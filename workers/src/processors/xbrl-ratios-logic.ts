/**
 * `xbrl-ratios` — the PURE decisions (no Prisma, no clock, no network).
 *
 * MONEY-1235. Every function here was previously an inline expression inside
 * `xbrl-ratios.ts`, where nothing could assert it. Three of the four bugs that
 * ticket found were exactly that shape — a policy written as one line of a
 * query object, described correctly by a comment, and implemented as something
 * else:
 *
 *   1. The nightly rotation was documented as a stale-first marker cursor and
 *      implemented as `orderBy: [{ symbol: "asc" }]`. With ~2,108 filing-bearing
 *      symbols and a limit of 1,000, the same alphabetical first thousand were
 *      re-derived every night and roughly M–Z was NEVER derived. MONEY-1211
 *      verbatim, and the job outcome looked healthy every single run.
 *   2. The word `basis` did not appear in the processor at all, while 1,486 of
 *      2,108 symbols (70.5%) file BOTH consolidated and standalone for their
 *      newest year. `filings[0]` was therefore a coin flip between two numbers
 *      that differ by a multiple.
 *   3. The CAGR feed was carved out of a newest-24 mixed-period query, which
 *      spans ~2.4–4.8 fiscal years for an active filer — so the FY(n−5) point a
 *      5-year CAGR needs was never fetched, and the recorded reason blamed the
 *      backfill for history that was sitting in the table.
 *
 * The rule this module encodes, in one sentence: **a selection whose behaviour
 * only shows up across nights, or only on the 70% of symbols that dual-file,
 * has to be a function you can call twice in a test.**
 *
 * @see workers/src/processors/xbrl-ratios.ts (the only caller)
 */

import { selectFilingForPeriod } from "@usemoney/core/market-data";

// ═══════════════════════════════════════════════════════════════════════════
// 1. The nightly rotation
// ═══════════════════════════════════════════════════════════════════════════

/** One filing-bearing active instrument the run may derive. */
export interface RatiosTargetCandidate {
  id: string;
  symbol: string;
  exchange: string;
}

/**
 * One `StockRatios` row's cursor stamp.
 *
 * `ratiosDerivedAt` arrives as `Date | null` because it is SELECTED, not
 * MATCHED. That distinction is the whole reason the ranking happens here in
 * memory instead of in the WHERE clause: on Prisma + MongoDB a
 * `{ ratiosDerivedAt: null }` filter does NOT match a document where the field
 * is entirely ABSENT, and ABSENT is exactly the shape of all 2,135 Tickertape-era
 * rows plus every row this job has not yet stamped. Four tickets in this repo
 * have been that bug (MONEY-1050, 1205, 1234, 1235). Reading the value and
 * deciding in JavaScript cannot have it.
 */
export interface RatiosDerivedMarker {
  /**
   * Keyed on (symbol, exchange) — the SAME tuple the upsert writes on
   * (`where: { symbol_exchange: … }`), NOT `instrumentId` — MONEY-1235.
   *
   * The cursor was written by one key and read by another. `StockRatios`'
   * upsert `update:` branch never sets `instrumentId`, so an existing row keeps
   * whatever it already had, and `sync-prod-to-qa.sh` delivers `stock_ratios`
   * into QA carrying PROD's ObjectIds while `instrument_mappings` is QA-DIRECT
   * with its own. Every marker lookup then missed: the row was stamped nightly,
   * the ranker never found it, the instrument stayed rank-0 forever and the
   * same first N symbols were re-derived every night — MONEY-1211 exactly,
   * wearing the counter added to prevent it. `cursorUnstampable` stayed 0
   * throughout, because the write genuinely succeeded.
   */
  symbol: string;
  exchange: string;
  ratiosDerivedAt: Date | null;
}

