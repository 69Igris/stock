/**
 * Request-ID Middleware (P1.3)
 *
 * Mints a per-request correlation id (`crypto.randomUUID()`), stashes it on the
 * Hono context (`c.get("requestId")`) for handlers/loggers, and echoes it on the
 * response as `X-Request-Id`. The CORS config already EXPOSES `X-Request-Id`
 * (see `app-logic.ts#CORS_EXPOSE_HEADERS`) but nothing set it until now — so the
 * header was advertised-but-never-present; this makes it real.
 *
 * Registered FIRST in the middleware stack so the id exists for every downstream
 * middleware and handler (including error/404 responses).
 */

import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app";

/** Response header carrying the per-request correlation id. */
export const REQUEST_ID_HEADER = "X-Request-Id";

export const requestIdMiddleware = createMiddleware<AppContext>(
  async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
  },
);
