/**
 * MONEY-1060 (RC1 + RC4 + review fixes 4/5) — fetch_price_history research tool.
 *
 * Covers `packages/research/src/tools/fetch-price-history.ts`:
 *   RC1 (DB-first): when the persisted DailyPrice collection has bars covering
 *        the window, the tool serves them (success:true, count>0, source:"db")
 *        and NEVER hits live Yahoo — the same seam the chart uses. A DB miss
 *        falls through to live.
 *   Fix 4 (coverage): a GAPPY DB slice (hasGaps — 5-day boundary/hole check) is
 *        NOT served as the full period: live is tried first; if live also comes
 *        up empty the partial DB bars are served but LABELLED
 *        (metadata.partial + coverage bounds [+ sourceError]).
 *   Fix 5 (1wk/1mo): weekly/monthly requests now read the DAILY DB bars and
 *        resample them (ISO week / calendar month buckets) under the same
 *        coverage rule, instead of always bypassing the DB.
 *   RC4 (honest errors): a live outage that produced no bars is surfaced as
 *        success:false + metadata.sourceError (NOT the old success:true +
 *        empty). Production `fetchChart` NEVER throws — it swallows and returns
 *        [] — so the outage signal rides the `onError` observer; the
 *        swallow-shaped fakes below (return empty + call onError) exercise the
 *        REAL wiring. A real empty response (no error) stays an honest quiet
 *        success with empty data.
 *
 * The DB read + live fetch are injected as deterministic fakes — no real DB, no
 * network (mirrors fetch-youtube-transcript's injected-prisma style).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchPriceHistoryTool,
  resolvePriceHistory,
  readDbPriceBars,
  fetchLivePriceBars,
  type RawPriceBar,
  type PriceHistoryPrismaClient,
} from "../src/tools/fetch-price-history";
import { resampleDailyBars } from "@usemoney/core/market-data/prices/yahoo-price-logic";

// ── helpers ─────────────────────────────────────────────────────────────────

function bar(date: string, close: number, volume = 1000): RawPriceBar {
  return {
    date: new Date(`${date}T00:00:00Z`),
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume,
  };
}

/**
 * One bar per day for the last `days` days up to now — passes hasGaps for any
 * period window of `days` days (resolvePriceHistory computes period1 from
 * Date.now(), so coverage fakes must be now-relative).
 */
function denseDailyBars(days: number): RawPriceBar[] {
  const out: RawPriceBar[] = [];
  const now = Date.now();
  for (let i = days; i >= 0; i--) {
    out.push({
      date: new Date(now - i * 86_400_000),
      open: 100 + i,
      high: 102 + i,
      low: 98 + i,
      close: 101 + i,
      volume: 1000 + i,
    });
  }
  return out;
}

