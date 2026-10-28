/**
 * MONEY-980 — Candle warehouse pure logic.
 *
 * The properties asserted here are the ones whose failure is INVISIBLE: a
 * concatenated price series, a silently shortened chart, a duplicate that
 * aborts a whole write chunk. None of them throw in production; they just draw
 * a wrong line.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  candleKey,
  marketForExchange,
  buildCandleColdKey,
  coldYearsForRange,
  sniffColdShardFormat,
  encodeColdShard,
  decodeColdShard,
  resolveColdShardFormat,
  coldShardContentType,
  CANDLE_COLD_CONTENT_TYPE,
  mergeHotAndCold,
  sliceRange,
  selectSingleListing,
  adjustCandleSeries,
  sanitizeCandleWrites,
  partitionCandleWrites,
  groupWritesBySeries,
  chunk,
  barMatchesVenue,
  newestTsForVenue,
  classifyCandleRowWriteError,
  hotWindowFloorYear,
  intradayHotFloorTs,
  isActiveListing,
  isIntradayTimeframe,
  resolveCandleDestination,
  partitionCandlesByDestination,
  groupColdShards,
  mergeColdBars,
  toColdBar,
  HOT_WINDOW_YEARS,
  INTRADAY_HOT_WINDOW_DAYS,
  INTRADAY_TIMEFRAMES,
  type CandleBar,
  type NormalizedCandleWrite,
} from "../../src/market-data/candles/candle-logic";

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

function bar(over: Partial<CandleBar> & { ts: Date }): CandleBar {
  return {
    symbol: "AAPL",
    exchange: "NASDAQ",
    timeframe: "D1",
    listingId: "AAPL:NASDAQ:1980-12-12",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1000,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    ...over,
  };
}

describe("cold shard codec", () => {
  test("round-trips a bar whose volume exceeds Int32", async () => {
    // US composite volume clears Int32, and a raw bigint makes JSON.stringify
    // throw — so this is the case that breaks a naive codec.
    const bars = [bar({ ts: d("2020-01-02"), volume: 4_000_000_000 })];
    const back = await decodeColdShard(await encodeColdShard(bars));
    assert.equal(back.length, 1);
    assert.equal(back[0]!.volume, 4_000_000_000);
    assert.equal(back[0]!.ts.toISOString(), d("2020-01-02").toISOString());
  });

  test("gzip and parquet are told apart by their magic bytes", async () => {
    assert.equal(
      sniffColdShardFormat(
        await encodeColdShard([bar({ ts: d("2020-01-02") })]),
      ),
      "JSONL_GZ",
    );
    assert.equal(sniffColdShardFormat(Buffer.from("PAR1sometail")), "PARQUET");
    assert.equal(
      sniffColdShardFormat(
        await encodeColdShard([bar({ ts: d("2020-01-02") })], "PARQUET"),
      ),
      "PARQUET",
    );
    // The point of sniffing: an unknown format must fail loudly rather than
    // parse garbage into plausible-looking prices. `PAR1sometail` sniffs as
    // parquet and is then REFUSED by the decoder ("footer != PAR1") — a
    // truncated shard must not read as a short year.
    await assert.rejects(() => decodeColdShard(Buffer.from("PAR1sometail")));
    await assert.rejects(() =>
      decodeColdShard(Buffer.from("not a shard at all")),
    );
  });

  test("an empty shard round-trips to an empty series, in BOTH formats", async () => {
    assert.deepEqual(await decodeColdShard(await encodeColdShard([])), []);
    // Measured: a zero-row parquet file is 162 bytes and still carries both
    // PAR1 markers, so an empty year is representable rather than a write that
    // throws and leaves the caller to invent a fallback.
    assert.deepEqual(
      await decodeColdShard(await encodeColdShard([], "PARQUET")),
      [],
    );
  });

  test("parquet carries EVERY ColdShardRow field, ts ascending", async () => {
    // The whole schema, not a sampled subset: a column silently dropped by the
    // writer decodes as a `null` the row mapper turns into 0 (`divCash`) or 1
    // (`splitFactor`) — a plausible number, never an error.
    const bars = [
      bar({
        ts: d("2020-03-02"),
        symbol: "BRKB",
        exchange: "NYSE",
        listingId: "BRKB:NYSE:1996-05-09",
        open: 1.5,
        high: 2.25,
        low: 1.125,
        close: 2,
        volume: 4_000_000_000,
        divCash: 0.22,
        splitFactor: 7,
        source: "DATABENTO",
      }),
      bar({ ts: d("2020-01-02"), symbol: "BRKB", exchange: "NYSE" }),
    ];
    const body = await encodeColdShard(bars, "PARQUET");
    assert.equal(body.subarray(0, 4).toString("latin1"), "PAR1");
    assert.equal(body.subarray(-4).toString("latin1"), "PAR1");

    const back = await decodeColdShard(body);
    assert.equal(back.length, 2);
    // Ascending, though they were handed over out of order.
    assert.deepEqual(
      back.map((b) => b.ts.toISOString()),
      [d("2020-01-02").toISOString(), d("2020-03-02").toISOString()],
    );
    const b = back[1]!;
    assert.deepEqual(
      {
        symbol: b.symbol,
        exchange: b.exchange,
        timeframe: b.timeframe,
        listingId: b.listingId,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        divCash: b.divCash,
        splitFactor: b.splitFactor,
        source: b.source,
      },
      {
        symbol: "BRKB",
        exchange: "NYSE",
        timeframe: "D1",
        listingId: "BRKB:NYSE:1996-05-09",
        open: 1.5,
        high: 2.25,
        low: 1.125,
        close: 2,
        volume: 4_000_000_000,
        divCash: 0.22,
        splitFactor: 7,
        source: "DATABENTO",
      },
    );
  });

  test("a parquet shard decodes from a POOLED Buffer, offset and all", async () => {
    // Node allocates Buffers under 4 KB out of an 8 KB shared pool, so a shard
    // arriving from GCS very often has a NON-ZERO `byteOffset` into an
    // ArrayBuffer that also holds unrelated allocations. Handing hyparquet
    // `body.buffer` would read a neighbour's bytes; this pins that the reader
    // slices through the Buffer's own view.
    const flat = await encodeColdShard(
      [bar({ ts: d("2020-01-02"), close: 42 })],
      "PARQUET",
    );
    const pooled = Buffer.allocUnsafe(flat.length + 64).subarray(
      64,
      64 + flat.length,
    );
    flat.copy(pooled);
    assert.notEqual(
      pooled.byteOffset,
      0,
      "the fixture must actually be offset",
    );

    const back = await decodeColdShard(pooled);
    assert.equal(back.length, 1);
    assert.equal(back[0]!.close, 42);
  });
});

describe("CANDLE_COLD_FORMAT — the write format is a per-call env read", () => {
  test("`parquet` selects parquet; anything else, unset included, is JSONL", () => {
    const saved = process.env.CANDLE_COLD_FORMAT;
    try {
      // Read PER CALL. A module-scope const would freeze at import — which on a
      // warm Cloud Run container turns a redeployed switch into no switch at
      // all — so the value MUST change between these calls without re-importing.
      delete process.env.CANDLE_COLD_FORMAT;
      assert.equal(resolveColdShardFormat(), "JSONL_GZ");

      process.env.CANDLE_COLD_FORMAT = "parquet";
      assert.equal(resolveColdShardFormat(), "PARQUET");

      process.env.CANDLE_COLD_FORMAT = "  PARQUET  ";
      assert.equal(resolveColdShardFormat(), "PARQUET");

      // Literal comparison, never Boolean(): `Boolean("false")` is true, which
      // would arm the switch in the one configuration meant to keep it off.
      for (const off of ["false", "true", "1", "jsonl", "gzip", ""]) {
        process.env.CANDLE_COLD_FORMAT = off;
        assert.equal(
          resolveColdShardFormat(),
          "JSONL_GZ",
          `${JSON.stringify(off)} must not select parquet`,
        );
      }
    } finally {
      if (saved === undefined) delete process.env.CANDLE_COLD_FORMAT;
      else process.env.CANDLE_COLD_FORMAT = saved;
    }
  });

  test("the content type follows the bytes, so a parquet object is not labelled gzip", () => {
    assert.equal(coldShardContentType("JSONL_GZ"), CANDLE_COLD_CONTENT_TYPE);
    assert.equal(coldShardContentType("JSONL_GZ"), "application/gzip");
    assert.equal(
      coldShardContentType("PARQUET"),
      "application/vnd.apache.parquet",
    );
  });
});

describe("the parquet codec must never reach the Vercel bundle", () => {
  test("hyparquet is imported DYNAMICALLY, inside its branch", () => {
    // `candle-logic.ts` is reachable from apps/web through the
    // `@usemoney/core/market-data` subpath, and apps/web deliberately never
    // registers a cold store — so the web can reach this MODULE and can never
    // reach the parquet BRANCH. A static import would ship 503 KB of codec
    // (hyparquet 284 KB + hyparquet-writer 219 KB, measured from the published
    // tarballs) into the bundle to serve a path that cannot execute there.
    //
    // LINE COMMENTS BEFORE BLOCK COMMENTS (MONEY-1143): strip blocks first and
    // a `//` line containing a `/*` opens a phantom block running to the next
    // `*/` hundreds of lines away. This scan asserts an ABSENCE, which is the
    // one shape where eaten text and a healthy property are indistinguishable.
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "market-data",
        "candles",
        "candle-logic.ts",
      ),
      "utf8",
    );
    const code = src
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // The comments name hyparquet repeatedly; the CODE must mention it exactly
    // twice, and both times as an awaited dynamic import.
    assert.equal(
      /^\s*import\s[^\n]*from\s*["']hyparquet/m.test(code),
      false,
      "no top-level import of the parquet codec",
    );
    assert.deepEqual(
      code.match(/await import\("hyparquet(?:-writer)?"\)/g),
      ['await import("hyparquet-writer")', 'await import("hyparquet")'],
      "both codec halves load dynamically, encoder first",
    );
    assert.equal(
      (code.match(/hyparquet/g) ?? []).length,
      2,
      "hyparquet appears in the CODE only at those two dynamic imports",
    );

    // POSITION, not just presence. The three assertions above are all satisfied
    // by hoisting BOTH imports to module scope as top-level awaits — legal
    // here, since `packages/core` is `"type": "module"` with `module: ESNext` —
    // which loads the codec on every import of this file while every scan stays
    // green. So slice each function body and require the import to sit INSIDE
    // it.
    //
    // GUARD BOTH BOUNDS. `indexOf` returning -1 does not give an empty slice,
    // it gives a WIDER one: `slice(-1)` is the last character and `slice(a, -1)`
    // runs to one before the end — so a renamed function would silently widen
    // the window to most of the file and pass. Assert both offsets first.
    const body = (open: string, close: string): string => {
      const from = code.indexOf(open);
      const to = code.indexOf(close, from + 1);
      assert.ok(from >= 0, `anchor not found: ${open}`);
      assert.ok(to > from, `end anchor not found after ${open}: ${close}`);
      return code.slice(from, to);
    };

    const encode = body(
      "async function encodeColdShardParquet(",
      "async function decodeColdShardParquet(",
    );
    const decode = body(
      "async function decodeColdShardParquet(",
      "export async function encodeColdShard(",
    );

    assert.match(encode, /await import\("hyparquet-writer"\)/);
    assert.match(decode, /await import\("hyparquet"\)/);
    // And NOTHING before the first branch may mention it, which is what a
    // hoisted top-level await would violate.
    assert.equal(
      code
        .slice(0, code.indexOf("async function encodeColdShardParquet("))
        .includes("hyparquet"),
      false,
      "the codec is named only inside the two branches, never at module scope",
    );
  });
});

describe("cold key layout", () => {
  test("keys by market/timeframe/symbol/year with no extension", () => {
    // No extension on purpose: the format is an implementation detail behind
    // the repository seam, so a later parquet writer reuses these exact keys.
    const key = buildCandleColdKey({
      market: marketForExchange("NASDAQ"),
      timeframe: "D1",
      symbol: "AAPL",
      year: 2019,
    });
    assert.equal(key, "candles/US/D1/AAPL/2019");
    assert.ok(!key.includes("."), "cold key must carry no format extension");
  });

  test("a missing or malformed segment throws instead of collapsing the key", () => {
    // `candles//D1/AAPL/2019` is a valid GCS key that nothing computes and no
    // prefix lists — the reshape is silent, so the guard must be loud.
    const base = { timeframe: "D1", symbol: "AAPL", year: 2019 };
    assert.throws(() =>
      buildCandleColdKey({ ...base, market: undefined as unknown as string }),
    );
    assert.throws(() => buildCandleColdKey({ ...base, market: "" }));
    assert.throws(() => buildCandleColdKey({ ...base, market: "US/extra" }));
    assert.throws(() =>
      buildCandleColdKey({
        market: "US",
        timeframe: "D1",
        symbol: "AA/PL",
        year: 2019,
      }),
    );
    // A dash must still be legal: BRK-A and SPG-P-J are ordinary tickers.
    assert.equal(
      buildCandleColdKey({
        market: "US",
        timeframe: "D1",
        symbol: "SPG-P-J",
        year: 2019,
      }),
      "candles/US/D1/SPG-P-J/2019",
    );
  });

  test("US venues all map to one market", () => {
    for (const ex of ["NASDAQ", "NYSE", "AMEX", "NYSE ARCA", "BATS"]) {
      assert.equal(marketForExchange(ex), "US", ex);
    }
  });

  test("year range is inclusive at both ends", () => {
    assert.deepEqual(
      coldYearsForRange(d("2018-06-01"), d("2021-02-01")),
      [2018, 2019, 2020, 2021],
    );
    assert.deepEqual(
      coldYearsForRange(d("2020-01-01"), d("2020-12-31")),
      [2020],
    );
  });
});

