/**
 * XBRL → `StockFinancials`, the WRITE side — MONEY-1115 (Data Engine P10 F3).
 *
 * `xbrl-sync` stores the filing as filed (`XbrlFiling`, the raw side).
 * `xbrl-projection.ts` turns a filing into the flat reader shape and decides who
 * outranks whom. `xbrl-reconcile.ts` produces the evidence. This file is the one
 * that actually moves product data, and it is the only irreversible step in P10.
 *
 * ## The constraint that shapes every decision below
 *
 * `StockFinancials` is `@@unique([symbol, exchange, statementType, periodType,
 * period])` — there is **no `source` in the key**. Two sources describing one
 * period are one row. So the moment this job writes a period, Tickertape's value
 * for that period is gone, and there is nothing left to reconcile against.
 * That is why the evidence gate (`scripts/data/xbrl-reconcile.ts`) has to run
 * BEFORE the first write and cannot be re-run after it.
 *
 * Three consequences, and each is a defaulted-off interlock rather than a
 * comment asking the next person to be careful:
 *
 *  1. **`apply` defaults to FALSE.** The job plans, counts and reports; it
 *     writes nothing. Arming it is a deliberate act by someone holding a
 *     reconcile report that reads READY for every field.
 *  2. **`createMissing` defaults to FALSE.** A CREATE is by construction a row
 *     the reconciliation never compared. It is also indistinguishable from a
 *     `periodLabel` join bug — Tickertape's period label is stored VERBATIM
 *     from its feed, so our derivation of it is an assumption about a third
 *     party's formatting, and if that assumption is wrong EVERY period looks
 *     like new ground and gets duplicated under a second label. Coverage gain is
 *     a separate, opt-in step.
 *  3. **Everything displaced is preserved in the row that displaced it**
 *     (`rawData.displacedByXbrl`), written exactly once. See
 *     `DisplacementRecord` in `@usemoney/core/market-data` for why that lives
 *     in-row rather than in an audit table or a run log.
 *
 * ## Why per-FIELD switchover is not offered
 *
 * The reconcile report judges readiness per field, so "switch over revenue but
 * not EBITDA" looks like the cautious option. It is not: it produces a row whose
 * `source` says NSE_XBRL while some of its columns are Tickertape's, and a row
 * nobody can attribute is exactly the state MONEY-1175 sat in for months. The
 * unit of switchover is the ROW. Fields the filing did not disclose are written
 * NULL — visibly absent, with the displaced value recoverable next to it —
 * rather than left holding another source's number.
 *
 * ## PREREQUISITE — the competing writers, and where they stand now
 *
 * The hazard this section was written for is REAL and unchanged in kind: every
 * competing writer's `update:` clause rewrites `revenue`, `netIncome`, `ebitda`
 * and `rawData` **without touching `source`**. On a row this job projected, such
 * a write is a silent revert with a FALSE provenance — the values become
 * Tickertape's while the row still claims `NSE_XBRL` — and because `rawData` is
 * where the displacement record lives, the evidence needed to undo it is
 * destroyed in the same statement. Both the data AND its audit trail, gone, with
 * no error and no second copy. Nothing about that reasoning has expired; what
 * has changed is who is still exposed to it.
 *
 * **All six competing write sites now consult the order** (MONEY-1198 for the
 * first two, MONEY-1204 for the rest):
 *
 *   - `workers/src/processors/financial-data-sync.ts` — the annual and
 *     quarterly `stockFinancials` upserts (`tickertapeMayWrite`), and the
 *     `stockRatios` upsert (`tickertapeRatiosMayWrite`). The ratios one is the
 *     highest-frequency of the set: `ratios-sync-daily`, 23:30 IST Mon-Fri,
 *     against a model keyed `@@unique([symbol, exchange])` with no period
 *     dimension, so one unguarded run replaces a symbol's ENTIRE ratio set.
 *   - `packages/research/src/data-sources/db-store.ts` — the `stockFinancials`
 *     and `stockRatios` upserts behind `getOrFetch*`. REQUEST-time, not
 *     scheduled: a single page view was enough.
 *   - `packages/research/src/data-sources/persistence.ts` — the fallback
 *     persist. Fire-and-forget with every error swallowed, so a wrong write
 *     there is silent by construction; its challenger is the RUNTIME
 *     `opts.source` (`TICKERTAPE | SCREENER | YAHOO`), not a literal.
 *
 * The order itself is declared exactly once, in `FINANCIALS_AUTHORITY`, and the
 * boolean every one of those writers needs comes from `mayOverwriteFinancials`
 * (`@usemoney/core/market-data`) — the same module as this file's
 * `planFinancialsWrite`, which uses the richer `chooseAuthority` because it also
 * needs the loser's identity to build the displacement record. A source scan,
 * `packages/core/__tests__/market-data/financials-write-authority.test.ts`,
 * DISCOVERS writers of both models across `apps/ packages/ workers/ scripts/`
 * and fails on any that lacks a guard, so a seventh writer cannot appear
 * unnoticed the way the four did.
 *
 * **`apply: true` is still NOT armed, and this section is not the reason any
 * more.** What remains gated is the evidence: `scripts/data/xbrl-reconcile.ts`
 * must read READY for every field FIRST, because once this job writes a period
 * there is no `source` in the unique key and Tickertape's value for it is gone —
 * there is nothing left to reconcile against. Arming it is a deliberate act by
 * someone holding that report, and it lands together with the wiring below.
 *
 * ## UNITS — MONEY-1205, and it changes what "READY" means
 *
 * `StockFinancials` is denominated in ₹ CRORE. That was never written down; it
 * is simply what all 32,359 prod rows are, because every one came from
 * Tickertape and Tickertape's feed is crore. XBRL facts are absolute RUPEES.
 * This job used to write the rupee value straight into the crore column —
 * 10,000,000x, on the one table with no `source` in its unique key.
 * {@link toCroreDenominated} now rebases every projected statement before
 * `planFinancialsWrite` sees it.
 *
 * **TWO CONSEQUENCES FOR THE GATE, and the second is a live blocker.**
 *
 *  1. `reconcile()` treats a 1e7 gap as `SCALE_MISMATCH`, which BLOCKS. Until
 *     now that block was CORRECT and unavoidable — the units genuinely
 *     disagreed. Any reconcile report produced before this change that read
 *     READY was reading a comparison that could not have been meaningful.
 *  2. RESOLVED (MONEY-1235). `scripts/data/xbrl-reconcile.ts` calls
 *     `projectFinancials` directly rather than going through this file, so it
 *     used to compare rupees against crore and report `SCALE_MISMATCH` for
 *     every field — a FALSE block, where the writer was correct and the gate
 *     could not see it. The gate now rebases through its own
 *     `toCroreStatement()` before `reconcile()`.
 *
 *     THE DUPLICATION IS REAL AND IS THE REMAINING HAZARD: two conversions now
 *     exist, `toCroreDenominated` here and `toCroreStatement` there, and if
 *     they ever disagree the gate silently grades numbers the writer will never
 *     persist — the exact class of defect this whole ticket family is about.
 *     They cannot be shared today because this one lives in `workers/` and a
 *     root script cannot import it. The durable fix is lifting it into
 *     `@usemoney/core/market-data` beside `rupeesToCrores` and having both
 *     callers use it.
 *
 * ## WIRED, AND DISARMED — do not confuse the two
 *
 * This paragraph used to say "NOT WIRED: there is deliberately no route, no
 * Pub/Sub topic and no scheduler entry". That has been false since MONEY-1220:
 * the route, the topic, the push subscription and `xbrl-projection-daily` all
 * exist, and `xbrl-projection-wired.test.ts` asserts every link of that chain
 * precisely because the job once shipped complete and unreachable for a whole
 * release.
 *
 * ## THE SCALE CHECK — MONEY-1237, and what changed under it
 *
 * `judgeFilingScale` is the only protection the CREATE-only universe has
 * against a filer mis-declaring its own `roundingLabel` (90.7% of winner
 * periods have no vendor row to reconcile against). Three defects made it
 * cover far less, and cost far more, than its counters said:
 *
 *  1. **It compared against the median of the WHOLE history**, so any
 *     whole-company step change was convicted — a reverse merger, a spin-off,
 *     and structurally EVERY company compounding >= 3.16x/yr over seven annual
 *     filings (newest ÷ median = r^3). It also INVERTED when the mis-scale was
 *     the majority: three bad filings and one good one quarantined the good
 *     one. Fixed in the detector: the comparison is now against the adjacent
 *     periods on each side, and a conviction needs the same power of ten on
 *     BOTH sides.
 *  2. **A quarantined filing was STAMPED**, so a false positive was permanent
 *     and invisible. Fixed here: see `scaleHeldIds` and the stamp block.
 *  3. **Sibling context came only from the current page**, which works during
 *     the drain and stops working the day it ends — after which every page
 *     holds one filing per symbol, every candidate answers
 *     INSUFFICIENT_CONTEXT, and that answer was UNCOUNTED. Fixed here:
 *     `fetchScaleContext` (ONE grouped query per page) plus
 *     `skippedScaleCheck`.
 *
 * What holds the door shut is not absence, it is `XBRL_PROJECTION_APPLY`, which
 * ships PRESENT and `"false"` in both Cloud Build specs and is compared against
 * the literal string (`Boolean("false")` is `true`, which would arm the job in
 * the one configuration meant to keep it off). The nightly scheduler payload is
 * additionally scoped to `{"periodTypes":["ANNUAL"]}` until the quarterly drain
 * completes — see `docs/reference/xbrl-switchover-runbook.md`.
 */

import prisma, { Prisma } from "@usemoney/database";
import {
  judgeFilingScale,
  judgeProjectionEligibility,
  ownedFields,
  planFinancialsWrite,
  projectFinancials,
  rupeesToCrores,
  toCroreDenominated,
  scaleValuesOf,
  selectFilingForPeriod,
  XBRL_SOURCE,
  type IncumbentFinancialsRow,
  type ProjectedFinancials,
  type ProjectionRefusal,
  type ScaleObservation,
  type XbrlFinancials,
  NEIGHBOUR_WINDOW,
  filerShapeOf,
} from "@usemoney/core/market-data";

