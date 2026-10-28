/**
 * Strategy Scan Processor Tests (workers/src/processors/strategy-scan.ts)
 * — DE-SHADOWED.
 *
 * Previously this file re-declared inline copies of `shouldSkipScan`,
 * `shouldUpdateUsageCount`, `extractErrorMessage`, `buildStrategyInput`,
 * `buildCompletedNotification` and `buildFailedNotification` and asserted the
 * copies — a shadow that stayed green even if the real idempotency / usage-gate
 * / notification payloads regressed.
 *
 * Those helpers now live in `workers/src/processors/strategy-scan-logic.ts`,
 * which `strategy-scan.ts` imports and CALLS; this test asserts the REAL exports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker logic under test (no shadow). strategy-scan.ts CALLS these.
import {
  shouldSkipScan,
  shouldUpdateUsageCount,
  extractScanErrorMessage,
  buildStrategyInput,
  buildScanCompletedNotification,
  buildScanFailedNotification,
  type StrategyScanLike,
  type StrategyInput,
} from "../../../../workers/src/processors/strategy-scan-logic";

const base: StrategyScanLike = {
  userId: "user-1",
  scanId: "scan-1",
  strategyId: "strat-1",
  isBuiltIn: false,
  filters: [{ field: "pe", operator: "lt", value: 20 }],
  logic: "AND",
  scanType: "fundamental",
};

// ══════════════════════════════════════════════════════════════════════
// shouldSkipScan (real export)
// ══════════════════════════════════════════════════════════════════════

describe("shouldSkipScan (real export)", () => {
  it("skips a COMPLETED scan", () => {
    assert.strictEqual(shouldSkipScan("COMPLETED"), true);
  });

  it("does not skip PENDING / RUNNING / FAILED / null", () => {
    assert.strictEqual(shouldSkipScan("PENDING"), false);
    assert.strictEqual(shouldSkipScan("RUNNING"), false);
    assert.strictEqual(shouldSkipScan("FAILED"), false);
    assert.strictEqual(shouldSkipScan(null), false);
    assert.strictEqual(shouldSkipScan(undefined), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldUpdateUsageCount (real export)
// ══════════════════════════════════════════════════════════════════════

describe("shouldUpdateUsageCount (real export)", () => {
  it("updates usage for custom strategies", () => {
    assert.strictEqual(shouldUpdateUsageCount(false), true);
  });

  it("does not update usage for built-in strategies", () => {
    assert.strictEqual(shouldUpdateUsageCount(true), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// extractScanErrorMessage (real export)
// ══════════════════════════════════════════════════════════════════════

describe("extractScanErrorMessage (real export)", () => {
  it("extracts the message from an Error", () => {
    assert.strictEqual(
      extractScanErrorMessage(new Error("DB timeout")),
      "DB timeout"
    );
  });

  it("returns 'Unknown error' for non-Error throws", () => {
    assert.strictEqual(extractScanErrorMessage("string"), "Unknown error");
    assert.strictEqual(extractScanErrorMessage(null), "Unknown error");
    assert.strictEqual(extractScanErrorMessage(undefined), "Unknown error");
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildStrategyInput (real export)
// ══════════════════════════════════════════════════════════════════════

describe("buildStrategyInput (real export)", () => {
  const builtIn: StrategyInput = {
    id: "value-investing",
    name: "Value Investing",
    filters: [{ field: "pe", operator: "lt", value: 15 }],
    logic: "AND",
    scanType: "fundamental",
  };

  it("returns the built-in when isBuiltIn=true and found", () => {
    const lookup = (id: string) =>
      id === "value-investing" ? builtIn : undefined;
    const result = buildStrategyInput(
      { ...base, isBuiltIn: true, strategyId: "value-investing" },
      "My Scan",
      lookup
    );
    assert.deepStrictEqual(result, builtIn);
  });

  it("throws when the built-in is not found", () => {
    assert.throws(
      () =>
        buildStrategyInput(
          { ...base, isBuiltIn: true, strategyId: "nonexistent" },
          "My Scan",
          () => undefined
        ),
      { message: "Built-in strategy nonexistent not found" }
    );
  });

  it("builds custom input from the message when isBuiltIn=false", () => {
    const result = buildStrategyInput(base, "PE Under 20", () => undefined);
    assert.deepStrictEqual(result, {
      id: "strat-1",
      name: "PE Under 20",
      filters: [{ field: "pe", operator: "lt", value: 20 }],
      logic: "AND",
      scanType: "fundamental",
    });
  });

  it("defaults empty logic to AND, preserves OR, passes scanType", () => {
    assert.strictEqual(
      buildStrategyInput({ ...base, logic: "" }, "t", () => undefined).logic,
      "AND"
    );
    assert.strictEqual(
      buildStrategyInput({ ...base, logic: "OR" }, "t", () => undefined).logic,
      "OR"
    );
    assert.strictEqual(
      buildStrategyInput(
        { ...base, scanType: "technical" },
        "t",
        () => undefined
      ).scanType,
      "technical"
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Notification builders (real exports)
// ══════════════════════════════════════════════════════════════════════

describe("buildScanCompletedNotification (real export)", () => {
  it("builds the completed payload with stock count", () => {
    const n = buildScanCompletedNotification(base, "Low PE Stocks", 42);
    assert.strictEqual(n.type, "SCAN_COMPLETED");
    assert.strictEqual(n.title, "Strategy Scan Complete");
    assert.strictEqual(n.message, '"Low PE Stocks" found 42 matching stocks.');
    assert.strictEqual(n.userId, "user-1");
    assert.strictEqual(n.metadata.scanId, "scan-1");
    assert.strictEqual(n.metadata.strategyId, "strat-1");
    assert.strictEqual(n.metadata.stockCount, 42);
  });

  it("handles zero stock count and special characters", () => {
    assert.strictEqual(
      buildScanCompletedNotification(base, "Empty Scan", 0).message,
      '"Empty Scan" found 0 matching stocks.'
    );
    assert.ok(
      buildScanCompletedNotification(
        base,
        "PE < 20 & ROE > 15%",
        5
      ).message.includes("PE < 20 & ROE > 15%")
    );
  });
});

describe("buildScanFailedNotification (real export)", () => {
  it("extracts an Error message", () => {
    const n = buildScanFailedNotification(base, new Error("DB timeout"));
    assert.strictEqual(n.type, "SCAN_FAILED");
    assert.strictEqual(n.message, "Scan failed: DB timeout");
  });

  it("uses 'Unknown error' for non-Error throws", () => {
    assert.strictEqual(
      buildScanFailedNotification(base, "string error").message,
      "Scan failed: Unknown error"
    );
    assert.strictEqual(
      buildScanFailedNotification(base, null).message,
      "Scan failed: Unknown error"
    );
  });

  it("includes scanId + strategyId but never a stockCount", () => {
    const n = buildScanFailedNotification(base, new Error("fail"));
    assert.strictEqual(n.metadata.scanId, "scan-1");
    assert.strictEqual(n.metadata.strategyId, "strat-1");
    assert.strictEqual("stockCount" in n.metadata, false);
  });
});
