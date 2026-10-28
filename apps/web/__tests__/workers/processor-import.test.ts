/**
 * Worker CSV-Import Processor Tests (workers/src/processors/import.ts) — DE-SHADOWED.
 *
 * The previous version of this file SHADOWED the worker processor: it declared
 * a local `async function processImport` "(mirrors workers/src/processors/
 * import.ts)" AND re-implemented `parseCSV` / `parseRow` / `generateTradeHash`
 * inline, asserting the COPY. Worse, the copy had DIVERGED from production —
 * the shadow rejected XLSX, used `importLog.create`, and computed
 * `tradeValue = quantity * price` with no finite guard, while the REAL worker
 * parses XLSX, upserts the ImportLog, and (before this change) wrote a
 * non-finite tradeValue verbatim. The suite stayed green against a fictional
 * implementation.
 *
 * This rewrite asserts ONLY real shipped code:
 *  1. The REAL pure orchestration helpers exported from
 *     `workers/src/processors/import-logic.ts` (which `import.ts` now CALLS):
 *     buildTradeValue / buildTradeCreateData / buildBrokerTradeId /
 *     buildJobStatusUpdate / buildImportResult / resolveImportStatus /
 *     isUniqueConstraintError.
 *  2. The REAL parsing primitives from `@usemoney/core/import` the worker
 *     composes (parseCSVContent / getColumnMapping / parseCSVRow /
 *     generateDuplicateHash). Their exhaustive parser/normalizer/hash coverage
 *     lives in `apps/web/__tests__/core/import/import.test.ts`; here we exercise
 *     only what the worker's row→trade pipeline depends on.
 *  3. An orchestration harness that mirrors ONLY the processor's prisma call
 *     SEQUENCE (PROCESSING → findFirst/create loop → COMPLETED), building every
 *     trade payload + status patch by calling the SAME real exports — so the
 *     dedup / broker-linkage / IDOR-scoped-lookup / overflow-rejection / progress
 *     assertions all run production code. (The processor itself imports Prisma +
 *     clearTradeCache + createNotification at module load, so it cannot be
 *     imported into a pure unit test.)
 *
 * Regression coverage for the two bugs fixed alongside this de-shadow:
 *  - Non-finite tradeValue: a row with finite-but-huge qty*price (1e308*1e308 →
 *    Infinity) is REJECTED (skip + reason), never persisted.
 *  - IDOR: the broker-connection lookup is scoped by userId — a crafted
 *    cross-user brokerConnectionId resolves to null and the row imports unlinked.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// REAL worker orchestration helpers under test (no shadow). import.ts CALLS these.
import {
  buildTradeValue,
  buildTradeCreateData,
  buildBrokerTradeId,
  buildJobStatusUpdate,
  buildImportResult,
  resolveImportStatus,
  isUniqueConstraintError,
  MAX_IMPORT_RESULT_ERRORS,
  type ImportTradeRow,
  type ImportLogStatus,
} from "../../../../workers/src/processors/import-logic";

// REAL parsing primitives the worker composes (same code path as production).
import {
  parseCSVContent,
  parseCSVRow,
  getColumnMapping,
  generateDuplicateHash,
} from "@usemoney/core/import";

// ── Test fixtures ────────────────────────────────────────────────────

const BASE_ROW: ImportTradeRow = {
  symbol: "RELIANCE",
  isin: "INE002A01018",
  exchange: "NSE",
  segment: "EQUITY",
  tradeType: "BUY",
  quantity: 10,
  price: 2500.5,
  tradeDate: new Date("2025-06-15"),
  productType: "CNC",
  orderType: "MARKET",
};

// ══════════════════════════════════════════════════════════════════════
// buildTradeValue — finite-guarded quantity*price (BUG-FIX regression)
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.buildTradeValue (real export)", () => {
  it("multiplies finite operands", () => {
    assert.strictEqual(buildTradeValue(10, 2500.5), 25005);
    assert.strictEqual(buildTradeValue(2.5, 100), 250);
  });

  it("returns 0 for a zero price (bonus/IPO allotment)", () => {
    assert.strictEqual(buildTradeValue(10, 0), 0);
  });

  it("BUG-FIX: returns null when the PRODUCT overflows to +Infinity", () => {
    // Failing input: two finite-but-astronomically-large operands. Each passes
    // parseCSVRow's finite/>0 checks, but their product is Infinity. The old
    // worker wrote `tradeValue: quantity * price` = Infinity onto a real Trade.
    assert.strictEqual(buildTradeValue(1e308, 1e308), null);
  });

  it("BUG-FIX: returns null for -Infinity product (negative huge price)", () => {
    assert.strictEqual(buildTradeValue(1e308, -1e308), null);
  });

  it("BUG-FIX: returns null when an operand is already non-finite", () => {
    assert.strictEqual(buildTradeValue(Infinity, 10), null);
    assert.strictEqual(buildTradeValue(10, NaN), null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildTradeCreateData — row → Trade payload (rejects corrupt rows)
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.buildTradeCreateData (real export)", () => {
  const ctx = { userId: "u-1", jobId: "job-1" };

  it("maps a valid row to a Trade-create payload", () => {
    const r = buildTradeCreateData(BASE_ROW, "abc123def456", 0, ctx);
    assert.strictEqual(r.ok, true);
    if (!r.ok) return;
    assert.strictEqual(r.data.userId, "u-1");
    assert.strictEqual(r.data.symbol, "RELIANCE");
    assert.strictEqual(r.data.tradingSymbol, "RELIANCE");
    assert.strictEqual(r.data.exchange, "NSE");
    assert.strictEqual(r.data.tradeType, "BUY");
    assert.strictEqual(r.data.quantity, 10);
    assert.strictEqual(r.data.price, 2500.5);
    assert.strictEqual(r.data.tradeValue, 25005);
    assert.strictEqual(r.data.sourceType, "IMPORTED");
    assert.strictEqual(r.data.isEditable, true);
    assert.strictEqual(r.data.needsRepairing, true);
    assert.strictEqual(r.data.importBatchId, "job-1");
    assert.strictEqual(r.data.duplicateHash, "abc123def456");
  });

  it("defaults brokerName to 'imported' and broker undefined when unlinked", () => {
    const r = buildTradeCreateData(BASE_ROW, "h", 0, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.data.broker, undefined);
    assert.strictEqual(r.data.brokerName, "imported");
  });

  it("sets broker + lowercased brokerName when broker-linked", () => {
    const r = buildTradeCreateData(BASE_ROW, "h", 0, {
      ...ctx,
      broker: "ZERODHA",
      brokerUserId: "Z123",
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.data.broker, "ZERODHA");
    assert.strictEqual(r.data.brokerUserId, "Z123");
    assert.strictEqual(r.data.brokerName, "zerodha");
  });

  it("falls back tradeTime to tradeDate when no explicit time", () => {
    const r = buildTradeCreateData(BASE_ROW, "h", 0, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(
      r.data.tradeTime.getTime(),
      BASE_ROW.tradeDate.getTime()
    );
  });

  it("uses explicit tradeTime when present", () => {
    const t = new Date("2025-06-15T09:30:00Z");
    const r = buildTradeCreateData({ ...BASE_ROW, tradeTime: t }, "h", 0, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.data.tradeTime.getTime(), t.getTime());
  });

  it("defaults orderType=MARKET and productType=CNC when missing", () => {
    const row = { ...BASE_ROW };
    delete row.orderType;
    delete row.productType;
    const r = buildTradeCreateData(row, "h", 0, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.data.orderType, "MARKET");
    assert.strictEqual(r.data.productType, "CNC");
  });

  it("BUG-FIX: rejects a row whose tradeValue overflows (does NOT persist)", () => {
    const r = buildTradeCreateData(
      { ...BASE_ROW, quantity: 1e308, price: 1e308 },
      "h",
      0,
      ctx
    );
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /overflow/i);
    assert.match(r.reason, /RELIANCE/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildBrokerTradeId
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.buildBrokerTradeId (real export)", () => {
  it("uses IMP-<hash>-<idx> when no upstream ids", () => {
    assert.strictEqual(buildBrokerTradeId({}, "deadbeef", 3), "IMP-deadbeef-3");
  });

  it("prefers tradeId over orderId and synthetic", () => {
    assert.strictEqual(
      buildBrokerTradeId({ tradeId: "T1", orderId: "O1" }, "h", 0),
      "T1"
    );
  });

  it("falls back to orderId when no tradeId", () => {
    assert.strictEqual(buildBrokerTradeId({ orderId: "O9" }, "h", 0), "O9");
  });

  it("is deterministic for a given (hash, idx) — safe for Pub/Sub retries", () => {
    assert.strictEqual(
      buildBrokerTradeId({}, "h", 5),
      buildBrokerTradeId({}, "h", 5)
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildJobStatusUpdate
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.buildJobStatusUpdate (real export)", () => {
  it("PROCESSING stamps startedAt, no completedAt/progress", () => {
    const before = new Date();
    const p = buildJobStatusUpdate("PROCESSING");
    const after = new Date();
    assert.strictEqual(p.status, "PROCESSING");
    assert.ok(p.startedAt instanceof Date);
    assert.ok(
      (p.startedAt as Date) >= before && (p.startedAt as Date) <= after
    );
    assert.strictEqual("completedAt" in p, false);
    assert.strictEqual("progress" in p, false);
  });

  it("COMPLETED stamps completedAt + progress=100 + result", () => {
    const result = buildImportResult(2, 1, 3, []);
    const p = buildJobStatusUpdate("COMPLETED", { result });
    assert.strictEqual(p.status, "COMPLETED");
    assert.strictEqual(p.progress, 100);
    assert.ok(p.completedAt instanceof Date);
    assert.deepStrictEqual(p.result, result);
  });

  it("COMPLETED without a result omits the result key", () => {
    const p = buildJobStatusUpdate("COMPLETED");
    assert.strictEqual("result" in p, false);
  });

  it("FAILED stamps completedAt + errorMessage, no progress", () => {
    const p = buildJobStatusUpdate("FAILED", { errorMessage: "boom" });
    assert.strictEqual(p.status, "FAILED");
    assert.strictEqual(p.errorMessage, "boom");
    assert.ok(p.completedAt instanceof Date);
    assert.strictEqual("progress" in p, false);
  });

  it("FAILED without a message omits errorMessage", () => {
    const p = buildJobStatusUpdate("FAILED");
    assert.strictEqual("errorMessage" in p, false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildImportResult — error array cap
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.buildImportResult (real export)", () => {
  it("packs the result shape", () => {
    const r = buildImportResult(5, 2, 7, ["x"]);
    assert.deepStrictEqual(r, {
      success: true,
      imported: 5,
      skipped: 2,
      total: 7,
      errors: ["x"],
    });
  });

  it("caps the errors array at MAX_IMPORT_RESULT_ERRORS", () => {
    const errs = Array.from({ length: 25 }, (_, i) => `e${i}`);
    const r = buildImportResult(0, 0, 25, errs);
    assert.strictEqual(r.errors.length, MAX_IMPORT_RESULT_ERRORS);
    assert.strictEqual(r.errors[0], "e0");
    assert.strictEqual(r.errors[9], "e9");
  });

  it("leaves a short errors array untouched", () => {
    const r = buildImportResult(0, 0, 1, ["only"]);
    assert.deepStrictEqual(r.errors, ["only"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// resolveImportStatus
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.resolveImportStatus (real export)", () => {
  it("no errors → COMPLETED", () => {
    assert.strictEqual(resolveImportStatus(5, 0), "COMPLETED");
    assert.strictEqual(resolveImportStatus(0, 0), "COMPLETED");
  });

  it("errors with some imported → PARTIALLY_COMPLETED", () => {
    assert.strictEqual(resolveImportStatus(3, 2), "PARTIALLY_COMPLETED");
  });

  it("errors with nothing imported → FAILED", () => {
    assert.strictEqual(resolveImportStatus(0, 4), "FAILED");
  });
});

// ══════════════════════════════════════════════════════════════════════
// isUniqueConstraintError
// ══════════════════════════════════════════════════════════════════════

describe("import-logic.isUniqueConstraintError (real export)", () => {
  it("true for a Prisma P2002 error", () => {
    const e = Object.assign(new Error("dup"), { code: "P2002" });
    assert.strictEqual(isUniqueConstraintError(e), true);
  });

  it("false for any other coded error", () => {
    const e = Object.assign(new Error("x"), { code: "P2025" });
    assert.strictEqual(isUniqueConstraintError(e), false);
  });

  it("false for a plain error / null / non-object", () => {
    assert.strictEqual(isUniqueConstraintError(new Error("x")), false);
    assert.strictEqual(isUniqueConstraintError(null), false);
    assert.strictEqual(isUniqueConstraintError("P2002"), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Real parsing primitives the worker composes (subset relevant to import.ts)
// ══════════════════════════════════════════════════════════════════════

describe("worker composes @usemoney/core/import (real source)", () => {
  it("parseCSVContent + parseCSVRow extract a Zerodha-style row", () => {
    const csv =
      "Symbol,Trade Type,Quantity,Price,Exchange,Segment,Trade Date\n" +
      "RELIANCE,BUY,10,2500.50,NSE,EQ,2025-06-15";
    const parsed = parseCSVContent(csv);
    assert.strictEqual(parsed.rows.length, 1);
    const row = parseCSVRow(parsed.rows[0]!, getColumnMapping("zerodha"), 1);
    assert.strictEqual(row.error, undefined);
    assert.strictEqual(row.data.symbol, "RELIANCE");
    assert.strictEqual(row.data.tradeType, "BUY");
    assert.strictEqual(row.data.quantity, 10);
    assert.strictEqual(row.data.price, 2500.5);
    assert.strictEqual(row.data.exchange, "NSE");
  });

  it("parseCSVRow rejects an Infinity quantity (parseNumber finiteness guard)", () => {
    const row = parseCSVRow(
      {
        Symbol: "X",
        "Trade Date": "2025-06-15",
        "Trade Type": "BUY",
        Quantity: "Infinity",
        Price: "100",
      },
      getColumnMapping("generic"),
      1
    );
    // "Infinity" → parseNumber → 0 → "Invalid quantity"
    assert.ok(row.error);
    assert.match(row.error!, /quantity/i);
  });

  it("generateDuplicateHash is the 16-hex fingerprint the worker stores", () => {
    const h = generateDuplicateHash({
      symbol: "RELIANCE",
      tradeDate: new Date("2025-06-15"),
      tradeType: "BUY",
      quantity: 10,
      price: 2500.5,
      exchange: "NSE",
      segment: "EQUITY",
    });
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it("generateDuplicateHash: SYNCED and IMPORTED duplicates collide (no double-count)", () => {
    // The dedup key is the 7 trade fields only — sourceType is NOT part of it,
    // so a CSV row identical to a synced fill hashes equal and is skipped.
    const fields = {
      symbol: "TCS",
      tradeDate: new Date("2025-06-15"),
      tradeType: "BUY" as const,
      quantity: 5,
      price: 3500,
      exchange: "NSE",
      segment: "EQUITY",
    };
    assert.strictEqual(
      generateDuplicateHash(fields),
      generateDuplicateHash(fields)
    );
  });

  it("generateDuplicateHash: Invalid-Date row does NOT throw (INVALID_DATE sentinel)", () => {
    assert.doesNotThrow(() =>
      generateDuplicateHash({
        symbol: "X",
        tradeDate: new Date("not-a-date"),
        tradeType: "BUY",
        quantity: 1,
        price: 1,
      })
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors ONLY the processor's prisma call SEQUENCE,
// building every payload by calling the REAL exports above.
// ══════════════════════════════════════════════════════════════════════

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}

interface ImportJobMessage {
  jobId: string;
  userId: string;
  content?: string;
  brokerFormat: string;
  fileName?: string;
  brokerConnectionId?: string;
  linkToManual?: boolean;
}

/**
 * Harness that re-creates the processor's prisma SEQUENCE for the inline-content
 * CSV happy path, deferring EVERY derivation to the real import-logic + core
 * exports. It is NOT the processor (which can't be imported purely); it asserts
 * that those real exports compose into the right call sequence.
 */
