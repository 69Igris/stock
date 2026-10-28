/**
 * Trade Import — SERVICE-LAYER orchestration tests (MONEY-620).
 *
 * DE-SHADOWED: this file previously RE-IMPLEMENTED the import orchestration
 * (`generateDuplicateHash`, `getTradePriority`, `resolveDuplicate`, the date /
 * trade-type / exchange / segment normalizers, the delimiter/header detectors
 * and the column mappings) INLINE and asserted the COPY. That was a shadow — the
 * only shipped copy of `resolveDuplicate`/`getTradePriority` lives inline in
 * `apps/web/lib/actions/trade-import.ts` and was therefore UNTESTED, so a
 * regression there (e.g. a SYNCED trade no longer winning over an IMPORTED
 * duplicate → double-counted fills) would have stayed green.
 *
 * It now imports the REAL exported symbols:
 *   - SERVICE orchestration logic from
 *     `packages/services/src/trade-import-logic.ts` (the priority/resolution,
 *     finite-guarded row→Trade mapping, batch progress %, summary rollup the
 *     service re-exports and the import job runs) — asserted BOTH via the
 *     relative source import AND via the `@usemoney/services` barrel, proving the
 *     service surfaces the same symbols.
 *   - PARSING / HASH / NORMALIZER primitives from `@usemoney/core/import` (the
 *     shipped single source of truth) instead of inline copies.
 *
 * Plus EXHAUSTIVE negative / edge / bug-hunt coverage:
 *   - non-finite price/qty must NOT persist a corrupt Trade nor poison the
 *     summary totals (reject + count as skipped);
 *   - duplicate priority: SYNCED wins over IMPORTED (no double-count); in-file
 *     identical rows deduped; Invalid-Date duplicate key is stable (no throw);
 *   - progress %: 0 total → 0 not NaN, > 100 guarded, empty file → zeroed
 *     summary with no throw;
 *   - malformed row (missing cols, wrong types) → skipped with reason, never a
 *     whole-import crash;
 *   - consumer-safety: no NaN/Invalid reaches the summary shape.
 *
 * Layer: unit (pure logic — no Prisma / network / open handles; exits clean).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── (A) SERVICE orchestration: REAL exports from the pure logic source ──
// Relative cross-package path (no `@/` alias) — the de-shadow. `trade-import-logic`
// is Prisma-free, so importing it opens no DB/socket handle.
import {
  finite,
  getTradePriority,
  resolveDuplicate,
  categorizeSkip,
  mapRowToTradeInput,
  mapParsedRowToTradeInput,
  computeImportProgress,
  clampPercent,
  emptyDuplicateCounters,
  rollupDuplicateCount,
  determineImportStatus,
  summarizeImport,
  type ExistingTradeForDedup,
  type DuplicateCounters,
  type MapRowContext,
} from "../../../../packages/services/src/trade-import-logic";

// The SAME orchestration symbols, re-exported by the service barrel. Asserting
// barrel identity proves the LIVE service surface (apps/web actions, apps/api,
// workers all import from here) and the tests run the same code.
import {
  getTradePriority as svcGetTradePriority,
  resolveDuplicate as svcResolveDuplicate,
  mapRowToTradeInput as svcMapRowToTradeInput,
  computeImportProgress as svcComputeImportProgress,
  summarizeImport as svcSummarizeImport,
} from "@usemoney/services";

// ── (B) PARSING / HASH primitives: REAL exports from @usemoney/core/import ──
import {
  generateDuplicateHash,
  normalizeTradeType,
  normalizeExchange,
  normalizeSegment,
  normalizeColumnName,
  parseNumber,
  parseDate,
  parseDateTime,
  getColumnMapping,
  parseCSVRow,
  detectDelimiter,
  type ColumnMapping,
  type TradeRow,
} from "@usemoney/core/import";

// ── Factories ──────────────────────────────────────────────────────────

function existing(
  overrides: Partial<ExistingTradeForDedup> = {}
): ExistingTradeForDedup {
  return {
    id: "t1",
    duplicateHash: "hash",
    sourceType: "IMPORTED",
    broker: null,
    brokerUserId: null,
    brokerTradeId: null,
    importBatchId: "batch1",
    ...overrides,
  };
}

function validRow(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    symbol: "RELIANCE",
    isin: undefined,
    tradeDate: new Date("2024-01-15T00:00:00Z"),
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    quantity: 10,
    price: 2500,
    orderType: "MARKET",
    productType: "CNC",
    ...overrides,
  };
}

const brokerCtx: MapRowContext = {
  linkingToManual: false,
  linkingToBroker: true,
};
const manualCtx: MapRowContext = {
  linkingToManual: true,
  linkingToBroker: false,
};

// ════════════════════════════════════════════════════════════════════════════
// (A) Barrel identity — the service re-exports the same orchestration symbols
// ════════════════════════════════════════════════════════════════════════════

describe("trade-import service barrel re-exports the real logic", () => {
  it("exposes the SAME function references as the logic source", () => {
    assert.strictEqual(svcGetTradePriority, getTradePriority);
    assert.strictEqual(svcResolveDuplicate, resolveDuplicate);
    assert.strictEqual(svcMapRowToTradeInput, mapRowToTradeInput);
    assert.strictEqual(svcComputeImportProgress, computeImportProgress);
    assert.strictEqual(svcSummarizeImport, summarizeImport);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (A) finite() guard
// ════════════════════════════════════════════════════════════════════════════

describe("trade-import-logic.finite (real export)", () => {
  it("passes through finite numbers", () => {
    assert.equal(finite(42), 42);
    assert.equal(finite(0), 0);
    assert.equal(finite(-3.5), -3.5);
  });

  it("collapses NaN / ±Infinity / null / undefined to fallback", () => {
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN, 7), 7);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (A) Duplicate priority — getTradePriority + resolveDuplicate (REAL exports)
// ════════════════════════════════════════════════════════════════════════════

describe("trade-import-logic.getTradePriority (real export)", () => {
  it("SYNCED = 4 (highest)", () => {
    assert.equal(
      getTradePriority(existing({ sourceType: "SYNCED", broker: "ZERODHA" })),
      4
    );
  });
  it("IMPORTED with broker = 3", () => {
    assert.equal(
      getTradePriority(existing({ sourceType: "IMPORTED", broker: "ZERODHA" })),
      3
    );
  });
  it("MANUAL = 2", () => {
    assert.equal(getTradePriority(existing({ sourceType: "MANUAL" })), 2);
  });
  it("IMPORTED without broker = 1 (lowest)", () => {
    assert.equal(
      getTradePriority(existing({ sourceType: "IMPORTED", broker: null })),
      1
    );
  });
});

describe("trade-import-logic.resolveDuplicate (real export)", () => {
  it("SKIPs when a SYNCED trade exists for the same broker", () => {
    const r = resolveDuplicate(
      [existing({ sourceType: "SYNCED", broker: "ZERODHA" })],
      {
        broker: "ZERODHA",
        manual: false,
      }
    );
    assert.equal(r.action, "SKIP");
    assert.match(r.reason, /Already synced/);
  });

  it("SKIPs (manual discarded) when SYNCED exists and importing as manual", () => {
    const r = resolveDuplicate(
      [existing({ sourceType: "SYNCED", broker: "ZERODHA" })],
      {
        broker: null,
        manual: true,
      }
    );
    assert.equal(r.action, "SKIP");
    assert.match(r.reason, /Manual discarded/);
  });

  it("SKIPs with promptOptions on cross-broker SYNCED conflict", () => {
    const r = resolveDuplicate(
      [existing({ sourceType: "SYNCED", broker: "ZERODHA" })],
      {
        broker: "UPSTOX",
        manual: false,
      }
    );
    assert.equal(r.action, "SKIP");
    assert.ok(r.promptOptions);
    assert.equal(r.promptOptions!.currentBroker, "ZERODHA");
    assert.equal(r.promptOptions!.newBroker, "UPSTOX");
  });

  it("UPGRADEs a MANUAL trade when importing broker-linked", () => {
    const r = resolveDuplicate([existing({ sourceType: "MANUAL" })], {
      broker: "ZERODHA",
      manual: false,
    });
    assert.equal(r.action, "UPGRADE");
    assert.match(r.reason, /Upgrading from Manual/);
  });

  it("SKIPs an IMPORTED duplicate for the same broker", () => {
    const r = resolveDuplicate(
      [existing({ sourceType: "IMPORTED", broker: "ZERODHA" })],
      {
        broker: "ZERODHA",
        manual: false,
      }
    );
    assert.equal(r.action, "SKIP");
    assert.match(r.reason, /Already imported/);
  });

  it("SKIPs an unlinked IMPORTED duplicate", () => {
    const r = resolveDuplicate(
      [existing({ sourceType: "IMPORTED", broker: null })],
      {
        broker: null,
        manual: false,
      }
    );
    assert.equal(r.action, "SKIP");
    assert.equal(r.reason, "Duplicate import");
  });

  // ── BUG-HUNT: SYNCED must WIN over an IMPORTED duplicate (no double-count) ──
  it("selects the SYNCED row even when an IMPORTED dup is listed first (no double-count)", () => {
    const r = resolveDuplicate(
      [
        existing({ id: "imp", sourceType: "IMPORTED", broker: null }), // priority 1
        existing({ id: "man", sourceType: "MANUAL" }), // priority 2
        existing({ id: "syn", sourceType: "SYNCED", broker: "ZERODHA" }), // priority 4
      ],
      { broker: "ZERODHA", manual: false }
    );
    assert.equal(r.action, "SKIP");
    assert.equal(r.existingTrade?.sourceType, "SYNCED");
    assert.equal(r.existingTrade?.id, "syn");
  });

  // ── BUG FIXED: resolveDuplicate must NOT mutate the caller's array ──
  // The live action did `existing.sort(...)` IN PLACE, reordering the caller's
  // duplicateMap entry. The extracted logic sorts a copy. Regression-guard it.
  it("does NOT mutate the input array order (sorts a copy)", () => {
    const input = [
      existing({ id: "imp", sourceType: "IMPORTED", broker: null }),
      existing({ id: "syn", sourceType: "SYNCED", broker: "ZERODHA" }),
    ];
    const before = input.map((t) => t.id);
    resolveDuplicate(input, { broker: "ZERODHA", manual: false });
    assert.deepEqual(
      input.map((t) => t.id),
      before,
      "input array order must be preserved"
    );
  });

  // ── BUG FIXED: empty candidate list must not throw (was undefined[0]) ──
  it("returns IMPORT (no throw) for an empty candidate list", () => {
    const r = resolveDuplicate([], { broker: "ZERODHA", manual: false });
    assert.equal(r.action, "IMPORT");
  });
});

describe("trade-import-logic.categorizeSkip (real export)", () => {
  it("buckets SYNCED → synced", () => {
    assert.equal(
      categorizeSkip(existing({ sourceType: "SYNCED" }), "ZERODHA"),
      "synced"
    );
  });
  it("buckets MANUAL → manual", () => {
    assert.equal(
      categorizeSkip(existing({ sourceType: "MANUAL" }), "ZERODHA"),
      "manual"
    );
  });
  it("buckets same-broker IMPORTED → sameAccount", () => {
    assert.equal(
      categorizeSkip(
        existing({ sourceType: "IMPORTED", broker: "ZERODHA" }),
        "ZERODHA"
      ),
      "sameAccount"
    );
  });
  it("buckets cross-broker IMPORTED → differentAccount", () => {
    assert.equal(
      categorizeSkip(
        existing({ sourceType: "IMPORTED", broker: "ZERODHA" }),
        "UPSTOX"
      ),
      "differentAccount"
    );
  });
  it("buckets unlinked IMPORTED → sameAccount (default)", () => {
    assert.equal(
      categorizeSkip(existing({ sourceType: "IMPORTED", broker: null }), null),
      "sameAccount"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (A) Row → Trade mapping — mapRowToTradeInput (REAL export). BUG-HUNT core.
// ════════════════════════════════════════════════════════════════════════════

describe("trade-import-logic.mapRowToTradeInput (real export)", () => {
  it("maps a valid row to a finite Trade payload", () => {
    const r = mapRowToTradeInput(
      validRow({ quantity: 10, price: 2500 }),
      brokerCtx
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.data.symbol, "RELIANCE");
    assert.equal(r.data.quantity, 10);
    assert.equal(r.data.price, 2500);
    assert.equal(r.data.tradeValue, 25000);
    assert.ok(Number.isFinite(r.data.tradeValue));
    assert.equal(r.data.positionType, "LONG");
    assert.equal(r.data.sourceType, "IMPORTED");
    assert.equal(r.data.isEditable, false); // broker-linked → not editable
    assert.equal(r.data.brokerage, 20);
  });

  it("derives SHORT for SELL", () => {
    const r = mapRowToTradeInput(validRow({ tradeType: "SELL" }), brokerCtx);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.data.positionType, "SHORT");
  });

  it("manual import → MANUAL + editable", () => {
    const r = mapRowToTradeInput(validRow(), manualCtx);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.data.sourceType, "MANUAL");
      assert.equal(r.data.isEditable, true);
    }
  });

  it("MF segment → zero charges; uses ISIN as tradingSymbol", () => {
    const r = mapRowToTradeInput(
      validRow({ segment: "MF", isin: "INF209K01157" }),
      manualCtx
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.data.brokerage, 0);
      assert.equal(r.data.totalCharges, 0);
      assert.equal(r.data.tradingSymbol, "INF209K01157");
      assert.equal(r.data.isin, "INF209K01157");
    }
  });

  it("price of 0 is ALLOWED (bonus / IPO allotment)", () => {
    const r = mapRowToTradeInput(validRow({ price: 0 }), brokerCtx);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.data.tradeValue, 0);
  });

  // ── BUG-HUNT: non-finite qty/price must REJECT (not persist a corrupt Trade) ──
  it("REJECTS NaN quantity (no corrupt Trade, counts as skip)", () => {
    const r = mapRowToTradeInput(validRow({ quantity: NaN }), brokerCtx);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Invalid quantity/);
  });

  it("REJECTS Infinity price (no corrupt tradeValue)", () => {
    const r = mapRowToTradeInput(validRow({ price: Infinity }), brokerCtx);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Invalid price/);
  });

  it("REJECTS zero / negative quantity", () => {
    assert.equal(
      mapRowToTradeInput(validRow({ quantity: 0 }), brokerCtx).ok,
      false
    );
    assert.equal(
      mapRowToTradeInput(validRow({ quantity: -5 }), brokerCtx).ok,
      false
    );
  });

  it("REJECTS negative price", () => {
    assert.equal(
      mapRowToTradeInput(validRow({ price: -1 }), brokerCtx).ok,
      false
    );
  });

  it("REJECTS an Invalid Date (no .toISOString() throw downstream)", () => {
    const r = mapRowToTradeInput(
      validRow({ tradeDate: new Date("not-a-date") }),
      brokerCtx
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Invalid trade date/);
  });

  it("REJECTS a missing symbol", () => {
    const r = mapRowToTradeInput(validRow({ symbol: "" }), brokerCtx);
    assert.equal(r.ok, false);
  });

  // ── BUG-HUNT: qty*price overflow to Infinity must REJECT, never write Inf ──
  it("REJECTS a tradeValue that overflows to Infinity", () => {
    const r = mapRowToTradeInput(
      validRow({ quantity: Number.MAX_VALUE, price: Number.MAX_VALUE }),
      brokerCtx
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /overflow/);
  });

  it("never emits a non-finite quantity/price/tradeValue on the OK path", () => {
    const r = mapRowToTradeInput(
      validRow({ quantity: 3, price: 99.99 }),
      brokerCtx
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.ok(Number.isFinite(r.data.quantity));
      assert.ok(Number.isFinite(r.data.price));
      assert.ok(Number.isFinite(r.data.tradeValue));
    }
  });
});

describe("trade-import-logic.mapParsedRowToTradeInput (real export)", () => {
  it("propagates a parse error as the skip reason", () => {
    const r = mapParsedRowToTradeInput(
      { data: {} as TradeRow, rowNumber: 5, error: "Missing price" },
      brokerCtx
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "Missing price");
  });

  it("maps a clean parsed row", () => {
    const r = mapParsedRowToTradeInput(
      { data: validRow(), rowNumber: 2 },
      brokerCtx
    );
    assert.ok(r.ok);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (A) Progress % — computeImportProgress / clampPercent (REAL exports)
// ════════════════════════════════════════════════════════════════════════════

describe("trade-import-logic.computeImportProgress (real export)", () => {
  it("maps processed/total onto a [base, base+span] window", () => {
    // 50 of 100 over the live 20..90 window → 55
    assert.equal(computeImportProgress(50, 100, 20, 70), 55);
  });

  it("full progress = base + span", () => {
    assert.equal(computeImportProgress(100, 100, 20, 70), 90);
  });

  // ── BUG-HUNT: div-by-zero (0 total rows) → base, NOT NaN ──
  it("0 total → base (never NaN)", () => {
    const p = computeImportProgress(0, 0, 20, 70);
    assert.ok(Number.isFinite(p));
    assert.equal(p, 20);
  });

  it("0 total with default base → 0 (never NaN)", () => {
    const p = computeImportProgress(0, 0);
    assert.ok(Number.isFinite(p));
    assert.equal(p, 0);
  });

  // ── BUG-HUNT: overshoot (processed > total) must clamp to 100, never > 100 ──
  it("processed > total clamps to 100 (no > 100)", () => {
    assert.equal(computeImportProgress(200, 100, 50, 100), 100);
  });

  it("clamps to [0,100] when base+span exceeds 100", () => {
    assert.equal(computeImportProgress(100, 100, 80, 50), 100);
  });

  it("non-finite total → base (never NaN)", () => {
    assert.equal(computeImportProgress(5, NaN, 10, 80), 10);
    assert.equal(computeImportProgress(5, Infinity, 10, 80), 10);
  });
});

describe("trade-import-logic.clampPercent (real export)", () => {
  it("clamps below 0 and above 100", () => {
    assert.equal(clampPercent(-10), 0);
    assert.equal(clampPercent(150), 100);
    assert.equal(clampPercent(42), 42);
  });
  it("non-finite → 0", () => {
    assert.equal(clampPercent(NaN), 0);
    assert.equal(clampPercent(Infinity), 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (A) Summary rollup — rollupDuplicateCount / determineImportStatus / summarize
// ════════════════════════════════════════════════════════════════════════════

describe("trade-import-logic.rollupDuplicateCount (real export)", () => {
  it("sums synced+sameAccount+differentAccount+manual, EXCLUDING upgraded", () => {
    const d: DuplicateCounters = {
      synced: 5,
      sameAccount: 3,
      differentAccount: 2,
      upgraded: 99, // must NOT be counted
      manual: 4,
    };
    assert.equal(rollupDuplicateCount(d), 14);
  });

  it("finite-guards a corrupt counter (NaN/Infinity → 0 addend)", () => {
    const d: DuplicateCounters = {
      synced: NaN,
      sameAccount: 3,
      differentAccount: Infinity,
      upgraded: 0,
      manual: 4,
    };
    const total = rollupDuplicateCount(d);
    assert.ok(Number.isFinite(total));
    assert.equal(total, 7);
  });

  it("emptyDuplicateCounters rolls up to 0", () => {
    assert.equal(rollupDuplicateCount(emptyDuplicateCounters()), 0);
  });
});

describe("trade-import-logic.determineImportStatus (real export)", () => {
  it("no errors → COMPLETED", () => {
    assert.equal(determineImportStatus(10, 0), "COMPLETED");
  });
  it("some imported + some errors → PARTIALLY_COMPLETED", () => {
    assert.equal(determineImportStatus(5, 3), "PARTIALLY_COMPLETED");
  });
  it("nothing imported + errors → FAILED", () => {
    assert.equal(determineImportStatus(0, 5), "FAILED");
  });
  it("non-finite counts are guarded (collapse to 0 → defensive status)", () => {
    // NaN errorCount → 0 → COMPLETED. Infinity imported → 0 → with errors, FAILED
    // (an Infinity imported count is nonsense, so it must NOT be treated as ">0").
    assert.equal(determineImportStatus(NaN, 0), "COMPLETED");
    assert.equal(determineImportStatus(Infinity, 2), "FAILED");
    assert.equal(determineImportStatus(7, NaN), "COMPLETED"); // NaN errors → 0
  });
});

describe("trade-import-logic.summarizeImport (real export)", () => {
  it("assembles a finite, derived summary for a healthy import", () => {
    const s = summarizeImport({
      totalRows: 100,
      imported: 90,
      skipped: 10,
      duplicates: {
        synced: 3,
        sameAccount: 2,
        differentAccount: 1,
        upgraded: 4,
        manual: 0,
      },
      errorCount: 0,
    });
    assert.deepEqual(s, {
      totalRows: 100,
      importedCount: 90,
      skippedCount: 10,
      duplicateCount: 6, // 3+2+1+0 (upgraded excluded)
      errorCount: 0,
      status: "COMPLETED",
    });
  });

  // ── BUG-HUNT: empty file → fully zeroed summary, no throw ──
  it("empty file (all zero) → zeroed summary, status COMPLETED, no throw", () => {
    const s = summarizeImport({
      totalRows: 0,
      imported: 0,
      skipped: 0,
      duplicates: emptyDuplicateCounters(),
      errorCount: 0,
    });
    assert.equal(s.totalRows, 0);
    assert.equal(s.importedCount, 0);
    assert.equal(s.skippedCount, 0);
    assert.equal(s.duplicateCount, 0);
    assert.equal(s.errorCount, 0);
    assert.equal(s.status, "COMPLETED");
  });

  // ── BUG-HUNT: a non-finite running counter must NOT poison the summary ──
  it("a NaN/Infinity running counter never reaches the summary (consumer-safety)", () => {
    const s = summarizeImport({
      totalRows: Infinity,
      imported: NaN,
      skipped: -5, // clamped to >= 0
      duplicates: {
        synced: NaN,
        sameAccount: 1,
        differentAccount: 0,
        upgraded: 0,
        manual: Infinity,
      },
      errorCount: 2,
    });
    assert.ok(Number.isFinite(s.totalRows));
    assert.ok(Number.isFinite(s.importedCount));
    assert.ok(Number.isFinite(s.skippedCount));
    assert.ok(Number.isFinite(s.duplicateCount));
    assert.ok(Number.isFinite(s.errorCount));
    assert.equal(s.importedCount, 0); // NaN → 0
    assert.equal(s.skippedCount, 0); // -5 clamped
    assert.equal(s.duplicateCount, 1); // NaN + 1 + 0 + Infinity → 1
    // imported 0 with 2 errors → FAILED
    assert.equal(s.status, "FAILED");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (B) Duplicate HASH — REAL @usemoney/core/import#generateDuplicateHash
// ════════════════════════════════════════════════════════════════════════════

describe("core/import generateDuplicateHash (real export)", () => {
  const base = {
    symbol: "RELIANCE",
    tradeDate: new Date("2024-01-15T00:00:00Z"),
    tradeType: "BUY",
    quantity: 10,
    price: 2500.0,
    exchange: "NSE",
    segment: "EQUITY",
  };

  it("is deterministic and 16 hex chars", () => {
    const h1 = generateDuplicateHash(base);
    const h2 = generateDuplicateHash({ ...base });
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
  });

  it("differs by symbol / date / type / qty", () => {
    assert.notEqual(
      generateDuplicateHash(base),
      generateDuplicateHash({ ...base, symbol: "TCS" })
    );
    assert.notEqual(
      generateDuplicateHash(base),
      generateDuplicateHash({
        ...base,
        tradeDate: new Date("2024-01-16T00:00:00Z"),
      })
    );
    assert.notEqual(
      generateDuplicateHash(base),
      generateDuplicateHash({ ...base, tradeType: "SELL" })
    );
    assert.notEqual(
      generateDuplicateHash(base),
      generateDuplicateHash({ ...base, quantity: 20 })
    );
  });

  it("is case-insensitive on symbol/type and rounds price to 2dp", () => {
    assert.equal(
      generateDuplicateHash({ ...base, symbol: "reliance", tradeType: "buy" }),
      generateDuplicateHash(base)
    );
    assert.equal(
      generateDuplicateHash({ ...base, price: 2500.001 }),
      generateDuplicateHash(base)
    );
  });

  it("defaults exchange→NSE and segment→EQUITY", () => {
    const noExSeg = {
      symbol: "RELIANCE",
      tradeDate: new Date("2024-01-15T00:00:00Z"),
      tradeType: "BUY",
      quantity: 10,
      price: 2500.0,
    };
    assert.equal(generateDuplicateHash(noExSeg), generateDuplicateHash(base));
  });

  // ── BUG-HUNT: identical rows within one file hash IDENTICALLY (in-file dedup) ──
  it("two identical in-file rows produce the SAME hash (deduped)", () => {
    const rowA = generateDuplicateHash(base);
    const rowB = generateDuplicateHash({ ...base });
    assert.equal(rowA, rowB);
  });

  // ── BUG-HUNT: Invalid-Date duplicate key is STABLE and does NOT throw ──
  it("an Invalid Date does NOT throw and yields a stable key", () => {
    const bad = { ...base, tradeDate: new Date("garbage") };
    let h1 = "";
    let h2 = "";
    assert.doesNotThrow(() => {
      h1 = generateDuplicateHash(bad);
      h2 = generateDuplicateHash({ ...bad });
    });
    assert.equal(h1.length, 16);
    assert.equal(h1, h2); // stable across calls
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (B) Normalizers / parsers — REAL @usemoney/core/import exports
// ════════════════════════════════════════════════════════════════════════════

describe("core/import normalizers (real exports)", () => {
  it("normalizeTradeType BUY/SELL incl. PURCHASE & '1'", () => {
    for (const b of ["buy", "BUY", "B", "BOUGHT", "PURCHASE", "1", "  Buy  "]) {
      assert.equal(normalizeTradeType(b), "BUY");
    }
    for (const s of ["sell", "SELL", "S", "UNKNOWN", ""]) {
      assert.equal(normalizeTradeType(s), "SELL");
    }
  });

  it("normalizeExchange canonicalizes & defaults to NSE", () => {
    assert.equal(normalizeExchange("NSE-EQ"), "NSE");
    assert.equal(normalizeExchange("bse"), "BSE");
    assert.equal(normalizeExchange("NFO"), "NFO");
    assert.equal(normalizeExchange(""), "NSE");
    assert.equal(normalizeExchange("custom"), "CUSTOM");
  });

  it("normalizeSegment derives from segment then exchange", () => {
    assert.equal(normalizeSegment("EQ", "NSE"), "EQUITY");
    assert.equal(normalizeSegment("F&O", "NFO"), "FO");
    assert.equal(normalizeSegment("MUTUAL FUND", "NSE"), "MF");
    assert.equal(normalizeSegment("", "NFO"), "FO");
    assert.equal(normalizeSegment("", "MCX"), "COMMODITY");
    assert.equal(normalizeSegment("", "NSE"), "EQUITY");
  });

  it("normalizeColumnName lowercases, trims, underscores", () => {
    assert.equal(normalizeColumnName("  Trade-ID "), "trade_id");
    assert.equal(
      normalizeColumnName("Order Execution Time"),
      "order_execution_time"
    );
  });

  // ── parseNumber is the shipped non-finite guard ──
  it("parseNumber strips ₹/commas and collapses non-finite to 0", () => {
    assert.equal(parseNumber("₹1,234.50"), 1234.5);
    assert.equal(parseNumber(42), 42);
    assert.equal(parseNumber(NaN), 0);
    assert.equal(parseNumber(Infinity), 0);
    assert.equal(parseNumber("Infinity"), 0);
    assert.equal(parseNumber("not-a-number"), 0);
    assert.equal(parseNumber(null), 0);
  });
});

describe("core/import date parsers (real exports)", () => {
  it("parseDate handles ISO / DD-MM-YYYY / DD/MM/YYYY", () => {
    assert.equal(parseDate("2024-01-15")?.getFullYear(), 2024);
    const d = parseDate("25/01/2024");
    assert.equal(d?.getMonth(), 0);
    assert.equal(d?.getDate(), 25);
  });
  it("parseDate returns null on empty / garbage", () => {
    assert.equal(parseDate(""), null);
    assert.equal(parseDate("not-a-date"), null);
  });
  it("parseDateTime handles ISO & space-separated", () => {
    assert.equal(parseDateTime("2024-01-15 10:30:45")?.getHours(), 10);
    assert.equal(parseDateTime(""), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (B) parseCSVRow contract — REAL row-parser + column mappings + delimiter
// ════════════════════════════════════════════════════════════════════════════

describe("core/import parseCSVRow (real export) — validation contract", () => {
  const map: ColumnMapping = getColumnMapping("generic");

  function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      symbol: "RELIANCE",
      date: "2024-01-15",
      type: "BUY",
      quantity: "10",
      price: "2500",
      ...over,
    };
  }

  it("parses a complete generic row", () => {
    const p = parseCSVRow(rawRow(), map, 2);
    assert.equal(p.error, undefined);
    assert.equal(p.data.symbol, "RELIANCE");
    assert.equal(p.data.quantity, 10);
    assert.equal(p.data.tradeType, "BUY");
  });

  // ── BUG-HUNT: missing required column → error string, NOT a crash ──
  it("missing symbol → 'Missing symbol' error (no throw)", () => {
    const p = parseCSVRow(rawRow({ symbol: "" }), map, 3);
    assert.match(p.error ?? "", /Missing symbol/);
  });
  it("missing date → error", () => {
    assert.match(
      parseCSVRow(rawRow({ date: "" }), map, 4).error ?? "",
      /Missing trade date/
    );
  });
  it("missing quantity / price → error", () => {
    assert.match(
      parseCSVRow(rawRow({ quantity: "" }), map, 5).error ?? "",
      /Missing quantity/
    );
    assert.match(
      parseCSVRow(rawRow({ price: "" }), map, 6).error ?? "",
      /Missing price/
    );
  });

  // ── BUG-HUNT: wrong-typed / out-of-range numerics → error, never a bad Trade ──
  it("non-positive quantity → 'Invalid quantity'", () => {
    assert.match(
      parseCSVRow(rawRow({ quantity: "0" }), map, 7).error ?? "",
      /Invalid quantity/
    );
    assert.match(
      parseCSVRow(rawRow({ quantity: "-3" }), map, 8).error ?? "",
      /Invalid quantity/
    );
  });
  it("garbage quantity (parses to 0) → 'Invalid quantity'", () => {
    assert.match(
      parseCSVRow(rawRow({ quantity: "abc" }), map, 9).error ?? "",
      /Invalid quantity/
    );
  });
  it("malformed date → 'Invalid date format'", () => {
    // A truly unparseable date: no ISO match, no DD-MM/DD-/-YYYY digit match, and
    // `new Date("not-a-real-date")` is Invalid → parseDate returns null.
    assert.match(
      parseCSVRow(rawRow({ date: "not-a-real-date" }), map, 10).error ?? "",
      /Invalid date/
    );
  });

  // ── extra/unknown columns are ignored, not fatal ──
  it("extra unknown columns are ignored (no crash)", () => {
    const p = parseCSVRow(
      rawRow({ junk1: "x", junk2: 99, nested: { a: 1 } }),
      map,
      11
    );
    assert.equal(p.error, undefined);
    assert.equal(p.data.symbol, "RELIANCE");
  });

  it("ISIN-looking symbol is detected as ISIN", () => {
    const p = parseCSVRow(rawRow({ symbol: "INE002A01018" }), map, 12);
    assert.equal(p.error, undefined);
    assert.equal(p.data.isin, "INE002A01018");
  });

  it("getColumnMapping returns distinct maps per broker format", () => {
    // Real zerodha tradeDate header candidates (superset, case variants included).
    assert.ok(getColumnMapping("zerodha").tradeDate.includes("trade_date"));
    assert.ok(getColumnMapping("zerodha").tradeDate.includes("Trade Date"));
    // upstox vs generic symbol candidate lists differ.
    assert.notDeepEqual(
      getColumnMapping("upstox").symbol,
      getColumnMapping("generic").symbol
    );
    // unknown format falls back to the generic mapping.
    assert.deepEqual(
      getColumnMapping(
        "nope" as unknown as Parameters<typeof getColumnMapping>[0]
      ),
      getColumnMapping("generic")
    );
  });

  it("detectDelimiter picks comma / semicolon / tab / pipe", () => {
    assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
    assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
    assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
    assert.equal(detectDelimiter("a|b|c\n1|2|3"), "|");
    assert.equal(detectDelimiter(""), ",");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (C) End-to-end-ish pipeline simulation (pure): parse → map → summarize
// proving non-finite / malformed rows are skipped and totals stay finite.
// ════════════════════════════════════════════════════════════════════════════

describe("pure import pipeline: parse → map → summarize (no corruption)", () => {
  const map: ColumnMapping = getColumnMapping("generic");

  it("a file mixing valid, malformed and in-file-duplicate rows yields a finite, correct summary", () => {
    const rows: Record<string, unknown>[] = [
      {
        symbol: "RELIANCE",
        date: "2024-01-15",
        type: "BUY",
        quantity: "10",
        price: "2500",
      }, // valid
      {
        symbol: "RELIANCE",
        date: "2024-01-15",
        type: "BUY",
        quantity: "10",
        price: "2500",
      }, // in-file dup
      {
        symbol: "TCS",
        date: "2024-01-15",
        type: "SELL",
        quantity: "5",
        price: "3800",
      }, // valid
      {
        symbol: "",
        date: "2024-01-15",
        type: "BUY",
        quantity: "1",
        price: "10",
      }, // malformed (no symbol)
      {
        symbol: "INFY",
        date: "bad-date",
        type: "BUY",
        quantity: "2",
        price: "1500",
      }, // malformed (date)
      {
        symbol: "WIPRO",
        date: "2024-01-15",
        type: "BUY",
        quantity: "0",
        price: "400",
      }, // invalid qty
    ];

    const ctx: MapRowContext = {
      linkingToManual: true,
      linkingToBroker: false,
    };
    const seen = new Set<string>();
    const dup = emptyDuplicateCounters();
    let imported = 0;
    let skipped = 0;
    let errorCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const parsed = parseCSVRow(rows[i], map, i + 2);
      const mapped = mapParsedRowToTradeInput(parsed, ctx);
      if (!mapped.ok) {
        // malformed / invalid → skipped with a reason, never a crash
        errorCount++;
        skipped++;
        continue;
      }
      const hash = generateDuplicateHash({
        symbol: mapped.data.symbol,
        tradeDate: mapped.data.tradeDate,
        tradeType: mapped.data.tradeType,
        quantity: mapped.data.quantity,
        price: mapped.data.price,
        exchange: mapped.data.exchange,
        segment: mapped.data.segment,
      });
      if (seen.has(hash)) {
        dup.sameAccount++;
        skipped++;
        continue;
      }
      seen.add(hash);
      imported++;
    }

    // 2 imported (RELIANCE, TCS), 1 in-file dup, 3 malformed/invalid.
    assert.equal(imported, 2);
    assert.equal(skipped, 4);
    assert.equal(errorCount, 3);

    const summary = summarizeImport({
      totalRows: rows.length,
      imported,
      skipped,
      duplicates: dup,
      errorCount,
    });

    assert.ok(Number.isFinite(summary.duplicateCount));
    assert.equal(summary.totalRows, 6);
    assert.equal(summary.importedCount, 2);
    assert.equal(summary.duplicateCount, 1); // the in-file dup
    assert.equal(summary.errorCount, 3);
    assert.equal(summary.status, "PARTIALLY_COMPLETED"); // imported > 0 with errors
  });

  it("a file of ONLY malformed rows → zero imported, FAILED, finite summary (no throw)", () => {
    const rows: Record<string, unknown>[] = [
      {
        symbol: "",
        date: "2024-01-15",
        type: "BUY",
        quantity: "1",
        price: "10",
      },
      { symbol: "X", date: "garbage", type: "BUY", quantity: "1", price: "10" },
    ];
    const ctx: MapRowContext = {
      linkingToManual: true,
      linkingToBroker: false,
    };
    let imported = 0;
    let skipped = 0;
    let errorCount = 0;
    assert.doesNotThrow(() => {
      for (let i = 0; i < rows.length; i++) {
        const mapped = mapParsedRowToTradeInput(
          parseCSVRow(rows[i], map, i + 2),
          ctx
        );
        if (!mapped.ok) {
          errorCount++;
          skipped++;
        } else {
          imported++;
        }
      }
    });
    const summary = summarizeImport({
      totalRows: rows.length,
      imported,
      skipped,
      duplicates: emptyDuplicateCounters(),
      errorCount,
    });
    assert.equal(summary.importedCount, 0);
    assert.equal(summary.status, "FAILED");
    assert.ok(Number.isFinite(summary.duplicateCount));
  });
});
