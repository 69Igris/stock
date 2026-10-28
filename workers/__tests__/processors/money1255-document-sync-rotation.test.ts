/**
 * MONEY-1255 — the stock-document-sync batch that never rotated.
 *
 * Measured on prod 2026-08-26: 15,866 of 20,804 active equity rows carry NO
 * document at all (76.3%); only 2,614 of 18,331 distinct active symbols have
 * one. The cause was not throughput and not an upstream — it was that
 * `orderBy: { analysisCount: "desc" }` sorts on a column that is 0 on ALL
 * 10,444 active NSE equities, so every run resolved the identical order and
 * re-synced the same ~250 symbols forever.
 *
 * Every case here drives the REAL exported `processStockDocumentSync` against
 * injected fakes. There is no re-declared copy of the loop: the defaults in the
 * processor's `deps` argument ARE the production path, so what runs here is
 * what the scheduler runs. Nothing opens a socket, a Pub/Sub client or a
 * database handle, and every sleep and clock is injected, so there is nothing
 * to orphan.
 *
 * The fake Prisma models the two MongoDB behaviours the fix depends on:
 *
 *  1. **An ABSENT field sorts first under `asc`.** `documentsSyncedAt` is
 *     absent — not null — on every pre-existing row, because `prisma db push`
 *     creates indexes and never fields. Rows are seeded WITHOUT the key at all
 *     (`hasOwnProperty` is false), so a fix that only worked for `null` fails
 *     here.
 *  2. **A `null` EQUALITY FILTER matches nothing.** Prisma's Mongo connector
 *     does not treat absent as null, so `{ documentsSyncedAt: null }` returns
 *     ZERO rows. The fake reproduces that faithfully rather than throwing: if
 *     the processor ever filters on the marker, the population silently
 *     empties and the rotation assertions fail — which is exactly how
 *     MONEY-1050 / 1205 / 1234 / 1236 presented in production.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processStockDocumentSync } from "../../src/processors/stock-document-sync";
import {
  MAX_SYMBOLS_PER_RUN,
  MAX_SYNC_CHAIN_DEPTH,
  SYNC_RUN_TIME_BUDGET_MS,
  SCREENER_PAGE_DOC_TYPES,
  resolveEnabledLegs,
  resolveLegsForTarget,
  partitionSymbolPage,
} from "../../src/processors/stock-document-sync-logic";
import type { StockDocumentSyncMessage } from "@usemoney/types/pubsub";

/* -------------------------------------------------------------------------- */
/* A Mongo-shaped instrument store                                             */
/* -------------------------------------------------------------------------- */

