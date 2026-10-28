/**
 * THE DEAD-WIRING GUARD for the realtime socket holder.
 *
 * ## Why this file exists
 *
 * MONEY-1309 shipped a service that connected to Tiingo and received nothing,
 * for a whole review cycle, with a green suite and a `/health` returning 200.
 * The cause was not a wrong line anywhere. It was an ABSENT one:
 * `planSubscriptions` and `TiingoSocket.applyDelta` were written, exported,
 * documented and unit-tested — and called by nothing. `main.ts`'s header
 * described three timers; `start()` registered two.
 *
 * Because the Tiingo auth token rides inside the SUBSCRIBE frame rather than
 * the handshake, "never subscribes" degrades to "never authenticates", so the
 * failure was total rather than partial:
 *
 *   no subscribe frame -> no auth -> no frames -> `rt:us:quote:*` never written
 *   -> every US quote falls back to the EOD close, permanently, wearing an
 *      honest badge that says so
 *
 * Every unit test passed because every unit was correct. The 15 cases in
 * `tiingo-rt-subscription-logic.test.ts` exercised a function with zero
 * production callers. THE JOIN was what was missing, and no test looked at it.
 *
 * ## What this guard asserts
 *
 * For each export that must be ON THE LIVE PATH: it exists where we say it
 * does, AND at least one production file other than its own declaration
 * references it. That is a weak property — a caller could still be inside dead
 * code — but it is exactly strong enough to catch the failure that happened,
 * and it costs nothing to keep true.
 *
 * It is deliberately NOT a source-text scan of `main.ts` for the string
 * `setInterval`. That would pin the spelling rather than the property, and the
 * next version of this bug will be spelled differently.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decideHealth } from "../../src/realtime/health-logic";
import { RT_GAUGE_METRICS } from "../../src/realtime/rt-metrics-logic";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Where production code lives. Tests and build output are not callers. */
const SCAN_ROOTS = [
  join(REPO, "workers", "src"),
  join(REPO, "packages", "core", "src"),
  join(REPO, "apps", "web", "app"),
  join(REPO, "apps", "web", "lib"),
];

/**
 * Strip comments before looking for a reference.
 *
 * A symbol named in a doc-comment is PROSE, not a call. This distinction is the
 * whole point here: every dead export in this feature was extensively described
 * in comments, and a scan that counted those would have reported the wiring as
 * present. That is not hypothetical — the modules that documented the missing
 * timer named it by symbol in their headers.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

function tsFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next")
        continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
        out.push(full);
    }
  };
  walk(root);
  return out;
}

interface LivePathExport {
  /** The identifier as written in source. */
  symbol: string;
  /** Repo-relative path of the file that DECLARES it. */
  declaredIn: string;
  /** What breaks, concretely, if nothing calls it. */
  why: string;
}

/**
 * The live path. Each entry is something whose absence is silent.
 *
 * A new entry belongs here when the answer to "what happens if nothing calls
 * this?" is a quiet degradation rather than a crash.
 */
const LIVE_PATH: readonly LivePathExport[] = [
  {
    symbol: "planSubscriptions",
    declaredIn:
      "packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts",
    why: "nothing decides which symbols to subscribe to; the socket holds an empty set",
  },
  {
    symbol: "applyDelta",
    declaredIn: "workers/src/realtime/tiingo-socket.ts",
    why: "no subscribe frame is ever sent, so the socket never authenticates either",
  },
  {
    symbol: "refreshSubscriptions",
    declaredIn: "workers/src/realtime/subscription.ts",
    why: "the subscription timer has nothing to run; the set never changes",
  },
  {
    symbol: "toCandleRow",
    declaredIn: "packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts",
    why: "closed minute bars are computed, retired from the aggregator, and dropped",
  },
  {
    symbol: "mayWriteIntoDay",
    declaredIn: "packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts",
    why: "realtime bars can overwrite EOD bars, making the volume column meaningless",
  },
  {
    symbol: "groupBySymbolDay",
    declaredIn: "packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts",
    why: "the mixed-source rule is never evaluated per symbol-day",
  },
  {
    symbol: "toQuotePayload",
    declaredIn: "packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts",
    why: "no quote is ever written to Redis for the web path to read",
  },
  {
    symbol: "pingUsSymbolInterest",
    declaredIn: "packages/core/src/market-data/tiingo/tiingo-rt-read.ts",
    why: "opening a US symbol page never registers interest, so it is never subscribed",
  },
  {
    symbol: "toArchiveLine",
    declaredIn: "packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts",
    why: "no raw ticks reach feeds/TIINGO/ws/, so the 30-day re-derivation window is empty while five docs claim it is filling",
  },
  {
    symbol: "decideHealth",
    declaredIn: "workers/src/realtime/health-logic.ts",
    why: "/health cannot say no, so a leader holding a socket that receives nothing is never restarted",
  },
  {
    symbol: "decideLeadership",
    declaredIn:
      "packages/core/src/market-data/tiingo/tiingo-rt-leader-logic.ts",
    why: "two overlapping revisions both hold a socket and double-write bars",
  },
];

