/**
 * Screener Routes (MONEY-1062 P4c — discovery-power parity)
 *
 * Thin Hono wrappers over @usemoney/services screener.service — the faithful
 * ports of the apps/web screener actions:
 *
 *   POST /v1/screener/stocks  ← screenStocksAction (apps/web lib/actions/screener.ts:290)
 *   POST /v1/screener/mfs     ← screenMfsAction    (apps/web lib/actions/screener.ts:927)
 *   POST /v1/screener/etfs    ← screenEtfsAction   (apps/web lib/actions/screener.ts:1044)
 *
 * POST (not GET) because the payload is the same structured `{ filters, query,
 * page, pageSize, sort }` object the web action receives as arguments — the
 * filter bag has ~15 optional keys per mode and an array member (amcAny).
 *
 * SCOPING: screener data is GLOBAL market data — the /v1 Bearer middleware
 * applies but NO userId is passed (mirrors the web action: no plan gate).
 *
 * BOUNDING: every string/array is zod-capped and every number must be FINITE —
 * `JSON.parse("1e999")` yields Infinity, which would otherwise poison the
 * Mongo `gte`/`lte` bands. Unknown filter keys are stripped by zod, so only
 * the engine's known bands ever reach the service (same effective surface the
 * web action reads). page/pageSize mirror the service's own 0-base / 200-cap.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
} from "../../lib/response";
import { screenStocks, screenMfs, screenEtfs } from "@usemoney/services";

const screenerRoutes = new Hono<AppContext>();

const MAX_QUERY_LEN = 120;
const MAX_NAME_LEN = 80;
const MAX_TAXONOMY_LEN = 64;
const MAX_INDEX_LEN = 40;
const MAX_AMC_ANY = 20;
const MAX_PAGE = 100_000;
const MAX_PAGE_SIZE = 200;

/** Finite-only number — rejects the Infinity that JSON.parse("1e999") emits. */
const finiteNum = z.number().finite();

const StockSortSchema = z.enum([
  "match",
  "mcap-desc",
  "mcap-asc",
  "change-desc",
  "change-asc",
  "name-asc",
  "name-desc",
]);

const FundSortSchema = z.enum([
  "match",
  "nav-desc",
  "nav-asc",
  "aum-desc",
  "ret1y-desc",
  "ret3y-desc",
  "ret5y-desc",
]);

/** Shared paging keys (query text + 0-indexed page + capped pageSize). */
const pagingShape = {
  query: z.string().max(MAX_QUERY_LEN).optional(),
  page: z.number().int().min(0).max(MAX_PAGE).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
} as const;

// ── Stocks (mirrors ScreenFilters) ───────────────────────────────────

const StockFiltersSchema = z.object({
  exchange: z.enum(["NSE", "BSE"]).optional(),
  sector: z.string().min(1).max(MAX_TAXONOMY_LEN).optional(),
  marketCapBucket: z.enum(["LARGE", "MID", "SMALL"]).optional(),
  minMarketCap: finiteNum.optional(),
  maxMarketCap: finiteNum.optional(),
  minPe: finiteNum.optional(),
  maxPe: finiteNum.optional(),
  minRoe: finiteNum.optional(),
  maxRoe: finiteNum.optional(),
  minRevenueGrowth: finiteNum.optional(),
  maxRevenueGrowth: finiteNum.optional(),
  minDebtToEquity: finiteNum.optional(),
  maxDebtToEquity: finiteNum.optional(),
  minDividendYield: finiteNum.optional(),
  maxDividendYield: finiteNum.optional(),
  index: z.string().min(1).max(MAX_INDEX_LEN).optional(),
});

const StocksBodySchema = z.object({
  filters: StockFiltersSchema.default({}),
  sort: StockSortSchema.optional(),
  ...pagingShape,
});

// ── Mutual funds (mirrors MfScreenFilters) ───────────────────────────

const MfFiltersSchema = z.object({
  category: z.string().min(1).max(MAX_TAXONOMY_LEN).optional(),
  amcName: z.string().min(1).max(MAX_NAME_LEN).optional(),
  amcAny: z
    .array(z.string().min(1).max(MAX_NAME_LEN))
    .max(MAX_AMC_ANY)
    .optional(),
  plan: z.enum(["DIRECT", "REGULAR"]).optional(),
  riskLevel: z.string().min(1).max(32).optional(),
  fundType: z.string().min(1).max(32).optional(),
  minAum: finiteNum.optional(),
  maxAum: finiteNum.optional(),
  minReturns1Y: finiteNum.optional(),
  maxReturns1Y: finiteNum.optional(),
  minReturns3Y: finiteNum.optional(),
  maxReturns3Y: finiteNum.optional(),
  minReturns5Y: finiteNum.optional(),
  maxReturns5Y: finiteNum.optional(),
  minExpenseRatio: finiteNum.optional(),
  maxExpenseRatio: finiteNum.optional(),
});

const MfsBodySchema = z.object({
  filters: MfFiltersSchema.default({}),
  sort: FundSortSchema.optional(),
  ...pagingShape,
});

// ── ETFs (mirrors EtfScreenFilters) ──────────────────────────────────

const EtfFiltersSchema = z.object({
  exchange: z.enum(["NSE", "BSE"]).optional(),
  assetClass: z.string().min(1).max(32).optional(),
  theme: z.string().min(1).max(MAX_TAXONOMY_LEN).optional(),
  amcName: z.string().min(1).max(MAX_NAME_LEN).optional(),
  category: z.string().min(1).max(MAX_TAXONOMY_LEN).optional(),
  minAum: finiteNum.optional(),
  maxAum: finiteNum.optional(),
  minReturns1Y: finiteNum.optional(),
  maxReturns1Y: finiteNum.optional(),
  minExpenseRatio: finiteNum.optional(),
  maxExpenseRatio: finiteNum.optional(),
});

const EtfsBodySchema = z.object({
  filters: EtfFiltersSchema.default({}),
  sort: FundSortSchema.optional(),
  ...pagingShape,
});

/**
 * POST /v1/screener/stocks
 * Body { filters?, query?, page?, pageSize?, sort? } → PagedResult<ScreenResult>.
 */
screenerRoutes.post("/stocks", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(StocksBodySchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid screener payload",
        parsed.issues,
      ),
      400,
    );
  }

  try {
    const { filters, query, page, pageSize, sort } = parsed.data;
    const result = await screenStocks(filters, query, { page, pageSize, sort });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Screener stocks error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to run screener"),
      500,
    );
  }
});

/**
 * POST /v1/screener/mfs
 * Body { filters?, query?, page?, pageSize?, sort? } → PagedResult<MfScreenResult>.
 */
screenerRoutes.post("/mfs", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(MfsBodySchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid screener payload",
        parsed.issues,
      ),
      400,
    );
  }

  try {
    const { filters, query, page, pageSize, sort } = parsed.data;
    const result = await screenMfs(filters, query, { page, pageSize, sort });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Screener MFs error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to run mutual fund screener"),
      500,
    );
  }
});

/**
 * POST /v1/screener/etfs
 * Body { filters?, query?, page?, pageSize?, sort? } → PagedResult<EtfScreenResult>.
 */
screenerRoutes.post("/etfs", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(EtfsBodySchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid screener payload",
        parsed.issues,
      ),
      400,
    );
  }

  try {
    const { filters, query, page, pageSize, sort } = parsed.data;
    const result = await screenEtfs(filters, query, { page, pageSize, sort });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Screener ETFs error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to run ETF screener"),
      500,
    );
  }
});

export default screenerRoutes;
