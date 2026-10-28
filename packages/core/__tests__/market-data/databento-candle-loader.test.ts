/**
 * The streaming loader — MONEY-1373.
 *
 * The case that carries the weight is the HEAP one. Everything else here is
 * mapping and counting, which a buffering implementation would also pass; only
 * a memory measurement can tell a streaming loader from one that accumulates
 * and flushes at the end, and MONEY-1337 is the record of what the second kind
 * costs in production (OOM-killed twice, a 48,000-document backlog stalled).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createZstdCompress } from "node:zlib";

import {
  emptyOhlcvLoadCounters,
  loadOhlcvStream,
} from "../../src/market-data/databento/databento-candle-loader";
import {
  QuarantineLedger,
  type ListingRow,
} from "../../src/market-data/databento/databento-symbology";
import { DATABENTO_SOURCE } from "../../src/market-data/databento/databento-logic";
import type { CandleWriteRow } from "../../src/market-data/candles/candle-logic";

/* ── fixtures ──────────────────────────────────────────────────────────── */

const HEADER =
  "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol";

const line = (iso: string, symbol: string, close = "1.5"): string =>
  `${iso},33,95,5482,1.0,2.0,0.5,${close},353,${symbol}`;

async function gz(text: string): Promise<Readable> {
  const chunks: Buffer[] = [];
  const c = createZstdCompress();
  const done = new Promise<void>((resolve, reject) => {
    c.on("data", (d: Buffer) => chunks.push(d));
    c.on("end", () => resolve());
    c.on("error", reject);
  });
  c.end(Buffer.from(text, "utf8"));
  c.resume();
  await done;
  return Readable.from(Buffer.concat(chunks));
}

const listing = (symbol: string, o: Partial<ListingRow> = {}): ListingRow => ({
  symbol,
  exchange: "NASDAQ",
  listingId: `${symbol}:NASDAQ:1980-12-12`,
  listingStartDate: new Date("1980-12-12T00:00:00Z"),
  listingEndDate: null,
  listingStatus: "ACTIVE",
  ...o,
});

const listings = (...symbols: string[]): Map<string, ListingRow[]> =>
  new Map(symbols.map((s) => [s, [listing(s)]]));

function collector() {
  const batches: CandleWriteRow[][] = [];
  return {
    batches,
    writer: async (rows: readonly CandleWriteRow[]) => {
      batches.push([...rows]);
    },
  };
}

/* ── mapping ───────────────────────────────────────────────────────────── */

describe("mapping a file into candle rows", () => {
  it("maps rows, stamps the source and uses the REPO's timeframe literal", () => {
    return (async () => {
      const c = collector();
      const counters = await loadOhlcvStream({
        stream: await gz(
          [
            HEADER,
            line("2024-06-03T14:30:00.000000000Z", "AAPL"),
            line("2024-06-03T14:31:00.000000000Z", "AAPL"),
          ].join("\n"),
        ),
        schema: "ohlcv-1m",
        listings: listings("AAPL"),
        writer: c.writer,
        quarantine: new QuarantineLedger(),
      });
      assert.equal(counters.rowsRead, 2);
      assert.equal(counters.rowsMapped, 2);
      const rows = c.batches.flat();
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.source, DATABENTO_SOURCE);
      // `M1`, never the vendor's "1m" — that literal is what keys the cold
      // shard path, and a second spelling is a second shard tree.
      assert.equal(rows[0]!.timeframe, "M1");
      assert.equal(rows[0]!.listingId, "AAPL:NASDAQ:1980-12-12");
      assert.equal(rows[0]!.exchange, "NASDAQ");
    })();
  });

  it("maps ohlcv-1h onto H1", () => {
    return (async () => {
      const c = collector();
      await loadOhlcvStream({
        stream: await gz(
          [HEADER, line("2024-06-03T14:00:00.000000000Z", "AAPL")].join("\n"),
        ),
        schema: "ohlcv-1h",
        listings: listings("AAPL"),
        writer: c.writer,
        quarantine: new QuarantineLedger(),
      });
      assert.equal(c.batches.flat()[0]!.timeframe, "H1");
    })();
  });

  it("converts the VENDOR's share-class notation to ours", () => {
    return (async () => {
      const c = collector();
      await loadOhlcvStream({
        stream: await gz(
          [HEADER, line("2024-06-03T14:30:00.000000000Z", "BRK.B")].join("\n"),
        ),
        schema: "ohlcv-1m",
        listings: listings("BRK-B"),
        writer: c.writer,
        quarantine: new QuarantineLedger(),
      });
      assert.equal(c.batches.flat()[0]!.symbol, "BRK-B");
    })();
  });

  it("REFUSES a schema that does not produce bars", () => {
    return (async () => {
      await assert.rejects(
        () =>
          loadOhlcvStream({
            stream: Readable.from(Buffer.alloc(0)),
            schema: "bbo-1m",
            listings: new Map(),
            writer: async () => {},
            quarantine: new QuarantineLedger(),
          }),
        /does not produce bars/,
      );
    })();
  });

  it("THROWS on a stream with no header rather than reporting a clean load", () => {
    return (async () => {
      // An empty file and a file of zero rows are different claims. Treating
      // the first as the second records a symbol-year as loaded having read
      // nothing at all.
      const stream = await gz("");
      await assert.rejects(
        () =>
          loadOhlcvStream({
            stream,
            schema: "ohlcv-1m",
            listings: new Map(),
            writer: async () => {},
            quarantine: new QuarantineLedger(),
          }),
        /no header line/,
      );
    })();
  });
});

