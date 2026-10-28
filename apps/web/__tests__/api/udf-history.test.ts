/**
 * TradingView UDF History Endpoint - CONTRACT tests.
 *
 * Imports the REAL exported pure helpers the GET /api/market/udf/history
 * handler calls (from `@/app/api/market/udf/history/route-logic`):
 *
 * - `tvResolutionToInterval` — TV resolution string → internal interval mapping
 * - `pickPeriodForRange`      — from/to ms range → Yahoo period bucket
 * - `barsToUdfOk`             — OHLCV bars → UDF column response (ms→**seconds**,
 *                              countback tail-slice — the most bug-prone path)
 * - `parseSymbolPrefix`       — "EXCHANGE:SYMBOL" split (defaults to NSE)
 * - `shouldReadSharedCache` / `shouldWriteSharedCache` — the MONEY-566
 *   Zerodha-compliance gate for the user-agnostic Redis cache.
 *
 * (Replaces the previous SHADOW version, which re-declared all of these inline —
 * including the COMPLIANCE truth table — and asserted the copies. The route now
 * calls these exports directly, so the invariant below guards production code.)
 *
 * Source: apps/web/app/api/market/udf/history/route.ts
 *         apps/web/app/api/market/udf/history/route-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HistoricalBar } from "@/lib/market/historical-fetcher";

import {
  tvResolutionToInterval,
  pickPeriodForRange,
  barsToUdfOk,
  parseSymbolPrefix,
  shouldReadSharedCache,
  shouldWriteSharedCache,
  isDailyPlusInterval,
  composeDailyPlusBars,
} from "@/app/api/market/udf/history/route-logic";

// ============== TEST HELPERS ==============

function makeBar(dateIso: string, value: number): HistoricalBar {
  return {
    date: new Date(dateIso),
    open: value,
    high: value + 1,
    low: value - 1,
    close: value + 0.5,
    volume: value * 100,
  };
}

// ============== tvResolutionToInterval ==============

describe("tvResolutionToInterval", () => {
  it("maps daily/weekly/monthly resolutions correctly", () => {
    assert.equal(tvResolutionToInterval("1D"), "1d");
    assert.equal(tvResolutionToInterval("D"), "1d");
    assert.equal(tvResolutionToInterval("1W"), "1wk");
    assert.equal(tvResolutionToInterval("W"), "1wk");
    assert.equal(tvResolutionToInterval("1M"), "1mo");
    assert.equal(tvResolutionToInterval("M"), "1mo");
  });

  it("maps numeric (minute) resolutions correctly", () => {
    assert.equal(tvResolutionToInterval("1"), "1m");
    assert.equal(tvResolutionToInterval("3"), "3m");
    assert.equal(tvResolutionToInterval("5"), "5m");
    assert.equal(tvResolutionToInterval("10"), "10m");
    assert.equal(tvResolutionToInterval("15"), "15m");
    assert.equal(tvResolutionToInterval("30"), "30m");
    assert.equal(tvResolutionToInterval("60"), "60m");
  });

  it("does NOT confuse uppercase 'M' (monthly) with numeric minutes", () => {
    assert.notEqual(tvResolutionToInterval("M"), "1m");
    assert.equal(tvResolutionToInterval("M"), "1mo");
  });

  it("returns null for unknown resolutions", () => {
    assert.equal(tvResolutionToInterval(""), null);
    assert.equal(tvResolutionToInterval("2"), null);
    assert.equal(tvResolutionToInterval("90"), null);
    assert.equal(tvResolutionToInterval("4H"), null);
    assert.equal(tvResolutionToInterval("1Y"), null);
  });

  it("trims whitespace before matching", () => {
    assert.equal(tvResolutionToInterval(" 1D "), "1d");
    assert.equal(tvResolutionToInterval("\t60\n"), "60m");
  });
});

// ============== pickPeriodForRange ==============

describe("pickPeriodForRange", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("picks 1d for ranges <= 1 day", () => {
    const now = Date.now();
    assert.equal(pickPeriodForRange(now - DAY_MS, now), "1d");
    assert.equal(pickPeriodForRange(now - DAY_MS * 0.5, now), "1d");
  });

  it("picks 5d for ranges <= 5 days", () => {
    const now = Date.now();
    assert.equal(pickPeriodForRange(now - DAY_MS * 3, now), "5d");
    assert.equal(pickPeriodForRange(now - DAY_MS * 5, now), "5d");
  });

  it("picks 1mo for ranges <= 31 days", () => {
    const now = Date.now();
    assert.equal(pickPeriodForRange(now - DAY_MS * 10, now), "1mo");
    assert.equal(pickPeriodForRange(now - DAY_MS * 31, now), "1mo");
  });

  it("picks 1y for ranges 200-400 days", () => {
    const now = Date.now();
    assert.equal(pickPeriodForRange(now - DAY_MS * 365, now), "1y");
  });

  it("picks max for very large ranges", () => {
    const now = Date.now();
    assert.equal(pickPeriodForRange(now - DAY_MS * 5000, now), "max");
    assert.equal(pickPeriodForRange(0, now), "max");
  });
});

// ============== barsToUdfOk ==============

describe("barsToUdfOk", () => {
  it("converts ms timestamps to unix SECONDS (not ms)", () => {
    // The single most critical TV invariant - t[] must be seconds.
    const bars = [makeBar("2026-01-01T00:00:00Z", 100)];
    const out = barsToUdfOk(bars, null);
    assert.equal(out.s, "ok");
    assert.equal(out.t.length, 1);
    // 2026-01-01T00:00:00Z = 1767225600 seconds (1767225600000 ms)
    assert.equal(out.t[0], 1767225600);
    assert.notEqual(out.t[0], 1767225600000);
  });

  it("returns column-oriented arrays of equal length", () => {
    const bars = [
      makeBar("2026-01-01T00:00:00Z", 100),
      makeBar("2026-01-02T00:00:00Z", 110),
      makeBar("2026-01-03T00:00:00Z", 105),
    ];
    const out = barsToUdfOk(bars, null);
    assert.equal(out.t.length, 3);
    assert.equal(out.o.length, 3);
    assert.equal(out.h.length, 3);
    assert.equal(out.l.length, 3);
    assert.equal(out.c.length, 3);
    assert.equal(out.v.length, 3);
  });

  it("preserves OHLCV values in the right columns", () => {
    const bar: HistoricalBar = {
      date: new Date("2026-01-15T00:00:00Z"),
      open: 100.5,
      high: 105.25,
      low: 98.75,
      close: 103.0,
      volume: 1234567,
    };
    const out = barsToUdfOk([bar], null);
    assert.equal(out.o[0], 100.5);
    assert.equal(out.h[0], 105.25);
    assert.equal(out.l[0], 98.75);
    assert.equal(out.c[0], 103.0);
    assert.equal(out.v[0], 1234567);
  });

  it("honors countback by returning only the LAST N bars", () => {
    const bars = [
      makeBar("2026-01-01T00:00:00Z", 100),
      makeBar("2026-01-02T00:00:00Z", 110),
      makeBar("2026-01-03T00:00:00Z", 120),
      makeBar("2026-01-04T00:00:00Z", 130),
      makeBar("2026-01-05T00:00:00Z", 140),
    ];
    const out = barsToUdfOk(bars, 2);
    assert.equal(out.t.length, 2);
    assert.equal(out.o[0], 130); // Jan 4
    assert.equal(out.o[1], 140); // Jan 5
  });

  it("ignores countback when null or zero", () => {
    const bars = [
      makeBar("2026-01-01T00:00:00Z", 100),
      makeBar("2026-01-02T00:00:00Z", 110),
      makeBar("2026-01-03T00:00:00Z", 120),
    ];
    assert.equal(barsToUdfOk(bars, null).t.length, 3);
    assert.equal(barsToUdfOk(bars, 0).t.length, 3);
  });

  it("honors countback even when N exceeds the bar count", () => {
    const bars = [
      makeBar("2026-01-01T00:00:00Z", 100),
      makeBar("2026-01-02T00:00:00Z", 110),
    ];
    assert.equal(barsToUdfOk(bars, 100).t.length, 2);
  });

  it("handles empty input", () => {
    const out = barsToUdfOk([], null);
    assert.equal(out.s, "ok");
    assert.equal(out.t.length, 0);
    assert.equal(out.o.length, 0);
  });

  it("defaults missing volume to 0", () => {
    const bar = {
      date: new Date("2026-01-01T00:00:00Z"),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    } as HistoricalBar;
    const out = barsToUdfOk([bar], null);
    assert.equal(out.v[0], 0);
  });

  it("synthesized MF NAV bars (o=h=l=c=nav, v=0) round-trip to seconds", () => {
    // The MF branch synthesizes o=h=l=c=nav, v=0 then calls barsToUdfOk.
    const navBar: HistoricalBar = {
      date: new Date("2026-01-01T00:00:00.000Z"),
      open: 12.34,
      high: 12.34,
      low: 12.34,
      close: 12.34,
      volume: 0,
    };
    const out = barsToUdfOk([navBar], null);
    assert.equal(out.t[0], 1767225600); // seconds precision
    assert.equal(out.c[0], 12.34);
    assert.equal(out.v[0], 0);
  });
});

// ============== EXCHANGE:SYMBOL prefix parsing ==============

describe("parseSymbolPrefix (EXCHANGE:SYMBOL)", () => {
  it("parses NSE:TCS into NSE + TCS", () => {
    assert.deepEqual(parseSymbolPrefix("NSE:TCS"), {
      prefix: "NSE",
      rawSymbol: "TCS",
    });
  });

  it("parses BSE:HDFCBANK", () => {
    assert.deepEqual(parseSymbolPrefix("BSE:HDFCBANK"), {
      prefix: "BSE",
      rawSymbol: "HDFCBANK",
    });
  });

  it("parses MF:120503 (mutual fund schemeCode)", () => {
    assert.deepEqual(parseSymbolPrefix("MF:120503"), {
      prefix: "MF",
      rawSymbol: "120503",
    });
  });

  it("defaults to NSE when no prefix is supplied", () => {
    assert.deepEqual(parseSymbolPrefix("RELIANCE"), {
      prefix: "NSE",
      rawSymbol: "RELIANCE",
    });
  });

  it("handles a symbol that is just a digit after the colon", () => {
    assert.deepEqual(parseSymbolPrefix("MF:0"), {
      prefix: "MF",
      rawSymbol: "0",
    });
  });
});

// ====== Shared-cache participation policy (MONEY-566 Zerodha compliance) ======
//
// The route now calls shouldReadSharedCache / shouldWriteSharedCache directly,
// so this truth table guards the real production gate. The compliance invariant
// is: there is NO row where a Zerodha-sourced payload is written to the
// user-agnostic shared cache, and no active-broker user ever participates.

describe("shared-cache READ gate", () => {
  it("active-broker users BYPASS the shared cache read (fetch fresh Zerodha)", () => {
    assert.equal(
      shouldReadSharedCache({ countback: null, brokerStatus: "active" }),
      false
    );
  });

  it("no-broker and needs_reauth users READ the shared (Yahoo) cache", () => {
    assert.equal(
      shouldReadSharedCache({ countback: null, brokerStatus: "none" }),
      true
    );
    assert.equal(
      shouldReadSharedCache({ countback: null, brokerStatus: "needs_reauth" }),
      true
    );
  });

  it("countback polls always bypass the read regardless of broker", () => {
    assert.equal(
      shouldReadSharedCache({ countback: 2, brokerStatus: "none" }),
      false
    );
    assert.equal(
      shouldReadSharedCache({ countback: 2, brokerStatus: "active" }),
      false
    );
  });
});

describe("shared-cache WRITE gate (Zerodha must never be cached)", () => {
  it("INVARIANT: a Zerodha-sourced payload is NEVER written, for ANY broker status", () => {
    for (const brokerStatus of ["active", "needs_reauth", "none"]) {
      assert.equal(
        shouldWriteSharedCache({
          payloadKind: "ok",
          countback: null,
          brokerStatus,
          source: "zerodha",
        }),
        false,
        `zerodha source must not be cached (brokerStatus=${brokerStatus})`
      );
    }
  });

  it("active-broker users never write to the shared cache, even on Yahoo fallback", () => {
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "ok",
        countback: null,
        brokerStatus: "active",
        source: "yahoo",
      }),
      false
    );
  });

  it("no-broker Yahoo bars ARE cached (the shared-cache happy path)", () => {
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "ok",
        countback: null,
        brokerStatus: "none",
        source: "yahoo",
      }),
      true
    );
  });

  it("public non-Yahoo sources (intraday-db ingest, MF NAV/no_data) are cacheable for no-broker users", () => {
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "ok",
        countback: null,
        brokerStatus: "none",
        source: "intraday-db",
      }),
      true
    );
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "ok",
        countback: null,
        brokerStatus: "none",
        source: undefined,
      }),
      true
    );
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "no_data",
        countback: null,
        brokerStatus: "none",
        source: undefined,
      }),
      true
    );
  });

  it("error payloads and countback polls are never written", () => {
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "error",
        countback: null,
        brokerStatus: "none",
        source: "yahoo",
      }),
      false
    );
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "ok",
        countback: 2,
        brokerStatus: "none",
        source: "yahoo",
      }),
      false
    );
  });
});

// ============== MONEY-1382: live sessions bypass the shared cache ==============
//
// A daily window that reaches today's session while it trades carries a candle
// rebuilt from a quote on every request. The shared cache's in-session TTL is
// 5 minutes; such a response may live 60 s. So it is neither read nor written.

describe("shared cache — a live session is never cached", () => {
  it("READ is bypassed for a live-session window, whoever asks", () => {
    assert.equal(
      shouldReadSharedCache({
        countback: null,
        brokerStatus: "none",
        liveSession: true,
      }),
      false
    );
  });

  it("WRITE is refused for a live-session window — the ALLOWED path (no-broker, Yahoo)", () => {
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "ok",
        countback: null,
        brokerStatus: "none",
        source: "yahoo",
        liveSession: true,
      }),
      false
    );
  });

  it("outside a live session the happy path still caches", () => {
    assert.equal(
      shouldWriteSharedCache({
        payloadKind: "ok",
        countback: null,
        brokerStatus: "none",
        source: "yahoo",
        liveSession: false,
      }),
      true
    );
  });
});

// ============== MONEY-1382: 1D / 1W / 1M from ONE daily series ==============

const D = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const ms = (iso: string): number => new Date(iso).getTime();
function ohlcv(
  iso: string,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number
): HistoricalBar {
  return { date: D(iso), open: o, high: h, low: l, close: c, volume: v };
}

describe("isDailyPlusInterval — an ALLOW list", () => {
  it("admits exactly 1d / 1wk / 1mo", () => {
    for (const i of ["1d", "1wk", "1mo"])
      assert.equal(isDailyPlusInterval(i), true);
  });

  it("refuses every minute interval, including the 3m/10m core's list omits", () => {
    for (const i of ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1h"]) {
      assert.equal(isDailyPlusInterval(i), false, i);
    }
  });
});

describe("composeDailyPlusBars — adjust EACH SESSION, THEN aggregate", () => {
  // 1:2 split, ex-date Wed 2026-06-10 — in the MIDDLE of the week of 06-08.
  const steps = [{ before: D("2026-06-10"), factor: 2 }];
  const days = [
    ohlcv("2026-06-01", 190, 200, 188, 198, 100),
    ohlcv("2026-06-08", 200, 210, 195, 205, 100), // raw, pre-split
    ohlcv("2026-06-09", 205, 220, 200, 210, 100), // raw, pre-split
    ohlcv("2026-06-10", 105, 108, 100, 104, 200), // ex-date
    ohlcv("2026-06-11", 104, 106, 101, 103, 200),
  ];

  it("a week straddling an ex-date is built from ADJUSTED sessions", () => {
    const out = composeDailyPlusBars({
      days,
      interval: "1wk",
      fromMs: ms("2026-06-01T00:00:00Z"),
      toMs: ms("2026-06-12T23:59:59Z"),
      steps,
      liveBar: null,
    });
    assert.equal(out.length, 2);
    // Adjust-then-resample: Mon/Tue halved, then aggregated. Resample-then-
    // adjust would halve the whole week (low 50, close 51.5, volume 1200).
    const { date, open, high, low, close, volume } = out[1]!;
    assert.deepEqual(
      { date, open, high, low, close, volume },
      {
        date: D("2026-06-08"),
        open: 100,
        high: 110,
        low: 97.5,
        close: 103,
        volume: 800,
      }
    );
  });

  it("a week whose first session precedes `from` is left to the older window", () => {
    const out = composeDailyPlusBars({
      days,
      interval: "1wk",
      fromMs: ms("2026-06-03T00:00:00Z"),
      toMs: ms("2026-06-12T23:59:59Z"),
      steps,
      liveBar: null,
    });
    assert.deepEqual(
      out.map((b) => b.date.toISOString().slice(0, 10)),
      ["2026-06-08"]
    );
  });

  it("1d filters to the requested window", () => {
    const out = composeDailyPlusBars({
      days,
      interval: "1d",
      fromMs: ms("2026-06-09T00:00:00Z"),
      toMs: ms("2026-06-10T23:59:59Z"),
      steps: [],
      liveBar: null,
    });
    assert.deepEqual(
      out.map((b) => b.date.toISOString().slice(0, 10)),
      ["2026-06-09", "2026-06-10"]
    );
  });
});

describe("composeDailyPlusBars — today's candle", () => {
  const yesterday = ohlcv("2026-06-11", 104, 106, 101, 103, 200);
  const live: HistoricalBar = {
    ...ohlcv("2026-06-12", 103, 107, 102, 106, 50),
    source: "LIVE",
  } as HistoricalBar;
  const window = {
    fromMs: ms("2026-06-01T00:00:00Z"),
    toMs: ms("2026-06-12T08:00:00Z"),
  };

  it("is appended when the series ends yesterday", () => {
    const out = composeDailyPlusBars({
      days: [yesterday],
      interval: "1d",
      ...window,
      steps: [],
      liveBar: live,
    });
    assert.deepEqual(
      out.map((b) => [b.date.toISOString().slice(0, 10), b.close]),
      [
        ["2026-06-11", 103],
        ["2026-06-12", 106],
      ]
    );
  });

  it("is NEVER duplicated — a row that already holds today wins", () => {
    const storedToday = ohlcv("2026-06-12", 103, 105, 102, 104, 40);
    const out = composeDailyPlusBars({
      days: [yesterday, storedToday],
      interval: "1d",
      ...window,
      steps: [],
      liveBar: live,
    });
    const today = out.filter(
      (b) => b.date.toISOString().slice(0, 10) === "2026-06-12"
    );
    assert.equal(today.length, 1, "two bars for one session");
    assert.equal(today[0]!.close, 104);
  });

  it("is not served to a backward-scroll window that ends before today", () => {
    const out = composeDailyPlusBars({
      days: [yesterday],
      interval: "1d",
      fromMs: ms("2026-06-01T00:00:00Z"),
      toMs: ms("2026-06-11T23:59:59Z"),
      steps: [],
      liveBar: live,
    });
    assert.deepEqual(
      out.map((b) => b.date.toISOString().slice(0, 10)),
      ["2026-06-11"]
    );
  });

  it("is adjusted WITH the series — a forthcoming ex-date divides it too, no spike", () => {
    // NSE publishes ex-dates ahead; the whole series is divided by it today.
    const out = composeDailyPlusBars({
      days: [yesterday],
      interval: "1d",
      ...window,
      steps: [{ before: D("2026-06-15"), factor: 5 }],
      liveBar: live,
    });
    assert.deepEqual(
      out.map((b) => b.close),
      [103 / 5, 106 / 5]
    );
  });

  it("merges into the current week rather than standing alone", () => {
    const out = composeDailyPlusBars({
      days: [ohlcv("2026-06-08", 100, 104, 99, 102, 10), yesterday],
      interval: "1wk",
      ...window,
      steps: [],
      liveBar: live,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.close, 106);
    assert.equal(out[0]!.high, 107);
    assert.equal(out[0]!.volume, 260);
  });
});
