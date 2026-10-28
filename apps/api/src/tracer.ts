/**
 * Datadog tracer bootstrap for apps/api — MONEY-1380.
 *
 * ## This file exists because the Vercel entry point never ran the old one
 *
 * `initTracer` was called from `src/index.ts`, which is the LOCAL DEVELOPMENT
 * entry point and says so in its own header. Production runs on Vercel through
 * `api/[[...route]].ts`, which imports `../dist/app.js` — built from `app.ts` —
 * and never touches `index.ts` at all. So `stockbook-api` has had no tracer in
 * production for as long as it has been deployed there.
 *
 * Importing this module for its side effect from the TOP of `app.ts` fixes the
 * missing-tracer half for both entry points.
 *
 * It does NOT fix it by winning a race, and it is worth being precise because
 * the obvious reading is wrong. `tsup` bundles `app.ts` into ONE ESM file with
 * every non-workspace dependency left external, so `hono`, `@clerk/backend`
 * and the LLM SDKs become top-level `import` statements in the bundle — hoisted
 * ABOVE the inlined `initTracer()` call and evaluated before it. Source order
 * in this file buys nothing once the bundler has finished with it.
 *
 * What actually makes instrumentation work is the loader hook:
 * `NODE_OPTIONS=--import dd-trace/register.js` on the Vercel project, plus
 * `import-in-the-middle`'s retroactive replay — `addHook` re-runs over modules
 * that are ALREADY loaded, so a tracer initialised after the imports still
 * patches them. Drop that env var and this file goes quiet without erroring.
 *
 * `index.ts` keeps its own call. `initTracer` latches on a module-level
 * `initialized` flag, so the second one is a no-op rather than a second tracer.
 *
 * ## Profiling and runtime metrics are OFF, and must be passed as options
 *
 * `tracerConfig` defaults both to `true` and an explicit option beats the
 * environment, so there is no DD_ variable that can turn them off from a Vercel
 * project setting. Vercel has no Datadog Agent for a pprof upload to reach, and
 * a serverless instance would pay for the serialisation on every invocation.
 *
 * ## What this does NOT do
 *
 * It does not make APM tracing work on Vercel. dd-trace ships spans to a local
 * agent on `localhost:8126`, and there is none — MONEY-718 is the open ticket
 * for that. What it enables is LLM Observability, which posts over HTTPS
 * straight to the intake when `DD_LLMOBS_AGENTLESS_ENABLED=1`, and which
 * dd-trace only initialises when tracing itself is enabled
 * (`dd-trace/src/proxy.js` gates it inside `if (config.tracing !== false)`).
 * Hence the Vercel env is `DD_TRACE_ENABLED=true` plus
 * `DD_APM_TRACING_ENABLED=false` — tracing on so LLM Obs can start, APM spans
 * suppressed because nothing would receive them.
 *
 * ONE MORE THING IS REQUIRED and it is not in this repo: this app builds to an
 * ESM bundle, so dd-trace also needs `NODE_OPTIONS=--import dd-trace/register.js`
 * set on the Vercel project. Without it the loader hook is absent and the LLM
 * SDKs are imported unpatched — the same property `workers/Dockerfile` gets from
 * its CMD.
 */

import { initTracer } from "@usemoney/datadog";

initTracer({
  service: "stockbook-api",
  profiling: false,
  runtimeMetrics: false,
});
