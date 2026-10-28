/**
 * MONEY-1357 — the profiler is opt-OUT, and only one process opts out.
 *
 * `initTracer` set `runtimeMetrics: true, profiling: true` unconditionally.
 * That was free for years because the profiler had nowhere to upload to: the
 * workers image bakes `DD_TRACE_ENABLED=true`, so on every service without an
 * agent it collected and failed fast against a refused port. Giving
 * `tiingo-realtime` a sidecar ARMED it — roughly 1,440 pprof serialise-and-upload
 * cycles a day, plus a GC `PerformanceObserver`, on a singleton event loop that
 * `run.googleapis.com/cpu-throttling: "false"` exists to keep free.
 *
 * The resolution is tested through `tracerConfig` rather than `initTracer`
 * because `initTracer` is a once-per-process side effect behind a module-level
 * latch: a test could observe exactly ONE resolution, and would open real agent
 * connections to do it. The property that matters most here is a DEFAULT — that
 * the four option-less callers (`stockbook-workers`, `stockbook-web`,
 * `stockbook-api`, and any future one) still get the profiler — and a default is
 * precisely what a single-shot test cannot check.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tracerConfig, llmobsConfig } from "../src/tracer";
import { llmWorkflow } from "../src/llmobs";

describe("tracerConfig — profiling and runtime metrics", () => {
  it("DEFAULTS to on, so an option-less caller is unchanged", () => {
    // Every other service passes `{ service }` and nothing else. If this flips,
    // three services silently lose their profiler to a change made for one.
    const c = tracerConfig({ service: "stockbook-workers" }, "production");
    assert.equal(c.profiling, true);
    assert.equal(c.runtimeMetrics, true);
    assert.equal(c.service, "stockbook-workers");
    assert.equal(c.env, "production");
  });

  it("an explicit false turns them OFF", () => {
    const c = tracerConfig(
      { service: "tiingo-realtime", profiling: false, runtimeMetrics: false },
      "production",
    );
    assert.equal(c.profiling, false);
    assert.equal(c.runtimeMetrics, false);
  });

  it("the two switches are independent", () => {
    // They are off together on the one service that sets them, which is exactly
    // the shape where a single shared flag would pass this suite while being
    // unable to express any other combination.
    const a = tracerConfig({ service: "s", profiling: false }, "qa");
    assert.equal(a.profiling, false);
    assert.equal(a.runtimeMetrics, true);

    const b = tracerConfig({ service: "s", runtimeMetrics: false }, "qa");
    assert.equal(b.profiling, true);
    assert.equal(b.runtimeMetrics, false);
  });

  it("resolves with `??`, not `||` — false must survive", () => {
    // `false || true` is true. Coalescing with `||` would make both switches
    // unpressable while looking set, which is the same class as
    // `Boolean("false")` arming a job the spec ships disarmed (MONEY-1214).
    // This case is the one that fails if the operator drifts back.
    const c = tracerConfig(
      { service: "s", profiling: false, runtimeMetrics: false },
      "qa",
    );
    assert.notEqual(c.profiling, true, "`||` would resolve false back to true");
    assert.notEqual(c.runtimeMetrics, true);
  });

  it("carries the rest of the config through unchanged", () => {
    // A guard on the fields this refactor moved but must not have altered.
    const c = tracerConfig({ service: "stockbook-api" }, "qa");
    assert.equal(c.logInjection, true);
    assert.equal(c.appsec, false);
    assert.equal(typeof c.version, "string");
    assert.ok(c.version.length > 0, "version must never be empty");
  });
});

/**
 * MONEY-1380 — LLM Observability resolution.
 *
 * Both properties below are ones where the OBVIOUS implementation breaks
 * production, and neither is visible by reading our own code: they are
 * behaviours of dd-trace that only show up in its source.
 */
