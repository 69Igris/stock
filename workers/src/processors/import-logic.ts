/**
 * CSV-import processor — PURE orchestration logic (no Prisma / cache / I/O).
 *
 * Side-effect-free helpers extracted out of `import.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies) without booting
 * Prisma / GCS / pubsub / `clearTradeCache` / `createNotification` at module
 * load. `import.ts` imports and CALLS every export here, so the production code
 * path and the tests execute the SAME code. This mirrors the worker precedent
 * `pairing-logic.ts` / `document-process-logic.ts`.
 *
 * What lives here (all side-effect-free):
 *   - `buildJobStatusUpdate`      — the BackgroundJob status patch (PROCESSING /
 *                                   COMPLETED / FAILED), single source of the
 *                                   completedAt + progress=100 stamping.
 *   - `buildImportResult`         — the `result` object stored on the job
 *                                   (`{ success, imported, skipped, total,
 *                                   errors }`), with the errors array capped.
 *   - `buildBrokerTradeId`        — the deterministic `IMP-${hash}-${idx}`
 *                                   brokerTradeId for an unsynced import row.
 *   - `buildTradeValue`           — the finite-guarded `quantity * price`. THIS
 *                                   is the bug fix: a row whose product overflows
 *                                   to ±Infinity (two finite-but-huge operands
 *                                   that pass `parseCSVRow`) is REJECTED rather
 *                                   than persisting a corrupt non-finite
 *                                   `tradeValue` onto a real Trade row (which
 *                                   then poisons every P&L sum that reads it).
 *   - `buildTradeCreateData`      — the full Trade-create payload, which rejects
 *                                   a non-finite-`tradeValue` row up front.
 *   - `resolveImportStatus`       — COMPLETED / PARTIALLY_COMPLETED / FAILED from
 *                                   imported + error counts.
 *
 * The CSV/XLSX parsing, per-row field extraction, value normalization
 * (`parseNumber` → non-finite collapses to 0) and the canonical duplicate HASH
 * (`generateDuplicateHash`, Invalid-Date → stable `INVALID_DATE` sentinel,
 * never a `.toISOString()` throw) are the SHIPPED primitives in
 * `@usemoney/core/import` and are de-shadowed separately in
 * `apps/web/__tests__/core/import/import.test.ts`. This module composes those
 * primitives; it owns only the worker-level orchestration around them.
 *
 * @see workers/src/processors/import.ts (caller)
 * @see apps/web/__tests__/workers/processor-import.test.ts (tests the real exports)
 * @see apps/web/__tests__/workers/import-idempotency.test.ts (tests the real exports)
 */

import type { BrokerType } from "@prisma/client";

/** Terminal/working states a BackgroundJob is moved through during an import. */
export type ImportJobStatus = "PROCESSING" | "COMPLETED" | "FAILED";

/** Terminal status an ImportLog row carries once the import settles. */
export type ImportLogStatus = "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED";

/** Max number of per-row error strings stored on the job result / surfaced. */
export const MAX_IMPORT_RESULT_ERRORS = 10;

/**
 * Build the BackgroundJob status-update patch.
 *
 * PROCESSING stamps `startedAt`; terminal states (COMPLETED / FAILED) stamp
 * `completedAt`. COMPLETED also pins `progress = 100` and carries the `result`
 * payload; FAILED carries the `errorMessage`. Centralized so the three call
 * sites in `import.ts` cannot drift (e.g. forget the completedAt stamp).
 */
export function buildJobStatusUpdate(
  status: ImportJobStatus,
  extra?: {
    result?: ImportJobResult;
    errorMessage?: string;
  },
): Record<string, unknown> {
  if (status === "PROCESSING") {
    return { status, startedAt: new Date() };
  }
  if (status === "COMPLETED") {
    return {
      status,
      completedAt: new Date(),
      progress: 100,
      ...(extra?.result ? { result: extra.result } : {}),
    };
  }
  // FAILED
  return {
    status,
    completedAt: new Date(),
    ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
  };
}

/** The `result` object stored on a completed import BackgroundJob. */
export interface ImportJobResult {
  success: boolean;
  imported: number;
  skipped: number;
  total: number;
  errors: string[];
}

/**
 * Build the import job's `result` payload. The errors array is capped at
 * `MAX_IMPORT_RESULT_ERRORS` so a pathological all-rows-fail batch cannot bloat
 * the BackgroundJob document with thousands of error strings.
 */
export function buildImportResult(
  imported: number,
  skipped: number,
  total: number,
  errors: string[],
): ImportJobResult {
  return {
    success: true,
    imported,
    skipped,
    total,
    errors: errors.slice(0, MAX_IMPORT_RESULT_ERRORS),
  };
}

/**
 * Deterministic synthetic broker-trade id for an imported row that has no
 * upstream trade/order id. Stable for a given (hash, idx) so a Pub/Sub retry of
 * the same batch regenerates the same id (the row's `duplicateHash` keeps the
 * dedup correct regardless). Prefers a real `tradeId` / `orderId` when present.
 */
export function buildBrokerTradeId(
  trade: { tradeId?: string; orderId?: string },
  hash: string,
  idx: number,
): string {
  return trade.tradeId || trade.orderId || `IMP-${hash}-${idx}`;
}

/**
 * Finite-guarded trade value: `quantity * price`.
 *
 * BUG CLASS this closes (worker IMPORT path): `parseCSVRow` → `parseNumber`
 * guarantees `quantity`/`price` are individually FINITE (and qty > 0, price >=
 * 0), but their PRODUCT can still overflow to `±Infinity` for two finite-but-
 * astronomically-large operands (e.g. `1e308 * 1e308`). The previous worker
 * wrote `tradeValue: trade.quantity * trade.price` verbatim, persisting a
 * non-finite `tradeValue` onto a real Trade row — which then poisons every P&L
 * SUM that reads it. We compute the RAW product and return `null` when it is
 * non-finite so the caller REJECTS the row (skip + reason) rather than storing
 * a corrupt value. (Do NOT coerce to 0 — that would silently persist a bogus ₹0
 * trade instead of flagging the corrupt row.)
 */
