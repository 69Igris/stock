/**
 * The cost model's FOLD — MONEY-1373 D1.
 *
 * `foldQuoteFile` is where the two archived schemas become one row per
 * `(listing, time-of-day)`, and the two are NOT interchangeable:
 *
 *   `bbo-1m`  TIME-UNIFORM — one record a minute per symbol whether or not
 *             anything traded. It is the quoted spread and the quoted size.
 *   `tbbo`    ACTIVITY-WEIGHTED — one record per trade, so a busy minute
 *             contributes hundreds and a quiet one none. It is the EFFECTIVE
 *             spread and nothing else.
 *
 * Folding a tbbo quote into `spread` would re-weight the quoted-spread
 * statistic toward the moments people were trading, which is when spreads are
 * tightest. The number would sit in a column called `quotedSpreadBps`, be
 * biased low, and carry nothing in the row to say so. The case that pins this
 * asserts the bbo `sampleCount` is UNCHANGED by a stream of tbbo rows.
 *
 * The golden fixture is hand-computed, not captured: `tbbo-golden.csv` carries
 * ten rows whose expected effective spreads were worked out on paper (see
 * EXPECTED below), so a change to the arithmetic fails against a number a human
 * derived rather than against a number the code once produced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { zstdCompressSync } from "node:zlib";

import {
  buildCostModel,
  costModelListingIndex,
  emptyCostModelCounters,
  foldQuoteFile,
  TBBO_FOLD_BUDGET_MS,
  TBBO_FOLD_DAYS,
  TBBO_MAX_FILES,
  spreadSample,
  tbboFoldWindow,
  type CostModelBuildDeps,
} from "../../../src/market-data/databento/databento-cost-model";
import {
  summarizeCell,
  type CostCell,
} from "../../../src/market-data/databento/databento-cost-model-logic";
import {
  isTbboRow,
  parseBboHeader,
  parseBboRow,
  parseTbboHeader,
  parseTbboRow,
} from "../../../src/market-data/databento/databento-logic";
import type { ListingRow } from "../../../src/market-data/databento/databento-symbology";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "databento",
  "tbbo-golden.csv",
);

/**
 * The effective spreads, computed by hand from the fixture.
 *
 * `effectiveSpreadBps` is `2 * |price - mid| / mid * 10_000`. On AAPL's
 * 100.00 / 100.10 book the mid is 100.05, so a trade at either side of the
 * quote is `2 * 0.05 / 100.05 * 10_000 = 9.995002…` — EXACTLY the quoted
 * spread `(ask - bid) / mid * 10_000`. That identity is the whole reason the
 * doubling convention exists, and it is the first thing this suite pins.
 */
const EXPECTED = {
  atTheAsk: 9.995002,
  atTheMid: 0,
  atTheBid: 9.995002,
  outsideTheQuote: 29.985007,
  quotedSpread: 9.995002,
} as const;

/** One trading-day listing per symbol, live across the fixture's dates. */
function listings(): ReturnType<typeof costModelListingIndex> {
  const rows: ListingRow[] = ["AAPL", "MSFT"].map((symbol) => ({
    symbol,
    exchange: "NASDAQ",
    listingId: `${symbol}:NASDAQ:2000-01-01`,
    listingStartDate: new Date("2000-01-01T00:00:00Z"),
    listingEndDate: null,
    listingStatus: "ACTIVE",
  }));
  return costModelListingIndex(rows);
}

/** The archive serves zstd; the fold reads it through `zstdLines`. */
function zstdStream(csv: string): Readable {
  return Readable.from([zstdCompressSync(Buffer.from(csv, "utf8"))]);
}

function goldenCsv(): string {
  return readFileSync(FIXTURE, "utf8");
}

/** A minimal bbo file over the same book, for the mixing case. */
function bboCsv(rowCount: number): string {
  const lines = ["ts_recv,symbol,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00"];
  // 2026-03-16 is a Monday; 14:00Z is 10:00 ET (EDT), the MID bucket.
  // `pretty_ts: true` renders ISO 8601 with NINE fractional digits, not
  // epoch-nanos — the manifest sets it and `parseNanoTimestamp` parses it.
  const base = Date.parse("2026-03-16T14:00:00Z");
  for (let i = 0; i < rowCount; i++) {
    const ts = new Date(base + i * 60_000)
      .toISOString()
      .replace("Z", "000000Z");
    lines.push(`${ts},AAPL,100.00,100.10,500,700`);
  }
  return `${lines.join("\n")}\n`;
}

