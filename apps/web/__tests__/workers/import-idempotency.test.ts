/**
 * Worker Import Idempotency Tests (workers/src/processors/import.ts) — DE-SHADOWED.
 *
 * The previous version SHADOWED the worker: it inlined a local `upsertImportLog`
 * "(mirrors workers/src/processors/import.ts)" plus a whole copy of
 * `processImport` and asserted the COPY — green even though the real worker's
 * helper could diverge.
 *
 * The Pub/Sub-retry idempotency CONTRACT now lives in a pure, exported helper —
 * `buildImportLogUpsertArgs` in `workers/src/processors/import-logic.ts`, which
 * the worker's `upsertImportLog` CALLS. This file asserts that REAL export (and
 * `resolveImportStatus`, which sets the persisted ImportLog status), then drives
 * a retry harness that builds its upsert args by calling the SAME export — so a
 * redelivered job converging onto ONE ImportLog row is proven against shipped
 * code. The full processImport lifecycle (PROCESSING → COMPLETED/FAILED, error
 * bubbling) is covered in `processor-import.test.ts`.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildImportLogUpsertArgs,
  resolveImportStatus,
} from "../../../../workers/src/processors/import-logic";

// A representative ImportLog row payload (the shape the worker upserts).
// `importBatchId` is required (the upsert unique key); any extra field (e.g.
// `errorDetails` on a failed import) is allowed via the index signature.
type LogData = {
  importBatchId: string;
  [key: string]: unknown;
};

function makeLogData(overrides?: Record<string, unknown>): LogData {
  return {
    userId: "u-1",
    importBatchId: "batch-1",
    fileName: "trades.csv",
    fileSize: null,
    brokerFormat: "zerodha",
    linkedBroker: null,
    linkedBrokerUserId: null,
    linkedToManual: false,
    totalRows: 5,
    importedCount: 5,
    skippedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    status: "COMPLETED",
    completedAt: new Date(),
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════
// buildImportLogUpsertArgs — the idempotency contract (real export)
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.buildImportLogUpsertArgs (real export)", () => {
  it("keys the upsert WHERE on importBatchId (the @unique field)", () => {
    const args = buildImportLogUpsertArgs(makeLogData());
    assert.deepStrictEqual(args.where, { importBatchId: "batch-1" });
  });

  it("create carries the FULL payload (incl. importBatchId)", () => {
    const args = buildImportLogUpsertArgs(makeLogData());
    assert.strictEqual(args.create.importBatchId, "batch-1");
    assert.strictEqual(args.create.userId, "u-1");
    assert.strictEqual(args.create.importedCount, 5);
    assert.strictEqual(args.create.status, "COMPLETED");
  });

  it("update EXCLUDES importBatchId (cannot rewrite the unique key)", () => {
    const args = buildImportLogUpsertArgs(makeLogData());
    assert.strictEqual("importBatchId" in args.update, false);
    // …but keeps every other field so a retry refreshes the row.
    assert.strictEqual(args.update.userId, "u-1");
    assert.strictEqual(args.update.importedCount, 5);
    assert.strictEqual(args.update.status, "COMPLETED");
  });

  it("create and update reflect the same updated counts on a retry payload", () => {
    const args = buildImportLogUpsertArgs(
      makeLogData({ importedCount: 3, skippedCount: 2, duplicateCount: 2 })
    );
    assert.strictEqual(args.create.importedCount, 3);
    assert.strictEqual(args.update.importedCount, 3);
    assert.strictEqual(args.update.skippedCount, 2);
    assert.strictEqual(args.update.duplicateCount, 2);
  });

  it("does not mutate the input payload", () => {
    const data = makeLogData();
    buildImportLogUpsertArgs(data);
    // importBatchId must still be present on the original object.
    assert.strictEqual(data.importBatchId, "batch-1");
  });

  it("carries a FAILED-import payload through unchanged in create", () => {
    const args = buildImportLogUpsertArgs(
      makeLogData({
        status: "FAILED",
        importedCount: 0,
        errorCount: 1,
        totalRows: 0,
        errorDetails: [{ row: 0, error: "No content or file URL provided" }],
      })
    );
    assert.strictEqual(args.create.status, "FAILED");
    assert.strictEqual(args.create.errorCount, 1);
    const details = args.create.errorDetails as Array<{
      row: number;
      error: string;
    }>;
    assert.strictEqual(details[0]!.error, "No content or file URL provided");
  });
});

// ══════════════════════════════════════════════════════════════════════
// resolveImportStatus — the status the failed/partial ImportLog gets
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.resolveImportStatus (real export)", () => {
  it("imported>0 with errors → PARTIALLY_COMPLETED", () => {
    assert.strictEqual(resolveImportStatus(2, 1), "PARTIALLY_COMPLETED");
  });
  it("nothing imported with errors → FAILED", () => {
    assert.strictEqual(resolveImportStatus(0, 3), "FAILED");
  });
  it("no errors → COMPLETED", () => {
    assert.strictEqual(resolveImportStatus(4, 0), "COMPLETED");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Retry harness — Pub/Sub redelivery converges onto ONE ImportLog row.
// The upsert args are built by the REAL export; the mock just records them and
// simulates the unique-key upsert semantics.
// ══════════════════════════════════════════════════════════════════════

interface UpsertCall {
  where: { importBatchId: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** Tiny in-memory ImportLog table keyed by importBatchId, upsert-honest. */
