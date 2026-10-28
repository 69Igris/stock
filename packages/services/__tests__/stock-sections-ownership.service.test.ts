/**
 * SERVICE TEST — ownership sections (MONEY-1204, P14 14c.4/5/6).
 *
 * The REAL service functions with a hand-rolled fake prisma + cache injected
 * through `OwnershipSectionDeps`. `@usemoney/services` runs its suite as ESM
 * (no require.cache module-mocking), so every collaborator goes through the
 * deps seam — which means these assertions land on the code that SHIPS: the
 * exact `where`/`select`/`orderBy`/`take`, the cache module + scope + key +
 * TTL, and the provenance envelope the client branches on.
 *
 * The cases that carry the weight:
 *
 *   1. `the where clause carries NO exchange` — every one of these tables
 *      defaults `exchange` to "NSE", and `ShareholdingPattern`'s unique key has
 *      no exchange in it at all. An `exchange: "BSE"` predicate returns zero
 *      rows on a dual-listed name and renders as "nothing published" — a silent
 *      empty that looks exactly like a real absence.
 *   2. `NSE wins / Tickertape is labelled fallback` — the section's whole
 *      premise, asserted through the service rather than only the pure layer.
 *   3. `a stale fallback is labelled and cached briefly` — the staleness bound
 *      preserved from getShareholdingAction.
 *   4. `an empty section is NOT cached` — caching "couldn't determine" pins the
 *      failure for the TTL (standing rule).
 *   5. `BigInt never reaches the wire` — `JSON.stringify` throws on a BigInt, so
 *      an uncoerced qty is a 500 at the server/client boundary, not a wrong
 *      number.
 *   6. `a DB throw is a sanitised failure` — no raw error text on the wire.
 *
 * Every window is driven by an injected `now`: no timers, no clock races,
 * nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  describeDealsCoverage,
  getStockDealsSection,
  getStockInsiderSection,
  getStockShareholdingSection,
  summariseDealsCoverage,
  type OwnershipSectionDeps,
} from "../src/stock-sections-ownership.service";

type Rec = Record<string, unknown>;

const NOW = new Date("2026-08-15T00:00:00.000Z");
const daysAgo = (n: number): Date =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

interface DbCfg {
  shareholdingPattern?: Rec[];
  stockShareholding?: Rec[];
  insiderEvent?: Rec[];
  stockDocument?: Rec[];
  institutionalDeal?: Rec[];
  /**
   * Market-wide day counts for the MONEY-1205 coverage probe, when they need
   * to differ from the per-symbol rows above (they usually do — the probe
   * counts the WHOLE market, the section reads one stock). `_n` on a row is
   * how many prints that day carried across all symbols.
   */
  institutionalDealDays?: Rec[];
  /** Which model should throw on read (to exercise the catch). */
  throwOn?: keyof DbCfg;
}

interface Calls {
  shareholdingPattern: Rec[];
  stockShareholding: Rec[];
  insiderEvent: Rec[];
  stockDocument: Rec[];
  institutionalDeal: Rec[];
  institutionalDealGroupBy: Rec[];
}

interface CacheSet {
  module: unknown;
  scope: unknown;
  key: unknown;
  data: unknown;
  ttl: unknown;
}

interface Harness {
  deps: OwnershipSectionDeps;
  calls: Calls;
  cacheGets: unknown[];
  cacheSets: CacheSet[];
}