async function foldGolden(): Promise<{
  cells: Map<string, CostCell>;
  counters: ReturnType<typeof emptyCostModelCounters>;
}> {
  const cells = new Map<string, CostCell>();
  const counters = emptyCostModelCounters();
  await foldQuoteFile({
    stream: zstdStream(goldenCsv()),
    kind: "tbbo",
    listings: listings(),
    cells,
    counters,
  });
  return { cells, counters };
}

/* ── the parser ────────────────────────────────────────────────────────── */

describe("parseTbboHeader reads BY NAME", () => {
  it("finds every column in a SHUFFLED header", () => {
    // The vendor's sibling CSV is documented `date,open,…` and is really
    // `date,close,high,low,open`. A positional parser written from the docs
    // swaps two columns on every row and the numbers stay plausible, so the
    // header is deliberately scrambled here.
    const cols = parseTbboHeader(
      "symbol,ask_px_00,price,ts_recv,bid_sz_00,action,bid_px_00,ask_sz_00",
    );
    assert.equal(cols.symbol, 0);
    assert.equal(cols.askPx, 1);
    assert.equal(cols.price, 2);
    assert.equal(cols.tsRecv, 3);
    assert.equal(cols.bidSz, 4);
    assert.equal(cols.action, 5);
    assert.equal(cols.bidPx, 6);
    assert.equal(cols.askSz, 7);
  });

  it("reads the REAL vendor header the DBN crate emits", () => {
    const header = goldenCsv().split("\n")[0]!;
    const cols = parseTbboHeader(header);
    assert.ok(cols.price >= 0);
    assert.ok(cols.bidPx >= 0 && cols.askPx >= 0);
  });

  it("THROWS naming `price` — a tbbo file without one is a bbo file", () => {
    assert.throws(
      () => parseTbboHeader("ts_recv,symbol,bid_px_00,ask_px_00"),
      /missing column\(s\) price/,
    );
  });

  it("tolerates a missing `action`: absence is not evidence of a non-trade", () => {
    const cols = parseTbboHeader("ts_recv,symbol,bid_px_00,ask_px_00,price");
    assert.equal(cols.action, -1);
    const row = parseTbboRow(
      "2026-03-16T14:00:00.000000000Z,AAPL,100.00,100.10,100.10",
      cols,
    );
    assert.ok(!("rejected" in row), "a row with no action column was rejected");
  });
});

describe("parseTbboRow rejects by REASON", () => {
  const cols = parseTbboHeader(
    "ts_recv,symbol,bid_px_00,ask_px_00,price,action",
  );
  const row = (bid: string, ask: string, px: string, action = "T"): unknown =>
    parseTbboRow(
      `2026-03-16T14:00:00.000000000Z,AAPL,${bid},${ask},${px},${action}`,
      cols,
    );

  it("rejects a crossed book through the SAME test the bbo fold uses", () => {
    // Delegated to `parseBboRow` rather than restated: one rule, stated twice,
    // disagreeing is the most expensive defect class in this repo.
    assert.deepEqual(row("100.10", "100.00", "100.05"), {
      rejected: "crossed",
    });
  });

  it("rejects an empty side", () => {
    assert.deepEqual(row("", "100.10", "100.05"), { rejected: "price" });
  });

  it("separates an unusable PRINT from an unusable BOOK", () => {
    // Two different findings: "the book was unusable" and "the print was
    // unusable" need opposite responses, so they get different names.
    assert.deepEqual(row("100.00", "100.10", ""), { rejected: "tradePrice" });
    assert.deepEqual(row("100.00", "100.10", "0"), { rejected: "tradePrice" });
  });

  it("isTbboRow separates the two shapes the fold branches on", () => {
    // `TbboRow extends BboRow`, so the union does not discriminate itself and
    // `"price" in row` narrows `price` to `unknown`. The fold picks the
    // effective spread or the quoted sample on this predicate, so a wrong
    // answer here silently costs every trade as a quote or vice versa.
    const bboCols = parseBboHeader("ts_recv,symbol,bid_px_00,ask_px_00");
    const bbo = parseBboRow(
      "2026-03-16T14:00:00.000000000Z,AAPL,100.00,100.10",
      bboCols,
    );
    assert.ok(!("rejected" in bbo));
    assert.equal(isTbboRow(bbo), false);

    const trade = row("100.00", "100.10", "100.10");
    assert.ok(!(trade as { rejected?: string }).rejected);
    assert.equal(isTbboRow(trade as never), true);
  });

  it("rejects a non-trade action", () => {
    assert.deepEqual(row("100.00", "100.10", "100.05", "C"), {
      rejected: "notTrade",
    });
  });
});

