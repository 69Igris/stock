/**
 * Plan a `StockRatios` write from XBRL — MONEY-1115 item 2.
 *
 * Pure. The caller does every join (filings, price, dividends) and every write;
 * this decides WHAT the row should contain and, more importantly, what it must
 * NOT contain.
 *
 * ## Why this is a planner and not a writer
 *
 * `StockRatios` is `@@unique([symbol, exchange])` — ONE row per symbol, no
 * period dimension — and `instrumentId` is `@unique` on top of that. So an
 * XBRL write does not add a row beside Tickertape's, it REPLACES the symbol's
 * entire ratio set. That is a much larger blast radius than `StockFinancials`,
 * where a period key confines a bad write to one cell, and it is why the
 * authority check belongs at the write site and the field selection belongs
 * here where it can be tested.
 *
 * ## Columns this deliberately never fills
 *
 * A `StockRatios` column left absent keeps whatever the incumbent source put
 * there. That is the correct outcome for anything XBRL cannot honestly derive:
 *
 * - **`grossMargin`** — no COGS concept exists in the taxonomy. The closest,
 *   `totalExpenses`, includes finance costs, depreciation and employee benefit
 *   expense, so `1 - totalExpenses/revenue` is an operating margin under
 *   another name.
 * - **`beta`, `targetPrice`, `recommendation`, `pegRatio`** — market/analyst
 *   figures with no filing-side equivalent. PEG needs a forward growth estimate,
 *   which is a forecast, not a disclosure.
 * - **`currentRatio`** — needs current assets AND current liabilities; both are
 *   balance-sheet concepts absent from quarterly filings, and a ratio built from
 *   one present and one absent leg is not a ratio.
 * - **the 3Y/5Y growth columns** — need a multi-year annual series that does not
 *   exist until the MONEY-1114 backfill lands.
 *
 * Filling any of these with a lookalike would be worse than leaving Tickertape's
 * value in place, because the row's `source` would then claim NSE_XBRL for a
 * number no filing supports.
 */

import type { DerivedRatios } from "./xbrl-projection";
import type { ValuationRatios } from "./xbrl-valuation";
import {
  EXTENDED_RATIO_COLUMNS,
  type ExtendedRatios,
} from "./ratio-derivations";

/** The `StockRatios` columns an XBRL-derived write is allowed to touch. */
export const XBRL_OWNED_RATIO_COLUMNS = [
  "pe",
  "pb",
  "evToEbitda",
  "roe",
  "roa",
  // The DENOMINATOR the two above used — MONEY-1250. Owned because it is
  // meaningless without them: a row carrying roe from one basis and a stamp
  // from another is worse than no stamp, so they move together.
  "returnBasis",
  "roce",
  "operatingMargin",
  "netMargin",
  "revenueGrowth",
  "earningsGrowth",
  "debtToEquity",
  "interestCoverage",
  "dividendYield",
  "marketCap",
  "enterpriseValue",
  // ── MONEY-1220: eight columns promoted out of UNOWNED ────────────────────
  //
  // These were never "XBRL cannot supply them". They needed inputs the first
  // pass did not gather: multi-year history (the CAGRs), a balance sheet (the
  // current ratio), an expense breakdown (gross margin — three tags that were
  // in 11 of our 18 fixtures but unmapped), and a price series (beta).
  // `ratio-derivations.ts` computes all eight; the ratios job feeds it.
  "currentRatio",
  "grossMargin",
  "revenueGrowth3Y",
  "revenueGrowth5Y",
  "earningsGrowth3Y",
  "earningsGrowth5Y",
  "pegRatio",
  "beta",
  // Computed by `deriveRatios` since MONEY-1115 with nowhere to go; the
  // columns land with this change.
  "ebitdaMargin",
  "assetTurnover",
] as const;

export type XbrlRatioColumn = (typeof XBRL_OWNED_RATIO_COLUMNS)[number];

