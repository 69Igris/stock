/**
 * `us-sink-logic` — MONEY-1513 (B2-US).
 *
 * Every case here pins a failure that is SILENT in production: a session date
 * shifted one day, a bar filed under the wrong occupant of a recycled ticker, a
 * NAV with seventeen decimals that fails a whole month's load at
 * `maxBadRecords: 0`, a coverage gate handed its two counts the wrong way round.
 * None of them produce an error anyone would see.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PRICE_BAR_PARSER_VERSION } from "../src/price-bar-logic";
import { monthDeleteBounds } from "../src/india-sink-logic";
import { priceBarPartitionKey } from "../src/price-bar-logic";
import { BigQuery } from "@google-cloud/bigquery";
import { buildDeleteMonthSql, buildPurgeRangeSql } from "../src/load";
import {
  US_MARKET,
  US_TABLES,
  MAX_CONSECUTIVE_SYMBOL_FAILURES,
  WalkAbortedError,
  createSymbolFailureTracker,
  classifyBarListing,
  classifyFundNavRow,
  classifyUsPriceBarRow,
  d1SessionDate,
  decideUsMonth,
  hasStitchedHistory,
  isUsTable,
  latestOccupantOf,
  mongoSourceUri,
  US_RESOLUTION_METHODS,
  snapWindowToMonths,
  stagePartForSource,
  toFundNavRow,
  usDeleteScope,
  usParserVersion,
  type ListingResolutionLike,
  type RowProvenance,
} from "../src/us-sink-logic";

const PROV: RowProvenance = {
  sourceObjectUri: "mongo://us_fund_nav/US000000031490",
  sourceRecordKey: "US000000031490:2024-03-15",
  pipelineRunId: "lake-replay-us-run",
  observedAtMs: Date.UTC(2024, 2, 15),
  ingestedAtMs: Date.UTC(2026, 8, 22, 6, 0, 0),
};

const RESOLVED = (listingId: string): ListingResolutionLike => ({
  ok: true,
  listing: { listingId },
  multiVenue: false,
});

function priced(
  over: Partial<Record<"open" | "high" | "low" | "close", number | null>> = {},
) {
  return { open: 1, high: 2, low: 0.5, close: 1.5, ...over };
}

describe("d1SessionDate — the off-by-one that would shift every US bar", () => {
  it("reads the UTC calendar date, because a D1 ts IS the session key", () => {
    assert.equal(
      d1SessionDate(new Date("2024-03-15T00:00:00.000Z")),
      "2024-03-15",
    );
  });

  it("does NOT convert to the ET calendar day", () => {
    // UTC midnight of 2024-01-01 is 19:00 ET on 2023-12-31. `usMarketDateKey`
    // would answer "2023-12-31" — a different YEAR, a different partition, and
    // every bar on the wrong side of every corporate action.
    assert.equal(
      d1SessionDate(new Date("2024-01-01T00:00:00.000Z")),
      "2024-01-01",
    );
    assert.equal(
      d1SessionDate(new Date("2024-07-01T00:00:00.000Z")),
      "2024-07-01",
    );
  });

  it("refuses an Invalid Date rather than emitting 'Invalid Da'", () => {
    assert.throws(() => d1SessionDate(new Date("not a date")), RangeError);
  });
});

describe("classifyBarListing — a ticker is not a security", () => {
  it("accepts a bar whose stored id is the one the master resolves", () => {
    assert.deepEqual(
      classifyBarListing({
        resolution: RESOLVED("AAPL:NASDAQ:1980-12-12"),
        barListingId: "AAPL:NASDAQ:1980-12-12",
      }),
      { ok: true, method: "VENDOR_LISTING_ID" },
    );
  });

  it("QUARANTINES the DOW mismatch rather than correcting it", () => {
    // A 2015 bar carrying Dow Inc.'s id while the master resolves 2015 to Dow
    // Chemical. Writing either value is wrong: one contradicts every other
    // store that holds the bar, the other files a company's prices under its
    // successor. The row does not get written.
    assert.deepEqual(
      classifyBarListing({
        resolution: RESOLVED("DOW:NYSE:1972-01-03"),
        barListingId: "DOW:NYSE:2019-04-02",
      }),
      { ok: false, reason: "LISTING_MISMATCH" },
    );
  });

  it("names the two unresolved states apart", () => {
    assert.deepEqual(
      classifyBarListing({
        resolution: { ok: false, reason: "none" },
        barListingId: "X:NYSE:2020-01-01",
      }),
      { ok: false, reason: "LISTING_UNRESOLVED" },
    );
    assert.deepEqual(
      classifyBarListing({
        resolution: { ok: false, reason: "ambiguous" },
        barListingId: "X:NYSE:2020-01-01",
      }),
      { ok: false, reason: "LISTING_AMBIGUOUS" },
    );
  });

  it("accepts a multiVenue bar WITHOUT comparing ids, and says so in the method", () => {
    // `resolveListingForDate` sets multiVenue only when every match shares one
    // listingStartDate on different venues — one security, already certified.
    // Its venue pick is a tie-break for a consolidated feed, so a bar stamped
    // with the NYSE row while the priority table prefers NASDAQ is healthy.
    assert.deepEqual(
      classifyBarListing({
        resolution: {
          ok: true,
          listing: { listingId: "SPY:NASDAQ:1993-01-29" },
          multiVenue: true,
        },
        barListingId: "SPY:NYSE ARCA:1993-01-29",
      }),
      { ok: true, method: "VENDOR_LISTING_ID_MULTIVENUE" },
    );
  });

  it("refuses a BLANK stored id — it would join to nothing", () => {
    assert.deepEqual(
      classifyBarListing({
        resolution: RESOLVED("AAPL:NASDAQ:1980-12-12"),
        barListingId: "",
      }),
      { ok: false, reason: "LISTING_MISMATCH" },
    );
  });
});

/* MONEY-1616 — windows copied from prod `us_instruments`, 2026-09-24. */
const W = (listingId: string, start: string | null, end: string | null) => ({
  listingId,
  listingStartDate: start ? new Date(`${start}T00:00:00.000Z`) : null,
  listingEndDate: end ? new Date(`${end}T00:00:00.000Z`) : null,
});
const AMBIGUOUS: ListingResolutionLike = { ok: false, reason: "ambiguous" };
const BARNES = W("B:NYSE:1984-09-07", "1984-09-07", "2025-01-27");
const BARRICK = W("B:NYSE:1985-02-04", "1985-02-04", "2026-09-22");
const B = [BARNES, BARRICK];

