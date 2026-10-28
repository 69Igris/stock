/**
 * Datadog constants - service names, default tags, and environment mappings.
 */

export const DD_SERVICES = {
  WEB: "stockbook-web",
  API: "stockbook-api",
  WORKERS: "stockbook-workers",
  /**
   * The Tiingo realtime socket holder — MONEY-1357.
   *
   * Its OWN service, not `stockbook-workers`, even though it ships in the same
   * image. It is one long-lived process holding one WebSocket at minScale 1;
   * the worker pool is request-driven and horizontally scaled. Filing both
   * under one name makes the service map, the error rate and any latency
   * percentile a blend of two workloads that fail in unrelated ways — and this
   * is the one process whose death is the whole feature.
   */
  REALTIME: "tiingo-realtime",
} as const;

export type DDService = (typeof DD_SERVICES)[keyof typeof DD_SERVICES];

/**
 * The APM SERVER span each traced service emits — MONEY-1534.
 *
 * ONE declaration. `scripts/ops/datadog/lib-datadog.sh` reads it
 * (`dd_server_span`) to render every service monitor's `trace.<span>.*`, and
 * the agreement tests hold `slos.json` and `dashboards/*.json` to it, because
 * JSON cannot import a TypeScript constant. The same arrangement as
 * {@link DD_SITE}.
 *
 * A per-SERVICE fact, not a library constant. dd-trace-js opens every inbound
 * request as `web.request`, and a framework plugin RENAMES THAT SAME SPAN
 * `<framework>.request` (`setFramework`, dd-trace
 * packages/dd-trace/src/plugins/util/web.js:87). Whether the plugin fires
 * depends on how the process STARTS: an ESM bundle's `hono` is patched only
 * under `--import dd-trace/register.js`. MONEY-1380 put that flag on the
 * workers' CMD (~2026-09-11), their span became `hono.request`, and the
 * monitor, SLO and widget that spelled `web.request` went dark with no error
 * anywhere.
 *
 * Measured on prod (us5), 24h to 2026-09-23 05:10Z, `sum:trace.<span>.hits`:
 *
 *   stockbook-workers     hono.request     15,787  web.request: no series
 *                                                  since 2026-09-11
 *   tiingo-realtime       web.request       2,876  bare node:http, no loader
 *   us-fundamentals       fastapi.request   2,229  ddtrace-py
 *   usemoney-market-data  hono.request      3,365  web.request: no series
 *
 * Never `http.request`: that is dd-trace-js's HTTP CLIENT span, our OUTBOUND
 * calls. Keep the object body free of braces and quotes in comments — the
 * shell resolver reads it with a regex, and a test pins the two readings
 * together. A service missing here is refused by name, never given a default.
 */
export const DD_SERVER_SPAN = {
  "stockbook-workers": "hono.request",
  "tiingo-realtime": "web.request",
  "us-fundamentals": "fastapi.request",
  "usemoney-market-data": "hono.request",
} as const;

/**
 * Prefix `datadog-metrics` prepends to EVERY metric name this package emits.
 *
 * MONEY-1238 — exported because it is not optional decoration: the series that
 * reaches Datadog is `stockbook.job.written`, not `job.written`, and
 * `scripts/ops/datadog/monitor-zero-write.json` queried the unprefixed name for
 * two releases. A monitor on a series nobody emits is permanently NO DATA,
 * which is indistinguishable from health once the no-data notification is
 * muted. One constant, imported by the code that emits and asserted against the
 * monitor that queries, is the only arrangement in which the two cannot drift.
 */
export const METRIC_PREFIX = "stockbook.";

/**
 * Map a raw DD_ENV / NODE_ENV value to the Datadog `env:` tag value.
 *
 * PURE half of {@link getDatadogEnv}, split out for MONEY-1238 so the monitor
 * tooling can ask "what tag will the workers emit for this environment?"
 * without reading `process.env`. `scripts/ops/datadog/apply-monitors.sh` takes
 * `prod` on the command line and used to substitute `env:prod` — a tag the
 * workers have never emitted, because `workers/cloudbuild.prod.yaml` sets
 * `DD_ENV=production` and this function maps it to `production`. QA matched by
 * coincidence (`qa` -> `qa`), which is exactly why the mismatch survived: the
 * environment it was tested in was the one environment it worked in.
 */
export function toDatadogEnv(raw: string | undefined): string {
  switch (raw) {
    case "production":
    case "prod":
      return "production";
    case "qa":
      return "qa";
    default:
      return "development";
  }
}

/**
 * Map NODE_ENV values to Datadog-friendly environment names.
 */
export function getDatadogEnv(): string {
  return toDatadogEnv(
    process.env.DD_ENV || process.env.NODE_ENV || "development",
  );
}

/**
 * Default tags applied to all metrics and traces.
 */
export function getDefaultTags(): string[] {
  const service = process.env.DD_SERVICE || "stockbook";
  const env = getDatadogEnv();
  const version = process.env.DD_VERSION || "unknown";
  return [`service:${service}`, `env:${env}`, `version:${version}`];
}

/**
 * The Datadog SITE this org lives on — US5, since the September 2026 account
 * replacement (MONEY-1229). The previous org was `us3.datadoghq.com`.
 *
 * ONE definition, deliberately a literal rather than an env read. Everything
 * that sends derives from it: the HTTP metrics reporter, the logs intake URL
 * below, the browser RUM init in apps/web, and
 * `scripts/ops/datadog/apply-monitors.sh`, which reads this literal out of the
 * file to build its API host. A site mismatch never errors — a key minted on
 * one site is answered 403 by another, and both the metrics client and the
 * logs transport swallow that — so the only symptom is a series that never
 * arrives, which reads as NO DATA and is indistinguishable from health. The
 * four Cloud Build sidecar specs and workers/scripts/deploy.sh carry the same
 * value as a plain env string (the sidecar cannot import TypeScript);
 * `__tests__/site-agreement.test.ts` pins every one of them to this constant.
 */
export const DD_SITE = "us5.datadoghq.com";

/** Datadog Logs HTTP intake endpoint, derived from the site above. */
export const DD_LOGS_INTAKE_URL = `https://http-intake.logs.${DD_SITE}/api/v2/logs`;
