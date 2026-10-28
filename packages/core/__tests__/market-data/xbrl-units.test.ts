/**
 * The `StockFinancials` units boundary — MONEY-1205.
 *
 * `StockFinancials` is denominated in ₹ CRORE. Nothing declared that; it is
 * simply what all 32,359 prod rows are, because every one came from Tickertape
 * and Tickertape's feed is crore, stored unconverted. XBRL facts are ABSOLUTE
 * RUPEES — `xbrl-financials-logic.ts`'s own "## Scale" section says so, and it
 * is right about the filing and was silently wrong about the destination.
 *
 * So `xbrl-projection-writer.ts` was aimed at a crore column with a rupee
 * value: 10,000,000x, in the one table with no `source` in its unique key,
 * therefore unrecoverable once written.
 *
 * These tests pin the conversion AND the property that it does not defeat the
 * reconcile gate — `reconcile()` must still classify an UNCONVERTED pair as
 * `SCALE_MISMATCH`, because that block is what stands between a units bug and
 * an irreversible write.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RUPEES_PER_CRORE,
  rupeesToCrores,
  reconcile,
} from "../../src/market-data";

describe("RUPEES_PER_CRORE", () => {
  it("is 1e7", () => {
    assert.equal(RUPEES_PER_CRORE, 1e7);
    assert.equal(RUPEES_PER_CRORE, 10_000_000);
  });
});

describe("rupeesToCrores", () => {
  it("converts a rupee-denominated XBRL figure into crores", () => {
    // HDFCBANK FY2025 revenue as Tickertape stores it: ₹470,915.93 crore.
    // The same figure as an XBRL fact is 4,709,159,300,000 rupees.
    const asRupees = 470_915.93 * RUPEES_PER_CRORE;
    const asCrores = rupeesToCrores(asRupees);
    assert.ok(asCrores !== undefined);
    assert.ok(Math.abs(asCrores - 470_915.93) < 1e-6);
  });

  it("keeps fractional precision (no rounding)", () => {
    // ₹ crore carries real decimals. Rounding at the writer would manufacture
    // a disagreement for the reconcile gate to report against an exact source.
    assert.equal(rupeesToCrores(12_345_678), 1.2345678);
    assert.equal(rupeesToCrores(1), 1e-7);
  });

  it("preserves a genuine zero", () => {
    assert.equal(rupeesToCrores(0), 0);
  });

  it("preserves sign (a loss stays a loss)", () => {
    assert.equal(rupeesToCrores(-50_000_000), -5);
  });

  it("returns undefined — never 0, never NaN — for absent/poisoned input", () => {
    // The caller spreads the result into a Prisma `update:`, where `undefined`
    // means "leave the column alone" and NaN means "write NaN".
    for (const bad of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      assert.equal(rupeesToCrores(bad as number | undefined), undefined);
    }
  });
});

describe("the conversion does NOT defeat the reconcile gate", () => {
  const tickertapeCrore = 470_915.93;
  const xbrlRupees = tickertapeCrore * RUPEES_PER_CRORE;

  it("still reports SCALE_MISMATCH when the units are NOT converted", () => {
    // The pre-fix state. 1e7 is in KNOWN_SCALES, so the gate blocked — and it
    // was RIGHT to. If this ever stops being a SCALE_MISMATCH, someone has
    // widened the tolerance or removed 1e7, and the alarm is gone.
    const r = reconcile(xbrlRupees, tickertapeCrore);
    assert.equal(r.verdict, "SCALE_MISMATCH");
    assert.equal(r.scaleFactor, 1e7);
  });

  it("reports MATCH once the writer's conversion is applied", () => {
    // The post-fix state: the two figures become genuinely comparable, so the
    // gate starts judging the NUMBERS instead of the units.
    const r = reconcile(rupeesToCrores(xbrlRupees), tickertapeCrore);
    assert.equal(r.verdict, "MATCH");
  });

  it("still catches a REAL disagreement after conversion", () => {
    // Converting must not launder a genuine difference into a MATCH.
    const wrong = rupeesToCrores(xbrlRupees * 1.4);
    const r = reconcile(wrong, tickertapeCrore);
    assert.equal(r.verdict, "DISAGREEMENT");
  });

  it("still catches a sign flip after conversion", () => {
    const r = reconcile(rupeesToCrores(-xbrlRupees), tickertapeCrore);
    assert.equal(r.verdict, "SIGN_MISMATCH");
  });
});
