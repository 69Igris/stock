/**
 * UNIT TEST — `written` must mean writes (MONEY-1238, finding #9).
 *
 * Three scheduled jobs reported a `written` count that was not "rows
 * persisted", so each of them could go completely dark and still paint the
 * zero-write monitor green. Every case below drives the REAL exported
 * processor — `processNewsSync`, `processStockDocumentSync`,
 * `processFilingsSync` — against injected fakes. There is no re-declared copy
 * of a loop anywhere in this file: the defaults in each processor's `deps`
 * argument ARE the production path, so what runs here is what the scheduler
 * runs.
 *
 * ## What each block pins
 *
 *  - news-sync: `getOrFetchNews` cannot throw (news-client swallows a 403 and
 *    returns `[]`, and db-store's outer catch returns the stored rows), so
 *    `processed++` fired unconditionally and `written: processed` was the batch
 *    size no matter what happened upstream.
 *  - stock-document-sync (a): a FRESHNESS SKIP incremented the created counter
 *    at three sites, so `written` was ~2x the symbol count on an already-
 *    populated table even with every source dark.
 *  - stock-document-sync (b): the API budget lived at MODULE scope on a warm
 *    Cloud Run instance, so it was spent once and never refilled. This is
 *    asserted by INVOKING TWICE in one process, which is the only way to
 *    observe a lifetime bug.
 *  - filings-sync: it persisted nothing and stamped its rotation cursor anyway.
 *
 * Nothing here opens a socket, a Pub/Sub client or a database handle, and every
 * sleep is injected, so there is nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  processNewsSync,
  describeNewsShortfall,
  type NewsSyncResult,
} from "../../src/processors/news-sync";
import { processStockDocumentSync } from "../../src/processors/stock-document-sync";
import {
  processFilingsSync,
  FILINGS_SYNC_NOT_WIRED_REASON,
} from "../../src/processors/filings-sync";
import {
  API_LIMITS,
  MAX_SYMBOLS_PER_RUN,
  DELAY_BETWEEN_SYMBOLS_MS,
} from "../../src/processors/stock-document-sync-logic";

/* -------------------------------------------------------------------------- */
/* Shared fakes                                                                */
/* -------------------------------------------------------------------------- */

const noSleep = async (): Promise<void> => {};

/** One `reportJobOutcome` emission, as the monitor would see it. */
interface Emitted {
  job: string;
  selected: number;
  written: number;
  failed: number;
  skippedReason?: string;
  /** True when it took the `selected > 0 && written === 0` WARNING branch. */
  warned: boolean;
}

/**
 * Run `fn` with `console.log`/`console.warn` captured and return the
 * `reportJobOutcome` emissions.
 *
 * Asserting the RETURN VALUE of a processor is not enough: the zero-write
 * monitor keys on `stockbook.job.written`, which comes from the
 * `reportJobOutcome` call, not from what the function hands its caller. Those
 * are two separate expressions and they have already disagreed once — the
 * original defect was a `written:` argument that did not match reality while
 * every log line looked fine.
 *
 * This drives the REAL `@usemoney/datadog/job-outcome` (its structured line is
 * the documented fallback signal), so nothing about the emission is simulated.
 * Restored in `finally` so a failing assertion cannot leave the process mute.
 */
