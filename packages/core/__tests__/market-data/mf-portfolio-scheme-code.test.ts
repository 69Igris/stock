/**
 * Scheme-code lookup over `mf_portfolio_holdings` — MONEY-1294.
 *
 * AMFI splits ONE filed portfolio across up to four scheme codes (Direct and
 * Regular, each Growth and IDCW). Measured on prod 2026-09-13, 435 of the 436
 * schemes the resolver refused as "ambiguous" are exactly that shape — every
 * candidate normalises to the identical family key, so they are one fund. The
 * table now carries both the primary code and the full set, and a reader that
 * consults only the primary answers "no disclosure" for three plans of a fund
 * whose portfolio is sitting in the table.
 *
 * Two things are pinned here and neither is the function's literal shape.
 *
 * ## 1. Both arms are POSITIVE predicates
 *
 * This is the constraint MongoDB imposes and that this repo has now shipped
 * four times (MONEY-1050 / 1205 / 1234 / 1236): a `db push` creates indexes,
 * not fields, so `amfiSchemeCodes` is ABSENT on all 54,248 pre-existing rows
 * and BOTH `{f: null}` and `{f: {not: null}}` return ZERO over it. `has` asks
 * whether an array contains a value — an absent field does not — and an
 * equality test on an absent scalar likewise just fails to match. So the filter
 * composes safely over rows written before and after this ticket, and the way
 * it stops doing that is someone adding a null-shaped arm.
 *
 * Asserting the returned OBJECT LITERAL would not catch that: a change that
 * dropped an arm and updated the expected literal in the same edit passes. The
 * assertions below are properties over the returned value instead — every arm
 * must name the input code, and no arm may mention `null`, `not` or `isSet`.
 *
 * ## 2. Every scheme-code reader goes through it
 *
 * The realistic regression is not this function breaking; it is the NEXT reader
 * being written as `where: { amfiSchemeCode: code }`, which is what both of
 * these were. That is a "does this call site exist" question, which a source
 * scan can answer honestly — unlike a policy question, which it cannot.
 *
 * The two query sites that join on the HELD instrument (`stock-sections-docs`
 * and research's `market-structure-store`, both asking "which funds hold
 * RELIANCE") are untouched and out of scope: they never name a scheme code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { schemeCodeWhere } from "../../src/market-data/mf-portfolio-section-logic";

// CWD is packages/core (the package's test script runs from there), so one
// level up is `packages/`.
const PACKAGES = "..";

describe("schemeCodeWhere — MONEY-1294 plan variants", () => {
  it("offers an arm for the primary code and an arm for the variant set", () => {
    const where = schemeCodeWhere("120503");
    assert.equal(where.OR.length, 2, "both arms must be present");

    // Reached through the arms rather than by index, so a reordering is not a
    // failure but a missing capability is.
    const arms = where.OR as readonly Record<string, unknown>[];
    const scalar = arms.filter((a) => a.amfiSchemeCode === "120503");
    const array = arms.filter(
      (a) =>
        typeof a.amfiSchemeCodes === "object" &&
        a.amfiSchemeCodes !== null &&
        (a.amfiSchemeCodes as { has?: unknown }).has === "120503",
    );
    assert.equal(scalar.length, 1, "the primary-code arm must be present");
    assert.equal(array.length, 1, "the plan-variant arm must be present");
  });

  it("names the code it was given, in every arm", () => {
    for (const code of ["120503", "119551", "0"]) {
      const rendered = JSON.stringify(schemeCodeWhere(code));
      const occurrences = rendered.split(`"${code}"`).length - 1;
      assert.equal(
        occurrences,
        2,
        `both arms must filter on ${code}; rendered ${rendered}`,
      );
    }
  });

  it("uses no null-shaped predicate, in either direction", () => {
    const rendered = JSON.stringify(schemeCodeWhere("120503"));
    for (const forbidden of ["null", '"not"', '"isSet"', '"isEmpty"']) {
      assert.ok(
        !rendered.includes(forbidden),
        `a MongoDB absent field matches neither ${forbidden} nor its negation ` +
          `(MONEY-1050 / 1205 / 1234 / 1236); rendered ${rendered}`,
      );
    }
  });
});

describe("every scheme-code reader routes through schemeCodeWhere", () => {
  // Both files read `mf_portfolio_holdings` by AMFI scheme code and both were
  // written as a bare equality before this ticket.
  const READERS = [
    join(PACKAGES, "services", "src", "fund-composition.service.ts"),
    join(PACKAGES, "services", "src", "mf-portfolio-section.service.ts"),
  ];

  for (const file of READERS) {
    it(`${file} filters through the shared builder`, () => {
      const src = readFileSync(file, "utf8");
      assert.ok(
        src.includes("schemeCodeWhere("),
        `${file} must build its scheme-code filter with schemeCodeWhere`,
      );

      // A bare `amfiSchemeCode:` is legitimate inside a Prisma `select`, which
      // is how both files still read the column back. It is a defect in a
      // `where`. Strip the select blocks, then look.
      const withoutSelects = src.replace(/select:\s*\{[^}]*\}/g, "select: { }");
      const bare = withoutSelects.match(/\bwhere:\s*\{[^}]*amfiSchemeCode\b/g);
      assert.equal(
        bare,
        null,
        `${file} filters on amfiSchemeCode directly, so it cannot see a ` +
          `fund's other plan variants: ${JSON.stringify(bare)}`,
      );
    });
  }
});
