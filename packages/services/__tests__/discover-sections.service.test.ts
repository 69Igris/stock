/**
 * Discover data-engine sections service — MONEY-1204 (P14 / 14d.2 · 14d.3 ·
 * 14d.5 · 14d.6).
 *
 * Runs the REAL service functions against a hand-rolled fake Prisma, fake cache
 * and injected clock, through `DiscoverSectionsDeps`. No DB, no Redis.
 *
 * What is pinned here is everything the pure helpers cannot see:
 *
 *   - THE METRIC FILTER on `market_positioning`. The table holds two feeds at
 *     incompatible grains keyed on the same (date, participant); a query that
 *     drops `metric` returns both and every aggregate built on it is roughly
 *     double. The pure builder refuses such a set, but the query is what keeps
 *     it from arriving — and a refactor that widens the `where` would still
 *     pass every pure test.
 *   - `index_constituents` is read BY `indexId`, and NOT read at all for an
 *     index we hold no constituent list for. That model has no `[symbol]`
 *     index; a symbol-first or unfiltered read is a collection scan per view.
 *   - the IST DAY reaching the bucketer, and the cache key CARRYING it, so the
 *     IPO tabs roll over with IST rather than living in Redis across the
 *     boundary they were computed on.
 *   - the cache KEY, the live-vs-closed TTL, and the rule that an EMPTY section
 *     is never written to cache.
 *   - errors coming back sanitised rather than leaking the DB message.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getCircularFeed,
  getCircularsForSymbol,
  getIndexDetail,
  getInstitutionalFlows,
  getIpoDashboardCard,
  getIpoSections,
  getMacroStrip,
  getMarketPositioning,
  type DiscoverSectionsDeps,
} from "../src/discover-sections.service";

const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

type Rec = Record<string, unknown>;

interface DbCfg {
  flows?: Rec[];
  positioning?: Rec[];
  macro?: Rec[];
  ipos?: Rec[];
  circulars?: Rec[];
  closes?: Rec[];
  constituents?: Rec[];
  memberships?: Rec[];
  /** Delegate name to blow up on, for the catch-path tests. */
  throwOn?: string;
}

interface Calls {
  institutionalFlow: Rec[];
  marketPositioning: Rec[];
  macroSeries: Rec[];
  upcomingIpo: Rec[];
  nseCircular: Rec[];
  indexClose: Rec[];
  indexConstituent: Rec[];
  indexMembership: Rec[];
}

interface CacheWrite {
  module: string;
  scope: string;
  key: string;
  ttl: number | undefined;
}

interface Harness {
  deps: DiscoverSectionsDeps;
  calls: Calls;
  writes: CacheWrite[];
  reads: string[];
}

function harness(
  cfg: DbCfg = {},
  opts: {
    isLive?: boolean;
    now?: string;
    cacheHit?: unknown;
  } = {},
): Harness {
  const calls: Calls = {
    institutionalFlow: [],
    marketPositioning: [],
    macroSeries: [],
    upcomingIpo: [],
    nseCircular: [],
    indexClose: [],
    indexConstituent: [],
    indexMembership: [],
  };
  const writes: CacheWrite[] = [];
  const reads: string[] = [];

  const delegate = (name: keyof Calls, rows: Rec[] | undefined) => ({
    findMany: async (args: Rec) => {
      calls[name].push(args);
      if (cfg.throwOn === name) {
        throw new Error(
          `E11000 duplicate key error collection: usemoney.${name} index: _id_`,
        );
      }
      const take = typeof args.take === "number" ? args.take : undefined;
      const list = rows ?? [];
      return take === undefined ? list : list.slice(0, take);
    },
  });

  const db = {
    institutionalFlow: delegate("institutionalFlow", cfg.flows),
    marketPositioning: delegate("marketPositioning", cfg.positioning),
    macroSeries: delegate("macroSeries", cfg.macro),
    upcomingIpo: delegate("upcomingIpo", cfg.ipos),
    nseCircular: delegate("nseCircular", cfg.circulars),
    indexClose: delegate("indexClose", cfg.closes),
    indexConstituent: delegate("indexConstituent", cfg.constituents),
    indexMembership: delegate("indexMembership", cfg.memberships),
  };

  const deps: DiscoverSectionsDeps = {
    prisma: db as unknown as DiscoverSectionsDeps["prisma"],
    getCached: (async (
      module: string,
      scope: string,
      key: string,
    ): Promise<unknown> => {
      reads.push(`${module}/${scope}/${key}`);
      return opts.cacheHit ?? null;
    }) as unknown as DiscoverSectionsDeps["getCached"],
    setCached: (async (
      module: string,
      scope: string,
      key: string,
      _data: unknown,
      _filters: unknown,
      config?: { ttl?: number },
    ): Promise<void> => {
      writes.push({ module, scope, key, ttl: config?.ttl });
    }) as unknown as DiscoverSectionsDeps["setCached"],
    getNseMarketStatus: () => ({ isLive: opts.isLive === true }),
    now: () => new Date(opts.now ?? "2026-08-16T06:00:00.000Z"),
  };

  return { deps, calls, writes, reads };
}

