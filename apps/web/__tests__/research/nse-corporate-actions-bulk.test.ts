/**
 * NSE BULK corporate-actions parsing — REAL source (MONEY-852).
 *
 * `fetchNSECorporateActionsBulk` omits the `symbol` filter so the
 * `corporates-corporateActions` endpoint returns EVERY equity's actions in a
 * date window; each raw row then carries its OWN ticker. This pins the bulk
 * parser (`parseBulkCorporateActions`) — it must pull the symbol from each row,
 * reuse the SAME structured ratio/type extraction as the single-symbol path, and
 * drop rows with no usable symbol (they can't be keyed for upsert). Also pins the
 * `DD-MM-YYYY` window formatter the worker builds the call from.
 *
 * No network: we assert the pure parser against the raw JSON shapes NSE emits.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseBulkCorporateActions,
  parseCorporateActions,
} from "@usemoney/research/data-sources/nse-filings-logic";
import { formatNSEDate } from "@usemoney/research/data-sources/nse-filings";

// ── formatNSEDate (DD-MM-YYYY) ───────────────────────────────────────────────

describe("formatNSEDate", () => {
  it("formats a Date as zero-padded DD-MM-YYYY (UTC)", () => {
    assert.strictEqual(
      formatNSEDate(new Date(Date.UTC(2024, 2, 5))), // 5 Mar 2024
      "05-03-2024"
    );
    assert.strictEqual(
      formatNSEDate(new Date(Date.UTC(2024, 11, 31))), // 31 Dec 2024
      "31-12-2024"
    );
  });
});

// ── parseBulkCorporateActions ────────────────────────────────────────────────

describe("parseBulkCorporateActions", () => {
  it("uses each row's OWN symbol and parses structured type/ratio per row", () => {
    const rows = parseBulkCorporateActions([
      {
        symbol: "RELIANCE",
        subject: "Face Value Split From Rs 10 To Rs 1",
        exDate: "2024-03-15",
        recDate: "2024-03-16",
      },
      {
        symbol: "TCS",
        subject: "Bonus 1:1",
        exDate: "2023-06-01",
      },
      {
        symbol: "INFY",
        subject: "Dividend - Rs 18 Per Share",
        exDate: "2024-05-30",
      },
    ]);

    assert.strictEqual(rows.length, 3);

    const reliance = rows.find((r) => r.symbol === "RELIANCE")!;
    assert.strictEqual(reliance.type, "SPLIT");
    assert.strictEqual(reliance.ratio, 10);
    assert.strictEqual(reliance.oldFaceValue, 10);
    assert.strictEqual(reliance.newFaceValue, 1);
    assert.deepStrictEqual(reliance.exDate, new Date("2024-03-15"));
    assert.deepStrictEqual(reliance.recordDate, new Date("2024-03-16"));

    const tcs = rows.find((r) => r.symbol === "TCS")!;
    assert.strictEqual(tcs.type, "BONUS");
    assert.strictEqual(tcs.ratio, 2);

    const infy = rows.find((r) => r.symbol === "INFY")!;
    assert.strictEqual(infy.type, "DIVIDEND");
    assert.strictEqual(infy.dividendPerShare, 18);
    assert.strictEqual(infy.ratio, null);
  });

  it("normalizes a .NS-suffixed / lower-cased symbol on the row", () => {
    const [a] = parseBulkCorporateActions([
      { symbol: "reliance.ns", subject: "Bonus 1:1", exDate: "2024-01-01" },
    ]);
    assert.strictEqual(a!.symbol, "RELIANCE");
  });

  it("falls back to the `comp` field when `symbol` is absent", () => {
    const [a] = parseBulkCorporateActions([
      {
        comp: "WIPRO",
        subject: "Dividend Rs 1 Per Share",
        exDate: "2024-02-02",
      },
    ]);
    assert.strictEqual(a!.symbol, "WIPRO");
  });

  it("DROPS rows that carry no usable symbol (can't be keyed)", () => {
    const rows = parseBulkCorporateActions([
      { subject: "Bonus 1:1", exDate: "2024-01-01" }, // no symbol/comp
      { symbol: "", subject: "Split 1:2", exDate: "2024-01-02" }, // empty
      { symbol: "TCS", subject: "Bonus 1:1", exDate: "2024-01-03" },
    ]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!.symbol, "TCS");
  });

  it("returns [] for a non-array / null / object response", () => {
    assert.deepStrictEqual(parseBulkCorporateActions(null), []);
    assert.deepStrictEqual(parseBulkCorporateActions("nope"), []);
    assert.deepStrictEqual(parseBulkCorporateActions({ x: 1 }), []);
    assert.deepStrictEqual(parseBulkCorporateActions([]), []);
  });

  it("matches the single-symbol parser field-for-field for the same row", () => {
    const raw = {
      symbol: "RELIANCE",
      subject: "Face Value Split From Rs 10 To Rs 1",
      exDate: "2024-03-15",
      recDate: "2024-03-16",
    };
    const [bulk] = parseBulkCorporateActions([raw]);
    const [single] = parseCorporateActions("RELIANCE", [raw]);
    // The bulk path must produce the identical structured row (the only
    // difference is where the symbol comes from).
    assert.deepStrictEqual(
      {
        symbol: bulk!.symbol,
        type: bulk!.type,
        ratio: bulk!.ratio,
        oldFaceValue: bulk!.oldFaceValue,
        newFaceValue: bulk!.newFaceValue,
        exDate: bulk!.exDate,
        recordDate: bulk!.recordDate,
        details: bulk!.details,
        actionType: bulk!.actionType,
      },
      {
        symbol: single!.symbol,
        type: single!.type,
        ratio: single!.ratio,
        oldFaceValue: single!.oldFaceValue,
        newFaceValue: single!.newFaceValue,
        exDate: single!.exDate,
        recordDate: single!.recordDate,
        details: single!.details,
        actionType: single!.actionType,
      }
    );
  });
});
