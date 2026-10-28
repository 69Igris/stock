/**
 * Risk Analysis Routes
 *
 * Portfolio risk analysis endpoints.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes } from "../../lib/response";
import { getPortfolioRisk } from "@usemoney/services";
import { isEntitled } from "../../lib/premium-gate";

const riskRoutes = new Hono<AppContext>();

/**
 * GET /v1/risk
 * Get portfolio risk analysis
 */
riskRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  // MONEY-1142 — tier gate. apps/web enforced this; apps/api did not, so a
  // FREE user with a valid Clerk JWT could curl this endpoint and receive the
  // premium payload with no client involved at all.
  if (!(await isEntitled(userId, "riskAnalysis"))) {
    return c.json(
      error(ErrorCodes.SUBSCRIPTION_REQUIRED, "Upgrade required"),
      403,
    );
  }

  try {
    const result = await getPortfolioRisk(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Risk analysis error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to analyze portfolio risk"),
      500,
    );
  }
});

export default riskRoutes;
