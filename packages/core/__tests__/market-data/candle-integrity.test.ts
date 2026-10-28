/**
 * UNIT TEST — OHLC invariants (MONEY-1175 step 3).
 *
 * Fixtures are REAL rows from the prod census, not invented shapes:
 *   BANSTEA  2026-03-30  o=h=l=16.5      c=14.97   (Yahoo degenerate bar)
 *   ACC      1995-10-05  o=3338.35 h=3450 l=3341   (NSE OPEN == PREVCLOSE)
 *   BHEL     1995-10-05  o=106.45 h=l=c=105.05     (same, open ABOVE the range)
 *   CITIUS…  2026-04-29  o=0                        (Yahoo non-positive)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCandle,
  isDrawableCandle,
  repairCandle,
  widenCandleRange,
  clampCandleOpen,
} from "../../src/market-data/candle-integrity";

describe("classifyCandle", () => {
  it("accepts a normal candle", () => {
    assert.equal(
      classifyCandle({ open: 100, high: 110, low: 95, close: 105 }),
      "OK",
    );
  });

  it("accepts a genuine single-price day (o==h==l==c)", () => {
    // An illiquid stock that printed once. Legitimate — must NOT be flagged,
    // or the guard would reject thousands of real BSE small-cap bars.
    assert.equal(
      classifyCandle({ open: 50, high: 50, low: 50, close: 50 }),
      "OK",
    );
  });

  it("flags Yahoo's degenerate bar (BANSTEA 2026-03-30)", () => {
    assert.equal(
      classifyCandle({ open: 16.5, high: 16.5, low: 16.5, close: 14.97 }),
      "DEGENERATE_FLAT",
    );
  });

  it("flags NSE's 1995 prev-close-as-open, below the range (ACC)", () => {
    assert.equal(
      classifyCandle({ open: 3338.35, high: 3450, low: 3341, close: 3386.55 }),
      "OPEN_OUT",
    );
  });

  it("flags NSE's 1995 prev-close-as-open, above the range (BHEL)", () => {
    assert.equal(
      classifyCandle({
        open: 106.45,
        high: 105.05,
        low: 105.05,
        close: 105.05,
      }),
      "OPEN_OUT",
    );
  });

  it("flags a zero price ahead of every other defect", () => {
    assert.equal(
      classifyCandle({ open: 0, high: 107.13, low: 104.5, close: 106.19 }),
      "NON_POSITIVE",
    );
  });

  it("flags NaN and Infinity as non-positive", () => {
    assert.equal(
      classifyCandle({ open: NaN, high: 10, low: 5, close: 7 }),
      "NON_POSITIVE",
    );
    assert.equal(
      classifyCandle({ open: Infinity, high: 10, low: 5, close: 7 }),
      "NON_POSITIVE",
    );
  });

  it("flags transposed low/high", () => {
    assert.equal(
      classifyCandle({ open: 100, high: 95, low: 110, close: 100 }),
      "LOW_GT_HIGH",
    );
  });

  it("flags a close outside the range", () => {
    assert.equal(
      classifyCandle({ open: 100, high: 104, low: 96, close: 95.75 }),
      "CLOSE_OUT",
    );
  });
});

describe("widenCandleRange — for under-reported ranges (Yahoo)", () => {
  it("rescues the degenerate bar without inventing a price", () => {
    const out = widenCandleRange({
      open: 16.5,
      high: 16.5,
      low: 16.5,
      close: 14.97,
    })!;
    assert.deepEqual(out, { open: 16.5, high: 16.5, low: 14.97, close: 14.97 });
    assert.ok(isDrawableCandle(out));
    // Every bound is a price that appeared in the input.
    for (const v of [out.high, out.low]) {
      assert.ok([16.5, 14.97].includes(v), `${v} was not an observed price`);
    }
  });

  it("leaves an already-valid candle untouched", () => {
    const input = { open: 100, high: 110, low: 95, close: 105 };
    assert.deepEqual(widenCandleRange(input), input);
  });

  it("refuses to rescue a non-positive bar", () => {
    assert.equal(
      widenCandleRange({ open: 0, high: 107.13, low: 104.5, close: 106.19 }),
      null,
    );
  });

  it("repairs transposed low/high as a side effect", () => {
    const out = widenCandleRange({
      open: 100,
      high: 95,
      low: 110,
      close: 100,
    })!;
    assert.ok(isDrawableCandle(out));
    assert.equal(out.low, 95);
    assert.equal(out.high, 110);
  });
});

describe("clampCandleOpen — for a known-bogus open (NSE 1995-96)", () => {
  it("pulls ACC's open UP to the low", () => {
    const out = clampCandleOpen({
      open: 3338.35,
      high: 3450,
      low: 3341,
      close: 3386.55,
    })!;
    assert.equal(out.open, 3341, "snaps to the nearest real traded price");
    assert.equal(out.high, 3450);
    assert.equal(out.low, 3341);
    assert.equal(out.close, 3386.55);
    assert.ok(isDrawableCandle(out));
  });

  it("pulls BHEL's open DOWN to the high", () => {
    const out = clampCandleOpen({
      open: 106.45,
      high: 105.05,
      low: 105.05,
      close: 105.05,
    })!;
    assert.equal(out.open, 105.05);
    assert.ok(isDrawableCandle(out));
  });

  it("does NOT widen the range — the bogus open must not become a real price", () => {
    // This is the whole difference from widenCandleRange. NSE's 106.45 was
    // yesterday's close; asserting a trade at it today would be fabrication.
    const out = clampCandleOpen({
      open: 106.45,
      high: 105.05,
      low: 105.05,
      close: 105.05,
    })!;
    assert.notEqual(out.high, 106.45);
  });

  it("leaves an already-valid candle untouched", () => {
    const input = { open: 100, high: 110, low: 95, close: 105 };
    assert.deepEqual(clampCandleOpen(input), input);
  });

  it("refuses when there is no usable range to clamp into", () => {
    // Transposed bounds: nothing trustworthy to clamp against.
    assert.equal(
      clampCandleOpen({ open: 100, high: 95, low: 110, close: 100 }),
      null,
    );
    // A bad close disqualifies the repair even though open is fine.
    assert.equal(
      clampCandleOpen({ open: 100, high: 110, low: 95, close: 0 }),
      null,
    );
  });

  it("rebuilds a ZERO open from the range (CITIUSINVT 2026-04-29)", () => {
    // `open` is the field being replaced, so its own value must not disqualify
    // the repair. Left alone, a 0 open draws a bar stretching down to the axis.
    const out = clampCandleOpen({
      open: 0,
      high: 107.13,
      low: 104.5,
      close: 106.19,
    })!;
    assert.equal(out.open, 104.5);
    assert.ok(isDrawableCandle(out));
  });

  it("rebuilds a NaN open", () => {
    const out = clampCandleOpen({ open: NaN, high: 110, low: 95, close: 105 })!;
    assert.equal(out.open, 95);
    assert.ok(isDrawableCandle(out));
  });

  it("also absorbs a close that sits just outside the range", () => {
    const out = clampCandleOpen({
      open: 100,
      high: 104,
      low: 96,
      close: 95.75,
    })!;
    assert.ok(isDrawableCandle(out));
    assert.equal(out.close, 95.75, "the close is authoritative, keep it");
    assert.equal(out.low, 95.75);
  });
});

describe("repairCandle — the shared dispatch", () => {
  // This function is the ONLY thing standing between the ingest path and the
  // backfill migration diverging. If they picked repairs independently, every
  // re-parse would silently undo the migration and the defect would oscillate.
  it("routes a bogus open to the clamp, not the widen", () => {
    const out = repairCandle({
      open: 106.45,
      high: 105.05,
      low: 105.05,
      close: 105.05,
    })!;
    assert.equal(out.open, 105.05);
    assert.notEqual(out.high, 106.45, "must NOT widen to yesterday's close");
  });

  it("routes an under-reported range to the widen, not the clamp", () => {
    const out = repairCandle({
      open: 16.5,
      high: 16.5,
      low: 16.5,
      close: 14.97,
    })!;
    assert.equal(out.low, 14.97, "must widen to include the real close");
    assert.equal(out.open, 16.5, "the open here is real — do not move it");
  });

  it("returns an already-valid candle unchanged (identity, not a copy-repair)", () => {
    const input = { open: 100, high: 110, low: 95, close: 105 };
    assert.equal(repairCandle(input), input);
  });

  it("is idempotent — repairing a repaired candle is a no-op", () => {
    // The migration and the parser both run repeatedly over the same rows.
    for (const bad of [
      { open: 16.5, high: 16.5, low: 16.5, close: 14.97 },
      { open: 3338.35, high: 3450, low: 3341, close: 3386.55 },
      { open: 0, high: 107.13, low: 104.5, close: 106.19 },
      { open: 100, high: 95, low: 110, close: 100 },
    ]) {
      const once = repairCandle(bad)!;
      assert.ok(isDrawableCandle(once), `not drawable: ${JSON.stringify(bad)}`);
      assert.deepEqual(
        repairCandle(once),
        once,
        "second pass must not move it",
      );
    }
  });

  it("collapses a close-only row to a flat bar (o=h=l=0, c=64.4)", () => {
    // 197 real prod rows, oldest 1999. No range exists to rebuild from, so the
    // honest representation is "one known price" — the same shape udf/history
    // already synthesizes for mutual-fund NAVs. Left alone, the zero open draws
    // a bar down to the axis.
    const out = repairCandle({ open: 0, high: 0, low: 0, close: 64.4 })!;
    assert.deepEqual(out, { open: 64.4, high: 64.4, low: 64.4, close: 64.4 });
    assert.ok(isDrawableCandle(out));
  });

  it("returns null when even the close is unusable", () => {
    assert.equal(repairCandle({ open: 5, high: 0, low: 0, close: 0 }), null);
    assert.equal(repairCandle({ open: 5, high: 0, low: 0, close: NaN }), null);
  });

  it("the close-only collapse is still idempotent", () => {
    const once = repairCandle({ open: 0, high: 0, low: 0, close: 64.4 })!;
    assert.deepEqual(repairCandle(once), once);
  });
});

describe("clampCandleOpen extra", () => {
  it("keeps the authoritative close when absorbing it into the range", () => {
    const out = clampCandleOpen({
      open: 100,
      high: 104,
      low: 96,
      close: 95.75,
    })!;
    assert.ok(isDrawableCandle(out));
    assert.equal(out.close, 95.75, "the close is authoritative, keep it");
    assert.equal(out.low, 95.75);
  });
});