function mkDeps(
  opts: { db?: DbCfg; cached?: unknown; isLive?: boolean; now?: Date } = {},
): Harness {
  const cfg = opts.db ?? {};
  const calls: Calls = {
    shareholdingPattern: [],
    stockShareholding: [],
    insiderEvent: [],
    stockDocument: [],
    institutionalDeal: [],
    institutionalDealGroupBy: [],
  };
  const cacheGets: unknown[] = [];
  const cacheSets: CacheSet[] = [];

  const model = (name: keyof Calls) => ({
    findMany: async (a: Rec) => {
      calls[name].push(a);
      if (cfg.throwOn === name) throw new Error("ECONNRESET mongodb://secret");
      return (cfg[name] as Rec[] | undefined) ?? [];
    },
  });

  /**
   * `shareholding_patterns` with the query actually APPLIED — the `where`
   * filter, the lexicographic `orderBy` and the `take`.
   *
   * A fake that returns its fixture whole cannot see an ordering bug: the
   * defect is that `orderBy: { quarter: "desc" }` sorts "Q1FY26" ABOVE every
   * canonical "YYYY-MM" and the `take` then keeps only those. So this one
   * obeys the query, which is the only way the assertion lands on the shipped
   * behaviour rather than on the fixture.
   */
  const shareholdingPatternModel = {
    findMany: async (a: Rec) => {
      calls.shareholdingPattern.push(a);
      if (cfg.throwOn === "shareholdingPattern")
        throw new Error("ECONNRESET mongodb://secret");
      const rows = (cfg.shareholdingPattern ?? []).slice();
      const where = a.where as
        | { quarter?: { startsWith?: string } }
        | undefined;
      const prefix = where?.quarter?.startsWith;
      const filtered =
        typeof prefix === "string"
          ? rows.filter((r) => String(r.quarter ?? "").startsWith(prefix))
          : rows;
      const dir = (a.orderBy as { quarter?: string } | undefined)?.quarter;
      const sorted =
        dir === undefined
          ? filtered
          : filtered.sort((x, y) => {
              const xa = String(x.quarter ?? "");
              const ya = String(y.quarter ?? "");
              const cmp = xa < ya ? -1 : xa > ya ? 1 : 0;
              return dir === "desc" ? -cmp : cmp;
            });
      const take = Number(a.take ?? Number.MAX_SAFE_INTEGER);
      return sorted.slice(0, take);
    },
  };

  /**
   * `institutional_deals` with `groupBy(date)` — the MONEY-1205 coverage probe.
   *
   * WITHOUT THIS METHOD THE FEATURE WAS 100% UNTESTED. `readDealsCoverage`
   * wraps its query in a try/catch that returns null on any throw, because a
   * missing coverage line must never take the deals panel down with it. A fake
   * that only implements `findMany` therefore threw
   * `db.institutionalDeal.groupBy is not a function`, hit that catch, and every
   * deals test in this file ran green against `coverage: null` — asserting the
   * failure branch and nothing else. Seven of them, silently.
   *
   * It applies the real `where` (the lookback cutoff) and groups for real, so
   * the assertions land on the shipped query rather than on a fixture.
   */
  const institutionalDealModel = {
    ...model("institutionalDeal"),
    groupBy: async (a: Rec) => {
      calls.institutionalDealGroupBy.push(a);
      if (cfg.throwOn === "institutionalDeal")
        throw new Error("ECONNRESET mongodb://secret");
      const where = a.where as { date?: { gte?: Date } } | undefined;
      const gte = where?.date?.gte;
      const counts = new Map<number, number>();
      for (const r of cfg.institutionalDealDays ??
        cfg.institutionalDeal ??
        []) {
        const d = r.date instanceof Date ? r.date : new Date(String(r.date));
        if (Number.isNaN(d.getTime())) continue;
        if (gte instanceof Date && d.getTime() < gte.getTime()) continue;
        // A fixture row may stand for many prints on that day.
        const n = Number((r as { _n?: number })._n ?? 1);
        counts.set(d.getTime(), (counts.get(d.getTime()) ?? 0) + n);
      }
      return [...counts.entries()]
        .sort((x, y) => y[0] - x[0])
        .map(([t, n]) => ({ date: new Date(t), _count: { _all: n } }));
    },
  };

  const db = {
    shareholdingPattern: shareholdingPatternModel,
    stockShareholding: model("stockShareholding"),
    insiderEvent: model("insiderEvent"),
    stockDocument: model("stockDocument"),
    institutionalDeal: institutionalDealModel,
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
    getNseMarketStatus: () => ({ isLive: opts.isLive ?? false }),
    now: () => opts.now ?? NOW,
  } satisfies OwnershipSectionDeps;

  return { deps, calls, cacheGets, cacheSets };
}

function unwrap<T>(
  r: { success: true; data: T } | { success: false; error: string },
): T {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return (r as { success: true; data: T }).data;
}

// ════════════════════════════════════════════════════════════════════════════
// 14c.4 — shareholding
// ════════════════════════════════════════════════════════════════════════════

const NSE_ROWS: Rec[] = [
  {
    quarter: "2026-06",
    promoterPct: 50.1,
    pledgedPct: null,
    fiiPct: 20,
    diiPct: 15,
    publicPct: 14.9,
  },
  {
    quarter: "2026-03",
    promoterPct: 50.4,
    pledgedPct: 3,
    fiiPct: 19,
    diiPct: 15.5,
    publicPct: 15.1,
  },
];

const TT_ROWS: Rec[] = [
  {
    quarter: "Q1-2026",
    promoter: 49.9,
    fii: 21,
    dii: 14,
    public: 15.1,
    pledgedPercent: 2.1,
    fetchedAt: daysAgo(3),
  },
];