type Bar = {
  listingId: string;
  sessionDate: string;
  close: number | null;
  splitFactor?: number;
};
const bar = (
  listingId: string,
  sessionDate: string,
  close: number | null = null,
  splitFactor?: number,
): Bar => ({ listingId, sessionDate, close, splitFactor });

/** What the shell does for one AMBIGUOUS session, composed the same way. */
function decide(
  windows: ReturnType<typeof W>[],
  barListingId: string,
  candidateIds: string[],
  series: Bar[] = [],
) {
  const occupant = latestOccupantOf(windows);
  return classifyBarListing({
    resolution: AMBIGUOUS,
    barListingId,
    occupancy: {
      candidateIds,
      latestOccupantId: occupant?.listingId ?? null,
      stitched:
        occupant !== null &&
        hasStitchedHistory({ occupant, windows, bars: series }),
    },
  });
}
const ADMIT = { ok: true, method: "LATEST_OCCUPANT" } as const;
const REFUSE = { ok: false, reason: "LISTING_AMBIGUOUS" } as const;

describe("LATEST_OCCUPANT — an ambiguous session admitted for the current occupant (MONEY-1616)", () => {
  it("admits Barrick's B bar inside the Barnes overlap, and records the method", () => {
    const all = [BARNES.listingId, BARRICK.listingId];
    assert.deepEqual(decide(B, BARRICK.listingId, all), ADMIT);
    assert.ok(US_RESOLUTION_METHODS.includes("LATEST_OCCUPANT"));
    // BNY: the ACTIVE 1973 row (BNY Mellon's history) beside a delisted ETF.
    const bny = [
      W("BNY:NYSE:2001-07-27", "2001-07-27", "2026-02-06"),
      W("BNY:NYSE:1973-05-03", "1973-05-03", "2026-09-22"),
    ];
    assert.deepEqual(
      decide(
        bny,
        "BNY:NYSE:1973-05-03",
        bny.map((w) => w.listingId),
      ),
      ADMIT,
    );
  });

  it("refuses the PREDECESSOR's id in the same overlap — only the latest occupant", () => {
    assert.deepEqual(
      decide(B, BARNES.listingId, [BARNES.listingId, BARRICK.listingId]),
      REFUSE,
    );
  });

  it("TOPW: a delisted stored id refuses while a later ACTIVE candidate exists", () => {
    const topw = [
      W("TOPW:BATS:2025-04-02", "2025-04-02", "2026-09-01"),
      W("TOPW:BATS:2025-09-04", "2025-09-04", "2026-09-22"),
    ];
    assert.equal(latestOccupantOf(topw)?.listingId, "TOPW:BATS:2025-09-04");
    assert.deepEqual(
      decide(
        topw,
        "TOPW:BATS:2025-04-02",
        topw.map((w) => w.listingId),
      ),
      REFUSE,
    );
  });

  it("GAB: the phantom one-day window's id refuses; the fund's own id is admitted", () => {
    const gab = [
      W("GAB:NYSE:1987-11-05", "1987-11-05", "2026-09-22"),
      W("GAB:NYSE:2026-09-21", "2026-09-21", "2026-09-21"),
    ];
    const both = gab.map((w) => w.listingId);
    assert.deepEqual(decide(gab, "GAB:NYSE:2026-09-21", both), REFUSE);
    assert.deepEqual(decide(gab, "GAB:NYSE:1987-11-05", both), ADMIT);
  });

  it("a TIE for latest-ending admits nobody", () => {
    // WNS: both rows end 2025-10-16.
    const wns = [
      W("WNS:NYSE:2006-07-26", "2006-07-26", "2025-10-16"),
      W("WNS:NYSE:2024-03-28", "2024-03-28", "2025-10-16"),
    ];
    assert.equal(latestOccupantOf(wns), null);
    for (const w of wns) {
      assert.deepEqual(
        decide(
          wns,
          w.listingId,
          wns.map((x) => x.listingId),
        ),
        REFUSE,
      );
    }
    // Two open ends are a tie too.
    assert.equal(
      latestOccupantOf([
        W("X:NYSE:2001-01-02", "2001-01-02", null),
        W("X:NASDAQ:2010-01-04", "2010-01-04", null),
      ]),
      null,
    );
  });

  it("an open end is the latest; one window or an Invalid Date end is null", () => {
    const dow = [
      W("DOW:NYSE:1972-06-01", "1972-06-01", "2019-04-01"),
      W("DOW:NYSE:2019-03-20", "2019-03-20", null),
    ];
    assert.equal(latestOccupantOf(dow)?.listingId, "DOW:NYSE:2019-03-20");
    assert.equal(latestOccupantOf([BARRICK]), null);
    assert.equal(
      latestOccupantOf([
        BARNES,
        { ...BARRICK, listingEndDate: new Date("nope") },
      ]),
      null,
    );
  });

  it("refuses the latest occupant's id on a session its window does NOT cover", () => {
    // Two predecessors overlap in 2007; the occupant starts in 2011. Its id on a
    // 2007 bar is not a candidate, so it is not admitted — whatever it is.
    const w = [
      W("Q:NYSE:2000-01-03", "2000-01-03", "2010-06-30"),
      W("Q:NASDAQ:2005-03-01", "2005-03-01", "2012-01-31"),
      W("Q:NYSE:2011-05-02", "2011-05-02", null),
    ];
    assert.deepEqual(
      decide(w, "Q:NYSE:2011-05-02", [
        "Q:NYSE:2000-01-03",
        "Q:NASDAQ:2005-03-01",
      ]),
      REFUSE,
    );
  });

  it("a DOW-like stitched series refuses the overlap too", () => {
    // Dow Inc.'s id on the 2019 overlap is admitted on its own; a 2015 bar
    // carrying the same id — Dow Chemical's history prepended — withdraws it.
    const dow = [
      W("DOW:NYSE:1972-06-01", "1972-06-01", "2019-04-01"),
      W("DOW:NYSE:2019-03-20", "2019-03-20", null),
    ];
    const both = dow.map((w) => w.listingId);
    const own = [bar("DOW:NYSE:2019-03-20", "2019-03-20")];
    assert.deepEqual(decide(dow, "DOW:NYSE:2019-03-20", both, own), ADMIT);
    assert.deepEqual(
      decide(dow, "DOW:NYSE:2019-03-20", both, [
        ...own,
        bar("DOW:NYSE:2019-03-20", "2015-06-01"),
      ]),
      REFUSE,
    );
  });

  it("the seven stitched tickers measured on prod are never admitted", () => {
    // Windows from the master; the bar is the FIRST stored session carrying the
    // occupant's id before its own window (the measured MISMATCH rows).
    const seven: [string, ReturnType<typeof W>[], string][] = [
      [
        "WUSA",
        [
          W("WUSA:NYSE ARCA:2015-07-21", "2015-07-21", "2018-03-16"),
          W("WUSA:NYSE ARCA:2024-09-24", "2024-09-24", "2025-05-23"),
        ],
        "2015-07-21",
      ],
      [
        "WNS",
        [
          W("WNS:NYSE:2006-07-26", "2006-07-26", "2025-10-16"),
          W("WNS:NYSE:2024-03-28", "2024-03-28", "2025-10-16"),
        ],
        "2006-07-26",
      ],
      [
        "DEFI",
        [
          W("DEFI:NYSE ARCA:2022-09-16", "2022-09-16", "2024-01-02"),
          W("DEFI:NYSE ARCA:2024-01-03", "2024-01-03", "2024-03-26"),
          W("DEFI:NYSE ARCA:2024-03-27", "2024-03-27", "2026-08-17"),
        ],
        "2024-01-03",
      ],
      [
        "MJUS",
        [
          W("MJUS:NYSE ARCA:2024-01-29", "2024-01-29", "2025-01-27"),
          W("MJUS:NYSE ARCA:2021-05-13", "2021-05-13", "2024-01-26"),
        ],
        "2021-05-13",
      ],
      [
        "HZON-WS",
        [
          W("HZON-WS:NYSE:2022-11-29", "2022-11-29", "2023-04-25"),
          W("HZON-WS:NYSE:2020-12-10", "2020-12-10", "2022-11-28"),
        ],
        "2020-12-10",
      ],
      [
        "PACI-U",
        [
          W("PACI-U:NYSE:2023-09-08", "2023-09-08", "2023-12-01"),
          W("PACI-U:NYSE:2021-12-01", "2021-12-01", "2023-09-07"),
        ],
        "2021-12-01",
      ],
      [
        "ALLG-WS",
        [
          W("ALLG-WS:NYSE:2023-09-25", "2023-09-25", "2023-10-17"),
          W("ALLG-WS:NYSE:2022-03-24", "2022-03-24", "2023-09-22"),
        ],
        "2022-03-24",
      ],
    ];
    for (const [sym, windows, stitchedAt] of seven) {
      // The stored id on every one of them is the latest-STARTING window.
      const stored = [...windows].sort((a, b) =>
        a.listingStartDate! < b.listingStartDate! ? 1 : -1,
      )[0]!.listingId;
      const series = [bar(stored, stitchedAt)];
      const occupant = latestOccupantOf(windows);
      // WNS is a tie and has no occupant; the other six are caught by the DATA.
      if (sym === "WNS") assert.equal(occupant, null, sym);
      else
        assert.ok(
          occupant && hasStitchedHistory({ occupant, windows, bars: series }),
          sym,
        );
      assert.deepEqual(
        decide(
          windows,
          stored,
          windows.map((w) => w.listingId),
          series,
        ),
        REFUSE,
        sym,
      );
    }
  });

  it("a bar AFTER the occupant's end is master lag, not stitching", () => {
    assert.equal(
      hasStitchedHistory({
        occupant: BARRICK,
        windows: B,
        bars: [
          bar(BARRICK.listingId, "2026-09-23"),
          // A predecessor's own early bar is not the occupant's.
          bar(BARNES.listingId, "1984-09-07"),
        ],
      }),
      false,
    );
    assert.equal(
      hasStitchedHistory({
        occupant: BARRICK,
        windows: B,
        bars: [bar(BARRICK.listingId, "1985-02-01")],
      }),
      true,
    );
  });

  it("BTDR: a price SEAM at the predecessor's end withholds the handover bar", () => {
    // 2023-04-13 is covered by both rows. The occupant's bar that day is $10 —
    // Blue Safari's SPAC price — and Bitdeer opens at $7.03 the next session.
    const btdr = [
      W("BTDR:NASDAQ:2023-04-13", "2023-04-13", "2026-09-22"),
      W("BTDR:NASDAQ:2021-07-28", "2021-07-28", "2023-04-13"),
    ];
    const both = btdr.map((w) => w.listingId);
    const id = "BTDR:NASDAQ:2023-04-13";
    assert.deepEqual(
      decide(btdr, id, both, [
        bar(id, "2023-04-13", 10),
        bar(id, "2023-04-14", 7.03),
      ]),
      REFUSE,
    );
    // The same days, price-continuous: no seam, admitted.
    assert.deepEqual(
      decide(btdr, id, both, [
        bar(id, "2023-04-13", 7.1),
        bar(id, "2023-04-14", 7.03),
      ]),
      ADMIT,
    );
  });

  it("INM: a seam at another window's START withholds the symbol too", () => {
    const inm = [
      W("INM:NASDAQ:2020-11-12", "2020-11-12", "2022-12-30"),
      W("INM:NASDAQ:2014-05-05", "2014-05-05", "2026-09-22"),
    ];
    const id = "INM:NASDAQ:2014-05-05";
    assert.deepEqual(
      decide(
        inm,
        id,
        inm.map((w) => w.listingId),
        [bar(id, "2020-11-11", 4.88), bar(id, "2020-11-12", 3.25)],
      ),
      REFUSE,
    );
  });

  it("a split on the boundary day, or a multi-year gap, is not a seam", () => {
    const btdr = [
      W("BTDR:NASDAQ:2023-04-13", "2023-04-13", "2026-09-22"),
      W("BTDR:NASDAQ:2021-07-28", "2021-07-28", "2023-04-13"),
    ];
    const occupant = btdr[0]!;
    const id = occupant.listingId;
    // 2-for-1 on the next session: the close halves, the split factor says why.
    assert.equal(
      hasStitchedHistory({
        occupant,
        windows: btdr,
        bars: [bar(id, "2023-04-13", 20), bar(id, "2023-04-14", 10, 2)],
      }),
      false,
    );
    // TRAK: the stored series jumps 2015 -> 2024. A gap is not a seam.
    assert.equal(
      hasStitchedHistory({
        occupant,
        windows: btdr,
        bars: [bar(id, "2023-04-13", 63.16), bar(id, "2023-05-30", 18.63)],
      }),
      false,
    );
  });

  it("MISMATCH and UNRESOLVED are unchanged, whatever the occupancy says", () => {
    const occupancy = {
      candidateIds: [BARNES.listingId, BARRICK.listingId],
      latestOccupantId: BARRICK.listingId,
      stitched: false,
    };
    assert.deepEqual(
      classifyBarListing({
        resolution: RESOLVED(BARNES.listingId),
        barListingId: BARRICK.listingId,
        occupancy,
      }),
      { ok: false, reason: "LISTING_MISMATCH" },
    );
    assert.deepEqual(
      classifyBarListing({
        resolution: { ok: false, reason: "none" },
        barListingId: BARRICK.listingId,
        occupancy,
      }),
      { ok: false, reason: "LISTING_UNRESOLVED" },
    );
    // No occupancy at all is the pre-MONEY-1616 answer.
    assert.deepEqual(
      classifyBarListing({
        resolution: AMBIGUOUS,
        barListingId: BARRICK.listingId,
      }),
      REFUSE,
    );
  });

  it("classifyUsPriceBarRow passes the occupancy through, price rung still after", () => {
    const occupancy = {
      candidateIds: [BARNES.listingId, BARRICK.listingId],
      latestOccupantId: BARRICK.listingId,
      stitched: false,
    };
    assert.deepEqual(
      classifyUsPriceBarRow({
        row: { listing_id: BARRICK.listingId, ...priced() },
        resolution: AMBIGUOUS,
        occupancy,
      }),
      { keep: true, method: "LATEST_OCCUPANT" },
    );
    assert.deepEqual(
      classifyUsPriceBarRow({
        row: {
          listing_id: BARRICK.listingId,
          open: null,
          high: null,
          low: null,
          close: null,
        },
        resolution: AMBIGUOUS,
        occupancy,
      }),
      { keep: false, reason: "NO_FINITE_PRICE" },
    );
  });
});

