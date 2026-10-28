/**
 * MONEY-1617 — the nightly EQUITY leg files each bar under the window that
 * covers its session, through the REAL `runPriceLeg`.
 *
 * The pure clip is covered in core; this proves the WIRING: the page's sibling
 * windows are loaded, handed to the writer, and what reaches `putCandles` is
 * what the clip decided — including the measured GAB phantom and RAM split.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  newUsEodRunState,
  runPriceLeg,
  type UsEodPriceLegDeps,
} from "../../src/processors/us-eod-sync";
import type { TiingoEodBar } from "@usemoney/core/market-data/tiingo/tiingo-logic";

interface Row {
  id: string;
  symbol: string;
  exchange: string;
  listingId: string;
  listingStartDate: Date | null;
  listingEndDate: Date | null;
  listingStatus: string;
}
const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const row = (
  listingId: string,
  start: string,
  end: string | null,
  listingStatus = "ACTIVE",
): Row => {
  const [symbol, exchange] = listingId.split(":") as [string, string];
  return {
    id: listingId,
    symbol,
    exchange,
    listingId,
    listingStartDate: d(start),
    listingEndDate: end ? d(end) : null,
    listingStatus,
  };
};
const bar = (date: string, close = 10): TiingoEodBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  divCash: 0,
  splitFactor: 1,
});

/** `page` answers the leg's paged query; `master` answers the window lookup. */
async function runEquity(page: Row[], master: Row[], bars: TiingoEodBar[]) {
  const written: Array<{
    listingId: string;
    ts: Date;
    listingStatus?: string | null;
  }> = [];
  const db = {
    usInstrument: {
      findMany: async (args: {
        take?: number;
        where?: { symbol?: { in: string[] } };
      }) =>
        args.take !== undefined
          ? page.map((r) => ({ ...r, permaTicker: null, usEodSyncedAt: null }))
          : master.filter((r) => args.where?.symbol?.in.includes(r.symbol)),
      updateMany: async () => ({ count: 0 }),
    },
  };
  const deps: UsEodPriceLegDeps = {
    prisma: db as never,
    fetchEod: async () => ({ bars, bytes: 1 }),
    putCandles: (async (rows: typeof written) => {
      written.push(...rows);
      return {
        created: rows.length,
        upgraded: 0,
        preserved: 0,
        failed: 0,
        droppedNonFinite: 0,
        clampedVolume: 0,
        archivedCold: 0,
        coldFellBackToHot: 0,
      };
    }) as never,
  };
  const state = newUsEodRunState();
  await runPriceLeg({
    leg: "EQUITY",
    state,
    take: page.length,
    startedAt: Date.now(),
    legBudgetMs: 300_000,
    requestBudget: 1_000,
    windowStart: "2026-09-15",
    sessionDate: "2026-09-22",
    deps,
  });
  return { state, written };
}

describe("MONEY-1617 — the nightly writer clips to the listing window", () => {
  it("GAB: fetching the one-day PHANTOM row files 09-21 under the 1987 listing", async () => {
    const LONG = row("GAB:NYSE:1987-11-05", "1987-11-05", "2026-09-22");
    const PHANTOM = row(
      "GAB:NYSE:2026-09-21",
      "2026-09-21",
      "2026-09-21",
      "DELISTED",
    );
    const { written } = await runEquity(
      [PHANTOM],
      [LONG, PHANTOM],
      [bar("2026-09-21"), bar("2026-09-22")],
    );
    assert.deepEqual(
      written.map((w) => w.listingId),
      [LONG.listingId, LONG.listingId],
    );
  });

  it("RAM: a bar before the new window goes to the OLD id; a gap bar is dropped and COUNTED", async () => {
    const OLD = row(
      "RAM:NASDAQ:2021-07-09",
      "2021-07-09",
      "2023-03-31",
      "DELISTED",
    );
    const NEW = row("RAM:NASDAQ:2026-06-24", "2026-06-24", "2026-09-22");
    const { state, written } = await runEquity(
      [NEW],
      [OLD, NEW],
      [bar("2023-03-31"), bar("2024-06-03"), bar("2026-09-22")],
    );
    assert.deepEqual(
      written.map((w) => [
        w.ts.toISOString().slice(0, 10),
        w.listingId,
        w.listingStatus,
      ]),
      [
        ["2023-03-31", OLD.listingId, "DELISTED"],
        ["2026-09-22", NEW.listingId, "ACTIVE"],
      ],
    );
    assert.equal(state.clipDropped.OUTSIDE_EVERY_WINDOW, 1);
    assert.equal(state.clipDropped.AMBIGUOUS_WINDOW, 0);
  });

  it("an EMPTY window lookup degrades to the row's OWN window, never to dropping everything", async () => {
    const NEW = row("RAM:NASDAQ:2026-06-24", "2026-06-24", "2026-09-22");
    const { written } = await runEquity([NEW], [], [bar("2026-09-22")]);
    assert.deepEqual(
      written.map((w) => w.listingId),
      [NEW.listingId],
    );
  });
});
