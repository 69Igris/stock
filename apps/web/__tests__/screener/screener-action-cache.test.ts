/**
 * MONEY-1131 — screener server action: page-level cache, sector pushdown,
 * single-flight, and (above all) RESULT IDENTITY.
 *
 * Drives the REAL `lib/actions/screener.ts` through the `require.cache` seam
 * (same technique as `__tests__/actions/discover-all.test.ts`), with an
 * in-memory cache standing in for Redis and a fake Prisma that records every
 * query it is handed. `singleFlight` is loaded for real from
 * `@usemoney/core/cache` — a stub of it would test the stub.
 *
 * The three defects under test:
 *
 *   - pagination deserialised the FULL ranked array (~7,400 stock rows) out of
 *     Redis to hand back 25 — on every page click and every sort change;
 *   - the ratios path read every row matching the fundamental bands and then
 *     dropped the wrong SECTORS in JavaScript;
 *   - concurrent misses on the same key each ran their own full scan.
 *
 * The identity suite is the one that matters: this decides which stocks a user
 * sees, so every optimisation has to be provably output-preserving. It is
 * differential, not a re-implementation — the reference is the action's own
 * whole-list answer, and the sector pushdown is checked by running the SAME
 * fixture through a DB that honours the new clause and a DB that ignores it
 * entirely (i.e. the pre-change behaviour).
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/screener.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

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
// 7 rows across 3 sectors, distinct market caps so ordering is deterministic.

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
    /**
     * `undefined` models a document whose `sector` KEY WAS NEVER CREATED, which
     * is a genuinely different state from an explicit `null` as far as Prisma is
     * concerned — and the distinction this fixture previously could not express.
     */
    sector?: string | null;
    latestQuote: { price: number; changePercent: number };
  };
}

function row(
  symbol: string,
  sector: string | null | undefined,
  pe: number,
  marketCap: number
): RatioFixture {
  return {
    symbol,
    exchange: "NSE",
    pe,
    roe: 18,
    revenueGrowth: 9,
    debtToEquity: 0.4,
    marketCap,
    dividendYield: 1.5,
    instrument: {
      name: `${symbol} Ltd`,
      // Omit the key entirely when `undefined` — assigning `sector: undefined`
      // would still create the property, which is the very state under test.
      ...(sector === undefined ? {} : { sector }),
      latestQuote: { price: 100 + pe, changePercent: 1.1 },
    },
  };
}

const FIXTURE: RatioFixture[] = [
  row("ONGC", "Energy", 12, 90_000),
  row("IOC", "Energy", 14, 80_000),
  row("BPCL", "Energy", 16, 70_000),
  row("TCS", "Information Technology", 28, 60_000),
  row("INFY", "Information Technology", 24, 50_000),
  row("MYSTERY", null, 20, 40_000),
  row("SKIPPED", "N/A", 22, 30_000),
  // The row that matters: `sector` key ABSENT, not null. Every instrument the
  // nightly sync mints looks like this until enrichment reaches it. Without it
  // the fixture cannot distinguish `{sector: null}` from
  // `{sector: {isSet: false}}`, and the "Not Categorised" pushdown shipped
  // missing the absent-field branch precisely because no row exercised it.
  row("UNSET", undefined, 26, 20_000),
];

// ── Test doubles ────────────────────────────────────────────────────────

interface QueryLog {
  model: string;
  args: Record<string, unknown>;
}

interface Harness {
  queries: QueryLog[];
  cacheGets: string[];
  cacheSets: string[];
  store: Map<string, unknown>;
  /** false ⇒ the DB ignores `where.instrument`, i.e. pre-MONEY-1131 behaviour. */
  honourSectorClause: boolean;
}

const h: Harness = {
  queries: [],
  cacheGets: [],
  cacheSets: [],
  store: new Map(),
  honourSectorClause: true,
};

/** Every `sector` condition the action can emit, in one union. */
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
 * PRISMA's semantics for one `sector` condition — not raw Mongo's. This is the
 * distinction the whole "Not Categorised" branch turns on:
 *   - `{ sector: null }`             → explicit null ONLY. It does NOT match a
 *                                      document missing the key, even though
 *                                      raw Mongo's `{f: null}` would.
 *   - `{ sector: { isSet: false } }` → the missing-key case, and only that.
 *   - `{ sector: { notIn: [...] } }` → MONEY-1157's widening. `$nin` also
 *                                      matches absent/null; modelled faithfully
 *                                      even though the branches above already
 *                                      cover those, so the double cannot hide a
 *                                      formulation that leans on it.
 * A double that collapsed these into `o.sector === sector` would report a pass
 * for a query that returns nothing in production.
 */