describe("llmobsConfig — the key must be ABSENT when the feature is off", () => {
  it("returns undefined when DD_LLMOBS_ENABLED is unset", () => {
    assert.equal(llmobsConfig({ service: "s" }, {}), undefined);
  });

  it("tracerConfig then omits the key entirely — not present-and-undefined", () => {
    // THE trap. `dd-trace/src/config/index.js:1023` self-enables LLM Obs on the
    // mere PRESENCE of an `llmobs` option:
    //   if (this.#env['llmobs.enabled'] == null && options.llmobs) { ...true }
    // so `{ llmobs: undefined }` is safe only because `undefined` is falsy,
    // and `{ llmobs: {} }` would NOT be. Enabling it where there is no agent
    // and no API key throws from an async callback and kills the process, so
    // every local dev shell and CI run depends on this key being absent.
    const c = tracerConfig({ service: "stockbook-workers" }, "production", {});
    assert.ok(
      !("llmobs" in c),
      "`llmobs` must not appear on the config at all when the feature is off",
    );
  });

  it("accepts dd-trace's own truthy spellings, and only those", () => {
    // Must agree with `isTrue` in dd-trace/src/util.js, because dd-trace reads
    // the same variable itself. A gate that disagreed would either omit our
    // ml_app while dd-trace enabled the product, or the reverse.
    for (const on of ["1", "true", "TRUE"]) {
      assert.ok(
        llmobsConfig({ service: "s" }, { DD_LLMOBS_ENABLED: on }),
        `${on} should enable`,
      );
    }
    for (const off of ["0", "false", "", "yes", "on"]) {
      assert.equal(
        llmobsConfig({ service: "s" }, { DD_LLMOBS_ENABLED: off }),
        undefined,
        `${off} must NOT enable`,
      );
    }
  });
});

describe("llmobsConfig — mlApp precedence", () => {
  const ON = { DD_LLMOBS_ENABLED: "1" };

  it("falls back to the SERVICE name, so an unwrapped call is bucketed not dropped", () => {
    assert.equal(
      llmobsConfig({ service: "stockbook-web" }, ON)?.mlApp,
      "stockbook-web",
    );
  });

  it("prefers DD_LLMOBS_ML_APP over the service name", () => {
    const c = llmobsConfig(
      { service: "s" },
      { ...ON, DD_LLMOBS_ML_APP: "from-env" },
    );
    assert.equal(c?.mlApp, "from-env");
  });

  it("an explicit option beats both", () => {
    const c = llmobsConfig(
      { service: "s", llmobs: { mlApp: "explicit" } },
      { ...ON, DD_LLMOBS_ML_APP: "from-env" },
    );
    assert.equal(c?.mlApp, "explicit");
  });
});

describe("llmobsConfig — agentlessEnabled is never left undefined", () => {
  const ON = { DD_LLMOBS_ENABLED: "1" };

  it("defaults to FALSE (use the agent) rather than absent", () => {
    // `setAgentStrategy` (dd-trace/src/llmobs/writers/util.js) returns at once
    // when this is non-null, and otherwise probes the agent's /info. That probe
    // is a boot race on Cloud Run: an app container that starts before its
    // datadog-agent sidecar gets an error, selects agentless, and — with no
    // DD_API_KEY on the app container, which is how our specs are written —
    // throws from an async callback and takes the process down.
    const c = llmobsConfig({ service: "stockbook-workers" }, ON);
    assert.equal(c?.agentlessEnabled, false);
    assert.notEqual(
      c?.agentlessEnabled,
      undefined,
      "undefined re-arms the boot probe",
    );
  });

  it("is TRUE when DD_LLMOBS_AGENTLESS_ENABLED is set — the Vercel case", () => {
    // DD_API_KEY belongs to the Vercel case rather than being incidental to
    // it: agentless posts straight to the intake, so without a key dd-trace
    // throws SYNCHRONOUSLY out of tracer.init() and the app never boots. The
    // "must not stop the app booting" suite below covers that directly.
    const c = llmobsConfig(
      { service: "stockbook-web" },
      { ...ON, DD_LLMOBS_AGENTLESS_ENABLED: "1", DD_API_KEY: "k" },
    );
    assert.equal(c?.agentlessEnabled, true);
  });

  it("an explicit `false` option survives — `??`, not `||`", () => {
    const c = llmobsConfig(
      { service: "s", llmobs: { agentlessEnabled: false } },
      { ...ON, DD_LLMOBS_AGENTLESS_ENABLED: "1" },
    );
    assert.equal(
      c?.agentlessEnabled,
      false,
      "`||` would resolve false back to the env's true",
    );
  });
});

