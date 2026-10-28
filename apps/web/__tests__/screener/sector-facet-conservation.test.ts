/**
 * MONEY-1157 — the web twin of the sector filter actually folds.
 *
 * `sectorMatches` / `sectorInstrumentFilter` existed twice: once in
 * `packages/services/src/screener.service.ts` and once here in
 * `apps/web/lib/actions/screener.ts`, each with a comment telling the reader to
 * keep the other in lockstep. They were in lockstep with EACH OTHER; what they
 * drifted from was `buildSectorFacets`, which had learned to fold non-canonical
 * stored values onto canonical NSE sectors. The chips then reported rows they
 * refused to return — on prod, Industrials +40 (`Construction`), Consumer
 * Discretionary +8 (`Textiles`), Not Categorised +242 (`Other` 228,
 * `Media & Entertainment` 9).
 *
 * Both are now aliases of one definition in `@usemoney/core/sector-taxonomy`.
 * A shared definition is only worth as much as its WIRING, so this drives the
 * REAL `screenStocksAction` through the `require.cache` seam (same technique as
 * `screener-action-cache.test.ts`) rather than asserting the helper again — the
 * services-side conservation proof lives in
 * `packages/services/__tests__/discover-sector-facets.test.ts`.
 *
 * The ratios-first path is used deliberately: it is the one that applies BOTH
 * halves — the Mongo pushdown AND the retained JS pass. (The instruments-first
 * path resolves `@usemoney/services` through a dynamic `import()`, which does
 * NOT read the require cache, so driving it here would load the real package
 * and dial a database.)
 *
 * Pure + mocked: fake Prisma, in-memory cache, no timers, no network.
 *
 * Source: apps/web/lib/actions/screener.ts,
 *         packages/core/src/market-data/instruments/sector-taxonomy.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  UNCATEGORISED_SECTOR_FACET,
  getAllSectorNames,
  resolveCanonicalSector,
} from "@usemoney/core/sector-taxonomy";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SCREENER_REL = "../../lib/actions/screener";
const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

// ── Fixture universe ────────────────────────────────────────────────────
//
// The prod distribution that went missing, plus canonical rows so a fold has to
// land ON TOP of a real count, plus the three "no sector" states the chip was
// originally written for. `undefined` models a document whose `sector` key was
// NEVER CREATED — a different state from an explicit null as far as Prisma is
// concerned, and the entire pre-enrichment population.

const DISTRIBUTION: ReadonlyArray<
  readonly [string | null | undefined, number]
> = [
  ["Other", 12],
  ["Construction", 7],
  ["Media & Entertainment", 4],
  ["Textiles", 3],
  ["Industrials", 2],
  ["Consumer Discretionary", 2],
  ["Energy", 5],
  ["Realty", 1],
  ["N/A", 2],
  [null, 2],
  [undefined, 2],
];

interface RatioFixture {
  symbol: string;
  exchange: string;
  pe: number;
  roe: number;
  revenueGrowth: number;
  debtToEquity: number;
  marketCap: number;
  dividendYield: number;
  instrument: {
    name: string;
    sector?: string | null;
    latestQuote: { price: number; changePercent: number };
  };
}

const FIXTURE: RatioFixture[] = DISTRIBUTION.flatMap(
  ([sector, n], group): RatioFixture[] =>
    Array.from({ length: n }, (_unused, i): RatioFixture => {
      const symbol = `S${group}_${i}`;
      return {
        symbol,
        exchange: "NSE",
        pe: 12,
        roe: 18,
        revenueGrowth: 9,
        debtToEquity: 0.4,
        marketCap: 1_000_000 - group * 1_000 - i,
        dividendYield: 1.5,
        instrument: {
          name: `${symbol} Ltd`,
          // Omit the key entirely when `undefined` — assigning
          // `sector: undefined` would still create the property, which is the
          // very state under test.
          ...(sector === undefined ? {} : { sector }),
          latestQuote: { price: 100, changePercent: 1.1 },
        },
      };
    })
);

const EXPECTED_BY_CHIP = new Map<string, number>(
  [...getAllSectorNames(), UNCATEGORISED_SECTOR_FACET].map((chip) => [chip, 0])
);
for (const [sector, n] of DISTRIBUTION) {
  const chip = resolveCanonicalSector(sector) ?? UNCATEGORISED_SECTOR_FACET;
  EXPECTED_BY_CHIP.set(chip, (EXPECTED_BY_CHIP.get(chip) ?? 0) + n);
}

// ── Test doubles ────────────────────────────────────────────────────────

interface Harness {
  /** false ⇒ the DB ignores `where.instrument`, i.e. no pushdown at all. */
  honourSectorClause: boolean;
  lastInstrumentClause: Record<string, unknown> | undefined;
}

const h: Harness = {
  honourSectorClause: true,
  lastInstrumentClause: undefined,
};

/** Every `sector` condition the action can emit. */
type SectorCondition =
  | string
  | null
  | {
      isSet?: boolean;
      equals?: string;
      mode?: string;
      notIn?: readonly string[];
    };

