/**
 * MONEY-219 - research preferences v2 tests.
 *
 * Covers:
 *   - 24 v2 skill IDs registered (16 core + the L4-only risk-var-stress
 *     pack (MONEY-669) + the MONEY-793 C1b composed/promoted packs) + 6 v1
 *     aliases preserved
 *   - SKILL_ID_ALIASES expansion is correct (v1 → set of v2)
 *   - expandSkillAliases dedupes when multiple aliases share targets
 *   - 7 named presets + custom; each preset's defaultSkills are real v2 IDs
 *   - resolveEffectiveSkills(preset) = preset.defaultSkills
 *   - resolveEffectiveSkills(preset, extra) = union
 *   - resolveEffectiveSkills(preset, extra, removed) drops removed
 *   - resolveEffectiveSkills(custom-only) bypasses preset
 *   - RESEARCH_DEFAULT_MODEL is 2.5-pro per the redesign brief
 *   - Schema accepts new fields (preset, extraSkills, removedSkills) and
 *     legacy prefs without those fields still parse.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_SKILL_IDS,
  RESEARCH_PRESETS,
  RESEARCH_PRESET_DEFS,
  RESEARCH_DEFAULT_MODEL,
  SKILL_ID_ALIASES,
  expandSkillAliases,
  resolveEffectiveSkills,
  RESEARCH_SKILL_LABELS,
  RESEARCH_SKILL_DESCRIPTIONS,
  researchPreferencesSchema,
  RESEARCH_HORIZONS,
  RESEARCH_BENCHMARKS,
  RESEARCH_REPORT_LENGTHS,
  BENCHMARK_SYMBOLS,
  resolveBenchmarkSymbol,
  type ResearchSkillId,
  type ResearchPresetId,
} from "../src/preferences/research-preferences";

const V2_SKILL_IDS: ResearchSkillId[] = [
  "fundamentals-core",
  "cash-flow-quality",
  "earnings-deep-dive",
  "dcf-valuation",
  "dividend-income",
  "relative-valuation",
  "quant-factor-scores",
  "technical-trend",
  "chart-pattern-detection",
  "regime-volatility",
  "macro-sensitivities",
  "flows-and-positioning",
  "forward-scenarios",
  "risk-portfolio-impact",
  "governance-flags",
  "news-sentiment-catalysts",
  "risk-var-stress",
  // MONEY-793 (C1b): composed skills + promoted orphan packs
  "portfolio-impact-on-user",
  "catalyst-calendar",
  "theme-evaluation",
  "tax-planning",
  "mf-deep-dive",
  "global-funds",
  "forensic-accounting",
];

// L4-only additions (MONEY-669 + MONEY-793 C1b): advanced-tier skills that are
// in l4-institutional but deliberately NOT in comprehensive — "Advanced >
// Comprehensive" means L4 is a strict superset of comprehensive.
const L4_ONLY_SKILL_IDS: ResearchSkillId[] = [
  "risk-var-stress",
  "portfolio-impact-on-user",
  "catalyst-calendar",
  "theme-evaluation",
  "forensic-accounting",
];

// MONEY-793 (C1b): situational opt-in packs — registered + pickable, but NOT a
// default of ANY preset (neither comprehensive nor l4-institutional).
const SITUATIONAL_SKILL_IDS: ResearchSkillId[] = [
  "tax-planning",
  "mf-deep-dive",
  "global-funds",
];

const V1_ALIAS_IDS: ResearchSkillId[] = [
  "investment-thesis",
  "peer-comparison",
  "earnings-analysis",
  "financial-deep-dive",
  "stock-analysis",
  "macro-analysis",
];

describe("RESEARCH_SKILL_IDS - v2 schema", () => {
  it("registers exactly 30 IDs (24 v2 + 6 v1 aliases)", () => {
    // MONEY-793 (C1b) added 7 v2 skills (3 composed + 4 promoted orphan
    // packs) on top of the prior 17 v2 IDs.
    assert.equal(RESEARCH_SKILL_IDS.length, 30);
  });

  it("contains every v2 ID", () => {
    for (const id of V2_SKILL_IDS) {
      assert.ok(
        (RESEARCH_SKILL_IDS as readonly string[]).includes(id),
        `missing v2 id: ${id}`,
      );
    }
  });

  it("retains v1 alias IDs for backward compat", () => {
    for (const id of V1_ALIAS_IDS) {
      assert.ok(
        (RESEARCH_SKILL_IDS as readonly string[]).includes(id),
        `missing v1 alias: ${id}`,
      );
    }
  });

  it("every ID has a human label", () => {
    for (const id of RESEARCH_SKILL_IDS) {
      assert.ok(RESEARCH_SKILL_LABELS[id], `missing label for ${id}`);
      assert.ok(
        RESEARCH_SKILL_DESCRIPTIONS[id],
        `missing description for ${id}`,
      );
    }
  });

  it("v1 aliases are visibly labelled `(legacy)`", () => {
    for (const id of V1_ALIAS_IDS) {
      assert.match(
        RESEARCH_SKILL_LABELS[id],
        /\(legacy\)$/,
        `${id} not labelled legacy`,
      );
    }
  });
});

describe("SKILL_ID_ALIASES + expandSkillAliases", () => {
  it("expands a v1 ID to its v2 replacements", () => {
    const expanded = expandSkillAliases(["investment-thesis"]);
    assert.deepEqual(expanded.sort(), [
      "dcf-valuation",
      "fundamentals-core",
      "relative-valuation",
    ]);
  });

  it("leaves v2 IDs untouched", () => {
    const expanded = expandSkillAliases([
      "quant-factor-scores",
      "regime-volatility",
    ]);
    assert.deepEqual(expanded.sort(), [
      "quant-factor-scores",
      "regime-volatility",
    ]);
  });

  it("dedupes when v1 aliases share a v2 target", () => {
    // peer-comparison → relative-valuation; investment-thesis includes it too
    const expanded = expandSkillAliases([
      "peer-comparison",
      "investment-thesis",
    ]);
    const counts = new Map<string, number>();
    for (const id of expanded) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, c] of counts) {
      assert.equal(c, 1, `${id} appears ${c} times`);
    }
    assert.ok(expanded.includes("relative-valuation"));
  });

  it("alias map only references real v2 IDs", () => {
    for (const [v1, expansions] of Object.entries(SKILL_ID_ALIASES)) {
      assert.ok(expansions);
      for (const v2 of expansions!) {
        assert.ok(V2_SKILL_IDS.includes(v2), `alias ${v1} → ${v2} not a v2 ID`);
      }
    }
  });
});

describe("RESEARCH_PRESETS - named bundles", () => {
  it("registers exactly 9 presets (8 named + custom)", () => {
    // 8 named: quick-pulse, investment-thesis, quant-deep-dive,
    // earnings-preview, macro-sector-view, risk-audit,
    // comprehensive (2.5-pro), l4-institutional (3.0-pro)
    assert.equal(RESEARCH_PRESETS.length, 9);
  });

  it("L4 Institutional uses gemini-3.1-pro-preview and includes every v2 skill except the situational opt-ins", () => {
    const def = RESEARCH_PRESET_DEFS["l4-institutional"];
    assert.equal(def.suggestedModel, "gemini-3.1-pro-preview");
    // MONEY-793 (C1b): L4 defaults = all v2 skills EXCEPT the situational
    // opt-ins (tax-planning / mf-deep-dive / global-funds).
    assert.equal(
      def.defaultSkills.length,
      V2_SKILL_IDS.length - SITUATIONAL_SKILL_IDS.length,
    );
    for (const s of V2_SKILL_IDS) {
      if (SITUATIONAL_SKILL_IDS.includes(s)) {
        assert.ok(
          !def.defaultSkills.includes(s),
          `L4 must NOT default situational ${s}`,
        );
      } else {
        assert.ok(def.defaultSkills.includes(s), `L4 missing ${s}`);
      }
    }
    // L4 should be more expensive than Comprehensive (heavier model)
    assert.ok(
      def.baseCredits > RESEARCH_PRESET_DEFS["comprehensive"].baseCredits,
      `L4 baseCredits (${def.baseCredits}) should exceed Comprehensive`,
    );
  });

  it("every preset has a definition with the required fields", () => {
    for (const id of RESEARCH_PRESETS) {
      const def = RESEARCH_PRESET_DEFS[id];
      assert.ok(def, `missing def for ${id}`);
      assert.equal(def.id, id);
      assert.ok(def.label.length > 0);
      assert.ok(def.shortLabel.length > 0);
      assert.ok(def.description.length > 0);
      assert.ok(typeof def.suggestedModel === "string");
      assert.ok(def.baseCredits >= 1);
      assert.ok(def.estimatedTasks.min >= 0);
      assert.ok(def.estimatedTasks.max >= def.estimatedTasks.min);
    }
  });

  it("preset.defaultSkills only references v2 IDs (not v1 aliases)", () => {
    for (const id of RESEARCH_PRESETS) {
      const def = RESEARCH_PRESET_DEFS[id];
      for (const skill of def.defaultSkills) {
        assert.ok(
          V2_SKILL_IDS.includes(skill),
          `preset ${id} references v1 alias ${skill}`,
        );
      }
    }
  });

  it("comprehensive includes every v2 skill EXCEPT the L4-only + situational packs; L4 is a strict superset", () => {
    const comprehensive = RESEARCH_PRESET_DEFS["comprehensive"];
    const l4 = RESEARCH_PRESET_DEFS["l4-institutional"];
    // MONEY-793 (C1b): comprehensive = all v2 skills minus the L4-only
    // advanced packs AND minus the situational opt-ins.
    assert.equal(
      comprehensive.defaultSkills.length,
      V2_SKILL_IDS.length -
        L4_ONLY_SKILL_IDS.length -
        SITUATIONAL_SKILL_IDS.length,
    );
    for (const s of L4_ONLY_SKILL_IDS) {
      assert.ok(
        !comprehensive.defaultSkills.includes(s),
        `comprehensive must not include L4-only ${s}`,
      );
      assert.ok(l4.defaultSkills.includes(s), `L4 missing its own pack ${s}`);
    }
    for (const s of SITUATIONAL_SKILL_IDS) {
      assert.ok(
        !comprehensive.defaultSkills.includes(s),
        `comprehensive must not include situational ${s}`,
      );
      assert.ok(
        !l4.defaultSkills.includes(s),
        `L4 must not default situational ${s}`,
      );
    }
    for (const s of comprehensive.defaultSkills) {
      assert.ok(
        l4.defaultSkills.includes(s),
        `L4 must be a strict superset of comprehensive (missing ${s})`,
      );
    }
  });

  it("custom preset has no default skills", () => {
    assert.deepEqual(RESEARCH_PRESET_DEFS["custom"].defaultSkills, []);
  });

  it("non-Pulse / non-L4 presets default to 2.5-pro per the brief", () => {
    const presets: ResearchPresetId[] = [
      "investment-thesis",
      "quant-deep-dive",
      "earnings-preview",
      "macro-sector-view",
      "risk-audit",
      "comprehensive",
    ];
    for (const p of presets) {
      assert.equal(
        RESEARCH_PRESET_DEFS[p].suggestedModel,
        "gemini-2.5-pro",
        `${p} not on 2.5-pro`,
      );
    }
  });

  it("RESEARCH_DEFAULT_MODEL is 2.5-pro", () => {
    assert.equal(RESEARCH_DEFAULT_MODEL, "gemini-2.5-pro");
  });
});

describe("resolveEffectiveSkills", () => {
  it("returns preset.defaultSkills when no extras/removals", () => {
    const got = resolveEffectiveSkills({ preset: "earnings-preview" });
    assert.deepEqual(got.sort(), [
      "earnings-deep-dive",
      "news-sentiment-catalysts",
      "relative-valuation",
    ]);
  });

  it("adds extra skills on top of preset defaults", () => {
    const got = resolveEffectiveSkills({
      preset: "investment-thesis",
      extraSkills: ["governance-flags"],
    });
    assert.ok(got.includes("governance-flags"));
    assert.ok(got.includes("dcf-valuation"));
  });

  it("removes skills the user dropped from a preset", () => {
    const got = resolveEffectiveSkills({
      preset: "investment-thesis",
      removedSkills: ["news-sentiment-catalysts"],
    });
    assert.ok(!got.includes("news-sentiment-catalysts"));
    assert.ok(got.includes("dcf-valuation"));
  });

  it("custom-only mode bypasses preset entirely", () => {
    const got = resolveEffectiveSkills({
      preset: "comprehensive",
      customOnlySkills: ["technical-trend"],
    });
    assert.deepEqual(got, ["technical-trend"]);
  });

  it("handles v1 alias in extraSkills via expansion", () => {
    const got = resolveEffectiveSkills({
      preset: "quick-pulse",
      extraSkills: ["macro-analysis"],
    });
    assert.ok(got.includes("macro-sensitivities"));
    assert.ok(got.includes("flows-and-positioning"));
  });

  it("returns empty for custom preset with no overrides", () => {
    const got = resolveEffectiveSkills({ preset: "custom" });
    assert.deepEqual(got, []);
  });
});

describe("researchPreferencesSchema - backward compat", () => {
  it("accepts a legacy prefs blob without preset/extraSkills/removedSkills", () => {
    const parsed = researchPreferencesSchema.parse({
      researchStyle: "auto",
      customSkills: [],
      researchFocus: "",
    });
    assert.equal(parsed.researchStyle, "auto");
    assert.equal(parsed.preset, undefined);
  });

  it("accepts a v2 prefs blob with preset + extra + removed", () => {
    const parsed = researchPreferencesSchema.parse({
      researchStyle: "custom",
      customSkills: ["fundamentals-core"],
      researchFocus: "",
      preset: "investment-thesis",
      extraSkills: ["governance-flags"],
      removedSkills: ["relative-valuation"],
    });
    assert.equal(parsed.preset, "investment-thesis");
    assert.deepEqual(parsed.extraSkills, ["governance-flags"]);
    assert.deepEqual(parsed.removedSkills, ["relative-valuation"]);
  });

  it("rejects an unknown preset id", () => {
    const result = researchPreferencesSchema.safeParse({
      researchStyle: "auto",
      customSkills: [],
      researchFocus: "",
      preset: "not-a-preset",
    });
    assert.equal(result.success, false);
  });

  it("rejects an unknown skill id in extraSkills", () => {
    const result = researchPreferencesSchema.safeParse({
      researchStyle: "auto",
      customSkills: [],
      researchFocus: "",
      extraSkills: ["not-a-skill"],
    });
    assert.equal(result.success, false);
  });
});

// ─── MONEY-794 (C1c): institutional run-parameters ──────────────────────────

describe("researchPreferencesSchema - MONEY-794 run-parameters", () => {
  const base = { researchStyle: "auto" as const, customSkills: [] };

  it("legacy prefs without run-params parse with all run-params undefined", () => {
    const parsed = researchPreferencesSchema.parse({
      ...base,
      researchFocus: "",
    });
    assert.equal(parsed.horizon, undefined);
    assert.equal(parsed.benchmark, undefined);
    assert.equal(parsed.assumptions, undefined);
    assert.equal(parsed.reportLength, undefined);
    assert.equal(parsed.varConfig, undefined);
  });

  it("accepts every horizon enum value", () => {
    for (const h of RESEARCH_HORIZONS) {
      const parsed = researchPreferencesSchema.parse({ ...base, horizon: h });
      assert.equal(parsed.horizon, h);
    }
  });

  it("rejects an unknown horizon", () => {
    const result = researchPreferencesSchema.safeParse({
      ...base,
      horizon: "10y",
    });
    assert.equal(result.success, false);
  });

  it("accepts a known benchmark id and a free-text sector benchmark", () => {
    for (const b of RESEARCH_BENCHMARKS) {
      assert.equal(
        researchPreferencesSchema.parse({ ...base, benchmark: b }).benchmark,
        b,
      );
    }
    assert.equal(
      researchPreferencesSchema.parse({ ...base, benchmark: "Nifty IT" })
        .benchmark,
      "Nifty IT",
    );
  });

  it("rejects an empty-string benchmark", () => {
    const result = researchPreferencesSchema.safeParse({
      ...base,
      benchmark: "",
    });
    assert.equal(result.success, false);
  });

  it("accepts assumption overrides and rejects out-of-range wacc", () => {
    const parsed = researchPreferencesSchema.parse({
      ...base,
      assumptions: { wacc: 0.11, terminalGrowth: 0.04, growthOverride: 0.15 },
    });
    assert.deepEqual(parsed.assumptions, {
      wacc: 0.11,
      terminalGrowth: 0.04,
      growthOverride: 0.15,
    });
    assert.equal(
      researchPreferencesSchema.safeParse({
        ...base,
        assumptions: { wacc: 2 },
      }).success,
      false,
    );
  });

  it("accepts every reportLength and rejects unknown", () => {
    for (const r of RESEARCH_REPORT_LENGTHS) {
      assert.equal(
        researchPreferencesSchema.parse({ ...base, reportLength: r })
          .reportLength,
        r,
      );
    }
    assert.equal(
      researchPreferencesSchema.safeParse({ ...base, reportLength: "epic" })
        .success,
      false,
    );
  });

  it("accepts valid varConfig and rejects off-grid confidence/horizonDays", () => {
    const parsed = researchPreferencesSchema.parse({
      ...base,
      varConfig: { confidence: 99, horizonDays: 10 },
    });
    assert.deepEqual(parsed.varConfig, { confidence: 99, horizonDays: 10 });
    assert.equal(
      researchPreferencesSchema.safeParse({
        ...base,
        varConfig: { confidence: 90 },
      }).success,
      false,
    );
    assert.equal(
      researchPreferencesSchema.safeParse({
        ...base,
        varConfig: { horizonDays: 5 },
      }).success,
      false,
    );
  });
});

describe("resolveBenchmarkSymbol - MONEY-794", () => {
  it("maps every known benchmark id to its index symbol", () => {
    assert.equal(resolveBenchmarkSymbol("NIFTY50"), "^NSEI");
    assert.equal(resolveBenchmarkSymbol("SENSEX"), "^BSESN");
    assert.equal(resolveBenchmarkSymbol("NIFTY500"), "^CRSLDX");
    for (const b of RESEARCH_BENCHMARKS) {
      assert.equal(resolveBenchmarkSymbol(b), BENCHMARK_SYMBOLS[b]);
    }
  });

  it("defaults to ^NSEI when unset (today's hardcoded benchmark)", () => {
    assert.equal(resolveBenchmarkSymbol(), "^NSEI");
    assert.equal(resolveBenchmarkSymbol(undefined), "^NSEI");
  });

  it("passes a free-text sector benchmark through untouched", () => {
    assert.equal(resolveBenchmarkSymbol("Nifty Bank"), "Nifty Bank");
  });
});
