/**
 * MONEY-1204 (P14 / 14e.1) — market-structure READER + engine wiring.
 *
 * Runs the SHIPPED `loadMarketFieldValues` and `applyMarketStructureFilters`
 * against an injected Prisma double — no database, no network — and asserts the
 * three things the pure tests cannot see:
 *
 *   1. Only the tables the requested fields need are queried. An unqueried
 *      source must leave its fields UNKNOWN, which excludes; it must never be
 *      answered from thin air.
 *   2. The flag reference day is fetched PER KIND and MARKET-WIDE (three tiny
 *      `findFirst`s), not derived from the candidate's own newest row.
 *   3. A source that THROWS degrades that source's fields to unknown rather
 *      than taking the screen down — the `bond_eod` / `bond_master` case, since
 *      both tables are new and nearly empty.
 *
 * And the end-to-end property the ticket asks for by name: a filter on the
 * permanently-null `mwplUtilisation` returns ZERO rows out of a non-empty
 * candidate set, rather than all of them.
 *
 * Source: packages/core/src/screener/market-fields.ts
 *         packages/core/src/screener/engine.ts (applyMarketStructureFilters)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadMarketFieldValues,
  marketFieldKey,
  MARKET_FIELD_LOOKBACK_DAYS,
  type MarketFieldsDeps,
} from "../../src/screener/market-fields";
import { matchesMarketFilters } from "../../src/screener/market-fields-logic";
import {
  applyMarketStructureFilters,
  runScreener,
  SCREENER_MARKET_UNIVERSE_LIMIT,
  type ScreenerFilter,
  type ScreenerResult,
} from "../../src/screener/engine";

const NOW = new Date("2026-08-15T00:00:00.000Z").getTime();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

interface Call {
  model: string;
  op: string;
  args: Record<string, unknown>;
}

interface Tables {
  instrumentMapping?: Array<Record<string, unknown>>;
  dailyPrice?: Array<Record<string, unknown>>;
  stockFlag?: Array<Record<string, unknown>>;
  shareholdingPattern?: Array<Record<string, unknown>>;
  indexMembership?: Array<Record<string, unknown>>;
  derivativeSummary?: Array<Record<string, unknown>>;
  mwplDaily?: Array<Record<string, unknown>>;
  bondEOD?: Array<Record<string, unknown>>;
  bondMaster?: Array<Record<string, unknown>>;
}

/**
 * A Prisma double that RECORDS every call and applies the parts of the `where`
 * these readers actually depend on ($in, gte, equality, null).
 *
 * Deliberately not a pass-through: if it ignored the `where` the "only the
 * requested sources are read" assertions would still pass while the filters did
 * nothing, which is the shadow-test failure mode.
 */