/**
 * Columns that exist on `StockRatios` and are deliberately NOT owned here.
 * Named explicitly so that adding one to the model without deciding its
 * provenance is a visible omission rather than a silent gap — the same reason
 * `ownedFields` exists on the financials side.
 */
export const XBRL_UNOWNED_RATIO_COLUMNS = [
  // Sell-side ANALYST OPINION. Not in any filing, not in any price series,
  // not reproducible from primary data. Left null by decision (MONEY-1220)
  // rather than sourced from a scraper — a number a reader cannot trace to a
  // filing id does not belong beside 26 that they can.
  "targetPrice",
  "recommendation",
] as const;

export interface RatiosWritePlan {
  /**
   * Only the columns with a real value. Absent ⇒ incumbent survives.
   *
   * Every column is a `number` EXCEPT `returnBasis`, which is the denominator
   * STAMP for `roe`/`roa` rather than a measurement — MONEY-1250.
   */
  set: Partial<Record<XbrlRatioColumn, number | "AVERAGE" | "CLOSING">>;
  /** Every owned column left unfilled, with why. Measured, never silent. */
  unfilled: Array<{ column: XbrlRatioColumn; reason: string }>;
  /**
   * Numbers the engine COMPUTED for which `StockRatios` has no column.
   *
   * Surfaced rather than dropped so the mismatch is visible — adding a column
   * is a schema decision, not a producer one.
   *
   * ## It is DERIVED now, not hand-listed — MONEY-1238
   *
   * This field was named for `ebitdaMargin` and `assetTurnover`, MONEY-1220
   * gave both of them columns, and the array was then declared, returned empty
   * on every call, and read by nothing. A mechanism with neither a producer nor
   * a reader does not detect the next mismatch; it only documents that somebody
   * once meant to.
   *
   * So it is computed from the inputs against
   * {@link XBRL_OWNED_RATIO_COLUMNS}: every finite number `deriveRatios` or
   * `deriveValuation` produced whose key is not an owned column. That is not a
   * hypothetical set. `deriveRatios` passes through `grossNpaRatio`,
   * `netNpaRatio` and `cet1Ratio` — disclosed RBI Form-A figures, computed on
   * every lender filing, with nowhere on `StockRatios` to put them. The old
   * hand-maintained list could never have said so, because it was written
   * before those three existed and nothing re-derives a literal.
   */
  computedButUnstorable: Array<{ name: string; value: number }>;
}

/**
 * Build the write plan.
 *
 * `undefined` is the only absence. A column is set when the engine produced a
 * finite number and omitted otherwise — never coerced to 0, which on this table
 * would read as "this company has zero return on equity" rather than "we could
 * not compute it".
 */
/**
 * Which period the ratios were derived from. REQUIRED — it changes what may be
 * written, and there is no safe default.
 */
export type RatioPeriodType =
  | "ANNUAL"
  | "QUARTERLY"
  | "NINE_MONTH"
  | "HALF_YEARLY";

/**
 * Ratios that divide a FLOW by a STOCK, and are therefore period-dependent.
 *
 * Margins are ratios of two flows from the same period and are period-invariant
 * — 12% net margin is 12% whether a quarter or a year produced it. These are
 * not: one period's profit over a balance-sheet quantity, so a quarterly value
 * is roughly a quarter of the annual one.
 *
 * `deriveRatios` states the hazard and hands it to the caller: *"ROE/ROA on a
 * QUARTERLY filing is a quarterly return, NOT an annual one. Deliberately not
 * annualised here… The caller annualises if it wants to, knowingly."* This
 * planner IS that caller, so "knowingly" means being told the period.
 *
 * Measured, same symbol both sides: the GLAXO Q2-FY25 fixture derives
 * `roce = 20.1`; prod `StockRatios.GLAXO` holds the annual `roce = 57.25`
 * (`roe = 49.75`). Writing the quarterly value drops GLAXO, INFY (36.2 → ~9)
 * and CIPLA (21.6 → ~5) out of a "ROCE > 20%" screen — irreversibly, because
 * `NSE_XBRL` OUTRANKS `TICKERTAPE` in `FINANCIALS_AUTHORITY`.
 *
 * The growth pair is here for a different reason: the column's incumbent is
 * Tickertape's ANNUAL growth (`revGrwAn`), while `deriveRatios` produces
 * quarter-on-same-quarter-last-year. Same column, different measure, and no
 * discriminator is stored alongside.
 */
