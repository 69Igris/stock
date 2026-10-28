/**
 * Cloud Run entry point.
 *
 * `app.ts` side-effect imports `./tracer` as its first statement, so importing
 * the app here is what initialises APM — ESM evaluates imports in source order.
 */
import { serve } from "@hono/node-server";
import app from "./app";

// Cloud Run supplies PORT and it is not negotiable; the literal below is only
// the LOCAL default. Binding to a hardcoded port makes the container start and
// then fail its health check with no error in the logs.
//
// 8085, NOT 8080 — `apps/api` already defaults to 8080 (`apps/api/src/index.ts`),
// and `yarn dev` starts both. Whichever bound first won and the other died with
// `EADDRINUSE: address already in use :::8080`, which in a Turbo pane reads as
// "the API server crashed" rather than "two services want one port". Cloud Run
// is unaffected: it always supplies PORT, so this literal is never used there.
const port = Number(process.env.PORT ?? 8085);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[market-data] listening on :${info.port}`);
});
