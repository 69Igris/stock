/**
 * MONEY-1291 — leg (b) bought bars it had already decided to throw away.
 *
 * Measured on prod 2026-08-30: `us_fund_nav` covered 2,436 of 49,846 funds, and
 * `backfill_checkpoints{jobKey:"tiingo-us-eod"}` held 46,969 `NO_PERMATICKER`
 * against 25,544 `DONE` — 46,908 of the former NMFQS funds. The cause of the
 * COVERAGE number is sequencing and self-heals: `UsFundNav` is unique on
 * `(permaTicker, date)`, `permaTicker` arrives from a separate paced enricher
 * that only started on 2026-08-29, and `NO_PERMATICKER` is deliberately
 * non-terminal.
 *
 * What did NOT self-heal is what these cases pin. `writeFundNavs` held the only
 * permaTicker check, and the caller had already issued the Tiingo request by
 * the time it ran — so an unkeyable fund cost one billed call on a PAID METERED
 * api and produced nothing. ~44,000 wasted requests per full rotation, every
 * night, for as long as the enricher lagged.
 *
 * The assertion that matters is a NEGATIVE — that a call was NOT made — which
 * is why `runPriceLeg` gained the `deps` seam it is driven through here. There
 * is no re-declared copy of the loop and no hand-rolled `RunState`: the
 * defaults in `resolvePriceLegDeps` ARE the production path and
 * `newUsEodRunState()` is the same factory `processUsEodSync` calls, so what
 * runs here is what the scheduler runs. Nothing opens a socket or a database
 * handle, and there is nothing to orphan.
 *
 * THE MUTATION THESE ARE SIZED FOR: move the guard back below the fetch (i.e.
 * restore the pre-MONEY-1291 arrangement, where only `writeFundNavs` checks).
 * `fetchCalls` becomes 1 and the first case goes red. The stamp and counter
 * assertions do NOT move under that mutation — they held before the fix too —
 * which is exactly why they are asserted alongside it rather than instead of
 * it: the fix must remove the request WITHOUT removing the rotation advance
 * that keeps an unkeyable fund from re-occupying the head of the queue forever
 * (MONEY-1211).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  newUsEodRunState,
  runPriceLeg,
  type RunState,
  type UsEodPriceLegDeps,
} from "../../src/processors/us-eod-sync";
import { STAMP_CHUNK_SIZE } from "../../src/processors/us-eod-sync-logic";
import type { TiingoEodBar } from "@usemoney/core/market-data/tiingo/tiingo-logic";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface FundRow {
  id: string;
  symbol: string;
  exchange: string;
  listingId: string | null;
  listingStartDate: Date | null;
  listingStatus: string;
  /**
   * ABSENT, not null, on a row the enricher has never reached — `prisma db
   * push` creates indexes and never fields, which is why nothing in the job may
   * FILTER on it (MONEY-1050 / 1205 / 1234 / 1236). Modelled as optional so a
   * guard written for `=== null` alone fails here the way it would in
   * production.
   */
  permaTicker?: string | null;
  usEodSyncedAt?: Date | null;
}

/** One NAV point. A fund's OHLC fields all carry the same number by design. */
function navBar(date: string, nav: number): TiingoEodBar {
  return {
    date,
    open: nav,
    high: nav,
    low: nav,
    close: nav,
    volume: 0,
    divCash: 0,
    splitFactor: 1,
  };
}

/**
 * A Prisma stand-in for `us_instruments` + `us_fund_nav`.
 *
 * `updateMany` implements the ROTATION STAMP and records the ids it advanced,
 * because "the row is still stamped" is half of what the fix has to preserve
 * and a fake that swallowed the call could not tell a stamped row from a
 * skipped one.
 */
function makeDb(rows: FundRow[]) {
  const stamped: string[] = [];
  const navUpserts: Array<Record<string, unknown>> = [];
  return {
    stamped,
    navUpserts,
    usInstrument: {
      findMany: async (args: { take?: number }) =>
        rows.slice(0, args.take ?? rows.length).map((r) => ({ ...r })),
      updateMany: async (args: { where: { id: { in: string[] } } }) => {
        stamped.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      },
    },
    usFundNav: {
      upsert: async (args: Record<string, unknown>) => {
        navUpserts.push(args);
        return {};
      },
    },
  };
}

/**
 * Drive the REAL leg (b) over `rows`, counting every Tiingo call it issues.
 *
 * `putCandles` is wired to a thrower rather than a no-op: leg (b) must never
 * reach the candle repository, and a silent stub would let a routing regression
 * pass as success.
 */
