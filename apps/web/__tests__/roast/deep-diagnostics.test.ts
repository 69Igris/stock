/**
 * Roast - Deep Diagnostics derivation tests
 *
 * De-shadowed: imports the REAL top5SectorConcentration / sectorHHI /
 * cashAllocation from components/roast/roast-detail-logic.ts — the same
 * functions the DeepDiagnostics tiles in RoastResults.tsx render. They derive
 * from result.sectorAnalysis (no backend ingestion required).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  top5SectorConcentration,
  sectorHHI,
  cashAllocation,
  type RoastSectorAnalysis,
} from "../../components/roast/roast-detail-logic";

const SAMPLE_SECTORS: RoastSectorAnalysis[] = [
  { sector: "Banking", percentage: 32, verdict: "overweight", comment: "" },
  { sector: "IT", percentage: 24, verdict: "overweight", comment: "" },
  { sector: "Energy", percentage: 14, verdict: "fair", comment: "" },
  { sector: "FMCG", percentage: 11, verdict: "fair", comment: "" },
  { sector: "Fintech", percentage: 8, verdict: "overweight", comment: "" },
  { sector: "Auto", percentage: 6, verdict: "underweight", comment: "" },
  { sector: "Pharma", percentage: 3, verdict: "underweight", comment: "" },
  { sector: "Cash", percentage: 2, verdict: "underweight", comment: "" },
];

describe("Deep Diagnostics derivations", () => {
  describe("top5SectorConcentration", () => {
    it("sums top 5 sectors by percentage", () => {
      // 32 + 24 + 14 + 11 + 8 = 89
      assert.equal(top5SectorConcentration(SAMPLE_SECTORS), 89);
    });

    it("handles fewer than 5 sectors", () => {
      const small = SAMPLE_SECTORS.slice(0, 3);
      assert.equal(top5SectorConcentration(small), 32 + 24 + 14);
    });

    it("handles empty input", () => {
      assert.equal(top5SectorConcentration([]), 0);
    });

    it("sorts by percentage even when input is unsorted", () => {
      const unsorted = [
        { sector: "A", percentage: 10, verdict: "fair" as const, comment: "" },
        { sector: "B", percentage: 50, verdict: "fair" as const, comment: "" },
        { sector: "C", percentage: 20, verdict: "fair" as const, comment: "" },
      ];
      // Top 5 = top 3 (only 3 entries) = 50+20+10 = 80
      assert.equal(top5SectorConcentration(unsorted), 80);
    });
  });

  describe("sectorHHI (Herfindahl-Hirschman Index)", () => {
    it("returns sum of squared shares", () => {
      // Each percentage divided by 100 squared, summed
      const hhi = sectorHHI([
        { sector: "A", percentage: 50, verdict: "fair", comment: "" },
        { sector: "B", percentage: 50, verdict: "fair", comment: "" },
      ]);
      // 0.5^2 + 0.5^2 = 0.5
      assert.equal(hhi, 0.5);
    });

    it("perfectly concentrated portfolio → 1.0", () => {
      const hhi = sectorHHI([
        { sector: "X", percentage: 100, verdict: "fair", comment: "" },
      ]);
      assert.equal(hhi, 1);
    });

    it("perfectly diversified → 1/N", () => {
      const four = [25, 25, 25, 25].map((p, i) => ({
        sector: `S${i}`,
        percentage: p,
        verdict: "fair" as const,
        comment: "",
      }));
      // 4 * 0.25^2 = 0.25
      assert.equal(sectorHHI(four), 0.25);
    });

    it("sample portfolio falls in moderate-concentration band", () => {
      const hhi = sectorHHI(SAMPLE_SECTORS);
      // Banking (.32^2 = .1024) + IT (.24^2 = .0576) + ... ≈ 0.21
      assert.ok(hhi > 0.18 && hhi < 0.25, `HHI was ${hhi}, expected 0.18-0.25`);
    });
  });

  describe("cashAllocation", () => {
    it("finds Cash sector regardless of case", () => {
      assert.equal(cashAllocation(SAMPLE_SECTORS), 2);
      const lower = SAMPLE_SECTORS.map((s) =>
        s.sector === "Cash" ? { ...s, sector: "cash" } : s
      );
      assert.equal(cashAllocation(lower), 2);
    });

    it("returns null when no Cash sector", () => {
      const noCash = SAMPLE_SECTORS.filter(
        (s) => s.sector.toLowerCase() !== "cash"
      );
      assert.equal(cashAllocation(noCash), null);
    });
  });
});