class ImportLogTable {
  rows = new Map<string, Record<string, unknown>>();
  calls: UpsertCall[] = [];

  upsert(args: UpsertCall) {
    this.calls.push(args);
    const key = args.where.importBatchId;
    if (this.rows.has(key)) {
      this.rows.set(key, { ...this.rows.get(key)!, ...args.update });
    } else {
      this.rows.set(key, { ...args.create });
    }
  }
}

/** Mirror the worker's terminal upsert: build args via the REAL export, upsert. */
function persistImportLog(
  table: ImportLogTable,
  payload: ReturnType<typeof makeLogData>
) {
  table.upsert(buildImportLogUpsertArgs(payload) as UpsertCall);
}

describe("ImportLog upsert is idempotent across Pub/Sub redelivery", () => {
  let table: ImportLogTable;

  beforeEach(() => {
    table = new ImportLogTable();
  });

  it("first delivery CREATEs the row", () => {
    persistImportLog(table, makeLogData({ importBatchId: "b-create" }));
    assert.strictEqual(table.rows.size, 1);
    assert.strictEqual(table.rows.get("b-create")!.status, "COMPLETED");
  });

  it("a redelivery of the same job does NOT create a second row", () => {
    persistImportLog(table, makeLogData({ importBatchId: "b-retry" }));
    persistImportLog(table, makeLogData({ importBatchId: "b-retry" }));

    // Two upsert calls, but exactly one persisted row (converged).
    assert.strictEqual(table.calls.length, 2);
    assert.strictEqual(table.rows.size, 1);
    // Both calls targeted the same unique key.
    assert.strictEqual(table.calls[0]!.where.importBatchId, "b-retry");
    assert.strictEqual(table.calls[1]!.where.importBatchId, "b-retry");
  });

  it("a redelivery with refreshed counts UPDATEs the existing row in place", () => {
    persistImportLog(
      table,
      makeLogData({
        importBatchId: "b-upd",
        importedCount: 5,
        status: "COMPLETED",
      })
    );
    // Retry recomputes (e.g. partial) — same batch id, new counts.
    persistImportLog(
      table,
      makeLogData({
        importBatchId: "b-upd",
        importedCount: 3,
        errorCount: 1,
        status: "PARTIALLY_COMPLETED",
      })
    );

    assert.strictEqual(table.rows.size, 1);
    const row = table.rows.get("b-upd")!;
    assert.strictEqual(row.importedCount, 3);
    assert.strictEqual(row.status, "PARTIALLY_COMPLETED");
  });

  it("a FAILED retry of an initially-FAILED job stays a single row", () => {
    const failed = makeLogData({
      importBatchId: "b-fail",
      status: "FAILED",
      importedCount: 0,
      errorCount: 1,
      totalRows: 0,
    });
    persistImportLog(table, failed);
    persistImportLog(table, failed);

    assert.strictEqual(table.rows.size, 1);
    assert.strictEqual(table.rows.get("b-fail")!.status, "FAILED");
  });
});