/**
 * PRISMA-on-Mongo semantics for one condition — a double for the DATABASE, not
 * a copy of the where-builder. `{ sector: null }` is an explicit-null equality
 * that does NOT match a missing key (raw Mongo's `{f: null}` would); only
 * `{ isSet: false }` does. Collapsing the two would report a pass for a query
 * that returns nothing in production.
 */
function evalCondition(
  want: SectorCondition,
  sector: string | null | undefined,
  keyPresent: boolean
): boolean {
  if (want === null) return keyPresent && sector === null;
  if (typeof want === "string") return keyPresent && sector === want;
  if (want.isSet !== undefined) {
    return want.isSet === false ? !keyPresent : keyPresent;
  }
  if (want.notIn) {
    if (!keyPresent || sector == null) return true;
    return !want.notIn.includes(sector);
  }
  if (want.equals !== undefined) {
    if (!keyPresent || sector == null) return false;
    return want.mode === "insensitive"
      ? sector.toLowerCase() === want.equals.toLowerCase()
      : sector === want.equals;
  }
  return false;
}

function matchesInstrumentClause(
  clause: Record<string, unknown> | undefined,
  row: RatioFixture
): boolean {
  if (!clause) return true;
  const inner = (clause as { is?: Record<string, unknown> }).is;
  if (!inner) return true;
  const sector = row.instrument.sector ?? null;
  const keyPresent = "sector" in row.instrument;
  const branches = inner.OR as Array<{ sector: SectorCondition }> | undefined;
  if (branches) {
    return branches.some((b) => evalCondition(b.sector, sector, keyPresent));
  }
  if (inner.sector === undefined) return true;
  return evalCondition(inner.sector as SectorCondition, sector, keyPresent);
}

function fakePrisma(): Record<string, unknown> {
  return {
    stockRatios: {
      findMany: async (args: Record<string, unknown>) => {
        const where = (args.where ?? {}) as Record<string, unknown>;
        const clause = where.instrument as Record<string, unknown> | undefined;
        h.lastInstrumentClause = clause;
        return FIXTURE.filter(
          (r) => !h.honourSectorClause || matchesInstrumentClause(clause, r)
        );
      },
    },
    instrumentMapping: {
      findMany: async () => [],
      count: async () => 0,
    },
    latestQuote: { findMany: async () => [] },
    mutualFundMaster: { findMany: async () => [], count: async () => 0 },
    indexConstituent: { findMany: async () => [] },
  };
}

/** A cache that always misses, so every call recomputes from the fixture and a
 *  stale entry can never manufacture agreement. */
function stubBoundaries(): void {
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  const corePath = require.resolve("@usemoney/core");
  for (const p of [dbPath, corePath]) snapshotOnce(p);

  cache[dbPath] = { exports: { __esModule: true, prisma: fakePrisma() } };
  cache[corePath] = {
    exports: {
      __esModule: true,
      getCached: async (): Promise<unknown> => null,
      setCached: async (): Promise<void> => {},
    },
  };
}

interface ScreenerMod {
  screenStocksAction: (
    filters?: Record<string, unknown>,
    query?: string,
    paging?: { page?: number; pageSize?: number; sort?: string }
  ) => Promise<{
    success: boolean;
    data?: {
      rows: Array<{ symbol: string; sector: string | null }>;
      total: number;
    };
    error?: string;
  }>;
}

