/**
 * MONEY-1382 — the India daily series is served on ONE basis.
 *
 * `daily_prices` mixes RAW exchange prints with Yahoo closes that Yahoo had
 * already restated for every split it knew about when we fetched them. The
 * chart route divided every bar by every later split, so a Yahoo row fetched
 * AFTER a split was divided twice.
 *
 * The fix is NOT the one the ticket first proposed. Measured on prod
 * 2026-09-23:
 *
 *   drop Yahoo rows older than the newest exchange row  70,266 rows lost
 *                                                       (72% of all Yahoo rows,
 *                                                       GOODYEAR 7,122 -> 2,546)
 *   skip the factor for every Yahoo row                  breaks 185 of 329 rows
 *                                                       the route got RIGHT
 *   factor as of the fetch instant (this)                breaks 0, fixes 29
 *
 * Executes the REAL `getHistoricalPrices` through the `globalThis.prisma`
 * seam `packages/database/client.ts` reads before building a client — the
 * module under test is imported DYNAMICALLY, after the double is installed.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const D = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

interface Row {
  instrumentId: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number | null;
  source: string;
  createdAt: Date;
}

let rows: Row[] = [];
let createManyCalls = 0;
/** Every date a createMany wrote, as YYYY-MM-DD. */
let written: string[] = [];

(globalThis as unknown as { prisma?: unknown }).prisma = {
  dailyPrice: {
    findMany: async (args: {
      where: { instrumentId: string; date: { gte: Date; lte: Date } };
    }) =>
      rows
        .filter(
          (r) =>
            r.instrumentId === args.where.instrumentId &&
            r.date >= args.where.date.gte &&
            r.date <= args.where.date.lte,
        )
        .sort((a, b) => a.date.getTime() - b.date.getTime()),
    createMany: async (args: { data: Array<{ date: Date }> }) => {
      createManyCalls++;
      written.push(...args.data.map((d) => d.date.toISOString().slice(0, 10)));
      return { count: args.data.length };
    },
    findUnique: async () => null,
    create: async () => ({}),
    update: async () => ({}),
  },
  instrumentMapping: {
    findUnique: async () => ({ yahooSymbol: "TEST.NS" }),
  },
};

const { getHistoricalPrices } =
  await import("../../src/market-data/prices/yahoo-price-service");
const {
  adjustBarsForBasis,
  resampleFetchWindow,
  liveSessionBar,
  yahooFillRange,
  istSessionDate,
} = await import("../../src/market-data/prices/yahoo-price-logic");

function row(
  iso: string,
  close: number,
  source: string,
  createdIso = iso,
): Row {
  return {
    instrumentId: "inst-1",
    date: D(iso),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    adjClose: null,
    source,
    createdAt: new Date(`${createdIso}T16:00:00Z`),
  };
}

beforeEach(() => {
  rows = [];
  createManyCalls = 0;
  written = [];
});

/** A Yahoo fake that records every range it is asked for. */
function recordingFetcher(bars: string[] = []) {
  const calls: Array<[string, string, string]> = [];
  const fetch = async (sym: string, from: Date, to: Date) => {
    calls.push([
      sym,
      from.toISOString().slice(0, 10),
      to.toISOString().slice(0, 10),
    ]);
    return bars.map((iso) => {
      const { instrumentId: _i, createdAt: _c, ...bar } = row(iso, 50, "YAHOO");
      return { ...bar, adjClose: undefined };
    });
  };
  return { calls, fetch };
}

// ── getHistoricalPrices: every row, its basis, and no Yahoo over the exchange ──

