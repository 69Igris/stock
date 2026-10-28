/**
 * Intent Mapper - Mutual-fund @mention routing (REAL-CONTRACT tests)
 * (lib/chat-tools/intent-mapper.ts)  — MONEY-1073
 *
 * Regression for the fund-mention research bug: the chat UI @-mentions a
 * mutual fund by its NUMERIC AMFI scheme code (`@121281`), but the fast-path's
 * `@Mention → run_research` rule matched only alphabetic-leading symbols
 * (`@[A-Z]…`). So a fund mention fell through to the Flash classifier, which
 * labelled "Research @<fund>" as an `mf_analysis` → `get_mutual_funds` and
 * dumped the user's held-funds list instead of researching the fund.
 *
 * These bind to the REAL `classifyIntentFast` (no shadow) and pin:
 *   - a lone numeric mention → run_research + `mf-analysis` + `[MUTUAL_FUND]`
 *     query (which skips startResearchAction's equity-only symbol validation);
 *   - fund names with parentheses/commas survive into the query, original-case;
 *   - numeric-LEADING tickers (360ONE) route to normal stock research;
 *   - existing alpha single / multi mention behaviour is unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyIntentFast } from "@/lib/chat-tools/intent-mapper";

// The exact string ChatPromptArea.handleSubmit builds for a fund mention:
//   `[Mentioned: @<code> (<name>, <exchange>)] <userText>`
const NIPPON =
  "[Mentioned: @121281 (NIPPON INDIA GROWTH MID CAP FUND - DIRECT Plan - IDCW Option, MF)] Research @121281";
// Fund whose name itself contains parentheses + a comma-free exchange tail.
const ICICI =
  "[Mentioned: @120585 (ICICI Prudential Large Cap Fund (erstwhile Bluechip Fund) - Direct Plan - IDCW, MF)] Research @120585";

describe("MONEY-1073 - mutual-fund @mention → mf-analysis research", () => {
  it("routes a lone numeric scheme-code mention to run_research", () => {
    const r = classifyIntentFast(NIPPON);
    assert.ok(r, "fund mention must classify (not fall through to Flash)");
    assert.strictEqual(r.tool, "run_research");
  });

  it("tags the run as a fund (assetType mf) + mf-analysis skill + advanced mode", () => {
    const r = classifyIntentFast(NIPPON);
    assert.ok(r);
    // assetType "mf" is the canonical single-fund signal (MONEY-446): the
    // run_research executor forwards it to startResearchAction, which forces
    // the mf-analysis skill AND bills the heavier mf_analysis estimate.
    assert.strictEqual(r.params.assetType, "mf");
    assert.strictEqual(r.params.skill, "mf-analysis");
    assert.strictEqual(r.params.mode, "advanced");
  });

  it("passes the scheme code through as the single symbol", () => {
    const r = classifyIntentFast(NIPPON);
    assert.ok(r);
    assert.deepStrictEqual(r.params.symbols, ["121281"]);
  });

  it("builds a [MUTUAL_FUND] query so equity symbol validation is skipped", () => {
    const r = classifyIntentFast(NIPPON);
    assert.ok(r);
    const query = r.params.query as string;
    assert.ok(
      query.startsWith("[MUTUAL_FUND]"),
      `query must be fund-shaped, got ${JSON.stringify(query)}`
    );
    // Original-case fund name (proves it's read from the raw message, not the
    // lowercased match input) with the ", MF" exchange tail stripped.
    assert.ok(
      query.includes("NIPPON INDIA GROWTH MID CAP FUND"),
      `query should carry the fund name, got ${JSON.stringify(query)}`
    );
    assert.ok(!/,\s*MF\)?$/i.test(query), "exchange tail must be stripped");
  });

  it("does not truncate a fund name that contains parentheses", () => {
    const r = classifyIntentFast(ICICI);
    assert.ok(r);
    assert.strictEqual(r.params.skill, "mf-analysis");
    const query = r.params.query as string;
    assert.ok(
      query.includes("(erstwhile Bluechip Fund)") &&
        query.includes("Direct Plan - IDCW"),
      `nested-paren fund name must survive, got ${JSON.stringify(query)}`
    );
  });

  it("falls back to the scheme code when the mention has no name", () => {
    const r = classifyIntentFast("[Mentioned: @118666]");
    assert.ok(r);
    assert.strictEqual(r.tool, "run_research");
    assert.strictEqual(r.params.skill, "mf-analysis");
    assert.strictEqual(r.params.query, "[MUTUAL_FUND] 118666");
  });

  it("handles the no-text 'Analyze <code>' form (ChatPromptArea empty send)", () => {
    // ChatPromptArea now keeps the [Mentioned:] context even with no typed
    // text, emitting `[Mentioned: …] Analyze <code>` instead of a bare
    // `Analyze <code>` that the classifier would reject as an equity symbol.
    const r = classifyIntentFast(
      "[Mentioned: @121281 (NIPPON INDIA GROWTH MID CAP FUND - DIRECT Plan - IDCW Option, MF)] Analyze 121281"
    );
    assert.ok(r);
    assert.strictEqual(r.tool, "run_research");
    assert.strictEqual(r.params.skill, "mf-analysis");
    assert.ok(String(r.params.query).startsWith("[MUTUAL_FUND]"));
  });
});

describe("MONEY-1073 - numeric-leading tickers still route to stock research", () => {
  it("a numeric-leading equity ticker (360ONE) is NOT treated as a fund", () => {
    const r = classifyIntentFast("[Mentioned: @360ONE] analyse this");
    assert.ok(r, "numeric-leading ticker mention must classify");
    assert.strictEqual(r.tool, "run_research");
    assert.deepStrictEqual(r.params.symbols, ["360ONE"]);
    // Has a letter → stock path: not a fund, no forced mf-analysis skill, no
    // [MUTUAL_FUND] query.
    assert.strictEqual(r.params.assetType, undefined);
    assert.notStrictEqual(r.params.skill, "mf-analysis");
    assert.strictEqual(r.params.skill, undefined);
    assert.ok(!String(r.params.query).startsWith("[MUTUAL_FUND]"));
  });
});

describe("MONEY-1073 - existing @mention behaviour is unchanged", () => {
  it("a single alpha stock mention keeps skill/mode undefined", () => {
    const r = classifyIntentFast("[Mentioned: @TCS] analyze this");
    assert.ok(r);
    assert.strictEqual(r.tool, "run_research");
    assert.deepStrictEqual(r.params.symbols, ["TCS"]);
    assert.strictEqual(r.params.skill, undefined);
    assert.strictEqual(r.params.mode, undefined);
  });

  it("two alpha stock mentions still force peer-comparison + advanced", () => {
    const r = classifyIntentFast(
      "[Mentioned: @RELIANCE] [Mentioned: @IOC] compare these"
    );
    assert.ok(r);
    assert.strictEqual(r.tool, "run_research");
    assert.strictEqual(r.params.skill, "peer-comparison");
    assert.strictEqual(r.params.mode, "advanced");
    assert.deepStrictEqual(r.params.symbols, ["RELIANCE", "IOC"]);
  });

  it("a numeric mention mixed with a stock is NOT a fund run (multi-symbol)", () => {
    const r = classifyIntentFast(
      "[Mentioned: @121281] [Mentioned: @TCS] compare"
    );
    assert.ok(r);
    // Two symbols → peer-comparison path, not the single-fund mf branch.
    assert.strictEqual(r.params.skill, "peer-comparison");
    assert.notStrictEqual(r.params.query, "[MUTUAL_FUND] 121281");
  });
});