describe("selectSingleListing — the DOW hazard", () => {
  const chem = "DOW:NYSE:1972-06-01";
  const inc = "DOW:NYSE:2019-03-20";
  const mixed: CandleBar[] = [
    bar({
      ts: d("2015-01-02"),
      symbol: "DOW",
      exchange: "NYSE",
      listingId: chem,
    }),
    bar({
      ts: d("2016-01-04"),
      symbol: "DOW",
      exchange: "NYSE",
      listingId: chem,
    }),
    bar({
      ts: d("2020-01-02"),
      symbol: "DOW",
      exchange: "NYSE",
      listingId: inc,
    }),
  ];

  test("never returns two companies in one series", () => {
    const sel = selectSingleListing(mixed, inc, "explicit");
    assert.equal(sel.bars.length, 1);
    assert.equal(sel.dropped, 2);
    assert.ok(sel.bars.every((b) => b.listingId === inc));
  });

  test("an EXPLICIT id with no bars returns empty rather than another company", () => {
    // The caller asserted which security it wanted. Substituting a different
    // one is precisely the corruption this function exists to prevent.
    const sel = selectSingleListing(mixed, "DOW:NYSE:1899-01-01", "explicit");
    assert.deepEqual(sel.bars, []);
  });

  test("a STALE instrument hint falls through instead of blanking the chart", () => {
    // InstrumentMapping is unique on (symbol, exchange) so it can hold only ONE
    // window; a hint that matches nothing is stale, not authoritative.
    const sel = selectSingleListing(mixed, "DOW:NYSE:1899-01-01", "instrument");
    assert.ok(sel.bars.length > 0, "a stale hint must not blank a held series");
    const ids = new Set(sel.bars.map((b) => b.listingId));
    assert.equal(ids.size, 1, "still exactly one listing, never a merge");
  });

  test("with no preference it still returns a single listing", () => {
    const sel = selectSingleListing(mixed, null, "instrument");
    assert.equal(new Set(sel.bars.map((b) => b.listingId)).size, 1);
  });

  test("empty input is empty output", () => {
    assert.deepEqual(selectSingleListing([], inc, "explicit").bars, []);
  });
});