/* ── the golden fold ───────────────────────────────────────────────────── */

describe("the golden tbbo fold, computed by hand", () => {
  it("a trade at the ask costs EXACTLY the quoted spread", async () => {
    const { cells } = await foldGolden();
    const cell = cells.get("AAPL:NASDAQ:2000-01-01|MID");
    assert.ok(cell !== undefined, "no AAPL MID cell");
    const values = [...cell.effective.values].sort((a, b) => a - b);
    assert.equal(values.length, 4, `sampled ${values.length}, expected 4`);
    assert.equal(values[0]!.toFixed(6), EXPECTED.atTheMid.toFixed(6));
    assert.equal(values[1]!.toFixed(6), EXPECTED.atTheAsk.toFixed(6));
    assert.equal(values[2]!.toFixed(6), EXPECTED.atTheBid.toFixed(6));
    assert.equal(values[3]!.toFixed(6), EXPECTED.outsideTheQuote.toFixed(6));
    // The identity the doubling convention exists for.
    assert.equal(
      EXPECTED.atTheAsk.toFixed(6),
      EXPECTED.quotedSpread.toFixed(6),
    );
  });

  it("counts every rejection under its own name", async () => {
    const { counters } = await foldGolden();
    assert.equal(counters.tbboFilesRead, 1);
    assert.equal(counters.tradesRead, 10);
    assert.equal(counters.tradesSampled, 5, "4 AAPL MID + 1 MSFT MID");
    assert.equal(counters.skippedNotTrade, 1, "the action=C row");
    assert.equal(counters.parseRejected, 3, "crossed, empty bid, no price");
    assert.equal(counters.skippedOutsideSession, 1, "the 03:00 ET row");
    // The bbo counters were never touched by a tbbo file.
    assert.equal(counters.filesRead, 0);
    assert.equal(counters.rowsRead, 0);
    assert.equal(counters.rowsSampled, 0);
  });

  it("leaves the QUOTED statistics empty — a trade is not a time sample", async () => {
    const { cells } = await foldGolden();
    for (const cell of cells.values()) {
      assert.equal(
        cell.spread.count,
        0,
        `${cell.symbol} ${cell.todBucket}: a tbbo row reached the quoted spread`,
      );
      assert.equal(cell.quotedSize.count, 0);
    }
  });

  it("a trade-only cell summarizes to NOTHING, and that is deliberate", async () => {
    // `summarizeCell` returns null when `spread.count === 0`. The model's
    // primary statistic is the QUOTED spread; effective is a supplement to it.
    // So the trade leg can only ever ENRICH cells the bbo fold already built,
    // and a listing that somehow had trades and no quotes would be dropped
    // rather than written with a cost basis of one number.
    //
    // Safe in practice because TOP50 is a strict subset of BASELINE (verified
    // 2026-09-07: 0 missing) and the 92-day tbbo window sits inside the
    // 365-day bbo one, so every tbbo listing has a bbo cell in the same
    // bucket.
    const { cells } = await foldGolden();
    assert.equal(summarizeCell(cells.get("MSFT:NASDAQ:2000-01-01|MID")!), null);
  });

  it("enriches a cell the QUOTE leg built", async () => {
    const listingIndex = listings();
    const cells = new Map<string, CostCell>();
    const counters = emptyCostModelCounters();
    await foldQuoteFile({
      stream: zstdStream(bboCsv(30)),
      kind: "bbo",
      listings: listingIndex,
      cells,
      counters,
    });
    await foldQuoteFile({
      stream: zstdStream(goldenCsv()),
      kind: "tbbo",
      listings: listingIndex,
      cells,
      counters,
    });
    const summary = summarizeCell(cells.get("AAPL:NASDAQ:2000-01-01|MID")!);
    assert.ok(summary !== null);
    assert.equal(summary.effectiveSampleCount, 4);
    // The median of {0, 9.995002, 9.995002, 29.985007} at NEAREST RANK.
    assert.equal(
      summary.effectiveSpreadBps!.toFixed(6),
      EXPECTED.atTheAsk.toFixed(6),
    );
    // And the quoted statistic is still the quote's.
    assert.equal(
      summary.medianSpreadBps.toFixed(6),
      EXPECTED.quotedSpread.toFixed(6),
    );
  });
});

