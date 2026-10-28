/**
 * Positions Routes
 *
 * Endpoints for managing user positions.
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
import {
  getPositions,
  getClosedTodayPositions,
  closePosition,
  addManualPosition,
} from "@usemoney/services";
import { ClosePositionSchema } from "@usemoney/validation";
import { parseListPage, encodeIdCursor } from "./pagination";
import { isValidBrokerFilter } from "./filters";

const positionsRoutes = new Hono<AppContext>();

/**
 * Body for POST /v1/positions — a zod mirror of addManualPositionAction's typed
 * input (apps/web/lib/actions/positions.ts:111). The web action trusts its
 * TypeScript caller; the public API validates. Numerics must be positive AND
 * finite (a JSON `1e999` parses to Infinity and would poison the stored P&L).
 */
const AddManualPositionSchema = z.object({
  symbol: z.string().min(1).max(32),
  exchange: z.string().min(1).max(16),
  segment: z.string().min(1).max(16),
  productType: z.string().min(1).max(16),
  positionType: z.enum(["LONG", "SHORT"]),
  quantity: z.number().positive().finite(),
  entryPrice: z.number().positive().finite(),
  currentPrice: z.number().positive().finite().optional(),
});

/**
 * GET /v1/positions
 * Get all positions for the authenticated user. `?limit` opts into cursor
 * pagination ({ items, summary, nextCursor }); without it the full list +
 * summary is returned unchanged.
 */
positionsRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const symbol = c.req.query("symbol");
    const broker = c.req.query("broker");
    const segment = c.req.query("segment");
    // Reject a garbage ?broker before it reaches the Prisma `broker` enum column
    // (→ 500). Accepts the enum values + the "all"/"manual"/"BROKER:userId" forms
    // getPositions honours; valid-value behaviour is unchanged.
    if (!isValidBrokerFilter(broker)) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid broker filter"),
        400,
      );
    }
    const filters = {
      ...(symbol && { symbol }),
      ...(broker && { broker }),
      ...(segment && { segment }),
    };

    const page = parseListPage(c.req.query("limit"), c.req.query("cursor"));
    const result = await getPositions(userId, filters, page);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    if (!page) {
      return c.json(success(result.data));
    }
    const { positions, summary, nextCursorId } = result.data;
    return c.json(
      success({
        items: positions,
        summary,
        nextCursor: encodeIdCursor(nextCursorId),
      }),
    );
  } catch (err) {
    console.error("Positions fetch error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch positions"),
      500,
    );
  }
});

/**
 * POST /v1/positions
 * Add a manual (off-broker) open position — shows on Holdings > Positions as
 * "Manual" (no broker tag). Mirrors addManualPositionAction (apps/web
 * lib/actions/positions.ts:111) via the extracted addManualPosition service
 * (DAY/NET derivation, LONG/SHORT split, unrealized-P&L math byte-faithful).
 * Returns 201 { positionId }.
 */
positionsRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(AddManualPositionSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid manual-position input",
          validated.issues,
        ),
        400,
      );
    }

    const result = await addManualPosition(userId, validated.data);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data), 201);
  } catch (err) {
    console.error("Add manual position error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to add position"),
      500,
    );
  }
});

/**
 * GET /v1/positions/summary
 * Get positions summary
 */
positionsRoutes.get("/summary", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getPositions(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data.summary));
  } catch (err) {
    console.error("Positions summary error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch positions summary"),
      500,
    );
  }
});

/**
 * GET /v1/positions/closed-today
 * Get positions closed today (intraday squared-off)
 */
positionsRoutes.get("/closed-today", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getClosedTodayPositions(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Closed-today positions error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch closed positions"),
      500,
    );
  }
});

/**
 * POST /v1/positions/:id/close
 * Close an open position at a given exit price. `:id` is the position/trade id;
 * body carries `{ exitPrice }`. Service computes finite-guarded realised P&L.
 */
positionsRoutes.post("/:id/close", async (c) => {
  const userId = c.get("userId");
  const positionId = c.req.param("id");

  try {
    const parsed = await safeJson<{ exitPrice?: unknown }>(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(ClosePositionSchema, {
      positionId,
      exitPrice: parsed.data.exitPrice,
    });
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid close-position input",
          validated.issues,
        ),
        400,
      );
    }

    const result = await closePosition(userId, validated.data);
    if (!result.success) {
      // Distinguish the client-error outcomes (not-found, already-closed) from
      // a genuine server failure so a mobile client gets an actionable status
      // rather than a blanket 500 (MONEY-1062 review).
      const status =
        result.error === "Position not found"
          ? 404
          : result.error === "Position already closed"
            ? 409
            : 500;
      const code =
        status === 404
          ? ErrorCodes.NOT_FOUND
          : status === 409
            ? ErrorCodes.CONFLICT
            : ErrorCodes.INTERNAL_ERROR;
      return c.json(error(code, result.error), status);
    }

    return c.json(success({ ...result.data, message: result.message }));
  } catch (err) {
    console.error("Close position error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to close position"),
      500,
    );
  }
});

export default positionsRoutes;
