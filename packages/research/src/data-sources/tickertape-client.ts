/**
 * Tickertape.in Data Client
 *
 * Tickertape has an unauthenticated JSON API with clean structured data.
 * Server-side calls bypass CORS. Rate-limited with 200ms delay between calls.
 *
 * Key endpoints:
 * - /search - stock search with real-time quotes
 * - /stocks/financials/income/{sid}/annual/normal - 5+ year income statement
 * - /stocks/financials/balancesheet/{sid}/annual/normal - balance sheet
 * - /stocks/financials/cashflow/{sid}/annual/normal - cash flow
 * - /stocks/peers/{sid} - peers with ratios
 * - /screener/query - 150+ filter screener
 */

import ky from "ky";
import { cacheWrap } from "./cache";
import {
  buildTickertapeRatiosQuery,
  mapTickertapeRatiosPayload,
  type TickertapeScreenerResponse,
} from "./tickertape-ratios-logic";

const logger = {
  warn: (...args: unknown[]) => console.warn("[tickertape]", ...args),
  debug: (..._args: unknown[]) => {},
};

// Use api.tickertape.in - www.tickertape.in blocks non-browser requests (404/403)
const BASE_URL = "https://api.tickertape.in";
const API_TIMEOUT_MS = 10_000;
const REQUEST_DELAY_MS = 300; // 300ms between calls (~3.3 req/sec)

/** Simple delay between requests */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry-aware fetch with exponential backoff on 502/429 */
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if ((status === 502 || status === 429) && attempt < maxRetries) {
        const backoff = (attempt + 1) * 3000; // 3s, 6s
        await delay(backoff);
        continue;
      }
      throw err;
    }
  }
  throw new Error("fetchWithRetry: exhausted retries");
}

// ── SID Resolution ─────────────────────────────────────────────────

// Cache: NSE symbol → Tickertape SID (survives for process lifetime)
const sidCache = new Map<string, string>();

/**
 * Resolve an NSE symbol to a Tickertape SID via search API.
 * Cached in Redis for 7 days (SIDs don't change).
 */
export async function resolveTickertapeSid(
  symbol: string,
): Promise<string | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  if (sidCache.has(clean)) return sidCache.get(clean)!;

  return cacheWrap(
    `tt:sid:${clean}`,
    async () => {
      return resolveTickertapeSidUncached(clean);
    },
    7 * 86400,
  ); // 7 day TTL
}

async function resolveTickertapeSidUncached(
  clean: string,
): Promise<string | null> {
  try {
    const resp = await fetchWithRetry(() =>
      ky
        .get(`${BASE_URL}/search`, {
          searchParams: { text: clean, types: "stock" },
          timeout: API_TIMEOUT_MS,
          headers: { Accept: "application/json" },
        })
        .json<{ data?: { stocks?: Array<{ sid: string; ticker: string }> } }>(),
    );

    const match = resp?.data?.stocks?.find(
      (s) => s.ticker.toUpperCase() === clean,
    );
    if (match) {
      sidCache.set(clean, match.sid);
      return match.sid;
    }

    // Fallback: first result
    const first = resp?.data?.stocks?.[0];
    if (first) {
      sidCache.set(clean, first.sid);
      return first.sid;
    }

    return null;
  } catch (error: unknown) {
    // Suppress verbose logging for expected 404s (invalid symbols)
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) {
      logger.debug({ symbol: clean }, "Tickertape SID not found (404)");
    } else {
      logger.warn(
        { symbol: clean, status },
        "Tickertape SID resolution failed",
      );
    }
    return null;
  }
}

// ── Financial Data ─────────────────────────────────────────────────

export interface TickertapeFinancialRow {
  period: string;
  [key: string]: unknown;
}

export interface TickertapeFinancials {
  income: TickertapeFinancialRow[];
  balanceSheet: TickertapeFinancialRow[];
  cashFlow: TickertapeFinancialRow[];
}

/**
 * Fetch financial statements (income, balance sheet, cash flow) for a stock.
 * Cached in Redis for 24h (financials change quarterly).
 */
