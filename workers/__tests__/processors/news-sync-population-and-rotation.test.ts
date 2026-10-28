/**
 * MONEY-1293 — the news population that was complete, and 79 symbols wide.
 *
 * ## What was measured, and why it does not look like a bug
 *
 * Prod, 2026-08-30. `stock_news` holds 1,727 rows covering **77 distinct
 * symbols**, and every counter on this job reads healthy. It is not stalled and
 * the rotation is not stuck — MONEY-1215 fixed that and the fix holds. 77 is
 * simply the whole of what this job could ever reach:
 *
 *   Holding ∪ WatchlistItem              103 distinct symbols
 *     narrowed by isActive/EQUITY/NSE     79  <- the entire selectable universe
 *   analysisCount > 0                      0  <- the OR's other arm, dead since
 *                                               MONEY-1215 measured it at 0/10,444
 *
 * So a NIFTY 50 constituent nobody in the user base happened to hold or watch
 * had, by construction, no news and no path to any — and nothing anywhere read
 * as unhealthy, because the job genuinely had nothing else to select. That is
 * the shape this file exists to pin: a population gate that is CORRECT and TOO
 * NARROW does not announce itself, and the zero-write monitor's own truth table
 * calls `selected 0 / written 0` "genuinely idle".
 *
 * `index_constituents` was sitting right there the whole time: 3,274 rows over
 * 17 indices, refreshed weekly by `index-constituent-sync` (newest
 * `lastSyncedAt` 2026-08-29), NIFTY 500 at exactly 500 rows and NIFTY Total
 * Market at 750, collapsing to **753 distinct symbols of which 749 are active
 * NSE equities**. Union with the portfolio population: **810 symbols / 782
 * selectable rows**, 9.9x the reach, ~4 days to a full rotation at 50 x 4/day.
 *
 * ## And the stamp that fired twice
 *
 * `newsSyncedAt` was present on **146** instrument rows on that same prod
 * snapshot — 79 NSE and **67 BSE** — against 79 symbols this job has ever
 * selected. `stampSyncMarker` matched on `symbol` alone, so every fetch stamped
 * the BSE twin as well. Inert while discovery pins `exchange: "NSE"`, and not
 * inert afterwards: 2,477 active equity symbols are listed on both venues and
 * **10 of them are two different companies** (KIRLPNU, SEL, CORDELIA,
 * RAJPUTANA, TDPOWERSYS, FOCUS, KALYANI, GSTL, MAL, ZEAL each carry two
 * distinct ISINs), two of which are already inside the widened population.
 *
 * ## Why these assertions can fail
 *
 * Every case drives the REAL exported `processNewsSync` / the REAL exported
 * `buildNewsDiscoveryWhere`. The processor's `deps` defaults ARE the production
 * path (MONEY-1238), so what runs here is what the scheduler runs — there is no
 * re-declared copy of the loop to assert against. Nothing opens a socket, a
 * Pub/Sub client or a database handle, and the sleep is injected, so there is
 * nothing to orphan.
 *
 * The fake Prisma reproduces the two MongoDB behaviours the rotation depends
 * on, rather than a convenient approximation of them:
 *
 *  1. **An ABSENT field sorts FIRST under `asc`.** `newsSyncedAt` is absent —
 *     not null — on every pre-existing `instrument_mappings` row, because
 *     `prisma db push` creates indexes and never fields. Rows are seeded
 *     WITHOUT the key at all, so a rotation that only handled `null` fails
 *     here.
 *  2. **A `null` EQUALITY FILTER matches nothing.** `{ newsSyncedAt: null }`
 *     returns ZERO rows on Mongo (MONEY-1050 / 1205 / 1234 / 1236). The fake
 *     honours that faithfully, so a `where` on the marker empties the
 *     population and the rotation assertions fail rather than silently pass.
 *
 * The `updateMany` fake matches `symbol` AND `exchange` when the caller supplies
 * both, so removing the exchange arm from the processor genuinely reaches the
 * BSE row here — the mutation is not absorbed by a lenient stub.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processNewsSync } from "../../src/processors/news-sync";
import {
  buildNewsDiscoveryWhere,
  normalizeDiscoverySymbols,
  NEWS_DISCOVERY_EXCHANGE,
  DEFAULT_NEWS_LIMIT,
} from "../../src/processors/news-sync-logic";

/* -------------------------------------------------------------------------- */
/* A Mongo-shaped instrument store                                            */
/* -------------------------------------------------------------------------- */

