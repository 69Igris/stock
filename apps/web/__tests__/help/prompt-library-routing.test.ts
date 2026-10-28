/**
 * MONEY-228 - prompt-library deterministic-routing contract.
 *
 * The Help Center used to send every prompt-library entry through the
 * chat classifier (`?prompt=...`). Result: any entry whose text contained
 * "portfolio" / "rebalance" / "sector" / "benchmark" rounded to the
 * same cheap `get_dashboard_stats` route - nine separate prompts in the
 * portfolio-intel category all returned the same dashboard summary.
 *
 * The fix: each PromptItem now carries an optional `tool` (preferred) or
 * `navigateTo` (when the canonical UI lives on a dedicated page). The
 * Help Center dispatches via `?tool=...&toolParams=...&userText=...` (or
 * `router.push(navigateTo)`) for these entries, bypassing the classifier
 * entirely. Free-text prompts only when the LLM is genuinely the right
 * router.
 *
 * These tests pin the highest-risk migrations so a future refactor can't
 * silently revert them and resurrect the routing-collapse bug.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prompts } from "../../app/help/lib/prompt-library";

describe("prompt-library - portfolio-intel deterministic dispatch (MONEY-228)", () => {
  const PORTFOLIO_INTEL_CONTRACT: Record<string, string> = {
    "portfolio-summary": "get_portfolio_summary",
    "portfolio-roast": "start_roast",
    // "risk-analysis" + "tax-analysis" DISABLED with the /risk and /tax
    // slash commands; their absence is asserted below.
    "portfolio-health": "portfolio_risk_analysis",
    "sector-allocation": "portfolio_risk_analysis",
    "investment-summary": "get_portfolio_summary",
  };

  it("every portfolio-intel prompt that maps to a chat tool has the tool field set", () => {
    for (const [id, expectedTool] of Object.entries(PORTFOLIO_INTEL_CONTRACT)) {
      const item = prompts.find((p) => p.id === id);
      assert.ok(item, `missing prompt-library entry: ${id}`);
      assert.equal(
        item?.tool,
        expectedTool,
        `${id} must dispatch ${expectedTool}, not fall through to the classifier`
      );
    }
  });

  it("keeps the disabled risk/tax prompt cards out of the library", () => {
    for (const id of ["risk-analysis", "tax-analysis"]) {
      assert.equal(
        prompts.find((p) => p.id === id),
        undefined,
        `${id} is disabled and must not render in the Help Center`
      );
    }
  });

  it("rebalance-suggestions navigates to /risk (no chat tool wraps the rebalance flow yet)", () => {
    const item = prompts.find((p) => p.id === "rebalance-suggestions");
    assert.ok(item);
    assert.equal(item?.navigateTo, "/risk");
    assert.equal(item?.tool, undefined);
  });

  it("portfolio-roast carries the start_roast params for the confirmation card", () => {
    const item = prompts.find((p) => p.id === "portfolio-roast");
    assert.deepEqual(item?.params, { mode: "overall", assetType: "all" });
  });

  it("sector-allocation routes to portfolio_risk_analysis without dead params", () => {
    // MONEY-295 round 2: portfolio_risk_analysis uses EmptyParams +
    // a parameterless action, so any params.focus passed here was
    // silently dropped - three portfolio-intel entries (this one,
    // portfolio-health, holdings-by-sector) rendered identical
    // generic risk cards. Removed the dead param. If focus-specific
    // renders are wanted, extend the tool's Zod schema first.
    const item = prompts.find((p) => p.id === "sector-allocation");
    assert.equal(item?.tool, "portfolio_risk_analysis");
    assert.equal(item?.params, undefined);
  });
});

describe("prompt-library - comparison portfolio-benchmark uses navigate (MONEY-228)", () => {
  it("portfolio-benchmark navigates to /dashboard (Nifty comparison renders inline there)", () => {
    const item = prompts.find((p) => p.id === "portfolio-benchmark");
    assert.ok(item);
    assert.equal(item?.navigateTo, "/dashboard");
  });
});

describe("prompt-library - stock-analysis dispatch (MONEY-228 phase 2)", () => {
  const STOCK_ANALYSIS_TOOL_CONTRACT: Array<{
    id: string;
    tool: string;
    skill?: string;
    customSkills?: string[];
    mode?: "fast" | "advanced";
  }> = [
    { id: "quick-analysis", tool: "run_research", mode: "fast" },
    { id: "deep-dive", tool: "run_research", mode: "advanced" },
    { id: "comprehensive-analysis", tool: "run_research", mode: "advanced" },
    {
      id: "dcf-valuation",
      tool: "run_research",
      mode: "advanced",
      skill: "dcf-valuation",
      customSkills: ["dcf-valuation"],
    },
    {
      id: "earnings-analysis",
      tool: "run_research",
      mode: "advanced",
      skill: "earnings-analysis",
      customSkills: ["earnings-analysis"],
    },
    {
      id: "investment-thesis",
      tool: "run_research",
      mode: "advanced",
      skill: "investment-thesis",
      customSkills: ["investment-thesis"],
    },
    {
      id: "technical-analysis",
      tool: "run_research",
      mode: "advanced",
      skill: "stock-analysis",
      customSkills: ["stock-analysis"],
    },
    { id: "should-i-buy", tool: "run_research", mode: "fast" },
    { id: "research-stock", tool: "run_research", mode: "fast" },
    {
      id: "concall-insights",
      tool: "run_research",
      mode: "advanced",
      skill: "earnings-analysis",
    },
    {
      id: "sector-analysis",
      tool: "run_research",
      mode: "advanced",
      skill: "sector-deep-dive",
    },
    { id: "financial-ratios", tool: "get_financial_data" },
  ];

  for (const expected of STOCK_ANALYSIS_TOOL_CONTRACT) {
    it(`${expected.id} dispatches ${expected.tool}`, () => {
      const item = prompts.find((p) => p.id === expected.id);
      assert.ok(item, `missing prompt-library entry: ${expected.id}`);
      assert.equal(item?.tool, expected.tool);
      if (expected.mode) {
        assert.equal(
          (item?.params as { mode?: string } | undefined)?.mode,
          expected.mode
        );
      }
      if (expected.skill) {
        assert.equal(
          (item?.params as { skill?: string } | undefined)?.skill,
          expected.skill
        );
      }
      if (expected.customSkills) {
        assert.deepEqual(
          (item?.params as { customSkills?: string[] } | undefined)
            ?.customSkills,
          expected.customSkills
        );
      }
    });
  }
});

describe("prompt-library - invariants", () => {
  it("every entry has either prompt + (tool | navigateTo) - never just an id with no dispatch field", () => {
    for (const item of prompts) {
      const hasDispatch =
        Boolean(item.tool) || Boolean(item.navigateTo) || Boolean(item.prompt);
      assert.ok(
        hasDispatch,
        `prompt ${item.id} has no dispatch field (need tool, navigateTo, or prompt)`
      );
    }
  });

  it("every entry's params are a plain object when set (no functions, no class instances)", () => {
    for (const item of prompts) {
      if (!item.params) continue;
      assert.equal(
        typeof item.params,
        "object",
        `${item.id}.params must be a plain object`
      );
      assert.ok(
        !Array.isArray(item.params),
        `${item.id}.params must not be an array`
      );
    }
  });
});