function md(out: {
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return (out.metadata ?? {}) as Record<string, unknown>;
}

/** Injectable fake prisma for readDbPriceBars (no real DB). */
function fakePrisma(opts: {
  instrument?: { id: string } | null;
  rows?: RawPriceBar[];
  throwFindMany?: boolean;
  onFindUnique?: (args: unknown) => void;
  onFindMany?: (args: unknown) => void;
}): PriceHistoryPrismaClient {
  const instrument =
    opts.instrument === undefined ? { id: "inst-1" } : opts.instrument;
  return {
    instrumentMapping: {
      findUnique: async (args: unknown) => {
        opts.onFindUnique?.(args);
        return instrument;
      },
    },
    dailyPrice: {
      findMany: async (args: unknown) => {
        opts.onFindMany?.(args);
        if (opts.throwFindMany) throw new Error("db read failed");
        return opts.rows ?? [];
      },
    },
  };
}

// ── RC1: DB-first (coverage-gated since fix 4) ────────────────────────────────

describe("resolvePriceHistory — RC1 DB-first with coverage", () => {
  it("serves fully-covering DB bars and does NOT hit live Yahoo", async () => {
    let liveCalled = false;
    const dbBars = denseDailyBars(31); // covers the whole 1m window

    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS", period: "1m" },
      {
        readDb: async () => dbBars,
        fetchLive: async () => {
          liveCalled = true;
          return { bars: [], error: null };
        },
      },
    );

    assert.equal(out.success, true);
    assert.equal(liveCalled, false, "must not hit live Yahoo when DB covers");

    const data = out.data as Array<Record<string, unknown>>;
    assert.equal(data.length, dbBars.length);
    assert.equal(md(out).count, dbBars.length);
    assert.equal(md(out).source, "db");
    assert.equal(md(out).partial, undefined, "full coverage is not partial");
    // bar shape preserved: YYYY-MM-DD date + OHLCV numbers.
    assert.match(String(data[0]!.date), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(data[0]!.close, dbBars[0]!.close);
    assert.equal(
      data[data.length - 1]!.close,
      dbBars[dbBars.length - 1]!.close,
    );
  });

  it("fix 4: a GAPPY DB slice is not served as the period — live wins when it has bars", async () => {
    // Only the last 3 days of a 1m window → hasGaps → must go live.
    const gappy = denseDailyBars(3);
    const liveBars = denseDailyBars(31);
    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS", period: "1m" },
      {
        readDb: async () => gappy,
        fetchLive: async () => ({ bars: liveBars, error: null }),
      },
    );
    assert.equal(out.success, true);
    assert.equal(md(out).source, "yahoo");
    assert.equal(md(out).count, liveBars.length);
    assert.equal(md(out).partial, undefined);
  });

  it("fix 4: gappy DB + live OUTAGE → the partial DB bars are served but LABELLED", async () => {
    const gappy = denseDailyBars(3);
    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS", period: "1m" },
      {
        readDb: async () => gappy,
        fetchLive: async () => ({
          bars: [],
          error: new Error("ETIMEDOUT query1.finance.yahoo.com"),
        }),
      },
    );
    assert.equal(out.success, true, "partial data beats none");
    const data = out.data as unknown[];
    assert.equal(data.length, gappy.length);
    assert.equal(md(out).source, "db");
    assert.equal(md(out).partial, true, "partial slice must be labelled");
    const coverage = md(out).coverage as { firstBar: string; lastBar: string };
    assert.match(coverage.firstBar, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(coverage.lastBar, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      md(out).sourceError,
      "ETIMEDOUT query1.finance.yahoo.com",
      "the live outage is carried alongside the partial data",
    );
  });

  it("fix 4: gappy DB + live genuinely empty (no error) → partial served, NO sourceError", async () => {
    const gappy = denseDailyBars(2);
    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS", period: "1m" },
      {
        readDb: async () => gappy,
        fetchLive: async () => ({ bars: [], error: null }),
      },
    );
    assert.equal(out.success, true);
    assert.equal(md(out).partial, true);
    assert.equal(md(out).sourceError, undefined);
  });

  it("fix 5: 1wk requests are served from the daily DB bars, RESAMPLED (live not hit)", async () => {
    let liveCalled = false;
    const daily = denseDailyBars(31);
    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS", period: "1m", interval: "1wk" },
      {
        readDb: async () => daily,
        fetchLive: async () => {
          liveCalled = true;
          return { bars: [], error: null };
        },
      },
    );
    assert.equal(
      liveCalled,
      false,
      "1wk with full DB coverage must not go live",
    );
    assert.equal(out.success, true);
    assert.equal(md(out).source, "db");
    const data = out.data as Array<Record<string, unknown>>;
    // Weekly buckets: strictly fewer bars than the daily series, matching the
    // REAL exported resampler on the same input.
    const expected = resampleDailyBars(daily, "1wk");
    assert.equal(data.length, expected.length);
    assert.ok(data.length < daily.length, "weekly bars must be aggregated");
    assert.equal(md(out).count, expected.length);
    assert.equal(
      data[data.length - 1]!.close,
      daily[daily.length - 1]!.close,
      "last weekly close = last daily close",
    );
  });

  it("fix 5: an unknown interval still bypasses the DB (straight to live)", async () => {
    let dbCalled = false;
    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS", interval: "1h" },
      {
        readDb: async () => {
          dbCalled = true;
          return denseDailyBars(400);
        },
        fetchLive: async () => ({ bars: [bar("2026-01-05", 15)], error: null }),
      },
    );
    assert.equal(
      dbCalled,
      false,
      "non-1d/1wk/1mo intervals must not read the DB",
    );
    assert.equal(out.success, true);
    assert.equal(md(out).source, "yahoo");
  });

  it("a DB read that throws does not block the live fallback", async () => {
    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS" },
      {
        readDb: async () => {
          throw new Error("mongo down");
        },
        fetchLive: async () => ({ bars: [bar("2026-02-02", 20)], error: null }),
      },
    );
    assert.equal(out.success, true);
    assert.equal(md(out).source, "yahoo");
    assert.equal(md(out).count, 1);
  });
});