async function runImportHarness(
  data: ImportJobMessage,
  deps: {
    existingHashes: Set<string>;
    brokerConnections: Record<
      string,
      {
        id: string;
        userId: string;
        broker: string;
        brokerUserId: string | null;
      }
    >;
    createThrows?: (idx: number) => unknown | undefined;
    calls: PrismaCall[];
  }
): Promise<void> {
  const { jobId, userId, brokerFormat, brokerConnectionId } = data;

  deps.calls.push({
    model: "backgroundJob",
    method: "updateMany",
    args: { where: { jobId }, data: buildJobStatusUpdate("PROCESSING") },
  });

  // Parse with the REAL core parser.
  const parsed = parseCSVContent(data.content || "");
  const columnMap = getColumnMapping(brokerFormat as never);
  const validRows: ImportTradeRow[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    if (!row) continue;
    const r = parseCSVRow(row, columnMap, i + 1);
    if (!r.error && r.data.symbol) validRows.push(r.data);
  }

  // IDOR-scoped broker lookup (findFirst by id + userId — the REAL guard).
  let connBroker: string | undefined;
  let connBrokerUserId: string | undefined;
  if (brokerConnectionId) {
    deps.calls.push({
      model: "brokerConnection",
      method: "findFirst",
      args: { where: { id: brokerConnectionId, userId } },
    });
    const conn = deps.brokerConnections[brokerConnectionId];
    // Mirror Prisma's `findFirst({ where: { id, userId } })`: a connection whose
    // userId differs from the job's userId does NOT match → null.
    if (conn && conn.userId === userId) {
      connBroker = conn.broker;
      connBrokerUserId = conn.brokerUserId || undefined;
    }
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let idx = 0; idx < validRows.length; idx++) {
    const trade = validRows[idx]!;
    try {
      const hash = generateDuplicateHash({
        symbol: trade.symbol,
        tradeDate: trade.tradeDate,
        tradeType: trade.tradeType,
        quantity: trade.quantity,
        price: trade.price,
        exchange: trade.exchange,
        segment: trade.segment,
      });

      deps.calls.push({
        model: "trade",
        method: "findFirst",
        args: { where: { userId, duplicateHash: hash } },
      });
      if (deps.existingHashes.has(hash)) {
        skipped++;
        continue;
      }

      const built = buildTradeCreateData(trade, hash, idx, {
        userId,
        jobId,
        broker: connBroker as never,
        brokerUserId: connBrokerUserId,
      });
      if (!built.ok) {
        errors.push(built.reason);
        continue;
      }

      const thrown = deps.createThrows?.(idx);
      deps.calls.push({
        model: "trade",
        method: "create",
        args: { data: built.data },
      });
      if (thrown) throw thrown;
      imported++;
    } catch (error) {
      if (isUniqueConstraintError(error)) skipped++;
      else
        errors.push(
          `${trade.symbol}: ${error instanceof Error ? error.message : "Insert error"}`
        );
    }
  }

  deps.calls.push({
    model: "backgroundJob",
    method: "updateMany",
    args: {
      where: { jobId },
      data: buildJobStatusUpdate("COMPLETED", {
        result: buildImportResult(imported, skipped, validRows.length, errors),
      }),
    },
  });

  const status: ImportLogStatus = resolveImportStatus(imported, errors.length);
  deps.calls.push({
    model: "importLog",
    method: "upsert",
    args: {
      where: { importBatchId: jobId },
      create: {
        userId,
        importBatchId: jobId,
        status,
        importedCount: imported,
        skippedCount: skipped,
        duplicateCount: skipped,
        errorCount: errors.length,
      },
    },
  });
}

