/**
 * @usemoney/trpc
 *
 * Type-safe API layer using tRPC.
 * Provides end-to-end type safety between clients and server.
 */

// Main router
export { appRouter, type AppRouter } from "./routers";

// Server utilities
export {
  router,
  publicProcedure,
  protectedProcedure,
  middleware,
  mergeRouters,
  createCallerFactory,
  type Context,
} from "./server";

// Client utilities
export { superjson } from "./client";
