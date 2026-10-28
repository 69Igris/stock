/**
 * SERVICE TEST — MONEY-1255: the ownership breakdown, and the chip that stopped
 * lying.
 *
 * The REAL service functions with a hand-rolled fake prisma + cache injected
 * through `OwnershipSectionDeps`, so every assertion lands on the code that
 * SHIPS: the exact `where` / `select` / `orderBy` / `take`, the cache key, and
 * the provenance envelope the client branches on.
 *
 * The cases that carry the weight:
 *
 *   1. `the where clause carries NO exchange` — `shareholding_breakdown` is
 *      `@@unique([symbol, exchange, quarter])`, so an `exchange` predicate
 *      returns ZERO rows for a quarter only the OTHER exchange filed. That
 *      renders as an empty card, indistinguishable from "nobody published
 *      this" — the silent-zero failure this subsystem keeps re-learning.
 *   2. `the select carries `source`` — without it every row falls back to the
 *      schema default and a BSE-only company is labelled NSE. It is the one
 *      way to undo A3.1 without touching A3.1's code.
 *   3. `the take is a MULTIPLE of the exchange count` — sized in ROWS over a
 *      table where one quarter occupies one row per exchange (MONEY-1207).
 *   4. `BigInt never reaches the wire` — `JSON.stringify` THROWS on one, so an
 *      uncoerced share count is a 500 at the server/client boundary.
 *   5. `an empty section is NOT cached` — caching "couldn't determine" pins the
 *      failure for the TTL.
 *
 * Every window is driven by an injected `now`: no timers, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getStockOwnershipBreakdownSection,
  getStockShareholdingSection,
  type OwnershipSectionDeps,
} from "../src/stock-sections-ownership.service";

type Rec = Record<string, unknown>;

const NOW = new Date("2026-08-22T00:00:00.000Z");

interface CacheSet {
  module: unknown;
  scope: unknown;
  key: unknown;
  data: unknown;
  ttl: unknown;
}

interface Harness {
  deps: OwnershipSectionDeps;
  calls: { shareholdingBreakdown: Rec[]; shareholdingPattern: Rec[] };
  cacheGets: unknown[];
  cacheSets: CacheSet[];
}

/**
 * A fake that OBEYS the query — filter, lexicographic order, take.
 *
 * A fake that returns its fixture whole cannot see an ordering or window bug,
 * and the two defects this file guards are both expressed in the query
 * (`startsWith` and a `take` that must be a multiple of the exchange count).
 */
function applyQuery(rows: Rec[], a: Rec): Rec[] {
  const where = a.where as
    | { symbol?: string; exchange?: string; quarter?: { startsWith?: string } }
    | undefined;
  let out = rows.slice();
  if (typeof where?.symbol === "string")
    out = out.filter(
      (r) => r.symbol === undefined || r.symbol === where.symbol,
    );
  // Deliberately honoured: if the service ever GROWS an exchange predicate, the
  // dual-listed fixtures below go empty and the assertions fail loudly rather
  // than the fake papering over it.
  if (typeof where?.exchange === "string")
    out = out.filter((r) => r.exchange === where.exchange);
  const prefix = where?.quarter?.startsWith;
  if (typeof prefix === "string")
    out = out.filter((r) => String(r.quarter ?? "").startsWith(prefix));
  const dir = (a.orderBy as { quarter?: string } | undefined)?.quarter;
  if (dir !== undefined) {
    out.sort((x, y) => {
      const xa = String(x.quarter ?? "");
      const ya = String(y.quarter ?? "");
      const cmp = xa < ya ? -1 : xa > ya ? 1 : 0;
      return dir === "desc" ? -cmp : cmp;
    });
  }
  const take = Number(a.take ?? Number.MAX_SAFE_INTEGER);
  out = out.slice(0, take);

  // PROJECT the select. A fake that hands back the whole fixture cannot see a
  // dropped column: `source: true` could be deleted from the query and the
  // provenance chip would go on reading a field the DB was never asked for.
  const select = a.select as Record<string, boolean> | undefined;
  if (!select) return out;
  return out.map((r) => {
    const projected: Rec = {};
    for (const k of Object.keys(select)) if (select[k]) projected[k] = r[k];
    return projected;
  });
}

