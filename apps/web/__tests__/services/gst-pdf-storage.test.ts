import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInvoiceStorageKey } from "@usemoney/services/gst";

describe("buildInvoiceStorageKey", () => {
  it("escapes slashes in invoice numbers and prefixes with FY", () => {
    const key = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/26-27/0001",
      financialYear: "26-27",
    });
    assert.equal(key, "26-27/UMAI_EXP_26-27_0001.pdf");
  });

  it("handles credit-note format with extra path segment", () => {
    const key = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/CN/26-27/0042",
      financialYear: "26-27",
    });
    assert.equal(key, "26-27/UMAI_EXP_CN_26-27_0042.pdf");
  });

  it("preserves four-digit padding from the invoice number", () => {
    const key = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/26-27/9999",
      financialYear: "26-27",
    });
    assert.match(key, /9999\.pdf$/);
  });

  it("groups same-FY documents under a single FY prefix", () => {
    const a = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/26-27/0001",
      financialYear: "26-27",
    });
    const b = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/CN/26-27/0001",
      financialYear: "26-27",
    });
    // Both should sort under "26-27/"
    assert.ok(a.startsWith("26-27/"));
    assert.ok(b.startsWith("26-27/"));
  });

  it("separates FY archives by prefix", () => {
    const fy26 = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/26-27/0001",
      financialYear: "26-27",
    });
    const fy25 = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/25-26/0001",
      financialYear: "25-26",
    });
    assert.notEqual(fy26.split("/")[0], fy25.split("/")[0]);
  });
});