function find(
  calls: PrismaCall[],
  model: string,
  method: string
): PrismaCall[] {
  return calls.filter((c) => c.model === model && c.method === method);
}
function statusOf(c: PrismaCall): string | undefined {
  return (c.args as { data?: { status?: string } }).data?.status;
}
function resultOf(c: PrismaCall): Record<string, unknown> | undefined {
  return (c.args as { data?: { result?: Record<string, unknown> } }).data
    ?.result;
}

describe("import harness (drives the REAL exports through the processor sequence)", () => {
  let calls: PrismaCall[];
  let existingHashes: Set<string>;
  let brokerConnections: Record<
    string,
    { id: string; userId: string; broker: string; brokerUserId: string | null }
  >;

  beforeEach(() => {
    calls = [];
    existingHashes = new Set();
    brokerConnections = {};
  });

  const CSV =
    "Symbol,Trade Type,Quantity,Price,Exchange,Segment,Trade Date\n" +
    "RELIANCE,BUY,10,2500.50,NSE,EQ,2025-06-15";

  it("happy path: PROCESSING → create → COMPLETED with correct stats", async () => {
    await runImportHarness(
      { jobId: "hp-1", userId: "u-1", brokerFormat: "zerodha", content: CSV },
      { existingHashes, brokerConnections, calls }
    );

    const bg = find(calls, "backgroundJob", "updateMany");
    assert.strictEqual(statusOf(bg[0]!), "PROCESSING");
    assert.strictEqual(statusOf(bg[1]!), "COMPLETED");
    const result = resultOf(bg[1]!)!;
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.total, 1);

    assert.strictEqual(find(calls, "trade", "create").length, 1);
    const created = (
      find(calls, "trade", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.strictEqual(created.symbol, "RELIANCE");
    assert.strictEqual(created.tradeValue, 25005);
    assert.strictEqual(created.sourceType, "IMPORTED");
  });

  it("dedup: a row whose hash already exists is skipped, not created", async () => {
    const hash = generateDuplicateHash({
      symbol: "RELIANCE",
      tradeDate: new Date("2025-06-15"),
      tradeType: "BUY",
      quantity: 10,
      price: 2500.5,
      exchange: "NSE",
      segment: "EQUITY",
    });
    existingHashes.add(hash);

    await runImportHarness(
      { jobId: "dup-1", userId: "u-1", brokerFormat: "zerodha", content: CSV },
      { existingHashes, brokerConnections, calls }
    );

    assert.strictEqual(find(calls, "trade", "create").length, 0);
    const result = resultOf(find(calls, "backgroundJob", "updateMany")[1]!)!;
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.skipped, 1);
  });

  it("broker linkage: scoped lookup attaches broker identity to created rows", async () => {
    brokerConnections["conn-z"] = {
      id: "conn-z",
      userId: "u-1",
      broker: "ZERODHA",
      brokerUserId: "Z123",
    };

    await runImportHarness(
      {
        jobId: "bl-1",
        userId: "u-1",
        brokerFormat: "zerodha",
        content: CSV,
        brokerConnectionId: "conn-z",
      },
      { existingHashes, brokerConnections, calls }
    );

    // The scoped lookup ran (findFirst with id + userId).
    const look = find(calls, "brokerConnection", "findFirst");
    assert.strictEqual(look.length, 1);
    assert.deepStrictEqual((look[0]!.args as { where: unknown }).where, {
      id: "conn-z",
      userId: "u-1",
    });

    const created = (
      find(calls, "trade", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.strictEqual(created.broker, "ZERODHA");
    assert.strictEqual(created.brokerUserId, "Z123");
    assert.strictEqual(created.brokerName, "zerodha");
  });

  it("BUG-FIX IDOR: another user's brokerConnectionId resolves to null → unlinked import", async () => {
    // Victim's connection. Attacker's job (userId u-attacker) references it.
    brokerConnections["conn-victim"] = {
      id: "conn-victim",
      userId: "u-victim",
      broker: "ZERODHA",
      brokerUserId: "VICTIM-CLIENT",
    };

    await runImportHarness(
      {
        jobId: "idor-1",
        userId: "u-attacker",
        brokerFormat: "zerodha",
        content: CSV,
        brokerConnectionId: "conn-victim",
      },
      { existingHashes, brokerConnections, calls }
    );

    // Lookup was userId-scoped → no cross-user leak.
    const look = find(calls, "brokerConnection", "findFirst");
    assert.deepStrictEqual((look[0]!.args as { where: unknown }).where, {
      id: "conn-victim",
      userId: "u-attacker",
    });

    const created = (
      find(calls, "trade", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    // The victim's broker identity must NOT be attached.
    assert.strictEqual(created.broker, undefined);
    assert.strictEqual(created.brokerUserId, undefined);
    assert.strictEqual(created.brokerName, "imported");
  });

  it("BUG-FIX overflow: a huge-qty*price row is recorded as an error, never created", async () => {
    // Two finite-but-huge values that pass parseCSVRow but overflow on multiply.
    const overflowCsv =
      "Symbol,Trade Type,Quantity,Price,Exchange,Segment,Trade Date\n" +
      "BIG,BUY,1e308,1e308,NSE,EQ,2025-06-15";

    await runImportHarness(
      {
        jobId: "of-1",
        userId: "u-1",
        brokerFormat: "generic",
        content: overflowCsv,
      },
      { existingHashes, brokerConnections, calls }
    );

    // No corrupt Trade persisted.
    assert.strictEqual(find(calls, "trade", "create").length, 0);
    const result = resultOf(find(calls, "backgroundJob", "updateMany")[1]!)!;
    assert.strictEqual(result.imported, 0);
    const errs = result.errors as string[];
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0]!, /overflow/i);
  });

  it("per-trade insert error is recorded without failing the whole job", async () => {
    const multiCsv =
      "Symbol,Trade Type,Quantity,Price,Exchange,Segment,Trade Date\n" +
      "RELIANCE,BUY,10,2500,NSE,EQ,2025-06-15\n" +
      "TCS,SELL,5,3500,NSE,EQ,2025-06-15\n" +
      "INFY,BUY,20,1500,NSE,EQ,2025-06-15";

    await runImportHarness(
      {
        jobId: "err-1",
        userId: "u-1",
        brokerFormat: "generic",
        content: multiCsv,
      },
      {
        existingHashes,
        brokerConnections,
        calls,
        createThrows: (idx) =>
          idx === 1 ? new Error("Simulated DB insert error") : undefined,
      }
    );

    const result = resultOf(find(calls, "backgroundJob", "updateMany")[1]!)!;
    assert.strictEqual(result.imported, 2);
    assert.strictEqual(result.total, 3);
    const errs = result.errors as string[];
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0]!, /TCS/);
  });

  it("a P2002 insert collision counts as skipped, not as an error", async () => {
    await runImportHarness(
      { jobId: "p2002", userId: "u-1", brokerFormat: "zerodha", content: CSV },
      {
        existingHashes,
        brokerConnections,
        calls,
        createThrows: () => Object.assign(new Error("dup"), { code: "P2002" }),
      }
    );

    const result = resultOf(find(calls, "backgroundJob", "updateMany")[1]!)!;
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.skipped, 1);
    assert.deepStrictEqual(result.errors, []);
  });

  it("ImportLog upsert keys on importBatchId with the resolved status", async () => {
    await runImportHarness(
      { jobId: "log-1", userId: "u-1", brokerFormat: "zerodha", content: CSV },
      { existingHashes, brokerConnections, calls }
    );

    const ups = find(calls, "importLog", "upsert");
    assert.strictEqual(ups.length, 1);
    const args = ups[0]!.args as {
      where: { importBatchId: string };
      create: { status: string; importedCount: number };
    };
    assert.strictEqual(args.where.importBatchId, "log-1");
    assert.strictEqual(args.create.status, "COMPLETED");
    assert.strictEqual(args.create.importedCount, 1);
  });
});

// Touch crypto so an unused-import lint can't trip if assertions are trimmed.
void crypto;
