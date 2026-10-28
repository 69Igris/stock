/**
 * The ratio columns XBRL + our own price history can produce, beyond the set
 * `xbrl-projection.ts` already derives — MONEY-1220.
 *
 * ## Why this file exists
 *
 * `StockRatios` has 28 data columns today — 25 when this paragraph was written,
 * plus `ebitdaMargin`, `assetTurnover` (MONEY-1220) and `returnBasis`
 * (MONEY-1250). The counts below are HISTORY and are left at their historical
 * values on purpose; the CURRENT split is 26 owned / 2 unowned and lives in
 * `XBRL_OWNED_RATIO_COLUMNS` + `XBRL_UNOWNED_RATIO_COLUMNS`, which
 * `xbrl-ratios-producer.test.ts` pins against `schema.prisma` so no prose
 * anywhere has to be trusted for it.
 *
 * MONEY-1115's first pass owned 15 and parked 10
 * in `XBRL_UNOWNED_RATIO_COLUMNS`, which read as "XBRL cannot supply these".
 * That was never true. It was a SCOPE line: the first pass consumed only the
 * latest filing, so anything needing multi-year history (CAGR), a balance sheet
 * (current ratio), an expense breakdown (gross margin) or a price series (beta)
 * had no inputs to hand. Eight of the ten are ordinary arithmetic over data we
 * already hold; this module is that arithmetic.
 *
 * The two that remain genuinely unowned — `targetPrice` and `recommendation` —
 * are sell-side ANALYST OPINION. They appear in no filing and in no price
 * series. They are deliberately left null rather than sourced from a scraper,
 * because a number nobody can reproduce from primary data does not belong in a
 * table whose other 26 columns are traceable to a filing id.
 *
 * ## The rule every function here obeys
 *
 * **A missing input yields `null`, never `0`.** Nowhere is this more load-
 * bearing than gross margin: treating an absent `CostOfMaterialsConsumed` as
 * zero reports a 100% gross margin, which is not a degraded answer but a
 * fabricated one. Every function returns `undefined` when it cannot honestly
 * compute, and {@link deriveExtendedRatios} records WHY in `unfilled` — the
 * same "measured, never silent" contract `planRatiosWrite` uses.
 *
 * Pure: no I/O, no Prisma, no clock. Callers pass plain records so the worker,
 * the backfill and the tests all exercise the identical code path.
 */

import type { XbrlFamily } from "./xbrl-financials-logic";
import { toIstDateKey } from "./nse-holidays";

// ═══════════════════════════════════════════════════════════════════════════
// Inputs
// ═══════════════════════════════════════════════════════════════════════════

/** One fiscal year's figures, as the projection produces them (₹ crore). */
export interface AnnualPoint {
  /** Fiscal year END, e.g. 2025 for FY 2024-25. Used only for ordering. */
  fyEndYear: number;
  revenue?: number | null;
  netIncome?: number | null;
}

/** The income lines a gross margin needs. All ₹ crore, all optional. */
export interface GrossMarginInput {
  revenue?: number | null;
  costOfMaterialsConsumed?: number | null;
  purchasesOfStockInTrade?: number | null;
  /** SIGNED delta. Inventory that grew is negative (a credit). Added as-is. */
  changesInInventories?: number | null;
}

/** The two balance-sheet lines a current ratio needs. */
export interface CurrentRatioInput {
  currentAssets?: number | null;
  currentLiabilities?: number | null;
}

/** One close. `date` is only used to align the two series. */
export interface ClosePoint {
  date: Date | string;
  close: number;
}

/** Why an extended column could not be filled. Surfaced, never swallowed. */
export type UnfilledReason =
  | "no-input"
  | "lender-has-no-cogs"
  | "non-positive-denominator"
  | "insufficient-history"
  | "sign-change"
  | "non-positive-growth"
  | "insufficient-observations"
  | "zero-variance";

