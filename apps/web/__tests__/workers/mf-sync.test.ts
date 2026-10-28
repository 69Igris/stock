/**
 * MF Sync Processor Tests (workers/src/processors/mf-sync.ts) — DE-SHADOWED.
 *
 * The previous version SHADOWED the processor: it declared a local
 * `async function processMfSync` "(mirrors workers/src/processors/mf-sync.ts)"
 * and asserted the COPY (a passthrough that just returned the injected sync
 * result). No real worker symbol was imported.
 *
 * This rewrite asserts ONLY real shipped code: the pure helpers exported from
 * `workers/src/processors/mf-sync-logic.ts`, which `mf-sync.ts` now CALLS —
 * `resolveForceFullSync` (the forceFullSync default the log line reads) and
 * `capMfErrorsForLog` (the AMFI error-log cap). The processor delegates the
 * actual NAV sync to `syncAmfiMutualFunds` (which fetches the AMFI feed + writes
 * MutualFundMaster at call time), so it can't be imported into a pure unit test;
 * the orchestration harness below mirrors its result/error passthrough using the
 * SAME real exports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker orchestration helpers under test (no shadow). mf-sync.ts CALLS these.
import {
  resolveForceFullSync,
  capMfErrorsForLog,
  MF_SYNC_ERROR_LOG_CAP,
} from "../../../../workers/src/processors/mf-sync-logic";

// ══════════════════════════════════════════════════════════════════════
// resolveForceFullSync (real export)
// ══════════════════════════════════════════════════════════════════════

describe("mf-sync-logic.resolveForceFullSync (real export)", () => {
  it("defaults to false when omitted", () => {
    assert.strictEqual(resolveForceFullSync({}), false);
  });

  it("returns false when explicitly false", () => {
    assert.strictEqual(resolveForceFullSync({ forceFullSync: false }), false);
  });

  it("returns true when explicitly true", () => {
    assert.strictEqual(resolveForceFullSync({ forceFullSync: true }), true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// capMfErrorsForLog (real export)
// ══════════════════════════════════════════════════════════════════════

describe("mf-sync-logic.capMfErrorsForLog (real export)", () => {
  it("caps a long error list at MF_SYNC_ERROR_LOG_CAP", () => {
    const errs = Array.from({ length: 50 }, (_, i) => `Error ${i + 1}`);
    const logged = capMfErrorsForLog(errs);
    assert.strictEqual(logged.length, MF_SYNC_ERROR_LOG_CAP);
    assert.strictEqual(logged[0], "Error 1");
    assert.strictEqual(logged[MF_SYNC_ERROR_LOG_CAP - 1], "Error 10");
  });

  it("returns a short list unchanged", () => {
    assert.deepStrictEqual(capMfErrorsForLog(["Parse error on line 42"]), [
      "Parse error on line 42",
    ]);
  });

  it("returns an empty array for no errors", () => {
    assert.deepStrictEqual(capMfErrorsForLog([]), []);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors the processor's syncAmfiMutualFunds → result
// passthrough + error-cap, via the SAME real exports. (The real processor boots
// the AMFI fetch at import, so it can't run in a pure unit test.)
// ══════════════════════════════════════════════════════════════════════

interface MfSyncResult {
  totalParsed: number;
  upserted: number;
  failed: number;
  errors: string[];
}

/** Re-runs the processor's delegate-and-report flow against an injected sync fn. */
async function runMfSyncSequence(
  data: { forceFullSync?: boolean },
  syncFn: () => Promise<MfSyncResult>
): Promise<{ forced: boolean; result: MfSyncResult; loggedErrors: string[] }> {
  const forced = resolveForceFullSync(data);
  const result = await syncFn();
  const loggedErrors =
    result.errors.length > 0 ? capMfErrorsForLog(result.errors) : [];
  return { forced, result, loggedErrors };
}

describe("mf-sync orchestration sequence (real exports)", () => {
  it("calls the AMFI sync exactly once and returns its result verbatim", async () => {
    let syncCount = 0;
    const out = await runMfSyncSequence({}, async () => {
      syncCount++;
      return { totalParsed: 10000, upserted: 9500, failed: 500, errors: [] };
    });

    assert.strictEqual(syncCount, 1);
    assert.strictEqual(out.result.totalParsed, 10000);
    assert.strictEqual(out.result.upserted, 9500);
    assert.strictEqual(out.result.failed, 500);
    assert.strictEqual(out.forced, false);
  });

  it("runs the sync regardless of the forceFullSync flag value", async () => {
    for (const forceFullSync of [true, false]) {
      let syncCount = 0;
      const out = await runMfSyncSequence({ forceFullSync }, async () => {
        syncCount++;
        return { totalParsed: 1, upserted: 1, failed: 0, errors: [] };
      });
      assert.strictEqual(syncCount, 1);
      assert.strictEqual(out.forced, forceFullSync);
    }
  });

  it("caps the logged errors at MF_SYNC_ERROR_LOG_CAP on a noisy parse", async () => {
    const errors = Array.from({ length: 25 }, (_, i) => `bad row ${i}`);
    const out = await runMfSyncSequence({}, async () => ({
      totalParsed: 1000,
      upserted: 975,
      failed: 25,
      errors,
    }));

    assert.strictEqual(out.loggedErrors.length, MF_SYNC_ERROR_LOG_CAP);
    assert.strictEqual(out.result.errors.length, 25); // result keeps the full list
  });

  it("logs no errors on a clean sync", async () => {
    const out = await runMfSyncSequence({}, async () => ({
      totalParsed: 100,
      upserted: 100,
      failed: 0,
      errors: [],
    }));
    assert.deepStrictEqual(out.loggedErrors, []);
  });

  it("propagates an upstream sync failure (no swallow)", async () => {
    await assert.rejects(
      () =>
        runMfSyncSequence({}, async () => {
          throw new Error("AMFI API unreachable");
        }),
      { message: "AMFI API unreachable" }
    );
  });

  it("handles a zero-result sync gracefully", async () => {
    const out = await runMfSyncSequence({}, async () => ({
      totalParsed: 0,
      upserted: 0,
      failed: 0,
      errors: [],
    }));
    assert.strictEqual(out.result.totalParsed, 0);
    assert.strictEqual(out.result.upserted, 0);
    assert.deepStrictEqual(out.loggedErrors, []);
  });
});