describe("realtime wiring — every live-path export has a production caller", () => {
  const files = SCAN_ROOTS.flatMap(tsFiles);
  const stripped = new Map(
    files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]),
  );

  it("PREMISE: the scan actually resolved production files", () => {
    // Without a floor this whole suite passes by finding nothing — the shape
    // where a root array is retargeted at a directory that does not exist and
    // an absence-assertion stays green. A falsifiable check needs a ceiling.
    assert.ok(
      files.length > 500,
      `scan found only ${files.length} files; the roots are wrong: ${SCAN_ROOTS.join(", ")}`,
    );
    for (const root of SCAN_ROOTS) {
      assert.ok(existsSync(root), `scan root does not exist: ${root}`);
      assert.ok(
        tsFiles(root).length > 0,
        `scan root resolved zero files: ${root}`,
      );
    }
  });

  it("PREMISE: every listed symbol exists where we claim it does", () => {
    // A rename must fail LOUDLY here rather than silently turning the caller
    // check into a search for a string nothing contains — which would pass.
    for (const e of LIVE_PATH) {
      const full = join(REPO, e.declaredIn);
      assert.ok(
        existsSync(full),
        `${e.symbol}: declaring file is gone: ${e.declaredIn}`,
      );
      assert.match(
        readFileSync(full, "utf8"),
        new RegExp(`\\b${e.symbol}\\b`),
        `${e.symbol} is not declared in ${e.declaredIn} any more`,
      );
    }
  });

  for (const e of LIVE_PATH) {
    it(`${e.symbol} is called from production code`, () => {
      const declaring = join(REPO, e.declaredIn);
      const re = new RegExp(`\\b${e.symbol}\\b`);
      const callers = files.filter(
        (f) => f !== declaring && re.test(stripped.get(f) ?? ""),
      );
      assert.ok(
        callers.length > 0,
        `${e.symbol} has NO production caller — it is dead wiring.\n` +
          `  declared in : ${e.declaredIn}\n` +
          `  consequence : ${e.why}\n` +
          `  This is the MONEY-1309 failure: an export that is written, tested\n` +
          `  and never invoked reads as a finished feature and ships disarmed.`,
      );
    });
  }

  it("POSITIVE CONTROL: an export nothing calls IS detected as dead", () => {
    // Proves the check above can fail. Without this, a scan that silently
    // matched everything (a broken regex, an over-eager strip) would report all
    // nine as wired while checking nothing.
    const invented = "__thisSymbolIsDeliberatelyNeverDefinedAnywhere__";
    const callers = files.filter((f) =>
      new RegExp(`\\b${invented}\\b`).test(stripped.get(f) ?? ""),
    );
    assert.equal(
      callers.length,
      0,
      "the control symbol should have no callers",
    );
  });

  it("POSITIVE CONTROL: a comment mention does NOT count as a caller", () => {
    // The dead exports in this feature were all richly documented. A scan that
    // counted prose would have called the wiring present.
    const src = `/** planSubscriptions is great */\n// planSubscriptions again\nconst x = 1;`;
    assert.doesNotMatch(stripComments(src), /planSubscriptions/);
  });
});