describe("merge and slice", () => {
  test("hot wins over cold for the same bar", () => {
    const cold = [bar({ ts: d("2020-01-02"), close: 100 })];
    const hot = [bar({ ts: d("2020-01-02"), close: 111 })];
    const merged = mergeHotAndCold(hot, cold);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.close, 111, "the hot store is the fresher copy");
  });

  test("merge returns one ascending series", () => {
    const merged = mergeHotAndCold(
      [bar({ ts: d("2021-01-04") })],
      [bar({ ts: d("2019-01-02") }), bar({ ts: d("2020-01-02") })],
    );
    assert.equal(merged.length, 3);
    for (let i = 1; i < merged.length; i++) {
      assert.ok(merged[i - 1]!.ts <= merged[i]!.ts);
    }
  });

  test("sliceRange is inclusive of both bounds", () => {
    const bars = ["2020-01-01", "2020-06-01", "2021-01-01"].map((x) =>
      bar({ ts: d(x) }),
    );
    assert.equal(sliceRange(bars, d("2020-01-01"), d("2021-01-01")).length, 3);
    assert.equal(sliceRange(bars, d("2020-02-01"), d("2020-12-31")).length, 1);
  });
});

describe("adjustCandleSeries", () => {
  test("a 2:1 split halves earlier prices and doubles earlier volume", () => {
    const bars = [
      bar({
        ts: d("2020-01-02"),
        close: 100,
        open: 100,
        high: 100,
        low: 100,
        volume: 1000,
      }),
      bar({
        ts: d("2020-01-03"),
        close: 50,
        open: 50,
        high: 50,
        low: 50,
        volume: 2000,
        splitFactor: 2,
      }),
    ];
    const adj = adjustCandleSeries(bars);
    assert.equal(adj[1]!.adjClose, 50, "the latest bar is never adjusted");
    assert.ok(Math.abs(adj[0]!.adjClose - 50) < 1e-9);
    assert.ok(Math.abs(adj[0]!.adjVolume - 2000) < 1);
  });

  test("adjusts correctly regardless of input order", () => {
    const asc = [
      bar({ ts: d("2020-01-02"), close: 100 }),
      bar({ ts: d("2020-01-03"), close: 50, splitFactor: 2 }),
    ];
    const desc = [...asc].reverse();
    assert.deepEqual(
      adjustCandleSeries(asc).map((b) => b.adjClose),
      adjustCandleSeries(desc).map((b) => b.adjClose),
    );
  });
});

describe("sanitizeCandleWrites — non-finite money never reaches the DB", () => {
  test("drops NaN and Infinity prices instead of storing them", () => {
    const res = sanitizeCandleWrites([
      {
        symbol: "A",
        exchange: "NYSE",
        timeframe: "D1",
        ts: d("2020-01-02"),
        listingId: "A:NYSE:2000-01-01",
        open: NaN,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      },
      {
        symbol: "A",
        exchange: "NYSE",
        timeframe: "D1",
        ts: d("2020-01-03"),
        listingId: "A:NYSE:2000-01-01",
        open: 1,
        high: 1,
        low: 1,
        close: Infinity,
        volume: 1,
      },
      {
        symbol: "A",
        exchange: "NYSE",
        timeframe: "D1",
        ts: d("2020-01-06"),
        listingId: "A:NYSE:2000-01-01",
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 1,
      },
    ]);
    assert.equal(res.rows.length, 1);
    assert.equal(res.droppedNonFinite, 2);
  });

  test("accepts a bigint volume without corrupting it", () => {
    const res = sanitizeCandleWrites([
      {
        symbol: "A",
        exchange: "NYSE",
        timeframe: "D1",
        ts: d("2020-01-02"),
        listingId: "A:NYSE:2000-01-01",
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 4_000_000_000n,
      },
    ]);
    assert.equal(res.rows.length, 1);
    assert.equal(Number(res.rows[0]!.volume), 4_000_000_000);
  });
});

