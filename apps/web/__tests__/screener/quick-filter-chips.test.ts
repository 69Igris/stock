/**
 * QuickFilterChips preset logic.
 *
 * The component itself is React + JSX so we don't render here - instead
 * we test the pure preset definitions to make sure each preset:
 *   1. activates and reports active state correctly
 *   2. round-trips: apply then re-apply → cleans up the same fields
 *
 * The presets are private to the component, so we duplicate the tiny
 * preset list here. If any preset definition changes in the source,
 * update this fixture in lockstep.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScreenFilters } from "../../lib/actions/screener";

interface Preset {
  id: string;
  apply: (f: ScreenFilters) => Partial<ScreenFilters>;
  isActive: (f: ScreenFilters) => boolean;
}

// Mirrors PRESETS in components/screener/QuickFilterChips.tsx.
const PRESETS: Preset[] = [
  {
    id: "lc",
    apply: () => ({ marketCapBucket: "LARGE" }),
    isActive: (f) => f.marketCapBucket === "LARGE",
  },
  {
    id: "qroe",
    apply: () => ({ minRoe: 20 }),
    isActive: (f) => (f.minRoe ?? -1) >= 20,
  },
  {
    id: "lev",
    apply: () => ({ maxDebtToEquity: 0.5 }),
    isActive: (f) => (f.maxDebtToEquity ?? Infinity) <= 0.5,
  },
  {
    id: "val",
    apply: () => ({ maxPe: 20 }),
    isActive: (f) => (f.maxPe ?? Infinity) <= 20,
  },
];

describe("QuickFilterChips presets", () => {
  it("starts inactive on a fresh filter set", () => {
    const empty: ScreenFilters = {};
    for (const p of PRESETS) {
      assert.equal(
        p.isActive(empty),
        false,
        `preset ${p.id} should not be active`
      );
    }
  });

  it("activates after applying", () => {
    for (const p of PRESETS) {
      const applied: ScreenFilters = {
        ...({} as ScreenFilters),
        ...p.apply({}),
      };
      assert.equal(
        p.isActive(applied),
        true,
        `preset ${p.id} should activate after apply`
      );
    }
  });

  it("toggling off via undefined reset clears active flag", () => {
    for (const p of PRESETS) {
      const applied: ScreenFilters = {
        ...({} as ScreenFilters),
        ...p.apply({}),
      };
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(p.apply({}))) {
        patch[k] = undefined;
      }
      const cleaned = { ...applied, ...patch } as ScreenFilters;
      assert.equal(
        p.isActive(cleaned),
        false,
        `preset ${p.id} should be inactive after reset`
      );
    }
  });

  it("low-debt preset boundary at exactly 0.5", () => {
    const lev = PRESETS.find((p) => p.id === "lev");
    assert.ok(lev);
    if (!lev) return;
    assert.equal(lev.isActive({ maxDebtToEquity: 0.5 }), true);
    assert.equal(lev.isActive({ maxDebtToEquity: 0.51 }), false);
  });

  it("undervalued preset boundary at exactly 20 P/E", () => {
    const val = PRESETS.find((p) => p.id === "val");
    assert.ok(val);
    if (!val) return;
    assert.equal(val.isActive({ maxPe: 20 }), true);
    assert.equal(val.isActive({ maxPe: 20.01 }), false);
  });

  it("quality preset requires minRoe ≥ 20", () => {
    const qroe = PRESETS.find((p) => p.id === "qroe");
    assert.ok(qroe);
    if (!qroe) return;
    assert.equal(qroe.isActive({ minRoe: 20 }), true);
    assert.equal(qroe.isActive({ minRoe: 19.99 }), false);
    assert.equal(qroe.isActive({}), false);
  });
});
