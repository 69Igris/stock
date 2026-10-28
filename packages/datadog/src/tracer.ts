/**
 * Datadog APM Tracer Initialization
 *
 * dd-trace requires a local Datadog Agent (localhost:8126) to receive traces.
 * - Cloud Run (workers): Use Datadog serverless-init sidecar container.
 * - Vercel (web, api): Set DD_TRACE_ENABLED=false - no agent available.
 *   RUM, Logs, and Metrics still work via HTTP APIs (no agent needed).
 *
 * MUST be imported before any other application code for auto-instrumentation
 * to patch libraries (Prisma, ioredis, http, etc.) correctly.
 */

import tracer from "dd-trace";
import { getDatadogEnv, DD_SITE } from "./constants";

let initialized = false;

export interface TracerOptions {
  /** Service name (e.g. "stockbook-web", "stockbook-workers") */
  service: string;
  /** Override environment detection */
  env?: string;
  /**
   * The continuous profiler. DEFAULT TRUE — every request-driven service keeps
   * it, and this option exists for the one process that must not have it.
   *
   * MONEY-1357: `tiingo-realtime` is a singleton holding one websocket with
   * `cpu-throttling: "false"`, i.e. an event loop we pay to keep free. The
   * profiler serialises and uploads a pprof roughly every minute — ~1,440
   * cycles a day, on that loop, in both environments. It was harmless before
   * this branch only because there was no agent to upload to and it failed
   * fast; adding the sidecar is what ARMS it.
   */
  profiling?: boolean;
  /**
   * Runtime metrics. DEFAULT TRUE, off for the same one process.
   *
   * It installs a GC `PerformanceObserver`, and this process allocates per
   * frame — top-of-book quotes for up to TIINGO_RT_MAX_SYMBOLS symbols.
   */
  runtimeMetrics?: boolean;
  /**
   * LLM Observability (MONEY-1380). Both fields are OPTIONAL OVERRIDES — the
   * feature itself is armed by `DD_LLMOBS_ENABLED`, never by passing this.
   * See {@link llmobsConfig} for why that separation is load-bearing.
   */
  llmobs?: {
    /** Top-level grouping in the LLM Obs UI. Defaults to the service name. */
    mlApp?: string;
    /** true on Vercel (HTTP intake), false on Cloud Run (agent sidecar). */
    agentlessEnabled?: boolean;
  };
}

/**
 * dd-trace's own truthiness, mirrored exactly (`dd-trace/src/util.js`).
 *
 * It MUST agree with the tracer's parse. dd-trace reads `DD_LLMOBS_ENABLED`
 * from the environment itself, so a gate here that disagreed would produce the
 * two worst outcomes available: we omit the config while dd-trace enables the
 * product (spans with no `ml_app` intent), or we supply it while dd-trace
 * thinks the feature is off.
 *
 * Note `Boolean("false")` is `true`, which is the coercion that armed a job its
 * spec shipped disarmed (MONEY-1214) — hence literal comparison, here as there.
 */
function isTrue(value: string | undefined): boolean {
  const s = String(value).toLowerCase();
  return s === "true" || s === "1";
}

/**
 * Resolve the `llmobs` block, or `undefined` to leave the key OFF THE CONFIG
 * ENTIRELY.
 *
 * ## Returning undefined is the whole point
 *
 * `dd-trace/src/config/index.js:1023` reads:
 *
 * ```js
 * if (this.#env['llmobs.enabled'] == null && options.llmobs) {
 *   setBoolean(opts, 'llmobs.enabled', true)
 * }
 * ```
 *
 * So merely PASSING an `llmobs` object turns LLM Observability on whenever
 * `DD_LLMOBS_ENABLED` is unset. Every `initTracer` caller in this repo would
 * then enable it — local `yarn dev`, every test that boots the tracer, every
 * environment that never opted in. And enabling it where there is no agent and
 * no API key does not degrade quietly: `setAgentStrategy` probes the agent,
 * fails, selects agentless, and `llmobs/index.js:69` THROWS
 *   "Cannot send LLM Observability data without a running agent or without
 *    both a Datadog API key and site"
 * from inside an async callback, where no caller's try/catch can reach it.
 *
 * Gating on the env var and omitting the key keeps "off" genuinely absent.
 *
 * ## Why `agentlessEnabled` is always an explicit boolean
 *
 * Same function, the other branch. `setAgentStrategy`
 * (`llmobs/writers/util.js`) returns IMMEDIATELY when `agentlessEnabled` is
 * non-null, and otherwise probes the agent's `/info` for the `/evp_proxy/v2/`
 * endpoint. That probe is a boot-time race: a Cloud Run app container that
 * starts before its `datadog-agent` sidecar is ready gets an error, flips to
 * agentless, and — with no `DD_API_KEY` on the app container, which is exactly
 * how `workers/cloudbuild.*.yaml` is written — throws and kills the process.
 *
 * Resolving to `false` rather than leaving it undefined removes that race
 * instead of narrowing it. Vercel sets `DD_LLMOBS_AGENTLESS_ENABLED=1` because
 * it has no agent at all.
 *
 * ## What stating `false` gives up, and why QA is the proof
 *
 * The probe it replaces does not only race — it also CHECKS, for
 * `/evp_proxy/v2/` in the agent's `/info`. Stating the answer asserts that the
 * `serverless-init` sidecar proxies that endpoint, and nothing in this repo has
 * measured it: `llmobs-wired.test.ts` stands up a stub agent, which by
 * construction cannot tell us what the real one serves. If it does not, every
 * payload gets a non-2xx that is logged internally and dropped.
 *
 * That is why MONEY-1380 gates prod on OBSERVING a span arrive in QA rather
 * than on the specs being armed. Treat "workers emit LLM Obs spans" as unproven
 * until that has been seen.
 */
