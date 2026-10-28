import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDodoCsv,
  getBillingPeriod,
  getFinancialYear,
  buildInvoiceStorageKey,
  GSTR1_TABLE_6A_HEADERS,
} from "@usemoney/services/gst";

/**
 * Edge-case test pack for the GST family - pins the more dangerous
 * behaviours that audit reviewers will care about. These are specifically
 * the cases that caused regressions during the deep-dive audit.
 */

describe("CSV parser - edge cases that bit during audit", () => {
  const HEADER =
    "transaction_id,payout_id,transaction_date,customer_email,customer_country,currency,gross_amount,fees_amount,net_amount";

  it("rejects rows missing trailing columns rather than producing partial rows", () => {
    const csv = `${HEADER}
txn_short,po_X,2026-04-15,a@b.com,US,USD`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 0);
    // The row falls into rowErrors with an "invalid amount field" complaint
    // because gross/fees/net are undefined.
    assert.equal(r.rowErrors.length, 1);
  });

  it("treats Windows line endings (\\r\\n) like Unix (\\n)", () => {
    const csv = `${HEADER}\r\ntxn_crlf,po_X,2026-04-15,a@b.com,US,USD,99.00,3.50,95.50\r\n`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.transactionId, "txn_crlf");
  });

  it("ignores blank lines between header and data", () => {
    const csv = `${HEADER}

txn_blank,po_X,2026-04-15,a@b.com,US,USD,99.00,3.50,95.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 1);
  });

  it("uppercases currency consistently", () => {
    const csv = `${HEADER}
txn_lc,po_X,2026-04-15,a@b.com,US,usd,10.00,0.50,9.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.currency, "USD");
  });

  it("preserves rawRow for audit even when row passes parsing", () => {
    const csv = `${HEADER}
txn_raw,po_X,2026-04-15,a@b.com,US,USD,99.00,3.50,95.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.rawRow.transaction_id, "txn_raw");
    assert.equal(r.rows[0]!.rawRow.gross_amount, "99.00");
  });
});

describe("Billing period - rare months", () => {
  it("December 31 (last day of year) lands in Dec second-half", () => {
    const { start, end } = getBillingPeriod(new Date("2026-12-31T23:59:00Z"));
    assert.equal(start.toISOString(), "2026-12-16T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-12-31T23:59:59.999Z");
  });

  it("January 1 lands in Jan first-half (NOT prior Dec)", () => {
    const { start, end } = getBillingPeriod(new Date("2027-01-01T00:01:00Z"));
    assert.equal(start.toISOString(), "2027-01-01T00:00:00.000Z");
    assert.equal(end.toISOString(), "2027-01-15T23:59:59.999Z");
  });
});

describe("Financial year derivation - boundary tests", () => {
  it("April 1 00:00:00 UTC starts new FY", () => {
    assert.equal(
      getFinancialYear(new Date("2026-04-01T00:00:00.000Z")),
      "26-27"
    );
  });

  it("March 31 23:59:59 UTC still belongs to prior FY", () => {
    assert.equal(
      getFinancialYear(new Date("2026-03-31T23:59:59.999Z")),
      "25-26"
    );
  });

  it("FY string is stable for the entire fiscal year", () => {
    assert.equal(
      getFinancialYear(new Date("2026-04-01T00:00:00Z")),
      getFinancialYear(new Date("2027-03-31T23:59:59Z"))
    );
  });
});

describe("Storage key conventions - character escaping", () => {
  it("invoice number with multiple slashes maps to underscores", () => {
    const key = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/CN/26-27/0001",
      financialYear: "26-27",
    });
    // 3 slashes in invoice number → 3 underscores in safeNumber
    assert.equal(key.match(/_/g)?.length, 4); // 3 from slashes + 0 in FY
  });

  it("FY appears as the leading path segment for grouping", () => {
    const key = buildInvoiceStorageKey({
      invoiceNumber: "UMAI/EXP/26-27/0001",
      financialYear: "26-27",
    });
    assert.equal(key.split("/")[0], "26-27");
  });
});

describe("GSTR-1 header contract", () => {
  it("'Invoice No.' uses a literal trailing dot - verbatim portal text", () => {
    assert.equal(GSTR1_TABLE_6A_HEADERS[1], "Invoice No.");
  });

  it("'Port Code' / shipping columns appear in GST-portal-mandated middle slots", () => {
    assert.equal(GSTR1_TABLE_6A_HEADERS[4], "Port Code");
    assert.equal(GSTR1_TABLE_6A_HEADERS[5], "Shipping Bill No.");
    assert.equal(GSTR1_TABLE_6A_HEADERS[6], "Shipping Bill Date");
  });

  it("Headers contain no trailing whitespace - GST portal rejects it", () => {
    for (const h of GSTR1_TABLE_6A_HEADERS) {
      assert.equal(h, h.trim());
    }
  });
});
