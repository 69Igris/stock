/**
 * MONEY-1157 — screener sector facets.
 *
 * TWO defects, one payload.
 *
 * 1. FACETS THAT VANISH. `getUniverseData` counted `sectorCounts` on the RAW
 *    `InstrumentMapping.sector` but emitted only `getAllSectorNames()` plus a
 *    "Not Categorised" bucket fed EXCLUSIVELY by `sector === "N/A" || !sector`.
 *    Every other stored value was counted into a key nothing ever read back.
 *    Measured on prod: `Other` 228, `Construction` 40, `Media & Entertainment`
 *    9, `Textiles` 8 — ~285 stocks in NO chip and NOT in "Not Categorised".
 *    The load-bearing assertion is therefore a CONSERVATION one: the facet
 *    counts must sum to the number of rows in. Any per-sector assertion alone
 *    would have stayed green through the original bug.
 *
 * 2. AN UNDIAGNOSABLE CATCH PATH. `getUniverseData`'s catch returns a
 *    NON-EMPTY, all-zero facet array — byte-identical to a genuinely thin
 *    market. `/discover/screener` guarded on `sectors.length > 0` (14 > 0 →
 *    accepted), `SectorChips` filtered `count > 0` (all 14 gone), and a caught
 *    DB error was indistinguishable from "no stocks anywhere". `degraded` is
 *    the sentinel that survives to the caller; it also stops the failure
 *    fallback being CACHED for the entry's 24h TTL.
 *
 * `@usemoney/services` runs its suite as ESM (no `require.cache` mocking), so
 * the service half drives the REAL exported `getDiscoverSummary` through its
 * injectable ports. Pure + mocked; no DB, no timers.
 *
 * Source: packages/services/src/discover-logic.ts,
 *         packages/services/src/discover.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSectorFacets, UNCATEGORISED_FACET } from "../src/discover-logic";
import {
  degradedUniverseFallback,
  getDiscoverSummary,
  type DiscoverStock,
  type DiscoverSummaryPorts,
} from "../src/discover.service";
import {
  screenStocks,
  type ScreenerCache,
  type ScreenerServiceDeps,
} from "../src/screener.service";
import { getAllSectorNames } from "@usemoney/core/sector-taxonomy";

// ── Fixtures ────────────────────────────────────────────────────────────

/** Only `sector` matters to the facet builder. */
function row(sector: string | null): { sector: string | null } {
  return { sector };
}

function rows(
  sector: string | null,
  n: number,
): Array<{ sector: string | null }> {
  return Array.from({ length: n }, () => row(sector));
}

function countOf(
  facets: ReadonlyArray<{ name: string; count: number }>,
  name: string,
): number {
  const hit = facets.find((f) => f.name === name);
  assert.ok(hit, `facet "${name}" must be emitted`);
  return hit!.count;
}

function total(facets: ReadonlyArray<{ name: string; count: number }>): number {
  return facets.reduce((sum, f) => sum + f.count, 0);
}

// ── buildSectorFacets (defect 1) ────────────────────────────────────────

