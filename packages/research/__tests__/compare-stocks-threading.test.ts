/**
 * compare_stocks — MONEY-806 synthesis param threading.
 *
 * The compare-mode synthesis previously dropped researchFocus / memoryContext /
 * horizon / reportLength (it called buildSynthesizerUserPrompt(query, tasks)
 * with no extras and had no reportLength directive). These tests import the
 * REAL exported helpers the tool now uses and assert:
 *   1. The framing directives the tool prepends for the stockData path are
 *      BYTE-IDENTICAL to what buildSynthesizerUserPrompt emits for the tasks
 *      path (so compare honours the same C1c run-params + B5 memory + focus as
 *      single-stock synthesis).
 *   2. The reportLength directive matches the synthesizer's brief/full wording
 *      and is empty for standard/unset (prompt unchanged).
 *
 * De-shadow guarantee: imports the REAL `compareFramingDirectives`,
 * `compareReportLengthDirective` (compare-stocks.ts) and the REAL
 * `buildSynthesizerUserPrompt` (prompts.ts) — no logic is re-declared here.
 *
 * Source under test: packages/research/src/tools/compare-stocks.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  compareFramingDirectives,
  compareReportLengthDirective,
} from "../src/tools/compare-stocks";
import { buildSynthesizerUserPrompt } from "../src/prompts";
import type { ResearchTask } from "../src/types";

describe("compareFramingDirectives — mirrors buildSynthesizerUserPrompt extras", () => {
  test("horizon directive matches the single-stock synthesizer exactly", () => {
    const horizon = "3y";
    // The synthesizer prompt for an EMPTY task list is just the framing
    // directives + the boilerplate. Diff the two prompts (with vs without the
    // extra) to isolate exactly what each extra adds.
    const base = buildSynthesizerUserPrompt("q", []);
    const withHorizon = buildSynthesizerUserPrompt(
      "q",
      [],
      undefined,
      undefined,
      horizon,
    );
    const synthDelta = withHorizon.slice(0, withHorizon.length - base.length);
    assert.equal(compareFramingDirectives({ horizon }), synthDelta);
  });

  test("researchFocus directive matches the single-stock synthesizer exactly", () => {
    const focus = "focus on balance sheet quality";
    const base = buildSynthesizerUserPrompt("q", []);
    const withFocus = buildSynthesizerUserPrompt("q", [], focus);
    const synthDelta = withFocus.slice(0, withFocus.length - base.length);
    assert.equal(
      compareFramingDirectives({ researchFocus: focus }),
      synthDelta,
    );
  });

  test("memoryContext directive matches the single-stock synthesizer exactly", () => {
    const memory = "Long-term SIP investor, low risk tolerance.";
    const base = buildSynthesizerUserPrompt("q", []);
    const withMemory = buildSynthesizerUserPrompt("q", [], undefined, memory);
    const synthDelta = withMemory.slice(0, withMemory.length - base.length);
    assert.equal(
      compareFramingDirectives({ memoryContext: memory }),
      synthDelta,
    );
  });

  test("all three together preserve the synthesizer's ordering (horizon → memory → focus)", () => {
    const horizon = "5y";
    const memory = "Aggressive growth investor.";
    const focus = "focus on growth";
    const base = buildSynthesizerUserPrompt("q", []);
    const withAll = buildSynthesizerUserPrompt("q", [], focus, memory, horizon);
    const synthDelta = withAll.slice(0, withAll.length - base.length);
    assert.equal(
      compareFramingDirectives({
        horizon,
        memoryContext: memory,
        researchFocus: focus,
      }),
      synthDelta,
    );
  });

  test("absent/blank inputs → empty string (prompt unchanged)", () => {
    assert.equal(compareFramingDirectives({}), "");
    assert.equal(
      compareFramingDirectives({
        horizon: "   ",
        memoryContext: "",
        researchFocus: "  ",
      }),
      "",
    );
  });
});

describe("compareReportLengthDirective — brief/full/standard", () => {
  test("standard / unset → empty (prompt byte-identical to today)", () => {
    assert.equal(compareReportLengthDirective(), "");
    assert.equal(compareReportLengthDirective("standard"), "");
    assert.equal(compareReportLengthDirective("anything-else"), "");
  });

  test("brief → emits the BRIEF directive (caps narrative, keeps all sections)", () => {
    const d = compareReportLengthDirective("brief");
    assert.match(d, /REPORT LENGTH — BRIEF/);
    assert.match(d, /emit ALL required sections/);
  });

  test("full → emits the FULL directive (deepest treatment, no padding)", () => {
    const d = compareReportLengthDirective("full");
    assert.match(d, /REPORT LENGTH — FULL/);
    assert.match(d, /Do NOT\s+invent data to pad length/);
  });
});

describe("compare_stocks tool — param schema exposes the threaded params", () => {
  test("tool declares researchFocus / memoryContext / horizon / reportLength params", async () => {
    const { compareStocksTool } = await import("../src/tools/compare-stocks");
    const p = compareStocksTool.parameters;
    for (const key of [
      "researchFocus",
      "memoryContext",
      "horizon",
      "reportLength",
    ]) {
      assert.ok(p[key], `compare_stocks should declare a "${key}" param`);
    }
  });
});

describe("compare_stocks tool — threading reaches buildSynthesizerUserPrompt (tasks path)", () => {
  // The tasks path delegates the data section to buildSynthesizerUserPrompt;
  // assert the directives land there when the synthesis params are stamped.
  test("a completed task + stamped params surface horizon/memory/focus in the prompt", () => {
    const tasks: ResearchTask[] = [
      {
        id: "t1",
        type: "data_fetch",
        tool: "fetch_key_ratios",
        params: { symbol: "TCS" },
        status: "completed",
        result: { symbol: "TCS", pe: 30 },
      } as unknown as ResearchTask,
    ];
    const prompt = buildSynthesizerUserPrompt(
      "compare TCS and INFY",
      tasks,
      "focus on margins",
      "Conservative investor.",
      "3y",
    );
    assert.match(prompt, /Analysis horizon[^\n]*3y/);
    assert.match(prompt, /Investor profile/);
    assert.match(prompt, /Conservative investor\./);
    assert.match(prompt, /User focus preference[^\n]*focus on margins/);
    // and the task data is still included.
    assert.match(prompt, /fetch_key_ratios/);
  });
});
