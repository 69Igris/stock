/**
 * Earnings Surprise Tool Tests
 * (packages/research/src/tools/compute-earnings-surprise.ts)
 *
 * De-shadowed (MONEY-620 / task 185): the previous version reimplemented
 * `computeSurprises` inline and asserted the copy. The real, registered
 * `computeEarningsSurpriseTool` is richer than the old shadow — it also
 * produces `trend` and `flags`, accepts `epsActual`/`epsEstimate`/`period`
 * aliases, and FILTERS OUT entries where both actual and estimate are 0.
 * This file now drives `computeEarningsSurpriseTool.execute()` directly so
 * those production-only behaviours are actually covered.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeEarningsSurpriseTool,
  type EarningsSurpriseResult,
} from "@usemoney/research/tools/compute-earnings-surprise";

async function run(
  earningsHistory: Array<Record<string, unknown>>
): Promise<EarningsSurpriseResult> {
  const out = await computeEarningsSurpriseTool.execute({ earningsHistory });
  assert.strictEqual(out.success, true, out.error);
  return out.data as EarningsSurpriseResult;
}

describe("Earnings Surprise Tool (real)", () => {
  describe("Surprise calculation", () => {
    it("should calculate positive surprise correctly", async () => {
      const r = await run([{ quarter: "Q1", actual: 12, estimate: 10 }]);
      assert.strictEqual(r.surprises[0]!.surprisePercent, 20);
      assert.strictEqual(r.surprises[0]!.beat, true);
    });

    it("should calculate negative surprise correctly", async () => {
      const r = await run([{ quarter: "Q1", actual: 8, estimate: 10 }]);
      assert.strictEqual(r.surprises[0]!.surprisePercent, -20);
      assert.strictEqual(r.surprises[0]!.beat, false);
    });

    it("zero estimate but non-zero actual: surprise 0, entry kept", async () => {
      const r = await run([{ quarter: "Q1", actual: 5, estimate: 0 }]);
      assert.strictEqual(r.surprises.length, 1);
      assert.strictEqual(r.surprises[0]!.surprisePercent, 0);
      assert.strictEqual(r.surprises[0]!.beat, true); // 5 >= 0
    });

    it("should handle exact match as beat", async () => {
      const r = await run([{ quarter: "Q1", actual: 10, estimate: 10 }]);
      assert.strictEqual(r.surprises[0]!.beat, true);
      assert.strictEqual(r.surprises[0]!.surprisePercent, 0);
    });

    it("accepts epsActual/epsEstimate/period aliases (real-only)", async () => {
      const r = await run([
        { period: "FY24Q1", epsActual: 12, epsEstimate: 10 },
      ]);
      assert.strictEqual(r.surprises[0]!.quarter, "FY24Q1");
      assert.strictEqual(r.surprises[0]!.surprisePercent, 20);
    });
  });

  describe("Beat rate", () => {
    it("should calculate 100% beat rate", async () => {
      const r = await run([
        { quarter: "Q1", actual: 12, estimate: 10 },
        { quarter: "Q2", actual: 11, estimate: 10 },
        { quarter: "Q3", actual: 13, estimate: 10 },
        { quarter: "Q4", actual: 15, estimate: 10 },
      ]);
      assert.strictEqual(r.beatRate, 1);
    });

    it("should calculate 0% beat rate", async () => {
      const r = await run([
        { quarter: "Q1", actual: 8, estimate: 10 },
        { quarter: "Q2", actual: 7, estimate: 10 },
        { quarter: "Q3", actual: 6, estimate: 10 },
        { quarter: "Q4", actual: 5, estimate: 10 },
      ]);
      assert.strictEqual(r.beatRate, 0);
    });

    it("should calculate 50% beat rate", async () => {
      const r = await run([
        { quarter: "Q1", actual: 12, estimate: 10 },
        { quarter: "Q2", actual: 8, estimate: 10 },
        { quarter: "Q3", actual: 11, estimate: 10 },
        { quarter: "Q4", actual: 7, estimate: 10 },
      ]);
      assert.strictEqual(r.beatRate, 0.5);
    });
  });

  describe("Pattern detection", () => {
    it("should detect consistent_beat (>=75%)", async () => {
      const r = await run([
        { quarter: "Q1", actual: 12, estimate: 10 },
        { quarter: "Q2", actual: 11, estimate: 10 },
        { quarter: "Q3", actual: 13, estimate: 10 },
        { quarter: "Q4", actual: 15, estimate: 10 },
      ]);
      assert.strictEqual(r.pattern, "consistent_beat");
    });

    it("should detect consistent_miss (<=25%)", async () => {
      const r = await run([
        { quarter: "Q1", actual: 8, estimate: 10 },
        { quarter: "Q2", actual: 7, estimate: 10 },
        { quarter: "Q3", actual: 6, estimate: 10 },
        { quarter: "Q4", actual: 5, estimate: 10 },
      ]);
      assert.strictEqual(r.pattern, "consistent_miss");
    });

    it("should detect mixed pattern (50% beat rate, no clear trend)", async () => {
      const r = await run([
        { quarter: "Q1", actual: 11, estimate: 10 },
        { quarter: "Q2", actual: 9, estimate: 10 },
        { quarter: "Q3", actual: 11, estimate: 10 },
        { quarter: "Q4", actual: 9, estimate: 10 },
      ]);
      assert.strictEqual(r.pattern, "mixed");
    });
  });

  describe("Trend + flags (real-only fields)", () => {
    it("positive trend when avg surprise > 3%", async () => {
      const r = await run([
        { quarter: "Q1", actual: 12, estimate: 10 },
        { quarter: "Q2", actual: 11, estimate: 10 },
      ]);
      assert.strictEqual(r.trend, "positive");
      assert.ok(r.avgSurprisePercent > 3);
    });

    it("negative trend when avg surprise < -3%", async () => {
      const r = await run([
        { quarter: "Q1", actual: 8, estimate: 10 },
        { quarter: "Q2", actual: 9, estimate: 10 },
      ]);
      assert.strictEqual(r.trend, "negative");
    });

    it("flags a consistent_beat pattern", async () => {
      const r = await run([
        { quarter: "Q1", actual: 12, estimate: 10 },
        { quarter: "Q2", actual: 11, estimate: 10 },
        { quarter: "Q3", actual: 13, estimate: 10 },
        { quarter: "Q4", actual: 15, estimate: 10 },
      ]);
      assert.ok(r.flags.some((f) => f.toLowerCase().includes("beat")));
    });

    it("flags two consecutive recent misses", async () => {
      const r = await run([
        { quarter: "Q1", actual: 8, estimate: 10 }, // newest — miss
        { quarter: "Q2", actual: 9, estimate: 10 }, // miss
        { quarter: "Q3", actual: 12, estimate: 10 },
        { quarter: "Q4", actual: 13, estimate: 10 },
      ]);
      assert.ok(r.flags.some((f) => f.includes("2 consecutive")));
    });
  });

  describe("Edge cases", () => {
    it("should handle single entry", async () => {
      const r = await run([{ quarter: "Q1", actual: 12, estimate: 10 }]);
      assert.strictEqual(r.surprises.length, 1);
      assert.strictEqual(r.beatRate, 1);
    });

    it("should limit to 8 quarters", async () => {
      const history = Array.from({ length: 12 }, (_, i) => ({
        quarter: `Q${i + 1}`,
        actual: 10 + i,
        estimate: 10,
      }));
      const r = await run(history);
      assert.strictEqual(r.surprises.length, 8);
    });

    it("drops all-zero entries; fails when nothing valid remains", async () => {
      const out = await computeEarningsSurpriseTool.execute({
        earningsHistory: [{ quarter: "Q1", actual: 0, estimate: 0 }],
      });
      assert.strictEqual(out.success, false);
      assert.match(out.error ?? "", /No valid earnings data/);
    });

    // MONEY-1274 (MONEY-1155 #30) — CHANGED from `success: false`. An empty
    // history is a thin INPUT, not a failed computation. Note the case ABOVE is
    // deliberately untouched: "No valid earnings data" fires after real entries
    // were examined and rejected, which is a different situation.
    it("reports UNAVAILABLE for an empty history", async () => {
      const out = await computeEarningsSurpriseTool.execute({
        earningsHistory: [],
      });
      assert.strictEqual(out.success, true);
      const d = out.data as Record<string, unknown>;
      assert.strictEqual(d.available, false);
      assert.match(String(d.reason), /at least 1 entry/i);
    });
  });
});