describe("MONEY-1157 — buildSectorFacets", () => {
  it("[regression] the counts CONSERVE the input — nothing may vanish", () => {
    // The exact prod distribution that went missing, alongside real ones.
    const input = [
      ...rows("Other", 228),
      ...rows("Construction", 40),
      ...rows("Media & Entertainment", 9),
      ...rows("Textiles", 8),
      ...rows("Information Technology", 5),
      ...rows("N/A", 3),
      ...rows(null, 2),
    ];

    const facets = buildSectorFacets(input);

    assert.equal(
      total(facets),
      input.length,
      "every row must land in exactly one facet — 285 of these used to land in none",
    );
  });

  it("folds a non-canonical value onto the canonical sector it maps to", () => {
    // Construction → Industrials, Textiles → Consumer Discretionary. These are
    // YAHOO_TO_NSE_MAP entries that already existed; the facet builder simply
    // never consulted them.
    const facets = buildSectorFacets([
      ...rows("Construction", 40),
      ...rows("Industrials", 2),
      ...rows("Textiles", 8),
    ]);

    assert.equal(countOf(facets, "Industrials"), 42);
    assert.equal(countOf(facets, "Consumer Discretionary"), 8);
  });

  it("folds the MONEY-1093 Realty alias onto Real Estate", () => {
    const facets = buildSectorFacets([
      ...rows("Realty", 3),
      ...rows("Real Estate", 4),
    ]);

    assert.equal(countOf(facets, "Real Estate"), 7);
  });

  it("sends a value that stays non-canonical to Not Categorised, not nowhere", () => {
    // MONEY-1302 narrowed this case. "Agriculture" and "Media & Entertainment"
    // are aliases now (FMCG and Telecommunication) — both were measured on prod
    // to be real companies, so the catch-all was the wrong home for them.
    // "Other" keeps the role this test exists for, and is the better example:
    // 26 of its 29 prod rows are bonds, so it must stay unmapped, and it must
    // still land SOMEWHERE rather than silently disappearing.
    const facets = buildSectorFacets([
      ...rows("Other", 228),
      ...rows("Totally Unmapped Label", 5),
    ]);

    assert.equal(countOf(facets, UNCATEGORISED_FACET), 233);
  });

  it("[MONEY-1302] the two new aliases fold, and LEAVE the catch-all", () => {
    // The replacement pin, asserted in both directions so the move cannot be
    // half-reverted: a value that folds must be counted under its canonical
    // chip AND must not also be counted under Not Categorised.
    const facets = buildSectorFacets([
      ...rows("Agriculture", 5),
      ...rows("Media & Entertainment", 9),
    ]);

    assert.equal(countOf(facets, "FMCG"), 5);
    assert.equal(countOf(facets, "Telecommunication"), 9);
    assert.equal(countOf(facets, UNCATEGORISED_FACET), 0);
  });

  it("still folds the bare Media token onto Telecommunication", () => {
    const facets = buildSectorFacets(rows("Media", 4));

    assert.equal(countOf(facets, "Telecommunication"), 4);
    assert.equal(countOf(facets, UNCATEGORISED_FACET), 0);
  });

  it("treats the N/A sentinel, null and empty string as uncategorised", () => {
    const facets = buildSectorFacets([
      ...rows("N/A", 3),
      ...rows(null, 2),
      ...rows("", 1),
    ]);

    assert.equal(countOf(facets, UNCATEGORISED_FACET), 6);
    assert.equal(UNCATEGORISED_FACET, "Not Categorised");
  });

  it("emits ONLY canonical names plus the uncategorised bucket", () => {
    // A facet is a FILTER option: emitting "Construction" here would offer a
    // chip the screener's sector filter has its own opinion about. The chip set
    // stays the canonical taxonomy.
    const facets = buildSectorFacets([
      ...rows("Other", 2),
      ...rows("Construction", 2),
      ...rows("Energy", 2),
    ]);

    const allowed = new Set([...getAllSectorNames(), UNCATEGORISED_FACET]);
    for (const f of facets) {
      assert.ok(allowed.has(f.name), `unexpected facet "${f.name}"`);
    }
    assert.equal(facets.length, getAllSectorNames().length + 1);
  });

  it("counts every canonical sector under its own name", () => {
    const input = getAllSectorNames().flatMap((name, i) => rows(name, i + 1));

    const facets = buildSectorFacets(input);

    getAllSectorNames().forEach((name, i) => {
      assert.equal(countOf(facets, name), i + 1);
    });
    assert.equal(countOf(facets, UNCATEGORISED_FACET), 0);
  });

  it("returns a NON-EMPTY all-zero array for no rows — the shape the guard must not trust", () => {
    // This is precisely why `/discover/screener` cannot use `length > 0`.
    const facets = buildSectorFacets([]);

    assert.equal(facets.length, getAllSectorNames().length + 1);
    assert.equal(total(facets), 0);
  });

  it("does not mutate or depend on input order", () => {
    const a = buildSectorFacets([...rows("Energy", 2), ...rows("Other", 1)]);
    const b = buildSectorFacets([...rows("Other", 1), ...rows("Energy", 2)]);

    assert.deepEqual(a, b);
  });
});

