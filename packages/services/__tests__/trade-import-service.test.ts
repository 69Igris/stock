/**
 * trade-import.service async triggers — REAL exports, injected prisma (MONEY-1062).
 *
 * `@usemoney/services` runs its suite as ESM (no `require.cache` prisma
 * injection), so a fake prisma is injected via each function's `deps` seam.
 * Pins the API/mobile parity contract on the code that ships:
 *   - startTradeImport creates the pollable CSV_IMPORT row (queueName + a
 *     content-FREE payload) and returns its jobId; a row-create failure is a
 *     hard INTERNAL (G3 — the route must not publish an untrackable import),
 *   - retryImport recreates only the stored failed rows, skips ones that now
 *     exist, and rewrites the ImportLog counts + status; a missing log is
 *     NOT_FOUND and "nothing to retry" is a code-less 400.
 *
 * Source: packages/services/src/trade-import.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startTradeImport,
  retryImport,
  type StartTradeImportDeps,
  type RetryImportDeps,
} from "../src/trade-import.service";

interface DbCall {
  where?: unknown;
  data?: unknown;
}

// ── startTradeImport ─────────────────────────────────────────────────────────

function fakeStartDb(opts: { createThrows?: boolean }): {
  prisma: StartTradeImportDeps["prisma"];
  created: DbCall[];
} {
  const created: DbCall[] = [];
  const prisma = {
    backgroundJob: {
      create: async (args: DbCall) => {
        if (opts.createThrows) throw new Error("insert failed");
        created.push(args);
        return args.data;
      },
    },
  } as unknown as StartTradeImportDeps["prisma"];
  return { prisma, created };
}

describe("startTradeImport — create the pollable job row (real fn, injected prisma)", () => {
  it("creates a CSV_IMPORT row with a content-free payload and returns the jobId", async () => {
    const { prisma, created } = fakeStartDb({});
    const res = await startTradeImport(
      "user_1",
      {
        brokerFormat: "zerodha",
        fileType: "csv",
        fileName: "trades.csv",
        contentLength: 4096,
        brokerConnectionId: "bc_1",
        linkToManual: false,
      },
      { prisma },
    );
    assert.equal(res.success, true);
    if (res.success) assert.ok(res.data.jobId.length > 0);
    assert.equal(created.length, 1);
    const data = created[0]!.data as Record<string, unknown>;
    assert.equal(data.jobType, "CSV_IMPORT");
    assert.equal(data.status, "PENDING");
    assert.equal(data.userId, "user_1");
    // queueName resolves to the env-suffixed CSV_IMPORT topic
    assert.match(String(data.queueName), /^csv-import-/);
    const payload = data.payload as Record<string, unknown>;
    assert.equal(payload.contentLength, 4096); // length only — never the content
    assert.equal(payload.brokerFormat, "zerodha");
    assert.equal(payload.fileType, "csv");
    assert.equal(payload.brokerConnectionId, "bc_1");
    // the raw CSV text is NOT stored in the job payload
    assert.equal("content" in payload, false);
    assert.equal("csvText" in payload, false);
  });

  it("a row-create failure is a hard INTERNAL (NOT best-effort — the route must not publish)", async () => {
    const { prisma } = fakeStartDb({ createThrows: true });
    const res = await startTradeImport(
      "user_1",
      { brokerFormat: "generic", fileType: "csv", contentLength: 10 },
      { prisma },
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
  });
});

// ── retryImport ──────────────────────────────────────────────────────────────

const VALID_ROW = {
  symbol: "RELIANCE",
  isin: null,
  tradeDate: "2025-01-15",
  tradeType: "BUY",
  quantity: 10,
  price: 100,
  exchange: "NSE",
  segment: "EQ",
  orderType: "MARKET",
  productType: "CNC",
  tradeId: null,
  orderId: null,
  tradeTime: null,
  expiryDate: null,
};

function importLogWith(errorDetails: unknown): Record<string, unknown> {
  return {
    id: "log_1",
    importBatchId: "b1",
    userId: "user_1",
    importedCount: 5,
    linkedBroker: null,
    linkedBrokerUserId: null,
    linkedToManual: false,
    errorDetails,
  };
}

function fakeRetryDb(opts: {
  importLog?: unknown; // undefined → not found
  existingTrade?: unknown; // trade.findFirst result (null → will create)
  createThrows?: boolean;
}): {
  prisma: RetryImportDeps["prisma"];
  created: DbCall[];
  updates: DbCall[];
} {
  const created: DbCall[] = [];
  const updates: DbCall[] = [];
  const prisma = {
    importLog: {
      findFirst: async () =>
        opts.importLog === undefined ? null : opts.importLog,
      update: async (args: DbCall) => {
        updates.push(args);
        return {};
      },
    },
    trade: {
      findFirst: async () => opts.existingTrade ?? null,
      create: async (args: DbCall) => {
        if (opts.createThrows) throw new Error("create failed");
        created.push(args);
        return {};
      },
    },
  } as unknown as RetryImportDeps["prisma"];
  return { prisma, created, updates };
}

describe("retryImport — retry the failed rows (real fn, injected prisma)", () => {
  it("a missing/foreign log → NOT_FOUND", async () => {
    const { prisma } = fakeRetryDb({ importLog: undefined });
    const res = await retryImport("user_1", "ghost", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NOT_FOUND");
  });

  it("a log with no error rows → code-less 'No failed rows to retry'", async () => {
    const { prisma } = fakeRetryDb({ importLog: importLogWith([]) });
    const res = await retryImport("user_1", "b1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.code, undefined);
      assert.match(res.error, /no failed rows/i);
    }
  });

  it("error rows without stored data → code-less 'No row data stored'", async () => {
    const { prisma } = fakeRetryDb({
      importLog: importLogWith([{ row: 3, error: "boom" }]), // no `data`
    });
    const res = await retryImport("user_1", "b1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.match(res.error, /no row data stored/i);
  });

  it("recreates a stored failed row, then marks the log COMPLETED", async () => {
    const { prisma, created, updates } = fakeRetryDb({
      importLog: importLogWith([
        { row: 3, error: "prev fail", data: VALID_ROW },
      ]),
      existingTrade: null, // does not exist yet → create
    });
    const res = await retryImport("user_1", "b1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data, { retried: 1, succeeded: 1, failed: 0 });
    }
    assert.equal(created.length, 1);
    // recreated with the batch id + a computed duplicateHash
    const tradeData = created[0]!.data as Record<string, unknown>;
    assert.equal(tradeData.importBatchId, "b1");
    assert.ok(tradeData.duplicateHash);
    // ImportLog rewritten: importedCount 5+1, errorCount 0 → COMPLETED
    const upd = updates[0]!.data as Record<string, unknown>;
    assert.equal(upd.importedCount, 6);
    assert.equal(upd.errorCount, 0);
    assert.equal(upd.status, "COMPLETED");
  });

  it("a row that now EXISTS is counted resolved, not duplicated", async () => {
    const { prisma, created } = fakeRetryDb({
      importLog: importLogWith([
        { row: 3, error: "prev fail", data: VALID_ROW },
      ]),
      existingTrade: { id: "t_existing" }, // already present
    });
    const res = await retryImport("user_1", "b1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.succeeded, 1);
    assert.equal(created.length, 0); // no duplicate insert
  });

  it("a create failure counts as failed → PARTIALLY_COMPLETED", async () => {
    const { prisma, updates } = fakeRetryDb({
      importLog: importLogWith([
        { row: 3, error: "prev fail", data: VALID_ROW },
      ]),
      existingTrade: null,
      createThrows: true,
    });
    const res = await retryImport("user_1", "b1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data, { retried: 1, succeeded: 0, failed: 1 });
    }
    const upd = updates[0]!.data as Record<string, unknown>;
    assert.equal(upd.errorCount, 1);
    assert.equal(upd.status, "PARTIALLY_COMPLETED"); // importedCount 5 (>0)
  });
});