const PERIOD_DEPENDENT_COLUMNS = new Set<XbrlRatioColumn>([
  "roe",
  "roa",
  "roce",
  "revenueGrowth",
  "earningsGrowth",
  // `pegRatio` is P/E divided by `earningsGrowth` — the very number one line
  // above, which this set refuses on a non-annual filing. Without it the job
  // declined to write the growth figure because a quarter-on-quarter measure is
  // the wrong one, and then wrote a PEG derived from exactly that figure
  // (MONEY-1235). `earningsGrowth3Y/5Y` are deliberately NOT here: they are
  // CAGRs over the ANNUAL series and do not depend on the latest filing's
  // period.
  //
  // THIS COMMENT USED TO SAY "for a March-year-end filer that is the common
  // case from April to August" — i.e. a seasonal window worth tolerating. It is
  // not seasonal. Measured on prod 2026-09-13, the newest filing is QUARTERLY
  // for **2,504 of 2,607 symbols (96.0%)**: a March-FY company files its annual
  // in May and then Q1 in August, Q2 in November and Q3 in February, so the
  // annual is newest only for the few weeks between results. Ten months of
  // every year, not five.
  //
  // The refusal below is still RIGHT — a quarter-on-quarter growth figure does
  // not belong in a column whose incumbent is annual. What was wrong was the
  // CALLER, which handed this planner a quarterly filing while an annual sat
  // loaded and unused beside it (MONEY-1401, `xbrl-ratios.ts` `deriveOne`).
  "pegRatio",
  // `assetTurnover` is `revenue / average totalAssets` — the definition at the
  // top of this comment, verbatim: a FLOW over a STOCK. It was missing from
  // this set while `roe` and `roa`, which share its exact shape, were in it
  // (MONEY-1239).
  //
  // It is reachable on a non-annual filing, and the reachable case is the worst
  // one. `deriveRatios` computes it only when the CURRENT filing carries a
  // balance sheet and a prior filing does too — and the current filing that
  // carries one is the HALF-YEARLY, which SEBI mandates a balance sheet for and
  // which the ratios job passes here as "QUARTERLY"
  // (`latest.periodType === "ANNUAL" ? "ANNUAL" : "QUARTERLY"`). So the value
  // that lands is six months of revenue over a full-year asset base: HALF the
  // annual turnover, in a column whose incumbent is the annual figure, with
  // nothing stored to say which measure it is.
  "assetTurnover",
]);

