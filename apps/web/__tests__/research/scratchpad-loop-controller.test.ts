/**
 * Scratchpad & LoopController Tests (DE-SHADOWED)
 *
 * Exercises the REAL exported `Scratchpad`, `LoopController`,
 * `DEFAULT_AGENT_CONFIG`, and the `ScratchpadEntry` / `ScratchpadEntryType`
 * / `ResearchAgentConfig` / `ValidationResult` types from the
 * `@usemoney/research` barrel.
 *
 * Both classes and the default config are import-safe via the barrel — the
 * `@usemoney/research` root export is already imported (and resolves under
 * apps/web node:test) by `__tests__/research/package-exports.test.ts`. The
 * stale `apps/web/lib/research/{scratchpad,loop-controller}.ts` paths the
 * previous header referenced no longer exist; the real source lives at
 * `packages/research/src/{scratchpad,loop-controller}.ts`.
 *
 * NOTE: de-shadowing surfaced that the real `DEFAULT_AGENT_CONFIG.maxSteps`
 * is `Infinity` (no artificial step cap), not the `20` the old inline copy
 * hard-coded — the assertions below now pin the real value.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Scratchpad,
  LoopController,
  DEFAULT_AGENT_CONFIG,
  type ScratchpadEntryType,
  type ResearchAgentConfig,
  type ValidationResult,
} from "@usemoney/research";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** ISO 8601 regex: YYYY-MM-DDTHH:mm:ss.sssZ */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makeValidation(
  overrides: Partial<ValidationResult> = {}
): ValidationResult {
  return {
    score: 0.5,
    passed: false,
    gaps: [],
    suggestions: [],
    ...overrides,
  };
}

// =============================================================================
//  SCRATCHPAD TESTS
// =============================================================================

