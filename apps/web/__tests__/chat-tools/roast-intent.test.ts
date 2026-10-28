/**
 * Roast intent classification tests (MONEY-295)
 *
 * Bug 7: "Roast my portfolio …" was Flash-classifying as `portfolio` →
 * `get_portfolio_summary`, returning a raw stats card instead of
 * triggering the actual portfolio roast workflow. Root cause: the
 * Flash intent classifier had no `portfolio_roast` intent option, and
 * the `intentToTool` map had no `portfolio_roast → start_roast`
 * mapping. The regex fallback also had no roast pattern.
 *
 * Fix: added `portfolio_roast` to INTENTS, AVAILABLE TOOLS, the
 * intentToTool map, and a regex fallback for "roast" + portfolio
 * keywords. Also extracts asset type (stocks/mf/all) and broker
 * filter from the user message.
 *
 * Source: apps/web/lib/chat-tools/intent-mapper.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyIntentFast } from "../../lib/chat-tools/intent-mapper";

describe("Roast intent - regex fast-path", () => {
  it("matches 'roast my portfolio'", () => {
    const result = classifyIntentFast("roast my portfolio");
    assert.equal(result?.tool, "start_roast");
    assert.equal(result?.params.mode, "overall");
    assert.equal(result?.params.assetType, "all");
  });

  it("matches the verbose StockSage prompt", () => {
    const result = classifyIntentFast(
      "Roast my portfolio - score my holdings on diversification, concentration risk, sector allocation, and quality. Flag any red flags and suggest specific improvements."
    );
    assert.equal(result?.tool, "start_roast");
  });

  it("matches 'rate my portfolio'", () => {
    const result = classifyIntentFast("rate my portfolio");
    assert.equal(result?.tool, "start_roast");
  });

  it("matches 'score my holdings'", () => {
    const result = classifyIntentFast("score my holdings");
    assert.equal(result?.tool, "start_roast");
  });

  it("matches 'critique my portfolio'", () => {
    const result = classifyIntentFast("critique my portfolio");
    assert.equal(result?.tool, "start_roast");
  });

  it("matches 'grade my holdings'", () => {
    const result = classifyIntentFast("grade my holdings");
    assert.equal(result?.tool, "start_roast");
  });

  it("matches bare 'roast me'", () => {
    const result = classifyIntentFast("roast me");
    assert.equal(result?.tool, "start_roast");
  });
});

describe("Roast intent - broker extraction", () => {
  it("extracts Zerodha as broker mode", () => {
    const result = classifyIntentFast("roast my Zerodha portfolio");
    assert.equal(result?.tool, "start_roast");
    assert.equal(result?.params.mode, "broker");
    assert.equal(result?.params.broker, "ZERODHA");
  });

  it("extracts Upstox as broker mode", () => {
    const result = classifyIntentFast("roast my upstox holdings");
    assert.equal(result?.params.mode, "broker");
    assert.equal(result?.params.broker, "UPSTOX");
  });

  it("extracts Angel One as broker mode", () => {
    const result = classifyIntentFast("roast my angel one portfolio");
    assert.equal(result?.params.broker, "ANGEL_ONE");
  });
});

describe("Roast intent - asset type extraction", () => {
  it("extracts stocks-only roast", () => {
    const result = classifyIntentFast("roast my stocks");
    assert.equal(result?.tool, "start_roast");
    assert.equal(result?.params.assetType, "stocks");
  });

  it("extracts MF-only roast", () => {
    const result = classifyIntentFast("roast my mutual funds");
    assert.equal(result?.params.assetType, "mf");
  });

  it("defaults to 'all' when asset type isn't specified", () => {
    const result = classifyIntentFast("roast my portfolio");
    assert.equal(result?.params.assetType, "all");
  });
});

describe("Roast intent - false-positive guards", () => {
  it("does NOT match 'beef roast recipe' (off-topic, no portfolio context)", () => {
    const result = classifyIntentFast("beef roast recipe");
    // Topic classifier handles this upstream; here we just verify the
    // regex doesn't latch onto bare "roast" without portfolio cues.
    assert.notEqual(result?.tool, "start_roast");
  });

  it("does NOT match 'analyse my portfolio' (different intent)", () => {
    const result = classifyIntentFast("analyse my portfolio");
    assert.notEqual(result?.tool, "start_roast");
  });

  it("does NOT match 'show my portfolio' (portfolio summary intent)", () => {
    const result = classifyIntentFast("show my portfolio");
    assert.notEqual(result?.tool, "start_roast");
  });
});
