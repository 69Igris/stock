/**
 * Nightly XBRL → `StockRatios` derivation — MONEY-1220, repaired by MONEY-1235.
 *
 * ## What this replaces
 *
 * Every one of the 2,135 rows in `stock_ratios` came from Tickertape, whose API
 * now returns 403 to our Cloud Run egress. The screener engine, the stock tabs,
 * the sector deep-dive and peers all read this table, so removing Tickertape
 * without a replacement would blank every fundamental filter on the site.
 *
 * This is the replacement, and it is strictly better in two ways that matter:
 * coverage (every company that files with NSE, not the 781 that happened to be
 * in a tier) and provenance (each number traces to a filing id we archived,
 * rather than being a figure a third party asserted).
 *
 * ## Two clocks, one row
 *
 * A ratio row is not one thing. Half of it moves when a FILING lands — margins,
 * growth, the CAGRs, current ratio, D/E — and half moves at every CLOSE — P/E,
 * P/B, market cap, EV, EV/EBITDA, dividend yield, PEG, beta. Recomputing the
 * filing half nightly is wasted work; recomputing the price half only on a new
 * filing would leave a P/E stale for a quarter.
 *
 * So the row carries `ratiosFilingId` and `ratiosPriceDate`, and the job asks
 * two separate questions. It also makes "why did this row change today"
 * answerable, which a single `updatedAt` never could.
 *
 * ## PARTIAL UPDATE — the row is not ours to replace
 *
 * We own 26 of 28 columns. `targetPrice` and `recommendation` are sell-side
 * ANALYST OPINION: in no filing, in no price series, not reproducible from
 * primary data. They are left strictly alone — whatever a previous source put
 * there survives, and we never write them.
 *
 * That means this job must never `update` with a whole object. Prisma would
 * write `undefined` fields as no-ops but a spread of a plan that lacks a column
 * is one refactor away from clearing it, and the column it would clear belongs
 * to a source we can no longer re-fetch. Only keys present in the plan are sent.
 *
 * ## MONEY-1235 — four things this job said it did and did not do
 *
 * Every one of them produced a perfectly healthy `[job-outcome]` line, which is
 * why they survived a release:
 *
 *  1. **The rotation never advanced.** The comment above the selection
 *     described a stale-first cursor over `ratiosDerivedAt`; the code was
 *     `orderBy: [{ symbol: "asc" }]` with no staleness filter anywhere.
 *     `ratiosDerivedAt` was WRITTEN and never READ, and the
 *     `@@index([ratiosDerivedAt])` whose schema doc says "serves the nightly
 *     stale-first select" served a query that did not exist. With ~2,108
 *     filing-bearing symbols against `DEFAULT_RATIOS_LIMIT = 1000`, the same
 *     alphabetical first thousand were re-derived every night and roughly
 *     symbols M–Z were **never** derived. MONEY-1211 verbatim. The cursor is
 *     now real and lives in `rankRatiosTargets`.
 *  2. **No basis selection at all.** The word `basis` did not appear in this
 *     file, while 1,486 of 2,108 symbols (70.5%) file BOTH consolidated and
 *     standalone for their newest year. Three consequences, all measured:
 *     `latest` was an arbitrary pick between two numbers that differ by a
 *     multiple (and could flip on alternate nights, because Mongo's equal-key
 *     order is unspecified); `annualFilings[0]`/`[1]` were often the SAME
 *     fiscal year's two bases, turning `revenueGrowth` into the consolidation
 *     GAP (AMBUJACEM 13,964.95 standalone vs 28,965.46 consolidated → a
 *     reported ~+107% "growth"); and the TTM feed picked up 2 quarters × 2
 *     bases, so `deriveTtm` correctly refused and **`pe` and `evToEbitda` were
 *     never computed for ~70% of filers**. `selectPeriodWinners` fixes all
 *     three at the source.
 *  3. **`take: 24` starved the CAGR feed.** See `ANNUAL_FILINGS_TAKE`.
 *  4. **The close had no recency bound.** See `PRICE_MAX_AGE_DAYS`.
 *
 * ## The 600s ack deadline is the real budget
 *
 * Every worker job arrives on a Pub/Sub PUSH subscription with a **600s ack
 * deadline** — Pub/Sub's maximum. A handler that runs past it does not merely
 * finish late: the message is redelivered and a SECOND copy of the same job
 * runs concurrently. CLAUDE.md's "pure DB+arithmetic — large headroom" is an
 * assertion, not a measurement, and this job issues one Atlas round-trip chain
 * per instrument.
 *
 * Round trips, counted rather than assumed:
 *
 * ```
 *                      BEFORE (MONEY-1220)      AFTER (MONEY-1235)
 *   per instrument     7                        6
 *     filings           1 (newest 24, mixed)     1 (newest 24, mixed)
 *     annual filings    –                        1 (ANNUAL, 16)      NEW
 *     corporate actions 1 (dividends only)       1 (widened, one query)
 *     latest close      1                        – folded into the beta window
 *     beta closes       1                        1
 *     nifty closes      1  (~1000 identical!)    – HOISTED to once per run
 *     incumbent source  1                        1
 *     write             1 (upsert)               1 (upsert, OR a cursor-only
 *                                                   updateMany on a refusal —
 *                                                   never both)
 *   per run            1                        3
 * ```
 *
 * At `limit = 1000` that is **7,001 → 6,003**, a 14% cut, and the nifty hoist
 * is what pays for the new ANNUAL query. The run now also REPORTS its own
 * wall-clock in the `[job-outcome]` line, so the next real run measures itself
 * instead of being reasoned about — which is the only way a limit change can
 * ever be justified. Do not raise `DEFAULT_RATIOS_LIMIT` before that number
 * exists.
 */

import { prisma } from "@usemoney/database";
import {
  deriveRatios,
  deriveValuation,
  deriveTtm,
  deriveExtendedRatios,
  planRatiosWrite,
  isPlanWorthWriting,
  deriveShareCount,
  ttmDividendPerShare,
  mayOverwriteFinancials,
  // MONEY-1346 — the document-extract fallback's mapper and period selector.
  extractToRatioInputs,
  selectAnnualExtractsByPeriod,
  type DocumentExtractRow,
  type AnnualPoint,
  type ClosePoint,
  type RatiosWritePlan,
  type TtmAggregate,
  type XbrlFinancials,
} from "@usemoney/core/market-data";
// `readFacts` lives with the projection writer, not in core: it decodes the
// stored `facts` JSON back into a parsed filing and is worker-side by design.
import { readFacts } from "./xbrl-projection-writer";
import {
  chooseRatioDerivationInputs,
  ANNUAL_FILINGS_TAKE,
  // MONEY-1346 — the extract table's OWN take. A different duplication factor
  // from the filing table's, measured rather than assumed; see the constant.
  ANNUAL_EXTRACT_ROWS_TAKE,
  ANNUAL_MAX_AGE_DAYS,
  PRICE_MAX_AGE_DAYS,
  annualRecencyVerdict,
  betaExcludeDatesFrom,
  classifyTtmInputs,
  rankRatiosTargets,
  selectPeriodWinners,
  type RatiosFilingRow,
  type TtmRefusal,
} from "./xbrl-ratios-logic";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";

/** Instruments per run. See the round-trip table in the file header. */
export const DEFAULT_RATIOS_LIMIT = 1000;

/**
 * The XBRL arm's eligibility, with the exchange interlock applied UP FRONT —
 * MONEY-1396.
 *
 * An instrument may only be selected for the XBRL arm when it has a filing ON
 * ITS OWN EXCHANGE. Without that, 2,164 of 2,807 filing-bearing instruments on
 * prod (77.1%) are selected, refused at the write, found unstampable, and
 * re-selected for ever — see the long note at the query itself.
 *
 * Enumerated rather than expressed as a field comparison because Prisma cannot
 * compare two fields. Exported so the rotation test can build its population
 * from the SAME predicate the job uses, instead of a hand-copied one that can
 * drift away from it.
 */
export const XBRL_ARM_WHERE = [
  { exchange: "NSE", xbrlFilings: { some: { exchange: "NSE" } } },
  { exchange: "BSE", xbrlFilings: { some: { exchange: "BSE" } } },
] as const;

/**
 * The DOCUMENT-EXTRACT arm's eligibility — MONEY-1401 F22.
 *
 * `XBRL_ARM_WHERE` closed the filing arm's squat and left the extract arm's
 * open: its clause carried no exchange predicate at all, so an instrument with
 * an EXTRACTED annual AND a filing on the OTHER exchange was selected, reached
 * `deriveOne`, returned `exchange-mismatch`, and could not be stamped —
 * MONEY-1211's head-of-queue squat through the same door, one arm over.
 *
 * The fix is not a second exchange pair. `deriveFromExtracts` is reachable ONLY
 * when `recentFilings.length === 0` (`deriveOne` returns into it there and
 * nowhere else), and that query is `{ instrumentId }` with NO exchange filter —
 * so `xbrlFilings: { none: {} }` is not an approximation of the doc arm's
 * reachability, it IS the condition, stated in the query instead of discovered
 * at the write.
 *
 * It removes nothing the filing arm wanted: an instrument with an own-exchange
 * filing is already selected by {@link XBRL_ARM_WHERE}, so this clause dropping
 * it changes no selection. Measured on prod 2026-09-13, of 3,777 active
 * instruments carrying an EXTRACTED ANNUAL extract: 387 also match
 * `XBRL_ARM_WHERE` (selected either way), 3,371 have no filing at all (the
 * legitimate doc-arm cohort, unaffected), and **19** are the squat this removes.
 */
export const DOC_ARM_WHERE = {
  documentFinancialExtracts: {
    some: { status: "EXTRACTED", periodType: "ANNUAL" },
  },
  xbrlFilings: { none: {} },
} as const;

/**
 * NOT-STALE, stated in the query — MONEY-1401 F(3).
 *
 * ## The refusal this withdraws could never be stamped
 *
 * `deriveOne` refuses a filer whose newest ANNUAL is past
 * {@link ANNUAL_MAX_AGE_DAYS} and calls `stampCursorOnly` to keep the rotation
 * moving. That stamp is an `updateMany`, which matches NOTHING when the
 * instrument has no `stock_ratios` row — and a stale filer that has never been
 * derived is precisely a symbol with no row. So the refusal is unstampable, the
 * instrument stays in `rankRatiosTargets`' rank 1 (NEVER DERIVED sorts first),
 * and it is re-selected every night for ever.
 *
 * And unlike every other refusal in this file, this one is MONOTONIC. An
 * `exchange-mismatch` is cleared by `reresolve-xbrl-instruments.ts`; undecodable
 * `facts` can be re-ingested. A stale annual only gets staler, and the cohort
 * only grows. Demonstrated against the real processor at `limit: 1` over two
 * instruments — one stale, one perfectly derivable: the stale one was selected
 * on all three nights, `written` was 0 every night, and the derivable one was
 * never reached. That is MONEY-1211's head-of-queue squat, through a fifth
 * door.
 *
 * LATENT TODAY only because ~643 armed instruments sit under
 * `DEFAULT_RATIOS_LIMIT`. It arms itself the moment
 * `scripts/data/reresolve-xbrl-instruments.ts` widens the population to ~2,598
 * — which this job's own comments assume will happen.
 *
 * ## Why WITHDRAW rather than widen the stamp
 *
 * The repo's recorded rule for this class, from MONEY-1346, which is the same
 * defect one cohort over: "The fix is to WITHDRAW the population, not to widen
 * the stamp. Upserting a marker-only row looks like the obvious repair and is
 * worse: an empty row carries a `source`, and if that source outranks others in
 * the authority table it locks every weaker source out of that key forever."
 * Here the source would be `NSE_XBRL`, the TOP of `FINANCIALS_AUTHORITY`, into
 * a table with no `source` in its unique key. The one-way door this whole file
 * is careful about.
 *
 * A stale instrument can never produce a write, so withdrawing it costs no row.
 *
 * ## The shape, and the arm that is NOT withdrawn
 *
 * NOT-STALE is "a fresh annual, **or no annual at all**" — the second half is
 * load-bearing. An instrument that has never filed an annual falls back to the
 * newest filing (`chooseRatioDerivationInputs`) and CAN be written from three
 * quarterly margins, so a predicate of "has a fresh annual" alone would withdraw
 * a cohort that still earns its slot. `deriveOne` reads its annuals with
 * `{ instrumentId, periodType: "ANNUAL" }` and NO exchange filter, so neither
 * does this — a predicate narrower than the check it mirrors would leave the
 * squat open for whatever it excluded.
 *
 * The write-time refusal at `:1560` STAYS. This is belt; that is braces, and it
 * is what keeps arming safe if `selectPeriodWinners` ever drops the newest
 * annual the raw query can see. `staleAnnual` going to ~0 on an ARMED run is
 * this clause working, not the bound going quiet.
 */