describe("partitionCandleWrites — precedence and duplicates", () => {
  // `volume` is BigInt on a NORMALIZED write, and that is the whole point of
  // the type: `sanitizeCandleWrites` accepts `number | bigint` at the door and
  // hands back `bigint` so no consumer can mix the two in one arithmetic
  // expression. Typing the helper — rather than letting it infer `number` —
  // means a future field change fails here instead of being cast away.
  const row = (ts: string, source = "TIINGO"): NormalizedCandleWrite => ({
    symbol: "AAPL",
    exchange: "NASDAQ",
    timeframe: "D1",
    ts: d(ts),
    listingId: "AAPL:NASDAQ:1980-12-12",
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: BigInt(10),
    divCash: 0,
    splitFactor: 1,
    source,
    listingStatus: "ACTIVE",
    tier: null,
  });

  test("collapses an in-batch duplicate rather than aborting the chunk", () => {
    // One repeat reaching createMany throws the WHOLE chunk on Mongo, where
    // skipDuplicates does not exist.
    const p = partitionCandleWrites(
      [row("2020-01-02"), row("2020-01-02")],
      new Map(),
    );
    assert.equal(p.create.length, 1);
    assert.equal(p.dupInBatch, 1);
  });

  test("a stronger existing source is preserved, never overwritten", () => {
    const existing = new Map([
      [candleKey(row("2020-01-02")), { id: "x", source: "BHAVCOPY" }],
    ]);
    const p = partitionCandleWrites([row("2020-01-02")], existing);
    assert.equal(p.upgrade.length, 0);
    assert.equal(p.preserved, 1);
  });

  test("EQUAL authority does not overwrite, so a re-run is a no-op", () => {
    const existing = new Map([
      [candleKey(row("2020-01-02")), { id: "x", source: "TIINGO" }],
    ]);
    const p = partitionCandleWrites([row("2020-01-02")], existing);
    assert.equal(
      p.upgrade.length,
      0,
      "re-running the backfill must not rewrite",
    );
    assert.equal(p.preserved, 1);
  });

  test("a weaker existing source is upgraded", () => {
    const existing = new Map([
      [candleKey(row("2020-01-02")), { id: "x", source: "YAHOO" }],
    ]);
    const p = partitionCandleWrites([row("2020-01-02")], existing);
    assert.equal(p.upgrade.length, 1);
  });
});

describe("grouping and chunking", () => {
  test("groups by series and bounds each group's ts range", () => {
    const rows = sanitizeCandleWrites([
      {
        symbol: "A",
        exchange: "NYSE",
        timeframe: "D1",
        ts: d("2020-01-02"),
        listingId: "A:NYSE:2000-01-01",
        open: 1,
        high: 2,
        low: 0.5,
        close: 1,
        volume: 1,
      },
      {
        symbol: "A",
        exchange: "NYSE",
        timeframe: "D1",
        ts: d("2021-01-04"),
        listingId: "A:NYSE:2000-01-01",
        open: 1,
        high: 2,
        low: 0.5,
        close: 1,
        volume: 1,
      },
      {
        symbol: "B",
        exchange: "NYSE",
        timeframe: "D1",
        ts: d("2020-05-05"),
        listingId: "B:NYSE:2000-01-01",
        open: 1,
        high: 2,
        low: 0.5,
        close: 1,
        volume: 1,
      },
    ]).rows;
    const groups = groupWritesBySeries(rows);
    assert.equal(groups.length, 2);
    const a = groups.find((g) => g.symbol === "A")!;
    assert.equal(a.minTs.toISOString(), d("2020-01-02").toISOString());
    assert.equal(a.maxTs.toISOString(), d("2021-01-04").toISOString());
  });

  test("chunk covers every item exactly once", () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunk(items, 10);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.flat(), items);
  });
});

describe("newestTsForVenue — a cold shard holds EVERY venue the ticker traded on", () => {
  // The shard key is `candles/{market}/{timeframe}/{symbol}/{year}` — no
  // exchange — so these three rows are one perfectly ordinary object.
  const uplisted = [
    bar({ ts: d("2019-12-31"), exchange: "NASDAQ" }),
    bar({ ts: d("2019-03-01"), exchange: "NYSE" }),
    bar({ ts: d("2019-06-02"), exchange: "NYSE" }),
  ];

  test("returns the newest bar OF THE ASKED-FOR VENUE, not whichever row sorts first", () => {
    // The newest row in the object is NASDAQ and it is also `bars[0]`, which is
    // precisely the seed a filter-after-seed loop picks up. Asking for NYSE must
    // yield the newest NYSE bar; returning 2019-12-31 here is another security's
    // resume point wearing this one's name.
    const newest = newestTsForVenue(uplisted, {
      exchange: "NYSE",
      timeframe: "D1",
    });
    assert.equal(
      newest?.toISOString(),
      d("2019-06-02").toISOString(),
      "seeded from an unfiltered bar — a NASDAQ timestamp answered an NYSE probe",
    );
  });

  test("a shard with NO bars for the venue answers null, so the caller keeps walking years", () => {
    // `latestTs` walks candidate years newest-first and stops at the first
    // answer. A non-null answer from a shard that holds nothing for this venue
    // stops the walk at the wrong year and the real data is never reached — the
    // failure is a SHORT series, which draws a chart rather than an error.
    const nasdaqOnly = [
      bar({ ts: d("2019-12-31"), exchange: "NASDAQ" }),
      bar({ ts: d("2019-01-02"), exchange: "NASDAQ" }),
    ];
    assert.equal(
      newestTsForVenue(nasdaqOnly, { exchange: "NYSE", timeframe: "D1" }),
      null,
    );
  });

  test("narrows by timeframe too, so a mixed-timeframe object cannot interleave", () => {
    const mixed = [
      bar({ ts: d("2019-12-31"), timeframe: "H1" }),
      bar({ ts: d("2019-06-02"), timeframe: "D1" }),
    ];
    assert.equal(
      newestTsForVenue(mixed, {
        exchange: "NASDAQ",
        timeframe: "D1",
      })?.toISOString(),
      d("2019-06-02").toISOString(),
    );
  });

  test("the answer does not depend on the order the shard happens to be in", () => {
    const forward = newestTsForVenue(uplisted, {
      exchange: "NYSE",
      timeframe: "D1",
    });
    const reversed = newestTsForVenue([...uplisted].reverse(), {
      exchange: "NYSE",
      timeframe: "D1",
    });
    assert.equal(forward?.toISOString(), reversed?.toISOString());
  });

  test("an Invalid Date is skipped rather than handed back as a resume point", () => {
    // An `Invalid Date` returned here becomes a `ts` predicate that matches
    // nothing, which reads downstream as "no data" instead of "bad row".
    const withGarbage = [
      bar({ ts: new Date("not-a-date") }),
      bar({ ts: d("2019-06-02") }),
    ];
    const venue = { exchange: "NASDAQ", timeframe: "D1" };
    assert.equal(
      newestTsForVenue(withGarbage, venue)?.toISOString(),
      d("2019-06-02").toISOString(),
    );
    assert.equal(
      newestTsForVenue([bar({ ts: new Date("not-a-date") })], venue),
      null,
      "a shard of nothing but unparseable rows must not answer",
    );
  });

  test("a venue match needs BOTH exchange and timeframe", () => {
    const b = bar({ ts: d("2019-06-02"), exchange: "NYSE", timeframe: "D1" });
    assert.equal(
      barMatchesVenue(b, { exchange: "NYSE", timeframe: "D1" }),
      true,
    );
    assert.equal(
      barMatchesVenue(b, { exchange: "NASDAQ", timeframe: "D1" }),
      false,
    );
    assert.equal(
      barMatchesVenue(b, { exchange: "NYSE", timeframe: "H1" }),
      false,
    );
  });
});

