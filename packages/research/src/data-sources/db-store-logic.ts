/**
 * DB-first data store — pure shaping helpers (no Prisma).
 *
 * `cleanStoreSymbol`, `groupFinancials` and `mapRatioFields` were inlined inside
 * `db-store.ts` (which imports Prisma at module top, so it can't be loaded under
 * the plain node test runner). They are extracted here as pure typed functions
 * so they can be unit-tested by importing the REAL symbol; `db-store.ts` imports
 * and calls them.
 *
 * (Staleness lives in `@usemoney/core/market-data/staleness` and is imported by
 * `db-store.ts` directly — its tests import that real module, not a copy.)
 */

// The ONE ranking of financials sources, imported rather than restated —
// MONEY-1235. Every writer in the repo guards on this list; a reader that
// decided provenance from a second, hand-kept copy would drift the moment a
// source is inserted. `xbrl-projection.ts` carries no runtime imports of its
// own (one `import type`), so this stays a pure module with no Prisma reach.
import { FINANCIALS_AUTHORITY } from "@usemoney/core/market-data/xbrl-projection";

/** Strip a trailing `.NS` / `.BO` suffix and upper-case a symbol. */
export function cleanStoreSymbol(symbol: string): string {
  return symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
}

export interface GroupedFinancials {
  income: Array<Record<string, unknown>>;
  balanceSheet: Array<Record<string, unknown>>;
  cashFlow: Array<Record<string, unknown>>;
}

/**
 * Bucket flat `StockFinancials` rows by `statementType`, spreading each row's
 * `rawData` and prepending its `period`.
 *
 * MONEY-1205 — the row's OWN fields are now carried through on top of the
 * spread `rawData`, rather than being dropped. Only `period` survived before,
 * so `rowToStatement` downstream had nothing but a label to read (the raw keys
 * are `incTrev`/`balTota`/`cafCfoa`, not `revenue`/`totalAssets`), every row
 * failed its `hasFigures` check, and the DB-first cache never returned a single
 * statement. Row fields are spread LAST because a typed column is what the row
 * asserts — possibly written by a higher-authority source — while `rawData` is
 * only the last payload that happened to land.
 *
 * Purely additive for existing consumers: the raw keys they read are all still
 * present under their original names.
 */
export function groupFinancials(
  records: Array<{
    statementType: string;
    rawData: unknown;
    period: string;
    [column: string]: unknown;
  }>,
): GroupedFinancials {
  const bucket = (type: string) =>
    records
      .filter((r) => r.statementType === type)
      // `...r` last, and `period` is NOT re-listed first: it is a required
      // field on `r`, so spreading the row supplies it, and listing it twice
      // is a TS2783 "specified more than once" — which is also the honest
      // reading, since the row's own `period` is the unique-key component and
      // must win over anything a payload happens to call `period`.
      .map((r) => ({
        ...(r.rawData as Record<string, unknown>),
        ...r,
      }));
  return {
    income: bucket("INCOME"),
    balanceSheet: bucket("BALANCE_SHEET"),
    cashFlow: bucket("CASH_FLOW"),
  };
}

/**
 * The `StockRatios` columns, all OPTIONAL — MONEY-1205.
 *
 * They used to be `number | null` (required), produced by casting
 * `ratioData.<name>` — which is `undefined` for a field the payload did not
 * carry — straight to `number | null`. Spread into an UNCONDITIONAL `update:`,
 * an absent field therefore wrote NULL.
 *
 * **That is the same landmine as the statement mapper, on a worse model.**
 * `StockFinancials` is keyed per PERIOD, so a bad write costs one period.
 * `StockRatios` is `@@unique([symbol, exchange])` — ONE row per symbol, no
 * period dimension — so a bad write is the symbol's ENTIRE ratio set.
 *
 * And it is not hypothetical. Measured against the live endpoint on 2026-08-18,
 * `POST /screener/query` honours only **7 of the 25 projected fields**
 * (`beta, divYield, mrktCapf, pb, pe, roce, roe`); the other 18 — `roa`,
 * `evEBITDA`, `pegRatio`, the three margins, the six growth rates, `debt2Eq`,
 * `curRatio`, `intCover`, `entVal`, `tgtPrice`, `recom` — are silently dropped
 * from the response. So a successful ratios write would have nulled 18 columns
 * on every symbol it touched.
 *
 * Optional now means: absent from the payload ⇒ absent from this object ⇒
 * Prisma leaves the column alone. An explicit `null` still writes null.
 */