export function planRatiosWrite(
  ratios: DerivedRatios,
  valuation: ValuationRatios,
  periodType: RatioPeriodType,
  /**
   * The eight history/price-derived columns from `ratio-derivations.ts`
   * (MONEY-1220). Optional so a caller with only a single filing in hand still
   * gets a valid plan — those columns then report their own reason ("no
   * extended derivations supplied") instead of vanishing from the accounting.
   */
  extended?: ExtendedRatios,
): RatiosWritePlan {
  // `number` for every column EXCEPT `returnBasis`, which is the denominator
  // STAMP rather than a measurement — MONEY-1250. Typed as the union rather
  // than widened to `unknown` so a numeric column cannot accidentally take a
  // string, and vice versa.
  const set: Partial<Record<XbrlRatioColumn, number | "AVERAGE" | "CLOSING">> =
    {};
  const unfilled: RatiosWritePlan["unfilled"] = [];
  const computedButUnstorable: RatiosWritePlan["computedButUnstorable"] = [];

  const put = (col: XbrlRatioColumn, v: number | undefined, reason: string) => {
    if (periodType !== "ANNUAL" && PERIOD_DEPENDENT_COLUMNS.has(col)) {
      unfilled.push({
        column: col,
        reason: `refused: ${periodType} filing, and this column's incumbent is annual`,
      });
      return;
    }
    if (typeof v === "number" && Number.isFinite(v)) set[col] = v;
    else unfilled.push({ column: col, reason });
  };

  put("roe", ratios.roe, "no netIncome or totalEquity");
  put("roa", ratios.roa, "no netIncome or totalAssets");
  // Written ONLY when a return was actually derived — MONEY-1250. `put` takes
  // finite numbers and this is the one owned column that is a string, so it is
  // set directly. Stamping a basis with no ratio beside it would assert a
  // derivation that did not happen.
  if (
    ratios.returnBasis !== undefined &&
    (typeof ratios.roe === "number" || typeof ratios.roa === "number")
  ) {
    set.returnBasis = ratios.returnBasis;
  } else {
    // Owned columns are filled OR carry a reason — never silently absent. The
    // guard that enforces that is the whole point of `unfilled`.
    unfilled.push({
      column: "returnBasis",
      reason: "no roe or roa was derived, so there is no denominator to stamp",
    });
  }
  put(
    "roce",
    ratios.roce,
    "no EBIT or capital employed (needs a balance sheet)",
  );
  put(
    "operatingMargin",
    ratios.operatingMargin,
    "no operatingIncome or revenue",
  );
  put("netMargin", ratios.netMargin, "no netIncome or revenue");
  put("debtToEquity", ratios.debtToEquity, "no totalDebt or totalEquity");
  put(
    "interestCoverage",
    ratios.interestCoverage,
    "no EBIT, or zero finance cost",
  );
  put("revenueGrowth", ratios.revenueGrowth, "no prior-year filing supplied");
  put("earningsGrowth", ratios.earningsGrowth, "no prior-year filing supplied");

  put("pe", valuation.pe, "no price or positive TTM EPS");
  put(
    "pb",
    valuation.pb,
    "no price or positive book value (needs a balance sheet)",
  );
  put("evToEbitda", valuation.evToEbitda, "no positive EV or TTM EBITDA");
  put(
    "dividendYield",
    valuation.dividendYield,
    "no price, or dividend amount unknown",
  );
  put("marketCap", valuation.marketCap, "no price or share count");
  put(
    "enterpriseValue",
    valuation.enterpriseValue,
    "no market cap, or neither debt nor cash reported",
  );

  // ── The two the engine always computed but could not store ───────────────
  // MONEY-1220 gave them columns; they are ordinary owned fields now, and
  // `computedButUnstorable` is the mechanism for the NEXT such mismatch —
  // derived below rather than hand-listed, because a literal cannot notice a
  // field added after it was written (MONEY-1238).
  put("ebitdaMargin", ratios.ebitdaMargin, "no EBITDA or revenue");
  put("assetTurnover", ratios.assetTurnover, "no revenue or totalAssets");

  // ── The eight promoted out of UNOWNED ────────────────────────────────────
  // Each carries the derivation's OWN reason rather than a generic one, so a
  // run can say "gross margin null for 3,900 lenders" instead of a bare count.
  for (const col of EXTENDED_RATIO_COLUMNS) {
    put(
      col,
      extended?.values[col],
      extended === undefined
        ? "no extended derivations supplied"
        : (extended.unfilled[col] ?? "no-input"),
    );
  }

  // ── What the engine produced that this table cannot hold — MONEY-1238 ────
  //
  // Read off the INPUTS, not off a literal, so a derivation gaining a field is
  // reported the first time it fires instead of the first time somebody
  // remembers to update a list. Both objects are flat `Partial<Record<string,
  // number>>` shapes, so one walk covers them.
  //
  // Order is `ratios` then `valuation`, and each is walked in declaration
  // order, so the list is deterministic for a given input — a run-to-run
  // diffable line rather than whatever key order an engine happened to use.
  const ownedRatioColumns = new Set<string>(XBRL_OWNED_RATIO_COLUMNS);
  for (const source of [ratios, valuation] as unknown as ReadonlyArray<
    Record<string, unknown>
  >) {
    for (const [name, value] of Object.entries(source)) {
      if (ownedRatioColumns.has(name)) continue;
      // A non-finite or absent value was never computed, so it is not a
      // storage gap — it is the ordinary absence every ratio here can have.
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      computedButUnstorable.push({ name, value });
    }
  }

  return { set, unfilled, computedButUnstorable };
}

