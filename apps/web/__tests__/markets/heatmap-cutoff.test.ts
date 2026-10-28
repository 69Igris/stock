/**
 * Heatmap timeframe cutoff date math (MONEY-242).
 *
 * De-shadowed: the cutoff logic was extracted from `getHeatmapDataAction`
 * into `lib/actions/discover-heatmap-logic.ts` (the action now imports it).
 * This test exercises the REAL `heatmapCutoffFor` export across the four
 * timeframes. `cutoffFor` below is a thin (now, tf)→Date adapter over the
 * real function; `ist()` is a fixture builder, not the unit under test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  heatmapCutoffFor,
  type HeatmapTimeframeForCutoff,
} from "@/lib/actions/discover-heatmap-logic";

type Tf = HeatmapTimeframeForCutoff;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Adapter: keeps the existing (now, tf) call sites, delegates to source. */
function cutoffFor(now: Date, tf: Tf): Date | null {
  return heatmapCutoffFor(tf, now);
}

/** Build a UTC instant from an IST clock spec. */
function ist(
  y: number,
  m: number,
  d: number,
  hh: number = 11,
  mm: number = 0
): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS);
}

describe("heatmap timeframe cutoff (MONEY-242)", () => {
  it("1D returns null cutoff (intraday - uses LatestQuote.changePercent)", () => {
    assert.equal(cutoffFor(new Date(), "1D"), null);
  });

  it("1W rolls back exactly 7 IST calendar days", () => {
    const now = ist(2026, 5, 15); // Fri 15 May 2026 IST
    const c = cutoffFor(now, "1W")!;
    // Expect 8 May 2026 (UTC midnight at the start of the IST day).
    assert.equal(c.getUTCFullYear(), 2026);
    assert.equal(c.getUTCMonth() + 1, 5);
    assert.equal(c.getUTCDate(), 8);
  });

  it("1M rolls back one calendar month, preserving day-of-month", () => {
    const now = ist(2026, 5, 15);
    const c = cutoffFor(now, "1M")!;
    assert.equal(c.getUTCFullYear(), 2026);
    assert.equal(c.getUTCMonth() + 1, 4);
    assert.equal(c.getUTCDate(), 15);
  });

  it("1M edge: when current is Mar 31, JS rolls forward to Mar 3 (acceptable)", () => {
    // setUTCMonth(month - 1) on Mar 31 lands on Mar 3 (Feb has 28 days).
    // Document the behavior so it doesn't regress silently.
    const now = ist(2026, 3, 31);
    const c = cutoffFor(now, "1M")!;
    assert.equal(c.getUTCMonth() + 1, 3);
    assert.equal(c.getUTCDate(), 3);
  });

  it("YTD anchors to Jan 1 of the current IST year", () => {
    const now = ist(2026, 7, 22, 14, 30);
    const c = cutoffFor(now, "YTD")!;
    assert.equal(c.getUTCFullYear(), 2026);
    assert.equal(c.getUTCMonth() + 1, 1);
    assert.equal(c.getUTCDate(), 1);
  });

  it("YTD on Jan 5 returns Jan 1 of the same year (4-day window)", () => {
    const now = ist(2027, 1, 5);
    const c = cutoffFor(now, "YTD")!;
    assert.equal(c.getUTCFullYear(), 2027);
    assert.equal(c.getUTCMonth() + 1, 1);
    assert.equal(c.getUTCDate(), 1);
  });

  it("Cutoff is at UTC midnight of the IST cutoff date (not 00:00 IST)", () => {
    const now = ist(2026, 5, 15);
    const c = cutoffFor(now, "1W")!;
    // The query passes `gte: cutoff` so DailyPrice rows for the IST
    // calendar day land in the window. UTC midnight is intentional.
    assert.equal(c.getUTCHours(), 0);
    assert.equal(c.getUTCMinutes(), 0);
  });
});
