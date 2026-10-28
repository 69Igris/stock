/**
 * Chat Tool Registry - Research Tool Auto-Detection Tests
 * (lib/chat-tools/registry.ts - run_research execute logic)
 *
 * Tests for the multi-stock auto-detection logic embedded in the
 * run_research tool's execute function:
 *
 *   - Multi-stock detection (symbols.length > 1)
 *   - Auto-skill inference: "peer-comparison" for multi-stock
 *   - Auto-mode inference: "advanced" for multi-stock, "fast" for single
 *   - Query inference from symbols / description / default
 *   - Explicit params override auto-detection
 *
 * Also tests the updated ResearchParams schema (query is now optional,
 * description is allowed) and the research tool's message output logic.
 *
 * Source: apps/web/lib/chat-tools/registry.ts - run_research tool
 *
 * Note: Logic is inlined to avoid importing Next.js / server-action
 * dependencies. Implementations match the source exactly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): assert the REAL exports.
// - ResearchParams is the actual schema from registry-metadata.ts (a superset
//   of the old inline copy — it also carries customSkills/researchFocus/model).
// - inferResearchParams / buildResearchMessage now live in
//   registry-research-logic.ts and are CALLED by registry.ts's run_research
//   executor, so this pins the production auto-detection.
import { ResearchParams } from "@/lib/chat-tools/registry-metadata";
import {
  inferResearchParams,
  buildResearchMessage,
} from "@/lib/chat-tools/registry-research-logic";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Registry - run_research tool auto-detection", () => {
  // ══════════════════════ ResearchParams schema ══════════════════════

  describe("ResearchParams schema", () => {
    it("should accept empty object (all params optional)", () => {
      const result = ResearchParams.safeParse({});
      assert.ok(result.success);
    });

    it("should accept query string alone", () => {
      const result = ResearchParams.safeParse({ query: "Analyze TCS" });
      assert.ok(result.success);
    });

    it("should accept description string alone", () => {
      const result = ResearchParams.safeParse({
        description: "Compare RELIANCE vs IOC",
      });
      assert.ok(result.success);
    });

    it("should accept symbols array alone", () => {
      const result = ResearchParams.safeParse({
        symbols: ["RELIANCE.NS", "IOC.NS"],
      });
      assert.ok(result.success);
    });

    it("should accept mode 'fast'", () => {
      const result = ResearchParams.safeParse({ mode: "fast" });
      assert.ok(result.success);
    });

    it("should accept mode 'advanced'", () => {
      const result = ResearchParams.safeParse({ mode: "advanced" });
      assert.ok(result.success);
    });

    it("should reject invalid mode value", () => {
      const result = ResearchParams.safeParse({ mode: "ultra" });
      assert.ok(!result.success);
    });

    it("should accept all fields together", () => {
      const result = ResearchParams.safeParse({
        query: "Compare stocks",
        skill: "peer-comparison",
        symbols: ["TCS", "INFY"],
        mode: "advanced",
        description: "Peer comparison",
      });
      assert.ok(result.success);
    });

    it("should accept empty symbols array", () => {
      const result = ResearchParams.safeParse({ symbols: [] });
      assert.ok(result.success);
    });

    it("should reject symbols with non-string elements", () => {
      const result = ResearchParams.safeParse({ symbols: [123, 456] });
      assert.ok(!result.success);
    });
  });

  // ══════════════════════ inferResearchParams ══════════════════════

  describe("inferResearchParams", () => {
    // ── Multi-stock auto-detection ─────────────────────────────────

    it("should set skill to 'peer-comparison' for two symbols", () => {
      const result = inferResearchParams({
        symbols: ["RELIANCE.NS", "IOC.NS"],
      });
      assert.strictEqual(result.skill, "peer-comparison");
    });

    it("should set mode to 'advanced' for two symbols", () => {
      const result = inferResearchParams({
        symbols: ["RELIANCE.NS", "IOC.NS"],
      });
      assert.strictEqual(result.mode, "advanced");
    });

    it("should auto-generate query 'Compare X vs Y' for two symbols", () => {
      const result = inferResearchParams({
        symbols: ["RELIANCE", "IOC"],
      });
      assert.strictEqual(result.query, "Compare RELIANCE vs IOC");
    });

    it("should set skill to 'peer-comparison' for three symbols", () => {
      const result = inferResearchParams({
        symbols: ["A", "B", "C"],
      });
      assert.strictEqual(result.skill, "peer-comparison");
    });

    it("should set mode to 'advanced' for three symbols", () => {
      const result = inferResearchParams({
        symbols: ["A", "B", "C"],
      });
      assert.strictEqual(result.mode, "advanced");
    });

    it("should join three symbols with ' vs ' in auto-query", () => {
      const result = inferResearchParams({
        symbols: ["A", "B", "C"],
      });
      assert.strictEqual(result.query, "Compare A vs B vs C");
    });

    // ── Single-stock behaviour ─────────────────────────────────────

    it("should set skill to undefined for single symbol", () => {
      const result = inferResearchParams({ symbols: ["TCS"] });
      assert.strictEqual(result.skill, undefined);
    });

    it("should set mode to 'fast' for single symbol", () => {
      const result = inferResearchParams({ symbols: ["TCS"] });
      assert.strictEqual(result.mode, "fast");
    });

    it("should auto-generate query 'Analyze X' for single symbol", () => {
      const result = inferResearchParams({ symbols: ["TCS"] });
      assert.strictEqual(result.query, "Analyze TCS");
    });

    // ── Empty / missing symbols ────────────────────────────────────

    it("should set skill to undefined for empty symbols array", () => {
      const result = inferResearchParams({ symbols: [] });
      assert.strictEqual(result.skill, undefined);
    });

    it("should set mode to 'fast' for empty symbols array", () => {
      const result = inferResearchParams({ symbols: [] });
      assert.strictEqual(result.mode, "fast");
    });

    it("should default query to 'Stock analysis' for empty symbols array", () => {
      const result = inferResearchParams({ symbols: [] });
      assert.strictEqual(result.query, "Stock analysis");
    });

    it("should set skill to undefined when symbols is not provided", () => {
      const result = inferResearchParams({});
      assert.strictEqual(result.skill, undefined);
    });

    it("should set mode to 'fast' when symbols is not provided", () => {
      const result = inferResearchParams({});
      assert.strictEqual(result.mode, "fast");
    });

    it("should default query to 'Stock analysis' when nothing is provided", () => {
      const result = inferResearchParams({});
      assert.strictEqual(result.query, "Stock analysis");
    });

    // ── Explicit params take precedence ───────────────────────────

    it("should preserve explicit query over auto-generated one", () => {
      const result = inferResearchParams({
        query: "Custom query",
        symbols: ["RELIANCE", "IOC"],
      });
      assert.strictEqual(result.query, "Custom query");
    });

    it("should still auto-infer skill when explicit query is provided with multi-stock", () => {
      const result = inferResearchParams({
        query: "Custom query",
        symbols: ["RELIANCE", "IOC"],
      });
      assert.strictEqual(result.skill, "peer-comparison");
    });

    it("should NOT override explicit skill for multi-stock", () => {
      const result = inferResearchParams({
        symbols: ["RELIANCE", "IOC"],
        skill: "stock-analysis",
      });
      assert.strictEqual(result.skill, "stock-analysis");
    });

    it("should NOT override explicit skill for single-stock", () => {
      const result = inferResearchParams({
        symbols: ["TCS"],
        skill: "deep-analysis",
      });
      assert.strictEqual(result.skill, "deep-analysis");
    });

    it("should NOT override explicit mode 'fast' for multi-stock", () => {
      const result = inferResearchParams({
        symbols: ["RELIANCE", "IOC"],
        mode: "fast",
      });
      assert.strictEqual(result.mode, "fast");
    });

    it("should NOT override explicit mode 'advanced' for single-stock", () => {
      const result = inferResearchParams({
        symbols: ["TCS"],
        mode: "advanced",
      });
      assert.strictEqual(result.mode, "advanced");
    });

    it("should NOT override explicit mode for empty symbols", () => {
      const result = inferResearchParams({ mode: "advanced" });
      assert.strictEqual(result.mode, "advanced");
    });

    // ── description fallback ──────────────────────────────────────

    it("should use description as query when query is not provided", () => {
      const result = inferResearchParams({
        description: "Analyze something specific",
      });
      assert.strictEqual(result.query, "Analyze something specific");
    });

    it("should prefer query over description when both are given", () => {
      const result = inferResearchParams({
        query: "Q takes precedence",
        description: "D is ignored",
      });
      assert.strictEqual(result.query, "Q takes precedence");
    });

    it("should use description over symbol-based auto-query for single symbol", () => {
      const result = inferResearchParams({
        description: "Deep dive into TCS",
        symbols: ["TCS"],
      });
      // description comes before symbol fallback in the chain
      assert.strictEqual(result.query, "Deep dive into TCS");
    });

    it("should use description over multi-symbol auto-query", () => {
      const result = inferResearchParams({
        description: "Custom comparison text",
        symbols: ["RELIANCE", "IOC"],
      });
      assert.strictEqual(result.query, "Custom comparison text");
    });

    // ── symbols passthrough ────────────────────────────────────────

    it("should pass symbols through to result unchanged", () => {
      const input = ["RELIANCE.NS", "IOC.NS"];
      const result = inferResearchParams({ symbols: input });
      assert.deepStrictEqual(result.symbols, input);
    });

    it("should return undefined symbols when not provided", () => {
      const result = inferResearchParams({});
      assert.strictEqual(result.symbols, undefined);
    });

    it("should return empty array when symbols is empty array", () => {
      const result = inferResearchParams({ symbols: [] });
      assert.deepStrictEqual(result.symbols, []);
    });
  });

  // ══════════════════════ buildResearchMessage ══════════════════════

  describe("buildResearchMessage", () => {
    it("should return 'Quick ...' for fast mode", () => {
      const msg = buildResearchMessage("fast");
      assert.ok(msg.startsWith("Quick"));
    });

    it("should return 'Comprehensive ...' for advanced mode", () => {
      const msg = buildResearchMessage("advanced");
      assert.ok(msg.startsWith("Comprehensive"));
    });

    it("should mention 'research started' in both modes", () => {
      assert.ok(buildResearchMessage("fast").includes("research started"));
      assert.ok(buildResearchMessage("advanced").includes("research started"));
    });

    it("should mention progress update in both messages", () => {
      assert.ok(buildResearchMessage("fast").includes("progress"));
      assert.ok(buildResearchMessage("advanced").includes("progress"));
    });
  });

  // ══════════════════════ end-to-end param construction ══════════════════════

  describe("end-to-end param construction scenarios", () => {
    it("two symbols with no query: peer-comparison, advanced, Compare X vs Y", () => {
      const result = inferResearchParams({
        symbols: ["TCS.NS", "INFY.NS"],
      });
      assert.strictEqual(result.skill, "peer-comparison");
      assert.strictEqual(result.mode, "advanced");
      assert.strictEqual(result.query, "Compare TCS.NS vs INFY.NS");
    });

    it("single symbol with description: undefined skill, fast, description as query", () => {
      const result = inferResearchParams({
        symbols: ["RELIANCE.NS"],
        description: "Sector-level overview of energy",
      });
      assert.strictEqual(result.skill, undefined);
      assert.strictEqual(result.mode, "fast");
      assert.strictEqual(result.query, "Sector-level overview of energy");
    });

    it("explicit skill + multi symbols: skill preserved, mode auto-advanced", () => {
      const result = inferResearchParams({
        symbols: ["HDFCBANK.NS", "ICICIBANK.NS"],
        skill: "sector-analysis",
      });
      assert.strictEqual(result.skill, "sector-analysis");
      assert.strictEqual(result.mode, "advanced");
      assert.strictEqual(result.query, "Compare HDFCBANK.NS vs ICICIBANK.NS");
    });

    it("fully explicit params: all preserved, no override", () => {
      const result = inferResearchParams({
        query: "What is the outlook for banking sector?",
        skill: "sector-analysis",
        mode: "advanced",
        symbols: ["HDFCBANK.NS"],
      });
      assert.strictEqual(
        result.query,
        "What is the outlook for banking sector?"
      );
      assert.strictEqual(result.skill, "sector-analysis");
      assert.strictEqual(result.mode, "advanced");
      assert.deepStrictEqual(result.symbols, ["HDFCBANK.NS"]);
    });

    it("no params at all: defaults to Stock analysis, fast, undefined skill", () => {
      const result = inferResearchParams({});
      assert.strictEqual(result.query, "Stock analysis");
      assert.strictEqual(result.skill, undefined);
      assert.strictEqual(result.mode, "fast");
      assert.strictEqual(result.symbols, undefined);
    });
  });
});