describe("llmWorkflow — the OFF path, which is what every dev machine runs", () => {
  // No tracer is initialised in a unit test, so `tracer.llmobs` is undefined
  // here. That is not an artificial condition: it is the state on every local
  // `yarn dev`, in CI, and anywhere DD_TRACE_ENABLED is false. A feature entry
  // point must never fail, change value, or lose an error because telemetry is
  // off — and a bare `tracer.llmobs.trace(...)` would throw a TypeError in
  // exactly this state.

  it("calls fn exactly once and returns its value", async () => {
    let calls = 0;
    const result = await llmWorkflow("research", "probe", async () => {
      calls++;
      return "value";
    });
    assert.equal(result, "value");
    assert.equal(
      calls,
      1,
      "fn must run exactly once, never twice or zero times",
    );
  });

  it("PROPAGATES a rejection rather than swallowing it", async () => {
    // A wrapper that swallowed this would turn a failed research run into a
    // silent success — the worst possible trade for an observability feature.
    const boom = new Error("upstream failed");
    await assert.rejects(
      llmWorkflow("roast", "probe", async () => {
        throw boom;
      }),
      (e: unknown) => e === boom,
      "the original error object must arrive unchanged",
    );
  });

  it("accepts the options argument without requiring it", async () => {
    assert.equal(await llmWorkflow("fire", "probe", async () => 1), 1);
    assert.equal(
      await llmWorkflow("fire", "probe", async () => 2, { sessionId: "s1" }),
      2,
    );
  });
});

describe("llmobsConfig — agentless without a key must not stop the app booting", () => {
  const ON = { DD_LLMOBS_ENABLED: "1", DD_LLMOBS_AGENTLESS_ENABLED: "1" };
  const quiet = <T>(fn: () => T): T => {
    // The path under test warns on purpose; keep it out of the suite output.
    const warn = console.warn;
    console.warn = () => {};
    try {
      return fn();
    } finally {
      console.warn = warn;
    }
  };

  it("turns the feature OFF when agentless is asked for with no DD_API_KEY", () => {
    // `setAgentStrategy` calls its callback SYNCHRONOUSLY when
    // `agentlessEnabled` is non-null (llmobs/writers/util.js:12), and
    // llmobs/index.js:68 throws when agentless is chosen without both an API
    // key and a site. Synchronously, that escapes tracer.init() -> initTracer()
    // -> the module evaluation of apps/api/src/tracer.ts, which app.ts imports
    // at its top: the API does not boot.
    //
    // Reachable from ordinary config — a Vercel Preview scope, or a local
    // .env.local from `vercel env pull`, carrying the two LLMOBS vars without
    // the DD_API_KEY secret.
    assert.equal(
      quiet(() => llmobsConfig({ service: "stockbook-api" }, ON)),
      undefined,
    );
  });

  it("keeps agentless ON when the key IS present", () => {
    const c = llmobsConfig(
      { service: "stockbook-api" },
      { ...ON, DD_API_KEY: "k" },
    );
    assert.equal(c?.agentlessEnabled, true);
  });

  it("AGENT mode is unaffected — no key is needed there", () => {
    // Cloud Run posts through the sidecar, which carries its own key. Requiring
    // one on the app container would disable the workers' LLM Obs entirely.
    const c = llmobsConfig(
      { service: "stockbook-workers" },
      { DD_LLMOBS_ENABLED: "1" },
    );
    assert.equal(c?.agentlessEnabled, false);
    assert.equal(c?.mlApp, "stockbook-workers");
  });

  it("says so rather than disabling in silence", () => {
    const seen: unknown[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => seen.push(a.join(" "));
    try {
      llmobsConfig({ service: "s" }, ON);
    } finally {
      console.warn = warn;
    }
    assert.equal(seen.length, 1, "exactly one warning");
    assert.match(String(seen[0]), /DD_API_KEY/);
  });
});