export function staleAnnualExclusion(now: Date) {
  const cutoff = new Date(now.getTime() - ANNUAL_MAX_AGE_DAYS * 86_400_000);
  return {
    OR: [
      {
        xbrlFilings: {
          some: { periodType: "ANNUAL", periodEnd: { gte: cutoff } },
        },
      },
      { xbrlFilings: { none: { periodType: "ANNUAL" } } },
    ],
  };
}

/** Trailing window for the beta regression. */
export const BETA_WINDOW_DAYS = 730;

/** The index beta is measured against. */
export const BETA_INDEX_SLUG = "nifty-50";

/**
 * Hard ceiling on the candidate scan, so an unexpectedly large population
 * cannot turn the selection query itself into the thing that blows the ack
 * deadline. Today's filing-bearing universe is ~2,108 symbols; 20,000 is above
 * the entire active NSE instrument count, so hitting it means something
 * structural changed and the run says so rather than quietly truncating.
 */
export const CANDIDATE_SCAN_CAP = 20_000;

/**
 * Ceiling on the `ratiosDerivedAt` marker read.
 *
 * Ordered **DESC** deliberately. `stock_ratios` is one row per symbol (2,135
 * today, bounded above by the active universe), so the cap should never bind —
 * but if it ever does, DESC keeps the MOST-RECENTLY-derived markers and drops
 * the stalest. A candidate whose marker was dropped is then treated as
 * never-derived and ranked FIRST, which is exactly where the stalest rows
 * belong. Ordering ASC would do the opposite: it would drop the fresh markers,
 * make freshly-derived instruments look never-derived, and stop the batch
 * advancing — the very bug this cursor exists to fix.
 */
export const MARKER_SCAN_CAP = 50_000;

export interface XbrlRatiosMessage {
  apply?: boolean;
  limit?: number;
  symbols?: string[];
}

export interface XbrlRatiosResult {
  ok: boolean;
  applied: boolean;
  selected: number;
  written: number;
  skippedNotWorthWriting: number;
  /**
   * Instruments refused because the FILING's exchange disagrees with the
   * INSTRUMENT's — MONEY-1299's mis-resolution, guarded at the write.
   *
   * Expected to be LARGE until `scripts/data/reresolve-xbrl-instruments.ts`
   * has run: measured on prod 2026-08-31, 2,169 of the 2,763 instruments this
   * job can select are the company's BSE row while `xbrl_filings.exchange` is
   * "NSE" on all 108,022 filings. A non-zero here is the guard working; a
   * non-zero AFTER the repair means the repair did not take.
   */
  skippedExchangeMismatch: number;
  /**
   * Instruments refused because the newest ANNUAL is past
   * {@link ANNUAL_MAX_AGE_DAYS} — MONEY-1401 F10.
   *
   * Its own field rather than folded into `skippedNotWorthWriting`, because the
   * two answer different questions: that one means "the filing produced too
   * little", this one means "the filing is too old to describe the company".
   * Only the second is a fact about the FILER, and only the second stops being
   * true when they file again.
   */
  staleAnnual: number;
  failed: number;
  /** Wall clock, so the 600s ack deadline stops being a guess. */
  durationMs: number;
  /** Instruments skipped because no close inside `PRICE_MAX_AGE_DAYS` exists. */
  stalePrice: number;
  /** Why a TTM could not be formed. `pe`/`evToEbitda` depend on it. */
  ttmRefusals: Record<TtmRefusal, number>;
  /** Beta returns dropped on a SPLIT/BONUS/DEMERGER ex-date. */
  betaReturnsDropped: number;
  /**
   * Beta returns beyond a plausible single-session move that SURVIVED the
   * drops — i.e. a corporate action our `corporate_actions` table is missing.
   */
  betaExtremeReturns: number;
  /**
   * Selected instruments whose rotation cursor ADVANCED — the written ones
   * (whose upsert carries the stamp) plus the refused ones that had a row to
   * stamp. This, not `written`, is the number that says whether tomorrow's run
   * will move on.
   */
  cursorStamped: number;
  /**
   * Selected instruments that produced NO derivable input at all — no filing
   * row survived the read, no period winner, or `facts` that would not decode.
   *
   * MONEY-1238. `no-inputs` was a `DeriveResult` no counter accumulated, so
   * `written + skippedNotWorthWriting + failed` did not sum to `selected` and
   * the shortfall had no name. A run could report 1,000 selected / 400 written
   * / 0 failed and the missing 600 were simply absent from the arithmetic —
   * indistinguishable from a rotation that never reached them.
   */
  noInputs: number;
  /**
   * Instruments whose TTM came from a basis other than the balance-sheet
   * half's, so `evToEbitda` was withheld — MONEY-1238. Sizes the one refusal
   * the basis-first TTM selection introduces.
   */
  ttmBasisFallback: number;
  /**
   * The planner's per-column refusal reasons, aggregated over the run as
   * `column -> reason -> count` — MONEY-1238. This is the "gross margin null
   * for 3,900 lenders" line `planRatiosWrite` promises; before this the array
   * was built per instrument and dropped on the floor.
   */
  unfilledByColumn: Record<string, Record<string, number>>;
  /**
   * Numbers the engine computed for which `StockRatios` has NO column, by name.
   * Non-zero is a schema gap, not an error: `grossNpaRatio`, `netNpaRatio` and
   * `cet1Ratio` are disclosed on every lender filing and have nowhere to go.
   */
  computedButUnstorable: Record<string, number>;
  /**
   * Selected instruments whose cursor did NOT advance: no `StockRatios` row to
   * stamp, an incumbent source that outranks NSE_XBRL, a throw, or a filing
   * whose `facts` could not be read. They stay at the head of the rotation and
   * consume a slot again tomorrow.
   *
   * Counted rather than assumed empty. A cursor that silently fails to advance
   * for part of the population is precisely MONEY-1211 and precisely this
   * ticket, and `selected > 0 && written === 0` cannot see it — the job looks
   * perfectly healthy while a subset of the universe is never reached.
   */
  cursorUnstampable: number;
  /**
   * Instruments whose ratios came from `document_financial_extracts` because
   * they have NO XBRL filing — MONEY-1346. The population the candidate query
   * could not previously see: 1,248 symbols on prod 2026-09-05, all with zero
   * `stock_ratios` rows.
   */
  fallbackExtracts: number;
  /**
   * Reached the fallback and found no usable ANNUAL EXTRACTED row. Distinct
   * from `fallbackAuthorityBlocked` because the fix is different: this one
   * needs more ingest, that one needs a look at who owns the row.
   */
  fallbackNoAnnualExtract: number;
  /**
   * A fallback write refused because a HIGHER-ranked source already owns the
   * row — `DOC_PDF` ranks below `NSE_XBRL` in `FINANCIALS_AUTHORITY`, so this
   * is the guard working, not an error.
   */
  fallbackAuthorityBlocked: number;
  /**
   * Fallback writes that landed on a row that ALREADY EXISTED — MONEY-1346.
   *
   * Expected to be ZERO, and that expectation is the third flag's arming
   * argument rather than a nice-to-have: 0 of 1,241 active extract-only
   * instruments held a `stock_ratios` row when this was measured on prod
   * 2026-09-05. The candidate query does not ENFORCE that, so a non-zero value
   * means a document reading has displaced another source's number through a
   * key that carries no `source` — allowed by `FINANCIALS_AUTHORITY`, and no
   * longer silent.
   */
  docDisplacedIncumbent: number;
}

/**
 * True when the environment has armed the RATIOS write — MONEY-1286.
 *
 * ## Its OWN flag, and why the split was not cosmetic
 *
 * This job and `xbrl-projection` both used to read `XBRL_PROJECTION_APPLY`, so
 * one switch decided two irreversible writes into two different tables. Both
 * gates were then run against prod on 2026-08-30 and DISAGREED:
 *
 *   `xbrlratios prod`  PASS      — `roe` READY at 666/697 (95.6%), none BLOCKED
 *   `xbrlrecon prod`   NOT READY — totalLiabilities disagrees on 17.2% of
 *                                  pairs, totalAssets/totalEquity 6.9%,
 *                                  netIncome 5.9%, against a 5.0% floor
 *
 * The evidence supports arming the ratios half and NOT the financials half, and
 * with one flag that state was inexpressible: arming what passed would have
 * armed what failed, into a table whose unique key carries no `source`, so the
 * first write destroys the value the reconcile still needs to compare against.
 *
 * The prize on this side is large and measured. `stock_ratios` holds 2,135 rows,
 * every one of them vendor (TICKERTAPE), frozen since 2026-03-21. TEN of the 26
 * XBRL-owned columns are 100% NULL platform-wide — operatingMargin, grossMargin,
 * ebitdaMargin, assetTurnover, earningsGrowth, revenueGrowth3Y/5Y,
 * earningsGrowth3Y/5Y, pegRatio, returnBasis — and nine more sit near 4%
 * (netMargin 86 rows, debtToEquity 86, currentRatio 86). From the 108,020
 * filings already ingested, per-symbol derivable TODAY: netMargin and
 * operatingMargin for 2,466 symbols, grossMargin 2,426, ebitdaMargin 2,417,
 * roe/roa/assetTurnover 2,303, debtToEquity 2,292, roce 2,287, currentRatio
 * 2,109.
 *
 * ## The two rules this comparison keeps from the projection job
 *
 * Compared against the LITERAL `"true"`, never `Boolean(value)`: an env var set
 * to `"false"` is a non-empty string and would arm the job under a truthiness
 * check — the same silent inversion as MONEY-1214's absent
 * `MF_METADATA_PROVIDER`, where a job ran cleanly for months writing nothing.
 *
 * Read PER CALL off the passed `env`, never captured in a module-scope const. A
 * module-level read freezes at import, which on a warm Cloud Run container means
 * a redeploy's new value never takes effect and the kill switch silently stops
 * being a switch (the bug documented on `bse-client.ts`'s retry config).
 */
export function isRatiosArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.XBRL_RATIOS_APPLY === "true";
}

/** `msg.apply` narrows; only the env arms. */
export function resolveRatiosApply(
  msg: XbrlRatiosMessage | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (msg?.apply === false) return false;
  return isRatiosArmed(env);
}

/**
 * True when the environment has armed the DOCUMENT-EXTRACT fallback write —
 * MONEY-1346.
 *
 * ## A THIRD flag, and the split is again not cosmetic
 *
 * `XBRL_RATIOS_APPLY` arms writes derived from an XBRL FILING. This one arms
 * writes derived from a model's reading of a filed PDF, for the cohort that has
 * no filing at all — measured on prod 2026-09-05, **1,248 symbols with EXTRACTED
 * ANNUAL extract rows, no XBRL filing, and ZERO `stock_ratios` rows**.
 *
 * Those two populations do not overlap, and that is the whole argument for a
 * separate switch: the extract cohort has NO INCUMBENT ROW TODAY, so every
 * write it makes is a pure CREATE. Nothing is displaced, nothing is destroyed,
 * and the one-way-door reasoning that gates `XBRL_RATIOS_APPLY` — "the first
 * XBRL write replaces the vendor row and the gate can never again produce
 * arming evidence in that environment" — does not apply to it. Arming this on
 * its own evidence is therefore possible; arming it through the XBRL flag
 * would have made it wait for evidence about a different table's contents.
 *
 * ## "TODAY" IS LOAD-BEARING, and it is a measurement rather than a guarantee
 *
 * Re-measured on prod 2026-09-05: of the 1,288 instruments holding EXTRACTED
 * ANNUAL extract rows, 39 also hold an XBRL filing (so they never reach the
 * fallback at all), 1,249 do not, 1,241 of those are active — and **0 of the
 * 1,241 hold a `stock_ratios` row**.
 *
 * That is a fact about the DATA. The candidate query does not enforce it: it
 * admits any active instrument with an EXTRACTED ANNUAL extract and no filing,
 * which does not exclude one that acquires a vendor row later. And such a write
 * WOULD displace — `DOC_PDF` outranks both vendors by founder decision
 * (MONEY-1255) and `StockRatios` is `@@unique([symbol, exchange])` with no
 * `source` in the key.
 *
 * So the premise is REPORTED rather than asserted. Every run emits
 * `fallback:displacedIncumbent=N`, and a non-zero N means this paragraph has
 * expired: the arming argument above rests on a snapshot that no longer holds
 * and has to be re-made, not re-read.
 *
 * The two rules are copied EXACTLY from `isRatiosArmed`, deliberately rather
 * than shared, because they are the two that keep being got wrong:
 *
 *   - compared to the LITERAL `"true"`, never `Boolean(value)` — `Boolean(
 *     "false")` is true, which would arm the job in the one configuration that
 *     ships today (MONEY-1214);
 *   - read PER CALL off the passed `env`, never a module-scope const — a
 *     module-level read freezes at import, so on a warm Cloud Run container a
 *     redeployed switch is no switch at all.
 */
