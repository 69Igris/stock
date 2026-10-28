/**
 * Stock-page DOCUMENT sections service — MONEY-1204 (P14 / 14c.7 · 14c.8 · 14c.9).
 *
 * Runs the REAL service functions with a hand-rolled fake Prisma, fake cache and
 * fake market clock injected through `StockSectionsDocsDeps`. No DB, no Redis.
 *
 * What is pinned here is everything the pure helpers cannot see:
 *
 *   - **`textContent` is never selected.** `StockDocument.textContent` holds up
 *     to ~100KB per row; a 200-row timeline read that includes it moves ~20MB
 *     per request for a column nothing renders. A `findMany` with no `select`
 *     pulls it by DEFAULT, so this is a query-shape contract, not a style note.
 *   - the `upcoming_events` read filtering on `symbol` EXPLICITLY — the column
 *     is nullable for macro rows and an omitted filter pins RBI policy day onto
 *     every stock on the platform.
 *   - which reads are exchange-scoped and which are not, and why.
 *   - the cache KEY, the TTL, and the rule that an EMPTY or FAILED section is
 *     never written to cache.
 *   - the MF inverse lookup: ISIN-first with an instrumentId fallback, the two
 *     most recent DISCLOSURE months (not the last two calendar months), and no
 *     holdings query at all when there is nothing to join on.
 *   - a caught DB error never reaching the caller as its own message.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getStockFilingsTimeline,
  getStockFinancialsSource,
  getStockFundsHolding,
  type StockSectionsDocsDeps,
} from "../src/stock-sections-docs.service";
import {
  getMfPortfolioSection,
  type MfPortfolioDeps,
} from "../src/mf-portfolio-section.service";

type Rec = Record<string, unknown>;

const at = (iso: string): Date => new Date(iso);
const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

interface DbCfg {
  documents?: Rec[];
  events?: Rec[];
  financials?: Rec[];
  filings?: Rec[];
  instruments?: Rec[];
  /** Rows returned by `mfPortfolioHolding.findMany`, keyed by nothing. */
  mfRows?: Rec[];
  /** Distinct periods present, newest first — drives the two `findFirst`s. */
  mfPeriods?: Date[];
  /** Delegate name to blow up on, for the catch-path test. */
  throwOn?: string;
}

interface Calls {
  stockDocument: Rec[];
  upcomingEvent: Rec[];
  stockFinancials: Rec[];
  xbrlFiling: Rec[];
  instrumentMapping: Rec[];
  mfFindFirst: Rec[];
  mfFindMany: Rec[];
}

interface CacheSet {
  module: unknown;
  scope: unknown;
  key: unknown;
  data: unknown;
  ttl: unknown;
}

interface Harness {
  deps: StockSectionsDocsDeps;
  calls: Calls;
  cacheGets: Array<{ key: unknown }>;
  cacheSets: CacheSet[];
}