// ── the counts vs the FILTER (defect 3) ─────────────────────────────────
//
// `buildSectorFacets` folding was only half the fix. `sectorMatches` — the
// screener's sector filter, and its lockstep twin in apps/web — still compared
// the RAW stored string, so a chip could report a number it then refused to
// return. Measured on prod: Industrials +40 (`Construction`), Consumer
// Discretionary +8 (`Textiles`), Not Categorised +242 (`Other` 228,
// `Media & Entertainment` 9, `Agriculture`).
//
// `instrumentsFirstPath` screens the very array the counts came from
// (`getDiscoverData().data.allStocks`), so this is checkable end-to-end and the
// discrepancy is exact. The assertion is CONSERVATION: for every chip,
// count === rows returned. Per-chip spot checks passed throughout the bug.

const PROD_SECTOR_DISTRIBUTION: ReadonlyArray<
  readonly [string | null, number]
> = [
  // The four values the facets counted and the filter could not reach…
  ["Other", 228],
  ["Construction", 40],
  ["Media & Entertainment", 9],
  ["Textiles", 8],
  // …alongside the states the chip was originally written for, and canonical
  // rows so the folded ones have to land ON TOP of a real count rather than
  // inventing one.
  ["Industrials", 2],
  ["Consumer Discretionary", 3],
  ["Information Technology", 5],
  ["Realty", 1],
  ["Real Estate", 2],
  ["N/A", 3],
  [null, 2],
];

function universeStock(symbol: string, sector: string | null): DiscoverStock {
  return {
    symbol,
    name: `${symbol} Ltd`,
    exchange: "NSE",
    sector,
    instrumentType: "EQUITY",
    instrumentId: `id-${symbol}`,
    yahooSymbol: `${symbol}.NS`,
    price: 100,
    change: 1,
    changePercent: 1,
    volume: 1_000,
    marketCap: 5_000,
  };
}

/** One row per prod-measured stock, with unique ids so nothing collapses. */
const PROD_UNIVERSE: DiscoverStock[] = PROD_SECTOR_DISTRIBUTION.flatMap(
  ([sector, n], group) =>
    Array.from({ length: n }, (_unused, i) =>
      universeStock(`S${group}_${i}`, sector),
    ),
);

/** A cache seam that always misses and never stores — every call must recompute
 *  from the universe, so a stale entry can never manufacture agreement. */
function missingCache(): ScreenerCache {
  return {
    get: async () => null,
    set: async () => {},
  };
}

/** The screener's instruments-first path needs a `stockRatios.findMany`
 *  (returns none — rows render with null fundamentals) and nothing else: with
 *  no `index` filter, `resolveIndexSymbols` short-circuits before any query. */
function ratiolessPrisma(): NonNullable<ScreenerServiceDeps["prisma"]> {
  return {
    stockRatios: { findMany: async () => [] },
  } as unknown as NonNullable<ScreenerServiceDeps["prisma"]>;
}

function universeDeps(
  universe: DiscoverStock[],
): Required<Pick<ScreenerServiceDeps, "prisma" | "cache" | "getDiscoverData">> {
  return {
    prisma: ratiolessPrisma(),
    cache: missingCache(),
    getDiscoverData: (async () => ({
      success: true as const,
      data: {
        topGainers: [],
        topLosers: [],
        allStocks: universe,
        sectors: buildSectorFacets(universe),
      },
    })) as unknown as NonNullable<ScreenerServiceDeps["getDiscoverData"]>,
  };
}

/** How many rows the REAL screener returns for a chip. `pageSize` is capped at
 *  MAX_PAGE_SIZE, so `total` (the matched-set size, and what the UI prints as
 *  "Showing 1-25 of N") is the number under test — not `rows.length`. */