describe("realtime wiring — the liveness probe must not cancel the backoff ladder", () => {
  // These two fixes are individually correct and cancel each other if the
  // numbers drift. `/health` gained the ability to return 503 so a wedged
  // leader gets restarted; the socket gained a backoff ladder that only climbs
  // if the PROCESS SURVIVES between attempts. A probe that fails during an
  // ordinary reconnect has Cloud Run restart the container, which builds a
  // fresh TiingoSocket with `attempt` back at 0 — so the ladder never reaches
  // its second rung and the reconnect storm the ladder exists to prevent
  // happens anyway, with both changes looking correct in their own files.
  //
  // main.ts calls `start()` at import, so it cannot be imported here; the
  // threshold is read from source and compared against the real constants.
  const mainSrc = readFileSync(
    join(REPO, "workers/src/realtime/main.ts"),
    "utf8",
  );
  const socketSrc = readFileSync(
    join(REPO, "workers/src/realtime/tiingo-socket.ts"),
    "utf8",
  );

  const num = (src: string, name: string): number => {
    const m = new RegExp(`\\b${name}\\s*=\\s*([0-9_]+)`).exec(src);
    assert.ok(m, `${name} not found — this test cannot check what it claims`);
    return Number(m![1]!.replace(/_/g, ""));
  };

  it("the unhealthy threshold exceeds a full reconnect cycle", () => {
    const unhealthyAfter = num(mainSrc, "UNHEALTHY_AFTER_MS");
    const backoffMax = num(socketSrc, "BACKOFF_MAX_MS");
    const heartbeat = num(socketSrc, "HEARTBEAT_TIMEOUT_MS");

    assert.ok(
      unhealthyAfter > backoffMax + heartbeat,
      `UNHEALTHY_AFTER_MS (${unhealthyAfter}) must exceed BACKOFF_MAX_MS ` +
        `(${backoffMax}) + HEARTBEAT_TIMEOUT_MS (${heartbeat}) = ` +
        `${backoffMax + heartbeat}, or the liveness probe restarts the container ` +
        "during an ordinary reconnect and resets the backoff ladder to its first rung",
    );
  });

  it("BEHAVIOURAL: a leader mid-reconnect stays healthy, and a wedged one does not", () => {
    // This case replaces a VACUOUS one. It used to assert that the identifier
    // `lastSocketHealthyMs` appeared in main.ts — which stays true when the
    // grace-window logic is deleted, because the declaration survives. Deleting
    // the logic left it GREEN. The decision now lives in a pure module so it
    // can be driven instead of grepped.
    const base = {
      leader: true,
      socketConnected: false,
      msSinceLastFrame: Infinity,
      lastHealthyAtMs: 1_000_000,
      heartbeatTimeoutMs: 45_000,
      unhealthyAfterMs: 180_000,
    };

    // Just disconnected — an ordinary reconnect, must NOT restart the container.
    assert.equal(decideHealth({ ...base, nowMs: 1_000_000 + 1_000 }).ok, true);
    // Still inside a full backoff + heartbeat cycle.
    assert.equal(
      decideHealth({ ...base, nowMs: 1_000_000 + 105_000 }).ok,
      true,
    );
    // Past the grace window — genuinely wedged, restart it.
    assert.equal(
      decideHealth({ ...base, nowMs: 1_000_000 + 180_001 }).ok,
      false,
    );
  });

  it("BEHAVIOURAL: a follower with no socket is healthy; a silent open socket is not", () => {
    const now = 2_000_000;
    // A follower holds no socket by design — restarting them would churn the
    // election for nothing.
    assert.equal(
      decideHealth({
        leader: false,
        socketConnected: false,
        msSinceLastFrame: Infinity,
        lastHealthyAtMs: 0,
        nowMs: now,
        heartbeatTimeoutMs: 45_000,
        unhealthyAfterMs: 180_000,
      }).ok,
      true,
    );
    // THE failure this probe exists for: connected, but receiving nothing —
    // indistinguishable from a quiet market until something checks the clock.
    const wedged = decideHealth({
      leader: true,
      socketConnected: true,
      msSinceLastFrame: 60_000,
      lastHealthyAtMs: now - 200_000,
      nowMs: now,
      heartbeatTimeoutMs: 45_000,
      unhealthyAfterMs: 180_000,
    });
    assert.equal(wedged.ok, false);
    assert.match(wedged.reason, /silent/);
  });

  it("BEHAVIOURAL: a live socket advances the health clock", () => {
    // Without this the grace window is measured from an ever-older instant and
    // a long-running healthy leader eventually reports 503.
    const v = decideHealth({
      leader: true,
      socketConnected: true,
      msSinceLastFrame: 1_000,
      lastHealthyAtMs: 1,
      nowMs: 5_000_000,
      heartbeatTimeoutMs: 45_000,
      unhealthyAfterMs: 180_000,
    });
    assert.equal(v.ok, true);
    assert.equal(v.lastHealthyAtMs, 5_000_000, "the clock must move forward");
  });
});