function mkDeps(
  opts: {
    breakdown?: Rec[];
    patterns?: Rec[];
    tickertape?: Rec[];
    cached?: unknown;
    throwOn?: "shareholdingBreakdown" | "shareholdingPattern";
  } = {},
): Harness {
  const calls = {
    shareholdingBreakdown: [] as Rec[],
    shareholdingPattern: [] as Rec[],
  };
  const cacheGets: unknown[] = [];
  const cacheSets: CacheSet[] = [];

  const model = (name: keyof typeof calls, rows: Rec[]) => ({
    findMany: async (a: Rec) => {
      calls[name].push(a);
      if (opts.throwOn === name) throw new Error("ECONNRESET mongodb://secret");
      return applyQuery(rows, a);
    },
  });

  const db = {
    shareholdingBreakdown: model("shareholdingBreakdown", opts.breakdown ?? []),
    shareholdingPattern: model("shareholdingPattern", opts.patterns ?? []),
    stockShareholding: { findMany: async () => opts.tickertape ?? [] },
  };

  const deps = {
    prisma: db as unknown as NonNullable<OwnershipSectionDeps["prisma"]>,
    getCached: (async (_m: unknown, _s: unknown, key: unknown) => {
      cacheGets.push(key);
      return (opts.cached ?? null) as never;
    }) as unknown as NonNullable<OwnershipSectionDeps["getCached"]>,
    setCached: (async (
      module: unknown,
      scope: unknown,
      key: unknown,
      data: unknown,
      _filters: unknown,
      config?: { ttl?: unknown },
    ) => {
      cacheSets.push({ module, scope, key, data, ttl: config?.ttl });
    }) as unknown as NonNullable<OwnershipSectionDeps["setCached"]>,
    getNseMarketStatus: () => ({ isLive: false }),
    now: () => NOW,
  } satisfies OwnershipSectionDeps;

  return { deps, calls, cacheGets, cacheSets };
}

