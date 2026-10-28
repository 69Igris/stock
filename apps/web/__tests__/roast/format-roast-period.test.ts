/**
 * Roast - formatRoastPeriod tests
 *
 * De-shadowed: imports the REAL formatRoastPeriod from
 * components/roast/roast-detail-logic.ts — the same Indian-FY (April–March)
 * label app/roast/[id]/client.tsx renders. The pure helper was extracted out
 * of the React client file (which can't import into node:test) into the .ts
 * sibling that the client now consumes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRoastPeriod } from "../../components/roast/roast-detail-logic";

describe("formatRoastPeriod (Indian financial year)", () => {
  it("April → Q1 of next-year FY", () => {
    assert.equal(formatRoastPeriod(new Date(2026, 3, 15)), "Q1 FY27");
  });

  it("June → Q1 of next-year FY", () => {
    assert.equal(formatRoastPeriod(new Date(2026, 5, 30)), "Q1 FY27");
  });

  it("July → Q2", () => {
    assert.equal(formatRoastPeriod(new Date(2026, 6, 1)), "Q2 FY27");
  });

  it("September → Q2", () => {
    assert.equal(formatRoastPeriod(new Date(2026, 8, 30)), "Q2 FY27");
  });

  it("October → Q3", () => {
    assert.equal(formatRoastPeriod(new Date(2026, 9, 1)), "Q3 FY27");
  });

  it("December → Q3", () => {
    assert.equal(formatRoastPeriod(new Date(2026, 11, 31)), "Q3 FY27");
  });

  it("January → Q4 of current calendar year FY", () => {
    // Jan 2026 falls in FY25-26 → FY26 (last 2 chars)
    assert.equal(formatRoastPeriod(new Date(2026, 0, 15)), "Q4 FY26");
  });

  it("March → Q4 of current calendar year FY", () => {
    assert.equal(formatRoastPeriod(new Date(2026, 2, 31)), "Q4 FY26");
  });

  it("February - boundary check", () => {
    assert.equal(formatRoastPeriod(new Date(2027, 1, 1)), "Q4 FY27");
  });

  it("Q1 FY26 example matches design caption", () => {
    // Apr 14, 2025 → Q1 of FY 2025-26 → FY26
    assert.equal(formatRoastPeriod(new Date(2025, 3, 14)), "Q1 FY26");
  });
});