export interface MappedRatioFields {
  pe?: number | null;
  pb?: number | null;
  evToEbitda?: number | null;
  pegRatio?: number | null;
  roe?: number | null;
  roa?: number | null;
  roce?: number | null;
  grossMargin?: number | null;
  operatingMargin?: number | null;
  netMargin?: number | null;
  revenueGrowth?: number | null;
  earningsGrowth?: number | null;
  revenueGrowth3Y?: number | null;
  earningsGrowth3Y?: number | null;
  revenueGrowth5Y?: number | null;
  earningsGrowth5Y?: number | null;
  debtToEquity?: number | null;
  currentRatio?: number | null;
  interestCoverage?: number | null;
  beta?: number | null;
  dividendYield?: number | null;
  marketCap?: number | null;
  enterpriseValue?: number | null;
  targetPrice?: number | null;
  recommendation?: string | null;
}

/**
 * Source key per `StockRatios` column.
 *
 * These are the CLIENT's normalised names, not the wire names:
 * `fetchTickertapeStockRatios` already maps `evEBITDA`→`evToEbitda`,
 * `grossMrgn`→`grossMargin`, `revGrwAn`→`revenueGrowth` and so on. Verified
 * against the live payload — unlike the statement mappers, the ratio NAMES here
 * were never wrong. `divYield`/`mCap` are the client's own preferred spellings
 * and are tried before the canonical ones.
 */
const RATIO_KEYS: Record<keyof MappedRatioFields, ReadonlyArray<string>> = {
  pe: ["pe"],
  pb: ["pb"],
  evToEbitda: ["evToEbitda"],
  pegRatio: ["pegRatio"],
  roe: ["roe"],
  roa: ["roa"],
  roce: ["roce"],
  grossMargin: ["grossMargin"],
  operatingMargin: ["operatingMargin"],
  netMargin: ["netMargin"],
  revenueGrowth: ["revenueGrowth"],
  earningsGrowth: ["earningsGrowth"],
  revenueGrowth3Y: ["revenueGrowth3Y"],
  earningsGrowth3Y: ["earningsGrowth3Y"],
  revenueGrowth5Y: ["revenueGrowth5Y"],
  earningsGrowth5Y: ["earningsGrowth5Y"],
  debtToEquity: ["debtToEquity"],
  currentRatio: ["currentRatio"],
  interestCoverage: ["interestCoverage"],
  beta: ["beta"],
  dividendYield: ["divYield", "dividendYield"],
  marketCap: ["mCap", "marketCap"],
  enterpriseValue: ["enterpriseValue"],
  targetPrice: ["targetPrice"],
  recommendation: ["recommendation"],
};

/** `recommendation` is the one string column; everything else is numeric. */
const RATIO_STRING_COLUMNS = new Set<keyof MappedRatioFields>([
  "recommendation",
]);

/**
 * Map a raw Tickertape ratio payload onto the `StockRatios` columns.
 *
 * Absent fields are OMITTED, never nulled — see {@link MappedRatioFields}. An
 * explicit `null` in the payload is preserved, because that is the source
 * positively reporting the ratio as unavailable (a loss-making company has no
 * meaningful P/E).
 *
 * Note `fetchTickertapeStockRatios` sets missing fields to `undefined`
 * EXPLICITLY (`pe: r.pe as number | undefined`), so the own-key is present with
 * an undefined value. Presence is therefore tested on the VALUE, not with
 * `Object.hasOwn` — which would have re-armed the exact clobber this avoids.
 */
export function mapRatioFields(
  ratioData: Record<string, unknown>,
): MappedRatioFields {
  const out: MappedRatioFields = {};
  for (const [column, sourceKeys] of Object.entries(RATIO_KEYS) as Array<
    [keyof MappedRatioFields, ReadonlyArray<string>]
  >) {
    let resolved: unknown = undefined;
    for (const key of sourceKeys) {
      const v = ratioData[key];
      if (v !== undefined) {
        resolved = v;
        break;
      }
    }
    if (resolved === undefined) continue;

    if (RATIO_STRING_COLUMNS.has(column)) {
      if (resolved === null) {
        (out as Record<string, unknown>)[column] = null;
      } else if (typeof resolved === "string") {
        const t = resolved.trim();
        // "" / "-" is how a feed spells absence, not a recommendation.
        if (t) (out as Record<string, unknown>)[column] = t;
      }
      continue;
    }

    if (resolved === null) {
      (out as Record<string, unknown>)[column] = null;
    } else if (typeof resolved === "number" && Number.isFinite(resolved)) {
      // 0 is a real ratio (a zero dividend yield); only non-finite is poison.
      (out as Record<string, unknown>)[column] = resolved;
    }
    // Anything else (a string, NaN, an object) is UNRESOLVED and omitted.
  }
  return out;
}

