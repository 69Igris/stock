/**
 * Chat-route research preset resolution - MONEY-219 PR-2.
 *
 * Verifies the precedence rules baked into the chat-route at
 * apps/web/app/api/chat/route.ts:
 *
 *   1. If the user has a `preset` set in prefs, the planner gets the
 *      preset's resolved skill set (defaults ∪ extras − removed).
 *   2. Otherwise, if researchStyle === "custom" and customSkills is
 *      non-empty, that array is forwarded as-is.
 *   3. The preset id itself is plumbed through so downstream tools
 *      (worker, telemetry, dynamic credits) can stamp it on the result.
 *   4. Research model defaults to RESEARCH_DEFAULT_MODEL (2.5 Pro)
 *      unless the user has explicitly chosen a different paid model
 *      in composer prefs (3.0/3.1 Pro).
 *
 * Logic is inlined from route.ts:265-321 so the test runs without
 * booting Clerk / Prisma / Pub/Sub.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveSkills,
  RESEARCH_DEFAULT_MODEL,
  type ResearchPresetId,
  type ResearchSkillId,
} from "../../../../packages/services/src/preferences/research-preferences";

interface FakePrefs {
  researchStyle?: "auto" | "quick" | "deep" | "custom";
  customSkills?: ResearchSkillId[];
  researchFocus?: string;
  preset?: ResearchPresetId;
  extraSkills?: ResearchSkillId[];
  removedSkills?: ResearchSkillId[];
}

function resolveResearchHints(
  userPrefs: FakePrefs | null,
  composerModel: string | null
): {
  preset?: ResearchPresetId;
  customSkills?: readonly ResearchSkillId[];
  researchFocus?: string;
  modelForRun: string;
} {
  let resolvedCustomSkills: readonly ResearchSkillId[] | undefined;
  let resolvedPreset: ResearchPresetId | undefined;

  if (userPrefs?.preset) {
    resolvedPreset = userPrefs.preset;
    const eff = resolveEffectiveSkills({
      preset: userPrefs.preset,
      extraSkills: userPrefs.extraSkills,
      removedSkills: userPrefs.removedSkills,
    });
    resolvedCustomSkills = eff.length > 0 ? eff : undefined;
  } else if (
    userPrefs?.researchStyle === "custom" &&
    userPrefs.customSkills &&
    userPrefs.customSkills.length > 0
  ) {
    resolvedCustomSkills = userPrefs.customSkills;
  }

  // Mirrors the model-default rule in route.ts: 2.5 Flash counts as
  // "no override" since it's the dirt-cheap default, while any paid
  // model the user explicitly picked overrides RESEARCH_DEFAULT_MODEL.
  const modelForRun =
    composerModel && composerModel !== "gemini-2.5-flash"
      ? composerModel
      : RESEARCH_DEFAULT_MODEL;

  return {
    preset: resolvedPreset,
    customSkills: resolvedCustomSkills,
    researchFocus: userPrefs?.researchFocus?.trim() || undefined,
    modelForRun,
  };
}

describe("chat-route preset precedence - MONEY-219 PR-2", () => {
  it("preset takes precedence over legacy customSkills", () => {
    const r = resolveResearchHints(
      {
        researchStyle: "custom",
        customSkills: ["dcf-valuation"], // legacy - should be ignored
        preset: "investment-thesis",
      },
      null
    );
    assert.equal(r.preset, "investment-thesis");
    // Investment Thesis preset = fundamentals-core + dcf-valuation +
    // relative-valuation + news-sentiment-catalysts
    assert.ok(r.customSkills?.includes("fundamentals-core"));
    assert.ok(r.customSkills?.includes("relative-valuation"));
    assert.equal(r.customSkills?.length, 4);
  });

  it("falls back to legacy customSkills when no preset is set", () => {
    const r = resolveResearchHints(
      {
        researchStyle: "custom",
        customSkills: ["dcf-valuation", "fundamentals-core"],
      },
      null
    );
    assert.equal(r.preset, undefined);
    assert.deepEqual(r.customSkills, ["dcf-valuation", "fundamentals-core"]);
  });

  it("returns no skills when neither preset nor custom is set", () => {
    const r = resolveResearchHints(
      {
        researchStyle: "auto",
      },
      null
    );
    assert.equal(r.preset, undefined);
    assert.equal(r.customSkills, undefined);
  });

  it("preset + extras + removals all roll into resolvedCustomSkills", () => {
    const r = resolveResearchHints(
      {
        preset: "earnings-preview",
        extraSkills: ["governance-flags"],
        removedSkills: ["news-sentiment-catalysts"],
      },
      null
    );
    assert.equal(r.preset, "earnings-preview");
    assert.ok(r.customSkills?.includes("governance-flags"));
    assert.ok(r.customSkills?.includes("earnings-deep-dive"));
    assert.ok(!r.customSkills?.includes("news-sentiment-catalysts"));
  });

  it("custom preset with no skills returns undefined customSkills", () => {
    const r = resolveResearchHints(
      {
        preset: "custom",
      },
      null
    );
    assert.equal(r.preset, "custom");
    assert.equal(r.customSkills, undefined);
  });

  it("research defaults to 2.5-pro when composer model is null", () => {
    const r = resolveResearchHints(null, null);
    assert.equal(r.modelForRun, "gemini-2.5-pro");
  });

  it("research defaults to 2.5-pro when composer model is 2.5-flash (default-equivalent)", () => {
    const r = resolveResearchHints(null, "gemini-2.5-flash");
    assert.equal(r.modelForRun, "gemini-2.5-pro");
  });

  it("research honors composer model when user explicitly chose 3-pro", () => {
    const r = resolveResearchHints(null, "gemini-3.1-pro-preview");
    assert.equal(r.modelForRun, "gemini-3.1-pro-preview");
  });

  it("research honors composer model when user explicitly chose 2.5-pro", () => {
    const r = resolveResearchHints(null, "gemini-2.5-pro");
    assert.equal(r.modelForRun, "gemini-2.5-pro");
  });
});
