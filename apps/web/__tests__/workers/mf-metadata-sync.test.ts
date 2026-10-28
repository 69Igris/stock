/**
 * MF Metadata Sync Processor Tests (workers/src/processors/mf-metadata-sync.ts)
 * — DE-SHADOWED.
 *
 * Previously this file declared a full inline `processMfMetadataSync` copy
 * "(mirrors the source)" and asserted the copy — a shadow that stayed green even
 * if the real WHERE clause, the batch cap, or the rate-limit gate regressed.
 *
 * The pure decision/builder helpers now live in
 * `workers/src/processors/mf-metadata-sync-logic.ts`, which `mf-metadata-sync.ts`
 * imports and CALLS. This test asserts those REAL exports directly. The
 * enrichment-loop counting is exercised via a thin orchestration harness that
 * drives the SAME real `resolveMfMetadataParams` + `shouldSleepAfterIndex`
 * (the real processor boots Prisma + the Kuvera client at import, so it can't run
 * in a pure unit test).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker logic under test (no shadow). mf-metadata-sync.ts CALLS these.
import {
  resolveMfMetadataParams,
  buildMfMetadataWhere,
  computeStaleDate,
  shouldSleepAfterIndex,
  shouldLogProgress,
  DEFAULT_BATCH_SIZE,
  DEFAULT_DELAY_MS,
  STALE_DAYS,
  PROGRESS_LOG_EVERY,
} from "../../../../workers/src/processors/mf-metadata-sync-logic";

// ══════════════════════════════════════════════════════════════════════
// resolveMfMetadataParams (real export)
// ══════════════════════════════════════════════════════════════════════

describe("resolveMfMetadataParams (real export)", () => {
  it("uses DEFAULT_BATCH_SIZE (500) when batchSize not provided", () => {
    assert.strictEqual(
      resolveMfMetadataParams({}).batchSize,
      DEFAULT_BATCH_SIZE
    );
    assert.strictEqual(resolveMfMetadataParams({}).batchSize, 500);
  });

  it("uses a custom batchSize when provided", () => {
    assert.strictEqual(
      resolveMfMetadataParams({ batchSize: 100 }).batchSize,
      100
    );
  });

  it("uses DEFAULT_DELAY_MS (1000) when delayMs not provided", () => {
    assert.strictEqual(resolveMfMetadataParams({}).delayMs, DEFAULT_DELAY_MS);
    assert.strictEqual(resolveMfMetadataParams({}).delayMs, 1000);
  });

  it("uses a custom delayMs when provided", () => {
    assert.strictEqual(resolveMfMetadataParams({ delayMs: 500 }).delayMs, 500);
  });

  it("defaults forceReEnrich to false", () => {
    assert.strictEqual(resolveMfMetadataParams({}).forceReEnrich, false);
  });

  it("respects forceReEnrich = true", () => {
    assert.strictEqual(
      resolveMfMetadataParams({ forceReEnrich: true }).forceReEnrich,
      true
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildMfMetadataWhere (real export)
// ══════════════════════════════════════════════════════════════════════

describe("buildMfMetadataWhere (real export)", () => {
  it("filters active funds with ABSENT, null or stale metadataSyncedAt when not forced", () => {
    const where = buildMfMetadataWhere(false);
    assert.strictEqual(where.isActive, true);
    assert.ok("OR" in where, "non-force mode includes an OR clause");
    if ("OR" in where) {
      // MONEY-1207: THREE branches. Prisma + MongoDB `{ field: null }` does NOT
      // match a document where the field is ABSENT, so `{ isSet: false }` is
      // what reaches the 6,960 prod rows that had never been enriched (measured
      // 2026-08-18: 7,263 rows store a date, 6,960 have no key at all). With
      // two branches the weekly job re-picked the SAME already-attempted 7,263
      // every Sunday and could never reach the rest — for 5.5 months.
      assert.strictEqual(where.OR.length, 3);
      assert.deepStrictEqual(where.OR[0], {
        metadataSyncedAt: { isSet: false },
      });
      assert.deepStrictEqual(where.OR[1], { metadataSyncedAt: null });
      assert.ok("metadataSyncedAt" in where.OR[2]);
    }
  });

  it("uses the supplied stale date in the OR clause", () => {
    const stale = new Date("2026-01-01T00:00:00Z");
    const where = buildMfMetadataWhere(false, stale);
    assert.ok("OR" in where);
    if ("OR" in where) {
      assert.strictEqual(
        where.OR[2].metadataSyncedAt.lt.getTime(),
        stale.getTime()
      );
    }
  });

  it("only filters by isActive when forceReEnrich is true", () => {
    const where = buildMfMetadataWhere(true);
    assert.deepStrictEqual(where, { isActive: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// computeStaleDate (real export)
// ══════════════════════════════════════════════════════════════════════

describe("computeStaleDate (real export)", () => {
  it("is exactly STALE_DAYS (7) before the supplied now", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const stale = computeStaleDate(now);
    const diffDays = (now.getTime() - stale.getTime()) / (1000 * 60 * 60 * 24);
    assert.strictEqual(diffDays, STALE_DAYS);
    assert.strictEqual(diffDays, 7);
  });

  it("returns a finite date for the default now", () => {
    assert.strictEqual(Number.isNaN(computeStaleDate().getTime()), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Rate-limit + progress gates (real exports)
// ══════════════════════════════════════════════════════════════════════

describe("shouldSleepAfterIndex (real export)", () => {
  it("sleeps after every fund except the last", () => {
    assert.strictEqual(shouldSleepAfterIndex(0, 3), true);
    assert.strictEqual(shouldSleepAfterIndex(1, 3), true);
    assert.strictEqual(shouldSleepAfterIndex(2, 3), false); // last
  });

  it("never sleeps for a single fund", () => {
    assert.strictEqual(shouldSleepAfterIndex(0, 1), false);
  });
});

describe("shouldLogProgress (real export)", () => {
  it("logs every PROGRESS_LOG_EVERY (50) funds (1-based)", () => {
    assert.strictEqual(PROGRESS_LOG_EVERY, 50);
    assert.strictEqual(shouldLogProgress(49), true); // 50th fund
    assert.strictEqual(shouldLogProgress(99), true); // 100th fund
    assert.strictEqual(shouldLogProgress(0), false);
    assert.strictEqual(shouldLogProgress(48), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors the processor's enrich loop using the SAME
// real gates (the real processor boots Prisma + Kuvera at import).
// ══════════════════════════════════════════════════════════════════════

interface Fund {
  schemeCode: string;
}

async function runMfMetadataSequence(
  data: { batchSize?: number; delayMs?: number; forceReEnrich?: boolean },
  funds: Fund[],
  enrichFn: (schemeCode: string) => Promise<{ enriched: boolean }>,
  sleepFn: (ms: number) => Promise<void>
): Promise<{ enriched: number; failed: number; sleeps: number[] }> {
  const { delayMs } = resolveMfMetadataParams(data);
  let enriched = 0;
  let failed = 0;
  const sleeps: number[] = [];

  for (let i = 0; i < funds.length; i++) {
    const result = await enrichFn(funds[i]!.schemeCode);
    if (result.enriched) enriched++;
    else failed++;
    if (shouldSleepAfterIndex(i, funds.length)) {
      sleeps.push(delayMs);
      await sleepFn(delayMs);
    }
  }
  return { enriched, failed, sleeps };
}

describe("mf-metadata enrich sequence (real gates)", () => {
  const enrichOk = async () => ({ enriched: true });
  const noop = async () => {};

  it("counts enriched and failed correctly for a mixed batch", async () => {
    const funds = [
      { schemeCode: "SC001" },
      { schemeCode: "SC002" },
      { schemeCode: "SC003" },
    ];
    const results: Record<string, boolean> = {
      SC001: true,
      SC002: false,
      SC003: true,
    };
    const out = await runMfMetadataSequence(
      {},
      funds,
      async (sc) => ({ enriched: results[sc]! }),
      noop
    );
    assert.strictEqual(out.enriched, 2);
    assert.strictEqual(out.failed, 1);
  });

  it("sleeps between funds with the resolved delay, never after the last", async () => {
    const funds = [
      { schemeCode: "A" },
      { schemeCode: "B" },
      { schemeCode: "C" },
    ];
    const out = await runMfMetadataSequence(
      { delayMs: 200 },
      funds,
      enrichOk,
      noop
    );
    assert.deepStrictEqual(out.sleeps, [200, 200]);
  });

  it("does not sleep for a single fund", async () => {
    const out = await runMfMetadataSequence(
      {},
      [{ schemeCode: "A" }],
      enrichOk,
      noop
    );
    assert.strictEqual(out.sleeps.length, 0);
  });

  it("returns zero counts and no sleeps for an empty batch", async () => {
    const out = await runMfMetadataSequence({}, [], enrichOk, noop);
    assert.strictEqual(out.enriched, 0);
    assert.strictEqual(out.failed, 0);
    assert.strictEqual(out.sleeps.length, 0);
  });
});
