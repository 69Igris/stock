/**
 * Hono Application Setup
 *
 * Main Hono app with middleware and route configuration.
 */

// MONEY-1380 — the tracer, FIRST. The Vercel entry point (api/[[...route]].ts)
// imports this module, never src/index.ts, so this side-effect import is the
// only thing that initialises a tracer in production. ESM evaluates imports in
// source order, so it runs before hono and the routes below it.
import "./tracer";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/ratelimit";
import { requestIdMiddleware } from "./middleware/request-id";
import healthRoutes from "./routes/health";
import v1Routes from "./routes/v1/index";
import trpcRoutes from "./routes/trpc";
import {
  getCorsOrigins,
  buildNotFoundBody,
  buildInternalErrorBody,
  buildRootInfoBody,
  CORS_ALLOW_METHODS,
  CORS_ALLOW_HEADERS,
  CORS_EXPOSE_HEADERS,
  CORS_MAX_AGE,
} from "./app-logic";

// Create Hono app with type-safe context
export type AppContext = {
  Variables: {
    /** Internal Mongo user _id (resolved from the Clerk subject by authMiddleware). */
    userId: string;
    /** Clerk subject (the raw JWT `sub`). */
    clerkUserId: string;
    /** Per-request correlation id (set by requestIdMiddleware). */
    requestId: string;
  };
};

const app = new Hono<AppContext>();

// Global middleware
// Request id first, so every downstream middleware/handler + the error/404
// responses carry the same X-Request-Id.
app.use("*", requestIdMiddleware);
app.use("*", logger());
app.use("*", prettyJSON());
app.use("*", secureHeaders());

// CORS configuration (allow-list resolved in ./app-logic)
app.use(
  "*",
  cors({
    origin: getCorsOrigins({
      nodeEnv: process.env.NODE_ENV,
      webUrl: process.env.WEB_URL,
      adminUrl: process.env.ADMIN_URL,
    }),
    credentials: true,
    allowMethods: [...CORS_ALLOW_METHODS],
    allowHeaders: [...CORS_ALLOW_HEADERS],
    exposeHeaders: [...CORS_EXPOSE_HEADERS],
    maxAge: CORS_MAX_AGE,
  }),
);

// Health check (no auth required)
app.route("/health", healthRoutes);

// Root endpoint
app.get("/", (c) => {
  return c.json(buildRootInfoBody());
});

// API v1 routes (with auth and rate limiting)
app.use("/v1/*", rateLimitMiddleware);
app.use("/v1/*", authMiddleware);
app.route("/v1", v1Routes);

// tRPC routes (with auth and rate limiting)
app.use("/trpc/*", rateLimitMiddleware);
app.use("/trpc/*", authMiddleware);
app.route("/trpc", trpcRoutes);

// 404 handler
app.notFound((c) => {
  return c.json(buildNotFoundBody(c.req.method, c.req.path), 404);
});

// Error handler - never leak internal error details to clients
app.onError((err, c) => {
  console.error("API Error:", err);
  return c.json(buildInternalErrorBody(err), 500);
});

export default app;