// ── fix 5: resampling math (core's resampleDailyBars since MONEY-1382) ──────

describe("resampleDailyBars — ISO-week / calendar-month buckets", () => {
  // 2026-06-01 is a Monday; 06-01…06-05 share an ISO week, 06-08 starts the next.
  const week1 = [
    {
      date: new Date("2026-06-01T00:00:00Z"),
      open: 100,
      high: 105,
      low: 99,
      close: 101,
      volume: 10,
    },
    {
      date: new Date("2026-06-02T00:00:00Z"),
      open: 101,
      high: 110,
      low: 98,
      close: 104,
      volume: 20,
    },
    {
      date: new Date("2026-06-05T00:00:00Z"),
      open: 104,
      high: 108,
      low: 100,
      close: 107,
      volume: 30,
    },
  ];
  const week2 = [
    {
      date: new Date("2026-06-08T00:00:00Z"),
      open: 107,
      high: 109,
      low: 106,
      close: 108,
      volume: 40,
    },
    {
      date: new Date("2026-06-09T00:00:00Z"),
      open: 108,
      high: 112,
      low: 107,
      close: 111,
      volume: 50,
    },
  ];

  it("1wk: open=first, close=last, high=max, low=min, volume=sum, date=FIRST session (MONEY-1382)", () => {
    const out = resampleDailyBars([...week1, ...week2], "1wk");
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
      date: new Date("2026-06-01T00:00:00Z"),
      open: 100,
      high: 110,
      low: 98,
      close: 107,
      volume: 60,
    });
    assert.deepEqual(out[1], {
      date: new Date("2026-06-08T00:00:00Z"),
      open: 107,
      high: 112,
      low: 106,
      close: 111,
      volume: 90,
    });
  });

  it("1wk: a weekend boundary splits buckets even without a Monday bar", () => {
    // Fri 2026-06-05 vs Tue 2026-06-09 — different ISO weeks.
    const out = resampleDailyBars([week1[2]!, week2[1]!], "1wk");
    assert.equal(out.length, 2);
  });

  it("1mo: buckets by calendar month", () => {
    const out = resampleDailyBars(
      [
        bar("2026-05-28", 90, 5),
        bar("2026-05-29", 92, 6),
        bar("2026-06-01", 95, 7),
        bar("2026-06-02", 97, 8),
      ],
      "1mo",
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]!.date.toISOString().slice(0, 10), "2026-05-28");
    assert.equal(out[0]!.open, 89); // first bar's open (close 90 - 1)
    assert.equal(out[0]!.close, 92); // last bar of May
    assert.equal(out[0]!.volume, 11);
    assert.equal(out[1]!.close, 97);
    assert.equal(out[1]!.volume, 15);
  });

  it("passes through unchanged for any other interval", () => {
    const daily = [bar("2026-06-01", 100), bar("2026-06-02", 101)];
    assert.deepEqual(resampleDailyBars(daily, "1d"), daily);
  });

  it("empty input → empty output", () => {
    assert.deepEqual(resampleDailyBars([], "1wk"), []);
  });
});

