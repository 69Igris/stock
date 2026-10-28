/**
 * A console line from a job actually REACHES the Datadog intake — MONEY-1375.
 *
 * ## Why this file exists, and why source scans were not enough
 *
 * Two earlier commits made the transport bundle and attached it to pino, and
 * both were verified by scanning source and build artefacts. A fresh-context
 * review then found the estate would still ship ZERO job logs, for two reasons
 * neither scan could see:
 *
 *   1. NOTHING WROTE TO PINO. `workers/src` has ~573 `console.*` calls against
 *      3 `getLogger()` uses; every job script defines its own `console.log`
 *      shim; and `reportJobOutcome` — the single line the log monitors are
 *      built around — is a `console.log`. Attaching a stream to pino reached
 *      almost none of it.
 *   2. THE FLUSH WAS A NO-OP. `flushLogs()` called `root.flush(cb)`, and
 *      `pino.multistream()` implements no `flush`, so pino fell through to the
 *      callback having sent nothing. Every shutdown reported a flush that never
 *      happened.
 *
 * Either one alone means no logs. Both passed a suite made entirely of source
 * assertions, which is the lesson: this file asserts a POST, not a pattern.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

interface Captured {
  url: string;
  body: unknown;
}

const captured: Captured[] = [];
let realFetch: typeof globalThis.fetch;
let restoreEnv: Record<string, string | undefined> = {};

before(() => {
  restoreEnv = {
    DD_API_KEY: process.env.DD_API_KEY,
    DD_SERVICE: process.env.DD_SERVICE,
    NODE_ENV: process.env.NODE_ENV,
  };
  process.env.DD_API_KEY = "stub-key-for-delivery-test";
  process.env.DD_SERVICE = "stockbook-workers";
  // `isDevelopment` is NODE_ENV === "development"; the stream only attaches
  // outside it.
  process.env.NODE_ENV = "production";

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    let body: unknown = init?.body;
    try {
      body = JSON.parse(String(init?.body ?? "null"));
    } catch {
      /* keep the raw string */
    }
    captured.push({ url: String(url), body });
    return { ok: true, status: 202, text: async () => "" } as unknown as Response;
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(restoreEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Every log line across every captured POST. */
function shippedLines(): string[] {
  const out: string[] = [];
  for (const c of captured) {
    if (!Array.isArray(c.body)) continue;
    for (const entry of c.body) {
      if (entry && typeof entry === "object") out.push(JSON.stringify(entry));
    }
  }
  return out;
}

describe("a job's console output reaches the Datadog intake", () => {
  it("ships a console.log line, and flushLogs() actually flushes it", async () => {
    const { initJobTelemetry, flushJobTelemetry } = await import(
      "../src/lib/job-telemetry"
    );

    await initJobTelemetry();

    const marker = `delivery-probe-${Date.now()}`;
    console.log(`[job-outcome] ${marker}`);

    // THE ASSERTION THAT MATTERS. Before the fix this flushed nothing: a job
    // that logged and returned shipped zero lines, because `pino.multistream()`
    // has no `flush` and the call resolved anyway.
    await flushJobTelemetry();

    const lines = shippedLines();
    assert.ok(
      captured.length > 0,
      "nothing was POSTed to the Datadog intake at all — the transport never ran",
    );
    assert.ok(
      lines.some((l) => l.includes(marker)),
      `the console line never reached the intake.\nPOSTs: ${captured.length}\nlines: ${lines.slice(0, 3).join("\n")}`,
    );
  });

  it("posts to the Datadog logs intake, not somewhere else", () => {
    assert.ok(captured.length > 0, "no POST captured");
    assert.match(
      captured[0]?.url ?? "",
      /http-intake\.logs\./,
      `unexpected intake URL: ${captured[0]?.url}`,
    );
  });

  it("redacts before shipping, so the sink never receives a secret", async () => {
    const { flushJobTelemetry } = await import("../src/lib/job-telemetry");
    const before = captured.length;

    console.log("token check", { password: "hunter2-should-not-ship" });
    await flushJobTelemetry();

    const fresh = captured.slice(before);
    const text = JSON.stringify(fresh);
    assert.ok(fresh.length > 0, "the second flush shipped nothing");
    assert.ok(
      !text.includes("hunter2-should-not-ship"),
      "a secret reached the Datadog intake — the forwarder must run AFTER redaction",
    );
  });
});
