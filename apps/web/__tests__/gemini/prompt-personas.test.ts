/**
 * Prompt Personas Tests (lib/gemini/prompt-personas.ts)
 *
 * Tests for the expert persona registry and system prompt composition:
 *   - PERSONAS registry: all 10 personas defined with required fields
 *   - getPersona: retrieves persona by ID, fallback to general_analyst
 *   - getAllPersonaIds: returns all 10 persona IDs
 *   - composeSystemPrompt: assembles prompt with preamble + persona + compliance
 *   - SHARED_COMPLIANCE_BLOCK: contains SEBI disclaimer and critical rules
 *   - BLOCK_FORMAT_INSTRUCTIONS: contains all 7 block types
 *
 * Pure functions extracted inline to avoid server-only import chains.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL persona registry + shared blocks.
// The DATA now lives in prompt-personas-data.ts (free of the server-only
// chat-tools chain), so it imports cleanly here. The old copy was a MINIMAL,
// DRIFTED stand-in: equity_research had 5 trigger keywords vs 14 in the source,
// and "all 7 block types" is stale — the real BLOCK_FORMAT_INSTRUCTIONS defines
// 15 typed blocks (table, card, chart, action, navigation, comparison, error,
// tax, mf, fire, sector, technical, pnl, dividend, scorecard).
import {
  PERSONAS,
  getPersona,
  getAllPersonaIds,
  BASE_HEDGE_FUND_PREAMBLE,
  SHARED_COMPLIANCE_BLOCK,
  BLOCK_FORMAT_INSTRUCTIONS,
} from "@/lib/gemini/prompt-personas-data";

const ALL_PERSONA_IDS = getAllPersonaIds();

// The base typed block markers every renderer must keep supporting.
const CORE_BLOCK_TYPES = [
  "table",
  "card",
  "chart",
  "action",
  "navigation",
  "comparison",
  "error",
];

// ── Tests ──────────────────────────────────────────────────────────────

describe("Prompt Personas", () => {
  describe("PERSONAS registry", () => {
    it("should have exactly 10 personas", () => {
      assert.strictEqual(Object.keys(PERSONAS).length, 10);
    });

    it("should have all expected persona IDs", () => {
      for (const id of ALL_PERSONA_IDS) {
        assert.ok(PERSONAS[id], `Missing persona: ${id}`);
      }
    });

    for (const id of ALL_PERSONA_IDS) {
      it(`${id}: should have required fields`, () => {
        const persona = PERSONAS[id];
        assert.ok(persona.id, "id");
        assert.strictEqual(persona.id, id, "id should match key");
        assert.ok(persona.title, "title");
        assert.ok(persona.description, "description");
        assert.ok(persona.systemPromptInstructions, "systemPromptInstructions");
        assert.ok(Array.isArray(persona.followUpChips), "followUpChips array");
        assert.ok(
          Array.isArray(persona.triggerKeywords),
          "triggerKeywords array"
        );
        assert.ok(
          Array.isArray(persona.applicableTools),
          "applicableTools array"
        );
      });
    }

    it("general_analyst should have empty triggerKeywords (catch-all)", () => {
      assert.strictEqual(PERSONAS.general_analyst.triggerKeywords.length, 0);
    });

    it("general_analyst should have empty applicableTools (all tools)", () => {
      assert.strictEqual(PERSONAS.general_analyst.applicableTools.length, 0);
    });

    it("equity_research should have 5 follow-up chips", () => {
      assert.strictEqual(PERSONAS.equity_research.followUpChips.length, 5);
    });

    it("follow-up chips should have {symbol} placeholder where relevant", () => {
      const chips = PERSONAS.equity_research.followUpChips;
      const symbolChips = chips.filter((c) => c.prompt?.includes("{symbol}"));
      assert.ok(
        symbolChips.length >= 3,
        "Most equity research chips should reference {symbol}"
      );
    });
  });

  describe("getPersona()", () => {
    it("should return correct persona for valid ID", () => {
      const persona = getPersona("equity_research");
      assert.strictEqual(persona.id, "equity_research");
      assert.strictEqual(persona.title, "Senior Equity Research Analyst");
    });

    it("should return general_analyst for unknown ID", () => {
      const persona = getPersona("nonexistent_persona");
      assert.strictEqual(persona.id, "general_analyst");
      assert.strictEqual(persona.title, "Senior Analyst");
    });

    it("should return general_analyst for empty string", () => {
      const persona = getPersona("");
      assert.strictEqual(persona.id, "general_analyst");
    });

    it("should return each persona correctly", () => {
      for (const id of ALL_PERSONA_IDS) {
        const persona = getPersona(id);
        assert.strictEqual(persona.id, id);
      }
    });
  });

  describe("getAllPersonaIds()", () => {
    it("should return 10 IDs", () => {
      const ids = getAllPersonaIds();
      assert.strictEqual(ids.length, 10);
    });

    it("should include all expected IDs", () => {
      const ids = getAllPersonaIds();
      for (const expected of ALL_PERSONA_IDS) {
        assert.ok(ids.includes(expected), `Missing: ${expected}`);
      }
    });
  });

  describe("Shared prompt components", () => {
    it("BASE_HEDGE_FUND_PREAMBLE should mention Indian capital markets", () => {
      assert.ok(BASE_HEDGE_FUND_PREAMBLE.includes("Indian capital markets"));
    });

    it("SHARED_COMPLIANCE_BLOCK should reference SEBI + the advisor disclaimer", () => {
      assert.ok(SHARED_COMPLIANCE_BLOCK.includes("SEBI"));
      assert.ok(
        SHARED_COMPLIANCE_BLOCK.includes("SEBI-\n   registered advisor")
      );
    });

    it("BLOCK_FORMAT_INSTRUCTIONS should define the 7 core block markers", () => {
      for (const type of CORE_BLOCK_TYPES) {
        assert.ok(
          BLOCK_FORMAT_INSTRUCTIONS.includes(`:::block:${type}`),
          `missing :::block:${type}`
        );
      }
    });

    it("BLOCK_FORMAT_INSTRUCTIONS should define the 15 typed blocks (not 7)", () => {
      const markerCount = (
        BLOCK_FORMAT_INSTRUCTIONS.match(/:::block:[a-z]+/g) || []
      ).length;
      // The OLD shadow asserted only 7 — the real registry now defines 15.
      assert.strictEqual(markerCount, 15);
    });
  });

  describe("Persona trigger keywords", () => {
    it("no trigger keyword should be shared by more than 2 personas", () => {
      const keywordMap = new Map<string, string[]>();
      for (const [id, persona] of Object.entries(PERSONAS)) {
        if (id === "general_analyst") continue;
        for (const kw of persona.triggerKeywords) {
          const existing = keywordMap.get(kw) || [];
          existing.push(id);
          keywordMap.set(kw, existing);
        }
      }
      const highOverlap = [...keywordMap.entries()].filter(
        ([, ids]) => ids.length > 2
      );
      assert.strictEqual(
        highOverlap.length,
        0,
        `Keywords shared by >2 personas: ${highOverlap.map(([kw]) => kw).join(", ")}`
      );
    });

    it("each non-general persona should have at least 3 trigger keywords", () => {
      for (const [id, persona] of Object.entries(PERSONAS)) {
        if (id === "general_analyst") continue;
        assert.ok(
          persona.triggerKeywords.length >= 3,
          `${id} has only ${persona.triggerKeywords.length} keywords`
        );
      }
    });
  });

  describe("Persona applicable tools", () => {
    it("equity_research should include run_research", () => {
      assert.ok(
        PERSONAS.equity_research.applicableTools.includes("run_research")
      );
    });

    it("financial_planner should include get_fire_scenarios", () => {
      assert.ok(
        PERSONAS.financial_planner.applicableTools.includes(
          "get_fire_scenarios"
        )
      );
    });

    it("portfolio_manager should include portfolio_risk_analysis", () => {
      assert.ok(
        PERSONAS.portfolio_manager.applicableTools.includes(
          "portfolio_risk_analysis"
        )
      );
    });

    it("private_banker should include tax_report", () => {
      assert.ok(PERSONAS.private_banker.applicableTools.includes("tax_report"));
    });

    it("wealth_advisor should include get_mutual_funds", () => {
      assert.ok(
        PERSONAS.wealth_advisor.applicableTools.includes("get_mutual_funds")
      );
    });
  });
});
