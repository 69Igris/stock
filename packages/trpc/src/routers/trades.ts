/**
 * Trades Router
 *
 * tRPC procedures for trades management.
 *
 * MONEY-1062: every procedure below is an unimplemented stub — it throws
 * `NOT_IMPLEMENTED` (via `notImplemented`) and names the REST `/v1` route that
 * actually serves the data. This replaced fabricated stubs — notably
 * `create` (returned `{ id: "", ...input }`) and `delete` (returned
 * `{ success: true }` while deleting nothing). The input schemas + row shapes
 * are kept intact for a future real implementation.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../server/trpc";
import { notImplemented } from "./not-implemented";

/**
 * Trade schema for validation. Kept as the intended output row shape for a
 * future real implementation (exported as {@link Trade}).
 */
const tradeSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  tradingSymbol: z.string(),
  exchange: z.string(),
  segment: z.string().optional(),
  tradeType: z.enum(["BUY", "SELL"]),
  productType: z.string(),
  quantity: z.number(),
  price: z.number(),
  value: z.number(),
  tradeDate: z.date(),
  tradeTime: z.date(),
  orderId: z.string().optional(),
  tradeId: z.string().optional(),
  broker: z.string().optional(),
  brokerUserId: z.string().optional(),
  sourceType: z.enum(["SYNCED", "IMPORTED", "MANUAL"]).optional(),
});

/** Intended output row shape (unused until the procedures are implemented). */
export type Trade = z.infer<typeof tradeSchema>;

/**
 * Trades query input schema
 */
const listTradesInput = z.object({
  broker: z.string().optional(),
  tradeType: z.enum(["BUY", "SELL"]).optional(),
  segment: z.string().optional(),
  symbol: z.string().optional(),
  from: z.date().optional(),
  to: z.date().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(50),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

/**
 * Paired trade schema. Kept as the intended output row shape for a future real
 * implementation (exported as {@link PairedTrade}).
 */
const pairedTradeSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  exchange: z.string(),
  segment: z.string(),
  entryDate: z.date(),
  entryPrice: z.number(),
  entryQuantity: z.number(),
  exitDate: z.date().optional(),
  exitPrice: z.number().optional(),
  quantity: z.number(),
  realizedPnL: z.number().optional(),
  pnlPercentage: z.number().optional(),
  status: z.enum(["OPEN", "CLOSED", "PARTIAL"]),
  broker: z.string().optional(),
  brokerUserId: z.string().optional(),
});

/** Intended paired-trade output row shape (unused until implemented). */
export type PairedTrade = z.infer<typeof pairedTradeSchema>;

export const tradesRouter = router({
  /**
   * Get all trades for authenticated user — NOT IMPLEMENTED.
   * Use `GET /v1/trades`.
   */
  list: protectedProcedure
    .input(listTradesInput)
    .query(() => notImplemented("GET /v1/trades")),

  /**
   * Get a single trade by ID — NOT IMPLEMENTED. Use `GET /v1/trades`.
   */
  byId: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(() => notImplemented("GET /v1/trades")),

  /**
   * Get paired trades (entry/exit view) — NOT IMPLEMENTED. Use `GET /v1/paired`.
   */
  paired: protectedProcedure
    .input(
      z.object({
        broker: z.string().optional(),
        status: z.enum(["OPEN", "CLOSED", "PARTIAL"]).optional(),
        symbol: z.string().optional(),
        from: z.date().optional(),
        to: z.date().optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(50),
        sortBy: z.string().optional(),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
      }),
    )
    .query(() => notImplemented("GET /v1/paired")),

  /**
   * Get trades summary — NOT IMPLEMENTED. Use `GET /v1/dashboard`
   * (portfolio + trading aggregates).
   */
  summary: protectedProcedure
    .input(
      z.object({
        from: z.date().optional(),
        to: z.date().optional(),
      }),
    )
    .query(() => notImplemented("GET /v1/dashboard")),

  /**
   * Create a manual trade — NOT IMPLEMENTED. Use `POST /v1/trades`.
   *
   * (Previously returned a fabricated `{ id: "", ...input }` with no
   * persistence — MONEY-1062.)
   */
  create: protectedProcedure
    .input(
      z.object({
        symbol: z.string(),
        tradingSymbol: z.string(),
        exchange: z.string(),
        segment: z.string().optional(),
        tradeType: z.enum(["BUY", "SELL"]),
        productType: z.string(),
        quantity: z.number().positive(),
        price: z.number().positive(),
        tradeDate: z.date(),
        tradeTime: z.date().optional(),
      }),
    )
    .mutation(() => notImplemented("POST /v1/trades")),

  /**
   * Update a manual trade — NOT IMPLEMENTED. Use `PUT /v1/trades/:id`.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        quantity: z.number().positive().optional(),
        price: z.number().positive().optional(),
        tradeDate: z.date().optional(),
      }),
    )
    .mutation(() => notImplemented("PUT /v1/trades/:id")),

  /**
   * Delete a manual trade — NOT IMPLEMENTED. Use `DELETE /v1/trades/:id`.
   *
   * (Previously returned `{ success: true }` while deleting nothing —
   * MONEY-1062.)
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(() => notImplemented("DELETE /v1/trades/:id")),
});

export type TradesRouter = typeof tradesRouter;