/**
 * Order the population stale-first and cut it to `limit`.
 *
 * The contract, in the order the ranks apply:
 *
 *   1. **Never derived first.** An instrument with no `StockRatios` row at all,
 *      or with a row whose `ratiosDerivedAt` is null/absent/unparseable. These
 *      are the rows that have never had a number written, so they are worth
 *      more than a re-derive of a row that is already correct.
 *   2. **Then least-recently derived**, `ratiosDerivedAt` ascending.
 *   3. **Ties broken on `symbol`**, always, so two runs over an identical
 *      population produce an identical batch. `selectFilingForPeriod`'s doc
 *      states the same requirement for the same reason: a selection that
 *      depends on the order the DB happened to return rows in is not
 *      reproducible, and its bugs are not either.
 *
 * ## Why this ADVANCES, which the old ordering did not
 *
 * A write stamps `ratiosDerivedAt = now`, which moves that instrument from the
 * head of rank 2 to its tail. The next run therefore receives the next
 * `limit` instruments, and the cursor sweeps the universe. Ordering by
 * `symbol` — a column that is CONSTANT for an instrument across every run —
 * cannot do that by construction: it hands every run the same first N rows
 * forever.
 *
 * Two honest consequences, written down rather than discovered later:
 *
 *   - **A dry run does not advance.** Nothing is stamped when `apply` is false,
 *     so an unarmed environment re-derives the same head every night. That is
 *     correct (a dry run must not mutate) and it is why the arm flag, not the
 *     cursor, is what makes the job progress.
 *   - **An instrument the run REFUSES must still be stamped**, or it parks at
 *     the head of rank 1 permanently and starves everything behind it. The
 *     caller does that in one batched `updateMany`; see `xbrl-ratios.ts`. The
 *     sibling projection job learned the same lesson about `projectedAt`:
 *     "the refusal is a decision, not a transient".
 */
/**
 * The ONE key the rotation cursor is read by, matching the tuple the upsert
 * writes on — MONEY-1235. A separator that cannot occur in a symbol or an
 * exchange, so `AB|C` and `A|BC` cannot collide.
 */
export function markerKey(symbol: string, exchange: string): string {
  return `${symbol}\u0000${exchange}`;
}