// ── Tickertape statement rows → `StockFinancials` columns (MONEY-1205) ──────
//
// ## Why this lives here and not in the worker
//
// FIVE writers persist Tickertape statement rows into `StockFinancials`:
//
//   1. `workers/src/processors/financial-data-sync.ts`  (annual, all 3 statements)
//   2. the same file's quarterly leg                    (interim income)
//   3. `packages/research/src/data-sources/db-store.ts` (REQUEST time)
//   4. `packages/research/src/data-sources/persistence.ts` (fallback persist)
//   5. `scripts/seed/seed-stock-financials.ts`          (the manual seed)
//
// Each carried its OWN key map and every one of them was wrong in a different
// way, so the mapping had to become one shared function. `@usemoney/workers`
// depends on `@usemoney/research`, never the reverse, so the shared copy could
// not live on the worker side — it lives here. (The worker file it used to be
// re-exported through, `financial-data-sync-logic.ts`, was deleted in MONEY-1220
// with the Tickertape processor it configured. Nothing here changed: the
// dependency direction is what put the shared copy in this package, not that
// file.)
//
// ## The API shape, measured — not assumed
//
// `GET api.tickertape.in/stocks/financials/{income|balancesheet|cashflow}/{sid}/
// {annual|interim}/normal` → `{ success, data: Row[] }`. A row is captured
// verbatim in `packages/research/__tests__/fixtures/tickertape-*.json`.
//
// **There is no `period` key. Only `displayPeriod`.** Three of the five writers
// read `row.period`, found `undefined`, and hit a `if (!period) continue` — so
// they have never written a single row. The two that did read `displayPeriod`
// (the seed, and the annual leg's `create:`) then read `row.revenue` /
// `row.netIncome` / `row.bsTass` / `row.cfOcf`, none of which exist either.
// That is why prod holds 32,359 rows in which `revenue` and `ebitda` are
// populated — the only two keys anybody guessed right — and every other typed
// column is null on 100% of rows.
//
// ## Two naming traps, both proven by arithmetic on the captured fixture
//
//   - **`incToi` is TAX**, not "total other income": `incPbt − incToi = incNinc`
//     holds on every row. Mapping it to an income column would book a company's
//     tax bill as revenue.
//   - **`incIoi` is INTEREST / finance cost**, not "interest and other income":
//     `incPbi − incIoi = incPbt` holds on every row.
//
// And two columns that look available and are not:
//
//   - **`incOpc` is null in 100% of rows**, all sectors. Operating income is
//     `incPbi` (EBIT), corroborated by `incEbi − incDep = incPbi`.
//   - **`incGpro` is null in 100% of rows.** It is left null rather than derived
//     from `revenue − costOfRevenue`, because `incCrev` is null in 100% of rows
//     too and a derivation from two absent inputs is a fabricated number.
//
// ## UNITS
//
// **Every figure on these rows is in ₹ CRORE and is stored unconverted.**
// HDFCBANK FY2025 `incTrev` = 470,915.93 = ₹4.71 lakh crore. That makes CRORE
// the declared unit of the numeric columns on `StockFinancials`, which is the
// invariant the XBRL projection writer has to convert INTO — see
// `RUPEES_PER_CRORE` in `@usemoney/core/market-data/xbrl-financials-logic`.
//
// ## Resolution states — the whole point of the return shape
//
// A column is in exactly one of three states, and conflating the last two is
// the defect this module exists to prevent:
//
//   RESOLVED          key present, value coerces to a finite number  → the number
//   DISCLOSED-ABSENT  key present, value is literally `null`         → `null`
//   UNRESOLVED        key missing / `undefined` / blank / non-finite → **key OMITTED**
//
// An OMITTED key is `undefined` when read, and Prisma treats `undefined` in an
// `update:` as "leave this column alone". That is load-bearing. Every one of the
// five writers spreads the mapped columns into an UNCONDITIONAL `update:`, so a
// mapper that returned `null` for an unresolved key would NULL the incumbent —
// on a row whose `source` still asserts where the value came from. Writing the
// period fix without this shape would have nulled `revenue` and `ebitda` on the
// 12,000+ prod rows that carry them, which is strictly worse than the writers
// never having run at all.
//
// A blank string is UNRESOLVED, never DISCLOSED-ABSENT, because `Number("")` is
// `0` and `new Date("")` is `Invalid Date` — the non-finite poison this repo
// guards at every other boundary. The `TTM` row is the live case: it ships
// `endDate: ""` (and `reporting: ""`), so `periodEnd` is omitted for it rather
// than written as a null or an Invalid Date.

/** Which statement a row belongs to. Mirrors `StockFinancials.statementType`. */
export type TickertapeStatementType = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";

/** Mirrors `StockFinancials.periodType`. Selects the annual vs interim key set. */
export type TickertapePeriodType = "ANNUAL" | "QUARTERLY";

/** The `StockFinancials` numeric columns this mapper can fill. */
export type TickertapeFinancialColumn =
  | "revenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "ebitda"
  | "totalAssets"
  | "totalLiabilities"
  | "totalEquity"
  | "totalDebt"
  | "totalCash"
  | "operatingCashFlow"
  | "capitalExpenditure"
  | "freeCashFlow";

