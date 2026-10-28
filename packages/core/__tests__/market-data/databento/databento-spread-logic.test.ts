/**
 * MONEY-1505 (B5) — `spread_cost_daily`'s arithmetic.
 *
 * The golden fixture at the bottom is the one the B5 prompt asks for by name:
 * a tbbo stream must leave the bbo `sampleCount` UNMOVED. Everything above it
 * is a guard whose removal is silent — a lane chosen from the row's shape, a
 * timestamp shifted the wrong way, a trade-only row written with NULL quoted
 * columns, two medians averaged into a number no book ever showed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mergeSpreadSummary,
  newSpreadDayCell,
  spreadDayKey,
  spreadSampleFor,
  summarizeSpreadDay,
  toSpreadCostRow,
  type SpreadDaySummary,
} from "../../../src/market-data/databento/databento-spread-logic";
import type {
  BboRow,
  TbboRow,
} from "../../../src/market-data/databento/databento-logic";

/** 2024-01-03 is a Wednesday, a full EST session. */
const ET_OFFSET_H = 5; // EST
const et = (h: number, m = 0, s = 0, ms = 0): number =>
  Date.UTC(2024, 0, 3, h + ET_OFFSET_H, m, s, ms);

function bbo(over: Partial<BboRow> = {}): BboRow {
  return {
    symbol: "AAPL",
    tsMs: et(10, 30),
    bid: 100,
    ask: 100.1,
    bidSize: 200,
    askSize: 300,
    ...over,
  };
}

function tbbo(over: Partial<TbboRow> = {}): TbboRow {
  return { ...bbo(), price: 100.1, ...over };
}

/* ─────────────────────────────────────────────────────────────────────────
   Lanes
   ──────────────────────────────────────────────────────────────────────── */

