/**
 * Holdings Router
 *
 * tRPC procedures for holdings management.
 *
 * MONEY-1062: every procedure below is an unimplemented stub — it throws
 * `NOT_IMPLEMENTED` (via `notImplemented`) and names the REST `/v1` route that
 * actually serves the data. The input schema + row shape (`holdingSchema`) are
 * kept intact for a future real implementation.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../server/trpc";
import { notImplemented } from "./not-implemented";

/**
 * Holding schema for validation. Kept as the intended output row shape for a
 * future real implementation (exported as {@link Holding}).
 */
const holdingSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  tradingSymbol: z.string(),
  name: z.string().optional(),
  exchange: z.string(),
  segment: z.string().optional(),
  quantity: z.number(),
  averagePrice: z.number(),
  currentPrice: z.number().optional(),
  investedValue: z.number(),
  currentValue: z.number().optional(),
  pnl: z.number().optional(),
  pnlPercentage: z.number().optional(),
  dayChange: z.number().optional(),
  dayChangePercentage: z.number().optional(),
  broker: z.string().optional(),
  brokerUserId: z.string().optional(),
});

/** Intended output row shape (unused until the procedures are implemented). */
export type Holding = z.infer<typeof holdingSchema>;

/**
 * Holdings query input schema
 */
const listHoldingsInput = z.object({
  broker: z.string().optional(),
  segment: z.enum(["EQUITY", "DERIVATIVES", "MUTUAL_FUND"]).optional(),
  exchange: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(50),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const holdingsRouter = router({
  /**
   * Get all holdings for authenticated user — NOT IMPLEMENTED.
   * Use `GET /v1/holdings`.
   */
  list: protectedProcedure
    .input(listHoldingsInput)
    .query(() => notImplemented("GET /v1/holdings")),

  /**
   * Get a single holding by ID — NOT IMPLEMENTED. Use `GET /v1/holdings`.
   */
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(() => notImplemented("GET /v1/holdings")),

  /**
   * Get holdings by symbol — NOT IMPLEMENTED. Use `GET /v1/holdings?symbol=…`.
   */
  bySymbol: protectedProcedure
    .input(z.object({ symbol: z.string(), exchange: z.string().optional() }))
    .query(() => notImplemented("GET /v1/holdings?symbol=…")),

  /**
   * Get holdings summary — NOT IMPLEMENTED. Use `GET /v1/holdings/summary`.
   */
  summary: protectedProcedure.query(() =>
    notImplemented("GET /v1/holdings/summary"),
  ),
});

export type HoldingsRouter = typeof holdingsRouter;