/**
 * Whether a plan is worth writing.
 *
 * An XBRL write REPLACES the symbol's whole ratio row and stamps it
 * `NSE_XBRL`. A plan carrying one or two fields would therefore trade a
 * populated Tickertape row for a nearly-empty one that claims a better source —
 * strictly worse than not writing. The floor is deliberately expressed in terms
 * of PROFITABILITY fields rather than a raw count: fifteen valuation fields
 * derived from a price with no filing behind them is not a filing-sourced row.
 */
export function isPlanWorthWriting(plan: RatiosWritePlan): {
  write: boolean;
  reason: string;
} {
  const core: XbrlRatioColumn[] = [
    "netMargin",
    "roe",
    "roa",
    "operatingMargin",
  ];
  const haveCore = core.filter((c) => plan.set[c] !== undefined).length;
  if (haveCore === 0) {
    return {
      write: false,
      reason:
        "no profitability ratio could be derived — writing would replace a " +
        "populated Tickertape row with an emptier one stamped NSE_XBRL",
    };
  }
  // The floor counts FILING-DERIVED fields, not the total.
  //
  // An earlier version required `total >= 3` alongside `haveCore >= 1`, which
  // admitted exactly the shape this function's doc disclaims: one margin from
  // the filing plus five fields computed from a market price cleared the bar
  // and re-stamped the row NSE_XBRL. Valuation fields answer "what is the
  // market paying", not "what did the company file", so counting them toward a
  // filing-provenance floor answers a different question than the one asked.
  //
  // `beta` joined that list in MONEY-1239, and it is the same defect arriving
  // by the door the fix left open. The test is PROVENANCE — "did a filing
  // produce this number" — not the schema's "Market" heading, and `beta` is an
  // OLS slope of `DailyPrice.close` against an index over ~490 sessions. There
  // is no filing input anywhere in it. It was promoted out of
  // `XBRL_UNOWNED_RATIO_COLUMNS` by MONEY-1220 without being added here, so it
  // silently counted as evidence that a FILING backed the row: one margin plus
  // `beta` plus one more cleared a floor that two filing-derived numbers alone
  // would not, and re-stamped the whole `StockRatios` row `NSE_XBRL`.
  //
  // `pegRatio` is deliberately NOT here. It is a hybrid (P/E ÷ earningsGrowth)
  // and it is unreachable without `earningsGrowth`, which is itself
  // filing-derived and lands in `set` alongside it — so it never carries the
  // floor on its own the way `beta` can.
  const MARKET_DERIVED = new Set<string>([
    "pe",
    "pb",
    "evToEbitda",
    "dividendYield",
    "marketCap",
    "enterpriseValue",
    "beta",
  ]);
  const keys = Object.keys(plan.set);
  const fromFiling = keys.filter((k) => !MARKET_DERIVED.has(k));
  if (fromFiling.length < 3) {
    return {
      write: false,
      reason:
        `only ${fromFiling.length} filing-derived field(s); floor is 3 ` +
        `(${keys.length - fromFiling.length} valuation field(s) excluded — ` +
        "they come from a price, not the filing)",
    };
  }
  return {
    write: true,
    reason: `${fromFiling.length} filing-derived field(s), ${haveCore} core`,
  };
}
