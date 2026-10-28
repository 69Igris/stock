/**
 * The US transaction-cost model's arithmetic — MONEY-1373.
 *
 * A cost model is the one thing in this branch whose output nobody can eyeball:
 * "1.9998 bps" is either right or wrong and looks identical either way, and a
 * backtest will quietly charge every trade with it. So the spreads below are
 * computed BY HAND in the comments and asserted to three decimal places.
 *
 * The rejections matter as much as the arithmetic. A crossed book yields a
 * NEGATIVE spread, which pulls a median down and makes an illiquid name look
 * cheap to trade — the direction that turns a losing strategy into a winning
 * backtest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RESERVOIR_SIZE,
  Reservoir,
  SeededRandom,
  assignTiers,
  cellKey,
  effectiveSpreadBps,
  newCell,
  percentile,
  quoteSample,
  seedForCell,
  shouldRebuildCostModel,
  summarizeCell,
  todBucketFor,
} from "../../../src/market-data/databento/databento-cost-model-logic";
import { usMarketDayBoundsUtc } from "../../../src/market-data/us-market-hours";

/**
 * An ET wall-clock instant, built from ET MIDNIGHT of that date.
 *
 * `usMarketDayBoundsUtc(dateKey).startMs` is ET midnight as a UTC instant, so
 * adding minutes to it lands on the ET wall clock in both DST regimes. A
 * hand-written `hh + 5` offset both hard-codes EST and overflows past hour 23
 * for anything after 19:00 — which is how the first version of this helper
 * produced Invalid Dates for the whole POST bucket.
 */
function et(dateKey: string, hh: number, mm: number): Date {
  return new Date(
    usMarketDayBoundsUtc(dateKey).startMs + (hh * 60 + mm) * 60_000,
  );
}

/* ─────────────────────────────────────────────────────────────────────── */

describe("the spread, computed by hand", () => {
  it("bid 100.00 / ask 100.02 is 1.9998 bps", () => {
    // mid = 100.01; (100.02 - 100.00) / 100.01 * 1e4 = 0.02 / 100.01 * 1e4
    //     = 1.99980002 bps
    const s = quoteSample(100.0, 100.02, 500, 700);
    assert.ok(!("rejected" in s));
    assert.equal(s.spreadBps.toFixed(4), "1.9998");
    assert.equal(s.spreadBps.toFixed(3), "2.000");
  });

  it("a penny on a $10 stock is ten times a penny on a $100 stock", () => {
    // The whole reason the unit is basis points and not cents.
    const cheap = quoteSample(9.995, 10.005, 1, 1);
    const dear = quoteSample(99.995, 100.005, 1, 1);
    assert.ok(!("rejected" in cheap) && !("rejected" in dear));
    assert.equal(cheap.spreadBps.toFixed(4), "10.0000");
    assert.equal(dear.spreadBps.toFixed(4), "1.0000");
  });

  it("quoted size is the average of the two sides", () => {
    const s = quoteSample(100.0, 100.02, 500, 700);
    assert.ok(!("rejected" in s));
    assert.equal(s.quotedSizeShares, 600);
  });
});

describe("unusable quotes are rejected BY REASON", () => {
  it("an empty side is `empty`, not a zero spread", () => {
    assert.deepEqual(quoteSample(NaN, 100.02, 1, 1), { rejected: "empty" });
    assert.deepEqual(quoteSample(100.0, NaN, 1, 1), { rejected: "empty" });
  });

  it("a non-positive price is `nonpositive`", () => {
    assert.deepEqual(quoteSample(0, 100.02, 1, 1), { rejected: "nonpositive" });
    assert.deepEqual(quoteSample(-1, 100.02, 1, 1), {
      rejected: "nonpositive",
    });
  });

  it("a CROSSED book is refused, not recorded as a negative spread", () => {
    // ask < bid. The arithmetic would give -1.9998 bps, which pulls a median
    // down and makes the name look cheaper to trade than it is.
    assert.deepEqual(quoteSample(100.02, 100.0, 1, 1), { rejected: "crossed" });
  });

  it("a LOCKED book is refused too — zero is the same lie, politely", () => {
    // ask === bid. A zero-spread sample says this listing is free to trade.
    assert.deepEqual(quoteSample(100.0, 100.0, 1, 1), { rejected: "crossed" });
  });

  it("a missing SIZE does not reject the quote", () => {
    // The spread is the primary statistic; the size is a bonus. Rejecting the
    // whole quote for a missing size would throw away the number that matters.
    const s = quoteSample(100.0, 100.02, NaN, NaN);
    assert.ok(!("rejected" in s));
    assert.equal(s.spreadBps.toFixed(4), "1.9998");
    assert.ok(Number.isNaN(s.quotedSizeShares));
  });
});