async function screenedTotal(
  universe: DiscoverStock[],
  chip: string,
): Promise<number> {
  const res = await screenStocks(
    { sector: chip },
    undefined,
    { page: 0, pageSize: 200 },
    universeDeps(universe),
  );
  assert.equal(res.success, true, `screening "${chip}" failed`);
  return res.success ? res.data.total : -1;
}

describe("MONEY-1157 — a chip's count is the number of rows the chip returns", () => {
  it("[regression] CONSERVATION: every facet count equals its screened total", async () => {
    const facets = buildSectorFacets(PROD_UNIVERSE);

    for (const facet of facets) {
      const screened = await screenedTotal(PROD_UNIVERSE, facet.name);
      assert.equal(
        screened,
        facet.count,
        `chip "${facet.name}" reports ${facet.count} and returns ${screened}`,
      );
    }
  });

  it("[regression] the specific over-reports measured on prod are gone", async () => {
    // Named individually so a failure says WHICH fold broke rather than only
    // that some total moved.
    assert.equal(
      await screenedTotal(PROD_UNIVERSE, "Industrials"),
      42,
      "Construction (40) + Industrials (2) — used to return 2",
    );
    assert.equal(
      await screenedTotal(PROD_UNIVERSE, "Consumer Discretionary"),
      11,
      "Textiles (8) + Consumer Discretionary (3) — used to return 3",
    );
    // MONEY-1302: Media & Entertainment (9) LEFT this chip for
    // Telecommunication — all 9 prod rows are real media companies. 242 -> 233.
    assert.equal(
      await screenedTotal(PROD_UNIVERSE, UNCATEGORISED_FACET),
      233,
      "Other (228) + N/A (3) + null (2) — used to return 5",
    );
    assert.equal(
      await screenedTotal(PROD_UNIVERSE, "Telecommunication"),
      9,
      "Media & Entertainment (9) — the rows that left the catch-all must " +
        "ARRIVE somewhere, or the move lost them",
    );
    assert.equal(
      await screenedTotal(PROD_UNIVERSE, "Real Estate"),
      3,
      "Realty (1) + Real Estate (2)",
    );
  });

  it("[regression] the chips together return the WHOLE universe, once each", async () => {
    // The sum is what the facet suite already pins for the counts; doing it
    // through the screener proves the other half — that no row is stranded
    // between chips, and none is returned by two.
    const facets = buildSectorFacets(PROD_UNIVERSE);
    let sum = 0;
    for (const facet of facets) {
      sum += await screenedTotal(PROD_UNIVERSE, facet.name);
    }

    assert.equal(sum, PROD_UNIVERSE.length);
  });

  it("an unfiltered screen still returns the whole universe", async () => {
    const res = await screenStocks(
      {},
      undefined,
      { page: 0, pageSize: 200 },
      universeDeps(PROD_UNIVERSE),
    );

    assert.equal(res.success, true);
    assert.equal(res.success && res.data.total, PROD_UNIVERSE.length);
  });

  it("[regression] a raw non-canonical filter value still reaches its own rows", async () => {
    // `SectorDeepDive` links `?stocks.sector=<raw heatmap bucket>`, and the
    // heatmap deliberately keeps non-canonical buckets visible. Folding must not
    // strand those links on an empty screen.
    assert.equal(await screenedTotal(PROD_UNIVERSE, "Other"), 228);
    assert.equal(
      await screenedTotal(PROD_UNIVERSE, "Construction"),
      40,
      "the literal rows, not the whole Industrials chip",
    );
  });
});

// ── the `degraded` sentinel (defect 2, service half) ────────────────────

function stock(symbol: string, sector: string | null): DiscoverStock {
  return {
    symbol,
    name: `${symbol} Ltd`,
    exchange: "NSE",
    sector,
    instrumentType: "EQUITY",
    instrumentId: `id-${symbol}`,
    yahooSymbol: `${symbol}.NS`,
    price: 100,
    change: 1,
    changePercent: 1,
    volume: 1_000,
    marketCap: 5_000,
  };
}

