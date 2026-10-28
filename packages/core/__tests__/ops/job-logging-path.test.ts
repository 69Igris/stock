/**
 * Every job and service ATTACHES the Datadog log stream — MONEY-1375.
 *
 * ## The state this measures, and why it read as health
 *
 * `initLogger()` is what attaches the Datadog multistream to pino. Measured on
 * 2026-09-06, it had exactly ONE caller in the entire repo:
 * `workers/src/index.ts`. Neither `tiingo-realtime` — an always-on service —
 * nor any of the thirteen Cloud Run job scripts called it. All of them logged
 * to stdout and nowhere else.
 *
 * Nothing looked wrong. Cloud Logging carried every line, `[job-outcome]`
 * printed perfectly, and the log monitors sat in NO DATA — which after one mute
 * is indistinguishable from a job that had nothing to say. The newest log line
 * in the whole us5 org was a hand-posted probe.
 *
 * It is the twin of MONEY-1278, one layer over: that ticket found the METRICS
 * path could not emit because the jobs had no `DD_API_KEY`; this is the LOGS
 * path failing for a different reason in the same processes.
 *
 * ## Two independent halves, and either alone still ships nothing
 *
 *   1. The transport must be BUNDLED. A computed import specifier hid it from
 *      esbuild, so it was never in the output and the runtime import of a raw
 *      `.ts` threw into a silent catch. Pinned by
 *      `packages/logger/__tests__/datadog-transport-bundling.test.ts`.
 *   2. The stream must be ATTACHED — this file.
 *
 * ## Derived, not listed — and from the RIGHT source
 *
 * The population comes from the tsup ENTRY LIST, which is what actually defines
 * a deployable job. The first version read `scripts/jobs/` and claimed that
 * covered every new job "the day it is added". It did not: `bse-backfill` is
 * `../scripts/data/backfill-bse-results.ts`, a real Cloud Run job with its own
 * provisioner and a ~30h BSE walk, and it sat outside that directory unwired
 * while this suite stayed green. Deriving from a directory is only better than
 * a hand-kept list when the directory IS the population.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
/**
 * The job population comes from the TSUP ENTRY LIST, not from a directory.
 *
 * The first version read `scripts/jobs/` and claimed that covered every new job
 * "the day it is added". It did not: `bse-backfill` is
 * `../scripts/data/backfill-bse-results.ts`, a real Cloud Run job with a
 * provisioner and a ~30h BSE walk, and it sat outside that directory unwired
 * while the suite stayed green. The entry list is what actually defines a
 * deployable job, so it is what this reads.
 */
const TSUP_CONFIG = readFileSync(
  join(ROOT, "workers", "tsup.config.ts"),
  "utf8",
);

const JOB_ENTRIES: Array<{ name: string; path: string }> = [
  ...TSUP_CONFIG.matchAll(/"([a-z0-9-]+)":\s*"\.\.\/(scripts\/[^"]+\.ts)"/g),
].map((m) => ({ name: m[1] ?? "", path: m[2] ?? "" }));

const read = (p: string) => readFileSync(p, "utf8");
/**
 * Comments quote the defect; only executable code should satisfy these.
 *
 * LINE FIRST, THEN BLOCK — MONEY-1143. A `//` containing `/*` opens a phantom
 * block that runs to the next `*` + `/`, swallowing real code; measured at
 * 11,192 characters out of a single file on this tree.
 */
