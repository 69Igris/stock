/**
 * tRPC Routers
 *
 * Combined app router with all domain routers.
 */

import { router } from "../server/trpc";
import { holdingsRouter } from "./holdings";
import { positionsRouter } from "./positions";
import { tradesRouter } from "./trades";
import { dashboardRouter } from "./dashboard";

/**
 * Main app router combining all domain routers
 */
export const appRouter = router({
  dashboard: dashboardRouter,
  holdings: holdingsRouter,
  positions: positionsRouter,
  trades: tradesRouter,
});

/**
 * Export type for client usage
 */
export type AppRouter = typeof appRouter;

// Re-export individual routers for direct access
export { holdingsRouter } from "./holdings";
export { positionsRouter } from "./positions";
export { tradesRouter } from "./trades";
export { dashboardRouter } from "./dashboard";