interface Row {
  id: string;
  symbol: string;
  exchange: string;
  isActive: boolean;
  instrumentType: string;
  tickertapeSid: string | null;
  analysisCount: number;
  /** Present ONLY once stamped. Seeded rows do not carry the key at all. */
  documentsSyncedAt?: Date;
  /** MONEY-1255 (A2) — the full company name. */
  name: string;
  /** MONEY-1255 (A2) — the join key the screener slug is resolved through. */
  isin?: string | null;
  /**
   * The screener-identity columns — MONEY-1255 (A2).
   *
   * OPTIONAL, and seeded rows do not carry the keys at all, for the same reason
   * `documentsSyncedAt` does not: `prisma db push` creates indexes and never
   * fields, so on all ~20,804 pre-existing rows these attributes are ABSENT
   * rather than null. A cache decision written for `null` would never fire.
   */
  screenerSlug?: string | null;
  screenerSlugCheckedAt?: Date | null;
  bseScripCode?: string | null;
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

function makeRows(
  count: number,
  opts: { exchange?: string; prefix?: string } = {},
): Row[] {
  const prefix = opts.prefix ?? "SYM";
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${prefix}${i}`,
    symbol: `${prefix}${String(i).padStart(4, "0")}`,
    name: `${prefix}${String(i).padStart(4, "0")} Industries Ltd`,
    exchange: opts.exchange ?? "NSE",
    isActive: true,
    instrumentType: "EQUITY",
    tickertapeSid: null,
    // The measured production reality: constant across the whole population.
    analysisCount: 0,
  }));
}

/**
 * A Prisma stand-in for `instrument_mappings` + `stock_documents`.
 *
 * `findMany` implements the ordering semantics the fix relies on; `updateMany`
 * implements the stamp. Both are faithful to Mongo rather than convenient.
 */
function makeDb(rows: Row[]) {
  const selections: Array<{ symbols: string[]; take: number }> = [];
  /** Every `instrumentMapping.update` the run issued — MONEY-1255 (A2). */
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    rows,
    selections,
    updates,
    instrumentMapping: {
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      }) => {
        const where = args.where ?? {};
        // MONGO SEMANTICS: an equality filter on an ABSENT field matches
        // nothing. Reproduced, not thrown, because that is how it fails in
        // production — silently, as an empty population.
        if ("documentsSyncedAt" in where) return [];

        let pool = rows.filter(
          (r) =>
            r.isActive === (where.isActive ?? r.isActive) &&
            r.instrumentType === (where.instrumentType ?? r.instrumentType),
        );
        const ex = where.exchange as { in?: string[] } | undefined;
        if (ex?.in) pool = pool.filter((r) => ex.in!.includes(r.exchange));
        if (Array.isArray(where.OR)) {
          pool = pool.filter((r) => r.tickertapeSid !== null);
        }

        // ORDER: honour whatever the processor asked for, so a wrong orderBy
        // produces a wrong page rather than being quietly ignored.
        const order = (
          Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy ?? {}]
        ) as Array<Record<string, "asc" | "desc">>;
        const sorted = [...pool].sort((a, b) => {
          for (const clause of order) {
            for (const [key, dir] of Object.entries(clause)) {
              const av = (a as unknown as Record<string, unknown>)[key];
              const bv = (b as unknown as Record<string, unknown>)[key];
              // A MISSING field sorts LOWEST on Mongo — an unstamped row is the
              // most stale thing there is, which is the whole mechanism.
              const an = av === undefined ? -Infinity : Number(av) || String(av);
              const bn = bv === undefined ? -Infinity : Number(bv) || String(bv);
              if (an === bn) continue;
              const cmp = an < bn ? -1 : 1;
              return dir === "desc" ? -cmp : cmp;
            }
          }
          return 0;
        });

        const page = sorted.slice(0, args.take ?? sorted.length);
        selections.push({
          symbols: page.map((r) => r.symbol),
          take: args.take ?? -1,
        });
        return page.map((r) => ({ symbol: r.symbol, exchange: r.exchange }));
      },
      findFirst: async (args: {
        where: { symbol: string; exchange?: string | { in: string[] } };
      }) => {
        let hits = rows.filter(
          (r) => r.symbol === args.where.symbol && r.isActive,
        );
        // The processor PINS the exchange for a discovered row (the page
        // already chose the listing) and passes `{ in: [...] }` only for a
        // caller-supplied symbol. A fake that ignored the arm would hand back
        // the NSE row for a query that asked for BSE.
        const ex = args.where.exchange;
        if (typeof ex === "string") hits = hits.filter((r) => r.exchange === ex);
        else if (ex?.in) hits = hits.filter((r) => ex.in.includes(r.exchange));
        // `exchange: "desc"` puts NSE first.
        const nse = hits.find((r) => r.exchange === "NSE");
        const hit = nse ?? hits[0];
        // The row is returned FIELD BY FIELD, mirroring Prisma's `select`, and
        // the screener-identity keys are only present when the seeded row
        // carries them. Spreading `hit` wholesale would materialise
        // `screenerSlug: undefined` on every row and hide the ABSENT case the
        // cache decision has to handle.
        if (!hit) return null;
        const row: Record<string, unknown> = {
          id: hit.id,
          exchange: hit.exchange,
          tickertapeSid: hit.tickertapeSid,
          name: hit.name,
        };
        for (const key of [
          "isin",
          "screenerSlug",
          "screenerSlugCheckedAt",
          "bseScripCode",
        ] as const) {
          if (Object.prototype.hasOwnProperty.call(hit, key)) row[key] = hit[key];
        }
        return row;
      },
      /** MONEY-1255 (A2) — where a resolved slug is persisted. */
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (row) Object.assign(row, args.data);
        updates.push({ id: args.where.id, data: args.data });
        return row ?? null;
      },
      updateMany: async (args: {
        where: { symbol: { in: string[] } };
        data: { documentsSyncedAt: Date };
      }) => {
        const wanted = new Set(args.where.symbol.in);
        let count = 0;
        for (const r of rows) {
          if (wanted.has(r.symbol)) {
            r.documentsSyncedAt = args.data.documentsSyncedAt;
            count++;
          }
        }
        return { count };
      },
    },
    stockDocument: {
      findUnique: async () => null,
      upsert: async () => ({ id: "doc" }),
    },
  };
}

/** Every upstream dark; the chain publishes are recorded, never opened. */
function darkSources(published: StockDocumentSyncMessage[] = []) {
  return {
    getOrFetchFinancials: async () => null,
    fetchNSEFinancialResults: async () => [],
    fetchCategorizedAnnouncements: async () => [],
    scrapeScreenerFullPage: async () => null,
    // MONEY-1255 (A2) — BSE's scrip master is dark too, and it MUST be
    // injected: its production default is the real fetcher, so a BSE-only
    // fixture that forgot this dep would reach api.bseindia.com from a unit
    // test. `[]` here means "the master had no row for this company", which the
    // resolver reports as `unavailable` — see BSE_MASTER below for the fixture
    // that actually resolves.
    fetchBseScripMaster: async () => [],
    uploadToGCS: async () => {},
    publishExtractJob: async () => {},
    publishNextBatch: async (m: StockDocumentSyncMessage) => {
      published.push(m);
    },
    sleep: noSleep,
  };
}

/* -------------------------------------------------------------------------- */
/* DEFECT 1 — the batch never rotated                                          */
/* -------------------------------------------------------------------------- */

describe("stock-document-sync: the page ROTATES", () => {
  it("REGRESSION: consecutive runs return DISJOINT batches", async () => {
    // The defect, stated as a test: with `analysisCount: "desc"` over a
    // population where every analysisCount is 0, run 2 got the identical page
    // run 1 got, and the tail was never reached. The old test suite ASSERTED
    // that as intended behaviour ("Re-running re-processes the SAME head
    // (idempotent), never the tail").
    const db = makeDb(makeRows(30));
    const deps = { prisma: db as never, ...darkSources() };
    const msg = { batchSize: 10 } as StockDocumentSyncMessage;

    const first = await quiet(() => processStockDocumentSync(msg, deps));
    const second = await quiet(() => processStockDocumentSync(msg, deps));
    const third = await quiet(() => processStockDocumentSync(msg, deps));

    const [p1, p2, p3] = db.selections.map((s) => s.symbols);
    assert.strictEqual(p1!.length, 10);
    assert.strictEqual(p2!.length, 10);
    assert.strictEqual(p3!.length, 10);

    const overlap12 = p1!.filter((s) => p2!.includes(s));
    assert.deepStrictEqual(
      overlap12,
      [],
      "run 2 must not re-select a single symbol run 1 already visited",
    );
    const overlap13 = p1!.filter((s) => p3!.includes(s));
    assert.deepStrictEqual(overlap13, []);
    const overlap23 = p2!.filter((s) => p3!.includes(s));
    assert.deepStrictEqual(overlap23, []);

    // Three runs of 10 must have COVERED the population, not orbited its head.
    const covered = new Set([...p1!, ...p2!, ...p3!]);
    assert.strictEqual(covered.size, 30);

    assert.strictEqual(first.selected, 10);
    assert.strictEqual(second.selected, 10);
    assert.strictEqual(third.selected, 10);
  });

  it("an ABSENT documentsSyncedAt is SELECTED, and sorts ahead of a stamped row", async () => {
    // The Mongo trap. `db push` creates indexes and never fields, so the marker
    // is absent on all ~20,800 pre-existing rows: `hasOwnProperty` is false,
    // not "the value is null". A fix written for `null` selects nothing.
    const rows = makeRows(4);
    // One row is already stamped — it must sort LAST.
    rows[0]!.documentsSyncedAt = new Date("2026-08-25T00:00:00.000Z");
    const db = makeDb(rows);

    // Precondition: the other three genuinely lack the key.
    for (const r of rows.slice(1)) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(r, "documentsSyncedAt"),
        false,
        "the fixture must model ABSENT, not null",
      );
    }

    await quiet(() =>
      processStockDocumentSync({ batchSize: 3 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
      }),
    );

    const page = db.selections[0]!.symbols;
    assert.strictEqual(page.length, 3);
    assert.ok(
      !page.includes(rows[0]!.symbol),
      "the already-stamped row must not lead the page",
    );
    assert.deepStrictEqual(page, [
      rows[1]!.symbol,
      rows[2]!.symbol,
      rows[3]!.symbol,
    ]);
  });

  it("STAMPS ON VISIT — a symbol with no documents still rotates away", async () => {
    // The rule the sibling `annual-reports-sync` broke: stamping only on a
    // WRITE leaves every empty symbol pinned to the head of a stale-first sort,
    // re-selected forever, blocking the tail. Every source here is dark, so
    // NOTHING is written — and every visited row must still be stamped.
    const db = makeDb(makeRows(5));
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 5 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
      }),
    );

    assert.strictEqual(result.written, 0, "precondition: nothing was written");
    assert.strictEqual(result.stamped, 5);
    for (const r of db.rows) {
      assert.ok(
        r.documentsSyncedAt instanceof Date,
        `${r.symbol} was visited and produced nothing — it must still rotate`,
      );
    }
  });

  it("stamps a symbol whose whole pass THREW", async () => {
    // An unfetchable symbol that keeps its stale marker owns a slot on every
    // future run. `news-sync` makes the identical call at `stampSyncMarker`.
    //
    // MUTATION NOTE: this test originally threw from the three UPSTREAM deps,
    // and it SURVIVED deleting the stamp in the outer `catch` — because each
    // leg catches its own upstream error, so the outer catch was never reached
    // and the assertion was met by the ordinary in-loop stamp. It was a test of
    // the wrong path wearing the right name. The freshness lookup in the
    // Tickertape leg sits OUTSIDE any inner try, so throwing from it is what
    // actually reaches the symbol-level catch. `result.failed` is asserted
    // first, as the proof that it did.
    const db = makeDb(makeRows(2));
    db.stockDocument.findUnique = async () => {
      throw new Error("mongo went away mid-symbol");
    };
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 2 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
      }),
    );
    assert.strictEqual(
      result.failed,
      2,
      "precondition: the SYMBOL-LEVEL catch must be the path under test",
    );
    assert.strictEqual(result.stamped, 2);
    for (const r of db.rows) assert.ok(r.documentsSyncedAt instanceof Date);
  });

  it("stamps a symbol whose per-leg upstreams all failed", async () => {
    // The other half, kept explicitly: each leg swallows its own upstream
    // error, so the symbol completes normally and is stamped by the in-loop
    // site. Both paths must stamp; they are different sites and a mutation of
    // one is not caught by a test of the other.
    const db = makeDb(makeRows(2));
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 2 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchNSEFinancialResults: async () => {
          throw new Error("NSE is down");
        },
        fetchCategorizedAnnouncements: async () => {
          throw new Error("NSE is down");
        },
        scrapeScreenerFullPage: async () => {
          throw new Error("screener is down");
        },
      }),
    );
    assert.strictEqual(result.failed, 0, "the legs absorbed their own errors");
    assert.ok(result.transportFailures >= 6);
    assert.strictEqual(result.stamped, 2);
    for (const r of db.rows) assert.ok(r.documentsSyncedAt instanceof Date);
  });

  it("stamps a selected symbol whose instrument row cannot be resolved", async () => {
    // The page and the per-symbol lookup are TWO queries, so they can disagree:
    // a row deactivated between them, or a stored symbol that `cleanSymbol`
    // rewrites, resolves to null. The old code did `processed++; continue;` and
    // left the marker absent — so that symbol led the stale-first page on every
    // subsequent run, permanently, for a lookup that will keep failing.
    //
    // Found by mutation testing: deleting this stamp site broke nothing until
    // this case existed.
    const db = makeDb(makeRows(3));
    const realFindFirst = db.instrumentMapping.findFirst;
    const ghost = db.rows[1]!.symbol;
    db.instrumentMapping.findFirst = async (args: {
      where: { symbol: string };
    }) => (args.where.symbol === ghost ? null : realFindFirst(args));

    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 3 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
      }),
    );

    assert.strictEqual(result.stamped, 3, "the unresolvable symbol must rotate");
    const row = db.rows.find((r) => r.symbol === ghost)!;
    assert.ok(
      row.documentsSyncedAt instanceof Date,
      "a symbol with no resolvable instrument row is still a VISIT",
    );
  });

  it("stamps EXCLUDED symbols, or they lead the page forever", async () => {
    // Index pseudo-symbols and ETF/debt prefixes are filtered out AFTER
    // selection, so they consume page slots. Unstamped, they are selected first
    // on every run and filtered out again — the same stall, one level down.
    const rows = [
      { ...makeRows(1, { prefix: "NIFTY" })[0]!, symbol: "NIFTY" },
      { ...makeRows(1, { prefix: "LIQ" })[0]!, symbol: "LIQUIDBEES" },
      { ...makeRows(1, { prefix: "REAL" })[0]!, symbol: "INFY" },
    ];
    const db = makeDb(rows as Row[]);
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 3 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
      }),
    );

    assert.strictEqual(result.selected, 1, "only INFY is a researchable equity");
    assert.strictEqual(result.rowsSelected, 3);
    assert.strictEqual(result.stamped, 3, "all three rows must rotate");
    for (const r of db.rows) {
      assert.ok(
        r.documentsSyncedAt instanceof Date,
        `${r.symbol} must be stamped even though it was excluded`,
      );
    }
  });

  it("a dual-listed symbol is visited ONCE, on its NSE row", async () => {
    const rows: Row[] = [
      { ...makeRows(1)[0]!, symbol: "TCS", exchange: "BSE", id: "bse" },
      { ...makeRows(1)[0]!, symbol: "TCS", exchange: "NSE", id: "nse" },
    ];
    const db = makeDb(rows);
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 2 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
      }),
    );
    assert.strictEqual(result.rowsSelected, 2);
    assert.strictEqual(result.selected, 1);
    assert.strictEqual(
      result.noNseListing,
      0,
      "a dual listing is NOT a BSE-only symbol",
    );
    // Both rows rotate together — the unit of work is the SYMBOL.
    assert.strictEqual(result.stamped, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* DEFECT 3 — BSE-only symbols burned a slot and vanished                      */
/* -------------------------------------------------------------------------- */

describe("stock-document-sync: a BSE-only symbol is COUNTED, not vanished", () => {
  it("REGRESSION: the skip is counted and the row still rotates", async () => {
    // The old code selected NSE **and** BSE rows, discarded the exchange with
    // `select: { symbol: true }`, hardcoded `const exchange = "NSE"`, missed,
    // and `continue`d with NO log line and NO counter. The symbol consumed one
    // of the 250 slots and produced nothing, invisibly, on every cycle.
    const rows: Row[] = [
      { ...makeRows(1)[0]!, symbol: "BSEONLY", exchange: "BSE", id: "b1" },
      { ...makeRows(1)[0]!, symbol: "INFY", exchange: "NSE", id: "n1" },
    ];
    const db = makeDb(rows);
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 2 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
      }),
    );

    assert.strictEqual(result.noNseListing, 1);
    assert.strictEqual(result.selected, 2);
    assert.strictEqual(result.stamped, 2, "a skipped BSE row must still rotate");
    const bse = db.rows.find((r) => r.symbol === "BSEONLY")!;
    assert.ok(bse.documentsSyncedAt instanceof Date);
  });

  it("the count reaches the job outcome, where an operator can see it", async () => {
    const rows: Row[] = [
      { ...makeRows(1)[0]!, symbol: "BSEONLY", exchange: "BSE", id: "b1" },
    ];
    const db = makeDb(rows);
    const lines: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await processStockDocumentSync(
        { batchSize: 1 } as StockDocumentSyncMessage,
        { prisma: db as never, ...darkSources() },
      );
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    const outcome = lines.find((l) => l.startsWith("[job-outcome]"));
    assert.ok(outcome, "the run must emit a job outcome");
    assert.match(String(outcome), /1 symbol\(s\) with no NSE listing/);
  });
});

/* -------------------------------------------------------------------------- */
/* DEFECT 2 — the run could not finish inside the ack deadline                 */
/* -------------------------------------------------------------------------- */

describe("stock-document-sync: the run is bounded by a WALL CLOCK", () => {
  /** A clock that advances `stepMs` on every read. */
  function fakeClock(stepMs: number) {
    let t = 0;
    return () => {
      const now = t;
      t += stepMs;
      return now;
    };
  }

  it("stops taking new symbols once the budget is spent", async () => {
    // 250 symbols x 2,000ms of politeness sleep + 250 x 3,000ms of Screener
    // self-throttle is 1,248s against a 600s ack deadline. Overrunning it does
    // not make the run slow — Pub/Sub redelivers and a SECOND copy starts on
    // the same page.
    const db = makeDb(makeRows(50));
    // Each clock read jumps 40s, so the budget is exhausted after a handful of
    // symbols regardless of how fast the fakes are.
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 50 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        now: fakeClock(40_000),
      }),
    );

    assert.strictEqual(result.stoppedOnBudget, true);
    assert.ok(
      result.stamped < 50,
      `the run must stop short of the page (stamped ${result.stamped})`,
    );
    assert.ok(result.stamped > 0, "it must make SOME progress");
  });

  it("the unvisited remainder is NOT lost — it leads the next page", async () => {
    // The old clamp DROPPED the tail ("head-only slice — no cursor"). Under a
    // stale-first sort an unvisited row keeps its absent marker, so it is the
    // first thing the next selection sees.
    const db = makeDb(makeRows(20));
    const deps = { prisma: db as never, ...darkSources() };
    const truncated = await quiet(() =>
      processStockDocumentSync({ batchSize: 20 } as StockDocumentSyncMessage, {
        ...deps,
        now: fakeClock(60_000),
      }),
    );
    const visited = db.rows
      .filter((r) => r.documentsSyncedAt)
      .map((r) => r.symbol);
    assert.ok(truncated.stoppedOnBudget);
    assert.ok(visited.length < 20);

    await quiet(() =>
      processStockDocumentSync({ batchSize: 20 } as StockDocumentSyncMessage, deps),
    );
    const secondPage = db.selections[1]!.symbols;
    for (const s of visited) {
      assert.ok(
        !secondPage.slice(0, 20 - visited.length).includes(s),
        `${s} was already visited and must not lead the next page`,
      );
    }
    // Everything now carries a marker: the page was finished, not dropped.
    assert.strictEqual(db.rows.every((r) => !!r.documentsSyncedAt), true);
  });

  it("a run that fits its budget does NOT report truncation", async () => {
    // The negative control: `stoppedOnBudget` must not be hard-wired true.
    const db = makeDb(makeRows(5));
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 5 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        now: fakeClock(1),
      }),
    );
    assert.strictEqual(result.stoppedOnBudget, false);
    assert.strictEqual(result.stamped, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* DEFECT 2 (cont.) — the self-chain, and that it terminates                   */
/* -------------------------------------------------------------------------- */

describe("stock-document-sync: the drain chain", () => {
  it("chains a follow-up carrying depth + 1 and the ORIGINAL scope", async () => {
    // `docTypes:["financial_statement"]` is the tickertape-daily payload, whose
    // WHERE additionally requires a `tickertapeSid` — so the rows must carry
    // one or the population is legitimately empty and nothing chains.
    const rows = makeRows(4).map((r) => ({ ...r, tickertapeSid: "sid" }));
    const db = makeDb(rows);
    const published: StockDocumentSyncMessage[] = [];
    const result = await quiet(() =>
      processStockDocumentSync(
        {
          batchSize: 2,
          docTypes: ["financial_statement"],
        } as StockDocumentSyncMessage,
        { prisma: db as never, ...darkSources(published) },
      ),
    );

    assert.strictEqual(result.chained, true);
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0]!.chainDepth, 1);
    assert.strictEqual(published[0]!.batchSize, 2);
    assert.deepStrictEqual(published[0]!.docTypes, ["financial_statement"]);
  });

  it("TERMINATES — driving the real processor until it stops chaining", async () => {
    // The adversarial environment: the population is always larger than the
    // page, so "the queue ran dry" can never end this. Only the depth bound
    // can, which is the point — it is a pure function of a number carried on
    // the message and consults no database.
    const db = makeDb(makeRows(500));
    let message = { batchSize: 2 } as StockDocumentSyncMessage;
    let links = 0;
    for (;;) {
      const published: StockDocumentSyncMessage[] = [];
      const result = await quiet(() =>
        processStockDocumentSync(message, {
          prisma: db as never,
          ...darkSources(published),
        }),
      );
      if (!result.chained) break;
      message = published[0]!;
      links += 1;
      assert.ok(
        links < MAX_SYNC_CHAIN_DEPTH * 5,
        "the chain did not terminate — runaway poll",
      );
    }
    assert.strictEqual(links, MAX_SYNC_CHAIN_DEPTH - 1);
  });

  it("does NOT chain when the page came back short", async () => {
    const db = makeDb(makeRows(3));
    const published: StockDocumentSyncMessage[] = [];
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 10 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(published),
      }),
    );
    assert.strictEqual(result.chained, false);
    assert.deepStrictEqual(published, []);
  });

  it("does NOT chain a caller-supplied symbol list", async () => {
    const db = makeDb(makeRows(3));
    const published: StockDocumentSyncMessage[] = [];
    const result = await quiet(() =>
      processStockDocumentSync(
        { symbols: ["SYM0000", "SYM0001"] } as StockDocumentSyncMessage,
        { prisma: db as never, ...darkSources(published) },
      ),
    );
    assert.strictEqual(result.chained, false);
    assert.deepStrictEqual(published, []);
  });

  it("does NOT chain when the rotation did not move", async () => {
    // Zero stamps means the next link re-selects the identical page. That is
    // the runaway-poll shape this repo already has an incident for.
    const db = makeDb(makeRows(10));
    db.instrumentMapping.updateMany = async () => {
      throw new Error("stamp failed");
    };
    const published: StockDocumentSyncMessage[] = [];
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 4 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(published),
      }),
    );
    assert.strictEqual(result.stamped, 0);
    assert.strictEqual(result.chained, false);
    assert.deepStrictEqual(published, []);
  });

  it("a forged chainDepth ENDS the chain rather than extending it", async () => {
    const db = makeDb(makeRows(500));
    const published: StockDocumentSyncMessage[] = [];
    const result = await quiet(() =>
      processStockDocumentSync(
        { batchSize: 2, chainDepth: 1e9 } as StockDocumentSyncMessage,
        { prisma: db as never, ...darkSources(published) },
      ),
    );
    assert.strictEqual(result.chained, false);
    assert.deepStrictEqual(published, []);
  });

  it("the page `take` is the CLAMPED size, so the chain can read 'drained'", async () => {
    // The scheduler sends `batchSize: 8000`. Passing that as `take` and
    // clamping afterwards would make a full page look drained and stop the
    // chain after one link, every night.
    const db = makeDb(makeRows(MAX_SYMBOLS_PER_RUN + 10));
    await quiet(() =>
      processStockDocumentSync({ batchSize: 8000 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        now: (() => {
          let t = 0;
          return () => (t += SYNC_RUN_TIME_BUDGET_MS);
        })(),
      }),
    );
    assert.strictEqual(db.selections[0]!.take, MAX_SYMBOLS_PER_RUN);
  });
});

/* -------------------------------------------------------------------------- */
/* DEFECT 4 — the counters counted ATTEMPTS, not writes                        */
/* -------------------------------------------------------------------------- */

describe("stock-document-sync: counts are WRITES, per source", () => {
  /** A Screener page carrying one downloadable annual report. */
  function screenerPage() {
    return {
      symbol: "INFY",
      profitAndLoss: null,
      quarterlyResults: null,
      balanceSheet: null,
      cashFlows: null,
      ratios: null,
      compoundedGrowth: "",
      compoundedGrowthData: {
        salesGrowth: {},
        profitGrowth: {},
        stockPriceCagr: {},
        returnOnEquity: {},
      },
      shareholding: [],
      peers: [],
      documents: [],
      corporateActions: [],
      fullText: "",
    };
  }

  it("REGRESSION: a source that 403s every request reports ZERO writes", async () => {
    // Every per-source counter used to be incremented BEFORE the call it
    // counted (`apiCalls.nse++` then `fetchNSEFinancialResults`), so a source
    // that answered 403 to every request still produced a full-looking count —
    // which is exactly the reading that hid Tickertape's block for five months.
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY" }];
    const db = makeDb(rows);
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchNSEFinancialResults: async () => {
          throw new Error("403 Forbidden");
        },
        fetchCategorizedAnnouncements: async () => {
          throw new Error("403 Forbidden");
        },
        scrapeScreenerFullPage: async () => {
          throw new Error("403 Forbidden");
        },
      }),
    );

    assert.strictEqual(result.wrote.nse, 0);
    assert.strictEqual(result.wrote.screener, 0);
    assert.strictEqual(result.written, 0);
    // The ATTEMPT counters still moved — they are the API budget, not health.
    assert.ok(result.api.nse > 0, "attempts are still counted, separately");
    // Three failing legs, three upstream failures.
    assert.strictEqual(result.transportFailures, 3);
  });

  it("a real write IS attributed to the source that produced it", async () => {
    // The positive control: `wrote` must not be hard-wired to 0.
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY", tickertapeSid: "sid" }];
    const db = makeDb(rows);
    const result = await quiet(() =>
      processStockDocumentSync(
        { batchSize: 1, docTypes: ["financial_statement"] } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          getOrFetchFinancials: async () =>
            ({
              income: [{ revenue: 1 }],
              balanceSheet: [],
              cashFlow: [],
              source: "TEST",
              fromCache: false,
            }) as never,
        },
      ),
    );
    assert.strictEqual(result.wrote.tickertape, 2, "one symbol x two periods");
    assert.strictEqual(result.wrote.nse, 0);
    assert.strictEqual(result.wrote.screener, 0);
    assert.strictEqual(result.written, 2);
    assert.strictEqual(result.transportFailures, 0);
  });

  it("a Screener write is attributed to screener, not to the whole run", async () => {
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY" }];
    const db = makeDb(rows);
    const page = screenerPage();
    page.fullText = "x".repeat(500);
    const result = await quiet(() =>
      processStockDocumentSync(
        { batchSize: 1, docTypes: ["screener_financials"] } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          scrapeScreenerFullPage: async () => page as never,
        },
      ),
    );
    assert.strictEqual(result.wrote.screener, 1);
    assert.strictEqual(result.wrote.tickertape, 0);
    assert.strictEqual(result.written, 1);
  });

  it("an NSE filing that LANDS is counted against nse, not against attempts", async () => {
    // The NSE write counter lives inside `storeNSEFiling`, past a download. It
    // was invisible to every test until `httpGet` became a seam — and a counter
    // no test can observe is a counter no mutation is caught in: deleting
    // `run.wrote.nse++` passed the whole suite.
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY" }];
    const db = makeDb(rows);
    const pdf = Buffer.alloc(4096, 1);
    const result = await quiet(() =>
      processStockDocumentSync(
        { batchSize: 1, docTypes: ["quarterly_result"] } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          fetchNSEFinancialResults: async () =>
            [
              {
                symbol: "INFY",
                title: "Q1-2026 Financial Results",
                description: "results",
                attachmentUrl: "/content/x.pdf",
                filingDate: new Date("2026-07-15T00:00:00.000Z"),
                category: "Financial Results",
              },
            ] as never,
          httpGet: (() => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => pdf,
            headers: { get: () => "application/pdf" },
          })) as never,
        },
      ),
    );
    assert.strictEqual(result.wrote.nse, 1);
    assert.strictEqual(result.wrote.tickertape, 0);
    assert.strictEqual(result.wrote.screener, 0);
    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.transportFailures, 0);
  });

  it("an NSE download that 404s is an UPSTREAM failure, not a quiet nothing", async () => {
    // "NSE has no PDF here" and "NSE will not serve us" are different claims and
    // only the second is a problem. The non-2xx branch used to `return 0` with
    // neither counted.
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY" }];
    const db = makeDb(rows);
    const result = await quiet(() =>
      processStockDocumentSync(
        { batchSize: 1, docTypes: ["quarterly_result"] } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          fetchNSEFinancialResults: async () =>
            [
              {
                symbol: "INFY",
                title: "Q1-2026 Financial Results",
                description: "results",
                attachmentUrl: "/content/x.pdf",
                filingDate: new Date("2026-07-15T00:00:00.000Z"),
                category: "Financial Results",
              },
            ] as never,
          httpGet: (() => ({
            ok: false,
            status: 404,
            arrayBuffer: async () => Buffer.alloc(0),
            headers: { get: () => null },
          })) as never,
        },
      ),
    );
    assert.strictEqual(result.wrote.nse, 0);
    assert.strictEqual(result.written, 0);
    assert.strictEqual(result.transportFailures, 1);
  });

  it("a Screener PDF that LANDS is counted against screener", async () => {
    // NOTE the docType: `concall_transcript`, not `annual_report`. The
    // Screener leg's gate list (`SCREENER_PAGE_DOC_TYPES`) does NOT contain
    // `annual_report`, even though `VALID_SCREENER_DOC_TYPES` does — so a
    // targeted `annual_report` request reaches the NSE announcements leg only
    // and never fetches the Screener page. That is PRE-EXISTING and unchanged
    // here; it is called out because `resolveEnabledLegs` mirrors the gate
    // exactly, so the run-health verdict stays honest either way.
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY" }];
    const db = makeDb(rows);
    const page = screenerPage();
    page.documents = [
      {
        type: "concall_transcript",
        title: "Q1 FY26 concall",
        url: "https://example.test/concall.pdf",
        period: "Q1-2026",
      },
    ] as never;
    const pdf = Buffer.alloc(4096, 1);
    const result = await quiet(() =>
      processStockDocumentSync(
        { batchSize: 1, docTypes: ["concall_transcript"] } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          scrapeScreenerFullPage: async () => page as never,
          httpGet: (() => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => pdf,
            headers: { get: () => "application/pdf;charset=UTF-8" },
          })) as never,
        },
      ),
    );
    assert.strictEqual(result.wrote.screener, 1);
    assert.strictEqual(result.wrote.nse, 0);
    assert.strictEqual(result.written, 1);
  });

  it("transportFailures REACHES the job outcome, where the branch reads it", async () => {
    // `job-outcome.ts` has a dedicated "wrote 0 after N UPSTREAM failure(s)"
    // branch. Without this field it is unreachable, and a total upstream block
    // emits a clean 0/0/0 — indistinguishable from a healthy quiet run.
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY" }];
    const db = makeDb(rows);
    const lines: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    const realErr = console.error;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.error = () => {};
    try {
      await processStockDocumentSync(
        { batchSize: 1 } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          scrapeScreenerFullPage: async () => {
            throw new Error("403 Forbidden");
          },
        },
      );
    } finally {
      console.warn = realWarn;
      console.log = realLog;
      console.error = realErr;
    }
    const outcome = lines.find((l) => l.includes("[job-outcome]"));
    assert.ok(outcome, "the run must emit a job outcome");
    assert.match(
      String(outcome),
      /UPSTREAM failure\(s\)/,
      "the transport-failure branch of job-outcome must be reachable",
    );
    assert.match(String(outcome), /"transportFailures":1/);
  });

  it("REGRESSION: a healthy tickertape-daily run does NOT flag a dead source", async () => {
    // The old condition was `apiCalls.tickertape === 0 || apiCalls.nse === 0`.
    // This schedule gates both NSE legs off BY DESIGN, so it fired on every
    // healthy weekday run — a permanently-asserted alarm.
    const rows = [{ ...makeRows(1)[0]!, symbol: "INFY", tickertapeSid: "sid" }];
    const db = makeDb(rows);
    const lines: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await processStockDocumentSync(
        { batchSize: 1, docTypes: ["financial_statement"] } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          getOrFetchFinancials: async () =>
            ({
              income: [{ revenue: 1 }],
              balanceSheet: [],
              cashFlow: [],
              source: "TEST",
              fromCache: false,
            }) as never,
        },
      );
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    const outcome = lines.find((l) => l.includes("[job-outcome]"));
    assert.ok(outcome);
    assert.ok(
      !String(outcome).includes("skippedReason"),
      `a healthy run must report no shortfall, got: ${outcome}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* A2 — the BSE-only class is SERVED from screener, not skipped                */
/* -------------------------------------------------------------------------- */

describe("stock-document-sync: a BSE-only symbol runs the SCREENER leg", () => {
  /** A screener page carrying one downloadable annual report. */
  function pageWithAnnualReport() {
    return {
      symbol: "SMALLCO",
      profitAndLoss: null,
      quarterlyResults: null,
      balanceSheet: null,
      cashFlows: null,
      ratios: null,
      compoundedGrowth: "",
      compoundedGrowthData: {
        salesGrowth: {},
        profitGrowth: {},
        stockPriceCagr: {},
        returnOnEquity: {},
      },
      shareholding: [],
      peers: [],
      documents: [
        {
          type: "annual_report",
          title: "SMALLCO Annual Report 2025",
          url: "https://www.bseindia.com/bseplus/AnnualReport/530127/ar2025.pdf",
          period: "FY2025",
        },
      ],
      corporateActions: [],
      fullText: "",
    };
  }

  /** BSE's master, as `fetchBseScripMaster` hands it over. */
  const BSE_MASTER = [
    { scripId: "SMALLCO", scripCode: "530127", isin: "INE111A01017" },
    { scripId: "OTHERCO", scripCode: "506235", isin: "INE428A01015" },
  ];

  /** One BSE-only row, carrying the ISIN the slug is joined through. */
  function bseOnlyRows(): Row[] {
    return [
      {
        ...makeRows(1)[0]!,
        id: "bse-1",
        symbol: "SMALLCO",
        name: "Smallco Filaments Ltd",
        isin: "INE111A01017",
        exchange: "BSE",
      },
    ];
  }

  /** A master fetcher that records every call. */
  function masterFetch(
    calls: number[],
    rows: typeof BSE_MASTER = BSE_MASTER,
  ) {
    return async () => {
      calls.push(1);
      return rows;
    };
  }

  it("REGRESSION: it is served, and the scrape is keyed by the SCRIP CODE", async () => {
    // The defect: `if (instrument.exchange !== "NSE") { …; continue; }` skipped
    // EVERY leg for 2,389 companies, on the stated ground that "no producer in
    // this repo can give a BSE-only company an annual_report". True of both NSE
    // legs and of the `stock_financials` read; false of screener.in — whose
    // company page is keyed by the BSE scrip code we can join to from the ISIN.
    const db = makeDb(bseOnlyRows());
    const calls: number[] = [];
    const scraped: Array<{ symbol: string; slug?: string | null }> = [];
    const page = pageWithAnnualReport();
    const pdf = Buffer.alloc(4096, 1);

    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch(calls) as never,
        scrapeScreenerFullPage: (async (
          symbol: string,
          opts?: { slug?: string | null },
        ) => {
          scraped.push({ symbol, slug: opts?.slug });
          return page as never;
        }) as never,
        httpGet: (() => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => pdf,
          headers: { get: () => "application/pdf" },
        })) as never,
      }),
    );