async function captureOutcomes<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; emitted: Emitted[] }> {
  const emitted: Emitted[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const realError = console.error;
  const take =
    (warned: boolean) =>
    (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (!text.startsWith("[job-outcome]")) return;
      const json = text.slice(text.indexOf("{"));
      emitted.push({
        ...(JSON.parse(json) as Omit<Emitted, "warned">),
        warned,
      });
    };
  console.log = take(false) as typeof console.log;
  console.warn = take(true) as typeof console.warn;
  console.error = (() => {}) as typeof console.error;
  try {
    const value = await fn();
    return { value, emitted };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
  }
}

/** A Prisma stand-in for news-sync: only the stamp + discovery are reached. */
function newsDb(stamped: string[]) {
  return {
    instrumentMapping: {
      findMany: async () => [] as Array<{ symbol: string }>,
      updateMany: async (args: { where: { symbol: string } }) => {
        stamped.push(args.where.symbol);
        return { count: 1 };
      },
    },
    holding: { groupBy: async () => [] },
    watchlistItem: { groupBy: async () => [] },
  };
}

/** A refresh result with no rows written, for the shapes that produce one. */
const NOTHING_WRITTEN = {
  created: 0,
  updated: 0,
  failed: 0,
  fetched: 0,
  servedFresh: false,
  fetchFailed: false,
  articles: [],
};

/* -------------------------------------------------------------------------- */
/* 9.1 news-sync                                                               */
/* -------------------------------------------------------------------------- */

describe("news-sync: `written` counts rows, not symbols", () => {
  const SYMBOLS = ["AAA", "BBB", "CCC", "DDD", "EEE"];

  it("REGRESSION: a dark upstream reports written=0, not the batch size", async () => {
    // Google News 403s our egress. `fetchNews` catches it and returns `[]`, so
    // `refreshNews` completes normally with `fetched: 0`. Before the fix this
    // exact run reported `written: 5`.
    const stamped: string[] = [];
    const result = await processNewsSync(
      { symbols: [...SYMBOLS], delayMs: 1 },
      {
        prisma: newsDb(stamped) as never,
        refreshNews: async () => ({ ...NOTHING_WRITTEN }),
        sleep: noSleep,
      },
    );

    assert.equal(result.selected, 5);
    assert.equal(result.written, 0, "a dark upstream must write nothing");
    assert.equal(result.emptyUpstream, 5);
    assert.equal(result.failed, 0, "nothing threw — that is the whole problem");
  });

  it("REGRESSION: an internal fetch error also reports written=0", async () => {
    // db-store's outer catch returns the STORED rows, so the caller receives a
    // perfectly ordinary array. Only `fetchFailed` distinguishes it.
    const result = await processNewsSync(
      { symbols: [...SYMBOLS], delayMs: 1 },
      {
        prisma: newsDb([]) as never,
        refreshNews: async () => ({ ...NOTHING_WRITTEN, fetchFailed: true }),
        sleep: noSleep,
      },
    );
    assert.equal(result.written, 0);
    assert.equal(result.fetchFailed, 5);
  });

  it("a real refresh is counted as rows: created + updated", async () => {
    const result = await processNewsSync(
      { symbols: ["AAA", "BBB"], delayMs: 1 },
      {
        prisma: newsDb([]) as never,
        refreshNews: async (symbol) =>
          symbol === "AAA"
            ? { ...NOTHING_WRITTEN, created: 7, updated: 3, fetched: 10 }
            : { ...NOTHING_WRITTEN, created: 0, updated: 4, fetched: 10 },
        sleep: noSleep,
      },
    );
    assert.equal(result.created, 7);
    assert.equal(result.updated, 7);
    assert.equal(result.written, 14);
  });

  it("a freshness-window run is a DIFFERENT zero from a blocked feed", async () => {
    // A Pub/Sub redelivery inside 30 minutes legitimately writes nothing. If the
    // reason string cannot tell that from a 403, the monitor gets muted.
    const fresh = await processNewsSync(
      { symbols: [...SYMBOLS], delayMs: 1 },
      {
        prisma: newsDb([]) as never,
        refreshNews: async () => ({ ...NOTHING_WRITTEN, servedFresh: true }),
        sleep: noSleep,
      },
    );
    assert.equal(fresh.written, 0);
    assert.equal(fresh.servedFresh, 5);
    assert.match(
      String(describeNewsShortfall(fresh)),
      /freshness window/,
      "an all-fresh run must say so",
    );

    const dark: NewsSyncResult = {
      ...fresh,
      servedFresh: 0,
      emptyUpstream: 5,
    };
    assert.match(String(describeNewsShortfall(dark)), /upstream-empty/);
    assert.doesNotMatch(
      String(describeNewsShortfall(dark)),
      /freshness window/,
    );
  });

  it("describeNewsShortfall stays silent when rows landed", () => {
    const ok: NewsSyncResult = {
      selected: 5,
      written: 12,
      created: 12,
      updated: 0,
      upsertFailed: 0,
      failed: 0,
      servedFresh: 0,
      fetchFailed: 0,
      emptyUpstream: 0,
    };
    assert.equal(describeNewsShortfall(ok), undefined);
  });

  it("REGRESSION: the MONITOR sees written=0 on a dark upstream", async () => {
    // The return value and the `reportJobOutcome` argument are two different
    // expressions. The monitor reads the second one, so it gets its own
    // assertion — a `written: symbols.length` there would be the original bug
    // reintroduced with a green return value.
    const { emitted } = await captureOutcomes(() =>
      processNewsSync(
        { symbols: [...SYMBOLS], delayMs: 1 },
        {
          prisma: newsDb([]) as never,
          refreshNews: async () => ({ ...NOTHING_WRITTEN }),
          sleep: noSleep,
        },
      ),
    );

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.job, "news-sync");
    assert.equal(emitted[0]!.selected, 5);
    assert.equal(emitted[0]!.written, 0);
    assert.equal(
      emitted[0]!.warned,
      true,
      "0-write must reach the WARN branch",
    );
    assert.match(String(emitted[0]!.skippedReason), /5 upstream-empty/);
  });

  it("the MONITOR sees the row count on a healthy run, and does not warn", async () => {
    const { emitted } = await captureOutcomes(() =>
      processNewsSync(
        { symbols: ["AAA", "BBB"], delayMs: 1 },
        {
          prisma: newsDb([]) as never,
          refreshNews: async () => ({
            ...NOTHING_WRITTEN,
            created: 3,
            updated: 1,
            fetched: 4,
          }),
          sleep: noSleep,
        },
      ),
    );
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.written, 8, "2 symbols x (3 created + 1 updated)");
    assert.equal(emitted[0]!.warned, false);
    assert.equal(emitted[0]!.skippedReason, undefined);
  });

  it("a symbol whose pass THROWS is counted as failed, never as written", async () => {
    // The only path that can still throw is one of ours (the stamp, or a bug in
    // the loop). It must not become a write.
    const stamped: string[] = [];
    const result = await processNewsSync(
      { symbols: ["AAA", "BBB"], delayMs: 1 },
      {
        prisma: newsDb(stamped) as never,
        refreshNews: async (symbol) => {
          if (symbol === "BBB") throw new Error("boom");
          return { ...NOTHING_WRITTEN, created: 2, fetched: 2 };
        },
        sleep: noSleep,
      },
    );
    assert.equal(result.failed, 1);
    assert.equal(result.written, 2, "only AAA's rows count");
    assert.deepEqual(stamped, ["AAA", "BBB"], "a failure is still stamped");
  });

  it("an empty population is its own reason, not an upstream verdict", () => {
    const none: NewsSyncResult = {
      selected: 0,
      written: 0,
      created: 0,
      updated: 0,
      upsertFailed: 0,
      failed: 0,
      servedFresh: 0,
      fetchFailed: 0,
      emptyUpstream: 0,
    };
    assert.equal(
      describeNewsShortfall(none),
      "population gate selected no symbols",
    );
  });

  it("still stamps every symbol, success or not — the rotation must advance", async () => {
    // news-sync DOES work (it calls a persisting data source), so unlike
    // filings-sync its cursor is allowed to move.
    const stamped: string[] = [];
    await processNewsSync(
      { symbols: [...SYMBOLS], delayMs: 1 },
      {
        prisma: newsDb(stamped) as never,
        refreshNews: async () => ({ ...NOTHING_WRITTEN }),
        sleep: noSleep,
      },
    );
    assert.deepEqual(stamped, SYMBOLS);
  });
});

