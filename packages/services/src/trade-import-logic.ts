/**
 * Trade-import — PURE orchestration logic (no Prisma / cache / I/O).
 *
 * Extracted from the trade-import pipeline (`apps/web/lib/actions/trade-import.ts`
 * + `apps/web/lib/jobs/import-processor.ts` + `workers/src/processors/import.ts`)
 * so the user-facing import money path can be unit-tested against the REAL
 * exported symbols. This de-shadows `apps/web/__tests__/actions/trade-import.ts`,
 * which previously RE-IMPLEMENTED `getTradePriority`/`resolveDuplicate`/the
 * row-mapping/summary math inline and asserted the COPY — a shadow that stayed
 * green while the only shipped copy of `resolveDuplicate` (inline in the action)
 * went untested. `trade-import.service.ts` re-exports every symbol here so the
 * service layer (consumed by apps/web, apps/api, workers) and the tests execute
 * the same code.
 *
 * What lives here (all side-effect-free):
 *   - `finite()`            — non-finite (NaN/±Infinity) guard. The import
 *                             summary is a SUM/ratio surface and a Trade row
 *                             carries `tradeValue = quantity * price`; a single
 *                             non-finite addend would poison the whole summary
 *                             ("imported: NaN") or persist a corrupt `tradeValue`.
 *   - `getTradePriority` / `resolveDuplicate` — the cross-source duplicate
 *                             priority rules (SYNCED > IMPORTED-with-broker >
 *                             MANUAL > IMPORTED-unlinked). This is the logic that
 *                             guarantees a SYNCED trade WINS over an IMPORTED
 *                             duplicate (no double-count).
 *   - `mapRowToTradeInput`  — parsed row → Trade-create input with a
 *                             finite-guarded quantity/price/tradeValue, REJECTING
 *                             (skip + reason) any row whose qty/price is
 *                             non-finite or out of range rather than persisting a
 *                             corrupt Trade or poisoning the totals.
 *   - `computeImportProgress` — batch progress %, div-by-zero (0 total) → 0 not
 *                             NaN, clamped to [0, 100].
 *   - `rollupDuplicateCount` / `determineImportStatus` / `summarizeImport` — the
 *                             import-summary rollup, with finite-guarded totals so
 *                             no NaN/Infinity reaches the summary formatters.
 *
 * The CSV/XLSX parsing, per-row field extraction, value normalization
 * (`parseNumber` → non-finite collapses to 0) and the canonical duplicate HASH
 * (`generateDuplicateHash`, Invalid-Date → stable `INVALID_DATE` sentinel, never
 * a `.toISOString()` throw) are the SHIPPED primitives in `@usemoney/core/import`
 * and are de-shadowed separately in
 * `apps/web/__tests__/core/import/import.test.ts`. This module composes those
 * primitives; it owns only the SERVICE-level orchestration the import job does
 * around them.
 */

import type { ParsedTradeRow, TradeRow } from "@usemoney/core/import";

// ---------------------------------------------------------------------------
// Non-finite guard
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 * Mirrors `packages/services/src/dashboard-logic.ts#finite` and
 * `apps/web/lib/db/dashboard-logic.ts#finite`. Used on every value that enters
 * the import summary (a SUM surface) or a persisted `tradeValue` so one corrupt
 * row can never render the import result as "NaN" nor write a corrupt Trade.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Cross-source duplicate priority resolution
// ---------------------------------------------------------------------------

export type TradeSourceType = "SYNCED" | "IMPORTED" | "MANUAL";

/**
 * Minimal structural view of an existing Trade row, as selected by the import
 * duplicate query. Kept local (not a Prisma type) so this module stays I/O-free
 * and the tests can hand-roll rows.
 */
export interface ExistingTradeForDedup {
  id: string;
  duplicateHash: string | null;
  sourceType: TradeSourceType;
  broker: string | null;
  brokerUserId: string | null;
  brokerTradeId: string | null;
  importBatchId: string | null;
}