export function isDocRatiosArmed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.DOC_RATIOS_APPLY === "true";
}

/** `msg.apply` narrows; only the env arms. Same contract as the XBRL half. */
export function resolveDocRatiosApply(
  msg: XbrlRatiosMessage | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (msg?.apply === false) return false;
  return isDocRatiosArmed(env);
}

/**
 * Which provenance a write on this run carries — MONEY-1346.
 *
 * One VARIABLE rather than a literal at each of the five places that used to
 * hardcode `"NSE_XBRL"` (two on the upsert, three on the authority guards). The
 * point is not brevity: `mayOverwriteFinancials(challenger, incumbent)` and the
 * `source` column must always name the SAME thing, and a guard that checks one
 * provenance while the write stamps another is a silent authority bypass that
 * no test looking at either half alone can see.
 */
export type RatiosSource = "NSE_XBRL" | "DOC_PDF";

type Db = typeof prisma;

function emptyTtmRefusals(): Record<TtmRefusal, number> {
  return {
    "no-quarters": 0,
    "insufficient-quarters": 0,
    "mixed-basis": 0,
    "unreadable-facts": 0,
    "refused-by-rules": 0,
  };
}

export async function processXbrlRatios(
  msg?: XbrlRatiosMessage,
  deps: { prisma?: Db; now?: Date } = {},
): Promise<XbrlRatiosResult> {
  const db = deps.prisma ?? prisma;
  const now = deps.now ?? new Date();
  const startedAtMs = Date.now();
  const apply = resolveRatiosApply(msg);
  // The DOCUMENT-EXTRACT arm — a SEPARATE switch, MONEY-1346. See
  // `isDocRatiosArmed`: the extract-only cohort has no incumbent row, so its
  // writes are pure CREATEs and can be armed on their own evidence.
  const docApply = resolveDocRatiosApply(msg);
  // ── AN UNSTAMPABLE POPULATION MUST NOT BE SELECTED — MONEY-1346 ──────────
  //
  // The extract-only cohort holds ZERO `stock_ratios` rows (measured on prod
  // 2026-09-05: 1,241 of 1,241 active extract-only instruments), which is what
  // makes `rankRatiosTargets` put every one of them in rank 1 — NEVER DERIVED
  // sorts first. When the doc arm is UNARMED every path through
  // `deriveFromExtracts` returns `cursor: "dry-run"`, and its two stamping
  // paths call `updateMany`, which matches nothing when there is no row. So
  // the cohort cannot be stamped, cannot fall out of rank 1, and 1,241 exceeds
  // `DEFAULT_RATIOS_LIMIT` (1,000).
  //
  // Armed XBRL beside an unarmed doc arm — precisely the state the third flag
  // exists to express — would therefore spend all 1,000 slots on rows it
  // refuses to write, every night, and NO XBRL instrument would ever be
  // derived again. That is MONEY-1211's head-of-queue squat arriving through a
  // fourth door, and `stampCursorOnly` cannot close this one: its stamp is an
  // update, and the rotation marker lives on a row that does not exist.
  //
  // Widening `stampCursorOnly` into an upsert is the fix NOT taken. A
  // marker-only `stock_ratios` row would carry `source: "DOC_PDF"`, which
  // OUTRANKS both vendors in `FINANCIALS_AUTHORITY` — so an empty row created
  // to advance a cursor would lock every weaker source out of that symbol
  // forever, through the same one-way door (`@@unique([symbol, exchange])`,
  // no `source` in the key) this whole file is careful about. "No row to
  // stamp" is the correct outcome; not selecting the row is the correct fix.
  //
  // `!apply` keeps the WHOLE-POPULATION rehearsal working: with the XBRL half
  // also unarmed there is no rotation to starve, so a dry run still reports
  // what the doc arm would do before anyone arms it.
  const docArmSelectable = docApply || !apply;
  // ── AND THE SAME ARGUMENT FOR A REFUSAL THAT NEVER LIFTS — MONEY-1401 F3 ──
  //
  // See {@link staleAnnualExclusion}. Applied only on an ARMED run, mirroring
  // `docArmSelectable` one line up and for the same two reasons: an unarmed run
  // stamps nothing, so there is no rotation to starve, and `staleAnnual` is the
  // diagnostic a rehearsal is FOR — the F10 bound expects a large number there
  // until `reresolve-xbrl-instruments.ts` has run, and withdrawing the cohort
  // from the dry run would report that as zero.
  const staleAnnualSelectable = !apply;
  const limit = Math.max(
    1,
    Math.min(20000, msg?.limit ?? DEFAULT_RATIOS_LIMIT),
  );

  console.log(
    `[xbrl-ratios] Starting (apply=${apply}, docApply=${docApply}, limit=${limit})`,
  );

  // ── Selection, phase 1: WHO is eligible ──────────────────────────────────
  //
  // Active instruments that have at least one filing. `orderBy symbol asc`
  // survives here for ONE reason and it is not the rotation: it makes the
  // `CANDIDATE_SCAN_CAP` cut deterministic. The rotation is decided by
  // `rankRatiosTargets` below, on a marker this query cannot sort by — the
  // marker lives on `StockRatios` and the population lives on
  // `InstrumentMapping`.
  const candidates = await db.instrumentMapping.findMany({
    where: {
      isActive: true,
      ...(msg?.symbols?.length ? { symbol: { in: msg.symbols } } : {}),
      // ── THE POPULATION WIDENS — MONEY-1346 ───────────────────────────────
      //
      // `xbrlFilings: { some: {} }` alone made "has no XBRL filing" mean "is
      // not a company", not "has no ratios yet". Measured on prod 2026-09-05:
      // 1,248 Indian symbols hold EXTRACTED ANNUAL rows in
      // `document_financial_extracts`, have no filing, and hold ZERO
      // `stock_ratios` rows — never written, and never even CONSIDERED, so no
      // counter anywhere named them.
      //
      // The arm stays on the RELATION, not on a marker column: a
      // `ratiosDerivedAt` predicate would not match a row where the field is
      // ABSENT, which is every pre-existing row, and that Prisma+Mongo rule has
      // caused four tickets here already. The staleness ordering stays in
      // JavaScript (`rankRatiosTargets`) exactly as before.
      // ── THE SAME ARGUMENT, ONE COHORT LARGER — MONEY-1396 ────────────────
      //
      // `xbrlFilings: { some: {} }` selects an instrument whose filings name a
      // DIFFERENT exchange, and that instrument is refused at the write
      // (`:1418`, the exchange interlock) and then cannot be cursor-stamped,
      // because `stampCursorOnly`'s `updateMany({symbol, exchange:"BSE"})`
      // matches no `stock_ratios` row — all 2,135 incumbents are keyed to NSE
      // instruments. Refused, unstampable, and therefore parked in rank 1 for
      // ever.
      //
      // Measured on prod 2026-09-13: `xbrl_filings` carries `exchange: "NSE"`
      // on all 108,073 rows, while the 2,807 instruments those filings resolve
      // to are **643 NSE and 2,164 BSE**. So 77.1% of the selectable population
      // is squatters, against `DEFAULT_RATIOS_LIMIT` of 1,000 — the head of the
      // queue is pure refusal. Simulated against the real `rankRatiosTargets`,
      // arming writes ~214 rows the first night, ~270 across four, then ZERO
      // every night after, while `[job-outcome]` reports a perfectly healthy
      // `selected=1000 written=0`.
      //
      // This is EXACTLY the `docArmSelectable` argument twenty lines up, for a
      // cohort 1.75x larger: an unstampable population must not be SELECTED.
      // The write-time guard at `:1418` stays — it is the braces to this belt,
      // and it is what makes arming safe before the repair
      // (`scripts/data/reresolve-xbrl-instruments.ts`) has run. This only stops
      // the job spending its whole batch on rows it is about to refuse.
      //
      // Prisma cannot compare two fields, so the pair is ENUMERATED rather than
      // expressed as `instrument.exchange == filing.exchange`. A filing's
      // `exchange` is non-nullable, so there is no absent case to reason about
      // — and this is a RELATION filter, never a marker-column predicate, so
      // the Prisma+Mongo absent-field trap does not apply.
      //
      // ── AND THE SAME ARGUMENT FOR THE OTHER ARM — MONEY-1401 F22 ─────────
      //
      // The extract clause used to carry NO exchange predicate, so the squat
      // this whole section closes stayed open through it: an instrument with an
      // EXTRACTED annual AND a filing on the OTHER exchange was selected,
      // refused at `:1418`, and left unstampable. Bounded at 19 instruments on
      // prod (2026-09-13) — small, and permanent, which is the same shape
      // MONEY-1211 was. See {@link DOC_ARM_WHERE}.
      OR: docArmSelectable
        ? [...XBRL_ARM_WHERE, DOC_ARM_WHERE]
        : // Armed XBRL, unarmed doc arm: back to the pre-MONEY-1346 population,
          // because the extra arm's cohort cannot be stamped and would squat.
          // See `docArmSelectable`.
          [...XBRL_ARM_WHERE],
      // A SECOND top-level key, not a third OR arm: this narrows every arm
      // rather than adding a population. Prisma ANDs the keys of one `where`.
      ...(staleAnnualSelectable ? {} : { AND: [staleAnnualExclusion(now)] }),
    },
    orderBy: [{ symbol: "asc" }],
    take: CANDIDATE_SCAN_CAP,
    select: { id: true, symbol: true, exchange: true },
  });

  // ── Selection, phase 2: WHO IS STALEST ───────────────────────────────────
  //
  // Read the marker, do not MATCH on it. A `{ ratiosDerivedAt: null }` WHERE
  // clause would not match a row where the field is ABSENT — which is every one
  // of the 2,135 Tickertape-era rows — and that single Prisma+Mongo rule has
  // caused four tickets here (MONEY-1050, 1205, 1234, 1235). Selecting the
  // value and ranking in JavaScript cannot have that bug.
  const markers = await db.stockRatios.findMany({
    orderBy: [{ ratiosDerivedAt: "desc" }],
    take: MARKER_SCAN_CAP,
    // (symbol, exchange) — the SAME tuple the upsert writes on. Reading the
    // cursor by `instrumentId` while writing by `symbol_exchange` is how the
    // rotation silently stopped advancing; see RatiosDerivedMarker.
    select: { symbol: true, exchange: true, ratiosDerivedAt: true },
  });

  const targets = rankRatiosTargets(candidates, markers, limit);

  // ── The index series, ONCE ───────────────────────────────────────────────
  //
  // ~490 rows, identical for every instrument in the run. Reading it inside
  // the per-instrument loop cost ~1,000 identical Atlas round-trips a night
  // for a series that cannot change mid-run.
  const since = new Date(now.getTime() - BETA_WINDOW_DAYS * 86_400_000);
  const indexCloses = (await db.indexClose.findMany({
    where: { indexSlug: BETA_INDEX_SLUG, date: { gte: since } },
    orderBy: [{ date: "asc" }],
    select: { date: true, close: true },
  })) as ClosePoint[];

  let written = 0;
  let notWorth = 0;
  let exchangeMismatch = 0;
  let failed = 0;
  let noInputs = 0;
  let stalePrice = 0;
  let betaReturnsDropped = 0;
  let betaExtremeReturns = 0;
  let ttmBasisFallback = 0;
  const ttmRefusals = emptyTtmRefusals();
  const unfilledByColumn: Record<string, Record<string, number>> = {};
  const computedButUnstorable: Record<string, number> = {};
  let cursorStamped = 0;
  let cursorUnstampable = 0;
  // MONEY-1346 — the three arms of the document-extract fallback, counted
  // separately. `fallbackExtracts` is the prize (an instrument the XBRL half
  // could never reach); the other two are the two ways it can produce nothing,
  // and they need different fixes — more ingest versus a repair of whichever
  // row already owns the symbol.
  let fallbackExtracts = 0;
  let fallbackNoAnnualExtract = 0;
  let fallbackAuthorityBlocked = 0;
  // MONEY-1346 — the falsifiable half of the third flag's arming argument.
  let docDisplacedIncumbent = 0;
  // MONEY-1401 F10 — instruments whose newest ANNUAL is past
  // `ANNUAL_MAX_AGE_DAYS`. Expected to be LARGE until
  // `scripts/data/reresolve-xbrl-instruments.ts` has run (measured 339 of the
  // 559 armed instruments carrying an annual on prod 2026-09-13, against 378 of
  // 2,598 over the post-repair population), so a big number here is a statement
  // about the instrument resolution, not about this bound.
  let staleAnnual = 0;

  for (const inst of targets) {
    try {
      const outcome = await deriveOne(inst, apply, {
        db,
        docApply,
        now,
        since,
        indexCloses,
      });
      if (outcome.result === "written") written++;
      else if (outcome.result === "not-worth-writing") notWorth++;
      else if (outcome.result === "exchange-mismatch") exchangeMismatch++;
      else if (outcome.result === "stale-annual") staleAnnual++;
      // MONEY-1238 — the third arm. Without it the four outcome counters do
      // not sum to `selected`, and the residue is silent.
      else noInputs++;
      if (outcome.stalePrice) stalePrice++;
      if (outcome.ttmRefusal) ttmRefusals[outcome.ttmRefusal]++;
      if (outcome.ttmBasisFallback) ttmBasisFallback++;
      betaReturnsDropped += outcome.betaReturnsDropped;
      betaExtremeReturns += outcome.betaExtremeReturns;
      // The planner's diagnostics, finally read — MONEY-1238.
      for (const u of outcome.unfilled) {
        const byReason = (unfilledByColumn[u.column] ??= {});
        byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
      }
      for (const c of outcome.computedButUnstorable) {
        computedButUnstorable[c.name] =
          (computedButUnstorable[c.name] ?? 0) + 1;
      }
      // The rotation tax, measured. `stamped` moves an instrument to the back
      // of the queue; everything else leaves it at the head, where it consumes
      // a slot again tomorrow. A cursor that silently fails to advance for a
      // subset of the population is exactly what MONEY-1211 and this ticket
      // both were, so the subset is counted rather than assumed empty.
      if (outcome.cursor === "stamped") cursorStamped++;
      else if (outcome.cursor !== "dry-run") cursorUnstampable++;
      if (outcome.fallback === "extracts") fallbackExtracts++;
      else if (outcome.fallback === "noAnnualExtract")
        fallbackNoAnnualExtract++;
      else if (outcome.fallback === "authorityBlocked")
        fallbackAuthorityBlocked++;
      // NOT an `else` arm: a displacing write is also a `fallback:extracts`,
      // so this counts a PROPERTY of the write, not a fifth bucket.
      if (outcome.docDisplacedIncumbent) docDisplacedIncumbent++;
    } catch (error) {
      // One bad instrument never ends the run — the rest of the universe is
      // still derivable, and a partial run that SAYS it was partial beats one
      // that stops at whichever filing happened to be malformed.
      //
      // A THROWN instrument is deliberately NOT cursor-stamped: unlike a
      // refusal, a throw may be transient, and re-reading it tomorrow costs one
      // instrument's worth of work. The same distinction the projection job
      // draws for `projectedAt`.
      failed++;
      cursorUnstampable++;
      console.warn(`[xbrl-ratios] ${inst.symbol} failed: ${String(error)}`);
    }
  }

  const durationMs = Date.now() - startedAtMs;

  // The duration and the counters ride in `skippedReason` because that is the
  // only free-text channel `reportJobOutcome` has, and the same precedent the
  // retired `stock-document-sync` set ("emits a job-outcome with the per-source
  // counts in its reason string"). Without it there is no measurement of this
  // job against the 600s ack deadline anywhere — only CLAUDE.md's assertion of
  // "large headroom", which is what a redelivered, double-running job looks
  // like right up until it happens.
  // MONEY-1238 — every counter this run computes must reach the outcome line.
  // `unfilledByColumn` is the whole array reduced to `column: reason=count`,
  // deterministically ordered so two nights are diffable, and capped: it is the
  // only unbounded term here (columns x reasons), and an outcome line that
  // grows without limit is one truncation away from losing the counters beside
  // it. The cap is stated in the line itself rather than silently applied.
  const UNFILLED_REPORT_LIMIT = 12;
  const unfilledRanked = Object.entries(unfilledByColumn)
    .map(([column, reasons]) => ({
      column,
      total: Object.values(reasons).reduce((a, b) => a + b, 0),
      reasons,
    }))
    .sort((a, b) => b.total - a.total || a.column.localeCompare(b.column));
  const unfilledLine = unfilledRanked
    .slice(0, UNFILLED_REPORT_LIMIT)
    .map(
      (r) =>
        `${r.column}=${r.total}(${
          Object.entries(r.reasons).sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
          )[0]?.[0] ?? "unknown"
        })`,
    )
    .join(",");
  const unfilledOverflow = Math.max(
    0,
    unfilledRanked.length - UNFILLED_REPORT_LIMIT,
  );

  const measurements =
    `durationMs=${durationMs} ackDeadlineMs=600000 ` +
    `candidates=${candidates.length} notWorthWriting=${notWorth} ` +
    `exchangeMismatch=${exchangeMismatch} staleAnnual=${staleAnnual} ` +
    `failed=${failed} noInputs=${noInputs} stalePrice=${stalePrice} ` +
    `ttm=${JSON.stringify(ttmRefusals)} ttmBasisFallback=${ttmBasisFallback} ` +
    `betaDropped=${betaReturnsDropped} betaExtreme=${betaExtremeReturns} ` +
    `unfilled=[${unfilledLine}]+${unfilledOverflow}more ` +
    `unstorable=${JSON.stringify(computedButUnstorable)} ` +
    `cursorStamped=${cursorStamped} cursorUnstampable=${cursorUnstampable} ` +
    // MONEY-1346 — `reportJobOutcome` has no extras field, so these ride the
    // reason string as `key=value` pairs, the same precedent every counter
    // above uses.
    `fallback:extracts=${fallbackExtracts} ` +
    `fallback:noAnnualExtract=${fallbackNoAnnualExtract} ` +
    `fallback:authorityBlocked=${fallbackAuthorityBlocked} ` +
    `fallback:displacedIncumbent=${docDisplacedIncumbent}`;

  reportJobOutcome({
    job: "xbrl-ratios",
    selected: targets.length,
    written,
    failed,
    skippedReason: !apply
      ? `not-armed (XBRL_RATIOS_APPLY !== 'true'); counts are a dry run; ${measurements}`
      : targets.length > 0 && written === 0
        ? `no write from ${targets.length} instrument(s): ${measurements}`
        : measurements,
  });

  if (candidates.length >= CANDIDATE_SCAN_CAP) {
    console.warn(
      `[xbrl-ratios] candidate scan hit its ${CANDIDATE_SCAN_CAP} cap — the ` +
        "filing-bearing universe grew past what this selection was sized for",
    );
  }

  return {
    ok: failed === 0,
    applied: apply,
    selected: targets.length,
    written,
    skippedNotWorthWriting: notWorth,
    skippedExchangeMismatch: exchangeMismatch,
    staleAnnual,
    failed,
    noInputs,
    durationMs,
    stalePrice,
    ttmRefusals,
    ttmBasisFallback,
    unfilledByColumn,
    computedButUnstorable,
    betaReturnsDropped,
    betaExtremeReturns,
    cursorStamped,
    cursorUnstampable,
    fallbackExtracts,
    fallbackNoAnnualExtract,
    fallbackAuthorityBlocked,
    docDisplacedIncumbent,
  };
}