export function llmobsConfig(
  opts: TracerOptions,
  envSource: NodeJS.ProcessEnv = process.env,
): { mlApp: string; agentlessEnabled: boolean } | undefined {
  if (!isTrue(envSource.DD_LLMOBS_ENABLED)) return undefined;

  const agentlessEnabled =
    opts.llmobs?.agentlessEnabled ??
    isTrue(envSource.DD_LLMOBS_AGENTLESS_ENABLED);

  // AGENTLESS WITHOUT A KEY WOULD STOP THE APP BOOTING, so the feature turns
  // itself off instead.
  //
  // This is the same throw the doc-comment above describes, reached by the
  // OTHER path — and that path is SYNCHRONOUS. `setAgentStrategy` calls its
  // callback inline when `agentlessEnabled` is non-null
  // (`llmobs/writers/util.js:12`), and `llmobs/index.js:68` throws when
  // agentless is chosen without both an API key and a site. Synchronously,
  // that escapes `tracer.init()` -> `initTracer()` -> the module evaluation of
  // `apps/api/src/tracer.ts`, which `app.ts` imports at its top — so the API
  // does not start at all.
  //
  // It is reachable from ordinary configuration: any Vercel scope (Preview,
  // Development) or a local `.env.local` from `vercel env pull` that carries
  // DD_LLMOBS_ENABLED and DD_LLMOBS_AGENTLESS_ENABLED but not the DD_API_KEY
  // secret. Telemetry must never be able to take the product down, so the
  // trade is one-way: no key, no LLM Obs, app boots.
  //
  // Warned rather than dropped in silence — a fail-open default that says
  // nothing is its own defect, and this one is invisible from the outside
  // (an empty LLM Obs page looks exactly like an unused feature).
  if (agentlessEnabled && !envSource.DD_API_KEY) {
    console.warn(
      "[datadog] LLM Observability asked for agentless mode without DD_API_KEY; " +
        "disabling it rather than failing to boot. Set DD_API_KEY, or unset " +
        "DD_LLMOBS_AGENTLESS_ENABLED to use a local agent.",
    );
    return undefined;
  }

  return {
    // `ml_app` groups everything in the UI. Unwrapped call sites land on the
    // service name, which is a visible "not yet attributed" bucket rather than
    // a drop — `llmWorkflow()` narrows the ones that matter.
    mlApp: opts.llmobs?.mlApp ?? envSource.DD_LLMOBS_ML_APP ?? opts.service,
    agentlessEnabled,
  };
}

/**
 * The resolved dd-trace config, as a value.
 *
 * Extracted so the defaults can be TESTED without booting dd-trace: `init` is
 * a once-per-process side effect with a module-level latch, so a test that
 * drives `initTracer` can observe exactly one resolution and opens real agent
 * connections to do it. The interesting property here is a default — that a
 * caller passing no options still gets the profiler — and a default is
 * precisely what a single-shot test cannot check.
 */
export function tracerConfig(
  opts: TracerOptions,
  env: string,
  envSource: NodeJS.ProcessEnv = process.env,
) {
  const llmobs = llmobsConfig(opts, envSource);

  return {
    service: opts.service,
    env,
    // MONEY-1380 — STATE the site; never inherit it from the environment here.
    //
    // dd-trace reads `DD_SITE` and otherwise defaults to `datadoghq.com`, which
    // is US1 — a different Datadog org from ours. That default is harmless
    // while every payload goes to a local agent (the agent carries its own
    // DD_SITE), and becomes load-bearing the moment anything runs AGENTLESS:
    // the LLM Obs writer posts straight to `https://api.{site}`, so a us5 key
    // presented to US1 is answered 403, logged through dd-trace's internal
    // logger and DROPPED. Every Vercel span would vanish, and vanish is
    // indistinguishable from a feature nobody used.
    //
    // `DD_SITE` is not in the Vercel env for web or api, so relying on it would
    // have made that the default outcome rather than an edge case.
    // `constants.ts` is the single source the whole repo already spells this
    // once in, and `site-agreement.test.ts` holds every other surface to it.
    site: DD_SITE,
    version: envSource.DD_VERSION || "1.0.0",
    logInjection: true,
    // `?? true`, never `|| true`: `false || true` is true, which would make
    // both switches unpressable while looking set.
    runtimeMetrics: opts.runtimeMetrics ?? true,
    profiling: opts.profiling ?? true,
    appsec: false,
    // Spread, so the key is ABSENT — not present-and-undefined — when LLM Obs
    // is off. dd-trace checks `options.llmobs` for truthiness to decide whether
    // to self-enable; see llmobsConfig.
    ...(llmobs ? { llmobs } : {}),
  };
}

/**
 * Initialize the Datadog tracer. Safe to call multiple times - only the first
 * call takes effect.
 *
 * @returns The dd-trace tracer instance (useful for custom spans).
 */
export function initTracer(opts: TracerOptions) {
  if (initialized) return tracer;
  if (process.env.DD_TRACE_ENABLED === "false") return tracer;

  const env = opts.env || getDatadogEnv();

  tracer.init(tracerConfig(opts, env));

  initialized = true;
  return tracer;
}

export { tracer };
