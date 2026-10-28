import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  researchPreferencesSchema,
  RESEARCH_STYLES,
  RESEARCH_SKILL_IDS,
  RESEARCH_SKILL_LABELS,
} from "@usemoney/services/preferences";

/**
 * MONEY-219 - Research preferences schema tests.
 * Pure-validation tests; persistence path is exercised via integration suite.
 */

describe("researchPreferencesSchema - happy paths", () => {
  it("accepts the default Auto profile (no skills, no focus)", () => {
    const parsed = researchPreferencesSchema.parse({
      researchStyle: "auto",
      customSkills: [],
    });
    assert.equal(parsed.researchStyle, "auto");
    assert.equal(parsed.customSkills.length, 0);
  });

  it("accepts a Deep style with no custom skills", () => {
    const parsed = researchPreferencesSchema.parse({
      researchStyle: "deep",
      customSkills: [],
    });
    assert.equal(parsed.researchStyle, "deep");
  });

  it("accepts a Custom style with multiple skills", () => {
    const parsed = researchPreferencesSchema.parse({
      researchStyle: "custom",
      customSkills: ["dcf-valuation", "peer-comparison", "investment-thesis"],
    });
    assert.equal(parsed.customSkills.length, 3);
  });

  it("accepts a focus text under the 280-char cap", () => {
    const parsed = researchPreferencesSchema.parse({
      researchStyle: "auto",
      customSkills: [],
      researchFocus: "I care about margin expansion and AI exposure",
    });
    assert.match(parsed.researchFocus!, /margin expansion/);
  });

  it("accepts empty-string focus as 'not set'", () => {
    const parsed = researchPreferencesSchema.parse({
      researchStyle: "auto",
      customSkills: [],
      researchFocus: "",
    });
    assert.equal(parsed.researchFocus, "");
  });
});

describe("researchPreferencesSchema - rejections", () => {
  it("rejects an unknown style", () => {
    assert.throws(() =>
      researchPreferencesSchema.parse({
        researchStyle: "extreme",
        customSkills: [],
      })
    );
  });

  it("rejects an unknown skill ID", () => {
    assert.throws(() =>
      researchPreferencesSchema.parse({
        researchStyle: "custom",
        customSkills: ["technical-analysis"], // not in RESEARCH_SKILL_IDS
      })
    );
  });

  it("rejects focus text >280 characters", () => {
    const oversized = "a".repeat(281);
    assert.throws(() =>
      researchPreferencesSchema.parse({
        researchStyle: "auto",
        customSkills: [],
        researchFocus: oversized,
      })
    );
  });

  it("rejects missing customSkills (it's required, not optional)", () => {
    assert.throws(() =>
      researchPreferencesSchema.parse({
        researchStyle: "auto",
      })
    );
  });
});

describe("RESEARCH_STYLES + RESEARCH_SKILL_IDS contracts", () => {
  it("exposes the canonical styles in order (v2: 6 styles incl. comprehensive/advanced)", () => {
    // v1 originally had 4 styles (auto/quick/deep/custom). v2 expanded
    // to include comprehensive + advanced - see research-preferences.ts.
    // Test updated to match the current source-of-truth ordering.
    assert.deepEqual(RESEARCH_STYLES, [
      "auto",
      "quick",
      "deep",
      "comprehensive",
      "advanced",
      "custom",
    ]);
  });

  it("includes the v2 skill registry plus retained v1 aliases", () => {
    // v2 skill set: fundamentals-core / cash-flow-quality / earnings-
    // deep-dive / dcf-valuation / dividend-income / relative-valuation
    // / quant-factor-scores / technical-trend / chart-pattern-detection
    // / regime-volatility / macro-sensitivities / flows-and-positioning
    // / forward-scenarios / risk-portfolio-impact / governance-flags /
    // news-sentiment-catalysts. The original v1 IDs (investment-thesis,
    // peer-comparison, earnings-analysis, financial-deep-dive,
    // stock-analysis, macro-analysis) are retained as DEPRECATED
    // aliases so saved user preferences keep deserialising -
    // applyResearchPreferences expands them at runtime via
    // SKILL_ID_ALIASES.
    assert.deepEqual(
      [...RESEARCH_SKILL_IDS],
      [
        // v2 fundamentals + valuation
        "fundamentals-core",
        "cash-flow-quality",
        "earnings-deep-dive",
        "dcf-valuation",
        "dividend-income",
        "relative-valuation",
        // v2 quant / technical
        "quant-factor-scores",
        "technical-trend",
        "chart-pattern-detection",
        "regime-volatility",
        // v2 macro & flows
        "macro-sensitivities",
        "flows-and-positioning",
        // v2 forward + risk + governance + sentiment
        "forward-scenarios",
        "risk-portfolio-impact",
        // MONEY-669: L4-only VaR/stress pack
        "risk-var-stress",
        "governance-flags",
        "news-sentiment-catalysts",
        // MONEY-793 (C1b): composed skills + promoted orphan packs
        "portfolio-impact-on-user",
        "catalyst-calendar",
        "theme-evaluation",
        "tax-planning",
        "mf-deep-dive",
        "global-funds",
        "forensic-accounting",
        // v1 aliases retained for back-compat
        "investment-thesis",
        "peer-comparison",
        "earnings-analysis",
        "financial-deep-dive",
        "stock-analysis",
        "macro-analysis",
      ]
    );
  });

  it("every skill ID has a friendly label", () => {
    for (const id of RESEARCH_SKILL_IDS) {
      const label = RESEARCH_SKILL_LABELS[id];
      assert.ok(label && label.length > 0, `missing label for ${id}`);
    }
  });

  it("v1 stock-analysis alias label is marked '(legacy)' to nudge users to v2", () => {
    // The v1 `stock-analysis` ID still resolves (expands to
    // fundamentals-core + technical-trend + chart-pattern-detection via
    // SKILL_ID_ALIASES) but the UI label flags it as legacy so the
    // popover steers users to the new v2 picks.
    assert.equal(
      RESEARCH_SKILL_LABELS["stock-analysis"],
      "Technical Analysis (legacy)"
    );
  });
});