describe("spreadSampleFor picks a lane, never both", () => {
  it("a bbo record is QUOTED", () => {
    const s = spreadSampleFor(bbo(), "bbo");
    assert.ok(!("rejected" in s));
    assert.equal(s.lane, "quoted");
    // (100.1 - 100) / 100.05 * 10_000
    assert.ok(Math.abs(s.valueBps - 9.9950025) < 1e-6, String(s.valueBps));
    assert.equal(s.sessionDate, "2024-01-03");
  });

  it("a tbbo record is EFFECTIVE", () => {
    const s = spreadSampleFor(tbbo(), "tbbo");
    assert.ok(!("rejected" in s));
    assert.equal(s.lane, "effective");
    // A trade at the ask on an uncrossed book gives exactly the quoted spread.
    assert.ok(Math.abs(s.valueBps - 9.9950025) < 1e-6, String(s.valueBps));
  });

  it("the KIND decides the lane, not the row's shape", () => {
    // `TbboRow extends BboRow`, so a tbbo record whose price is unreadable is
    // structurally a bbo row. Deciding from the shape would put it in the
    // QUOTED lane — exactly the bias this module exists to prevent.
    const shaped = bbo() as TbboRow;
    const s = spreadSampleFor(shaped, "tbbo");
    assert.ok("rejected" in s);
    assert.equal(s.rejected, "unusable-trade");
  });

  it("a crossed or locked book is rejected, not clamped to zero", () => {
    for (const q of [
      { bid: 100.1, ask: 100 },
      { bid: 100, ask: 100 },
    ]) {
      const s = spreadSampleFor(bbo(q), "bbo");
      assert.ok("rejected" in s, JSON.stringify(q));
      assert.equal(s.rejected, "unusable-quote");
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The two timestamps
   ──────────────────────────────────────────────────────────────────────── */

describe("bbo's ts_recv is an interval END, tbbo's is an event", () => {
  it("20:00:00.000 ET is INSIDE the session for bbo and OUTSIDE for tbbo", () => {
    // The session runs 04:00-20:00 ET. A bbo record stamped at exactly 20:00
    // covers 19:59-20:00 and belongs to the session that just closed; shifting
    // it one millisecond back is what puts it there. A tbbo record stamped at
    // 20:00 is a print at 20:00, which is past the close.
    const at = et(20, 0, 0, 0);

    const quoted = spreadSampleFor(bbo({ tsMs: at }), "bbo");
    assert.ok(
      !("rejected" in quoted),
      "the bbo record must land in the session",
    );
    assert.equal(quoted.sessionDate, "2024-01-03");

    const trade = spreadSampleFor(tbbo({ tsMs: at }), "tbbo");
    assert.ok("rejected" in trade);
    assert.equal(trade.rejected, "outside-session");
  });

  it("03:59:59.999 ET is outside the session in both directions", () => {
    assert.deepEqual(
      spreadSampleFor(bbo({ tsMs: et(3, 59, 59, 999) }), "bbo"),
      {
        rejected: "outside-session",
      },
    );
  });

  it("the session date is the ET day, never the UTC day", () => {
    // 19:00 ET on 2024-01-03 under EST is 2024-01-04 in UTC. A UTC slice would
    // file this post-market quote on the NEXT session.
    const s = spreadSampleFor(bbo({ tsMs: et(19, 0) }), "bbo");
    assert.ok(!("rejected" in s));
    assert.equal(s.sessionDate, "2024-01-03");
    assert.equal(new Date(et(19, 0)).toISOString().slice(0, 10), "2024-01-04");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Summaries
   ──────────────────────────────────────────────────────────────────────── */

function cellWith(
  quoted: readonly number[],
  effective: readonly number[] = [],
) {
  const cell = newSpreadDayCell("AAPL:NASDAQ:1980-12-12", "AAPL", "2024-01-03");
  for (const v of quoted) {
    cell.quoted.add(v);
    cell.quotedObjectUri = "gs://b/databento/EQUS.MINI/bbo-1m/2024/j/a.csv.zst";
  }
  for (const v of effective) cell.effective.add(v);
  return cell;
}

describe("summarizeSpreadDay", () => {
  it("reports the nearest-rank median and p90", () => {
    const s = summarizeSpreadDay(cellWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    assert.ok(s !== null);
    assert.equal(s.medianSpreadBps, 5);
    assert.equal(s.p90SpreadBps, 9);
    assert.equal(s.quoteSampleCount, 10);
    assert.equal(s.effectiveSpreadBps, null);
    assert.equal(s.effectiveSampleCount, null);
  });

  it("p90 is NOT p75 — the column would otherwise under-report the tail", () => {
    // Nearest rank over 1..10: p75 is 8 and p90 is 9. The sibling cost model
    // stores p75, so a copied constant would be invisible here.
    const s = summarizeSpreadDay(cellWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    assert.ok(s !== null);
    assert.notEqual(s.p90SpreadBps, 8);
  });

  it("a TRADE-ONLY cell yields NO ROW", () => {
    // tbbo-top50 is a strict subset of the bbo baseline, so trades without
    // quotes mean the bbo file for that session did not arrive — a gap to fix,
    // not a measurement. A row with NULL quoted columns would read as "this
    // listing has no spread".
    assert.equal(summarizeSpreadDay(cellWith([], [1, 2, 3])), null);
  });

  it("an empty cell yields no row rather than a row of zeros", () => {
    assert.equal(summarizeSpreadDay(cellWith([])), null);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   THE GOLDEN FIXTURE — a tbbo stream must leave quoteSampleCount unmoved
   ──────────────────────────────────────────────────────────────────────── */

describe("a tbbo stream cannot move the QUOTED statistic", () => {
  /** A deterministic bbo minute stream: one quote a minute, widening. */
  const BBO_STREAM: BboRow[] = Array.from({ length: 60 }, (_v, i) =>
    bbo({ tsMs: et(10, i), bid: 100, ask: 100 + (i + 1) / 100 }),
  );

  /**
   * An ACTIVITY-WEIGHTED trade stream in the same session: 500 prints inside
   * one minute, every one at a tight book. If these folded into the quoted
   * lane they would drag the median from ~30 bps to ~1 bp, which is precisely
   * the "looks like a quoted spread, is biased low" failure.
   */
  const TBBO_STREAM: TbboRow[] = Array.from({ length: 500 }, (_v, i) =>
    tbbo({ tsMs: et(10, 30, i % 60), bid: 100, ask: 100.01, price: 100.01 }),
  );

  function fold(rows: readonly (BboRow | TbboRow)[], kind: "bbo" | "tbbo") {
    const cell = newSpreadDayCell(
      "AAPL:NASDAQ:1980-12-12",
      "AAPL",
      "2024-01-03",
    );
    for (const row of rows) {
      const s = spreadSampleFor(row, kind);
      if ("rejected" in s) continue;
      if (s.lane === "quoted") {
        cell.quoted.add(s.valueBps);
        cell.quotedObjectUri =
          "gs://b/databento/EQUS.MINI/bbo-1m/2024/j/a.csv.zst";
      } else {
        cell.effective.add(s.valueBps);
      }
    }
    return cell;
  }

  it("the bbo fold alone produces the golden quoted numbers", () => {
    const s = summarizeSpreadDay(fold(BBO_STREAM, "bbo"));
    assert.ok(s !== null);
    assert.equal(s.quoteSampleCount, 60);
    // Nearest rank over 60 widening quotes: the median is the 30th
    // (ask 100.30, mid 100.15) and p90 the 54th (ask 100.54, mid 100.27).
    // Both are spreads a book actually showed — an interpolated median would
    // invent one that never occurred, which on a tick-constrained book is not
    // a price anyone could have traded at.
    assert.equal(Number(s.medianSpreadBps.toFixed(4)), 29.9551);
    assert.equal(Number(s.p90SpreadBps.toFixed(4)), 53.8546);
    assert.equal(s.effectiveSampleCount, null);
  });

  it("folding tbbo adds ONLY the effective lane", () => {
    const tradeOnly = summarizeSpreadDay(fold(TBBO_STREAM, "tbbo"));
    assert.equal(
      tradeOnly,
      null,
      "a tbbo-only cell has no quoted sample and must produce no row at all",
    );

    const quoted = summarizeSpreadDay(fold(BBO_STREAM, "bbo"))!;
    const trades = fold(TBBO_STREAM, "tbbo");
    // The two legs meet in the MERGE, exactly as the loader's two passes do.
    const trade = {
      ...quoted,
      quotedObjectUri: "",
      medianSpreadBps: 0,
      p90SpreadBps: 0,
      quoteSampleCount: 0,
      effectiveSpreadBps: 0.9999500025,
      effectiveSampleCount: trades.effective.count,
    } satisfies SpreadDaySummary;

    const merged = mergeSpreadSummary(quoted, trade);

    assert.equal(merged.collisions, 0);
    assert.equal(
      merged.summary.quoteSampleCount,
      60,
      "THE assertion: 500 trades must not appear in the quoted count",
    );
    assert.equal(merged.summary.medianSpreadBps, quoted.medianSpreadBps);
    assert.equal(merged.summary.p90SpreadBps, quoted.p90SpreadBps);
    assert.equal(merged.summary.effectiveSampleCount, 500);
  });

  it("every tbbo record classifies as effective, none as quoted", () => {
    const lanes = new Set(
      TBBO_STREAM.map((r) => {
        const s = spreadSampleFor(r, "tbbo");
        return "rejected" in s ? s.rejected : s.lane;
      }),
    );
    assert.deepEqual([...lanes], ["effective"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Merge
   ──────────────────────────────────────────────────────────────────────── */

const QUOTED: SpreadDaySummary = {
  listingId: "AAPL:NASDAQ:1980-12-12",
  symbol: "AAPL",
  sessionDate: "2024-01-03",
  quotedObjectUri: "gs://b/databento/EQUS.MINI/bbo-1m/2024/j/a.csv.zst",
  medianSpreadBps: 10,
  p90SpreadBps: 20,
  quoteSampleCount: 900,
  effectiveSpreadBps: null,
  effectiveSampleCount: null,
};

const EFFECTIVE: SpreadDaySummary = {
  ...QUOTED,
  quotedObjectUri: "",
  medianSpreadBps: 0,
  p90SpreadBps: 0,
  quoteSampleCount: 0,
  effectiveSpreadBps: 7,
  effectiveSampleCount: 4000,
};

describe("mergeSpreadSummary", () => {
  it("an absent existing row is the incoming one", () => {
    assert.deepEqual(mergeSpreadSummary(undefined, QUOTED), {
      summary: QUOTED,
      collisions: 0,
    });
  });

  it("combines per LANE in either order", () => {
    const a = mergeSpreadSummary(QUOTED, EFFECTIVE).summary;
    const b = mergeSpreadSummary(EFFECTIVE, QUOTED).summary;
    for (const s of [a, b]) {
      assert.equal(s.quoteSampleCount, 900);
      assert.equal(s.medianSpreadBps, 10);
      assert.equal(s.effectiveSpreadBps, 7);
      assert.equal(s.effectiveSampleCount, 4000);
    }
  });

  it("counts a COLLISION rather than averaging two medians", () => {
    // Two files covering one symbol-session. Averaging two medians is not a
    // median of anything; the larger sample wins and the fact is reported.
    const bigger: SpreadDaySummary = {
      ...QUOTED,
      medianSpreadBps: 99,
      quoteSampleCount: 1000,
    };
    const merged = mergeSpreadSummary(QUOTED, bigger);
    assert.equal(merged.collisions, 1);
    assert.equal(merged.summary.medianSpreadBps, 99);
    assert.equal(merged.summary.quoteSampleCount, 1000);

    const smaller = mergeSpreadSummary(bigger, QUOTED);
    assert.equal(smaller.collisions, 1);
    assert.equal(smaller.summary.quoteSampleCount, 1000, "the larger must win");
  });

  it("refuses to merge two DIFFERENT keys", () => {
    assert.throws(
      () =>
        mergeSpreadSummary(QUOTED, { ...QUOTED, sessionDate: "2024-01-04" }),
      /keyed them wrongly/,
    );
    assert.throws(
      () =>
        mergeSpreadSummary(QUOTED, {
          ...QUOTED,
          listingId: "MSFT:NASDAQ:1986",
        }),
      /keyed them wrongly/,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The row
   ──────────────────────────────────────────────────────────────────────── */

describe("toSpreadCostRow", () => {
  const ctx = {
    market: "US",
    source: "DATABENTO",
    parserVersion: "spread-cost-v1",
    pipelineRunId: "run-1",
    observedAtMs: Date.UTC(2026, 8, 22),
    ingestedAtMs: Date.UTC(2026, 8, 22, 1),
  };

  it("counts are INT64 strings and the effective pair stays null together", () => {
    const row = toSpreadCostRow(QUOTED, ctx);
    assert.equal(row.quote_sample_count, "900");
    assert.equal(row.effective_spread_bps, null);
    assert.equal(row.effective_sample_count, null);
    assert.doesNotThrow(() => JSON.stringify(row));
  });

  it("source_object_uri names the object the QUOTED numbers came from", () => {
    // NOT the stage path: `lake/stage/` is deleted at 14 days by the S1
    // lifecycle rule, so a row's only provenance pointer would 404 a
    // fortnight after it was written. And not a tbbo object either — that
    // file contributed nothing to the stored median.
    const row = toSpreadCostRow(
      mergeSpreadSummary(QUOTED, EFFECTIVE).summary,
      ctx,
    );
    assert.equal(row.source_object_uri, QUOTED.quotedObjectUri);
    assert.match(row.source_object_uri, /^gs:\/\/.*\/databento\//);
    assert.ok(!row.source_object_uri.includes("lake/stage/"));
  });

  it("carries the mandatory columns and the record key", () => {
    const row = toSpreadCostRow(
      mergeSpreadSummary(QUOTED, EFFECTIVE).summary,
      ctx,
    ) as unknown as Record<string, unknown>;
    assert.equal(
      row.source_record_key,
      spreadDayKey(QUOTED.listingId, "2024-01-03"),
    );
    assert.equal(row.parser_version, "spread-cost-v1");
    assert.equal(row.pipeline_run_id, "run-1");
    assert.equal(row.observed_at, "2026-09-22T00:00:00.000Z");
    assert.equal(row.ingested_at, "2026-09-22T01:00:00.000Z");
    assert.equal(row.effective_sample_count, "4000");
    assert.equal(row.market, "US");
    assert.equal(row.source, "DATABENTO");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   NUMERIC scale — MONEY-1512
   ──────────────────────────────────────────────────────────────────────── */

describe("spread_cost_daily NUMERIC scale (MONEY-1512)", () => {
  const ctx = {
    market: "US",
    source: "DATABENTO",
    parserVersion: "spread-cost-v1",
    pipelineRunId: "run-1",
    observedAtMs: Date.UTC(2026, 8, 22),
    ingestedAtMs: Date.UTC(2026, 8, 22, 1),
  };

  /** What BigQuery sees — the NDJSON text, not the JS number behind it. */
  function serialisedDecimals(v: unknown): number {
    const s = JSON.stringify(v);
    const dot = s.indexOf(".");
    return dot === -1 ? 0 : s.length - dot - 1;
  }

  // Ordinary one-cent books. The pre-existing fixtures use 10 and 20, which is
  // exactly why this shipped uncaught: every spread column is a quotient
  // (`((ask - bid) / mid) * 10_000`) and `percentile()` is nearest-rank, so it
  // returns a raw sample VERBATIM — a full float tail, straight into
  // NUMERIC(18, 6).
  const REAL: SpreadDaySummary = {
    listingId: "AAPL:NASDAQ:1980-12-12",
    symbol: "AAPL",
    sessionDate: "2024-01-03",
    quotedObjectUri: "gs://b/databento/EQUS.MINI/bbo-1m/2024/j/a.csv.zst",
    medianSpreadBps: ((100.005 - 99.995) / 100) * 10_000,
    p90SpreadBps: ((100.05 - 99.95) / 100.0) * 10_000,
    quoteSampleCount: 900,
    effectiveSpreadBps: (2 * Math.abs(100.065 - 100) * 10_000) / 100.0005,
    effectiveSampleCount: 12,
  };

  it("the raw quotients really do exceed NUMERIC(18, 6)", () => {
    // Pins the premise. If these stop carrying a float tail the guard below is
    // testing nothing and must be re-derived rather than deleted.
    assert.ok(
      serialisedDecimals(REAL.medianSpreadBps) > 6,
      `median raw ${JSON.stringify(REAL.medianSpreadBps)}`,
    );
    assert.ok(serialisedDecimals(REAL.p90SpreadBps) > 6);
    assert.ok(serialisedDecimals(REAL.effectiveSpreadBps) > 6);
  });

  it("every spread column is rounded to scale 6 on the row", () => {
    const row = toSpreadCostRow(REAL, ctx);
    for (const col of [
      "median_spread_bps",
      "p90_spread_bps",
      "effective_spread_bps",
    ] as const) {
      assert.ok(
        serialisedDecimals(row[col]) <= 6,
        `${col} serialised ${JSON.stringify(row[col])} — over NUMERIC(18, 6)`,
      );
    }
  });

  it("the two NOT NULL columns never come back null", () => {
    // `median_spread_bps` and `p90_spread_bps` are NUMERIC(18, 6) NOT NULL, so
    // unlike `value_lakh` there is no null escape: a nullable rounder would
    // type-check against `effective_spread_bps` and fail the load on these two.
    const row = toSpreadCostRow(REAL, ctx);
    assert.equal(typeof row.median_spread_bps, "number");
    assert.equal(typeof row.p90_spread_bps, "number");
  });

  it("a non-finite value on a NOT NULL column THROWS rather than writing 0", () => {
    // Writing a 0 would put a fabricated tightest-possible spread into the
    // cost model every backtest is priced against, with nothing on the row to
    // say so. `summarizeCell` drops a quote-less cell, so reaching here at all
    // is a real upstream defect and must be loud.
    assert.throws(
      () => toSpreadCostRow({ ...REAL, medianSpreadBps: Number.NaN }, ctx),
      /not finite/,
    );
  });
});
