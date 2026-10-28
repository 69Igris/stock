/**
 * The streaming loader: a `.csv.zst` file becomes `Candle` rows — MONEY-1373.
 *
 * ## Nothing is ever fully in memory
 *
 * One harvest file is a symbol-year of 1-minute bars (~120,000 rows), and the
 * MASTER hourly entries run to hundreds of megabytes uncompressed. The whole
 * 1-minute baseline is tens of gigabytes.
 *
 * MONEY-1337 is the written record of what buffering costs: the doc-ingest
 * converter held whole objects, was OOM-killed twice with "The configured
 * memory limit was reached", and stalled a 48,000-document backlog for days. So
 * this reads lines from a decompressing stream, buffers ONE SYMBOL at a time,
 * and hands each buffer to the writer with `await` — which is the
 * back-pressure: the decompressor stops pulling while a database write is in
 * flight, instead of racing ahead of it.
 *
 * ## Why per-symbol buffers, and how big they get
 *
 * The session writer needs a symbol's bars together, because it groups them by
 * session and rewrites cold shards whole — one PUT per symbol-year rather than
 * one per bar. So bars accumulate per symbol and flush when the symbol's YEAR
 * changes, when the buffer passes its cap, or at end of stream.
 *
 * That gives two shapes, and both are bounded:
 *
 *   HARVEST files are `split_symbols=true, split_duration=year`, so one file is
 *   one symbol-year: a single buffer, one flush, one shard write.
 *
 *   APPEND files are one session for every baseline symbol, so ~500 buffers of
 *   ~960 rows each live at once — roughly 100 MB at ~200 bytes a row, against a
 *   2Gi task. Stated rather than assumed, because it is the one arrangement
 *   where buffer count scales with the SYMBOL SET.
 *
 * ## Everything rejected is COUNTED
 *
 * A row can be dropped for a malformed line, an UNDEF price, a bad timestamp,
 * or a symbol that does not resolve to exactly one listing. Each has its own
 * counter, because the operational answers differ: a spike in `quarantined` is
 * a master gap to backfill, a spike in `droppedPrice` is a vendor problem, and
 * a spike in `droppedFields` means the file is not what we think it is. A single
 * "skipped" total would make all three look the same.
 */

import type { Readable } from "node:stream";

import type { CandleWriteRow } from "../candles/candle-logic";
import { zstdLines } from "./databento-stream";
import {
  DATABENTO_SOURCE,
  SCHEMA_TIMEFRAME,
  fromDatabentoSymbol,
  parseOhlcvHeader,
  parseOhlcvRow,
  type DatabentoSchema,
} from "./databento-logic";
import {
  resolveListingForDate,
  type ListingRow,
  type QuarantineLedger,
} from "./databento-symbology";

/**
 * Rows held for one symbol before a flush.
 *
 * ~120,000 is one symbol-year of 1-minute bars — the natural harvest unit — so
 * a single symbol-year file flushes ONCE, at end of stream, and produces
 * exactly one cold-shard write. Raising this buys nothing; lowering it splits a
 * symbol-year into several shard rewrites of the same object.
 */
export const DEFAULT_MAX_BUFFERED_ROWS_PER_SYMBOL = 120_000;

export interface OhlcvLoadCounters {
  rowsRead: number;
  rowsMapped: number;
  droppedFields: number;
  droppedTimestamp: number;
  droppedPrice: number;
  droppedSymbolField: number;
  quarantined: number;
  multiVenue: number;
  symbolsSeen: number;
  flushes: number;
}

export function emptyOhlcvLoadCounters(): OhlcvLoadCounters {
  return {
    rowsRead: 0,
    rowsMapped: 0,
    droppedFields: 0,
    droppedTimestamp: 0,
    droppedPrice: 0,
    droppedSymbolField: 0,
    quarantined: 0,
    multiVenue: 0,
    symbolsSeen: 0,
    flushes: 0,
  };
}