describe("classifyUsPriceBarRow", () => {
  it("keeps a resolved, priced row and hands back the method", () => {
    assert.deepEqual(
      classifyUsPriceBarRow({
        row: { listing_id: "A:NYSE:1999-11-18", ...priced() },
        resolution: RESOLVED("A:NYSE:1999-11-18"),
      }),
      { keep: true, method: "VENDOR_LISTING_ID" },
    );
  });

  it("refuses a bar with no finite price at all", () => {
    assert.deepEqual(
      classifyUsPriceBarRow({
        row: {
          listing_id: "A:NYSE:1999-11-18",
          open: null,
          high: null,
          low: null,
          close: null,
        },
        resolution: RESOLVED("A:NYSE:1999-11-18"),
      }),
      { keep: false, reason: "NO_FINITE_PRICE" },
    );
  });

  it("keeps a row with ANY one price — a NULL open is not a missing bar", () => {
    assert.deepEqual(
      classifyUsPriceBarRow({
        row: {
          listing_id: "A:NYSE:1999-11-18",
          open: null,
          high: null,
          low: null,
          close: 12.5,
        },
        resolution: RESOLVED("A:NYSE:1999-11-18"),
      }),
      { keep: true, method: "VENDOR_LISTING_ID" },
    );
  });

  it("checks the LISTING before the price, so a mismatch is named as one", () => {
    // Both rungs fail. The reason an operator acts on is the listing — a
    // price-shaped reason would send them to the feed instead of the master.
    assert.deepEqual(
      classifyUsPriceBarRow({
        row: {
          listing_id: "DOW:NYSE:2019-04-02",
          open: null,
          high: null,
          low: null,
          close: null,
        },
        resolution: RESOLVED("DOW:NYSE:1972-01-03"),
      }),
      { keep: false, reason: "LISTING_MISMATCH" },
    );
  });
});

