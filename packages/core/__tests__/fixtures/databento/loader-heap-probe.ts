/**
 * The child process for `databento-loader-memory.spawntest.ts` — MONEY-1373.
 *
 * Deliberately NOT a `.test.ts` / `.spawntest.ts` file, so neither lane's glob
 * picks it up: it is a program, run under `node --expose-gc`, that prints one
 * JSON line and exits.
 *
 * Why a separate process at all: a heap measurement needs a settled baseline,
 * and inside the shared test runner the reading is polluted by every suite that
 * ran before it in the same process. The first version of this check lived in
 * the normal lane, and a deliberate leak PASSED it — the measurement said 1.05x
 * for correct code and 1.91x for leaking code when run in isolation with gc
 * control, and produced no usable signal at all when run beside other tests.
 */

import { Readable } from "node:stream";
import { createZstdCompress } from "node:zlib";

import { loadOhlcvStream } from "../../../src/market-data/databento/databento-candle-loader";
import {
  QuarantineLedger,
  type ListingRow,
} from "../../../src/market-data/databento/databento-symbology";

const HEADER =
  "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol";

const LISTING: ListingRow = {
  symbol: "AAPL",
  exchange: "NASDAQ",
  listingId: "AAPL:NASDAQ:1980-12-12",
  listingStartDate: new Date("1980-12-12T00:00:00Z"),
  listingEndDate: null,
  listingStatus: "ACTIVE",
};

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

/**
 * Rows retained by the `--leak` run, at module scope so nothing can collect
 * them. The leak run is not a curiosity: it is the PREMISE the assertions rest
 * on, re-derived on every execution. See {@link main}.
 */
const leaked: unknown[] = [];

/** Peak LIVE heap above a GC'd baseline, while loading `rows` bars. */
async function peakHeapFor(rows: number, leak = false): Promise<number> {
  const base = Date.UTC(2024, 5, 3, 13, 30);
  const lines: string[] = [HEADER];
  for (let i = 0; i < rows; i++) {
    const iso = new Date(base + i * 60_000).toISOString().replace("Z", "000000Z");
    lines.push(`${iso},33,95,5482,1.0,2.0,0.5,1.5,353,AAPL`);
  }
  const stream = await gz(lines.join("\n"));

  // The reason this program exists. Without it the baseline is whatever the
  // previous allocation left behind.
  global.gc?.();
  const baseline = process.memoryUsage().heapUsed;

  let peak = 0;
  const counters = await loadOhlcvStream({
    stream,
    schema: "ohlcv-1m",
    listings: new Map([["AAPL", [LISTING]]]),
    writer: async (batch) => {
      if (leak) leaked.push(...batch.map((row) => ({ ...row })));
      // COLLECT BEFORE READING. `heapUsed` is allocated-but-not-yet-collected,
      // so without this the sample measures how long it has been since V8 last
      // scavenged — and V8 sizes its young generation from the machine's
      // memory state, not from this program. Measured 2026-09-08 on ONE
      // unchanged loader: 1.05x in a quiet process and 1.64-1.98x in a busy
      // one, against a 1.5x ceiling. That is not a property of the code under
      // test, and a test whose verdict moves with free RAM cannot be read.
      //
      // Forced, the same code reads FLAT (0.0 MB at both sizes) and the
      // `--leak` run still reads 2.79x. ~45 collections for the 90k run; this
      // program already lives in the 180 s lane.
      global.gc?.();
      const used = process.memoryUsage().heapUsed - baseline;
      if (used > peak) peak = used;
    },
    quarantine: new QuarantineLedger(),
    maxBufferedRowsPerSymbol: 2_000,
  });
  if (counters.rowsMapped !== rows) {
    throw new Error(`mapped ${counters.rowsMapped} of ${rows} rows`);
  }
  return peak;
}

/**
 * Both runs, and the LEAK run that proves this measurement can still see one.
 *
 * The old premise was `smallBytes > 1 MiB` — "too little to be a real
 * measurement". Against a forced-GC live set that is now false for the RIGHT
 * reason: a streaming loader's live set is the 2,000-row buffer and the
 * decompressor's carry, a few hundred KB, whatever the file size. Deleting the
 * premise outright would leave the ratio unguarded, which is how a probe that
 * measures nothing reports 0.00x and passes forever.
 *
 * So the premise is replaced by an EXPERIMENT rather than a floor: the same
 * probe, same sampling, with every mapped row retained. If that run does not
 * scale, the instrument is broken and the verdict on the real run is worthless.
 * A verified ceiling, re-derived every execution.
 */
async function main(): Promise<void> {
  const small = await peakHeapFor(30_000);
  const large = await peakHeapFor(90_000);
  const leakSmall = await peakHeapFor(30_000, true);
  const leakLarge = await peakHeapFor(90_000, true);
  void leaked.length;
  process.stdout.write(
    `${JSON.stringify({
      smallBytes: small,
      largeBytes: large,
      ratio: large / Math.max(small, 1),
      leakSmallBytes: leakSmall,
      leakLargeBytes: leakLarge,
      leakRatio: leakLarge / Math.max(leakSmall, 1),
      hasGc: typeof global.gc === "function",
    })}\n`,
  );
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