export async function fetchTickertapeFinancials(
  symbol: string,
): Promise<TickertapeFinancials | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  return cacheWrap(
    `tt:fin:${clean}`,
    async () => {
      const sid = await resolveTickertapeSid(symbol);
      if (!sid) return null;

      try {
        const [income, balance, cashflow] = await Promise.all([
          fetchFinancialStatement(sid, "income"),
          fetchFinancialStatement(sid, "balancesheet"),
          fetchFinancialStatement(sid, "cashflow"),
        ]);

        return {
          income: income ?? [],
          balanceSheet: balance ?? [],
          cashFlow: cashflow ?? [],
        };
      } catch (error) {
        logger.warn(
          { symbol, sid, error },
          "Tickertape financials fetch failed",
        );
        return null;
      }
    },
    365 * 86400,
  ); // 1 year TTL - historical financials are immutable
}

async function fetchFinancialStatement(
  sid: string,
  type: "income" | "balancesheet" | "cashflow",
): Promise<TickertapeFinancialRow[] | null> {
  await delay(REQUEST_DELAY_MS);
  try {
    const resp = await ky
      .get(`${BASE_URL}/stocks/financials/${type}/${sid}/annual/normal`, {
        timeout: API_TIMEOUT_MS,
        headers: { Accept: "application/json" },
      })
      .json<{ data?: Array<Record<string, unknown>> }>();

    if (!resp?.data || !Array.isArray(resp.data)) return null;
    return resp.data as TickertapeFinancialRow[];
  } catch {
    return null;
  }
}

// ── Peer Data ──────────────────────────────────────────────────────

export interface TickertapePeer {
  name: string;
  ticker: string;
  sid: string;
  marketCap?: number;
  pe?: number;
  pb?: number;
  roe?: number;
  [key: string]: unknown;
}

/**
 * Fetch peer companies for a stock.
 * Cached in Redis for 24h.
 */
export async function fetchTickertapePeers(
  symbol: string,
): Promise<TickertapePeer[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  return cacheWrap(
    `tt:peers:${clean}`,
    async () => {
      const sid = await resolveTickertapeSid(symbol);
      if (!sid) return null;

      await delay(REQUEST_DELAY_MS);
      try {
        const resp = await ky
          .get(`${BASE_URL}/stocks/peers/${sid}`, {
            searchParams: { tab: "valuation" },
            timeout: API_TIMEOUT_MS,
            headers: { Accept: "application/json" },
          })
          .json<{ data?: { peers?: TickertapePeer[] } }>();

        return resp?.data?.peers ?? null;
      } catch (error) {
        logger.warn({ symbol, sid, error }, "Tickertape peers fetch failed");
        return null;
      }
    },
    365 * 86400,
  ); // 1 year TTL - peer data is historical
}

// ── Stock Screener ─────────────────────────────────────────────────

export interface ScreenerFilter {
  [metric: string]: { g?: number; l?: number; eq?: number };
}

export interface ScreenerResult {
  sid: string;
  ticker: string;
  name: string;
  [key: string]: unknown;
}

/**
 * Run a stock screener query with Tickertape's 150+ filters.
 *
 * Example filters:
 * { mrktCapf: { g: 100000 }, roe: { g: 15 }, pe: { l: 25 } }
 */
export async function screenStocksTickertape(
  filters: ScreenerFilter,
  limit = 50,
): Promise<ScreenerResult[]> {
  try {
    const resp = await ky
      .post(`${BASE_URL}/screener/query`, {
        json: {
          match: filters,
          sortBy: "mrktCapf",
          sortOrder: -1,
          project: [
            "ticker",
            "name",
            "mrktCapf",
            "pe",
            "pb",
            "roe",
            "roce",
            "divYield",
            "debt2Eq",
            "revGrwAn",
            "netPftGrw",
          ],
          offset: 0,
          count: limit,
        },
        timeout: API_TIMEOUT_MS,
        headers: { Accept: "application/json" },
      })
      .json<{ data?: { result?: ScreenerResult[] } }>();

    return resp?.data?.result ?? [];
  } catch (error) {
    logger.warn({ filters, error }, "Tickertape screener query failed");
    return [];
  }
}

