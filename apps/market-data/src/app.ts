/**
 * `usemoney-market-data` — the UDF datafeed, served from Cloud Run behind a CDN.
 *
 * Today every TradingView call goes through a Vercel function doing Clerk auth
 * + Redis + Mongo + a live Yahoo fetch. Measured over 14 days
 * (`service:vercel.edge-network`): `udf/history` p50 0.75 s / p95 3.15 s, and
 * `udf/config` and `udf/time` — which return CONSTANTS — p50 0.26 s. A quarter
 * of a second to return a literal is the clearest possible argument for an
 * edge-cacheable origin.
 *
 * A1 creates the service and serves the static half. A2/A3/C4 bring the data.
 */
import "./tracer";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { requestIdMiddleware } from "./middleware/request-id";
import udfRoutes from "./routes/udf";
// MONEY-1467 — without this `/udf/history` answers no_data for EVERY symbol,
// in production, with no error anywhere. See tile-store-init.ts.
import { initTileStore } from "./tile-store-init";
import healthRoutes from "./routes/health";
// MONEY-1469 (A4) — the batch quote reader. Redis only; no vendor call.
import quoteRoutes from "./routes/quotes";
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_EXPOSE_HEADERS,
  CORS_MAX_AGE,
  getCorsOrigins,
} from "./app-logic";

export type AppContext = {
  Variables: {
    requestId: string;
    /** Set by `marketTokenMiddleware`; unused until A5. */
    userId?: string;
  };
};

export function createApp() {
  const app = new Hono<AppContext>();

  app.use("*", requestIdMiddleware);
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: getCorsOrigins(process.env.NODE_ENV),
      allowMethods: [...CORS_ALLOW_METHODS],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      // Without this the browser strips X-Bar-Basis — see the constant.
      exposeHeaders: [...CORS_EXPOSE_HEADERS],
      maxAge: CORS_MAX_AGE,
    }),
  );

  // Registered on the way up rather than lazily per request: a reader with
  // no store is not an error, it is a blank chart, so the one chance to say
  // so is at boot.
  initTileStore();

  app.route("/udf", udfRoutes);
  app.route("/quotes", quoteRoutes);
  app.route("/health", healthRoutes);

  app.get("/", (c) =>
    c.json({
      service: "usemoney-market-data",
      endpoints: ["/udf", "/quotes", "/health"],
    }),
  );

  app.notFound((c) => c.json({ s: "error", errmsg: "not found" }, 404));

  app.onError((err, c) => {
    // The request id goes in the RESPONSE, the detail goes in the LOG. A
    // stack trace in a UDF response body reaches the browser of anyone who can
    // load a chart.
    console.error(`[market-data] ${c.get("requestId") ?? "-"} ${String(err)}`);
    return c.json({ s: "error", errmsg: "internal error" }, 500);
  });

  return app;
}

export const app = createApp();
export default app;