async function runNavLeg(
  rows: FundRow[],
  bars: (symbol: string) => TiingoEodBar[] = () => [navBar("2026-08-29", 42.5)],
): Promise<{
  state: RunState;
  db: ReturnType<typeof makeDb>;
  fetchedSymbols: string[];
}> {
  const db = makeDb(rows);
  const fetchedSymbols: string[] = [];
  const deps: UsEodPriceLegDeps = {
    prisma: db as never,
    fetchEod: async ({ symbol }: { symbol: string }) => {
      fetchedSymbols.push(symbol);
      return { bars: bars(symbol), bytes: 128 };
    },
    putCandles: async () => {
      throw new Error("leg (b) must never write candles");
    },
  };

  const state = newUsEodRunState();
  await runPriceLeg({
    leg: "MF",
    state,
    take: rows.length,
    startedAt: Date.now(),
    legBudgetMs: 300_000,
    requestBudget: 1_000,
    windowStart: "2026-08-24",
    sessionDate: "2026-08-29",
    deps,
  });
  return { state, db, fetchedSymbols };
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

describe("MONEY-1291 — an unkeyable fund costs ZERO Tiingo requests", () => {
  it("issues no request, still stamps, and counts the skip", async () => {
    const { state, db, fetchedSymbols } = await runNavLeg([
      {
        id: "row-1",
        symbol: "VFIAX",
        exchange: "NMFQS",
        listingId: "VFIAX:NMFQS:1962-01-02",
        listingStartDate: new Date("1962-01-02"),
        listingStatus: "ACTIVE",
        // The key is ABSENT — the enricher has not reached this row.
      },
    ]);

    // THE FIX. Moving the guard back below `fetchEod` makes this 1.
    assert.deepEqual(
      fetchedSymbols,
      [],
      "an unkeyable fund must not be fetched at all",
    );

    // The rotation still advances, or the row leads the next page forever.
    //
    // `pendingStamps` is where the advance is RECORDED. The database write is
    // chunked at `STAMP_CHUNK_SIZE` and otherwise deferred to
    // `processUsEodSync`'s `finally`, so a one-row page legitimately leaves the
    // buffer unflushed — the case below drives a page past the chunk size and
    // asserts the write actually lands.
    assert.deepEqual(state.pendingStamps, ["row-1"]);
    assert.equal(db.stamped.length, 0);

    assert.equal(state.mfSkippedNoPermaTicker, 1);

    // Nothing was requested, so nothing may be claimed as requested or received.
    assert.equal(state.mfAttempted, 0);
    assert.equal(state.mfBars, 0);
    assert.equal(state.mfOwed, 0);
    assert.equal(state.mfWritten, 0);
    assert.deepEqual(db.navUpserts, []);

    // The page was SELECTED — 0 here would be the "empty population" lie.
    assert.equal(state.mfSelected, 1);

    // Skipping is not a failure and must never be counted as one: `failed` and
    // `transportFailures` send an operator to Tiingo, and the remedy is our own
    // enrichment job.
    assert.equal(state.failed, 0);
    assert.equal(state.transportFailures, 0);
    assert.equal(state.notFound, 0);

    // The quota meter is charged per request ISSUED. Zero requests, zero spend
    // — this is the number the ticket is denominated in.
    assert.equal(state.requestsIssued, 0);
  });

  it("a whitespace-only permaTicker is unkeyable too, and is not fetched", async () => {
    // `.trim()` lives in `fundNavKey` precisely so the pre-fetch guard and the
    // belt-and-braces guard in `writeFundNavs` cannot disagree about this row.
    const { state, fetchedSymbols } = await runNavLeg([
      {
        id: "row-ws",
        symbol: "SWPPX",
        exchange: "NMFQS",
        listingId: null,
        listingStartDate: null,
        listingStatus: "ACTIVE",
        permaTicker: "   ",
      },
    ]);

    assert.deepEqual(fetchedSymbols, []);
    assert.equal(state.mfSkippedNoPermaTicker, 1);
    assert.equal(state.requestsIssued, 0);
  });

  it("a KEYABLE fund is still fetched and written — the fix is not a kill switch", async () => {
    const { state, db, fetchedSymbols } = await runNavLeg([
      {
        id: "row-2",
        symbol: "FXAIX",
        exchange: "NMFQS",
        listingId: "FXAIX:NMFQS:1988-02-17",
        listingStartDate: new Date("1988-02-17"),
        listingStatus: "ACTIVE",
        permaTicker: "US000000000042",
      },
    ]);

    assert.deepEqual(fetchedSymbols, ["FXAIX"]);
    assert.equal(state.mfSkippedNoPermaTicker, 0);
    assert.equal(state.mfAttempted, 1);
    assert.equal(state.mfBars, 1);
    assert.equal(state.mfWritten, 1);
    assert.equal(db.navUpserts.length, 1);
    assert.deepEqual(state.pendingStamps, ["row-2"]);
    assert.ok(state.requestsIssued >= 1);
  });

  it("a mixed page spends its budget only on the funds it can write", async () => {
    // The measured production shape: ~94% of the partition unkeyable. A page
    // must not be abandoned at the first skip, and the skips must not consume
    // request budget the keyable rows need.
    const rows: FundRow[] = [
      {
        id: "a",
        symbol: "AAAXX",
        exchange: "NMFQS",
        listingId: null,
        listingStartDate: null,
        listingStatus: "ACTIVE",
      },
      {
        id: "b",
        symbol: "BBBXX",
        exchange: "NMFQS",
        listingId: null,
        listingStartDate: null,
        listingStatus: "ACTIVE",
        permaTicker: "US000000000001",
      },
      {
        id: "c",
        symbol: "CCCXX",
        exchange: "NMFQS",
        listingId: null,
        listingStartDate: null,
        listingStatus: "ACTIVE",
        permaTicker: null,
      },
      {
        id: "d",
        symbol: "DDDXX",
        exchange: "NMFQS",
        listingId: null,
        listingStartDate: null,
        listingStatus: "ACTIVE",
        permaTicker: "US000000000002",
      },
    ];

    const { state, db, fetchedSymbols } = await runNavLeg(rows);

    assert.deepEqual(fetchedSymbols, ["BBBXX", "DDDXX"]);
    assert.equal(state.mfSkippedNoPermaTicker, 2);
    assert.equal(state.mfAttempted, 2);

    // EVERY visited row rotates, keyable or not.
    assert.deepEqual(state.pendingStamps, ["a", "b", "c", "d"]);
    assert.equal(state.mfSelected, 4);

    // Two writes, and the skipped rows contributed nothing to either side.
    assert.equal(db.navUpserts.length, 2);
    assert.equal(state.mfWritten, 2);
  });

  it("the rotation stamp REACHES the database on a page of pure skips", async () => {
    // `STAMP_CHUNK_SIZE` rows so the chunked flush inside `runPriceLeg` fires,
    // rather than leaving every id to `processUsEodSync`'s closing `finally`.
    // Without this the "still stamped" half of the fix would be asserted only
    // against an in-memory buffer, and a broken `flushStamps` would pass.
    const rows: FundRow[] = Array.from(
      { length: STAMP_CHUNK_SIZE },
      (_, i) => ({
        id: `bulk-${i}`,
        symbol: `F${String(i).padStart(4, "0")}X`,
        exchange: "NMFQS",
        listingId: null,
        listingStartDate: null,
        listingStatus: "ACTIVE",
      }),
    );

    const { state, db, fetchedSymbols } = await runNavLeg(rows);

    assert.deepEqual(fetchedSymbols, []);
    assert.equal(state.mfSkippedNoPermaTicker, STAMP_CHUNK_SIZE);
    assert.equal(db.stamped.length, STAMP_CHUNK_SIZE);
    assert.equal(state.stamped, STAMP_CHUNK_SIZE);
    assert.deepEqual(state.pendingStamps, []);
    assert.equal(state.requestsIssued, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The seam must not become a second production path                           */
/* -------------------------------------------------------------------------- */

describe("MONEY-1291 — the injected defaults ARE the production path", () => {
  const PROC = readFileSync(
    fileURLToPath(
      new URL("../../src/processors/us-eod-sync.ts", import.meta.url),
    ),
    "utf8",
  );

  it("`resolvePriceLegDeps` falls back to the real prisma, client and repository", () => {
    // Everything the cases above assert is reached through `deps`, and the
    // sibling source scans in `us-eod-sync-logic.test.ts` now pin the SPELLING
    // `db.usFundNav.upsert(` rather than `prisma.usFundNav.upsert(`. Both are
    // vacuous if `db` is not prisma in production: the writes would land
    // nowhere and every assertion in both files would stay green. This is the
    // one place that says what the handle defaults TO.
    const start = PROC.indexOf("function resolvePriceLegDeps(");
    assert.ok(start > 0, "resolvePriceLegDeps was not found");
    const body = PROC.slice(start, PROC.indexOf("\n}\n", start));

    assert.match(body, /prisma:\s*deps\.prisma \?\? prisma,/);
    assert.match(body, /fetchEod:\s*deps\.fetchEod \?\? fetchTiingoEod,/);
    assert.match(body, /deps\.putCandles \?\?\s*candleRepository\.putCandles/);

    // A default that quietly no-ops would make a forgetful fixture exercise an
    // outage branch while looking like a success — the trap
    // `stock-document-sync`'s own deps block is written against.
    assert.equal(
      /=>\s*(\[\]|null|undefined|\{\})/.test(body),
      false,
      "no default may be a silent stub",
    );
  });

  it("`runPriceLeg`'s deps argument is OPTIONAL, so production passes none", () => {
    // If it were required, every production call site would have to name the
    // collaborators and the defaults would be dead code — the seam would then
    // be a fork of the loop rather than the loop itself.
    assert.match(PROC, /deps\?:\s*UsEodPriceLegDeps;/);
    const calls = PROC.split("\n").filter((l) =>
      l.includes("await runPriceLeg({"),
    );
    assert.equal(calls.length, 2, "legs (a) and (b) are the only call sites");
  });
});