// ── Quick Quote ────────────────────────────────────────────────────

export interface TickertapeQuote {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  marketCap?: number;
  [key: string]: unknown;
}

/**
 * Fetch a quick quote for a stock via search API (includes real-time price).
 */
export async function fetchTickertapeQuote(
  symbol: string,
): Promise<TickertapeQuote | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  try {
    const resp = await ky
      .get(`${BASE_URL}/search`, {
        searchParams: { text: clean, types: "stock" },
        timeout: API_TIMEOUT_MS,
        headers: { Accept: "application/json" },
      })
      .json<{
        data?: {
          stocks?: Array<{
            ticker: string;
            name: string;
            price?: number;
            change?: number;
            pChange?: number;
            marketCap?: number;
            [key: string]: unknown;
          }>;
        };
      }>();

    const match = resp?.data?.stocks?.find(
      (s) => s.ticker.toUpperCase() === clean,
    );
    if (!match) return null;

    return {
      ticker: match.ticker,
      name: match.name,
      price: match.price ?? 0,
      change: match.change ?? 0,
      changePercent: match.pChange ?? 0,
      marketCap: match.marketCap,
    };
  } catch {
    return null;
  }
}

// ── Stock Ratios (via screener single-stock query) ───────────────

/**
 * MONEY-1205 — every ratio is `number | null` and OPTIONAL, and the three
 * states are distinct: absent (the endpoint did not return the field), `null`
 * (the endpoint reported it unavailable — HDFC Bank has no meaningful current
 * ratio) and a finite number, `0` included.
 *
 * The fields that used to be declared here but are NOT in
 * `TICKERTAPE_RATIO_WIRE_KEYS` (`pegRatio`, `grossMargin`, `operatingMargin`,
 * `earningsGrowth`, `targetPrice`, `recommendation`, …) are gone from the
 * interface rather than left as never-populated optionals: declaring a field
 * this client cannot produce is what let 20 invented projection names survive
 * review. See `TICKERTAPE_RATIO_UNMAPPED` for each one's reason.
 */
export interface TickertapeStockRatios {
  ticker: string;
  name: string;
  pe?: number | null;
  pb?: number | null;
  roe?: number | null;
  roa?: number | null;
  roce?: number | null;
  evToEbitda?: number | null;
  netMargin?: number | null;
  revenueGrowth?: number | null;
  revenueGrowth5Y?: number | null;
  debtToEquity?: number | null;
  currentRatio?: number | null;
  interestCoverage?: number | null;
  beta?: number | null;
  divYield?: number | null;
  mCap?: number | null;
  enterpriseValue?: number | null;
  [key: string]: unknown;
}

/**
 * Fetch all ratio fields for a single stock via the screener API.
 *
 * MONEY-1205 — the request shape and the response mapping both live in
 * `tickertape-ratios-logic.ts` so they can be asserted against a CAPTURED
 * response. Both were wrong here, and neither was reachable by a test while
 * they sat inside this closure:
 *
 *   - the body filtered on `match: { sid: { values: [sid] } }`, which this
 *     endpoint does not understand. It returned the EMPTY SET for every symbol,
 *     so this function returned null on every call and `syncRatios`
 *     early-returned — `ratios-sync-daily` had written nothing since the query
 *     was introduced (prod's newest `stock_ratios.updatedAt`: 2026-03-21).
 *   - 20 of the 27 projected field names did not exist upstream, and an unknown
 *     projection is dropped SILENTLY, so even a working query would have filled
 *     7 columns and left 20 unresolved.
 *
 * Returns null when nothing was learned; callers treat that as "do not write",
 * which is what keeps a bad fetch from clearing a live ratio set.
 */
export async function fetchTickertapeStockRatios(
  sid: string,
): Promise<TickertapeStockRatios | null> {
  return cacheWrap(
    `tt:ratios:${sid}`,
    async () => {
      try {
        await delay(REQUEST_DELAY_MS);

        const resp = await fetchWithRetry(() =>
          ky
            .post(`${BASE_URL}/screener/query`, {
              json: buildTickertapeRatiosQuery(sid),
              timeout: API_TIMEOUT_MS,
              headers: { Accept: "application/json" },
            })
            .json<TickertapeScreenerResponse>(),
        );

        return mapTickertapeRatiosPayload(
          sid,
          resp,
        ) as TickertapeStockRatios | null;
      } catch (error) {
        logger.warn({ sid, error }, "Tickertape stock ratios fetch failed");
        return null;
      }
    },
    3600, // 1 hour cache
  );
}