    assert.deepStrictEqual(
      scraped,
      [{ symbol: "SMALLCO", slug: "530127" }],
      "the URL is built from the SCRIP CODE; the LABEL stays our ticker",
    );
    assert.strictEqual(result.wrote.screener, 1, "the annual report LANDED");
    assert.strictEqual(result.written, 1);
    assert.strictEqual(result.bseOnly.served, 1);
    assert.strictEqual(result.bseOnly.slugResolved, 1);
    assert.strictEqual(result.noNseListing, 1);
    assert.strictEqual(result.bseOnly.masterUnavailable, false);
  });

  it("costs ZERO screener requests to resolve — the whole point of the join", async () => {
    // The search this replaced would have spent ~2,389 requests against a host
    // that has 429'd us before (MONEY-853). The scrip master is a BSE fetch, so
    // `api.screener` counts the PAGE SCRAPE and nothing else.
    const db = makeDb(bseOnlyRows());
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch([]) as never,
      }),
    );
    assert.strictEqual(
      result.api.screener,
      1,
      "one page scrape; the resolution spends none of the screener budget",
    );
  });

  it("the master is fetched AT MOST ONCE per run, however many symbols need it", async () => {
    // It is a ~4.5MB document. Fetching it per symbol would be worse than the
    // search it replaced.
    const rows: Row[] = [
      ...bseOnlyRows(),
      {
        ...makeRows(1)[0]!,
        id: "bse-2",
        symbol: "OTHERCO",
        name: "Otherco Ltd",
        isin: "INE428A01015",
        exchange: "BSE",
      },
    ];
    const db = makeDb(rows);
    const calls: number[] = [];
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 2 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch(calls) as never,
      }),
    );
    assert.strictEqual(result.bseOnly.slugResolved, 2, "both resolved");
    assert.strictEqual(calls.length, 1, "one fetch, shared by the whole page");
  });

  it("the document is written on the BSE side of the unique key", async () => {
    // Every write is keyed `(symbol, exchange, docType, period)`. Filing a
    // BSE-only company under "NSE" would key its documents to an exchange that
    // cannot source them — and would collide with a dual listing's NSE rows.
    const db = makeDb(bseOnlyRows());
    const upserts: Array<Record<string, unknown>> = [];
    db.stockDocument.upsert = (async (args: {
      where: { symbol_exchange_docType_period: Record<string, unknown> };
      create: Record<string, unknown>;
    }) => {
      upserts.push({ ...args.where.symbol_exchange_docType_period, ...args.create });
      return { id: "doc" };
    }) as never;

    await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch([]) as never,
        scrapeScreenerFullPage: async () => pageWithAnnualReport() as never,
        httpGet: (() => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.alloc(4096, 1),
          headers: { get: () => "application/pdf" },
        })) as never,
      }),
    );

    assert.strictEqual(upserts.length, 1);
    assert.strictEqual(upserts[0]!.symbol, "SMALLCO");
    assert.strictEqual(upserts[0]!.exchange, "BSE");
    assert.strictEqual(upserts[0]!.docType, "annual_report");
    assert.strictEqual(
      upserts[0]!.instrumentId,
      "bse-1",
      "the BSE row's instrumentId, not a dangling or NSE one",
    );
  });

  it("the NSE legs stay OFF — they cannot answer, and asking costs budget", async () => {
    // `resolveLegsForTarget`. Both NSE legs read NSE endpoints and the
    // "Tickertape" leg is a read of `stock_financials`, filled by an
    // NSE-FILERS-ONLY ingest. Entering them spends an API-limit slot and a
    // round trip to be told nothing.
    const db = makeDb(bseOnlyRows());
    let nseQuarterly = 0;
    let nseAnnouncements = 0;
    let financials = 0;

    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch([]) as never,
        fetchNSEFinancialResults: async () => {
          nseQuarterly += 1;
          return [];
        },
        fetchCategorizedAnnouncements: async () => {
          nseAnnouncements += 1;
          return [];
        },
        getOrFetchFinancials: async () => {
          financials += 1;
          return null;
        },
      }),
    );

    assert.strictEqual(nseQuarterly, 0);
    assert.strictEqual(nseAnnouncements, 0);
    assert.strictEqual(financials, 0);
    assert.strictEqual(result.api.nse, 0);
    assert.strictEqual(result.api.tickertape, 0);
    assert.ok(result.api.screener > 0, "the one leg that CAN answer did run");
  });

  it("an NSE symbol is UNCHANGED — no slug, no master fetch, all three legs", async () => {
    // The negative control. If A2 had made the slug path unconditional, every
    // NSE company would drag a 4.5MB master fetch to re-derive its own ticker.
    const db = makeDb(makeRows(1));
    const calls: number[] = [];
    const scraped: Array<{ symbol: string; slug?: string | null }> = [];

    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch(calls) as never,
        scrapeScreenerFullPage: (async (
          symbol: string,
          opts?: { slug?: string | null },
        ) => {
          scraped.push({ symbol, slug: opts?.slug });
          return null;
        }) as never,
      }),
    );

    assert.deepStrictEqual(calls, [], "an NSE company needs no slug lookup");
    assert.deepStrictEqual(
      scraped,
      [{ symbol: "SYM0000", slug: undefined }],
      "the scraper is called exactly as it was before A2",
    );
    assert.strictEqual(result.noNseListing, 0);
    assert.strictEqual(result.bseOnly.served, 0);
    assert.ok(result.api.nse > 0, "the NSE legs still run for an NSE company");
  });

  it("REGRESSION: a slug MISS still STAMPS — or it owns the head forever", async () => {
    // The rule the sibling `annual-reports-sync` broke. A company BSE's master
    // has no row for produced nothing, and a row that is visited and not
    // stamped leads a stale-first page on every run, permanently, for a lookup
    // that will keep failing.
    const rows = bseOnlyRows();
    // NEITHER key may hit the master: the ISIN is absent AND the symbol is
    // not a scrip_id in it. Overriding only the ISIN still RESOLVES through
    // the scrip_id fallback — which is how this fixture was wrong at first,
    // and is a live proof that the fallback is reachable.
    rows[0]!.isin = "INE999Z01019";
    rows[0]!.symbol = "GHOSTCO";
    const db = makeDb(rows);
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch([]) as never,
        scrapeScreenerFullPage: async () => {
          throw new Error("the page must not be fetched without a slug");
        },
      }),
    );

    assert.strictEqual(result.written, 0, "precondition: nothing was written");
    assert.strictEqual(result.bseOnly.served, 0);
    assert.strictEqual(result.bseOnly.slugMiss, 1);
    assert.strictEqual(result.stamped, 1);
    assert.ok(
      db.rows[0]!.documentsSyncedAt instanceof Date,
      "a company with no scrip code must still rotate to the back",
    );
  });

  it("a MISS is PERSISTED as a finding: null slug + a FRESH timestamp", async () => {
    // `null` + fresh means "we looked and BSE has no row", a real re-checkable
    // state and NOT the same as never-asked. Writing the slug without the
    // timestamp would make it un-expirable.
    const rows = bseOnlyRows();
    rows[0]!.isin = "INE999Z01019";
    rows[0]!.symbol = "GHOSTCO";
    const db = makeDb(rows);
    await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch([]) as never,
      }),
    );

    assert.strictEqual(db.updates.length, 1);
    assert.strictEqual(db.updates[0]!.data.screenerSlug, null);
    assert.ok(
      db.updates[0]!.data.screenerSlugCheckedAt instanceof Date,
      "the timestamp is what makes the null expire",
    );
    assert.strictEqual(
      "bseScripCode" in db.updates[0]!.data,
      false,
      "a miss knows no scrip code — do not write one, not even null",
    );
  });

  it("a resolution persists the slug, the timestamp AND the scrip code", async () => {
    // `bseScripCode` comes free and AUTHORITATIVE here — BSE issues both the
    // ISIN and the scrip code, so this is the join key A4's XBRL bridge wants.
    const db = makeDb(bseOnlyRows());
    await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch([]) as never,
      }),
    );
    assert.strictEqual(db.updates.length, 1);
    assert.strictEqual(db.updates[0]!.data.screenerSlug, "530127");
    assert.strictEqual(db.updates[0]!.data.bseScripCode, "530127");
    assert.ok(db.updates[0]!.data.screenerSlugCheckedAt instanceof Date);
  });

  it("REGRESSION: an UNAVAILABLE master persists NOTHING and counts no miss", async () => {
    // `fetchBseScripMaster` returns [] on a failed fetch AND under
    // `BSE_MASTER_ENRICH=off`. Reading that as "no match" would stamp a 90-day
    // "no page" finding onto every BSE-only company on the page during a
    // transient BSE outage — caching a failure as a fact.
    const db = makeDb(bseOnlyRows());
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: async () => [],
      }),
    );

    assert.strictEqual(result.bseOnly.masterUnavailable, true);
    assert.strictEqual(result.bseOnly.slugMiss, 0, "we could not LOOK");
    assert.strictEqual(result.bseOnly.slugAmbiguous, 0);
    assert.strictEqual(result.bseOnly.slugResolved, 0);
    assert.deepStrictEqual(
      db.updates,
      [],
      "nothing may be cached — a failure is not a finding",
    );
    // It still ROTATES, so the outage costs a cycle and not a permanent stall.
    assert.strictEqual(result.stamped, 1);
  });

  it("an outage does not read like a miss-storm in the job outcome", async () => {
    // `served 0, resolved 0, miss 0, ambiguous 0` is something an operator
    // would have to INFER. "We could not look" gets said out loud.
    const db = makeDb(bseOnlyRows());
    const lines: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await processStockDocumentSync(
        { batchSize: 1 } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          fetchBseScripMaster: async () => [],
        },
      );
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    const outcome = lines.find((l) => l.includes("[job-outcome]"));
    assert.ok(outcome, "the run must emit a job outcome");
    assert.match(String(outcome), /BSE SCRIP MASTER UNAVAILABLE/);
  });

  it("REGRESSION: a CACHED slug prevents a second master fetch", async () => {
    // The resolution is lazy-once, not per-run: a cached scrip code must not
    // drag a 4.5MB master fetch on every cycle.
    const rows = bseOnlyRows();
    rows[0]!.screenerSlug = "530127";
    const db = makeDb(rows);
    const calls: number[] = [];
    const scraped: Array<{ slug?: string | null }> = [];

    await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: db as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch(calls) as never,
        scrapeScreenerFullPage: (async (
          _symbol: string,
          opts?: { slug?: string | null },
        ) => {
          scraped.push({ slug: opts?.slug });
          return null;
        }) as never,
      }),
    );

    assert.deepStrictEqual(calls, [], "the cached slug must be used as-is");
    assert.deepStrictEqual(scraped, [{ slug: "530127" }]);
    assert.deepStrictEqual(db.updates, [], "nothing to persist — nothing asked");
  });

  it("REGRESSION: a FRESH negative is not re-asked; a STALE one is", async () => {
    // The 90-day TTL, from both sides. Deleting it makes the first half fail
    // (a master fetch every run) and keeping a permanent `null` makes the
    // second fail (a company that listed in December is never re-checked).
    const fresh = bseOnlyRows();
    fresh[0]!.screenerSlug = null;
    fresh[0]!.screenerSlugCheckedAt = new Date(Date.now() - 30 * 86_400_000);
    const freshDb = makeDb(fresh);
    const freshCalls: number[] = [];
    await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: freshDb as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch(freshCalls) as never,
      }),
    );
    assert.deepStrictEqual(freshCalls, [], "asked 30d ago — do not re-ask");

    const stale = bseOnlyRows();
    stale[0]!.screenerSlug = null;
    stale[0]!.screenerSlugCheckedAt = new Date(Date.now() - 120 * 86_400_000);
    const staleDb = makeDb(stale);
    const staleCalls: number[] = [];
    const result = await quiet(() =>
      processStockDocumentSync({ batchSize: 1 } as StockDocumentSyncMessage, {
        prisma: staleDb as never,
        ...darkSources(),
        fetchBseScripMaster: masterFetch(staleCalls) as never,
      }),
    );
    assert.strictEqual(
      staleCalls.length,
      1,
      "120d ago is expired — a cached 'no' that never expires is fail-open",
    );
    assert.strictEqual(result.bseOnly.slugResolved, 1);
  });

  it("the BSE-only counters REACH the job outcome, where an operator sees them", async () => {
    // "2,389 BSE-only, 0 served" and "2,389 BSE-only, 2,389 served" must not
    // read the same. `noNseListing` alone cannot tell them apart.
    const rows = bseOnlyRows();
    rows[0]!.isin = "INE999Z01019";
    rows[0]!.symbol = "GHOSTCO";
    const db = makeDb(rows);
    const lines: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await processStockDocumentSync(
        { batchSize: 1 } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          fetchBseScripMaster: masterFetch([]) as never,
        },
      );
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    const outcome = lines.find((l) => l.includes("[job-outcome]"));
    assert.ok(outcome, "the run must emit a job outcome");
    assert.match(String(outcome), /1 symbol\(s\) with no NSE listing/);
    assert.match(String(outcome), /0 served via screener/);
    assert.match(String(outcome), /1 no-scrip-code/);
  });
});