const code = (s: string) =>
  s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("every Cloud Run job attaches the Datadog log stream", () => {
  it("finds the job entries to check", () => {
    // A positive control: if the parse ever resolves to nothing, every
    // assertion below passes vacuously.
    assert.ok(
      JOB_ENTRIES.length >= 12,
      `only ${JOB_ENTRIES.length} job entries parsed from workers/tsup.config.ts — the scan is broken`,
    );
  });

  it("covers the job that lives outside scripts/jobs/", () => {
    // Named explicitly because it is the one a directory scan misses, and it
    // did.
    assert.ok(
      JOB_ENTRIES.some((e) =>
        e.path.includes("scripts/data/backfill-bse-results"),
      ),
      "bse-backfill is no longer in the entry list, or the parse stopped matching it",
    );
  });

  for (const entry of JOB_ENTRIES) {
    it(`${entry.name} calls initJobTelemetry()`, () => {
      const src = code(read(join(ROOT, entry.path)));
      assert.match(
        src,
        /await\s+initJobTelemetry\s*\(/,
        `${entry.name} never attaches the log stream, so it logs to stdout only`,
      );
      assert.match(
        src,
        /from\s+"\.\.\/\.\.\/workers\/src\/lib\/job-telemetry"/,
        `${entry.name} does not import the shared helper`,
      );
    });
  }
});

describe("the long-running services attach it too", () => {
  it("workers/src/index.ts attaches AND feeds the stream", () => {
    const src = code(read(join(ROOT, "workers", "src", "index.ts")));
    assert.match(
      src,
      /await\s+initLogger\s*\(/,
      "the stream is never attached",
    );
    // Attaching is half of it. This process makes ~573 `console.*` calls
    // against 3 `getLogger()` uses, so without the forwarder the stream is
    // attached and fed nothing — measured in prod, ten job types reported
    // metrics in two hours while this service shipped ZERO logs.
    assert.match(
      src,
      /forwardConsoleToDatadog\s*\(/,
      "the stream is attached but nothing forwards console into it",
    );
  });

  it("tiingo-realtime calls initLogger() and flushes on shutdown", () => {
    // An always-on service: the 5s flush timer fires while it runs, so what the
    // shutdown flush protects is the final window — which is where the leader
    // transition and the reason for the restart are.
    const src = code(read(join(ROOT, "workers", "src", "realtime", "main.ts")));
    assert.match(
      src,
      /await\s+initLogger\s*\(/,
      "tiingo-realtime never attaches the log stream",
    );
    assert.match(
      src,
      /flushLogs\s*\(/,
      "tiingo-realtime does not flush logs on shutdown",
    );
    assert.match(
      src,
      /forwardConsoleToDatadog\s*\(/,
      "tiingo-realtime attaches the stream but never forwards console into it",
    );
  });
});

describe("the shared helper does what its callers assume", () => {
  const src = code(
    read(join(ROOT, "workers", "src", "lib", "job-telemetry.ts")),
  );

  it("awaits initLogger rather than firing it and moving on", () => {
    // Not awaiting means the first lines are written before the stream is
    // attached, which is a partial loss that looks like a complete success.
    assert.match(src, /await\s+initLogger\s*\(\s*\)/);
  });

  it("registers a flush on the paths a job actually ends on", () => {
    // These jobs set `process.exitCode` and return, so the loop drains and
    // `beforeExit` fires. SIGTERM is Cloud Run reclaiming the task.
    assert.match(
      src,
      /beforeExit/,
      "no beforeExit flush — the final window is lost on normal exit",
    );
    assert.match(
      src,
      /SIGTERM/,
      "no SIGTERM flush — a reclaimed task loses its last lines",
    );
  });

  it("guards the EXIT flush, but not explicit ones", () => {
    // beforeExit can fire more than once, and a second concurrent flush would
    // race the first over the same buffer.
    // The GUARD, not merely the variable. `/flushed/` alone stayed green when
    // the early return was deleted, because the declaration and the assignment
    // still matched — a filter that cannot fail is the defect this whole branch
    // kept finding.
    assert.match(
      src,
      /if\s*\(\s*exitFlushStarted\s*\)\s*return/,
      "the EXIT flush is not guarded against re-entry",
    );
    // And the guard must NOT cover explicit calls: sharing one flag made
    // `flushJobTelemetry()` a no-op after its first use, so a job that flushed
    // mid-run then shipped nothing at exit. The delivery test caught that.
    assert.match(
      src,
      /export async function flushJobTelemetry[\s\S]{0,200}await flushTelemetry\(\)/,
      "flushJobTelemetry must always flush, not share the exit guard",
    );
  });

  it("EXITS from the signal handler, restoring the default disposition", () => {
    // Adding a listener for SIGTERM/SIGINT REPLACES Node's default disposition.
    // A handler that does not exit leaves the process alive — verified by probe:
    // a node process with a no-op SIGTERM listener survived the signal and had
    // to be SIGKILLed. None of the thirteen jobs had a signal handler before
    // this helper, so omitting the exit turns prompt termination into a hang
    // until Cloud Run's grace period expires, across every job at once, visible
    // only on a reclaimed task.
    assert.match(
      src,
      /process\.exit\(\s*code\s*\)/,
      "the signal handler must exit, or the job stops dying on SIGTERM",
    );
    assert.match(src, /143/, "SIGTERM should exit 128+15");
    assert.match(src, /130/, "SIGINT should exit 128+2");
  });

  it("bounds the flush so a hung transport cannot hold the process open", () => {
    // The exit must not be hostage to the flush: losing the last window is
    // acceptable, refusing to die is not.
    assert.match(
      src,
      /Promise\.race/,
      "the signal-path flush is unbounded — a hung transport delays termination",
    );
    assert.match(src, /SIGNAL_FLUSH_TIMEOUT_MS/);
  });

  it("never lets telemetry failure change the job's outcome", () => {
    assert.match(
      src,
      /flushLogs\(\)\.catch/,
      "a failing log flush must not fail the job",
    );
    assert.match(
      src,
      /flushMetrics\(\)\.catch/,
      "a failing metric flush must not fail the job",
    );
  });
});