function matchesSectorCondition(
  want: SectorCondition,
  sector: string | null | undefined,
  sectorKeyPresent: boolean
): boolean {
  if (want === null) return sectorKeyPresent && sector === null;
  if (typeof want === "string") return sectorKeyPresent && sector === want;
  if (want.isSet !== undefined) {
    return want.isSet === false ? !sectorKeyPresent : sectorKeyPresent;
  }
  if (want.notIn) {
    if (!sectorKeyPresent || sector == null) return true;
    return !want.notIn.includes(sector);
  }
  if (want.equals !== undefined) {
    if (!sectorKeyPresent || sector == null) return false;
    return want.mode === "insensitive"
      ? sector.toLowerCase() === want.equals.toLowerCase()
      : sector === want.equals;
  }
  return false;
}

/**
 * Minimal MongoDB-shaped evaluation of the relation clause the action now
 * emits. A test double for the database, NOT a copy of production logic — and
 * the identity suite below deliberately also runs with this switched OFF, so a
 * flaw here cannot manufacture a pass.
 */
function matchesInstrumentClause(
  clause: Record<string, unknown> | undefined,
  sector: string | null | undefined,
  sectorKeyPresent: boolean
): boolean {
  if (!clause) return true;
  const inner = (clause as { is?: Record<string, unknown> }).is;
  if (!inner) return true;
  if (Array.isArray(inner.OR)) {
    return (inner.OR as Array<{ sector: SectorCondition }>).some((o) =>
      matchesSectorCondition(o.sector, sector, sectorKeyPresent)
    );
  }
  if (inner.sector === undefined) return true;
  return matchesSectorCondition(
    inner.sector as SectorCondition,
    sector,
    sectorKeyPresent
  );
}

function fakePrisma() {
  const record = (model: string, args: Record<string, unknown>) => {
    h.queries.push({ model, args });
  };
  return {
    stockRatios: {
      findMany: async (args: Record<string, unknown>) => {
        record("stockRatios", args);
        const where = (args.where ?? {}) as Record<string, unknown>;
        const clause = where.instrument as Record<string, unknown> | undefined;
        return FIXTURE.filter(
          (r) =>
            !h.honourSectorClause ||
            matchesInstrumentClause(
              clause,
              r.instrument.sector,
              "sector" in r.instrument
            )
        );
      },
    },
    instrumentMapping: {
      findMany: async (args: Record<string, unknown>) => {
        record("instrumentMapping", args);
        return [];
      },
      count: async (args: Record<string, unknown>) => {
        record("instrumentMapping.count", args);
        return 312;
      },
    },
    latestQuote: {
      findMany: async (args: Record<string, unknown>) => {
        record("latestQuote", args);
        return [];
      },
    },
    mutualFundMaster: {
      findMany: async (args: Record<string, unknown>) => {
        record("mutualFundMaster", args);
        return [];
      },
      count: async (args: Record<string, unknown>) => {
        record("mutualFundMaster.count", args);
        return 1700;
      },
    },
    indexConstituent: {
      findMany: async (args: Record<string, unknown>) => {
        record("indexConstituent", args);
        return [];
      },
    },
  };
}

function stubBoundaries(): void {
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  const corePath = require.resolve("@usemoney/core");
  const servicesPath = require.resolve("@usemoney/services");
  for (const p of [dbPath, corePath, servicesPath]) snapshotOnce(p);

  cache[dbPath] = { exports: { __esModule: true, prisma: fakePrisma() } };
  cache[corePath] = {
    exports: {
      __esModule: true,
      // Keyed on the identifier alone — the module/scope are constant here, and
      // the identifier is exactly what the action varies.
      getCached: async (
        _m: string,
        _s: string,
        identifier: string
      ): Promise<unknown> => {
        h.cacheGets.push(identifier);
        return h.store.has(identifier) ? h.store.get(identifier) : null;
      },
      setCached: async (
        _m: string,
        _s: string,
        identifier: string,
        data: unknown
      ): Promise<void> => {
        h.cacheSets.push(identifier);
        // Round-trip through JSON so a test can never pass on shared object
        // identity that Redis would have destroyed.
        h.store.set(identifier, JSON.parse(JSON.stringify(data)));
      },
    },
  };
  // `@usemoney/services` is only imported for a TYPE plus the lazy
  // `getDiscoverData` in the instruments-first path, which these filters never
  // take. Stubbed so the real package is never pulled in.
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getDiscoverData: async () => ({ success: true, data: null }),
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
      rows: Array<{ symbol: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    error?: string;
  }>;
  getScreenerUniverseCountsAction: () => Promise<{
    mf: number;
    etf: number;
  } | null>;
}

