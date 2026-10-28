/**
 * Calculator slug coverage - B8 (MONEY-218-followup).
 *
 * Verifies that every slug surfaced on the /calculators index resolves
 * to a CalcConfig in the [slug] dynamic route. This guards against the
 * exact regression that landed B8 in the bug queue: the index linked to
 * 15 cards, the dynamic route was never built, and every click 404'd.
 *
 * Approach: mirror both lists locally from their source files, assert
 * set-equality. If either list changes, this test fails until the new
 * slug has a config row OR the index card is removed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CALC_CONFIGS, CALC_SLUGS } from "../../app/calculators/[slug]/configs";

// Mirror of the slug arrays in apps/web/app/calculators/page.tsx.
// If a card is added to the index page, add the slug here too - the
// test will then fail until the matching CalcConfig exists.
const FINANCIAL_SLUGS = [
  "sip",
  "lumpsum",
  "step-up-sip",
  "emi",
  "fd",
  "rd",
  "nps",
  "income-tax",
];

const MUTUAL_FUND_SLUGS = [
  "mf-lumpsum",
  "mf-sip",
  "mf-step-up-sip",
  "mf-goal-sip",
  "mf-inflation-sip",
  "mf-returns-xirr",
  "mf-swp",
];

const ALL_INDEX_SLUGS = [...FINANCIAL_SLUGS, ...MUTUAL_FUND_SLUGS];

describe("/calculators slug coverage - B8", () => {
  it("every index card has a CalcConfig", () => {
    for (const slug of ALL_INDEX_SLUGS) {
      assert.ok(
        CALC_CONFIGS[slug],
        `index lists ${slug} but /calculators/${slug} has no config`
      );
    }
  });

  it("every CalcConfig is reachable from the index", () => {
    for (const slug of CALC_SLUGS) {
      assert.ok(
        ALL_INDEX_SLUGS.includes(slug),
        `config ${slug} exists but is not linked from the index`
      );
    }
  });

  it("CALC_SLUGS length matches index card count", () => {
    assert.equal(CALC_SLUGS.length, ALL_INDEX_SLUGS.length);
    assert.equal(CALC_SLUGS.length, 15);
  });

  it("every config has at least one input field OR is the XIRR custom builder", () => {
    for (const [slug, cfg] of Object.entries(CALC_CONFIGS)) {
      if (cfg.calcKey === "xirr") {
        // XIRR uses the cashflow series builder; fields[] is intentionally empty.
        assert.equal(
          cfg.fields.length,
          0,
          `XIRR ${slug} should have no fields`
        );
        continue;
      }
      assert.ok(
        cfg.fields.length > 0,
        `${slug} has zero fields and is not the XIRR builder`
      );
    }
  });

  it("every config has at least one accent result row", () => {
    for (const [slug, cfg] of Object.entries(CALC_CONFIGS)) {
      const hasAccent = cfg.results.some((r) => r.accent);
      assert.ok(
        hasAccent,
        `${slug} has no accent result row - UI hierarchy lost`
      );
    }
  });

  it("MF calculators all carry the MF badge", () => {
    for (const slug of MUTUAL_FUND_SLUGS) {
      assert.equal(CALC_CONFIGS[slug]?.badge, "MF", `${slug} missing MF badge`);
    }
  });

  it("financial calculators have no MF badge", () => {
    for (const slug of FINANCIAL_SLUGS) {
      assert.notEqual(
        CALC_CONFIGS[slug]?.badge,
        "MF",
        `${slug} should not be tagged MF`
      );
    }
  });
});