/* ── rejections ────────────────────────────────────────────────────────── */

describe("every rejection is counted, and counted APART", () => {
  it("separates a bad price from a bad line from an unknown symbol", () => {
    return (async () => {
      // The three have opposite operational answers: a price spike is a vendor
      // problem, a fields spike means the file is not what we think it is, and
      // a quarantine spike is a master gap to backfill. One "skipped" total
      // would make them indistinguishable.
      const c = collector();
      const q = new QuarantineLedger();
      const counters = await loadOhlcvStream({
        stream: await gz(
          [
            HEADER,
            line("2024-06-03T14:30:00.000000000Z", "AAPL"),
            // UNDEF price renders as an empty field under pretty_px.
            "2024-06-03T14:31:00.000000000Z,33,95,5482,,2.0,0.5,1.5,353,AAPL",
            "too,few",
            line("2024-06-03T14:33:00.000000000Z", "NOSUCH"),
          ].join("\n"),
        ),
        schema: "ohlcv-1m",
        listings: listings("AAPL"),
        writer: c.writer,
        quarantine: q,
      });
      assert.equal(counters.rowsRead, 4);
      assert.equal(counters.rowsMapped, 1);
      assert.equal(counters.droppedPrice, 1);
      assert.equal(counters.droppedFields, 1);
      assert.equal(counters.quarantined, 1);
      assert.equal(q.summary().quarantinedSymbols, 1);
      assert.equal(q.summary().sample[0]!.symbol, "NOSUCH");
    })();
  });

  it("quarantines a date OUTSIDE the listing's window rather than guessing", () => {
    return (async () => {
      const c = collector();
      const q = new QuarantineLedger();
      const counters = await loadOhlcvStream({
        stream: await gz(
          [HEADER, line("2018-06-03T14:30:00.000000000Z", "DOW")].join("\n"),
        ),
        schema: "ohlcv-1m",
        // Dow Chemical delisted 2017, Dow Inc. listed 2019 — a 2018 bar is
        // neither company's.
        listings: new Map([
          [
            "DOW",
            [
              listing("DOW", {
                listingId: "DOW:NYSE:1972-06-01",
                exchange: "NYSE",
                listingStartDate: new Date("1972-06-01T00:00:00Z"),
                listingEndDate: new Date("2017-08-31T00:00:00Z"),
              }),
              listing("DOW", {
                listingId: "DOW:NYSE:2019-03-20",
                exchange: "NYSE",
                listingStartDate: new Date("2019-03-20T00:00:00Z"),
              }),
            ],
          ],
        ]),
        writer: c.writer,
        quarantine: q,
      });
      assert.equal(counters.quarantined, 1);
      assert.equal(counters.rowsMapped, 0);
      assert.equal(c.batches.length, 0);
    })();
  });

  it("files a recycled ticker's bars under the listing that was TRADING", () => {
    return (async () => {
      const c = collector();
      await loadOhlcvStream({
        stream: await gz(
          [
            HEADER,
            line("2015-06-03T14:30:00.000000000Z", "DOW"),
            line("2024-06-03T14:30:00.000000000Z", "DOW"),
          ].join("\n"),
        ),
        schema: "ohlcv-1m",
        listings: new Map([
          [
            "DOW",
            [
              listing("DOW", {
                listingId: "DOW:NYSE:1972-06-01",
                exchange: "NYSE",
                listingStartDate: new Date("1972-06-01T00:00:00Z"),
                listingEndDate: new Date("2017-08-31T00:00:00Z"),
                listingStatus: "DELISTED",
              }),
              listing("DOW", {
                listingId: "DOW:NYSE:2019-03-20",
                exchange: "NYSE",
                listingStartDate: new Date("2019-03-20T00:00:00Z"),
              }),
            ],
          ],
        ]),
        writer: c.writer,
        quarantine: new QuarantineLedger(),
      });
      const rows = c.batches.flat();
      assert.equal(rows.length, 2);
      const byYear = new Map(
        rows.map((r) => [r.ts.getUTCFullYear(), r.listingId]),
      );
      assert.equal(byYear.get(2015), "DOW:NYSE:1972-06-01");
      assert.equal(byYear.get(2024), "DOW:NYSE:2019-03-20");
    })();
  });
});