function loadScreener(): ScreenerMod {
  const cache = moduleCache();
  stubBoundaries();
  delete cache[require.resolve(SCREENER_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(SCREENER_REL) as ScreenerMod;
}

function reset(): void {
  h.queries = [];
  h.cacheGets = [];
  h.cacheSets = [];
  h.store = new Map();
  h.honourSectorClause = true;
}

beforeEach(reset);

after(() => {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(SCREENER_REL)];
});

const ratiosQueries = () => h.queries.filter((q) => q.model === "stockRatios");
const pageKeys = () => h.cacheSets.filter((k) => /:p\d+x\d+$/.test(k));
const listKeys = () => h.cacheSets.filter((k) => !/:p\d+x\d+$/.test(k));

// ════════════════════════════════════════════════════════════════════════
// FIX 4 — the sector filter reaches the query
// ════════════════════════════════════════════════════════════════════════

describe("screener ratios path — sector reaches the query (MONEY-1131)", () => {
  it("a named sector pushes down EVERY stored value that folds onto it (MONEY-1157)", async () => {
    const mod = loadScreener();
    await mod.screenStocksAction({ minPe: 1, maxPe: 99, sector: "Energy" });

    const where = ratiosQueries()[0]!.args.where as {
      instrument?: { is?: Record<string, unknown> };
    };
    // Was `{ sector: { equals: "Energy", mode: "insensitive" } }` — the raw
    // string and nothing else, while `buildSectorFacets` was already COUNTING
    // `Power` / `Oil & Gas` rows under this chip. A Mongo filter cannot call the
    // JS predicate per row, so the canonical target is expanded into the set of
    // stored values that fold onto it. Insensitive `equals` per branch rather
    // than one `$in`, because the JS predicate is case-insensitive on the row
    // side and a case-sensitive `$in` would therefore be a SUBSET of it — the
    // retained JS pass cannot rescue a row the database never returned.
    assert.deepEqual(where.instrument, {
      is: {
        OR: [
          { sector: { equals: "Energy", mode: "insensitive" } },
          { sector: { equals: "Power", mode: "insensitive" } },
          { sector: { equals: "Oil & Gas", mode: "insensitive" } },
        ],
      },
    });
  });

  it("a sector with no aliases keeps the single-clause shape", async () => {
    const mod = loadScreener();
    await mod.screenStocksAction({ minPe: 1, maxPe: 99, sector: "Utilities" });

    const where = ratiosQueries()[0]!.args.where as {
      instrument?: { is?: Record<string, unknown> };
    };
    assert.deepEqual(
      where.instrument,
      { is: { sector: { equals: "Utilities", mode: "insensitive" } } },
      "the query shape must only grow where the taxonomy actually folds"
    );
  });

  it('"Not Categorised" pushes down absent / null / "" / "N/A" AND everything non-canonical', async () => {
    const mod = loadScreener();
    await mod.screenStocksAction({
      minPe: 1,
      maxPe: 99,
      sector: "Not Categorised",
    });

    const where = ratiosQueries()[0]!.args.where as {
      instrument?: { is?: { OR?: Array<{ sector: SectorCondition }> } };
    };
    const branches = where.instrument?.is?.OR;
    assert.ok(branches, "the uncategorised bucket must stay an OR");

    // `{ isSet: false }` is FIRST and is not decoration: Prisma's `{sector: null}`
    // matches an explicit null only, so without this branch every instrument
    // whose `sector` key was never created — the entire pre-enrichment
    // population the chip exists to surface — is dropped by the database, and
    // the retained JS pass cannot bring back rows that never arrived. It also
    // means the `notIn` branch below never has to be trusted to match absent
    // fields, which is the trap a `$nin`-only formulation walks into.
    assert.deepEqual(branches!.slice(0, 4), [
      { sector: { isSet: false } },
      { sector: null },
      { sector: "" },
      { sector: "N/A" },
    ]);

    // MONEY-1157 — the widening. `Other` (228 rows on prod) was counted under
    // this chip and then excluded by the query AND by the JS predicate.
    const notIn = (branches![4]?.sector as { notIn?: readonly string[] })
      ?.notIn;
    assert.ok(notIn, "the bucket must widen past the four literal values");
    assert.ok(
      notIn!.includes("Energy") && notIn!.includes("Construction"),
      "values that DO fold onto a canonical sector must be excluded from the bucket"
    );
    // MONEY-1302 moved `Agriculture` and `Media & Entertainment` from the
    // second list to the first: both are aliases now, so both must be EXCLUDED
    // from the catch-all or they are counted under a canonical chip AND
    // returned by the catch-all — the exact double-count this file exists to
    // prevent. Asserted positively rather than just deleted from the list
    // below, so the move is pinned in the direction it actually went.
    assert.ok(
      notIn!.includes("Agriculture") &&
        notIn!.includes("Media & Entertainment"),
      "MONEY-1302 aliases fold onto FMCG / Telecommunication, so they must be " +
        "excluded from the catch-all bucket"
    );
    assert.equal(
      notIn!.some((v) => ["Other", "N/A"].includes(v)),
      false,
      "values that fold nowhere belong IN the bucket, so they must not be listed"
    );
  });

  it("no sector filter ⇒ no relation clause at all (query shape unchanged)", async () => {
    const mod = loadScreener();
    await mod.screenStocksAction({ minPe: 1, maxPe: 99 });

    const where = ratiosQueries()[0]!.args.where as Record<string, unknown>;
    assert.equal(
      Object.hasOwn(where, "instrument"),
      false,
      "an unfiltered screen must not grow a join predicate"
    );
  });

  it("the ratios read still carries NO take — capping it would truncate the matched set", async () => {
    const mod = loadScreener();
    await mod.screenStocksAction({ minPe: 1, maxPe: 99 });
    assert.equal(
      Object.hasOwn(ratiosQueries()[0]!.args, "take"),
      false,
      "a take here would silently under-report `total`"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// RESULT IDENTITY — the assertion this ticket lives or dies on
// ════════════════════════════════════════════════════════════════════════

describe("screener results are unchanged by MONEY-1131", () => {
  it("sector pushdown is output-neutral: a DB that ignores the new clause returns the SAME rows", async () => {
    const filters = { minPe: 1, maxPe: 99, sector: "Energy" };

    // Post-change: the database applies the clause.
    h.honourSectorClause = true;
    const withPushdown = await loadScreener().screenStocksAction(filters);

    // Pre-change: the database ignores it and hands back everything, exactly
    // as it did before the clause existed. The retained JS pass must produce
    // an identical result.
    reset();
    h.honourSectorClause = false;
    const withoutPushdown = await loadScreener().screenStocksAction(filters);

    assert.deepEqual(withPushdown, withoutPushdown);
    assert.equal(withPushdown.success, true);
    // Membership, not order — the ordering identity is what the deepEqual
    // above and the sort-key case below pin.
    assert.deepEqual(
      withPushdown.data!.rows.map((r) => r.symbol).sort(),
      ["BPCL", "IOC", "ONGC"],
      "and it is the right three rows, not two empty sets"
    );
  });

  it('"Not Categorised" is output-neutral too — absent, null AND the "N/A" sentinel all survive', async () => {
    const filters = { minPe: 1, maxPe: 99, sector: "Not Categorised" };

    h.honourSectorClause = true;
    const withPushdown = await loadScreener().screenStocksAction(filters);
    reset();
    h.honourSectorClause = false;
    const withoutPushdown = await loadScreener().screenStocksAction(filters);

    assert.deepEqual(withPushdown, withoutPushdown);
    assert.deepEqual(
      withPushdown.data!.rows.map((r) => r.symbol).sort(),
      ["MYSTERY", "SKIPPED", "UNSET"],
      "the uncategorised bucket is (sector absent) ∪ (sector null) ∪ (sector 'N/A')"
    );
  });

  it("[regression] the pushdown does not drop rows whose `sector` key is ABSENT", async () => {
    // The differential assertion above compares pushdown against no-pushdown,
    // so it catches this — but only because UNSET exists in the fixture, and it
    // did not when the pushdown was written. Pin the specific row directly, so
    // deleting `{ sector: { isSet: false } }` fails with a message that names
    // the cause instead of an off-by-one in a symbol list.
    h.honourSectorClause = true;
    const res = await loadScreener().screenStocksAction({
      minPe: 1,
      maxPe: 99,
      sector: "Not Categorised",
    });

    assert.ok(
      res.data!.rows.some((r) => r.symbol === "UNSET"),
      "an instrument with NO `sector` key must match 'Not Categorised' — " +
        "Prisma's `{sector: null}` does not match absent fields, so the " +
        "`{ sector: { isSet: false } }` branch is what makes this work"
    );
  });

  it("paging is a faithful slice: every page concatenates back to the whole ranked list, in order", async () => {
    const mod = loadScreener();
    const filters = { minPe: 1, maxPe: 99 };

    // Reference: the entire ranked list in one call.
    const whole = await mod.screenStocksAction(filters, undefined, {
      page: 0,
      pageSize: 200,
    });
    const reference = whole.data!.rows;
    assert.equal(reference.length, FIXTURE.length);

    const pageSize = 3;
    const collected: Array<{ symbol: string }> = [];
    for (let page = 0; page * pageSize < reference.length; page++) {
      const res = await mod.screenStocksAction(filters, undefined, {
        page,
        pageSize,
      });
      assert.equal(res.success, true);
      assert.equal(
        res.data!.total,
        reference.length,
        `page ${page} must report the matched-set size, not the page size`
      );
      assert.deepEqual(
        res.data!.rows,
        reference.slice(page * pageSize, page * pageSize + pageSize),
        `page ${page} must equal the corresponding slice of the ranked list`
      );
      collected.push(...res.data!.rows);
    }
    assert.deepEqual(collected, reference);
  });

  it("a page served from the page entry is byte-identical to the page that computed it", async () => {
    const mod = loadScreener();
    const filters = { minPe: 1, maxPe: 99, minRoe: 5 };

    const first = await mod.screenStocksAction(filters, undefined, { page: 1 });
    const queriesAfterFirst = h.queries.length;
    const second = await mod.screenStocksAction(filters, undefined, {
      page: 1,
    });

    assert.deepEqual(second, first);
    assert.equal(
      h.queries.length,
      queriesAfterFirst,
      "the second read must not touch the DB"
    );
  });

  it("sort order is preserved end-to-end for every sort key", async () => {
    const mod = loadScreener();
    for (const sort of ["match", "mcap-desc", "mcap-asc", "name-asc"]) {
      reset();
      const whole = await mod.screenStocksAction({ minPe: 1, maxPe: 99 }, "", {
        page: 0,
        pageSize: 200,
        sort,
      });
      const paged = await mod.screenStocksAction({ minPe: 1, maxPe: 99 }, "", {
        page: 0,
        pageSize: 2,
        sort,
      });
      assert.deepEqual(
        paged.data!.rows,
        whole.data!.rows.slice(0, 2),
        `sort=${sort} must page off the same ordering`
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// FIX 5 — pagination stops deserialising the whole ranked list
// ════════════════════════════════════════════════════════════════════════

describe("screener cache tiers (MONEY-1131)", () => {
  it("a cold page-0 writes BOTH the page entry and the full ranked list", async () => {
    const mod = loadScreener();
    await mod.screenStocksAction({ minPe: 1, maxPe: 99 });

    assert.equal(listKeys().length, 1, "backing store written once");
    assert.equal(pageKeys().length, 1, "page entry written once");
    assert.ok(
      pageKeys()[0]!.startsWith(listKeys()[0]!),
      "the page entry must derive from the list key, so the two tiers cannot " +
        "drift onto different filter/sort identities"
    );
    assert.ok(
      pageKeys()[0]!.endsWith(":p0x25"),
      `page key must name its page + size, got ${pageKeys()[0]}`
    );
  });

  it("a warm page reads ONLY its page entry — the multi-MB list key is never fetched", async () => {
    const mod = loadScreener();
    const filters = { minPe: 1, maxPe: 99, maxRoe: 90 };
    await mod.screenStocksAction(filters);

    h.cacheGets = [];
    await mod.screenStocksAction(filters);

    assert.deepEqual(
      h.cacheGets.filter((k) => !/:p\d+x\d+$/.test(k)),
      [],
      "the full ranked list must not be deserialised to return 25 rows"
    );
    assert.equal(h.cacheGets.length, 1);
  });

  it("a NEW page falls back to the cached list instead of re-running the DB path", async () => {
    const mod = loadScreener();
    const filters = { minPe: 1, maxPe: 99, minDebtToEquity: 0 };
    await mod.screenStocksAction(filters, undefined, { page: 0, pageSize: 2 });
    const queriesAfterWarm = ratiosQueries().length;

    const p1 = await mod.screenStocksAction(filters, undefined, {
      page: 1,
      pageSize: 2,
    });

    assert.equal(p1.success, true);
    assert.equal(
      ratiosQueries().length,
      queriesAfterWarm,
      "page 2 must not re-scan the DB"
    );
    assert.ok(
      h.cacheSets.some((k) => k.endsWith(":p1x2")),
      "and it memoises itself for next time"
    );
  });

  it("page entries are per {page,size} and never collide across sorts", async () => {
    const mod = loadScreener();
    await mod.screenStocksAction({ minPe: 1, maxPe: 99 }, "", {
      page: 0,
      sort: "mcap-desc",
    });
    await mod.screenStocksAction({ minPe: 1, maxPe: 99 }, "", {
      page: 0,
      sort: "mcap-asc",
    });

    const keys = pageKeys();
    assert.equal(new Set(keys).size, 2, "different sorts ⇒ different entries");
  });
});

// ════════════════════════════════════════════════════════════════════════
// FIX 6 — stampede protection
// ════════════════════════════════════════════════════════════════════════

describe("screener single-flight (MONEY-1131)", () => {
  it("concurrent misses on the same key run ONE DB path and all get the same answer", async () => {
    const mod = loadScreener();
    const filters = { minPe: 3, maxPe: 97, minRevenueGrowth: 1 };

    const results = await Promise.all([
      mod.screenStocksAction(filters),
      mod.screenStocksAction(filters),
      mod.screenStocksAction(filters),
      mod.screenStocksAction(filters),
    ]);

    assert.equal(
      ratiosQueries().length,
      1,
      `4 concurrent misses must collapse to 1 scan, ran ${ratiosQueries().length}`
    );
    for (const r of results) assert.deepEqual(r, results[0]);
  });

  it("distinct keys are NOT collapsed — a different filter still gets its own scan", async () => {
    const mod = loadScreener();
    await Promise.all([
      mod.screenStocksAction({ minPe: 1, maxPe: 50 }),
      mod.screenStocksAction({ minPe: 51, maxPe: 99 }),
    ]);
    assert.equal(ratiosQueries().length, 2);
  });

  it("the flight releases: a later miss on the same key runs again", async () => {
    const mod = loadScreener();
    const filters = { minPe: 2, maxPe: 98 };
    await mod.screenStocksAction(filters);
    h.store.clear(); // TTL expiry
    await mod.screenStocksAction(filters);
    assert.equal(
      ratiosQueries().length,
      2,
      "single-flight must not become a permanent lock"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// The cheap universe counts that replaced screening idle tabs
// ════════════════════════════════════════════════════════════════════════

describe("screener universe counts (MONEY-1131)", () => {
  it("counts with the SAME predicates the screens use, via count() not findMany()", async () => {
    const mod = loadScreener();
    const counts = await mod.getScreenerUniverseCountsAction();

    assert.deepEqual(counts, { mf: 1700, etf: 312 });
    assert.deepEqual(
      h.queries.map((q) => q.model).sort(),
      ["instrumentMapping.count", "mutualFundMaster.count"],
      "no row fetches — these are badges"
    );
    const mfWhere = h.queries.find((q) => q.model === "mutualFundMaster.count")!
      .args.where as { isActive?: boolean };
    assert.equal(mfWhere.isActive, true, "same active-scheme predicate");
  });

  it("is cached, so a second render costs no queries", async () => {
    const mod = loadScreener();
    await mod.getScreenerUniverseCountsAction();
    const after = h.queries.length;
    await mod.getScreenerUniverseCountsAction();
    assert.equal(h.queries.length, after);
  });
});