describe("toFundNavRow — NUMERIC(18,6) from the first line (MONEY-1512)", () => {
  it("ROUNDS a NAV to six decimals, because BigQuery refuses more", () => {
    // `UsFundNav.nav` is a Mongo Float. One row carrying a seventeen-digit tail
    // fails the WHOLE month at `maxBadRecords: 0` — which is how
    // `derivatives_eod_in` could not load a single row for any window.
    const row = toFundNavRow(
      {
        permaTicker: "US000000031490",
        symbol: "AAAAX",
        navDate: "2024-03-15",
        nav: 11.123456789012345,
        source: "TIINGO",
      },
      PROV,
    );
    assert.equal(row.nav, 11.123457);
    assert.ok(String(row.nav).split(".")[1]!.length <= 6);
  });

  it("turns a non-finite NAV into NULL, never 0", () => {
    // 0 is a fund that went to zero. NULL is "we do not have this".
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const row = toFundNavRow(
        {
          permaTicker: "P",
          symbol: null,
          navDate: "2024-03-15",
          nav: bad,
          source: "TIINGO",
        },
        PROV,
      );
      assert.equal(row.nav, null);
    }
  });

  it("stamps the fund-nav parser version, distinct from the bar one", () => {
    const row = toFundNavRow(
      {
        permaTicker: "P",
        symbol: "X",
        navDate: "2024-03-15",
        nav: 1,
        source: "TIINGO",
      },
      { ...PROV, parserVersion: undefined },
    );
    assert.equal(row.parser_version, usParserVersion("fund_nav_d1"));
    assert.notEqual(row.parser_version, PRICE_BAR_PARSER_VERSION);
  });

  it("carries observed_at from the SOURCE and ingested_at from the run", () => {
    const row = toFundNavRow(
      {
        permaTicker: "P",
        symbol: "X",
        navDate: "2024-03-15",
        nav: 1,
        source: "TIINGO",
      },
      PROV,
    );
    assert.equal(row.observed_at, new Date(PROV.observedAtMs).toISOString());
    assert.equal(row.ingested_at, new Date(PROV.ingestedAtMs).toISOString());
    assert.notEqual(row.observed_at, row.ingested_at);
  });

  it("keeps a NULL symbol as NULL rather than an empty string", () => {
    const row = toFundNavRow(
      {
        permaTicker: "P",
        symbol: null,
        navDate: "2024-03-15",
        nav: 1,
        source: "TIINGO",
      },
      PROV,
    );
    assert.equal(row.symbol, null);
  });
});

