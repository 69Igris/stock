/**
 * `document_financial_extracts` → {@link RatioInputs} — MONEY-1346 / MONEY-1260.
 *
 * ## The gap this closes, measured
 *
 * On prod 2026-09-05, **1,248 Indian symbols hold EXTRACTED ANNUAL rows in
 * `document_financial_extracts` and have NO XBRL filing at all. ZERO of them
 * have a `stock_ratios` row.** The only live producer — `xbrl-ratios` — selects
 * its candidates with `xbrlFilings: { some: {} }`, so a company that never
 * filed XBRL is not merely unwritten, it is never CONSIDERED: no P/E, no ROE,
 * no margin, and no counter anywhere saying so.
 *
 * The numbers to fix that are already stored. A model has read the company's
 * own annual report and written revenue, profit, assets, equity, EPS and the
 * paid-up/face-value pair into a row. What was missing was a way to hand those
 * numbers to the SAME derivations the XBRL half uses, without either forking
 * the ratio code or pretending the reading is a filing.
 *
 * ## What this module is, and is not
 *
 * It is a PURE mapper: extract columns in, {@link RatioInputs} out. No Prisma
 * import — the row arrives as a structural type, so this file cannot grow a
 * dependency on the schema and can be tested with an object literal. No
 * derivation happens here; every ratio is still computed by `deriveRatios`,
 * `deriveShareCount` and `deriveValuation`.
 *
 * ## UNITS — the mistake this file exists to make impossible
 *
 * `DocumentFinancialExtract`'s money columns are **CRORES**. `XbrlFinancials.
 * values` is **ABSOLUTE RUPEES** — XBRL facts are filed unscaled, and
 * `deriveValuation` says so of its own inputs. Handing a crore figure to a
 * rupee-shaped structure is wrong by a factor of ten million in a number that
 * still looks like a number: market cap, enterprise value and EV/EBITDA all
 * become nonsense while every margin — a ratio of two same-scale figures —
 * stays perfectly correct, so the error survives every sanity check that
 * compares percentages.
 *
 * Three columns are NOT in the statement's scale and must NOT be converted, for
 * the same reason `document-financials-logic.ts` marks them `unscaled`: `eps`
 * and `faceValue` are rupees PER SHARE, and `sharesOutstanding` is a count.
 * A face value of ₹10 multiplied by 1e7 is ₹10 crore per share.
 *
 * ## What this cohort cannot produce, stated rather than discovered
 *
 *   - `roce` / `interestCoverage` / `ebitdaMargin` VIA THE COMPONENTS ROUTE.
 *     All three are built from `profitBeforeTax`, `financeCosts` and
 *     `depreciationAndAmortisation`, and the extraction prompt asks for none of
 *     them. `ebitdaMargin` is recovered anyway through
 *     {@link RatioInputs.reportedIncome} — the statement's own EBITDA line —
 *     but `roce` and `interestCoverage` are genuinely unavailable and report
 *     their own reason through `planRatiosWrite`.
 *   - `debtToEquity`. The extract carries ONE `totalDebt`, with no
 *     current/non-current split, and `projectFinancials` builds a non-lender's
 *     `totalDebt` from `borrowingsCurrent` + `borrowingsNonCurrent`. Splitting
 *     a total we do not have is a fabricated maturity classification, so the
 *     total is mapped to `borrowings` — the concept that MEANS "total
 *     borrowings" and the one `deriveRatios` already reads as the unsplit
 *     fallback — and `debtToEquity` reports unfilled. The caller can still pass
 *     the same figure straight to `deriveValuation`, which takes `totalDebt` as
 *     an argument rather than reading it out of `values`.
 *   - `grossMargin` / `currentRatio`. Need cost-of-goods lines and a
 *     current-assets/liabilities split; the extract has neither.
 *
 * ## `family` is `"ind-as"`, deliberately
 *
 * A document reading carries no taxonomy entry point, so there is nothing to
 * classify a filer from. `"ind-as"` is the non-lender default and it is the
 * SAFE direction here rather than the optimistic one: the lender refusal exists
 * because deriving EBITDA as an interest ADD-BACK is meaningless for a bank,
 * and this path derives no such thing — `ebitdaBeforeExceptionalItems` is the
 * figure the company's own statement printed. A lender that printed one is
 * making its own claim, not having one manufactured for it.
 */

import { RUPEES_PER_CRORE, type RatioInputs } from "./xbrl-financials-logic";

