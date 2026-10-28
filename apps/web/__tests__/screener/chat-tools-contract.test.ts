/**
 * Ask Screener chat — Gemini tool schema contract (MONEY-1078).
 *
 * The declarations sent to Gemini and the executor's switch must stay in
 * lockstep, and the schema must satisfy Gemini's own constraints. Pins:
 *   - every declared tool has an executor case (and vice versa);
 *   - no OBJECT schema ships EMPTY properties (Gemini 400s the whole
 *     request — the bug the FIRE tools documented);
 *   - filter tool properties are generated from the SAME vocab the
 *     sanitizer allowlists, so the model is never offered a key the
 *     executor would silently drop;
 *   - the system prompt embeds the live snapshot.
 *
 * Sources: apps/web/app/discover/screener/lib/chat/{tools,systemPrompt}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SCREENER_TOOLS } from "@/app/discover/screener/lib/chat/tools";
import {
  STOCK_FIELDS,
  MF_FIELDS,
  ETF_FIELDS,
} from "@/app/discover/screener/lib/chat/filters";
import { buildScreenerSystemPrompt } from "@/app/discover/screener/lib/chat/systemPrompt";
import { executeScreenerTool } from "@/app/discover/screener/lib/chat/toolExecutor";
import type { ScreenerChatActions } from "@/app/discover/screener/lib/chat/actions";
import type { ScreenerSnapshot } from "@/app/discover/screener/lib/chat/systemPrompt";

const noopActions: ScreenerChatActions = {
  switchMode: () => {},
  mergeFilters: () => {},
  unsetFilters: () => {},
  clearFilters: () => {},
  setQuery: () => {},
  setSort: () => {},
};

const EXPECTED_TOOLS = [
  "setStockFilters",
  "setMfFilters",
  "setEtfFilters",
  "removeFilters",
  "clearFilters",
  "setSearchQuery",
  "setSort",
  "switchMode",
];

describe("SCREENER_TOOLS — declaration shape", () => {
  it("declares exactly the expected tool set", () => {
    assert.deepEqual(
      SCREENER_TOOLS.map((t) => t.name).sort(),
      [...EXPECTED_TOOLS].sort()
    );
  });

  it("gives every tool a non-empty description", () => {
    for (const t of SCREENER_TOOLS) {
      assert.ok(
        (t.description ?? "").length > 20,
        `${t.name} needs a real description`
      );
    }
  });

  it("never ships an OBJECT schema with empty properties (Gemini 400s)", () => {
    for (const t of SCREENER_TOOLS) {
      if (!t.parameters) continue; // no-arg tools omit `parameters` entirely
      const props = t.parameters.properties ?? {};
      assert.ok(
        Object.keys(props).length > 0,
        `${t.name} ships an empty OBJECT schema — Gemini rejects the request`
      );
    }
  });

  it("omits `parameters` on the no-arg clearFilters tool", () => {
    const clear = SCREENER_TOOLS.find((t) => t.name === "clearFilters");
    assert.equal(clear!.parameters, undefined);
  });

  it("marks required args on the tools that need them", () => {
    const byName = new Map(SCREENER_TOOLS.map((t) => [t.name, t]));
    assert.deepEqual(byName.get("setSearchQuery")!.parameters!.required, [
      "query",
    ]);
    assert.deepEqual(byName.get("setSort")!.parameters!.required, ["sort"]);
    assert.deepEqual(byName.get("switchMode")!.parameters!.required, ["mode"]);
    assert.deepEqual(byName.get("removeFilters")!.parameters!.required, [
      "keys",
    ]);
  });

  it("leaves filter criteria optional (models send a subset)", () => {
    for (const name of ["setStockFilters", "setMfFilters", "setEtfFilters"]) {
      const tool = SCREENER_TOOLS.find((t) => t.name === name)!;
      assert.equal(
        tool.parameters!.required,
        undefined,
        `${name} must not force any single criterion`
      );
    }
  });
});

describe("SCREENER_TOOLS — vocabulary parity with the sanitizer", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["setStockFilters", STOCK_FIELDS],
    ["setMfFilters", MF_FIELDS],
    ["setEtfFilters", ETF_FIELDS],
  ];

  for (const [toolName, fields] of cases) {
    it(`${toolName} exposes exactly its mode's allowlisted keys`, () => {
      const tool = SCREENER_TOOLS.find((t) => t.name === toolName)!;
      const declared = Object.keys(tool.parameters!.properties ?? {}).sort();
      assert.deepEqual(declared, Object.keys(fields).sort());
    });
  }
});

describe("SCREENER_TOOLS — executor parity", () => {
  it("every declared tool is handled by the executor", () => {
    for (const t of SCREENER_TOOLS) {
      // `FunctionDeclaration.name` is optional in the GenAI SDK; a nameless
      // declaration is unroutable, so it must fail here rather than be skipped.
      const name = t.name;
      assert.ok(name, "every declared tool must have a name");
      const r = executeScreenerTool(name, {}, () => "stocks", noopActions);
      // An arg-validation failure is fine; "Unknown tool" is not — that
      // means a declaration with no matching executor case.
      if (!r.ok) {
        assert.doesNotMatch(
          r.error,
          /Unknown tool/,
          `${t.name} is declared to Gemini but unhandled by the executor`
        );
      }
    }
  });

  it("rejects a name that is not declared", () => {
    const r = executeScreenerTool(
      "setCryptoFilters",
      {},
      () => "stocks",
      noopActions
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unknown tool/);
  });
});

describe("buildScreenerSystemPrompt", () => {
  const snapshot: ScreenerSnapshot = {
    mode: "stocks",
    query: "infy",
    sort: "match",
    filters: { minRoe: 20 },
    resultTotal: 37,
    topResults: [
      {
        symbol: "INFY",
        name: "Infosys",
        sector: "IT",
        ltp: 1500,
        pe: 24,
        roe: 30,
        marketCap: 600000,
      },
    ],
    available: { sectors: ["IT", "Banking"] },
  };

  it("embeds the live snapshot so the model sees the real screen", () => {
    const prompt = buildScreenerSystemPrompt(snapshot);
    assert.match(prompt, /INFY/);
    assert.match(prompt, /"resultTotal": 37/);
    assert.match(prompt, /"minRoe": 20/);
  });

  it("documents the per-mode filter vocabulary and sort keys", () => {
    const prompt = buildScreenerSystemPrompt(snapshot);
    assert.match(prompt, /setStockFilters/);
    assert.match(prompt, /setMfFilters/);
    assert.match(prompt, /setEtfFilters/);
    assert.match(prompt, /ret3y-desc/);
  });

  it("carries the anti-hallucination and no-advice guardrails", () => {
    const prompt = buildScreenerSystemPrompt(snapshot);
    assert.match(prompt, /NEVER invent/i);
    assert.match(prompt, /not a SEBI-registered investment adviser/i);
  });

  /*
   * NOTE ON WHAT THESE CAN AND CANNOT PROVE.
   *
   * No model runs here, so nothing below verifies that Gemini OBEYS the
   * prompt — only that the instructions the prompt is built from are
   * internally consistent and reach the model. They are deliberately
   * written against STRUCTURE (ordering, presence of both branches of a
   * rule) rather than exact wording, so a reword survives but deleting a
   * rule fails.
   *
   * The behavioural gap — does the model call the tool for a bare criteria
   * phrase, and stay hands-off for a question about displayed rows — needs
   * a live eval and is tracked in the branch's PR description, not here.
   * See TEST-COVERAGE.md's screener-chat section.
   */

  it("resolves apply-vs-answer with the question branch taking precedence", () => {
    // The two routing rules USED to contradict: "a message naming criteria
    // is ALWAYS an apply request" vs "treat as a question ONLY when it asks
    // about what is on screen". "why do these large caps all have low ROE?"
    // satisfies both, and ALWAYS outranks ONLY — so the model would apply
    // marketCapBucket: LARGE to a question. Assert the ordering exists and
    // that the question branch is stated FIRST, which is what breaks the tie.
    const prompt = buildScreenerSystemPrompt(snapshot);
    const questionRule = prompt.indexOf("QUESTION ABOUT WHAT IS ON SCREEN");
    const applyRule = prompt.indexOf("NAMES SCREENING CRITERIA");
    assert.ok(questionRule > -1, "question branch must be stated");
    assert.ok(applyRule > -1, "apply branch must be stated");
    assert.ok(
      questionRule < applyRule,
      "the question branch must come FIRST — it is the tie-breaker for a message that is both"
    );
    // And the ambiguous case must be called out explicitly, since that is
    // the one a reader (or model) would otherwise get wrong.
    assert.match(prompt, /why do these large caps all have low ROE/i);
  });

  it("forbids narrating criteria that were never applied", () => {
    const prompt = buildScreenerSystemPrompt(snapshot);
    assert.match(prompt, /NEVER describe criteria as being in effect/i);
    assert.match(prompt, /resultTotal/);
  });

  it("tells the model not to trust the count when results are stale", () => {
    // A healthy snapshot must not mention staleness at all...
    const healthy = buildScreenerSystemPrompt(snapshot);
    assert.doesNotMatch(healthy, /resultsStale":/);

    // ...but once the refetch fails, the embedded snapshot must carry the
    // flag AND the prompt must forbid quoting the stale numbers. Without
    // this the "filters actually shows them" rule green-lights the wrong
    // answer: after a failed refetch `filters` DOES show the new criteria.
    const stale = buildScreenerSystemPrompt({
      ...snapshot,
      resultsStale: { reason: "Failed to run screener" },
    });
    assert.match(stale, /"resultsStale"/, "flag must reach the model");
    assert.match(stale, /STALE RESULTS/);
    assert.match(stale, /do NOT quote the count/i);
  });
});
