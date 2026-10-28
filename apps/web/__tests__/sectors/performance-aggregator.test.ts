/**
 * MONEY-393 §7 - Sector performance aggregator.
 *
 * De-shadowed (MONEY-620): imports the REAL aggregateSectorPerformance from
 * lib/actions/sector-performance-logic.ts, which getSectorPerformanceAction
 * (the "use server" action) calls with the Prisma-fetched rows + the real
 * normalize/display functions injected. The pure function was extracted out of
 * the action so it's testable without the heavy @usemoney/core / Prisma imports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateSectorPerformance,
  type SectorInstrument,
  type SectorQuote,
} from "../../lib/actions/sector-performance-logic";

/** Thin adapter: build quoteByInst + inject a no-op display getter. */
function aggregate(
  instruments: SectorInstrument[],
  quotes: SectorQuote[],
  normalize: (s: string) => string = (s) => s
) {
  const quoteByInst = new Map(quotes.map((q) => [q.instrumentId, q]));
  return aggregateSectorPerformance(
    instruments,
    quoteByInst,
    normalize,
    () => null
  );
}

describe("MONEY-393 §7 - Sector performance aggregator", () => {
  it("[aggregator] empty inputs → empty output (no throw)", () => {
    assert.deepEqual(aggregate([], []), []);
  });

  it("[aggregator] sector without quotes is excluded", () => {
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "Banking" },
      ],
      [{ instrumentId: "1", changePercent: 1.5, volume: 1000 }]
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.sector, "IT");
  });

  it("[aggregator] mean is simple arithmetic over all constituents", () => {
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "IT" },
        { id: "3", sector: "IT" },
      ],
      [
        { instrumentId: "1", changePercent: 1.0, volume: 100 },
        { instrumentId: "2", changePercent: 2.0, volume: 100 },
        { instrumentId: "3", changePercent: 3.0, volume: 100 },
      ]
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.meanChangePct, 2.0); // (1+2+3)/3
    assert.equal(out[0]?.weightedChangePct, 2.0); // same volumes → same value
  });

  it("[aggregator] weighted change favors high-volume stocks", () => {
    // 1% change with 10,000 volume + 5% change with 100 volume:
    // weighted = (1*10000 + 5*100) / (10000+100) = 10500/10100 ≈ 1.0396
    // mean = (1+5)/2 = 3.0 (very different from weighted)
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "IT" },
      ],
      [
        { instrumentId: "1", changePercent: 1.0, volume: 10000 },
        { instrumentId: "2", changePercent: 5.0, volume: 100 },
      ]
    );
    assert.equal(out[0]?.meanChangePct, 3.0);
    assert.ok(
      Math.abs(out[0]!.weightedChangePct - 1.0396) < 0.01,
      `weighted ${out[0]?.weightedChangePct} should be ≈1.04 (volume-pinned)`
    );
  });

  it("[aggregator] zero/null volume falls back to weight=1 (still counted)", () => {
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "IT" },
      ],
      [
        { instrumentId: "1", changePercent: 10, volume: 0 },
        { instrumentId: "2", changePercent: -10, volume: null },
      ]
    );
    // Both stocks get equal weighting → weighted ≈ mean ≈ 0
    assert.equal(out[0]?.meanChangePct, 0);
    assert.equal(out[0]?.weightedChangePct, 0);
  });

  it("[aggregator] sort places gainers first, losers last (desc)", () => {
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "Auto" },
        { id: "3", sector: "Pharma" },
      ],
      [
        { instrumentId: "1", changePercent: 2.0, volume: 100 },
        { instrumentId: "2", changePercent: -1.5, volume: 100 },
        { instrumentId: "3", changePercent: 0.5, volume: 100 },
      ]
    );
    assert.deepEqual(
      out.map((r) => r.sector),
      ["IT", "Pharma", "Auto"]
    );
  });

  it("[aggregator] bar widths scale to 100 for the loudest sector", () => {
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "Auto" },
      ],
      [
        { instrumentId: "1", changePercent: 5.0, volume: 100 },
        { instrumentId: "2", changePercent: -2.5, volume: 100 },
      ]
    );
    const it = out.find((r) => r.sector === "IT");
    const auto = out.find((r) => r.sector === "Auto");
    assert.equal(it?.barWidth, 100, "loudest sector pegs to 100");
    assert.equal(auto?.barWidth, 50, "half the magnitude → half the bar");
  });

  it("[aggregator] all-zero day: every bar at 0 (no NaN)", () => {
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "Auto" },
      ],
      [
        { instrumentId: "1", changePercent: 0, volume: 100 },
        { instrumentId: "2", changePercent: 0, volume: 100 },
      ]
    );
    for (const r of out) {
      assert.equal(r.barWidth, 0);
      assert.equal(Number.isFinite(r.barWidth), true);
    }
  });

  it("[aggregator] canonicalization collapses spelling variants into one bucket", () => {
    // Real prod uses `normalizeToNseSector` from @usemoney/core to
    // merge "IT", "Information Technology", "TECH" into the same
    // canonical "Information Technology" bucket. Mock that.
    const norm = (s: string): string => {
      if (/^IT$|technology|tech/i.test(s)) return "Information Technology";
      return s;
    };
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "Tech" },
        { id: "3", sector: "Information Technology" },
      ],
      [
        { instrumentId: "1", changePercent: 1.0, volume: 100 },
        { instrumentId: "2", changePercent: 2.0, volume: 100 },
        { instrumentId: "3", changePercent: 3.0, volume: 100 },
      ],
      norm
    );
    assert.equal(out.length, 1, "all three should collapse to one sector");
    assert.equal(out[0]?.sector, "Information Technology");
    assert.equal(out[0]?.count, 3);
  });

  it("[aggregator] null changePercent skips the stock (doesn't crash)", () => {
    const out = aggregate(
      [
        { id: "1", sector: "IT" },
        { id: "2", sector: "IT" },
      ],
      [
        { instrumentId: "1", changePercent: null, volume: 100 },
        { instrumentId: "2", changePercent: 2.0, volume: 100 },
      ]
    );
    assert.equal(out[0]?.count, 1);
    assert.equal(out[0]?.meanChangePct, 2.0);
  });
});