/**
 * One mapped row. Numeric columns and `periodEnd` are OPTIONAL on purpose: an
 * absent property means UNRESOLVED and must not reach an `update:`; an explicit
 * `null` means the source disclosed the field as empty and is safe to write.
 */
export interface MappedTickertapeStatement extends Partial<
  Record<TickertapeFinancialColumn, number | null>
> {
  /** `displayPeriod`, verbatim and trimmed. Part of the unique key. */
  period: string;
  /** From `endDate`. Omitted when blank/unparseable (the `TTM` row). */
  periodEnd?: Date;
}

/**
 * Source key per column, per statement, per period type.
 *
 * Exported so a test can assert the map itself against the captured fixture
 * rather than re-typing it — a duplicated key map is how the five writers
 * drifted apart in the first place.
 */
export const TICKERTAPE_STATEMENT_KEYS: Record<
  TickertapePeriodType,
  Record<
    TickertapeStatementType,
    Partial<Record<TickertapeFinancialColumn, string>>
  >
> = {
  ANNUAL: {
    INCOME: {
      revenue: "incTrev",
      // EBIT. NOT `incOpc` — that key exists and is null in 100% of rows.
      operatingIncome: "incPbi",
      netIncome: "incNinc",
      ebitda: "incEbi",
      // Present but null in 100% of rows. Mapped anyway so the column reads
      // DISCLOSED-ABSENT rather than UNRESOLVED, and never derived.
      grossProfit: "incGpro",
    },
    BALANCE_SHEET: {
      totalAssets: "balTota",
      totalLiabilities: "balTotl",
      totalEquity: "balTeq",
      // Null for banks/NBFCs. Deliberately NOT falling back to `balTltd`:
      // that is LONG-TERM debt only, a different concept, and substituting it
      // would understate leverage for every company with short-term borrowings
      // while looking like a successful read.
      totalDebt: "balTdeb",
      totalCash: "balCsti",
    },
    CASH_FLOW: {
      operatingCashFlow: "cafCfoa",
      // Stored POSITIVE, matching `cafCfoa − cafCexp = cafFcf`.
      capitalExpenditure: "cafCexp",
      freeCashFlow: "cafFcf",
    },
  },
  QUARTERLY: {
    // The interim feed is P&L-only — there is no quarterly balance-sheet or
    // cash-flow endpoint — so those two maps are deliberately EMPTY rather than
    // absent, and a caller asking for them gets a row with no columns instead of
    // a crash.
    INCOME: {
      revenue: "qIncTrev",
      operatingIncome: "qIncPbi",
      netIncome: "qIncNinc",
      ebitda: "qIncEbi",
      // No `qIncGpro` in the interim payload at all — omitted, not mapped-to-null.
    },
    BALANCE_SHEET: {},
    CASH_FLOW: {},
  },
};

/**
 * Which statements Tickertape can actually SERVE for a period type — MONEY-1205.
 *
 * Derived from {@link TICKERTAPE_STATEMENT_KEYS} rather than written out, so
 * the two cannot drift: a statement whose key map is EMPTY cannot resolve a
 * single column, so persisting it can only ever create an all-null row.
 *
 * ## The bug this closes
 *
 * `getOrFetchFinancials(symbol, exchange, "QUARTERLY")` fetched
 * `fetchTickertapeFinancials`, whose URL hardcodes `/annual/normal`
 * (`tickertape-client.ts`), and then upserted those ANNUAL rows under the
 * CALLER's `periodType`. Because the QUARTERLY key table reads `qIncTrev` while
 * an annual row carries `incTrev`, every column came back unresolved. The row
 * that lands is:
 *
 *   periodType "QUARTERLY", period "FY 2025", all 13 columns null,
 *   rawData = an annual payload, source "TICKERTAPE"
 *
 * — a quarter that does not exist, asserting a provenance it does not have.
 *
 * It was INERT before MONEY-1205 only because the mapper read `row.period`,
 * which the feed does not emit, so `if (!mapped) continue` dropped every row.
 * Repairing the period key ARMED it. That path is on the daily
 * `stock-document-sync-tickertape-daily` job (batchSize 8000) and on every
 * request-time research call, against a genuine quarterly writer that runs
 * weekly over 100 instruments — so the fabricated rows would have landed first
 * and become prod's first non-zero QUARTERLY population.
 *
 * Verified against the live API on 2026-08-18: `/interim/normal` serves
 * `income` (200) and answers `balancesheet` and `cashflow` with
 * `400 {"success":false,"errorType":"INVALID_INPUT"}`. There is no quarterly
 * balance sheet or cash flow to fetch.
 */
export function tickertapeStatementsForPeriod(
  periodType: TickertapePeriodType,
): ReadonlyArray<TickertapeStatementType> {
  const table = TICKERTAPE_STATEMENT_KEYS[periodType];
  return (Object.keys(table) as TickertapeStatementType[]).filter(
    (statement) => Object.keys(table[statement]).length > 0,
  );
}

