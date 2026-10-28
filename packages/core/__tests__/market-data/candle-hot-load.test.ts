/**
 * MONEY-980 — the READ-side cold -> hot write-back.
 *
 * Everything here is about ONE failure that produces no error, no log and no
 * visible symptom: a series somebody reads every single day quietly ageing out
 * of the hot store after 30 days, so the chart gets slower once and the
 * `hotLoadedYears` ledger goes on claiming a year that is no longer hot.
 *
 * ## The trap has THREE halves, and the third one is why this file grew
 *
 *   1. its CAUSE — `partitionCandleWrites` really does preserve, so a
 *      `putCandles`-only write-back really cannot refresh the stamp;
 *   2. its FIX — the stamp is refreshed by a write that names `hotLoadedAt` and
 *      nothing precedence has an opinion about; and
 *   3. **whether that fix is REACHABLE.** It was not. `buildHotLoadStampUpdates`
 *      was correct in isolation and every assertion about it passed, while the
 *      only path to it ran off `promotableColdBars`, which by design returns
 *      nothing once the bars are in Mongo. So the refresh executed exactly
 *      once per series, ever, and the file that proved the fix could not see it
 *      — because the entire repository half was asserted with SOURCE SCANS and
 *      none of it ran.
 *
 * That is the lesson this file now encodes. Pure decisions are still tested
 * purely, but every wiring claim that CAN be executed IS executed, against the
 * real `CandleRepository` with a recording fake driver in place of Prisma. A
 * source scan is kept only where there is nothing to run — the shape of a raw
 * command, the absence of a call — and every one of them proves its extracted
 * region is non-empty before asserting that something is missing from it,
 * because `src.slice(-1, n)` is `""` and `""` passes every negative assertion
 * ever written about it.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "@usemoney/database";

import {
  barsNeedingHotLoadStamp,
  buildHotLoadStampUpdates,
  candleKey,
  encodeColdShard,
  groupTimestampsBySeries,
  hotLoadedYearsForBars,
  isLoadedTier,
  partitionCandleWrites,
  partitionCandlesByDestination,
  promotableColdBars,
  sanitizeCandleWrites,
  toHotLoadWriteRows,
  HOT_LOAD_STAMP_CHUNK,
  HOT_LOAD_STAMP_MAX_AGE_MS,
  type CandleBar,
  type HotCandleRow,
  type NormalizedCandleWrite,
} from "../../src/market-data/candles/candle-logic";
import {
  CandleRepository,
  type CandleReadMeta,
} from "../../src/market-data/candles/candle-repository";
import {
  setCandleColdStore,
  type CandleColdStore,
} from "../../src/market-data/candles/candle-cold-store";

const CORE = join(import.meta.dirname, "..", "..");
const REPO = join(CORE, "..", "..");
const read = (...parts: string[]): string =>
  readFileSync(join(REPO, ...parts), "utf8");

const REPOSITORY = read(
  "packages",
  "core",
  "src",
  "market-data",
  "candles",
  "candle-repository.ts",
);

const EVICT_LOGIC = read(
  "workers",
  "src",
  "processors",
  "candle-evict-logic.ts",
);

/**
 * A named region of a source file, PROVEN to exist before anything is asserted
 * about it.
 *
 * The reason this is a function and not two `indexOf`s at each call site is a
 * live defect it replaces. A scan written as
 * `src.slice(src.indexOf(a), src.indexOf(b))` silently yields `""` when `a` is
 * absent (`slice(-1, n)` with `n < len - 1`), and `""` satisfies every negative
 * assertion — `!"".includes("putCandles")` is `true`. One of the six scans in
 * this file was written that way and asserted nothing at all.
 *
 * Three guards, and the second is the one the old form also lacked: the end
 * anchor is searched from AFTER the start anchor, so an end token that happens
 * to appear earlier in the file cannot produce an empty region either.
 */
function region(src: string, startAnchor: string, endAnchor: string): string {
  const start = src.indexOf(startAnchor);
  assert.notEqual(start, -1, `start anchor never found: ${startAnchor}`);
  const end = src.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(
    end,
    -1,
    `end anchor never found AFTER the start anchor: ${endAnchor}`,
  );
  const body = src.slice(start, end);
  assert.ok(
    body.length > 100,
    `region [${startAnchor} … ${endAnchor}] is ${body.length} chars — too ` +
      "small to be the block this scan means to assert about",
  );
  return body;
}

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

function bar(over: Partial<CandleBar> & { ts: Date }): CandleBar {
  return {
    symbol: "DOW",
    exchange: "NYSE",
    timeframe: "D1",
    listingId: "DOW:NYSE:2019-03-20",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1_000,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    ...over,
  };
}

/**
 * Source with comments stripped — LINE comments before BLOCK comments.
 *
 * Order is not cosmetic (MONEY-1143): strip block comments first and a `//`
 * comment containing a `/*` opens a phantom block that runs to the next `*` +
 * `/`, hundreds of lines away, deleting live call sites from the scan.
 */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/* ─────────────────────────────────────────────────────────────────────────
   promotableColdBars — WHICH bars get pulled into the hot store
   ──────────────────────────────────────────────────────────────────────── */

