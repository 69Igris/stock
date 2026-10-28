/**
 * Report Renderer Tests
 *
 * De-shadowed: imports the REAL pure exports from
 * `workers/src/lib/report-renderer-logic.ts`, which `report-renderer.ts` itself
 * calls. Importing `report-renderer.ts` directly would boot Prisma, so the pure
 * FY/dispatch logic was extracted into a sibling and is asserted here.
 *
 * Tests for:
 * - getCurrentFY: Financial year calculation (Indian FY: April-March)
 * - fyToDateRange: FY string → Date range (incl. malformed-FY guard)
 * - isValidReportType: report-type dispatch gate
 *
 * NOTE: the previous version of this file also asserted `validateReportType`,
 * `getReportFileName`, `prepareTradeData` and `prepareHoldingsData` — but NONE
 * of those exist in the source (they were fabricated "mimics what the renderer
 * does" copies that tested nothing real). They have been removed; the report
 * type gate is now covered by the REAL `isValidReportType` export instead.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getCurrentFY,
  fyToDateRange,
  isValidReportType,
  VALID_REPORT_TYPES,
} from "../../../../workers/src/lib/report-renderer-logic";

describe("ReportRenderer - getCurrentFY (real export)", () => {
  it("should return a string in YYYY-YY format", () => {
    const fy = getCurrentFY();
    assert.match(fy, /^\d{4}-\d{2}$/);
  });

  it("should compute correct FY based on current month", () => {
    const fy = getCurrentFY();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    if (month >= 4) {
      assert.equal(fy, `${year}-${String(year + 1).slice(2)}`);
    } else {
      assert.equal(fy, `${year - 1}-${String(year).slice(2)}`);
    }
  });

  it("uses April (month >= 4, 1-indexed) as the FY boundary — injectable clock", () => {
    // April 2025 → FY 2025-26 ; March 2025 → FY 2024-25
    assert.equal(getCurrentFY(new Date(2025, 3, 1)), "2025-26"); // Apr
    assert.equal(getCurrentFY(new Date(2025, 2, 31)), "2024-25"); // Mar
    assert.equal(getCurrentFY(new Date(2025, 11, 31)), "2025-26"); // Dec
    assert.equal(getCurrentFY(new Date(2026, 0, 1)), "2025-26"); // Jan
  });
});

describe("ReportRenderer - fyToDateRange (real export)", () => {
  it("should parse 2025-26 to Apr 1 2025 - Mar 31 2026", () => {
    const { startDate, endDate } = fyToDateRange("2025-26");
    assert.equal(startDate.getMonth(), 3); // April (0-indexed)
    assert.equal(startDate.getDate(), 1);
    assert.equal(startDate.getFullYear(), 2025);

    assert.equal(endDate.getMonth(), 2); // March
    assert.equal(endDate.getDate(), 31);
    assert.equal(endDate.getFullYear(), 2026);
  });

  it("should parse 2024-25 correctly", () => {
    const { startDate, endDate } = fyToDateRange("2024-25");
    assert.equal(startDate.getFullYear(), 2024);
    assert.equal(startDate.getMonth(), 3);
    assert.equal(endDate.getFullYear(), 2025);
    assert.equal(endDate.getMonth(), 2);
  });

  it("should include end of day for endDate", () => {
    const { endDate } = fyToDateRange("2025-26");
    assert.equal(endDate.getHours(), 23);
    assert.equal(endDate.getMinutes(), 59);
    assert.equal(endDate.getSeconds(), 59);
  });

  it("should include start of day for startDate", () => {
    const { startDate } = fyToDateRange("2025-26");
    assert.equal(startDate.getHours(), 0);
    assert.equal(startDate.getMinutes(), 0);
  });

  it("should return start before end", () => {
    const { startDate, endDate } = fyToDateRange("2025-26");
    assert.ok(startDate.getTime() < endDate.getTime());
  });

  it("should span approximately 365 days", () => {
    const { startDate, endDate } = fyToDateRange("2025-26");
    const daysDiff =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    assert.ok(daysDiff >= 364 && daysDiff <= 366);
  });

  it("produces VALID (not Invalid) Date objects for a well-formed FY", () => {
    const { startDate, endDate } = fyToDateRange("2025-26");
    assert.ok(!Number.isNaN(startDate.getTime()));
    assert.ok(!Number.isNaN(endDate.getTime()));
  });

  it("INVALID-DATE GUARD: throws on a malformed FY instead of yielding Invalid Date", () => {
    // parseInt("", 10) / parseInt("garbage", 10) → NaN → new Date(NaN,...) is an
    // Invalid Date, which would silently match NO trades (blank report). The
    // guard converts that into a loud error.
    for (const bad of ["", "garbage", "FY24", "-26", "abc-def"]) {
      assert.throws(
        () => fyToDateRange(bad),
        /Invalid financial year/,
        `expected "${bad}" to throw`
      );
    }
  });
});

describe("ReportRenderer - isValidReportType (real export)", () => {
  it("should accept the three real report types", () => {
    assert.ok(isValidReportType("tax"));
    assert.ok(isValidReportType("risk"));
    assert.ok(isValidReportType("portfolio_statement"));
  });

  it("should reject unknown report types", () => {
    assert.ok(!isValidReportType("unknown"));
    assert.ok(!isValidReportType(""));
    assert.ok(!isValidReportType("balance_sheet"));
  });

  it("VALID_REPORT_TYPES matches exactly the dispatch arms", () => {
    assert.deepEqual(
      [...VALID_REPORT_TYPES],
      ["tax", "risk", "portfolio_statement"]
    );
  });
});