/* -------------------------------------------------------------------------- */
/* 9.2 stock-document-sync                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every document lookup answers "we already hold a fresh copy".
 *
 * MONEY-1255 — `findFirst` returns `exchange` and the mapping supports
 * `updateMany`, because the processor now SELECTS the exchange (it used to
 * hardcode `"NSE"` and silently drop every BSE-only symbol) and STAMPS
 * `documentsSyncedAt` on every visit. A fixture that omits either makes the
 * production path unreachable in the test.
 */
function allFreshDb() {
  return {
    instrumentMapping: {
      findFirst: async () => ({
        id: "inst1",
        exchange: "NSE",
        tickertapeSid: null,
      }),
      findMany: async () => [] as Array<{ symbol: string }>,
      updateMany: async () => ({ count: 1 }),
    },
    stockDocument: {
      findUnique: async () => ({ id: "doc1", fetchedAt: new Date() }),
      upsert: async () => {
        throw new Error("must not write on an all-fresh population");
      },
    },
  };
}

/** No stored documents at all; upserts are recorded. */
function emptyDb(writes: string[]) {
  return {
    instrumentMapping: {
      findFirst: async () => ({
        id: "inst1",
        exchange: "NSE",
        tickertapeSid: null,
      }),
      findMany: async () => [] as Array<{ symbol: string }>,
      updateMany: async () => ({ count: 1 }),
    },
    stockDocument: {
      findUnique: async () => null,
      upsert: async (args: { where: Record<string, unknown> }) => {
        writes.push(JSON.stringify(args.where));
        return { id: "doc1" };
      },
    },
  };
}