export function buildTradeValue(quantity: number, price: number): number | null {
  const raw = quantity * price;
  return Number.isFinite(raw) ? raw : null;
}

/**
 * The subset of a parsed import row the worker maps into a Trade-create row.
 *
 * Structurally matches the `validTrades[]` shape `import.ts` accumulates from
 * `@usemoney/core/import#parseCSVRow` (which widens `tradeType` to `string` and
 * makes the optional fields optional). Kept local (not `Pick<TradeRow>`) so it
 * is assignment-compatible with that call-site array without forcing the worker
 * to re-narrow `tradeType` to the `"BUY" | "SELL"` literal union.
 */
export interface ImportTradeRow {
  symbol: string;
  isin?: string;
  exchange: string;
  segment: string;
  tradeType: string;
  quantity: number;
  price: number;
  tradeDate: Date;
  tradeTime?: Date;
  productType?: string;
  orderType?: string;
  tradeId?: string;
  orderId?: string;
}

/** Broker linkage layered onto each created row when the import is broker-linked. */
export interface ImportBrokerContext {
  broker?: BrokerType;
  brokerUserId?: string;
}

/** The Trade-create payload the worker writes for one imported row. */
export interface ImportTradeCreateData {
  userId: string;
  broker?: BrokerType;
  brokerUserId?: string;
  brokerName: string;
  brokerTradeId: string;
  symbol: string;
  tradingSymbol: string;
  isin?: string;
  exchange: string;
  segment: string;
  tradeType: string;
  orderType: string;
  productType: string;
  quantity: number;
  price: number;
  tradeValue: number;
  tradeDate: Date;
  tradeTime: Date;
  sourceType: "IMPORTED";
  isEditable: boolean;
  needsRepairing: boolean;
  duplicateHash: string;
  importBatchId: string;
}

export type BuildTradeResult =
  | { ok: true; data: ImportTradeCreateData }
  | { ok: false; reason: string };

/**
 * Map a parsed import row + its dedup hash into the Trade-create payload the
 * worker persists, REJECTING any row whose `tradeValue` would be non-finite
 * (see `buildTradeValue`). `brokerName` is the lowercased broker type when the
 * import is broker-linked, else the sentinel `"imported"`.
 */
export function buildTradeCreateData(
  row: ImportTradeRow,
  hash: string,
  idx: number,
  ctx: {
    userId: string;
    jobId: string;
    broker?: BrokerType;
    brokerUserId?: string;
  },
): BuildTradeResult {
  const tradeValue = buildTradeValue(row.quantity, row.price);
  if (tradeValue === null) {
    return {
      ok: false,
      reason: `${row.symbol}: Trade value overflow (${row.quantity} * ${row.price})`,
    };
  }

  return {
    ok: true,
    data: {
      userId: ctx.userId,
      broker: ctx.broker,
      brokerUserId: ctx.brokerUserId,
      brokerName: ctx.broker ? ctx.broker.toLowerCase() : "imported",
      brokerTradeId: buildBrokerTradeId(row, hash, idx),
      symbol: row.symbol,
      tradingSymbol: row.symbol,
      isin: row.isin,
      exchange: row.exchange,
      segment: row.segment,
      tradeType: row.tradeType,
      orderType: row.orderType || "MARKET",
      productType: row.productType || "CNC",
      quantity: row.quantity,
      price: row.price,
      tradeValue,
      tradeDate: row.tradeDate,
      tradeTime: row.tradeTime || row.tradeDate,
      sourceType: "IMPORTED",
      isEditable: true,
      needsRepairing: true,
      duplicateHash: hash,
      importBatchId: ctx.jobId,
    },
  };
}

/**
 * Determine the terminal ImportLog status. No errors → COMPLETED; some rows
 * imported despite errors → PARTIALLY_COMPLETED; nothing imported → FAILED.
 */
export function resolveImportStatus(
  imported: number,
  errorCount: number,
): ImportLogStatus {
  if (errorCount === 0) return "COMPLETED";
  if (imported > 0) return "PARTIALLY_COMPLETED";
  return "FAILED";
}

/**
 * True for a Prisma unique-constraint violation (`P2002`). A trade.create that
 * trips this is a same-batch race duplicate, not a hard error — the caller
 * counts it as `skipped`, not as an import error.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/** The `{ where, create, update }` argument bag for an ImportLog upsert. */
export interface ImportLogUpsertArgs<T extends { importBatchId: string }> {
  where: { importBatchId: string };
  create: T;
  update: Omit<T, "importBatchId">;
}

/**
 * Shape the idempotent ImportLog upsert arguments from a row payload.
 *
 * This is the Pub/Sub-retry idempotency contract: `importBatchId` is `@unique`,
 * so the worker UPSERTs on it. The `create` branch carries the full payload; the
 * `update` branch carries everything EXCEPT `importBatchId` (you cannot rewrite
 * the unique key on the existing row). Centralizing this guarantees a redelivery
 * of the same job converges to one ImportLog row instead of a duplicate-key
 * crash or a second history entry. Pure — the I/O `upsert()` call stays in
 * `import.ts`, which CALLS this to build its args.
 */
export function buildImportLogUpsertArgs<
  T extends { importBatchId: string },
>(data: T): ImportLogUpsertArgs<T> {
  const { importBatchId, ...rest } = data;
  return {
    where: { importBatchId },
    create: data,
    update: rest,
  };
}
