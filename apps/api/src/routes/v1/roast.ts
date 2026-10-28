/**
 * Roast Routes
 *
 * Portfolio-roast start + eligibility + history/result reads (async agent
 * version). Thin wrappers over roast.service — every read is userId-scoped
 * (IDOR-safe) in the service.
 *
 * MONEY-1062 (P2b): STARTING a roast (feature gate + broker pre-flight + credit
 * consume + Pub/Sub publish) now lives in `startRoast(userId, …)` in
 * roast.service — extracted parallel to apps/web/lib/actions/roast.ts so the
 * thin route never inlines pubsub. `POST /v1/roast` and `GET /v1/roast/can-use`
 * are wired below; the credit gate runs BEFORE the job is queued and a publish
 * failure refunds (all inside the service).
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  paginate,
  safeJson,
  zodParse,
} from "../../lib/response";
import {
  getRoastHistory,
  getRoastBySessionId,
  getRunningRoasts,
  getRoastStatus,
  cancelRoast,
  deleteRoast,
  startRoast,
  canUseRoast,
} from "@usemoney/services";
import { parsePagination } from "./pagination";

const roastRoutes = new Hono<AppContext>();

/**
 * Body for POST /v1/roast (mirrors the web action's RoastParams).
 */
const StartRoastSchema = z.object({
  mode: z.enum(["overall", "broker"]),
  broker: z.string().trim().min(1).max(50).optional(),
  brokerUserId: z.string().trim().min(1).max(100).optional(),
  dateFrom: z.string().trim().min(1).max(40).optional(),
  dateTo: z.string().trim().min(1).max(40).optional(),
  symbols: z.array(z.string().trim().min(1).max(50)).max(100).optional(),
  assetType: z.enum(["stocks", "mf", "all"]),
  scope: z.enum(["PORTFOLIO", "TRADEBOOK"]).optional(),
});

/**
 * POST /v1/roast
 * Start an async portfolio roast → 202 { sessionId, warnings? }. Poll via
 * GET /v1/roast/:sessionId/status. Mirrors startRoastAction incl. the MONEY-1062
 * fix (createRoastSession checked BEFORE the credit consume). Code mapping:
 * UPGRADE_REQUIRED / NO_CREDITS → 403; NOT_CONNECTED / NEEDS_REAUTH /
 * NEVER_SYNCED → 400 (details.errorType); INTERNAL → 500.
 */
roastRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const parsed = await safeJson(c);
  if (!parsed.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const validated = zodParse(StartRoastSchema, parsed.data);
  if (!validated.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid roast request",
        validated.issues,
      ),
      400,
    );
  }

  try {
    const result = await startRoast(userId, validated.data);
    if (!result.success) {
      switch (result.code) {
        case "UPGRADE_REQUIRED":
        case "NO_CREDITS":
          return c.json(error(ErrorCodes.FORBIDDEN, result.error), 403);
        case "NOT_CONNECTED":
        case "NEEDS_REAUTH":
        case "NEVER_SYNCED":
          // 400 with the specific broker-state type surfaced in details so the
          // mobile client can branch (reconnect vs sync vs connect).
          return c.json(
            error(ErrorCodes.VALIDATION_ERROR, result.error, {
              errorType: result.code,
            }),
            400,
          );
        case "NOT_FOUND":
          return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
        default:
          return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
    }
    return c.json(success(result.data), 202);
  } catch (err) {
    console.error("Roast start error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to start portfolio roast"),
      500,
    );
  }
});

/**
 * GET /v1/roast/can-use
 * Pre-flight roast eligibility (free-roast vs advanced-credit vs blocked).
 * Mirrors canUseRoastAction. MUST be registered BEFORE the `/:sessionId` param
 * route so the literal "can-use" is not captured as a sessionId.
 */
roastRoutes.get("/can-use", async (c) => {
  const userId = c.get("userId");

  const result = await canUseRoast(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/roast
 * Paginated roast history (COMPLETED/FAILED), newest-first, scoped to the caller.
 */
roastRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const { page, limit } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await getRoastHistory(userId, page, limit);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  return c.json(paginate(result.data.items, result.data.total, page, limit));
});

/**
 * GET /v1/roast/running
 * The caller's in-flight roasts (status ∉ {COMPLETED, FAILED}), newest-first.
 * Mirrors getRunningRoastsAction. MUST be registered BEFORE the `/:sessionId`
 * param route below so the literal "running" is not captured as a sessionId.
 */
roastRoutes.get("/running", async (c) => {
  const userId = c.get("userId");

  const result = await getRunningRoasts(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  return c.json(success(result.data));
});

/**
 * GET /v1/roast/:sessionId/status
 * Lightweight status/progress poll for a roast the caller owns. Mirrors
 * getRoastStatusAction. NOTE: getRoastStatus is `(sessionId, userId)` —
 * sessionId FIRST — and scopes by userId so a foreign/missing sessionId → 404.
 */
roastRoutes.get("/:sessionId/status", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await getRoastStatus(sessionId, userId);
  if (!result.success) {
    // A DB error (code "INTERNAL") is a 500; a missing/foreign session → 404.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success(result.data));
});

/**
 * POST /v1/roast/:sessionId/cancel
 * Cancel a running roast the caller owns (marks it FAILED). Mirrors
 * cancelRoastAction. A foreign/missing or already-finished session → 404.
 */
roastRoutes.post("/:sessionId/cancel", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await cancelRoast(userId, sessionId);
  if (!result.success) {
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success({ message: "Roast cancelled" }));
});

/**
 * DELETE /v1/roast/:id
 * Hard-delete a completed roast the caller owns. Keyed by the roast `id` (the
 * `id` field in the GET /v1/roast history items) — NOT the sessionId — because
 * deleteRoast scopes by `{ id, userId }`, mirroring the web
 * `deleteRoastAction(id)`. A foreign/missing id → 404.
 */
roastRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const result = await deleteRoast(userId, id);
  if (!result.success) {
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success({ message: "Roast deleted" }));
});

/**
 * GET /v1/roast/:sessionId
 * Full roast record (result) for a session the caller owns. A guessed sessionId
 * from another account resolves as 404 (getRoastBySessionId scopes by userId) —
 * no cross-user leak.
 */
roastRoutes.get("/:sessionId", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await getRoastBySessionId(sessionId, userId);
  if (!result.success) {
    // A DB error (code "INTERNAL") is a 500; a missing/foreign session → 404.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success(result.data));
});

export default roastRoutes;
