/**
 * A backfill that fails everything must not exit 0.
 *
 * All three Tiingo walks set `process.exitCode = 1` on a circuit-breaker stop
 * and on NOTHING else, so a night where the upstream answered 500 to every
 * request recorded tens of thousands of ERROR checkpoints and exited 0 — Cloud
 * Run reported SUCCEEDED, `--max-retries=0` meant nothing retried, and the only
 * signal an operator has is the exit code that said fine.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  judgeBackfillOutcome,
  BACKFILL_FAILURE_RATIO,
} from "../../src/ops/backfill-outcome";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("judgeBackfillOutcome", () => {
  it("a circuit-breaker stop is a FAILED run even though work was done", () => {
    const v = judgeBackfillOutcome({
      stopped: "rate limited",
      attempted: 3,
      succeeded: 3,
      failed: 0,
    });
    assert.equal(v.exitCode, 1);
    assert.match(v.reason, /rate limited/);
  });

  it("attempted-everything-failed is a FAILED run — the defect this exists for", () => {
    const v = judgeBackfillOutcome({
      attempted: 72_685,
      succeeded: 0,
      failed: 72_685,
    });
    assert.equal(v.exitCode, 1);
    assert.match(v.reason, /NOTHING succeeded/);
  });

  it("a handful of transient errors in a large walk is HEALTHY", () => {
    // A rule that fails on one error makes every run red, and a signal that is
    // always on is one people learn to ignore — the same outcome as none.
    const v = judgeBackfillOutcome({
      attempted: 72_685,
      succeeded: 72_585,
      failed: 100,
    });
    assert.equal(v.exitCode, 0);
    assert.equal(v.reason, "");
  });

  it("majority-failed is a FAILED run", () => {
    const n = 1000;
    const justOver = Math.floor(n * BACKFILL_FAILURE_RATIO) + 1;
    const v = judgeBackfillOutcome({
      attempted: n,
      succeeded: n - justOver,
      failed: justOver,
    });
    assert.equal(v.exitCode, 1);
    assert.match(v.reason, /failed/);
  });

  it("exactly at the ratio is NOT a failure (the boundary is strict)", () => {
    const n = 1000;
    const atRatio = n * BACKFILL_FAILURE_RATIO;
    assert.equal(
      judgeBackfillOutcome({
        attempted: n,
        succeeded: n - atRatio,
        failed: atRatio,
      }).exitCode,
      0,
    );
  });

  it("attempted NOTHING is healthy — every item was already checkpointed", () => {
    // Distinct from "attempted and all failed". Collapsing the two is how a
    // resumable job reports failure forever once it finishes.
    const v = judgeBackfillOutcome({ attempted: 0, succeeded: 0, failed: 0 });
    assert.equal(v.exitCode, 0);
  });

  it("incoherent counters cannot certify a run as healthy", () => {
    for (const bad of [
      { attempted: -1, succeeded: 0, failed: 0 },
      { attempted: 10, succeeded: NaN, failed: 0 },
      { attempted: 10, succeeded: 5, failed: -3 },
      { attempted: Infinity, succeeded: 1, failed: 0 },
    ]) {
      assert.equal(judgeBackfillOutcome(bad).exitCode, 1, JSON.stringify(bad));
    }
  });
});

describe("all three Tiingo walks route their exit code through the shared judge", () => {
  const SCRIPTS = [
    "scripts/jobs/tiingo-us-backfill.ts",
    "scripts/jobs/tiingo-us-corp-actions-backfill.ts",
    "scripts/jobs/tiingo-us-news-seed.ts",
  ];

  it("each imports and calls it", () => {
    for (const p of SCRIPTS) {
      const src = read(p);
      assert.match(
        src,
        /import \{ judgeBackfillOutcome \} from "@usemoney\/core\/ops\/backfill-outcome"/,
        `${p} must import the shared judge`,
      );
      assert.match(src, /judgeBackfillOutcome\(\{/, `${p} must call it`);
    }
  });

  it("none re-implements the rule locally", () => {
    // Three copies of a threshold drift, and a threshold that differs per
    // script is one nobody can reason about.
    for (const p of SCRIPTS) {
      const src = read(p)
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(
        src,
        /const\s+BACKFILL_FAILURE_RATIO/,
        `${p} re-declares the threshold instead of importing it`,
      );
    }
  });
});

describe("the news seed lets the WRITE decide the checkpoint status", () => {
  const src = read("scripts/jobs/tiingo-us-news-seed.ts");
  const code = src
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("writeRows reports how many rows failed", () => {
    assert.match(
      code,
      /async function writeRows\([^)]*\)\s*:\s*Promise<number>/,
      "writeRows must return this day's failure count, not void",
    );
  });

  it("a day whose rows failed is checkpointed ERROR, not DONE", () => {
    // DONE and TRUNCATED are TERMINAL, so the resume filter never re-walks the
    // day — and Tiingo's news history floors at 90 days, after which the
    // session is unrecoverable.
    assert.match(code, /finalStatus\s*=\s*"ERROR"/, "must demote to ERROR");
    assert.match(
      code,
      /checkpoint\(\s*day,\s*finalStatus/,
      "the checkpoint must receive the WRITE-adjusted status, not the fetch status",
    );
  });
});
