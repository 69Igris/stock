/**
 * Dashboard Router
 *
 * tRPC procedures for dashboard data.
 *
 * MONEY-1062: every procedure below is an unimplemented stub — it throws
 * `NOT_IMPLEMENTED` (via `notImplemented`) and names the REST `/v1` route that
 * actually serves the data. The `.input(...)` schemas + router shape are kept
 * intact for a future real implementation.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../server/trpc";
import { notImplemented } from "./not-implemented";

export const dashboardRouter = router({
  /**
   * Get dashboard summary — NOT IMPLEMENTED. Use `GET /v1/dashboard`.
   */
  summary: protectedProcedure.query(() => notImplemented("GET /v1/dashboard")),

  /**
   * Get connected brokers status — NOT IMPLEMENTED. Use `GET /v1/brokers`.
   */
  brokers: protectedProcedure.query(() => notImplemented("GET /v1/brokers")),

  /**
   * Get portfolio allocation by sector/segment — NOT IMPLEMENTED.
   * Use `GET /v1/dashboard/portfolio`.
   */
  allocation: protectedProcedure
    .input(
      z.object({
        type: z
          .enum(["sector", "segment", "broker", "exchange"])
          .default("segment"),
      }),
    )
    .query(() => notImplemented("GET /v1/dashboard/portfolio")),

  /**
   * Get performance over time — NOT IMPLEMENTED. Use `GET /v1/dashboard/returns`.
   */
  performance: protectedProcedure
    .input(
      z.object({
        period: z.enum(["1W", "1M", "3M", "6M", "1Y", "ALL"]).default("1M"),
      }),
    )
    .query(() => notImplemented("GET /v1/dashboard/returns")),

  /**
   * Get recent activity — NOT IMPLEMENTED. Use `GET /v1/trades`.
   */
  recentActivity: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(20).default(10),
      }),
    )
    .query(() => notImplemented("GET /v1/trades")),
});

export type DashboardRouter = typeof dashboardRouter;