describe("getHistoricalPrices — mixed exchange/Yahoo window", () => {
  // The window opens a month BEFORE the first exchange print, and holds holes
  // INSIDE coverage too (02-04 -> 02-23) — so `hasGaps` over the whole window
  // is TRUE, and only the pre-coverage month may reach Yahoo.
  const start = D("2026-01-01");
  const end = D("2026-03-31");

  function mixed(): void {
    rows = [
      row("2026-02-02", 200, "BHAVCOPY_HIST"),
      row("2026-02-03", 201, "BHAVCOPY_HIST"),
      // A Yahoo row fetched AFTER the 2026-02-20 split: already restated.
      row("2026-02-04", 101, "YAHOO", "2026-03-01"),
      row("2026-02-23", 100, "BHAVCOPY"),
      row("2026-03-20", 104, "BHAVCOPY"),
      // Newer than the newest exchange row — a forming session.
      row("2026-03-23", 105, "YAHOO", "2026-03-23"),
    ];
  }

  it("coverage starting mid-window: Yahoo is asked for ONLY the span before the first print", async () => {
    mixed();
    const yahoo = recordingFetcher();
    await getHistoricalPrices("inst-1", start, end, yahoo.fetch);
    assert.deepEqual(
      yahoo.calls,
      [["TEST.NS", "2026-01-01", "2026-02-02"]],
      "the years before an instrument's first exchange print have nothing but Yahoo",
    );
  });

  it("writes only pre-coverage sessions, even when the vendor returns one inside coverage", async () => {
    mixed();
    // 02-16 has no exchange row (a hole inside coverage) — the MONEY-1382
    // interleave. A fetcher ignoring its period2 must still not land it.
    const yahoo = recordingFetcher(["2026-01-05", "2026-01-30", "2026-02-16"]);
    await getHistoricalPrices("inst-1", start, end, yahoo.fetch);
    assert.deepEqual(written, ["2026-01-05", "2026-01-30"]);
  });

  it("FULLY covered: zero Yahoo fetches", async () => {
    // Saturday start; the exchange prints every session Monday..Friday.
    rows = ["02-02", "02-03", "02-04", "02-05", "02-06"].map((md) =>
      row(`2026-${md}`, 100, "BHAVCOPY"),
    );
    const yahoo = recordingFetcher();
    await getHistoricalPrices(
      "inst-1",
      D("2026-01-31"),
      D("2026-02-06"),
      yahoo.fetch,
    );
    assert.deepEqual(yahoo.calls, []);
  });

  it("holes INSIDE coverage (a suspension): zero Yahoo fetches — the loop that never converged", async () => {
    rows = [
      row("2026-01-01", 100, "BHAVCOPY_HIST"),
      row("2026-01-02", 100, "BHAVCOPY_HIST"),
      row("2026-02-10", 100, "YAHOO", "2026-02-11"),
      row("2026-03-30", 100, "BHAVCOPY"),
      row("2026-03-31", 100, "BHAVCOPY"),
    ];
    const yahoo = recordingFetcher();
    await getHistoricalPrices("inst-1", start, end, yahoo.fetch);
    assert.deepEqual(yahoo.calls, []);
    assert.equal(createManyCalls, 0);
  });

  it("a gap AFTER the last print (a delisting): zero Yahoo fetches", async () => {
    rows = [
      row("2026-01-01", 100, "BHAVCOPY"),
      row("2026-01-02", 100, "BHAVCOPY"),
    ];
    const yahoo = recordingFetcher();
    await getHistoricalPrices("inst-1", start, end, yahoo.fetch);
    assert.deepEqual(yahoo.calls, []);
  });

  it("returns EVERY row — none dropped — in date order", async () => {
    mixed();
    const bars = await getHistoricalPrices(
      "inst-1",
      start,
      end,
      async () => [],
    );
    assert.deepEqual(
      bars.map((b) => b.date.toISOString().slice(0, 10)),
      [
        "2026-02-02",
        "2026-02-03",
        "2026-02-04",
        "2026-02-23",
        "2026-03-20",
        "2026-03-23",
      ],
      "a Yahoo row older than the newest exchange row must survive — " +
        "dropping them cost 72% of all Yahoo rows on prod",
    );
  });

  it("a Yahoo row carries the instant it was fetched; an exchange row carries none", async () => {
    mixed();
    const bars = await getHistoricalPrices(
      "inst-1",
      start,
      end,
      async () => [],
    );
    const byDate = new Map(
      bars.map((b) => [b.date.toISOString().slice(0, 10), b]),
    );
    assert.equal(byDate.get("2026-02-04")!.source, "YAHOO");
    assert.deepEqual(
      byDate.get("2026-02-04")!.adjustedThrough,
      new Date("2026-03-01T16:00:00Z"),
    );
    assert.equal(byDate.get("2026-02-02")!.source, "BHAVCOPY_HIST");
    assert.equal(byDate.get("2026-02-02")!.adjustedThrough, undefined);
    assert.equal(byDate.get("2026-02-23")!.adjustedThrough, undefined);
  });

  it("a Yahoo-ONLY window still gap-fills the whole window — it has nothing else", async () => {
    rows = [row("2026-02-04", 101, "YAHOO", "2026-02-05")];
    const yahoo = recordingFetcher();
    await getHistoricalPrices("inst-1", start, end, yahoo.fetch);
    assert.deepEqual(yahoo.calls, [["TEST.NS", "2026-01-01", "2026-03-31"]]);
  });

  it("yahooFillRange: empty -> whole window; late first print -> up to it", () => {
    assert.deepEqual(yahooFillRange([], start, end), { start, end });
    assert.deepEqual(
      yahooFillRange(
        [{ date: D("2026-03-30"), source: "BHAVCOPY" }],
        start,
        end,
      ),
      { start, end: D("2026-03-30") },
    );
  });

  it("yahooFillRange: a pre-coverage span Yahoo already filled is not fetched again", () => {
    const filled = [];
    for (
      let d = D("2026-01-01");
      d < D("2026-03-30");
      d = new Date(+d + 3 * 864e5)
    ) {
      filled.push({ date: d, source: "YAHOO" });
    }
    filled.push({ date: D("2026-03-30"), source: "BHAVCOPY" });
    assert.equal(yahooFillRange(filled, start, end), null);
  });
});

// ── adjustBarsForBasis: each split applied exactly once ──