/**
 * The bases to try for a TTM, in order — MONEY-1238.
 *
 * `preferred` first, then every OTHER basis actually present among the
 * candidate quarters. The tail is ordered CONSOLIDATED, STANDALONE, then
 * anything unrecognised sorted by name: an UNKNOWN basis ranks last for the
 * same reason `basisRank` and `rankOf` put unknowns last — a vocabulary we have
 * not seen may fill a gap, never displace something we understand.
 *
 * Bases NOT present in the candidate set are omitted rather than attempted.
 * Attempting them costs nothing but would emit a `no-quarters` refusal for a
 * basis the company does not file, which is noise in the one counter that is
 * supposed to say why `pe` is null.
 *
 * Exported for the test that proves the order is TOTAL: the whole point is that
 * the outcome does not depend on the order Mongo returned the rows in.
 */
export function ttmBasisOrder(
  preferred: string,
  rows: ReadonlyArray<{ basis: string }>,
): string[] {
  const present = new Set(rows.map((r) => r.basis));
  const rank = (b: string): number =>
    b === "CONSOLIDATED" ? 0 : b === "STANDALONE" ? 1 : 2;
  const rest = [...present]
    .filter((b) => b !== preferred)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return present.has(preferred) ? [preferred, ...rest] : rest;
}

type DeriveResult =
  | "written"
  | "not-worth-writing"
  | "no-inputs"
  // The filing and the instrument name different exchanges — MONEY-1299.
  | "exchange-mismatch"
  // The newest ANNUAL is older than `ANNUAL_MAX_AGE_DAYS` — MONEY-1401 F10.
  // A NAMED outcome rather than a silent skip: "we refused because the
  // fundamentals are stale" and "there was nothing to derive" are different
  // facts, and only the first one is a statement about the FILER.
  | "stale-annual";

/**
 * Where this instrument's rotation cursor ended up. Every value is a distinct
 * reason the batch may or may not advance past it next night, and all of them
 * are counted — a cursor that silently fails to move is the whole ticket.
 */
type CursorOutcome =
  | "stamped"
  | "no-row"
  | "authority-blocked"
  | "not-reached"
  | "dry-run";

interface DeriveOutcome {
  result: DeriveResult;
  stalePrice: boolean;
  ttmRefusal: TtmRefusal | null;
  /**
   * The coherent TTM came from a basis other than the one the balance-sheet
   * half of the row uses, so `evToEbitda` was withheld — MONEY-1238.
   */
  ttmBasisFallback: boolean;
  betaReturnsDropped: number;
  betaExtremeReturns: number;
  /**
   * `RatiosWritePlan.unfilled`, which had ZERO readers — MONEY-1238. The
   * planner records a REASON per column it could not fill and its own comment
   * promises a run can report "gross margin null for 3,900 lenders"; nothing
   * ever read the array, so every one of those reasons was computed and
   * discarded inside the loop that produced it.
   */
  unfilled: ReadonlyArray<{ column: string; reason: string }>;
  /** `RatiosWritePlan.computedButUnstorable` — same, and a schema gap. */
  computedButUnstorable: ReadonlyArray<{ name: string; value: number }>;
  cursor: CursorOutcome;
  /**
   * Which arm of the DOCUMENT-EXTRACT fallback this instrument took, or `null`
   * when it never reached it — MONEY-1346.
   *
   * Counted rather than folded into the existing outcomes because the whole
   * defect being fixed is a population that was silently absent from the
   * arithmetic: `noInputs` went up and nothing said whether that meant "no
   * filing AND no extract" or "an extract we refused to use".
   */
  fallback: null | "extracts" | "noAnnualExtract" | "authorityBlocked";
  /**
   * A document-derived write landed on a row that ALREADY EXISTED — MONEY-1346.
   *
   * The third flag's whole justification is "this cohort has no incumbent row,
   * so every write is a pure CREATE". That was MEASURED and it is true of the
   * data — 0 of 1,241 active extract-only instruments hold a `stock_ratios`
   * row, prod 2026-09-05 — but it is a property of the DATA, not of the query,
   * and the two are not the same claim. The selector admits any active
   * instrument with an EXTRACTED ANNUAL extract and no XBRL filing; nothing
   * stops one of those acquiring a vendor row tomorrow.
   *
   * `DOC_PDF` outranks both vendors by founder decision (MONEY-1255) and
   * `StockRatios` carries no `source` in its key, so such a write WOULD
   * displace and the displaced value would be gone. That is the declared
   * policy and it is not being changed here. What is being changed is that it
   * can no longer happen SILENTLY: this counter is the falsifiable version of
   * the claim the flag is armed on, and a non-zero value means the "pure
   * CREATE" premise has expired and the arming argument needs re-reading.
   */
  docDisplacedIncumbent: boolean;
}

interface DeriveContext {
  db: Db;
  /**
   * The DOCUMENT-EXTRACT arm — `DOC_RATIOS_APPLY`, NOT the XBRL one
   * (MONEY-1346). Carried here rather than as a second positional argument so
   * the two arms cannot be swapped at a call site: they gate writes with
   * different provenance into rows with different incumbents.
   */
  docApply: boolean;
  now: Date;
  /** Start of the beta window; also the floor for the corporate-action read. */
  since: Date;
  /** Hoisted once per run — see `processXbrlRatios`. */
  indexCloses: readonly ClosePoint[];
}