/* -------------------------------------------------------------------------- */
/* A2.3 — the leg gate did not list the doc type it exists to produce         */
/* -------------------------------------------------------------------------- */

describe("stock-document-sync: `annual_report` reaches the SCREENER leg", () => {
  it("REGRESSION: a targeted annual_report request FETCHES the screener page", async () => {
    // `VALID_SCREENER_DOC_TYPES` has carried `annual_report` since MONEY-853
    // and `parseDocumentLinks` emits it as its FIRST section — the Screener
    // page's annual-report block is the richest source of them we have. But
    // `SCREENER_PAGE_DOC_TYPES`, the LEG GATE, did not list it, so
    // `docTypes:["annual_report"]` never fetched the page at all. It reached
    // the NSE announcements leg only. Nothing errored; the request just
    // returned less than it could.
    const db = makeDb(makeRows(1));
    let fetched = 0;
    const result = await quiet(() =>
      processStockDocumentSync(
        {
          batchSize: 1,
          docTypes: ["annual_report"],
        } as StockDocumentSyncMessage,
        {
          prisma: db as never,
          ...darkSources(),
          scrapeScreenerFullPage: async () => {
            fetched += 1;
            return null;
          },
        },
      ),
    );
    assert.strictEqual(fetched, 1, "the Screener page must be fetched");
    assert.strictEqual(result.api.screener, 1);
  });

  it("the gate and the HEALTH VERDICT are one list, so neither can lie", () => {
    // `resolveEnabledLegs` reads `SCREENER_PAGE_DOC_TYPES` rather than a second
    // copy. If the two were separate lists, adding a doc type to one would make
    // the run-health verdict describe a leg the run cannot enter — an alarm
    // that reports "screener produced nothing" for a leg that never ran.
    assert.ok(
      (SCREENER_PAGE_DOC_TYPES as readonly string[]).includes("annual_report"),
    );
    assert.strictEqual(resolveEnabledLegs(["annual_report"]).screener, true);
    // And it still enables the NSE leg, which also produces annual reports from
    // the announcements feed — this is an addition, not a redirect.
    assert.strictEqual(resolveEnabledLegs(["annual_report"]).nse, true);
  });

  it("resolveLegsForTarget can only ever REMOVE legs", () => {
    // A BSE-only company on a run that gated Screener off by `docTypes` does
    // NOT get the leg back. Otherwise a targeted `financial_statement` schedule
    // would start scraping screener for 2,389 companies it never asked about.
    const off = resolveEnabledLegs(["financial_statement"]);
    assert.deepStrictEqual(resolveLegsForTarget(off, true), {
      tickertape: false,
      nse: false,
      screener: false,
    });
    const all = resolveEnabledLegs(undefined);
    assert.deepStrictEqual(resolveLegsForTarget(all, true), {
      tickertape: false,
      nse: false,
      screener: true,
    });
    assert.deepStrictEqual(
      resolveLegsForTarget(all, false),
      all,
      "an NSE target is returned untouched",
    );
  });

  it("partitionSymbolPage names the BSE-only class, in PAGE ORDER", () => {
    // The third class. `eligible` keeps every target in page order — a class
    // that always sorted last would always be the one a wall-clock truncation
    // dropped, and because an unvisited row keeps its stale marker it would
    // lead the next page and be pushed to the back again. A livelock.
    const { eligible, bseOnly, excluded } = partitionSymbolPage([
      { symbol: "AAA", exchange: "BSE" },
      { symbol: "BBB", exchange: "NSE" },
      { symbol: "TCS", exchange: "BSE" },
      { symbol: "TCS", exchange: "NSE" },
      { symbol: "NIFTY", exchange: "NSE" },
    ]);
    assert.deepStrictEqual(eligible, [
      { symbol: "AAA", exchange: "BSE" },
      { symbol: "BBB", exchange: "NSE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    assert.deepStrictEqual(
      bseOnly,
      [{ symbol: "AAA", exchange: "BSE" }],
      "a DUAL-listed company is not BSE-only, even when its BSE row is in the page",
    );
    assert.deepStrictEqual(excluded, ["NIFTY"]);
  });
});
