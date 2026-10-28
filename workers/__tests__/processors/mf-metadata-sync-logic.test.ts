/**
 * MF metadata sync — cursor WHERE + run-health gate — REAL exports (MONEY-1205).
 *
 * Source: workers/src/processors/mf-metadata-sync-logic.ts (imported and CALLED
 * by workers/src/processors/mf-metadata-sync.ts).
 *
 * Two defects are pinned here:
 *
 *  1. **The cursor could not reach 6,960 funds.** The WHERE clause's only
 *     "never enriched" branch was `{ metadataSyncedAt: null }`, and Prisma +
 *     MongoDB does NOT match an ABSENT field with `null`. Measured on prod
 *     2026-08-18 over 14,223 active schemes: 7,263 rows store a date, 6,960 have
 *     no `metadataSyncedAt` key at all; the old clause selected exactly the
 *     7,263 already-attempted rows and never the 6,960.
 *     The structural assertions below pin the `isSet:false` branch; the
 *     SEMANTIC proof (that MongoDB really does treat the two shapes
 *     differently) needs a server and lives in `mf-metadata-cursor-db.test.ts`.
 *
 *  2. **`enriched=0` exited 0.** The processor logged
 *     `Done: enriched=0, failed=500` and returned normally, so Pub/Sub acked and
 *     Cloud Scheduler recorded a success — for three months, against an upstream
 *     that had been 404ing for every ISIN the whole time. Same class as
 *     MONEY-1189's wrong-granularity completeness check.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveMfMetadataParams,
  buildMfMetadataWhere,
  computeStaleDate,
  shouldSleepAfterIndex,
  shouldLogProgress,
  judgeMfMetadataHealth,
  DEFAULT_BATCH_SIZE,
  DEFAULT_DELAY_MS,
  STALE_DAYS,
  PROGRESS_LOG_EVERY,
  type MfMetadataRunTally,
} from "../../src/processors/mf-metadata-sync-logic";

// ══════════════════════════════════════════════════════════════════════
// Params / stale date / gates
// ══════════════════════════════════════════════════════════════════════

describe("resolveMfMetadataParams (real export)", () => {
  it("applies the documented defaults", () => {
    const p = resolveMfMetadataParams({});
    assert.equal(p.batchSize, DEFAULT_BATCH_SIZE);
    assert.equal(p.batchSize, 500);
    assert.equal(p.delayMs, DEFAULT_DELAY_MS);
    assert.equal(p.delayMs, 1000);
    assert.equal(p.forceReEnrich, false);
  });

  it("respects overrides", () => {
    const p = resolveMfMetadataParams({
      batchSize: 100,
      delayMs: 500,
      forceReEnrich: true,
    });
    assert.equal(p.batchSize, 100);
    assert.equal(p.delayMs, 500);
    assert.equal(p.forceReEnrich, true);
  });
});

describe("computeStaleDate (real export)", () => {
  it("is exactly STALE_DAYS (7) before the supplied now", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const diffDays =
      (now.getTime() - computeStaleDate(now).getTime()) / 86_400_000;
    assert.equal(diffDays, STALE_DAYS);
    assert.equal(diffDays, 7);
  });
});

describe("rate-limit + progress gates (real exports)", () => {
  it("sleeps after every fund except the last", () => {
    assert.equal(shouldSleepAfterIndex(0, 3), true);
    assert.equal(shouldSleepAfterIndex(1, 3), true);
    assert.equal(shouldSleepAfterIndex(2, 3), false);
    assert.equal(shouldSleepAfterIndex(0, 1), false);
  });

  it("logs every PROGRESS_LOG_EVERY (50) funds, 1-based", () => {
    assert.equal(PROGRESS_LOG_EVERY, 50);
    assert.equal(shouldLogProgress(49), true);
    assert.equal(shouldLogProgress(99), true);
    assert.equal(shouldLogProgress(0), false);
    assert.equal(shouldLogProgress(48), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// DEFECT 1 — the cursor WHERE clause
// ══════════════════════════════════════════════════════════════════════

describe("buildMfMetadataWhere (real export) — the isSet:false branch", () => {
  it("carries THREE branches: absent, explicit null, and stale", () => {
    const where = buildMfMetadataWhere(false);
    assert.equal(where.isActive, true);
    assert.ok("OR" in where, "non-force mode must include an OR clause");
    if (!("OR" in where)) return;
    assert.equal(
      where.OR.length,
      3,
      "absent / explicit-null / stale — dropping any one silently strands a population",
    );
  });

  it("MATCHES AN ABSENT FIELD via `isSet: false` (the 6,960-row fix)", () => {
    const where = buildMfMetadataWhere(false);
    if (!("OR" in where)) throw new Error("expected an OR clause");

    const hasIsSet = where.OR.some(
      (branch) =>
        "metadataSyncedAt" in branch &&
        typeof branch.metadataSyncedAt === "object" &&
        branch.metadataSyncedAt !== null &&
        "isSet" in branch.metadataSyncedAt &&
        branch.metadataSyncedAt.isSet === false,
    );
    assert.ok(
      hasIsSet,
      "without `{ metadataSyncedAt: { isSet: false } }` the 6,960 prod rows " +
        "whose field is absent can NEVER be selected — Prisma+Mongo `null` " +
        "matches only an explicitly stored null",
    );
  });

  it("STILL matches an explicitly stored null (neither predicate subsumes the other)", () => {
    const where = buildMfMetadataWhere(false);
    if (!("OR" in where)) throw new Error("expected an OR clause");
    const hasNull = where.OR.some(
      (branch) =>
        "metadataSyncedAt" in branch && branch.metadataSyncedAt === null,
    );
    assert.ok(
      hasNull,
      "an explicit null is a real shape a partial write can produce",
    );
  });

  it("uses the supplied stale date in the range branch", () => {
    const stale = new Date("2026-01-01T00:00:00Z");
    const where = buildMfMetadataWhere(false, stale);
    if (!("OR" in where)) throw new Error("expected an OR clause");
    const range = where.OR.find(
      (b) =>
        "metadataSyncedAt" in b &&
        typeof b.metadataSyncedAt === "object" &&
        b.metadataSyncedAt !== null &&
        "lt" in b.metadataSyncedAt,
    );
    assert.ok(range, "expected an { lt: staleDate } branch");
    const lt = (range as { metadataSyncedAt: { lt: Date } }).metadataSyncedAt
      .lt;
    assert.equal(lt.getTime(), stale.getTime());
  });

  it("only filters by isActive when forceReEnrich is true", () => {
    assert.deepEqual(buildMfMetadataWhere(true), { isActive: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// DEFECT 2 — the liveness gate
// ══════════════════════════════════════════════════════════════════════

function tally(over: Partial<MfMetadataRunTally> = {}): MfMetadataRunTally {
  return {
    selected: 0,
    enriched: 0,
    attempted: 0,
    stamped: 0,
    fieldsExtracted: 0,
    ...over,
  };
}

describe("judgeMfMetadataHealth (real export)", () => {
  it("0 USABLE ROWS ACROSS A FULL BATCH => NOT ok (the run must throw)", () => {
    // The exact prod shape: 500 funds selected, the provider reached for all of
    // them, zero fields extracted. This previously logged and exited 0.
    const h = judgeMfMetadataHealth(
      tally({ selected: 500, attempted: 500, enriched: 0, stamped: 500 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.level, "error");
    assert.equal(h.reason, "provider-dead");
    assert.match(h.message, /ZERO usable fields/);
  });

  it("distinguishes 'we never reached the provider' from 'the provider is dead'", () => {
    const h = judgeMfMetadataHealth(
      tally({ selected: 500, attempted: 0, enriched: 0, stamped: 500 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.reason, "no-fund-reachable");
    assert.match(h.message, /would not change this outcome/);
  });

  it("an EMPTY batch is healthy — 'nothing is stale' is a real steady state", () => {
    const h = judgeMfMetadataHealth(tally({ selected: 0 }));
    assert.equal(h.ok, true);
    assert.equal(h.reason, "empty-batch");
    assert.equal(h.level, "info");
  });

  it("ANY enrichment makes the run healthy, even a mostly-failing batch", () => {
    // `stamped` added to the fixture by MONEY-1238, not to weaken this case but
    // to keep it about what it says: the ENRICHMENT ratio. The helper defaults
    // `stamped: 0`, which since MONEY-1238 is its own failure (see the
    // cursor-stuck case below) — a state this test never meant to assert, and
    // which did not exist as a verdict when it was written.
    const h = judgeMfMetadataHealth(
      tally({
        selected: 500,
        attempted: 500,
        enriched: 1,
        stamped: 500,
        fieldsExtracted: 3,
      }),
    );
    assert.equal(h.ok, true);
    assert.equal(h.reason, "ok");
  });

  it("MONEY-1238: enrichment with a STUCK cursor is not healthy", () => {
    // The state that hid underneath the rung above. `stamped` is documented as
    // "cursor advanced" and was read by nothing: enrich 3 of 500, stamp none,
    // and the run reported success while the SAME 500 funds were re-selected
    // every Sunday, forever. That is MONEY-1211 — a rotation that never
    // rotates — with the detector present but unwired.
    const h = judgeMfMetadataHealth(
      tally({ selected: 500, attempted: 500, enriched: 3, stamped: 0 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.reason, "cursor-stuck");
  });

  it("MONEY-1238: a dead provider still reads as provider-dead, not cursor-stuck", () => {
    // Ordering matters more than the boolean here. A dead provider stamps
    // nothing either, so an unguarded `stamped === 0` check would answer "the
    // cursor is stuck" for an upstream outage and send the operator to the
    // wrong system. Both verdicts fail the run; only one is actionable.
    const h = judgeMfMetadataHealth(
      tally({ selected: 500, attempted: 500, enriched: 0, stamped: 0 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.reason, "provider-dead");
  });

  it("MONEY-1238: a PARTIAL stamp stays healthy but says so", () => {
    // A fund that errored should be retried, so a partial stamp is legitimate
    // and must not fail the run — it rides in the message instead, or the
    // check would be flaky enough to be muted, which is how the original
    // signal became inert in the first place.
    const h = judgeMfMetadataHealth(
      tally({
        selected: 500,
        attempted: 500,
        enriched: 400,
        stamped: 480,
        fieldsExtracted: 900,
      }),
    );
    assert.equal(h.ok, true);
    assert.match(h.message, /20 unstamped fund\(s\) will be re-selected/);
  });

  it("a single selected fund that yields nothing still fails (no sample floor)", () => {
    // Deliberately no minimum-sample threshold: the whole batch runs against ONE
    // provider, so 0-for-1 is the same signal as 0-for-500, just cheaper.
    const h = judgeMfMetadataHealth(
      tally({ selected: 1, attempted: 1, enriched: 0 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.reason, "provider-dead");
  });
});