describe("classifyFundNavRow", () => {
  it("keeps a priced row in its own month", () => {
    assert.equal(
      classifyFundNavRow({
        row: { nav_date: "2024-03-15", nav: 11.25 },
        partitionKey: "US/2024-03",
      }),
      null,
    );
  });

  it("refuses a row from another month — the DELETE would not cover it", () => {
    assert.equal(
      classifyFundNavRow({
        row: { nav_date: "2024-04-01", nav: 11.25 },
        partitionKey: "US/2024-03",
      }),
      "WRONG_MONTH",
    );
  });

  it("refuses a NULL nav", () => {
    assert.equal(
      classifyFundNavRow({
        row: { nav_date: "2024-03-15", nav: null },
        partitionKey: "US/2024-03",
      }),
      "NO_FINITE_NAV",
    );
  });
});

describe("decideUsMonth", () => {
  it("SKIPS a month nothing was observed for, and says so in US terms", () => {
    const verdict = decideUsMonth({
      sessionsSeen: new Set(),
      sessionsWritten: new Set(),
      rowCount: 0,
    });
    assert.equal(verdict.action, "skip");
    assert.ok(verdict.action === "skip" && /hot row/.test(verdict.reason));
    // The India wording names things this job does not have. An operator sent
    // looking for a "family floor" would go hunting a registry with no US entry.
    assert.ok(
      verdict.action === "skip" && !/family|day-file/.test(verdict.reason),
    );
  });

  it("SKIPS a month whose rows were all quarantined", () => {
    const verdict = decideUsMonth({
      sessionsSeen: new Set(["2024-03-15"]),
      sessionsWritten: new Set(),
      rowCount: 0,
    });
    assert.equal(verdict.action, "skip");
    assert.ok(verdict.action === "skip" && /quarantine/.test(verdict.reason));
  });

  it("hands the two counts to coverage IN THE RIGHT ORDER", () => {
    // `decideCoverage` refuses unless actual >= expected > 0. Swapping them
    // makes a PARTIAL month — one whose quarantine ate a whole session — pass,
    // and ACCEPTED is what makes every future run skip it for ever.
    const verdict = decideUsMonth({
      sessionsSeen: new Set(["2024-03-14", "2024-03-15"]),
      sessionsWritten: new Set(["2024-03-15"]),
      rowCount: 7,
    });
    assert.equal(verdict.action, "load");
    assert.ok(verdict.action === "load" && verdict.expectedSessions === 2);
    assert.ok(verdict.action === "load" && verdict.actualSessions === 1);
  });

  it("loads a complete month", () => {
    const days = new Set(["2024-03-14", "2024-03-15"]);
    const verdict = decideUsMonth({
      sessionsSeen: days,
      sessionsWritten: new Set(days),
      rowCount: 400,
    });
    assert.deepEqual(verdict, {
      action: "load",
      expectedSessions: 2,
      actualSessions: 2,
    });
  });
});