function mkDeps(
  opts: {
    db?: DbCfg;
    cached?: unknown;
    isLive?: boolean;
    now?: string;
  } = {},
): Harness {
  const cfg = opts.db ?? {};
  const calls: Calls = {
    stockDocument: [],
    upcomingEvent: [],
    stockFinancials: [],
    xbrlFiling: [],
    instrumentMapping: [],
    mfFindFirst: [],
    mfFindMany: [],
  };
  const cacheGets: Array<{ key: unknown }> = [];
  const cacheSets: CacheSet[] = [];

  const boom = (name: string): void => {
    if (cfg.throwOn === name) {
      throw new Error("db exploded: mongodb+srv://user:hunter2@cluster");
    }
  };

  const db = {
    stockDocument: {
      findMany: async (a: Rec) => {
        calls.stockDocument.push(a);
        boom("stockDocument");
        return cfg.documents ?? [];
      },
    },
    upcomingEvent: {
      findMany: async (a: Rec) => {
        calls.upcomingEvent.push(a);
        boom("upcomingEvent");
        return cfg.events ?? [];
      },
    },
    stockFinancials: {
      findMany: async (a: Rec) => {
        calls.stockFinancials.push(a);
        boom("stockFinancials");
        return cfg.financials ?? [];
      },
    },
    xbrlFiling: {
      findMany: async (a: Rec) => {
        calls.xbrlFiling.push(a);
        boom("xbrlFiling");
        return cfg.filings ?? [];
      },
    },
    instrumentMapping: {
      findMany: async (a: Rec) => {
        calls.instrumentMapping.push(a);
        boom("instrumentMapping");
        return cfg.instruments ?? [];
      },
    },
    mfPortfolioHolding: {
      findFirst: async (a: Rec) => {
        calls.mfFindFirst.push(a);
        boom("mfPortfolioHolding");
        const periods = cfg.mfPeriods ?? [];
        const where = a.where as { period?: { lt?: Date } } | undefined;
        const lt = where?.period?.lt;
        const candidates = lt
          ? periods.filter((p) => p.getTime() < lt.getTime())
          : periods;
        return candidates[0] ? { period: candidates[0] } : null;
      },
      /**
       * Applies the query — the `period` predicate, the `orderBy` and the
       * `take`. A fake that returns the fixture whole cannot see a cap that
       * straddles two months, which is the entire defect this guards.
       */
      findMany: async (a: Rec) => {
        calls.mfFindMany.push(a);
        const rows = (cfg.mfRows ?? []).slice();
        const where = a.where as
          | { period?: Date | { in?: Date[]; equals?: Date } }
          | undefined;
        const pred = where?.period;
        const wanted: number[] | null =
          pred instanceof Date
            ? [pred.getTime()]
            : pred && typeof pred === "object"
              ? [
                  ...(pred.in ?? []).map((d) => d.getTime()),
                  ...(pred.equals ? [pred.equals.getTime()] : []),
                ]
              : null;
        const filtered =
          wanted === null || wanted.length === 0
            ? rows
            : rows.filter((r) => wanted.includes((r.period as Date).getTime()));
        const orderBy = (
          Array.isArray(a.orderBy) ? a.orderBy : [a.orderBy ?? {}]
        ) as Array<Record<string, string>>;
        const sorted = filtered.sort((x, y) => {
          for (const clause of orderBy) {
            for (const [field, dir] of Object.entries(clause)) {
              const xv = x[field];
              const yv = y[field];
              const xn = xv instanceof Date ? xv.getTime() : Number(xv ?? 0);
              const yn = yv instanceof Date ? yv.getTime() : Number(yv ?? 0);
              if (xn !== yn) return dir === "desc" ? yn - xn : xn - yn;
            }
          }
          return 0;
        });
        return sorted.slice(0, Number(a.take ?? Number.MAX_SAFE_INTEGER));
      },
    },
  };

  const getCachedFake = async <T>(
    _module: unknown,
    _scope: unknown,
    key: unknown,
  ): Promise<T | null> => {
    cacheGets.push({ key });
    return (opts.cached as T | null | undefined) ?? null;
  };
  const setCachedFake = async <T>(
    module: unknown,
    scope: unknown,
    key: unknown,
    data: T,
    _filters?: unknown,
    config?: { ttl?: unknown },
  ): Promise<void> => {
    cacheSets.push({ module, scope, key, data, ttl: config?.ttl });
  };

  const deps: StockSectionsDocsDeps = {
    prisma: db as unknown as StockSectionsDocsDeps["prisma"],
    getCached: getCachedFake as unknown as StockSectionsDocsDeps["getCached"],
    setCached: setCachedFake as unknown as StockSectionsDocsDeps["setCached"],
    getNseMarketStatus: () => ({ isLive: opts.isLive ?? false }),
    now: () => at(opts.now ?? "2026-08-15T06:30:00.000Z"),
  };
  return { deps, calls, cacheGets, cacheSets };
}

const ARGS = { symbol: "RELIANCE", exchange: "NSE" };

// ════════════════════════════════════════════════════════════════════════════
// 14c.7 — filings timeline
// ════════════════════════════════════════════════════════════════════════════

const DOCS: Rec[] = [
  {
    id: "a",
    docType: "annual_report",
    period: "2025",
    title: "Annual Report FY25",
    description: null,
    sourceUrl: "https://nse/ar.pdf",
    sourceType: "NSE",
    processingStatus: "READY",
    fileSize: 1024,
    mimeType: "application/pdf",
    fetchedAt: at("2026-08-10T10:00:00.000Z"),
  },
  {
    id: "b",
    docType: "corporate_filing",
    period: "bse-1234",
    title: "Board meeting outcome",
    description: null,
    sourceUrl: "https://bse/x.pdf",
    sourceType: "BSE",
    processingStatus: "PENDING",
    fileSize: 0,
    mimeType: "application/pdf",
    fetchedAt: at("2026-08-14T10:00:00.000Z"),
  },
];