function loadScreener(): ScreenerMod {
  const cache = moduleCache();
  stubBoundaries();
  delete cache[require.resolve(SCREENER_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(SCREENER_REL) as ScreenerMod;
}

/** Every screen carries a fundamental band so the RATIOS path is taken — the
 *  one that applies both the pushdown and the JS pass. */
async function screen(sector: string): Promise<{
  total: number;
  sectors: Array<string | null>;
  symbols: string[];
}> {
  const res = await loadScreener().screenStocksAction(
    { minPe: 1, maxPe: 99, sector },
    undefined,
    { page: 0, pageSize: 200 }
  );
  assert.equal(res.success, true, `screening "${sector}" failed: ${res.error}`);
  return {
    total: res.data!.total,
    sectors: res.data!.rows.map((r) => r.sector),
    symbols: res.data!.rows.map((r) => r.symbol),
  };
}

/** The symbols minted for one entry of `DISTRIBUTION`, by its stored value. */
function symbolsStoredAs(sector: string | null | undefined): string[] {
  const group = DISTRIBUTION.findIndex(([value]) => value === sector);
  assert.notEqual(group, -1, `no fixture group stored as ${String(sector)}`);
  return Array.from(
    { length: DISTRIBUTION[group]![1] },
    (_unused, i) => `S${group}_${i}`
  );
}

beforeEach(() => {
  h.honourSectorClause = true;
  h.lastInstrumentClause = undefined;
});

after(() => {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(SCREENER_REL)];
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("MONEY-1157 — the web screener action folds sectors like the facets do", () => {
  it("[regression] CONSERVATION: each chip returns exactly the rows counted under it", async () => {
    // The load-bearing assertion. Per-chip spot checks stayed green through the
    // whole bug; what failed was the invariant that the chips partition the
    // universe. `Construction` was counted under Industrials and returned by
    // nothing, so this sum was short by ~285 on prod.
    let sum = 0;
    for (const [chip, expected] of EXPECTED_BY_CHIP) {
      const { total } = await screen(chip);
      assert.equal(
        total,
        expected,
        `chip "${chip}" is counted ${expected} and returns ${total}`
      );
      sum += total;
    }

    assert.equal(
      sum,
      FIXTURE.length,
      "every row must be returned by exactly one chip — no strays, no doubles"
    );
  });

  it("[regression] Industrials reaches the Construction rows", async () => {
    const { total, sectors } = await screen("Industrials");

    assert.equal(total, 9, "Construction (7) + Industrials (2)");
    assert.equal(sectors.filter((s) => s === "Construction").length, 7);
  });

  it("[regression] Consumer Discretionary reaches the Textiles rows", async () => {
    const { total, sectors } = await screen("Consumer Discretionary");

    assert.equal(total, 5, "Textiles (3) + Consumer Discretionary (2)");
    assert.equal(sectors.filter((s) => s === "Textiles").length, 3);
  });

  it("[regression] Not Categorised reaches Other", async () => {
    const { total, sectors } = await screen(UNCATEGORISED_SECTOR_FACET);

    // MONEY-1302 MOVED `Media & Entertainment` OUT of this chip, deliberately:
    // its 9 prod rows are all real media companies, so the catch-all was wrong
    // for every one of them. The chip's total drops by exactly those 4 fixture
    // rows; `Other` stays, and is now the sole fixture value that folds
    // nowhere — the right answer for it, because 26 of its 29 prod rows are
    // bonds.
    assert.equal(total, 18, "Other (12) + N/A (2) + null (2) + absent (2)");
    assert.equal(sectors.filter((s) => s === "Other").length, 12);
    assert.equal(
      sectors.filter((s) => s === "Media & Entertainment").length,
      0,
      "Media & Entertainment now folds onto Telecommunication and must have " +
        "LEFT the catch-all — a row counted under two chips is double-counted"
    );
  });

  it("[regression] Telecommunication reaches the Media & Entertainment rows", async () => {
    // The other half of the move, pinned as firmly as the old placement was.
    // Asserted TOGETHER with the catch-all case above so nobody can move one
    // spelling without seeing the other — the same reasoning the original
    // "pinned so a future fix cannot quietly move it" comment gave.
    const { total, sectors } = await screen("Telecommunication");

    assert.equal(
      total,
      4,
      "Media & Entertainment (4), no canonical rows in the fixture"
    );
    assert.equal(
      sectors.filter((s) => s === "Media & Entertainment").length,
      4
    );
  });

  it("[regression] an ABSENT sector key still reaches Not Categorised", async () => {
    // Prisma's `{sector: null}` misses documents where the key was never
    // created, and every instrument the nightly sync mints looks like that until
    // enrichment reaches it. The widened `notIn` branch must not have displaced
    // `{ sector: { isSet: false } }` — and the JS pass downstream cannot bring
    // back rows the database never returned, so this failure mode is silent.
    const { symbols } = await screen(UNCATEGORISED_SECTOR_FACET);
    const returned = new Set(symbols);

    for (const stored of [undefined, null, "N/A"] as const) {
      for (const symbol of symbolsStoredAs(stored)) {
        assert.ok(
          returned.has(symbol),
          `${symbol} (sector ${JSON.stringify(stored)}) must reach the chip`
        );
      }
    }
  });

  it("Realty is reachable under Real Estate (MONEY-1093 alias)", async () => {
    const { total } = await screen("Real Estate");
    assert.equal(total, 1);
  });

  it("the pushdown is output-neutral: a DB that ignores the clause returns the SAME rows", async () => {
    // The query may be looser than the predicate but never tighter, so removing
    // it entirely must not change the answer. This is what proves the expansion
    // did not quietly narrow the result set.
    for (const chip of ["Industrials", "Energy", UNCATEGORISED_SECTOR_FACET]) {
      h.honourSectorClause = true;
      const withPushdown = await screen(chip);
      h.honourSectorClause = false;
      const withoutPushdown = await screen(chip);

      assert.deepEqual(
        withPushdown,
        withoutPushdown,
        `the pushdown changed the visible result set for "${chip}"`
      );
    }
  });

  it("the sector filter still reaches the QUERY, not just the Node pass", async () => {
    await screen("Industrials");

    assert.ok(
      h.lastInstrumentClause,
      "dropping the pushdown would re-introduce the whole-banded-set fetch " +
        "MONEY-1131 removed — silently, because the JS pass still filters"
    );
  });

  it("[regression] a raw non-canonical filter value keeps reaching its own rows", async () => {
    // `SectorDeepDive` links `/discover/screener?stocks.sector=<raw bucket>`,
    // and the heatmap deliberately keeps non-canonical buckets visible. Folding
    // must not strand those links on an empty screen.
    assert.equal((await screen("Other")).total, 12);
    assert.equal(
      (await screen("Construction")).total,
      7,
      "the rows literally stored that way, not the whole Industrials chip"
    );
  });
});