interface Row {
  symbol: string;
  exchange: string;
  isActive: boolean;
  instrumentType: string;
  analysisCount: number;
  /** Present ONLY once stamped. Seeded rows do not carry the key at all. */
  newsSyncedAt?: Date;
}

interface Where {
  isActive?: boolean;
  instrumentType?: string;
  exchange?: string;
  symbol?: string | { in: string[] };
  newsSyncedAt?: unknown;
  OR?: Array<Record<string, unknown>>;
}

/** One leaf predicate, with Mongo's absent-is-not-null semantics. */
function leafMatches(row: Row, key: string, cond: unknown): boolean {
  const has = Object.prototype.hasOwnProperty.call(row, key);
  const value = (row as unknown as Record<string, unknown>)[key];
  if (cond === null) {
    // Prisma's Mongo connector does not treat ABSENT as null: `{f: null}`
    // matches nothing. Reproduced rather than approximated, because the
    // approximation is what would let a `where` on the marker pass here.
    return false;
  }
  if (cond && typeof cond === "object") {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return has && (c.in as string[]).includes(value as string);
    if ("gt" in c) return has && (value as number) > (c.gt as number);
    throw new Error(`fake prisma: unsupported operator ${JSON.stringify(c)}`);
  }
  return has && value === cond;
}

function matches(row: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      const arms = cond as Array<Record<string, unknown>>;
      if (arms.length === 0) return false;
      if (!arms.some((arm) => matches(row, arm as Where))) return false;
      continue;
    }
    if (!leafMatches(row, key, cond)) return false;
  }
  return true;
}

/** Mongo sorts a MISSING field lowest, so an unstamped row leads under `asc`. */
function rank(row: Row, field: string): number | string {
  const has = Object.prototype.hasOwnProperty.call(row, field);
  if (!has) return Number.NEGATIVE_INFINITY;
  const v = (row as unknown as Record<string, unknown>)[field];
  return v instanceof Date ? v.getTime() : (v as string);
}

/**
 * Sort by the orderBy the CALLER supplied, honouring direction.
 *
 * Load-bearing rather than thorough. An earlier draft sorted stale-first
 * unconditionally and ignored `args.orderBy` — so the fake, not the processor,
 * was providing the rotation, and flipping the real `orderBy` to `desc` left
 * every behavioural case green. A fake that hard-codes the property under test
 * cannot see a mutation to it.
 */