function outcome(
  result: DeriveResult,
  over: Partial<DeriveOutcome> = {},
): DeriveOutcome {
  return {
    result,
    stalePrice: false,
    ttmRefusal: null,
    ttmBasisFallback: false,
    betaReturnsDropped: 0,
    betaExtremeReturns: 0,
    unfilled: [],
    computedButUnstorable: [],
    fallback: null,
    docDisplacedIncumbent: false,
    // An instrument that returned before the authority read was never offered
    // a cursor at all. Rare (unreadable `facts`), but it is a head-of-queue
    // occupant, so it is named rather than folded into a generic bucket.
    cursor: "not-reached",
    ...over,
  };
}

/**
 * Advance the rotation cursor for an instrument that produced NOTHING — MONEY-1238.
 *
 * ## Why a no-input instrument must be offered the cursor at all
 *
 * The three `no-inputs` returns below (`recentFilings` empty, no period winner,
 * `facts` that will not decode) used to return `cursor: "not-reached"`, which
 * is honest — the authority read never happened — and permanent. The candidate
 * query selects on `xbrlFilings: { some: {} }` and `rankRatiosTargets` ranks
 * NEVER-DERIVED first, so an instrument whose stored `facts` cannot be decoded
 * is selected FIRST, produces nothing, is not stamped, and is selected first
 * again tomorrow. Forever. It occupies a slot in a 1,000-instrument batch
 * against a ~2,108-symbol universe, and it takes a real instrument's place.
 *
 * That is MONEY-1211 exactly, arriving through a third door: the same
 * head-of-queue squat the `symbol asc` ordering caused and the refusal stamp
 * already closed for `isPlanWorthWriting`. Undecodable `facts` is no more
 * transient than an unworthwhile plan — the bytes are already stored, and
 * nothing about tomorrow's run decodes them differently.
 *
 * A THROW is still not stamped: it may be transient, and the catch in
 * `processXbrlRatios` keeps that distinction deliberately.
 *
 * Costs one extra `findUnique` on a path that is rare by construction, and only
 * on the arming runs (`apply`), so an unarmed rehearsal still mutates nothing.
 */
async function stampCursorOnly(
  inst: { symbol: string; exchange: string },
  apply: boolean,
  db: Db,
  now: Date,
  // MONEY-1346 — the provenance whose authority is being claimed. A cursor
  // stamp is still a WRITE into a row another source may own, so it is guarded
  // by the same rank as the ratios write it stands in for, and the two must
  // never name different sources.
  source: RatiosSource,
): Promise<CursorOutcome> {
  if (!apply) return "dry-run";
  // Adjacent to its write, for the same reason every other cursor touch in
  // this file re-reads it: a guard that is not next to the write it gates
  // protects nothing the next edit cannot separate them by.
  const incumbent = await db.stockRatios.findUnique({
    where: {
      symbol_exchange: { symbol: inst.symbol, exchange: inst.exchange },
    },
    select: { source: true },
  });
  if (!mayOverwriteFinancials(source, incumbent?.source)) {
    return "authority-blocked";
  }
  const stamped = await db.stockRatios.updateMany({
    // Keyed like every other cursor touch in this file — see the
    // RatiosDerivedMarker comment for why this must match the upsert.
    where: { symbol: inst.symbol, exchange: inst.exchange },
    data: { ratiosDerivedAt: now },
  });
  return stamped.count > 0 ? "stamped" : "no-row";
}

/**
 * The PRICE half of a ratio row — MONEY-1346.
 *
 * Extracted from `deriveOne` so the document-extract fallback runs the SAME
 * freshness rule, the SAME corporate-action window and the SAME beta series
 * rather than a second copy of them. Two copies of a staleness guard is how one
 * of them quietly stops matching the other: the rule that a close older than
 * `PRICE_MAX_AGE_DAYS` must not produce a P/E is exactly the kind that reads as
 * obviously-correct in both places while only one is enforced.
 *
 * `periodEnd` is the newest reporting period the caller holds. It is used ONLY
 * to floor the corporate-action read for a DORMANT filer, whose newest
 * statement can be older than the beta window.
 */
interface PriceContext {
  /** The newest close inside `PRICE_MAX_AGE_DAYS`, or `undefined`. */
  usablePrice: { date: Date; close: number } | undefined;
  /** A close exists but is older than the cutoff — counted, never used. */
  stalePrice: boolean;
  /** The whole beta window, ascending. Doubles as the price source. */
  stockCloses: ClosePoint[];
  actions: Array<{
    exDate: Date;
    dividendPerShare: number | null;
    type: string | null;
  }>;
}

async function loadPriceContext(
  inst: { id: string; symbol: string; exchange: string },
  periodEnd: Date,
  ctx: DeriveContext,
): Promise<PriceContext> {
  const { db, now, since } = ctx;
  // ── Price half ────────────────────────────────────────────────────────────
  //
  // ONE corporate-action read serving two purposes. It used to filter
  // `dividendPerShare: { not: null }`; that filter is gone because the SPLIT /
  // BONUS / DEMERGER rows the beta window needs would have been excluded by it.
  // Nothing is lost — `ttmDividendPerShare` applies its own twelve-month window
  // and counts null amounts as `skippedNullAmount` rather than treating them as
  // a zero dividend, which is stricter than the WHERE clause ever was.
  //
  // The floor is the EARLIER of the two windows: the beta window (730d back
  // from now) and a 400d floor off the filing's period end.
  //
  // MONEY-1238 moved the DIVIDEND window's anchor from `periodEnd` to
  // the price date (see `ttmDividendPerShare` at the valuation call). This
  // floor is deliberately NOT re-derived from that anchor: the beta window is
  // already 730 days back from `now`, which strictly contains a 12-month window
  // ending at any close inside `PRICE_MAX_AGE_DAYS`, so the read still covers
  // the new window with room. The period-end term survives to keep covering a
  // DORMANT filer, whose newest filing can be older than the beta window.
  const dividendFloorMs = periodEnd.getTime() - 400 * 86_400_000;
  const actions = await db.corporateAction.findMany({
    where: {
      symbol: inst.symbol,
      exchange: inst.exchange,
      exDate: {
        // ONE DAY OF SLACK, for the same reason the marks route needed it —
        // MONEY-1527. This bound is on the RAW INSTANT while every consumer
        // matches on the IST calendar day, and prod stores `exDate` in two
        // conventions 5h30m apart. An 18:30Z-stamped ex-date whose IST day is
        // the first day of the window sits BEFORE `since` and is never
        // fetched, so `betaExcludeDatesFrom`'s own widened filter can never
        // see it — a filter downstream of the query cannot admit a row the
        // query refused.
        //
        // It survives today only because the cron is 22:00 IST = 16:30Z, two
        // hours short of the 18:30Z stamp. Moving that schedule past 18:30Z
        // would silently drop the boundary ex-date and send its ~-90% log
        // return into a published `stock_ratios.beta`.
        gte: new Date(Math.min(since.getTime(), dividendFloorMs) - 86_400_000),
      },
    },
    orderBy: [{ exDate: "desc" }],
    select: { exDate: true, dividendPerShare: true, type: true },
  });

  // The beta window doubles as the price source. A separate
  // `findFirst({ orderBy: date desc })` used to fetch the latest close with NO
  // lower bound at all; since anything older than `PRICE_MAX_AGE_DAYS` is now
  // refused, a 730-day window strictly contains every acceptable close, and the
  // extra round-trip bought nothing.
  const stockCloses = (await db.dailyPrice.findMany({
    where: { instrumentId: inst.id, date: { gte: since } },
    orderBy: [{ date: "asc" }],
    select: { date: true, close: true },
  })) as Array<{ date: Date; close: number }>;

  const newestClose = stockCloses[stockCloses.length - 1];
  const priceCutoff = new Date(now.getTime() - PRICE_MAX_AGE_DAYS * 86_400_000);
  // A holiday Monday reaching back to Friday's close is correct and must keep
  // working. A suspended-but-still-`isActive` instrument being handed a P/E and
  // a market cap off a close from last year, stamped with a fresh
  // `ratiosDerivedAt`, is not — and the only trace of it was
  // `ratiosPriceDate`, which nothing reads.
  const priceIsFresh =
    newestClose !== undefined &&
    Number.isFinite(newestClose.close) &&
    newestClose.date >= priceCutoff;
  const usablePrice = priceIsFresh ? newestClose : undefined;
  const stalePrice = newestClose !== undefined && !priceIsFresh;

  return { usablePrice, stalePrice, stockCloses, actions };
}

/**
 * Ratios for a company that has NO XBRL FILING — MONEY-1346 / MONEY-1260.
 *
 * ## The population, measured
 *
 * Prod 2026-09-05: **1,248 Indian symbols hold EXTRACTED ANNUAL rows in
 * `document_financial_extracts`, have zero XBRL filings, and hold ZERO
 * `stock_ratios` rows.** Not "written badly" — never considered. The candidate
 * query selected `xbrlFilings: { some: {} }`, so no P/E, no ROE and no margin
 * was ever possible for them, and no counter said so.
 *
 * ## Every write here is a CREATE, and that is the safety argument
 *
 * Because the cohort has no incumbent row, a write displaces nothing. The
 * one-way door that gates `XBRL_RATIOS_APPLY` — the first XBRL write replaces
 * the vendor row, so the gate can never again produce arming evidence — has no
 * analogue here, which is why this arm is `DOC_RATIOS_APPLY` and can be armed
 * on its own evidence. The authority guard stays anyway, and stays ADJACENT to
 * each write: `DOC_PDF` ranks BELOW `NSE_XBRL`, so if this ever does meet an
 * XBRL-derived row it refuses by construction and the refusal is counted.
 *
 * ## What it deliberately does NOT do
 *
 *   - **No TTM.** `deriveTtm` sums four discrete quarters and refuses a
 *     cumulative one, because a YTD column consuming a quarter's slot
 *     double-counts the year. Extract rows carry NO `cumulative` flag, so that
 *     refusal is unavailable — a quarterly extract could be either and nothing
 *     on the row says which. So the quarterly rows are not read at all here.
 *   - **No quarterly-derived column.** The period handed to `planRatiosWrite`
 *     is `"ANNUAL"` because the inputs ARE annual; the planner's
 *     `PERIOD_DEPENDENT_COLUMNS` refusal is therefore not being dodged, it is
 *     being satisfied.
 *
 * `ttmEps` IS supplied, from the annual row's own `eps`, and that is not a TTM
 * in the sense above: it is one printed figure covering twelve months, not a
 * sum of four rows whose periods must be checked for contiguity. `pe` is the
 * single most valuable column this cohort can gain and it is unreachable
 * without it. `ttmEbitda` comes from the SAME row for the same reason and on
 * the same basis, so `enterpriseValue` and `evToEbitda` cannot mix a group
 * numerator with a parent denominator the way the XBRL path's basis-fallback
 * can.
 */
