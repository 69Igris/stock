/**
 * Corporate-actions createMany payload builder (MONEY-806) — pure unit tests.
 *
 * Imports the REAL `buildCorporateActionCreateManyPayload` / `safeWriteDate`
 * from lib/actions/stock-tabs-logic.ts (the exact helper `warmCorporateActions`
 * calls). No Prisma, no network — the warm-up's risky bit (bound rows, guard
 * Dates, collapse in-payload duplicates on the `@@unique` tuple) is asserted
 * directly so the single `createMany({ skipDuplicates: true })` write is safe.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCorporateActionCreateManyPayload,
  safeWriteDate,
  CORP_ACTIONS_WARMUP_MAX_ROWS,
  type ParsedCorporateAction,
} from "../../lib/actions/stock-tabs-logic";

/** A parsed NSE row, as `fetchNSECorporateActions` returns it (MONEY-1535). */
function rec(over: Partial<ParsedCorporateAction> = {}): ParsedCorporateAction {
  return {
    symbol: "TCS",
    type: "DIVIDEND",
    exDate: new Date("2026-03-10T00:00:00Z"),
    recordDate: new Date("2026-03-12T00:00:00Z"),
    details: "Dividend - Rs 24 Per Share",
    ratio: null,
    oldFaceValue: null,
    newFaceValue: null,
    dividendPerShare: 24,
    ...over,
  };
}

describe("safeWriteDate", () => {
  it("passes through a valid Date", () => {
    const d = new Date("2026-03-10T00:00:00Z");
    assert.equal(safeWriteDate(d), d);
  });

  it("coerces an Invalid Date to null (no RangeError on serialise)", () => {
    assert.equal(safeWriteDate(new Date("garbage")), null);
  });

  it("coerces null / undefined to null", () => {
    assert.equal(safeWriteDate(null), null);
    assert.equal(safeWriteDate(undefined), null);
  });
});

describe("buildCorporateActionCreateManyPayload", () => {
  it("maps a parsed row to main's CorporateAction shape (type + dividendPerShare)", () => {
    const out = buildCorporateActionCreateManyPayload([rec()], "NSE", "inst-1");
    assert.equal(out.length, 1);
    const row = out[0]!;
    assert.equal(row.symbol, "TCS");
    assert.equal(row.exchange, "NSE");
    assert.equal(row.type, "DIVIDEND"); // main's `type`, not `actionType`
    assert.ok(row.exDate instanceof Date);
    assert.equal(row.dividendPerShare, 24);
    assert.equal(row.ratio, null);
    assert.equal(row.source, "NSE");
  });

  it("never carries the (removed) instrumentId column", () => {
    const out = buildCorporateActionCreateManyPayload([rec()], "NSE", "inst-1");
    assert.equal("instrumentId" in out[0]!, false);
  });

  // MONEY-1535 — carried, never re-derived. The end-to-end case that drives
  // the REAL parser ("Bonus 1:1" -> 2, "From Rs 10 To Rs 2" -> 5) lives in
  // stock-tabs-corpactions.test.ts; this pins that the builder moves all four
  // of the parser's numbers into their own columns.
  it("carries the parser's post:pre ratio and face values into their columns", () => {
    const split = rec({
      type: "SPLIT",
      details:
        "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share",
      ratio: 5,
      oldFaceValue: 10,
      newFaceValue: 2,
      dividendPerShare: null,
      exDate: new Date("2026-02-01"),
    });
    const [row] = buildCorporateActionCreateManyPayload([split], "NSE", null);
    assert.equal(row!.type, "SPLIT");
    assert.equal(row!.ratio, 5);
    assert.equal(row!.oldFaceValue, 10);
    assert.equal(row!.newFaceValue, 2);
    assert.equal(row!.dividendPerShare, null);
  });

  it("collapses in-payload duplicates on (symbol, exchange, type, exDate)", () => {
    const dupA = rec({ details: "first", dividendPerShare: 24 });
    const dupB = rec({ details: "second", dividendPerShare: 25 });
    const other = rec({
      type: "BONUS",
      details: "Bonus 1:1",
      exDate: new Date("2026-04-01"),
    });
    const out = buildCorporateActionCreateManyPayload(
      [dupA, dupB, other],
      "NSE",
      null
    );
    assert.equal(out.length, 2, "the duplicate tuple is collapsed");
    assert.equal(out[0]!.details, "first", "first row wins");
    assert.equal(out[1]!.type, "BONUS");
  });

  it("DROPS a null-exDate row (main's schema requires exDate)", () => {
    const dated = rec({ exDate: new Date("2026-03-10T00:00:00Z") });
    const undated = rec({ exDate: null });
    const out = buildCorporateActionCreateManyPayload(
      [dated, undated],
      "NSE",
      null
    );
    assert.equal(out.length, 1, "only the dated row survives");
    assert.ok(out[0]!.exDate instanceof Date);
  });

  it("DROPS an Invalid-Date row entirely (never persists a dateless/invalid row)", () => {
    const bad = rec({
      exDate: new Date("not-a-date"),
      recordDate: new Date("also-bad"),
    });
    const out = buildCorporateActionCreateManyPayload([bad], "NSE", null);
    assert.equal(out.length, 0, "Invalid exDate → row dropped");
  });

  it("nulls a non-finite value (NaN / Infinity) on its column", () => {
    const nan = rec({ exDate: new Date("2026-01-01"), dividendPerShare: NaN });
    const inf = rec({
      type: "BONUS",
      exDate: new Date("2026-02-01"),
      ratio: Infinity,
    });
    const out = buildCorporateActionCreateManyPayload([nan, inf], "NSE", null);
    assert.equal(out[0]!.dividendPerShare, null); // DIVIDEND row
    assert.equal(out[1]!.ratio, null); // BONUS row
  });

  it("bounds the number of rows to the cap (newest-first head kept)", () => {
    const many: ParsedCorporateAction[] = [];
    for (let i = 0; i < CORP_ACTIONS_WARMUP_MAX_ROWS + 25; i++) {
      // Distinct exDate per row so none collapse — purely exercising the cap.
      many.push(
        rec({
          exDate: new Date(2026, 0, 1 + i),
          details: `row ${i}`,
        })
      );
    }
    const out = buildCorporateActionCreateManyPayload(many, "NSE", null);
    assert.equal(out.length, CORP_ACTIONS_WARMUP_MAX_ROWS);
    assert.equal(out[0]!.details, "row 0", "kept the head (newest first)");
  });

  it("returns [] for an empty input", () => {
    assert.deepEqual(
      buildCorporateActionCreateManyPayload([], "NSE", "inst-1"),
      []
    );
  });
});