export interface NewTradeLinking {
  broker: string | null;
  manual: boolean;
}

export type DuplicateAction = "SKIP" | "IMPORT" | "UPGRADE" | "PROMPT";

export interface DuplicateResolution {
  action: DuplicateAction;
  reason: string;
  existingTrade?: ExistingTradeForDedup;
  promptOptions?: {
    currentBroker: string;
    newBroker: string;
  };
}

/**
 * Priority order for duplicate resolution (higher wins):
 *   4. SYNCED                    (immutable broker sync — always wins)
 *   3. IMPORTED with broker link
 *   2. MANUAL
 *   1. IMPORTED without link     (lowest)
 *
 * This ordering is what guarantees a SYNCED trade beats an IMPORTED duplicate so
 * the same fill is never double-counted across sync + CSV.
 */
export function getTradePriority(trade: ExistingTradeForDedup): number {
  if (trade.sourceType === "SYNCED") return 4;
  if (trade.sourceType === "IMPORTED" && trade.broker) return 3;
  if (trade.sourceType === "MANUAL") return 2;
  return 1; // IMPORTED without broker
}

/**
 * Resolve a duplicate against the existing trades that share its dedup hash.
 *
 * Picks the highest-priority existing row, then applies the cross-source rules.
 * A SYNCED existing row always yields SKIP (the incoming CSV row is discarded so
 * the synced fill is not double-counted). A MANUAL existing row + broker-linked
 * import yields UPGRADE (the manual row is enriched with broker linkage, not
 * duplicated). Same-broker imports SKIP; cross-broker conflicts SKIP with
 * `promptOptions` so the UI can offer a relink.
 *
 * NOTE: sorts a COPY (`[...existing]`) — the live action sorted the array
 * in-place, which mutated the caller's `duplicateMap` entry; that reordering is
 * a latent footgun if the same array is consulted again. Sorting a copy is
 * behaviour-preserving for the resolution result and removes the mutation.
 */
export function resolveDuplicate(
  existing: ExistingTradeForDedup[],
  newLinking: NewTradeLinking,
): DuplicateResolution {
  // Defensive: an empty candidate list is not a duplicate. The live code
  // indexed `sorted[0]` unconditionally (it only called this when the list was
  // non-empty), so an empty list there would read `undefined.sourceType` and
  // throw. Returning IMPORT keeps a stray empty group from crashing the import.
  if (existing.length === 0) {
    return { action: "IMPORT", reason: "No existing duplicate" };
  }

  // Sort by priority (highest first) on a COPY — do not mutate the caller's array.
  const sorted = [...existing].sort(
    (a, b) => getTradePriority(b) - getTradePriority(a),
  );
  const highest = sorted[0]!;

  // Case: Synced trade exists (always wins → SKIP the incoming row).
  if (highest.sourceType === "SYNCED") {
    if (newLinking.broker === highest.broker) {
      return {
        action: "SKIP",
        reason: `Already synced from ${highest.broker}`,
        existingTrade: highest,
      };
    }
    if (newLinking.manual) {
      return {
        action: "SKIP",
        reason: `Already synced from ${highest.broker}. Manual discarded.`,
        existingTrade: highest,
      };
    }
    if (newLinking.broker && newLinking.broker !== highest.broker) {
      return {
        action: "SKIP", // Skip by default for cross-broker conflicts
        reason: `Trade exists linked to ${highest.broker}. Cannot link to ${newLinking.broker}.`,
        existingTrade: highest,
        promptOptions: {
          currentBroker: highest.broker!,
          newBroker: newLinking.broker,
        },
      };
    }
    return {
      action: "SKIP",
      reason: `Already synced from ${highest.broker}`,
      existingTrade: highest,
    };
  }

  // Case: Manual trade exists, new is broker-linked → UPGRADE (enrich, not dup).
  if (highest.sourceType === "MANUAL" && newLinking.broker) {
    return {
      action: "UPGRADE",
      reason: `Upgrading from Manual to ${newLinking.broker}`,
      existingTrade: highest,
    };
  }

  // Case: Imported with same broker linking.
  if (highest.broker === newLinking.broker) {
    return {
      action: "SKIP",
      reason: highest.broker
        ? `Already imported for ${highest.broker}`
        : "Duplicate import",
      existingTrade: highest,
    };
  }

  // Case: Imported with different broker.
  if (
    highest.broker &&
    newLinking.broker &&
    highest.broker !== newLinking.broker
  ) {
    return {
      action: "SKIP",
      reason: `Trade exists linked to ${highest.broker}`,
      existingTrade: highest,
      promptOptions: {
        currentBroker: highest.broker,
        newBroker: newLinking.broker,
      },
    };
  }

  // Default: Skip duplicate.
  return {
    action: "SKIP",
    reason: "Duplicate trade",
    existingTrade: highest,
  };
}