async function deriveFromExtracts(
  inst: { id: string; symbol: string; exchange: string },
  ctx: DeriveContext,
): Promise<DeriveOutcome> {
  const { db, docApply, now, since, indexCloses } = ctx;
  const SOURCE: RatiosSource = "DOC_PDF";

  const rows = (await db.documentFinancialExtract.findMany({
    where: {
      instrumentId: inst.id,
      status: "EXTRACTED",
      periodType: "ANNUAL",
    },
    orderBy: [{ periodEnd: "desc" }],
    // A `take` counted in ROWS over a table where one period occupies several
    // returns fewer distinct periods than asked for — CLAUDE.md's
    // duplication-factor rule, MONEY-1207. This said "eight annual periods"
    // and fetched eight ROWS, which the measurement showed can be as few as
    // TWO periods. The arithmetic, and the measured depth of the corpus that
    // bounds what any `take` can buy, are on the constant.
    take: ANNUAL_EXTRACT_ROWS_TAKE,
    select: {
      periodEnd: true,
      periodType: true,
      basis: true,
      revenueFromOperations: true,
      otherIncome: true,
      operatingIncomeExOtherIncome: true,
      ebitdaBeforeExceptionalItems: true,
      netIncome: true,
      totalAssets: true,
      totalLiabilities: true,
      totalEquity: true,
      totalDebt: true,
      totalCash: true,
      eps: true,
      faceValue: true,
      paidUpCapital: true,
    },
  })) as DocumentExtractRow[];

  const periods = selectAnnualExtractsByPeriod(rows);
  const latestRow = periods[0];
  if (latestRow === undefined) {
    return outcome("no-inputs", {
      fallback: "noAnnualExtract",
      cursor: await stampCursorOnly(inst, docApply, db, now, SOURCE),
    });
  }

  // ── F10 APPLIES TO THIS ARM TOO — MONEY-1401 F8b review ──────────────────
  //
  // The bound was wired at ONE of TWO write arms. `deriveOne` refuses a filer
  // whose newest ANNUAL is past {@link ANNUAL_MAX_AGE_DAYS}; this function
  // queries `{instrumentId, status: "EXTRACTED", periodType: "ANNUAL"}` with NO
  // `periodEnd` filter and never asked. So a doc-arm instrument whose newest
  // EXTRACTED annual is FY2018 had its balance-sheet ratios derived from a
  // seven-year-old year end and stamped with a THIS-WEEK `ratiosPriceDate` —
  // the exact hazard F10 names, in the sibling arm its own comment points at.
  //
  // {@link staleAnnualExclusion} cannot reach it: that predicate reads
  // `xbrlFilings`, and {@link DOC_ARM_WHERE} requires `xbrlFilings: {none:{}}`,
  // so every instrument this function sees satisfies its second OR arm ("no
  // annual filing at all") and is selected whatever its extracts say. 3,371
  // instruments have no filing at all on prod.
  //
  // Same verdict, same counter, same cursor discipline as `deriveOne`'s branch:
  // REFUSED, never fallen back to a quarterly, because a quarter's margin in a
  // year's column is unmarked on the row.
  if (annualRecencyVerdict(latestRow.periodEnd, now) !== "FRESH") {
    return outcome("stale-annual", {
      fallback: "extracts",
      cursor: await stampCursorOnly(inst, docApply, db, now, SOURCE),
    });
  }

  const latest = extractToRatioInputs(latestRow);
  // `periods[1]` is guaranteed a DIFFERENT period end — the selector collapses
  // both bases of one year to a single row. That is NOT the same as the two
  // rows sharing a basis, and this comment used to claim it was.
  //
  // `selectAnnualExtractsByPeriod` picks the basis PER PERIOD independently
  // (CONSOLIDATED preferred, standalone as fallback), so a company that filed
  // both bases this year and only standalone last year hands this line a
  // CONSOLIDATED closing against a STANDALONE prior — the consolidation gap,
  // one table over from where MONEY-1235 found it. CLAUDE.md records 664
  // symbols as standalone-only, and a model reading a PDF can find one basis
  // in one year for reasons of its own on top of that.
  //
  // Nothing is done about it HERE, deliberately: `deriveRatios` refuses a
  // mismatched pair for every ratio that spans two years, growth included
  // since MONEY-1346, so the guard sits at the one place both this path and
  // the XBRL path route through rather than in a copy on each side.
  const priorRow = periods[1];
  const ratios = deriveRatios(
    latest,
    priorRow ? extractToRatioInputs(priorRow) : undefined,
  );

  const { usablePrice, stalePrice, stockCloses, actions } =
    await loadPriceContext(inst, latestRow.periodEnd, ctx);

  const shareCount = deriveShareCount(latest);

  // ABSOLUTE RUPEES on every money argument — `deriveValuation` says so of its
  // own inputs, and the extract stores CRORES. `extractToRatioInputs` has
  // already converted the copies inside `values`, so they are read back from
  // there rather than re-scaled here: one conversion, one place.
  const valuation = deriveValuation({
    price: usablePrice?.close,
    shares: shareCount?.shares,
    // The annual row's own printed EPS — see the header for why this is not the
    // TTM aggregation this path refuses.
    ttmEps: latestRow.eps ?? undefined,
    ttmEbitda: latest.reportedIncome?.ebitdaBeforeExceptionalItems,
    totalEquity: latest.values.totalEquity,
    // `values.borrowings` is the extract's `totalDebt` — the unsplit total. It
    // is passed HERE explicitly because `projectFinancials` builds a
    // non-lender's balance-sheet debt from the current/non-current pair, which
    // a document reading does not have; see `document-ratio-inputs.ts`.
    totalDebt: latest.values.borrowings,
    totalCash: latest.values.cashAndCashEquivalents,
    ttmDividendPerShare: ttmDividendPerShare(actions, usablePrice?.date ?? now)
      .total,
  });

  const annuals: AnnualPoint[] = periods.map((r) => ({
    fyEndYear: r.periodEnd.getUTCFullYear(),
    revenue: r.revenueFromOperations ?? null,
    netIncome: r.netIncome ?? null,
  }));

  const extended = deriveExtendedRatios({
    annuals,
    // `grossMargin` needs the cost-of-goods lines and `currentRatio` needs the
    // current-assets/liabilities split; the extraction prompt asks for neither,
    // so both are omitted and report their own "no-input" reason rather than
    // being fed a partial shape that would look like a derivation failure.
    family: latest.family,
    pe: valuation.pe,
    earningsGrowth: ratios.earningsGrowth,
    stockCloses,
    indexCloses,
    betaExcludeDates: betaExcludeDatesFrom(actions, since),
  });

  const plan = planRatiosWrite(ratios, valuation, "ANNUAL", extended);

  const counters: Pick<
    DeriveOutcome,
    | "stalePrice"
    | "ttmRefusal"
    | "ttmBasisFallback"
    | "betaReturnsDropped"
    | "betaExtremeReturns"
    | "unfilled"
    | "computedButUnstorable"
  > = {
    stalePrice,
    // NULL, not a refusal bucket: no TTM was ATTEMPTED on this path, and
    // recording a refusal reason would put this cohort into the counter that
    // sizes why the XBRL half's `pe` is null.
    ttmRefusal: null,
    ttmBasisFallback: false,
    betaReturnsDropped: extended.betaDiagnostics?.droppedReturns ?? 0,
    betaExtremeReturns: extended.betaDiagnostics?.extremeReturns ?? 0,
    unfilled: plan.unfilled,
    computedButUnstorable: plan.computedButUnstorable,
  };

  const worth = isPlanWorthWriting(plan);

  const incumbent = await db.stockRatios.findUnique({
    where: {
      symbol_exchange: { symbol: inst.symbol, exchange: inst.exchange },
    },
    select: { source: true },
  });

  if (!docApply) {
    const wouldWrite =
      worth.write && mayOverwriteFinancials(SOURCE, incumbent?.source);
    return outcome(wouldWrite ? "written" : "not-worth-writing", {
      ...counters,
      fallback: "extracts",
      cursor: "dry-run",
    });
  }

  if (!worth.write) {
    // The cursor stamp is a WRITE into this row too, so it carries the same
    // guard, ADJACENT to it — the discipline the XBRL path states and the
    // source scan enforces.
    if (!mayOverwriteFinancials(SOURCE, incumbent?.source)) {
      return outcome("not-worth-writing", {
        ...counters,
        fallback: "authorityBlocked",
        cursor: "authority-blocked",
      });
    }
    const stamped = await db.stockRatios.updateMany({
      where: { symbol: inst.symbol, exchange: inst.exchange },
      data: { ratiosDerivedAt: now },
    });
    return outcome("not-worth-writing", {
      ...counters,
      fallback: "extracts",
      cursor: stamped.count > 0 ? "stamped" : "no-row",
    });
  }

  const set = { ...plan.set } as Record<string, number>;

  // `ratiosFilingId` is DELIBERATELY not written below. It is `@db.ObjectId`
  // and an extract id would fit it structurally, which is precisely the danger:
  // the column names an `XbrlFiling`, and a reader joining it would find
  // nothing while the row looked fully attributed. `source: "DOC_PDF"` is the
  // honest provenance, and it is the field readers already branch on.

  // `DOC_PDF` loses to `NSE_XBRL` by construction, so this is the line that
  // makes "a filing always beats a reading of a filing" true even if the
  // control-flow ordering above is ever refactored away. It sits HERE, next to
  // the write, because a guard the next edit can be separated from its write
  // protects nothing.
  if (!mayOverwriteFinancials(SOURCE, incumbent?.source)) {
    return outcome("not-worth-writing", {
      ...counters,
      fallback: "authorityBlocked",
      cursor: "authority-blocked",
    });
  }

  await db.stockRatios.upsert({
    where: {
      symbol_exchange: { symbol: inst.symbol, exchange: inst.exchange },
    },
    create: {
      instrumentId: inst.id,
      symbol: inst.symbol,
      exchange: inst.exchange,
      source: SOURCE,
      ratiosPriceDate: usablePrice?.date ?? null,
      ratiosDerivedAt: now,
      ...set,
    },
    update: {
      source: SOURCE,
      ...(usablePrice ? { ratiosPriceDate: usablePrice.date } : {}),
      ratiosDerivedAt: now,
      ...set,
    },
  });

  return outcome("written", {
    ...counters,
    fallback: "extracts",
    cursor: "stamped",
    // Read BEFORE the upsert, above — after it, every row exists.
    docDisplacedIncumbent: incumbent !== null,
  });
}

