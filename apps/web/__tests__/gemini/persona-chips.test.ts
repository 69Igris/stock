/**
 * Persona Chips Tests (lib/gemini/persona-chips.ts)
 *
 * Tests for the client-safe persona follow-up chip definitions:
 *   - PERSONA_CHIPS: all 10 personas have chip arrays
 *   - Chip structure validation (label, prompt, icon)
 *   - Symbol interpolation ({symbol} placeholder)
 *   - Icon names are valid lucide-react icons
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline PERSONA_CHIPS (subset for testing structure) ──────────────

// We import directly since this module is client-safe (no server deps)
import { PERSONA_CHIPS, type ChipDef } from "../../lib/gemini/persona-chips";

// ── Valid icon names (matching the ICON_MAP in FollowUpChips.tsx) ──────

const VALID_ICONS = new Set([
  "TrendingUp",
  "Users",
  "Newspaper",
  "BarChart3",
  "Search",
  "SlidersHorizontal",
  "Flame",
  "Plus",
  "LineChart",
]);

const ALL_PERSONA_IDS = [
  "equity_research",
  "wealth_advisor",
  "financial_planner",
  "quant_analyst",
  "technical_analyst",
  "portfolio_manager",
  "private_banker",
  "macro_strategist",
  "sell_side_analyst",
  "general_analyst",
];

// ── Tests ──────────────────────────────────────────────────────────────

describe("Persona Chips", () => {
  describe("PERSONA_CHIPS registry", () => {
    it("should have entries for all 10 personas", () => {
      for (const id of ALL_PERSONA_IDS) {
        assert.ok(PERSONA_CHIPS[id], `Missing chips for persona: ${id}`);
      }
    });

    it("should have exactly 10 entries", () => {
      assert.strictEqual(Object.keys(PERSONA_CHIPS).length, 10);
    });
  });

  describe("Chip structure validation", () => {
    for (const id of ALL_PERSONA_IDS) {
      it(`${id}: each chip should have label, prompt, and icon`, () => {
        const chips = PERSONA_CHIPS[id];
        assert.ok(Array.isArray(chips), `${id} should have an array of chips`);

        for (const chip of chips!) {
          assert.ok(chip.label, `${id}: chip missing label`);
          // prompt is optional in ChipDef - chips without it fall
          // through to the label as the typed text. Only require the
          // non-optional fields (label + icon).
          assert.ok(chip.icon, `${id}: chip missing icon`);
          assert.ok(
            chip.label.length > 0 && chip.label.length < 30,
            `${id}: chip label "${chip.label}" should be 1-30 chars`
          );
        }
      });
    }

    for (const id of ALL_PERSONA_IDS) {
      it(`${id}: chips should have valid icon names`, () => {
        const chips = PERSONA_CHIPS[id]!;
        for (const chip of chips) {
          assert.ok(
            VALID_ICONS.has(chip.icon),
            `${id}: invalid icon "${chip.icon}" in chip "${chip.label}". Valid: ${[...VALID_ICONS].join(", ")}`
          );
        }
      });
    }
  });

  describe("Symbol interpolation", () => {
    it("equity_research chips should contain {symbol} placeholders", () => {
      const chips = PERSONA_CHIPS["equity_research"]!;
      const withSymbol = chips.filter((c) => c.prompt?.includes("{symbol}"));
      assert.ok(
        withSymbol.length >= 3,
        `Expected ≥3 chips with {symbol}, got ${withSymbol.length}`
      );
    });

    it("technical_analyst chips should contain {symbol} placeholders", () => {
      const chips = PERSONA_CHIPS["technical_analyst"]!;
      const withSymbol = chips.filter((c) => c.prompt?.includes("{symbol}"));
      assert.ok(
        withSymbol.length >= 2,
        `Expected ≥2 chips with {symbol}, got ${withSymbol.length}`
      );
    });

    it("portfolio_manager chips should NOT require {symbol} (portfolio-wide)", () => {
      const chips = PERSONA_CHIPS["portfolio_manager"]!;
      // Portfolio manager operates on the whole portfolio, so most chips
      // should NOT need a {symbol} placeholder. Guard against optional
      // prompt (ChipDef.prompt is optional - chips without it fall
      // through to the label as the user-typed text).
      const withSymbol = chips.filter(
        (c) => c.prompt !== undefined && c.prompt.includes("{symbol}")
      );
      assert.ok(
        withSymbol.length <= 1,
        `Portfolio manager should have ≤1 symbol chips, got ${withSymbol.length}`
      );
    });

    it("{symbol} interpolation should work correctly", () => {
      const chip: ChipDef = {
        label: "Test",
        prompt: "Analyse {symbol} in detail for {symbol} valuation",
        icon: "Search",
      };
      const interpolated = chip.prompt!.replace(/\{symbol\}/g, "TCS");
      assert.strictEqual(
        interpolated,
        "Analyse TCS in detail for TCS valuation"
      );
    });
  });

  describe("Chip count per persona", () => {
    it("equity_research should have 5 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["equity_research"]!.length, 5);
    });

    it("wealth_advisor should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["wealth_advisor"]!.length, 4);
    });

    it("financial_planner should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["financial_planner"]!.length, 4);
    });

    it("quant_analyst should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["quant_analyst"]!.length, 4);
    });

    it("technical_analyst should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["technical_analyst"]!.length, 4);
    });

    it("portfolio_manager should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["portfolio_manager"]!.length, 4);
    });

    it("private_banker should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["private_banker"]!.length, 4);
    });

    it("macro_strategist should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["macro_strategist"]!.length, 4);
    });

    it("sell_side_analyst should have 4 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["sell_side_analyst"]!.length, 4);
    });

    it("general_analyst should have 3 chips", () => {
      assert.strictEqual(PERSONA_CHIPS["general_analyst"]!.length, 3);
    });

    it("every persona should have at least 3 chips", () => {
      for (const [id, chips] of Object.entries(PERSONA_CHIPS)) {
        assert.ok(chips.length >= 3, `${id} has only ${chips.length} chips`);
      }
    });
  });

  describe("Chip label uniqueness", () => {
    for (const id of ALL_PERSONA_IDS) {
      it(`${id}: should have unique chip labels`, () => {
        const chips = PERSONA_CHIPS[id]!;
        const labels = chips.map((c) => c.label);
        const unique = new Set(labels);
        assert.strictEqual(
          unique.size,
          labels.length,
          `${id}: duplicate labels found: ${labels.filter((l, i) => labels.indexOf(l) !== i).join(", ")}`
        );
      });
    }
  });

  describe("Chip prompts should be actionable", () => {
    it("chips should not have empty prompts (when defined - prompt is optional)", () => {
      // ChipDef.prompt is optional - chips without an explicit prompt
      // fall through to the label as the user-typed text. Only the
      // defined prompts need a min-length check.
      for (const [id, chips] of Object.entries(PERSONA_CHIPS)) {
        for (const chip of chips) {
          if (chip.prompt === undefined) continue;
          assert.ok(
            chip.prompt.length >= 10,
            `${id}: chip "${chip.label}" has too-short prompt: "${chip.prompt}"`
          );
        }
      }
    });

    it("chips should not have prompts longer than 200 chars (when defined)", () => {
      for (const [id, chips] of Object.entries(PERSONA_CHIPS)) {
        for (const chip of chips) {
          if (chip.prompt === undefined) continue;
          assert.ok(
            chip.prompt.length <= 200,
            `${id}: chip "${chip.label}" has too-long prompt (${chip.prompt.length} chars)`
          );
        }
      }
    });
  });

  // MONEY-587: suggestion chips must dispatch to a ready backend, never a
  // free-text prompt that falls through the classifier onto a tool that can't
  // fulfil it (the "Suggest stocks that benefit from the current macro theme"
  // → run_screener → "could not parse" dead-end). Screener + macro personas
  // are deterministic-only; un-fulfillable thematic chips were removed.
  describe("Deterministic dispatch (MONEY-587)", () => {
    for (const id of ["quant_analyst", "macro_strategist"] as const) {
      it(`${id}: every chip dispatches via tool or navigateTo (no classifier fallthrough)`, () => {
        const chips = PERSONA_CHIPS[id]!;
        for (const chip of chips) {
          assert.ok(
            chip.tool || chip.navigateTo,
            `${id}: chip "${chip.label}" must use tool/navigateTo, not a free-text prompt`
          );
          assert.ok(
            !chip.prompt,
            `${id}: chip "${chip.label}" should not carry a free-text prompt`
          );
        }
      });
    }

    it("un-fulfillable thematic/screener chips were removed", () => {
      const allLabels = Object.values(PERSONA_CHIPS)
        .flat()
        .map((c) => c.label);
      const removed = [
        "Top Picks by Theme",
        "Sector Rotation",
        "FII/DII Flows",
        "Rate Sensitivity",
        "Tighten Filters",
        "Sector Leaders",
        "Momentum Overlay",
        "Different Strategy",
      ];
      for (const label of removed) {
        assert.ok(
          !allLabels.includes(label),
          `chip "${label}" should have been removed (no ready backend)`
        );
      }
    });

    it("screener tool chips reference known-ready named strategies", () => {
      // Keep in sync with packages/research builtin-strategies ids used above.
      const READY_STRATEGIES = new Set([
        "low_debt_high_roe",
        "growth_momentum",
        "garp",
        "strong_fundamentals_fii",
        "dividend_aristocrats",
      ]);
      const screenerChips = Object.values(PERSONA_CHIPS)
        .flat()
        .filter(
          (c) => c.tool === "run_screener" && c.params?.strategy !== undefined
        );
      assert.ok(
        screenerChips.length >= 4,
        `expected ≥4 deterministic screener chips, got ${screenerChips.length}`
      );
      for (const chip of screenerChips) {
        assert.ok(
          READY_STRATEGIES.has(chip.params!.strategy as string),
          `chip "${chip.label}" uses unknown strategy "${String(chip.params!.strategy)}"`
        );
      }
    });
  });
});