describe("Scratchpad", () => {
  // ---------------------------------------------------------------------------
  //  Basic lifecycle
  // ---------------------------------------------------------------------------
  describe("Basic lifecycle", () => {
    it("should have 0 entries on a fresh scratchpad", () => {
      const sp = new Scratchpad();
      assert.strictEqual(sp.getEntries().length, 0);
    });

    it("should have stepCount 0 on a fresh scratchpad", () => {
      const sp = new Scratchpad();
      assert.strictEqual(sp.getStepCount(), 0);
    });

    it("should have stepCount 1 after logging one entry", () => {
      const sp = new Scratchpad();
      sp.log("plan", { goal: "test" });
      assert.strictEqual(sp.getStepCount(), 1);
    });

    it("should have entries length 1 after logging one entry", () => {
      const sp = new Scratchpad();
      sp.log("plan", { goal: "test" });
      assert.strictEqual(sp.getEntries().length, 1);
    });

    it("should assign sequential stepNumbers starting from 1", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a");
      sp.log("tool_call", "b");
      sp.log("tool_result", "c");
      const entries = sp.getEntries();
      assert.strictEqual(entries[0]!.stepNumber, 1);
      assert.strictEqual(entries[1]!.stepNumber, 2);
      assert.strictEqual(entries[2]!.stepNumber, 3);
    });

    it("should have sequential stepNumbers after many logs", () => {
      const sp = new Scratchpad();
      for (let i = 0; i < 10; i++) {
        sp.log("reasoning", `step ${i}`);
      }
      const entries = sp.getEntries();
      for (let i = 0; i < 10; i++) {
        assert.strictEqual(entries[i]!.stepNumber, i + 1);
      }
    });

    it("should assign a valid ISO timestamp to each entry", () => {
      const sp = new Scratchpad();
      sp.log("plan", "test");
      const entry = sp.getEntries()[0]!;
      assert.ok(
        ISO_DATE_RE.test(entry.timestamp),
        `timestamp "${entry.timestamp}" is not valid ISO`
      );
    });

    it("should assign timestamps that parse to a valid Date", () => {
      const sp = new Scratchpad();
      sp.log("reasoning", "data");
      const entry = sp.getEntries()[0]!;
      const d = new Date(entry.timestamp);
      assert.ok(!isNaN(d.getTime()), "timestamp should parse to valid Date");
    });

    it("should store the entry type correctly", () => {
      const sp = new Scratchpad();
      sp.log("error", "boom");
      assert.strictEqual(sp.getEntries()[0]!.type, "error");
    });

    it("should store the entry data correctly", () => {
      const sp = new Scratchpad();
      const data = { key: "value", nested: [1, 2, 3] };
      sp.log("plan", data);
      assert.deepStrictEqual(sp.getEntries()[0]!.data, data);
    });

    it("should store taskId when provided", () => {
      const sp = new Scratchpad();
      sp.log("tool_call", "data", "task-42");
      assert.strictEqual(sp.getEntries()[0]!.taskId, "task-42");
    });

    it("should leave taskId undefined when not provided", () => {
      const sp = new Scratchpad();
      sp.log("tool_result", "data");
      assert.strictEqual(sp.getEntries()[0]!.taskId, undefined);
    });

    it("should store tokenUsage when provided", () => {
      const sp = new Scratchpad();
      sp.log("reasoning", "data", undefined, { input: 100, output: 200 });
      assert.deepStrictEqual(sp.getEntries()[0]!.tokenUsage, {
        input: 100,
        output: 200,
      });
    });

    it("should leave tokenUsage undefined when not provided", () => {
      const sp = new Scratchpad();
      sp.log("validation", "data");
      assert.strictEqual(sp.getEntries()[0]!.tokenUsage, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  //  getEntries returns copy
  // ---------------------------------------------------------------------------
  describe("getEntries returns copy", () => {
    it("should not be affected by modifications to the returned array", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a");
      const entries = sp.getEntries();
      entries.push({
        timestamp: "fake",
        stepNumber: 999,
        type: "error",
        data: "injected",
      });
      assert.strictEqual(sp.getEntries().length, 1);
    });

    it("should not be affected by pushing to the returned array", () => {
      const sp = new Scratchpad();
      sp.log("plan", "first");
      sp.log("reasoning", "second");
      const copy = sp.getEntries();
      copy.length = 0; // empty the copy
      assert.strictEqual(sp.getEntries().length, 2);
    });

    it("should return the same content on multiple calls", () => {
      const sp = new Scratchpad();
      sp.log("tool_call", { fn: "search" });
      sp.log("tool_result", { result: "ok" });
      const a = sp.getEntries();
      const b = sp.getEntries();
      assert.deepStrictEqual(a, b);
    });

    it("should return an empty array for an empty scratchpad", () => {
      const sp = new Scratchpad();
      const entries = sp.getEntries();
      assert.ok(Array.isArray(entries));
      assert.strictEqual(entries.length, 0);
    });

    it("should include newly logged entries on subsequent calls", () => {
      const sp = new Scratchpad();
      sp.log("plan", "first");
      assert.strictEqual(sp.getEntries().length, 1);
      sp.log("error", "second");
      assert.strictEqual(sp.getEntries().length, 2);
    });

    it("should return a different array reference each time", () => {
      const sp = new Scratchpad();
      sp.log("plan", "x");
      const a = sp.getEntries();
      const b = sp.getEntries();
      assert.notStrictEqual(a, b);
    });
  });

  // ---------------------------------------------------------------------------
  //  toJSON returns reference
  // ---------------------------------------------------------------------------
  describe("toJSON returns reference", () => {
    it("should return the same reference as the internal entries", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a");
      const json1 = sp.toJSON();
      const json2 = sp.toJSON();
      assert.strictEqual(
        json1,
        json2,
        "toJSON() should return the same reference"
      );
    });

    it("should reflect mutations made via the returned reference", () => {
      const sp = new Scratchpad();
      sp.log("plan", "original");
      const ref = sp.toJSON();
      ref.push({
        timestamp: "injected",
        stepNumber: 999,
        type: "error",
        data: "injected",
      });
      // The mutation should be visible on subsequent toJSON() calls
      assert.strictEqual(sp.toJSON().length, 2);
      assert.strictEqual(sp.toJSON()[1]!.data, "injected");
    });

    it("should return same content as getEntries but a different reference", () => {
      const sp = new Scratchpad();
      sp.log("reasoning", "thought");
      sp.log("validation", "check");
      const json = sp.toJSON();
      const entries = sp.getEntries();
      assert.deepStrictEqual(json, entries, "content should match");
      assert.notStrictEqual(json, entries, "references should differ");
    });
  });

  // ---------------------------------------------------------------------------
  //  getStepCount
  // ---------------------------------------------------------------------------
  describe("getStepCount", () => {
    it("should start at 0", () => {
      const sp = new Scratchpad();
      assert.strictEqual(sp.getStepCount(), 0);
    });

    it("should increment by 1 per log call", () => {
      const sp = new Scratchpad();
      sp.log("plan", "1");
      assert.strictEqual(sp.getStepCount(), 1);
      sp.log("plan", "2");
      assert.strictEqual(sp.getStepCount(), 2);
      sp.log("plan", "3");
      assert.strictEqual(sp.getStepCount(), 3);
    });

    it("should be 100 after 100 logs", () => {
      const sp = new Scratchpad();
      for (let i = 0; i < 100; i++) {
        sp.log("reasoning", `step ${i}`);
      }
      assert.strictEqual(sp.getStepCount(), 100);
    });

    it("should never decrement", () => {
      const sp = new Scratchpad();
      let prev = 0;
      for (let i = 0; i < 20; i++) {
        sp.log("plan", i);
        const current = sp.getStepCount();
        assert.ok(
          current > prev,
          `stepCount should increase: ${current} > ${prev}`
        );
        prev = current;
      }
    });

    it("should be consistent with entries length", () => {
      const sp = new Scratchpad();
      for (let i = 0; i < 15; i++) {
        sp.log("tool_call", { index: i });
      }
      assert.strictEqual(sp.getStepCount(), sp.getEntries().length);
    });
  });

  // ---------------------------------------------------------------------------
  //  getTokenUsage
  // ---------------------------------------------------------------------------
  describe("getTokenUsage", () => {
    it("should return {input: 0, output: 0} with no entries", () => {
      const sp = new Scratchpad();
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 0, output: 0 });
    });

    it("should return correct sum for a single entry with tokens", () => {
      const sp = new Scratchpad();
      sp.log("plan", "data", undefined, { input: 50, output: 75 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 50, output: 75 });
    });

    it("should accumulate tokens from multiple entries", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a", undefined, { input: 10, output: 20 });
      sp.log("reasoning", "b", undefined, { input: 30, output: 40 });
      sp.log("validation", "c", undefined, { input: 5, output: 15 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 45, output: 75 });
    });

    it("should skip entries without tokenUsage", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a"); // no tokens
      sp.log("reasoning", "b", undefined, { input: 100, output: 200 });
      sp.log("error", "c"); // no tokens
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 100, output: 200 });
    });

    it("should handle mixed entries (some with, some without tokens)", () => {
      const sp = new Scratchpad();
      sp.log("plan", "1", undefined, { input: 10, output: 10 });
      sp.log("tool_call", "2");
      sp.log("tool_result", "3", undefined, { input: 20, output: 30 });
      sp.log("reasoning", "4");
      sp.log("validation", "5", undefined, { input: 5, output: 5 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 35, output: 45 });
    });

    it("should handle large token numbers", () => {
      const sp = new Scratchpad();
      sp.log("plan", "data", undefined, {
        input: 1_000_000,
        output: 2_000_000,
      });
      sp.log("reasoning", "more", undefined, {
        input: 500_000,
        output: 800_000,
      });
      assert.deepStrictEqual(sp.getTokenUsage(), {
        input: 1_500_000,
        output: 2_800_000,
      });
    });

    it("should handle zero tokens in usage", () => {
      const sp = new Scratchpad();
      sp.log("plan", "data", undefined, { input: 0, output: 0 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 0, output: 0 });
    });

    it("should handle 0 input with large output", () => {
      const sp = new Scratchpad();
      sp.log("reasoning", "verbose", undefined, { input: 0, output: 999_999 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 0, output: 999_999 });
    });

    it("should handle large input with 0 output", () => {
      const sp = new Scratchpad();
      sp.log("tool_call", "prompt", undefined, { input: 888_888, output: 0 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 888_888, output: 0 });
    });

    it("should correctly sum 100 entries with various token counts", () => {
      const sp = new Scratchpad();
      let expectedInput = 0;
      let expectedOutput = 0;
      for (let i = 0; i < 100; i++) {
        const inp = i * 3;
        const out = i * 7;
        expectedInput += inp;
        expectedOutput += out;
        sp.log("reasoning", `step ${i}`, undefined, {
          input: inp,
          output: out,
        });
      }
      assert.deepStrictEqual(sp.getTokenUsage(), {
        input: expectedInput,
        output: expectedOutput,
      });
    });

    it("should return {0,0} when all entries lack tokenUsage", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a");
      sp.log("error", "b");
      sp.log("refinement", "c");
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 0, output: 0 });
    });

    it("should handle only the last entry having tokenUsage", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a");
      sp.log("reasoning", "b");
      sp.log("validation", "c", undefined, { input: 42, output: 84 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 42, output: 84 });
    });

    it("should handle only the first entry having tokenUsage", () => {
      const sp = new Scratchpad();
      sp.log("plan", "a", undefined, { input: 11, output: 22 });
      sp.log("reasoning", "b");
      sp.log("error", "c");
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 11, output: 22 });
    });

    it("should handle a single entry with very large token values", () => {
      const sp = new Scratchpad();
      sp.log("plan", "big", undefined, {
        input: Number.MAX_SAFE_INTEGER,
        output: 1,
      });
      const usage = sp.getTokenUsage();
      assert.strictEqual(usage.input, Number.MAX_SAFE_INTEGER);
      assert.strictEqual(usage.output, 1);
    });

    it("should accumulate correctly when adding entries one by one", () => {
      const sp = new Scratchpad();
      sp.log("plan", "1", undefined, { input: 10, output: 20 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 10, output: 20 });
      sp.log("reasoning", "2", undefined, { input: 5, output: 10 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 15, output: 30 });
      sp.log("validation", "3", undefined, { input: 25, output: 50 });
      assert.deepStrictEqual(sp.getTokenUsage(), { input: 40, output: 80 });
    });
  });

  // ---------------------------------------------------------------------------
  //  Entry types
  // ---------------------------------------------------------------------------
  describe("Entry types", () => {
    const allTypes: ScratchpadEntryType[] = [
      "plan",
      "tool_call",
      "tool_result",
      "reasoning",
      "validation",
      "error",
      "refinement",
    ];

    it('should log "plan" type correctly', () => {
      const sp = new Scratchpad();
      sp.log("plan", { steps: ["a", "b"] });
      assert.strictEqual(sp.getEntries()[0]!.type, "plan");
    });

    it('should log "tool_call" type correctly', () => {
      const sp = new Scratchpad();
      sp.log("tool_call", { fn: "search", args: { q: "test" } });
      assert.strictEqual(sp.getEntries()[0]!.type, "tool_call");
    });

    it('should log "tool_result" type correctly', () => {
      const sp = new Scratchpad();
      sp.log("tool_result", { result: [1, 2, 3] });
      assert.strictEqual(sp.getEntries()[0]!.type, "tool_result");
    });

    it('should log "reasoning" type correctly', () => {
      const sp = new Scratchpad();
      sp.log("reasoning", "The data suggests...");
      assert.strictEqual(sp.getEntries()[0]!.type, "reasoning");
    });

    it('should log "validation" type correctly', () => {
      const sp = new Scratchpad();
      sp.log("validation", { passed: true, score: 0.9 });
      assert.strictEqual(sp.getEntries()[0]!.type, "validation");
    });

    it('should log "error" type correctly', () => {
      const sp = new Scratchpad();
      sp.log("error", { message: "timeout", code: 408 });
      assert.strictEqual(sp.getEntries()[0]!.type, "error");
    });

    it('should log "refinement" type correctly', () => {
      const sp = new Scratchpad();
      sp.log("refinement", { iteration: 2, changes: ["added source"] });
      assert.strictEqual(sp.getEntries()[0]!.type, "refinement");
    });

    it("should preserve all seven entry types in sequence", () => {
      const sp = new Scratchpad();
      for (const t of allTypes) {
        sp.log(t, `data for ${t}`);
      }
      const entries = sp.getEntries();
      for (let i = 0; i < allTypes.length; i++) {
        assert.strictEqual(entries[i]!.type, allTypes[i]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  //  Monkey tests
  // ---------------------------------------------------------------------------
  describe("Monkey tests", () => {
    it("should handle null data", () => {
      const sp = new Scratchpad();
      sp.log("error", null);
      assert.strictEqual(sp.getEntries()[0]!.data, null);
    });

    it("should handle undefined data", () => {
      const sp = new Scratchpad();
      sp.log("error", undefined);
      assert.strictEqual(sp.getEntries()[0]!.data, undefined);
    });

    it("should handle complex nested object data", () => {
      const sp = new Scratchpad();
      const nested = {
        a: { b: { c: { d: [1, 2, { e: "deep" }] } } },
        f: [[[["very nested"]]]],
      };
      sp.log("tool_result", nested);
      assert.deepStrictEqual(sp.getEntries()[0]!.data, nested);
    });

    it("should handle array data", () => {
      const sp = new Scratchpad();
      const arr = [1, "two", { three: 3 }, [4, 5]];
      sp.log("tool_result", arr);
      assert.deepStrictEqual(sp.getEntries()[0]!.data, arr);
    });

    it("should handle empty string data", () => {
      const sp = new Scratchpad();
      sp.log("reasoning", "");
      assert.strictEqual(sp.getEntries()[0]!.data, "");
    });

    it("should handle number data", () => {
      const sp = new Scratchpad();
      sp.log("plan", 42);
      assert.strictEqual(sp.getEntries()[0]!.data, 42);
    });

    it("should handle boolean data", () => {
      const sp = new Scratchpad();
      sp.log("validation", true);
      assert.strictEqual(sp.getEntries()[0]!.data, true);
      sp.log("validation", false);
      assert.strictEqual(sp.getEntries()[1]!.data, false);
    });

    it("should produce ordered timestamps for rapid sequential logging", () => {
      const sp = new Scratchpad();
      for (let i = 0; i < 50; i++) {
        sp.log("reasoning", i);
      }
      const entries = sp.getEntries();
      for (let i = 1; i < entries.length; i++) {
        const prev = new Date(entries[i - 1]!.timestamp).getTime();
        const curr = new Date(entries[i]!.timestamp).getTime();
        assert.ok(
          curr >= prev,
          `timestamp ${i} should be >= timestamp ${i - 1}`
        );
      }
    });

    it("should handle a very large data object", () => {
      const sp = new Scratchpad();
      const bigObj: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        bigObj[`key_${i}`] = `value_${i}`;
      }
      sp.log("tool_result", bigObj);
      const entry = sp.getEntries()[0]!;
      assert.strictEqual(
        Object.keys(entry.data as Record<string, string>).length,
        1000
      );
    });

    it("should handle unicode data", () => {
      const sp = new Scratchpad();
      const unicodeStr =
        "\u0928\u092E\u0938\u094D\u0924\u0947 \u4F60\u597D \u0645\u0631\u062D\u0628\u0627 \uD83D\uDE80\uD83C\uDF0D";
      sp.log("reasoning", unicodeStr);
      assert.strictEqual(sp.getEntries()[0]!.data, unicodeStr);
    });

    it("should handle empty taskId string", () => {
      const sp = new Scratchpad();
      sp.log("plan", "data", "");
      assert.strictEqual(sp.getEntries()[0]!.taskId, "");
    });

    it("should handle data that is a function reference (stored as-is)", () => {
      const sp = new Scratchpad();
      const fn = () => "hello";
      sp.log("error", fn);
      assert.strictEqual(sp.getEntries()[0]!.data, fn);
    });

    it("should handle data that is a Date object", () => {
      const sp = new Scratchpad();
      const now = new Date();
      sp.log("plan", now);
      assert.strictEqual(sp.getEntries()[0]!.data, now);
    });
  });
});

// =============================================================================
//  LOOPCONTROLLER TESTS
// =============================================================================

describe("LoopController", () => {
  // ---------------------------------------------------------------------------
  //  Constructor and initial state
  // ---------------------------------------------------------------------------
  describe("Constructor and initial state", () => {
    it("should have initial iteration = 0", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      assert.strictEqual(lc.getIteration(), 0);
    });

    it("should have initial totalSteps = 0", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      assert.strictEqual(lc.getTotalSteps(), 0);
    });

    it("should store the config correctly (verified via behavior)", () => {
      const custom: ResearchAgentConfig = {
        maxSteps: 5,
        maxIterations: 1,
        qualityThreshold: 0.9,
        stepTimeoutMs: 10_000,
        totalTimeoutMs: 60_000,
        maxConcurrency: 1,
      };
      const lc = new LoopController(custom);
      // Verify config is stored by checking isAtLimit with maxIterations=1
      lc.startIteration();
      assert.ok(lc.isAtLimit());
    });

    it("should not be at limit initially with default config", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      assert.strictEqual(lc.isAtLimit(), false);
    });

    it("should match expected default config values", () => {
      // Real source uses Infinity (no artificial step cap) — pin it so a
      // regression to a finite default can't slip through.
      assert.strictEqual(DEFAULT_AGENT_CONFIG.maxSteps, Infinity);
      assert.strictEqual(DEFAULT_AGENT_CONFIG.maxIterations, 2);
      assert.strictEqual(DEFAULT_AGENT_CONFIG.qualityThreshold, 0.7);
      assert.strictEqual(DEFAULT_AGENT_CONFIG.stepTimeoutMs, 30_000);
      assert.strictEqual(DEFAULT_AGENT_CONFIG.totalTimeoutMs, 180_000);
      assert.strictEqual(DEFAULT_AGENT_CONFIG.maxConcurrency, 3);
    });
  });

  // ---------------------------------------------------------------------------
  //  shouldRefine
  // ---------------------------------------------------------------------------
  describe("shouldRefine", () => {
    it("should return false when at max iterations (regardless of validation)", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 1,
      });
      lc.startIteration(); // iteration = 1 = maxIterations
      const v = makeValidation({ score: 0, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return false when at max steps (regardless of validation)", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });
      lc.addSteps(5); // totalSteps = 5 = maxSteps
      const v = makeValidation({ score: 0, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return false when validation has passed (even if score below threshold)", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({ score: 0.1, passed: true });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return false when score >= threshold (even if not passed)", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({ score: 0.7, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return true when score < threshold AND not passed AND under limits", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({ score: 0.5, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should return false when score is exactly at threshold (uses < not <=)", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        qualityThreshold: 0.7,
      });
      const v = makeValidation({ score: 0.7, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return true for score 0, not passed, under limits", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({ score: 0, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should return true for score 0.69 with threshold 0.7, not passed", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        qualityThreshold: 0.7,
      });
      const v = makeValidation({ score: 0.69, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should return false for score 0.7 with threshold 0.7, not passed", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        qualityThreshold: 0.7,
      });
      const v = makeValidation({ score: 0.7, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return false when iteration exactly equals maxIterations", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 3,
      });
      lc.startIteration(); // 1
      lc.startIteration(); // 2
      lc.startIteration(); // 3
      const v = makeValidation({ score: 0.1, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return false when steps exactly equal maxSteps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 10 });
      lc.addSteps(10);
      const v = makeValidation({ score: 0.1, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return true for a fresh controller with bad validation", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({
        score: 0.3,
        passed: false,
        gaps: ["missing data"],
      });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should return false after one startIteration with maxIterations=1", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 1,
      });
      lc.startIteration();
      const v = makeValidation({ score: 0, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should not be affected by empty gaps and suggestions", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({
        score: 0.4,
        passed: false,
        gaps: [],
        suggestions: [],
      });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should not be affected by populated gaps and suggestions when score >= threshold", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({
        score: 0.8,
        passed: false,
        gaps: ["gap1", "gap2"],
        suggestions: ["add more"],
      });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should handle negative score (treated as < threshold)", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({ score: -1, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should return true just below max iterations", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 3,
      });
      lc.startIteration(); // 1
      lc.startIteration(); // 2 (below 3)
      const v = makeValidation({ score: 0.3, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should return true just below max steps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 10 });
      lc.addSteps(9); // one below maxSteps
      const v = makeValidation({ score: 0.3, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true);
    });

    it("should return false when both iteration and steps are at limits", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 2,
        maxSteps: 10,
      });
      lc.startIteration();
      lc.startIteration();
      lc.addSteps(10);
      const v = makeValidation({ score: 0.1, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return false when passed is true even with score 0", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({ score: 0, passed: true });
      assert.strictEqual(lc.shouldRefine(v), false);
    });

    it("should return false for score above threshold even with many gaps", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({
        score: 0.71,
        passed: false,
        gaps: ["a", "b", "c", "d", "e"],
      });
      assert.strictEqual(lc.shouldRefine(v), false);
    });
  });

  // ---------------------------------------------------------------------------
  //  startIteration
  // ---------------------------------------------------------------------------
  describe("startIteration", () => {
    it("should return 1 on first call", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      assert.strictEqual(lc.startIteration(), 1);
    });

    it("should return 2 on second call", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      lc.startIteration();
      assert.strictEqual(lc.startIteration(), 2);
    });

    it("should return incrementing values each time", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      for (let i = 1; i <= 10; i++) {
        assert.strictEqual(lc.startIteration(), i);
      }
    });

    it("should affect shouldRefine behavior by reaching maxIterations", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 2,
      });
      const bad = makeValidation({ score: 0.1, passed: false });
      assert.strictEqual(lc.shouldRefine(bad), true); // iteration=0 < 2
      lc.startIteration(); // 1
      assert.strictEqual(lc.shouldRefine(bad), true); // iteration=1 < 2
      lc.startIteration(); // 2
      assert.strictEqual(lc.shouldRefine(bad), false); // iteration=2 >= 2
    });

    it("should affect isAtLimit behavior", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 3,
      });
      assert.strictEqual(lc.isAtLimit(), false);
      lc.startIteration(); // 1
      assert.strictEqual(lc.isAtLimit(), false);
      lc.startIteration(); // 2
      assert.strictEqual(lc.isAtLimit(), false);
      lc.startIteration(); // 3
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should update getIteration() return value", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      assert.strictEqual(lc.getIteration(), 0);
      lc.startIteration();
      assert.strictEqual(lc.getIteration(), 1);
      lc.startIteration();
      assert.strictEqual(lc.getIteration(), 2);
    });
  });

  // ---------------------------------------------------------------------------
  //  addSteps
  // ---------------------------------------------------------------------------
  describe("addSteps", () => {
    it("should add to totalSteps", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      lc.addSteps(5);
      assert.strictEqual(lc.getTotalSteps(), 5);
    });

    it("should accumulate across multiple calls", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      lc.addSteps(3);
      lc.addSteps(7);
      lc.addSteps(2);
      assert.strictEqual(lc.getTotalSteps(), 12);
    });

    it("should not change totalSteps when adding 0", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      lc.addSteps(5);
      lc.addSteps(0);
      assert.strictEqual(lc.getTotalSteps(), 5);
    });

    it("should handle large step counts", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      lc.addSteps(1_000_000);
      assert.strictEqual(lc.getTotalSteps(), 1_000_000);
    });

    it("should affect isAtLimit when reaching maxSteps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 10 });
      lc.addSteps(9);
      assert.strictEqual(lc.isAtLimit(), false);
      lc.addSteps(1);
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should affect shouldRefine when reaching maxSteps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 10 });
      const bad = makeValidation({ score: 0.1, passed: false });
      lc.addSteps(9);
      assert.strictEqual(lc.shouldRefine(bad), true);
      lc.addSteps(1);
      assert.strictEqual(lc.shouldRefine(bad), false);
    });
  });

  // ---------------------------------------------------------------------------
  //  isAtLimit
  // ---------------------------------------------------------------------------
  describe("isAtLimit", () => {
    it("should return false for a fresh controller", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      assert.strictEqual(lc.isAtLimit(), false);
    });

    it("should return true after maxIterations startIteration calls", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 2,
      });
      lc.startIteration();
      lc.startIteration();
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return true after enough addSteps to reach maxSteps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });
      lc.addSteps(5);
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return false when one below maxIterations", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 3,
      });
      lc.startIteration(); // 1
      lc.startIteration(); // 2
      assert.strictEqual(lc.isAtLimit(), false);
    });

    it("should return false when one below maxSteps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 10 });
      lc.addSteps(9);
      assert.strictEqual(lc.isAtLimit(), false);
    });

    it("should return true when exactly at maxIterations", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 4,
      });
      for (let i = 0; i < 4; i++) lc.startIteration();
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return true when exactly at maxSteps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 15 });
      lc.addSteps(15);
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return true when both iteration and steps are at limit", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 2,
        maxSteps: 10,
      });
      lc.startIteration();
      lc.startIteration();
      lc.addSteps(10);
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return true immediately with maxIterations=0", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 0,
      });
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return true immediately with maxSteps=0", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 0 });
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return true when exceeding maxIterations", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 2,
      });
      lc.startIteration();
      lc.startIteration();
      lc.startIteration(); // exceeds
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should return true when exceeding maxSteps", () => {
      const lc = new LoopController({ ...DEFAULT_AGENT_CONFIG, maxSteps: 5 });
      lc.addSteps(100); // greatly exceeds
      assert.strictEqual(lc.isAtLimit(), true);
    });
  });

  // ---------------------------------------------------------------------------
  //  Edge cases / Monkey tests
  // ---------------------------------------------------------------------------
  describe("Edge cases / Monkey tests", () => {
    it("should handle config with maxIterations=1 and maxSteps=1", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 1,
        maxSteps: 1,
      });
      assert.strictEqual(lc.isAtLimit(), false);
      lc.startIteration();
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should handle very large config values", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 1_000_000,
        maxSteps: 1_000_000,
      });
      assert.strictEqual(lc.isAtLimit(), false);
      for (let i = 0; i < 100; i++) {
        lc.startIteration();
        lc.addSteps(100);
      }
      assert.strictEqual(lc.isAtLimit(), false);
      assert.strictEqual(lc.getIteration(), 100);
      assert.strictEqual(lc.getTotalSteps(), 10_000);
    });

    it("should not change state when calling shouldRefine many times", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      const v = makeValidation({ score: 0.3, passed: false });
      for (let i = 0; i < 100; i++) {
        lc.shouldRefine(v);
      }
      assert.strictEqual(lc.getIteration(), 0);
      assert.strictEqual(lc.getTotalSteps(), 0);
    });

    it("should not change state when calling getIteration/getTotalSteps", () => {
      const lc = new LoopController(DEFAULT_AGENT_CONFIG);
      lc.startIteration();
      lc.addSteps(5);
      for (let i = 0; i < 50; i++) {
        lc.getIteration();
        lc.getTotalSteps();
      }
      assert.strictEqual(lc.getIteration(), 1);
      assert.strictEqual(lc.getTotalSteps(), 5);
    });

    it("should work through a complete sequential workflow", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 3,
        maxSteps: 15,
        qualityThreshold: 0.8,
      });

      // Iteration 1
      assert.strictEqual(lc.startIteration(), 1);
      lc.addSteps(4);
      const v1 = makeValidation({
        score: 0.4,
        passed: false,
        gaps: ["incomplete"],
      });
      assert.strictEqual(lc.shouldRefine(v1), true);

      // Iteration 2
      assert.strictEqual(lc.startIteration(), 2);
      lc.addSteps(5);
      const v2 = makeValidation({
        score: 0.6,
        passed: false,
        gaps: ["needs depth"],
      });
      assert.strictEqual(lc.shouldRefine(v2), true);

      // Iteration 3
      assert.strictEqual(lc.startIteration(), 3);
      lc.addSteps(3);
      const v3 = makeValidation({ score: 0.75, passed: false });
      // At max iterations now (3 >= 3), so should not refine
      assert.strictEqual(lc.shouldRefine(v3), false);

      assert.strictEqual(lc.isAtLimit(), true);
      assert.strictEqual(lc.getIteration(), 3);
      assert.strictEqual(lc.getTotalSteps(), 12);
    });

    it("should stop refinement when validation passes mid-workflow", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 5,
        maxSteps: 50,
        qualityThreshold: 0.7,
      });

      lc.startIteration();
      lc.addSteps(3);
      const v1 = makeValidation({ score: 0.3, passed: false });
      assert.strictEqual(lc.shouldRefine(v1), true);

      lc.startIteration();
      lc.addSteps(2);
      // Now validation passes
      const v2 = makeValidation({ score: 0.5, passed: true });
      assert.strictEqual(lc.shouldRefine(v2), false);

      // Still not at limit (only 2 of 5 iterations, 5 of 50 steps)
      assert.strictEqual(lc.isAtLimit(), false);
    });

    it("should stop refinement when steps run out mid-workflow", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        maxIterations: 10,
        maxSteps: 8,
        qualityThreshold: 0.9,
      });

      lc.startIteration();
      lc.addSteps(4);
      const v1 = makeValidation({ score: 0.2, passed: false });
      assert.strictEqual(lc.shouldRefine(v1), true);

      lc.startIteration();
      lc.addSteps(4); // totalSteps = 8 = maxSteps
      assert.strictEqual(lc.shouldRefine(v1), false);
      assert.strictEqual(lc.isAtLimit(), true);
    });

    it("should handle qualityThreshold of 0 (only passed matters)", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        qualityThreshold: 0,
      });
      // score < 0 is needed for shouldRefine to be true via score check,
      // but threshold=0 means score must be < 0
      const v = makeValidation({ score: 0, passed: false });
      assert.strictEqual(lc.shouldRefine(v), false); // 0 is not < 0
    });

    it("should handle qualityThreshold of 1.0", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        qualityThreshold: 1.0,
      });
      const v = makeValidation({ score: 0.99, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true); // 0.99 < 1.0
    });

    it("should handle shouldRefine with score exactly 0 and threshold > 0", () => {
      const lc = new LoopController({
        ...DEFAULT_AGENT_CONFIG,
        qualityThreshold: 0.5,
      });
      const v = makeValidation({ score: 0, passed: false });
      assert.strictEqual(lc.shouldRefine(v), true);
    });
  });
});