describe("the effective spread", () => {
  it("a trade AT THE ASK equals the quoted spread", () => {
    // The property that makes the two comparable in one row: 2 * |ask - mid|
    // is exactly (ask - bid).
    const quoted = quoteSample(100.0, 100.02, 1, 1);
    assert.ok(!("rejected" in quoted));
    const eff = effectiveSpreadBps(100.02, 100.0, 100.02);
    assert.equal(eff?.toFixed(6), quoted.spreadBps.toFixed(6));
  });

  it("a trade AT THE MID is zero — price improvement", () => {
    // `toFixed`, not `=== 0`: (100.0 + 100.02) / 2 is 100.01000000000001 in
    // IEEE 754, so the exact comparison fails on arithmetic that is correct.
    const eff = effectiveSpreadBps(100.01, 100.0, 100.02);
    assert.ok(eff !== null);
    assert.equal(eff.toFixed(6), "0.000000");
  });

  it("a trade OUTSIDE the quote exceeds the quoted spread", () => {
    const eff = effectiveSpreadBps(100.04, 100.0, 100.02);
    assert.ok(eff !== null && eff > 1.9998);
  });

  it("a crossed book yields null, not a number", () => {
    assert.equal(effectiveSpreadBps(100.0, 100.02, 100.0), null);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("percentiles are NEAREST RANK, never interpolated", () => {
  it("returns a value that actually occurred", () => {
    // On a tick-constrained book the spread really is 1 cent or 2 cents and
    // nothing between. Interpolation would invent a "1.5 cent" median that
    // nobody could have traded at.
    const values = [1, 1, 1, 2, 2];
    assert.equal(percentile(values, 0.5), 1);
    assert.equal(percentile(values, 0.75), 2);
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      assert.ok(
        values.includes(percentile(values, p)),
        `p${p} invented a value`,
      );
    }
  });

  it("handles the ends", () => {
    const values = [5, 1, 3, 2, 4];
    assert.equal(percentile(values, 0), 1);
    assert.equal(percentile(values, 1), 5);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    assert.deepEqual(values, [3, 1, 2]);
  });

  it("an empty set is NaN, not 0", () => {
    // Zero is a spread. NaN is "no estimate", which is the true answer.
    assert.ok(Number.isNaN(percentile([], 0.5)));
  });

  it("refuses a p outside [0,1]", () => {
    assert.throws(() => percentile([1, 2], 1.5), RangeError);
    assert.throws(() => percentile([1, 2], -0.1), RangeError);
  });
});

describe("the reservoir", () => {
  it("is EXACT below capacity", () => {
    const r = new Reservoir(1, 16);
    for (let i = 1; i <= 10; i++) r.add(i);
    assert.equal(r.count, 10);
    assert.deepEqual(
      [...r.values].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.equal(percentile(r.values, 0.5), 5);
  });

  it("COUNT keeps growing after the reservoir fills", () => {
    // `count` is the sampleCount the row reports. Using values.length instead
    // would cap every busy cell at the capacity and make a cell built from
    // four quotes indistinguishable from one built from forty thousand.
    const r = new Reservoir(7, 8);
    for (let i = 0; i < 1000; i++) r.add(i);
    assert.equal(r.values.length, 8);
    assert.equal(r.count, 1000);
  });

  it("is DETERMINISTIC — two builds of one input agree", () => {
    // A model that changed on re-run would make a backtest unreproducible in
    // exactly the way version-pinning exists to prevent.
    const build = () => {
      const r = new Reservoir(seedForCell("AAPL:NASDAQ:1980-12-12|MID"), 32);
      for (let i = 0; i < 5000; i++) r.add(i);
      return [...r.values];
    };
    assert.deepEqual(build(), build());
  });

  it("actually SAMPLES the tail, not just the head", () => {
    // A broken reservoir keeps its first N and looks perfectly deterministic.
    const r = new Reservoir(seedForCell("X|MID"), 32);
    for (let i = 0; i < 5000; i++) r.add(i);
    assert.ok(
      r.values.some((v) => v > 1000),
      `the reservoir kept only early values: ${r.values.join(",")}`,
    );
  });

  it("drops non-finite values without counting them", () => {
    const r = new Reservoir(1, 8);
    r.add(NaN);
    r.add(Infinity);
    r.add(1);
    assert.equal(r.count, 1);
  });

  it("a zero seed does not freeze the generator", () => {
    // Zero is a fixed point of xorshift: it produces zero forever, which would
    // make one cell keep only its first N samples while every other cell
    // sampled properly.
    const rng = new SeededRandom(0);
    const draws = new Set([rng.next(1000), rng.next(1000), rng.next(1000)]);
    assert.ok(draws.size > 1, "a zero seed produced a constant stream");
  });

  it("the default capacity is 4,096", () => {
    assert.equal(RESERVOIR_SIZE, 4_096);
    assert.equal(new Reservoir(1).capacity, 4_096);
  });
});

describe("a cell's three reservoirs are independently seeded", () => {
  it("spread, size and effective do not share a sub-sample", () => {
    // Sharing a seed would keep exactly the same records in all three, so a
    // cell's statistics would be drawn from one sub-sample rather than three.
    const cell = newCell("AAPL:NASDAQ:1980-12-12", "AAPL", "MID");
    for (let i = 0; i < 5000; i++) {
      cell.spread.add(i);
      cell.quotedSize.add(i);
      cell.effective.add(i);
    }
    assert.notDeepEqual(cell.spread.values, cell.quotedSize.values);
    assert.notDeepEqual(cell.spread.values, cell.effective.values);
  });

  it("the key is stable and distinguishes buckets", () => {
    assert.equal(cellKey("A:B:C", "MID"), "A:B:C|MID");
    assert.notEqual(cellKey("A:B:C", "MID"), cellKey("A:B:C", "OPEN30"));
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("summarizing a cell", () => {
  it("reports median, p75 and the RAW count", () => {
    const cell = newCell("AAPL:NASDAQ:1980-12-12", "AAPL", "MID");
    for (const v of [1, 1, 1, 2, 4]) cell.spread.add(v);
    const s = summarizeCell(cell);
    assert.ok(s !== null);
    assert.equal(s.medianSpreadBps, 1);
    assert.equal(s.p75SpreadBps, 2);
    assert.equal(s.sampleCount, 5);
  });

  it("sampleCount is the RAW count, even past the reservoir's capacity", () => {
    // THE JOIN, not the halves. The reservoir's own `count` is asserted above,
    // but `summarizeCell` is what writes the row — and swapping
    // `cell.spread.count` for `cell.spread.values.length` there passed the
    // whole suite until this case existed. It would cap every busy cell at
    // 4,096 and make a cell built from four quotes indistinguishable from one
    // built from forty thousand, which is the only thing telling a reader
    // whether a spread estimate means anything.
    const cell = newCell("A:B:C", "A", "MID");
    for (let i = 0; i < RESERVOIR_SIZE + 500; i++) cell.spread.add(1 + (i % 3));
    const s = summarizeCell(cell);
    assert.ok(s !== null);
    assert.equal(s.sampleCount, RESERVOIR_SIZE + 500);
    assert.notEqual(s.sampleCount, cell.spread.values.length);
  });

  it("the optional counts are raw too", () => {
    const cell = newCell("A:B:C", "A", "MID");
    for (let i = 0; i < RESERVOIR_SIZE + 100; i++) {
      cell.spread.add(1);
      cell.effective.add(2);
    }
    const s = summarizeCell(cell);
    assert.ok(s !== null);
    assert.equal(s.effectiveSampleCount, RESERVOIR_SIZE + 100);
  });

  it("omits the optional statistics rather than reporting zero", () => {
    const cell = newCell("A:B:C", "A", "MID");
    cell.spread.add(1);
    const s = summarizeCell(cell);
    assert.ok(s !== null);
    assert.equal(s.medianQuotedSizeShares, undefined);
    assert.equal(s.effectiveSpreadBps, undefined);
    assert.equal(s.effectiveSampleCount, undefined);
  });

  it("a cell with NO quotes yields null, never a row of zeros", () => {
    // A zero-spread row reads as a free-to-trade listing and would make a
    // backtest of an illiquid name look like its best idea.
    assert.equal(summarizeCell(newCell("A:B:C", "A", "MID")), null);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("time-of-day buckets follow the SESSION's close", () => {
  const D = "2026-11-23"; // a normal Monday

  it("splits a regular session into the five buckets", () => {
    assert.equal(todBucketFor(et(D, 4, 0)), "PRE");
    assert.equal(todBucketFor(et(D, 9, 29)), "PRE");
    assert.equal(todBucketFor(et(D, 9, 30)), "OPEN30");
    assert.equal(todBucketFor(et(D, 9, 59)), "OPEN30");
    assert.equal(todBucketFor(et(D, 10, 0)), "MID");
    assert.equal(todBucketFor(et(D, 15, 29)), "MID");
    assert.equal(todBucketFor(et(D, 15, 30)), "CLOSE30");
    assert.equal(todBucketFor(et(D, 15, 59)), "CLOSE30");
    assert.equal(todBucketFor(et(D, 16, 0)), "POST");
    assert.equal(todBucketFor(et(D, 19, 59)), "POST");
  });

  it("drops quotes outside 04:00–20:00 rather than folding them in", () => {
    // A quote outside the session is a vendor artefact or a clock bug, and
    // either way it is not a cost anyone can pay.
    assert.equal(todBucketFor(et(D, 3, 59)), null);
    assert.equal(todBucketFor(et(D, 20, 0)), null);
  });

  it("MOVES the close window on an early-close day", () => {
    // 2026-11-27, the day after Thanksgiving: the market closes at 13:00 ET.
    // A fixed 15:30 grid would file the real closing auction under MID and
    // leave CLOSE30 measuring an empty post-market — a cell of wide,
    // meaningless spreads that a backtest would charge every closing trade.
    const H = "2026-11-27";
    assert.equal(todBucketFor(et(H, 12, 29)), "MID");
    assert.equal(todBucketFor(et(H, 12, 30)), "CLOSE30");
    assert.equal(todBucketFor(et(H, 12, 59)), "CLOSE30");
    assert.equal(todBucketFor(et(H, 13, 0)), "POST");
    // And the SAME wall-clock times on a normal day are still MID.
    assert.equal(todBucketFor(et(D, 12, 30)), "MID");
    assert.equal(todBucketFor(et(D, 13, 0)), "MID");
  });

  it("is DST-aware — the same ET minute buckets alike in July and November", () => {
    // A fixed UTC offset would put every summer quote an hour off, which
    // would move the whole opening auction out of OPEN30.
    assert.equal(todBucketFor(et("2026-07-06", 9, 45)), "OPEN30");
    assert.equal(todBucketFor(et("2026-11-23", 9, 45)), "OPEN30");
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("liquidity tiers are RELATIVE terciles", () => {
  const six = [
    { listingId: "A", medianDollarVolume: 600 },
    { listingId: "B", medianDollarVolume: 500 },
    { listingId: "C", medianDollarVolume: 400 },
    { listingId: "D", medianDollarVolume: 300 },
    { listingId: "E", medianDollarVolume: 200 },
    { listingId: "F", medianDollarVolume: 100 },
  ];

  it("splits six listings 2 / 2 / 2, most liquid first", () => {
    const tiers = assignTiers(six);
    assert.deepEqual(
      six.map((l) => tiers.get(l.listingId)),
      ["T1", "T1", "T2", "T2", "T3", "T3"],
    );
  });

  it("scaling every volume by 1000 changes NOTHING", () => {
    // The reason the cut is relative. Fixed dollar thresholds would re-tier the
    // whole universe on a market-wide move, which reads as every stock's
    // liquidity changing at once.
    const scaled = six.map((l) => ({
      ...l,
      medianDollarVolume: l.medianDollarVolume * 1000,
    }));
    assert.deepEqual([...assignTiers(six)], [...assignTiers(scaled)]);
  });

  it("breaks ties by listingId, so a rebuild cannot move a listing", () => {
    const tied = [
      { listingId: "Z", medianDollarVolume: 100 },
      { listingId: "A", medianDollarVolume: 100 },
      { listingId: "M", medianDollarVolume: 100 },
    ];
    const forward = assignTiers(tied);
    const reversed = assignTiers([...tied].reverse());
    assert.deepEqual([...forward].sort(), [...reversed].sort());
  });

  it("an unmeasurable listing is T3, the CONSERVATIVE tier", () => {
    // Defaulting to T1 would cost an unmeasurable listing as if it were the
    // most liquid thing in the universe.
    const tiers = assignTiers([
      { listingId: "A", medianDollarVolume: 100 },
      { listingId: "B", medianDollarVolume: 0 },
      { listingId: "C", medianDollarVolume: NaN },
    ]);
    assert.equal(tiers.get("B"), "T3");
    assert.equal(tiers.get("C"), "T3");
  });

  it("an all-unmeasurable population is entirely T3, not empty", () => {
    const tiers = assignTiers([{ listingId: "A", medianDollarVolume: 0 }]);
    assert.equal(tiers.get("A"), "T3");
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("when the model rebuilds", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  const ready = (builtAt: string) => ({
    modelVersion: 3,
    builtAt: new Date(builtAt),
    status: "READY",
  });

  it("no version at all rebuilds", () => {
    assert.equal(shouldRebuildCostModel(now, null), true);
  });

  it("the SAME UTC month does NOT rebuild", () => {
    // Rebuilding on every append would give a backtest a different cost basis
    // every night and make two runs of one strategy incomparable.
    assert.equal(
      shouldRebuildCostModel(now, ready("2026-09-01T00:00:00Z")),
      false,
    );
  });

  it("a NEW UTC month rebuilds", () => {
    assert.equal(
      shouldRebuildCostModel(now, ready("2026-08-31T23:59:59Z")),
      true,
    );
  });

  it("the same month of a DIFFERENT YEAR rebuilds", () => {
    // A month comparison that ignored the year would skip a rebuild for a
    // whole year and report a healthy monthly cadence.
    assert.equal(
      shouldRebuildCostModel(now, ready("2025-09-15T00:00:00Z")),
      true,
    );
  });

  it("the flag forces it", () => {
    assert.equal(
      shouldRebuildCostModel(now, ready("2026-09-01T00:00:00Z"), true),
      true,
    );
  });

  it("a FAILED or still-BUILDING version rebuilds regardless of the month", () => {
    // A half-written table is not a model, and leaving it as the newest
    // version would have a reader pin to it.
    for (const status of ["FAILED", "BUILDING"]) {
      assert.equal(
        shouldRebuildCostModel(now, {
          ...ready("2026-09-01T00:00:00Z"),
          status,
        }),
        true,
        `status ${status} did not force a rebuild`,
      );
    }
  });
});
