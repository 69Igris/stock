import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDodoCsv } from "@usemoney/services/gst";

const VALID_HEADER =
  "transaction_id,payout_id,transaction_date,customer_email,customer_country,currency,gross_amount,fees_amount,net_amount";

describe("parseDodoCsv - happy path", () => {
  it("parses a single valid row", () => {
    const csv = `${VALID_HEADER}
txn_001,po_AAA,2026-04-15,user@example.com,US,USD,99.00,3.50,95.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.headerErrors.length, 0);
    assert.equal(r.rowErrors.length, 0);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.transactionId, "txn_001");
    assert.equal(r.rows[0]!.payoutId, "po_AAA");
    assert.equal(r.rows[0]!.currency, "USD");
    assert.equal(r.rows[0]!.grossAmount, 99.0);
    assert.equal(r.rows[0]!.feesAmount, 3.5);
    assert.equal(r.rows[0]!.netAmount, 95.5);
    assert.equal(r.rows[0]!.customerCountry, "US");
  });

  it("returns a stable csvHash that is order-independent", () => {
    const a = `${VALID_HEADER}
txn_002,po_X,2026-04-10,a@b.com,GB,GBP,50.00,2.00,48.00
txn_001,po_X,2026-04-09,c@d.com,US,USD,99.00,3.50,95.50`;
    const b = `${VALID_HEADER}
txn_001,po_X,2026-04-09,c@d.com,US,USD,99.00,3.50,95.50
txn_002,po_X,2026-04-10,a@b.com,GB,GBP,50.00,2.00,48.00`;
    assert.equal(parseDodoCsv(a).csvHash, parseDodoCsv(b).csvHash);
  });

  it("handles negative net (refund) without crashing", () => {
    const csv = `${VALID_HEADER}
txn_refund,po_R,2026-04-12,a@b.com,US,USD,(99.00),0.00,(99.00)`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.grossAmount, -99);
    assert.equal(r.rows[0]!.netAmount, -99);
  });

  it("strips currency symbols and thousands separators in amounts", () => {
    const csv = `${VALID_HEADER}
txn_003,po_X,2026-04-15,a@b.com,US,USD,"$1,234.56",10.00,1224.56`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.grossAmount, 1234.56);
  });

  it("accepts DD/MM/YYYY date format", () => {
    const csv = `${VALID_HEADER}
txn_004,po_X,15/04/2026,a@b.com,US,USD,10.00,0.50,9.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 1);
    assert.equal(
      r.rows[0]!.transactionDate.toISOString(),
      "2026-04-15T00:00:00.000Z"
    );
  });

  it("handles header columns in any order, case-insensitive", () => {
    const csv = `currency,Net_Amount,Transaction_Id,Gross_Amount,Fees_Amount,Transaction_Date
USD,95.50,txn_005,99.00,3.50,2026-04-15`;
    const r = parseDodoCsv(csv);
    assert.equal(r.headerErrors.length, 0);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.transactionId, "txn_005");
  });
});

describe("parseDodoCsv - error paths", () => {
  it("reports missing required header", () => {
    const csv = `transaction_id,currency,gross_amount
txn_001,USD,99.00`;
    const r = parseDodoCsv(csv);
    assert.ok(r.headerErrors.length > 0);
    assert.match(
      r.headerErrors.join(","),
      /transaction_date|fees_amount|net_amount/
    );
    assert.equal(r.rows.length, 0);
  });

  it("rejects rows with invalid currency", () => {
    const csv = `${VALID_HEADER}
txn_006,po_X,2026-04-15,a@b.com,US,US$,10.00,0.50,9.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 0);
    assert.equal(r.rowErrors.length, 1);
    assert.match(r.rowErrors[0]!.reason, /invalid currency/);
  });

  it("rejects rows with malformed date", () => {
    const csv = `${VALID_HEADER}
txn_007,po_X,not-a-date,a@b.com,US,USD,10.00,0.50,9.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 0);
    assert.equal(r.rowErrors[0]!.reason, "invalid transaction_date");
  });

  it("rejects rows with non-numeric amount", () => {
    const csv = `${VALID_HEADER}
txn_008,po_X,2026-04-15,a@b.com,US,USD,abc,0.50,9.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.rows.length, 0);
    assert.match(r.rowErrors[0]!.reason, /invalid amount/);
  });

  it("returns empty result for empty CSV", () => {
    const r = parseDodoCsv("");
    assert.equal(r.rows.length, 0);
    assert.match(r.headerErrors[0] || "", /empty/);
  });

  it("strips UTF-8 BOM from first cell", () => {
    const csv = `﻿${VALID_HEADER}
txn_bom,po_X,2026-04-15,a@b.com,US,USD,10.00,0.50,9.50`;
    const r = parseDodoCsv(csv);
    assert.equal(r.headerErrors.length, 0);
    assert.equal(r.rows.length, 1);
  });
});