// =============================================================================
//  INTEGRATION: Scratchpad + LoopController together
// =============================================================================

describe("Scratchpad + LoopController integration", () => {
  it("should track steps in scratchpad and feed count to loop controller", () => {
    const sp = new Scratchpad();
    const lc = new LoopController({
      ...DEFAULT_AGENT_CONFIG,
      maxSteps: 5,
      maxIterations: 3,
    });

    lc.startIteration();

    sp.log("plan", "research query decomposition");
    sp.log("tool_call", { fn: "search", q: "stock analysis" });
    sp.log("tool_result", { results: ["r1", "r2"] });
    lc.addSteps(sp.getStepCount());

    assert.strictEqual(lc.getTotalSteps(), 3);
    assert.strictEqual(lc.isAtLimit(), false);

    sp.log("reasoning", "synthesizing results");
    sp.log("validation", { score: 0.4, passed: false });
    lc.addSteps(2); // add the remaining 2 steps

    assert.strictEqual(lc.getTotalSteps(), 5);
    assert.strictEqual(lc.isAtLimit(), true);
  });

  it("should track token usage across research iterations", () => {
    const sp = new Scratchpad();
    const lc = new LoopController({
      ...DEFAULT_AGENT_CONFIG,
      maxIterations: 2,
      qualityThreshold: 0.8,
    });

    // Iteration 1
    lc.startIteration();
    sp.log("plan", "initial plan", "task-1", { input: 100, output: 50 });
    sp.log("tool_call", { fn: "search" }, "task-1", {
      input: 200,
      output: 100,
    });
    sp.log("tool_result", { data: "result" }, "task-1", {
      input: 50,
      output: 300,
    });
    lc.addSteps(3);

    const v1 = makeValidation({ score: 0.5, passed: false });
    assert.strictEqual(lc.shouldRefine(v1), true);

    // Iteration 2
    lc.startIteration();
    sp.log("refinement", "adding more sources", "task-1", {
      input: 150,
      output: 200,
    });
    sp.log("validation", { score: 0.85 }, "task-1", { input: 100, output: 50 });
    lc.addSteps(2);

    const usage = sp.getTokenUsage();
    assert.strictEqual(usage.input, 600); // 100+200+50+150+100
    assert.strictEqual(usage.output, 700); // 50+100+300+200+50
    assert.strictEqual(sp.getStepCount(), 5);
    assert.strictEqual(lc.getIteration(), 2);
    assert.strictEqual(lc.isAtLimit(), true);
  });

  it("should maintain independent state between scratchpad and controller", () => {
    const sp = new Scratchpad();
    const lc = new LoopController(DEFAULT_AGENT_CONFIG);

    // Log to scratchpad but don't addSteps to controller
    sp.log("plan", "a");
    sp.log("tool_call", "b");
    sp.log("tool_result", "c");

    assert.strictEqual(sp.getStepCount(), 3);
    assert.strictEqual(lc.getTotalSteps(), 0);
    assert.strictEqual(lc.isAtLimit(), false);
  });
});
