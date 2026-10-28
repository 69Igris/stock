/**
 * MONEY-779 — startResearchAction run-parameter sanitization contract.
 *
 * Out-of-range run-params (a fat-fingered WACC=50, a 99.9 VaR confidence) used
 * to flow through `startResearchAction` straight to the worker and into
 * compute_dcf / compute_var RAW (`extras` is a hint, not a contract — both the
 * chat run-path and ResearchModal forward loosely-coerced objects).
 *
 * De-shadowed (MONEY-779): this file used to re-declare a "Mirror of"
 * `sanitizeAgainstSchema` inline and assert the copy — a SHADOW test (the real
 * source fn was private to the `"use server"` research action). The logic is
 * now extracted into the pure, exported `research-run-params-logic.ts` sibling
 * that `startResearchAction` imports + calls; this test imports the REAL export
 * and drives it against the REAL server schemas
 * (researchAssumptionsSchema / researchVarConfigSchema). If a schema bound or
 * the drop-field logic changes, this contract test fails with the source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  researchAssumptionsSchema,
  researchVarConfigSchema,
} from "@usemoney/services/preferences";
import { sanitizeAgainstSchema } from "@/lib/actions/research-run-params-logic";

const cleanAssumptions = (v: Record<string, unknown> | undefined) =>
  sanitizeAgainstSchema(researchAssumptionsSchema, v);
const cleanVarConfig = (v: Record<string, unknown> | undefined) =>
  sanitizeAgainstSchema(researchVarConfigSchema, v);

describe("run-param sanitize - assumptions", () => {
  it("keeps in-bounds assumptions verbatim", () => {
    assert.deepEqual(
      cleanAssumptions({
        wacc: 0.11,
        terminalGrowth: 0.04,
        growthOverride: 0.15,
      }),
      { wacc: 0.11, terminalGrowth: 0.04, growthOverride: 0.15 }
    );
  });

  it("drops an absurd WACC (50 = 5000%) but keeps in-bounds siblings", () => {
    assert.deepEqual(cleanAssumptions({ wacc: 50, terminalGrowth: 0.03 }), {
      terminalGrowth: 0.03,
    });
  });

  it("honours a legitimate 0 override (0% is in-bounds)", () => {
    assert.deepEqual(cleanAssumptions({ wacc: 0, terminalGrowth: 0 }), {
      wacc: 0,
      terminalGrowth: 0,
    });
  });

  it("drops a terminalGrowth above its 1.0 ceiling", () => {
    assert.equal(cleanAssumptions({ terminalGrowth: 2 }), undefined);
  });

  it("allows growthOverride up to its 5.0 ceiling but drops beyond it", () => {
    assert.deepEqual(cleanAssumptions({ growthOverride: 5 }), {
      growthOverride: 5,
    });
    assert.equal(cleanAssumptions({ growthOverride: 6 }), undefined);
  });

  it("drops non-numeric / NaN fields", () => {
    assert.equal(
      cleanAssumptions({
        wacc: Number.NaN,
        terminalGrowth: "0.04" as unknown as number,
      }),
      undefined
    );
  });

  it("returns undefined for an empty / missing object", () => {
    assert.equal(cleanAssumptions({}), undefined);
    assert.equal(cleanAssumptions(undefined), undefined);
  });
});

describe("run-param sanitize - varConfig", () => {
  it("keeps valid confidence + horizonDays", () => {
    assert.deepEqual(cleanVarConfig({ confidence: 99, horizonDays: 10 }), {
      confidence: 99,
      horizonDays: 10,
    });
  });

  it("drops an off-enum confidence (97) but keeps a valid horizonDays", () => {
    assert.deepEqual(cleanVarConfig({ confidence: 97, horizonDays: 1 }), {
      horizonDays: 1,
    });
  });

  it("drops an off-enum horizonDays (5)", () => {
    assert.equal(cleanVarConfig({ horizonDays: 5 }), undefined);
  });
});