describe("classifyCandleRowWriteError — a race is not a failure", () => {
  // The per-row fallback runs only AFTER a bulk collision, so its common input
  // is rows a concurrent writer already landed. Counting those as `failed`
  // raises the job's failure metric AND `owed` in the freshness monitor, with no
  // matching `written` — a page for correct behaviour.
  test("a Prisma unique-constraint violation is a no-op counted as preserved", () => {
    assert.equal(
      classifyCandleRowWriteError(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      ),
      "preserved",
    );
  });

  test("a raw Mongo E11000 that escaped Prisma's mapping is also preserved", () => {
    assert.equal(
      classifyCandleRowWriteError(
        Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }),
      ),
      "preserved",
    );
    assert.equal(
      classifyCandleRowWriteError({ code: "11000" }),
      "preserved",
      "the driver stringifies the code on some paths",
    );
  });

  test("every OTHER Prisma error is still a failure", () => {
    // P2025 = record not found, P2010 = raw query failed, P1001 = unreachable.
    // None of these mean the row is safely stored, so suppressing them would
    // turn a systematically failing write into a clean-looking run.
    for (const code of ["P2025", "P2010", "P1001", "P2002 "]) {
      assert.equal(
        classifyCandleRowWriteError(Object.assign(new Error("nope"), { code })),
        "failed",
        `${code} must not be swallowed`,
      );
    }
    assert.equal(
      classifyCandleRowWriteError(new Error("connection reset")),
      "failed",
    );
  });

  test("a message that merely SAYS duplicate is NOT enough", () => {
    // Codes only, deliberately. This classifier suppresses a failure count, so a
    // substring match on free text is the direction that loses writes silently;
    // an unrecognised duplicate merely keeps today's noisy-but-safe behaviour.
    assert.equal(
      classifyCandleRowWriteError(
        new Error("E11000 duplicate key error collection"),
      ),
      "failed",
    );
    assert.equal(
      classifyCandleRowWriteError("E11000 duplicate key error"),
      "failed",
      "a thrown string carries no code and must not be trusted",
    );
  });

  test("null, undefined and a thrown non-object are failures", () => {
    assert.equal(classifyCandleRowWriteError(null), "failed");
    assert.equal(classifyCandleRowWriteError(undefined), "failed");
    assert.equal(classifyCandleRowWriteError(42), "failed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TIER ROUTING (MONEY-980 C4)
//
// Before this, `writeColdShard` and `setCandleColdStore` were defined,
// exported and called by NOTHING — the cold tier had never executed in any
// runtime. So these cases are not defending a working rule from regression,
// they are the first thing that has ever exercised it, and they are written
// against the two ways it silently goes wrong: a boundary off by one year
// (invisible — a slightly shorter chart) and a clock read per row (invisible
// for 364 days a year).
// ───────────────────────────────────────────────────────────────────────────

const at = (iso: string): Date => new Date(iso);

/** A normalised write with everything defaulted except what a case is about. */
function writeRow(
  over: Partial<NormalizedCandleWrite> & { ts: Date },
): NormalizedCandleWrite {
  return {
    symbol: "AAPL",
    exchange: "NASDAQ",
    timeframe: "D1",
    listingId: "AAPL:NASDAQ:1980-12-12",
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: BigInt(10),
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    listingStatus: "ACTIVE",
    tier: null,
    ...over,
  };
}

describe("hotWindowFloorYear + isActiveListing", () => {
  test("the floor is current UTC year minus HOT_WINDOW_YEARS", () => {
    assert.equal(
      hotWindowFloorYear(at("2026-08-28T00:00:00Z")),
      2026 - HOT_WINDOW_YEARS,
    );
  });

  test("the year is read in UTC, not local time", () => {
    // 2026-12-31T23:00Z is 2027 in +02:00 and later. A boundary computed in a
    // different calendar than the rows it partitions puts 31 December on both
    // sides of itself — `buildFeedArchiveKey` had the mirror-image bug.
    assert.equal(hotWindowFloorYear(at("2026-12-31T23:59:59.999Z")), 2016);
    assert.equal(hotWindowFloorYear(at("2027-01-01T00:00:00.000Z")), 2017);
  });

  test("absent, null and empty all mean ACTIVE", () => {
    // The documented default. A bar arriving with no stated status comes from
    // the nightly, which only ever walks active listings.
    assert.equal(isActiveListing(undefined), true);
    assert.equal(isActiveListing(null), true);
    assert.equal(isActiveListing("   "), true);
  });

  test("the match is POSITIVE — an unknown status is not active", () => {
    // Cold is the conservative direction: a cold bar is archived and still
    // readable, whereas guessing "active" adds rows to the store whose size is
    // the entire design constraint.
    assert.equal(isActiveListing("ACTIVE"), true);
    assert.equal(isActiveListing(" active "), true);
    assert.equal(isActiveListing("DELISTED"), false);
    assert.equal(isActiveListing("SUSPENDED"), false);
    assert.equal(isActiveListing("ACTIVE_PENDING"), false);
  });
});

describe("resolveCandleDestination — a bar is HOT only if BOTH halves say so", () => {
  const now = at("2026-08-28T00:00:00Z");

  test("an ACTIVE listing's current-year bar is WINDOW", () => {
    assert.equal(
      resolveCandleDestination({ barYear: 2026, listingStatus: "ACTIVE", now }),
      "HOT_WINDOW",
    );
  });

  test("the floor year ITSELF is inside the window", () => {
    // `>=`, not `>`. Off by one here silently drops a whole year of every
    // active security out of Mongo and into GCS — a slower read, never an
    // error.
    assert.equal(
      resolveCandleDestination({ barYear: 2016, listingStatus: "ACTIVE", now }),
      "HOT_WINDOW",
    );
  });

  test("one year below the floor is COLD", () => {
    assert.equal(
      resolveCandleDestination({ barYear: 2015, listingStatus: "ACTIVE", now }),
      "COLD",
    );
  });

  test("a DELISTED listing is COLD even for a current-year bar", () => {
    // The half a bar cannot carry. 10,287 delisted US issues, and their recent
    // years are exactly the rows a year-only rule would leave in Mongo.
    assert.equal(
      resolveCandleDestination({
        barYear: 2026,
        listingStatus: "DELISTED",
        now,
      }),
      "COLD",
    );
  });

  test("THE YEAR ROLLOVER moves the boundary — the case a hidden new Date() hides", () => {
    // A 2016 bar is hot on 31 December 2026 and cold on 1 January 2027. This is
    // why the clock is a parameter: with `new Date()` read inside the function
    // this assertion is only runnable on one day of the year.
    const lastMoment = at("2026-12-31T23:59:59.999Z");
    const firstMoment = at("2027-01-01T00:00:00.000Z");
    assert.equal(
      resolveCandleDestination({
        barYear: 2016,
        listingStatus: "ACTIVE",
        now: lastMoment,
      }),
      "HOT_WINDOW",
    );
    assert.equal(
      resolveCandleDestination({
        barYear: 2016,
        listingStatus: "ACTIVE",
        now: firstMoment,
      }),
      "COLD",
    );
  });

  test("an explicit LOADED wins over BOTH data tests", () => {
    // The override exists precisely for rows the data sends cold — a pre-window
    // year, or a delisted security — that a reader has just pulled back. Checked
    // FIRST, or it would be unreachable in every case it is for.
    assert.equal(
      resolveCandleDestination({
        barYear: 1994,
        listingStatus: "DELISTED",
        tier: "LOADED",
        now,
      }),
      "HOT_LOADED",
    );
  });

  test("an explicit WINDOW cannot force a pre-window bar into Mongo", () => {
    // A caller who could do that could refill Mongo with the 200M rows this
    // split removed. The override widens what a caller may ask for by exactly
    // one value.
    assert.equal(
      resolveCandleDestination({
        barYear: 1994,
        listingStatus: "ACTIVE",
        tier: "WINDOW",
        now,
      }),
      "COLD",
    );
  });

  test("a non-finite year is COLD, never NaN-compared into the hot store", () => {
    // `NaN >= anything` is false, so this already lands cold — asserted so the
    // guard cannot be "simplified" away into an accident.
    assert.equal(
      resolveCandleDestination({ barYear: NaN, listingStatus: "ACTIVE", now }),
      "COLD",
    );
  });

  test("the window spans HOT_WINDOW_YEARS + 1 calendar years", () => {
    const hot: number[] = [];
    for (let y = 2026 - HOT_WINDOW_YEARS - 2; y <= 2026; y++) {
      if (
        resolveCandleDestination({
          barYear: y,
          listingStatus: "ACTIVE",
          now,
        }) === "HOT_WINDOW"
      ) {
        hot.push(y);
      }
    }
    assert.equal(hot.length, HOT_WINDOW_YEARS + 1);
    assert.equal(hot[0], 2026 - HOT_WINDOW_YEARS);
    assert.equal(hot[hot.length - 1], 2026);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE INTRADAY ARM (MONEY-1373)
//
// Databento is about to write M1 and H1 bars into the SAME table that holds
// D1. The year rule cannot be reused: an M1 symbol-year is ~242,000 rows
// against D1's ~252, so `barYear >= floor` over 3.4 years x ~510 symbols routes
// ~1.2 billion rows into Mongo — and it does so SILENTLY, because every one of
// those bars genuinely is inside the ten-year window. There is no error to see;
// the store just fills.
//
// The cases below are written against the two ways THIS arm goes wrong in turn:
// a comparator off by one at the boundary (invisible — a slightly shorter
// intraday chart), and an arm that swallows D1 as well (catastrophic and also
// invisible, since D1 bars older than 45 days would start archiving themselves
// out of the hot window).
// ───────────────────────────────────────────────────────────────────────────

describe("isIntradayTimeframe — W1 is NOT intraday", () => {
  test("the set is exactly the sub-daily timeframes", () => {
    for (const tf of ["S1", "M1", "M5", "M15", "H1"]) {
      assert.equal(isIntradayTimeframe(tf), true, `${tf} must be intraday`);
    }
    // W1 is ~52 rows a year — SPARSER than D1, not denser. Putting it in the
    // set would evict two years of weekly history for no reason at all.
    assert.equal(isIntradayTimeframe("W1"), false);
    assert.equal(isIntradayTimeframe("D1"), false);
  });

  test("absent, null and an unknown timeframe all fall through to the year rule", () => {
    // The direction of a miss. An unrecognised timeframe keeps the behaviour
    // every caller had before this arm existed, rather than being guessed onto
    // a 45-day window that would silently truncate it.
    assert.equal(isIntradayTimeframe(undefined), false);
    assert.equal(isIntradayTimeframe(null), false);
    assert.equal(isIntradayTimeframe(""), false);
    assert.equal(isIntradayTimeframe("m1"), false);
    assert.equal(isIntradayTimeframe("1m"), false);
  });

  test("the floor is exactly INTRADAY_HOT_WINDOW_DAYS behind the clock", () => {
    const now = at("2026-08-28T00:00:00Z");
    assert.equal(
      now.getTime() - intradayHotFloorTs(now).getTime(),
      INTRADAY_HOT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    // Days, not a calendar edge: the year window rolls once a year, this one
    // rolls every day, so a boundary that snapped to midnight would be a
    // different rule on the day it was computed.
    assert.equal(INTRADAY_HOT_WINDOW_DAYS, 45);
    assert.equal(INTRADAY_TIMEFRAMES.size, 5);
  });
});

describe("resolveCandleDestination — the INTRADAY arm (MONEY-1373)", () => {
  const now = at("2026-08-28T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  /** A bar instant `n` days before the injected clock. */
  const daysAgo = (n: number): number => now.getTime() - n * DAY;
  /** A D1 bar's arguments — the shape that must keep taking the YEAR rule. */
  const d1 = (year: number, over: Record<string, unknown> = {}) => ({
    barYear: year,
    listingStatus: "ACTIVE",
    timeframe: "D1",
    tsMs: Date.UTC(year, 6, 1),
    now,
    ...over,
  });

  // ── REGRESSION FIRST ────────────────────────────────────────────────────
  // Restated verbatim from the D1 block above, so a change to the year rule
  // fails HERE too rather than only there. The new arm sits directly upstream
  // of that rule and an arm that matched one timeframe too many would rewrite
  // all three of these answers without touching the code they test.
  test("REGRESSION: the D1 year rule is untouched by the new arm", () => {
    assert.equal(
      resolveCandleDestination({ barYear: 2026, listingStatus: "ACTIVE", now }),
      "HOT_WINDOW",
      "an ACTIVE listing's current-year bar is WINDOW",
    );
    assert.equal(
      resolveCandleDestination({ barYear: 2015, listingStatus: "ACTIVE", now }),
      "COLD",
      "one year below the floor is COLD",
    );
    assert.equal(
      resolveCandleDestination({
        barYear: 2026,
        listingStatus: "DELISTED",
        now,
      }),
      "COLD",
      "a DELISTED listing is COLD even for a current-year bar",
    );
  });

  test("REGRESSION: naming D1 explicitly still takes the year rule", () => {
    // The same three answers with `timeframe`/`tsMs` SUPPLIED, which is how
    // `partitionCandlesByDestination` now calls it. If D1 ever leaked into
    // INTRADAY_TIMEFRAMES, the 2015 bar would be cold for the wrong reason and
    // the 2026 DELISTED bar would flip to HOT_WINDOW — the arm ignores status.
    assert.equal(resolveCandleDestination(d1(2026)), "HOT_WINDOW");
    assert.equal(resolveCandleDestination(d1(2015)), "COLD");
    assert.equal(
      resolveCandleDestination(d1(2026, { listingStatus: "DELISTED" })),
      "COLD",
    );
  });

  test("an M1 bar 44 days old is HOT_WINDOW and 46 days old is COLD", () => {
    assert.equal(
      resolveCandleDestination({
        barYear: 2026,
        listingStatus: "ACTIVE",
        timeframe: "M1",
        tsMs: daysAgo(44),
        now,
      }),
      "HOT_WINDOW",
    );
    assert.equal(
      resolveCandleDestination({
        barYear: 2026,
        listingStatus: "ACTIVE",
        timeframe: "M1",
        tsMs: daysAgo(46),
        now,
      }),
      "COLD",
    );
  });

  test("THE BOUNDARY INSTANT ITSELF is inside the window — `>=`, never `>`", () => {
    // MUTATION: flip `>=` to `>` in the intraday comparator and this is the
    // case that goes red. The 44/46 pair cannot see it — both sit a full day
    // clear of the boundary — which is exactly why an off-by-one here would
    // ship: one minute of every symbol silently archived a day early, forever,
    // rendering as nothing at all.
    const floor = intradayHotFloorTs(now).getTime();
    const args = {
      barYear: 2026,
      listingStatus: "ACTIVE",
      timeframe: "M1" as const,
      now,
    };
    assert.equal(
      resolveCandleDestination({ ...args, tsMs: floor }),
      "HOT_WINDOW",
    );
    assert.equal(
      resolveCandleDestination({ ...args, tsMs: floor - 1 }),
      "COLD",
    );
  });

  test("the arm IGNORES listingStatus — a delisted security's last 45 days stay hot", () => {
    // Deliberate, and it is the one place these two rules disagree about a
    // fact. The year rule's status test exists to stop ~10,287 delisted issues
    // parking a DECADE of daily history in Mongo. 45 days of an already-bounded
    // feed is not that problem, and the bars somebody most wants after a
    // delisting are the ones immediately before it.
    assert.equal(
      resolveCandleDestination({
        barYear: 2026,
        listingStatus: "DELISTED",
        timeframe: "M1",
        tsMs: daysAgo(44),
        now,
      }),
      "HOT_WINDOW",
    );
  });

  test("an explicit LOADED still wins over the intraday arm", () => {
    // The override is checked FIRST and must stay there. An ancient M1 bar is
    // precisely the row the intraday arm sends cold, so checking the data first
    // would make the override unreachable in the case it is for.
    assert.equal(
      resolveCandleDestination({
        barYear: 2019,
        listingStatus: "DELISTED",
        timeframe: "M1",
        tsMs: daysAgo(2_000),
        tier: "LOADED",
        now,
      }),
      "HOT_LOADED",
    );
  });

  test("H1 behaves like M1; W1 and D1 take the year rule", () => {
    // An H1 bar from a recent-but-out-of-window day.
    const oldEnough = daysAgo(200);
    assert.equal(
      resolveCandleDestination({
        barYear: 2026,
        listingStatus: "ACTIVE",
        timeframe: "H1",
        tsMs: daysAgo(10),
        now,
      }),
      "HOT_WINDOW",
    );
    assert.equal(
      resolveCandleDestination({
        barYear: 2026,
        listingStatus: "ACTIVE",
        timeframe: "H1",
        tsMs: oldEnough,
        now,
      }),
      "COLD",
    );
    // The SAME instant, on the two timeframes the year rule owns: 200 days old
    // is deep inside the ten-year window, so both are HOT. If either had joined
    // INTRADAY_TIMEFRAMES this assertion would read COLD.
    for (const timeframe of ["W1", "D1"]) {
      assert.equal(
        resolveCandleDestination({
          barYear: 2026,
          listingStatus: "ACTIVE",
          timeframe,
          tsMs: oldEnough,
          now,
        }),
        "HOT_WINDOW",
        `${timeframe} must take the YEAR rule`,
      );
    }
  });

  test("a non-finite tsMs on an intraday timeframe is COLD", () => {
    // The same fail-to-cold posture the non-finite `barYear` check has. A
    // `NaN >= floor` is false and would land cold anyway; asserted so the guard
    // cannot be "simplified" away into an accident — and because an ABSENT
    // `tsMs` is the realistic shape (a caller that forwarded `timeframe` and
    // forgot the instant), where there is no comparison to accidentally get
    // right.
    for (const tsMs of [NaN, Infinity, undefined]) {
      assert.equal(
        resolveCandleDestination({
          barYear: 2026,
          listingStatus: "ACTIVE",
          timeframe: "M1",
          ...(tsMs === undefined ? {} : { tsMs }),
          now,
        }),
        "COLD",
        `tsMs=${String(tsMs)}`,
      );
    }
  });

  test("partitionCandlesByDestination splits a MIXED batch three ways", () => {
    // The call site that must never forget to forward the two new fields. It
    // is the one place a batch legitimately holds both timeframes, and the
    // fields are OPTIONAL (so the D1-only backfill seam keeps compiling), which
    // means omitting them here is not a compile error — it is an M1 bar routed
    // by its YEAR, which is the whole defect.
    const rows = [
      writeRow({ ts: d("2026-03-02") }), // D1, in window        -> hot
      writeRow({ ts: d("2010-03-02") }), // D1, out of window    -> cold
      writeRow({ ts: new Date(daysAgo(2)), timeframe: "M1" }), // -> hot
      writeRow({ ts: new Date(daysAgo(120)), timeframe: "M1" }), // -> cold
    ];
    const p = partitionCandlesByDestination(rows, now);
    assert.equal(
      p.hotWindow.length + p.hotLoaded.length + p.cold.length,
      rows.length,
    );
    assert.equal(p.hotWindow.length, 2);
    assert.equal(p.cold.length, 2);
    // Named rather than counted: two-and-two is also what a broken arm
    // produces if it swaps which pair is which.
    assert.deepEqual(p.hotWindow.map((r) => r.timeframe).sort(), ["D1", "M1"]);
    assert.deepEqual(p.cold.map((r) => r.timeframe).sort(), ["D1", "M1"]);
    assert.equal(
      p.cold.find((r) => r.timeframe === "M1")!.ts.getTime(),
      daysAgo(120),
      "the OLD M1 bar is the cold one — a year-routed M1 would be hot here",
    );
  });
});

describe("partitionCandlesByDestination", () => {
  const now = at("2026-08-28T00:00:00Z");

  test("every input row lands in exactly one bucket", () => {
    const rows = [
      writeRow({ ts: d("2026-03-02") }),
      writeRow({ ts: d("2010-03-02") }),
      writeRow({ ts: d("2011-03-02"), tier: "LOADED" }),
      writeRow({ ts: d("2026-03-03"), listingStatus: "DELISTED" }),
    ];
    const p = partitionCandlesByDestination(rows, now);
    assert.equal(
      p.hotWindow.length + p.hotLoaded.length + p.cold.length,
      rows.length,
    );
    assert.equal(p.hotWindow.length, 1);
    assert.equal(p.hotLoaded.length, 1);
    assert.equal(p.cold.length, 2);
  });

  test("ONE clock for the batch — a year boundary cannot split a symbol-year", () => {
    // Reading the clock per row would let a batch that straddles midnight on 31
    // December send two bars of one symbol-year to two different stores: half
    // the year in Mongo, half in a shard, and a merged read that looks
    // complete. Asserted by partitioning the SAME year twice at two instants
    // and requiring each call to be internally uniform.
    const sameYear = [
      writeRow({ ts: d("2016-01-04") }),
      writeRow({ ts: d("2016-06-15") }),
      writeRow({ ts: d("2016-12-30") }),
    ];
    const before = partitionCandlesByDestination(
      sameYear,
      at("2026-12-31T23:59:59.999Z"),
    );
    assert.equal(before.hotWindow.length, 3);
    assert.equal(before.cold.length, 0);

    const after = partitionCandlesByDestination(
      sameYear,
      at("2027-01-01T00:00:00.000Z"),
    );
    assert.equal(after.hotWindow.length, 0);
    assert.equal(after.cold.length, 3);
  });

  test("an empty batch partitions to three empty buckets", () => {
    const p = partitionCandlesByDestination([], now);
    assert.deepEqual(
      [p.hotWindow.length, p.hotLoaded.length, p.cold.length],
      [0, 0, 0],
    );
  });
});

describe("groupColdShards", () => {
  test("groups by (market, timeframe, symbol, year) and NOT by exchange", () => {
    // Deliberate, and it matches `buildCandleColdKey`. 928 tickers in Tiingo's
    // master appear on more than one exchange and US uplisting is routine, so
    // an exchange in the key would SPLIT one security's history across two
    // object trees at the moment it uplisted. Grouping by it here would be
    // worse: two objects computed for one key, each silently overwriting the
    // other.
    const shards = groupColdShards([
      writeRow({ ts: d("2010-03-02"), exchange: "NASDAQ" }),
      writeRow({ ts: d("2010-06-02"), exchange: "NYSE" }),
      writeRow({ ts: d("2011-06-02"), exchange: "NYSE" }),
    ]);
    assert.equal(
      shards.length,
      2,
      "one object per symbol-year, both venues in it",
    );
    const y2010 = shards.find((s) => s.year === 2010);
    assert.equal(y2010?.bars.length, 2);
    assert.equal(y2010?.market, "US");
    assert.equal(y2010?.timeframe, "D1");
  });

  test("bars come out ascending so an appended shard reads like a fresh one", () => {
    const shards = groupColdShards([
      writeRow({ ts: d("2010-12-31") }),
      writeRow({ ts: d("2010-01-04") }),
      writeRow({ ts: d("2010-06-15") }),
    ]);
    assert.deepEqual(
      shards[0]?.bars.map((b) => b.ts.toISOString().slice(0, 10)),
      ["2010-01-04", "2010-06-15", "2010-12-31"],
    );
  });

  test("the shard year is UTC, matching coldYearsForRange and the key", () => {
    // A bar at 2010-01-01T00:00Z is 2009 in every negative offset. If the group
    // year and `coldYearsForRange` disagreed by one, the reader would ask for a
    // key the writer never wrote — an absent year, which is a shorter chart.
    const shards = groupColdShards([
      writeRow({ ts: new Date("2010-01-01T00:00:00Z") }),
    ]);
    assert.equal(shards[0]?.year, 2010);
    assert.deepEqual(
      coldYearsForRange(
        new Date("2010-01-01T00:00:00Z"),
        new Date("2010-01-01T00:00:00Z"),
      ),
      [2010],
    );
  });

  test("toColdBar narrows volume from bigint to number", () => {
    // A shard round-trips through JSON, where a bigint throws outright
    // ("Do not know how to serialize a BigInt"). Exact to 2^53 — five orders of
    // magnitude above any equity's composite volume.
    const b = toColdBar(
      writeRow({ ts: d("2010-01-04"), volume: BigInt(4_500_000_000) }),
    );
    assert.equal(typeof b.volume, "number");
    assert.equal(b.volume, 4_500_000_000);
    assert.doesNotThrow(() => JSON.stringify(b));
  });
});

describe("mergeColdBars — a GCS write is a REPLACE", () => {
  test("keeps existing bars the incoming batch does not mention", () => {
    // The whole reason `writeColdShard` merges. Handed one month of 2014, a
    // naive write leaves the object holding one month of 2014 — eleven months
    // deleted, no error, and a chart that simply draws a shorter line.
    const existing = [
      bar({ ts: d("2014-01-02") }),
      bar({ ts: d("2014-02-03") }),
    ];
    const incoming = [bar({ ts: d("2014-03-04") })];
    const merged = mergeColdBars(existing, incoming);
    assert.equal(merged.length, 3);
    assert.deepEqual(
      merged.map((b) => b.ts.toISOString().slice(0, 10)),
      ["2014-01-02", "2014-02-03", "2014-03-04"],
    );
  });

  test("INCOMING wins on a key collision — a repair re-run must not be a no-op", () => {
    const existing = [bar({ ts: d("2014-01-02"), close: 1 })];
    const incoming = [bar({ ts: d("2014-01-02"), close: 999 })];
    assert.equal(mergeColdBars(existing, incoming)[0]?.close, 999);
  });

  test("the collision key is the FULL natural key, not the timestamp", () => {
    // A shard is keyed by TICKER and holds every venue that ticker traded on,
    // so two bars can share a `ts` and still be different rows. Collapsing on
    // `ts` alone would delete one venue's bar on every merge.
    const merged = mergeColdBars(
      [bar({ ts: d("2014-01-02"), exchange: "NASDAQ" })],
      [bar({ ts: d("2014-01-02"), exchange: "NYSE" })],
    );
    assert.equal(merged.length, 2);
  });

  test("merging into an empty shard is the incoming batch, sorted", () => {
    const merged = mergeColdBars(
      [],
      [bar({ ts: d("2014-03-04") }), bar({ ts: d("2014-01-02") })],
    );
    assert.deepEqual(
      merged.map((b) => b.ts.toISOString().slice(0, 10)),
      ["2014-01-02", "2014-03-04"],
    );
  });
});

describe("sanitizeCandleWrites — the two routing fields", () => {
  const raw = {
    symbol: "AAPL",
    exchange: "NASDAQ",
    timeframe: "D1",
    ts: d("2026-01-02"),
    listingId: "AAPL:NASDAQ:1980-12-12",
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
  };

  test("an unstated listingStatus resolves to ACTIVE, once, here", () => {
    // Resolved at the door so no consumer re-derives "absent means ACTIVE" — a
    // default spelled twice is a default that will eventually be spelled two
    // ways.
    assert.equal(sanitizeCandleWrites([raw]).rows[0]?.listingStatus, "ACTIVE");
    assert.equal(
      sanitizeCandleWrites([{ ...raw, listingStatus: null }]).rows[0]
        ?.listingStatus,
      "ACTIVE",
    );
    assert.equal(
      sanitizeCandleWrites([{ ...raw, listingStatus: "delisted" }]).rows[0]
        ?.listingStatus,
      "DELISTED",
    );
  });

  test("only LOADED survives as an override; WINDOW is normalised to null", () => {
    // A caller passing WINDOW is asking for what the routing already computes.
    // Carrying it would leave a value that later reads as a deliberate
    // override, which is how a flag outlives the rule it was standing in for.
    assert.equal(
      sanitizeCandleWrites([{ ...raw, tier: "LOADED" }]).rows[0]?.tier,
      "LOADED",
    );
    assert.equal(
      sanitizeCandleWrites([{ ...raw, tier: "WINDOW" }]).rows[0]?.tier,
      null,
    );
    assert.equal(sanitizeCandleWrites([raw]).rows[0]?.tier, null);
  });
});