/**
 * Coerce one source value into a resolution state.
 *
 * `undefined` = UNRESOLVED (caller omits the key). `null` = either
 * DISCLOSED-ABSENT or UNRESOLVED — the caller cannot tell them apart from the
 * return alone, which is why this returns a tagged result instead.
 */
function resolveNumeric(
  raw: unknown,
): { state: "unresolved" } | { state: "value"; value: number | null } {
  if (raw === undefined) return { state: "unresolved" };
  if (raw === null) return { state: "value", value: null };
  if (typeof raw === "number") {
    // 0 is a real datum on these statements; only non-finite is poison.
    return Number.isFinite(raw)
      ? { state: "value", value: raw }
      : { state: "unresolved" };
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    // "" / "-" / "—" / "NA" are how a feed spells absence. `Number("")` is 0,
    // so these MUST short-circuit before any numeric coercion.
    if (t === "" || t === "-" || t === "—" || t.toUpperCase() === "NA") {
      return { state: "unresolved" };
    }
    const n = Number(t.replace(/,/g, ""));
    return Number.isFinite(n)
      ? { state: "value", value: n }
      : { state: "unresolved" };
  }
  return { state: "unresolved" };
}

/**
 * Parse `endDate` into a real Date, or UNRESOLVED.
 *
 * The `TTM` row ships `endDate: ""`. `new Date("")` is an Invalid Date whose
 * `getTime()` is NaN, and Prisma writes it as an unusable value rather than
 * throwing — so the guard is on `Number.isFinite(getTime())`, not on truthiness.
 */
