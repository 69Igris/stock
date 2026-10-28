/**
 * ResearchModal pure helpers (MONEY-779 / MONEY-801) — unit tests.
 *
 * These were inline, untested helpers inside the `"use client"` ResearchModal
 * component (no real test could import them without dragging React /
 * next-navigation / Clerk into node:test). Extracted into the pure sibling
 * `components/analysis/research-modal-logic.ts` that the component now imports +
 * calls; this file imports the REAL exports and drives them directly.
 *
 * `buildRunParamsExtras` / `pctToFraction` are the PRODUCER of the same
 * `assumptions` / `varConfig` object the server action's `sanitizeAgainstSchema`
 * (research-run-params-logic.ts) later validates — so a regression that lets a
 * fat-fingered WACC=5000% through the modal (instead of dropping it client-side)
 * is caught here, not just at the server fallback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  styleToMode,
  styleToPresetId,
  clampName,
  NAME_MAX_CHARS,
  pctToFraction,
  buildRunParamsExtras,
} from "@/components/analysis/research-modal-logic";

describe("styleToMode", () => {
  it("quick → fast, auto → undefined, everything else → advanced", () => {
    assert.equal(styleToMode("quick"), "fast");
    assert.equal(styleToMode("auto"), undefined);
    assert.equal(styleToMode("deep"), "advanced");
    assert.equal(styleToMode("comprehensive"), "advanced");
    assert.equal(styleToMode("advanced"), "advanced");
    assert.equal(styleToMode("custom"), "advanced");
  });
});

describe("styleToPresetId", () => {
  it("maps each fixed style to its preset and leaves auto/custom unset", () => {
    assert.equal(styleToPresetId("quick"), "quick-pulse");
    assert.equal(styleToPresetId("deep"), "investment-thesis");
    assert.equal(styleToPresetId("comprehensive"), "comprehensive");
    assert.equal(styleToPresetId("advanced"), "l4-institutional");
    // auto (planner) + custom (user-owned) must NOT reset the picker.
    assert.equal(styleToPresetId("auto"), undefined);
    assert.equal(styleToPresetId("custom"), undefined);
  });
});

describe("clampName", () => {
  it("returns '' for nullish / blank", () => {
    assert.equal(clampName(null), "");
    assert.equal(clampName(undefined), "");
    assert.equal(clampName("   "), "");
  });
  it("passes through a short name (trimmed)", () => {
    assert.equal(clampName("  TCS  "), "TCS");
  });
  it("clamps a long scheme name to NAME_MAX_CHARS + ellipsis", () => {
    const long =
      "AXIS NIFTY AAA BOND PLUS SDL APR 2026 50:50 ETF FOF - DIRECT PLAN - GROWTH OPTION";
    const out = clampName(long);
    assert.ok(out.endsWith("…"));
    // body (sans the ellipsis) never exceeds the cap.
    assert.ok(out.slice(0, -1).length <= NAME_MAX_CHARS);
    assert.ok(out.length < long.length);
  });
});

describe("pctToFraction", () => {
  const waccBounds = { min: 0, max: 1 };
  it("converts a percent string to a fraction", () => {
    assert.equal(pctToFraction("11", waccBounds), 0.11);
    assert.equal(pctToFraction("11.5", waccBounds), 0.115);
    assert.equal(pctToFraction(" 8 ", waccBounds), 0.08);
  });
  it("returns undefined for empty / non-numeric / non-finite", () => {
    assert.equal(pctToFraction("", waccBounds), undefined);
    assert.equal(pctToFraction("   ", waccBounds), undefined);
    assert.equal(pctToFraction("abc", waccBounds), undefined);
    assert.equal(pctToFraction("Infinity", waccBounds), undefined);
  });
  it("rejects out-of-bounds values (the absurd-WACC guard)", () => {
    // 5000% → fraction 50, way past wacc's max of 1 → dropped client-side.
    assert.equal(pctToFraction("5000", waccBounds), undefined);
    // negative WACC is below the 0 floor.
    assert.equal(pctToFraction("-5", waccBounds), undefined);
  });
  it("honours each field's distinct bounds", () => {
    // terminalGrowth allows -100%..100%; growthOverride up to 500%.
    assert.equal(pctToFraction("-50", { min: -1, max: 1 }), -0.5);
    assert.equal(pctToFraction("500", { min: -1, max: 5 }), 5);
    assert.equal(pctToFraction("600", { min: -1, max: 5 }), undefined);
  });
});

describe("buildRunParamsExtras", () => {
  const neutral = {
    horizon: undefined,
    benchmark: "",
    reportLength: "standard" as const,
    varConfidence: 95 as const,
    varHorizonDays: 1 as const,
    waccPct: "",
    terminalGrowthPct: "",
    growthOverridePct: "",
  };

  it("an entirely untouched run yields {} (byte-identical to today)", () => {
    assert.deepEqual(buildRunParamsExtras(neutral), {});
  });

  it("omits behaviour-neutral defaults (standard / 95% / 1d / blank benchmark)", () => {
    const out = buildRunParamsExtras({
      ...neutral,
      reportLength: "standard",
      benchmark: "   ",
      varConfidence: 95,
      varHorizonDays: 1,
    });
    assert.deepEqual(out, {});
  });

  it("forwards each explicitly-chosen value", () => {
    const out = buildRunParamsExtras({
      ...neutral,
      horizon: "3y",
      benchmark: " ^CNXIT ",
      reportLength: "full",
      varConfidence: 99,
      varHorizonDays: 10,
    });
    assert.equal(out.horizon, "3y");
    assert.equal(out.benchmark, "^CNXIT", "benchmark is trimmed");
    assert.equal(out.reportLength, "full");
    assert.deepEqual(out.varConfig, { confidence: 99, horizonDays: 10 });
  });

  it("includes only the deviating half of varConfig", () => {
    const out = buildRunParamsExtras({
      ...neutral,
      varConfidence: 99,
      varHorizonDays: 1, // default → omitted
    });
    assert.deepEqual(out.varConfig, { confidence: 99 });
  });

  it("typed assumptions are % → fraction and only the typed fields survive", () => {
    const out = buildRunParamsExtras({
      ...neutral,
      waccPct: "11",
      terminalGrowthPct: "4",
      growthOverridePct: "", // untouched → omitted
    });
    assert.deepEqual(out.assumptions, { wacc: 0.11, terminalGrowth: 0.04 });
  });

  it("DROPS an out-of-range assumption client-side but keeps in-bounds siblings", () => {
    // The producer-side guard for the same class the server sanitizer catches:
    // WACC=5000% is dropped, terminalGrowth=3% survives.
    const out = buildRunParamsExtras({
      ...neutral,
      waccPct: "5000",
      terminalGrowthPct: "3",
    });
    assert.deepEqual(out.assumptions, { terminalGrowth: 0.03 });
  });

  it("omits assumptions entirely when every typed field is out of range", () => {
    const out = buildRunParamsExtras({
      ...neutral,
      waccPct: "5000",
      terminalGrowthPct: "9999",
    });
    assert.equal(out.assumptions, undefined);
  });
});
