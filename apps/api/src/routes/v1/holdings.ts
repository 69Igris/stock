/**
 * Holdings Routes
 *
 * Endpoints for managing user holdings.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes } from "../../lib/response";
import { getHoldings, deleteHolding } from "@usemoney/services";
import { parseListPage, encodeIdCursor } from "./pagination";

const holdingsRoutes = new Hono<AppContext>();

/**
 * GET /v1/holdings
 * Get all holdings for the authenticated user. `?limit` opts into cursor
 * pagination ({ items, summary, breakdowns, nextCursor }); without it the full
 * list + summary + breakdowns is returned unchanged.
 */
holdingsRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const symbol = c.req.query("symbol");
    const sector = c.req.query("sector");
    const filters = {
      ...(symbol && { symbol }),
      ...(sector && { sector }),
    };

    const page = parseListPage(c.req.query("limit"), c.req.query("cursor"));
    const result = await getHoldings(userId, filters, page);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    if (!page) {
      return c.json(success(result.data));
    }
    const {
      holdings,
      summary,
      sectorBreakdown,
      exchangeBreakdown,
      nextCursorId,
    } = result.data;
    return c.json(
      success({
        items: holdings,
        summary,
        sectorBreakdown,
        exchangeBreakdown,
        nextCursor: encodeIdCursor(nextCursorId),
      }),
    );
  } catch (err) {
    console.error("Holdings fetch error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch holdings"),
      500,
    );
  }
});

/**
 * GET /v1/holdings/summary
 * Get holdings summary
 */
holdingsRoutes.get("/summary", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getHoldings(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data.summary));
  } catch (err) {
    console.error("Holdings summary error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch holdings summary"),
      500,
    );
  }
});

/**
 * DELETE /v1/holdings/:id
 * Delete a holding (manual entries only)
 */
holdingsRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const holdingId = c.req.param("id");

  try {
    const result = await deleteHolding(userId, holdingId);
    if (!result.success) {
      // Missing/foreign holding → 404; a DB error → 500; the broker-synced
      // refusal (no code) stays a 400 validation error.
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
    console.error("Holdings delete error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to delete holding"),
      500,
    );
  }
});

export default holdingsRoutes;