export function rankRatiosTargets(
  candidates: readonly RatiosTargetCandidate[],
  markers: readonly RatiosDerivedMarker[],
  limit: number,
): RatiosTargetCandidate[] {
  const derivedAt = new Map<string, number>();
  for (const m of markers) {
    const t = m.ratiosDerivedAt;
    // An Invalid Date is treated as never-derived, not as time 0. `NaN`
    // compares false against everything, so a naive sort would scatter such
    // rows unpredictably through the batch.
    if (t instanceof Date && Number.isFinite(t.getTime())) {
      derivedAt.set(markerKey(m.symbol, m.exchange), t.getTime());
    }
  }

  return [...candidates]
    .sort((a, b) => {
      const ta = derivedAt.get(markerKey(a.symbol, a.exchange));
      const tb = derivedAt.get(markerKey(b.symbol, b.exchange));
      if (ta === undefined && tb !== undefined) return -1;
      if (ta !== undefined && tb === undefined) return 1;
      if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, Math.max(0, limit));
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. One period, two bases, one answer
// ═══════════════════════════════════════════════════════════════════════════

/** The filing fields the selection needs. A superset of what Prisma returns. */
export interface RatiosFilingRow {
  id: string;
  periodEnd: Date;
  periodType: string;
  cumulative: boolean;
  /**
   * The FILING's own exchange, distinct from the instrument's.
   *
   * Optional because older callers and fixtures do not carry it; the interlock
   * in `deriveOne` treats absent as "cannot compare" and does not refuse, so a
   * caller that omits it degrades to the previous behaviour rather than
   * silently blocking every write.
   */
  exchange?: string | null;
  basis: string;
  coverage?: number | null;
  filedAt?: Date | null;
  sourceUrl?: string | null;
}

/**
 * How many ANNUAL filing ROWS to fetch for the CAGR feed — MONEY-1235.
 *
 * `cagr()` needs `years + 1` usable points: 4 for a 3-year CAGR, **6 for a
 * 5-year**. This is a take counted in ROWS over a population where one logical
 * unit (a fiscal year) occupies up to TWO rows, because 70.5% of filers publish
 * both a consolidated and a standalone annual. That is the MONEY-1207 rule
 * exactly — "a batch must be a MULTIPLE of the population's duplication
 * factor" — and getting it wrong returns fewer distinct years than asked for
 * while looking like it worked.
 *
 * So: 6 years × a duplication factor of 2 = 12, rounded up to **16** for the
 * filer that also files a revision or a transition year. XBRL history floors at
 * 2018 (CLAUDE.md), so 16 rows can never span more than the ~8 fiscal years
 * that exist, and there is no page to lose.
 *
 * The old code carved annuals out of the newest-24 MIXED-period query. An
 * active filer publishes ~5 rows/year single-basis and ~10/year dual-basis, so
 * 24 rows covered ~2.4–4.8 years: the FY(n−5) point sat around row 30+ and was
 * never fetched. `revenueGrowth5Y` / `earningsGrowth5Y` were therefore null for
 * every active filer forever, no matter how complete the backfill — and the
 * reason recorded was `insufficient-history`, which blames the backfill for
 * history that is in the table and merely outside the query window.
 */
export const ANNUAL_FILINGS_TAKE = 16;

/**
 * How many ANNUAL EXTRACT ROWS to fetch for the same feed — MONEY-1346.
 *
 * A SEPARATE number from `ANNUAL_FILINGS_TAKE` because the duplication factor
 * is different, and it is worse. `XbrlFiling`'s unique key carries `basis` but
 * not a document id, so one period occupies at most TWO rows. The extract
 * table keys on `(documentId, periodEnd, periodType, basis)`, and an annual
 * report prints the PRIOR year as its comparative — so FY2025 appears again in
 * the FY2026 report, on both bases, from two different documents.
 *
 * MEASURED on prod 2026-09-05 over the 1,288 instruments holding EXTRACTED
 * ANNUAL rows, rather than reasoned about:
 *
 *   rows per (instrument, periodEnd)   1 -> 1,551   2 -> 770   3 -> 3   4 -> 17
 *   rows needed to reach 6 distinct periods            max 19
 *
 * So 24 = six periods at the measured worst case of four rows each, which is
 * what `revenueGrowth5Y` / `earningsGrowth5Y` need. `take: 8` returned as few
 * as TWO distinct periods and put both 5Y columns out of reach.
 *
 * READ THE SECOND HALF OF THAT MEASUREMENT BEFORE FILING A BUG ABOUT A NULL
 * 5Y CAGR. The corpus does not go back far enough for almost anyone:
 *
 *   distinct annual periods per instrument   1 -> 265   2 -> 1,017
 *                                            3 -> 1   5 -> 2   6 -> 1
 *                                            8 -> 1   15 -> 1
 *
 * 1,282 of 1,288 hold ONE or TWO years. Raising this constant makes the 3Y
 * column reachable for 5 instruments and the 5Y column for 3. That is the
 * honest size of the prize: the `take` was a real ceiling, and it was not the
 * BINDING one. The binding one is how many annual reports we have read per
 * company, which only the drain moves.
 */
export const ANNUAL_EXTRACT_ROWS_TAKE = 24;

/**
 * Collapse a filing set to ONE winner per reported period.
 *
 * The group key is `(periodEnd, periodType, cumulative)` — the same identity
 * `XbrlFiling`'s unique key uses, minus `basis`, because `basis` is precisely
 * what is being resolved. `cumulative` stays IN the key deliberately: a
 * year-to-date column and the discrete quarter that shares its `periodEnd` are
 * different facts, and merging them would let `selectFilingForPeriod` return
 * the YTD row on a basis tie-break and silently triple a quarter's revenue.
 *
 * Within a group `selectFilingForPeriod` decides: CONSOLIDATED over
 * STANDALONE, then coverage, then filing date, then source URL — a TOTAL
 * order, so the winner is a function of the candidate SET and not of the order
 * Mongo returned it in. That property is load-bearing here: consolidated and
 * standalone share a `periodEnd`, Mongo's equal-key order is unspecified, and
 * `filings[0]` therefore flipped between two different truths on alternate
 * nights with no run ever looking wrong.
 *
 * Output order is `periodEnd` DESC, then non-cumulative before cumulative,
 * then ANNUAL before any other period type, then `id` — total, so callers can
 * take "the newest" without re-sorting and get the same answer every time.
 */
export function selectPeriodWinners<T extends RatiosFilingRow>(
  filings: readonly T[],
): T[] {
  const groups = new Map<string, T[]>();
  for (const f of filings) {
    const key = `${f.periodEnd.getTime()}|${f.periodType}|${f.cumulative ? 1 : 0}`;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }

  const winners: T[] = [];
  for (const g of groups.values()) {
    const w = selectFilingForPeriod(g);
    if (w) winners.push(w);
  }

  // ANNUAL wins a same-`periodEnd` tie against QUARTERLY, and that is not
  // cosmetic. Indian filers publish Q4 and the full year on the SAME period
  // end, and `planRatiosWrite` refuses every period-dependent column (roe, roa,
  // roce, revenueGrowth, earningsGrowth) unless it is told ANNUAL. Under the
  // old arbitrary pick, whether a company got a ROCE at all depended on which
  // row the query happened to return first.
  const typeRank = (t: string): number => (t === "ANNUAL" ? 0 : 1);
  return winners.sort(
    (a, b) =>
      b.periodEnd.getTime() - a.periodEnd.getTime() ||
      Number(a.cumulative) - Number(b.cumulative) ||
      typeRank(a.periodType) - typeRank(b.periodType) ||
      a.id.localeCompare(b.id),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Why a TTM died
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Why `deriveTtm` will refuse — or `null` when it will not.
 *
 * `pe` and `evToEbitda` both need a TTM, and before MONEY-1235 the TTM feed
 * took `filter(QUARTERLY).slice(0, 4)` off a mixed-basis query: for a
 * dual-basis filer that is TWO quarters × TWO bases, `deriveTtm` correctly
 * refused on `ttmBasisIsConsistent`, and **`pe` and `evToEbitda` were therefore
 * never computed for ~70% of filers** — reported with the same bare null as a
 * company that has genuinely never filed a quarter.
 *
 * Naming the causes separately is the whole point. "TTM unavailable" is not
 * actionable; "1,486 symbols refused for mixed basis, 90 for missing quarters"
 * says which half is a bug.
 */
export type TtmRefusal =
  | "no-quarters"
  | "insufficient-quarters"
  | "mixed-basis"
  | "unreadable-facts"
  /**
   * The input set was clean and `deriveTtm` still refused — a non-contiguous
   * run of quarters, or a period span outside 60–120 days. Recorded by the
   * CALLER, not by {@link classifyTtmInputs}, so that every null TTM has a
   * named cause and none of them arrive as an un-counted absence.
   */
  | "refused-by-rules";

export function classifyTtmInputs(
  quarters: ReadonlyArray<{ basis: string | null }>,
  /** Quarterly winners whose stored `facts` JSON could not be read back. */
  unreadable: number,
): TtmRefusal | null {
  if (quarters.length === 0) {
    return unreadable > 0 ? "unreadable-facts" : "no-quarters";
  }
  if (quarters.length < 4) return "insufficient-quarters";
  if (new Set(quarters.map((q) => q.basis)).size !== 1) return "mixed-basis";
  // Everything else `deriveTtm` still judges for itself — contiguity, period
  // span, the all-four-or-none field rule. This function only classifies the
  // failures that are visible from the INPUT SET, which are the ones the
  // selection above is responsible for.
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Price hygiene
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How old the close feeding a valuation may be — MONEY-1235.
 *
 * The read used to be `dailyPrice.findFirst({ orderBy: date desc })` with NO
 * lower bound at all. A holiday Monday correctly reaching back to Friday's
 * close is the case that bound has to permit; a suspended-but-still-`isActive`
 * instrument getting a P/E and a market cap off a close from 2023, stamped
 * with a fresh `ratiosDerivedAt`, is the case it has to stop. The only trace of
 * the second was `ratiosPriceDate`, which nothing reads.
 *
 * Seven days clears the longest run of consecutive non-trading days an Indian
 * calendar produces (a weekend either side of a mid-week holiday cluster) with
 * room to spare, and is short enough that a suspended counter falls out within
 * one week rather than indefinitely. The price series itself is dense — 3.74M
 * `daily_prices` rows inside the trailing 730 days as of 2026-08-21 — so this
 * bound costs nothing on a healthy instrument.
 */
/**
 * Which filing the ratios are DERIVED FROM, and what to tell the planner.
 *
 * ## Why this is a function and not two expressions at the call site
 *
 * `deriveOne` used to make this decision twice, inline, and the two halves
 * disagreed — that disagreement IS MONEY-1401. It passed `latestFinancials`
 * (the newest filing of any period type) to `deriveRatios`, and separately told
 * `planRatiosWrite` about `latest.periodType`. Both read the same variable, so
 * they looked consistent; what neither noticed is that the newest filing is
 * QUARTERLY for **2,504 of 2,607 symbols (96.0%)** on prod, a quarterly carries
 * no balance sheet, and so every stock ratio was undefined before the planner's
 * period refusal ever got a chance to run.
 *
 * Two expressions that must agree, sitting 200 lines apart, is exactly the
 * shape a source scan cannot police: it can prove a call site exists, never
 * which of two near-identical arguments is in it. So the decision moves here,
 * where it is one value and can be tested directly.
 *
 * ## The rule
 *
 * Balance-sheet ratios need balance-sheet FIGURES, and an annual filing always
 * has them where a quarterly usually does not. Not never: GLAXO's Q2FY25
 * half-year filing carries `totalAssets` and yields roe/roa/roce, while CIPLA
 * Q3FY26, RELIANCE Q1FY27 and BHARTIARTL Q2FY20 do not (verified against the
 * committed fixtures). The quarterly is a coin flip; on prod it lands "no" on
 * 657 of ~662 plans. So: prefer the latest annual, and fall back to the newest
 * filing only when the symbol has no annual at all (139 symbols on prod), where
 * the planner's existing refusal is the correct outcome and is unchanged.
 *
 * `periodType` describes the filing the ratios CAME FROM, never the newest one
 * on file — reporting "QUARTERLY" about an annual derivation would re-refuse
 * `PERIOD_DEPENDENT_COLUMNS` for a reason that is no longer true.
 */
export interface RatioDerivationChoice<F> {
  /** The facts to hand `deriveRatios`. */
  financials: F;
  /** What to tell `planRatiosWrite`. */
  periodType: "ANNUAL" | "QUARTERLY";
  /** True when the annual was used — for counters and diagnostics. */
  usedAnnual: boolean;
}

export function chooseRatioDerivationInputs<F>(args: {
  /** Facts of the newest filing of ANY period type. Never absent. */
  latestFinancials: F;
  /** Period type of that newest filing. */
  latestPeriodType: string | null | undefined;
  /** Facts of the newest ANNUAL filing, when the symbol has one. */
  latestAnnualFinancials: F | undefined;
  /** Period type of that annual — read rather than assumed. */
  latestAnnualPeriodType: string | null | undefined;
}): RatioDerivationChoice<F> {
  if (args.latestAnnualFinancials !== undefined) {
    return {
      financials: args.latestAnnualFinancials,
      // Read the row's own value rather than hardcoding "ANNUAL": these rows
      // come from `selectPeriodWinners` over a set filtered to annuals, and a
      // filter that silently widens must not be laundered into a claim here.
      periodType:
        args.latestAnnualPeriodType === "ANNUAL" ? "ANNUAL" : "QUARTERLY",
      usedAnnual: true,
    };
  }
  return {
    financials: args.latestFinancials,
    periodType: args.latestPeriodType === "ANNUAL" ? "ANNUAL" : "QUARTERLY",
    usedAnnual: false,
  };
}

/**
 * How old the newest ANNUAL filing may be before its balance sheet stops
 * describing the company — MONEY-1401 F10.
 *
 * ## The hazard, which is NOT "a wrong number"
 *
 * `latestAnnual` had no `periodEnd` floor anywhere, so an `isActive` instrument
 * that stopped filing annuals after FY2019 and kept filing quarterlies got
 * `roe`/`roa`/`roce`/`revenueGrowth`/`earningsGrowth`/`pegRatio`/`assetTurnover`
 * derived from the FY2019 balance sheet — stamped `ratiosDerivedAt: now` beside
 * a this-week `ratiosPriceDate`. Every figure is a true statement about FY2019
 * and the ROW says it is current. That is "no data" converted into "stale data
 * wearing a fresh timestamp", which is exactly the hazard
 * {@link PRICE_MAX_AGE_DAYS} exists for on the price side.
 *
 * ## Why 730 and not 365 or 1095
 *
 * Chosen from the data, not from a round number. Measured on prod 2026-09-13
 * over the 2,793 active filing-bearing instruments (the post-repair steady
 * state; `scripts/data/reresolve-xbrl-instruments.ts` is what turns today's 630
 * into that), by age of the newest non-cumulative ANNUAL:
 *
 *     no annual at all   195
 *     < 1 year           986
 *     1-2 years        1,234      <- the bulk, and all of it healthy
 *     2-3 years          185
 *     3-5 years          177
 *     > 5 years           16
 *
 * There is a cliff between the second and third rows, and the filing calendar
 * says why. An Indian FY ends 31 March and results are due within 60 days, so
 * between one annual landing and the next the newest annual ages to roughly
 * 14-18 months in the ordinary course — a company that has filed everything on
 * time is routinely a year and a half past its own year end. 365 days would
 * refuse **1,612 of 2,598 (62.0%)** of a perfectly healthy population. 1,095
 * days lets through a filer that has missed TWO complete annual cycles.
 *
 * 730 refuses **378 of 2,598 (14.5%)** post-repair — and, on today's
 * un-repaired armed cohort, 339 of 559 (60.6%), which is a measure of the
 * un-run instrument repair rather than of this bound.
 *
 * ## The refusal is TOTAL, and deliberately not a fallback
 *
 * A stale annual does NOT fall back to the quarterly. That would reinstate the
 * defect MONEY-1401 fixed one paragraph earlier — a quarter's margin written
 * into the same column as a year's margin, with nothing on the row to say
 * which. "Prefer not claiming over compensating": the instrument is refused and
 * counted as `staleAnnual`.
 *
 * THIS PARAGRAPH USED TO END "and cursor-stamped so the rotation still
 * advances". It was FALSE, and the test that quoted it asserted a different
 * counter. `stampCursorOnly` is an `updateMany`, which matches nothing when the
 * instrument has no `stock_ratios` row — and a stale filer that has never been
 * derived is exactly a symbol with no row. Demonstrated at `limit: 1` over two
 * instruments: the stale one was selected on all three nights and the derivable
 * one never once. Staleness is monotonic, so the refusal never lifts.
 *
 * The rotation is protected by WITHDRAWING the cohort from the candidate query
 * instead — see `STALE_ANNUAL_EXCLUSION` in `xbrl-ratios.ts`. A stale
 * instrument can never be written, so not selecting it loses nothing.
 */
export const ANNUAL_MAX_AGE_DAYS = 730;

export type AnnualRecencyVerdict = "FRESH" | "STALE";

/**
 * Is this ANNUAL recent enough to derive a balance sheet from?
 *
 * ## `ABSENT` is gone, and it was never acted on — MONEY-1401
 *
 * A third verdict used to sit here for "no annual at all". It read well and
 * decided nothing: BOTH call sites branched on `=== "STALE"` alone, so ABSENT
 * and FRESH took the identical path and the value existed only to be ignored.
 * Worse, it was returned for TWO unrelated inputs — an absent annual AND an
 * annual whose `periodEnd` would not parse — while its own docstring named only
 * the harmless one ("the 195 instruments that have never filed an annual"). So
 * the permissive branch silently covered the case the docstring next paragraph
 * warned about: "a NaN compares false against every threshold, which is how a
 * missing bound reads as a satisfied one". It claimed a protection it did not
 * provide.
 *
 * The caller already KNOWS whether it holds an annual — it is the thing it
 * passed in — so that half was never this function's to answer. What is left is
 * a two-valued question about a date, and both values are acted on.
 *
 * An unusable date now reads **STALE**, not fresh. `periodEnd` is a
 * non-nullable `DateTime` in the schema, so this is unreachable through Prisma
 * today and is the direction to fail in if that ever stops being true: refusing
 * a filing we cannot date costs one instrument's ratios, deriving from it puts
 * an undated balance sheet on the row beside a this-week price.
 */
export function annualRecencyVerdict(
  periodEnd: Date,
  now: Date,
  maxAgeDays: number = ANNUAL_MAX_AGE_DAYS,
): AnnualRecencyVerdict {
  if (!(periodEnd instanceof Date) || !Number.isFinite(periodEnd.getTime())) {
    return "STALE";
  }
  const ageDays = (now.getTime() - periodEnd.getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays)) return "STALE";
  return ageDays > maxAgeDays ? "STALE" : "FRESH";
}

export const PRICE_MAX_AGE_DAYS = 7;

/**
 * Corporate-action types that RE-PRICE the share without any economic event.
 *
 * SPLIT and BONUS are the textbook cases. DEMERGER is included because the
 * resulting price step on the parent is the same artefact from the same cause:
 * value leaves the listed share on the ex-date.
 *
 * BUYBACK and MERGER are deliberately OUT. A buyback retires shares at a
 * tender price and does not restate the continuing quote, and a MERGER's
 * surviving symbol keeps its own price line — dropping their returns would
 * discard genuine market moves to guard against an artefact that is not there.
 * DIVIDEND is out for the same reason: an ex-dividend drop is a real return.
 */
export const QTY_CHANGING_ACTION_TYPES: ReadonlySet<string> = new Set([
  "SPLIT",
  "BONUS",
  "DEMERGER",
]);

/**
 * The ex-dates whose daily return the beta regression must skip.
 *
 * Returns raw `Date`s, NOT day-key strings. `beta()` owns the rendering and
 * applies the RIGHT renderer to each side — UTC for a bar's session key, IST
 * for an ex-date instant (MONEY-1527). Do not render here: two hand-rolled
 * day keys in two files is how an exclusion set stops matching.
 *
 * AND THE SYMPTOM IS NOT A ZERO COUNT. An earlier version of this comment said
 * a mismatch makes "the dropped count read 0", indistinguishable from "this
 * instrument had no splits". Measured, it does not: the early key lands on a
 * REAL previous session, so exactly one return is still dropped — the wrong
 * one — and `droppedReturns` reads a healthy 1 while the slope is wrecked.
 * The count is not a diagnostic for this class.
 */
export function betaExcludeDatesFrom(
  actions: ReadonlyArray<{ exDate: Date; type: string | null }>,
  since: Date,
): Date[] {
  const out: Date[] = [];
  for (const a of actions) {
    if (!(a.exDate instanceof Date) || !Number.isFinite(a.exDate.getTime())) {
      continue;
    }
    // A DAY OF SLACK, because this bound is on the RAW INSTANT while the bars
    // it will be matched against sit at UTC midnight — MONEY-1527.
    //
    // `since` is `now - BETA_WINDOW_DAYS`, and an 18:30Z-stamped ex-date whose
    // IST day is the FIRST day of the window sits 5h30m before it. Filtered
    // here, it never reaches `beta()`'s now-correct renderer, so the split's
    // fake return is regressed with nothing dropped — the exact symptom this
    // function's header describes. And because the window is a rolling
    // `now - N days`, which symbols sit on the boundary changes every night,
    // so one symbol's beta would be correct on one run and poisoned on the
    // next.
    //
    // Over-including is free: `beta()` only ever uses these to MATCH a bar, so
    // a date outside the series matches nothing and costs nothing.
    if (a.exDate.getTime() < since.getTime() - 86_400_000) continue;
    if (a.type === null || !QTY_CHANGING_ACTION_TYPES.has(a.type)) continue;
    out.push(a.exDate);
  }
  return out;
}