/**
 * Every upstream dark, and the extract-job chain RECORDED rather than thrown.
 *
 * It used to throw ("extract must not be chained when nothing was written"),
 * which was vacuous: the production call sits inside a `try/catch` that only
 * `logger.warn`s, so the throw was swallowed and the assertion could never
 * fail. `chained` is asserted explicitly instead.
 */
function noSources(chained: string[] = []) {
  return {
    getOrFetchFinancials: async () => null,
    fetchNSEFinancialResults: async () => [],
    fetchCategorizedAnnouncements: async () => [],
    scrapeScreenerFullPage: async () => null,
    uploadToGCS: async () => {},
    publishExtractJob: async () => void chained.push("published"),
    // MONEY-1255 — the drain chain is injected too. Without it the default
    // would open a real Pub/Sub client the moment a run looked continuable.
    publishNextBatch: async () => void chained.push("chained"),
    sleep: noSleep,
  };
}

describe("stock-document-sync: a freshness skip is not a write", () => {
  it("REGRESSION: an all-fresh population reports written=0", async () => {
    // Two periods x N symbols used to increment `docsCreated` on the freshness
    // branch, so a 250-symbol run over a populated table reported ~500 written
    // with every source dark. The alarm could only fire on a virgin database.
    const symbols = Array.from({ length: 6 }, (_, i) => `SYM${i}`);
    const chained: string[] = [];
    const { value: result, emitted } = await captureOutcomes(() =>
      processStockDocumentSync(
        { symbols, docTypes: ["financial_statement"] },
        { prisma: allFreshDb() as never, ...noSources(chained) },
      ),
    );

    assert.equal(result.selected, 6);
    assert.equal(result.written, 0, "nothing was written — say 0");
    assert.equal(
      result.skippedFresh,
      12,
      "6 symbols x 2 periods were skipped, and the skips are counted",
    );
    assert.equal(result.failed, 0);
    assert.deepEqual(
      chained,
      [],
      "nothing was written, so the extract chain must not fire",
    );

    // What the MONITOR sees. `written` in the outcome is a different expression
    // from `written` in the return value; both have to be 0.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.job, "stock-document-sync");
    assert.equal(emitted[0]!.selected, 6);
    assert.equal(emitted[0]!.written, 0);
    assert.equal(
      emitted[0]!.warned,
      true,
      "selected>0 && written===0 must take the WARNING branch",
    );
    assert.match(String(emitted[0]!.skippedReason), /12 already fresh/);
  });

  it("a real upsert IS counted, so written=0 is not simply hard-wired", async () => {
    const writes: string[] = [];
    const chained: string[] = [];
    const { value: result, emitted } = await captureOutcomes(() =>
      processStockDocumentSync(
        { symbols: ["AAA"], docTypes: ["financial_statement"] },
        {
          prisma: emptyDb(writes) as never,
          ...noSources(chained),
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
    assert.equal(result.written, 2, "one symbol x two period types");
    assert.equal(result.skippedFresh, 0);
    assert.equal(writes.length, 2);
    assert.deepEqual(chained, ["published"]);

    // The positive control for the monitor: a run that DID write must not warn.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.written, 2);
    assert.equal(emitted[0]!.warned, false);
  });

  it("an empty population still REPORTS — the early return used to be silent", async () => {
    // `if (allSymbols.length === 0) return;` skipped `reportJobOutcome`
    // entirely, so the one job state MONEY-1220 exists to catch — a population
    // gate that matches nothing — emitted no metric at all.
    const emptyPopulation = {
      instrumentMapping: {
        findFirst: async () => null,
        findMany: async () => [] as Array<{ symbol: string }>,
        updateMany: async () => ({ count: 0 }),
      },
      stockDocument: {
        findUnique: async () => null,
        upsert: async () => {
          throw new Error("nothing to write");
        },
      },
    };
    const { value: result, emitted } = await captureOutcomes(() =>
      processStockDocumentSync(
        {},
        { prisma: emptyPopulation as never, ...noSources() },
      ),
    );

    assert.equal(result.selected, 0);
    assert.equal(result.written, 0);
    assert.equal(emitted.length, 1, "an empty population must still report");
    assert.equal(emitted[0]!.selected, 0);
    assert.equal(
      emitted[0]!.warned,
      false,
      "selected===0 is not the zero-write alarm — there was nothing to do",
    );
    assert.match(String(emitted[0]!.skippedReason), /selected no symbols/);
  });

  it("REGRESSION: an already-stored NSE filing is a skip, not a create", async () => {
    // `storeNSEFiling` returned 1 on `if (exists)`. That is the same defect as
    // the tickertape site, reached through a different leg.
    const result = await processStockDocumentSync(
      { symbols: ["AAA"], docTypes: ["quarterly_result"] },
      {
        prisma: allFreshDb() as never,
        ...noSources(),
        fetchNSEFinancialResults: async () => [
          {
            symbol: "AAA",
            title: "Q1-2026 Financial Results",
            description: "results",
            attachmentUrl: "/content/x.pdf",
            filingDate: new Date("2026-07-15T00:00:00.000Z"),
            category: "Financial Results",
          },
        ],
      },
    );
    assert.equal(result.written, 0);
    assert.equal(result.skippedFresh, 1);
  });

  it("REGRESSION: an already-stored Screener doc is a skip, not a create", async () => {
    // `storeScreenerDoc` returned 1 on `if (exists)` — the third site. The
    // shareholding JSON snapshot is the fourth: it already returned 0, but the
    // skip was invisible.
    const result = await processStockDocumentSync(
      {
        symbols: ["AAA"],
        docTypes: ["annual_report", "screener_shareholding"],
      },
      {
        prisma: allFreshDb() as never,
        ...noSources(),
        scrapeScreenerFullPage: async () =>
          ({
            symbol: "AAA",
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
            shareholding: [
              {
                quarter: "Mar 2026",
                promoter: 50,
                fii: 10,
                dii: 10,
                public: 30,
                government: 0,
              },
            ],
            peers: [],
            documents: [
              {
                type: "annual_report",
                title: "AR 2026",
                url: "https://example.test/ar.pdf",
                period: "FY2026",
              },
            ],
            corporateActions: [],
            fullText: "",
          }) as never,
      },
    );
    assert.equal(result.written, 0);
    assert.equal(
      result.skippedFresh,
      2,
      "the annual-report PDF and the shareholding snapshot are both skips",
    );
  });

  it("the screener WRITE counter covers the BSE path — MONEY-1255 (A2)", async () => {
    // The BSE-only path is a NEW producer reaching `run.wrote.screener` through
    // a branch none of the cases above enter (they all resolve to an NSE
    // instrument). A counter that is only ever exercised on one path is a
    // counter no mutation of the other path is caught in — which is exactly how
    // `run.wrote.nse++` survived deletion until `httpGet` became a seam.
    const writes: string[] = [];
    const db = emptyDb(writes);
    // The one difference from `emptyDb`: this company is listed only on BSE.
    db.instrumentMapping.findFirst = (async () => ({
      id: "bse1",
      exchange: "BSE",
      tickertapeSid: null,
      name: "Smallco Filaments Ltd",
      isin: "INE111A01017",
      // Already resolved, so this case exercises the WRITE path and not the
      // scrip-master join (which has its own file).
      screenerSlug: "530127",
    })) as never;

    const { value: result } = await captureOutcomes(() =>
      processStockDocumentSync(
        { symbols: ["SMALLCO"], docTypes: ["screener_financials"] },
        {
          prisma: db as never,
          ...noSources(),
          scrapeScreenerFullPage: async () =>
            ({
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
              documents: [],
              corporateActions: [],
              fullText: "x".repeat(500),
            }) as never,
        },
      ),
    );

    assert.equal(result.written, 1);
    assert.equal(result.wrote.screener, 1, "attributed to the source that produced it");
    assert.equal(result.wrote.nse, 0);
    assert.equal(result.wrote.tickertape, 0);
    assert.equal(result.noNseListing, 1);
    assert.equal(result.bseOnly.served, 1);
    // FALSIFIABLE CEILING: `written: 1` proves a row landed, not WHERE. The
    // upsert key is what makes it reachable — a BSE company filed under "NSE"
    // would be a row nothing can read and a collision with any NSE namesake.
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /"exchange":"BSE"/);
    assert.match(writes[0]!, /"symbol":"SMALLCO"/);
  });
});

describe("stock-document-sync: the API budget is PER RUN", () => {
  /**
   * The direct regression test for the module-scope lifetime bug: invoke the
   * same imported function twice in one process, exactly as a warm Cloud Run
   * instance does when Pub/Sub redelivers.
   */
  it("REGRESSION: a second invocation starts with a fresh tally", async () => {
    const symbols = ["AAA", "BBB", "CCC"];
    const opts = { symbols, docTypes: ["screener_financials"] };
    const deps = { prisma: allFreshDb() as never, ...noSources() };

    const first = await processStockDocumentSync(opts, deps);
    const second = await processStockDocumentSync(opts, deps);

    assert.equal(first.api.screener, 3);
    assert.equal(
      second.api.screener,
      first.api.screener,
      "the second run inherited the first run's spend — the tally is shared",
    );
  });

  it("REGRESSION: the screener leg still runs after the budget would have been spent", async () => {
    // The production shape, at production scale: `API_LIMITS.screener` is 500
    // and a run works at most MAX_SYMBOLS_PER_RUN (250) symbols, one screener
    // call each. With a module-scope tally the budget is gone after two
    // invocations and the leg is never entered again for the life of the
    // instance — silently, which is MONEY-853's shape.
    assert.equal(MAX_SYMBOLS_PER_RUN, 250);
    assert.equal(API_LIMITS.screener, 500);
    assert.ok(
      MAX_SYMBOLS_PER_RUN * 2 >= API_LIMITS.screener,
      "arithmetic changed: two runs no longer exhaust the screener budget",
    );

    const symbols = Array.from(
      { length: MAX_SYMBOLS_PER_RUN },
      (_, i) => `S${i}`,
    );
    const opts = { symbols, docTypes: ["screener_financials"] };
    const deps = { prisma: allFreshDb() as never, ...noSources() };

    await processStockDocumentSync(opts, deps);
    await processStockDocumentSync(opts, deps);
    const third = await processStockDocumentSync(opts, deps);

    assert.equal(
      third.api.screener,
      MAX_SYMBOLS_PER_RUN,
      "the third invocation must still be allowed to call screener",
    );
  });

  it("the ack-deadline arithmetic that makes a warm redelivery NORMAL", () => {
    // Not decoration: this is why the leak is live rather than theoretical. The
    // per-symbol politeness delay alone exceeds most of Pub/Sub's MAXIMUM ack
    // deadline (600s), so a run routinely outlives its own lease and the
    // redelivery lands on the same warm container.
    const sleepingMs = MAX_SYMBOLS_PER_RUN * DELAY_BETWEEN_SYMBOLS_MS;
    assert.equal(sleepingMs, 500_000);
    assert.ok(
      sleepingMs > 600_000 * 0.8,
      "a full run sleeps for more than 80% of the ack deadline before any I/O",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 9.3 filings-sync                                                            */
/* -------------------------------------------------------------------------- */

describe("filings-sync: cannot report success while persisting nothing", () => {
  function filingsDb(stamped: string[], selected: string[]) {
    return {
      instrumentMapping: {
        findMany: async () => selected.map((symbol) => ({ symbol })),
        updateMany: async (args: { where: { symbol: string } }) => {
          stamped.push(args.where.symbol);
          return { count: 1 };
        },
      },
      holding: { groupBy: async () => [] },
      watchlistItem: { groupBy: async () => [] },
    };
  }

  it("REGRESSION: the rotation cursor is NOT stamped", async () => {
    // The whole defect: `filingsSyncedAt` advanced over work the job does not
    // do, so the population rotated past symbols nothing was ever collected
    // for. `filingsSyncedAt` has exactly one reader — this job's own orderBy —
    // so not stamping is safe as well as honest.
    const stamped: string[] = [];
    const result = await processFilingsSync(
      {},
      { prisma: filingsDb(stamped, ["AAA", "BBB", "CCC"]) as never },
    );

    assert.deepEqual(stamped, [], "a job that writes nothing may not advance");
    assert.equal(result.selected, 3);
    assert.equal(result.written, 0);
  });

  it("REGRESSION: it never claims to be wired", async () => {
    const result = await processFilingsSync(
      {},
      { prisma: filingsDb([], ["AAA"]) as never },
    );
    assert.equal(result.wired, false);
    assert.equal(result.skippedReason, FILINGS_SYNC_NOT_WIRED_REASON);
    assert.match(result.skippedReason, /NO persistence layer/);
  });

  it("a caller-supplied symbol list is still not persisted or stamped", async () => {
    const stamped: string[] = [];
    const result = await processFilingsSync(
      { symbols: ["AAA", "BBB"] },
      { prisma: filingsDb(stamped, []) as never },
    );
    assert.equal(result.selected, 2);
    assert.equal(result.written, 0);
    assert.deepEqual(stamped, []);
  });

  it("REGRESSION: it reports a zero-write outcome, which it never did before", async () => {
    // The original job called `reportJobOutcome` NEVER. It could not emit the
    // one signal that describes it — "selected work, wrote nothing" — so the
    // weekly no-op was invisible to the monitor by construction.
    const { emitted } = await captureOutcomes(() =>
      processFilingsSync(
        {},
        { prisma: filingsDb([], ["AAA", "BBB", "CCC"]) as never },
      ),
    );

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.job, "filings-sync");
    assert.equal(emitted[0]!.selected, 3);
    assert.equal(emitted[0]!.written, 0);
    assert.equal(emitted[0]!.warned, true);
    assert.equal(emitted[0]!.skippedReason, FILINGS_SYNC_NOT_WIRED_REASON);
  });
});

/* -------------------------------------------------------------------------- */
/* 9.4 the filings-sync ROUTE                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Strip comments so a prose mention cannot satisfy (or defeat) a source
 * assertion. LINE comments FIRST — MONEY-1143: a `/*` inside a `//` comment
 * would otherwise open a block that swallows the code after it.
 */
function stripComments(src: string): string {
  const noLine = src
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
  return noLine.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("filings-sync route: the HTTP body must not claim success", () => {
  // Exercised against the source rather than over HTTP: the route calls the
  // processor with NO deps, so a real request would open a Prisma connection.
  // The same posture as `mf-portfolio-route-only.test.ts`.
  const ROUTE = stripComments(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/routes/filings-sync.ts",
      ),
      "utf8",
    ),
  );

  it("resolves the source it reasons over", () => {
    assert.ok(
      ROUTE.includes("processFilingsSync"),
      "route source did not load",
    );
  });

  it("REGRESSION: does not return a hard-coded success:true", () => {
    assert.doesNotMatch(
      ROUTE,
      /c\.json\(\s*\{\s*success:\s*true\s*\}/,
      "the job persists nothing; the body may not say otherwise",
    );
    assert.match(ROUTE, /success:\s*false/);
  });

  it("still ACKs with 200, and forwards the processor's verdict", () => {
    // A 5xx would burn the subscription's five delivery attempts and
    // dead-letter a founder notification every Sunday for a known defect —
    // which is how a DLQ gets muted. The alarm lives in the job outcome.
    assert.match(ROUTE, /\.\.\.result/, "the verdict must reach the body");
    assert.match(ROUTE, /success:\s*false,\s*\.\.\.result\s*\},\s*200/);
  });
});
