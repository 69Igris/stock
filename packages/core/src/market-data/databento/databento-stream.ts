/**
 * The zstd line reader — MONEY-1373.
 *
 * ## Why this is not in `databento-logic.ts`
 *
 * That file claims zero I/O and no allocated handles, and its sibling
 * `candle-logic.ts` states the rule it is obeying: `zlib`'s `*Sync` entry
 * points are pure CPU over a Buffer, "unlike `zlib.createGzip()`, which is a
 * stream and would keep the event loop alive". A transform stream in the pure
 * module would contradict a rule written one directory over, so it lives here
 * instead — one small file whose entire job is the stream, and whose test drives
 * it from an in-memory `Readable` that always ends.
 *
 * ## Why streaming at all
 *
 * A harvest file is a symbol-year of 1-minute bars: ~120,000 rows, and the
 * MASTER 1-hour entries run to hundreds of megabytes uncompressed. The
 * doc-ingest drain (MONEY-1337) is the written record of what buffering costs —
 * a converter that held whole objects died twice with "The configured memory
 * limit was reached" and stalled a 48,000-document backlog. Nothing here ever
 * holds more than one line plus the decoder's own window.
 *
 * ## Why Node 22
 *
 * `zlib.createZstdDecompress` landed in Node 23.8 and was backported to 22.15.
 * The workers image moved from `node:20-alpine` to `node:22-alpine` in this same
 * ticket for this one call, in preference to a userland zstd dependency: the
 * decoder sits in the path of every byte we buy, and the standard library is
 * the one implementation nobody has to keep patched.
 */

import { createZstdDecompress } from "node:zlib";
import type { Readable } from "node:stream";

/**
 * Yield decoded lines from a zstd-compressed byte stream.
 *
 * Newline-delimited, `\r` stripped, blank lines skipped, and the final partial
 * line (a file that does not end in a newline) is yielded rather than dropped —
 * that last one is a whole bar, and losing it silently is the shape of defect
 * this repo keeps paying for.
 *
 * Back-pressure is the caller's `for await`: the decompressor stops pulling
 * while the consumer is awaiting a database write, which is what keeps a
 * 40-million-row load flat in memory rather than racing the writer.
 *
 * The decompressor is destroyed in a `finally`, so a consumer that breaks out
 * of the loop early (an error, a budget stop) does not leave the transform and
 * its source pinned — the orphaned-handle class this repo treats as a failure
 * rather than a nuisance.
 */
export async function* zstdLines(source: Readable): AsyncGenerator<string> {
  if (typeof createZstdDecompress !== "function") {
    throw new Error(
      "zstdLines: node:zlib has no createZstdDecompress. It requires Node " +
        ">= 22.15; the workers image is node:22-alpine as of MONEY-1373. " +
        `This runtime is ${process.version}.`,
    );
  }
  const decompressor = createZstdDecompress();
  source.pipe(decompressor);

  let carry = "";
  try {
    for await (const chunk of decompressor) {
      carry += (chunk as Buffer).toString("utf8");
      let nl = carry.indexOf("\n");
      while (nl !== -1) {
        const line = carry.slice(0, nl).replace(/\r$/, "");
        carry = carry.slice(nl + 1);
        if (line !== "") yield line;
        nl = carry.indexOf("\n");
      }
    }
    const last = carry.replace(/\r$/, "");
    if (last !== "") yield last;
  } finally {
    decompressor.destroy();
  }
}

/**
 * Split an already-decoded text blob into lines, with the same rules.
 *
 * For the support files (`manifest.json` and friends are small) and for tests
 * that want the line rules without a stream.
 */
export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l !== "");
}