/**
 * Categorize a SKIP resolution into the right duplicate bucket
 * (synced / sameAccount / differentAccount / manual). Mirrors the inline
 * `if (existing.sourceType === "SYNCED") duplicates.synced++ ...` ladder in the
 * action so the bucket counts are computed by ONE tested function.
 */
export type DuplicateBucket =
  | "synced"
  | "manual"
  | "sameAccount"
  | "differentAccount";

export function categorizeSkip(
  existing: ExistingTradeForDedup,
  linkedBroker: string | null,
): DuplicateBucket {
  if (existing.sourceType === "SYNCED") return "synced";
  if (existing.sourceType === "MANUAL") return "manual";
  if (existing.broker === linkedBroker) return "sameAccount";
  if (existing.broker && linkedBroker && existing.broker !== linkedBroker) {
    return "differentAccount";
  }
  return "sameAccount";
}

// ---------------------------------------------------------------------------
// Row → Trade-create mapping (finite-guarded)
// ---------------------------------------------------------------------------

/**
 * The subset of `Prisma.TradeCreateInput` the import pipeline writes for a new
 * row (the per-user/`userId`, `broker`, `importBatchId`, `duplicateHash` and
 * audit fields are layered on by the service/processor around this core).
 */
export interface TradeCreateData {
  symbol: string;
  tradingSymbol: string;
  isin: string | null;
  exchange: string;
  segment: string;
  tradeType: "BUY" | "SELL";
  positionType: "LONG" | "SHORT";
  orderType: string;
  productType: string;
  quantity: number;
  price: number;
  tradeValue: number;
  tradeDate: Date;
  status: string;
  sourceType: TradeSourceType;
  isEditable: boolean;
  needsRepairing: boolean;
  brokerage: number;
  totalCharges: number;
}

export interface MapRowContext {
  /** True when importing into a manual (unlinked, editable) book. */
  linkingToManual: boolean;
  /** True when importing linked to a broker (rows become non-editable). */
  linkingToBroker: boolean;
}

export type MapRowResult =
  | { ok: true; data: TradeCreateData }
  | { ok: false; reason: string };

/**
 * Default per-segment charges. MF trades carry no brokerage; everything else
 * defaults to a flat ₹20 (matches the live import). Centralized so the value is
 * computed once and is finite by construction.
 */
function defaultCharges(segment: string): number {
  return segment === "MF" ? 0 : 20;
}