const HEALTHY_UNIVERSE = {
  allStocks: [stock("ONGC", "Energy")],
  sectors: buildSectorFacets([row("Energy")]),
};

/** The REAL catch-path payload — `getUniverseData` returns exactly this, so
 *  the fixture cannot drift from production (no shadow). */
const DEGRADED_UNIVERSE = degradedUniverseFallback();

function harness(overrides: Partial<DiscoverSummaryPorts> = {}) {
  const calls = { read: 0, write: 0, universe: 0, movers: 0 };
  const written: unknown[] = [];
  const ports: DiscoverSummaryPorts = {
    readSummary: async () => {
      calls.read += 1;
      return null;
    },
    writeSummary: async (v) => {
      calls.write += 1;
      written.push(v);
    },
    getUniverse: async () => {
      calls.universe += 1;
      return HEALTHY_UNIVERSE;
    },
    getMovers: async () => {
      calls.movers += 1;
      return { topGainers: [stock("ONGC", "Energy")], topLosers: [] };
    },
    ...overrides,
  };
  return { calls, written, ports };
}

describe("MONEY-1157 — degraded universe is distinguishable and never cached", () => {
  it("[regression] the catch-path payload itself carries the sentinel", async () => {
    // Binds to the factory the catch path RETURNS, so dropping the flag there
    // fails here rather than only in a fixture that agrees with itself.
    assert.equal(DEGRADED_UNIVERSE.degraded, true);
    assert.deepEqual(DEGRADED_UNIVERSE.allStocks, []);
    assert.ok(DEGRADED_UNIVERSE.sectors.length > 0);
  });

  it("[regression] a caught universe failure surfaces as `degraded`, not as thin data", async () => {
    const { ports } = harness({ getUniverse: async () => DEGRADED_UNIVERSE });

    const result = await getDiscoverSummary(ports);

    assert.equal(result.success, true);
    assert.equal(result.data?.degraded, true);
    // The payload alone is indistinguishable — that is the whole point.
    assert.equal(result.data?.stockCount, 0);
    assert.ok(result.data!.sectors.length > 0);
    assert.equal(
      result.data!.sectors.every((s) => s.count === 0),
      true,
    );
  });

  it("[regression] the degraded fallback is NEVER written to the 24h summary cache", async () => {
    const { calls, ports } = harness({
      getUniverse: async () => DEGRADED_UNIVERSE,
    });

    await getDiscoverSummary(ports);

    assert.equal(
      calls.write,
      0,
      "caching a failure would turn a DB blip into a day of an empty screener",
    );
  });

  it("a healthy universe IS cached and carries no sentinel", async () => {
    const { calls, written, ports } = harness();

    const result = await getDiscoverSummary(ports);

    assert.equal(calls.write, 1);
    assert.equal(result.data?.degraded, undefined);
    assert.equal(
      (written[0] as { degraded?: true }).degraded,
      undefined,
      "a healthy summary must not carry the flag into Redis",
    );
  });

  it("the sentinel survives the movers-present branch", async () => {
    const { ports } = harness({ getUniverse: async () => DEGRADED_UNIVERSE });

    const result = await getDiscoverSummary(ports);

    // This branch spreads the summary, so the flag rides along.
    assert.equal(result.data?.topGainers.length, 1);
    assert.equal(result.data?.degraded, true);
  });

  it("the sentinel survives the movers-ABSENT branch, which rebuilds the literal", async () => {
    const { ports } = harness({
      getUniverse: async () => DEGRADED_UNIVERSE,
      getMovers: async () => null,
    });

    const result = await getDiscoverSummary(ports);

    // That branch constructs a fresh object rather than spreading, which is
    // exactly how a flag added to one path silently skips another.
    assert.equal(result.data?.degraded, true);
    assert.deepEqual(result.data?.topGainers, []);
  });
});
