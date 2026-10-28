/**
 * Ask FIRE chat — allocation auto-rebalance UNIT tests (MONEY-1049).
 *
 * `rebalanceAssetAllocations` is the deterministic 100% guarantee applied
 * after chat-driven allocation changes: it adjusts ONLY the untouched assets
 * (proportional scaling + largest-remainder rounding) so the values the
 * assistant explicitly set stay exact. This suite pins:
 *   - the original bug scenario (40/5/10/30/10 = 95% after "make my plan
 *     more conservative") resolving to exactly 100 with touched preserved;
 *   - undershoot AND overshoot totals;
 *   - the all-touched / preserved-≥100 fallback (scale everything);
 *   - integer output that sums to exactly 100 (largest-remainder), and
 *   - no-op behaviour when already balanced.
 *
 * Source: apps/web/app/fire/lib/chat/bridge.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rebalanceAssetAllocations } from "@/app/fire/lib/chat/bridge";
import type { AssetClass } from "@/app/fire/lib/types";

const mk = (name: string, allocation: number): AssetClass => ({
  id: name,
  name,
  icon: "💼",
  allocation,
  expectedReturn: 10,
  color: "#000",
});

const sum = (xs: AssetClass[]) => xs.reduce((s, a) => s + a.allocation, 0);
const get = (xs: AssetClass[], name: string) =>
  xs.find((a) => a.name === name)!.allocation;

describe("rebalanceAssetAllocations — undershoot (the original 95% bug)", () => {
  const out = rebalanceAssetAllocations(
    [
      mk("Equity", 40),
      mk("Cash", 5),
      mk("Gold", 10),
      mk("Fixed Deposits", 30),
      mk("Real Estate", 10),
    ],
    ["Equity", "Fixed Deposits"]
  );

  it("totals exactly 100", () => {
    assert.equal(sum(out), 100);
  });

  it("preserves the assets the assistant set explicitly", () => {
    assert.equal(get(out, "Equity"), 40);
    assert.equal(get(out, "Fixed Deposits"), 30);
  });

  it("absorbs the gap only into untouched assets", () => {
    assert.equal(
      get(out, "Cash") + get(out, "Gold") + get(out, "Real Estate"),
      30
    );
  });

  it("emits integer allocations", () => {
    for (const a of out) assert.ok(Number.isInteger(a.allocation), a.name);
  });
});

describe("rebalanceAssetAllocations — overshoot", () => {
  const out = rebalanceAssetAllocations(
    [mk("Equity", 70), mk("Cash", 40), mk("Gold", 10)],
    ["Equity"]
  );

  it("shrinks untouched assets down to exactly 100", () => {
    assert.equal(sum(out), 100);
    assert.equal(get(out, "Equity"), 70);
    assert.equal(get(out, "Cash") + get(out, "Gold"), 30);
  });
});

describe("rebalanceAssetAllocations — fallbacks & edges", () => {
  it("already balanced (within 0.5) → returned untouched", () => {
    const input = [mk("Equity", 60), mk("Cash", 40)];
    const out = rebalanceAssetAllocations(input, ["Equity"]);
    assert.equal(get(out, "Cash"), 40);
    assert.equal(get(out, "Equity"), 60);
  });

  it("every asset touched → scales ALL to 100 (fallback)", () => {
    const out = rebalanceAssetAllocations(
      [mk("A", 50), mk("B", 50), mk("C", 50)],
      ["A", "B", "C"]
    );
    assert.equal(sum(out), 100);
  });

  it("preserved assets already exceed 100 → scales ALL to 100", () => {
    const out = rebalanceAssetAllocations(
      [mk("A", 80), mk("B", 40), mk("C", 10)],
      ["A", "B"]
    );
    assert.equal(sum(out), 100);
  });

  it("empty list → returned as-is", () => {
    assert.deepEqual(rebalanceAssetAllocations([], ["X"]), []);
  });

  it("preserve names are case-insensitive", () => {
    const out = rebalanceAssetAllocations(
      [mk("Equity", 40), mk("Cash", 20), mk("Gold", 20)],
      ["equity"]
    );
    assert.equal(get(out, "Equity"), 40);
    assert.equal(sum(out), 100);
  });

  it("largest-remainder: awkward thirds still land on exactly 100", () => {
    const out = rebalanceAssetAllocations(
      [mk("A", 10), mk("B", 10), mk("C", 10)],
      []
    );
    assert.equal(sum(out), 100);
    for (const a of out) assert.ok(Number.isInteger(a.allocation));
  });
});
