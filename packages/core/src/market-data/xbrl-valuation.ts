/**
 * Valuation ratios — the leg of MONEY-1115 that leaves the filing.
 *
 * Every other ratio in `xbrl-projection.ts` is computed from ONE document.
 * These four cannot be: they need a market price, a share count and a dividend
 * history, from three different tables. Keeping them here makes that boundary
 * explicit — this module is pure, and the caller does the joins.
 *
 * ## Share count is DERIVED, and the derivation is the fragile part
 *
 * The taxonomy publishes `paidUpEquityShareCapital` (rupees) and
 * `faceValuePerShare` (rupees/share), not a share count. Shares are
 * `paidUpCapital / faceValue`. Measured on prod 2026-08-18: both concepts are
 * present on **2,152 of 2,152** stored filings, so this route works for the
 * whole set — but it is arithmetic on two reported figures, not a reported
 * figure, and it is wrong the moment either is restated without the other.
 *
 * The fallback, `profitForPeriod / basicEps`, is deliberately marked
 * `estimated` when used. It disagrees with the paid-up route whenever EPS is
 * computed on a weighted-average count (which is the norm) rather than the
 * closing count, and that difference is real, not noise.
 *
 * ## What this module refuses
 *
 * Indian QUARTERLY filings carry a P&L but no balance sheet — SEBI mandates one
 * half-yearly and annually. Measured: `totalEquity` appears on **29 of 2,152**
 * stored filings. So P/B and EV/EBITDA are structurally unavailable from
 * quarterly data and MUST come from an annual filing. Rather than fall back to
 * a stale or interpolated equity figure, they are simply not returned. A missing
 * ratio is recoverable; a P/B computed off last year's book value is a wrong
 * number that looks right.
 */

import {
  rupeesToCrores,
  type RatioInputs,
  type XbrlConcept,
} from "./xbrl-financials-logic";