describe("promotableColdBars", () => {
  it("promotes a cold bar the read served and Mongo did not have", () => {
    const cold = [bar({ ts: d("2015-06-01") })];
    const promoted = promotableColdBars({ cold, served: cold, hot: [] });
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]!.ts.toISOString(), "2015-06-01T00:00:00.000Z");
  });

  it("DROPS the other occupant of a recycled ticker", () => {
    // `candles/US/D1/DOW/2015` is keyed by TICKER, so it legitimately holds Dow
    // CHEMICAL's bars while the reader asked for Dow INC. `selectSingleListing`
    // has already picked one; promoting the other would spend hot-window rows
    // on a company nobody requested and would put its years in the WRONG
    // listing's `hotLoadedYears` ledger.
    const wanted = bar({ ts: d("2015-06-01") });
    const other = bar({
      ts: d("2015-06-02"),
      listingId: "DOW:NYSE:1972-06-01",
    });
    const promoted = promotableColdBars({
      cold: [wanted, other],
      served: [wanted],
      hot: [],
    });
    assert.deepEqual(
      promoted.map((b) => b.listingId),
      ["DOW:NYSE:2019-03-20"],
    );
  });

  it("EXCLUDES a key Mongo already answered with", () => {
    // The corruption this prevents: an in-window `WINDOW` row whose key also
    // appears in a stale shard would be re-stamped LOADED and then deleted 30
    // days later by a rule that has no business governing it — the window does.
    const shared = bar({ ts: d("2015-06-01") });
    const coldOnly = bar({ ts: d("2015-06-02") });
    const promoted = promotableColdBars({
      cold: [shared, coldOnly],
      served: [shared, coldOnly],
      hot: [shared],
    });
    assert.deepEqual(
      promoted.map((b) => b.ts.toISOString()),
      ["2015-06-02T00:00:00.000Z"],
    );
  });

  it("DEDUPES a repeated shard line", () => {
    // `parseColdShard` is line-tolerant and does not dedupe. A repeat reaching
    // `createMany` aborts the WHOLE chunk on the four-part unique index —
    // Prisma-Mongo has no usable `skipDuplicates`.
    const one = bar({ ts: d("2015-06-01") });
    const promoted = promotableColdBars({
      cold: [one, { ...one }],
      served: [one],
      hot: [],
    });
    assert.equal(promoted.length, 1);
  });

  it("returns bars ASCENDING by ts", () => {
    const later = bar({ ts: d("2015-06-03") });
    const earlier = bar({ ts: d("2015-06-01") });
    const promoted = promotableColdBars({
      cold: [later, earlier],
      served: [later, earlier],
      hot: [],
    });
    assert.deepEqual(
      promoted.map((b) => b.ts.toISOString()),
      ["2015-06-01T00:00:00.000Z", "2015-06-03T00:00:00.000Z"],
    );
  });

  it("promotes the WHOLE cold year, not the caller's slice", () => {
    // A shard's granularity is a symbol-YEAR and `hotLoadedYears` is a per-YEAR
    // ledger. Promoting only the requested slice would make the ledger claim a
    // year is hot when eleven months of it are not, and the next read with
    // slightly different bounds would go back to GCS anyway.
    const january = bar({ ts: d("2015-01-05") });
    const june = bar({ ts: d("2015-06-01") });
    const promoted = promotableColdBars({
      cold: [january, june],
      served: [january, june],
      hot: [],
    });
    assert.equal(promoted.length, 2);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   barsNeedingHotLoadStamp — the half `promotableColdBars` structurally cannot do
   ──────────────────────────────────────────────────────────────────────── */

function hotRow(over: Partial<HotCandleRow> & { ts: Date }): HotCandleRow {
  return { ...bar(over), tier: "LOADED", hotLoadedAt: null, ...over };
}

const NOW = d("2026-08-28");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const DAY_MS = 24 * 60 * 60 * 1000;

describe("barsNeedingHotLoadStamp", () => {
  it("selects a served LOADED row whose stamp has aged past the budget", () => {
    const row = hotRow({ ts: d("2015-06-01"), hotLoadedAt: ago(3 * DAY_MS) });
    const picked = barsNeedingHotLoadStamp({
      hot: [row],
      served: [row],
      now: NOW,
    });
    assert.deepEqual(
      picked.map((b) => b.ts.toISOString()),
      ["2015-06-01T00:00:00.000Z"],
    );
  });

  it("SKIPS a row stamped inside the budget — the write budget, not a correctness knob", () => {
    const row = hotRow({ ts: d("2015-06-01"), hotLoadedAt: ago(60_000) });
    assert.deepEqual(
      barsNeedingHotLoadStamp({ hot: [row], served: [row], now: NOW }),
      [],
    );
  });

  it("refreshes at EXACTLY the budget, so a daily reader is never one tick short", () => {
    // The comparison is "skip when provably fresher than the budget", so the
    // boundary belongs to the refresh side. A `<=` here would let a series read
    // at the same clock time every day drift a day older on every read.
    const row = hotRow({
      ts: d("2015-06-01"),
      hotLoadedAt: ago(HOT_LOAD_STAMP_MAX_AGE_MS),
    });
    assert.equal(
      barsNeedingHotLoadStamp({ hot: [row], served: [row], now: NOW }).length,
      1,
    );
  });

  it("REFRESHES a LOADED row with NO stamp — otherwise it is immortal", () => {
    // A `LOADED` row whose `hotLoadedAt` is absent can never match the
    // eviction's `{lt: cutoff}`, so it would sit in Mongo for ever. Repairing
    // it is the point, not a side effect — and it is why the staleness test is
    // written as "skip when provably fresh" rather than "refresh when provably
    // stale": `NaN < budget` is false, so an unusable stamp falls through to
    // the refresh.
    const row = hotRow({ ts: d("2015-06-01"), hotLoadedAt: null });
    assert.equal(
      barsNeedingHotLoadStamp({ hot: [row], served: [row], now: NOW }).length,
      1,
    );
  });

  it("REFRESHES a row whose stamp is an Invalid Date", () => {
    const row = hotRow({
      ts: d("2015-06-01"),
      hotLoadedAt: new Date("not-a-date"),
    });
    assert.equal(
      barsNeedingHotLoadStamp({ hot: [row], served: [row], now: NOW }).length,
      1,
    );
  });

  it("SKIPS a WINDOW row — the tier test is POSITIVE", () => {
    // An in-window row's residency is governed by the rolling window. Stamping
    // one is inert today and a landmine the moment the eviction query widens.
    const row = hotRow({
      ts: d("2025-06-02"),
      tier: "WINDOW",
      hotLoadedAt: null,
    });
    assert.deepEqual(
      barsNeedingHotLoadStamp({ hot: [row], served: [row], now: NOW }),
      [],
    );
  });

  it("SKIPS an unrecognised tier — an unknown value fails CLOSED", () => {
    const row = hotRow({ ts: d("2015-06-01"), tier: "ARCHIVED" });
    assert.deepEqual(
      barsNeedingHotLoadStamp({ hot: [row], served: [row], now: NOW }),
      [],
    );
    assert.equal(isLoadedTier("ARCHIVED"), false);
    assert.equal(isLoadedTier(undefined), false);
    assert.equal(isLoadedTier("LOADED"), true);
  });

  it("SKIPS the OTHER occupant of a recycled ticker", () => {
    // Same rule and same reason as `promotableColdBars` filter 1: refreshing a
    // listing nobody asked for keeps it in Mongo for ever on the strength of
    // reads of a different company.
    const wanted = hotRow({ ts: d("2015-06-01") });
    const other = hotRow({
      ts: d("2015-06-02"),
      listingId: "DOW:NYSE:1972-06-01",
    });
    assert.deepEqual(
      barsNeedingHotLoadStamp({
        hot: [wanted, other],
        served: [wanted],
        now: NOW,
      }).map((b) => b.listingId),
      ["DOW:NYSE:2019-03-20"],
    );
  });

  it("dedupes by natural key and returns ascending", () => {
    const later = hotRow({ ts: d("2015-06-03") });
    const earlier = hotRow({ ts: d("2015-06-01") });
    const picked = barsNeedingHotLoadStamp({
      hot: [later, earlier, { ...later }],
      served: [later, earlier],
      now: NOW,
    });
    assert.deepEqual(
      picked.map((b) => b.ts.toISOString()),
      ["2015-06-01T00:00:00.000Z", "2015-06-03T00:00:00.000Z"],
    );
  });

  it("maxAgeMs 0 refreshes unconditionally", () => {
    const row = hotRow({ ts: d("2015-06-01"), hotLoadedAt: NOW });
    assert.equal(
      barsNeedingHotLoadStamp({
        hot: [row],
        served: [row],
        now: NOW,
        maxAgeMs: 0,
      }).length,
      1,
    );
  });

  it("a non-finite maxAgeMs falls back to the default rather than to 0", () => {
    // `NaN` reaching the comparison would make `nowMs - t < NaN` false for
    // everything, i.e. refresh on EVERY read — a silent removal of the write
    // budget rather than an error.
    const row = hotRow({ ts: d("2015-06-01"), hotLoadedAt: ago(60_000) });
    assert.deepEqual(
      barsNeedingHotLoadStamp({
        hot: [row],
        served: [row],
        now: NOW,
        maxAgeMs: Number.NaN,
      }),
      [],
    );
  });

  it("returns nothing when the read served nothing", () => {
    const row = hotRow({ ts: d("2015-06-01") });
    assert.deepEqual(
      barsNeedingHotLoadStamp({ hot: [row], served: [], now: NOW }),
      [],
    );
  });
});

describe("the stamp budget stays FAR inside the deleter's TTL", () => {
  it("is at least 10x smaller than HOT_LOAD_TTL_DAYS, read from the deleter", () => {
    // `HOT_LOAD_TTL_DAYS` is declared in the WORKER and its own doc forbids the
    // stamping side from importing it ("a writer that knew the TTL would be
    // free to disagree with the deleter about it"). So the relation is checked
    // from the outside, against the real declaration rather than a remembered
    // number — a check whose ceiling is not verified proves nothing.
    const match = /export const HOT_LOAD_TTL_DAYS = (\d+);/.exec(EVICT_LOGIC);
    assert.ok(match, "HOT_LOAD_TTL_DAYS is no longer declared as a literal");
    const ttlMs = Number(match[1]) * DAY_MS;
    assert.ok(ttlMs > 0, `parsed a nonsensical TTL from ${match[0]}`);
    assert.ok(
      HOT_LOAD_STAMP_MAX_AGE_MS * 10 <= ttlMs,
      `a ${HOT_LOAD_STAMP_MAX_AGE_MS}ms refresh budget against a ${ttlMs}ms ` +
        "TTL leaves too little margin: a continuously-read series could age " +
        "out between two refreshes",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   toHotLoadWriteRows — the ONE legitimate tier override
   ──────────────────────────────────────────────────────────────────────── */

describe("toHotLoadWriteRows", () => {
  it("carries tier LOADED and preserves the bar's own source", () => {
    const rows = toHotLoadWriteRows([
      bar({ ts: d("2015-06-01"), source: "TIINGO" }),
    ]);
    assert.equal(rows[0]!.tier, "LOADED");
    assert.equal(rows[0]!.source, "TIINGO");
  });

  it("routes to HOT_LOADED even though the year and the status BOTH say cold", () => {
    // The end-to-end reason the override exists: a 2015 bar of a delisted
    // listing fails both data tests, and what makes it hot is a fact outside
    // the row entirely — somebody asked for it.
    const rows = toHotLoadWriteRows([bar({ ts: d("2015-06-01") })]);
    const sanitized = sanitizeCandleWrites(rows);
    const routed = partitionCandlesByDestination(
      sanitized.rows,
      d("2026-08-28"),
    );
    assert.equal(routed.hotLoaded.length, 1);
    assert.equal(routed.cold.length, 0);
    assert.equal(routed.hotWindow.length, 0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   THE TRAP — its cause, then its fix
   ──────────────────────────────────────────────────────────────────────── */

function normalized(
  over: Partial<NormalizedCandleWrite> = {},
): NormalizedCandleWrite {
  return {
    symbol: "DOW",
    exchange: "NYSE",
    timeframe: "D1",
    ts: d("2015-06-01"),
    listingId: "DOW:NYSE:2019-03-20",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: BigInt(1_000),
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    listingStatus: "ACTIVE",
    tier: "LOADED",
    ...over,
  };
}

describe("THE TRAP: putCandles alone can never refresh hotLoadedAt", () => {
  it("a repeat write-back at an EQUAL source takes the PRESERVE path", () => {
    // This is the cause, asserted rather than assumed. `partitionCandleWrites`
    // is right to preserve — equal authority must not overwrite, or a re-run
    // stops being idempotent and a historical replay clobbers the nightly's
    // copy of the same bar. It is simply the wrong mechanism for a timestamp
    // that records WHEN SOMEBODY LAST READ the row.
    const row = normalized();
    const existing = new Map([
      [candleKey(row), { id: "abc123", source: "TIINGO" }],
    ]);

    const partition = partitionCandleWrites([row], existing);

    assert.equal(partition.preserved, 1, "the row must be preserved");
    assert.equal(partition.create.length, 0, "no create -> no hotLoadedAt");
    assert.equal(partition.upgrade.length, 0, "no upgrade -> no $set");
  });

  it("...and at a STRONGER incumbent source too", () => {
    const row = normalized({ source: "YAHOO" });
    const existing = new Map([
      [candleKey(row), { id: "abc123", source: "TIINGO" }],
    ]);
    assert.equal(partitionCandleWrites([row], existing).preserved, 1);
  });

  it("only a FIRST write reaches the create path that stamps it", () => {
    const row = normalized();
    const partition = partitionCandleWrites([row], new Map());
    assert.equal(partition.create.length, 1);
    assert.equal(partition.preserved, 0);
  });
});

describe("THE FIX: buildHotLoadStampUpdates", () => {
  it("writes hotLoadedAt and NOTHING else", () => {
    // The moment `data` also carried a price or a `source`, this write would
    // need a precedence decision and the trap would be back by another door.
    const now = d("2026-08-28");
    const [update] = buildHotLoadStampUpdates(
      [bar({ ts: d("2015-06-01") })],
      now,
    );
    assert.ok(update);
    assert.deepEqual(Object.keys(update.data), ["hotLoadedAt"]);
    assert.equal(update.data.hotLoadedAt.getTime(), now.getTime());
  });

  it("matches tier POSITIVELY and never tests hotLoadedAt for null", () => {
    // A Mongo `db push` creates indexes and not fields, so on rows predating
    // the column the attribute is ABSENT and BOTH `{null}` and `{not: null}`
    // return zero (MONEY-1050 / 1205 / 1234 / 1235).
    const [update] = buildHotLoadStampUpdates(
      [bar({ ts: d("2015-06-01") })],
      d("2026-08-28"),
    );
    assert.ok(update);
    assert.equal(update.where.tier, "LOADED");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(update.where, "hotLoadedAt"),
      "the WHERE must not mention hotLoadedAt at all",
    );
  });

  it("the positive tier predicate is what protects a WINDOW row", () => {
    // Stated as the property rather than the field: a stamp that could match a
    // WINDOW row would move an in-window bar into the 30-day eviction lane.
    const updates = buildHotLoadStampUpdates(
      [bar({ ts: d("2015-06-01") }), bar({ ts: d("2015-06-02") })],
      d("2026-08-28"),
    );
    for (const u of updates) {
      assert.equal(u.where.tier, "LOADED");
    }
  });

  it("targets EXACT timestamps, never a range", () => {
    // A ts RANGE would sweep up rows the read never touched — including hot
    // WINDOW rows sitting inside the same year — so the `$in` is the guard, not
    // an optimisation.
    const bars = [d("2015-06-01"), d("2015-06-03")].map((ts) => bar({ ts }));
    const [update] = buildHotLoadStampUpdates(bars, d("2026-08-28"));
    assert.ok(update);
    assert.deepEqual(
      update.where.ts.in.map((t) => t.toISOString()),
      ["2015-06-01T00:00:00.000Z", "2015-06-03T00:00:00.000Z"],
    );
  });

  it("splits SERIES apart — one update never spans two of them", () => {
    const bars = [
      bar({ ts: d("2015-06-01"), symbol: "DOW" }),
      bar({ ts: d("2015-06-01"), symbol: "AAPL", exchange: "NASDAQ" }),
    ];
    const updates = buildHotLoadStampUpdates(bars, d("2026-08-28"));
    assert.equal(updates.length, 2);
    assert.deepEqual(
      updates.map((u) => `${u.where.symbol}/${u.where.exchange}`).sort(),
      ["AAPL/NASDAQ", "DOW/NYSE"],
    );
  });

  it("CHUNKS a long series so one `$in` stays bounded", () => {
    const bars = Array.from({ length: 1_100 }, (_, i) =>
      bar({ ts: new Date(Date.UTC(2015, 0, 1) + i * 86_400_000) }),
    );
    const updates = buildHotLoadStampUpdates(bars, d("2026-08-28"));
    assert.equal(updates.length, Math.ceil(1_100 / HOT_LOAD_STAMP_CHUNK));
    for (const u of updates) {
      assert.ok(u.where.ts.in.length <= HOT_LOAD_STAMP_CHUNK);
    }
    assert.equal(
      updates.reduce((n, u) => n + u.where.ts.in.length, 0),
      1_100,
      "no timestamp may be dropped by the chunking",
    );
  });

  it("returns nothing for an empty promotion", () => {
    assert.deepEqual(buildHotLoadStampUpdates([], d("2026-08-28")), []);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The ledger inputs
   ──────────────────────────────────────────────────────────────────────── */

describe("hotLoadedYearsForBars", () => {
  it("is distinct and ascending", () => {
    assert.deepEqual(
      hotLoadedYearsForBars([
        bar({ ts: d("2016-01-04") }),
        bar({ ts: d("2015-06-01") }),
        bar({ ts: d("2015-12-31") }),
      ]),
      [2015, 2016],
    );
  });

  it("uses the UTC year, so 31 December lands in ONE year", () => {
    // A boundary computed in a different calendar than the rows it partitions
    // puts 31 December on both sides of itself.
    assert.deepEqual(
      hotLoadedYearsForBars([bar({ ts: new Date("2015-12-31T23:59:59Z") })]),
      [2015],
    );
  });

  it("DROPS an unparseable ts rather than writing NaN into an Int[]", () => {
    assert.deepEqual(
      hotLoadedYearsForBars([
        bar({ ts: new Date("not-a-date") }),
        bar({ ts: d("2015-06-01") }),
      ]),
      [2015],
    );
  });
});

describe("groupTimestampsBySeries", () => {
  it("keeps two series with a SPACE-ambiguous identity apart", () => {
    // `NYSE ARCA` is a real exchange name and it contains a space, so a
    // printable delimiter makes two different tuples collide onto one group —
    // exactly what `candleKey` uses NUL to prevent.
    const groups = groupTimestampsBySeries([
      bar({
        ts: d("2015-06-01"),
        symbol: "X",
        exchange: "NYSE ARCA",
        timeframe: "D1",
      }),
      bar({
        ts: d("2015-06-01"),
        symbol: "X",
        exchange: "NYSE",
        timeframe: "ARCA D1",
      }),
    ]);
    assert.equal(groups.length, 2);
  });

  it("sorts each series' timestamps ascending", () => {
    const groups = groupTimestampsBySeries([
      bar({ ts: d("2015-06-03") }),
      bar({ ts: d("2015-06-01") }),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0]!.timestamps.map((t) => t.toISOString()),
      ["2015-06-01T00:00:00.000Z", "2015-06-03T00:00:00.000Z"],
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   EXECUTING the repository — a recording fake driver in place of Prisma
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A minimal Mongo, honest about the two things this suite turns on.
 *
 *   - It HONOURS `select`. A fake that returns whole documents would let
 *     `readHot` drop `tier` / `hotLoadedAt` from its projection and every test
 *     below would still pass — the exact shadow that makes a suite agree with
 *     broken source.
 *   - It applies `updateMany` for real, so `hotLoadedAt` on a row is whatever
 *     the production code actually wrote, and a stamp that never moves is
 *     visible as a stamp that never moves.
 *
 * `gate` is an optional promise every write awaits, which is how the
 * concurrency and deadline cases are made deterministic instead of racy.
 */
interface FakeRow {
  id: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  ts: Date;
  listingId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  divCash: number;
  splitFactor: number;
  source: string;
  tier: string;
  hotLoadedAt: Date | null;
}

interface RawUpdateCommand {
  update: string;
  updates: Array<{
    q: Record<string, unknown>;
    u: Record<string, Record<string, unknown>>;
    multi?: boolean;
    upsert?: boolean;
  }>;
  ordered?: boolean;
}

type SelectMap = Record<string, boolean>;

function project(row: FakeRow, select: SelectMap | undefined): FakeRow {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) out[field] = (row as unknown as Record<string, unknown>)[field];
  }
  return out as unknown as FakeRow;
}

interface FlatWhere {
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  listingId?: string;
  ts?: { gte?: Date; lte?: Date; in?: Date[] };
  tier?: string;
  OR?: FlatWhere[];
}

function matches(row: FakeRow, where: FlatWhere): boolean {
  if (where.OR) return where.OR.some((branch) => matches(row, branch));
  if (where.symbol !== undefined && row.symbol !== where.symbol) return false;
  if (where.exchange !== undefined && row.exchange !== where.exchange) {
    return false;
  }
  if (where.timeframe !== undefined && row.timeframe !== where.timeframe) {
    return false;
  }
  if (where.listingId !== undefined && row.listingId !== where.listingId) {
    return false;
  }
  if (where.tier !== undefined && row.tier !== where.tier) return false;
  const ts = where.ts;
  if (ts) {
    const t = row.ts.getTime();
    if (ts.gte !== undefined && t < ts.gte.getTime()) return false;
    if (ts.lte !== undefined && t > ts.lte.getTime()) return false;
    if (ts.in !== undefined && !ts.in.some((x) => x.getTime() === t)) {
      return false;
    }
  }
  return true;
}

class FakeDb {
  rows: FakeRow[] = [];
  listings: Array<{ listingId: string }> = [];
  /** Every driver call, in order. The order assertions read this. */
  readonly calls: Array<{ op: string; arg: unknown }> = [];
  /** Every raw command, decoded, for the ledger assertions. */
  readonly rawCommands: RawUpdateCommand[] = [];
  /** When set, EVERY write awaits it first. */
  gate: Promise<void> | null = null;
  /** Ops that should throw instead of running. */
  readonly failing = new Set<string>();

  private seq = 0;
  private restore: Array<() => void> = [];

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  writes(): string[] {
    return this.ops().filter(
      (op) => op !== "candle.findMany" && op !== "usInstrument.findMany",
    );
  }

  private async enterWrite(op: string): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failing.has(op)) throw new Error(`fake driver: ${op} refused`);
  }

  install(): void {
    const candle = prisma.candle as unknown as Record<string, unknown>;
    const usInstrument = prisma.usInstrument as unknown as Record<
      string,
      unknown
    >;
    const client = prisma as unknown as Record<string, unknown>;
    const save = (target: Record<string, unknown>, key: string): void => {
      const original = target[key];
      this.restore.push(() => {
        target[key] = original;
      });
    };
    for (const key of [
      "findMany",
      "createMany",
      "updateMany",
      "create",
      "update",
    ]) {
      save(candle, key);
    }
    save(usInstrument, "findMany");
    save(client, "$runCommandRaw");

    candle.findMany = async (arg: {
      where: FlatWhere;
      select?: SelectMap;
      orderBy?: { ts: "asc" | "desc" };
    }): Promise<FakeRow[]> => {
      this.calls.push({ op: "candle.findMany", arg });
      const hit = this.rows
        .filter((row) => matches(row, arg.where))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
      return hit.map((row) => project(row, arg.select));
    };

    candle.createMany = async (arg: {
      data: Array<Record<string, unknown>>;
    }): Promise<{ count: number }> => {
      this.calls.push({ op: "candle.createMany", arg });
      await this.enterWrite("candle.createMany");
      for (const row of arg.data) {
        const data = row as unknown as Omit<FakeRow, "id">;
        // `hotLoadedAt` is OMITTED (absent), never written as null, on a
        // non-LOADED create — the Mongo distinction the whole eviction query
        // turns on. `?? null` is this fake's stand-in for "the attribute is not
        // there", which is what Prisma would read back.
        this.rows.push({
          id: `row-${++this.seq}`,
          ...data,
          hotLoadedAt: data.hotLoadedAt ?? null,
        });
      }
      return { count: arg.data.length };
    };

    candle.updateMany = async (arg: {
      where: FlatWhere;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> => {
      this.calls.push({ op: "candle.updateMany", arg });
      await this.enterWrite("candle.updateMany");
      let count = 0;
      for (const row of this.rows) {
        if (!matches(row, arg.where)) continue;
        Object.assign(row, arg.data);
        count++;
      }
      return { count };
    };

    candle.create = async (arg: {
      data: Record<string, unknown>;
    }): Promise<FakeRow> => {
      this.calls.push({ op: "candle.create", arg });
      await this.enterWrite("candle.create");
      const data = arg.data as unknown as Omit<FakeRow, "id">;
      const row: FakeRow = {
        id: `row-${++this.seq}`,
        ...data,
        hotLoadedAt: data.hotLoadedAt ?? null,
      };
      this.rows.push(row);
      return row;
    };

    candle.update = async (arg: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<FakeRow> => {
      this.calls.push({ op: "candle.update", arg });
      await this.enterWrite("candle.update");
      const row = this.rows.find((r) => r.id === arg.where.id);
      if (!row) throw new Error("fake driver: P2025");
      Object.assign(row, arg.data);
      return row;
    };

    usInstrument.findMany = async (): Promise<Array<{ listingId: string }>> => {
      this.calls.push({ op: "usInstrument.findMany", arg: null });
      return this.listings;
    };

    client.$runCommandRaw = async (
      cmd: RawUpdateCommand,
    ): Promise<{ nModified: number }> => {
      const op = `raw:${cmd.update}`;
      this.calls.push({ op, arg: cmd });
      this.rawCommands.push(cmd);
      await this.enterWrite(op);
      let nModified = 0;
      if (cmd.update === "candles") {
        for (const u of cmd.updates) {
          const oid = (u.q._id as { $oid?: string } | undefined)?.$oid;
          const row = this.rows.find((r) => r.id === oid);
          if (!row) continue;
          Object.assign(row, u.u.$set ?? {});
          nModified++;
        }
      }
      return { nModified };
    };
  }

  uninstall(): void {
    for (const undo of this.restore.reverse()) undo();
    this.restore = [];
  }
}

/** A promise a test can release by hand. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Give the microtask queue enough turns for a started IIFE to reach its gate. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** `us_instruments` never answers a candle query, so it gets its own row shape. */
function storedRow(over: Partial<FakeRow> & { ts: Date }): FakeRow {
  const base = bar({ ts: over.ts });
  return {
    id: `seed-${over.ts.getTime()}`,
    symbol: base.symbol,
    exchange: base.exchange,
    timeframe: base.timeframe,
    listingId: base.listingId,
    open: base.open,
    high: base.high,
    low: base.low,
    close: base.close,
    // `Candle.volume` is a Mongo `long`; Prisma hands a `bigint` back and
    // `readHot` narrows it at the store boundary. The fake has to hold the
    // wide type or that conversion is never exercised.
    volume: BigInt(base.volume),
    divCash: base.divCash,
    splitFactor: base.splitFactor,
    source: base.source,
    tier: "LOADED",
    hotLoadedAt: null,
    ...over,
    ts: over.ts,
  };
}

/**
 * One symbol per test.
 *
 * The cold read goes through `cachedWithStaleFallback`, whose entries outlive a
 * single test in-process. Two tests sharing a symbol would share a cached
 * shard, so the second one's "cold hit" could be the first one's answer — a
 * fixture cancelling the thing it was meant to set up.
 */
let symbolCounter = 0;
function nextSymbol(): string {
  return `HOTLOAD${++symbolCounter}`;
}

interface Harness {
  db: FakeDb;
  repo: CandleRepository;
  symbol: string;
  listingId: string;
  /** Bars the fake GCS shard holds for 2015. */
  coldBars: CandleBar[];
  read: (over?: Record<string, unknown>) => Promise<CandleReadMeta>;
  setClock: (at: Date) => void;
}

const activeHarnesses: Harness[] = [];

function harness(
  options: {
    exchange?: string;
    cold?: boolean;
    seedRows?: (h: { symbol: string; listingId: string }) => FakeRow[];
    listings?: (h: { listingId: string }) => Array<{ listingId: string }>;
    deadlineMs?: number;
    now?: Date;
    /** Override the listingId ON THE BARS. `""` is how a row carries none. */
    barListingId?: string;
  } = {},
): Harness {
  const symbol = nextSymbol();
  const exchange = options.exchange ?? "NYSE";
  const listingId = `${symbol}:${exchange}:2019-03-20`;
  const barListingId = options.barListingId ?? listingId;
  const coldBars: CandleBar[] = [
    bar({ ts: d("2015-06-01"), symbol, exchange, listingId: barListingId }),
    bar({ ts: d("2015-06-02"), symbol, exchange, listingId: barListingId }),
  ];

  const db = new FakeDb();
  db.rows = options.seedRows?.({ symbol, listingId }) ?? [];
  db.listings = options.listings
    ? options.listings({ listingId })
    : [{ listingId }];
  db.install();

  if (options.cold !== false) {
    const store: CandleColdStore = {
      async get(key: string): Promise<Buffer | null> {
        return key.endsWith("/2015") ? encodeColdShard(coldBars) : null;
      },
      async put(): Promise<void> {},
    };
    setCandleColdStore(store);
  } else {
    setCandleColdStore(null);
  }

  let clock = options.now ?? d("2026-08-28");
  const repo = new CandleRepository({
    now: () => clock,
    ...(options.deadlineMs !== undefined
      ? { hotLoadDeadlineMs: options.deadlineMs }
      : {}),
  });

  const h: Harness = {
    db,
    repo,
    symbol,
    listingId,
    coldBars,
    setClock: (at: Date): void => {
      clock = at;
    },
    read: async (over = {}): Promise<CandleReadMeta> => {
      const res = await repo.getCandles({
        symbol,
        exchange,
        timeframe: "D1",
        from: d("2015-01-01"),
        to: d("2015-12-31"),
        ...over,
      });
      return res.meta;
    },
  };
  activeHarnesses.push(h);
  return h;
}

afterEach(async () => {
  // Drain BEFORE restoring the driver: a write-back the deadline stopped
  // waiting for is still running, and a test that left one behind must not be
  // able to hand the next test an orphaned handle — or a Prisma call against a
  // restored real client.
  for (const h of activeHarnesses.splice(0)) {
    await h.repo.settleHotLoads();
    h.db.uninstall();
  }
  setCandleColdStore(null);
});

describe("REGRESSION: a repeat read refreshes hotLoadedAt", () => {
  it("read 1 promotes and stamps; read 2 a day later stamps WITHOUT promoting", async () => {
    // THE DEFECT, measured against the real functions before the fix: read 1
    // promoted 2 bars and issued 1 stamp update; reads 2 and 3 issued ZERO
    // driver calls of any kind, because `promotableColdBars` correctly excludes
    // the keys Mongo now holds and the whole write-back hung off its length.
    const h = harness();

    const first = await h.read();
    await h.repo.settleHotLoads();
    assert.equal(first.hotLoadBars, 2, "read 1 promotes both cold bars");
    assert.equal(first.hotLoadOutcome, "applied");
    assert.deepEqual(h.db.writes(), [
      "candle.createMany",
      "candle.updateMany",
      "raw:us_instruments",
    ]);
    const firstStamps = h.db.rows.map((r) => r.hotLoadedAt?.toISOString());
    assert.deepEqual(firstStamps, [
      "2026-08-28T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
    ]);

    h.db.calls.length = 0;
    h.setClock(d("2026-08-31"));
    const second = await h.read();
    await h.repo.settleHotLoads();

    assert.equal(second.hotLoadBars, 0, "nothing left to promote — correct");
    assert.equal(
      second.hotLoadStampBars,
      2,
      "...and the stamp half must still find both rows",
    );
    assert.equal(second.hotLoadRestamped, 2);
    assert.equal(second.hotLoadOutcome, "applied");
    assert.deepEqual(
      h.db.writes(),
      ["candle.updateMany", "raw:us_instruments"],
      "the second read must WRITE; before the fix it issued nothing",
    );
    assert.deepEqual(
      h.db.rows.map((r) => r.hotLoadedAt?.toISOString()),
      ["2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
      "the stamp must have MOVED — this is the 30-day sawtooth, gone",
    );
  });

  it("a read inside the budget does nothing at all", async () => {
    const h = harness();
    await h.read();
    await h.repo.settleHotLoads();

    h.db.calls.length = 0;
    h.setClock(new Date(d("2026-08-28").getTime() + 60_000));
    const meta = await h.read();
    await h.repo.settleHotLoads();

    assert.equal(meta.hotLoadOutcome, "idle");
    assert.equal(meta.hotLoadStampBars, 0);
    assert.equal(meta.hotLoadRestamped, null);
    assert.deepEqual(h.db.writes(), [], "a warm read must cost NO writes");
  });

  it("the stamp keeps moving forever — three consecutive daily reads", async () => {
    // The property the sawtooth violated, stated over time rather than once.
    const h = harness();
    const days = ["2026-08-28", "2026-08-30", "2026-09-01", "2026-09-03"];
    const stamps: string[] = [];
    for (const day of days) {
      h.setClock(d(day));
      await h.read();
      await h.repo.settleHotLoads();
      stamps.push(h.db.rows[0]!.hotLoadedAt?.toISOString() ?? "null");
    }
    assert.deepEqual(
      stamps,
      days.map((day) => `${day}T00:00:00.000Z`),
      "every read must leave its own timestamp behind",
    );
  });

  it("readHot PROJECTS tier and hotLoadedAt — without them the refresh is blind", async () => {
    // Asserted against the driver's own argument rather than the source, and it
    // is load-bearing: the fake honours `select`, so dropping either column
    // from the projection makes the regression test above fail rather than
    // silently pass.
    const h = harness();
    await h.read();
    await h.repo.settleHotLoads();
    const hotRead = h.db.calls.find((c) => c.op === "candle.findMany");
    assert.ok(hotRead, "readHot issued no query");
    const select = (hotRead.arg as { select: SelectMap }).select;
    assert.equal(select.tier, true);
    assert.equal(select.hotLoadedAt, true);
  });
});

describe("the write-back's three steps, executed", () => {
  it("runs putCandles, THEN the stamp, THEN the ledger", async () => {
    // The ledger claims a year is hot. It must be LAST, so a failed write
    // short-circuits before the claim is made.
    const h = harness();
    await h.read();
    await h.repo.settleHotLoads();
    assert.deepEqual(h.db.writes(), [
      "candle.createMany",
      "candle.updateMany",
      "raw:us_instruments",
    ]);
  });

  it("the stamp names hotLoadedAt and NOTHING precedence ranks", async () => {
    const h = harness();
    await h.read();
    await h.repo.settleHotLoads();
    const stamp = h.db.calls.find((c) => c.op === "candle.updateMany");
    assert.ok(stamp, "no stamp was issued");
    const arg = stamp.arg as {
      where: FlatWhere;
      data: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(arg.data), ["hotLoadedAt"]);
    assert.ok(
      arg.data.hotLoadedAt instanceof Date,
      "the Prisma path takes a real Date — the column's type comes from the schema",
    );
    assert.equal(arg.where.tier, "LOADED", "POSITIVE tier match");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(arg.where, "hotLoadedAt"),
      "a null/not-null test on an absent Mongo attribute matches ZERO rows",
    );
  });

  it("the ledger is $addToSet, Extended-JSON dated, multi:false and never upserts", async () => {
    const h = harness();
    await h.read();
    await h.repo.settleHotLoads();
    const ledger = h.db.rawCommands.find((c) => c.update === "us_instruments");
    assert.ok(ledger, "the ledger command never ran");
    const one = ledger.updates[0];
    assert.ok(one, "the ledger command carried no update");
    assert.deepEqual(one.q, { listingId: h.listingId });
    assert.deepEqual(one.u.$addToSet, { hotLoadedYears: { $each: [2015] } });
    const lastHotLoadAt = (one.u.$set as { lastHotLoadAt: { $date: unknown } })
      .lastHotLoadAt;
    assert.equal(
      typeof lastHotLoadAt.$date,
      "string",
      "a bare Date on the raw path lands in a DateTime? column as TEXT, which " +
        "the eviction's { lt: cutoff } can never match",
    );
    assert.equal(lastHotLoadAt.$date, "2026-08-28T00:00:00.000Z");
    assert.equal(one.multi, false);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(one, "upsert"),
      "a listing with no us_instruments row is a master-sync gap, not a row to invent",
    );
  });

  it("promoted rows are created as LOADED and carry a stamp from the create itself", async () => {
    const h = harness();
    await h.read();
    await h.repo.settleHotLoads();
    assert.equal(h.db.rows.length, 2);
    for (const row of h.db.rows) {
      assert.equal(row.tier, "LOADED");
      assert.ok(row.hotLoadedAt instanceof Date);
    }
  });

  it("a null listingId skips the LEDGER without skipping the ROWS", async () => {
    // `Candle.tier`/`hotLoadedAt` are the authoritative per-row fact; the table
    // is the summary. Inventing a listing key to have something to write would
    // be worse than writing nothing.
    //
    // Reaching this state takes BOTH halves, and the first attempt at this test
    // got it wrong: emptying `us_instruments` is not enough, because
    // `selectSingleListing` then INFERS the id from the bars themselves and the
    // ledger runs after all. The bars have to carry no listing either.
    const h = harness({ listings: () => [], barListingId: "" });
    const meta = await h.read();
    await h.repo.settleHotLoads();
    assert.equal(meta.hotLoadBars, 2);
    assert.equal(h.db.rows.length, 2, "the bars are still promoted");
    assert.equal(
      h.db.rawCommands.filter((c) => c.update === "us_instruments").length,
      0,
      "no ledger row to stamp",
    );
  });
});

describe("SELF-HEAL: what a truncated write-back leaves behind", () => {
  it("rows written with no ledger entry are completed by the NEXT read", async () => {
    // The named failure mode of the inline lane's deadline and of a serverless
    // suspension: step 1 landed, steps 2 and 3 did not. That prefix used to be
    // PERMANENT — with nothing left to promote, the write-back never ran again.
    // It is now the input to the restamp path.
    const h = harness({
      seedRows: ({ symbol, listingId }) => [
        storedRow({
          ts: d("2015-06-01"),
          symbol,
          listingId,
          hotLoadedAt: d("2026-07-01"),
        }),
        storedRow({
          ts: d("2015-06-02"),
          symbol,
          listingId,
          hotLoadedAt: d("2026-07-01"),
        }),
      ],
    });

    const meta = await h.read();
    await h.repo.settleHotLoads();

    assert.equal(
      meta.hotLoadBars,
      0,
      "nothing to promote — they are all there",
    );
    assert.equal(meta.hotLoadStampBars, 2);
    assert.equal(meta.hotLoadRestamped, 2);
    assert.deepEqual(h.db.writes(), [
      "candle.updateMany",
      "raw:us_instruments",
    ]);
    const ledger = h.db.rawCommands.find((c) => c.update === "us_instruments");
    assert.ok(ledger, "the ledger the truncated attempt never wrote");
    assert.deepEqual(ledger.updates[0]?.u.$addToSet, {
      hotLoadedYears: { $each: [2015] },
    });
    assert.deepEqual(
      h.db.rows.map((r) => r.hotLoadedAt?.toISOString()),
      ["2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z"],
    );
  });

  it("a LOADED row with NO stamp at all is repaired rather than left immortal", async () => {
    const h = harness({
      seedRows: ({ symbol, listingId }) => [
        storedRow({
          ts: d("2015-06-01"),
          symbol,
          listingId,
          hotLoadedAt: null,
        }),
      ],
    });
    await h.read();
    await h.repo.settleHotLoads();
    assert.equal(
      h.db.rows[0]!.hotLoadedAt?.toISOString(),
      "2026-08-28T00:00:00.000Z",
    );
  });

  it("a WINDOW row inside the same series is NEVER stamped", async () => {
    // The corruption the positive tier predicate exists to prevent, exercised
    // end to end: an in-window row must not be moved into the 30-day lane by a
    // read that happened to span it.
    const h = harness({
      cold: false,
      seedRows: ({ symbol, listingId }) => [
        storedRow({
          ts: d("2015-06-01"),
          symbol,
          listingId,
          tier: "WINDOW",
          hotLoadedAt: null,
        }),
      ],
    });
    const meta = await h.read();
    await h.repo.settleHotLoads();
    assert.equal(meta.hotLoadOutcome, "idle");
    assert.equal(h.db.rows[0]!.hotLoadedAt, null);
    assert.deepEqual(h.db.writes(), []);
  });
});

describe("hotLoadOutcome tells the states apart", () => {
  it("`off` — writeBack:false does not write and says why", async () => {
    const h = harness();
    const meta = await h.read({ writeBack: false });
    await h.repo.settleHotLoads();
    assert.equal(meta.hotLoadOutcome, "off");
    assert.equal(meta.hotLoadBars, 0);
    assert.deepEqual(h.db.writes(), []);
  });

  it("`not-us` — an India read is refused on the EXCHANGE, not on query.market", async () => {
    // `market` overrides the COLD KEY only. Honouring it here would let a
    // caller point the write-back at a market the row's exchange does not
    // belong to, and `us_instruments` is US-only.
    const h = harness({ exchange: "NSE" });
    const meta = await h.read({ market: "US" });
    await h.repo.settleHotLoads();
    assert.equal(meta.hotLoadOutcome, "not-us");
    assert.deepEqual(h.db.writes(), []);
  });

  it("`idle` — a US read with nothing to do is NOT the same answer as the two above", async () => {
    const h = harness({ cold: false });
    const meta = await h.read();
    await h.repo.settleHotLoads();
    assert.equal(meta.hotLoadOutcome, "idle");
    assert.deepEqual(h.db.writes(), []);
  });

  it("`in-flight` — a concurrent read of the same series does not double-write", async () => {
    const gate = deferred();
    const h = harness();
    h.db.gate = gate.promise;

    const started = await h.read({ hotLoadLane: "background" });
    assert.equal(started.hotLoadOutcome, "started");
    assert.equal(started.hotLoadRestamped, null, "not knowable yet");
    await settleMicrotasks();

    const concurrent = await h.read({ hotLoadLane: "background" });
    assert.equal(concurrent.hotLoadOutcome, "in-flight");
    assert.equal(
      concurrent.hotLoadBars,
      2,
      "the count is what this read SELECTED, not what it was allowed to run",
    );

    gate.release();
    await h.repo.settleHotLoads();
    assert.equal(
      h.db.calls.filter((c) => c.op === "candle.createMany").length,
      1,
      "the second reader must not start an identical bulk write",
    );
  });

  it("`failed` — a throwing write is absorbed, logged, and does not break the read", async () => {
    const h = harness();
    h.db.failing.add("candle.updateMany");
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const res = await h.repo.getCandles({
        symbol: h.symbol,
        exchange: "NYSE",
        timeframe: "D1",
        from: d("2015-01-01"),
        to: d("2015-12-31"),
      });
      assert.equal(res.bars.length, 2, "the READ is unaffected");
      assert.equal(res.meta.hotLoadOutcome, "failed");
      assert.equal(res.meta.hotLoadRestamped, null);
    } finally {
      await h.repo.settleHotLoads();
      console.warn = realWarn;
    }
    assert.equal(warnings.length, 1, "a swallowed failure must still be LOUD");
    assert.match(warnings[0]!, /hot-load write-back failed/);
  });

  it("`started` — the background lane returns before the work lands", async () => {
    const gate = deferred();
    const h = harness();
    h.db.gate = gate.promise;
    const meta = await h.read({ hotLoadLane: "background" });
    assert.equal(meta.hotLoadOutcome, "started");
    assert.equal(h.db.rows.length, 0, "nothing has been written yet");
    gate.release();
    await h.repo.settleHotLoads();
    assert.equal(h.db.rows.length, 2, "...and it lands once drained");
  });
});

describe("the inline lane's deadline", () => {
  it("stops WAITING without stopping the work, and orphans nothing", async () => {
    // The MEDIUM decision, made testable. A read must not hang on a wedged
    // Mongo; abandoning the wait must not tear state (the step order makes
    // every prefix repairable) and must not leave a handle behind — the
    // promise stays in `inFlightHotLoads`, so `settleHotLoads` still drains it.
    const gate = deferred();
    const h = harness({ deadlineMs: 5 });
    h.db.gate = gate.promise;

    const meta = await h.read();
    assert.equal(meta.hotLoadOutcome, "deadline");
    assert.equal(
      meta.hotLoadRestamped,
      null,
      "`null` is 'we did not wait to find out', which is not 0",
    );
    assert.equal(
      meta.hotLoadBars,
      2,
      "the plan is still reported — the read selected them",
    );
    assert.equal(h.db.rows.length, 0, "the write has not landed yet");

    gate.release();
    await h.repo.settleHotLoads();
    assert.equal(h.db.rows.length, 2, "the abandoned work still completes");
    assert.deepEqual(h.db.writes(), [
      "candle.createMany",
      "candle.updateMany",
      "raw:us_instruments",
    ]);
  });

  it("the default lane AWAITS, so a serverless caller cannot be truncated by us", async () => {
    // The property the old fire-and-forget could not offer on Vercel, where
    // post-response async work is SUSPENDED and no `after()`/`waitUntil` exists
    // in apps/web to hold it open.
    const h = harness();
    const meta = await h.read();
    assert.equal(meta.hotLoadOutcome, "applied");
    assert.equal(
      h.db.rows.length,
      2,
      "the rows must be in the store BEFORE getCandles resolves",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   SOURCE SCANS — only where there is nothing to execute
   ──────────────────────────────────────────────────────────────────────── */

describe("candle-repository wires the write-back correctly", () => {
  const src = stripComments(REPOSITORY);

  it("the stamp refresh goes through the SHARED builder, not a second query", () => {
    // A second statement of "which rows and which column" is exactly the drift
    // the trap lives in. The builder is unit-tested above; this asserts the
    // production path calls it and hands the result to `updateMany` unchanged.
    const body = region(
      src,
      "private async refreshHotLoadStamps",
      "private async recordHotLoadLedger",
    );
    assert.match(body, /buildHotLoadStampUpdates\(bars, now\)/);
    assert.match(body, /prisma\.candle\.updateMany\(update\)/);
    assert.match(
      body,
      /updated \+= res\.count/,
      "the count must come from the driver's answer, after the call",
    );
  });

  it("refreshHotLoadStamps does NOT route through the precedence writer", () => {
    // THIS SCAN USED TO ASSERT NOTHING. It sliced its region with two bare
    // `indexOf`s, had no length guard, and ran only NEGATIVE assertions — so a
    // missing anchor made the region `""` and `!"".includes(...)` passed. Every
    // absence claim in this file now goes through `region`, which proves the
    // block exists first.
    const body = region(
      src,
      "private async refreshHotLoadStamps",
      "private async recordHotLoadLedger",
    );
    assert.ok(
      body.includes("prisma.candle.updateMany"),
      "the region must be the method body, not an empty slice",
    );
    assert.ok(
      !body.includes("putCandles") && !body.includes("partitionCandleWrites"),
      "the stamp must be independent of price-source precedence",
    );
  });

  it("the write-back body cannot reject, whichever lane it runs in", () => {
    const body = region(
      src,
      "private async runHotLoad(",
      "  private async hotLoad(",
    );
    // An async IIFE with its OWN try/catch/finally, whose promise is stored
    // rather than thrown. A `void p.catch(...)` shape would also have to
    // survive a throwing `finally`; this one has no such edge.
    assert.match(
      body,
      /const work = \(async \(\): Promise<void> => \{/,
      "must be started as a self-contained async IIFE",
    );
    assert.match(body, /catch \(error\)/, "must absorb its own error");
    assert.match(body, /finally \{/, "must always release its in-flight slot");
    assert.match(
      body,
      /this\.inFlightHotLoads\.set\(key, work\)/,
      "the promise must be retained so settleHotLoads() can await it",
    );
    const register = body.indexOf("this.inFlightHotLoads.set(key, work)");
    const lane = body.indexOf('args.lane === "background"');
    assert.ok(register >= 0 && lane >= 0, "both landmarks present");
    assert.ok(
      register < lane,
      "BOTH lanes must be registered before either returns, or the inline " +
        "lane's deadline would abandon an untracked promise",
    );
  });

  it("the India guard is POSITIVE, reads the EXCHANGE, and is stated ONCE", () => {
    const plan = region(
      src,
      "private planHotLoad(",
      "private async runHotLoad(",
    );
    assert.match(plan, /marketForExchange\(args\.exchange\) !== "US"/);
    assert.ok(
      !plan.includes("query.market"),
      "the guard must not be spoofable through the market override",
    );
    // Stated once: the runner must have no market opinion of its own to drift
    // from this one.
    const run = region(
      src,
      "private async runHotLoad(",
      "  private async hotLoad(",
    );
    assert.ok(
      !run.includes("marketForExchange"),
      "a second market test in the runner is a second rule free to disagree",
    );
  });

  it("NO bare Date survives inside a $runCommandRaw $set", () => {
    // The live defect this scan was written for: Prisma's raw path takes
    // `InputJsonValue`, whose `{ toJSON(): unknown }` arm ACCEPTS a `Date` and
    // then serialises it through JSON.stringify — so `hotLoadedAt: now`
    // compiles, runs, reports nModified, and stores a STRING in a `DateTime?`
    // column that the eviction's `{ lt: cutoff }` can never match.
    // Scoped to the RAW commands only. The Prisma `update()` / `create()`
    // fallbacks below them pass a bare `Date` correctly — Prisma knows the
    // column's type from the schema — so a whole-file scan would fire on
    // correct code and get deleted rather than fixed.
    const rawBlocks = [...src.matchAll(/\$runCommandRaw\(/g)].map((m) =>
      src.slice(m.index, m.index + 1_500),
    );
    assert.ok(
      rawBlocks.length >= 2,
      `expected the raw command blocks; found ${rawBlocks.length}`,
    );
    for (const block of rawBlocks) {
      assert.ok(
        !/hotLoadedAt: now[,\s}]/.test(block),
        "a bare `hotLoadedAt: now` is still inside a raw command",
      );
      assert.ok(
        !/\$date: now[,\s}]/.test(block),
        "$date takes an ISO string or {$numberLong}, not a Date object",
      );
    }
  });

  it("the deadline's timer is always cleared", () => {
    // A `Promise.race` against a `setTimeout` that is never cleared holds the
    // event loop open on every fast path — the orphan class this repo treats as
    // a failure rather than a nuisance.
    const body = region(
      src,
      "async function raceDeadline(",
      "interface ColdReadResult",
    );
    assert.match(body, /finally \{/);
    assert.match(body, /clearTimeout\(timer\)/);
  });
});