// ── Shareholding Data ────────────────────────────────────────────

export interface TickertapeShareholding {
  /**
   * MONEY-1205 — these are `| null` because an ABSENT holding is not a zero
   * holding. They used to be mapped with `?? 0`, which turned "Tickertape did
   * not report an FII stake" into "FIIs own 0.00% of this company" — a claim
   * the feed never made, indistinguishable downstream from a real zero.
   *
   * Core's `TickertapeShareholdingRow` has always accepted `number | null`
   * here, so nothing downstream needed widening; the fabrication happened in
   * this mapper, before core ever saw the row.
   */
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  public: number | null;
  quarter: string;
}

/**
 * Map Tickertape's shareholding payload into rows, WITHOUT inventing data.
 *
 * Exported so the absence rules below can be tested directly. Note what this
 * function deliberately does NOT settle: which key carries the quarter label.
 * The sibling income endpoint on this same API keys its period as
 * `displayPeriod`, not `period` — established from a captured fixture — so both
 * spellings are accepted and neither is asserted anywhere. Settling that
 * question requires a captured shareholding fixture, which does not exist yet;
 * inventing one would only prove this mapper self-consistent.
 */
export function mapTickertapeShareholdingRows(
  data: ReadonlyArray<Record<string, unknown>>,
): TickertapeShareholding[] | null {
  // MONEY-1205 — two fabrications used to happen here, and together they
  // starved the fallback.
  //
  // 1. `?? 0` on each holding invented a zero the feed never reported.
  // 2. `(row.period as string) ?? ""` invented an empty quarter label.
  //
  // Why it mattered: `fetchShareholdingChain` runs Tickertape -> Screener
  // through `tryChain`, which returns the FIRST NON-NULL result. A successful
  // HTTP call that produced label-less, zero-filled rows was still a non-null
  // array, so it WON the chain and Screener never ran. The failure was
  // invisible — a populated-looking response carrying no information.
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const rows = data
    .map((row) => {
      const rawQuarter = row.period ?? row.displayPeriod;
      const quarter = typeof rawQuarter === "string" ? rawQuarter.trim() : "";
      return {
        promoter: num(row.prmotrHldng),
        fii: num(row.fiiHldng),
        dii: num(row.diiHldng),
        public: num(row.publicHldng),
        quarter,
      };
    })
    // A row with no quarter cannot be placed on a timeline, and a row with no
    // holding at all carries nothing to place. Either way it is not a data
    // point, and emitting it only hides that we have none.
    .filter(
      (r) =>
        r.quarter.length > 0 &&
        (r.promoter !== null ||
          r.fii !== null ||
          r.dii !== null ||
          r.public !== null),
    );

  return rows.length > 0 ? rows : null;
}

export async function fetchTickertapeShareholding(
  symbol: string,
): Promise<TickertapeShareholding[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  return cacheWrap(
    `tt:shr:${clean}`,
    async () => {
      const sid = await resolveTickertapeSid(symbol);
      if (!sid) return null;
      await delay(REQUEST_DELAY_MS);
      try {
        const resp = await ky
          .get(`${BASE_URL}/stocks/shareholding/${sid}`, {
            timeout: API_TIMEOUT_MS,
            headers: { Accept: "application/json" },
          })
          .json<{ data?: Array<Record<string, unknown>> }>();
        if (!resp?.data?.length) return null;
        return mapTickertapeShareholdingRows(resp.data);
      } catch {
        return null;
      }
    },
    86400,
  );
}

// ── Quarterly Results ────────────────────────────────────────────

