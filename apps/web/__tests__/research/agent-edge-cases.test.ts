/**
 * Research Agent edge cases — REAL source (MONEY-620 de-shadow).
 *
 * Previously this file re-implemented `buildContentBlocks`, the qualityScore
 * extraction, `hasValidReport` and `detectQueryType` inline and asserted the
 * copies. The inline `buildContentBlocks` in particular encoded PRE-MONEY-457
 * behaviour (score card gated on `report.recommendation`, recommendation shown
 * in the subtitle/items) — the real function changed to a confidence-only card
 * emitted whenever `score` is a number, so the shadow stayed green while prod
 * diverged. It now imports the REAL pure exports from
 * `packages/research/src/agent-logic.ts` (which `agent.ts` calls).
 *
 * The emergency-synthesis JSON-parse path, the low-time task-skip heuristic and
 * the swallowed-session-update behaviour live inside async `ResearchAgent`
 * methods that call Gemini/Prisma and have no pure exported counterpart; those
 * reimplementation-only suites were dropped rather than kept as shadows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildContentBlocks,
  computeQualityScore,
  hasValidReport,
  detectQueryType,
} from "@usemoney/research/agent-logic";

// ── Score extraction (computeQualityScore) ──────────────────────────────────

describe("computeQualityScore — extraction & falsy-0 handling", () => {
  const FAST = true; // skipValidation
  const ADVANCED = false;

  it("report.score=0 in fast mode → undefined (0 is falsy, fast skips it)", () => {
    assert.strictEqual(
      computeQualityScore(
        { score: 0, recommendation: "N/A", summary: "Synthesis failed" },
        0,
        FAST
      ),
      undefined
    );
  });

  it("report.score=0 in advanced mode → 0", () => {
    assert.strictEqual(
      computeQualityScore({ score: 0, recommendation: "N/A" }, 0, ADVANCED),
      0
    );
  });

  it("fast mode: report.score used as fallback (72)", () => {
    assert.strictEqual(
      computeQualityScore({ score: 72, recommendation: "BUY" }, 0, FAST),
      72
    );
  });

  it("advanced mode: validation score preferred over report.score, 0-1 scaled", () => {
    // validation 0.85 (0-1 scale) → 85, beats report.score 60.
    assert.strictEqual(
      computeQualityScore(
        { score: 60, recommendation: "HOLD" },
        0.85,
        ADVANCED
      ),
      85
    );
  });

  it("advanced mode: falls back to report.score when validation score is 0", () => {
    assert.strictEqual(
      computeQualityScore({ score: 55, recommendation: "HOLD" }, 0, ADVANCED),
      55
    );
  });

  it("fast mode with a string report → undefined", () => {
    assert.strictEqual(
      computeQualityScore("plain text report", 0, FAST),
      undefined
    );
  });

  it("advanced mode with a string report → 0", () => {
    assert.strictEqual(
      computeQualityScore("plain text report", 0, ADVANCED),
      0
    );
  });

  it("a 0-100 validator score is NOT re-scaled (82 stays 82)", () => {
    assert.strictEqual(computeQualityScore({ score: 60 }, 82, ADVANCED), 82);
  });
});

// ── hasValidReport ──────────────────────────────────────────────────────────

describe("hasValidReport", () => {
  it("report with score=0 is NOT valid (triggers emergency synthesis)", () => {
    assert.strictEqual(
      hasValidReport({ score: 0, recommendation: "N/A" }),
      false
    );
  });

  it("report with score=1 IS valid", () => {
    assert.strictEqual(
      hasValidReport({ score: 1, recommendation: "SELL" }),
      true
    );
  });

  it("report object with no score field IS valid (score !== 0)", () => {
    // `(report.score !== 0)` is true when score is undefined.
    assert.strictEqual(hasValidReport({ summary: "text" }), true);
  });

  it("non-empty string report IS valid", () => {
    assert.strictEqual(hasValidReport("Some text"), true);
  });

  it("empty string report is NOT valid", () => {
    assert.strictEqual(hasValidReport(""), false);
  });

  it("whitespace-only string report is NOT valid", () => {
    assert.strictEqual(hasValidReport("   "), false);
  });

  it("null / undefined report is NOT valid", () => {
    assert.strictEqual(hasValidReport(null), false);
    assert.strictEqual(hasValidReport(undefined), false);
  });
});

// ── buildContentBlocks (MONEY-457 behaviour) ────────────────────────────────

describe("buildContentBlocks", () => {
  it("score=0 STILL produces a metric card (card gated on typeof score, not recommendation)", () => {
    const report = {
      score: 0,
      recommendation: "N/A",
      summary: "Synthesis failed",
    };
    const blocks = buildContentBlocks(report, ["RELIANCE.NS"]);
    const cards = blocks.filter(
      (b) => b.type === "card" && b.variant === "metric"
    );
    assert.strictEqual(cards.length, 1);
    assert.strictEqual((cards[0] as Record<string, unknown>).value, "0/100");
  });

  it("metric card subtitle shows confidence only — never the recommendation (MONEY-457)", () => {
    const report = { score: 80, recommendation: "STRONG BUY", confidence: 90 };
    const blocks = buildContentBlocks(report, ["RELIANCE.NS"]);
    const card = blocks.find(
      (b) => b.type === "card" && b.variant === "metric"
    ) as Record<string, unknown>;
    assert.strictEqual(card.subtitle, "Confidence: 90%");
    // The recommendation must NOT appear anywhere in the card.
    assert.ok(!JSON.stringify(card).includes("STRONG BUY"));
  });

  it("metric card Symbol item strips the .NS/.BO suffix", () => {
    const report = { score: 70, summary: "ok" };
    const blocks = buildContentBlocks(report, ["RELIANCE.NS", "TCS.BO"]);
    const card = blocks.find(
      (b) => b.type === "card" && b.variant === "metric"
    ) as Record<string, unknown>;
    const items = card.items as Array<{ label: string; value: string }>;
    assert.strictEqual(items[0]!.value, "RELIANCE, TCS");
  });

  it("confidence defaults to N/A when absent", () => {
    const report = { score: 50, summary: "x" };
    const blocks = buildContentBlocks(report, ["X.NS"]);
    const card = blocks.find(
      (b) => b.type === "card" && b.variant === "metric"
    ) as Record<string, unknown>;
    assert.strictEqual(card.subtitle, "Confidence: N/A%");
  });

  it("empty-string recommendation does NOT suppress the card (card ignores recommendation)", () => {
    const report = { score: 50, recommendation: "", summary: "Neutral" };
    const blocks = buildContentBlocks(report, ["XYZ.NS"]);
    const cards = blocks.filter(
      (b) => b.type === "card" && b.variant === "metric"
    );
    // Pre-MONEY-457 the empty recommendation suppressed the card; now it does not.
    assert.strictEqual(cards.length, 1);
  });

  it("string report → single text block", () => {
    const blocks = buildContentBlocks("Plain text report", ["TCS.NS"]);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]!.type, "text");
    assert.strictEqual(blocks[0]!.content, "Plain text report");
  });

  it("report with no renderable fields → JSON fallback text block", () => {
    const report = { someField: "value" };
    const blocks = buildContentBlocks(report, ["INFY.NS"]);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]!.type, "text");
    assert.strictEqual(blocks[0]!.content, JSON.stringify(report, null, 2));
  });

  it("report with only summary → single text block", () => {
    const report = { summary: "This is a summary" };
    const blocks = buildContentBlocks(report, ["HDFC.NS"]);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]!.type, "text");
    assert.strictEqual(blocks[0]!.content, "This is a summary");
  });

  it("score + summary + keyMetrics → metric card, summary text, info card", () => {
    const report = {
      score: 85,
      recommendation: "BUY",
      confidence: 90,
      summary: "Strong stock",
      keyMetrics: [{ label: "PE", value: 25, verdict: "Fair" }],
    };
    const blocks = buildContentBlocks(report, ["RELIANCE.NS"]);
    assert.strictEqual(blocks.length, 3);
    assert.strictEqual(blocks[0]!.type, "card");
    assert.strictEqual(blocks[1]!.type, "text");
    assert.strictEqual(blocks[2]!.type, "card");
    assert.strictEqual((blocks[2] as Record<string, unknown>).variant, "info");
  });

  it("empty keyMetrics array → no info card", () => {
    const report = { score: 70, recommendation: "HOLD", keyMetrics: [] };
    const blocks = buildContentBlocks(report, ["SBIN.NS"]);
    // Only the metric card; no key-metrics card for an empty array.
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]!.type, "card");
    assert.strictEqual(
      (blocks[0] as Record<string, unknown>).variant,
      "metric"
    );
  });

  it("keyMetrics formats label and 'value (verdict)'", () => {
    const report = {
      summary: "x",
      keyMetrics: [{ label: "ROE", value: "22%", verdict: "good" }],
    };
    const blocks = buildContentBlocks(report, ["X.NS"]);
    const infoCard = blocks.find(
      (b) => b.type === "card" && b.variant === "info"
    ) as Record<string, unknown>;
    const items = infoCard.items as Array<{ label: string; value: string }>;
    assert.strictEqual(items[0]!.label, "ROE");
    assert.strictEqual(items[0]!.value, "22% (good)");
  });
});

// ── detectQueryType (a few representative routes; full matrix in
//    agent-query-cleaning.test.ts) ─────────────────────────────────────────

describe("detectQueryType (agent edge routes)", () => {
  it("strategy keywords route to strategy", () => {
    assert.strictEqual(
      detectQueryType("Apply momentum strategy to stock market"),
      "strategy"
    );
  });

  it("comparison keyword routes to comparison", () => {
    assert.strictEqual(
      detectQueryType("Compare RELIANCE vs TCS"),
      "comparison"
    );
  });

  it("sector keyword routes to sector", () => {
    assert.strictEqual(
      detectQueryType("Analyze banking sector outlook"),
      "sector"
    );
  });

  it("portfolio keyword routes to portfolio", () => {
    assert.strictEqual(
      detectQueryType("Analyze my portfolio risk"),
      "portfolio"
    );
  });

  it("valuation keywords route to valuation", () => {
    assert.strictEqual(
      detectQueryType("What is the intrinsic value of RELIANCE"),
      "valuation"
    );
    assert.strictEqual(detectQueryType("Run DCF analysis on TCS"), "valuation");
  });

  it("a generic query returns undefined (default stock-analysis)", () => {
    assert.strictEqual(
      detectQueryType("Tell me about RELIANCE stock"),
      undefined
    );
  });
});