describe("the two folds do not contaminate each other", () => {
  it("tbbo rows leave the bbo sampleCount UNCHANGED", async () => {
    // THE case this leg is most likely to get wrong. Folding a trade-time
    // quote into `spread` re-weights the quoted spread toward the moments
    // people were trading, which is when spreads are tightest — a number that
    // looks like a quoted spread, is biased low, and says nothing about it.
    const listingIndex = listings();
    const cells = new Map<string, CostCell>();
    const counters = emptyCostModelCounters();

    await foldQuoteFile({
      stream: zstdStream(bboCsv(30)),
      kind: "bbo",
      listings: listingIndex,
      cells,
      counters,
    });
    const cell = cells.get("AAPL:NASDAQ:2000-01-01|MID")!;
    const quotedBefore = cell.spread.count;
    const sizeBefore = cell.quotedSize.count;
    // 29 of 30, not 30 — and that is the interval-END rule working. The first
    // row is stamped 14:00:00.000Z, one millisecond back is 09:59:59.999 ET,
    // and OPEN30 runs to 10:00. A bbo record is bucketed by when its interval
    // CLOSED, so the row belongs to the bucket it closed in.
    assert.equal(quotedBefore, 29);
    assert.equal(cells.get("AAPL:NASDAQ:2000-01-01|OPEN30")!.spread.count, 1);

    await foldQuoteFile({
      stream: zstdStream(goldenCsv()),
      kind: "tbbo",
      listings: listingIndex,
      cells,
      counters,
    });

    assert.equal(cell.spread.count, quotedBefore, "tbbo reached `spread`");
    assert.equal(
      cell.quotedSize.count,
      sizeBefore,
      "tbbo reached `quotedSize`",
    );
    assert.equal(cell.effective.count, 4);
    assert.equal(counters.rowsSampled, 30);
    assert.equal(counters.tradesSampled, 5);
    // The tbbo stamp is an EVENT, used as-is — no one-millisecond shift — so
    // its 14:00:00.000Z row lands in MID where the bbo row of the same stamp
    // landed in OPEN30. Pinning both directions keeps the two rules apart.
    assert.equal(
      cells.get("AAPL:NASDAQ:2000-01-01|OPEN30")!.effective.count,
      0,
    );
  });

  it("a header-less tbbo object THROWS, naming its kind", async () => {
    await assert.rejects(
      () =>
        foldQuoteFile({
          stream: zstdStream(""),
          kind: "tbbo",
          listings: listings(),
          cells: new Map(),
          counters: emptyCostModelCounters(),
        }),
      /foldQuoteFile\(tbbo\): the stream produced no header line/,
    );
  });
});

/* ── the build ─────────────────────────────────────────────────────────── */

