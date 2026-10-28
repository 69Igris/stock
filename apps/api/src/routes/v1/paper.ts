/**
 * Paper Trading Routes
 *
 * `/v1/paper` exposes BOTH paper-trading models (MONEY-1062 P3a, parity D2):
 *
 *   1. LEGACY position model (KEPT, unchanged) — `getPaperPortfolio` /
 *      `createPaperTrade` / `closePaperTrade` / `deletePaperTrade`:
 *        GET  /            list positions + summary
 *        POST /            create a paper trade (buy)
 *        POST /:id/close   close a paper trade (sell)
 *        DELETE /:id       delete a paper trade
 *
 *   2. ORDER / CASH-PORTFOLIO model (ADDITIVE) — the model the LIVE web UI
 *      (apps/web/app/paper-trading) uses, ported into
 *      `paper-portfolio.service` so mobile gets the same product as web:
 *        GET  /portfolio   get-or-create the cash portfolio
 *        POST /orders      place an order (cash-checked buy / sell)
 *        GET  /orders      recent orders (newest first, ?limit / ?status)
 *        GET  /performance closed-trade performance summary
 *        GET  /dashboard   portfolio + position totals + performance
 *        POST /reset       reset cash + close all positions
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
import { parseLimit } from "./pagination";
import { PlaceOrderSchema } from "@usemoney/validation";
import {
  getPaperPortfolio,
  createPaperTrade,
  closePaperTrade,
  deletePaperTrade,
  getOrCreatePaperPortfolio,
  placePaperOrder,
  getPaperOrders,
  getPaperPerformance,
  getPaperDashboardStats,
  resetPaperPortfolio,
} from "@usemoney/services";

const paperRoutes = new Hono<AppContext>();

/**
 * Create-paper-trade body schema. Mirrors `CreatePaperTradeInput`; the money
 * fields are guarded so a non-finite / non-positive `quantity`/`averagePrice`
 * (the entry price) is rejected with a 400 instead of writing a junk row (the
 * service also finite-hardens, but a raw client deserves a real validation
 * error, not a silently-zeroed position).
 */
const CreatePaperTradeSchema = z.object({
  symbol: z.string().min(1, "Symbol is required"),
  assetType: z.string().optional(),
  segment: z.string().optional(),
  exchange: z.string().optional(),
  positionType: z.string().optional(),
  quantity: z.number().positive("Quantity must be positive").finite(),
  lotSize: z.number().optional(),
  averagePrice: z.number().positive("Average price must be positive").finite(),
  investedValue: z.number().finite(),
  currentPrice: z.number().finite().optional(),
  currentValue: z.number().finite().optional(),
  unrealizedPnL: z.number().finite().optional(),
  pnlPercentage: z.number().finite().optional(),
  strikePrice: z.number().optional(),
  optionType: z.string().optional(),
  expiryDate: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  entryDate: z.string().optional(),
});

/** Close-paper-trade body: a positive finite exit price (a real sell price). */
const ClosePaperTradeSchema = z.object({
  exitPrice: z.number().positive("Exit price must be positive").finite(),
});

/**
 * GET /v1/paper
 * Get paper portfolio (all positions + summary)
 */
paperRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getPaperPortfolio(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Paper portfolio error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch paper portfolio"),
      500,
    );
  }
});

/**
 * POST /v1/paper
 * Create a new paper trade (buy)
 */
paperRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(CreatePaperTradeSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid paper trade",
          validated.issues,
        ),
        400,
      );
    }
    const result = await createPaperTrade(userId, validated.data);
    if (!result.success) {
      // MONEY-1183 — a DB failure is a 500. It used to share this branch with
      // genuine client errors, so a failed write was reported as the caller's
      // fault and never retried. The service now tags INTERNAL; anything
      // un-coded keeps this route's previous status.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success(result.data), 201);
  } catch (err) {
    console.error("Paper create error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to create paper trade"),
      500,
    );
  }
});