/**
 * ONE interim (quarterly) income row, VERBATIM off the wire — MONEY-1205.
 *
 * This used to be a hand-mapped `{period, revenue, netProfit, eps,
 * operatingProfit}`, and **not one of those five keys exists on the endpoint.**
 * `/stocks/financials/income/{sid}/interim/normal` returns
 * `{displayPeriod, endDate, reporting, qIncTrev, qIncRaw, qIncPfc, qIncEpc,
 * qIncSga, qIncOpe, qIncEbi, qIncDep, qIncPbi, qIncIoi, qIncPbt, qIncToi,
 * qIncNinc, qIncEps, qIncDps, qIncPyr}` — captured verbatim in
 * `packages/research/__tests__/fixtures/tickertape-interim-income-HDBK.json`.
 *
 * The old mapper therefore produced `{period: "", revenue: undefined, …}` for
 * every real row, and every consumer's `if (!period)` guard dropped it. Prod
 * holds **0 QUARTERLY `StockFinancials` rows platform-wide** as a result.
 *
 * It is now a passthrough on purpose. A mapping layer here was pure loss: it
 * added a second place for the key map to be wrong, it discarded `endDate`
 * (the only sortable period key) and `qIncEbi` (EBITDA) outright, and it made
 * the shape consumers test against something no upstream ever emits — which is
 * exactly what let a unit test stay green through all of it. Mapping is
 * `mapTickertapeStatementRow(…, "QUARTERLY")` in `db-store-logic.ts`, once.
 */
export interface TickertapeQuarterlyResult {
  /** Period LABEL, e.g. "JUN 2026". There is no `period` key on this feed. */
  displayPeriod?: string;
  /** ISO end-of-quarter. Present on every interim row. */
  endDate?: string;
  /** "consolidated" | "standalone". */
  reporting?: string;
  /** Total revenue, ₹ crore. */
  qIncTrev?: number | null;
  /** EBITDA, ₹ crore. */
  qIncEbi?: number | null;
  /** EBIT / operating income, ₹ crore. `qIncEbi − qIncDep = qIncPbi`. */
  qIncPbi?: number | null;
  /** Net income, ₹ crore. `qIncPbt − qIncToi = qIncNinc`. */
  qIncNinc?: number | null;
  /** TAX — not "total other income". Proven by the identity above. */
  qIncToi?: number | null;
  /** INTEREST / finance cost — not "interest and other income". */
  qIncIoi?: number | null;
}
//
// NOTE: deliberately NO `[key: string]: unknown` index signature. It reads as
// harmless documentation of "the feed may add fields", but it makes this type
// structurally incompatible with `ScreenerQuarterlyResult` in
// `fetchQuarterlyResultsChain`'s return union (TS2322: "Index signature for
// type 'string' is missing"). The extra keys are all still present at RUNTIME —
// this is a verbatim passthrough — and the mapper that consumes them takes a
// `Record<string, unknown>`, so nothing needs them declared here.

export async function fetchTickertapeQuarterlyResults(
  symbol: string,
): Promise<TickertapeQuarterlyResult[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  return cacheWrap(
    `tt:qtr:${clean}`,
    async () => {
      const sid = await resolveTickertapeSid(symbol);
      if (!sid) return null;
      await delay(REQUEST_DELAY_MS);
      try {
        const resp = await ky
          .get(`${BASE_URL}/stocks/financials/income/${sid}/interim/normal`, {
            timeout: API_TIMEOUT_MS,
            headers: { Accept: "application/json" },
          })
          .json<{ data?: Array<Record<string, unknown>> }>();
        if (!resp?.data?.length) {
          logger.debug(
            { symbol: clean, sid },
            "Tickertape quarterly income returned empty",
          );
          return null;
        }
        // Verbatim. See `TickertapeQuarterlyResult` — the previous five-key
        // hand-map read `period` / `revenuef` / `netPftf` / `eps` / `operPftf`,
        // and the endpoint emits none of them.
        return resp.data as TickertapeQuarterlyResult[];
      } catch (err) {
        // MONEY-672: was a silent `return null` → empty earnings with no signal.
        // Log so an empty earnings fetch is diagnosable on QA after deploy.
        logger.warn(
          { symbol: clean, sid, err: String(err) },
          "Tickertape quarterly income fetch failed",
        );
        return null;
      }
    },
    86400,
  );
}