// ── RC4: honest errors on live outage ──────────────────────────────────────────

describe("resolvePriceHistory — RC4 honest errors", () => {
  it("live outage (throw, no bars) → success:false with metadata.sourceError", async () => {
    const out = await resolvePriceHistory(
      { symbol: "RELIANCE.NS" },
      {
        readDb: async () => [],
        fetchLive: async () => ({
          bars: [],
          error: new Error("ETIMEDOUT query1.finance.yahoo.com"),
        }),
      },
    );

    assert.equal(out.success, false, "an outage must NOT be an empty success");
    assert.match(out.error ?? "", /ETIMEDOUT/);
    assert.equal(md(out).sourceError, "ETIMEDOUT query1.finance.yahoo.com");
    assert.equal(out.data, undefined, "no empty data array on a failed fetch");
  });

  it("genuine empty gap (no throw) stays an honest success with empty data", async () => {
    const out = await resolvePriceHistory(
      { symbol: "NEWLISTING.NS" },
      {
        readDb: async () => [],
        fetchLive: async () => ({ bars: [], error: null }),
      },
    );

    assert.equal(out.success, true, "a real empty response is not an outage");
    assert.equal((out.data as unknown[]).length, 0);
    assert.equal(md(out).count, 0);
    assert.equal(md(out).sourceError, undefined);
  });
});

// ── preserved happy paths + guards ─────────────────────────────────────────────

describe("resolvePriceHistory — live success + guards", () => {
  it("DB miss + live bars → success:true with the live bars (source:yahoo)", async () => {
    const out = await resolvePriceHistory(
      { symbol: "TCS.NS" },
      {
        readDb: async () => [],
        fetchLive: async () => ({
          bars: [bar("2026-03-03", 5.5)],
          error: null,
        }),
      },
    );
    assert.equal(out.success, true);
    const data = out.data as Array<Record<string, unknown>>;
    assert.equal(data.length, 1);
    assert.equal(data[0]!.close, 5.5);
    assert.equal(data[0]!.date, "2026-03-03");
    assert.equal(md(out).source, "yahoo");
    assert.equal(md(out).count, 1);
  });

  it("errors when symbol is missing (real execute() wrapper, no DB/network)", async () => {
    const out = await fetchPriceHistoryTool.execute({});
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /symbol is required/);
  });

  it("tool metadata is unchanged", () => {
    assert.equal(fetchPriceHistoryTool.name, "fetch_price_history");
    assert.equal(fetchPriceHistoryTool.category, "data");
    assert.equal(fetchPriceHistoryTool.cacheTTL, 3600);
  });
});

// ── readDbPriceBars seam (mirrors the chart's InstrumentMapping→DailyPrice read) ──

describe("readDbPriceBars — DB seam", () => {
  it("resolves the instrument by yahooSymbol and reads DailyPrice by instrumentId + date range", async () => {
    let findUniqueArgs: unknown;
    let findManyArgs: unknown;
    const rows = [bar("2026-01-01", 11), bar("2026-01-02", 12)];

    const out = await readDbPriceBars(
      "RELIANCE.NS",
      new Date("2025-01-01T00:00:00Z"),
      new Date("2026-01-03T00:00:00Z"),
      fakePrisma({
        instrument: { id: "inst-9" },
        rows,
        onFindUnique: (a) => (findUniqueArgs = a),
        onFindMany: (a) => (findManyArgs = a),
      }),
    );

    assert.equal(out.length, 2);
    assert.equal(out[0]!.close, 11);
    assert.ok(out[0]!.date instanceof Date, "raw bars keep Date-typed dates");

    const fu = findUniqueArgs as { where: { yahooSymbol: string } };
    assert.equal(fu.where.yahooSymbol, "RELIANCE.NS");

    const fm = findManyArgs as {
      where: { instrumentId: string; date: { gte: Date; lte: Date } };
      orderBy: { date: string };
    };
    assert.equal(fm.where.instrumentId, "inst-9");
    assert.equal(fm.orderBy.date, "asc");
    assert.ok(fm.where.date.gte instanceof Date);
    assert.ok(fm.where.date.lte instanceof Date);
  });

  it("returns [] on a DB miss (no instrument mapped)", async () => {
    const out = await readDbPriceBars(
      "UNKNOWN.NS",
      new Date("2025-01-01"),
      new Date("2026-01-01"),
      fakePrisma({ instrument: null }),
    );
    assert.deepEqual(out, []);
  });

  it("never throws — a DB error is a miss ([]), letting the caller go live", async () => {
    const out = await readDbPriceBars(
      "RELIANCE.NS",
      new Date("2025-01-01"),
      new Date("2026-01-01"),
      fakePrisma({ instrument: { id: "inst-1" }, throwFindMany: true }),
    );
    assert.deepEqual(out, []);
  });
});