describe("adjustBarsForBasis — a 1:2 split on 2026-02-20", () => {
  const steps = [{ before: D("2026-02-20"), factor: 2 }];
  const bar = (iso: string, close: number, adjustedThrough?: string) => ({
    date: D(iso),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    ...(adjustedThrough
      ? { adjustedThrough: new Date(`${adjustedThrough}T16:00:00Z`) }
      : {}),
  });

  const out = adjustBarsForBasis(
    [
      bar("2026-02-10", 200), // exchange print, raw
      bar("2026-02-11", 101, "2026-03-01"), // Yahoo, fetched AFTER the split
      bar("2026-02-12", 202, "2026-02-13"), // Yahoo, fetched BEFORE it: raw
      bar("2026-02-24", 100), // after the split
    ],
    steps,
  );

  it("divides a raw exchange print dated before the split", () => {
    assert.equal(out[0]!.close, 100);
    assert.equal(out[0]!.volume, 2000, "volume moves the other way");
  });

  it("does NOT divide a Yahoo row fetched after the split a second time", () => {
    assert.equal(out[1]!.close, 101);
  });

  it("DOES divide a Yahoo row fetched before the split — it was raw (185 such rows on prod)", () => {
    assert.equal(out[2]!.close, 101);
  });

  it("keeps each bar's own date", () => {
    assert.deepEqual(
      out.map((b) => b.date.toISOString().slice(0, 10)),
      ["2026-02-10", "2026-02-11", "2026-02-12", "2026-02-24"],
    );
  });

  it("no steps -> the same array, untouched", () => {
    const input = [bar("2026-02-10", 200)];
    assert.equal(adjustBarsForBasis(input, []), input);
  });
});

// ── weekly/monthly windows ──
// resampleDailyBars' bucket math is pinned in packages/research/__tests__/
// fetch-price-history.test.ts, where it lived before it moved to core.

describe("resampleFetchWindow — whole buckets only", () => {
  it("1wk: widens a Wednesday..Tuesday window to Monday..Sunday", () => {
    const w = resampleFetchWindow(
      new Date("2026-06-03T10:00:00Z"),
      new Date("2026-06-09T10:00:00Z"),
      "1wk",
    );
    assert.equal(w.start.toISOString(), "2026-06-01T00:00:00.000Z");
    assert.equal(w.end.toISOString(), "2026-06-14T23:59:59.999Z");
  });

  it("1wk: a Sunday `to` is already the end of its week", () => {
    const w = resampleFetchWindow(D("2026-06-01"), D("2026-06-07"), "1wk");
    assert.equal(w.end.toISOString(), "2026-06-07T23:59:59.999Z");
  });

  it("1mo: first of the month .. last instant of the month", () => {
    const w = resampleFetchWindow(D("2026-02-17"), D("2026-02-18"), "1mo");
    assert.equal(w.start.toISOString(), "2026-02-01T00:00:00.000Z");
    assert.equal(w.end.toISOString(), "2026-02-28T23:59:59.999Z");
  });
});

// ── liveSessionBar: today's candle, only from THIS session's quote ──

describe("liveSessionBar", () => {
  // Wednesday 2026-09-23, 11:00 IST — a trading day, mid-session.
  const now = new Date("2026-09-23T05:30:00Z");
  const quote = (
    tsIso: string,
    over: Partial<Record<string, number>> = {},
  ) => ({
    price: 2110,
    open: 2100,
    high: 2120,
    low: 2095,
    volume: 12_345,
    timestamp: new Date(tsIso),
    ...over,
  });

  it("builds today's bar, dated at the session (UTC midnight of the IST day)", () => {
    const bar = liveSessionBar(quote("2026-09-23T05:29:00Z"), now);
    assert.deepEqual(bar, {
      date: D("2026-09-23"),
      open: 2100,
      high: 2120,
      low: 2095,
      close: 2110,
      volume: 12_345,
      source: "LIVE",
    });
    assert.deepEqual(istSessionDate(now), D("2026-09-23"));
  });

  it("refuses last night's quote — `latest_quotes` is only refreshed at 23:00", () => {
    assert.equal(liveSessionBar(quote("2026-09-22T09:45:00Z"), now), null);
  });

  it("refuses a quote from before today's 09:15 open", () => {
    assert.equal(liveSessionBar(quote("2026-09-23T03:40:00Z"), now), null);
  });

  it("refuses when the session is not live (after close, weekend)", () => {
    assert.equal(
      liveSessionBar(
        quote("2026-09-23T09:59:00Z"),
        new Date("2026-09-23T10:05:00Z"),
      ),
      null,
    );
    assert.equal(
      liveSessionBar(
        quote("2026-09-26T05:00:00Z"),
        new Date("2026-09-26T05:30:00Z"),
      ),
      null,
    );
  });

  it("refuses a candle with a missing (zero) price rather than drawing it", () => {
    assert.equal(
      liveSessionBar(quote("2026-09-23T05:29:00Z", { open: 0 }), now),
      null,
    );
    assert.equal(liveSessionBar(null, now), null);
  });

  it("widens a range the price has moved outside", () => {
    const bar = liveSessionBar(
      quote("2026-09-23T05:29:00Z", { price: 2130 }),
      now,
    );
    assert.equal(bar!.high, 2130);
  });
});
