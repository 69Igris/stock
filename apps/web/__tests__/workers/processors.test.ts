/**
 * Worker Processors — shared job-lifecycle contract (DE-SHADOWED, MONEY-620).
 *
 * The previous version of this aggregate file SHADOWED every worker processor:
 * it declared SEVEN local replicas — `processPairing` / `processImport` /
 * `processSync` (TODO-placeholder stubs) plus dependency-injected copies of
 * `processInstrumentSync` / `processPriceSync` / `processSectorEnrichment` /
 * `processMfSync` — and asserted those COPIES. None imported a real worker
 * symbol, so the suite stayed green against code that does not exist in
 * production. Worse, the copies had DIVERGED from the real source:
 *
 *   - `processPairing` shadow returned `result: { success, processed: 0 }`; the
 *     REAL `pairing.ts` returns `{ success, tradesProcessed, pairedViewsCreated,
 *     openPositions, closedPositions, partialPositions, totalRealizedPnL }` after
 *     running `pairTradesFIFO`. The stub tested a placeholder, not the algorithm.
 *   - `processImport` shadow returned `result: { success, imported: 0, errors: [] }`;
 *     the REAL `import.ts` returns `{ success, imported, skipped, total, errors }`
 *     (note `skipped` + `total`, and a CAPPED errors array) after CSV/XLSX parse +
 *     dedup + finite-guarded trade-value persistence.
 *   - `processSync` shadow returned `result: { success, synced: 0 }` (a number);
 *     the REAL `sync.ts` returns `{ success, synced: <stats object>, total }`.
 *   - `processSectorEnrichment` shadow defaulted `exchanges=["NSE"]`, `delayMs=2000`,
 *     `batchSize=100`; the REAL source defaults `exchanges=["NSE","BSE"]`,
 *     `delayMs=500`, `batchSize=500`. The shadow asserted the WRONG defaults.
 *
 * Verdict + redistribution (every assertion now runs SHIPPED code):
 *
 *  - pairing → de-shadowed in `processor-pairing.test.ts` + `pairing-edge-cases.test.ts`
 *    (import the REAL `pairing-logic.ts` exports + run the REAL `pairTradesFIFO`).
 *  - import  → de-shadowed in `processor-import.test.ts` + `import-idempotency.test.ts`
 *    (import the REAL `import-logic.ts` exports + REAL `@usemoney/core/import` parser).
 *  - sync / instrument-sync / price-sync / sector-enrichment / mf-sync → each has a
 *    dedicated suite (`processor-sync.test.ts`, `instrument-sync.test.ts`,
 *    `processor-price-sync.test.ts`, `processor-sector-enrichment.test.ts`,
 *    `mf-sync.test.ts`); the aggregate's DI copies added nothing real over those, so
 *    they are deleted as redundant inline shadows.
 *
 * What remains here is the ONE thing that genuinely belongs in a cross-processor
 * file and was the aggregate's real intent: the shared BackgroundJob lifecycle
 * (PROCESSING → COMPLETED / FAILED) and the import `result` payload. Both the
 * import processor AND (structurally) the pairing/sync processors funnel job
 * status through the SAME stamping contract, which is now a single exported
 * helper — `buildJobStatusUpdate` + `buildImportResult` in
 * `workers/src/processors/import-logic.ts`, which `import.ts` CALLS. This suite
 * asserts those REAL exports: the status stamping (startedAt / completedAt /
 * progress=100 / errorMessage) and the error-message-capture branch that the old
 * inline "Lifecycle" + "Error message capture" describe blocks tried (and failed)
 * to prove against a copy.
 *
 * @see workers/src/processors/import-logic.ts (the real exports under test)
 * @see workers/src/processors/import.ts (the caller that funnels every status patch through them)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL shared job-lifecycle helpers under test (no shadow). The worker
// processors CALL these to stamp BackgroundJob status + build the result.
import {
  buildJobStatusUpdate,
  buildImportResult,
  MAX_IMPORT_RESULT_ERRORS,
  type ImportJobStatus,
} from "../../../../workers/src/processors/import-logic";

// ══════════════════════════════════════════════════════════════════════
// buildJobStatusUpdate — the BackgroundJob status patch (real export)
//
// This is the single source of the PROCESSING → COMPLETED/FAILED stamping the
// processors share. PROCESSING stamps `startedAt`; terminal states stamp
// `completedAt`; COMPLETED pins `progress=100` (+ optional `result`); FAILED
// carries an optional `errorMessage`.
// ══════════════════════════════════════════════════════════════════════

describe("Workers job lifecycle — buildJobStatusUpdate (real export)", () => {
  it("PROCESSING stamps startedAt and nothing terminal", () => {
    const before = new Date();
    const patch = buildJobStatusUpdate("PROCESSING");
    const after = new Date();

    assert.strictEqual(patch.status, "PROCESSING");
    assert.ok(patch.startedAt instanceof Date);
    assert.ok((patch.startedAt as Date) >= before);
    assert.ok((patch.startedAt as Date) <= after);
    // PROCESSING must NOT prematurely stamp a terminal state.
    assert.strictEqual("completedAt" in patch, false);
    assert.strictEqual("progress" in patch, false);
    assert.strictEqual("result" in patch, false);
    assert.strictEqual("errorMessage" in patch, false);
  });

  it("COMPLETED stamps completedAt + progress=100", () => {
    const before = new Date();
    const patch = buildJobStatusUpdate("COMPLETED");
    const after = new Date();

    assert.strictEqual(patch.status, "COMPLETED");
    assert.strictEqual(patch.progress, 100);
    assert.ok(patch.completedAt instanceof Date);
    assert.ok((patch.completedAt as Date) >= before);
    assert.ok((patch.completedAt as Date) <= after);
    // COMPLETED is not a PROCESSING start — no startedAt restamp.
    assert.strictEqual("startedAt" in patch, false);
  });

  it("COMPLETED carries the result payload when provided", () => {
    const result = buildImportResult(3, 1, 4, []);
    const patch = buildJobStatusUpdate("COMPLETED", { result });

    assert.strictEqual(patch.status, "COMPLETED");
    assert.strictEqual(patch.progress, 100);
    assert.deepStrictEqual(patch.result, result);
  });

  it("COMPLETED without a result omits the result key entirely", () => {
    const patch = buildJobStatusUpdate("COMPLETED");
    assert.strictEqual("result" in patch, false);
  });

  it("FAILED stamps completedAt + errorMessage, never progress", () => {
    const before = new Date();
    const patch = buildJobStatusUpdate("FAILED", {
      errorMessage: "Pairing algorithm failed",
    });
    const after = new Date();

    assert.strictEqual(patch.status, "FAILED");
    assert.strictEqual(patch.errorMessage, "Pairing algorithm failed");
    assert.ok(patch.completedAt instanceof Date);
    assert.ok((patch.completedAt as Date) >= before);
    assert.ok((patch.completedAt as Date) <= after);
    // A failed job is done but not "100%" — progress must be absent here.
    assert.strictEqual("progress" in patch, false);
  });

  it("FAILED without a message omits errorMessage", () => {
    const patch = buildJobStatusUpdate("FAILED");
    assert.strictEqual(patch.status, "FAILED");
    assert.strictEqual("errorMessage" in patch, false);
    assert.ok(patch.completedAt instanceof Date);
  });

  it("does not leak a stale errorMessage onto a COMPLETED patch", () => {
    // Passing an errorMessage alongside COMPLETED must be ignored — a completed
    // job is not a failure.
    const patch = buildJobStatusUpdate("COMPLETED", {
      errorMessage: "ignored",
    });
    assert.strictEqual("errorMessage" in patch, false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Lifecycle: PROCESSING → COMPLETED / FAILED, asserted on real patches.
//
// Replaces the old "Lifecycle: PROCESSING → COMPLETED" + "Error message capture"
// describe blocks, which re-implemented the two updateMany payloads inline. Here
// the two patches are produced by the REAL export, so the same code the worker
// writes to BackgroundJob is what the test inspects.
// ══════════════════════════════════════════════════════════════════════

describe("Workers job lifecycle — PROCESSING → terminal transition (real export)", () => {
  it("a successful job: PROCESSING then COMPLETED with progress=100", () => {
    const start = buildJobStatusUpdate("PROCESSING");
    const done = buildJobStatusUpdate("COMPLETED", {
      result: buildImportResult(2, 0, 2, []),
    });

    assert.strictEqual(start.status, "PROCESSING");
    assert.strictEqual(done.status, "COMPLETED");
    assert.strictEqual(done.progress, 100);
    // The completion timestamp is at or after the processing-start timestamp.
    assert.ok((done.completedAt as Date) >= (start.startedAt as Date));
  });

  it("a failing job: PROCESSING then FAILED carrying the captured message", () => {
    const start = buildJobStatusUpdate("PROCESSING");
    // The worker computes `error instanceof Error ? error.message : "Unknown error"`
    // and passes it here; assert the captured Error.message survives onto the patch.
    const err = new Error("Broker token expired");
    const failed = buildJobStatusUpdate("FAILED", {
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    });

    assert.strictEqual(start.status, "PROCESSING");
    assert.strictEqual(failed.status, "FAILED");
    assert.strictEqual(failed.errorMessage, "Broker token expired");
  });

  it("captures the 'Unknown error' sentinel for a non-Error throw", () => {
    const thrown: unknown = "string error";
    const failed = buildJobStatusUpdate("FAILED", {
      errorMessage: thrown instanceof Error ? thrown.message : "Unknown error",
    });
    assert.strictEqual(failed.errorMessage, "Unknown error");
  });

  it("status type covers exactly the three worker job states", () => {
    // Compile-time + runtime guard that the union the processors switch on is
    // the one this helper accepts.
    const states: ImportJobStatus[] = ["PROCESSING", "COMPLETED", "FAILED"];
    for (const s of states) {
      assert.strictEqual(buildJobStatusUpdate(s).status, s);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildImportResult — the import job's `result` payload (real export)
//
// The import processor stamps this onto the COMPLETED BackgroundJob. The old
// shadow asserted a fictional `{ success, imported: 0, errors: [] }`; the real
// shape is `{ success, imported, skipped, total, errors }` with the errors array
// capped so an all-rows-fail batch can't bloat the job document.
// ══════════════════════════════════════════════════════════════════════

describe("Workers import result — buildImportResult (real export)", () => {
  it("packs the full real shape (imported + skipped + total + errors)", () => {
    const result = buildImportResult(5, 2, 7, ["row 3: bad price"]);
    assert.deepStrictEqual(result, {
      success: true,
      imported: 5,
      skipped: 2,
      total: 7,
      errors: ["row 3: bad price"],
    });
  });

  it("a clean import carries imported counts and an empty errors array", () => {
    const result = buildImportResult(10, 0, 10, []);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.imported, 10);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.total, 10);
    assert.deepStrictEqual(result.errors, []);
  });

  it("caps the errors array at MAX_IMPORT_RESULT_ERRORS", () => {
    const errs = Array.from({ length: 25 }, (_, i) => `err-${i}`);
    const result = buildImportResult(0, 0, 25, errs);
    assert.strictEqual(result.errors.length, MAX_IMPORT_RESULT_ERRORS);
    assert.strictEqual(result.errors[0], "err-0");
    assert.strictEqual(
      result.errors[MAX_IMPORT_RESULT_ERRORS - 1],
      `err-${MAX_IMPORT_RESULT_ERRORS - 1}`
    );
  });
});