export interface LoadOhlcvArgs {
  stream: Readable;
  schema: DatabentoSchema;
  /**
   * Listing windows for the symbols this file is expected to contain, in OUR
   * notation. PRELOADED by the caller — never a per-row database read.
   *
   * A symbol the map does not know is quarantined rather than looked up: it is
   * either a symbol we did not ask for, or a notation the conversion table does
   * not handle, and both belong in the ledger rather than in `candles`.
   */
  listings: ReadonlyMap<string, ListingRow[]>;
  /** Where a symbol's buffered rows go. Awaited — this is the back-pressure. */
  writer: (rows: readonly CandleWriteRow[]) => Promise<void>;
  quarantine: QuarantineLedger;
  maxBufferedRowsPerSymbol?: number;
}

interface SymbolBuffer {
  rows: CandleWriteRow[];
  year: number;
}

/**
 * Stream one OHLCV file into the candle store.
 *
 * Returns counters; throws only if the stream itself fails, because a
 * half-loaded file must be visibly incomplete rather than quietly partial.
 */
export async function loadOhlcvStream(
  args: LoadOhlcvArgs,
): Promise<OhlcvLoadCounters> {
  const counters = emptyOhlcvLoadCounters();
  const timeframe = SCHEMA_TIMEFRAME[args.schema];
  if (timeframe === undefined) {
    throw new RangeError(
      `loadOhlcvStream: schema ${args.schema} has no timeframe mapping, so it ` +
        "does not produce bars. bbo-1m and tbbo are quote/trade records read " +
        "by the cost model from the archive, never loaded into candles.",
    );
  }
  const cap =
    args.maxBufferedRowsPerSymbol ?? DEFAULT_MAX_BUFFERED_ROWS_PER_SYMBOL;

  const buffers = new Map<string, SymbolBuffer>();
  let columns: ReturnType<typeof parseOhlcvHeader> | null = null;

  const flush = async (symbol: string): Promise<void> => {
    const buf = buffers.get(symbol);
    if (buf === undefined || buf.rows.length === 0) return;
    buffers.delete(symbol);
    counters.flushes++;
    // AWAITED. The decompressor stops pulling while this runs, which is what
    // keeps a forty-million-row load flat in memory rather than racing the
    // writer. Never `Promise.all` over flushes.
    await args.writer(buf.rows);
  };

  for await (const line of zstdLines(args.stream)) {
    if (columns === null) {
      columns = parseOhlcvHeader(line);
      continue;
    }
    counters.rowsRead++;

    const parsed = parseOhlcvRow(line, columns);
    if ("rejected" in parsed) {
      if (parsed.rejected === "fields") counters.droppedFields++;
      else if (parsed.rejected === "timestamp") counters.droppedTimestamp++;
      else if (parsed.rejected === "price") counters.droppedPrice++;
      else counters.droppedSymbolField++;
      continue;
    }

    const ourSymbol = fromDatabentoSymbol(parsed.symbol);
    const ts = new Date(parsed.tsMs);
    const resolution = resolveListingForDate(args.listings.get(ourSymbol), ts);
    if (!resolution.ok) {
      counters.quarantined++;
      args.quarantine.add(ourSymbol, resolution.reason, ts);
      continue;
    }
    if (resolution.multiVenue) counters.multiVenue++;

    const year = ts.getUTCFullYear();
    let buf = buffers.get(ourSymbol);
    if (buf === undefined) {
      counters.symbolsSeen++;
      buf = { rows: [], year };
      buffers.set(ourSymbol, buf);
    } else if (buf.year !== year || buf.rows.length >= cap) {
      // A year change closes the buffer, so a harvest file that happens to span
      // a boundary still writes one shard per year rather than one straddling
      // batch. The cap is the safety net for a file that is neither.
      await flush(ourSymbol);
      buf = { rows: [], year };
      buffers.set(ourSymbol, buf);
    }

    buf.rows.push({
      symbol: ourSymbol,
      exchange: resolution.listing.exchange,
      timeframe,
      ts,
      listingId: resolution.listing.listingId,
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.close,
      volume: parsed.volume,
      source: DATABENTO_SOURCE,
      listingStatus: resolution.listing.listingStatus,
    });
    counters.rowsMapped++;
  }

  if (columns === null) {
    throw new TypeError(
      "loadOhlcvStream: the stream produced no header line. An empty file is " +
        "not the same as a file of zero rows, and treating it as one would " +
        "record a symbol-year as loaded having read nothing.",
    );
  }

  for (const symbol of [...buffers.keys()]) {
    await flush(symbol);
  }
  return counters;
}
