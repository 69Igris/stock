/**
 * Unit tests for the cycle helpers in useBillingCycle.
 *
 * The hook itself depends on Next.js useSearchParams/useRouter so we
 * cover only the pure helpers exported from the module
 * (computeAnnualSavings, BILLING_CYCLES). The reactive hook portion
 * is exercised via the runtime flow on Landing / /pricing / Settings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAnnualSavings,
  BILLING_CYCLES,
} from "../../lib/pricing/useBillingCycle";

describe("useBillingCycle / computeAnnualSavings", () => {
  it("PRO 249/mo vs 1999/yr ≈ 33%", () => {
    assert.equal(computeAnnualSavings(249, 1999), 33);
  });

  it("Premium 1499/mo vs 14999/yr ≈ 17%", () => {
    assert.equal(computeAnnualSavings(1499, 14999), 17);
  });

  it("returns null when annual is not actually cheaper", () => {
    // 100 × 12 = 1200; annual 1200 → no savings
    assert.equal(computeAnnualSavings(100, 1200), null);
    // annual MORE than monthly × 12 → no savings
    assert.equal(computeAnnualSavings(100, 1500), null);
  });

  it("returns null for null / undefined / zero / negative", () => {
    assert.equal(computeAnnualSavings(null, 1999), null);
    assert.equal(computeAnnualSavings(249, undefined), null);
    assert.equal(computeAnnualSavings(0, 1999), null);
    assert.equal(computeAnnualSavings(249, 0), null);
    assert.equal(computeAnnualSavings(-249, 1999), null);
  });

  it("returns null for NaN / Infinity (defensive)", () => {
    assert.equal(computeAnnualSavings(NaN, 1999), null);
    assert.equal(computeAnnualSavings(249, Infinity), null);
  });
});

describe("useBillingCycle / BILLING_CYCLES constant", () => {
  it("contains exactly monthly and annual", () => {
    assert.deepEqual([...BILLING_CYCLES].sort(), ["annual", "monthly"]);
  });
});