describe("stagePartForSource — the wildcard must not cross sources", () => {
  it("separates TIINGO from TIINGO_RT, which is a PREFIX of it", () => {
    const a = stagePartForSource("TIINGO", 0);
    const b = stagePartForSource("TIINGO_RT", 0);
    // `bq load` takes `…/{runId}/TIINGO-*`, which is a startsWith on the
    // object name. Without the dash, `TIINGO*` swallows both and the second
    // source's delete-and-load removes the first's rows.
    assert.ok(a.startsWith("TIINGO-"));
    assert.ok(!b.startsWith("TIINGO-"));
    assert.ok(b.startsWith("TIINGO_RT-"));
  });

  it("zero-pads so the parts of one source sort", () => {
    assert.equal(stagePartForSource("TIINGO", 7), "TIINGO-000007");
    assert.ok(
      stagePartForSource("TIINGO", 2) < stagePartForSource("TIINGO", 10),
    );
  });

  it("refuses a source that would break the wildcard", () => {
    for (const bad of ["TIINGO-RT", "TIINGO*", "tiingo", "", "1TIINGO"]) {
      assert.throws(() => stagePartForSource(bad, 0), /source/);
    }
  });

  it("refuses a non-integer sequence", () => {
    assert.throws(() => stagePartForSource("TIINGO", -1), /sequence/);
    assert.throws(() => stagePartForSource("TIINGO", 1.5), /sequence/);
  });
});

describe("snapWindowToMonths — replaceMonth deletes a WHOLE month", () => {
  it("widens a mid-month window to both month boundaries", () => {
    // Unsnapped, `--from 2024-03-15 --to 2024-03-31 --apply` deletes
    // 2024-03-01..14 and reloads only the second fortnight — a two-week hole in
    // a month the ledger reports ACCEPTED.
    assert.deepEqual(snapWindowToMonths("2024-03-15", "2024-03-20"), {
      from: "2024-03-01",
      to: "2024-03-31",
    });
  });

  it("gets February right in a leap year and out of one", () => {
    assert.equal(
      snapWindowToMonths("2024-02-10", "2024-02-10").to,
      "2024-02-29",
    );
    assert.equal(
      snapWindowToMonths("2023-02-10", "2023-02-10").to,
      "2023-02-28",
    );
  });

  it("rolls the YEAR over in December", () => {
    // A hand-written `month + 1` yields `2024-13-01`, and clamping it to
    // December deletes the wrong month.
    assert.deepEqual(snapWindowToMonths("2024-12-05", "2024-12-05"), {
      from: "2024-12-01",
      to: "2024-12-31",
    });
  });

  it("leaves an already-whole window alone", () => {
    assert.deepEqual(snapWindowToMonths("2024-03-01", "2024-03-31"), {
      from: "2024-03-01",
      to: "2024-03-31",
    });
  });

  it("refuses a reversed or malformed window", () => {
    assert.throws(
      () => snapWindowToMonths("2024-05-01", "2024-04-01"),
      /after/,
    );
    assert.throws(() => snapWindowToMonths("2024-3-1", "2024-04-01"), /--from/);
    assert.throws(
      () => snapWindowToMonths("2024-13-01", "2024-13-02"),
      /real date/,
    );
  });
});

describe("the partition key and the delete bounds agree, by construction", () => {
  it("every date of a month lands inside its own month's DELETE range", () => {
    // This is what replaces a WRONG_MONTH rung for `price_bar_d1`: the loader
    // derives the partition FROM the row, so the only thing that could put a
    // row outside the range being replaced is these two functions disagreeing.
    for (const month of ["2024-01", "2024-02", "2024-12", "1999-11"]) {
      const last = new Date(
        Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
      ).getUTCDate();
      for (let day = 1; day <= last; day++) {
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const key = priceBarPartitionKey(US_MARKET, date);
        assert.equal(key, `US/${month}`);
        const bounds = monthDeleteBounds(key);
        assert.ok(
          date >= bounds.fromInclusive,
          `${date} >= ${bounds.fromInclusive}`,
        );
        assert.ok(date < bounds.toExclusive, `${date} < ${bounds.toExclusive}`);
        assert.equal(bounds.market, US_MARKET);
      }
    }
  });
});

describe("tables and parser versions", () => {
  it("names both tables and refuses anything else", () => {
    assert.deepEqual([...US_TABLES], ["price_bar_d1", "fund_nav_d1"]);
    assert.ok(isUsTable("price_bar_d1"));
    assert.ok(isUsTable("fund_nav_d1"));
    assert.ok(!isUsTable("derivatives_eod_in"));
    assert.ok(!isUsTable(undefined));
  });

  it("scopes the DELETE per table, and `market` is the dangerous half", () => {
    // A `null` market on `price_bar_d1` drops the predicate entirely and
    // widens the delete across every other US source in that month (it does
    // NOT reach India — the statement also carries `AND source = @source`
    // and India is BHAVCOPY_HIST; corrected after review) — which the US
    // load then does not replace, and nothing errors.
    assert.deepEqual(usDeleteScope("price_bar_d1"), {
      market: "US",
      dateColumn: "session_date",
    });
    // `fund_nav_d1` has no `market` column at all (it keys on perma_ticker),
    // so naming one fails the statement.
    assert.deepEqual(usDeleteScope("fund_nav_d1"), {
      market: null,
      dateColumn: "nav_date",
    });
  });

  it("reuses B2's own version for bars and a distinct one for NAVs", () => {
    // One version across both tables would mean a NAV mapper fix forces a
    // re-load of ten years of bars, which is the cost that makes people not
    // bump it.
    assert.equal(usParserVersion("price_bar_d1"), PRICE_BAR_PARSER_VERSION);
    // MONEY-1616: LATEST_OCCUPANT admits rows v1 quarantined over unchanged
    // bytes, so the version is the only thing that makes those months reload.
    assert.equal(usParserVersion("price_bar_d1"), "price-bar-v2");
    assert.notEqual(
      usParserVersion("fund_nav_d1"),
      usParserVersion("price_bar_d1"),
    );
  });
});