export function parseTickertapePeriodEnd(raw: unknown): Date | undefined {
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? raw : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

/**
 * Map ONE Tickertape statement row onto the `StockFinancials` columns.
 *
 * Pure. Never fabricates, never derives, never falls back to a neighbouring
 * concept. Returns `null` when the row carries no usable period — `period` is
 * part of the unique key, so an unkeyable row cannot be upserted at all.
 *
 * `row.period` is accepted as a fallback after `displayPeriod` so that rows read
 * back out of our OWN stored `rawData` (which `groupFinancials` prepends a
 * `period` to) map identically to rows straight off the wire. The wire shape
 * only ever has `displayPeriod`.
 */
export function mapTickertapeStatementRow(
  statementType: TickertapeStatementType,
  row: Record<string, unknown>,
  periodType: TickertapePeriodType = "ANNUAL",
): MappedTickertapeStatement | null {
  const rawPeriod = row.displayPeriod ?? row.period;
  const period = typeof rawPeriod === "string" ? rawPeriod.trim() : "";
  if (!period) return null;

  const out: MappedTickertapeStatement = { period };

  const periodEnd = parseTickertapePeriodEnd(row.endDate);
  if (periodEnd !== undefined) out.periodEnd = periodEnd;

  const keys = TICKERTAPE_STATEMENT_KEYS[periodType][statementType];
  for (const [column, sourceKey] of Object.entries(keys) as Array<
    [TickertapeFinancialColumn, string]
  >) {
    const r = resolveNumeric(row[sourceKey]);
    if (r.state === "value") out[column] = r.value;
  }

  return out;
}

/**
 * The numeric columns only — `period` and `periodEnd` stripped off.
 *
 * `period` is a WHERE-clause component on every one of the five upserts, so
 * spreading it into `update:`/`create:` alongside the columns is at best
 * redundant and at worst a second, contradictory source of the key. This is the
 * value writers spread.
 */
export function tickertapeStatementColumns(
  mapped: MappedTickertapeStatement,
): Partial<Record<TickertapeFinancialColumn, number | null>> & {
  periodEnd?: Date;
} {
  const { period: _period, ...columns } = mapped;
  void _period;
  return columns;
}

/**
 * Gate for advancing `instrumentMapping.financialsSyncedAt` after a financials
 * run — MONEY-805, shared by the worker AND the seed as of MONEY-1205.
 *
 * ONLY bump the staleness marker when at least one feed actually persisted a
 * row (annual statements OR quarterly income). A total miss — annual fetch null
 * AND quarterly empty (a transient upstream failure) — must leave the marker
 * untouched so the instrument is retried on the next run instead of being
 * marked "freshly synced" and skipped for a full staleness window.
 *
 * It lives here rather than on the worker side because `@usemoney/workers`
 * publishes no `exports` map and no `main`, so nothing outside the worker can
 * import from it. (It used to be re-exported through the worker's
 * `financial-data-sync-logic.ts`, deleted in MONEY-1220 with its processor;
 * that removes a re-export, not the reason this lives here.) And
 * `scripts/seed/seed-stock-financials.ts` had the same defect with its own
 * unconditional bump. A second copy in the seed is how the two would drift.
 */
export function shouldBumpFinancialsSyncedAt(
  annualOk: boolean,
  quarterlyOk: boolean,
): boolean {
  return annualOk || quarterlyOk;
}

// ── Period ordering, provenance and the frozen TTM row — MONEY-1235 ──────────
//
// `getOrFetchFinancials` used to read `orderBy: { period: "desc" }` and treat
// `rows[0]` as "the newest row" — for the staleness check AND for the `source`
// label handed to the research agent. `period` is a free-text LABEL, so that is
// a LEXICOGRAPHIC sort, and the XBRL switchover breaks it in two independent
// ways at once:
//
//  1. QUARTERLY MISORDER. `periodLabel()` emits `Q${q}-${fyEndYear}` (Indian
//     fiscal year, April-March), so the newest quarter of a symbol that has
//     started FY2027 is `"Q1-2027"` — which sorts BELOW every `"Q4-2026"`,
//     `"Q3-2026"`, `"Q2-2026"` string. `fetch_income_statement(quarterly:true)`
//     would hand the model a list whose FIRST element is not the latest
//     quarter, with nothing in the payload to notice it by. Prod has 71,450
//     quarterly filings and ZERO quarterly `stock_financials` rows today, so
//     this misorder arrives with the first rows the projection ever writes.
//
//  2. THE FROZEN TTM ROW WINS FOREVER. `"TTM" > "FY 20xx"` because `"T" > "F"`.
//     ~2,123 `period:"TTM"` rows are stored under `periodType:"ANNUAL"` and
//     `periodLabel()` structurally never emits "TTM", so the projection can
//     never displace them: they keep Tickertape values, a Tickertape `source`
//     and a frozen `fetchedAt` permanently. Under a label sort that row is
//     `rows[0]` for every symbol that has one, so `metadata.source` reads
//     `TICKERTAPE` and the staleness log fires nightly even when every FY row
//     beside it is fresh `NSE_XBRL`.
//
// The fix is to sort on the DATE. `periodEnd` is the sortable key the model
// gained in MONEY-1207 and the XBRL writer populates it on both CREATE and
// UPDATE (workers/src/processors/xbrl-projection-writer.ts) — but it is
// NULLABLE and the ~32,359 legacy Tickertape rows predate it, so the sort must
// not depend on it being there. Sorting in CODE rather than adding
// `orderBy: { periodEnd: "desc" }` is deliberate: on Mongo a MISSING field
// sorts in a fixed position (ahead of every value on an ascending sort), which
// would file every undated legacy row against the wrong end of the list
// silently. In code the two cases are separable and testable.

/**
 * A stored `StockFinancials` row, as far as ordering and provenance care.
 *
 * Deliberately `unknown`-typed: these helpers are fed BOTH real Prisma rows and
 * the grouped objects `groupFinancials` produces (whose `rawData` spread can
 * put anything under any of these names), so every field is re-validated here
 * rather than trusted.
 */
export interface StoredFinancialsPeriodRow {
  period?: unknown;
  periodEnd?: unknown;
  source?: unknown;
  fetchedAt?: unknown;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Epoch ms from a Date / ISO string / number, or null. Never NaN. */
function toTime(v: unknown): number | null {
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? v.getTime() : null;
  }
  if (typeof v === "string" && v.trim()) {
    const t = new Date(v.trim()).getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * True when a row is the trailing-twelve-month AGGREGATE rather than a period.
 *
 * Matches `isTtmRow` in apps/web/components/stock/StockFinancialsTab.tsx, which
 * is the other reader of the same rows.
 */
export function isTtmPeriod(period: unknown): boolean {
  return typeof period === "string" && period.trim().toUpperCase() === "TTM";
}

/**
 * The period-end a free-text `period` LABEL stands for, in epoch ms.
 *
 * Only a FALLBACK — for rows written before `periodEnd` existed. Every row the
 * XBRL projection touches carries the real date, and the real date always wins
 * in {@link financialsPeriodTime}.
 *
 * The convention is the one `periodLabel()` emits (packages/core/src/
 * market-data/xbrl-projection.ts), i.e. Indian fiscal years running April to
 * March, with the label naming the year the FY ENDS in:
 *
 *   "FY 2026" / "2026" -> 2026-03-31     "Q4-2026" -> 2026-03-31
 *   "Q1-2027"          -> 2026-06-30     "Q2-2026" -> 2025-09-30
 *   "Q3-2026"          -> 2025-12-31
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not special-case December-year-end filers (95 ANNUAL filings /
 *    20 symbols on prod). Their label resolves to the wrong MONTH, but to the
 *    right relative ORDER, because every one of that filer's rows shifts by the
 *    same nine months — and ordering is the only thing this value is used for.
 *  - It returns null for "TTM" rather than guessing. A trailing-twelve-month
 *    aggregate has no period end, and inventing one is exactly how it ended up
 *    leading the list in the first place.
 */
export function periodEndFromLabel(period: unknown): number | null {
  if (typeof period !== "string") return null;
  const s = period.trim();
  if (!s || isTtmPeriod(s)) return null;

  // Year token: a 4-digit year, else a 2-digit one ("FY24" -> 2024).
  let year: number | null = null;
  const four = s.match(/(\d{4})/);
  if (four) {
    year = Number(four[1]);
  } else {
    const two = s.match(/(\d{2})\b/);
    if (two) year = 2000 + Number(two[1]);
  }
  if (year === null || !Number.isFinite(year)) return null;

  const q = s.match(/Q\s*([1-4])\b/i);
  if (q) {
    const quarter = Number(q[1]);
    // `Date.UTC(y, month, 0)` is the LAST day of `month` (1-based), which is
    // how Jun/Sep/Dec/Mar get 30/30/31/31 without a lookup table.
    return quarter === 4
      ? Date.UTC(year, 3, 0)
      : Date.UTC(year - 1, quarter * 3 + 3, 0);
  }
  // Annual: the fiscal year ends 31 March of the labelled year.
  return Date.UTC(year, 3, 0);
}

/** The row's sortable instant: the real `periodEnd`, else the label. */
export function financialsPeriodTime(
  row: StoredFinancialsPeriodRow,
): number | null {
  return toTime(row.periodEnd) ?? periodEndFromLabel(row.period);
}

/**
 * Newest-first comparator over stored financials rows.
 *
 * A row with a placeable instant always outranks one without — an unplaceable
 * row (only "TTM" reaches this, since every other label parses) cannot be
 * positioned, and GUESSING its position is the bug this replaces. Ties fall
 * back to a descending label compare so the order is total and deterministic.
 */
export function compareFinancialsNewestFirst(
  a: StoredFinancialsPeriodRow,
  b: StoredFinancialsPeriodRow,
): number {
  const ta = financialsPeriodTime(a);
  const tb = financialsPeriodTime(b);
  if (ta !== null && tb !== null && ta !== tb) return tb - ta;
  if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
  const pa = typeof a.period === "string" ? a.period : "";
  const pb = typeof b.period === "string" ? b.period : "";
  return pb.localeCompare(pa);
}

/** Newest-first COPY. Never mutates the caller's array. */
export function sortFinancialsNewestFirst<T extends StoredFinancialsPeriodRow>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(compareFinancialsNewestFirst);
}

/**
 * The newest row that is a real REPORTING PERIOD — TTM excluded.
 *
 * This is the row whose `fetchedAt` answers "is our copy of this company's
 * financials current". The TTM row cannot answer it: nothing refreshes it any
 * more, so its age says only that Tickertape stopped, never whether the filings
 * beside it are fresh. Returns `undefined` when every row is TTM.
 */
export function pickNewestPeriodicRow<T extends StoredFinancialsPeriodRow>(
  rows: readonly T[],
): T | undefined {
  let best: T | undefined;
  let bestAt: number | null = null;
  for (const row of rows) {
    if (isTtmPeriod(row.period)) continue;
    const at = financialsPeriodTime(row);
    if (best === undefined) {
      best = row;
      bestAt = at;
      continue;
    }
    if (at === null) continue;
    if (bestAt === null || at > bestAt) {
      best = row;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The BEST-ranked `source` present across a set of rows.
 *
 * Not "the source of the newest row", which is what this replaces. One frozen
 * TICKERTAPE row alongside fifteen fresh NSE_XBRL ones must not make the whole
 * payload announce itself as Tickertape — and it did, because the frozen row
 * was the one a lexicographic sort put first.
 *
 * This is honestly a BEST, not a uniform label: rows keep their own `source`
 * column through `groupFinancials` (which spreads the row's fields), so a
 * caller that needs per-period provenance still has it. Ranking is
 * `FINANCIALS_AUTHORITY`, the same order every writer guards on, with an
 * unknown source ranking LAST so a new upstream can never claim to be the best.
 */
export function authorityMaxSource(
  rows: readonly { source?: unknown }[],
): string {
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const raw = typeof row.source === "string" ? row.source.trim() : "";
    if (!raw) continue;
    const i = (FINANCIALS_AUTHORITY as readonly string[]).indexOf(raw);
    const rank = i === -1 ? FINANCIALS_AUTHORITY.length : i;
    if (rank < bestRank) {
      bestRank = rank;
      best = raw;
    }
  }
  // "UNKNOWN" rather than a plausible-looking default: a payload whose rows
  // carry no provenance must not be labelled with a provenance.
  return best ?? "UNKNOWN";
}

/**
 * How far behind the periodic rows a TTM row is allowed to be before it is
 * called out — 45 days.
 *
 * Not a round number chosen for looking tidy: SEBI LODR gives a listed company
 * 45 days after a quarter end to file its results. A TTM row more than one
 * filing window behind the periodic rows beside it therefore CANNOT contain the
 * newest quarter those rows contain, whatever it claims to be trailing.
 */
export const TTM_STALE_BEHIND_DAYS = 45;

/** What a stale TTM row is, once one has been found. */
export interface StaleTtmNotice {
  /** The row's label, verbatim, before it is re-badged. */
  period: string;
  /** ISO instant the TTM row was last refreshed. */
  asOf: string;
  /** Whole days by which it trails the newest periodic row. */
  behindDays: number;
}

/**
 * MONEY-1235 — is the TTM row frozen relative to the rows beside it?
 *
 * Deliberately a RELATIVE comparison against the newest periodic row's
 * `fetchedAt`, never against the wall clock. Two reasons:
 *
 *  - It is deterministic, so the test that pins it does not drift with the date.
 *  - "Old" is not the complaint. A three-month-old TTM sitting beside
 *    three-month-old annual rows is a company that has not filed, which is
 *    normal and must not be badged. The defect is a TTM that stopped moving
 *    while the rows beside it kept moving.
 *
 * Returns null — meaning "no claim" — whenever either side lacks a usable
 * `fetchedAt`. An undeterminable answer is not a clean bill of health, but it
 * is also not evidence of staleness, and manufacturing either would be worse
 * than saying nothing.
 */
export function describeStaleTtm(
  rows: readonly StoredFinancialsPeriodRow[],
  behindDays: number = TTM_STALE_BEHIND_DAYS,
): StaleTtmNotice | null {
  const ttm = rows.find((r) => isTtmPeriod(r.period));
  if (!ttm) return null;
  const ttmAt = toTime(ttm.fetchedAt);
  if (ttmAt === null) return null;

  const newest = pickNewestPeriodicRow(rows);
  const newestAt = newest ? toTime(newest.fetchedAt) : null;
  if (newestAt === null) return null;

  const behindMs = newestAt - ttmAt;
  if (behindMs <= behindDays * MS_PER_DAY) return null;
  return {
    period: typeof ttm.period === "string" ? ttm.period : "TTM",
    asOf: new Date(ttmAt).toISOString(),
    behindDays: Math.floor(behindMs / MS_PER_DAY),
  };
}

/**
 * Re-badge a frozen TTM label so the date travels WITH the number.
 *
 * `period` is what a research prompt renders as the column heading, so this is
 * the only channel by which "these figures stopped in March" reaches the model
 * at all — a structured field beside the row would be dropped by
 * `rowToStatement`'s allowlist and never read.
 *
 * READ PATH ONLY. `period` is part of `StockFinancials`' unique key, so a
 * re-badged row must never reach a writer. `getOrFetchFinancials` performs no
 * writes (pinned by packages/research/__tests__/tickertape-off-request-path
 * .test.ts), and the persisting path is `fetchFinancialsChain`, which does not
 * go through here.
 */
export function labelStaleTtmPeriod(period: string, asOf: string): string {
  const day = asOf.slice(0, 10);
  return day ? `${period} (as of ${day})` : period;
}

/** Apply {@link labelStaleTtmPeriod} plus structured markers to TTM rows. */
export function annotateStaleTtmRows<T extends { period: string }>(
  rows: readonly T[],
  notice: StaleTtmNotice,
): Array<T & { ttmStaleAsOf?: string; ttmBehindDays?: number }> {
  return rows.map((row) =>
    isTtmPeriod(row.period)
      ? {
          ...row,
          period: labelStaleTtmPeriod(row.period, notice.asOf),
          ttmStaleAsOf: notice.asOf,
          ttmBehindDays: notice.behindDays,
        }
      : row,
  );
}

/**
 * The instant a `StockRatios` row's DERIVED columns were last refreshed —
 * MONEY-1235.
 *
 * `xbrl-ratios-daily` stamps `ratiosDerivedAt` on every nightly derivation and
 * deliberately never touches `fetchedAt`, because `fetchedAt` is still the
 * honest age of the only two columns that job does NOT own: `targetPrice` and
 * `recommendation` are sell-side analyst opinion, nothing writes them any more,
 * and back-dating them to "today" because a margin was recomputed would be a
 * lie about the one number a reader is most likely to act on.
 *
 * So a reader asking "are these ratios current" must ask for the MAX of the two
 * clocks. Reading `fetchedAt` alone made `isStale(..., "ratios")` — a 24-hour
 * threshold — permanently true for every symbol on the platform, which is a
 * nightly log line saying "stale" about numbers derived hours earlier.
 */
export function latestRatiosTimestamp(row: {
  fetchedAt?: unknown;
  ratiosDerivedAt?: unknown;
}): Date | null {
  const fetched = toTime(row.fetchedAt);
  const derived = toTime(row.ratiosDerivedAt);
  if (fetched === null && derived === null) return null;
  return new Date(
    Math.max(
      fetched ?? Number.NEGATIVE_INFINITY,
      derived ?? Number.NEGATIVE_INFINITY,
    ),
  );
}