// ── fetchLivePriceBars seam (RC4 root cause: the REAL fetchChart + withExchangeFallback SWALLOW) ──

describe("fetchLivePriceBars — real swallow-path wiring (onError observer)", () => {
  it("production shape: chartFetch returns EMPTY + reports via onError (never throws) → error captured", async () => {
    // This is what the REAL yahooFetchChart does on an outage: catch → log →
    // return []. The old catch-based plumbing never saw it; the onError
    // observer must.
    const seen: string[] = [];
    const r = await fetchLivePriceBars(
      "RELIANCE.NS",
      new Date(0),
      new Date(),
      "1d",
      async (s, _o, fetchOpts) => {
        seen.push(s);
        fetchOpts?.onError?.(new Error("Yahoo Finance API error: 503"));
        return []; // swallow-shaped: empty result, NO throw
      },
    );
    // .NS missed → the alternate .BO exchange is still tried.
    assert.deepEqual(seen, ["RELIANCE.NS", "RELIANCE.BO"]);
    assert.equal(r.bars.length, 0);
    assert.ok(r.error instanceof Error, "outage must be captured, not lost");
    assert.equal(r.error?.message, "Yahoo Finance API error: 503");
  });

  it("production shape: primary swallow-empty but alternate exchange has bars → data wins, error cleared", async () => {
    const r = await fetchLivePriceBars(
      "TCS.NS",
      new Date(0),
      new Date(),
      "1d",
      async (s, _o, fetchOpts) => {
        if (s.endsWith(".NS")) {
          fetchOpts?.onError?.(new Error("ns 503"));
          return [];
        }
        return [bar("2026-06-01", 15)];
      },
    );
    assert.equal(r.bars.length, 1);
    assert.equal(r.error, null, "got data → the earlier capture is ignored");
  });

  it("both exchanges throw → bars:[] with the error captured (not a silent empty)", async () => {
    const r = await fetchLivePriceBars(
      "RELIANCE.NS",
      new Date(0),
      new Date(),
      "1d",
      async () => {
        throw new Error("network down");
      },
    );
    assert.equal(r.bars.length, 0);
    assert.ok(r.error instanceof Error);
    assert.equal(r.error?.message, "network down");
  });

  it("first exchange throws but alternate succeeds → bars returned, error cleared", async () => {
    const r = await fetchLivePriceBars(
      "TCS.NS",
      new Date(0),
      new Date(),
      "1d",
      async (s) => {
        if (s.endsWith(".NS")) throw new Error("ns down");
        return [bar("2026-06-01", 15)];
      },
    );
    assert.equal(r.bars.length, 1);
    assert.equal(r.bars[0]!.close, 15);
    assert.equal(
      r.error,
      null,
      "got data on the alternate exchange → no error",
    );
  });

  it("live returns real bars → passthrough with no error", async () => {
    const r = await fetchLivePriceBars(
      "INFY.NS",
      new Date(0),
      new Date(),
      "1d",
      async () => [bar("2026-06-02", 30), bar("2026-06-03", 31)],
    );
    assert.equal(r.bars.length, 2);
    assert.equal(r.error, null);
  });
});