/** Finite-only read. `0` is a real value; NaN/Infinity are not. */
function num(
  values: Partial<Record<XbrlConcept, number>>,
  key: XbrlConcept,
): number | undefined {
  const v = values[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Divide, refusing every degenerate case. Same contract as `xbrl-projection`'s
 * private `ratio()` — duplicated deliberately rather than exported from there,
 * because widening that module's surface to share a three-line guard invites
 * the next caller to reach for its internals too.
 */
function safeRatio(
  numerator: number | undefined,
  denominator: number | undefined,
  opts?: { allowNegativeNumerator?: boolean },
): number | undefined {
  if (numerator === undefined || denominator === undefined) return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return undefined;
  }
  if (denominator <= 0) return undefined;
  if (numerator < 0 && opts?.allowNegativeNumerator !== true) return undefined;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : undefined;
}

export interface ShareCount {
  shares: number;
  /**
   * `paid-up` — `paidUpEquityShareCapital / faceValuePerShare`, the reported
   * route. `eps-implied` — `profitForPeriod / basicEps`, a fallback that
   * disagrees with the reported route whenever EPS uses a weighted-average
   * count. A caller that stores a valuation ratio should store this alongside.
   */
  basis: "paid-up" | "eps-implied";
}

/**
 * Shares outstanding from one filing.
 *
 * Returns `null` rather than guessing. A zero or negative face value is refused
 * outright: it is not a company with free shares, it is a bad parse, and
 * dividing by it produces an Infinity that would top every market-cap ranking.
 */
/**
 * `RatioInputs`, not `XbrlFinancials` — MONEY-1346. Only `values` is read;
 * `XbrlFinancials` stays assignable, so no existing call site moves.
 */
export function deriveShareCount(f: RatioInputs): ShareCount | null {
  const v = f.values;

  const paidUp = num(v, "paidUpEquityShareCapital");
  const faceValue = num(v, "faceValuePerShare");
  const fromPaidUp = safeRatio(paidUp, faceValue);
  if (fromPaidUp !== undefined && fromPaidUp > 0) {
    return { shares: fromPaidUp, basis: "paid-up" };
  }

  // EPS can legitimately be negative (a loss). The implied count cannot be, so
  // a negative profit with a negative EPS still yields a positive count — which
  // is why the numerator guard is relaxed here and the RESULT is checked.
  const profit = num(v, "profitForPeriod");
  const eps = num(v, "basicEps");
  if (profit !== undefined && eps !== undefined && eps !== 0) {
    const implied = profit / eps;
    if (Number.isFinite(implied) && implied > 0) {
      return { shares: implied, basis: "eps-implied" };
    }
  }

  return null;
}

/**
 * What the caller must join in for a valuation. Any field may be absent.
 *
 * ## UNITS — every money field here is ABSOLUTE RUPEES
 *
 * Stated because mixing scales inside one addition is silent: enterprise value
 * is `marketCap + debt - cash`, so a caller sourcing `totalDebt` from
 * `StockFinancials` (which stores CRORE) while `price` is rupees produces an EV
 * wrong by a factor of ten million, in a number that still looks like a number.
 *
 * XBRL facts are already absolute rupees, so a caller reading straight from
 * `XbrlFinancials.values` needs no conversion. A caller reading from
 * `StockFinancials`/`ProjectedFinancials` MUST multiply by `RUPEES_PER_CRORE`
 * first. The OUTPUT is converted back to crore by {@link deriveValuation} —
 * see its unit note.
 */
export interface ValuationInputs {
  /**
   * The CURRENT close, in RUPEES — the latest one the caller holds, not the
   * close at the filing's period end.
   *
   * This doc used to say "close at (or nearest at-or-before) the period end",
   * which no caller has ever honoured: the ratios job passes today's
   * `DailyPrice.close` (MONEY-1235). The BEHAVIOUR is right and the doc was
   * wrong — a P/E is what the market is paying TODAY for trailing earnings, so
   * pricing it at a period end six months gone would answer a question nobody
   * asked and would freeze between filings. `StockRatios.ratiosPriceDate`
   * records which close was used, which is only meaningful under this reading.
   *
   * The distinction is not cosmetic: `deriveValuation` is also reachable from
   * a backfill or a reconcile, and a reader who took the old sentence literally
   * would join a historical close to a current TTM and get a ratio that matches
   * neither clock.
   */
  price?: number;
  /** A share COUNT, not a money value. */
  shares?: number;
  /** Trailing-twelve-month EPS in RUPEES per share — from `deriveTtm`. */
  ttmEps?: number;
  /** Trailing-twelve-month EBITDA in absolute RUPEES. */
  ttmEbitda?: number;
  /** Book value: total equity from an ANNUAL balance sheet, absolute RUPEES. */
  totalEquity?: number;
  /** Total borrowings in absolute RUPEES. */
  totalDebt?: number;
  /** Cash and equivalents in absolute RUPEES. */
  totalCash?: number;
  /** Sum of `dividendPerShare` over the trailing twelve months, in RUPEES. */
  ttmDividendPerShare?: number;
}

export interface ValuationRatios {
  /**
   * ₹ CRORE, not rupees — `StockRatios.marketCap`'s unit, confirmed by
   * `screener.ts`'s `marketCap: number | null; // crores`, by
   * `scan-filters.ts`, and by `formatMarketCapCrores(valueInCrores)`. Prod
   * values sit in the 4.8 → 1.87e6 band.
   *
   * The conversion happens HERE rather than at the write site because the ratio
   * outputs (`pe`, `pb`, `evToEbitda`) are scale-free — a caller cannot tell
   * from the shape which fields still need converting, and the ordering of an
   * unconverted market cap is monotone, so the mistake survives every
   * sort-based sanity check and only breaks absolute thresholds.
   */
  marketCap?: number;
  /** ₹ CRORE, same as {@link ValuationRatios.marketCap}. */
  enterpriseValue?: number;
  pe?: number;
  pb?: number;
  evToEbitda?: number;
  /** In PERCENT, to match `StockRatios.dividendYield`'s existing convention. */
  dividendYield?: number;
}

/**
 * Compute valuation ratios from joined inputs.
 *
 * ## Negative denominators are refused, not signed
 *
 * A loss-making company has no meaningful P/E. Reporting a negative one is a
 * convention some vendors adopt, and it is actively harmful in a screener: sort
 * ascending by P/E and every loss-maker rises above every cheap profitable
 * company. `safeRatio` refuses a non-positive denominator, so `pe`, `pb` and
 * `evToEbitda` are simply absent for those companies — which is what a
 * "cheapest by P/E" screen should show.
 *
 * Enterprise value is the one figure allowed to go negative (net cash exceeding
 * market cap is a real, if unusual, state), but `evToEbitda` still refuses it as
 * a numerator, because a negative EV over positive EBITDA sorts as "cheapest"
 * and means the opposite.
 */
export function deriveValuation(i: ValuationInputs): ValuationRatios {
  const out: ValuationRatios = {};

  // Kept in RUPEES for the EV arithmetic below, which mixes it with debt and
  // cash; converted to crore only at assignment.
  const marketCapRupees =
    i.price !== undefined && i.shares !== undefined && i.shares > 0
      ? i.price * i.shares
      : undefined;
  const marketCapCrore = rupeesToCrores(marketCapRupees);
  if (marketCapCrore !== undefined) out.marketCap = marketCapCrore;

  const pe = safeRatio(i.price, i.ttmEps);
  if (pe !== undefined) out.pe = pe;

  const bookPerShare = safeRatio(i.totalEquity, i.shares);
  const pb = safeRatio(i.price, bookPerShare);
  if (pb !== undefined) out.pb = pb;

  // EV = market cap + debt - cash. Debt and cash are each optional; a company
  // with no reported debt contributes 0 only when the OTHER side is present, so
  // a filing carrying neither yields no EV rather than EV == market cap.
  let evRupees: number | undefined;
  if (
    marketCapRupees !== undefined &&
    (i.totalDebt !== undefined || i.totalCash !== undefined)
  ) {
    const ev = marketCapRupees + (i.totalDebt ?? 0) - (i.totalCash ?? 0);
    if (Number.isFinite(ev)) {
      evRupees = ev;
      const evCrore = rupeesToCrores(ev);
      // `rupeesToCrores` keeps a negative (net cash exceeding market cap is a
      // real state); only non-finite is dropped.
      if (evCrore !== undefined) out.enterpriseValue = evCrore;
    }
  }

  // Computed in RUPEES on both sides — EV in crore over EBITDA in rupees would
  // be the same 1e7 error wearing a ratio's clothes.
  const evEbitda = safeRatio(evRupees, i.ttmEbitda);
  if (evEbitda !== undefined) out.evToEbitda = evEbitda;

  const dy = safeRatio(i.ttmDividendPerShare, i.price);
  if (dy !== undefined) out.dividendYield = dy * 100;

  return out;
}

/** Days within which two equal amounts are treated as one restated event. */
const DIVIDEND_DEDUPE_WINDOW_DAYS = 3;

/**
 * Sum `dividendPerShare` across the corporate actions falling in the trailing
 * twelve months ending at `asOf`.
 *
 * The window is ex-date based, which is the date that determines entitlement.
 * A null `dividendPerShare` contributes NOTHING and is counted as skipped
 * rather than treated as a zero dividend — `CorporateAction.dividendPerShare`
 * is explicitly nullable and 42,923 DIVIDEND rows exist on prod, so "declared
 * but amount not captured" is a real state that must not depress the yield.
 *
 * ## Near-duplicate rows are collapsed, and they are not an edge case
 *
 * Measured on prod 2026-08-19 over the trailing twelve months: of 1,220 symbols
 * with a priced dividend, **642 (52.6%)** carry at least one same-amount row
 * within two days of another, and summing the table as-is inflates aggregate
 * DPS by **+56.8%** (22,338.34 vs 14,244.85).
 *
 *     INFY  2026-06-09 ₹25 + 2026-06-10 ₹25  -> sums 73, true 48
 *     TCS   2026-05-24 ₹31 + 2026-05-25 ₹31, and two more pairs -> 108 vs 65
 *     ITC   2026-05-26 ₹8  + 2026-05-27 ₹8   -> 22.5 vs 14.5
 *
 * A `(symbol, exDate)` unique key would NOT catch these — exact-date duplicates
 * are zero (2,374 distinct `(symbol, exDate)` across 2,374 rows). The twins sit
 * one day apart, from the same source, and are restatements of one event.
 *
 * So the rule is: within {@link DIVIDEND_DEDUPE_WINDOW_DAYS}, an identical
 * amount is the SAME dividend counted twice. Deliberately narrow — it keys on
 * amount equality as well as proximity, so a company genuinely paying two
 * different dividends days apart (interim + special) still sums both, and one
 * paying the same amount quarterly is unaffected at ~90-day spacing.
 *
 * This is a seam-level defence, not a substitute for fixing the ingest. It
 * lives here because a yield computed from this table today is wrong by half.
 */
export function ttmDividendPerShare(
  actions: ReadonlyArray<{ exDate: Date; dividendPerShare: number | null }>,
  asOf: Date,
): {
  total: number | undefined;
  counted: number;
  skippedNullAmount: number;
  /** Rows dropped as same-amount restatements. Measured, never silent. */
  deduped: number;
} {
  const from = new Date(asOf.getTime());
  from.setUTCFullYear(from.getUTCFullYear() - 1);

  const inWindow: Array<{ exDate: Date; amount: number }> = [];
  let skippedNullAmount = 0;

  for (const a of actions) {
    if (a.exDate <= from || a.exDate > asOf) continue;
    if (a.dividendPerShare === null || !Number.isFinite(a.dividendPerShare)) {
      skippedNullAmount++;
      continue;
    }
    inWindow.push({ exDate: a.exDate, amount: a.dividendPerShare });
  }

  // Oldest-first, so the FIRST sighting of an event is the one kept.
  inWindow.sort((x, y) => x.exDate.getTime() - y.exDate.getTime());

  const kept: Array<{ exDate: Date; amount: number }> = [];
  let deduped = 0;
  const windowMs = DIVIDEND_DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  for (const row of inWindow) {
    const twin = kept.some(
      (k) =>
        k.amount === row.amount &&
        Math.abs(k.exDate.getTime() - row.exDate.getTime()) <= windowMs,
    );
    if (twin) {
      deduped++;
      continue;
    }
    kept.push(row);
  }

  let total = 0;
  for (const k of kept) total += k.amount;
  const counted = kept.length;

  // NO priced action in the window => UNKNOWN, never 0.
  //
  // The earlier version returned 0 here and reserved `undefined` for the
  // narrower "every action had a null amount" case. That was wrong against the
  // real table: only 1,977 of 10,749 active NSE instruments have a DIVIDEND
  // action in the trailing twelve months, so "no rows" overwhelmingly means
  // "our corporate-actions coverage does not reach this symbol", not "this
  // company paid nothing". `StockRatios` agrees — 1,161 non-null
  // `dividendYield` values and exactly ONE equal to 0, i.e. the table's
  // convention for "no dividend" is already NULL.
  //
  // Emitting 0 would flip a real 3.61% (INFY) or 4.81% (ITC) to a hard zero
  // whenever ingest lags, under a source stamp that outranks the incumbent.
  if (counted === 0) {
    return { total: undefined, counted, skippedNullAmount, deduped };
  }
  return { total, counted, skippedNullAmount, deduped };
}
