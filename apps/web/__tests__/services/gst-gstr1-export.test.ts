import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GSTR1_TABLE_6A_HEADERS } from "@usemoney/services/gst";

/**
 * GSTR-1 Table 6A CSV format pinning tests.
 *
 * These pin the EXACT columns + order the GST portal's offline utility
 * expects. Any drift (renamed column, reordered, extra spaces, capitalisation)
 * breaks portal import. This test is the contract.
 */

describe("GSTR1_TABLE_6A_HEADERS", () => {
  it("exposes exactly 10 columns in the GST-portal-mandated order", () => {
    assert.deepEqual(GSTR1_TABLE_6A_HEADERS, [
      "GSTIN of recipient",
      "Invoice No.",
      "Invoice Date",
      "Invoice Value",
      "Port Code",
      "Shipping Bill No.",
      "Shipping Bill Date",
      "GST Rate",
      "Taxable Value",
      "IGST Amount",
    ]);
  });

  it("uses 'Invoice No.' (with trailing dot) - verbatim portal text", () => {
    assert.equal(GSTR1_TABLE_6A_HEADERS[1], "Invoice No.");
  });

  it("'Invoice Date' is third column (after recipient + number)", () => {
    assert.equal(GSTR1_TABLE_6A_HEADERS[2], "Invoice Date");
  });

  it("trailing IGST Amount column ends the row - no audit/recipient name suffixes", () => {
    assert.equal(
      GSTR1_TABLE_6A_HEADERS[GSTR1_TABLE_6A_HEADERS.length - 1],
      "IGST Amount"
    );
  });
});