describe("the build tolerates an absent trade leg", () => {
  function deps(over: Partial<CostModelBuildDeps> = {}): CostModelBuildDeps {
    const logged: string[] = [];
    return {
      listBboFiles: async () => [{ jobId: "J1", archiveKey: "bbo/1" }],
      openArchive: async (key) =>
        key.startsWith("bbo")
          ? zstdStream(bboCsv(30))
          : zstdStream(goldenCsv()),
      listingRows: async () => [
        {
          symbol: "AAPL",
          exchange: "NASDAQ",
          listingId: "AAPL:NASDAQ:2000-01-01",
          listingStartDate: new Date("2000-01-01T00:00:00Z"),
          listingEndDate: null,
          listingStatus: "ACTIVE",
        },
      ],
      listingLiquidity: async () => [
        { listingId: "AAPL:NASDAQ:2000-01-01", medianDollarVolume: 1e9 },
      ],
      createVersion: async () => {},
      writeRows: async () => {},
      finishVersion: async () => {},
      nextVersion: async () => 1,
      log: (...a) => logged.push(a.join(" ")),
      ...over,
    };
  }

  const window = {
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2026-04-01T00:00:00Z"),
    trigger: "TEST",
    apply: false,
  };

  it("is READY with effectiveSpreadBps absent when no tbbo file exists", async () => {
    // The effective column is documented as "where we have them". Zero tbbo
    // files is the state before the entry is harvested, and it must not fail
    // the build the way zero BBO files does.
    const result = await buildCostModel({
      ...window,
      deps: deps({
        listTbboFiles: async () => ({
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-04-01T00:00:00Z"),
          files: [],
        }),
      }),
    });
    assert.equal(result.dryRun, true);
    assert.ok(result.rowCount > 0);
    assert.equal(result.counters.tbboFilesRead, 0);
    assert.equal(result.counters.tradesSampled, 0);
  });

  it("is READY with the leg entirely undeclared", async () => {
    const result = await buildCostModel({ ...window, deps: deps() });
    assert.ok(result.rowCount > 0);
    assert.equal(result.counters.tradesRead, 0);
  });

  it("folds the trades when the leg IS declared", async () => {
    const result = await buildCostModel({
      ...window,
      deps: deps({
        listTbboFiles: async () => ({
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-04-01T00:00:00Z"),
          files: [{ jobId: "J2", archiveKey: "tbbo/1" }],
        }),
      }),
    });
    assert.equal(result.counters.tbboFilesRead, 1);
    // FOUR, not five: these deps declare only AAPL, so the fixture's MSFT
    // trade is an unknown listing. A trade whose listing we cannot resolve is
    // counted, never guessed onto a neighbouring symbol.
    assert.equal(result.counters.tradesSampled, 4);
    assert.equal(result.counters.skippedUnknownListing, 1);
    assert.equal(result.counters.rowsSampled, 30, "the bbo leg is unaffected");
  });

  it("an unreadable tbbo object does NOT count against the readable floor", async () => {
    // MIN_READABLE_RATIO grades the bbo sample the model is COSTED on. A
    // missing optional column must not refuse a build that has its quotes.
    const result = await buildCostModel({
      ...window,
      deps: deps({
        listTbboFiles: async () => ({
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-04-01T00:00:00Z"),
          files: [
            { jobId: "J2", archiveKey: "tbbo/1" },
            { jobId: "J3", archiveKey: "tbbo/2" },
          ],
        }),
        openArchive: async (key) =>
          key === "bbo/1" ? zstdStream(bboCsv(30)) : null,
      }),
    });
    assert.ok(result.rowCount > 0, "the build refused over an optional column");
    assert.equal(result.counters.tbboFilesRead, 0);
  });

  it("names BOTH legs' jobs on the version row", async () => {
    // A version that named only the bbo jobs leaves the trade sample
    // unprovenanced, and provenance is the entire reason the row exists: a
    // backtest pins the version and can never ask again.
    let named: string[] = [];
    await buildCostModel({
      ...window,
      apply: true,
      deps: deps({
        listTbboFiles: async () => ({
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-04-01T00:00:00Z"),
          files: [{ jobId: "J2", archiveKey: "tbbo/1" }],
        }),
        createVersion: async (a) => {
          named = [...a.sourceJobIds];
        },
      }),
    });
    assert.deepEqual([...named].sort(), ["J1", "J2"]);
  });
});