describe("14c.4 getStockShareholdingSection", () => {
  it("serves a cache HIT without touching the DB", async () => {
    const h = mkDeps({ cached: { data: { quarters: [] }, source: "NSE_SHP" } });
    const r = await getStockShareholdingSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    );
    assert.equal(r.success, true);
    assert.equal(h.calls.shareholdingPattern.length, 0);
    // Exchange is IN the key. It has to be: the section now prefers the viewed
    // exchange's filing where both NSE and BSE have published the same quarter
    // (MONEY-1207 put `exchange` in the row's unique key), so a symbol-only key
    // would let whichever page rendered first serve its numbers to the other.
    assert.deepEqual(h.cacheGets, ["stock-shareholding-section:ACME:NSE"]);
  });

  it("does not let one exchange's cached section serve the other", async () => {
    // The concrete failure the key change prevents: NSE renders first, caches
    // its pick, and the BSE page then serves NSE's filing under a BSE heading
    // with nothing on screen to say so.
    const nse = mkDeps({
      cached: { data: { quarters: [] }, source: "NSE_SHP" },
    });
    await getStockShareholdingSection(
      { symbol: "ACME", exchange: "NSE" },
      nse.deps,
    );
    const bse = mkDeps({
      cached: { data: { quarters: [] }, source: "NSE_SHP" },
    });
    await getStockShareholdingSection(
      { symbol: "ACME", exchange: "BSE" },
      bse.deps,
    );
    assert.notDeepEqual(nse.cacheGets, bse.cacheGets);
    assert.deepEqual(bse.cacheGets, ["stock-shareholding-section:ACME:BSE"]);
  });

  it("collapses a quarter both exchanges filed into ONE row", async () => {
    // MONEY-1207 fallout, end to end through the service: the reader is
    // symbol-scoped on purpose (an exchange predicate would hide quarters only
    // one exchange filed), so both filings arrive and the builder picks one.
    const h = mkDeps({
      db: {
        shareholdingPattern: [
          {
            quarter: "2026-06",
            exchange: "NSE",
            promoterPct: 41.82,
            pledgedPct: null,
            fiiPct: 6.1,
            diiPct: null,
            publicPct: null,
          },
          {
            quarter: "2026-06",
            exchange: "BSE",
            promoterPct: 41.82,
            pledgedPct: null,
            fiiPct: 6.1,
            diiPct: null,
            publicPct: null,
          },
          {
            quarter: "2026-03",
            exchange: "NSE",
            promoterPct: 42.09,
            pledgedPct: null,
            fiiPct: 5.4,
            diiPct: null,
            publicPct: null,
          },
          {
            quarter: "2026-03",
            exchange: "BSE",
            promoterPct: 42.09,
            pledgedPct: null,
            fiiPct: 5.4,
            diiPct: null,
            publicPct: null,
          },
        ],
      },
    });
    const r = await getStockShareholdingSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    );
    assert.equal(r.success, true);
    const quarters = r.success ? r.data.data.quarters : [];
    const labels = quarters.map((q) => q.quarter);
    assert.deepEqual(labels, ["2026-06", "2026-03"], "one row per quarter");
    // And the QoQ delta must be a real period-over-period move, not 0.
    assert.ok(
      quarters[0].deltas.promoterPct !== null &&
        quarters[0].deltas.promoterPct !== 0,
      "delta must not compare a quarter against itself",
    );

    // The dedupe ranks on `exchange`, so the reader must SELECT it. Asserted on
    // the query rather than the output because omitting it does not fail
    // anything: every row then ranks equal and the winner silently becomes
    // whichever filing the driver returned first. A fixture-based test cannot
    // see that — the fake returns its rows whole regardless of the select.
    const q = h.calls.shareholdingPattern[0] as {
      select?: Record<string, unknown>;
      where?: Record<string, unknown>;
    };
    assert.equal(q.select?.exchange, true, "select must fetch `exchange`");
    // And it must stay symbol-scoped: an exchange predicate would hide a
    // quarter only the other exchange filed.
    assert.equal(
      q.where?.exchange,
      undefined,
      "query must not filter by exchange",
    );
  });

  it("reads on symbol ALONE — an exchange predicate would blank BSE views", async () => {
    // `ShareholdingPattern` is `@@unique([symbol, quarter])` with NO exchange,
    // and every stored row defaults `exchange` to "NSE". Filtering on the
    // page's exchange returns zero rows for a BSE view of a dual-listed name.
    const h = mkDeps({ db: { shareholdingPattern: NSE_ROWS } });
    await getStockShareholdingSection(
      { symbol: "ACME", exchange: "BSE" },
      h.deps,
    );
    // Symbol only — plus the canonical-label predicate the ordering depends on
    // (see "an undatable label must not displace…"). Still NO exchange.
    assert.deepEqual(h.calls.shareholdingPattern[0]?.where, {
      symbol: "ACME",
      quarter: { startsWith: "20" },
    });
    assert.deepEqual(h.calls.stockShareholding[0]?.where, { symbol: "ACME" });
  });

  it("the Tickertape read stays UNFILTERED and UNORDERED — its labels are month names", async () => {
    // Guards a copy-paste that would silently delete the fallback. The NSE
    // query twenty lines above carries `quarter: { startsWith: "20" }` and an
    // `orderBy`, both correct THERE and both wrong HERE, because the two
    // tables speak different label vocabularies:
    //
    //   shareholding_patterns.quarter  "2026-06"   canonicalised by our parser
    //   stock_shareholding.quarter     "Jun 2026"  Tickertape's, verbatim
    //
    // Measured on prod 2026-08-16: every row in stock_shareholding uses the
    // month-name form. `startsWith: "20"` would therefore match NOTHING and
    // return a well-formed empty result — indistinguishable from "no
    // Tickertape history for this symbol" — on the one path that exists for
    // when NSE has filed nothing.
    //
    // The fixture spans a YEAR BOUNDARY on purpose. Alphabetically
    // "Sep 2025" > "Jun 2026", so a lexicographic `orderBy: { quarter: "desc" }`
    // would headline the OLDER quarter. `quarterSortRank` understands the
    // month-name form and the in-memory sort is the authority.
    const h = mkDeps({
      db: {
        stockShareholding: [
          {
            quarter: "Sep 2025",
            promoter: 40,
            fii: 20,
            dii: 20,
            public: 20,
            pledgedPercent: 1,
            fetchedAt: daysAgo(3),
          },
          {
            quarter: "Jun 2026",
            promoter: 62,
            fii: 18,
            dii: 10,
            public: 10,
            pledgedPercent: 4,
            fetchedAt: daysAgo(3),
          },
        ],
      },
    });

    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "ACME", exchange: "NSE" },
        h.deps,
      ),
    );

    // No predicate, no order — the read hands the builder everything it has.
    assert.deepEqual(h.calls.stockShareholding[0]?.where, { symbol: "ACME" });
    assert.equal(
      h.calls.stockShareholding[0]?.orderBy,
      undefined,
      "there is no correct DB-side order for a month-name label",
    );

    // The fallback is reachable at all with these labels...
    assert.equal(env.source, "TICKERTAPE");
    assert.equal(env.empty, false);
    // ...and Jun 2026 is newest, which alphabetical ordering would get wrong.
    assert.equal(
      env.data.quarters[0]?.promoterPct,
      62,
      "Jun 2026 must headline; a lexicographic sort would pick Sep 2025",
    );
  });

  it("given BOTH sources, NSE wins and `fallback` is absent from the envelope", async () => {
    const h = mkDeps({
      db: { shareholdingPattern: NSE_ROWS, stockShareholding: TT_ROWS },
    });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "ACME", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.source, "NSE_SHP");
    assert.equal(env.fallback, undefined, "no fallback chip on the primary");
    assert.equal(env.empty, false);
    assert.deepEqual(
      env.data.quarters.map((q) => q.quarter),
      ["2026-06", "2026-03"],
    );
    // `asOf` is the quarter END the data describes, not a fetch time.
    assert.equal(env.asOf, "2026-06-30T00:00:00.000Z");
    assert.equal(env.data.stale, false);
  });

  it("preserves nulls end-to-end and computes the QoQ delta", async () => {
    const h = mkDeps({ db: { shareholdingPattern: NSE_ROWS } });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "ACME", exchange: "NSE" },
        h.deps,
      ),
    );
    const newest = env.data.quarters[0];
    assert.ok(newest);
    // Not reported this quarter. `?? 0` here would invent an all-clear.
    assert.equal(newest.pledgedPct, null);
    assert.equal(newest.deltas.promoterPct, -0.3);
    // Previous quarter reported a pledge, this one did not → unknown, not -3.
    assert.equal(newest.deltas.pledgedPct, null);
  });

  it("an undatable label must not displace every real quarter out of the read", async () => {
    // B5 — `normalizeQuarter` keeps an unparseable period VERBATIM and
    // upper-cased ("Q1FY26"), and "Q" > "2" in ASCII, so a lexicographic
    // `orderBy: { quarter: "desc" }` sorts every one of them ABOVE every
    // canonical "YYYY-MM". Enough of them and the `take` window contains no
    // real quarter at all: the panel renders undatable labels, `asOf` is null
    // and the whole wrong answer is cached for six hours.
    const verbatim = Array.from({ length: 24 }, (_, i) => ({
      quarter: `Q${(i % 4) + 1}FY${20 + Math.floor(i / 4)}`,
      promoterPct: 1,
      pledgedPct: null,
      fiiPct: null,
      diiPct: null,
      publicPct: null,
    }));
    const h = mkDeps({
      db: { shareholdingPattern: [...verbatim, ...NSE_ROWS] },
    });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "ACME", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.deepEqual(
      env.data.quarters.map((q) => q.quarter),
      ["2026-06", "2026-03"],
      "the real quarters must survive the read",
    );
    assert.equal(env.asOf, "2026-06-30T00:00:00.000Z");
    assert.equal(env.data.quarters[0]?.deltas.promoterPct, -0.3);
  });

  it("falls back to Tickertape ONLY when NSE has nothing, and says so", async () => {
    const h = mkDeps({ db: { stockShareholding: TT_ROWS } });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "ACME", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.source, "TICKERTAPE");
    assert.equal(env.fallback, true, "the fallback chip must be visible");
    assert.equal(env.data.stale, false);
    assert.match(String(env.note), /NSE has published no shareholding/);
    assert.equal(h.cacheSets[0]?.ttl, 6 * 60 * 60);
  });

  it("labels a STALE fallback copy and caches it only briefly", async () => {
    // The staleness bound preserved from getShareholdingAction: nothing
    // refreshes `stock_shareholding`, so one old StockSage run can otherwise
    // pin a symbol to one quarter forever.
    const h = mkDeps({
      db: {
        stockShareholding: [{ ...TT_ROWS[0], fetchedAt: daysAgo(120) }],
      },
    });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "ACME", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.data.stale, true);
    assert.equal(env.fallback, true);
    assert.match(String(env.note), /older than a quarter/);
    assert.equal(h.cacheSets[0]?.ttl, 30 * 60, "short TTL while stale");
  });

  it("collapses duplicate Tickertape quarters, freshest copy winning", async () => {
    // `@@unique([symbol, exchange, quarter])` lets the same quarter exist twice
    // for a dual-listed name; plotted twice it would show a QoQ delta of zero
    // between the pair.
    const h = mkDeps({
      db: {
        stockShareholding: [
          { ...TT_ROWS[0], promoter: 10, fetchedAt: daysAgo(30) },
          { ...TT_ROWS[0], promoter: 49.9, fetchedAt: daysAgo(1) },
        ],
      },
    });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "ACME", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.data.quarters.length, 1);
    assert.equal(env.data.quarters[0]?.promoterPct, 49.9);
  });

  it("an absent symbol is success + empty, and is NEVER cached", async () => {
    const h = mkDeps({ db: {} });
    const env = unwrap(
      await getStockShareholdingSection(
        { symbol: "NOBODY", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.empty, true, "empty is explicit, not inferred by the UI");
    assert.equal(env.source, null);
    assert.deepEqual(env.data.quarters, []);
    assert.deepEqual(h.cacheSets, [], "caching an empty pins it for the TTL");
  });

  it("a DB throw is a sanitised failure with nothing cached", async () => {
    const h = mkDeps({ db: { throwOn: "shareholdingPattern" } });
    const r = await getStockShareholdingSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    );
    assert.equal(r.success, false);
    const err = (r as { success: false; error: string }).error;
    assert.equal(err, "Failed to load shareholding pattern");
    assert.equal(/mongodb|ECONNRESET/.test(err), false, "no raw DB text leaks");
    assert.deepEqual(h.cacheSets, []);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.5 — insider
// ════════════════════════════════════════════════════════════════════════════

const INSIDER_ROWS: Rec[] = [
  {
    id: "e1",
    date: daysAgo(2),
    person: "A Promoter",
    category: "PIT",
    action: "BUY",
    // BigInt, exactly as Prisma returns it.
    qty: BigInt(1500),
    value: 150000,
    source: "NSE_PIT",
  },
  {
    id: "e2",
    date: daysAgo(20),
    person: "B Promoter",
    category: "SAST",
    action: "ENCUMBRANCE OTHER THAN PLEDGE",
    qty: BigInt(700),
    value: null,
    source: "NSE_SAST",
  },
  {
    id: "e3",
    date: daysAgo(40),
    person: "A Promoter",
    category: "PLEDGE",
    action: "PLEDGE_CREATION",
    qty: BigInt(500000),
    value: null,
    source: "NSE_PLEDGE",
  },
];

describe("14c.5 getStockInsiderSection", () => {
  it("coerces BigInt qty so the payload survives JSON.stringify", async () => {
    // An uncoerced BigInt does not render wrong — it THROWS inside the server
    // action's serialisation, i.e. a 500 with no useful message.
    const h = mkDeps({ db: { insiderEvent: INSIDER_ROWS } });
    const env = unwrap(
      await getStockInsiderSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    assert.doesNotThrow(() => JSON.stringify(env));
    const first = env.data.months[0]?.events[0];
    assert.equal(typeof first?.qty, "number");
    assert.equal(first?.qty, 1500);
  });

  it("reads on symbol alone, newest first, bounded", async () => {
    const h = mkDeps({ db: { insiderEvent: INSIDER_ROWS } });
    await getStockInsiderSection({ symbol: "ACME", exchange: "BSE" }, h.deps);
    const q = h.calls.insiderEvent[0];
    assert.deepEqual(q?.where, { symbol: "ACME" });
    assert.deepEqual(q?.orderBy, { date: "desc" });
    assert.equal(q?.take, 200);
  });

  it("nets the 90-day window, excluding pledges and unknown actions", async () => {
    const h = mkDeps({ db: { insiderEvent: INSIDER_ROWS } });
    const env = unwrap(
      await getStockInsiderSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    const s = env.data.summary;
    assert.equal(s.buyQty, 1500);
    assert.equal(s.netQty, 1500, "500,000 pledged shares must not net in");
    assert.equal(s.pledgeCount, 1);
    assert.equal(s.unknownCount, 1);
  });

  it("renders an unrecognised action verbatim instead of dropping the row", async () => {
    const h = mkDeps({ db: { insiderEvent: INSIDER_ROWS } });
    const env = unwrap(
      await getStockInsiderSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    const all = env.data.months.flatMap((m) => m.events);
    assert.equal(all.length, 3, "no row is dropped for an unknown action");
    const odd = all.find((e) => e.id === "e2");
    assert.equal(odd?.action, "ENCUMBRANCE OTHER THAN PLEDGE");
    assert.equal(odd?.direction, "UNKNOWN");
  });

  it("stamps source + asOf from the SAME (newest) event and notes the mix", async () => {
    const h = mkDeps({ db: { insiderEvent: INSIDER_ROWS } });
    const env = unwrap(
      await getStockInsiderSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    assert.equal(env.source, "NSE_PIT");
    assert.equal(env.asOf, daysAgo(2).toISOString());
    assert.match(String(env.note), /NSE_PIT, NSE_SAST, NSE_PLEDGE/);
  });

  it("attaches a LIKELY document link, never an asserted one", async () => {
    const h = mkDeps({
      db: {
        insiderEvent: [INSIDER_ROWS[0] as Rec],
        stockDocument: [
          {
            id: "d1",
            docType: "corporate_filing",
            title: "Disclosure under Reg 7(2)",
            sourceUrl: "https://nse/1",
            fetchedAt: daysAgo(1),
          },
        ],
      },
    });
    const env = unwrap(
      await getStockInsiderSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    const link = env.data.months[0]?.events[0]?.document;
    assert.ok(link);
    assert.equal(link.id, "d1");
    assert.equal(link.likely, true);
  });

  it("does NOT query documents when the symbol has no filings", async () => {
    const h = mkDeps({ db: {} });
    const env = unwrap(
      await getStockInsiderSection(
        { symbol: "NOBODY", exchange: "NSE" },
        h.deps,
      ),
    );
    assert.equal(env.empty, true);
    assert.equal(
      h.calls.stockDocument.length,
      0,
      "an empty section costs one read",
    );
    assert.deepEqual(h.cacheSets, []);
  });

  it("uses the live TTL while the session is open", async () => {
    const h = mkDeps({ db: { insiderEvent: INSIDER_ROWS }, isLive: true });
    await getStockInsiderSection({ symbol: "ACME", exchange: "NSE" }, h.deps);
    assert.equal(h.cacheSets[0]?.ttl, 30 * 60);
    assert.equal(h.cacheSets[0]?.module, "discover");
    assert.equal(h.cacheSets[0]?.scope, "_global");
    assert.equal(h.cacheSets[0]?.key, "stock-insider:ACME");
  });

  it("a DB throw is a sanitised failure", async () => {
    const h = mkDeps({ db: { throwOn: "insiderEvent" } });
    const r = await getStockInsiderSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    );
    assert.equal(r.success, false);
    assert.equal(
      (r as { success: false; error: string }).error,
      "Failed to load insider activity",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.6 — deals
// ════════════════════════════════════════════════════════════════════════════

const DEAL_ROWS: Rec[] = [
  {
    id: "d1",
    date: daysAgo(1),
    securityName: "ACME LTD",
    clientName: "GRAVITON RESEARCH CAPITAL LLP",
    buySell: "BUY",
    qty: BigInt(120000),
    avgPrice: 12.5,
    dealType: "BULK",
    remarks: "-",
    source: "NSE_DEALS",
  },
  {
    id: "d2",
    date: daysAgo(45),
    securityName: "-",
    clientName: "Graviton Research Capital  LLP.",
    buySell: "SELL",
    qty: BigInt(20000),
    avgPrice: 13,
    dealType: "BLOCK",
    remarks: null,
    source: "NSE_DEALS",
  },
  {
    id: "d3",
    date: daysAgo(200),
    securityName: "ACME LTD",
    clientName: "ONE OFF FUND",
    buySell: "BUY",
    qty: BigInt(50),
    avgPrice: 11,
    dealType: "BULK",
    remarks: "Market Trade",
    source: "NSE_DEALS",
  },
];

describe("14c.6 getStockDealsSection", () => {
  it("coerces BigInt qty and keeps the payload serialisable", async () => {
    const h = mkDeps({ db: { institutionalDeal: DEAL_ROWS } });
    const env = unwrap(
      await getStockDealsSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    assert.doesNotThrow(() => JSON.stringify(env));
    assert.equal(env.data.deals[0]?.qty, 120000);
    assert.equal(typeof env.data.deals[0]?.qty, "number");
  });

  it("nulls a `-` remark and a missing security name — never the word null", async () => {
    const h = mkDeps({ db: { institutionalDeal: DEAL_ROWS } });
    const env = unwrap(
      await getStockDealsSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    assert.equal(env.data.deals[0]?.remarks, null);
    assert.equal(env.data.deals[1]?.securityName, null);
    assert.equal(env.data.deals[2]?.remarks, "Market Trade");
  });

  it("flags the repeat counterparty across spelling variants", async () => {
    const h = mkDeps({ db: { institutionalDeal: DEAL_ROWS } });
    const env = unwrap(
      await getStockDealsSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    assert.equal(env.data.repeatClients.length, 1);
    assert.equal(env.data.repeatClients[0]?.prints, 2);
    assert.equal(env.data.deals[0]?.repeatClient, true);
    assert.equal(
      env.data.deals[2]?.repeatClient,
      false,
      "a single print 200 days ago is not a repeat buyer",
    );
  });

  it("reads on symbol alone via the (symbol, date) index", async () => {
    const h = mkDeps({ db: { institutionalDeal: DEAL_ROWS } });
    await getStockDealsSection({ symbol: "ACME", exchange: "BSE" }, h.deps);
    const q = h.calls.institutionalDeal[0];
    assert.deepEqual(q?.where, { symbol: "ACME" });
    assert.deepEqual(q?.orderBy, { date: "desc" });
  });

  it("stamps NSE_DEALS provenance with the newest print's date", async () => {
    const h = mkDeps({ db: { institutionalDeal: DEAL_ROWS } });
    const env = unwrap(
      await getStockDealsSection({ symbol: "ACME", exchange: "NSE" }, h.deps),
    );
    assert.equal(env.source, "NSE_DEALS");
    assert.equal(env.asOf, daysAgo(1).toISOString());
    assert.equal(env.fallback, undefined);
    // BY KEY, not by position (MONEY-1205). The section now also writes the
    // market-wide `deals-feed-coverage` entry, and it lands FIRST because the
    // probe resolves inside the same `Promise.all` as the per-symbol read.
    // `cacheSets[0]` silently became a different cache entry; the assertion
    // that matters is that the section's own entry exists with its own TTL.
    const own = h.cacheSets.find((c) => c.key === "stock-deals:ACME");
    assert.ok(own, "the section must cache its own payload");
    assert.equal(own.ttl, 6 * 60 * 60);
  });

  it("a symbol with no prints is empty, successful and uncached", async () => {
    const h = mkDeps({ db: {} });
    const env = unwrap(
      await getStockDealsSection({ symbol: "NOBODY", exchange: "NSE" }, h.deps),
    );
    assert.equal(env.empty, true);
    assert.deepEqual(env.data.deals, []);
    assert.deepEqual(h.cacheSets, []);
  });

  it("a DB throw is a sanitised failure", async () => {
    const h = mkDeps({ db: { throwOn: "institutionalDeal" } });
    const r = await getStockDealsSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    );
    assert.equal(r.success, false);
    assert.equal(
      (r as { success: false; error: string }).error,
      "Failed to load bulk & block deals",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MONEY-1205 — the deals feed's covered window
// ════════════════════════════════════════════════════════════════════════════
//
// The section headlines `asOf` = THIS STOCK's newest print. On a quiet name
// that reads "latest 07 Nov 2024", which a reader parses as a dead feed. It is
// not: the newest print anywhere on prod is 2026-08-17. What is true is that
// the archive only became a daily job partway through — measured on prod
// 2026-08-17, the per-day market-wide counts are
//
//   08-17:104  08-13:132  08-12:120  08-11:108  08-10:152  08-07:114  08-04:58
//   08-03:2    07-30:3    07-29:2    07-24:3    07-21:2    …
//
// — a covered run of seven sessions sitting on top of a sparse sampled
// backfill. So the section states the WINDOW it can speak for, and the
// distinction is COMPUTED rather than asserted: a day the whole market
// produced two prints on did not have two prints.
//
// PROD SHAPE IS THE FIXTURE. A synthetic ladder would not have exercised the
// 4-day step from Mon 08-17 back to Thu 08-13 (Independence Day plus a
// weekend), which is the case a naive "consecutive calendar days" rule breaks
// on, nor the 58-print boundary day that sits just above the threshold.
describe("MONEY-1205 summariseDealsCoverage", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  /** The real prod distribution, newest first. */
  const PROD_DAYS = [
    { date: d("2026-08-17"), count: 104 },
    { date: d("2026-08-13"), count: 132 },
    { date: d("2026-08-12"), count: 120 },
    { date: d("2026-08-11"), count: 108 },
    { date: d("2026-08-10"), count: 152 },
    { date: d("2026-08-07"), count: 114 },
    { date: d("2026-08-04"), count: 58 },
    { date: d("2026-08-03"), count: 2 },
    { date: d("2026-07-30"), count: 3 },
    { date: d("2026-07-29"), count: 2 },
    { date: d("2026-07-24"), count: 3 },
    { date: d("2026-07-21"), count: 2 },
  ];

  it("finds the real run and stops at the backfill tail", () => {
    const c = summariseDealsCoverage(PROD_DAYS);
    assert.equal(c.latestDay, "2026-08-17");
    assert.equal(c.continuousFrom, "2026-08-04");
    assert.equal(c.continuousDays, 7, "seven covered sessions, not twelve");
  });

  it("[regression] a 4-day holiday step does not end the run", () => {
    // Mon 17th back to Thu 13th: a weekend plus Independence Day. A rule that
    // required consecutive calendar days would report a one-session window and
    // make the honest line look like a broken feed.
    const c = summariseDealsCoverage(PROD_DAYS.slice(0, 2));
    assert.equal(c.continuousFrom, "2026-08-13");
    assert.equal(c.continuousDays, 2);
  });

  it("[regression] a month-long hole DOES end the run", () => {
    // The other side of the same rule. Without a gap bound, a covered week in
    // August would swallow a sampled day in June and claim to cover both.
    const c = summariseDealsCoverage([
      { date: d("2026-08-17"), count: 104 },
      { date: d("2026-06-17"), count: 104 },
    ]);
    assert.equal(c.continuousDays, 1);
    assert.equal(c.continuousFrom, "2026-08-17");
  });

  it("[regression] a sparse day is not coverage however recent it is", () => {
    // The run must START at the newest day we hold. If the most recent session
    // is a two-print artefact there is no current coverage to describe, and
    // "continuous since 2026-08-04" with three empty weeks after it would be
    // the same lie in a new place.
    const c = summariseDealsCoverage([
      { date: d("2026-08-17"), count: 2 },
      ...PROD_DAYS.slice(1),
    ]);
    assert.equal(c.latestDay, "2026-08-17", "we still know the newest print");
    assert.equal(c.continuousFrom, null, "but we cannot claim daily coverage");
    assert.equal(c.continuousDays, 0);
  });

  it("is order-insensitive — it sorts its own input", () => {
    const shuffled = [...PROD_DAYS].reverse();
    assert.deepEqual(
      summariseDealsCoverage(shuffled),
      summariseDealsCoverage(PROD_DAYS),
    );
  });

  it("an empty or unparseable feed is null, never a fabricated window", () => {
    assert.deepEqual(summariseDealsCoverage([]), {
      latestDay: null,
      continuousFrom: null,
      continuousDays: 0,
    });
    assert.deepEqual(
      summariseDealsCoverage([{ date: "not-a-date", count: 99 }]),
      { latestDay: null, continuousFrom: null, continuousDays: 0 },
    );
  });
});

describe("MONEY-1205 describeDealsCoverage", () => {
  it("states the window rather than implying a series", () => {
    const note = describeDealsCoverage({
      latestDay: "2026-08-17",
      continuousFrom: "2026-08-04",
      continuousDays: 7,
    });
    assert.ok(note);
    assert.match(note, /04 Aug 2026/);
    assert.match(note, /17 Aug 2026/);
    assert.match(note, /7 sessions/);
    // The load-bearing clause: an absent older print is OUR gap, not evidence
    // that nothing was disclosed.
    assert.match(note, /not evidence of no print/);
  });

  it("[regression] says nothing about continuity it has not measured", () => {
    // "sparse before X" with no X is noise, and claiming a run we did not
    // observe is the bug this replaced.
    const note = describeDealsCoverage({
      latestDay: "2024-11-07",
      continuousFrom: null,
      continuousDays: 0,
    });
    assert.ok(note);
    assert.match(note, /07 Nov 2024/);
    assert.doesNotMatch(note, /Daily coverage|backfill/);
  });

  it("an unknown window produces no line at all", () => {
    // A probe that could not run means "we do not know how much we cover".
    // The panel then says nothing, which is the only honest reading — and it
    // is why the UI renders null rather than an empty sentence.
    assert.equal(describeDealsCoverage(null), undefined);
    assert.equal(
      describeDealsCoverage({
        latestDay: null,
        continuousFrom: null,
        continuousDays: 0,
      }),
      undefined,
    );
  });
});

describe("MONEY-1205 getStockDealsSection carries the window", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const DAYS = [
    { date: d("2026-08-14"), _n: 104 },
    { date: d("2026-08-13"), _n: 132 },
    { date: d("2026-08-12"), _n: 120 },
    { date: d("2026-08-11"), _n: 58 },
    { date: d("2026-08-10"), _n: 2 },
  ];

  it("puts the coverage window in the payload AND the envelope note", () => {
    // Both, deliberately: the panel renders `coverage`, while `note` is what
    // `/v1/stocks/:symbol/deals` and the provenance tooltip carry.
    const h = mkDeps({
      db: { institutionalDeal: DEAL_ROWS, institutionalDealDays: DAYS },
    });
    return getStockDealsSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    ).then((r) => {
      const env = unwrap(r);
      assert.equal(env.data.coverage?.latestDay, "2026-08-14");
      assert.equal(env.data.coverage?.continuousFrom, "2026-08-11");
      assert.equal(env.data.coverage?.continuousDays, 4);
      assert.match(String(env.note), /Daily coverage of this feed/);
    });
  });

  it("[regression] the probe is market-wide — it carries NO symbol filter", () => {
    // The whole point of the line is that it describes the FEED, not the
    // stock. A `symbol` predicate here would make a quiet name report that the
    // feed itself only covers the days that name happened to print on —
    // exactly the false impression the change removes.
    const h = mkDeps({
      db: { institutionalDeal: DEAL_ROWS, institutionalDealDays: DAYS },
    });
    return getStockDealsSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    ).then(() => {
      const probe = h.calls.institutionalDealGroupBy[0];
      assert.ok(probe, "the coverage probe must actually run");
      assert.deepEqual(probe.by, ["date"]);
      const where = probe.where as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(where),
        ["date"],
        "a symbol predicate here would describe the stock, not the feed",
      );
    });
  });

  it("[regression] caches the window under ONE global key, not per symbol", () => {
    // The answer is a property of the feed, so a per-symbol key would run the
    // same grouped scan once per stock page and cache thousands of copies of
    // one fact.
    const h = mkDeps({
      db: { institutionalDeal: DEAL_ROWS, institutionalDealDays: DAYS },
    });
    return getStockDealsSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    ).then(() => {
      const cov = h.cacheSets.find((c) => c.key === "deals-feed-coverage");
      assert.ok(cov, "the coverage probe must cache its answer");
      assert.doesNotMatch(String(cov.key), /ACME/);
    });
  });

  it("[regression] a 'we do not know' window is never cached", () => {
    // Standing rule: caching a couldn't-determine pins the failure for the
    // whole TTL. An empty probe window must stay re-askable.
    const h = mkDeps({
      db: { institutionalDeal: DEAL_ROWS, institutionalDealDays: [] },
    });
    return getStockDealsSection(
      { symbol: "ACME", exchange: "NSE" },
      h.deps,
    ).then((r) => {
      const env = unwrap(r);
      assert.equal(env.data.coverage?.latestDay, null);
      assert.equal(env.note, undefined, "no window, no sentence");
      assert.equal(
        h.cacheSets.find((c) => c.key === "deals-feed-coverage"),
        undefined,
      );
    });
  });
});
