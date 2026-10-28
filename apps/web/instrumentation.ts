/**
 * Next.js Instrumentation Hook
 *
 * Runs once on server startup before any request handling.
 * Initializes Datadog APM tracer for server-side tracing.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initTracer } = await import("@usemoney/datadog");
    // MONEY-1380 — profiling and runtimeMetrics OFF on Vercel.
    //
    // `tracerConfig` defaults both to TRUE, and an option beats the
    // environment, so they cannot be turned off with a DD_ var here. Vercel has
    // no Datadog Agent to receive a pprof upload, so the profiler serialises
    // and fails on a serverless instance roughly every minute, and
    // runtimeMetrics installs a GC PerformanceObserver for telemetry that has
    // nowhere to go. LLM Observability does not need either — it posts over
    // HTTPS to the intake (DD_LLMOBS_AGENTLESS_ENABLED=1).
    initTracer({
      service: "stockbook-web",
      profiling: false,
      runtimeMetrics: false,
    });

    const { initLogger } = await import("@usemoney/logger");
    await initLogger();
  }
}