describe("realtime wiring — the timers the service documents are the timers it runs", () => {
  const mainSrc = readFileSync(
    join(REPO, "workers/src/realtime/main.ts"),
    "utf8",
  );
  const body = stripComments(mainSrc);

  it("start() registers one interval per documented timer", () => {
    // The header documents leader / subscribe / flush. It documented all three
    // while `start()` registered two, and nothing compared them.
    const intervals = body.match(/setInterval\(/g) ?? [];
    assert.equal(
      intervals.length,
      3,
      `expected 3 setInterval registrations (leader, subscribe, flush), found ${intervals.length}`,
    );
  });

  it("each timer's period constant is actually passed to a timer", () => {
    // `SUBSCRIPTION_REFRESH_MS` was declared, exported, and never passed to
    // anything — a constant whose only consumer was the export list.
    for (const period of [
      "LEADER_RENEW_MS",
      "SUBSCRIPTION_REFRESH_MS",
      "FLUSH_MS",
    ]) {
      assert.match(
        body,
        new RegExp(`setInterval\\([^;]*?\\b${period}\\b`, "s"),
        `${period} is never passed to a setInterval — the timer it names does not run`,
      );
    }
  });
});

describe("MONEY-1357 — tiingo-realtime reports to Datadog under its own name", () => {
  /**
   * This service was DARK on both environments, measured 2026-09-05: no `DD_*`
   * env, no sidecar, no key. The image bakes `DD_TRACE_ENABLED=true` and
   * `DD_SERVICE=stockbook-workers`, so dd-trace booted against an agent that
   * was not there and dropped every span, while `datadog-metrics` no-op'd for
   * want of a key. Nothing errored — the one process that must not die simply
   * had no external signal at all.
   *
   * The heredoc is extracted rather than the whole file scanned, because the
   * SAME secret names and the same annotation block appear in the
   * `stockbook-workers` service above it. A whole-file assertion passes when
   * the realtime wiring has landed in the wrong container — which is exactly
   * what happened while writing this, and is why the extraction is the first
   * thing asserted.
   */
  const heredoc = (spec: string): string => {
    const src = readFileSync(join(REPO, "workers", spec), "utf8");
    const start = src.indexOf("cat > /tmp/tiingo-realtime.yaml << EOF\n");
    assert.ok(start > 0, `${spec}: no realtime heredoc`);
    const end = src.indexOf("\n        EOF\n", start);
    assert.ok(end > start, `${spec}: unterminated realtime heredoc`);
    return src.slice(start, end);
  };

  for (const spec of ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"]) {
    describe(spec, () => {
      const block = heredoc(spec);

      it("PREMISE: the extracted block is the realtime service, not the worker pool", () => {
        assert.match(block, /name: tiingo-realtime-(prod|qa)/);
        assert.doesNotMatch(block, /name: stockbook-workers-(prod|qa)/);
      });

      it("runs a datadog-agent sidecar, and waits for it", () => {
        assert.match(
          block,
          /- name: datadog-agent\n\s+image: gcr\.io\/datadoghq\/serverless-init:latest/,
          "no sidecar — dd-trace has nothing to send to and every span is dropped",
        );
        assert.match(
          block,
          /container-dependencies: '\{"tiingo-realtime":\["datadog-agent"\]\}'/,
          "without the dependency a cold start emits before the agent is up",
        );
      });

      /**
       * The two containers, split apart — and that is the point of this helper
       * rather than scanning `block`.
       *
       * Both carry a `DD_API_KEY` block, so a whole-block regex for one is
       * satisfied by the OTHER. Mutation-checked: deleting the key from the app
       * container left a block-wide assertion green, while the metrics that
       * need it (`datadog-metrics`, which runs in the app container and no-ops
       * without a key) would have gone nowhere. Per container, or it proves
       * nothing.
       */
      const containers = (): Record<string, string> => {
        const marker = "\n                - name: ";
        const parts = block.split(marker).slice(1);
        const out: Record<string, string> = {};
        for (const part of parts) {
          const name = part.slice(0, part.indexOf("\n")).trim();
          out[name] = part;
        }
        return out;
      };

      it("PREMISE: the block splits into exactly the two expected containers", () => {
        assert.deepEqual(Object.keys(containers()).sort(), [
          "datadog-agent",
          "tiingo-realtime",
        ]);
      });

      it("both containers report under tiingo-realtime, not stockbook-workers", () => {
        for (const [name, body] of Object.entries(containers())) {
          assert.match(
            body,
            /name: DD_SERVICE\n\s+value: tiingo-realtime\b/,
            `${name} does not report as tiingo-realtime — it would inherit the image's stockbook-workers`,
          );
        }
      });

      it("EACH container carries its own DD_API_KEY", () => {
        for (const [name, body] of Object.entries(containers())) {
          assert.match(
            body,
            /name: DD_API_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: DD_API_KEY_(PROD|QA)/,
            `${name} has no Datadog key: the agent cannot forward, and datadog-metrics in the app container no-ops`,
          );
        }
      });

      it("the app container points at the agent and enables tracing", () => {
        const app = containers()["tiingo-realtime"];
        assert.ok(app, "no tiingo-realtime container");
        assert.match(
          app,
          /DD_TRACE_AGENT_URL\n\s+value: "http:\/\/localhost:8126"/,
        );
        assert.match(app, /DD_TRACE_ENABLED\n\s+value: "true"/);
      });

      it("keeps the singleton and the un-throttled CPU the socket depends on", () => {
        // Not decoration: Cloud Run throttles CPU between requests unless this
        // is set, which starves a long-lived socket into missed heartbeats and
        // a reconnect loop. Adding a sidecar must not disturb either.
        assert.match(block, /minScale: "1"/);
        assert.match(block, /maxScale: "1"/);
        assert.match(block, /run\.googleapis\.com\/cpu-throttling: "false"/);
      });
    });
  }

  it("main.ts initialises the tracer under DD_SERVICES.REALTIME", () => {
    const src = readFileSync(
      join(REPO, "workers/src/realtime/main.ts"),
      "utf8",
    );
    const call = /initTracer\(\{[\s\S]*?\}\)/.exec(stripComments(src));
    assert.ok(call, "main.ts does not call initTracer");
    assert.match(call[0], /service:\s*DD_SERVICES\.REALTIME\b/);
    assert.doesNotMatch(
      src,
      /initTracer\(\{\s*service:\s*"stockbook-workers"/,
      "the realtime holder must not file itself under the worker pool's name",
    );
  });

  it("the profiler and runtime metrics are OFF on the always-on socket", () => {
    // The image bakes DD_TRACE_ENABLED=true, so before the sidecar the profiler
    // collected and failed fast against a refused port. The sidecar makes the
    // uploads SUCCEED — ~1,440 pprof serialise-and-upload cycles a day, plus a
    // GC PerformanceObserver in a process that allocates per frame, on the one
    // event loop `cpu-throttling: "false"` is paid for. Both default to TRUE in
    // `TracerOptions`, so this is the only place that says otherwise, and a
    // silent revert would look exactly like the fix.
    const src = stripComments(
      readFileSync(join(REPO, "workers/src/realtime/main.ts"), "utf8"),
    );
    const call = /initTracer\(\{[\s\S]*?\}\)/.exec(src);
    assert.ok(call, "main.ts does not call initTracer");
    assert.match(
      call[0],
      /profiling:\s*false\b/,
      "the continuous profiler is armed on the one process that must not have it",
    );
    assert.match(
      call[0],
      /runtimeMetrics:\s*false\b/,
      "runtime metrics install a GC observer on a per-frame allocator",
    );
  });
});

describe("MONEY-1357 — the counters this service keeps are actually emitted", () => {
  /**
   * The counters existed and were readable on `/health` and nowhere else, which
   * is the same shape as the dead exports at the top of this file: computed,
   * correct, and reaching nobody. These assert the JOIN — that `main.ts` calls
   * the emitter, from the one place that runs on every tick.
   */
  const body = readFileSync(join(REPO, "workers/src/realtime/main.ts"), "utf8");

  it("emitRtMetrics is called from flushTick's finally, not its happy path", () => {
    // flushTick returns early on: busy, not leader, nothing due. Every one of
    // those is a state an operator wants to see, and `rt.health_ok` has to be
    // emitted when the service is UNHEALTHY above all. In the `finally`, or the
    // gauge goes quiet exactly when it matters.
    const flush = /async function flushTick\(\)[\s\S]*?\n\}/.exec(body);
    assert.ok(flush, "flushTick not found");
    const tail = /\}\s*finally\s*\{([\s\S]*?)\}/.exec(flush[0]);
    assert.ok(tail, "flushTick has no finally block");
    assert.match(
      tail[1],
      /emitRtMetrics\(\)/,
      "the emit is not in the finally — early returns would report nothing",
    );
  });

  it("a BUSY flush still emits — the guard sits ABOVE the try", () => {
    // `if (flushBusy) return` is checked BEFORE the try, and `flushBusy` is
    // cleared only in the `finally`. Neither `candleSink.write` nor
    // `tickArchive.flush` carries a timeout, so a Mongo primary election latches
    // the flag for minutes and every 5s tick returns before the `try` — with the
    // emit only in the `finally`, EVERY realtime series went silent, including
    // `rt.health_ok`. 20 minutes later monitor-rt-health.json (notify_no_data)
    // paged with "a living process cannot stop emitting it. No data means the
    // process is gone", while the process was alive and `/health` returned 200
    // because `decideHealth` watches the socket, not the flush loop.
    const flush = /async function flushTick\(\)[\s\S]*?\n\}/.exec(body);
    assert.ok(flush, "flushTick not found");
    const guard = /if\s*\(flushBusy\)\s*\{([\s\S]*?)\n  \}/.exec(flush[0]);
    assert.ok(
      guard,
      "the flushBusy guard is a bare `return` — a stuck flush emits nothing " +
        "and the no-data alarm blames a process that is still running",
    );
    assert.match(
      stripComments(guard[1]),
      /emitRtMetrics\(\)/,
      "the busy early return must emit before it returns",
    );
  });

  it("the metrics path reads health WITHOUT advancing the liveness clock", () => {
    // `healthy()` used to write `lastSocketHealthyMs` back, and its only caller
    // was the 30s probe. Calling it from the 5s emitter hands the metrics loop
    // the liveness clock — see the behavioural case below for what that costs.
    const emit = /function emitRtMetrics\(\)[\s\S]*?\n\}/.exec(body);
    assert.ok(emit, "emitRtMetrics not found");
    const inner = stripComments(emit[0]);
    assert.match(
      inner,
      /healthView\(/,
      "the emitter must take the read-only view",
    );
    assert.doesNotMatch(
      inner,
      /\bhealthy\(/,
      "the 5s emitter must not call the clock-advancing health path",
    );
    assert.doesNotMatch(
      inner,
      /lastSocketHealthyMs\s*=/,
      "the 5s emitter must not write the liveness clock directly either",
    );
  });

  it("BEHAVIOURAL: sampling health every 5s and writing the clock defeats the probe", () => {
    // The mechanism, driven rather than grepped. A socket that comes up for ONE
    // 5s window every 150s, on ticks the 30s probe never lands on:
    //
    //   probe-only writer  -> the clock never moves -> 503 past the 180s grace
    //   5s writer too      -> the clock resets every 150s -> 200 forever
    //
    // Cloud Run then never restarts a container that is dropping most of the
    // feed, and nothing else in the estate notices: rt.health_ok reads 1.
    const TICK = 5_000;
    const START = 1_000_000;
    const base = {
      leader: true,
      heartbeatTimeoutMs: 45_000,
      unhealthyAfterMs: 180_000,
    };
    // Live on i ≡ 1 (mod 30) — never on a probe tick (i ≡ 0 mod 6).
    const live = (i: number): boolean => i % 30 === 1;
    const probeTick = (i: number): boolean => i % 6 === 0;

    const run = (metricsWritesClock: boolean): boolean => {
      let clock = START;
      let everUnhealthy = false;
      for (let i = 1; i <= 120; i++) {
        const nowMs = START + i * TICK;
        const input = {
          ...base,
          socketConnected: live(i),
          msSinceLastFrame: live(i) ? 0 : Infinity,
          lastHealthyAtMs: clock,
          nowMs,
        };
        // The 5s metrics sample.
        const m = decideHealth(input);
        if (metricsWritesClock) clock = m.lastHealthyAtMs;
        // The 30s probe, on its own cadence, reading the same clock.
        if (probeTick(i)) {
          const v = decideHealth({ ...input, lastHealthyAtMs: clock, nowMs });
          clock = v.lastHealthyAtMs;
          if (!v.ok) everUnhealthy = true;
        }
      }
      return everUnhealthy;
    };

    assert.equal(
      run(false),
      true,
      "with a READ-ONLY metrics path the probe must eventually 503 on a flapping socket",
    );
    assert.equal(
      run(true),
      false,
      "PREMISE: this is the defect — a 5s writer keeps downFor under the grace " +
        "window forever, so the probe can never fail. If this ever returns true " +
        "the scenario has stopped exercising the hazard and the case above is vacuous",
    );
  });

  it("the subscribed gauge and /health use the O(1) count", () => {
    // `subscribedSymbols()` spreads and SORTS a Set of up to
    // TIINGO_RT_MAX_SYMBOLS (3,000) to produce a number `Set.size` already
    // holds — 17,280 times a day on the socket's own event loop, plus every
    // health probe. Nothing in either caller consumes the ordering.
    // `subscription.ts` still uses the array; it diffs against a plan.
    assert.doesNotMatch(
      stripComments(body),
      /subscribedSymbols\(\)/,
      "main.ts must not spread-and-sort the subscription set to count it",
    );
    assert.match(body, /subscribedCount\(\)/);
  });

  it("the shutdown path emits and flushes before the process ends", () => {
    const shutdown = /async function shutdown\([\s\S]*?\n\}/.exec(body);
    assert.ok(shutdown, "shutdown not found");
    assert.match(shutdown[0], /emitRtMetrics\(\)/);
    assert.match(
      shutdown[0],
      /flushMetrics\(/,
      "datadog-metrics batches on a 15s timer; without a flush a deploy drops the final window",
    );
  });

  it("every metric the logic declares is reachable from main.ts", () => {
    // Counters go through the delta list, so the names are not written out here
    // — the gauges are, and a gauge whose constant is never referenced is a
    // series nobody emits and a dashboard widget that reads NO DATA.
    for (const key of Object.keys(RT_GAUGE_METRICS)) {
      assert.match(
        body,
        new RegExp(`RT_GAUGE_METRICS\\.${key}\\b`),
        `RT_GAUGE_METRICS.${key} is declared and never emitted`,
      );
    }
    assert.match(body, /computeRtMetricDeltas\(/);
  });

  it("the snapshot reads all three counter objects, not just the local one", () => {
    const snap = /function rtSnapshot\(\)[\s\S]*?\n\}/.exec(body);
    assert.ok(snap, "rtSnapshot not found");
    for (const source of [
      "counters.",
      "candleSink.counters.",
      "socket?.counters.",
    ]) {
      assert.ok(
        snap[0].includes(source),
        `rtSnapshot never reads ${source} — those counters would sit at zero forever`,
      );
    }
  });
});
