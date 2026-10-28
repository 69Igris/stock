/**
 * Research Scratchpad — REAL import (de-shadow companion).
 *
 * `apps/web/__tests__/research/scratchpad-loop-controller.test.ts` reimplements
 * the Scratchpad class inline ("classes are reimplemented inline because the
 * source modules have side-effecting imports") and even points at a stale path
 * (`apps/web/lib/research/scratchpad.ts`, which no longer exists — the real one
 * is `packages/research/src/scratchpad.ts`). But Scratchpad only imports TYPES,
 * so it is import-safe: these tests assert the REAL exported class.
 *
 * Focus: the token-usage MERGE/aggregation (summing across entries) plus
 * edge cases — empty pad, missing/partial tokenUsage, NaN, unicode data, entry
 * snapshot isolation, monotonic step numbering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Scratchpad } from "../src/scratchpad";

describe("Scratchpad - step numbering & entries", () => {
  it("empty pad: 0 steps, empty entries, zeroed token usage", () => {
    const s = new Scratchpad();
    assert.equal(s.getStepCount(), 0);
    assert.deepEqual(s.getEntries(), []);
    assert.deepEqual(s.getTokenUsage(), { input: 0, output: 0 });
  });

  it("assigns monotonically increasing stepNumber starting at 1", () => {
    const s = new Scratchpad();
    s.log("plan", { a: 1 });
    s.log("tool_call", { b: 2 });
    s.log("validation", { c: 3 });
    const steps = s.getEntries().map((e) => e.stepNumber);
    assert.deepEqual(steps, [1, 2, 3]);
    assert.equal(s.getStepCount(), 3);
  });

  it("records type, taskId and data faithfully", () => {
    const s = new Scratchpad();
    s.log("tool_result", { ok: true }, "task_7");
    const e = s.getEntries()[0]!;
    assert.equal(e.type, "tool_result");
    assert.equal(e.taskId, "task_7");
    assert.deepEqual(e.data, { ok: true });
    assert.equal(typeof e.timestamp, "string");
    // timestamp is an ISO string
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
  });

  it("getEntries returns a COPY — mutating it does not corrupt the pad", () => {
    const s = new Scratchpad();
    s.log("plan", {});
    const snapshot = s.getEntries();
    snapshot.push({
      timestamp: "x",
      stepNumber: 999,
      type: "error",
      data: null,
    });
    // The pad itself is unaffected.
    assert.equal(s.getEntries().length, 1);
    assert.equal(s.getStepCount(), 1);
  });
});

describe("Scratchpad - token usage merge/aggregation", () => {
  it("sums input/output across all entries that carry usage", () => {
    const s = new Scratchpad();
    s.log("plan", {}, undefined, { input: 100, output: 20 });
    s.log("validation", {}, undefined, { input: 5, output: 50 });
    assert.deepEqual(s.getTokenUsage(), { input: 105, output: 70 });
  });

  it("entries WITHOUT tokenUsage contribute nothing (not NaN)", () => {
    const s = new Scratchpad();
    s.log("tool_call", {}); // no usage
    s.log("plan", {}, undefined, { input: 10, output: 3 });
    s.log("reasoning", {}); // no usage
    const usage = s.getTokenUsage();
    assert.deepEqual(usage, { input: 10, output: 3 });
    assert.ok(Number.isFinite(usage.input));
    assert.ok(Number.isFinite(usage.output));
  });

  it("zero-valued usage entries keep the totals finite and unchanged", () => {
    const s = new Scratchpad();
    s.log("plan", {}, undefined, { input: 0, output: 0 });
    s.log("plan", {}, undefined, { input: 7, output: 9 });
    assert.deepEqual(s.getTokenUsage(), { input: 7, output: 9 });
  });

  it("a NaN in one entry's usage is isolated to that field (documents behaviour)", () => {
    // Defensive: a malformed estimate (NaN) should not be silently turned into
    // 0 by the aggregator — it propagates, which is the honest signal that an
    // upstream token estimate was bad. We assert the OTHER axis stays clean.
    const s = new Scratchpad();
    s.log("plan", {}, undefined, { input: Number.NaN, output: 40 });
    s.log("validation", {}, undefined, { input: 10, output: 2 });
    const usage = s.getTokenUsage();
    assert.ok(Number.isNaN(usage.input)); // poisoned axis surfaces
    assert.equal(usage.output, 42); // clean axis still correct, finite
    assert.ok(Number.isFinite(usage.output));
  });

  it("toJSON exposes the same entries (for session persistence)", () => {
    const s = new Scratchpad();
    s.log("plan", { q: "x" }, undefined, { input: 1, output: 1 });
    const json = s.toJSON();
    assert.equal(json.length, 1);
    assert.equal(json[0]!.type, "plan");
    assert.deepEqual(json[0]!.tokenUsage, { input: 1, output: 1 });
  });
});

describe("Scratchpad - edge data", () => {
  it("handles unicode / nested / null data without throwing", () => {
    const s = new Scratchpad();
    assert.doesNotThrow(() => {
      s.log("reasoning", { note: "नमस्ते 🚀 café", nested: { a: [1, 2] } });
      s.log("error", null);
      s.log("tool_result", { big: "z".repeat(10_000) });
    });
    assert.equal(s.getStepCount(), 3);
    assert.deepEqual(s.getEntries()[1]!.data, null);
  });

  it("many entries: step count stays exact, usage sums correctly", () => {
    const s = new Scratchpad();
    for (let i = 0; i < 250; i++) {
      s.log("tool_call", { i }, `t${i}`, { input: 1, output: 2 });
    }
    assert.equal(s.getStepCount(), 250);
    assert.deepEqual(s.getTokenUsage(), { input: 250, output: 500 });
  });
});