function unwrap<T>(
  r: { success: true; data: T } | { success: false; error: string },
): T {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return (r as { success: true; data: T }).data;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** RELIANCE-shaped: NSE files the breakdown, both quarters present. */
const NSE_BREAKDOWN: Rec[] = [
  {
    symbol: "RELIANCE",
    quarter: "2026-06",
    exchange: "NSE",
    source: "NSE_SHP_XBRL",
    fiiPct: 20.4,
    diiPct: 14.8,
    mutualFundPct: 9.2,
    insurancePct: 3.1,
    banksFiPct: 0.4,
    govtPct: 0,
    retailPct: 12.4,
    promoterShares: 3_200_000_000n,
    fiiShares: 1_100_000_000n,
    diiShares: 900_000_000n,
    publicShares: 1_200_000_000n,
    totalShares: 6_441_503_000n,
  },
  {
    symbol: "RELIANCE",
    quarter: "2026-03",
    exchange: "NSE",
    source: "NSE_SHP_XBRL",
    fiiPct: 20,
    diiPct: 15,
    mutualFundPct: 8.9,
    insurancePct: null,
    banksFiPct: 0,
    govtPct: 0,
    retailPct: 12.6,
  },
];

/**
 * NPRFIN-shaped: a BSE-only micro-cap. NOTHING here is filed on NSE, which is
 * the case the whole ticket exists for — 2,605 symbols on prod look like this.
 */
const BSE_ONLY_BREAKDOWN: Rec[] = [
  {
    symbol: "NPRFIN",
    quarter: "2026-06",
    exchange: "BSE",
    source: "BSE_SHP",
    fiiPct: 0.12,
    diiPct: null,
    retailPct: 28.4,
    totalShares: 12_500_000n,
  },
];

const BSE_ONLY_PATTERN: Rec[] = [
  {
    symbol: "NPRFIN",
    quarter: "2026-06",
    exchange: "BSE",
    source: "BSE_SHP",
    promoterPct: 68.02,
    pledgedPct: null,
    fiiPct: 0.12,
    diiPct: null,
    publicPct: 31.86,
  },
];

// ════════════════════════════════════════════════════════════════════════════
// A3.4 — the BSE data renders, under a truthful chip
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1255 A3.4 — a BSE-only company end to end", () => {
  it("serves a populated shareholding section stamped BSE_SHP", async () => {
    const h = mkDeps({ patterns: BSE_ONLY_PATTERN });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "NPRFIN", exchange: "BSE" },
        h.deps,
      ),
    );

    assert.equal(env.empty, false, "the section must not be empty");
    assert.equal(env.data.quarters.length, 1);
    assert.equal(env.data.quarters[0]?.promoterPct, 68.02);

    // The whole point: the numbers came from BSE and the chip says BSE.
    assert.equal(env.source, "BSE_SHP");
    assert.notEqual(
      env.source,
      "NSE_SHP",
      "a BSE-only company must never be labelled with NSE's source",
    );
    // BSE is an exchange filing, not a downgrade — no amber fallback pill.
    assert.equal(env.fallback, undefined);
    // `asOf` describes the quarter, and describes the SAME row the chip names.
    assert.equal(env.asOf, new Date(Date.UTC(2026, 6, 0)).toISOString());
  });

  it("SELECTS the `source` column — the one way to undo the fix silently", async () => {
    const h = mkDeps({ patterns: BSE_ONLY_PATTERN });
    await getStockShareholdingSection(
      { symbol: "NPRFIN", exchange: "BSE" },
      h.deps,
    );
    const select = h.calls.shareholdingPattern[0]?.select as Rec;
    assert.equal(
      select.source,
      true,
      "without this the chip falls back to the schema default",
    );
    assert.equal(
      select.exchange,
      true,
      "without this the dedupe ranks every row equal",
    );
  });

  it("serves the breakdown for the same company under a BSE chip", async () => {
    const h = mkDeps({ breakdown: BSE_ONLY_BREAKDOWN });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "NPRFIN", exchange: "BSE" },
        h.deps,
      ),
    );
    assert.equal(env.empty, false);
    assert.equal(env.source, "BSE_SHP");
    assert.equal(env.data.legs.find((l) => l.key === "fii")?.pct, 0.12);
    // DII was not filed. Null, never 0 — "no domestic institution reported"
    // and "we hold no number" must not render the same.
    assert.equal(env.data.legs.find((l) => l.key === "dii")?.pct, null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A3.3 — the breakdown reader
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1255 A3.3 getStockOwnershipBreakdownSection", () => {
  it("reads on symbol ALONE — an exchange predicate would blank a quarter", async () => {
    const h = mkDeps({ breakdown: NSE_BREAKDOWN });
    await getStockOwnershipBreakdownSection(
      { symbol: "RELIANCE", exchange: "BSE" },
      h.deps,
    );
    const where = h.calls.shareholdingBreakdown[0]?.where as Rec;
    assert.deepEqual(Object.keys(where).sort(), ["quarter", "symbol"]);
    assert.equal(where.symbol, "RELIANCE");
    assert.equal(
      "exchange" in where,
      false,
      "an exchange predicate returns nothing for a quarter only the other exchange filed",
    );
  });

  it("excludes undatable labels, which would outrank every real quarter", async () => {
    const h = mkDeps({
      breakdown: [
        { symbol: "X", quarter: "Q1FY26", fiiPct: 1 },
        { symbol: "X", quarter: "Q2FY26", fiiPct: 2 },
        { symbol: "X", quarter: "Q3FY26", fiiPct: 3 },
        { symbol: "X", quarter: "Q4FY26", fiiPct: 4 },
        ...NSE_BREAKDOWN.map((r) => ({ ...r, symbol: "X" })),
      ],
    });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "X", exchange: "NSE" },
        h.deps,
      ),
    );
    // Letters sort ABOVE digits in a lexicographic `desc`, so without the
    // predicate the four junk labels fill the take of 4 and no real quarter is
    // ever loaded — the card would render an undated row and `asOf: null`.
    assert.deepEqual((h.calls.shareholdingBreakdown[0]?.where as Rec).quarter, {
      startsWith: "20",
    });
    assert.equal(env.data.quarter, "2026-06");
    assert.equal(env.data.prevQuarter, "2026-03");
    assert.equal(env.data.comparable, true);
  });

  it("sizes the take as a MULTIPLE of the exchange count", async () => {
    const h = mkDeps({ breakdown: NSE_BREAKDOWN });
    await getStockOwnershipBreakdownSection(
      { symbol: "RELIANCE", exchange: "NSE" },
      h.deps,
    );
    // 2 quarters x 2 exchanges. A take of 2 over a dual-listed name hands back
    // ONE quarter twice and no prior quarter to compare against, so every
    // delta on the card would be null (MONEY-1207).
    assert.equal(h.calls.shareholdingBreakdown[0]?.take, 4);
    assert.deepEqual(h.calls.shareholdingBreakdown[0]?.orderBy, {
      quarter: "desc",
    });
  });

  it("keeps a dual-filed quarter from eating the comparison slot", async () => {
    const dual: Rec[] = [
      { ...NSE_BREAKDOWN[0], symbol: "AARTIIND" },
      {
        ...NSE_BREAKDOWN[0],
        symbol: "AARTIIND",
        exchange: "BSE",
        source: "BSE_SHP",
        fiiPct: 19.9,
      },
      { ...NSE_BREAKDOWN[1], symbol: "AARTIIND" },
      {
        ...NSE_BREAKDOWN[1],
        symbol: "AARTIIND",
        exchange: "BSE",
        source: "BSE_SHP",
      },
    ];
    const h = mkDeps({ breakdown: dual });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "AARTIIND", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.data.quarter, "2026-06");
    assert.equal(env.data.prevQuarter, "2026-03");
    assert.equal(env.data.comparable, true);
    // A real move, not the fabricated 0 a self-comparison produces.
    assert.equal(env.data.legs.find((l) => l.key === "fii")?.deltaPct, 0.4);
  });

  it("the whole envelope survives JSON.stringify — BigInt would throw", async () => {
    const h = mkDeps({ breakdown: NSE_BREAKDOWN });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "RELIANCE", exchange: "NSE" },
        h.deps,
      ),
    );
    // Not a wrong number — a 500 with no useful message at the server/client
    // boundary. The fixture carries real bigints so this is the shipped path.
    assert.doesNotThrow(() => JSON.stringify(env));
    assert.equal(env.data.shares.total, "6441503000");
    assert.equal(typeof env.data.shares.promoter, "string");
    // …and what is CACHED must survive it too: the cache serialises.
    assert.doesNotThrow(() => JSON.stringify(h.cacheSets[0]?.data));
  });

  it("stamps asOf from the quarter it describes, never from a fetch time", async () => {
    const h = mkDeps({ breakdown: NSE_BREAKDOWN });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "RELIANCE", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.asOf, new Date(Date.UTC(2026, 6, 0)).toISOString());
    assert.notEqual(env.asOf, NOW.toISOString());
  });

  it("notes a prior quarter it declined to compare against", async () => {
    const h = mkDeps({
      breakdown: [
        NSE_BREAKDOWN[0]!,
        { ...NSE_BREAKDOWN[1], quarter: "2025-06" },
      ],
    });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "RELIANCE", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.data.comparable, false);
    assert.match(String(env.note), /Jun 2025/);
    assert.match(String(env.note), /not the one immediately before/);
  });

  it("an absent symbol is success + empty, and is NEVER cached", async () => {
    const h = mkDeps({ breakdown: [] });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "NOSUCH", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.empty, true);
    assert.equal(env.source, null);
    assert.equal(env.asOf, null);
    // Caching "couldn't determine" pins the failure for the TTL and makes the
    // next request lie about it.
    assert.deepEqual(h.cacheSets, []);
  });

  it("a row with a quarter and no values is empty, not a card of dashes", async () => {
    const h = mkDeps({ breakdown: [{ symbol: "X", quarter: "2026-06" }] });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "X", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.empty, true);
    assert.deepEqual(h.cacheSets, []);
  });

  it("caches a populated card under an exchange-scoped key", async () => {
    const h = mkDeps({ breakdown: NSE_BREAKDOWN });
    await getStockOwnershipBreakdownSection(
      { symbol: "RELIANCE", exchange: "BSE" },
      h.deps,
    );
    assert.equal(h.cacheSets.length, 1);
    assert.equal(h.cacheSets[0]?.module, "discover");
    assert.equal(h.cacheSets[0]?.scope, "_global");
    // Exchange IS in the key: the preferred exchange changes which filing wins,
    // so a symbol-only key would let one page serve the other's numbers.
    assert.equal(h.cacheSets[0]?.key, "stock-ownership-breakdown:RELIANCE:BSE");
    assert.equal(h.cacheSets[0]?.ttl, 6 * 60 * 60);
  });

  it("serves a cache HIT without touching the DB", async () => {
    const h = mkDeps({
      breakdown: NSE_BREAKDOWN,
      cached: {
        data: { quarter: "2026-06" },
        source: "NSE_SHP_XBRL",
        empty: false,
      },
    });
    const env = unwrap(
      await getStockOwnershipBreakdownSection(
        { symbol: "RELIANCE", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.source, "NSE_SHP_XBRL");
    assert.deepEqual(h.calls.shareholdingBreakdown, []);
  });

  it("a DB throw is a sanitised failure with nothing cached", async () => {
    const h = mkDeps({
      breakdown: NSE_BREAKDOWN,
      throwOn: "shareholdingBreakdown",
    });
    const r = await getStockOwnershipBreakdownSection(
      { symbol: "RELIANCE", exchange: "NSE" },
      h.deps,
    );
    assert.equal(r.success, false);
    const msg = (r as { success: false; error: string }).error;
    assert.equal(msg, "Failed to load ownership breakdown");
    // The raw driver message carries a connection string.
    assert.doesNotMatch(msg, /mongodb|ECONNRESET/);
    assert.deepEqual(h.cacheSets, []);
  });
});