// ═══════════════════════════════════════════════════════════════════════════
// Individual derivations
// ═══════════════════════════════════════════════════════════════════════════

/** Finite and not NaN. `Number.isFinite(null)` is false, which is what we want. */
function num(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Current assets / current liabilities.
 *
 * Annual (or half-yearly) only: Indian QUARTERLY filings carry a P&L and no
 * balance sheet — SEBI mandates one at half-year. Passing a quarter's figures
 * here yields `no-input`, correctly.
 */
export function currentRatio(input: CurrentRatioInput): {
  value?: number;
  reason?: UnfilledReason;
} {
  const a = num(input.currentAssets);
  const l = num(input.currentLiabilities);
  if (a === undefined || l === undefined) return { reason: "no-input" };
  // A zero or negative current-liabilities figure is a parse artefact, not a
  // company with no short-term obligations. Dividing by it produces Infinity,
  // which would sort to the top of every "most liquid" screen.
  if (l <= 0) return { reason: "non-positive-denominator" };
  return { value: a / l };
}

/**
 * (Revenue − COGS) / Revenue, where COGS is the Ind-AS three-line sum.
 *
 * Lenders return `lender-has-no-cogs`: a bank's cost of funds is interest
 * expended, not materials consumed, and calling that a gross margin would
 * invent a metric the filing does not report.
 */
export function grossMargin(
  input: GrossMarginInput,
  family: XbrlFamily,
): { value?: number; reason?: UnfilledReason } {
  if (family === "banking" || family === "nbfc") {
    return { reason: "lender-has-no-cogs" };
  }
  const revenue = num(input.revenue);
  if (revenue === undefined) return { reason: "no-input" };
  if (revenue <= 0) return { reason: "non-positive-denominator" };

  const materials = num(input.costOfMaterialsConsumed);
  const purchases = num(input.purchasesOfStockInTrade);
  const inventoryDelta = num(input.changesInInventories);

  // ALL THREE must be present. A filer that reports materials but not purchases
  // is not telling us purchases were zero — it is telling us nothing, and
  // summing what we have would understate COGS and overstate the margin.
  if (
    materials === undefined ||
    purchases === undefined ||
    inventoryDelta === undefined
  ) {
    return { reason: "no-input" };
  }

  // `inventoryDelta` is added, not subtracted and not abs()'d — see the tag-map
  // comment in xbrl-financials-logic.ts. Ind-AS signs it as an expense
  // adjustment already.
  const cogs = materials + purchases + inventoryDelta;
  // PERCENT — MONEY-1235. `grossMargin` sits beside `netMargin`, `roe` and
  // `roa` in the schema's Profitability group; those come from `pct()`, which
  // multiplies by 100, and the Fundamentals card renders all four through the
  // same `fmt: "pct"`. Returning 0.35 here printed a 35% gross margin as
  // "0.3%".
  return { value: ((revenue - cogs) / revenue) * 100 };
}

/**
 * Compound annual growth rate over `years` fiscal years.
 *
 * Needs `years + 1` points: a 3-year CAGR compares FY(n) with FY(n−3).
 *
 * Returns `sign-change` when either endpoint is non-positive. CAGR is
 * mathematically undefined across a sign change — `(−50/100)^(1/3)` is complex
 * — and the plausible-looking real number a naive implementation returns is
 * worse than no answer, because a company swinging from loss to profit is
 * exactly the case a growth screen is meant to surface.
 */
export function cagr(
  points: readonly AnnualPoint[],
  years: number,
  field: "revenue" | "netIncome",
): { value?: number; reason?: UnfilledReason } {
  const usable = points
    .map((p) => ({ fyEndYear: p.fyEndYear, v: num(p[field]) }))
    .filter((p): p is { fyEndYear: number; v: number } => p.v !== undefined)
    .sort((a, b) => b.fyEndYear - a.fyEndYear);

  if (usable.length < years + 1) return { reason: "insufficient-history" };

  const latest = usable[0]!;
  // Walk to the point exactly `years` fiscal years back. A gap in the series
  // (a year we never ingested) must not be silently treated as adjacent, or a
  // 5-year CAGR gets computed over 3 years of actual elapsed time.
  const target = usable.find((p) => p.fyEndYear === latest.fyEndYear - years);
  if (target === undefined) return { reason: "insufficient-history" };

  if (latest.v <= 0 || target.v <= 0) return { reason: "sign-change" };
  // PERCENT, not a fraction — MONEY-1235. `revenueGrowth3Y/5Y` and
  // `earningsGrowth3Y/5Y` share a schema group with `revenueGrowth`
  // (`// Growth (YoY %)`), which comes from `growthPct` and is already
  // multiplied by 100, and the Fundamentals card renders all of them through
  // the SAME `fmt: "pct"`. Returning 0.18 here put a true 18%/yr CAGR on screen
  // as "0.2%" beside an 18 from the YoY column — two scales in one column
  // group, silently.
  return { value: (Math.pow(latest.v / target.v, 1 / years) - 1) * 100 };
}

/**
 * P/E ÷ earnings growth.
 *
 * Growth arrives as a PERCENT (18 = 18%) — MONEY-1235.
 *
 * It was documented as a FRACTION and multiplied by 100 here, but the only
 * production caller passes `deriveRatios`' `earningsGrowth`, which comes from
 * `growthPct` and is ALREADY a percent. Measured: `pegRatio(30, 18)` returned
 * 0.0167 where the conventional PEG is 30/18 = 1.667 — a hundredfold low, on a
 * column `packages/core/src/screener/strategies.ts` filters with `pegRatio < 1`
 * and `< 1.5`, so EVERY symbol carrying a PEG passed those screens.
 *
 * Non-positive growth returns `non-positive-growth`. A negative PEG is not
 * "cheap" — it is a category error, and it sorts to the top of a "lowest PEG"
 * screen where it does the most damage.
 */
export function pegRatio(
  pe: number | null | undefined,
  earningsGrowthPercent: number | null | undefined,
): { value?: number; reason?: UnfilledReason } {
  const p = num(pe);
  const g = num(earningsGrowthPercent);
  if (p === undefined || g === undefined) return { reason: "no-input" };
  if (g <= 0) return { reason: "non-positive-growth" };
  if (p <= 0) return { reason: "non-positive-growth" };
  return { value: p / g };
}

/** Minimum paired daily observations before a beta means anything. */
export const BETA_MIN_OBSERVATIONS = 200;

/**
 * A single-day |log return| this large is not a market move — MONEY-1235.
 *
 * `ln(1.5)` ≈ 0.405, i.e. a 50% move in one session. NSE's price bands are
 * 2/5/10/20%; the F&O universe has no band but a genuine 50% single-day move is
 * essentially unheard of without a corporate action. So a surviving return
 * beyond this is a SPLIT/BONUS we have no `corporate_actions` row for.
 *
 * It is deliberately only COUNTED, never winsorized or clipped. Trimming it
 * would silently repair the one signal that says our corporate-action coverage
 * has a hole — and would also swallow a genuine limit-move on a thin counter,
 * which is real data.
 */
export const BETA_EXTREME_LOG_RETURN = Math.log(1.5);

/**
 * `Date` -> `YYYY-MM-DD` in UTC, for a BAR's session key.
 *
 * `ClosePoint.date` is written at UTC midnight by construction
 * (`bhavcopy.ts` `tradingDateUtcMidnight`), so it is a session KEY and UTC is
 * the right rendering.
 *
 * THIS FILE NOW HAS TWO DAY-KEY SPELLINGS, DELIBERATELY. An earlier version of
 * this docstring promised "exactly ONE spelling of a day key in the codebase"
 * and predicted that a mismatch makes "the dropped count read 0". Both claims
 * are retracted: `beta` keys its EXCLUSION list through `exDateDayKey`
 * (MONEY-1527) because an ex-date is an instant and a bar date is not, and the
 * measured symptom of the old mismatch was a HEALTHY count of 1 with a wrecked
 * slope, not a zero. See `exDateDayKey` for both.
 */
function utcDayKey(d: Date | string): string {
  return (
    d instanceof Date ? d.toISOString() : new Date(d).toISOString()
  ).slice(0, 10);
}

/**
 * The ex-date's day key, in IST — MONEY-1527.
 *
 * THE TWO SIDES OF THIS COMPARISON ARE DIFFERENT KINDS OF DATE, and applying
 * one renderer to both is what broke the exclusion. `beta()`'s original design
 * deliberately owned ONE day-key function and applied it to both sides,
 * because two hand-rolled `toISOString().slice(0, 10)`s in two files is how an
 * exclusion set silently matches nothing. That reasoning is right and the
 * conclusion was wrong:
 *
 *   a BAR's date    `DailyPrice.date`, written UTC-MIDNIGHT by construction
 *                   (`bhavcopy.ts` `tradingDateUtcMidnight`). It is a session
 *                   KEY, not an instant, so UTC is the correct rendering and
 *                   `utcDayKey` stays exactly as it is.
 *   an EX-DATE      `CorporateAction.exDate`, a real INSTANT, and prod stores
 *                   it in TWO conventions: 48,224 rows at 18:30Z (IST
 *                   midnight) and 10,863 at 00:00Z. A UTC slice reads the
 *                   first one a calendar day EARLY.
 *
 * So a bar on day D keys `D` while an 18:30Z ex-date keyed `D-1`.
 *
 * READ THE NEXT SENTENCE BEFORE TRIAGING A SUSPECT BETA. The obvious guess is
 * that the exclusion set matched NOTHING and `droppedReturns` read 0. IT DID
 * NOT, and an earlier version of this comment said so wrongly. D-1 is a
 * trading session in the normal case, so the early key landed on a REAL
 * previous bar: the regression discarded THAT day's ordinary return and kept
 * the split's. Measured on the fixture in
 * `ratio-derivations.test.ts` — `droppedReturns` reads **1** either way, and
 * the slope comes out 0.0632 against a clean 0.8000.
 *
 * That matters beyond the comment. `droppedReturns` is published as
 * `betaReturnsDropped` (`xbrl-ratios.ts`), so an operator scanning historical
 * outcomes for `betaReturnsDropped: 0` to find poisoned symbols is looking for
 * a value this defect never produced. The count was healthy and the slope was
 * wrong — which is the harder shape, not the easier one.
 *
 * A 10:1 split therefore injected a roughly -90% log return into the OLS slope
 * against an index that did not move, into a PUBLISHED `stock_ratios.beta`.
 *
 * IST renders BOTH conventions correctly with no branch: 18:30Z is IST
 * midnight of the same day, 00:00Z is 05:30 IST of the same day. Identical
 * reasoning to `corp-action-logic.ts`'s `istDateKey` (MONEY-1516), and this
 * one can IMPORT the canonical `toIstDateKey` rather than mirror it, because
 * both live in `packages/core`.
 */
function exDateDayKey(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  // THROWS, as `utcDayKey` did. `toIstDateKey` has no validity guard and
  // renders an Invalid Date as the literal "NaN-NaN-NaN" — a well-formed
  // string that matches no bar, so every malformed entry would collapse to one
  // key, the exclusion would silently no-op, and a split's return would reach
  // a published beta. That is precisely the symptom this function exists to
  // end, re-created by a renderer that does not throw.
  //
  // `BetaOptions.excludeReturnDates` is `ReadonlyArray<Date | string>`, so the
  // string arm reaches here without a Date at all (`new Date("2022-07-28 IST")`
  // is Invalid in V8), and `beta` is exported from `packages/core`. Today's
  // only producer guards with `Number.isFinite`; the type invites one that
  // does not.
  // TEST THE RENDERED KEY, not just the instant. `Number.isFinite(getTime())`
  // is TRUE for a year under 1000, and `toIstDateKey` does not zero-pad the
  // year — it renders "999-06-15", a well-formed string that parses back to
  // NaN and matches no bar. That is the silent no-op this guard exists to end,
  // reached through the one input the instant check cannot see. The sibling
  // written in the same change, `isRenderableExDate` in the marks route, tests
  // the key for exactly this reason.
  const key = toIstDateKey(date);
  if (!Number.isFinite(Date.parse(`${key}T00:00:00.000Z`))) {
    throw new RangeError(
      `beta: excludeReturnDates contains an unusable date (${String(d)} -> ` +
        `"${key}") — a silent miss here puts a split's return into a ` +
        `published beta`,
    );
  }
  return key;
}

/** Extra knobs for {@link beta}. All optional; absent = the old behaviour. */
export interface BetaOptions {
  /**
   * Days whose daily return must be DROPPED — raw dates, not pre-keyed
   * strings; see {@link utcDayKey}.
   *
   * ## Why dropping, and not adjusting (MONEY-1235)
   *
   * `beta` regresses `DailyPrice.close`, and per MONEY-1175 that column is
   * mixed-authority: bhavcopy closes are stored RAW (unadjusted) while Yahoo's
   * are split-ADJUSTED. One 1:2 split inside the window therefore injects a
   * ~ln(2) = -0.69 fake daily return into the OLS slope on the ex-date, on the
   * stock side only, against an index that did not move.
   *
   * The obvious repair — read `DailyPrice.adjClose` instead — IS NOT
   * AVAILABLE. Measured on prod 2026-08-21: `adjClose` is populated on **0 of
   * 10,615,160** rows. The column is declared (`adjClose Float?`) and exactly
   * one writer ever sets it (`yahoo-price-service.ts`, three call sites, all
   * `source: "YAHOO"`), and after MONEY-1175 made BHAVCOPY (100) strictly
   * outrank YAHOO (10) the exchange rows own the series. So an
   * `adjClose ?? close` fallback degenerates to `close` for every row — and if
   * it ever did NOT, it would be worse than raw: a per-row fallback mixes two
   * price SCALES inside one series and manufactures a jump at every
   * source flip, not just at splits.
   *
   * Dropping the affected RETURN rescales nothing and cannot corrupt a genuine
   * observation. It costs one datum out of ~490.
   */
  excludeReturnDates?: ReadonlyArray<Date | string>;
}

/**
 * What {@link beta} measured, beyond the slope itself.
 *
 * The counts are always present — including on a refusal — so a caller can
 * report "beta unfilled, 0 observations after 2 drops" rather than a bare null.
 * Absence of a count is exactly the silence MONEY-1189 kept finding.
 */
export interface BetaResult {
  value?: number;
  reason?: UnfilledReason;
  /** Paired returns discarded because a qty-changing ex-date sits on them. */
  droppedReturns: number;
  /**
   * Returns that SURVIVED the drop and still exceed
   * {@link BETA_EXTREME_LOG_RETURN}. A non-zero count on an instrument with no
   * excluded dates means our `corporate_actions` coverage missed an action.
   */
  extremeReturns: number;
  /** Paired returns actually fed to the regression, after drops. */
  observations: number;
}

/**
 * OLS slope of the stock's daily log-returns against the index's.
 *
 * Log returns, not simple returns: they are additive across time and symmetric
 * in sign, so a −50%/+100% round trip does not read as net positive drift.
 *
 * Requires {@link BETA_MIN_OBSERVATIONS} paired days, counted AFTER
 * {@link BetaOptions.excludeReturnDates} drops — the floor exists to stop a
 * handful of moves dominating the slope, and a dropped day is a move the
 * regression never saw.
 */
export function beta(
  stock: readonly ClosePoint[],
  index: readonly ClosePoint[],
  opts: BetaOptions = {},
): BetaResult {
  // UTC, and it MUST STAY UTC — see `exDateDayKey`. `ClosePoint.date` is a
  // session KEY written at UTC midnight, not an instant.
  //
  // A mutation swapping this to the IST renderer SURVIVES the suite, and that
  // is a property of the contract rather than a hole in the tests: IST renders
  // a UTC-midnight input to the same calendar day, so on every date this
  // function can actually be handed the two renderers agree. The guard is
  // therefore the CALLER's contract — bars arrive UTC-midnight — and the day
  // that stops being true (an intraday `ClosePoint`, a vendor writing 20:00Z)
  // this line silently starts reading the next day. Pin the contract at the
  // producer, not here.
  const key = utcDayKey;

  const byDay = new Map<string, number>();
  for (const p of index) {
    if (num(p.close) !== undefined && p.close > 0)
      byDay.set(key(p.date), p.close);
  }

  const paired: Array<{ day: string; s: number; i: number }> = [];
  for (const p of stock) {
    if (num(p.close) === undefined || p.close <= 0) continue;
    const day = key(p.date);
    const i = byDay.get(day);
    if (i !== undefined) paired.push({ day, s: p.close, i });
  }
  paired.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const rs: number[] = [];
  const ri: number[] = [];
  let droppedReturns = 0;
  let extremeReturns = 0;
  // `exDateDayKey`, NOT `key` — the two sides are different kinds of date.
  // See the function's header; using `key` here is the MONEY-1527 defect.
  const exclude = new Set<string>(
    (opts.excludeReturnDates ?? []).map((d) => exDateDayKey(d)),
  );
  for (let k = 1; k < paired.length; k++) {
    const prev = paired[k - 1]!;
    const cur = paired[k]!;
    // The return is attributed to the LATER day. A 1:2 split with ex-date D
    // prints post-split on D and pre-split on D-1, so it is exactly this
    // return — the one whose `cur` is D — that carries the fake jump.
    if (exclude.has(cur.day)) {
      droppedReturns++;
      continue;
    }
    const s = Math.log(cur.s / prev.s);
    if (Math.abs(s) > BETA_EXTREME_LOG_RETURN) extremeReturns++;
    rs.push(s);
    ri.push(Math.log(cur.i / prev.i));
  }

  if (rs.length < BETA_MIN_OBSERVATIONS) {
    return {
      reason: "insufficient-observations",
      droppedReturns,
      extremeReturns,
      observations: rs.length,
    };
  }

  const n = rs.length;
  const meanS = rs.reduce((a, b) => a + b, 0) / n;
  const meanI = ri.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varI = 0;
  for (let k = 0; k < n; k++) {
    const di = ri[k]! - meanI;
    cov += (rs[k]! - meanS) * di;
    varI += di * di;
  }
  // A suspended index series (every close identical) has zero variance; the
  // slope would be 0/0. Report it rather than emitting NaN into a Float column.
  if (varI === 0) {
    return {
      reason: "zero-variance",
      droppedReturns,
      extremeReturns,
      observations: n,
    };
  }
  return {
    value: cov / varI,
    droppedReturns,
    extremeReturns,
    observations: n,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The bundle the ratios job writes
// ═══════════════════════════════════════════════════════════════════════════

/** Every column this module owns. Mirrors the StockRatios field names. */
export const EXTENDED_RATIO_COLUMNS = [
  "currentRatio",
  "grossMargin",
  "revenueGrowth3Y",
  "revenueGrowth5Y",
  "earningsGrowth3Y",
  "earningsGrowth5Y",
  "pegRatio",
  "beta",
] as const;

export type ExtendedRatioColumn = (typeof EXTENDED_RATIO_COLUMNS)[number];

export interface ExtendedRatioInputs {
  /** Newest first or oldest first — sorted internally. */
  annuals: readonly AnnualPoint[];
  latestAnnualIncome?: GrossMarginInput;
  latestBalanceSheet?: CurrentRatioInput;
  family: XbrlFamily;
  /** Already-derived P/E, so PEG does not recompute it from a second source. */
  pe?: number | null;
  /** Already-derived YoY earnings growth, as a FRACTION. */
  earningsGrowth?: number | null;
  stockCloses?: readonly ClosePoint[];
  indexCloses?: readonly ClosePoint[];
  /**
   * MONEY-1235 — ex-dates of qty-changing corporate actions (SPLIT / BONUS /
   * DEMERGER) inside the beta window. Their daily return is DROPPED rather
   * than adjusted; see {@link BetaOptions.excludeReturnDates} for why no
   * adjusted-close route exists.
   */
  betaExcludeDates?: ReadonlyArray<Date | string>;
}

export interface ExtendedRatios {
  values: Partial<Record<ExtendedRatioColumn, number>>;
  /** Every column left unfilled, with why. Measured, never silent. */
  unfilled: Partial<Record<ExtendedRatioColumn, UnfilledReason>>;
  /**
   * What the beta regression actually saw — MONEY-1235.
   *
   * Optional on the TYPE only so a hand-built `ExtendedRatios` in a test stays
   * valid; {@link deriveExtendedRatios} always fills it. A beta that is unfilled
   * because 490 observations became 2 after drops, and one unfilled because the
   * instrument listed last month, are different problems with the same null.
   */
  betaDiagnostics?: {
    droppedReturns: number;
    extremeReturns: number;
    observations: number;
  };
}

/**
 * Compute all eight. A column appears in exactly one of `values` or `unfilled`.
 *
 * The caller writes only `values`; `unfilled` exists so a run can report "gross
 * margin is null for 4,100 symbols because 3,900 are lenders and 200 filed no
 * cost lines" instead of a bare count of nulls.
 */
export function deriveExtendedRatios(
  input: ExtendedRatioInputs,
): ExtendedRatios {
  const values: Partial<Record<ExtendedRatioColumn, number>> = {};
  const unfilled: Partial<Record<ExtendedRatioColumn, UnfilledReason>> = {};

  const put = (
    col: ExtendedRatioColumn,
    r: { value?: number; reason?: UnfilledReason },
  ): void => {
    if (r.value !== undefined && Number.isFinite(r.value))
      values[col] = r.value;
    else unfilled[col] = r.reason ?? "no-input";
  };

  put(
    "currentRatio",
    input.latestBalanceSheet
      ? currentRatio(input.latestBalanceSheet)
      : { reason: "no-input" },
  );
  put(
    "grossMargin",
    input.latestAnnualIncome
      ? grossMargin(input.latestAnnualIncome, input.family)
      : input.family === "banking" || input.family === "nbfc"
        ? { reason: "lender-has-no-cogs" }
        : { reason: "no-input" },
  );

  put("revenueGrowth3Y", cagr(input.annuals, 3, "revenue"));
  put("revenueGrowth5Y", cagr(input.annuals, 5, "revenue"));
  put("earningsGrowth3Y", cagr(input.annuals, 3, "netIncome"));
  put("earningsGrowth5Y", cagr(input.annuals, 5, "netIncome"));

  put("pegRatio", pegRatio(input.pe, input.earningsGrowth));

  const betaResult: BetaResult =
    input.stockCloses && input.indexCloses
      ? beta(input.stockCloses, input.indexCloses, {
          excludeReturnDates: input.betaExcludeDates,
        })
      : {
          reason: "no-input",
          droppedReturns: 0,
          extremeReturns: 0,
          observations: 0,
        };
  put("beta", betaResult);

  return {
    values,
    unfilled,
    betaDiagnostics: {
      droppedReturns: betaResult.droppedReturns,
      extremeReturns: betaResult.extremeReturns,
      observations: betaResult.observations,
    },
  };
}
