/**
 * Trades Routes
 *
 * Endpoints for managing user trades.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
} from "../../lib/response";
import {
  getTrades,
  getAvailableFYs,
  createTrade,
  updateTrade,
  deleteTrade,
} from "@usemoney/services";
import { TradeFormSchema, TradeFilterSchema } from "@usemoney/validation";
import { parsePagination } from "./pagination";
import { isValidBrokerFilter } from "./filters";

const tradesRoutes = new Hono<AppContext>();

/**
 * GET /v1/trades
 * Get all trades for the authenticated user
 */
tradesRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const { page, skip, limit } = parsePagination({
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });

    // Validate ?broker against the accepted filter set (BrokerType enum + the
    // "all"/"manual"/"BROKER:userId" forms) BEFORE it hits the Prisma `broker`
    // enum column — a garbage value would otherwise throw a Prisma validation
    // error → 500. Silently dropping it would widen the read to ALL brokers'
    // trades (wrong data), so an invalid broker is a 400.
    const broker = c.req.query("broker");
    if (!isValidBrokerFilter(broker)) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid broker filter"),
        400,
      );
    }

    const parsed = zodParse(TradeFilterSchema, {
      symbol: c.req.query("symbol"),
      broker,
      segment: c.req.query("segment"),
      tradeType: c.req.query("tradeType"),
      fromDate: c.req.query("fromDate"),
      toDate: c.req.query("toDate"),
      skip,
      limit,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid trade filters",
          parsed.issues,
        ),
        400,
      );
    }

    const result = await getTrades(userId, parsed.data);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    // Offset-paginated envelope (meta.total/page/limit/hasMore, same as
    // paginate()/credits/feedback) — but `data` keeps the { trades, stats } shape
    // so the filter-scoped stats strip isn't lost to a bare-array envelope.
    const { trades, total, stats } = result.data;
    return c.json(
      success(
        { trades, stats },
        { total, page, limit, hasMore: page * limit < total },
      ),
    );
  } catch (err) {
    console.error("Trades fetch error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch trades"),
      500,
    );
  }
});

/**
 * GET /v1/trades/fys (MONEY-1062 P1a)
 * The Indian financial years (1 Apr – 31 Mar, IST boundary) the caller's
 * trades span, newest first — powers the mobile Tradebook FY dropdown
 * (MONEY-847). Registered BEFORE any /:id-style route in this module so a
 * literal "fys" path segment can never be captured as a trade id.
 */
tradesRoutes.get("/fys", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getAvailableFYs(userId);
    if (!result.success) {
      // getAvailableFYs has no not-found path (an empty tradebook is a
      // successful `{ fys: [] }`) — any failure is a DB error → 500.
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Trades FYs error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load financial years"),
      500,
    );
  }
});

/**
 * POST /v1/trades
 * Create a new manual trade
 */
tradesRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(TradeFormSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid trade", validated.issues),
        400,
      );
    }
    const result = await createTrade(userId, validated.data);

    if (!result.success) {
      // MONEY-1181 — this was a 400 VALIDATION_ERROR, which it can never be.
      // The body is already validated against TradeFormSchema three lines up,
      // and `createTrade` has exactly ONE failure path: the catch around the
      // Prisma write. So `success: false` is always a DB error, and calling it
      // "Invalid trade" told the client its input was malformed — the client
      // stops retrying and asks the user to fix data that was never wrong.
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data), 201);
  } catch (err) {
    console.error("Trade create error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to create trade"),
      500,
    );
  }
});

/**
 * PUT /v1/trades/:id
 * Update a trade (only manual trades)
 */
tradesRoutes.put("/:id", async (c) => {
  const userId = c.get("userId");
  const tradeId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(TradeFormSchema.partial(), parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid trade update",
          validated.issues,
        ),
        400,
      );
    }
    const result = await updateTrade(userId, tradeId, validated.data);

    if (!result.success) {
      // A DB error (code "INTERNAL") is a 500; any other failure stays a 400.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Trade update error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to update trade"),
      500,
    );
  }
});

/**
 * DELETE /v1/trades/:id
 * Delete a trade (only manual trades)
 */
tradesRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const tradeId = c.req.param("id");

  try {
    const result = await deleteTrade(userId, tradeId);
    if (!result.success) {
      // Missing/foreign trade → 404; a DB error → 500; the broker-synced refusal
      // (no code) stays a 400 validation error.
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success({ message: result.message }));
  } catch (err) {
    console.error("Trade delete error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to delete trade"),
      500,
    );
  }
});

export default tradesRoutes;