const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[xbrl-projection-writer] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[xbrl-projection-writer] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[xbrl-projection-writer] ${msg}`, data),
};

/**
 * Filings read per run. Large enough that a symbol's full history fits many
 * times over, small enough to bound one run's memory.
 */
const DEFAULT_LIMIT = 5000;

/** Examples kept in the result. A capped list must say it is capped. */
const MAX_EXAMPLES = 40;

/**
 * Neighbouring PERIODS the sibling fetch reaches on each side of the page —
 * MONEY-1237.
 *
 * FOUR, which is one more than `NEIGHBOUR_WINDOW` (3) in
 * `@usemoney/core/market-data`'s scale detector — the number of adjacent
 * periods that function actually compares against. The +1 is slack for a
 * company that skipped a filing, and the coupling is the point: a fetch window
 * NARROWER than the detector's comparison window would starve the detector of
 * exactly the periods it just decided it needs, and it would do so silently
 * (fewer siblings reads as INSUFFICIENT_CONTEXT, not as an error).
 *
 * DERIVED from the detector's own `NEIGHBOUR_WINDOW`, plus one period of
 * deliberate slack — MONEY-1237. The invariant is that the FETCH window must
 * never be narrower than the COMPARISON window: a narrower fetch raises no
 * error and loses no data visibly — it simply returns fewer siblings, fewer
 * siblings read as INSUFFICIENT_CONTEXT, and the scale check switches itself
 * off while every counter still reports a healthy run. Deriving the value makes
 * that invariant hold by construction instead of by a hand-copied number; the
 * structural test that reads both source files stays as belt and braces. The
 * +1 is slack, not padding to delete: a gap year inside the fetch range still
 * leaves the comparison window fully supplied.
 */
const SIBLING_CONTEXT_PERIODS = NEIGHBOUR_WINDOW + 1;

/**
 * How long a period is, for sizing that window. Rounded UP so a 53-week fiscal
 * year or a late-filed quarter cannot fall outside the reach of its own
 * neighbours.
 */
const DAYS_PER_ANNUAL_PERIOD = 366;
const DAYS_PER_QUARTERLY_PERIOD = 100;
const MS_PER_DAY = 86_400_000;

/**
 * Rows the sibling fetch may return, sized from the page.
 *
 * The arithmetic: each candidate wants up to `SIBLING_CONTEXT_PERIODS` periods
 * on each side, and a company files BOTH a consolidated and a standalone
 * document for the same period, so 4 x 2 x 2 = 16 is the worst case per
 * candidate.
 *
 * SIXTEEN, NOT EIGHT — MONEY-1236. This was 8, justified as "the realistic
 * case, most pages are one basis after `selectFilingForPeriod` has had its
 * say". That reasoning is about the CANDIDATES; it does not apply to the
 * SIBLINGS, and the query below filters neither `basis` nor `periodType`. In
 * the steady state a symbol holds ~4 quarters x 2 bases plus 1-2 annuals x 2
 * bases inside the +/-400-day window — about 12, and 16 in the worst case the
 * line above already computes.
 *
 * At 8, a 500-filing page capped at 4,000 rows against a real need of ~6,000,
 * so truncation became the NORMAL nightly outcome rather than a runaway guard.
 * And because the fetch is `symbol asc`, the same tail of the alphabet was
 * starved every single night, answering INSUFFICIENT_CONTEXT and falling into
 * `skippedScaleCheck` — i.e. the check this file's own header calls "the only
 * cover the quarterly universe will ever get" was permanently off for those
 * symbols. The cap is a runaway guard, not a budget: it exists so a symbol list
 * that accidentally selects a whole exchange cannot pull the table into memory.
 * Truncation is COUNTED (`scaleContextTruncated`) and degrades into
 * `skippedScaleCheck`, never into a wrong verdict.
 */
const SIBLING_ROWS_PER_FILING = 16;
const SIBLING_CONTEXT_MIN_ROWS = 2_000;
const SIBLING_CONTEXT_MAX_ROWS = 20_000;

/**
 * Examples kept for an outcome that is EXPECTED to be common — MONEY-1235.
 *
 * See `noteCapped`: without a per-kind budget the 29.5%-frequency standalone
 * refusal fills the whole shared list and the rare outcomes never appear.
 */
const EXAMPLES_PER_COMMON_KIND = 5;

/** The `XbrlFiling` columns this job reads. */
export interface FilingRow {
  id: string;
  instrumentId: string | null;
  symbol: string;
  exchange: string;
  periodStart: Date;
  periodEnd: Date;
  periodType: string;
  basis: string;
  cumulative: boolean;
  coverage: number;
  taxonomyVersion: string;
  sourceUrl: string;
  filedAt: Date | null;
  facts: unknown;
}

export interface XbrlProjectionWriteOptions {
  /** Restrict to these symbols. Omitted = every filing in the window. */
  symbols?: string[];
  /** Only filings whose period ends on or after this date. */
  since?: Date;
  /**
   * Consider only filings this job has not already decided about — MONEY-1220.
   *
   * WITHOUT this the nightly job is MONEY-1211 again. Selection is
   * `orderBy: [symbol asc, periodEnd desc] take: limit`, which is a CONSTANT
   * ordering over a table that only grows at the end: every run receives the
   * same first `limit` filings forever, writes them once, then reports
   * `skippedUnchanged` on them nightly while everything after the cut is never
   * read at all. No error, no alert, and `stock_financials` simply stops
   * growing — indistinguishable from "there is nothing new to write".
   *
   * The ORDER is deliberately left alone: symbol-major is what keeps a truncated
   * page from cutting between a STANDALONE filing and the CONSOLIDATED sibling
   * that should supersede it. This is a FILTER, so the sibling invariant is
   * unchanged and the batch still advances.
   */
  unprojectedOnly?: boolean;
  /** Max filings read in one run. */
  limit?: number;
  /**
   * WRITE. Defaults to false: the run plans and reports and touches nothing.
   * The precondition for `true` is a reconcile report reading READY for EVERY
   * field — this job cannot check that, which is why it is a human-held switch.
   */
  apply?: boolean;
  /**
   * Also create rows that have no incumbent. Defaults to false — see the header:
   * a create is a row the reconciliation never looked at, and a 100%-create run
   * is the exact signature of a period-label join bug.
   */
  createMissing?: boolean;
  /**
   * Restrict the run to these projection buckets. Default: both.
   *
   * Applied as a column filter on selection, not as a post-verdict skip — see
   * the selection block for why the difference is load-bearing.
   */
  periodTypes?: Array<"ANNUAL" | "QUARTERLY">;
  /** Injectable clock, so `displacedAt` is deterministic under test. */
  now?: Date;
}

export interface XbrlProjectionWriteResult {
  ok: boolean;
  apply: boolean;
  createMissing: boolean;
  filingsRead: number;
  /** Hit the read limit — some filings were not considered at all. */
  truncatedByLimit: boolean;
  /**
   * Filings held back because the read stopped mid-symbol. Processing them
   * would let a STANDALONE filing win a period whose CONSOLIDATED sibling fell
   * outside the page — a wrong number, silently, from a paging artefact.
   */
  deferredByPagination: number;
  /** Filings refused before they reached a row, by cause. */
  refused: Record<ProjectionRefusal, number>;
  /** Distinct (symbol, exchange, periodType, period) rows addressed. */
  periods: number;
  /**
   * Filings that lost their period to a sibling — most often a STANDALONE
   * filing losing to the CONSOLIDATED one for the same quarter. Counted because
   * `StockFinancials` cannot hold both, so this is data we deliberately do not
   * write and must be able to see rather than infer from a subtraction.
   */
  supersededSiblings: number;
  /** Filings whose `facts` could not be read back as a parsed filing. */
  unreadableFacts: number;
  /**
   * Filings QUARANTINED because their magnitudes disagree with the periods on
   * BOTH sides of them by the same power of ten — MONEY-1235/1237. Nothing is
   * written, and — since MONEY-1237 — the filing is NOT stamped. See the stamp
   * block for why: the verdict is a function of the sibling set, and the
   * sibling set grows.
   */
  refusedScaleSuspect: number;
  /**
   * Filings HELD because the company's own two BASES contradict each other on
   * paid-up equity share capital — MONEY-1250 (T3.2).
   *
   * A third scale door, not a variant of the first two, and separate for the
   * reason `skippedScaleUnconfirmed` is separate from `refusedScaleSuspect`:
   * each answers a different operator question.
   *
   *   refusedScaleSuspect      we convicted THIS filing, and named the factor
   *   skippedScaleUnconfirmed  we could not tell yet; the next period decides
   *   refusedBasisConflict     the PAIR is provably inconsistent and no
   *                            evidence in either document says which half
   *
   * It is also the only one of the three that does NOT empty itself. Neither
   * document will ever change, so unless NSE republishes one, these filings are
   * held and re-read every night for good — 166 period groups on the prod
   * snapshot of 2026-08-26 against a 500-filing page. That is the number to
   * watch, and it is only visible because this counter is its own.
   */
  refusedBasisConflict: number;
  /**
   * Filings HELD because the only neighbouring side that exists disagrees —
   * MONEY-1237.
   *
   * The candidate is the newest (or oldest) filing we hold for that company, so
   * a mis-declared unit and a genuine whole-company step change (a reverse
   * merger, a spin-off) are the same picture. Not written, not stamped, and
   * deliberately NOT folded into `refusedScaleSuspect`: that counter means "we
   * convicted", this one means "we could not tell yet", and the second one
   * empties itself as soon as the next reporting period lands.
   */
  skippedScaleUnconfirmed: number;
  /**
   * Filings written with NO scale check at all — MONEY-1237.
   *
   * `INSUFFICIENT_CONTEXT` used to fall through UNCOUNTED. There was no such
   * field on this type, so a run with ZERO scale coverage was indistinguishable
   * in the logs from a run with full coverage — on the one check the header
   * calls "the only cover the quarterly universe will ever get". Probed on the
   * steady-state shape (one new filing per symbol, siblings all projected on an
   * earlier night): `siblingPeriods: 0` for every candidate.
   *
   * Named `skipped*` on purpose so `describeNoWriteReason`'s key scan picks it
   * up. Read it as "N filings skipped the CHECK", not as a door a write went
   * out of — the filings it counts were written.
   */
  skippedScaleCheck: number;
  /**
   * Sibling FILINGS pulled in by the ONE extra query — MONEY-1237.
   *
   * The runtime proof that the fetch is wired. After the drain this must be
   * non-zero; a zero here alongside a non-zero `skippedScaleCheck` is the
   * scale-cover-goes-dark defect returning.
   */
  scaleContextFetched: number;
  /**
   * The sibling fetch hit its row cap, so symbols late in the page got less
   * context than they should have — MONEY-1237. Degrades into
   * `skippedScaleCheck`, never into a wrong verdict, but it must be visible.
   */
  scaleContextTruncated: boolean;
  /** Statements with at least one projected value. */
  statementsProjected: number;
  created: number;
  updated: number;
  /** Updates that replaced a DIFFERENT source and recorded what they replaced. */
  displaced: number;
  skippedAuthority: number;
  skippedUnchanged: number;
  /**
   * Our own CONSOLIDATED-derived row protected from a later STANDALONE sibling
   * — MONEY-1235. Its own counter, never folded into `skippedAuthority`: that
   * one means "another SOURCE outranks us", which cannot happen while NSE_XBRL
   * leads `FINANCIALS_AUTHORITY`, so a non-zero there would be alarming while a
   * non-zero here is the guard working.
   */
  skippedBasisDowngrade: number;
  /**
   * A STANDALONE (or unrecognised-basis) winner refused permission to displace
   * a vendor incumbent — MONEY-1235. Expected to be LARGE: 3,208 of 10,879
   * winner periods (29.5%) are standalone-only.
   */
  skippedStandaloneNoDisplace: number;
  /** Would have created, but the filing has no resolved instrument. */
  skippedNoInstrument: number;
  /** Would have created, but `createMissing` is off. */
  skippedCreateSuppressed: number;
  /** Per-row failures. One bad row never aborts the run. */
  failed: number;
  /**
   * Filings this run would advance the `projectedAt` cursor for — MONEY-1238.
   *
   * `decided.length`, and 0 on a dry run because a rehearsal stamps nothing.
   * Exists only to give {@link stamped} a DENOMINATOR: "stamped 0" means
   * "nothing to stamp" on a fully-refused page and "the cursor did not move"
   * on a page of 500 writes, and those two must never look alike.
   */
  stampAttempted: number;
  /**
   * Filings the cursor `updateMany` reported it actually stamped —
   * MONEY-1238.
   *
   * THE DEFECT: this call's result was discarded. The stamp sits inside a
   * try/catch that only WARNS (correctly — a cursor that fails to advance
   * costs a repeated read, never a wrong number), and `out.ok` was already
   * settled ~50 lines earlier, so a stamp that failed EVERY night left the run
   * reporting `written=500 failed=0 ok=true` while the next run re-read and
   * re-wrote the same page forever. That is MONEY-1211 exactly, and this repo
   * has now shipped the silent-cursor defect three times.
   *
   * The sibling ratios job made the opposite call deliberately —
   * `const stamped = await db.stockRatios.updateMany(...)` ->
   * `cursor: stamped.count > 0 ? "stamped" : "no-row"` — for the same reason.
   *
   * NOT named `skipped*`/`refused*`: {@link describeNoWriteReason}'s key scan
   * would then report it as a door a write went out of, which it is not. It is
   * surfaced explicitly in the job's outcome line instead.
   */
  stamped: number;
  /**
   * The cursor `updateMany` THREW — MONEY-1238.
   *
   * Distinct from `stamped < stampAttempted`, which is Mongo saying it matched
   * fewer rows than we named (rows deleted, or already stamped). Same visible
   * consequence, different cause, so they are not folded together — the
   * conflation is what this whole ticket family is about. Deliberately does
   * NOT clear `ok`: see the stamp block.
   */
  stampFailed: boolean;
  examples: string[];
}

function emptyRefusals(): Record<ProjectionRefusal, number> {
  return {
    HALF_YEARLY_HAS_NO_BUCKET: 0,
    CUMULATIVE_IS_NOT_A_QUARTER: 0,
    PERIOD_SPAN_CONTRADICTS_TYPE: 0,
    NO_USABLE_PERIOD: 0,
  };
}

/**
 * Read `XbrlFiling.facts` back as a parsed filing.
 *
 * `facts` is the whole `XbrlFinancials` result stored as Json. Returning null
 * on anything unexpected — rather than casting and hoping — is what keeps a
 * malformed row a COUNTED outcome (`unreadableFacts`) instead of a TypeError
 * that ends the run at whatever row it reached.
 */
export function readFacts(facts: unknown): XbrlFinancials | null {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return null;
  const values = (facts as Record<string, unknown>).values;
  if (!values || typeof values !== "object") return null;
  return facts as unknown as XbrlFinancials;
}

/**
 * Re-exported from `@usemoney/core/market-data` — MONEY-1235.
 *
 * The rupees -> ₹ crore rebase used to be DEFINED here, and the F3 reconcile
 * (`scripts/data/xbrl-reconcile.ts`) carried an identical private copy because a
 * root script cannot import from `workers/`. Two conversions, one of which
 * decides whether the other may be armed: had they drifted, the gate would have
 * graded numbers this writer will never persist — a gate measuring something
 * other than what ships, which is the defect class MONEY-1220/1234/1235 exist
 * to remove. There is now ONE definition, in core, and both call it.
 *
 * Still exported from this module so existing importers and
 * `xbrl-projection-writer.test.ts` keep their entry point.
 */
export { toCroreDenominated };

/**
 * Reduce one filing to the magnitudes the scale detector compares — MONEY-1235.
 *
 * ## Why it goes through `toCroreDenominated` even though only ratios are read
 *
 * The detector divides, so a shared constant factor would cancel and rupees
 * would work. It converts anyway, for two reasons that outlive the arithmetic:
 * the numbers appear verbatim in the `SCALE-SUSPECT` example lines, where crore
 * is the unit every other line in this file and every figure in
 * `StockFinancials` is quoted in; and it is the SAME transformation the write
 * path applies, so what the detector judges is exactly what would have been
 * written. A second, subtly different reduction is how a detector ends up
 * clearing a value the writer then mangles.
 *
 * Returns null for a filing whose facts are unreadable — those are counted as
 * `unreadableFacts` on the write path and must not become a phantom sibling
 * with no values, which would inflate the context tier's size without
 * contributing a single comparable magnitude.
 */
export function observeScale(f: FilingRow): ScaleObservation | null {
  const facts = readFacts(f.facts);
  if (!facts) return null;
  const projection = projectFinancials(facts);
  // ONE reduction, shared with the F3 reconcile — MONEY-1255. This was a local
  // `crore[field]` loop over `SCALE_FIELDS`, duplicated verbatim in
  // `scripts/data/xbrl-reconcile.ts`, and when `ProjectedFinancials.revenue`
  // was renamed BOTH copies started indexing a key that no longer exists.
  // `scaleValuesOf` carries the label -> column map (`SCALE_FIELD_COLUMN`), so
  // the next rename is a compile error in one file rather than two silent
  // `undefined`s.
  const values = scaleValuesOf(
    [projection.income, projection.balanceSheet].map((s) =>
      s ? toCroreDenominated(s) : null,
    ),
  );
  // MONEY-1250 (T3.2) — the cross-basis invariant's ONLY input, and it does not
  // come off a projected statement.
  //
  // `paidUpEquityShareCapital` is not a `StockFinancials` column, so it is not
  // in `ProjectedFinancials` and `toCroreDenominated` (which converts
  // `ownedFields` only) never sees it. Read straight off the parsed facts, in
  // raw rupees. The detector reads RATIOS between two filings of the same
  // company, so the unit cancels; what must not vary is the unit BETWEEN the
  // two, and both come through this same line.
  //
  // A missing or non-numeric tag is left ABSENT rather than defaulted to 0: a
  // zero would be a number the filing never stated, and the invariant's own
  // floor treats zero as unevaluable for exactly that reason.
  const paidUpEquityShareCapital = facts.values?.paidUpEquityShareCapital;
  return {
    filingId: f.id,
    basis: f.basis,
    periodType: f.periodType,
    ...(typeof paidUpEquityShareCapital === "number" &&
    Number.isFinite(paidUpEquityShareCapital)
      ? { paidUpEquityShareCapital }
      : {}),
    // Diagnostic only — the quarantine line prints `"Lakhs" vs "Crores"`, which
    // is the first thing a human checks. No verdict may depend on it: the label
    // is the filer's claim about its own units and this check exists because
    // that claim is sometimes false.
    ...(typeof facts.roundingLabel === "string"
      ? { roundingLabel: facts.roundingLabel }
      : {}),
    // MONEY-1237 — the ORDERING key, not decoration. `judgeFilingScale`
    // compares a filing against the periods ADJACENT to it, so without a date
    // it falls back to the caller's array position; supplying the real one
    // keeps the verdict independent of how the page happened to be assembled,
    // which matters here because `fetchScaleContext` MERGES siblings from a
    // second query into the same list.
    periodEnd: f.periodEnd,
    label: f.periodEnd.toISOString().slice(0, 10),
    values,
  };
}

/** The row key a filing projects into. */
function groupKey(
  symbol: string,
  exchange: string,
  periodType: string,
  period: string,
): string {
  return `${symbol}|${exchange}|${periodType}|${period}`;
}

/**
 * Drop the trailing symbol when the read hit its limit.
 *
 * Filings are read ordered by `symbol asc`, so a truncated page can only cut
 * INSIDE the last symbol. Every other symbol in the page is complete, and
 * completeness per symbol is what `selectFilingForPeriod` needs to be correct:
 * with half a symbol's filings, a standalone filing can win a period whose
 * consolidated sibling was simply not read. Deferring the partial symbol costs
 * one run's coverage; keeping it costs a wrong number that looks fine.
 */
export function dropPartialTrailingSymbol(rows: readonly FilingRow[]): {
  kept: FilingRow[];
  deferred: number;
} {
  if (rows.length === 0) return { kept: [], deferred: 0 };
  const lastSymbol = rows[rows.length - 1]!.symbol;
  const kept = rows.filter((r) => r.symbol !== lastSymbol);
  // Every row belongs to one symbol: keeping nothing would stall forever, so
  // the page is used as-is and the caller widens the limit instead.
  if (kept.length === 0) return { kept: [...rows], deferred: 0 };
  return { kept, deferred: rows.length - kept.length };
}

type Db = typeof prisma;

/** The `XbrlFiling` columns `observeScale` and the projection both read. */
const FILING_SELECT = {
  id: true,
  instrumentId: true,
  symbol: true,
  exchange: true,
  periodStart: true,
  periodEnd: true,
  periodType: true,
  basis: true,
  cumulative: true,
  coverage: true,
  taxonomyVersion: true,
  sourceUrl: true,
  filedAt: true,
  facts: true,
} as const;

/**
 * The sibling periods this page does NOT contain — MONEY-1237 (FIX 3).
 *
 * ## Why it exists
 *
 * `judgeFilingScale` needs the periods ADJACENT to the candidate. During the
 * drain they are in the page for free. Afterwards they are not: every earlier
 * filing was stamped on an earlier night, `unprojectedOnly` filters it out, and
 * the detector sees `siblingPeriods: 0` for every candidate in the run. The
 * check does not fail — it politely answers INSUFFICIENT_CONTEXT and the filing
 * is written unchecked. That is the state this function ends.
 *
 * ## ONE query, and the shape of it
 *
 * One `findMany` for the WHOLE page, never one per symbol or per group. Bounded
 * three ways so it cannot become the thing it is replacing:
 *
 *  1. **The page's own symbols.** Uses the `@@index([symbol, exchange,
 *     periodEnd(sort: Desc)])` that `xbrl_filings` already carries for exactly
 *     this read shape.
 *  2. **A period window** of `SIBLING_CONTEXT_PERIODS` on each side of the
 *     page's period range, sized from whether the page contains ANNUAL filings.
 *     In the steady state the page spans ONE period, so the window is ~4 years
 *     (annual) or ~13 months (quarterly). During the drain the page already
 *     holds the history, so `notIn` removes nearly everything this returns.
 *  3. **`notIn` the page's own ids**, server-side. The alternative — filtering
 *     in memory — re-fetches every `facts` blob the page is already holding,
 *     which on a full drain page is the whole payload twice.
 *
 * ## It THROWS rather than degrading
 *
 * Deliberate, and it runs BEFORE any write, so a failure costs a clean retry
 * and never a half-written run. Swallowing the error would turn "the context
 * query failed" into "this company has no siblings", which is a fail-open
 * default wearing the costume of a measurement — the exact defect this ticket
 * is removing on the other side of the same function.
 */
async function fetchScaleContext(
  db: Db,
  usable: readonly FilingRow[],
  out: XbrlProjectionWriteResult,
): Promise<FilingRow[]> {
  if (usable.length === 0) return [];

  const symbols = [...new Set(usable.map((f) => f.symbol))];
  const ids = usable.map((f) => f.id);
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let hasAnnual = false;
  for (const f of usable) {
    const t = f.periodEnd.getTime();
    if (!Number.isFinite(t)) continue;
    if (t < earliest) earliest = t;
    if (t > latest) latest = t;
    if (f.periodType === "ANNUAL") hasAnnual = true;
  }
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return [];

  // A MIXED page takes the annual span: a window sized for quarters would
  // leave the annual candidates in it with fewer neighbours than the detector
  // compares against, which reads as INSUFFICIENT_CONTEXT rather than as a
  // mis-sized query.
  const span =
    SIBLING_CONTEXT_PERIODS *
    (hasAnnual ? DAYS_PER_ANNUAL_PERIOD : DAYS_PER_QUARTERLY_PERIOD) *
    MS_PER_DAY;
  const cap = Math.min(
    SIBLING_CONTEXT_MAX_ROWS,
    Math.max(SIBLING_CONTEXT_MIN_ROWS, usable.length * SIBLING_ROWS_PER_FILING),
  );

  const rows = (await db.xbrlFiling.findMany({
    where: {
      symbol: { in: symbols },
      periodEnd: {
        gte: new Date(earliest - span),
        lte: new Date(latest + span),
      },
      id: { notIn: ids },
    },
    // Symbol-major, matching the main read. Under truncation this starves the
    // symbols at the END of the alphabet rather than thinning every symbol, and
    // a starved symbol answers INSUFFICIENT_CONTEXT — counted, not silent.
    orderBy: [{ symbol: "asc" }, { periodEnd: "desc" }],
    take: cap,
    select: FILING_SELECT,
  })) as unknown as FilingRow[];

  out.scaleContextFetched = rows.length;
  out.scaleContextTruncated = rows.length >= cap;
  if (out.scaleContextTruncated) {
    logger.warn(
      { cap, symbols: symbols.length },
      "scale context hit its row cap — symbols late in the page have thin " +
        "sibling context and will report skippedScaleCheck",
    );
  }
  return rows;
}

/**
 * Project every eligible filing into `StockFinancials`.
 *
 * Idempotent: a second run over the same filings makes no writes at all
 * (`planFinancialsWrite` returns SKIP when the row already carries our stamp,
 * our numbers and our filing's provenance).
 */
/**
 * The ONE definition of "this filing has not been decided about yet".
 *
 * Exported and shared rather than written out at each call site, because it
 * already drifted once. MONEY-1234 fixed the selection below and left
 * `countUnprojectedFilings` — the diagnostic that exists to detect exactly this
 * class of bug — still asking `{ projectedAt: null }`, which matches nothing on
 * Mongo. That count therefore returned 0 unconditionally and the route printed
 * a permanent "Nothing to do." all-clear over a 90,188-filing backlog
 * (MONEY-1235). Two hand-copied filters is what made that possible; there is
 * now one.
 *
 * Both shapes are covered deliberately: `isSet: false` for a row that has never
 * been stamped (which is every row until the projection first writes), and
 * `null` for a row explicitly reset later. Once stamping begins the two
 * populations coexist.
 */
export const UNPROJECTED_FILING_WHERE: Prisma.XbrlFilingWhereInput = {
  OR: [{ projectedAt: null }, { projectedAt: { isSet: false } }],
};

/**
 * Why a run that SELECTED filings wrote nothing — MONEY-1235.
 *
 * Derived by SCANNING the result's own `skipped*` / `refused*` keys rather than
 * from a hand-written list, because the hand-written list is what failed. The
 * previous version enumerated seven counters by name; three more were added in
 * this same ticket (`skippedStandaloneNoDisplace`, `skippedBasisDowngrade`,
 * `refusedScaleSuspect`) and none of them appeared. That matters more than it
 * sounds: standalone-only is 29.5% of winner periods, so on the first armed run
 * `written: 0` could have been ENTIRELY explained by the standalone guard while
 * the reason line read all-zeros — a job reporting success, writing nothing,
 * and unable to say which door closed, which is the exact shape this ticket
 * exists to remove.
 *
 * Adding a counter to `XbrlProjectionWriteResult` now surfaces it here for
 * free. Sorted biggest-door-first, because the operator's next question is
 * always "what accounted for most of it".
 *
 * The all-zero branch is deliberately loud. If filings were selected, nothing
 * was written, and NO counter accounts for it, that is not a quiet success —
 * it means the filings produced no statements at all, and the run should be
 * investigated rather than filed under "nothing to do".
 *
 * ONE entry is not a door: `scaleCheck` (`skippedScaleCheck`, MONEY-1237)
 * counts filings written WITHOUT a scale check, not filings a write was blocked
 * on. It carries the `skipped` prefix on purpose, so that the scan — and the
 * structural test that iterates this type's own `skipped*`/`refused*` keys —
 * pick it up for free rather than depending on somebody remembering to add it.
 * The alternative was a hand-maintained list, and a hand-maintained list is
 * exactly what failed here.
 */
export function describeNoWriteReason(
  result: XbrlProjectionWriteResult,
): string {
  const doors = listWriteDoors(result);

  const head = `no write from ${result.filingsRead} filing(s)`;
  if (doors.length === 0) {
    return (
      `${head} and NO counter accounts for it ` +
      `(periods=${result.periods}, statementsProjected=${result.statementsProjected}) ` +
      `— unaccounted, investigate`
    );
  }
  return `${head}: ${doors.map(([k, v]) => `${k}=${v}`).join(", ")}`;
}

/**
 * Every non-zero door a write could have gone out of, biggest first —
 * MONEY-1238.
 *
 * Extracted verbatim out of {@link describeNoWriteReason}, whose body this was,
 * because the census was reachable ONLY through that function and that function
 * is only called when `written === 0`. So on the ARMED-PARTIAL run — the normal
 * armed run, 400 written and 100 withheld — the doors were computed by nobody
 * and reported nowhere, and the operator's question ("what happened to the
 * other hundred?") had no answer in the logs at all.
 *
 * The scan, not a hand-written list, for the reason `describeNoWriteReason`
 * gives at length: the hand-written list is what failed, twice.
 */
export function listWriteDoors(
  result: XbrlProjectionWriteResult,
): Array<[string, number]> {
  const doors: Array<[string, number]> = [];
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "number" || value === 0) continue;
    if (/^(skipped|refused)/.test(key)) {
      // `skippedCreateSuppressed` -> `createSuppressed`
      const label = key.replace(/^skipped/, "");
      doors.push([label.charAt(0).toLowerCase() + label.slice(1), value]);
    }
  }
  // `refused` is a Record, not a number, so the numeric scan above skips it —
  // MONEY-1235. Flattened here because it is the LARGEST door in a
  // HALF_YEARLY-heavy page: measured, 4,999 refusals plus one failure printed
  // "failed=1", attributing 5,000 filings to a single error, and refusals ALONE
  // printed "NO counter accounts for it … unaccounted, investigate" when the
  // refusal counters accounted for every one of them. That is this function's
  // own stated defect class, inside this function.
  for (const [reason, count] of Object.entries(result.refused)) {
    if (typeof count === "number" && count > 0) {
      doors.push([`refused${reason}`, count]);
    }
  }

  // Not prefixed, but they are still doors a write can go out of.
  // `deferredByPagination` counts filings included in `filingsRead` that were
  // held back with the trailing symbol, so leaving it out makes the arithmetic
  // fail to close.
  for (const key of [
    "supersededSiblings",
    "unreadableFacts",
    "deferredByPagination",
    "failed",
  ] as const) {
    const value = result[key];
    if (typeof value === "number" && value > 0) doors.push([key, value]);
  }

  // Biggest door first — the operator's actual next question. Sorted HERE
  // rather than at the one call site that used to do it, so every consumer of
  // the census gets the same order.
  doors.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return doors;
}

/**
 * The door census as one field, for the job's outcome line — MONEY-1238.
 *
 * `"none"` rather than an empty string when nothing was withheld: an empty
 * value in a `key=value` line reads as a truncated log, and "no doors" is a
 * real, useful and common answer on a clean run.
 */
export function summariseWriteDoors(result: XbrlProjectionWriteResult): string {
  const doors = listWriteDoors(result);
  if (doors.length === 0) return "none";
  return doors.map(([k, v]) => `${k}=${v}`).join(",");
}

/**
 * Counters that match the `skipped*` scan but are NOT withheld writes —
 * MONEY-1238.
 *
 * Both would inflate {@link countWithheldWrites} on a perfectly healthy run,
 * and each is excluded for its own reason:
 *
 *  - `skippedUnchanged` — the row already holds this exact value. Nothing was
 *    withheld; there was nothing to write. On a steady-state page this is the
 *    LARGEST counter, so including it would make `blocked` track "how much of
 *    the page is already done", which is the opposite of a warning sign.
 *  - `skippedScaleCheck` — MONEY-1237, and the type's own comment says it:
 *    "the filings it counts were written". It carries the `skipped` prefix
 *    purely so `describeNoWriteReason`'s scan picks it up, which is exactly the
 *    trap this list exists to disarm.
 *
 * A list of EXCLUSIONS rather than inclusions, deliberately. A counter added
 * later is counted by DEFAULT — over-reporting a door is a question an operator
 * asks; under-reporting one is the silence MONEY-1220/1235 are about.
 */
const NOT_A_WITHHELD_WRITE = new Set(["skippedUnchanged", "skippedScaleCheck"]);

/**
 * How many writes this run deliberately withheld — MONEY-1238.
 *
 * Replaces `blocked = result.skippedAuthority`, which was structurally ~0:
 * `AUTHORITY` is one of four `FinancialsSkipReason` members and, per the result
 * type's own comment, "cannot happen while NSE_XBRL leads
 * `FINANCIALS_AUTHORITY`". Meanwhile `skippedStandaloneNoDisplace` covers 29.5%
 * of winner periods and `skippedCreateSuppressed` covers EVERY quarterly write
 * under the nightly payload — and neither reached the number the operator reads
 * first.
 *
 * ## It is a SIGNAL, not an arithmetic complement
 *
 * The counters it sums are not all in the same unit — `refused*` and the scale
 * verdicts count FILINGS, the row-level guards count STATEMENTS, and one filing
 * yields up to two statements. So `selected - written - blocked` does not close
 * to zero and must never be presented as though it does; wrong-granularity
 * completeness signals are a defect this repo has shipped repeatedly
 * (MONEY-1189). The per-door breakdown, in its own units, rides alongside it in
 * the outcome line — see {@link summariseWriteDoors}.
 */
export function countWithheldWrites(result: XbrlProjectionWriteResult): number {
  let total = 0;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "number") continue;
    if (!/^(skipped|refused)/.test(key)) continue;
    if (NOT_A_WITHHELD_WRITE.has(key)) continue;
    total += value;
  }
  // `refused` is a Record and the numeric scan cannot see it — the same blind
  // spot that made `describeNoWriteReason` print "unaccounted, investigate"
  // over 4,999 accounted-for refusals.
  for (const count of Object.values(result.refused)) {
    if (typeof count === "number") total += count;
  }
  return total;
}

export async function processXbrlProjectionWrite(
  opts: XbrlProjectionWriteOptions = {},
  deps: { prisma?: Db } = {},
): Promise<XbrlProjectionWriteResult> {
  const db = deps.prisma ?? prisma;
  const apply = opts.apply === true;
  const createMissing = opts.createMissing === true;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const out: XbrlProjectionWriteResult = {
    ok: true,
    apply,
    createMissing,
    filingsRead: 0,
    truncatedByLimit: false,
    deferredByPagination: 0,
    refused: emptyRefusals(),
    periods: 0,
    supersededSiblings: 0,
    unreadableFacts: 0,
    refusedScaleSuspect: 0,
    refusedBasisConflict: 0,
    skippedScaleUnconfirmed: 0,
    skippedScaleCheck: 0,
    scaleContextFetched: 0,
    scaleContextTruncated: false,
    statementsProjected: 0,
    created: 0,
    updated: 0,
    displaced: 0,
    skippedAuthority: 0,
    skippedUnchanged: 0,
    skippedBasisDowngrade: 0,
    skippedStandaloneNoDisplace: 0,
    skippedNoInstrument: 0,
    skippedCreateSuppressed: 0,
    failed: 0,
    stampAttempted: 0,
    stamped: 0,
    stampFailed: false,
    examples: [],
  };

  const note = (line: string): void => {
    if (out.examples.length < MAX_EXAMPLES) out.examples.push(line);
  };

  /**
   * `note`, but with a per-KIND budget — MONEY-1235.
   *
   * `examples` is one shared list of 40. An outcome that fires on 29.5% of
   * winner periods (`STANDALONE_NO_DISPLACE`, measured: 3,208 of 10,879) fills
   * all 40 slots before the first DISPLACE or NO-INSTRUMENT line is reached, so
   * adding an expected, well-counted outcome would DESTROY the diagnostic value
   * of the rare ones — the list would faithfully report the thing we already
   * have a counter for and hide everything we do not.
   *
   * The counters carry the volume; the examples exist to show the SHAPE. A
   * handful of each is all a shape needs.
   */
  const perKind = new Map<string, number>();
  const noteCapped = (kind: string, line: string): void => {
    const seen = perKind.get(kind) ?? 0;
    if (seen >= EXAMPLES_PER_COMMON_KIND) return;
    perKind.set(kind, seen + 1);
    note(line);
  };

  const symbols = (opts.symbols ?? [])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const filings = (await db.xbrlFiling.findMany({
    where: {
      ...(symbols.length > 0 ? { symbol: { in: symbols } } : {}),
      ...(opts.since ? { periodEnd: { gte: opts.since } } : {}),
      // Shared with `countUnprojectedFilings` — see UNPROJECTED_FILING_WHERE.
      // A bare `{ projectedAt: null }` here matched NOTHING on Mongo and made
      // this job select 0 of 90,188 filings while reporting success
      // (MONEY-1234).
      ...(opts.unprojectedOnly === true ? UNPROJECTED_FILING_WHERE : {}),
      // Scope to one projection bucket. Filtered HERE, in the query, and never
      // after `judgeProjectionEligibility`: a post-verdict filter would stamp
      // only the matching filings, so the next run would re-read the same
      // unstamped page forever and the cursor would never advance — MONEY-1211's
      // constant-ordering defect rebuilt. Safe as a column filter because the
      // vocabularies coincide exactly where it matters: target ANNUAL comes only
      // from a filing typed ANNUAL and target QUARTERLY only from one typed
      // QUARTERLY. HALF_YEARLY and NINE_MONTH produce no target at all (they are
      // refused), so excluding them here changes nothing.
      ...(opts.periodTypes && opts.periodTypes.length > 0
        ? { periodType: { in: opts.periodTypes } }
        : {}),
    },
    // Symbol-major so a truncated page can only cut inside ONE symbol.
    orderBy: [{ symbol: "asc" }, { periodEnd: "desc" }],
    take: limit,
    // Shared with `fetchScaleContext` — MONEY-1237. Two hand-copied column
    // lists is how `countUnprojectedFilings` ended up asking a different
    // question from the selector it was meant to diagnose (MONEY-1234), and a
    // sibling read that dropped `facts` or `basis` would feed the detector
    // phantom observations with no magnitudes and the wrong context tier.
    select: FILING_SELECT,
  })) as unknown as FilingRow[];

  out.filingsRead = filings.length;
  out.truncatedByLimit = filings.length >= limit;

  let usable: FilingRow[] = filings;
  if (out.truncatedByLimit) {
    const split = dropPartialTrailingSymbol(filings);
    usable = split.kept;
    out.deferredByPagination = split.deferred;
    logger.warn(
      { limit, deferred: split.deferred },
      "read hit the limit — the trailing symbol is DEFERRED, not partially processed",
    );
  }

  // ── The scale-detector's context, built ONCE for the whole page ──
  //
  // MONEY-1235. `judgeFilingScale` compares a filing's magnitudes against the
  // company's OWN adjacent filings, and this is where those siblings come from:
  // the read is `orderBy: [symbol asc, …]` and `dropPartialTrailingSymbol`
  // guarantees whole symbols per page, so every sibling THIS PAGE holds is
  // already in `usable`.
  //
  // Built here rather than inside the group loop because a symbol's filings are
  // shared by ALL of that symbol's groups: one pass over `usable` is O(n) where
  // per-group projection would be O(n²) within each symbol.
  const observations = new Map<string, ScaleObservation>();
  const bySymbol = new Map<string, ScaleObservation[]>();
  const addObservation = (obs: ScaleObservation, symbol: string): void => {
    observations.set(obs.filingId, obs);
    const list = bySymbol.get(symbol);
    if (list) list.push(obs);
    else bySymbol.set(symbol, [obs]);
  };
  for (const f of usable) {
    const obs = observeScale(f);
    if (obs) addObservation(obs, f.symbol);
  }

  // ── …and the siblings that are NOT on this page ── MONEY-1237
  //
  // THE DEFECT: the paragraph above was true only during the DRAIN. While the
  // backlog is being worked off a page holds whole symbols with their whole
  // history, so `bySymbol` is a real time series. Afterwards every nightly page
  // holds roughly ONE new filing per symbol — every earlier one was stamped on
  // a previous night and is filtered out by `unprojectedOnly` — so
  // `siblings.length` is 0, every candidate answers INSUFFICIENT_CONTEXT
  // (probed: `siblingPeriods: 0`), and the filing is written with no scale
  // check at all. The header calls this check "the only cover the quarterly
  // universe will ever get"; it was DRAIN-ONLY cover.
  //
  // ONE grouped query for the whole page, never one per group. A per-symbol
  // lookup is the N+1 that made the F3 reconcile un-runnable (MONEY-1234:
  // 6h20m elapsed at 0.0% CPU, killed unfinished), and this job runs against a
  // 600s Pub/Sub ack deadline that cannot be raised.
  const filings2 = await fetchScaleContext(db, usable, out);
  for (const f of filings2) {
    const obs = observeScale(f);
    if (obs) addObservation(obs, f.symbol);
  }

  // ── Group by target row ──
  const groups = new Map<
    string,
    {
      target: { periodType: "ANNUAL" | "QUARTERLY"; period: string };
      rows: FilingRow[];
    }
  >();

  // Filings this run reached a DECISION about, and the subset that failed.
  // Only decided-minus-failed advances the `projectedAt` cursor — see the stamp
  // block at the end of this function.
  const decidedIds = new Set<string>();
  const failedIds = new Set<string>();
  /**
   * Filings whose outcome was NOT a decision — MONEY-1235.
   *
   * Distinct from `failedIds`, which means "this threw and might succeed on a
   * retry with no new bytes". These did not fail: they were deliberately not
   * written because a SWITCH is off (`createMissing`) or because a row this job
   * does not own is missing (`instrument_mappings`). Both flip without any new
   * filing, so stamping them would burn the filing on a verdict that is a
   * property of the RUN, not of the data.
   */
  const notDecidedIds = new Set<string>();
  /**
   * Filings HELD BACK by the scale detector — MONEY-1237.
   *
   * A third set, and not folded into `notDecidedIds`, because the reason a
   * filing comes back is different and the difference is what makes each one
   * safe. `notDecided` flips when a SWITCH or another table changes with
   * nothing new arriving from NSE. These flip when the SIBLING SET changes: a
   * newer period lands, or the F2 backfill lays down an older one. Both are
   * "come back tomorrow"; only one of them is about this run's configuration,
   * and collapsing them would make the next person reading the stamp block
   * believe a scale hold is a dry-run artefact.
   *
   * The whole GROUP is held, winner and superseded siblings alike: the group
   * re-forms identically on the next run, and a stamped loser would be missing
   * from it.
   */
  const scaleHeldIds = new Set<string>();

  for (const f of usable) {
    const verdict = judgeProjectionEligibility({
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      periodType: f.periodType,
      cumulative: f.cumulative,
    });
    if (!verdict.eligible) {
      out.refused[verdict.refusal]++;
      // A refusal IS a decision, so it advances the cursor. All four refusals
      // are pure functions of columns already stored on the row
      // (periodStart/periodEnd/periodType/cumulative), so a filing refused once
      // is refused identically forever — re-reading it nightly can only ever
      // produce the same verdict.
      //
      // Left unstamped it never drains: 357 of prod's 90,188 filings are
      // HALF_YEARLY, so once the real backlog is projected every future run
      // would select those 357 and write 0, permanently. "selected 357,
      // written 0" is indistinguishable from a broken selector at a glance, and
      // manufacturing that signal is precisely what MONEY-1220 and MONEY-1234
      // exist to stop.
      //
      // IF THE ELIGIBILITY POLICY EVER CHANGES — a real HALF_YEARLY bucket, a
      // widened span window — these rows are now invisible to the nightly run.
      // Clear their stamp to re-open them:
      //   db.xbrl_filings.updateMany({ periodType: "HALF_YEARLY" },
      //                              { $unset: { projectedAt: "" } })
      decidedIds.add(f.id);
      continue;
    }
    const key = groupKey(
      f.symbol,
      f.exchange,
      verdict.target.periodType,
      verdict.target.period,
    );
    const g = groups.get(key);
    if (g) g.rows.push(f);
    else groups.set(key, { target: verdict.target, rows: [f] });
  }

  out.periods = groups.size;

  for (const [key, group] of groups) {
    const winner = selectFilingForPeriod(group.rows);
    if (!winner) continue;
    out.supersededSiblings += group.rows.length - 1;

    // Every filing in the group is decided, winner and superseded alike: a
    // sibling that LOST its period will lose it again on every future run, so
    // re-reading it nightly is pure cost.
    for (const row of group.rows) decidedIds.add(row.id);

    const financials = readFacts(winner.facts);
    if (!financials) {
      out.unreadableFacts++;
      note(`UNREADABLE ${key} (filing ${winner.id})`);
      continue;
    }

    // ── The scale quarantine (MONEY-1235, re-derived in MONEY-1237) ──
    //
    // Before anything is written, ask whether this filing's magnitudes agree
    // with the periods ADJACENT to it. The F3 reconcile found 28 scale
    // mismatches across 15 (symbol, period) filings — 1000x, 100x, 10x, both
    // directions, each internally consistent — which is the signature of a
    // filer mis-declaring its own `roundingLabel`, not of our arithmetic. Those
    // 28 are only the ones a VENDOR row existed to expose; 90.7% of winner
    // periods have none, so this check is the only cover the quarterly universe
    // (71,450 filings, zero incumbent rows) will ever get.
    //
    // SKIPPED, and — since MONEY-1237 — NOT STAMPED. Skipped because the
    // founder decision is quarantine over auto-correction: multiplying by an
    // inferred power of ten guesses which side is wrong, and a silently
    // "corrected" number is worse than a visible gap. Not stamped because the
    // stamped version had NO RECOVERY PATH. Its comment claimed one — "a
    // corrected filing is a NEW `XbrlFiling` row, unstamped by construction" —
    // and that is true of a filing that is WRONG. It is false of a filing that
    // is RIGHT: NSE will never republish a correct reverse-merger year, so a
    // legitimate step change quarantined by the old whole-history median was
    // lost permanently and silently, recoverable only by a hand `$unset`
    // against prod. Three verdicts, three responses, all of them re-derived on
    // the next run:
    //
    //   SCALE_SUSPECT       both neighbouring sides disagree by the same power
    //                       of ten. A conviction, and it will keep convicting —
    //                       but it is a function of the SIBLING SET, and the
    //                       sibling set GROWS (the F2 backfill lays down older
    //                       years, the next quarter lays down a newer one).
    //                       Re-reading it costs one page slot; stamping it
    //                       costs the period.
    //   SCALE_UNCONFIRMED   only one side exists (the newest or oldest filing
    //                       we hold), so a mis-scale and a whole-company step
    //                       change are the same picture. HELD, and it empties
    //                       itself: one reporting period later the missing side
    //                       exists and the verdict resolves.
    //   INSUFFICIENT_CONTEXT  no oracle. WRITTEN, and now COUNTED — see
    //                       `skippedScaleCheck`.
    //
    // The cost of not stamping is real and is bounded by measurement: 15 of
    // prod's 90,188 filings (0.017%) are known mis-scales, so the permanently
    // re-read set is noise against a 500-filing page. If `refusedScaleSuspect`
    // plus `skippedScaleUnconfirmed` ever approaches `limit`, this job is
    // starving itself and that is what those two counters are for.
    const candidate = observations.get(winner.id);
    const scale = candidate
      ? judgeFilingScale(candidate, bySymbol.get(winner.symbol) ?? [])
      : null;
    if (!scale || scale.verdict === "INSUFFICIENT_CONTEXT") {
      // Written with no scale cover. Counted rather than silent: a run with
      // ZERO coverage used to be indistinguishable from a run with full
      // coverage, on the one check that protects the CREATE-only universe.
      out.skippedScaleCheck++;
    } else if (scale.verdict === "SCALE_SUSPECT") {
      out.refusedScaleSuspect++;
      for (const row of group.rows) scaleHeldIds.add(row.id);
      note(
        `SCALE-SUSPECT ${winner.symbol} ${group.target.period} ` +
          `x${scale.factor} on ${scale.fields.join("+")} ` +
          `(vs ${scale.siblingPeriods} sibling periods, filing ${winner.id})`,
      );
      continue;
    } else if (scale.verdict === "SCALE_BASIS_CONFLICT") {
      // MONEY-1250 (T3.2). The company's own CONSOLIDATED and STANDALONE
      // filings for this period state different paid-up equity share capital —
      // the parent's own share capital, identical across bases by
      // construction. One of the two documents is mis-scaled somewhere.
      //
      // HELD exactly like SCALE_SUSPECT, and counted SEPARATELY, because the
      // two say different things and the difference decides what an operator
      // does next. SCALE_SUSPECT names the offending filing; this one names a
      // PAIR and says in as many words that it cannot pick a side. Folding
      // them would also hide the one operational risk this rule carries: it
      // holds ~166 period groups permanently (measured on prod 2026-08-26 —
      // 45 ANNUAL, 118 QUARTERLY, 3 HALF_YEARLY), because unlike
      // SCALE_UNCONFIRMED nothing about it resolves with the next reporting
      // period. Those filings are never stamped, so they are re-read every
      // night forever, and a page is 500 filings. `refusedBasisConflict`
      // approaching `limit` is this job starving itself, and this counter is
      // the only thing that would say so.
      out.refusedBasisConflict++;
      for (const row of group.rows) scaleHeldIds.add(row.id);
      noteCapped(
        "SCALE_BASIS_CONFLICT",
        `SCALE-BASIS-CONFLICT ${winner.symbol} ${group.target.period} ` +
          `${winner.basis} paidUp=${scale.paidUpEquityShareCapital}` +
          `${scale.roundingLabel ? ` (${scale.roundingLabel})` : ""} vs ` +
          `${scale.counterpartBasis} paidUp=${scale.counterpartPaidUpEquityShareCapital}` +
          `${scale.counterpartRoundingLabel ? ` (${scale.counterpartRoundingLabel})` : ""} ` +
          `= x${scale.ratio} — ${scale.undecidable} ` +
          `(filing ${winner.id}, counterpart ${scale.counterpartFilingId})`,
      );
      continue;
    } else if (scale.verdict === "SCALE_UNCONFIRMED") {
      out.skippedScaleUnconfirmed++;
      for (const row of group.rows) scaleHeldIds.add(row.id);
      // `noteCapped`, not `note`: this is an EXPECTED outcome in the steady
      // state — every genuine step change passes through it for exactly one
      // reporting period — and an expected outcome that already has a counter
      // must not be allowed to fill the shared 40-line example list.
      noteCapped(
        "SCALE_UNCONFIRMED",
        `SCALE-UNCONFIRMED ${winner.symbol} ${group.target.period} ` +
          `x${scale.factor} on ${scale.fields.join("+")} ` +
          `(no ${scale.missingSide} sibling period; ` +
          `${scale.siblingPeriods} sibling periods, filing ${winner.id})`,
      );
      continue;
    }

    const projection = projectFinancials(financials);
    // MONEY-1238 — the CONCEPT list travels with the field name.
    //
    // This was `projection.unfilled.map((u) => u.field)`, which threw away the
    // half `ProjectionResult.unfilled`'s own doc calls "the point of the
    // module". A stored `["ebitda"]` says only that a null column is null; a
    // stored `[{field:"ebitda", needed:["depreciationAndAmortisation"]}]` says
    // WHY, and the difference is whether a null is a taxonomy gap we accept or
    // a parse bug we fix. Nothing else retains it once the run ends.
    const unfilled = projection.unfilled.map((u) => ({
      field: u.field,
      needed: [...u.needed],
    }));
    const filingProvenance = {
      periodEnd: winner.periodEnd.toISOString(),
      periodType: winner.periodType,
      basis: winner.basis,
      cumulative: winner.cumulative,
      // MONEY-1239 — the taxonomy family decides which columns this filing may
      // write at all. A lender does not write `operatingIncome` or `ebitda`,
      // because the concepts they need are in 10% and 0% of lender filings
      // respectively, so claiming them would null the rest.
      family: financials.family,
      // The FILING SHAPE — MONEY-1250. `family` is "banking" for 665 NBFC
      // documents, so it cannot answer "is this an RBI Form-A bank";
      // `bankCapital` can (76 of 76 vs 0 of 871). Read through the SHARED
      // helper: this comment used to say "from the filing's own tags", which
      // pointed a reader straight at `lenderTopLineShape` — a function
      // returning the same two strings from a discriminator that is wrong for
      // exactly these 665 filings.
      filerShape: filerShapeOf(financials.values),
      taxonomyVersion: winner.taxonomyVersion,
      coverage: winner.coverage,
      sourceUrl: winner.sourceUrl,
    };

    // MONEY-1205 — rebase rupees → ₹ crore BEFORE anything downstream sees a
    // value. `planFinancialsWrite` compares against the incumbent (crore),
    // records what it displaced (crore) and stamps `rawData.xbrl.projected`, so
    // converting any later would leave three copies disagreeing about units.
    const statements: ProjectedFinancials[] = [
      projection.income,
      projection.balanceSheet,
    ]
      .filter((s): s is ProjectedFinancials => s !== null)
      .map(toCroreDenominated);

    for (const statement of statements) {
      out.statementsProjected++;
      try {
        const decision = await writeOneStatement({
          db,
          apply,
          createMissing,
          now,
          winner,
          statement,
          unfilled,
          filingProvenance,
          target: group.target,
          out,
          note,
          noteCapped,
        });
        // ANY not-a-decision outcome un-stamps the whole filing — MONEY-1235.
        // One filing produces up to TWO statements, and they can disagree: a
        // filing whose INCOME row updated while its BALANCE_SHEET create was
        // suppressed must come back for the create, so the OR is over
        // statements, never the last one wins.
        if (decision === "NOT_DECIDED") notDecidedIds.add(winner.id);
      } catch (err) {
        // One bad row never ends the run: the rest of the universe is still
        // projectable, and a partial run that SAYS it was partial is worth more
        // than a run that stops at whatever row happened to be malformed.
        out.failed++;
        // Keeps its null stamp so the next run retries it — the one
        // outcome that might succeed with no new bytes.
        failedIds.add(winner.id);
        note(
          `FAILED ${winner.symbol} ${group.target.period} ` +
            `${statement.statementType}: ${String(err)}`,
        );
      }
    }
  }

  // A run with rows it MEANT to write and did not is not a successful run.
  // Refusals and `unreadableFacts` are explained outcomes with their own
  // counters; `failed` is the only bucket that means "this should have landed
  // and did not". Reporting ok on it is the completeness-signal-at-the-wrong-
  // granularity defect this repo has now shipped five times (MONEY-1189).
  out.ok = out.failed === 0;

  // ── Advance the cursor — MONEY-1220 ──────────────────────────────────────
  //
  // Stamp every filing this run REACHED A DECISION about, so the next run's
  // `unprojectedOnly` filter moves past it. Without this the filter selects the
  // same rows forever and the job is no better than the constant sort it
  // replaced.
  //
  // Stamped: written, superseded by a sibling, refused by authority, skipped as
  // unchanged, skipped as a basis downgrade or a standalone non-displacement,
  // or unreadable. All of those are DECISIONS —
  // re-reading them every night starves the queue behind them, and none will
  // change without new bytes (a new filing gets a new row, which is unstamped
  // by construction).
  //
  // NOT stamped, and the second one is what blocked arming — MONEY-1235:
  //
  //  - `failed`. A per-row failure is the one outcome that might succeed next
  //    time with no new bytes, so it keeps its null stamp and is retried.
  //  - `notDecided` — create-suppressed and no-instrument. Neither is a
  //    property of the FILING. `createMissing` is a switch on the message, and
  //    a missing `instrument_mappings` row is a gap another job fills; both
  //    flip with nothing new arriving from NSE. These used to stamp, because
  //    `decidedIds` was populated for the whole group BEFORE any statement was
  //    written and the CREATE branch returned without touching `failedIds`.
  //    Armed with the nightly `{}` payload (`createMissing` false) that burns
  //    500 quarterly filings PER NIGHT into stamped-never-created, and the
  //    later deliberate `createMissing` pilot then selects nothing at all —
  //    MONEY-1235's "Quarterly can never fill" defect rebuilt one level up,
  //    recoverable only by a hand `$unset`. Prod has 71,450 QUARTERLY filings
  //    against ZERO quarterly `stock_financials` rows, so EVERY quarterly write
  //    is a create and every one of them was exposed.
  //  - `scaleHeld` — MONEY-1237, and it is the same defect one layer down. The
  //    scale quarantine DID stamp, and its comment justified that with "a
  //    corrected filing is a NEW `XbrlFiling` row, unstamped by construction".
  //    That escape hatch only exists for a filing that is WRONG. NSE will never
  //    republish a filing that is RIGHT, so every false positive — and the
  //    whole-history median produced them on reverse mergers, spin-offs and any
  //    company compounding >= 3.16x/yr — was a real period lost permanently,
  //    silently, with a hand `$unset` as the only recovery. Not stamping makes
  //    the verdict a function of the CURRENT sibling set instead of the one
  //    that happened to be in memory the night the filing first appeared.
  //
  // Only when `apply` — a dry run must leave no trace, or the first armed run
  // would skip everything a rehearsal had already "decided".
  const decided = [...decidedIds].filter(
    (id) =>
      !failedIds.has(id) && !notDecidedIds.has(id) && !scaleHeldIds.has(id),
  );
  if (apply && decided.length > 0) {
    out.stampAttempted = decided.length;
    try {
      // THE RESULT IS READ — MONEY-1238. It used to be discarded, so a stamp
      // that silently matched zero rows was indistinguishable from one that
      // moved the whole page: the run reported `written=500 failed=0 ok=true`
      // either way, and the next night re-read and re-wrote the same 500
      // filings. Forever. That is MONEY-1211 with a different door, and the
      // sibling ratios job reads `updateMany().count` for exactly this reason.
      const res = await db.xbrlFiling.updateMany({
        where: { id: { in: decided } },
        data: { projectedAt: now },
      });
      out.stamped = res.count;
      if (out.stamped < decided.length) {
        logger.warn(
          { attempted: decided.length, stamped: out.stamped },
          "projectedAt stamp matched FEWER rows than it named — the cursor " +
            "did not fully advance and those filings return tomorrow",
        );
      }
    } catch (error) {
      // A cursor that fails to advance costs a repeated read, never a wrong
      // number. It must not fail a run that has already written correct rows —
      // so `ok` is deliberately untouched here. What changed in MONEY-1238 is
      // that the failure is now COUNTED and reaches the job-outcome line,
      // instead of living only in a warning nobody queries.
      out.stampFailed = true;
      logger.warn({ error, count: decided.length }, "projectedAt stamp failed");
    }
  }

  if (!apply) {
    logger.warn(
      { wouldCreate: out.created, wouldUpdate: out.updated },
      "DRY RUN — nothing was written. Pass apply:true only with a reconcile " +
        "report reading READY for every field.",
    );
  }
  logger.info(out, "done");
  return out;
}

/**
 * Whether one statement's outcome is a PERMANENT decision about its filing —
 * MONEY-1235.
 *
 * Returned rather than inferred by the caller, because the caller cannot see
 * which branch ran: a create-suppressed statement and a skipped-unchanged one
 * both leave the store untouched and both increment a counter, and only one of
 * them is a decision. Making it a returned VALUE also means a new branch added
 * below cannot silently inherit "decided" — the compiler asks.
 */
type StatementDecision = "DECIDED" | "NOT_DECIDED";

async function writeOneStatement(args: {
  db: Db;
  apply: boolean;
  createMissing: boolean;
  now: Date;
  winner: FilingRow;
  statement: ProjectedFinancials;
  /** MONEY-1238 — field AND the concepts it needed. See the call site. */
  unfilled: Array<{ field: string; needed: string[] }>;
  filingProvenance: {
    periodEnd: string;
    periodType: string;
    basis: string;
    cumulative: boolean;
    family?: string;
    taxonomyVersion: string;
    coverage: number;
    sourceUrl: string;
  };
  target: { periodType: "ANNUAL" | "QUARTERLY"; period: string };
  out: XbrlProjectionWriteResult;
  note: (line: string) => void;
  /** `note` with a per-kind budget, for outcomes expected to be common. */
  noteCapped: (kind: string, line: string) => void;
}): Promise<StatementDecision> {
  const { db, winner, statement, target, out, note } = args;

  const where = {
    symbol: winner.symbol,
    exchange: winner.exchange,
    statementType: statement.statementType,
    periodType: target.periodType,
    period: target.period,
  };

  const incumbent = (await db.stockFinancials.findUnique({
    where: { symbol_exchange_statementType_periodType_period: where },
    select: {
      source: true,
      fetchedAt: true,
      rawData: true,
      // MONEY-1238 — the basis guards' FALLBACK evidence. Selected because
      // `planFinancialsWrite` now consults it when `rawData` provenance is
      // unreadable; omitting it here would leave the fallback permanently
      // `undefined`, i.e. a guard that reads a field the query never fetched.
      // See `IncumbentFinancialsRow.basis`.
      basis: true,
      // The VENDOR's income columns. Selected but no longer OWNED (MONEY-1255
      // `UNOWNED_VENDOR_COLUMNS`), so `incumbentValues` never reads them and no
      // write mentions them — they are here only so a reader of this query can
      // see what the row holds beside our figures.
      revenue: true,
      grossProfit: true,
      operatingIncome: true,
      netIncome: true,
      ebitda: true,
      // OURS. Every one of these is in `INCOME_FIELDS`, so omitting any of them
      // makes `incumbentValues` read `undefined`, the UNCHANGED check see a
      // difference that is not there, and the row be rewritten on every nightly
      // pass forever. `otherIncome` was missing here from the day it became
      // owned (MONEY-1250) — the same defect, one column wide.
      otherIncome: true,
      revenueFromOperations: true,
      operatingIncomeExOtherIncome: true,
      ebitdaBeforeExceptionalItems: true,
      totalAssets: true,
      totalLiabilities: true,
      totalEquity: true,
      totalDebt: true,
      totalCash: true,
    },
  })) as IncumbentFinancialsRow | null;

  const plan = planFinancialsWrite({
    projected: statement,
    incumbent,
    filing: args.filingProvenance,
    unfilled: args.unfilled,
    now: args.now,
    challenger: XBRL_SOURCE,
  });

  const label = `${winner.symbol} ${target.periodType} ${target.period} ${statement.statementType}`;

  if (plan.action === "SKIP") {
    // On the VALUE, never on the prose. Matching `reason` text would silently
    // reclassify every skip the day somebody rewords a message.
    //
    // This used to be `if UNCHANGED else AUTHORITY`, and that `else` was a
    // CATCH-ALL: MONEY-1235's two new basis skips would have landed in
    // `skippedAuthority`, reporting a 29.5% policy outcome under a label that
    // means "some other SOURCE outranks NSE_XBRL" — which cannot happen while
    // NSE_XBRL leads `FINANCIALS_AUTHORITY`, so nobody would have questioned
    // the number. Each reason now has its own arm and its own counter.
    //
    // Kept as an if/else-if over `plan.skipReason === "UNCHANGED"` rather than
    // rewritten as a `switch`: `financials-write-authority.test.ts` scans this
    // file for that exact comparison to prove the projection writer's authority
    // EXEMPTION is earned — it is exempt because it uses the richer
    // `planFinancialsWrite` and HONOURS the verdict, not because it skips the
    // check. A `switch` reads the same value and would silently fail that
    // drift guard.
    //
    // The two basis skips use `noteCapped`, not `note`: both are EXPECTED
    // outcomes at scale (standalone-only is 29.5% of winner periods) and a
    // shared 40-line list filled with an outcome that already has a counter is
    // a list that has stopped reporting anything.
    if (plan.skipReason === "UNCHANGED") out.skippedUnchanged++;
    else if (plan.skipReason === "BASIS_DOWNGRADE") {
      out.skippedBasisDowngrade++;
      args.noteCapped(
        "BASIS_DOWNGRADE",
        `SKIP-BASIS-DOWNGRADE ${label}: ${plan.reason}`,
      );
    } else if (plan.skipReason === "STANDALONE_NO_DISPLACE") {
      out.skippedStandaloneNoDisplace++;
      args.noteCapped(
        "STANDALONE_NO_DISPLACE",
        `SKIP-STANDALONE ${label}: ${plan.reason}`,
      );
    } else {
      out.skippedAuthority++;
      note(`SKIP-AUTHORITY ${label}: ${plan.reason}`);
    }
    // Every SKIP is a decision. Both basis skips will return the same verdict
    // for as long as the incumbent stands, and the UPGRADE path survives the
    // stamp because a later CONSOLIDATED filing is a DIFFERENT `XbrlFiling` row
    // (`basis` is in that table's unique key) and arrives unstamped.
    return "DECIDED";
  }

  if (plan.action === "CREATE") {
    if (!args.createMissing) {
      // NOT a decision — see the stamp block. `createMissing` is a switch on
      // the message, so this verdict describes the RUN and not the filing.
      out.skippedCreateSuppressed++;
      return "NOT_DECIDED";
    }
    if (!winner.instrumentId) {
      // `StockFinancials.instrumentId` is a required FK. A filing whose issuer
      // is not in `instrument_mappings` cannot open a row — counted on its own
      // line, because folding it into "skipped" would hide a mapping gap behind
      // a number that also means "deliberately not created".
      //
      // Also NOT a decision: `instrument-sync` fills that gap on its own
      // schedule, with nothing new arriving from NSE, and a stamp here would
      // make the filing invisible on the night the mapping finally appears.
      out.skippedNoInstrument++;
      note(`NO-INSTRUMENT ${label} (filing ${winner.id})`);
      return "NOT_DECIDED";
    }
    note(`CREATE ${label}`);
    // COUNTED AFTER THE WRITE RESOLVES — MONEY-1238.
    //
    // The increment used to sit ABOVE the await, so a statement whose Prisma
    // call REJECTED was counted as written AND as failed: a single filing
    // producing a single statement could report the arithmetically impossible
    // {"selected":1,"written":1,"failed":1}. That inflates `job.written`, which
    // is exactly the series the zero-write monitor keys on — a run in which
    // every write threw would still report a healthy non-zero written count,
    // so the alarm could not fire on the one shape it exists to catch.
    //
    // The dry run still counts, because `args.apply === false` performs no
    // write and therefore cannot fail: what it reports is what WOULD land.
    if (args.apply) {
      await db.stockFinancials.create({
        data: {
          instrumentId: winner.instrumentId,
          ...where,
          // Owned columns the filing did not disclose arrive here as explicit
          // NULLs. That is the point: on a fresh row they read as "not disclosed",
          // and on an update they stop another source's number from surviving
          // under our provenance stamp.
          ...(plan.values ?? {}),
          // MONEY-1232 — the REAL date, not just the label.
          //
          // `StockFinancials.periodEnd` is nullable and this writer never set it,
          // so every projected row would have landed with `periodEnd: null`. Two
          // consequences, both silent:
          //
          //  1. `@@index([symbol, exchange, statementType, periodType,
          //     periodEnd(sort: Desc)])` exists precisely to sort these rows by
          //     date. Against null it covers nothing — for exactly the rows this
          //     job creates.
          //  2. Chronology would then rest entirely on the LABEL string. The
          //     research path (`db-store.ts` -> `getDbFirstStatements` ->
          //     `fetch-income-statement.ts`) orders by `period` DESC and re-sorts
          //     nowhere, handing the result straight to the model. A lexical sort
          //     over mixed-convention labels misorders statements inside a prompt
          //     with no error and nothing to notice.
          //
          // Writing the date makes ordering independent of the naming convention,
          // which is what stops the label rule from being load-bearing.
          periodEnd: winner.periodEnd,
          // MONEY-1235 — CONSOLIDATED or STANDALONE, on the row itself.
          //
          // It is already in `rawData.xbrl.filing.basis`, which is what the basis
          // GUARDS read (and must keep reading — see `planFinancialsWrite`). This
          // column exists for READERS: the Financials tab, the research tools and
          // any future reconcile need to know whether a number is the group or
          // the parent WITHOUT parsing a Json blob, and the two figures differ by
          // a multiple for any holding company.
          basis: winner.basis,
          source: plan.source ?? XBRL_SOURCE,
          rawData: plan.rawData as unknown as Prisma.InputJsonValue,
          fetchedAt: args.now,
        } as Prisma.StockFinancialsUncheckedCreateInput,
      });
    }
    out.created++;
    return "DECIDED";
  }

  if (plan.displaced) {
    note(
      `DISPLACE ${label}: ${plan.displaced.displacedSource} → ${XBRL_SOURCE}`,
    );
  }
  // COUNTED AFTER THE WRITE RESOLVES — MONEY-1238.
  //
  // The increment used to sit ABOVE the await, so a statement whose Prisma
  // call REJECTED was counted as written AND as failed: a single filing
  // producing a single statement could report the arithmetically impossible
  // {"selected":1,"written":1,"failed":1}. That inflates `job.written`, which
  // is exactly the series the zero-write monitor keys on — a run in which
  // every write threw would still report a healthy non-zero written count,
  // so the alarm could not fire on the one shape it exists to catch.
  //
  // The dry run still counts, because `args.apply === false` performs no
  // write and therefore cannot fail: what it reports is what WOULD land.
  if (args.apply) {
    await db.stockFinancials.update({
      where: { symbol_exchange_statementType_periodType_period: where },
      data: {
        ...(plan.values ?? {}),
        // Set on UPDATE too, not only CREATE — see the note above. An incumbent
        // Tickertape row has no `periodEnd` either, so a displacement that left
        // it null would keep the sort broken on exactly the rows we just took
        // ownership of.
        periodEnd: winner.periodEnd,
        // Same reasoning as `periodEnd`: a displaced vendor row carries no basis
        // at all, so an update that left it absent would keep every reader
        // guessing on precisely the rows we just took ownership of.
        basis: winner.basis,
        source: plan.source ?? XBRL_SOURCE,
        rawData: plan.rawData as unknown as Prisma.InputJsonValue,
        fetchedAt: args.now,
      } as Prisma.StockFinancialsUncheckedUpdateInput,
    });
  }
  out.updated++;
  if (plan.displaced) out.displaced++;
  return "DECIDED";
}
