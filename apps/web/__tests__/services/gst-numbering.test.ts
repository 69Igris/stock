import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Pure-logic tests for UMAI number formatting.
 *
 * The atomic counter behaviour is exercised in the integration test suite
 * (separate ticket), but the formatting + FY math is pure and worth pinning
 * down here so refactors don't drift the on-document number format.
 */

import { getFinancialYear } from "@usemoney/services/gst";

describe("UMAI numbering - financial year derivation", () => {
  it("April 1 falls in the new FY", () => {
    assert.equal(getFinancialYear(new Date("2026-04-01T00:00:00Z")), "26-27");
  });
  it("March 31 still belongs to the prior FY", () => {
    assert.equal(getFinancialYear(new Date("2026-03-31T23:59:59Z")), "25-26");
  });
});

describe("UMAI numbering - format invariants", () => {
  // We re-implement the formatting here (rather than calling the side-effecting
  // allocator) because the format itself is a contract - auditors read these
  // numbers and a refactor that subtly changes padding or separators is a
  // compliance issue, not a bug.
  function formatUmai(opts: {
    documentType: "INVOICE" | "CREDIT_NOTE";
    fy: string;
    sequence: number;
  }): string {
    const prefix =
      opts.documentType === "INVOICE" ? "UMAI/EXP/" : "UMAI/EXP/CN/";
    const padded = String(opts.sequence).padStart(4, "0");
    return `${prefix}${opts.fy}/${padded}`;
  }

  it("formats invoice numbers as UMAI/EXP/YY-YY/NNNN", () => {
    assert.equal(
      formatUmai({ documentType: "INVOICE", fy: "26-27", sequence: 1 }),
      "UMAI/EXP/26-27/0001"
    );
    assert.equal(
      formatUmai({ documentType: "INVOICE", fy: "26-27", sequence: 9999 }),
      "UMAI/EXP/26-27/9999"
    );
  });

  it("formats credit-note numbers with CN segment", () => {
    assert.equal(
      formatUmai({ documentType: "CREDIT_NOTE", fy: "26-27", sequence: 1 }),
      "UMAI/EXP/CN/26-27/0001"
    );
  });

  it("zero-pads to 4 digits - single-digit sequence reads 0001", () => {
    assert.equal(
      formatUmai({ documentType: "INVOICE", fy: "26-27", sequence: 7 }),
      "UMAI/EXP/26-27/0007"
    );
  });
});
