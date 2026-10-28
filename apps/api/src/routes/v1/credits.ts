/**
 * Credits Routes
 *
 * Read-only credit balance + usage history, userId-scoped. Thin wrappers over
 * credit.service.
 *
 * NOTE: the comprehensive-credit RESERVATION lifecycle (reserve / commit /
 * refund in credit-reservation.service) is a worker/action-side mutation flow,
 * not a mobile read, so it is intentionally NOT surfaced here.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes, paginate } from "../../lib/response";
import { getCreditBalance, getCreditUsageHistory } from "@usemoney/services";
import { parsePagination } from "./pagination";

const creditsRoutes = new Hono<AppContext>();

/**
 * GET /v1/credits
 * Remaining plan + pack credits and their limits (balance/usage snapshot).
 */
creditsRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  const result = await getCreditBalance(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  return c.json(success(result.data));
});

/**
 * GET /v1/credits/usage
 * Paginated credit-usage history (newest-first). Optional ?action filter.
 */
creditsRoutes.get("/usage", async (c) => {
  const userId = c.get("userId");
  const { page, limit, skip } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await getCreditUsageHistory(userId, {
    skip,
    limit,
    action: c.req.query("action"),
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  return c.json(paginate(result.data.items, result.data.total, page, limit));
});

export default creditsRoutes;