describe("14c.7 getStockFilingsTimeline", () => {
  it("cache HIT short-circuits before any query", async () => {
    const h = mkDeps({
      cached: {
        data: { pinned: null, items: [], counts: {}, notReadyCount: 0 },
        source: "NSE",
        asOf: null,
        empty: true,
      },
    });
    const r = await getStockFilingsTimeline(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(h.calls.stockDocument.length, 0);
    assert.equal(h.calls.upcomingEvent.length, 0);
    assert.equal(h.cacheGets[0]?.key, "stock-filings-timeline:RELIANCE");
  });

  it("NEVER selects `textContent` — the ~100KB-per-row column", async () => {
    // The contract this file exists for. A `findMany` with no `select` pulls
    // textContent by default; a 200-row read then moves ~20MB per request for
    // a column no list renders.
    const h = mkDeps({ db: { documents: DOCS } });
    await getStockFilingsTimeline(ARGS, h.deps);
    const select = h.calls.stockDocument[0]?.select as Rec;
    assert.ok(select, "the read MUST pass an explicit select");
    assert.equal("textContent" in select, false);
    assert.equal(select.title, true);
    assert.equal(select.processingStatus, true);
    assert.equal(select.fetchedAt, true);
  });

  it("keys the document read on symbol ALONE, not the page's exchange", async () => {
    // stock_documents is fed by NSE *and* BSE announcement syncs; scoping to
    // the page's exchange returns zero rows on a BSE view of a dual listing.
    const h = mkDeps({ db: { documents: DOCS } });
    await getStockFilingsTimeline(ARGS, h.deps);
    const where = h.calls.stockDocument[0]?.where as Rec;
    assert.deepEqual(where, { symbol: "RELIANCE" });
  });

  it("filters upcoming events on `symbol` EXPLICITLY and on future dates", async () => {
    // `symbol` is nullable — macro rows (RBI policy, US CPI) carry none, and an
    // omitted filter pins one RBI date onto every stock page.
    const h = mkDeps({ db: { documents: DOCS } });
    await getStockFilingsTimeline(ARGS, h.deps);
    const where = h.calls.upcomingEvent[0]?.where as {
      symbol?: unknown;
      date?: { gte?: Date };
    };
    assert.equal(where.symbol, "RELIANCE");
    assert.equal(
      where.date?.gte?.toISOString(),
      "2026-08-15T00:00:00.000Z",
      "the window starts at the UTC day, so an event dated today survives",
    );
  });

  it("surfaces a PENDING document rather than hiding it", async () => {
    const h = mkDeps({ db: { documents: DOCS } });
    const r = await getStockFilingsTimeline(ARGS, h.deps);
    assert.ok(r.success);
    // Looked up by ID, not by position: the claim under test is that the
    // PENDING row is PRESENT and correctly flagged, and reading it off
    // `items[0]` silently re-tests the sort order instead.
    const byId = new Map(r.data.data.items.map((d) => [d.id, d]));
    assert.deepEqual([...byId.keys()].sort(), ["a", "b"]);
    assert.equal(byId.get("b")?.status, "PENDING");
    assert.equal(byId.get("b")?.readable, false);
    assert.equal(byId.get("a")?.readable, true);
    assert.equal(r.data.data.notReadyCount, 1);
  });

  it("orders by PERIOD, not by the order the scrape happened to write", async () => {
    // MONEY-1255, service-level. The fixture is the GOODYEAR shape reduced to
    // its essentials: an OLDER fiscal year scraped LATER, plus an announcement
    // whose period names no date at all.
    //
    // It is built here rather than reusing DOCS on purpose. Under the fallback
    // contract, DOCS produces the SAME order under the old comparator and the
    // new one, so asserting on it would prove nothing — a shadow test. These
    // three rows disagree: an `indexedAt`-first comparator returns
    // ["fy2010", "fy2025", "ann"], and only the period-first one returns this.
    const h = mkDeps({
      db: {
        documents: [
          {
            id: "fy2025",
            docType: "annual_report",
            period: "FY2025",
            title: "Annual Report 2025",
            sourceType: "SCREENER",
            processingStatus: "PENDING",
            fetchedAt: at("2026-04-19T17:33:39.000Z"),
          },
          {
            id: "fy2010",
            docType: "annual_report",
            period: "FY2010",
            title: "Annual Report 2010",
            sourceType: "SCREENER",
            processingStatus: "PENDING",
            // Scraped LAST, and therefore first under the old ordering.
            fetchedAt: at("2026-04-23T12:05:00.000Z"),
          },
          {
            id: "ann",
            docType: "corporate_filing",
            period: "nse-106748636",
            title: "Earnings call intimation",
            sourceType: "NSE",
            processingStatus: "PENDING",
            // No readable period, so this one DOES ride its ingest day — and
            // that day (Aug) is later than either annual report's, so it leads.
            fetchedAt: at("2026-08-25T09:00:00.000Z"),
          },
        ],
      },
    });
    const r = await getStockFilingsTimeline(ARGS, h.deps);
    assert.ok(r.success);
    assert.deepEqual(
      r.data.data.items.map((d) => d.id),
      ["ann", "fy2025", "fy2010"],
    );
  });

  it("stamps asOf from the newest INDEX time and labels the source feed", async () => {
    const h = mkDeps({ db: { documents: DOCS } });
    const r = await getStockFilingsTimeline(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.asOf, "2026-08-14T10:00:00.000Z");
    // Two feeds present; the dominant one labels the chip and the note says so.
    assert.ok(r.data.source === "NSE" || r.data.source === "BSE");
    assert.match(String(r.data.note), /2 source feeds/);
    assert.match(String(r.data.note), /no filing date/i);
  });

  it("caches a populated section with the closed-market TTL", async () => {
    const h = mkDeps({ db: { documents: DOCS } });
    await getStockFilingsTimeline(ARGS, h.deps);
    assert.equal(h.cacheSets.length, 1);
    assert.equal(h.cacheSets[0]?.module, "discover");
    assert.equal(h.cacheSets[0]?.scope, "_global");
    assert.equal(h.cacheSets[0]?.ttl, 60 * 60);
    const live = mkDeps({ db: { documents: DOCS }, isLive: true });
    await getStockFilingsTimeline(ARGS, live.deps);
    assert.equal(live.cacheSets[0]?.ttl, 30 * 60);
  });

  it("NEVER caches an empty section", async () => {
    const h = mkDeps({ db: { documents: [], events: [] } });
    const r = await getStockFilingsTimeline(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, true);
    assert.equal(h.cacheSets.length, 0);
  });

  it("a pinned event with ZERO documents is not empty", async () => {
    const h = mkDeps({
      db: {
        documents: [],
        events: [
          {
            id: "e",
            date: day("2026-08-20"),
            symbol: "RELIANCE",
            title: "Board meeting",
            category: "earnings",
            source: "NSE",
          },
        ],
      },
    });
    const r = await getStockFilingsTimeline(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, false);
    assert.equal(r.data.data.pinned?.daysAway, 5);
    assert.equal(h.cacheSets.length, 1);
  });

  it("a DB error returns a short message and NEVER caches it", async () => {
    const h = mkDeps({ db: { throwOn: "stockDocument" } });
    const r = await getStockFilingsTimeline(ARGS, h.deps);
    assert.equal(r.success, false);
    assert.equal(
      r.success === false && r.error,
      "Failed to load filings timeline",
    );
    assert.equal(
      r.success === false && /hunter2|mongodb/.test(r.error),
      false,
      "a raw DB message must not reach the caller",
    );
    assert.equal(h.cacheSets.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.8 — financials source badge + basis toggle
// ════════════════════════════════════════════════════════════════════════════

const Q3_END = day("2025-12-31");
const FILINGS: Rec[] = [
  {
    id: "cons-q3",
    periodStart: day("2025-10-01"),
    periodEnd: Q3_END,
    periodType: "QUARTERLY",
    basis: "CONSOLIDATED",
    cumulative: false,
    audited: false,
    coverage: 0.82,
    conceptsFound: ["Revenue"],
    sourceUrl: "https://nse/a.xml",
    filedAt: at("2026-01-20T00:00:00.000Z"),
    taxonomyVersion: "2020-03-31",
  },
  {
    id: "cons-9m",
    periodStart: day("2025-04-01"),
    periodEnd: Q3_END,
    periodType: "QUARTERLY",
    basis: "CONSOLIDATED",
    cumulative: true,
    audited: false,
    coverage: 0.8,
    conceptsFound: ["Revenue"],
    sourceUrl: "https://nse/b.xml",
    filedAt: at("2026-01-20T00:00:00.000Z"),
    taxonomyVersion: "2020-03-31",
  },
  {
    id: "std-q3",
    periodStart: day("2025-10-01"),
    periodEnd: Q3_END,
    periodType: "QUARTERLY",
    basis: "STANDALONE",
    cumulative: false,
    audited: false,
    coverage: 0.7,
    conceptsFound: ["Revenue"],
    sourceUrl: "https://nse/c.xml",
    filedAt: at("2026-01-20T00:00:00.000Z"),
    taxonomyVersion: "2020-03-31",
  },
];

describe("14c.8 getStockFinancialsSource", () => {
  it("reads `source` from the rows — it does NOT hardcode TICKERTAPE", async () => {
    // Today every row genuinely reads TICKERTAPE (the XBRL switchover is not
    // armed), which is exactly why the badge must read rather than assert.
    const h = mkDeps({
      db: {
        financials: [
          {
            period: "Q1-2026",
            source: "TICKERTAPE",
            fetchedAt: at("2026-08-01T00:00:00.000Z"),
            rawData: null,
          },
        ],
      },
    });
    const r = await getStockFinancialsSource(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.data.badge.primary, "TICKERTAPE");
    assert.equal(r.data.source, "TICKERTAPE");

    const flipped = mkDeps({
      db: {
        financials: [
          {
            period: "Q1-2026",
            source: "NSE_XBRL",
            fetchedAt: null,
            rawData: null,
          },
        ],
      },
    });
    const r2 = await getStockFinancialsSource(ARGS, flipped.deps);
    assert.ok(r2.success);
    assert.equal(r2.data.data.badge.primary, "NSE_XBRL");
  });

  it("SELECTS `source` — the column the incumbent reader omits", async () => {
    // The whole section is inert without it. `stock-tabs.ts` / `stock-tabs.service.ts`
    // do not select it, which is the three-place change this ticket reports.
    const h = mkDeps({ db: { financials: [{ source: "TICKERTAPE" }] } });
    await getStockFinancialsSource(ARGS, h.deps);
    const select = h.calls.stockFinancials[0]?.select as Rec;
    assert.equal(select.source, true);
    assert.equal(
      select.rawData,
      true,
      "the displacement audit trail lives here",
    );
  });

  it("scopes the financials read by exchange and the filings read by symbol", async () => {
    // The badge must describe the SAME rows the numbers come from
    // (`stock_financials` has exchange in its unique key). `xbrl_filings` is an
    // NSE feed, so a BSE view must still see it.
    const h = mkDeps({
      db: { financials: [{ source: "TICKERTAPE" }], filings: FILINGS },
    });
    await getStockFinancialsSource(
      { symbol: "RELIANCE", exchange: "BSE" },
      h.deps,
    );
    assert.deepEqual(h.calls.stockFinancials[0]?.where, {
      symbol: "RELIANCE",
      exchange: "BSE",
    });
    assert.deepEqual(h.calls.xbrlFiling[0]?.where, { symbol: "RELIANCE" });
  });

  it("ships one bucket per (basis, cumulative) so no series can be merged", async () => {
    const h = mkDeps({
      db: { financials: [{ source: "TICKERTAPE" }], filings: FILINGS },
    });
    const r = await getStockFinancialsSource(ARGS, h.deps);
    assert.ok(r.success);
    const views = r.data.data.views;
    assert.deepEqual(views.map((v) => `${v.basis}:${v.cumulative}`).sort(), [
      "CONSOLIDATED:false",
      "CONSOLIDATED:true",
      "STANDALONE:false",
    ]);
    for (const v of views) {
      assert.equal(
        v.periods.every((p) => p.basis === v.basis),
        true,
      );
      assert.equal(
        v.periods.every((p) => p.cumulative === v.cumulative),
        true,
      );
    }
    // Q3 and the nine-month cumulative share a periodEnd and are in DIFFERENT
    // buckets — the merge the schema warns about is structurally impossible.
    const disc = views.find(
      (v) => v.basis === "CONSOLIDATED" && !v.cumulative,
    )!;
    const cum = views.find((v) => v.basis === "CONSOLIDATED" && v.cumulative)!;
    assert.deepEqual(
      disc.periods.map((p) => p.id),
      ["cons-q3"],
    );
    assert.deepEqual(
      cum.periods.map((p) => p.id),
      ["cons-9m"],
    );
    assert.equal(r.data.data.defaultBasis, "CONSOLIDATED");
  });

  it("a populated badge with ZERO filings is a real state, not empty", async () => {
    // It is today's state for every stock on the platform.
    const h = mkDeps({
      db: {
        financials: [
          { source: "TICKERTAPE", fetchedAt: at("2026-08-01T00:00:00.000Z") },
        ],
        filings: [],
      },
    });
    const r = await getStockFinancialsSource(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, false);
    assert.equal(r.data.data.filingsEmpty, true);
    assert.match(String(r.data.note), /No XBRL filing/i);
    assert.equal(h.cacheSets[0]?.ttl, 6 * 60 * 60);
  });

  it("no financials AND no filings ⇒ empty, and nothing is cached", async () => {
    const h = mkDeps({ db: { financials: [], filings: [] } });
    const r = await getStockFinancialsSource(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, true);
    assert.equal(r.data.source, null);
    assert.equal(h.cacheSets.length, 0);
  });

  it("a DB error returns a short message and NEVER caches it", async () => {
    const h = mkDeps({ db: { throwOn: "xbrlFiling" } });
    const r = await getStockFinancialsSource(ARGS, h.deps);
    assert.equal(r.success, false);
    assert.equal(
      r.success === false && r.error,
      "Failed to load financials provenance",
    );
    assert.equal(h.cacheSets.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.9 — funds holding this stock
// ════════════════════════════════════════════════════════════════════════════

const MF_ROWS = (jul: Date, jun: Date): Rec[] => [
  {
    period: jul,
    amc: "SBI",
    schemeName: "SBI Bluechip Fund",
    schemeKey: "sbi bluechip",
    amfiSchemeCode: "103504",
    isin: "INE002A01018",
    instrumentId: "i1",
    instrumentName: "Reliance Industries Ltd",
    holdingType: "EQUITY",
    quantity: 1000,
    marketValue: 250,
    percentToNav: 3.5,
  },
  {
    period: jun,
    amc: "SBI",
    schemeName: "SBI Bluechip Fund",
    schemeKey: "sbi bluechip",
    amfiSchemeCode: "103504",
    isin: "INE002A01018",
    instrumentId: "i1",
    instrumentName: "Reliance Industries Ltd",
    holdingType: "EQUITY",
    quantity: 900,
    marketValue: 220,
    percentToNav: 3,
  },
  {
    period: jun,
    amc: "HDFC",
    schemeName: "HDFC Flexi Cap",
    schemeKey: "hdfc flexi cap",
    amfiSchemeCode: null,
    isin: "INE002A01018",
    instrumentId: "i1",
    instrumentName: "Reliance Industries Ltd",
    holdingType: "EQUITY",
    quantity: 100,
    marketValue: 25,
    percentToNav: 1,
  },
];

describe("14c.9 getStockFundsHolding", () => {
  const JUL = day("2026-07-01");
  const JUN = day("2026-06-01");
  const instruments = [
    { id: "i1", isin: "ine002a01018" },
    { id: "i2", isin: "INE002A01018" },
  ];

  it("joins ISIN-first with an instrumentId fallback, uppercased and deduped", async () => {
    // mf_portfolio_holdings has NO symbol column. Both keys are nullable by
    // design, so both go into the OR.
    const h = mkDeps({
      db: { instruments, mfPeriods: [JUL, JUN], mfRows: MF_ROWS(JUL, JUN) },
    });
    await getStockFundsHolding(ARGS, h.deps);
    const or = (h.calls.mfFindFirst[0]?.where as { OR?: Rec[] }).OR ?? [];
    assert.deepEqual(or[0], { isin: { in: ["INE002A01018"] } });
    assert.deepEqual(or[1], { instrumentId: { in: ["i1", "i2"] } });
    // The instrument resolution itself is exchange-agnostic: one company, one
    // ISIN, two listings.
    assert.deepEqual(h.calls.instrumentMapping[0]?.where, {
      symbol: "RELIANCE",
    });
  });

  it("reads the two most recent DISCLOSURE months, not the last two calendar months", async () => {
    // AMCs file at different times and Nippon publishes only the current month;
    // a fixed two-month window shows an empty panel for most of every month.
    const MAR = day("2026-03-01");
    const h = mkDeps({
      db: {
        instruments,
        mfPeriods: [JUL, MAR],
        mfRows: MF_ROWS(JUL, MAR),
      },
    });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(h.calls.mfFindFirst.length, 2);
    assert.deepEqual(
      (h.calls.mfFindFirst[1]?.where as { period?: { lt?: Date } }).period?.lt,
      JUL,
    );
    // ONE bounded read PER PERIOD — a single `period: { in: [...] }` read with
    // a shared cap lets the newest month eat the older one's rows whole.
    assert.equal(h.calls.mfFindMany.length, 2);
    const periods = h.calls.mfFindMany.map(
      (c) => (c.where as { period?: Date }).period,
    );
    assert.deepEqual(periods, [JUL, MAR]);
    // …and the non-consecutive pair is FLAGGED rather than mislabelled.
    assert.equal(r.data.data.monthGap, true);
    assert.match(String(r.data.note), /not consecutive/i);
  });

  it("produces the fund count, combined weight and MoM diff", async () => {
    const h = mkDeps({
      db: { instruments, mfPeriods: [JUL, JUN], mfRows: MF_ROWS(JUL, JUN) },
    });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    const s = r.data.data;
    assert.equal(s.fundCount, 1);
    assert.equal(s.combinedWeightPct, 3.5);
    assert.deepEqual(s.entered, []);
    assert.deepEqual(
      s.exited.map((f) => f.schemeKey),
      ["hdfc flexi cap"],
    );
    assert.equal(s.funds[0]?.deltaPct, 0.5);
    assert.equal(s.funds[0]?.href, "/mf/103504");
    // The exited scheme has no AMFI code — it still renders, just unlinked.
    assert.equal(s.exited[0]?.href, null);
    assert.equal(s.exited[0]?.schemeName, "HDFC Flexi Cap");
  });

  it("a big month must not eat the prior month's rows and fabricate `entered`", async () => {
    // B6 — `orderBy: [{ period: "desc" }, …]` with ONE shared `take` puts the
    // whole newest month first, so the cap lands INSIDE the prior month. Every
    // scheme whose prior-month row fell off the end then looks brand new, and
    // the funds panel renders it as a fund that ENTERED the stock this month.
    // One Nifty-500 index fund is ~500 rows a month, so two months is already
    // over the 800-row cap on a widely-held name.
    const N = 600;
    const rows: Rec[] = [];
    for (const period of [JUL, JUN]) {
      for (let i = 0; i < N; i++) {
        rows.push({
          period,
          amc: "ACME AMC",
          schemeName: `ACME Fund ${i}`,
          schemeKey: `acme fund ${i}`,
          amfiSchemeCode: String(100000 + i),
          isin: "INE002A01018",
          instrumentId: "i1",
          instrumentName: "Reliance Industries Ltd",
          holdingType: "EQUITY",
          quantity: 1,
          marketValue: 1,
          percentToNav: 1,
        });
      }
    }
    const h = mkDeps({
      db: { instruments, mfPeriods: [JUL, JUN], mfRows: rows },
    });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    const s = r.data.data;
    assert.equal(s.fundCount, N, "every holder of the newest month");
    assert.deepEqual(s.entered, [], "nobody entered — the same 600 held both");
    assert.deepEqual(s.exited, [], "and nobody exited");
    assert.equal(s.comparable, true);
  });

  it("stamps asOf with the DISCLOSURE month, never the ingest time", async () => {
    const h = mkDeps({
      db: { instruments, mfPeriods: [JUL, JUN], mfRows: MF_ROWS(JUL, JUN) },
    });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.asOf, JUL.toISOString());
    assert.equal(r.data.source, "amc-portfolio-disclosure");
    assert.equal(h.cacheSets[0]?.ttl, 6 * 60 * 60);
  });

  it("no ISIN and no instrument row ⇒ honest empty, and NO holdings query", async () => {
    const h = mkDeps({ db: { instruments: [] } });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, true);
    assert.equal(r.data.data.fundCount, 0);
    assert.match(String(r.data.note), /No ISIN/i);
    assert.equal(h.calls.mfFindFirst.length, 0, "no unfiltered fallback query");
    assert.equal(h.calls.mfFindMany.length, 0);
    assert.equal(h.cacheSets.length, 0, "an empty section is never cached");
  });

  it("an instrument with no ISIN still joins on instrumentId", async () => {
    const h = mkDeps({
      db: {
        instruments: [{ id: "i9", isin: null }],
        mfPeriods: [JUL],
        mfRows: [{ ...MF_ROWS(JUL, JUN)[0]!, isin: null, instrumentId: "i9" }],
      },
    });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    const or = (h.calls.mfFindFirst[0]?.where as { OR?: Rec[] }).OR ?? [];
    assert.equal(or.length, 1);
    assert.deepEqual(or[0], { instrumentId: { in: ["i9"] } });
    assert.equal(r.data.data.fundCount, 1);
    assert.equal(r.data.data.comparable, false);
  });

  it("no disclosure months at all ⇒ empty without a rows query", async () => {
    const h = mkDeps({ db: { instruments, mfPeriods: [] } });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, true);
    assert.equal(h.calls.mfFindMany.length, 0);
    assert.equal(h.cacheSets.length, 0);
  });

  it("a DB error returns a short message and NEVER caches it", async () => {
    const h = mkDeps({ db: { throwOn: "instrumentMapping" } });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.equal(r.success, false);
    assert.equal(
      r.success === false && r.error,
      "Failed to load fund ownership",
    );
    assert.equal(r.success === false && /hunter2/.test(r.error), false);
    assert.equal(h.cacheSets.length, 0);
  });

  it("cache HIT short-circuits before resolving the instrument", async () => {
    const h = mkDeps({
      cached: {
        data: { fundCount: 0, funds: [], entered: [], exited: [] },
        source: "amc-portfolio-disclosure",
        asOf: null,
        empty: true,
      },
    });
    const r = await getStockFundsHolding(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(h.calls.instrumentMapping.length, 0);
    assert.equal(h.cacheGets[0]?.key, "stock-funds-holding:RELIANCE");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14d.1 — MF portfolio section
//
// Lives in THIS file rather than its own: it is the same defect as 14c.9's
// (`take` shared across two disclosure months) in the second reader of
// `mf_portfolio_holdings`, and the two must not drift apart again.
// ════════════════════════════════════════════════════════════════════════════

interface MfHarness {
  deps: MfPortfolioDeps;
  findFirst: Rec[];
  findMany: Rec[];
}

/** A fake `mf_portfolio_holdings` that APPLIES the period predicate + `take`. */
function mkMfDeps(rows: Rec[]): MfHarness {
  const findFirst: Rec[] = [];
  const findMany: Rec[] = [];
  const periodOf = (r: Rec): number => (r.period as Date).getTime();

  const db = {
    mfPortfolioHolding: {
      findFirst: async (a: Rec) => {
        findFirst.push(a);
        const where = a.where as { period?: { lt?: Date } } | undefined;
        const lt = where?.period?.lt;
        const times = [...new Set(rows.map(periodOf))]
          .filter((t) => (lt ? t < lt.getTime() : true))
          .sort((x, y) => y - x);
        return times[0] === undefined ? null : { period: new Date(times[0]) };
      },
      findMany: async (a: Rec) => {
        findMany.push(a);
        const where = a.where as { period?: Date } | undefined;
        const want = where?.period;
        const filtered = want
          ? rows.filter((r) => periodOf(r) === want.getTime())
          : rows.slice();
        const clauses = (
          Array.isArray(a.orderBy) ? a.orderBy : [a.orderBy ?? {}]
        ) as Array<Record<string, string>>;
        const sorted = filtered.sort((x, y) => {
          for (const clause of clauses) {
            for (const [field, dir] of Object.entries(clause)) {
              const xv = x[field];
              const yv = y[field];
              const xn = xv instanceof Date ? xv.getTime() : Number(xv ?? 0);
              const yn = yv instanceof Date ? yv.getTime() : Number(yv ?? 0);
              if (xn !== yn) return dir === "desc" ? yn - xn : xn - yn;
            }
          }
          return 0;
        });
        return sorted.slice(0, Number(a.take ?? Number.MAX_SAFE_INTEGER));
      },
    },
    fundHolding: { findMany: async () => [] },
  };

  return {
    deps: {
      prisma: db as unknown as MfPortfolioDeps["prisma"],
      getCached: (async () => null) as unknown as MfPortfolioDeps["getCached"],
      setCached: (async () =>
        undefined) as unknown as MfPortfolioDeps["setCached"],
      getNseMarketStatus: () => ({ isLive: false }),
    },
    findFirst,
    findMany,
  };
}

describe("14d.1 getMfPortfolioSection", () => {
  const JUL = day("2026-07-01");
  const JUN = day("2026-06-01");

  it("does not let the newest month's rows starve the month it is diffed against", async () => {
    // B6 (second reader) — `orderBy: { period: "desc" }, take: 800` across BOTH
    // months puts the whole newest month first, so the cut lands inside the
    // prior month and every scheme cut off reads as newly bought. For a fund
    // portfolio that is not "a fund entered the stock" but "this scheme bought
    // 400 new positions this month", printed as fact. An index fund tracking
    // the Nifty 500 discloses ~500 rows a month, so two months is over the cap.
    const N = 600;
    const rows: Rec[] = [];
    for (const period of [JUL, JUN]) {
      for (let i = 0; i < N; i++) {
        rows.push({
          period,
          amc: "ACME AMC",
          schemeKey: "acme index fund",
          amfiSchemeCode: "103504",
          instrumentName: `HOLDING ${i}`,
          isin: `INE${String(i).padStart(9, "0")}`,
          holdingType: "EQUITY",
          quantity: 1,
          marketValue: 1,
          percentToNav: 1,
          source: "AMC",
        });
      }
    }
    const h = mkMfDeps(rows);
    const r = await getMfPortfolioSection({ schemeCode: "103504" }, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.data.lines.length, N);
    assert.deepEqual(r.data.data.diff.entered, [], "nothing was bought");
    assert.deepEqual(r.data.data.diff.exited, [], "and nothing was sold");
    assert.equal(r.data.asOf, JUL.toISOString());
  });

  it("reads ONE bounded page per disclosure month", async () => {
    const rows: Rec[] = [JUL, JUN].map((period, i) => ({
      period,
      amc: "ACME AMC",
      schemeKey: "acme index fund",
      amfiSchemeCode: "103504",
      instrumentName: `HOLDING ${i}`,
      isin: null,
      holdingType: "EQUITY",
      quantity: 1,
      marketValue: 1,
      percentToNav: 1,
      source: "AMC",
    }));
    const h = mkMfDeps(rows);
    const r = await getMfPortfolioSection({ schemeCode: "103504" }, h.deps);
    assert.ok(r.success);
    assert.equal(h.findMany.length, 2);
    assert.deepEqual(
      h.findMany.map((c) => (c.where as { period?: Date }).period),
      [JUL, JUN],
    );
    for (const call of h.findMany) {
      assert.equal(call.take, 800, "the cap is PER month");
      assert.ok(
        call.orderBy,
        "an explicit sort — two identical reads must not disagree on the cut",
      );
    }
  });

  it("a scheme with a single disclosure month diffs against nothing", async () => {
    // One month on file is not "everything entered this month".
    const rows: Rec[] = [
      {
        period: JUL,
        amc: "ACME AMC",
        schemeKey: "acme index fund",
        amfiSchemeCode: "103504",
        instrumentName: "HOLDING 0",
        isin: null,
        holdingType: "EQUITY",
        quantity: 1,
        marketValue: 1,
        percentToNav: 1,
        source: "AMC",
      },
    ];
    const h = mkMfDeps(rows);
    const r = await getMfPortfolioSection({ schemeCode: "103504" }, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.data.lines.length, 1);
    assert.deepEqual(r.data.data.diff.entered, []);
    assert.equal(r.data.data.diff.previousPeriod, null);
  });

  it("no official disclosure at all falls back, labelled", async () => {
    const h = mkMfDeps([]);
    const r = await getMfPortfolioSection({ schemeCode: "999999" }, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, true);
    assert.equal(r.data.data.lines.length, 0);
  });
});
