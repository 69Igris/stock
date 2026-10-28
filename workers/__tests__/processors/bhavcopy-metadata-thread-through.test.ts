/**
 * WIRING TEST — the metadata-backfill COUNTS reach the sync log (MONEY-1157).
 *
 * `backfillInstrumentMetadata` was declared `Promise<void>` while its body has
 * always ended in `return { seriesWritten, isinWritten, typeWritten }`, and
 * those counts are threaded up through `upsertBhavcopyRows` →
 * `ingestExchangeDay` → `processBhavcopySync`, folded into `metadataTotals`, and
 * PERSISTED on the MarketDataSyncLog row. `tsc` reported the mismatch (TS2322)
 * but `tsup`/esbuild never type-checks, so it never blocked a build.
 *
 * The dangerous "fix" was to make the runtime match the declaration — drop the
 * return and let the function really be void. Nothing would have failed: the
 * caller already tolerates a missing value (`if (metadata)`), so the sync log
 * would silently go back to price counts only, and "the classification backfill
 * has been dead for weeks" would once again be indistinguishable from "the
 * universe converged" — the exact ambiguity MONEY-1093 closed.
 *
 * This is a SOURCE-SHAPE test, matching the established precedent for this file
 * (`apps/web/__tests__/workers/bhavcopy-metadata-backfill.test.ts`): the
 * processor imports a real Prisma client at module load, so it cannot be
 * imported into a pure unit test without opening a connection (orphan risk).
 * It pins the CHAIN, which is what a well-meaning refactor would sever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(
  path.join(HERE, "..", "..", "src", "processors", "bhavcopy-sync.ts"),
  "utf8",
);

/**
 * Assertions run against the CODE, never the prose.
 *
 * Found by mutation-checking this very file: deleting the counts `return`
 * statement left the suite green, because the JSDoc above
 * `backfillInstrumentMetadata` quotes that exact statement while explaining why
 * it must stay. A source-shape test that can be satisfied by a comment
 * describing the code is a shadow of the worst kind — it passes precisely
 * because someone documented the thing they then removed.
 */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("bhavcopy metadata counts: the producer still returns them", () => {
  it("found the source", () => {
    assert.ok(SRC.length > 0);
  });

  it("backfillInstrumentMetadata is NOT declared void", () => {
    // The declaration that was wrong. If someone re-narrows it to
    // `Promise<void>`, every assertion below becomes unreachable in practice.
    //
    // Sliced to the ONE signature line rather than regex-spanning the whole
    // function: the body contains a nested `writeIsin(...): Promise<void>`
    // helper, which a lazy `[\s\S]*?` happily reaches.
    const declStart = SRC.indexOf(
      "async function backfillInstrumentMetadata(",
    );
    assert.ok(declStart > 0, "the function should exist");
    const returnLineStart = SRC.indexOf("\n):", declStart);
    assert.ok(returnLineStart > declStart, "the signature should close");
    const returnLine = SRC.slice(
      returnLineStart + 1,
      SRC.indexOf("\n", returnLineStart + 1),
    );

    assert.doesNotMatch(
      returnLine,
      /Promise<void>/,
      "backfillInstrumentMetadata must declare the counts it returns",
    );
    assert.match(
      returnLine,
      /^\):\s*Promise<MetadataBackfillCounts\s*\|\s*undefined>\s*\{$/,
    );
  });

  it("still returns the three counts", () => {
    assert.match(
      SRC,
      /return\s*\{\s*seriesWritten,\s*isinWritten,\s*typeWritten\s*\}/,
      "the counts return is the whole point — a void body silently un-instruments the job",
    );
  });
});

describe("bhavcopy metadata counts: the chain to the sync log is intact", () => {
  it("upsertBhavcopyRows captures the awaited counts", () => {
    assert.match(SRC, /const metadata = await backfillInstrumentMetadata\(/);
  });

  it("upsertBhavcopyRows returns them to its caller", () => {
    assert.match(SRC, /return\s*\{\s*upserted,\s*failed,\s*metadata\s*\}/);
  });

  it("ingestExchangeDay forwards them upward", () => {
    assert.match(
      SRC,
      /return\s*\{\s*fetched:\s*rows\.length,\s*upserted,\s*failed,\s*metadata\s*\}/,
    );
  });

  it("processBhavcopySync destructures metadata off the per-day result", () => {
    assert.match(
      SRC,
      /const\s*\{\s*upserted,\s*failed,\s*fetched,\s*metadata\s*\}\s*=/,
    );
  });

  it("folds all three counts into metadataTotals", () => {
    for (const field of ["seriesWritten", "isinWritten", "typeWritten"]) {
      assert.match(
        SRC,
        new RegExp(`metadataTotals\\.${field}\\s*\\+=\\s*metadata\\.${field}`),
        `${field} must be accumulated across every exchange/day of the run`,
      );
    }
  });

  it("the fold is guarded on a present value, so absent === null === skip", () => {
    // Why the declared type is `metadata?: … | null` rather than a required
    // field: the no-rows early returns omit the key entirely, and the caller's
    // `.catch` substitutes `null`. Both must mean "nothing to add", never a
    // crash and never a zero that looks like a real measurement.
    assert.match(SRC, /if\s*\(metadata\)\s*\{/);
  });

  it("metadataTotals is persisted on BOTH the COMPLETED and FAILED sync log", () => {
    // "did the classification backfill do anything?" is at its most interesting
    // on the run that failed, so the spread must appear on both update paths.
    const spreads = SRC.match(/\.\.\.metadataTotals/g) ?? [];
    assert.ok(
      spreads.length >= 2,
      `expected metadataTotals on the COMPLETED and FAILED updates, found ${spreads.length}`,
    );
  });
});