const ok = <T>(res: { success: boolean } & Record<string, unknown>): T => {
  assert.equal(
    res.success,
    true,
    `expected success, got ${JSON.stringify(res)}`,
  );
  return (res as unknown as { data: T }).data;
};

// ════════════════════════════════════════════════════════════════════════════
// 14d.2 (a) — FII/DII flows
// ════════════════════════════════════════════════════════════════════════════

describe("14d.2 getInstitutionalFlows", () => {
  const flows = [
    {
      date: day("2026-08-13"),
      category: "FII",
      segment: "CASH",
      buyValue: 12000,
      sellValue: 11000,
      netValue: 1000,
    },
    {
      date: day("2026-08-14"),
      category: "FII",
      segment: "CASH",
      buyValue: 9000,
      sellValue: 9500,
      netValue: -500,
    },
    {
      date: day("2026-08-14"),
      category: "DII",
      segment: "CASH",
      buyValue: 8000,
      sellValue: 7000,
      netValue: 1000,
    },
  ];

  it("issues ONE bounded read PER CATEGORY on the (category, date desc) index", async () => {
    const h = harness({ flows });
    await getInstitutionalFlows({ windowSessions: 20 }, h.deps);
    assert.equal(h.calls.institutionalFlow.length, 2);
    const categories = h.calls.institutionalFlow.map(
      (c) => (c.where as Rec).category,
    );
    assert.deepEqual(categories.sort(), ["DII", "FII"]);
    for (const c of h.calls.institutionalFlow) {
      assert.deepEqual(c.orderBy, { date: "desc" });
      assert.equal((c.where as Rec).segment, "CASH");
      assert.ok(typeof c.take === "number" && (c.take as number) > 0);
    }
  });

  it("labels the payload ₹ crore and stamps the newest session", async () => {
    const h = harness({ flows });
    const env = ok<{
      data: { unit: string; series: Array<{ category: string }> };
      asOf: string | null;
      source: string | null;
      empty: boolean;
    }>(await getInstitutionalFlows({}, h.deps));
    assert.equal(env.data.unit, "INR_CRORE");
    assert.equal(env.asOf, "2026-08-14");
    assert.equal(env.source, "NSE_FII_DII_CASH");
    assert.equal(env.empty, false);
  });

  it("writes the closed-market TTL under the discover/_global namespace", async () => {
    const h = harness({ flows }, { isLive: false });
    await getInstitutionalFlows({ windowSessions: 20 }, h.deps);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(
      { module: h.writes[0]?.module, scope: h.writes[0]?.scope },
      { module: "discover", scope: "_global" },
    );
    assert.equal(h.writes[0]?.key, "discover-flows:CASH:20");
    assert.equal(h.writes[0]?.ttl, 6 * 60 * 60);

    const live = harness({ flows }, { isLive: true });
    await getInstitutionalFlows({ windowSessions: 20 }, live.deps);
    assert.equal(live.writes[0]?.ttl, 15 * 60);
  });

  it("does NOT cache an empty section", async () => {
    const h = harness({ flows: [] });
    const env = ok<{ empty: boolean }>(await getInstitutionalFlows({}, h.deps));
    assert.equal(env.empty, true);
    assert.deepEqual(
      h.writes,
      [],
      "a cached 'nothing here' is a fail-open default",
    );
  });

  it("cache HIT short-circuits before any query", async () => {
    const h = harness(
      { flows },
      { cacheHit: { data: { series: [] }, empty: true } },
    );
    await getInstitutionalFlows({}, h.deps);
    assert.deepEqual(h.calls.institutionalFlow, []);
  });

  it("returns a sanitised error instead of leaking the DB message", async () => {
    const h = harness({ flows, throwOn: "institutionalFlow" });
    const res = await getInstitutionalFlows({}, h.deps);
    assert.equal(res.success, false);
    assert.equal(
      (res as { error: string }).error,
      "Failed to load institutional flows",
    );
    assert.ok(!(res as { error: string }).error.includes("E11000"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14d.2 (b) — positioning: the metric filter
// ════════════════════════════════════════════════════════════════════════════

describe("14d.2 getMarketPositioning", () => {
  const participantRows = [
    {
      date: day("2026-08-12"),
      participant: "FII",
      bucket: "FUT_IDX",
      metric: "OI",
      longQty: 100,
      shortQty: 40,
      netQty: 60,
    },
    {
      date: day("2026-08-13"),
      participant: "FII",
      bucket: "FUT_IDX",
      metric: "OI",
      longQty: 130,
      shortQty: 40,
      netQty: 90,
    },
  ];

  it("PINS `metric` in the where clause — the query is the first line of defence", async () => {
    const h = harness({ positioning: participantRows });
    await getMarketPositioning({ participant: "FII", metric: "OI" }, h.deps);
    const call = h.calls.marketPositioning[0];
    assert.ok(call, "a query must have been issued");
    const where = call.where as Rec;
    assert.equal(
      where.metric,
      "OI",
      "without this the read also returns nse-fii-stats rows for the same FII and day",
    );
    assert.equal(where.participant, "FII");
    // Equality on (participant, metric) + date order is exactly
    // @@index([participant, bucket, metric, date desc]).
    assert.deepEqual(call.orderBy, { date: "desc" });
    assert.ok(typeof call.take === "number");
  });

  it("falls back to OI rather than issuing an unfiltered read for a bogus metric", async () => {
    const h = harness({ positioning: participantRows });
    const env = ok<{ data: { metric: string } }>(
      await getMarketPositioning(
        // A stray query param must never widen the query.
        { metric: "FII_STATS" as unknown as "OI" },
        h.deps,
      ),
    );
    assert.equal((h.calls.marketPositioning[0]?.where as Rec).metric, "OI");
    assert.equal(env.data.metric, "OI");
  });

  it("builds legs with a day-on-day change and offers the four participants", async () => {
    const h = harness({ positioning: participantRows });
    const env = ok<{
      data: {
        date: string | null;
        legs: Array<{
          bucket: string;
          netQty: number | null;
          netChange: number | null;
        }>;
        participants: readonly string[];
      };
      asOf: string | null;
    }>(
      await getMarketPositioning({ participant: "FII", metric: "OI" }, h.deps),
    );
    assert.equal(env.data.date, "2026-08-13");
    assert.equal(env.asOf, "2026-08-13");
    assert.equal(env.data.legs[0]?.netQty, 90);
    assert.equal(env.data.legs[0]?.netChange, 30);
    assert.deepEqual(
      [...env.data.participants],
      ["FII", "DII", "CLIENT", "PRO"],
    );
  });

  it("keys the cache on participant AND metric so the toggle cannot serve stale legs", async () => {
    const h = harness({ positioning: participantRows });
    await getMarketPositioning(
      { participant: "CLIENT", metric: "VOLUME" },
      h.deps,
    );
    assert.equal(
      h.reads[0],
      "discover/_global/discover-positioning:CLIENT:VOLUME",
    );
  });

  it("is empty, not an error, when the participant has no rows", async () => {
    const h = harness({ positioning: [] });
    const env = ok<{ empty: boolean }>(
      await getMarketPositioning({ participant: "PRO" }, h.deps),
    );
    assert.equal(env.empty, true);
    assert.deepEqual(h.writes, []);
  });

  it("returns a sanitised error on a DB failure", async () => {
    const h = harness({
      positioning: participantRows,
      throwOn: "marketPositioning",
    });
    const res = await getMarketPositioning({}, h.deps);
    assert.equal(res.success, false);
    assert.equal(
      (res as { error: string }).error,
      "Failed to load participant positioning",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14d.2 (c) — macro strip
// ════════════════════════════════════════════════════════════════════════════

describe("14d.2 getMacroStrip", () => {
  const macro = [
    {
      seriesId: "RBI_REPO_RATE",
      period: day("2026-08-07"),
      value: 5.5,
      unit: "PERCENT",
      frequency: "WEEKLY",
      label: "Repo Rate",
      releasedOn: day("2026-08-08"),
    },
    {
      seriesId: "RBI_FOREX_RESERVES_TOTAL_USD_MN",
      period: day("2026-08-01"),
      value: 702345,
      unit: "USD_MILLION",
      frequency: "WEEKLY",
      label: "Total Reserves",
      releasedOn: null,
    },
  ];

  it("fetches only the strip's series ids and keeps each tile's own period", async () => {
    const h = harness({ macro });
    const env = ok<{
      data: { items: Array<{ seriesId: string; period: string | null }> };
      asOf: string | null;
    }>(await getMacroStrip({}, h.deps));
    const where = h.calls.macroSeries[0]?.where as Rec;
    const ids = (where.seriesId as Rec).in as string[];
    assert.ok(ids.includes("RBI_REPO_RATE"));
    assert.ok(ids.includes("MOSPI_CPI_COMBINED"));

    const periods = Object.fromEntries(
      env.data.items.map((i) => [i.seriesId, i.period]),
    );
    assert.equal(periods.RBI_REPO_RATE, "2026-08-07");
    assert.equal(periods.RBI_FOREX_RESERVES_TOTAL_USD_MN, "2026-08-01");
    assert.notEqual(
      periods.RBI_REPO_RATE,
      periods.RBI_FOREX_RESERVES_TOTAL_USD_MN,
      "the strip must never present one shared 'as of'",
    );
    assert.equal(env.asOf, "2026-08-07");
  });

  it("is EMPTY when every tile is unavailable — not a strip of zeros", async () => {
    const h = harness({ macro: [] });
    const env = ok<{
      data: { items: Array<{ value: number | null }> };
      empty: boolean;
    }>(await getMacroStrip({}, h.deps));
    assert.equal(env.empty, true);
    for (const i of env.data.items) assert.equal(i.value, null);
    assert.deepEqual(h.writes, []);
  });

  it("uses the same long TTL live or closed — macro does not move with the tape", async () => {
    const live = harness({ macro }, { isLive: true });
    await getMacroStrip({}, live.deps);
    const closed = harness({ macro }, { isLive: false });
    await getMacroStrip({}, closed.deps);
    assert.equal(live.writes[0]?.ttl, 6 * 60 * 60);
    assert.equal(closed.writes[0]?.ttl, 6 * 60 * 60);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14d.3 — IPO
// ════════════════════════════════════════════════════════════════════════════

describe("14d.3 getIpoSections", () => {
  const ipos = [
    {
      symbol: "NEWCO",
      companyName: "Newco Industries",
      series: "EQ",
      isSme: false,
      issueStart: day("2026-08-14"),
      issueEnd: day("2026-08-16"),
      listingDate: null,
      priceMin: 100,
      priceMax: 105,
      issueSize: null,
      lotSize: 140,
      status: "OPEN",
    },
    {
      symbol: "SOONCO",
      companyName: null,
      series: null,
      isSme: true,
      issueStart: day("2026-08-20"),
      issueEnd: day("2026-08-22"),
      listingDate: null,
      priceMin: null,
      priceMax: null,
      issueSize: null,
      lotSize: null,
      status: "UPCOMING",
    },
  ];

  it("resolves the IST day from the injected clock and keys the cache on it", async () => {
    // 11:30 IST on the closing day. Under an instant comparison NEWCO is
    // already 6h "expired"; under IST day keys it is still bidding.
    const h = harness({ ipos }, { now: "2026-08-16T06:00:00.000Z" });
    const env = ok<{
      data: {
        today: string;
        current: Array<{ symbol: string; closesToday: boolean }>;
      };
    }>(await getIpoSections({}, h.deps));
    assert.equal(env.data.today, "2026-08-16");
    assert.deepEqual(
      env.data.current.map((v) => v.symbol),
      ["NEWCO"],
    );
    assert.equal(env.data.current[0]?.closesToday, true);
    assert.equal(h.reads[0], "discover/_global/discover-ipo:2026-08-16:30");
  });

  it("rolls the tabs over at IST midnight, not UTC midnight", async () => {
    // 00:01 IST on the 17th — UTC still reads 2026-08-16.
    const h = harness({ ipos }, { now: "2026-08-16T18:31:00.000Z" });
    const env = ok<{
      data: {
        today: string;
        current: Rec[];
        recent: Array<{ symbol: string }>;
      };
    }>(await getIpoSections({}, h.deps));
    assert.equal(env.data.today, "2026-08-17");
    assert.deepEqual(env.data.current, []);
    assert.deepEqual(
      env.data.recent.map((v) => v.symbol),
      ["NEWCO"],
    );
    assert.equal(h.reads[0], "discover/_global/discover-ipo:2026-08-17:30");
  });

  it("does NOT push the bidding window into the where clause", async () => {
    // `issueEnd: { gte: new Date() }` is the exact instant-vs-IST-day bug; the
    // phase decision belongs in the pure layer.
    const h = harness({ ipos });
    await getIpoSections({}, h.deps);
    const where = h.calls.upcomingIpo[0]?.where as Rec;
    const serialized = JSON.stringify(where);
    assert.ok(!serialized.includes('"issueEnd":{"gte"'), serialized);
    assert.ok(!serialized.includes('"status"'), serialized);
  });

  it("keeps an un-priced issue's band null through the whole stack", async () => {
    const h = harness({ ipos });
    const env = ok<{
      data: { upcoming: Array<{ symbol: string; priceMin: number | null }> };
    }>(await getIpoSections({}, h.deps));
    const soonco = env.data.upcoming.find((v) => v.symbol === "SOONCO");
    assert.equal(soonco?.priceMin, null, "₹0 would read as a free issue");
  });

  it("is empty, not a 404, when NSE has published nothing", async () => {
    const h = harness({ ipos: [] });
    const env = ok<{ empty: boolean }>(await getIpoSections({}, h.deps));
    assert.equal(env.empty, true);
    assert.deepEqual(h.writes, []);
  });

  it("builds the dashboard card from the SAME sections the page renders", async () => {
    const h = harness({ ipos });
    const env = ok<{
      data: {
        openCount: number;
        closingToday: Array<{ symbol: string }>;
        empty: boolean;
      };
    }>(await getIpoDashboardCard({}, h.deps));
    assert.equal(env.data.openCount, 1);
    assert.deepEqual(
      env.data.closingToday.map((v) => v.symbol),
      ["NEWCO"],
    );
    assert.equal(env.data.empty, false);
  });

  it("marks the dashboard card empty when nothing is open or forthcoming", async () => {
    const h = harness({ ipos: [] });
    const env = ok<{ data: { empty: boolean }; empty: boolean }>(
      await getIpoDashboardCard({}, h.deps),
    );
    assert.equal(env.data.empty, true);
    assert.equal(env.empty, true, "the dashboard mounts nothing at all");
  });

  it("returns a sanitised error on a DB failure", async () => {
    const h = harness({ ipos, throwOn: "upcomingIpo" });
    const res = await getIpoSections({}, h.deps);
    assert.equal(res.success, false);
    assert.equal(
      (res as { error: string }).error,
      "Failed to load IPO calendar",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14d.5 — circulars
// ════════════════════════════════════════════════════════════════════════════

describe("14d.5 getCircularFeed", () => {
  const circ = (over: Rec = {}): Rec => ({
    circularNumber: "75736",
    displayNumber: "NSE/CML/75736",
    department: "Listing",
    category: "Compliance",
    subject: "Listing of further issues",
    company: "",
    circularDate: day("2026-08-13"),
    topic: "LISTING",
    fileUrl: "https://nsearchives.nseindia.com/x.pdf",
    fileName: "x.pdf",
    approxSizeBytes: 374086,
    ...over,
  });

  it("keeps a re-issued circular under BOTH departments", async () => {
    const h = harness({
      circulars: [circ(), circ({ department: "Emerge" })],
    });
    const env = ok<{
      data: { circulars: Array<{ key: string; department: string }> };
    }>(await getCircularFeed({}, h.deps));
    assert.equal(
      env.data.circulars.length,
      2,
      "circularNumber is NOT unique — keying on it discards half of every re-issue",
    );
    assert.deepEqual(env.data.circulars.map((c) => c.key).sort(), [
      "75736::Emerge",
      "75736::Listing",
    ]);
  });

  it("probes hasMore with take = limit + 1 rather than a count()", async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      circ({ circularNumber: `n${i}` }),
    );
    const h = harness({ circulars: rows });
    const env = ok<{ data: { circulars: unknown[]; hasMore: boolean } }>(
      await getCircularFeed({ limit: 5 }, h.deps),
    );
    assert.equal(h.calls.nseCircular[0]?.take, 6);
    assert.equal(env.data.circulars.length, 5);
    assert.equal(env.data.hasMore, true);
  });

  it("filters by department on its own index and counts the chips", async () => {
    const h = harness({ circulars: [circ({ department: "Surveillance" })] });
    const env = ok<{
      data: { departments: Array<{ department: string; count: number }> };
    }>(await getCircularFeed({ department: "Surveillance" }, h.deps));
    assert.equal(
      (h.calls.nseCircular[0]?.where as Rec).department,
      "Surveillance",
    );
    assert.deepEqual(h.calls.nseCircular[0]?.orderBy, { circularDate: "desc" });
    assert.deepEqual(env.data.departments, [
      { department: "Surveillance", count: 1 },
    ]);
  });

  it("is empty, not an error, on a quiet week", async () => {
    const h = harness({ circulars: [] });
    const env = ok<{ empty: boolean }>(await getCircularFeed({}, h.deps));
    assert.equal(env.empty, true);
    assert.deepEqual(h.writes, []);
  });

  it("returns a sanitised error on a DB failure", async () => {
    const h = harness({ circulars: [circ()], throwOn: "nseCircular" });
    const res = await getCircularFeed({}, h.deps);
    assert.equal(res.success, false);
    assert.equal(
      (res as { error: string }).error,
      "Failed to load exchange circulars",
    );
  });
});

describe("14d.5 getCircularsForSymbol", () => {
  const surv = (subject: string, over: Rec = {}): Rec => ({
    circularNumber: String(Math.random()).slice(2, 8),
    displayNumber: "",
    department: "Surveillance",
    category: "Compliance",
    subject,
    company: "",
    circularDate: day("2026-08-13"),
    topic: "SURVEILLANCE",
    fileUrl: "",
    fileName: "",
    approxSizeBytes: null,
    ...over,
  });

  it("scopes the scan by department AND date — the symbol match cannot be indexed", async () => {
    const h = harness({ circulars: [surv("RELIANCE moved to ASM Stage I")] });
    await getCircularsForSymbol({ symbol: "RELIANCE" }, h.deps);
    const where = h.calls.nseCircular[0]?.where as Rec;
    assert.deepEqual((where.department as Rec).in, ["Surveillance"]);
    assert.ok((where.circularDate as Rec).gte instanceof Date);
    assert.ok(typeof h.calls.nseCircular[0]?.take === "number");
  });

  it("ships the heuristic disclaimer inside the payload, not just the note", async () => {
    const h = harness({ circulars: [surv("RELIANCE moved to ASM Stage I")] });
    const env = ok<{
      data: { matches: Array<{ confidence: string }>; disclaimer: string };
      note?: string;
    }>(await getCircularsForSymbol({ symbol: "RELIANCE" }, h.deps));
    assert.equal(env.data.matches.length, 1);
    assert.equal(env.data.matches[0]?.confidence, "LOW");
    assert.match(env.data.disclaimer, /heuristic match/i);
    assert.match(String(env.note), /heuristic match/i);
  });

  it("does not fire a query at all for an empty symbol", async () => {
    const h = harness({ circulars: [surv("anything")] });
    const env = ok<{ empty: boolean }>(
      await getCircularsForSymbol({ symbol: "  " }, h.deps),
    );
    assert.equal(env.empty, true);
    assert.deepEqual(h.calls.nseCircular, []);
  });

  it("is empty when nothing mentions the symbol, and caches nothing", async () => {
    const h = harness({
      circulars: [surv("Securities moved below the applicable price band")],
    });
    const env = ok<{ data: { matches: unknown[] }; empty: boolean }>(
      await getCircularsForSymbol({ symbol: "BEL" }, h.deps),
    );
    assert.deepEqual(env.data.matches, [], "'below' must not match BEL");
    assert.equal(env.empty, true);
    assert.deepEqual(h.writes, []);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14d.6 — index detail
// ════════════════════════════════════════════════════════════════════════════

describe("14d.6 getIndexDetail", () => {
  const closes = [
    {
      date: day("2026-08-12"),
      name: "Nifty 50",
      open: 24400,
      high: 24650,
      low: 24350,
      close: 24600,
      prevClose: 24500,
      pe: 22.1,
      pb: 3.7,
      divYield: 1.24,
      volume: 280000000,
      turnoverCr: 33000,
    },
    {
      date: day("2026-08-13"),
      name: "Nifty 50",
      open: 24600,
      high: 24800,
      low: 24500,
      close: 24700,
      prevClose: 24600,
      pe: 22.4,
      pb: 3.8,
      divYield: 1.25,
      volume: 285000000,
      turnoverCr: 34500.5,
    },
  ];
  const constituents = [
    {
      symbol: "HDFCBANK",
      weightBps: 84321,
      rank: 1,
      lastSyncedAt: day("2026-08-13"),
    },
    {
      symbol: "INFY",
      weightBps: null,
      rank: 2,
      lastSyncedAt: day("2026-08-13"),
    },
  ];
  const memberships = [
    {
      symbol: "HDFCBANK",
      firstSeen: day("2020-01-01"),
      lastSeen: day("2026-08-13"),
      addedOn: null,
      removedOn: null,
    },
    {
      symbol: "GONE",
      firstSeen: day("2020-01-01"),
      lastSeen: day("2024-03-27"),
      addedOn: null,
      removedOn: day("2024-03-28"),
    },
  ];

  it("resolves the slug into BOTH key vocabularies and queries each on its own", async () => {
    const h = harness({ closes, constituents, memberships });
    const env = ok<{
      data: {
        route: { indexSlug: string; indexId: string | null; label: string };
      };
    }>(await getIndexDetail({ slug: "nifty-50" }, h.deps));

    assert.equal(env.data.route.indexSlug, "nifty-50");
    assert.equal(env.data.route.indexId, "nifty50");
    // IndexClose keys on the slug…
    assert.equal((h.calls.indexClose[0]?.where as Rec).indexSlug, "nifty-50");
    // …IndexConstituent and IndexMembership key on the id.
    assert.equal(
      (h.calls.indexConstituent[0]?.where as Rec).indexId,
      "nifty50",
    );
    assert.equal((h.calls.indexMembership[0]?.where as Rec).indexId, "nifty50");
  });

  it("reads IndexConstituent BY INDEX — never by symbol, which has no index", async () => {
    const h = harness({ closes, constituents, memberships });
    await getIndexDetail({ slug: "nifty-50" }, h.deps);
    const where = h.calls.indexConstituent[0]?.where as Rec;
    assert.deepEqual(Object.keys(where), ["indexId"]);
    assert.equal(
      where.symbol,
      undefined,
      "index_constituents has @@index([indexId]) and NO [symbol] index",
    );
    // Ordering by rank uses @@index([indexId, rank]).
    assert.deepEqual(h.calls.indexConstituent[0]?.orderBy, { rank: "asc" });
  });

  it("skips both indexId reads entirely for a closes-only index", async () => {
    const h = harness({ closes, constituents, memberships });
    const env = ok<{
      data: {
        route: { indexId: string | null; known: boolean };
        constituents: { rows: unknown[] };
        detail: { close: number | null };
      };
      note?: string;
    }>(await getIndexDetail({ slug: "india-vix" }, h.deps));

    assert.equal(env.data.route.indexId, null);
    assert.equal(env.data.route.known, false);
    assert.deepEqual(
      h.calls.indexConstituent,
      [],
      "a closes-only index must not trigger a constituent read",
    );
    assert.deepEqual(h.calls.indexMembership, []);
    // The page still works — this is the normal case, not a 404.
    assert.equal(env.data.constituents.rows.length, 0);
    assert.equal(env.data.detail.close, 24700);
    assert.match(String(env.note), /price history only/i);
  });

  it("converts weightBps correctly and leaves an unpublished weight null", async () => {
    const h = harness({ closes, constituents, memberships });
    const env = ok<{
      data: {
        constituents: {
          rows: Array<{ symbol: string; weightPct: number | null }>;
          hasWeights: boolean;
        };
      };
    }>(await getIndexDetail({ slug: "nifty-50" }, h.deps));
    const rows = env.data.constituents.rows;
    assert.equal(rows.find((r) => r.symbol === "HDFCBANK")?.weightPct, 8.4321);
    assert.equal(rows.find((r) => r.symbol === "INFY")?.weightPct, null);
    assert.equal(env.data.constituents.hasWeights, true);
  });

  it("never renders a 0 for an unreported valuation", async () => {
    const h = harness({
      closes: [
        {
          ...closes[1],
          pe: null,
          pb: null,
          divYield: null,
          volume: null,
          turnoverCr: null,
        },
      ],
      constituents: [],
      memberships: [],
    });
    const env = ok<{
      data: {
        detail: {
          valuation: {
            pe: number | null;
            pb: number | null;
            divYield: number | null;
          };
        };
      };
    }>(await getIndexDetail({ slug: "india-vix" }, h.deps));
    assert.equal(env.data.detail.valuation.pe, null);
    assert.equal(env.data.detail.valuation.pb, null);
    assert.equal(env.data.detail.valuation.divYield, null);
  });

  it("reports membership on the open interval", async () => {
    const h = harness({ closes, constituents, memberships });
    const env = ok<{
      data: {
        membership: {
          currentCount: number;
          changes: Array<{ symbol: string; kind: string }>;
        };
      };
    }>(await getIndexDetail({ slug: "nifty-50" }, h.deps));
    assert.equal(env.data.membership.currentCount, 1);
    assert.deepEqual(env.data.membership.changes, [
      { symbol: "GONE", kind: "REMOVED", date: "2024-03-28" },
    ]);
  });

  it("keys the cache on the resolved slug so aliases share one entry", async () => {
    const a = harness({ closes, constituents, memberships });
    await getIndexDetail({ slug: "banknifty" }, a.deps);
    const b = harness({ closes, constituents, memberships });
    await getIndexDetail({ slug: "Bank Nifty" }, b.deps);
    assert.equal(a.reads[0], b.reads[0]);
    assert.equal(a.reads[0], "discover/_global/discover-index:nifty-bank:180");
  });

  it("is empty, not an error, for an index we hold nothing on", async () => {
    const h = harness({ closes: [], constituents: [], memberships: [] });
    const env = ok<{ empty: boolean }>(
      await getIndexDetail({ slug: "nifty-totally-new" }, h.deps),
    );
    assert.equal(env.empty, true);
    assert.deepEqual(h.writes, []);
  });

  it("returns a sanitised error on a DB failure", async () => {
    const h = harness({
      closes,
      constituents,
      memberships,
      throwOn: "indexClose",
    });
    const res = await getIndexDetail({ slug: "nifty-50" }, h.deps);
    assert.equal(res.success, false);
    assert.equal(
      (res as { error: string }).error,
      "Failed to load index details",
    );
  });
});