/* ── flushing ──────────────────────────────────────────────────────────── */

describe("flushing", () => {
  it("a YEAR change closes a symbol's buffer, so one shard is written per year", () => {
    return (async () => {
      const c = collector();
      const counters = await loadOhlcvStream({
        stream: await gz(
          [
            HEADER,
            line("2024-12-31T20:30:00.000000000Z", "AAPL"),
            line("2025-01-02T14:30:00.000000000Z", "AAPL"),
          ].join("\n"),
        ),
        schema: "ohlcv-1m",
        listings: listings("AAPL"),
        writer: c.writer,
        quarantine: new QuarantineLedger(),
      });
      assert.equal(counters.flushes, 2);
      assert.equal(c.batches.length, 2);
      assert.equal(c.batches[0]![0]!.ts.getUTCFullYear(), 2024);
      assert.equal(c.batches[1]![0]!.ts.getUTCFullYear(), 2025);
    })();
  });

  it("the cap closes a buffer that grows past it", () => {
    return (async () => {
      const c = collector();
      const rows = Array.from({ length: 7 }, (_, i) =>
        line(
          `2024-06-03T14:${String(30 + i).padStart(2, "0")}:00.000000000Z`,
          "AAPL",
        ),
      );
      const counters = await loadOhlcvStream({
        stream: await gz([HEADER, ...rows].join("\n")),
        schema: "ohlcv-1m",
        listings: listings("AAPL"),
        writer: c.writer,
        quarantine: new QuarantineLedger(),
        maxBufferedRowsPerSymbol: 3,
      });
      assert.equal(counters.rowsMapped, 7);
      assert.ok(c.batches.length >= 3, `flushed ${c.batches.length} times`);
      assert.equal(c.batches.flat().length, 7);
    })();
  });

  it("holds each symbol SEPARATELY and flushes both at end of stream", () => {
    return (async () => {
      const c = collector();
      const counters = await loadOhlcvStream({
        stream: await gz(
          [
            HEADER,
            line("2024-06-03T14:30:00.000000000Z", "AAPL"),
            line("2024-06-03T14:30:00.000000000Z", "MSFT"),
            line("2024-06-03T14:31:00.000000000Z", "AAPL"),
          ].join("\n"),
        ),
        schema: "ohlcv-1m",
        listings: listings("AAPL", "MSFT"),
        writer: c.writer,
        quarantine: new QuarantineLedger(),
      });
      assert.equal(counters.symbolsSeen, 2);
      // Interleaved input, but each batch is ONE symbol — the session writer
      // needs it that way to rewrite a shard whole.
      for (const batch of c.batches) {
        assert.equal(new Set(batch.map((r) => r.symbol)).size, 1);
      }
      assert.equal(c.batches.flat().length, 3);
    })();
  });

  it("AWAITS the writer — the back-pressure, not a fire-and-forget", () => {
    return (async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const counters = await loadOhlcvStream({
        stream: await gz(
          [
            HEADER,
            line("2024-06-03T14:30:00.000000000Z", "AAPL"),
            line("2024-06-03T14:31:00.000000000Z", "MSFT"),
            line("2024-06-03T14:32:00.000000000Z", "GOOG"),
          ].join("\n"),
        ),
        schema: "ohlcv-1m",
        listings: listings("AAPL", "MSFT", "GOOG"),
        writer: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
        },
        quarantine: new QuarantineLedger(),
      });
      assert.equal(counters.flushes, 3);
      assert.equal(
        maxInFlight,
        1,
        "more than one writer call was in flight — a Promise.all over flushes " +
          "removes the back-pressure that keeps a large load flat in memory",
      );
    })();
  });
});

/* ── memory ────────────────────────────────────────────────────────────── */

/*
 * The HEAP measurement lives in `databento-loader-memory.spawntest.ts`.
 *
 * It was here first, and it did not work: inside the shared runner the heap
 * baseline is polluted by whatever suite ran before, `global.gc` is not
 * available to settle it, and a deliberate leak (retain every mapped row)
 * PASSED both a fixed 120 MB budget and a scaling ratio. Measured in its own
 * process under --expose-gc the same check separates correct from leaking at
 * 1.05x against 1.91x. A memory claim that cannot fail is worse than none, so
 * it moved to the lane that can make it.
 *
 * What stays here is the structural half — that the loader flushes many times
 * and respects its buffer cap — which is exactly what a heap test cannot see.
 */

describe("counters", () => {
  it("start at zero and are all present", () => {
    const c = emptyOhlcvLoadCounters();
    for (const [k, v] of Object.entries(c)) assert.equal(v, 0, `${k} is not 0`);
  });
});