/**
 * Map a parsed row into the Trade-create payload, REJECTING any row that would
 * persist a corrupt Trade or poison the summary totals.
 *
 * Bug class this closes: the live `prisma.trade.create({ data: { ...,
 * quantity: parsed.data.quantity, price: parsed.data.price,
 * tradeValue: parsed.data.quantity * parsed.data.price } })` trusts the parsed
 * numbers. `parseNumber` collapses an UNPARSEABLE string to 0, but a value that
 * arrives as a real non-finite number (a corrupt upstream XLSX cell already
 * typed `Infinity`/`NaN`, or `quantity * price` overflowing to `Infinity` for
 * astronomically large inputs) would be written verbatim — a `tradeValue` of
 * `NaN`/`Infinity` on a real Trade row, which then poisons every P&L sum that
 * reads it. We reject such rows up front (skip + reason) and never emit a
 * non-finite `quantity`/`price`/`tradeValue`.
 *
 * Validation:
 *   - quantity must be finite and > 0   (a 0/negative/NaN/Infinity qty is invalid).
 *   - price must be finite and >= 0      (0 is allowed: bonus/IPO allotments).
 *   - tradeDate must be a valid Date     (an Invalid Date is rejected, not stored).
 *   - tradeValue = quantity * price, finite-guarded (defensive against overflow).
 */
export function mapRowToTradeInput(
  row: Pick<
    TradeRow,
    | "symbol"
    | "isin"
    | "exchange"
    | "segment"
    | "tradeType"
    | "quantity"
    | "price"
    | "tradeDate"
    | "orderType"
    | "productType"
  >,
  ctx: MapRowContext,
): MapRowResult {
  if (!row.symbol) {
    return { ok: false, reason: "Missing symbol" };
  }

  if (!Number.isFinite(row.quantity) || row.quantity <= 0) {
    return {
      ok: false,
      reason: `Invalid quantity: ${String(row.quantity)}`,
    };
  }

  if (!Number.isFinite(row.price) || row.price < 0) {
    return { ok: false, reason: `Invalid price: ${String(row.price)}` };
  }

  if (
    !(row.tradeDate instanceof Date) ||
    Number.isNaN(row.tradeDate.getTime())
  ) {
    return { ok: false, reason: "Invalid trade date" };
  }

  // tradeValue: both operands are validated finite, but their PRODUCT can still
  // overflow to ±Infinity for extreme inputs (e.g. MAX_VALUE * MAX_VALUE). Check
  // the RAW product for finiteness here — do NOT run it through finite() first,
  // which would silently collapse the overflow to 0 and persist a bogus ₹0 trade
  // instead of rejecting the corrupt row.
  const rawTradeValue = row.quantity * row.price;
  if (!Number.isFinite(rawTradeValue)) {
    return { ok: false, reason: "Trade value overflow" };
  }
  const tradeValue = rawTradeValue;

  // Linked-to-broker imports are immutable; manual/unlinked are editable.
  const isEditable = ctx.linkingToBroker ? false : true;
  const charges = defaultCharges(row.segment);

  return {
    ok: true,
    data: {
      symbol: row.symbol,
      tradingSymbol: row.isin || row.symbol,
      isin: row.isin || null,
      exchange: row.exchange,
      segment: row.segment,
      tradeType: row.tradeType,
      positionType: row.tradeType === "BUY" ? "LONG" : "SHORT",
      orderType: row.orderType || "MARKET",
      productType: row.productType || "CNC",
      quantity: row.quantity,
      price: row.price,
      tradeValue,
      tradeDate: row.tradeDate,
      status: "OPEN",
      sourceType: ctx.linkingToManual ? "MANUAL" : "IMPORTED",
      isEditable,
      needsRepairing: true,
      brokerage: charges,
      totalCharges: charges,
    },
  };
}

/**
 * Convenience adapter: map a `ParsedTradeRow` (the output of
 * `@usemoney/core/import#parseCSVRow`). A row that already carries a parse
 * `error` is rejected with that error; otherwise its `data` is mapped/validated.
 */
export function mapParsedRowToTradeInput(
  parsed: ParsedTradeRow,
  ctx: MapRowContext,
): MapRowResult {
  if (parsed.error) {
    return { ok: false, reason: parsed.error };
  }
  return mapRowToTradeInput(parsed.data, ctx);
}

