/**
 * D1 tile logic — MONEY-1467 (A2).
 *
 * Every assertion here targets a failure a running builder does not report:
 *
 *   wrong year split      a bar is filed under the wrong year object. The
 *                         chart is missing one session at a boundary nobody
 *                         looks at, and nothing errors.
 *   adjustment drift      the tile and the live chart disagree about a split.
 *                         Both render perfectly; only a reconciliation months
 *                         later finds it.
 *   a fail-OPEN decode    a tile from a future format parses, produces numbers
 *                         of the right type in the right places, and draws a
 *                         quietly wrong chart.
 *   a short sources array does not fail — it mis-attributes every bar after
 *                         the gap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ADJUSTMENT_POLICY_VERSION,
  FIVE_YEAR_WINDOW,
  TILE_FORMAT_VERSION,
  TileDecodeError,
  UnsafeListingIdError,
  applyAdjustments,
  buildTilesFromBars,
  fingerprintActions,
  mustReadDeepHistory,
  rebuildReason,
  shardOf,
  decodeTile,
  encodeTile,
  canBuildTileKey,
  foldListingIdForKey,
  tileKey5y,
  tileKeyYear,
  tileManifestKey,
  venueYear,
  venueYearStartSec,
  zeroWriteRefusal,
  type SourcedBar,
} from "../../../src/market-data/tiles/tile-logic";
import {
  buildAdjustmentTimeline,
  type AdjustingAction,
} from "../../../src/market-data/price-adjust";
import {
  adjustBarsForBasis,
  toHistoricalBar,
} from "../../../src/market-data/prices/yahoo-price-logic";

const bar = (iso: string, close = 100, source?: string): SourcedBar => ({
  date: new Date(iso),
  open: close,
  high: close,
  low: close,
  close,
  volume: 1_000,
  ...(source ? { source } : {}),
});

describe("the year split happens in the VENUE's clock, never UTC", () => {
  it("a bar at 00:30 IST on 1 January belongs to the NEW year", () => {
    // 2023-12-31T19:00:00Z is 2024-01-01 00:30 IST. UTC says 2023. A UTC split
    // files this bar in the 2023 object, and the 2024 chart is missing its
    // first session — with no error anywhere.
    assert.equal(
      venueYear(Date.parse("2023-12-31T19:00:00Z") / 1000, "IN"),
      2024,
    );
    assert.equal(
      venueYear(Date.parse("2023-12-31T18:29:00Z") / 1000, "IN"),
      2023,
    );
  });

  it("a bar at 23:00 ET on 31 December belongs to the OLD year", () => {
    // The mirror image: 2024-01-01T04:00:00Z is 2023-12-31 23:00 ET. UTC says
    // 2024. The two markets fail in OPPOSITE directions, which is why one
    // hardcoded offset cannot serve both.
    assert.equal(
      venueYear(Date.parse("2024-01-01T04:00:00Z") / 1000, "US"),
      2023,
    );
    assert.equal(
      venueYear(Date.parse("2024-01-01T05:00:00Z") / 1000, "US"),
      2024,
    );
  });

  it("the year START is the venue's midnight, not UTC midnight", () => {
    assert.equal(
      new Date(venueYearStartSec(2024, "IN") * 1000).toISOString(),
      "2023-12-31T18:30:00.000Z",
      "IST is UTC+5:30, so its new year begins at 18:30Z the day before",
    );
    assert.equal(
      new Date(venueYearStartSec(2024, "US") * 1000).toISOString(),
      "2024-01-01T05:00:00.000Z",
      "January is always EST (UTC-5)",
    );
  });

  it("buildTilesFromBars files boundary bars the same way", () => {
    const bars = [
      bar("2022-06-01T10:00:00Z"),
      bar("2023-12-31T18:29:00Z"), // 23:59 IST 31 Dec -> 2023
      bar("2023-12-31T19:00:00Z"), // 00:30 IST  1 Jan -> 2024
      bar("2024-06-01T10:00:00Z"),
    ];
    const built = buildTilesFromBars(bars, new Date("2026-03-01T00:00:00Z"), {
      market: "IN",
      listingId: "RELIANCE:NSE",
    });
    const y2023 = built.years.find((y) => y.year === 2023);
    const y2024 = built.years.find((y) => y.year === 2024);
    assert.equal(y2023?.tile.bars.length, 1, "only the 23:59 IST bar is 2023");
    assert.equal(y2024?.tile.bars.length, 2, "the 00:30 IST bar joins 2024");
    assert.equal(
      y2024?.tile.bars[0]![0],
      Math.floor(Date.parse("2023-12-31T19:00:00Z") / 1000),
      "and it is the FIRST bar of 2024",
    );
  });
});

describe("the 5y window and closed years", () => {
  it("the current year is NEVER a year tile", () => {
    // A year tile is written ONCE. Writing one for a year still accumulating
    // sessions makes it immediately wrong — losing the single property the
    // year tiles exist to have.
    const built = buildTilesFromBars(
      [bar("2026-03-01T10:00:00Z"), bar("2025-03-01T10:00:00Z")],
      new Date("2026-06-01T00:00:00Z"),
      { market: "IN", listingId: "X:NSE" },
    );
    assert.deepEqual(
      built.years.map((y) => y.year),
      [2025],
      "2026 is still open",
    );
    assert.equal(
      built.fiveY.bars.length,
      2,
      "but both bars are in the 5y tile",
    );
  });

  it("the 5y tile holds five CALENDAR years, inclusive of the current one", () => {
    const now = new Date("2026-06-01T00:00:00Z"); // venue year 2026
    const bars = [
      bar("2021-06-01T10:00:00Z"), // 2021 — outside a 2022..2026 window
      bar("2022-01-05T10:00:00Z"), // 2022 — the oldest INSIDE
      bar("2026-05-05T10:00:00Z"),
    ];
    const built = buildTilesFromBars(bars, now, {
      market: "IN",
      listingId: "X:NSE",
    });
    assert.equal(FIVE_YEAR_WINDOW, 5);
    assert.equal(built.fiveY.bars.length, 2, "2021 is outside the window");
    assert.equal(
      built.fiveY.bars[0]![0],
      Math.floor(Date.parse("2022-01-05T10:00:00Z") / 1000),
    );
    // The excluded bar must still reach its YEAR tile — the window trims the
    // 5y object, it does not discard history.
    assert.ok(
      built.years.some((y) => y.year === 2021),
      "2021 still gets a year tile",
    );
  });

  it("an empty listing produces a valid, empty 5y tile rather than throwing", () => {
    const built = buildTilesFromBars([], new Date("2026-06-01T00:00:00Z"), {
      market: "IN",
      listingId: "NEWLY_LISTED:NSE",
    });
    assert.equal(built.fiveY.bars.length, 0);
    assert.equal(built.fiveY.header.first_bar, null);
    assert.equal(built.fiveY.header.last_bar, null);
    assert.deepEqual(built.years, []);
  });
});

describe("provenance travels with the bars", () => {
  it("sources stay parallel to bars, and an unknown source is NAMED", () => {
    const built = buildTilesFromBars(
      [
        bar("2025-01-02T10:00:00Z", 100, "BHAVCOPY"),
        bar("2025-01-03T10:00:00Z", 101, "YAHOO"),
        bar("2025-01-06T10:00:00Z", 102), // no source at all
      ],
      new Date("2026-06-01T00:00:00Z"),
      { market: "IN", listingId: "X:NSE" },
    );
    const tile = built.years.find((y) => y.year === 2025)!.tile;
    assert.equal(tile.sources.length, tile.bars.length);
    // "UNKNOWN", never undefined: a hole in a parallel array shifts every later
    // index if anything ever compacts it, and "we do not know" is a different
    // statement from "Yahoo filled it".
    assert.deepEqual(tile.sources, ["BHAVCOPY", "YAHOO", "UNKNOWN"]);
  });

  it("BHAVCOPY_HIST is NAMED, not UNKNOWN — MONEY-1541", () => {
    // 10.2M of prod's 10.8M daily_prices rows carry it.
    const built = buildTilesFromBars(
      [bar("2025-01-02T10:00:00Z", 100, "BHAVCOPY_HIST")],
      new Date("2026-06-01T00:00:00Z"),
      { market: "IN", listingId: "X:NSE" },
    );
    assert.deepEqual(built.years.find((y) => y.year === 2025)!.tile.sources, [
      "BHAVCOPY_HIST",
    ]);
  });
});

describe("adjustment agrees with the path the live chart already uses", () => {
  it("applyAdjustments is the SAME computation, not a second implementation", () => {
    // A3's acceptance is that a tile and the old path agree on sampled dates.
    // Two implementations of one policy agree until the day they do not, so
    // this asserts identity against the real functions rather than re-deriving
    // the expected numbers by hand.
    const actions: AdjustingAction[] = [
      {
        exDate: new Date("2024-06-01T00:00:00Z"),
        type: "SPLIT",
        ratio: 2,
      } as AdjustingAction,
    ];
    const bars = [
      bar("2024-01-02T10:00:00Z", 200),
      bar("2024-07-02T10:00:00Z", 100),
    ];

    const viaTiles = applyAdjustments(bars, actions);
    const { steps } = buildAdjustmentTimeline(actions);
    // The legacy route's function since MONEY-1382 (route-logic.ts).
    const viaExisting = adjustBarsForBasis(bars, steps);

    assert.deepEqual(
      viaTiles.bars.map((b) => b.close),
      viaExisting.map((b) => b.close),
      "the tile path and the chart path must produce identical closes",
    );
    // And it actually DID something — a no-op would satisfy the line above.
    assert.equal(viaTiles.bars[0]!.close, 100, "the pre-split bar is halved");
    assert.equal(
      viaTiles.bars[1]!.close,
      100,
      "the post-split bar is untouched",
    );
    assert.equal(viaTiles.actionsUsed, 1);
  });

  it("a Yahoo row is divided only by the actions AFTER we fetched it — MONEY-1541", () => {
    // Prod charts read tiles since 2026-09-17, and the builder divided every
    // row by the whole timeline: the MONEY-1382 double adjustment, served.
    // VEGA:BSE's real rows: BSE BONUS 5 ex 2026-04-24; Yahoo's 04-23 session
    // was fetched 04-24 00:46Z, after the ex-date, and already reads 62.45.
    const actions: AdjustingAction[] = [
      {
        exDate: new Date("2026-04-23T18:30:00.000Z"),
        type: "BONUS",
        ratio: 5,
        source: "BSE",
      },
    ];
    const row = (date: string, close: number, source: string, at: string) =>
      toHistoricalBar({
        date: new Date(`${date}T00:00:00.000Z`),
        open: close,
        high: close,
        low: close,
        close,
        volume: 0,
        adjClose: null,
        source,
        createdAt: new Date(at),
      });
    const out = applyAdjustments(
      [
        row("2026-04-16", 312.25, "BHAVCOPY_HIST", "2026-04-17T00:49:03Z"),
        row("2026-04-22", 312.25, "YAHOO", "2026-04-23T00:18:50Z"),
        row("2026-04-23", 62.45, "YAHOO", "2026-04-24T00:46:00Z"),
        row("2026-04-28", 61.95, "BHAVCOPY_HIST", "2026-04-29T00:38:44Z"),
      ],
      actions,
    ).bars.map((b) => Number(b.close.toFixed(2)));
    // The exchange print and the Yahoo row fetched BEFORE the ex-date are raw
    // and divided; the one fetched after it is left alone. It read 12.49.
    assert.deepEqual(out, [62.45, 62.45, 62.45, 61.95]);
  });

  it("no actions returns the same array reference — the 95% case pays nothing", () => {
    const bars = [bar("2025-01-02T10:00:00Z")];
    assert.equal(applyAdjustments(bars, []).bars, bars);
  });
});

describe("keys are safe to build from database values", () => {
  it("the documented shapes", () => {
    assert.equal(
      tileKey5y("IN", "RELIANCE:NSE"),
      "tiles/IN/d1/RELIANCE:NSE/5y.json",
    );
    assert.equal(
      tileKeyYear("IN", "RELIANCE:NSE", 2024),
      "tiles/IN/d1/RELIANCE:NSE/2024.json",
    );
    assert.equal(tileManifestKey("IN"), "tiles/IN/d1/manifest.json");
    // US listing ids carry the listing start, so they hold TWO colons.
    assert.equal(
      tileKey5y("US", "AAPL:NASDAQ:1980-12-12"),
      "tiles/US/d1/AAPL:NASDAQ:1980-12-12/5y.json",
    );
  });

  it("a separator in a listing id is REFUSED, not encoded away", () => {
    // `bucketForPrefix` only inspects the first segment, so a `..` or a `/`
    // here would move the object outside its prefix and nothing downstream
    // would object.
    for (const evil of [
      "../../etc/passwd",
      "A/B:NSE",
      "..",
      "X:NSE/../../y",
      "",
    ]) {
      assert.throws(
        () => tileKey5y("IN", evil),
        UnsafeListingIdError,
        `accepted ${evil}`,
      );
    }
  });

  it("an implausible year is refused", () => {
    assert.throws(() => tileKeyYear("IN", "X:NSE", 12345), RangeError);
  });
});

describe("encode/decode fails CLOSED", () => {
  it("round-trips", () => {
    const built = buildTilesFromBars(
      [bar("2025-01-02T10:00:00Z", 100, "BHAVCOPY")],
      new Date("2026-06-01T00:00:00Z"),
      { market: "IN", listingId: "X:NSE", instrumentId: "abc123" },
    );
    const decoded = decodeTile(encodeTile(built.fiveY));
    assert.deepEqual(decoded.bars, built.fiveY.bars);
    assert.deepEqual(decoded.sources, built.fiveY.sources);
    assert.equal(decoded.header.instrument_id, "abc123");
    assert.equal(
      decoded.header.adjustment_policy_version,
      ADJUSTMENT_POLICY_VERSION,
    );
  });

  it("REFUSES a tile from a format it does not know", () => {
    // The whole reason the version field exists. A future tile would parse as
    // JSON, produce numbers of the right type in the right places, and render
    // a chart that is quietly wrong.
    const future = JSON.stringify({
      header: { v: TILE_FORMAT_VERSION + 1, listing_id: "X:NSE", market: "IN" },
      bars: [[1, 2, 3, 4, 5, 6]],
      sources: ["BHAVCOPY"],
    });
    assert.throws(() => decodeTile(future), TileDecodeError);
  });

  it("REFUSES a sources array that is not parallel to bars", () => {
    const short = JSON.stringify({
      header: { v: TILE_FORMAT_VERSION, listing_id: "X:NSE", market: "IN" },
      bars: [
        [1, 2, 3, 4, 5, 6],
        [2, 3, 4, 5, 6, 7],
      ],
      sources: ["BHAVCOPY"],
    });
    assert.throws(() => decodeTile(short), TileDecodeError);
  });

  it("REFUSES garbage rather than returning an empty tile", () => {
    // Returning `{bars: []}` here would render as "this symbol has no history",
    // which is indistinguishable from a delisted instrument.
    for (const junk of ["", "not json", "[]", '{"bars":[]}', '{"header":{}}']) {
      assert.throws(
        () => decodeTile(junk),
        TileDecodeError,
        `accepted ${JSON.stringify(junk)}`,
      );
    }
  });
});

describe("the rebuild decision names WHY, and defaults to rebuilding", () => {
  const entry = {
    years: [2024],
    five_y_built_at: "2026-09-12T00:00:00.000Z",
    adjustment_policy_version: ADJUSTMENT_POLICY_VERSION,
    tile_format_version: TILE_FORMAT_VERSION,
    source_max_date: "2026-09-11T00:00:00.000Z",
    built_from: "dailyprice" as const,
    yahoo_fill_sessions: 0,
  };
  const now = (iso: string | null) => ({
    sourceMaxDate: iso ? new Date(iso) : null,
    policyVersion: ADJUSTMENT_POLICY_VERSION,
    formatVersion: TILE_FORMAT_VERSION,
  });

  it("skips only when the source has NOT advanced", () => {
    assert.equal(rebuildReason(entry, now("2026-09-11T00:00:00.000Z")), null);
    assert.equal(
      rebuildReason(entry, now("2026-09-12T00:00:00.000Z")),
      "source-advanced",
    );
  });

  it("never built is a REASON, not a skip", () => {
    assert.equal(
      rebuildReason(undefined, now("2026-09-11T00:00:00.000Z")),
      "no-entry",
    );
  });

  // ── MONEY-1506: the PRODUCER moved ───────────────────────────────────────
  //
  // B4 switches the US bars from `CandleRepository` to `gold.adjusted_bar_d1`.
  // Without this the 5-year tile would pick the new producer up (its
  // `source_max_date` advances nightly anyway) while every CLOSED YEAR tile
  // kept the old one's numbers for ever — a chart that steps at exactly the
  // five-year boundary wherever the two disagree, which is the disagreement
  // the switch exists to settle.
  it("a changed PRODUCER is its own reason", () => {
    assert.equal(
      rebuildReason(
        { ...entry, built_from: "candles" },
        {
          ...now("2026-09-11T00:00:00.000Z"),
          builtFrom: "gold",
        },
      ),
      "source-changed",
    );
  });

  it("the SAME producer does not rebuild every night", () => {
    assert.equal(
      rebuildReason(
        { ...entry, built_from: "gold" },
        {
          ...now("2026-09-11T00:00:00.000Z"),
          builtFrom: "gold",
        },
      ),
      null,
    );
  });

  it("a caller that states no producer is not asked the question", () => {
    // India's builder and every pre-B4 caller pass nothing. "Cannot ask" must
    // not mean "rebuild", or the whole India market rebuilds nightly — the
    // same back-compat rule the actions fingerprint follows.
    assert.equal(
      rebuildReason(
        { ...entry, built_from: "candles" },
        now("2026-09-11T00:00:00.000Z"),
      ),
      null,
    );
  });

  it("FORMAT still outranks a changed producer", () => {
    // The reader REFUSES an unknown format, so that has to be the reason
    // reported — a "source-changed" here would rebuild the tile and then hand
    // the reader something it still cannot parse, with the wrong cause logged.
    assert.equal(
      rebuildReason(
        {
          ...entry,
          built_from: "candles",
          tile_format_version: TILE_FORMAT_VERSION + 1,
        },
        { ...now("2026-09-11T00:00:00.000Z"), builtFrom: "gold" },
      ),
      "format-changed",
    );
  });

  it("a moved POLICY rebuilds a tile that decodes perfectly", () => {
    // This is the case a single version number cannot express: the bytes parse,
    // every field is the right type, and the prices are on the old basis.
    assert.equal(
      rebuildReason(entry, {
        ...now("2026-09-11T00:00:00.000Z"),
        policyVersion: ADJUSTMENT_POLICY_VERSION + 1,
      }),
      "policy-changed",
    );
  });

  it("a moved FORMAT rebuilds, because the reader would refuse the tile", () => {
    assert.equal(
      rebuildReason(
        { ...entry, tile_format_version: TILE_FORMAT_VERSION + 1 },
        now("2026-09-11T00:00:00.000Z"),
      ),
      "format-changed",
    );
  });

  it("an entry with no recorded source date is STALE, not current", () => {
    // "The last build did not record one" must not read as "up to date": a
    // listing silently skipped every night is a chart frozen on whatever day
    // the last good build happened.
    assert.equal(
      rebuildReason(
        { ...entry, source_max_date: null },
        now("2026-09-11T00:00:00.000Z"),
      ),
      "source-advanced",
    );
    assert.equal(
      rebuildReason(
        { ...entry, source_max_date: "not-a-date" },
        now("2026-09-11T00:00:00.000Z"),
      ),
      "source-advanced",
    );
  });
});

describe("sharding is stable and balanced", () => {
  it("a listing lands on the SAME shard every run", () => {
    // If it did not, two shards could both decide to rebuild one listing and
    // race the same object.
    const a = shardOf("RELIANCE:NSE", 8);
    for (let i = 0; i < 50; i++) assert.equal(shardOf("RELIANCE:NSE", 8), a);
  });

  it("one shard means shard 0 — never a modulo of 1 that looks sharded", () => {
    assert.equal(shardOf("ANYTHING:NSE", 1), 0);
    assert.equal(shardOf("ANYTHING:NSE", 0), 0);
  });

  it("spreads a realistic universe across shards", () => {
    // A hash that piled everything on one shard would "work" and take 8x as
    // long, which reads as a slow job rather than a broken one.
    const counts = new Array(8).fill(0);
    for (let i = 0; i < 4000; i++) counts[shardOf(`SYM${i}:NSE`, 8)]!++;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    assert.ok(min > 4000 / 8 / 2, `shard famine: ${counts.join(",")}`);
    assert.ok(max < (4000 / 8) * 2, `shard pile-up: ${counts.join(",")}`);
  });
});

describe("a NEW corporate action rebuilds the YEAR tiles, not just the 5y", () => {
  // The review's finding 5. A split re-bases every bar BEFORE its ex-date —
  // mostly deep history, i.e. the year tiles. Comparing only `source_max_date`
  // rebuilds the 5y tile on the new basis and leaves the year tiles on the old
  // one, so the chart steps at exactly the five-year boundary on a real price
  // series, with nothing reporting an error.
  const split = (iso: string, ratio: number) => ({
    exDate: new Date(iso),
    type: "SPLIT",
    ratio,
  });
  const entryWith = (fp: string) => ({
    years: [2024],
    five_y_built_at: "2026-09-12T00:00:00.000Z",
    adjustment_policy_version: ADJUSTMENT_POLICY_VERSION,
    tile_format_version: TILE_FORMAT_VERSION,
    source_max_date: "2026-09-11T00:00:00.000Z",
    built_from: "dailyprice" as const,
    yahoo_fill_sessions: 0,
    actions_fingerprint: fp,
  });
  const unchanged = {
    sourceMaxDate: new Date("2026-09-11T00:00:00.000Z"),
    policyVersion: ADJUSTMENT_POLICY_VERSION,
    formatVersion: TILE_FORMAT_VERSION,
  };

  it("a changed fingerprint is its OWN reason", () => {
    const before = fingerprintActions([split("2024-06-01T00:00:00Z", 2)]);
    const after = fingerprintActions([
      split("2024-06-01T00:00:00Z", 2),
      split("2026-01-05T00:00:00Z", 5),
    ]);
    assert.notEqual(before, after);
    assert.equal(
      rebuildReason(entryWith(before), {
        ...unchanged,
        actionsFingerprint: after,
      }),
      "actions-changed",
    );
    assert.equal(
      rebuildReason(entryWith(before), {
        ...unchanged,
        actionsFingerprint: before,
      }),
      null,
      "the same actions must not rebuild every night",
    );
  });

  it("a CORRECTED ratio on the same ex-date is a change", () => {
    // Same date, different multiplier — every price before it moves.
    const a = fingerprintActions([split("2024-06-01T00:00:00Z", 2)]);
    const b = fingerprintActions([split("2024-06-01T00:00:00Z", 5)]);
    assert.notEqual(a, b);
  });

  it("a re-measured OBSERVED gap, or a changed source, is a change — MONEY-1541", () => {
    // A detector re-run rewrites details.observedRatio on the SAME row, and a
    // CAPITAL_ADJUSTMENT divides by it; `source` decides the DERIVED rules.
    const cliff = (observedRatio: number, source = "DERIVED") => [
      {
        exDate: new Date("2024-06-01T00:00:00Z"),
        type: "CAPITAL_ADJUSTMENT",
        ratio: 2,
        source,
        details: { observedRatio },
      },
    ];
    assert.notEqual(
      fingerprintActions(cliff(1.97)),
      fingerprintActions(cliff(2.03)),
    );
    assert.notEqual(
      fingerprintActions(cliff(1.97)),
      fingerprintActions(cliff(1.97, "NSE")),
    );
  });

  it("order does not matter", () => {
    const a = fingerprintActions([
      split("2024-06-01T00:00:00Z", 2),
      split("2022-01-01T00:00:00Z", 3),
    ]);
    const b = fingerprintActions([
      split("2022-01-01T00:00:00Z", 3),
      split("2024-06-01T00:00:00Z", 2),
    ]);
    assert.equal(a, b, "a reordered query result is not a change");
  });

  it("a rewrite of CLOSED years reads the whole history — MONEY-1541", () => {
    // An incremental build reads the 5y window, and a closed year is rewritten
    // only from bars the run read: a policy bump or a new split re-based the
    // last six year tiles and left SUDARSCHEM's 2014 or TORNTPHARM's 2006 on
    // the old basis.
    const fp = fingerprintActions([split("2014-09-29T18:30:00Z", 5)]);
    const entry = { ...entryWith(fp), years: [2006, 2014, 2024] };
    const now = {
      ...unchanged,
      actionsFingerprint: fp,
      builtFrom: "dailyprice" as const,
    };
    assert.equal(mustReadDeepHistory(entry, now), false, "an ordinary night");
    assert.equal(
      mustReadDeepHistory(entry, {
        ...now,
        policyVersion: ADJUSTMENT_POLICY_VERSION + 1,
      }),
      true,
    );
    assert.equal(
      mustReadDeepHistory(entry, { ...now, actionsFingerprint: "changed" }),
      true,
    );
    assert.equal(mustReadDeepHistory(undefined, now), true, "a first build");
  });

  it("an entry written BEFORE fingerprints existed is not rebuilt for ever", () => {
    // Back-compat: no fingerprint on the entry means the question cannot be
    // asked, and "cannot ask" must not mean "rebuild every night".
    const legacy = { ...entryWith("x"), actions_fingerprint: undefined };
    assert.equal(
      rebuildReason(legacy, { ...unchanged, actionsFingerprint: "anything" }),
      null,
    );
  });
});

// ── MONEY-1479: a SPACE in the exchange name ───────────────────────────────
//
// Measured on prod: 284 of 14,258 US listings could not be tiled, ALL of them
// `NYSE ARCA` (244, mostly ETFs) and `NYSE MKT` (40) — e.g.
// `ESSC:NYSE ARCA:2025-09-30`. Those are the exchanges' real names, not dirty
// data, so the key folds the space rather than the stored listingId being
// migrated.

describe("a space in the listing id is folded, not refused", () => {
  it("both key builders fold it, and agree with each other", () => {
    const id = "ESSC:NYSE ARCA:2025-09-30";
    const five = tileKey5y("US", id);
    const year = tileKeyYear("US", id, 2025);
    assert.match(five, /ESSC:NYSE_ARCA:2025-09-30/);
    assert.match(year, /ESSC:NYSE_ARCA:2025-09-30/);
    // A key written by one and read by the other must land in the same folder,
    // or a year tile is a 404 that renders as a blank chart.
    assert.equal(
      five.slice(0, five.lastIndexOf("/")),
      year.slice(0, year.lastIndexOf("/")),
    );
    assert.doesNotMatch(five, / /, "no space may survive into an object key");
  });

  it("canBuildTileKey agrees with the builders — it must not refuse what they accept", () => {
    // The resolver asks this predicate (MONEY-1476). If it said no while the
    // builder said yes, /udf/symbols would refuse a symbol that has a tile.
    for (const id of [
      "ESSC:NYSE ARCA:2025-09-30",
      "RELIANCE:NSE",
      "AAPL:NASDAQ:1980-12-12",
    ]) {
      assert.equal(canBuildTileKey(id), true, id);
      assert.doesNotThrow(() => tileKey5y("US", id), id);
    }
  });

  it("everything else unsafe is STILL refused — the fold is one character, not a loosening", () => {
    // A separator would move the object outside its prefix, and
    // `bucketForPrefix` only inspects the first segment.
    for (const bad of ["A/B:NSE", "..:NSE", "A\\B:NSE", "A\tB:NSE", ""]) {
      assert.equal(canBuildTileKey(bad), false, JSON.stringify(bad));
      assert.throws(() => tileKey5y("US", bad), JSON.stringify(bad));
    }
  });

  it("the fold cannot collide with a real listing id", () => {
    // `NYSE ARCA` -> `NYSE_ARCA` is only safe because no exchange uses an
    // underscore. If one ever did, two distinct listings would share a key and
    // one would silently overwrite the other.
    assert.equal(foldListingIdForKey("X:NYSE ARCA:1"), "X:NYSE_ARCA:1");
    assert.equal(foldListingIdForKey("X:NSE"), "X:NSE", "untouched when safe");
  });
});

describe("`&` is a real Indian ticker character, and it was breaking 20 tiles a night", () => {
  // MEASURED on prod from the nightly job outcome: `tile-build-d1-in` exits 1
  // every run on TEN symbols across BOTH exchanges — M&M (a NIFTY 50
  // constituent), M&MFIN, J&KBANK, IL&FSTRANS, IL&FSENGG, GVT&D, GMRP&UI,
  // ARE&M, S&SPOWER, SURANAT&P. `[job-outcome] {"selected":9278,"written":7777,
  // "failed":20}`. So Mahindra & Mahindra has had no D1 tile in either
  // environment and its chart is blank on the tile origin.
  it("M&M can be tiled", () => {
    assert.ok(canBuildTileKey("M&M:NSE"), "M&M is in the NIFTY 50");
    assert.ok(canBuildTileKey("IL&FSTRANS:BSE"));
    assert.equal(tileKey5y("IN", "M&M:NSE"), "tiles/IN/d1/M&M:NSE/5y.json");
  });

  it("and it is ALLOWED, not folded — a fold would collide", () => {
    // The space fold already spent the only character that cannot appear in a
    // real listing id (`_`). Folding `&` there too would map `A&B` and `A B`
    // onto ONE key: two different instruments sharing a tile, which is worse
    // than the failure it replaces.
    assert.notEqual(
      foldListingIdForKey("M&M:NSE"),
      foldListingIdForKey("M M:NSE"),
    );
    assert.equal(foldListingIdForKey("M&M:NSE"), "M&M:NSE", "& is not folded");
  });

  it("the separators it exists to refuse are STILL refused", () => {
    // Anti-vacuity: widening a charset is exactly the change that quietly
    // admits the thing the charset was for.
    assert.equal(canBuildTileKey("A/B:NSE"), false, "a slash reshapes the key");
    assert.equal(
      canBuildTileKey("..:NSE"),
      false,
      "traversal escapes the prefix",
    );
    assert.equal(canBuildTileKey("A B&C:NSE"), true, "space folds, & passes");
  });
});

describe("zeroWriteRefusal separates an empty SHARD from an empty POPULATION", () => {
  const base = { apply: true, built: 0, builtEmpty: 0, skipped: 0 };

  it("an empty shard of a real population is healthy", () => {
    // MONEY-1379's lesson from broker-sync: the fan-out is wide and most leaves
    // legitimately match nothing.
    assert.equal(
      zeroWriteRefusal({ ...base, walked: 0, population: 9278 }),
      null,
    );
  });

  it("an empty POPULATION is the silent success this guard exists for", () => {
    // The defect the old form let through: if the selector drifts and matches
    // zero rows platform-wide, EVERY shard walks 0, every shard is exempted,
    // every task exits 0, and tiles/ stops being refreshed behind a green
    // dashboard — which is verbatim what the refusal was written to end.
    const r = zeroWriteRefusal({ ...base, walked: 0, population: 0 });
    assert.ok(r, "a run that selected nothing at all must refuse");
    assert.match(r, /ZERO listings/);
  });

  it("a dry run still writes nothing legitimately", () => {
    assert.equal(
      zeroWriteRefusal({ ...base, apply: false, walked: 100, population: 0 }),
      null,
    );
  });

  it("walking listings and producing nothing still refuses", () => {
    assert.ok(zeroWriteRefusal({ ...base, walked: 50, population: 9278 }));
  });
});