/**
 * POST /v1/paper/:id/close
 * Close a paper trade (sell)
 */
paperRoutes.post("/:id/close", async (c) => {
  const userId = c.get("userId");
  const positionId = c.req.param("id");

  try {
    const parsed = await safeJson<{ exitPrice?: unknown }>(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(ClosePaperTradeSchema, {
      exitPrice: parsed.data.exitPrice,
    });
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid exit price",
          validated.issues,
        ),
        400,
      );
    }
    const result = await closePaperTrade(
      userId,
      positionId,
      validated.data.exitPrice,
    );
    if (!result.success) {
      // MONEY-1183 — a DB failure is a 500. It used to share this branch with
      // genuine client errors, so a failed write was reported as the caller's
      // fault and never retried. The service now tags INTERNAL / NOT_FOUND; anything
      // un-coded keeps this route's previous status.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Paper close error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to close paper trade"),
      500,
    );
  }
});

/**
 * DELETE /v1/paper/:id
 * Delete a paper trade
 */
paperRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const positionId = c.req.param("id");

  try {
    const result = await deletePaperTrade(userId, positionId);
    if (!result.success) {
      // MONEY-1180 — a DB failure is a 500, not a 404. Both outcomes used
      // to collapse into this one branch and answer 404, which told the
      // client the row does not exist and it stopped retrying a delete
      // that would have worked. Un-coded failures keep the 404 default.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success({ message: "Paper trade deleted" }));
  } catch (err) {
    console.error("Paper delete error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to delete paper trade"),
      500,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ORDER / CASH-PORTFOLIO MODEL (additive) — matches the live web paper-trading UI
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/paper/portfolio
 * Get (or lazily create) the caller's cash portfolio → { id, initialCapital, cash }.
 */
paperRoutes.get("/portfolio", async (c) => {
  const userId = c.get("userId");
  const result = await getOrCreatePaperPortfolio(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/paper/orders
 * Place a paper order against the cash portfolio. Zod mirror of the web action's
 * input (side/qty/symbol/orderType/…). Business rejections (price required,
 * insufficient cash) surface as `INVALID_INPUT` → 400.
 */
paperRoutes.post("/orders", async (c) => {
  const userId = c.get("userId");

  const parsed = await safeJson(c);
  if (!parsed.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const validated = zodParse(PlaceOrderSchema, parsed.data);
  if (!validated.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid order", validated.issues),
      400,
    );
  }

  try {
    const result = await placePaperOrder(userId, validated.data);
    if (!result.success) {
      switch (result.code) {
        case "INVALID_INPUT":
          return c.json(error(ErrorCodes.INVALID_INPUT, result.error), 400);
        case "NOT_FOUND":
          return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
        default:
          return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
    }
    return c.json(success(result.data), 201);
  } catch (err) {
    console.error("Paper order error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to place order"),
      500,
    );
  }
});

/**
 * GET /v1/paper/orders
 * Recent orders (newest first). `?limit` clamped to [1, 100]; optional `?status`.
 */
paperRoutes.get("/orders", async (c) => {
  const userId = c.get("userId");
  const limit = parseLimit(c.req.query("limit"));
  const status = c.req.query("status");

  const result = await getPaperOrders(userId, { limit, status });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/paper/performance
 * Closed-trade performance summary (win rate, realized P&L, best/worst).
 */
paperRoutes.get("/performance", async (c) => {
  const userId = c.get("userId");
  const result = await getPaperPerformance(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/paper/dashboard
 * Combined dashboard stats: portfolio + open/closed position totals + performance.
 */
paperRoutes.get("/dashboard", async (c) => {
  const userId = c.get("userId");
  const result = await getPaperDashboardStats(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/paper/reset
 * Reset the cash portfolio: purge orders, close all positions, restore cash.
 */
paperRoutes.post("/reset", async (c) => {
  const userId = c.get("userId");
  const result = await resetPaperPortfolio(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

export default paperRoutes;
