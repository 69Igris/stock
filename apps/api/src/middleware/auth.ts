/**
 * Authentication Middleware
 *
 * Verifies Clerk JWT tokens from Authorization header.
 *
 * The token-extraction and verify→check-sub→set-context decision flow live in
 * `./auth-logic.ts` so they're unit-tested against the real source.
 */

import { createMiddleware } from "hono/factory";
import { verifyToken } from "@clerk/backend";
import { resolveUserId } from "@usemoney/services";
import type { AppContext } from "../app";
import {
  decideAuth,
  decideOptionalAuth,
  buildUnauthorizedBody,
} from "./auth-logic";

const verify = (token: string) =>
  verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });

export const authMiddleware = createMiddleware<AppContext>(async (c, next) => {
  const decision = await decideAuth(c.req.header("Authorization"), verify);

  if (!decision.authorized) {
    return c.json(decision.body!, decision.status ?? 401);
  }

  // P1.1 (MONEY-1062): resolve the Clerk subject to the internal Mongo user id
  // ONCE, here. Every downstream handler then reads the SAME resolved id from
  // `c.get("userId")` instead of re-resolving, and ownership scoping is ALWAYS
  // the Mongo _id — never the Clerk id. (This closes the research-route
  // IDOR-inconsistency where /status + /result scoped by `c.get("userId")` when
  // that held the Clerk id.) A verified token with no matching DB user → 401.
  const clerkUserId = decision.clerkUserId!;
  const dbUserId = await resolveUserId(clerkUserId);
  if (!dbUserId) {
    return c.json(buildUnauthorizedBody("User not found"), 401);
  }

  c.set("clerkUserId", clerkUserId);
  c.set("userId", dbUserId);
  await next();
});

/**
 * Optional auth middleware - doesn't fail if no token.
 *
 * Keeps the same context invariant as the required middleware: when a valid
 * token IS present, `c.get("userId")` is the internal Mongo id (resolved from
 * the Clerk subject), not the Clerk id. A missing/invalid token — or a verified
 * token with no matching DB user — simply proceeds anonymously (never blocks).
 */
export const optionalAuthMiddleware = createMiddleware<AppContext>(
  async (c, next) => {
    const ctx = await decideOptionalAuth(c.req.header("Authorization"), verify);

    if (ctx.clerkUserId) {
      const dbUserId = await resolveUserId(ctx.clerkUserId);
      if (dbUserId) {
        c.set("userId", dbUserId);
        c.set("clerkUserId", ctx.clerkUserId);
      }
    }

    await next();
  },
);
