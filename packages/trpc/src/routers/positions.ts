/**
 * Positions Router
 *
 * tRPC procedures for positions management.
 *
 * MONEY-1062: every procedure below is an unimplemented stub — it throws
 * `NOT_IMPLEMENTED` (via `notImplemented`) and names the REST `/v1` route that
 * actually serves the data. The input schema + row shape (`positionSchema`) are
 * kept intact for a future real implementation.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../server/trpc";
import { notImplemented } from "./not-implemented";

/**
 * Position schema for validation. Kept as the intended output row shape for a
 * future real implementation (exported as {@link Position}).
 */
const positionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  tradingSymbol: z.string(),
  exchange: z.string(),
  segment: z.string(),
  productType: z.string(),
  positionType: z.enum(["DAY", "NET"]),
  quantity: z.number(),
  buyQuantity: z.number(),
  sellQuantity: z.number(),
  buyPrice: z.number(),
  sellPrice: z.number(),
  averagePrice: z.number(),
  lastPrice: z.number().optional(),
  pnl: z.number(),
  m2m: z.number().optional(),
  realizedPnl: z.number().optional(),
  unrealizedPnl: z.number().optional(),
  broker: z.string().optional(),
  brokerUserId: z.string().optional(),
});

/** Intended output row shape (unused until the procedures are implemented). */
export type Position = z.infer<typeof positionSchema>;

/**
 * Positions query input schema
 */
const listPositionsInput = z.object({
  broker: z.string().optional(),
  positionType: z.enum(["DAY", "NET"]).optional(),
  segment: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(50),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const positionsRouter = router({
  /**
   * Get all positions for authenticated user — NOT IMPLEMENTED.
   * Use `GET /v1/positions`.
   */
  list: protectedProcedure
    .input(listPositionsInput)
    .query(() => notImplemented("GET /v1/positions")),

  /**
   * Get a single position by ID — NOT IMPLEMENTED. Use `GET /v1/positions`.
   */
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(() => notImplemented("GET /v1/positions")),

  /**
   * Get positions by symbol — NOT IMPLEMENTED. Use `GET /v1/positions?symbol=…`.
   */
  bySymbol: protectedProcedure
    .input(
      z.object({
        symbol: z.string(),
        positionType: z.enum(["DAY", "NET"]).optional(),
      }),
    )
    .query(() => notImplemented("GET /v1/positions?symbol=…")),

  /**
   * Get positions summary — NOT IMPLEMENTED. Use `GET /v1/positions/summary`.
   */
  summary: protectedProcedure.query(() =>
    notImplemented("GET /v1/positions/summary"),
  ),
});

export type PositionsRouter = typeof positionsRouter;
