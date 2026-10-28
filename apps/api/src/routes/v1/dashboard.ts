/**
 * Dashboard Routes
 *
 * Endpoints for dashboard data aggregation.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes } from "../../lib/response";
import { getDashboardStats, getPortfolioReturns } from "@usemoney/services";

const dashboardRoutes = new Hono<AppContext>();

/**
 * GET /v1/dashboard
 * Get dashboard summary data
 */
dashboardRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getDashboardStats(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Dashboard error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch dashboard data"),
      500,
    );
  }
});

/**
 * GET /v1/dashboard/portfolio
 * Get portfolio breakdown (alias for main dashboard)
 */
dashboardRoutes.get("/portfolio", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getDashboardStats(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data.portfolio));
  } catch (err) {
    console.error("Portfolio error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch portfolio data"),
      500,
    );
  }
});

/**
 * GET /v1/dashboard/returns
 * Annualised portfolio returns (XIRR + CAGR) from dated trade cashflows.
 * Metrics are null when they can't be computed correctly (MONEY-485).
 */
dashboardRoutes.get("/returns", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getPortfolioReturns(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Returns error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to compute portfolio returns"),
      500,
    );
  }
});

export default dashboardRoutes;