// ---------------------------------------------------------------------------
// Progress %
// ---------------------------------------------------------------------------

/**
 * Compute the import progress percentage for a batched insert, mapped onto the
 * `[base, base + span]` window the job reports (the live processor used
 * `Math.round(20 + (processedCount / validRows.length) * 70)`).
 *
 * Hardened:
 *   - `total <= 0` (empty / all-invalid file) → returns `base`, never `NaN`
 *     (the live `processedCount / 0` produced `NaN`, which then rendered as a
 *     `NaN%` progress bar).
 *   - result clamped to `[0, 100]` so a `processed > total` overshoot (or a
 *     base+span that exceeds 100) can never report > 100%.
 */
export function computeImportProgress(
  processed: number,
  total: number,
  base = 0,
  span = 100,
): number {
  const safeBase = finite(base);
  const safeSpan = finite(span);
  if (!Number.isFinite(total) || total <= 0) {
    return clampPercent(safeBase);
  }
  const ratio = finite(processed) / total;
  const pct = safeBase + ratio * safeSpan;
  return clampPercent(Math.round(pct));
}

/** Clamp a percentage into the inclusive `[0, 100]` range (non-finite → 0). */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Summary rollup
// ---------------------------------------------------------------------------

export interface DuplicateCounters {
  synced: number;
  sameAccount: number;
  differentAccount: number;
  upgraded: number;
  manual: number;
}

export type ImportStatus = "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED";

/** Empty duplicate counters — the canonical zeroed starting/empty value. */
export function emptyDuplicateCounters(): DuplicateCounters {
  return {
    synced: 0,
    sameAccount: 0,
    differentAccount: 0,
    upgraded: 0,
    manual: 0,
  };
}

/**
 * Total "duplicate" count surfaced in the import log. `upgraded` is deliberately
 * EXCLUDED — an upgrade enriches an existing row, it is not a discarded
 * duplicate. Every addend is finite-guarded so a corrupt counter can never make
 * the rolled-up `duplicateCount` `NaN`.
 */
export function rollupDuplicateCount(d: DuplicateCounters): number {
  return (
    finite(d.synced) +
    finite(d.sameAccount) +
    finite(d.differentAccount) +
    finite(d.manual)
  );
}

/**
 * Determine the terminal import status from the imported count and the number
 * of errored rows. No errors → COMPLETED; some rows imported despite errors →
 * PARTIALLY_COMPLETED; nothing imported → FAILED. Mirrors the identical ladder
 * duplicated across the action and both processors.
 */
export function determineImportStatus(
  imported: number,
  errorCount: number,
): ImportStatus {
  if (finite(errorCount) === 0) return "COMPLETED";
  if (finite(imported) > 0) return "PARTIALLY_COMPLETED";
  return "FAILED";
}

export interface ImportSummaryInput {
  totalRows: number;
  imported: number;
  skipped: number;
  duplicates: DuplicateCounters;
  errorCount: number;
}

export interface ImportSummary {
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  errorCount: number;
  status: ImportStatus;
}

/**
 * Assemble the import-log summary with every count finite-guarded and the
 * derived `duplicateCount`/`status` computed by the tested helpers above. This
 * is the single shape handed to the summary formatters / ImportLog row, so it
 * MUST never contain a NaN/Infinity.
 *
 * Empty-file safety: `summarizeImport` of an all-zero input yields a fully
 * zeroed summary with status COMPLETED and never throws.
 */
export function summarizeImport(input: ImportSummaryInput): ImportSummary {
  const importedCount = Math.max(0, finite(input.imported));
  const errorCount = Math.max(0, finite(input.errorCount));
  return {
    totalRows: Math.max(0, finite(input.totalRows)),
    importedCount,
    skippedCount: Math.max(0, finite(input.skipped)),
    duplicateCount: rollupDuplicateCount(input.duplicates),
    errorCount,
    status: determineImportStatus(importedCount, errorCount),
  };
}
