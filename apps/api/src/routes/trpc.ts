/**
 * tRPC Route Handler
 *
 * Integrates tRPC with Hono for type-safe API endpoints.
 *
 * The context-creation logic is extracted into the exported `createTrpcContext`
 * so the auth-passthrough contract — reading `userId` / `clerkUserId` off the
 * Hono context set by `authMiddleware` — is tested against the REAL source
 * instead of an inline copy. The `createContext` adapter below just calls it.
 *
 * @see apps/api/__tests__/routes/trpc.test.ts
 */

import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { appRouter, type Context } from "@usemoney/trpc";
import type { AppContext } from "../app";

/**
 * Minimal read-only view of the Hono context the tRPC bridge depends on: the
 * `get(key)` accessor used to pull auth values set by `authMiddleware`.
 */
export interface TrpcContextSource {
  get(key: string): string | undefined;
}

/**
 * Build the tRPC {@link Context} from the Hono request context. Extracts the
 * `userId` and `clerkUserId` the auth middleware stored; both are `undefined`
 * when the request was unauthenticated / the middleware did not run.
 */
export function createTrpcContext(c: TrpcContextSource): Context {
  const userId = c.get("userId") as string | undefined;
  const clerkUserId = c.get("clerkUserId") as string | undefined;

  return {
    userId,
    clerkUserId,
  };
}

const trpcRoutes = new Hono<AppContext>();

/**
 * Mount tRPC handler
 * All procedures are available at /trpc/*
 */
trpcRoutes.use(
  "/*",
  trpcServer({
    router: appRouter,
    // Get auth context from Hono's context (set by authMiddleware)
    createContext: (_opts, c): Context => createTrpcContext(c),
  }),
);

export default trpcRoutes;