async function deriveOne(
  inst: { id: string; symbol: string; exchange: string },
  apply: boolean,
  ctx: DeriveContext,
): Promise<DeriveOutcome> {
  const { db, now, since, indexCloses } = ctx;

  // The `select` carries `basis`, `coverage`, `filedAt` and `sourceUrl` on
  // purpose: they are exactly `selectFilingForPeriod`'s tie-break chain, and
  // without them the choice between a consolidated and a standalone filing for
  // the same period is whatever order Mongo returned.
  const FILING_SELECT = {
    id: true,
    periodEnd: true,
    periodType: true,
    facts: true,
    // From the STORED row, not the document — deriveTtm needs it to refuse a
    // YTD column summed alongside three discrete quarters.
    cumulative: true,
    // The filing's OWN exchange, carried so `deriveOne` can refuse to write a
    // row keyed to a different one. See the interlock below.
    exchange: true,
    basis: true,
    coverage: true,
    filedAt: true,
    sourceUrl: true,
  } as const;

  // Newest filing first, ANY period type — this is what decides `latest` and
  // feeds the TTM. ANNUAL carries the balance sheet a current ratio, P/B and
  // D/E all need; Indian QUARTERLY filings have none.
  const [recentFilings, annualFilings] = await Promise.all([
    db.xbrlFiling.findMany({
      where: { instrumentId: inst.id },
      orderBy: [{ periodEnd: "desc" }],
      take: 24,
      select: FILING_SELECT,
    }),
    // A SECOND, ANNUAL-ONLY query — the CAGR feed. See `ANNUAL_FILINGS_TAKE`
    // for why carving annuals out of the newest-24 mixed query made
    // `revenueGrowth5Y` unreachable for every active filer, forever.
    db.xbrlFiling.findMany({
      where: { instrumentId: inst.id, periodType: "ANNUAL" },
      orderBy: [{ periodEnd: "desc" }],
      take: ANNUAL_FILINGS_TAKE,
      select: FILING_SELECT,
    }),
  ]);
  if (recentFilings.length === 0) {
    // ── THE DOCUMENT-EXTRACT FALLBACK — MONEY-1346 ─────────────────────────
    //
    // Placed HERE and only here. An instrument with even one XBRL filing never
    // reaches this line, so a filer can never be derived from a model's reading
    // of a PDF while its own machine-readable filing sits unread — which is the
    // ordering `FINANCIALS_AUTHORITY` already states (NSE_XBRL outranks
    // DOC_PDF) expressed as control flow rather than only as a guard.
    return deriveFromExtracts(inst, ctx);
  }

  // ── ONE filing per reported period ───────────────────────────────────────
  const recentWinners = selectPeriodWinners(
    recentFilings as unknown as Array<RatiosFilingRow & { facts: unknown }>,
  );
  const annualWinners = selectPeriodWinners(
    annualFilings as unknown as Array<RatiosFilingRow & { facts: unknown }>,
  );

  const latest = recentWinners[0];
  if (!latest) {
    return outcome("no-inputs", {
      cursor: await stampCursorOnly(inst, apply, db, now, "NSE_XBRL"),
    });
  }
  // ── THE EXCHANGE INTERLOCK — MONEY-1299 ─────────────────────────────────
  //
  // `stock_ratios` is @@unique([symbol, exchange]) and this job keys the upsert
  // on the INSTRUMENT's exchange, while the filings it derives from carry their
  // own. Those two disagree far more often than not: measured on prod
  // 2026-08-31, 2,169 of 2,763 selectable instruments are the company's BSE row
  // and `xbrl_filings.exchange` is "NSE" on all 108,022 filings, because
  // `resolveInstrumentId`'s ISIN leg was an unordered `findFirst` over an ISIN
  // that 2,155 dual listings share.
  //
  // Writing anyway does not collide and does not error — it CREATES A SECOND
  // ROW for the company, `(SYMBOL, "BSE")` beside the incumbent
  // `(SYMBOL, "NSE")`. Every reader asking for the NSE listing (the stock
  // page's default) then keeps the stale vendor row forever, and because this
  // table has no `source` in its key, the gate that would have caught it can
  // never again produce arming evidence in that environment. A one-way door.
  //
  // So this is a WRITE-time refusal, not a selection filter, and it is COUNTED:
  // the repair script is the fix (78,882 reattachments, dry-run verified), and
  // this guard is what makes arming `XBRL_RATIOS_APPLY` safe BEFORE the repair
  // rather than dependent on it having already run. A data repair that has to
  // happen first is a precondition someone forgets; a guard that refuses is not.
  if (latest.exchange && latest.exchange !== inst.exchange) {
    return outcome("exchange-mismatch", {
      cursor: await stampCursorOnly(inst, apply, db, now, "NSE_XBRL"),
    });
  }

  const latestFinancials = readFacts(latest.facts);
  if (!latestFinancials) {
    // The head-of-queue squatter this stamp exists for — see `stampCursorOnly`.
    return outcome("no-inputs", {
      cursor: await stampCursorOnly(inst, apply, db, now, "NSE_XBRL"),
    });
  }

  const latestAnnual = annualWinners[0];

  // ── THE ANNUAL NEEDS A RECENCY BOUND TOO — MONEY-1401 F10 ────────────────
  //
  // `latestAnnual` had no `periodEnd` floor anywhere, so a filer that stopped
  // filing annuals and kept filing quarterlies had its balance-sheet ratios
  // derived from a years-old year end and stamped `ratiosDerivedAt: now` beside
  // a this-week `ratiosPriceDate`. See {@link ANNUAL_MAX_AGE_DAYS} for the bound
  // and the measurement it was chosen from.
  //
  // REFUSED, not fallen back. Falling back to `latestFinancials` would put a
  // quarter's margin in the same column as a year's with nothing on the row to
  // say which — the hazard the annual switch three paragraphs down exists to
  // remove — so a stale filer gets no write at all.
  //
  // THE CURSOR STAMP HERE IS NOT LOAD-BEARING, and this comment used to claim
  // it was ("cursor-stamped, so the rotation still advances past it"). It does
  // not: `stampCursorOnly` is an `updateMany` and a never-derived stale filer
  // has no `stock_ratios` row for it to match. The rotation is protected by
  // {@link staleAnnualExclusion}, which withdraws the cohort from the candidate
  // query on an armed run. The stamp stays because it is free and DOES advance
  // the filers that happen to carry a vendor row; this branch is now the braces
  // to that belt, reachable on a dry run and whenever the raw query and
  // `selectPeriodWinners` disagree about which annual is newest.
  //
  // An instrument that never filed an annual does NOT take this branch — the
  // verdict is only asked of an annual we HOLD. Those 195 reach the existing
  // period refusal in `planRatiosWrite`, which is correct and unchanged. That
  // `latestAnnual &&` is the whole of what the retired `ABSENT` verdict was
  // trying to say, moved to the caller that already had the answer.
  if (
    latestAnnual &&
    annualRecencyVerdict(latestAnnual.periodEnd, now) !== "FRESH"
  ) {
    return outcome("stale-annual", {
      cursor: await stampCursorOnly(inst, apply, db, now, "NSE_XBRL"),
    });
  }

  const latestAnnualFinancials = latestAnnual
    ? readFacts(latestAnnual.facts)
    : undefined;

  // Prior-year annual, for the YoY growth `deriveRatios` computes itself.
  //
  // `annualWinners[1]` is now guaranteed to be a DIFFERENT fiscal year. Before
  // MONEY-1235 it was frequently the SAME year's other basis, so the "growth"
  // written into `revenueGrowth`/`earningsGrowth` was the consolidation gap —
  // and it WAS written, because `periodType === "ANNUAL"` clears
  // `PERIOD_DEPENDENT_COLUMNS`' refusal.
  const priorAnnualFinancials = annualWinners[1]
    ? readFacts(annualWinners[1].facts)
    : undefined;

  // ── BALANCE-SHEET RATIOS COME FROM THE ANNUAL — MONEY-1401 ───────────────
  //
  // This used to pass `latestFinancials`, the newest filing of ANY period type.
  // Measured on prod 2026-09-13, the newest filing is QUARTERLY for **2,504 of
  // 2,607 symbols (96.0%)** — and 2,365 of those have an annual sitting right
  // there.
  //
  // A quarterly USUALLY carries no balance-sheet FIGURES, which is not quite
  // the same as carrying no balance sheet: `projectFinancials` always returns a
  // `balanceSheet` OBJECT, and what varies is whether its fields are populated.
  // Verified against the committed fixtures — CIPLA Q3FY26, RELIANCE Q1FY27 and
  // BHARTIARTL Q2FY20 all yield `totalAssets: undefined` and hence no
  // `roe`/`roa`/`roce`, while GLAXO Q2FY25 (a half-year filing, which SEBI does
  // require a balance sheet with) yields `totalAssets: 37,300,900,000` and all
  // three ratios. So the quarterly is a COIN FLIP and the annual is a
  // guarantee, and prod says the coin lands "no": the nightly dry run reported
  // `unfilled=[roce=657 (no EBIT or capital employed (needs a balance sheet)),
  // debtToEquity=616, currentRatio=570, …]` out of ~662 plans built.
  //
  // `planRatiosWrite` then refused the same columns a SECOND time for being
  // non-annual — so even GLAXO's populated quarterly balance sheet would not
  // have been written.
  //
  // So arming `XBRL_RATIOS_APPLY` would have replaced a vendor table that fills
  // `roe` on 95.5% and `roce` on 99.2% of rows with one that fills them on ~4%.
  // Fresh, and empty, on the two columns a reader looks at first. `latestAnnual`
  // was ALREADY loaded twelve lines up and already trusted for exactly this kind
  // of read further down — `:1574-1577` takes the valuation's equity, debt and
  // cash off it. Only this call was left on the quarterly.
  //
  // ONE call, not two. Passing the annual also makes the income ratios annual,
  // which is the right answer rather than a tolerated side effect: the sibling
  // arm `deriveFromExtracts` (`:1150`) already derives its margins from an
  // ANNUAL extract and hardcodes `"ANNUAL"` at `:1207`, and BOTH arms write the
  // SAME `stock_ratios` columns with nothing on the row to say which produced
  // it. A quarter's margin beside a year's margin in one column is the
  // `mayWriteIntoDay` hazard in a different table. Trailing figures are not
  // lost — `deriveTtm` computes them separately at `:1521` and is untouched.
  //
  // The fallback is the 139 symbols with no annual filing at all; there the
  // existing refusal path is correct and unchanged.
  //
  // The choice lives in `chooseRatioDerivationInputs` rather than inline,
  // because it has to be made ONCE and read in TWO places — here, and by
  // `planRatiosWrite` below. Those were two separate expressions before, which
  // is how they came to disagree.
  const derivation = chooseRatioDerivationInputs({
    latestFinancials,
    latestPeriodType: latest.periodType,
    // `readFacts` answers `null` for an annual whose facts will not parse. That
    // is ABSENT for this decision, not "an annual with no numbers" — there is
    // nothing to derive from either way, and the fallback to `latestFinancials`
    // is the same one a symbol with no annual at all gets.
    latestAnnualFinancials: latestAnnualFinancials ?? undefined,
    latestAnnualPeriodType: latestAnnual?.periodType,
  });
  const ratios = deriveRatios(
    derivation.financials,
    priorAnnualFinancials ?? undefined,
  );

  // ── THE COLUMN MUST NAME THE FILING THE RATIOS CAME FROM — MONEY-1401 F10 ─
  //
  // The upsert wrote `latest.id` unconditionally, and `latest` is the newest
  // filing of ANY period type — QUARTERLY for 2,504 of 2,607 symbols on prod.
  // So the one column a reader could use to date the fundamentals named a
  // filing that contributed only the TTM feed, while every balance-sheet ratio
  // on the row came from an annual the column does not mention. A reader
  // joining it would find a plausible filing and be told the wrong period.
  //
  // This file already refuses to write the column for exactly this reason on
  // the doc arm (`:1321-1325`): "the column names an `XbrlFiling`, and a reader
  // joining it would find nothing while the row looked fully attributed". Here
  // the row looked fully attributed AND the join resolved, which is worse.
  //
  // Read off `derivation.usedAnnual` rather than recomputing the choice — the
  // whole reason `chooseRatioDerivationInputs` exists is that the decision is
  // made once and read in several places, and a third expression of it here is
  // how the first two came to disagree.
  const ratiosFilingId =
    derivation.usedAnnual && latestAnnual ? latestAnnual.id : latest.id;

  const price = await loadPriceContext(inst, latest.periodEnd, ctx);
  const { usablePrice, stalePrice, stockCloses, actions } = price;

  // ── TTM: the BASIS is chosen FIRST, then the winners within it ───────────
  //
  // MONEY-1238. `deriveTtm` REFUSES a mixed-basis set and says why
  // ("consolidated 1000s with standalone 100s yields 2200, where the true
  // consolidated year is 4000 and the true standalone year is 400"), and
  // `classifyTtmInputs` counts the refusal — so the hazard was named, measured
  // and never actually removed. The feed was still assembled by picking the
  // best filing PER PERIOD and only afterwards asking whether the four agreed.
  // A filer that publishes both bases for three quarters and standalone only
  // for the fourth produces three CONSOLIDATED winners and one STANDALONE one,
  // and loses `pe` and `evToEbitda` for the year — even though four coherent
  // STANDALONE quarters were sitting right there in the same page of filings.
  //
  // So the basis is decided BEFORE the per-period selection, and the selection
  // then runs inside it. Each attempt is single-basis by construction, which
  // makes `mixed-basis` unreachable from this call site rather than merely
  // rare.
  //
  // PREFERENCE ORDER is the basis the REST OF THE ROW already uses, not a
  // blanket "CONSOLIDATED first". That distinction is the whole reason this is
  // safe: `enterpriseValue` is built from the ANNUAL winner's equity, debt and
  // cash, so a TTM EBITDA taken from the other basis would put a group
  // numerator over a parent denominator inside ONE ratio — mixed basis moved
  // one level up, which is strictly worse than the refusal it replaced. The
  // annual winner is itself CONSOLIDATED-preferred (`selectFilingForPeriod`),
  // so "prefer consolidated" still holds wherever a consolidated annual exists.
  const rowBasis = (latestAnnual ?? latest).basis;
  const quarterlyRows = recentFilings.filter(
    (f) => f.periodType === "QUARTERLY" && f.cumulative !== true,
  ) as unknown as Array<RatiosFilingRow & { facts: unknown }>;

  let ttm: TtmAggregate | null = null;
  let ttmBasis: string | null = null;
  let firstRefusal: TtmRefusal | null = null;
  let bestRefusal: TtmRefusal | null = null;

  for (const basis of ttmBasisOrder(rowBasis, quarterlyRows)) {
    // Discrete quarters only, one per period, newest four. Cumulative rows were
    // excluded above rather than left for `deriveTtm` to refuse, so a YTD
    // column cannot consume one of the four slots a real quarter needed.
    const quarterWinners = selectPeriodWinners(
      quarterlyRows.filter((f) => f.basis === basis),
    ).slice(0, 4);

    let unreadableQuarters = 0;
    const ttmQuarters: Array<{
      financials: XbrlFinancials;
      cumulative: boolean;
    }> = [];
    for (const f of quarterWinners) {
      const fin = readFacts(f.facts);
      if (fin === null) {
        unreadableQuarters++;
        continue;
      }
      ttmQuarters.push({ financials: fin, cumulative: f.cumulative === true });
    }

    // Classified BEFORE `deriveTtm` so "no quarters at all" stays
    // distinguishable from "three quarters and a hole". Both used to arrive as
    // the same bare null on `pe` and `evToEbitda`, for ~70% of filers.
    const inputRefusal = classifyTtmInputs(
      ttmQuarters.map((q) => ({ basis: q.financials.basis })),
      unreadableQuarters,
    );
    const candidate = inputRefusal === null ? deriveTtm(ttmQuarters) : null;
    if (candidate !== null) {
      ttm = candidate;
      ttmBasis = basis;
      break;
    }
    // A clean input set that `deriveTtm` still refuses (non-contiguous
    // quarters, a period span outside 60-120 days) gets its own bucket rather
    // than none, so the refusal accounting sums to every null TTM.
    const refusal: TtmRefusal = inputRefusal ?? "refused-by-rules";
    firstRefusal ??= refusal;
    // "no-quarters" from the preferred basis is the LEAST informative answer
    // available — it says the company files the other basis, not that a TTM
    // was impossible. A later attempt's more specific refusal wins the report.
    if (refusal !== "no-quarters") bestRefusal ??= refusal;
  }

  const ttmRefusal: TtmRefusal | null =
    ttm !== null ? null : (bestRefusal ?? firstRefusal);

  // Measured, not assumed: how often the coherent TTM came from a basis other
  // than the one the balance-sheet half of the row uses. It is also the exact
  // population whose `evToEbitda` is withheld below, so a reader can size that
  // refusal instead of discovering it as a column of nulls.
  const ttmBasisFallback = ttm !== null && ttmBasis !== rowBasis;

  // Share count comes from the filing (paid-up capital / face value), never
  // from a TTM sum — a share COUNT is an instant, not a flow.
  const shareCount = deriveShareCount(latestFinancials);

  const valuation = deriveValuation({
    price: usablePrice?.close,
    shares: shareCount?.shares,
    ttmEps: ttm?.eps,
    // ── `evToEbitda` needs BOTH legs on ONE basis — MONEY-1238 ─────────────
    //
    // Enterprise value is built from the ANNUAL winner's equity, debt and cash
    // just below; TTM EBITDA comes from the quarters. When those two disagree
    // about basis the ratio is a group numerator over a parent denominator (or
    // the reverse), and the two "differ by a MULTIPLE for any holding
    // company" — 360ONE FY2025 totalAssets is 19,768 Cr consolidated against
    // 7,332 Cr standalone. Withholding `ttmEbitda` refuses exactly
    // `evToEbitda` and nothing else.
    //
    // This is reachable TODAY, not only through the new fallback: a filer that
    // publishes a CONSOLIDATED annual and STANDALONE-only quarters produced a
    // homogeneous standalone TTM against consolidated debt and cash, passed
    // every existing guard, and wrote a mixed-basis EV/EBITDA.
    //
    // `pe` is deliberately NOT withheld. It is price over TTM EPS — no
    // balance-sheet leg, nothing to disagree with — and it is the column this
    // basis-first selection exists to make computable.
    ttmEbitda: ttmBasisFallback ? undefined : ttm?.ebitda,
    totalEquity: latestAnnualFinancials?.values.totalEquity ?? undefined,
    totalDebt: latestAnnualFinancials?.values.borrowings ?? undefined,
    totalCash:
      latestAnnualFinancials?.values.cashAndCashEquivalents ?? undefined,
    // ── ONE CLOCK for a ratio — MONEY-1238 ────────────────────────────────
    //
    // `dividendYield` is `ttmDividendPerShare / price`. The denominator is
    // TODAY'S close (bounded by `PRICE_MAX_AGE_DAYS` against `now`); the
    // numerator's twelve-month window used to END at the LATEST FILING'S
    // PERIOD END, so the two halves were measured on different clocks — and
    // for an annual-only filer the gap is a whole year.
    //
    // Concretely, for a March-year-end company whose newest filing is Q4
    // (`periodEnd` 31 March) evaluated in August: the window was 1-Apr-2025 to
    // 31-Mar-2026, which EXCLUDES the June final dividend — the largest of the
    // year for most Indian filers — while the price against which it is
    // divided is today's. Dividends are corporate actions with their own
    // ex-dates; nothing about them is scoped to a filing period.
    //
    // The price DATE, not `now`, so the row is self-describing: the yield is as
    // of the same close `ratiosPriceDate` stamps. They differ by at most
    // `PRICE_MAX_AGE_DAYS`, and using the stamped date means the numerator can
    // never include an ex-date later than the close in the denominator.
    //
    // The corporate-action read already covers this window: its floor is the
    // EARLIER of `now - 730d` and `periodEnd - 400d`, so a twelve-month window
    // ending at the price date is strictly inside what was fetched.
    ttmDividendPerShare: ttmDividendPerShare(actions, usablePrice?.date ?? now)
      .total,
  });

  // ── Extended half ─────────────────────────────────────────────────────────
  //
  // The CAGR feed comes from the ANNUAL-ONLY winners, so `cagr()` finally sees
  // the six distinct fiscal years a 5-year CAGR needs. It already refuses a gap
  // (it matches `fyEndYear === latest − years` exactly rather than counting
  // rows), so a hole in the history still yields null instead of a CAGR over
  // the wrong number of years.
  const annuals: AnnualPoint[] = [];
  for (const f of annualWinners) {
    const fin = readFacts(f.facts);
    if (!fin) continue;
    annuals.push({
      fyEndYear: f.periodEnd.getUTCFullYear(),
      revenue: fin.values.revenueFromOperations ?? null,
      netIncome: fin.values.profitForPeriod ?? null,
    });
  }

  const extended = deriveExtendedRatios({
    annuals,
    latestAnnualIncome: latestAnnualFinancials
      ? {
          revenue: latestAnnualFinancials.values.revenueFromOperations,
          costOfMaterialsConsumed:
            latestAnnualFinancials.values.costOfMaterialsConsumed,
          purchasesOfStockInTrade:
            latestAnnualFinancials.values.purchasesOfStockInTrade,
          changesInInventories:
            latestAnnualFinancials.values.changesInInventories,
        }
      : undefined,
    latestBalanceSheet: latestAnnualFinancials
      ? {
          currentAssets: latestAnnualFinancials.values.currentAssets,
          currentLiabilities: latestAnnualFinancials.values.currentLiabilities,
        }
      : undefined,
    family: latestFinancials.family,
    pe: valuation.pe,
    earningsGrowth: ratios.earningsGrowth,
    stockCloses: stockCloses as ClosePoint[],
    indexCloses,
    // `DailyPrice.close` is mixed-authority and bhavcopy stores it RAW
    // (MONEY-1175), and `adjClose` is populated on 0 of 10,615,160 rows, so
    // there is no adjusted series to switch to. Dropping the ex-date's RETURN
    // removes the ~ln(2) artefact without rescaling anything.
    betaExcludeDates: betaExcludeDatesFrom(actions, since),
  });

  // Same `derivation` the ratios came from — MONEY-1401. Reporting the newest
  // filing's period here while deriving from the annual is precisely the
  // disagreement this ticket is about, and it cannot recur now that both reads
  // are one value.
  const plan = planRatiosWrite(
    ratios,
    valuation,
    derivation.periodType,
    extended,
  );

  // Built AFTER the plan so the planner's own diagnostics can ride along —
  // MONEY-1238. `unfilled` and `computedButUnstorable` are produced on every
  // call and were read by nothing, which is why the module's promise of "gross
  // margin null for 3,900 lenders" was unkeepable.
  const counters: Pick<
    DeriveOutcome,
    | "stalePrice"
    | "ttmRefusal"
    | "ttmBasisFallback"
    | "betaReturnsDropped"
    | "betaExtremeReturns"
    | "unfilled"
    | "computedButUnstorable"
  > = {
    stalePrice,
    ttmRefusal,
    ttmBasisFallback,
    betaReturnsDropped: extended.betaDiagnostics?.droppedReturns ?? 0,
    betaExtremeReturns: extended.betaDiagnostics?.extremeReturns ?? 0,
    unfilled: plan.unfilled,
    computedButUnstorable: plan.computedButUnstorable,
  };

  const worth = isPlanWorthWriting(plan);

  // ── Write authority ──────────────────────────────────────────────────────
  //
  // NSE_XBRL is the TOP of FINANCIALS_AUTHORITY, so in practice this always
  // passes today. It is here anyway, and it imports the SHARED helper rather
  // than testing `source !== "NSE_XBRL"` locally, for the reason
  // `financials-write-authority.test.ts` exists: adding a source to the order
  // must stay a ONE-FILE edit. A hand-rolled check behind a guard-shaped name
  // is how six writers drift into six different orderings, and this table has
  // no `source` in its unique key, so the drift is only visible as a wrong
  // number nobody can attribute.
  //
  // It is read BEFORE the `worth` branch, not after, because BOTH branches
  // write to this row — the worthwhile one writes ratios, the refused one
  // writes only the rotation cursor — and neither may touch a row a
  // higher-authority source owns.
  const incumbent = await db.stockRatios.findUnique({
    where: {
      symbol_exchange: { symbol: inst.symbol, exchange: inst.exchange },
    },
    select: { source: true },
  });
  // Dry run: report what WOULD land, mutate nothing. The cursor therefore does
  // NOT advance on an unarmed run, which is correct and is why the arm flag —
  // not the cursor — is what makes the job progress.
  if (!apply) {
    const wouldWrite =
      worth.write && mayOverwriteFinancials("NSE_XBRL", incumbent?.source);
    return outcome(wouldWrite ? "written" : "not-worth-writing", {
      ...counters,
      cursor: "dry-run",
    });
  }

  if (!worth.write) {
    // ── Cursor-only stamp for a REFUSED instrument ─────────────────────────
    //
    // A refusal is a decision, not a transient. Left unstamped, an instrument
    // that can never produce a worthwhile plan parks at the head of the
    // never-derived rank FOREVER and consumes a slot every night — the same
    // starvation the old `symbol asc` ordering caused, arriving by a different
    // door. The sibling projection job stamps `projectedAt` on its authority
    // refusals for exactly this reason.
    //
    // `updateMany`, not `update`, so a missing row is a `count: 0` rather than
    // a P2025 throw — and that count is the honest measure of how many
    // instruments have no row to hold a cursor. This job must NOT create an
    // empty row stamped NSE_XBRL just to hold one: `isPlanWorthWriting`'s whole
    // argument is that a nearly-empty row wearing a better source is worse than
    // no write at all.
    //
    // Only `ratiosDerivedAt` is sent. Not `source`, not `ratiosFilingId`, not a
    // single ratio column — the model documents this field as the nightly
    // cursor, and "this job looked at this row at time T" is exactly what a
    // stamp on a refusal asserts.
    //
    // The guard is re-evaluated here rather than hoisted to one `mayWrite`
    // above, and the repetition is deliberate: a guard that is not ADJACENT to
    // the write it gates protects nothing the next edit cannot separate them
    // by. `mayOverwriteFinancials` is pure and `incumbent` is already in hand,
    // so the second call costs nothing but the line.
    if (!mayOverwriteFinancials("NSE_XBRL", incumbent?.source)) {
      return outcome("not-worth-writing", {
        ...counters,
        cursor: "authority-blocked",
      });
    }
    const stamped = await db.stockRatios.updateMany({
      // Keyed like every other cursor touch in this file — see the
      // RatiosDerivedMarker comment for why this must match the upsert.
      where: { symbol: inst.symbol, exchange: inst.exchange },
      data: { ratiosDerivedAt: now },
    });
    return outcome("not-worth-writing", {
      ...counters,
      cursor: stamped.count > 0 ? "stamped" : "no-row",
    });
  }

  // Adjacent to its write, for the reason given at the cursor stamp above.
  if (!mayOverwriteFinancials("NSE_XBRL", incumbent?.source)) {
    return outcome("not-worth-writing", {
      ...counters,
      cursor: "authority-blocked",
    });
  }

  // PARTIAL UPDATE. Only the keys the plan actually filled are sent, so
  // `targetPrice` / `recommendation` — and any owned column this filing could
  // not support — keep whatever is already there. See the file header.
  const set = { ...plan.set } as Record<string, number>;

  await db.stockRatios.upsert({
    where: {
      symbol_exchange: { symbol: inst.symbol, exchange: inst.exchange },
    },
    create: {
      instrumentId: inst.id,
      symbol: inst.symbol,
      exchange: inst.exchange,
      source: "NSE_XBRL",
      ratiosFilingId,
      ratiosPriceDate: usablePrice?.date ?? null,
      ratiosDerivedAt: now,
      ...set,
    },
    update: {
      source: "NSE_XBRL",
      ratiosFilingId,
      // `ratiosPriceDate` is OMITTED when no fresh close was used, rather than
      // written as null. The plan omits every price-derived column in that
      // case, so the row keeps the previous run's `pe`/`marketCap` — nulling
      // the stamp beside them would leave those numbers unattributable, which
      // is the exact provenance lie this pair of stamps exists to prevent.
      ...(usablePrice ? { ratiosPriceDate: usablePrice.date } : {}),
      ratiosDerivedAt: now,
      ...set,
    },
  });

  return outcome("written", { ...counters, cursor: "stamped" });
}