describe("mongoSourceUri", () => {
  it("names the assertion for a row with no object behind it", () => {
    assert.equal(
      mongoSourceUri("candles", "AAPL:NASDAQ:1980-12-12:D1"),
      "mongo://candles/AAPL:NASDAQ:1980-12-12:D1",
    );
  });

  it("refuses an empty half rather than tracing back to nothing", () => {
    assert.throws(() => mongoSourceUri("", "k"), /both parts/);
    assert.throws(() => mongoSourceUri("candles", "  "), /both parts/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The DELETE's market clause — MONEY-1514 review
   ──────────────────────────────────────────────────────────────────────── */

describe("buildDeleteMonthSql scopes by market only when there is one", () => {
  // WHY THIS EXISTS. `usDeleteScope` pins which (market, dateColumn) pair a
  // caller passes, and it was already tested. What had NO test was what the
  // statement then DOES with them: mutating `scopeMarket` to a constant `true`
  // left the whole lake suite green at 317/317, while making every
  // `fund_nav_d1` delete name a column that table does not have.

  const base = {
    projectId: "p",
    dataset: "lake_silver_prod",
    fromInclusive: "2024-03-01",
    toExclusive: "2024-04-01",
    source: "TIINGO",
  };

  it("REFUSES an identifier it cannot bind — the guard travels with the interpolation", () => {
    // MONEY-1516 review (#17). `assertIdent` used to live in `replaceMonth`
    // alone; extracting and EXPORTING this function left the guard behind, so
    // every direct caller — this test file among them — interpolated `table`
    // and `dateColumn` into a DELETE unvalidated. None of these four values
    // can be bound as a parameter, so the refusal is the only protection.
    const bad: ReadonlyArray<readonly [string, Record<string, string>]> = [
      ["table", { table: "price_bar_d1`; DROP TABLE x; --" }],
      ["table", { table: "Price_Bar_D1" }], // IDENT is lower-case only
      ["dateColumn", { dateColumn: "session_date` OR TRUE --" }],
      ["projectId", { projectId: "p` , `x" }],
      ["dataset", { dataset: "lake_silver_prod`" }],
      ["projectId", { projectId: "" }],
    ];
    for (const [field, override] of bad) {
      assert.throws(
        () =>
          buildDeleteMonthSql({
            ...base,
            table: "price_bar_d1",
            market: "US",
            dateColumn: "session_date",
            ...override,
          }),
        new RegExp(field),
        `buildDeleteMonthSql accepted ${JSON.stringify(override)} — it is interpolated into SQL`,
      );
    }

    // And a REAL GCP project id must still pass: it carries hyphens, which
    // `IDENT` forbids, so guarding these two with `assertIdent` would refuse
    // every production call.
    assert.ok(
      buildDeleteMonthSql({
        ...base,
        projectId: "stock-book-483718",
        dataset: "lake_silver_prod",
        table: "price_bar_d1",
        market: "US",
        dateColumn: "session_date",
      }).query.includes("stock-book-483718"),
    );
  });

  it("fund_nav_d1 — NO market clause, because the column does not exist", () => {
    const got = buildDeleteMonthSql({
      ...base,
      table: "fund_nav_d1",
      market: null,
      dateColumn: "nav_date",
    });
    assert.ok(
      !got.query.includes("market"),
      `naming market on fund_nav_d1 fails with "Unrecognized name: market" — got:\n${got.query}`,
    );
    assert.ok(!("market" in got.params), "no market param");
    assert.ok(!("market" in got.types), "no market type");
    assert.match(got.query, /nav_date >= PARSE_DATE\('%Y-%m-%d', @from\)/);
  });

  it("price_bar_d1 — the market clause IS present, and bound", () => {
    const got = buildDeleteMonthSql({
      ...base,
      table: "price_bar_d1",
      market: "US",
      dateColumn: "session_date",
    });
    assert.match(got.query, /market = @market/);
    assert.equal(got.params["market"], "US");
    assert.equal(got.types["market"], "STRING");
    assert.match(got.query, /session_date >= PARSE_DATE\('%Y-%m-%d', @from\)/);
  });

  it("undefined is treated as absent, not as a NULL binding", () => {
    // `!== null` would take the scoped branch here and bind market as NULL.
    // `market = NULL` is UNKNOWN for every row, so the DELETE matches NOTHING
    // and the load that follows appends a duplicate month — the exact failure
    // the guard exists to refuse, through the one value a `!==` check misses.
    const got = buildDeleteMonthSql({
      ...base,
      table: "fund_nav_d1",
      market: undefined as unknown as string | null,
      dateColumn: "nav_date",
    });
    assert.ok(!got.query.includes("market"), "undefined must not scope");
    assert.ok(!("market" in got.params));
  });

  it("every scoped delete still carries the source predicate", () => {
    // This is what makes the widened-delete case survivable, and it is the
    // fact an earlier version of the comment above got wrong: India rows are
    // BHAVCOPY_HIST and can never match a TIINGO delete, whatever market does.
    for (const m of [null, "US", "IN"]) {
      const got = buildDeleteMonthSql({
        ...base,
        table: m === null ? "fund_nav_d1" : "price_bar_d1",
        market: m,
        dateColumn: m === null ? "nav_date" : "session_date",
      });
      assert.match(got.query, /AND source = @source/, `market=${String(m)}`);
      assert.equal(got.params["source"], "TIINGO");
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1538 — what the CLIENT sends, not what the builder returns
   ──────────────────────────────────────────────────────────────────────── */

describe("every lake DELETE parameter reaches BigQuery with a VALUE", () => {
  // WHY THIS EXISTS. Every assertion above inspects `params`, and all of them
  // were green while prod month-deletes bound `from`/`to` as NULL: the builder
  // returned the right strings typed `DATE`, and `@google-cloud/bigquery`
  // DROPPED them — for a DATE/TIME-family type it sends `value.value`, which a
  // string does not have. `session_date >= NULL` matched nothing, and 315,609
  // rows were appended twice. So this serialises through the client's own
  // `valueToQueryParameter_`: the layer that decides what BigQuery receives.
  const cases: ReadonlyArray<
    readonly [
      string,
      {
        query: string;
        params: Record<string, string>;
        types: Record<string, string>;
      },
    ]
  > = [
    [
      "buildDeleteMonthSql, market-scoped",
      buildDeleteMonthSql({
        projectId: "stock-book-483718",
        dataset: "lake_silver_prod",
        table: "price_bar_d1",
        market: "IN",
        fromInclusive: "1995-03-01",
        toExclusive: "1995-04-01",
        source: "BHAVCOPY_HIST",
        dateColumn: "session_date",
      }),
    ],
    [
      "buildDeleteMonthSql, no market",
      buildDeleteMonthSql({
        projectId: "stock-book-483718",
        dataset: "lake_silver_prod",
        table: "fund_nav_d1",
        market: null,
        fromInclusive: "2024-03-01",
        toExclusive: "2024-04-01",
        source: "TIINGO",
        dateColumn: "nav_date",
      }),
    ],
    [
      "buildPurgeRangeSql",
      buildPurgeRangeSql({
        projectId: "stock-book-483718",
        dataset: "lake_silver_prod",
        table: "trade_bar_h1",
        market: "US",
        source: "DATABENTO",
        fromDate: "2024-01-02",
        toDate: "2024-01-31",
      }),
    ],
  ];

  for (const [label, got] of cases) {
    it(`${label}: no parameter is serialised empty`, () => {
      for (const [name, value] of Object.entries(got.params)) {
        const sent = BigQuery.valueToQueryParameter_(value, got.types[name]);
        const v = sent.parameterValue?.value;
        assert.ok(
          v !== undefined && v !== null && v !== "",
          `${label}: @${name} (${got.types[name]}) reaches BigQuery as NULL — sent ${JSON.stringify(sent)}`,
        );
        assert.equal(v, value, `${label}: @${name} is sent as ${String(v)}`);
      }
    });

    it(`${label}: every @name in the SQL is a bound parameter`, () => {
      for (const m of got.query.matchAll(/@([a-z_]+)/g)) {
        assert.ok(
          m[1]! in got.params,
          `${label}: @${m[1]} is used but not bound`,
        );
      }
    });

    it(`${label}: the date bounds are parsed IN SQL, not typed DATE`, () => {
      // PARSE_DATE refuses a malformed bound with an error; a DATE-typed string
      // param is silently NULL. The first is the only safe way to fail.
      assert.doesNotMatch(
        JSON.stringify(got.types),
        /"(DATE|TIMESTAMP|DATETIME)"/,
      );
      assert.match(got.query, /PARSE_DATE\('%Y-%m-%d', @(from|from_date)\)/);
      assert.match(got.query, /PARSE_DATE\('%Y-%m-%d', @(to|to_date)\)/);
    });
  }
});

describe("buildPurgeRangeSql guards what it interpolates", () => {
  // Its sibling got these guards in the MONEY-1516 review; this one was never
  // extracted, so it interpolated `table`, `projectId` and `dataset` unchecked.
  const base = {
    projectId: "stock-book-483718",
    dataset: "lake_silver_prod",
    table: "trade_bar_h1",
    market: "US",
    source: "DATABENTO",
    fromDate: "2024-01-02",
    toDate: "2024-01-31",
  };
  it("refuses an identifier it cannot bind", () => {
    for (const [field, override] of [
      ["table", { table: "trade_bar_h1`; DROP TABLE x; --" }],
      ["projectId", { projectId: "p` , `x" }],
      ["dataset", { dataset: "lake_silver_prod`" }],
    ] as const) {
      assert.throws(
        () => buildPurgeRangeSql({ ...base, ...override }),
        new RegExp(field),
      );
    }
    assert.match(
      buildPurgeRangeSql(base).query,
      /stock-book-483718\.lake_silver_prod\.trade_bar_h1/,
    );
  });
});

describe("createSymbolFailureTracker — MONEY-1608 review", () => {
  it("returns a line naming the symbol and the error, for logging NOW", () => {
    const t = createSymbolFailureTracker(3);
    const line = t.fail("AAPL", new Error("403 Forbidden"));
    assert.match(line, /symbol AAPL FAILED \(1 in a row\): 403 Forbidden/);
  });

  it("aborts the walk at the limit, with a named error", () => {
    const t = createSymbolFailureTracker(3);
    t.fail("A", new Error("x"));
    t.fail("B", new Error("x"));
    assert.throws(
      () => t.fail("C", new Error("x")),
      (e: unknown) => {
        assert.ok(e instanceof WalkAbortedError);
        assert.match((e as Error).message, /WALK ABORTED: 3 consecutive/);
        assert.match((e as Error).message, /symbol C FAILED/);
        return true;
      },
    );
  });

  it("a success in between resets the run — scattered bad symbols never abort", () => {
    const t = createSymbolFailureTracker(3);
    for (let i = 0; i < 10; i++) {
      t.fail("A", new Error("x"));
      t.fail("B", new Error("x"));
      t.ok();
    }
  });

  it("defaults to 50", () => {
    assert.equal(MAX_CONSECUTIVE_SYMBOL_FAILURES, 50);
    const t = createSymbolFailureTracker();
    for (let i = 1; i < 50; i++) t.fail(`S${i}`, new Error("x"));
    assert.throws(() => t.fail("S50", new Error("x")), WalkAbortedError);
  });
});