describe("MONEY-1152 — the N/A tombstone is not a sector", () => {
  it('[regression] excludes "N/A" instead of ranking it', () => {
    // Measured on QA before this fix: normalizeToNseSector passes "N/A"
    // through UNCHANGED, so the /discover sector-performance list rendered a
    // row literally labelled "N/A" as its 3rd-largest sector — 1,296
    // instruments, 15.8% of the aggregate, sitting between Industrials and
    // Financial Services. The old guard was `!inst.sector`, which only catches
    // null/empty.
    const instruments: SectorInstrument[] = [
      { id: "a", sector: "N/A" },
      { id: "b", sector: "N/A" },
      { id: "c", sector: "Healthcare" },
    ];
    const quotes = new Map<string, SectorQuote>([
      ["a", { instrumentId: "a", changePercent: 9, volume: 100 }],
      ["b", { instrumentId: "b", changePercent: 8, volume: 100 }],
      ["c", { instrumentId: "c", changePercent: 1, volume: 100 }],
    ]);

    const rows = aggregateSectorPerformance(
      instruments,
      quotes,
      (s) => s, // identity normalize — mirrors normalizeToNseSector's passthrough
      () => null
    );

    assert.deepEqual(
      rows.map((r) => r.sector),
      ["Healthcare"],
      'an "N/A" bucket must not appear, even though it would have topped the ' +
        "list on change% here"
    );
  });

  it("[regression] still excludes null and empty sectors", () => {
    const rows = aggregateSectorPerformance(
      [
        { id: "a", sector: null },
        { id: "b", sector: "" },
        { id: "c", sector: "FMCG" },
      ],
      new Map<string, SectorQuote>([
        ["a", { instrumentId: "a", changePercent: 5, volume: 1 }],
        ["b", { instrumentId: "b", changePercent: 5, volume: 1 }],
        ["c", { instrumentId: "c", changePercent: 2, volume: 1 }],
      ]),
      (s) => s,
      () => null
    );
    assert.deepEqual(
      rows.map((r) => r.sector),
      ["FMCG"]
    );
  });
});
