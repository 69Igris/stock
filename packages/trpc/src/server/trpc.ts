/**
 * tRPC Server Configuration
 *
 * Base tRPC setup with context and procedures.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

/**
 * Context passed to every procedure
 * Index signature required for compatibility with @hono/trpc-server
 */
export interface Context {
  [key: string]: unknown;
  /**
   * The RESOLVED INTERNAL Mongo user `_id` — NOT the Clerk subject. As of
   * MONEY-1062, `apps/api`'s auth middleware resolves the Clerk sub to the Mongo
   * `_id` once and sets THAT here (`c.get("userId")`), so any ownership scoping
   * is always the Mongo id. The Clerk sub is carried separately on
   * `clerkUserId`.
   */
  userId?: string;
  /** The Clerk subject (raw JWT `sub`) — reference only; scope by `userId`. */
  clerkUserId?: string;
}

/**
 * Initialize tRPC with context type and superjson transformer
 */
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof Error ? error.cause.message : null,
      },
    };
  },
});

/**
 * Router factory
 */
export const router = t.router;

/**
 * Public procedure - no authentication required
 */
export const publicProcedure = t.procedure;

/**
 * Protected procedure - requires authentication
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId || !ctx.clerkUserId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  return next({
    ctx: {
      userId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
    },
  });
});

/**
 * Middleware factory
 */
export const middleware = t.middleware;

/**
 * Merge routers
 */
export const mergeRouters = t.mergeRouters;

/**
 * Create caller factory for server-side calls
 */
export const createCallerFactory = t.createCallerFactory;