function makeDb(
  tables: Tables,
  throwing: ReadonlySet<string> = new Set(),
): { deps: MarketFieldsDeps; calls: Call[] } {
  const calls: Call[] = [];

  const matches = (
    row: Record<string, unknown>,
    where: Record<string, unknown> | undefined,
  ): boolean => {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      const value = row[key];
      if (
        cond !== null &&
        typeof cond === "object" &&
        !(cond instanceof Date)
      ) {
        const c = cond as Record<string, unknown>;
        if (Array.isArray(c.in) && !(c.in as unknown[]).includes(value)) {
          return false;
        }
        if (c.gte instanceof Date) {
          const d = value instanceof Date ? value : new Date(String(value));
          if (d.getTime() < c.gte.getTime()) return false;
        }
        // Modelled, not ignored: an unrecognised operator here would let every
        // row through and the shareholding tests below would be asserting
        // against a filter that never ran.
        if (typeof c.startsWith === "string") {
          if (!String(value).startsWith(c.startsWith)) return false;
        }
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };

  const sortRows = (
    rows: Array<Record<string, unknown>>,
    orderBy: unknown,
  ): Array<Record<string, unknown>> => {
    const specs = (
      Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
    ) as Array<Record<string, "asc" | "desc">>;
    if (specs.length === 0) return rows;
    return rows.slice().sort((a, b) => {
      for (const spec of specs) {
        for (const [key, dir] of Object.entries(spec)) {
          const av = a[key];
          const bv = b[key];
          const an = av instanceof Date ? av.getTime() : av;
          const bn = bv instanceof Date ? bv.getTime() : bv;
          if (an === bn) continue;
          const cmp = (an as number) < (bn as number) ? -1 : 1;
          return dir === "desc" ? -cmp : cmp;
        }
      }
      return 0;
    });
  };

  const model = (name: keyof Tables) => ({
    findMany: async (args: Record<string, unknown> = {}) => {
      calls.push({ model: name, op: "findMany", args });
      if (throwing.has(name)) throw new Error(`${name} is unavailable`);
      const rows = (tables[name] ?? []).filter((r) =>
        matches(r, args.where as Record<string, unknown> | undefined),
      );
      const sorted = sortRows(rows, args.orderBy);
      return typeof args.take === "number"
        ? sorted.slice(0, args.take)
        : sorted;
    },
    findFirst: async (args: Record<string, unknown> = {}) => {
      calls.push({ model: name, op: "findFirst", args });
      if (throwing.has(name)) throw new Error(`${name} is unavailable`);
      const rows = (tables[name] ?? []).filter((r) =>
        matches(r, args.where as Record<string, unknown> | undefined),
      );
      return sortRows(rows, args.orderBy)[0] ?? null;
    },
  });

  const db = {
    instrumentMapping: model("instrumentMapping"),
    dailyPrice: model("dailyPrice"),
    stockFlag: model("stockFlag"),
    shareholdingPattern: model("shareholdingPattern"),
    indexMembership: model("indexMembership"),
    derivativeSummary: model("derivativeSummary"),
    mwplDaily: model("mwplDaily"),
    bondEOD: model("bondEOD"),
    bondMaster: model("bondMaster"),
  };

  return {
    deps: { prisma: db as unknown as MarketFieldsDeps["prisma"] },
    calls,
  };
}

const CANDIDATES = [
  { symbol: "AAA", exchange: "NSE" },
  { symbol: "BBB", exchange: "NSE" },
];

const INSTRUMENTS = [
  {
    id: "i-aaa",
    symbol: "AAA",
    exchange: "NSE",
    isin: "INE001A01001",
    isActive: true,
  },
  { id: "i-bbb", symbol: "BBB", exchange: "NSE", isin: null, isActive: true },
];

// ════════════════════════════════════════════════════════════════════

describe("loadMarketFieldValues — only the needed tables are read", () => {
  it("a delivery screen touches DailyPrice (and the id join) and nothing else", async () => {
    const { deps, calls } = makeDb({
      instrumentMapping: INSTRUMENTS,
      dailyPrice: [
        {
          instrumentId: "i-aaa",
          date: day("2026-08-14"),
          deliveryPct: 71,
          deliveryQty: 10n,
          avgPrice: 100,
          trades: 5,
          close: 100,
        },
        {
          instrumentId: "i-aaa",
          date: day("2026-08-13"),
          deliveryPct: null,
          deliveryQty: null,
          avgPrice: null,
          trades: null,
          close: 99,
        },
      ],
      // Present in the fixture but must NOT be read.
      stockFlag: [
        {
          symbol: "AAA",
          kind: "FO_BAN",
          value: "BAN",
          date: day("2026-08-14"),
          series: null,
          source: "s",
        },
      ],
      mwplDaily: [
        { symbol: "AAA", date: day("2026-08-14"), utilisationPct: null },
      ],
    });

    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["deliveryPct", "deliveryPct20dAvg"],
      deps,
      NOW,
    );

    const models = new Set(calls.map((c) => c.model));
    assert.deepEqual([...models].sort(), ["dailyPrice", "instrumentMapping"]);

    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.deliveryPct, 71);
    assert.equal(aaa.deliveryPct20dAvg, 71, "the null session is skipped");
    assert.equal(aaa.deliveryPct20dDays, 1);
    // The flags table was never read, so its fields are UNKNOWN — not `false`.
    assert.equal(aaa.foBanFlag, null);
    assert.equal(aaa.mwplUtilisation, null);
  });

  it("headlines the last REPORTED session when the bhavcopy has not landed", async () => {
    // The live weekday state before 21:00 IST: price-sync has written today's
    // Yahoo row (OHLCV, no delivery columns) and bhavcopy-sync has not run yet.
    // Headlining the newest ROW would make `deliveryPct` null for the ENTIRE
    // universe for most of every trading day, so every delivery screen would
    // return zero matches — and the stock page, reading these same rows, would
    // simultaneously show 71%. The screener takes the last REPORTED figure and
    // dates it (MONEY-1204).
    const { deps } = makeDb({
      instrumentMapping: INSTRUMENTS,
      dailyPrice: [
        {
          instrumentId: "i-aaa",
          date: day("2026-08-15"),
          deliveryPct: null,
          deliveryQty: null,
          avgPrice: null,
          trades: null,
          close: 101,
        },
        {
          instrumentId: "i-aaa",
          date: day("2026-08-14"),
          deliveryPct: 71,
          deliveryQty: 10n,
          avgPrice: 100,
          trades: 5,
          close: 100,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["deliveryPct"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.deliveryPct, 71);
    assert.equal(aaa.deliveryAsOf, "2026-08-14T00:00:00.000Z");
    assert.equal(
      matchesMarketFilters(aaa, [
        { field: "deliveryPct", operator: "gt", value: 50 },
      ]),
      true,
      "a delivery screen must still match while the bhavcopy is pending",
    );
  });

  it("the READER's 60-day window is what bounds delivery staleness", async () => {
    // "Last reported" needs a floor, and it is not a second constant in the
    // pure layer — it is `MARKET_FIELD_LOOKBACK_DAYS.delivery`. A name whose
    // last reporting session is older than that window has its rows filtered
    // out by the query, so nothing is in hand to headline and the field reads
    // unknown, which excludes. This is the assertion that fails if anyone
    // widens the window without re-reading what it now controls.
    const { deps, calls } = makeDb({
      instrumentMapping: INSTRUMENTS,
      dailyPrice: [
        // 100 days before NOW — a delisted / long-suspended name.
        {
          instrumentId: "i-aaa",
          date: day("2026-05-07"),
          deliveryPct: 88,
          deliveryQty: 10n,
          avgPrice: 100,
          trades: 5,
          close: 100,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["deliveryPct"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(
      aaa.deliveryPct,
      null,
      "a 100-day-old figure is not a headline",
    );
    assert.equal(aaa.deliveryAsOf, null, "and it carries no as-of date either");

    // The bound is the query's, so pin that it is actually applied.
    const read = calls.find(
      (c) => c.model === "dailyPrice" && c.op === "findMany",
    );
    const gte = (read?.args.where as { date?: { gte?: Date } } | undefined)
      ?.date?.gte;
    assert.ok(gte instanceof Date, "the delivery read must be date-bounded");
    assert.equal(
      Math.round((NOW - gte.getTime()) / 86_400_000),
      MARKET_FIELD_LOOKBACK_DAYS.delivery,
    );
  });

  it("gives every candidate an entry, even one with no rows anywhere", async () => {
    const { deps } = makeDb({ instrumentMapping: INSTRUMENTS, dailyPrice: [] });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["deliveryPct"],
      deps,
      NOW,
    );
    // A lookup MISS could be read by a caller as "no filters applied"; an
    // all-unknown entry cannot.
    assert.equal(values.size, 2);
    assert.equal(values.get(marketFieldKey("BBB", "NSE"))!.deliveryPct, null);
  });

  it("does not read InstrumentMapping when no field needs an id or ISIN", async () => {
    const { deps, calls } = makeDb({
      instrumentMapping: INSTRUMENTS,
      shareholdingPattern: [
        {
          symbol: "AAA",
          quarter: "2026-06",
          pledgedPct: 12,
          fiiPct: 20,
          diiPct: 8,
        },
        {
          symbol: "AAA",
          quarter: "2026-03",
          pledgedPct: 9,
          fiiPct: 18,
          diiPct: 8,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["pledgedPct", "pledgedPctQoqDelta"],
      deps,
      NOW,
    );
    assert.deepEqual(
      [...new Set(calls.map((c) => c.model))],
      ["shareholdingPattern"],
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.pledgedPct, 12);
    assert.equal(aaa.pledgedPctQoqDelta, 3);
  });

  it("an UNDATABLE quarter label cannot fabricate a pledge collapse", async () => {
    // `normalizeQuarter` keeps an unparseable period VERBATIM and upper-cased,
    // and in ASCII "Q" > "2" — so under `orderBy: { quarter: "desc" }` a
    // "Q1FY26" row sorts ABOVE every canonical `YYYY-MM`. The reader then kept
    // only the newest TWO rows, so the two real quarters were thrown away
    // BEFORE any in-memory re-sort could see them (which is why a correct
    // comparator alone cannot fix this).
    //
    // Truth here is 41.2% and +2.2pp. The bug published 3% and −38.2pp: a
    // fabricated pledge COLLAPSE, on the field whose null rule exists precisely
    // to stop a fabricated all-clear (module header, rule 4).
    const { deps } = makeDb({
      shareholdingPattern: [
        {
          symbol: "AAA",
          quarter: "2026-06",
          pledgedPct: 41.2,
          fiiPct: null,
          diiPct: null,
        },
        {
          symbol: "AAA",
          quarter: "2026-03",
          pledgedPct: 39.0,
          fiiPct: null,
          diiPct: null,
        },
        {
          symbol: "AAA",
          quarter: "Q1FY26",
          pledgedPct: 3.0,
          fiiPct: null,
          diiPct: null,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["pledgedPct", "pledgedPctQoqDelta"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.pledgedPct, 41.2);
    assert.equal(aaa.pledgedPctQoqDelta, 2.2);
    assert.equal(aaa.shareholdingQuarter, "2026-06");
    assert.equal(aaa.shareholdingPrevQuarter, "2026-03");
  });

  it("does not read a dual-filed quarter as its own prior quarter", async () => {
    // MONEY-1207 put `exchange` in the unique key, so the 2,465 symbols listed
    // on BOTH exchanges file each quarter twice. Undeduped, the newest two rows
    // are the SAME period: `shareholdingPrevQuarter` equals
    // `shareholdingQuarter` and every QoQ delta is exactly 0 — a confident
    // "no movement" that screener filters then match on as real.
    const { deps } = makeDb({
      shareholdingPattern: [
        {
          symbol: "AAA",
          quarter: "2026-06",
          exchange: "NSE",
          pledgedPct: 41.2,
          fiiPct: null,
          diiPct: null,
        },
        {
          symbol: "AAA",
          quarter: "2026-06",
          exchange: "BSE",
          pledgedPct: 41.2,
          fiiPct: null,
          diiPct: null,
        },
        {
          symbol: "AAA",
          quarter: "2026-03",
          exchange: "NSE",
          pledgedPct: 39.0,
          fiiPct: null,
          diiPct: null,
        },
        {
          symbol: "AAA",
          quarter: "2026-03",
          exchange: "BSE",
          pledgedPct: 39.0,
          fiiPct: null,
          diiPct: null,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["pledgedPct", "pledgedPctQoqDelta"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.shareholdingQuarter, "2026-06");
    assert.notEqual(
      aaa.shareholdingPrevQuarter,
      aaa.shareholdingQuarter,
      "previous quarter must be a DIFFERENT period",
    );
    assert.equal(aaa.shareholdingPrevQuarter, "2026-03");
    assert.equal(aaa.pledgedPctQoqDelta, 2.2, "delta must survive the dedupe");
  });

  it("keeps distinct quarters when duplicates would fill the row cap", async () => {
    // The cap counts ROWS. Dual-filed, 8 rows are only 4 periods — so a cap
    // applied BEFORE the dedupe silently truncates the series by half.
    const dual = ["2026-06", "2026-03", "2025-12", "2025-09"].flatMap((q, i) =>
      ["NSE", "BSE"].map((exchange) => ({
        symbol: "AAA",
        quarter: q,
        exchange,
        pledgedPct: 40 - i,
        fiiPct: null,
        diiPct: null,
      })),
    );
    const { deps } = makeDb({ shareholdingPattern: dual });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["pledgedPct", "pledgedPctQoqDelta"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.shareholdingQuarter, "2026-06");
    assert.equal(aaa.shareholdingPrevQuarter, "2026-03");
  });

  it("survives MORE undatable labels than the row cap", async () => {
    // The cap cannot be widened out of trouble: `@@unique([symbol, quarter])`
    // permits arbitrarily many verbatim labels, and they all sort above the
    // real ones. Eight of them must still not displace two real quarters.
    const verbatim = [
      "Q1FY26",
      "Q2FY26",
      "Q3FY26",
      "Q4FY26",
      "Q1FY25",
      "Q2FY25",
      "Q3FY25",
      "Q4FY25",
    ].map((quarter) => ({
      symbol: "AAA",
      quarter,
      pledgedPct: 3.0,
      fiiPct: null,
      diiPct: null,
    }));
    const { deps } = makeDb({
      shareholdingPattern: [
        ...verbatim,
        {
          symbol: "AAA",
          quarter: "2026-06",
          pledgedPct: 41.2,
          fiiPct: null,
          diiPct: null,
        },
        {
          symbol: "AAA",
          quarter: "2026-03",
          pledgedPct: 39.0,
          fiiPct: null,
          diiPct: null,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["pledgedPct", "pledgedPctQoqDelta"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.pledgedPct, 41.2);
    assert.equal(aaa.pledgedPctQoqDelta, 2.2);
  });
});

describe("loadMarketFieldValues — flags", () => {
  const flagTable = [
    // AAA's ban ENDED in January. The market-wide newest ban day is 14-Aug.
    {
      symbol: "AAA",
      kind: "FO_BAN",
      value: "BAN",
      date: day("2026-01-05"),
      series: null,
      source: "s",
    },
    {
      symbol: "BBB",
      kind: "FO_BAN",
      value: "BAN",
      date: day("2026-08-14"),
      series: null,
      source: "s",
    },
    // Surveillance is a day behind — its own reference must be used.
    {
      symbol: "AAA",
      kind: "SURVEILLANCE",
      value: "GSM Stage 1",
      date: day("2026-08-13"),
      series: null,
      source: "s",
    },
  ];

  it("asks for a market-wide newest day PER KIND, not one global maximum", async () => {
    const { deps, calls } = makeDb({ stockFlag: flagTable });
    await loadMarketFieldValues(
      CANDIDATES,
      ["foBanFlag", "gsmFlag"],
      deps,
      NOW,
    );

    const references = calls.filter(
      (c) => c.model === "stockFlag" && c.op === "findFirst",
    );
    const kinds = references
      .map((c) => (c.args.where as { kind: string }).kind)
      .sort();
    assert.deepEqual(kinds, ["FO_BAN", "PRICE_BAND", "SURVEILLANCE"]);
    // Each reference query is unscoped by symbol — that is what "market-wide"
    // means, and it is what makes an ended ban visible as ended.
    for (const c of references) {
      assert.equal((c.args.where as Record<string, unknown>).symbol, undefined);
    }
  });

  it("an ended ban reads false; a current one reads true; a lagging kind still reads true", async () => {
    const { deps } = makeDb({ stockFlag: flagTable });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["foBanFlag", "gsmFlag"],
      deps,
      NOW,
    );

    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    const bbb = values.get(marketFieldKey("BBB", "NSE"))!;

    assert.equal(aaa.foBanFlag, false, "January's ban is not August's ban");
    assert.equal(bbb.foBanFlag, true);
    // SURVEILLANCE's own market-wide newest day is the 13th, so AAA's 13-Aug
    // GSM row is current. A single global max (the 14th, from FO_BAN) would
    // have made this false — a fail-open on a surveillance surface.
    assert.equal(aaa.gsmFlag, true);
    assert.equal(bbb.gsmFlag, false);
  });

  it("a STALE feed reads UNKNOWN, never a clean bill of health", async () => {
    // The QA state, and the state of any environment where `surveillance-sync`
    // has stopped: the newest flag row anywhere is 2026-05-01, 106 days before
    // NOW and far outside the 45-day row window.
    //
    // The reference-day `findFirst` used to carry NO date bound while the ROW
    // query was windowed, so it happily reported May as "the newest day this
    // kind published". Every boolean it gates then flipped from unknown to
    // FALSE while the rows backing them were filtered out — so a stock that was
    // under ASM and F&O-banned on the last published day answered
    // `asmFlag: false, foBanFlag: false`, and a screen for "NOT under ASM"
    // MATCHED a banned stock. Rule 3 of the module header: a missing reference
    // day is not "not flagged".
    const stale = day("2026-05-01");
    const { deps } = makeDb({
      stockFlag: [
        {
          symbol: "AAA",
          kind: "SURVEILLANCE",
          value: "ASM Stage 1",
          date: stale,
          series: null,
          source: "s",
        },
        {
          symbol: "AAA",
          kind: "FO_BAN",
          value: "BAN",
          date: stale,
          series: null,
          source: "s",
        },
      ],
    });
    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["asmFlag", "gsmFlag", "foBanFlag", "priceBandFlag"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(
      aaa.asmFlag,
      null,
      "a 106-day-stale feed cannot say 'not ASM'",
    );
    assert.equal(aaa.gsmFlag, null);
    assert.equal(aaa.foBanFlag, null, "…nor 'not banned' about a banned stock");
    assert.equal(aaa.priceBandFlag, null);
    assert.equal(aaa.flagsAsOf, null);
  });

  it("bounds the reference-day lookup by the SAME window as the rows", async () => {
    // The structural half: it is the missing `date` predicate that produced the
    // fail-open above, and only this assertion says so when the value test is
    // satisfied some other way.
    const { deps, calls } = makeDb({ stockFlag: flagTable });
    await loadMarketFieldValues(CANDIDATES, ["gsmFlag"], deps, NOW);

    const references = calls.filter(
      (c) => c.model === "stockFlag" && c.op === "findFirst",
    );
    const rowReads = calls.filter(
      (c) => c.model === "stockFlag" && c.op === "findMany",
    );
    const since = (c: Call): number => {
      const where = c.args.where as { date?: { gte?: Date } };
      const gte = where.date?.gte;
      assert.ok(gte instanceof Date, "no date lower bound on the query");
      return gte.getTime();
    };
    assert.ok(references.length > 0 && rowReads.length > 0);
    for (const c of references) {
      assert.equal(
        since(c),
        since(rowReads[0]!),
        "the reference day must use the row window; an unbounded findFirst " +
          "resurrects a day whose rows the row query has already discarded",
      );
    }
  });
});

describe("loadMarketFieldValues — bonds degrade, never explode", () => {
  it("does not query the bond tables when no candidate has an ISIN", async () => {
    const { deps, calls } = makeDb({
      instrumentMapping: [
        {
          id: "i-bbb",
          symbol: "BBB",
          exchange: "NSE",
          isin: null,
          isActive: true,
        },
      ],
      bondEOD: [
        {
          isin: "INE001A01001",
          date: day("2026-08-14"),
          segment: "CBM",
          lastPrice: 100,
          lastYtm: 8,
          wtdYtm: null,
          totalTradeValueLacs: 5,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      [{ symbol: "BBB", exchange: "NSE" }],
      ["bondYield"],
      deps,
      NOW,
    );
    assert.equal(
      calls.some((c) => c.model === "bondEOD"),
      false,
      "an empty $in must not be sent",
    );
    assert.equal(values.get(marketFieldKey("BBB", "NSE"))!.bondYield, null);
  });

  it("a THROWING bond table degrades to unknown rather than failing the screen", async () => {
    const { deps } = makeDb(
      {
        instrumentMapping: INSTRUMENTS,
        bondEOD: [],
        bondMaster: [],
      },
      new Set(["bondEOD"]),
    );

    const values = await loadMarketFieldValues(
      CANDIDATES,
      ["bondYield", "bondCoupon"],
      deps,
      NOW,
    );
    const aaa = values.get(marketFieldKey("AAA", "NSE"))!;
    assert.equal(aaa.bondYield, null);
    assert.equal(aaa.bondCoupon, null);
  });

  it("normalises the ISIN before joining (trailing space, lower case)", async () => {
    const { deps } = makeDb({
      instrumentMapping: [
        {
          id: "i-b",
          symbol: "BOND1",
          exchange: "NSE",
          isin: " ine261f08eo7 ",
          isActive: true,
        },
      ],
      bondEOD: [
        {
          isin: "INE261F08EO7",
          date: day("2026-08-14"),
          segment: "CBM",
          lastPrice: 101.5,
          lastYtm: 7.2,
          wtdYtm: null,
          totalTradeValueLacs: 40,
        },
      ],
      bondMaster: [
        { isin: "INE261F08EO7", coupon: 8.33, maturityDate: day("2031-03-31") },
      ],
    });
    const values = await loadMarketFieldValues(
      [{ symbol: "BOND1", exchange: "NSE" }],
      ["bondYield", "bondCoupon"],
      deps,
      NOW,
    );
    const row = values.get(marketFieldKey("BOND1", "NSE"))!;
    // `cbm_trd` prints ISINs with a TRAILING SPACE; an un-normalised join
    // matches nothing, which looks exactly like "this bond does not trade".
    assert.equal(row.bondYield, 7.2);
    assert.equal(row.bondCoupon, 8.33);
  });

  it("breaks a same-day two-segment tie by traded value, deterministically", async () => {
    const { deps } = makeDb({
      instrumentMapping: [
        {
          id: "i-b",
          symbol: "BOND1",
          exchange: "NSE",
          isin: "INE261F08EO7",
          isActive: true,
        },
      ],
      bondEOD: [
        {
          isin: "INE261F08EO7",
          date: day("2026-08-14"),
          segment: "CBM",
          lastPrice: 101.5,
          lastYtm: 7.2,
          wtdYtm: null,
          totalTradeValueLacs: 5,
        },
        {
          isin: "INE261F08EO7",
          date: day("2026-08-14"),
          segment: "WDM",
          lastPrice: 99.0,
          lastYtm: 8.9,
          wtdYtm: null,
          totalTradeValueLacs: 400,
        },
      ],
    });
    const values = await loadMarketFieldValues(
      [{ symbol: "BOND1", exchange: "NSE" }],
      ["bondYield"],
      deps,
      NOW,
    );
    const row = values.get(marketFieldKey("BOND1", "NSE"))!;
    // The segment where it actually traded wins, and the choice travels with
    // the value so the answer is auditable.
    assert.equal(row.bondSegment, "WDM");
    assert.equal(row.bondYield, 8.9);
    assert.equal(row.bondPrice, 99.0);
  });
});

// ════════════════════════════════════════════════════════════════════
// Engine wiring
// ════════════════════════════════════════════════════════════════════

function candidate(symbol: string): ScreenerResult {
  return { symbol, exchange: "NSE", name: `${symbol} Ltd` };
}

describe("applyMarketStructureFilters", () => {
  const universe = ["AAA", "BBB", "CCC", "DDD", "EEE"].map(candidate);

  it("a filter on the ALWAYS-NULL mwplUtilisation returns ZERO rows, not all", async () => {
    const { deps } = makeDb({
      mwplDaily: universe.map((c) => ({
        symbol: c.symbol,
        date: day("2026-08-14"),
        // Null on every row today, and it stays null until a feed for the
        // denominator exists. `oi_cli_limit` is a per-CLIENT limit and is
        // deliberately not substituted.
        utilisationPct: null,
      })),
    });

    const filters: ScreenerFilter[] = [
      { field: "mwplUtilisation", operator: "lt", value: 100 },
    ];
    const out = await applyMarketStructureFilters(universe, filters, deps, NOW);

    assert.equal(out.length, 0);
    assert.equal(universe.length, 5, "the input was not empty");

    // And the other direction, which a coalesce-to-zero would also break.
    const out2 = await applyMarketStructureFilters(
      universe,
      [{ field: "mwplUtilisation", operator: "gte", value: 0 }],
      deps,
      NOW,
    );
    assert.equal(out2.length, 0);
  });

  it("keeps only matching candidates and attaches values to the survivors", async () => {
    const { deps } = makeDb({
      instrumentMapping: universe.map((c, i) => ({
        id: `i-${i}`,
        symbol: c.symbol,
        exchange: "NSE",
        isin: null,
        isActive: true,
      })),
      dailyPrice: universe.flatMap((c, i) => [
        {
          instrumentId: `i-${i}`,
          date: day("2026-08-14"),
          deliveryPct: 50 + i * 10,
          deliveryQty: null,
          avgPrice: null,
          trades: null,
          close: 100,
        },
      ]),
    });

    const out = await applyMarketStructureFilters(
      universe,
      [{ field: "deliveryPct", operator: "gt", value: 65 }],
      deps,
      NOW,
    );

    assert.deepEqual(
      out.map((r) => r.symbol),
      ["CCC", "DDD", "EEE"],
    );
    assert.equal(out[0]!.market?.deliveryPct, 70);
    // Non-survivors carry nothing — the multi-table read is not shipped to
    // callers that filtered the row out anyway.
    assert.equal(universe[0]!.market, undefined);
  });

  it("is a no-op with no filters or no candidates", async () => {
    const { deps, calls } = makeDb({});
    assert.deepEqual(
      await applyMarketStructureFilters(universe, [], deps, NOW),
      universe,
    );
    assert.deepEqual(
      await applyMarketStructureFilters(
        [],
        [{ field: "deliveryPct", operator: "gt", value: 1 }],
        deps,
        NOW,
      ),
      [],
    );
    assert.equal(calls.length, 0, "no query for a screen that cannot narrow");
  });

  it("index membership screens off the OPEN stint only", async () => {
    const { deps } = makeDb({
      indexMembership: [
        {
          symbol: "AAA",
          indexId: "nifty50",
          addedOn: null,
          firstSeen: day("2020-01-01"),
          lastSeen: day("2026-08-14"),
          removedOn: null,
        },
        // BBB LEFT the index. `removedOn` is in the `where`, so this row is
        // never returned — an ex-member must not screen as a member.
        {
          symbol: "BBB",
          indexId: "nifty50",
          addedOn: null,
          firstSeen: day("2020-01-01"),
          lastSeen: day("2024-01-01"),
          removedOn: day("2024-01-02"),
        },
      ],
    });

    const out = await applyMarketStructureFilters(
      universe,
      [{ field: "indexMember", operator: "eq", value: 1, operand: "nifty50" }],
      deps,
      NOW,
    );
    assert.deepEqual(
      out.map((r) => r.symbol),
      ["AAA"],
    );
  });

  it("survives a JSON round-trip — no BigInt escapes to the wire", async () => {
    const { deps } = makeDb({
      derivativeSummary: [
        {
          symbol: "AAA",
          date: day("2026-08-14"),
          pcrOi: 1.4,
          futOiChange: 9_007_199_254_740n,
        },
      ],
    });
    const out = await applyMarketStructureFilters(
      universe,
      [{ field: "pcrOi", operator: "gt", value: 1 }],
      deps,
      NOW,
    );
    assert.deepEqual(
      out.map((r) => r.symbol),
      ["AAA"],
    );
    assert.doesNotThrow(() => JSON.stringify(out));
    assert.equal(out[0]!.market?.futOiChange, 9_007_199_254_740);
  });
});

// ════════════════════════════════════════════════════════════════════
// runScreener routing — the market-structure-ONLY path
// ════════════════════════════════════════════════════════════════════

describe("runScreener — a screen made only of market-structure filters", () => {
  const SYMBOLS = ["AAA", "BBB", "CCC", "DDD"];

  function equityUniverse() {
    return SYMBOLS.map((symbol, i) => ({
      id: `i-${i}`,
      symbol,
      exchange: "NSE",
      name: `${symbol} Ltd`,
      sector: "Financial Services",
      isin: null,
      isActive: true,
      instrumentType: "EQUITY",
    }));
  }

  it("seeds the universe itself instead of returning nothing", async () => {
    // With no fundamental and no technical filter there is no candidate set to
    // narrow, so the routing has to seed one — otherwise "stocks in the F&O
    // ban" screens an empty list and reports no matches.
    const { deps, calls } = makeDb({
      instrumentMapping: equityUniverse(),
      stockFlag: [
        {
          symbol: "AAA",
          kind: "FO_BAN",
          value: "BAN",
          date: day("2026-08-14"),
          series: null,
          source: "s",
        },
        {
          symbol: "CCC",
          kind: "FO_BAN",
          value: "BAN",
          date: day("2026-08-14"),
          series: null,
          source: "s",
        },
        // BBB's ban ENDED in January — the existence check would include it.
        {
          symbol: "BBB",
          kind: "FO_BAN",
          value: "BAN",
          date: day("2026-01-05"),
          series: null,
          source: "s",
        },
      ],
    });

    const out = await runScreener(
      [{ field: "foBanFlag", operator: "eq", value: 1 }],
      { limit: 50 },
      { ...deps, now: NOW },
    );

    assert.deepEqual(out.map((r) => r.symbol).sort(), ["AAA", "CCC"]);
    assert.equal(out[0]!.market?.foBanFlag, true);

    // The seed is capped, and it asked for EQUITY.
    const seed = calls.find(
      (c) => c.model === "instrumentMapping" && c.op === "findMany",
    );
    assert.ok(seed);
    assert.equal(seed!.args.take, SCREENER_MARKET_UNIVERSE_LIMIT);
    assert.equal(
      (seed!.args.where as Record<string, unknown>).instrumentType,
      "EQUITY",
    );
  });

  it("seeds from the DEBT universe when every market filter is a bond field", async () => {
    // A bond-yield screen seeded with equities returns nothing and reads as
    // "no bonds match" rather than "we screened the wrong universe".
    const { deps, calls } = makeDb({
      instrumentMapping: [
        {
          id: "i-b",
          symbol: "BOND1",
          exchange: "NSE",
          name: "BOB 8.33% 2031",
          sector: null,
          isin: "INE261F08EO7",
          isActive: true,
          instrumentType: "DEBT",
        },
      ],
      bondEOD: [
        {
          isin: "INE261F08EO7",
          date: day("2026-08-14"),
          segment: "WDM",
          lastPrice: 99,
          lastYtm: 8.4,
          wtdYtm: null,
          totalTradeValueLacs: 10,
        },
      ],
      bondMaster: [
        { isin: "INE261F08EO7", coupon: 8.33, maturityDate: day("2031-03-31") },
      ],
    });

    const out = await runScreener(
      [{ field: "bondYield", operator: "gt", value: 8 }],
      {},
      { ...deps, now: NOW },
    );

    const seed = calls.find(
      (c) => c.model === "instrumentMapping" && c.op === "findMany",
    );
    assert.equal(
      (seed!.args.where as Record<string, unknown>).instrumentType,
      "DEBT",
    );
    assert.deepEqual(
      out.map((r) => r.symbol),
      ["BOND1"],
    );
    assert.equal(out[0]!.market?.bondCoupon, 8.33);
  });

  it("an EMPTY bond table degrades to zero matches, not an error", async () => {
    const { deps } = makeDb({
      instrumentMapping: [
        {
          id: "i-b",
          symbol: "BOND1",
          exchange: "NSE",
          name: "BOB",
          sector: null,
          isin: "INE261F08EO7",
          isActive: true,
          instrumentType: "DEBT",
        },
      ],
      bondEOD: [],
      bondMaster: [],
    });
    const out = await runScreener(
      [{ field: "bondYield", operator: "gt", value: 8 }],
      {},
      { ...deps, now: NOW },
    );
    assert.deepEqual(out, []);
  });

  it("sorts by a market field by reading it off `result.market`", async () => {
    const { deps } = makeDb({
      instrumentMapping: equityUniverse(),
      dailyPrice: SYMBOLS.map((_, i) => ({
        instrumentId: `i-${i}`,
        date: day("2026-08-14"),
        deliveryPct: 40 + i * 10,
        deliveryQty: null,
        avgPrice: null,
        trades: null,
        close: 100,
      })),
    });

    const desc = await runScreener(
      [{ field: "deliveryPct", operator: "gt", value: 0 }],
      { sortBy: "deliveryPct", sortDir: "desc" },
      { ...deps, now: NOW },
    );
    // Reading the field off the TOP level would resolve undefined for every row
    // and leave the input order untouched — an invisible no-op sort.
    assert.deepEqual(
      desc.map((r) => r.market?.deliveryPct),
      [70, 60, 50, 40],
    );

    const asc = await runScreener(
      [{ field: "deliveryPct", operator: "gt", value: 0 }],
      { sortBy: "deliveryPct", sortDir: "asc" },
      { ...deps, now: NOW },
    );
    assert.deepEqual(
      asc.map((r) => r.market?.deliveryPct),
      [40, 50, 60, 70],
    );
  });

  it("honours `limit` after the market filter has run", async () => {
    const { deps } = makeDb({
      instrumentMapping: equityUniverse(),
      dailyPrice: SYMBOLS.map((_, i) => ({
        instrumentId: `i-${i}`,
        date: day("2026-08-14"),
        deliveryPct: 90,
        deliveryQty: null,
        avgPrice: null,
        trades: null,
        close: 100,
      })),
    });
    const out = await runScreener(
      [{ field: "deliveryPct", operator: "gt", value: 50 }],
      { limit: 2 },
      { ...deps, now: NOW },
    );
    assert.equal(out.length, 2);
  });
});

// ════════════════════════════════════════════════════════════════════
// Source hygiene — a literal NUL makes a file INVISIBLE to review
// ════════════════════════════════════════════════════════════════════

/**
 * git classifies a blob as BINARY the moment it finds a NUL byte in the first
 * 8000 bytes, and a binary blob has NO diff: `git diff`, `gh pr diff` and every
 * review tool print `Bin 0 -> 23738 bytes` instead of the change. A composite
 * map key written with a RAW NUL separator embeds that byte in the SOURCE, so
 * the whole module silently stops being reviewable — which is how the unbounded
 * surveillance reference-day `findFirst` guarded above got through review.
 *
 * The separator SEMANTICS are worth keeping (a NUL cannot occur in a symbol, an
 * exchange, an AMC name or an epoch string, so the composite key is
 * unambiguous). Writing it as the two-character escape `\u0000` keeps the
 * runtime byte identical while leaving the file pure ASCII text.
 *
 * Scans the whole package rather than the one known site: the idiom is
 * copy-pasted, and the next copy is the one nobody looks at. A NUL BELOW the
 * 8000-byte sniff window (`market-data/deals.ts` carried one at offset 28,696)
 * still shows a text diff today and flips to binary the moment anything above
 * it is shortened — so "git currently prints a diff" is not a passing grade.
 */
describe("no source file in the repo carries a literal NUL byte", () => {
  // Scoped to `packages/core/src` in its first draft, which is precisely how it
  // missed one: `packages/services/src/peers-sync.service.ts` carried TWO NULs
  // (bytes 4,649 and 6,874) and had been binary to git since MONEY-1145 — the
  // guard's own blind spot, in a workspace nobody had given a scan. Adding a
  // second per-package copy would have been the same mistake with more files,
  // so this walks every workspace, the way `financials-write-authority.test.ts`
  // does. The cost is one readFileSync per .ts file, once.
  const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
  const ROOTS = ["apps", "packages", "workers", "scripts"];
  const SKIP = new Set([
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    "vendor",
    "generated",
  ]);

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out; // a root that does not exist is not a failure
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(full);
      }
    }
    return out;
  };

  const files = ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it("actually scans the repo (a blind scan would pass vacuously)", () => {
    // The failure this guards against is the one it was written to fix: a scan
    // pointed at the wrong root finds nothing and reports success. MONEY-1189's
    // wrong-granularity completeness check, in miniature.
    assert.ok(
      files.length > 1500,
      `expected to scan >1500 source files, saw ${files.length} — the roots ` +
        "are wrong and this guard is blind",
    );
    assert.ok(
      files.some((f) => f.includes(join("packages", "services", "src"))),
      "packages/services/src is not being scanned — that is the workspace the " +
        "first version of this guard missed",
    );
    assert.ok(
      files.some((f) => f.includes(join("workers", "src"))),
      "workers/src is not being scanned",
    );
  });

  it("no .ts/.tsx source file embeds a raw NUL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const at = readFileSync(file).indexOf(0);
      if (at !== -1) {
        offenders.push(`${file.slice(REPO_ROOT.length + 1)} (byte ${at})`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these files embed a raw NUL and are therefore BINARY to git — no " +
        "diff, no review, in `/code-review` or `gh pr diff`. Write the " +
        "separator as the escape `\\u0000`, never the literal byte. Note a " +
        "NUL below git's 8000-byte sniff window still diffs as text TODAY and " +
        "flips to binary the moment anything above it is shortened, so " +
        '"git currently shows a diff" is not a passing grade.',
    );
  });
});

/**
 * MONEY-1402 — every entry point in THIS FILE is called with a pinned clock.
 *
 * ## Why a self-scan, and why it fails TODAY rather than in a month
 *
 * Every market-structure read is bounded `date >= now - MARKET_FIELD_LOOKBACK_DAYS`.
 * So an assertion that lets `now` default to `Date.now()` is not asserting a
 * behaviour — it is asserting how long ago somebody typed the fixture date, and
 * it passes until the calendar catches up.
 *
 * That is not hypothetical. `day("2026-08-14")` sat behind the 30-day
 * `derivatives` window and went red on 2026-09-13 with nothing changed but the
 * date, taking `main` with it for every branch that ran the push gate. Four more
 * assertions reached the same reads through `runScreener`, which had no way to
 * pass a clock down at all; they were fused for the 45- and 60-day windows.
 *
 * A shifted-clock run catches all of that, but nothing runs one in CI. This case
 * is the cheap half: it reads its own source and fails the moment a call site is
 * added without a pinned clock — immediately, in the ordinary suite, instead of
 * on whatever future morning the fixture ages out.
 */
describe("MONEY-1402 — no assertion in this file depends on the wall clock", () => {
  const SELF = readFileSync(new URL(import.meta.url), "utf8");

  /** Call sites of `fn(` in this file, as the source text of each argument list. */
  const callsTo = (fn: string): string[] => {
    const out: string[] = [];
    const needle = `${fn}(`;
    let i = SELF.indexOf(needle);
    while (i !== -1) {
      // Walk to the matching close paren so a nested call cannot end the slice
      // early — `filters.map((f) => f.field)` is an argument, not a terminator.
      let depth = 0;
      let j = i + needle.length - 1;
      for (; j < SELF.length; j++) {
        if (SELF[j] === "(") depth++;
        else if (SELF[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out.push(SELF.slice(i, j + 1));
      i = SELF.indexOf(needle, j);
    }
    return out;
  };

  it("the scan finds the call sites it is meant to police", () => {
    // Without this the two assertions below pass vacuously the day someone
    // renames a helper or the brace-matcher stops finding anything.
    assert.ok(
      callsTo("runScreener").length >= 5,
      `found ${callsTo("runScreener").length} runScreener call sites — the scan broke`,
    );
    assert.ok(
      callsTo("applyMarketStructureFilters").length >= 6,
      `found ${callsTo("applyMarketStructureFilters").length} ` +
        `applyMarketStructureFilters call sites — the scan broke`,
    );
    assert.ok(
      callsTo("loadMarketFieldValues").length >= 8,
      `found ${callsTo("loadMarketFieldValues").length} ` +
        `loadMarketFieldValues call sites — the scan broke`,
    );
  });

  it("every call pins `now` to NOW", () => {
    const offenders: string[] = [];
    for (const fn of [
      "runScreener",
      "applyMarketStructureFilters",
      "loadMarketFieldValues",
    ]) {
      for (const call of callsTo(fn)) {
        // `NOW` positionally, or `now: NOW` inside the deps object.
        if (!/\bNOW\b/.test(call)) {
          offenders.push(`${fn}: ${call.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these calls let `now` default to Date.now(), so what they assert " +
        "changes with the calendar. Pass NOW positionally, or `now: NOW` in " +
        "the deps object for runScreener.",
    );
  });

  it("the lookback windows this file's fixtures sit behind are the real ones", () => {
    // The fixtures are dated relative to NOW by hand, so the windows they are
    // chosen against have to be read from the source rather than remembered.
    // A widened window is harmless; a NARROWED one silently invalidates a
    // fixture, which is the failure this whole block exists to prevent.
    assert.equal(MARKET_FIELD_LOOKBACK_DAYS.derivatives, 30);
    assert.equal(MARKET_FIELD_LOOKBACK_DAYS.flags, 45);
    assert.equal(MARKET_FIELD_LOOKBACK_DAYS.delivery, 60);
  });
});