describe("the trade leg is BOUNDED — it cannot outrun the task timeout", () => {
  it("spreads its sample across the window instead of taking a prefix", () => {
    // A prefix samples the oldest sessions and a suffix the newest; either is
    // a biased sample of a 92-day window, and a time-of-day statistic is
    // exactly the thing that bias moves.
    const files = Array.from({ length: 92 }, (_, i) => i);
    const picked = spreadSample(files, TBBO_MAX_FILES);
    assert.equal(picked.length, TBBO_MAX_FILES);
    assert.equal(picked[0], 0, "the oldest session is always included");
    assert.ok(
      picked[picked.length - 1]! > files.length - 2 * (92 / TBBO_MAX_FILES),
      "the sample does not reach the end of the window",
    );
    assert.deepEqual(
      [...picked].sort((a, b) => a - b),
      picked,
      "the stride must preserve the oldest-first order",
    );
    assert.equal(new Set(picked).size, picked.length, "duplicate file picked");
  });

  it("returns a short window unchanged rather than padding it", () => {
    assert.deepEqual(spreadSample([1, 2, 3], TBBO_MAX_FILES), [1, 2, 3]);
    assert.deepEqual(spreadSample([], 5), []);
    assert.throws(() => spreadSample([1], 0), RangeError);
  });

  it("the BUILD applies the cap, not just the helper", () => {
    // The mutation that made this necessary: replacing `spreadSample(...)`
    // with `[...tbboFiles]` at the call site passed every case above, because
    // they all exercised the helper directly. A helper nothing calls is the
    // same hole as no helper at all.
    const many = Array.from({ length: 30 }, (_, i) => ({
      jobId: "J2",
      archiveKey: `tbbo/${i}`,
    }));
    return buildCostModel({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-04-01T00:00:00Z"),
      trigger: "TEST",
      apply: false,
      deps: {
        listBboFiles: async () => [{ jobId: "J1", archiveKey: "bbo/1" }],
        listTbboFiles: async () => ({
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-04-01T00:00:00Z"),
          files: many,
        }),
        openArchive: async (key) =>
          key.startsWith("bbo")
            ? zstdStream(bboCsv(5))
            : zstdStream(goldenCsv()),
        listingRows: async () => [
          {
            symbol: "AAPL",
            exchange: "NASDAQ",
            listingId: "AAPL:NASDAQ:2000-01-01",
            listingStartDate: new Date("2000-01-01T00:00:00Z"),
            listingEndDate: null,
            listingStatus: "ACTIVE",
          },
        ],
        listingLiquidity: async () => [
          { listingId: "AAPL:NASDAQ:2000-01-01", medianDollarVolume: 1e9 },
        ],
        createVersion: async () => {},
        writeRows: async () => {},
        finishVersion: async () => {},
        nextVersion: async () => 1,
        log: () => {},
      },
    }).then((result) => {
      assert.equal(
        result.counters.tbboFilesRead,
        TBBO_MAX_FILES,
        `folded ${result.counters.tbboFilesRead} of ${many.length} files; the cap is ${TBBO_MAX_FILES}`,
      );
      assert.equal(result.counters.tbboFilesSkippedForTime, 0, "not a timeout");
    });
  });

  it("stops on its wall clock and SAYS SO rather than being killed", () => {
    // Being killed by Cloud Run loses the whole build: `createCostModelVersion`
    // has not run, so no BUILDING row survives to explain it, and because the
    // kill lands after the bar-writing loop `reportJobOutcome` never runs and
    // the append's monitors read NO DATA. Stopping early costs an OPTIONAL
    // column and is reported.
    let ticks = 0;
    const logged: string[] = [];
    return buildCostModel({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-04-01T00:00:00Z"),
      trigger: "TEST",
      apply: false,
      deps: {
        listBboFiles: async () => [{ jobId: "J1", archiveKey: "bbo/1" }],
        listTbboFiles: async () => ({
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-04-01T00:00:00Z"),
          files: [
            { jobId: "J2", archiveKey: "tbbo/1" },
            { jobId: "J2", archiveKey: "tbbo/2" },
            { jobId: "J2", archiveKey: "tbbo/3" },
          ],
        }),
        // First call starts the clock, second is still inside, third is past.
        now: () => [0, 1, TBBO_FOLD_BUDGET_MS + 1][ticks++] ?? 1e12,
        openArchive: async (key) =>
          key.startsWith("bbo")
            ? zstdStream(bboCsv(5))
            : zstdStream(goldenCsv()),
        listingRows: async () => [
          {
            symbol: "AAPL",
            exchange: "NASDAQ",
            listingId: "AAPL:NASDAQ:2000-01-01",
            listingStartDate: new Date("2000-01-01T00:00:00Z"),
            listingEndDate: null,
            listingStatus: "ACTIVE",
          },
        ],
        listingLiquidity: async () => [
          { listingId: "AAPL:NASDAQ:2000-01-01", medianDollarVolume: 1e9 },
        ],
        createVersion: async () => {},
        writeRows: async () => {},
        finishVersion: async () => {},
        nextVersion: async () => 1,
        log: (...a) => logged.push(a.join(" ")),
      },
    }).then((result) => {
      assert.equal(result.counters.tbboFilesRead, 1, "folded past the budget");
      assert.equal(result.counters.tbboFilesSkippedForTime, 2);
      assert.ok(
        logged.some((l) => l.includes("budget after")),
        "the early stop was not reported",
      );
      // The BUILD still succeeded — the quoted spread is what it is costed on.
      assert.ok(result.rowCount > 0);
    });
  });

  it("stamps the trade leg's OWN window on the version row", () => {
    // `builtFrom`/`builtTo` describe the 365-day QUOTE window. The trade
    // window is anchored at the archive and stops moving, so without these
    // three fields a reader — which is Python, and cannot see a TypeScript
    // comment — cannot tell a fresh effective column from a two-year-old one.
    let seen: Record<string, unknown> = {};
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-04-01T00:00:00Z");
    return buildCostModel({
      from: new Date("2025-04-01T00:00:00Z"),
      to: new Date("2026-04-01T00:00:00Z"),
      trigger: "TEST",
      apply: true,
      deps: {
        listBboFiles: async () => [{ jobId: "J1", archiveKey: "bbo/1" }],
        listTbboFiles: async () => ({
          from,
          to,
          files: [{ jobId: "J2", archiveKey: "tbbo/1" }],
        }),
        openArchive: async (key) =>
          key.startsWith("bbo")
            ? zstdStream(bboCsv(30))
            : zstdStream(goldenCsv()),
        listingRows: async () => [
          {
            symbol: "AAPL",
            exchange: "NASDAQ",
            listingId: "AAPL:NASDAQ:2000-01-01",
            listingStartDate: new Date("2000-01-01T00:00:00Z"),
            listingEndDate: null,
            listingStatus: "ACTIVE",
          },
        ],
        listingLiquidity: async () => [
          { listingId: "AAPL:NASDAQ:2000-01-01", medianDollarVolume: 1e9 },
        ],
        createVersion: async (a) => {
          seen = a as unknown as Record<string, unknown>;
        },
        writeRows: async () => {},
        finishVersion: async () => {},
        nextVersion: async () => 1,
        log: () => {},
      },
    }).then(() => {
      assert.equal((seen["effectiveFrom"] as Date).getTime(), from.getTime());
      assert.equal((seen["effectiveTo"] as Date).getTime(), to.getTime());
      assert.equal(seen["effectiveFileCount"], 1);
      // And it is NOT the quote window.
      assert.notEqual(
        (seen["builtFrom"] as Date).getTime(),
        (seen["effectiveFrom"] as Date).getTime(),
      );
    });
  });
});

