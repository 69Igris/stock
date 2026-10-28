/**
 * Rate Limiting Middleware
 *
 * Simple in-memory rate limiting. For production,
 * consider using Redis-based rate limiting.
 *
 * The client-id derivation, window/counter, and 429-shaping live in
 * `./ratelimit-logic.ts` so they're unit-tested against the real source.
 */

import { createMiddleware } from "hono/factory";
import type { AppContext } from "../app";
import {
  RateLimiter,
  getClientId,
  RATE_LIMIT_CLEANUP_INTERVAL_MS,
} from "./ratelimit-logic";

// Single shared limiter instance for the process.
const limiter = new RateLimiter();

export const rateLimitMiddleware = createMiddleware<AppContext>(
  async (c, next) => {
    // Get client identifier (hashed auth token or IP).
    const clientId = getClientId({
      authorizationHeader: c.req.header("Authorization"),
      xForwardedFor: c.req.header("X-Forwarded-For"),
      xRealIP: c.req.header("X-Real-IP"),
    });

    const result = limiter.processRequest(clientId);

    for (const [name, value] of Object.entries(result.headers)) {
      c.header(name, value);
    }

    if (!result.allowed && result.body) {
      return c.json(result.body, result.status ?? 429);
    }

    await next();
  },
);

// Cleanup old entries periodically (every 5 minutes)
setInterval(() => {
  limiter.cleanup();
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);