/**
 * The `document_financial_extracts` columns this mapper reads.
 *
 * Structural on purpose — see the header. Every money field is optional AND
 * nullable because Prisma returns `null` for an unset `Float?` while a
 * hand-built test row omits it; both must mean "absent", and neither may become
 * a zero.
 */
export interface DocumentExtractRow {
  /** UTC end-of-period. The only date the extract guarantees. */
  periodEnd: Date;
  /** `ANNUAL` | `QUARTERLY`. */
  periodType: string;
  /** `CONSOLIDATED` | `STANDALONE`, upper-case as stored. */
  basis: string;

  // ── Income statement, CRORES ──
  revenueFromOperations?: number | null;
  otherIncome?: number | null;
  operatingIncomeExOtherIncome?: number | null;
  ebitdaBeforeExceptionalItems?: number | null;
  netIncome?: number | null;

  // ── Balance sheet, CRORES ──
  totalAssets?: number | null;
  totalLiabilities?: number | null;
  totalEquity?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;

  // ── Per-share, RUPEES (never scaled) ──
  eps?: number | null;
  faceValue?: number | null;

  /** CRORES, like every other money column. */
  paidUpCapital?: number | null;
}

/** Finite-only. `null`, `undefined` and NaN/Infinity are all absence. */
function finite(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * CRORES → ABSOLUTE RUPEES. Absence stays absence — never 0.
 *
 * Re-checked for finiteness AFTER the multiply: a stored value large enough to
 * overflow to `Infinity` once scaled would otherwise reach `values`, and every
 * downstream guard treats a present number as a real one.
 */
function croresToRupees(v: number | null | undefined): number | undefined {
  const n = finite(v);
  if (n === undefined) return undefined;
  const scaled = n * RUPEES_PER_CRORE;
  return Number.isFinite(scaled) ? scaled : undefined;
}

/** ISO `YYYY-MM-DD` in UTC. */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The reporting span for one extract row.
 *
 * ANNUAL is `end − 1 year + 1 day` … `end`, which is the Indian fiscal
 * convention (a 31-March year end starts on 1 April) and yields 366 across a
 * leap February without special-casing one. QUARTERLY is the same construction
 * over three months.
 *
 * `days` is INCLUSIVE of both ends, matching what the XBRL fixtures store for a
 * full fiscal year (365 for 2024-04-01 → 2025-03-31). Nothing in `deriveRatios`
 * reads it; it is filled correctly rather than left as a plausible constant
 * because `isAdjacentAnnual` DOES read `end`, and a period object whose fields
 * disagree with each other is the kind of thing a later reader trusts.
 */
function periodFor(row: DocumentExtractRow): RatioInputs["period"] {
  const endMs = row.periodEnd.getTime();
  // Step to the DAY AFTER the end FIRST, then subtract the span in months.
  //
  // The other order is off by one for every month-length mismatch, and it is
  // off by one QUIETLY: subtracting three months from 30-Jun gives 30-Mar, and
  // adding a day gives 31-March — a quarter that starts on the last day of the
  // previous quarter, with a 92-day span that still looks like a quarter. Doing
  // it this way, the intermediate date is always the FIRST of a month, so the
  // month arithmetic can neither clamp (31-Feb) nor drift.
  const start = new Date(endMs + 86_400_000);
  start.setUTCMonth(
    start.getUTCMonth() - (row.periodType === "QUARTERLY" ? 3 : 12),
  );
  const days = Math.round((endMs - start.getTime()) / 86_400_000) + 1;
  return { start: iso(start), end: iso(row.periodEnd), days };
}

/**
 * Lower-case the stored basis, or refuse it.
 *
 * `XbrlBasis` is a closed two-value union and `isAdjacentAnnual` treats an
 * absent basis as UNKNOWN and refuses to average across it — which is the right
 * answer for a value we do not recognise. Mapping an unexpected string onto one
 * of the two would assert a comparability that was never checked.
 */
function basisOf(basis: string): RatioInputs["basis"] {
  const lower = basis.toLowerCase();
  return lower === "consolidated" || lower === "standalone" ? lower : null;
}

/**
 * Map one stored extract row onto the ratio engines' input shape.
 *
 * Only FINITE values reach `values`: an absent column stays absent, never a
 * zero. That rule is the whole reason `Partial<Record<…>>` is the value type —
 * a `netIncome: 0` written for a company whose profit was simply not read makes
 * `netMargin` 0%, which reads as a fact rather than as a gap.
 */
export function extractToRatioInputs(row: DocumentExtractRow): RatioInputs {
  const values: RatioInputs["values"] = {};
  const put = (
    key: keyof RatioInputs["values"],
    v: number | undefined,
  ): void => {
    if (v !== undefined) values[key] = v;
  };

  // ── Income statement ──
  put("revenueFromOperations", croresToRupees(row.revenueFromOperations));
  put("otherIncome", croresToRupees(row.otherIncome));
  // `netIncome` is the extract's name for what the taxonomy calls
  // `ProfitLossForPeriod`. `profitAttributableToOwners` is deliberately NOT
  // also set: the extract has one profit figure and cannot say whether it is
  // before or after non-controlling interests, and `projectFinancials`
  // re-derives the attribution from the pair when both are present. Setting one
  // key means the projection reads exactly the number that was read.
  put("profitForPeriod", croresToRupees(row.netIncome));

  // ── Balance sheet ──
  put("totalAssets", croresToRupees(row.totalAssets));
  put("totalEquity", croresToRupees(row.totalEquity));
  put("totalLiabilities", croresToRupees(row.totalLiabilities));
  // See the header: the unsplit total, on the concept that means exactly that.
  put("borrowings", croresToRupees(row.totalDebt));
  put("cashAndCashEquivalents", croresToRupees(row.totalCash));

  // ── Per share — RUPEES ALREADY, and scaling either is silent ──
  put("basicEps", finite(row.eps));
  put("faceValuePerShare", finite(row.faceValue));
  // …but paid-up capital IS a money column in the statement's scale, which is
  // what makes `deriveShareCount`'s `paidUpCapital / faceValue` come out as a
  // share COUNT: crores × 1e7 gives rupees, over rupees-per-share.
  put("paidUpEquityShareCapital", croresToRupees(row.paidUpCapital));

  const operating = croresToRupees(row.operatingIncomeExOtherIncome);
  const ebitda = croresToRupees(row.ebitdaBeforeExceptionalItems);

  return {
    values,
    basis: basisOf(row.basis),
    // See the header for why this is not a guess dressed as a classification.
    family: "ind-as",
    period: periodFor(row),
    // Omitted entirely when neither line was read, so the optional field means
    // "this source reported nothing directly" rather than "it reported two
    // absences".
    ...(operating !== undefined || ebitda !== undefined
      ? {
          reportedIncome: {
            ...(operating !== undefined
              ? { operatingIncomeExOtherIncome: operating }
              : {}),
            ...(ebitda !== undefined
              ? { ebitdaBeforeExceptionalItems: ebitda }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Pick ONE row per distinct `periodEnd`, CONSOLIDATED preferred — MONEY-1346.
 *
 * The extract table keys on `(documentId, periodEnd, periodType, basis)`, so a
 * company that files both bases for one year holds TWO rows for it, and they
 * "differ by a MULTIPLE for any holding company" (360ONE FY2025 total assets:
 * 19,768 Cr consolidated against 7,332 Cr standalone). Handing the newest two
 * rows straight to `deriveRatios` as this-year and prior-year would therefore
 * routinely compare a group against a parent and publish the consolidation gap
 * as growth — the MONEY-1235 defect, one table over.
 *
 * The preference matches the ratified `stock_financials` policy
 * (CONSOLIDATED-preferred, standalone as fallback) and matches
 * `selectFilingForPeriod` on the XBRL side, so the two halves of the same
 * column are chosen the same way.
 *
 * Input order is not trusted: rows are grouped, then the result is sorted by
 * `periodEnd` DESCENDING, so `[0]` is the latest period and `[1]` the one
 * before it whatever Mongo returned.
 */
export function selectAnnualExtractsByPeriod<T extends DocumentExtractRow>(
  rows: readonly T[],
): T[] {
  const byPeriod = new Map<number, T>();
  for (const row of rows) {
    const key = row.periodEnd.getTime();
    if (!Number.isFinite(key)) continue;
    const incumbent = byPeriod.get(key);
    if (incumbent === undefined) {
      byPeriod.set(key, row);
      continue;
    }
    // Only a CONSOLIDATED row displaces an incumbent, and only when the
    // incumbent is not already one. Anything else keeps the first row seen,
    // which combined with the sort below makes the choice total and
    // order-independent.
    if (row.basis === "CONSOLIDATED" && incumbent.basis !== "CONSOLIDATED") {
      byPeriod.set(key, row);
    }
  }
  return [...byPeriod.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => row);
}