describe("the fold window is anchored at the ARCHIVE, not at now", () => {
  it("is 92 days, and the constant says why it is not the 12 months bought", () => {
    // The PURCHASE is 12 months because it is a one-way buy at $0 inside the
    // subscription. The FOLD is 92 days because ~4-8M rows a day is
    // ~250-500M lines, which is 10-30 minutes in Node — inside the append's
    // 2 h task timeout, where a 12-month fold would not be.
    assert.equal(TBBO_FOLD_DAYS, 92);
  });

  it("still selects 92 days when the archive is 200 days old", () => {
    // THE FAILURE THIS PREVENTS. `tbbo-top50` is `append: false`, so the
    // archive stops moving the day the harvest finishes. A `now - 92d` window
    // selects ZERO files about three months later and every rebuild from then
    // on drops `effectiveSpreadBps` from every row — while still reporting a
    // READY model, which is the shape nobody notices.
    const now = new Date("2026-09-07T00:00:00Z");
    const archiveEnd = new Date(now.getTime() - 200 * 86_400_000);
    const window = tbboFoldWindow(archiveEnd)!;
    assert.equal(window.to.getTime(), archiveEnd.getTime());
    assert.equal(
      (window.to.getTime() - window.from.getTime()) / 86_400_000,
      TBBO_FOLD_DAYS,
    );
    // The window a `now`-anchored rule would have produced starts AFTER the
    // archive ends, so it can only select nothing.
    const naiveFrom = new Date(now.getTime() - TBBO_FOLD_DAYS * 86_400_000);
    assert.ok(
      naiveFrom.getTime() > archiveEnd.getTime(),
      "the 200-day gap must exceed the fold window for this case to bite",
    );
  });

  it("is null when nothing is archived — not a zero-width window", () => {
    assert.equal(tbboFoldWindow(null), null);
  });
});