function applyOrderBy(
  rows: Row[],
  orderBy: unknown,
): Row[] {
  const terms = (
    Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  ) as Array<Record<string, "asc" | "desc">>;
  if (terms.length === 0) return [...rows];
  return [...rows].sort((a, b) => {
    for (const term of terms) {
      const [field, dir] = Object.entries(term)[0]!;
      const av = rank(a, field);
      const bv = rank(b, field);
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

interface FakeDb {
  rows: Row[];
  holdings: string[];
  watchlist: string[];
  constituents: string[];
  /** Every WHERE the processor handed `findMany`, in order. */
  seenWhere: Where[];
  /** Every orderBy the processor handed `findMany`, in order. */
  seenOrderBy: unknown[];
  /** Every WHERE the processor handed `updateMany`, in order. */
  stampWhere: Where[];
}

function makeDb(init: {
  rows: Row[];
  holdings?: string[];
  watchlist?: string[];
  constituents?: string[];
  constituentsThrow?: boolean;
}): { db: FakeDb; prisma: Record<string, unknown> } {
  const db: FakeDb = {
    rows: init.rows,
    holdings: init.holdings ?? [],
    watchlist: init.watchlist ?? [],
    constituents: init.constituents ?? [],
    seenWhere: [],
    seenOrderBy: [],
    stampWhere: [],
  };
  const group = (xs: string[]) =>
    Promise.resolve([...new Set(xs)].map((symbol) => ({ symbol })));
  const prismaFake = {
    holding: { groupBy: () => group(db.holdings) },
    watchlistItem: { groupBy: () => group(db.watchlist) },
    indexConstituent: {
      groupBy: () =>
        init.constituentsThrow
          ? Promise.reject(new Error("index_constituents unreachable"))
          : group(db.constituents),
    },
    instrumentMapping: {
      findMany: (args: {
        where: Where;
        orderBy?: unknown;
        take?: number;
      }): Promise<Array<{ symbol: string }>> => {
        db.seenWhere.push(args.where);
        db.seenOrderBy.push(args.orderBy);
        const hits = applyOrderBy(
          db.rows.filter((r) => matches(r, args.where)),
          args.orderBy,
        ).slice(0, args.take ?? Infinity);
        return Promise.resolve(hits.map((r) => ({ symbol: r.symbol })));
      },
      updateMany: (args: {
        where: Where;
        data: Record<string, unknown>;
      }): Promise<{ count: number }> => {
        db.stampWhere.push(args.where);
        let count = 0;
        for (const r of db.rows) {
          if (!matches(r, args.where)) continue;
          Object.assign(r, args.data);
          count++;
        }
        return Promise.resolve({ count });
      },
    },
  };
  return { db, prisma: prismaFake };
}

/** A `refreshNews` that always persists one row and records what it was asked. */
function fakeRefresh(asked: string[], opts: { throws?: Set<string> } = {}) {
  return async (symbol: string) => {
    asked.push(symbol);
    if (opts.throws?.has(symbol)) throw new Error(`upstream dead for ${symbol}`);
    return {
      created: 1,
      updated: 0,
      failed: 0,
      fetched: 1,
      servedFresh: false,
      fetchFailed: false,
      articles: [],
    };
  };
}

const noSleep = async (): Promise<void> => {};

/** Silence the processor's own logging for the duration of `fn`. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const l = console.log;
  const w = console.warn;
  const e = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = l;
    console.warn = w;
    console.error = e;
  }
}

/** An unstamped, selectable NSE equity row. */
const nse = (symbol: string, extra: Partial<Row> = {}): Row => ({
  symbol,
  exchange: "NSE",
  isActive: true,
  instrumentType: "EQUITY",
  analysisCount: 0,
  ...extra,
});

/* -------------------------------------------------------------------------- */
/* 1. Discovery reaches index constituents                                    */
/* -------------------------------------------------------------------------- */

describe("MONEY-1293 — discovery spans index constituents, not just portfolios", () => {
  it("[meta] the population that shipped could only ever have been the portfolio", () => {
    // Guards every assertion below. If `analysisCount > 0` ever stopped being
    // the only non-portfolio arm, the widening would be measuring something
    // else and these cases would be arguing about the wrong query.
    const before = buildNewsDiscoveryWhere(["INFY"]);
    assert.deepEqual(
      before.OR,
      [{ symbol: { in: ["INFY"] } }, { analysisCount: { gt: 0 } }],
      "passing no constituents must render byte-identically to the pre-1293 " +
        "shape — otherwise this is a rewrite, not a widening",
    );
  });

  it("renders the constituents as their OWN OR arm, beside the portfolio arm", () => {
    const w = buildNewsDiscoveryWhere(["INFY"], ["RELIANCE", "TCS"]);
    assert.deepEqual(w.OR, [
      { symbol: { in: ["INFY"] } },
      { symbol: { in: ["RELIANCE", "TCS"] } },
      { analysisCount: { gt: 0 } },
    ]);
    // The narrowing keys are untouched by the widening: this stays an
    // active-NSE-equity query, which is what makes the exchange-scoped stamp
    // below correct.
    assert.equal(w.isActive, true);
    assert.equal(w.instrumentType, "EQUITY");
    assert.equal(w.exchange, NEWS_DISCOVERY_EXCHANGE);
  });

  it("omits an EMPTY constituent arm rather than emitting `{ in: [] }`", () => {
    // `{ in: [] }` matches NOTHING in Prisma. Emitted, it would be an arm that
    // can never be satisfied — harmless in an OR, but it would also mean a dead
    // `index-constituent-sync` looked identical to a live one in the query.
    const w = buildNewsDiscoveryWhere(["INFY"], []);
    assert.equal(w.OR.length, 2);
    assert.ok(
      !w.OR.some((arm) => "symbol" in arm && arm.symbol.in.length === 0),
      "no empty `in` list may reach Prisma",
    );
  });

  it("keeps the (still dead) analysed arm — it is free and will one day be true", () => {
    const w = buildNewsDiscoveryWhere(["INFY"], ["TCS"]);
    assert.ok(
      w.OR.some((arm) => "analysisCount" in arm),
      "the analysed set must survive as an OR arm, not be replaced",
    );
  });

  it("SELECTS a constituent that no user holds or watches — the whole point", async () => {
    // NIFTYONLY is in an index and in nobody's portfolio. Before MONEY-1293 it
    // was unreachable: not in the portfolio arm, and `analysisCount` is 0 on
    // every row on prod.
    const { prisma } = makeDb({
      rows: [nse("HELD"), nse("NIFTYONLY"), nse("UNREACHABLE")],
      holdings: ["HELD"],
      constituents: ["NIFTYONLY"],
    });
    const asked: string[] = [];
    const r = await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh(asked) as never,
          sleep: noSleep,
        },
      ),
    );
    assert.deepEqual(asked.sort(), ["HELD", "NIFTYONLY"]);
    assert.equal(r.selected, 2);
    // UNREACHABLE is a real active NSE equity in NO population. It must stay
    // out, or this test would pass against a WHERE that selects the universe
    // and proves nothing about the constituent arm.
    assert.ok(!asked.includes("UNREACHABLE"));
  });

  it("[mutation guard] dropping the constituent arm loses the constituent", () => {
    // The falsifiability statement for the case above, written as an explicit
    // negative so the mutation is visible in the file rather than only in a
    // reviewer's terminal. `buildNewsDiscoveryWhere(portfolio)` IS the
    // pre-MONEY-1293 call, and against the same rows it selects strictly less.
    const rows = [nse("HELD"), nse("NIFTYONLY")];
    const widened = rows.filter((r) =>
      matches(r, buildNewsDiscoveryWhere(["HELD"], ["NIFTYONLY"])),
    );
    const narrow = rows.filter((r) => matches(r, buildNewsDiscoveryWhere(["HELD"])));
    assert.deepEqual(
      widened.map((r) => r.symbol),
      ["HELD", "NIFTYONLY"],
    );
    assert.deepEqual(narrow.map((r) => r.symbol), ["HELD"]);
  });

  it("degrades to the portfolio when index_constituents is unreachable", async () => {
    // A dead constituents lookup must not empty the population. The arm is
    // omitted, not emitted as `{ in: [] }`, so the job falls back to exactly
    // what it selected before MONEY-1293 instead of selecting nothing.
    const { db, prisma } = makeDb({
      rows: [nse("HELD"), nse("NIFTYONLY")],
      holdings: ["HELD"],
      constituents: ["NIFTYONLY"],
      constituentsThrow: true,
    });
    const asked: string[] = [];
    await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh(asked) as never,
          sleep: noSleep,
        },
      ),
    );
    assert.deepEqual(asked, ["HELD"]);
    assert.equal(db.seenWhere[0]!.OR!.length, 2, "constituent arm omitted");
  });

  it("normalises both populations identically — trim, upper, dedupe, drop blanks", () => {
    assert.deepEqual(
      normalizeDiscoverySymbols([" infy ", "INFY", "tcs", "", null, undefined]),
      ["INFY", "TCS"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The stamp is scoped to the exchange the selection is scoped to          */
/* -------------------------------------------------------------------------- */

describe("MONEY-1293 — stampSyncMarker stamps the NSE row and only the NSE row", () => {
  it("leaves the BSE twin unstamped", async () => {
    // Prod carried 146 stamps (79 NSE + 67 BSE) for 79 symbols ever selected.
    const rows = [
      nse("RELIANCE"),
      { ...nse("RELIANCE"), exchange: "BSE" },
    ];
    const { prisma } = makeDb({ rows, holdings: ["RELIANCE"] });
    await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh([]) as never,
          sleep: noSleep,
        },
      ),
    );
    const nseRow = rows.find((r) => r.exchange === "NSE")!;
    const bseRow = rows.find((r) => r.exchange === "BSE")!;
    assert.ok(
      Object.prototype.hasOwnProperty.call(nseRow, "newsSyncedAt"),
      "the row the run actually fetched must rotate",
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(bseRow, "newsSyncedAt"),
      "the BSE twin must NOT be stamped: no run fetched it, and for the 10 " +
        "symbols whose two listings are two different companies that stamp " +
        "would retire a row whose news was never synced",
    );
  });

  it("puts the exchange in the WHERE, read from the constant the query uses", async () => {
    const rows = [nse("RELIANCE")];
    const { db, prisma } = makeDb({ rows, holdings: ["RELIANCE"] });
    await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh([]) as never,
          sleep: noSleep,
        },
      ),
    );
    assert.equal(db.stampWhere.length, 1);
    assert.deepEqual(db.stampWhere[0], {
      symbol: "RELIANCE",
      exchange: NEWS_DISCOVERY_EXCHANGE,
    });
    // The stamp and the selection must name the SAME exchange. Two literals
    // that happen to agree today is how they came to disagree in the first
    // place — one had the arm, the other did not.
    assert.equal(db.seenWhere[0]!.exchange, db.stampWhere[0]!.exchange);
  });

  it("stamps exactly one row per selected symbol, not one per listing", async () => {
    // The count is the falsifiable form of the 146-vs-79 measurement: with the
    // exchange arm the ratio is 1.00, without it, on this fixture, it is 2.00.
    const rows = [
      nse("A"),
      { ...nse("A"), exchange: "BSE" },
      nse("B"),
      { ...nse("B"), exchange: "BSE" },
    ];
    const { prisma } = makeDb({ rows, holdings: ["A", "B"] });
    await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh([]) as never,
          sleep: noSleep,
        },
      ),
    );
    const stamped = rows.filter((r) =>
      Object.prototype.hasOwnProperty.call(r, "newsSyncedAt"),
    );
    assert.equal(stamped.length, 2, "one stamp per selected symbol");
    assert.deepEqual(
      stamped.map((r) => r.exchange),
      ["NSE", "NSE"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Rotation regression guard — the half that already worked                */
/* -------------------------------------------------------------------------- */

describe("MONEY-1293 — the MONEY-1215 rotation still holds", () => {
  it("orders stale-first on newsSyncedAt, tie-broken on symbol", async () => {
    const { db, prisma } = makeDb({ rows: [nse("A")], holdings: ["A"] });
    await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh([]) as never,
          sleep: noSleep,
        },
      ),
    );
    assert.deepEqual(db.seenOrderBy[0], [
      { newsSyncedAt: "asc" },
      { symbol: "asc" },
    ]);
  });

  it("NEVER puts the marker in the WHERE — `{marker: null}` matches zero rows", async () => {
    // Not a style rule. `newsSyncedAt` is ABSENT on every pre-existing row, so
    // a `where` on it selects nothing and the job reports a clean, healthy,
    // entirely empty run forever (MONEY-1050 / 1205 / 1234 / 1236). The fake
    // reproduces that, so this fails loudly rather than by inspection.
    const { db, prisma } = makeDb({ rows: [nse("A")], holdings: ["A"] });
    await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh([]) as never,
          sleep: noSleep,
        },
      ),
    );
    assert.ok(!("newsSyncedAt" in db.seenWhere[0]!));
  });

  it("advances past a stamped row instead of re-selecting it", async () => {
    // Absent sorts lowest, so the never-synced row leads; once stamped it goes
    // to the back and the next run reaches the next symbol. A `desc` order — or
    // a constant sort key — hands every run the same head forever (MONEY-1211).
    const rows = [nse("A"), nse("B")];
    const { prisma } = makeDb({ rows, holdings: ["A", "B"] });
    const asked: string[] = [];
    const refresh = fakeRefresh(asked) as never;
    await quiet(() =>
      processNewsSync(
        { limit: 1 },
        { prisma: prisma as never, refreshNews: refresh, sleep: noSleep },
      ),
    );
    await quiet(() =>
      processNewsSync(
        { limit: 1 },
        { prisma: prisma as never, refreshNews: refresh, sleep: noSleep },
      ),
    );
    assert.deepEqual(asked, ["A", "B"], "run 2 must reach the tail, not re-do A");
  });

  it("STAMPS A SYMBOL WHOSE PASS THREW — an unstamped failure owns the head forever", async () => {
    // The regression this guards is not hypothetical: `financial-data-sync` has
    // exactly this shape, with ~14 of every 100 rows unresolvable symbols
    // pinned to the front of the sort. A failed symbol that keeps its absent
    // marker leads every future page and starves the tail.
    const rows = [nse("DEAD"), nse("ALIVE")];
    const { db, prisma } = makeDb({ rows, holdings: ["DEAD", "ALIVE"] });
    const asked: string[] = [];
    const r = await quiet(() =>
      processNewsSync(
        {},
        {
          prisma: prisma as never,
          refreshNews: fakeRefresh(asked, {
            throws: new Set(["DEAD"]),
          }) as never,
          sleep: noSleep,
        },
      ),
    );
    assert.equal(r.failed, 1);
    const dead = rows.find((x) => x.symbol === "DEAD")!;
    assert.ok(
      Object.prototype.hasOwnProperty.call(dead, "newsSyncedAt"),
      "a symbol whose pass threw must still rotate",
    );
    // And the failure stamp is exchange-scoped too — the catch branch is a
    // SECOND call site, and a fix applied to only the success path would leave
    // the defect alive on exactly the rows that hit it most often.
    assert.ok(
      db.stampWhere.every((w) => w.exchange === NEWS_DISCOVERY_EXCHANGE),
      "every stamp — success and failure — must carry the exchange",
    );
  });

  it("[meta] the default limit is what production actually runs with", () => {
    // A rotation argument sized against a batch nobody uses is arithmetic about
    // a different job. The scheduler publishes `{}`.
    assert.equal(DEFAULT_NEWS_LIMIT, 50);
  });
});
