/**
 * (raw_symbol, date) → listingId — MONEY-1373.
 *
 * The golden case is DOW, and it is taken verbatim from the `Candle.listingId`
 * doc comment in the Prisma schema: Tiingo's master holds two NYSE rows for that
 * ticker, identical in exchange, assetType and currency —
 *
 *     DOW,NYSE,Stock,USD,1972-06-01,2017-08-31   <- Dow Chemical
 *     DOW,NYSE,Stock,USD,2019-03-20,             <- Dow Inc.
 *
 * — and the windows never overlap, so no unique index can catch a bar filed
 * under the wrong one. A resolver that returned "the current occupant" would
 * quietly attribute 2015's bars to a company that did not exist until 2019.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  QuarantineLedger,
  US_EXCHANGE_PRIORITY,
  buildListingIndex,
  clipBarsToListingWindows,
  findPhantomWindows,
  isPhantomWindow,
  latestOccupantOf,
  resolveListingForDate,
  windowCoversDate,
  type ListingRow,
} from "../../src/market-data/databento/databento-symbology";

const row = (
  o: Partial<ListingRow> & Pick<ListingRow, "symbol" | "listingId">,
): ListingRow => ({
  exchange: "NYSE",
  listingStartDate: null,
  listingEndDate: null,
  listingStatus: "ACTIVE",
  ...o,
});

const DOW_CHEMICAL = row({
  symbol: "DOW",
  listingId: "DOW:NYSE:1972-06-01",
  listingStartDate: new Date("1972-06-01T00:00:00Z"),
  listingEndDate: new Date("2017-08-31T00:00:00Z"),
  listingStatus: "DELISTED",
});
const DOW_INC = row({
  symbol: "DOW",
  listingId: "DOW:NYSE:2019-03-20",
  listingStartDate: new Date("2019-03-20T00:00:00Z"),
  listingEndDate: null,
  listingStatus: "ACTIVE",
});
const DOW = [DOW_CHEMICAL, DOW_INC];

describe("GOLDEN: DOW is two companies and the DATE decides which", () => {
  it("a 2015 bar is Dow Chemical", () => {
    const r = resolveListingForDate(DOW, new Date("2015-06-01T14:30:00Z"));
    assert.ok(r.ok);
    assert.equal(r.listing.listingId, "DOW:NYSE:1972-06-01");
    assert.equal(r.listing.listingStatus, "DELISTED");
  });

  it("a 2024 bar is Dow Inc.", () => {
    const r = resolveListingForDate(DOW, new Date("2024-01-02T14:30:00Z"));
    assert.ok(r.ok);
    assert.equal(r.listing.listingId, "DOW:NYSE:2019-03-20");
  });

  it("a bar in the GAP between them resolves to NEITHER", () => {
    // 2018 — after Dow Chemical delisted, before Dow Inc. listed. There is no
    // right answer, so there is no answer: the row is quarantined and counted.
    const r = resolveListingForDate(DOW, new Date("2018-06-01T14:30:00Z"));
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "none");
  });

  it("the LAST session of a listing still belongs to it", () => {
    // A bar stamped 15:59 on the delisting date. Comparing against the raw date
    // instead of the end of that day would drop every bar of the one session a
    // delisting makes interesting.
    const r = resolveListingForDate(DOW, new Date("2017-08-31T19:59:00Z"));
    assert.ok(r.ok);
    assert.equal(r.listing.listingId, "DOW:NYSE:1972-06-01");
  });

  it("the day AFTER the end date does not", () => {
    const r = resolveListingForDate(DOW, new Date("2017-09-01T13:30:00Z"));
    assert.equal(r.ok, false);
  });

  it("the first SESSION of a listing belongs to it", () => {
    // 04:00 ET on the start date — the first instant of that ET session.
    //
    // This used to assert `2019-03-20T00:00:00Z`, which is UTC midnight and
    // therefore 20:00 ET on 2019-03-19: the tail of the PREVIOUS session, and
    // a bar there belongs to the day before. The bound is an ET session now,
    // on both sides, so the fixture had to name an instant that is actually
    // inside it.
    const r = resolveListingForDate(DOW, new Date("2019-03-20T08:00:00Z"));
    assert.ok(r.ok);
    assert.equal(r.listing.listingId, "DOW:NYSE:2019-03-20");
  });

  it("the POST-MARKET hour of the final session still belongs to it", () => {
    // THE DEFECT THIS BOUND WAS FIXED FOR. Under EST the 19:00-19:59 ET hour
    // of session D lands on UTC D+1, and the end bound was a UTC day-end — so
    // that hour fell OUTSIDE the listing that traded it. Measured on the QA
    // master: 768 sessions lost the hour to quarantine and 48 had it stamped
    // with a DIFFERENT security's listingId.
    //
    // Dow Chemical's last session is 2017-08-31; 19:30 ET that day is
    // 2017-08-31T23:30Z (EDT), and 00:30Z on 2017-09-01 would be the EST
    // equivalent. Both must resolve to the 1972 listing, never the 2019 one.
    const r = resolveListingForDate(DOW, new Date("2017-08-31T23:30:00Z"));
    assert.ok(r.ok, "the final session's post-market hour was quarantined");
    assert.equal(r.listing.listingId, "DOW:NYSE:1972-06-01");
  });
});

describe("windowCoversDate — open bounds are open", () => {
  it("a listing with no start has always existed as far as we know", () => {
    const r = row({
      symbol: "X",
      listingId: "X:NYSE:",
      listingEndDate: new Date("2020-01-10T00:00:00Z"),
    });
    assert.equal(windowCoversDate(r, new Date("1970-01-01T00:00:00Z")), true);
    // 2020-01-11T00:00Z is 19:00 ET on 2020-01-10 — the final session's
    // post-market, which DOES belong. The day after does not.
    assert.equal(windowCoversDate(r, new Date("2020-01-11T00:00:00Z")), true);
    assert.equal(windowCoversDate(r, new Date("2020-01-12T00:00:00Z")), false);
  });

  it("a listing with no end is still trading", () => {
    const r = row({
      symbol: "X",
      listingId: "X:NYSE:2020",
      listingStartDate: new Date("2020-01-01T00:00:00Z"),
    });
    assert.equal(windowCoversDate(r, new Date("2099-01-01T00:00:00Z")), true);
  });
});

describe("a symbol we hold no row for is a QUARANTINE, not a guess", () => {
  it("an unknown symbol resolves to none", () => {
    assert.deepEqual(
      resolveListingForDate(undefined, new Date("2024-01-02T00:00:00Z")),
      {
        ok: false,
        reason: "none",
        candidates: 0,
      },
    );
  });

  it("an empty window list resolves to none", () => {
    assert.equal(
      resolveListingForDate([], new Date("2024-01-02T00:00:00Z")).ok,
      false,
    );
  });
});

describe("a dual-VENUE listing is one security; a recycled ticker is two", () => {
  const dualA = row({
    symbol: "FOO",
    exchange: "BATS",
    listingId: "FOO:BATS:2020-01-01",
    listingStartDate: new Date("2020-01-01T00:00:00Z"),
  });
  const dualB = row({
    symbol: "FOO",
    exchange: "NASDAQ",
    listingId: "FOO:NASDAQ:2020-01-01",
    listingStartDate: new Date("2020-01-01T00:00:00Z"),
  });

  it("resolves a dual-venue listing by the DECLARED priority, and says so", () => {
    const r = resolveListingForDate(
      [dualA, dualB],
      new Date("2024-01-02T00:00:00Z"),
    );
    assert.ok(r.ok);
    assert.equal(r.listing.exchange, "NASDAQ");
    assert.equal(r.multiVenue, true);
  });

  it("the priority is order-independent — the INPUT order must not decide", () => {
    const a = resolveListingForDate(
      [dualA, dualB],
      new Date("2024-01-02T00:00:00Z"),
    );
    const b = resolveListingForDate(
      [dualB, dualA],
      new Date("2024-01-02T00:00:00Z"),
    );
    assert.deepEqual(a, b);
  });

  it("QUARANTINES two overlapping windows with DIFFERENT start dates", () => {
    // Same venue or not, two different start dates are two different
    // securities. A tolerance window here would merge two companies that
    // happened to list in the same week.
    const other = row({
      symbol: "FOO",
      exchange: "NYSE",
      listingId: "FOO:NYSE:2021-06-01",
      listingStartDate: new Date("2021-06-01T00:00:00Z"),
    });
    const r = resolveListingForDate(
      [dualA, other],
      new Date("2024-01-02T00:00:00Z"),
    );
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "ambiguous");
    assert.equal((r as { candidates: number }).candidates, 2);
  });

  it("QUARANTINES two overlapping windows on ONE venue", () => {
    const twin = row({
      symbol: "FOO",
      exchange: "BATS",
      listingId: "FOO:BATS:2020-01-01-dup",
      listingStartDate: new Date("2020-01-01T00:00:00Z"),
    });
    const r = resolveListingForDate(
      [dualA, twin],
      new Date("2024-01-02T00:00:00Z"),
    );
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "ambiguous");
  });

  it("the venue priority is a real list, so the test is not vacuous", () => {
    assert.ok(US_EXCHANGE_PRIORITY.length >= 5);
    assert.equal(US_EXCHANGE_PRIORITY[0], "NASDAQ");
  });
});

describe("buildListingIndex", () => {
  it("groups by symbol, case- and whitespace-insensitively", () => {
    const idx = buildListingIndex([
      DOW_CHEMICAL,
      DOW_INC,
      row({ symbol: " aapl ", listingId: "A" }),
    ]);
    assert.equal(idx.get("DOW")!.length, 2);
    assert.equal(idx.get("AAPL")!.length, 1);
  });
});

describe("QuarantineLedger — a count alone cannot be acted on", () => {
  it("records the SPAN per symbol, so one dead ticker reads differently from one bad file", () => {
    const led = new QuarantineLedger();
    led.add("ZZZZ", "none", new Date("2023-05-01T00:00:00Z"));
    led.add("ZZZZ", "none", new Date("2024-11-30T00:00:00Z"));
    led.add("ZZZZ", "none", new Date("2023-06-01T00:00:00Z"));
    const s = led.summary();
    assert.equal(s.quarantinedSymbols, 1);
    assert.equal(s.quarantinedRows, 3);
    assert.equal(s.sample[0]!.firstDate, "2023-05-01");
    assert.equal(s.sample[0]!.lastDate, "2024-11-30");
  });

  it("keeps the two reasons apart and reports the dominant one", () => {
    const led = new QuarantineLedger();
    led.add("A", "ambiguous", new Date("2024-01-02T00:00:00Z"));
    led.add("A", "ambiguous", new Date("2024-01-03T00:00:00Z"));
    led.add("A", "none", new Date("2024-01-04T00:00:00Z"));
    assert.equal(led.summary().sample[0]!.reason, "ambiguous");
  });

  it("ranks the worst offenders first and bounds the sample", () => {
    const led = new QuarantineLedger();
    for (let i = 0; i < 50; i++) {
      led.add(`S${i}`, "none", new Date("2024-01-02T00:00:00Z"));
    }
    for (let i = 0; i < 9; i++)
      led.add("LOUD", "none", new Date("2024-01-02T00:00:00Z"));
    const s = led.summary(5);
    assert.equal(s.sample.length, 5);
    assert.equal(s.sample[0]!.symbol, "LOUD");
    assert.equal(s.quarantinedSymbols, 51);
    assert.equal(s.quarantinedRows, 59);
  });
});

/* ── MONEY-1617 — phantom windows and the writer clip ─────────────────── */

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const win = (
  listingId: string,
  start: string | null,
  end: string | null,
  exchange = "NYSE",
  listingStatus = "ACTIVE",
): ListingRow =>
  row({
    symbol: listingId.split(":")[0]!,
    exchange,
    listingId,
    listingStartDate: start ? d(start) : null,
    listingEndDate: end ? d(end) : null,
    listingStatus,
  });
/** A session's 04:00 ET open — the instant every resolver here uses. */
const open = (iso: string): Date => new Date(`${iso}T09:00:00Z`);

// Prod 2026-09-24: a ONE-day row created 09-22 inside a 1987 window.
const GAB_1987 = win("GAB:NYSE:1987-11-05", "1987-11-05", "2026-09-23");
const GAB_PHANTOM = win(
  "GAB:NYSE:2026-09-21",
  "2026-09-21",
  "2026-09-21",
  "NYSE",
  "DELISTED",
);

describe("MONEY-1617 — a phantom window loses a tie, and only a tie", () => {
  it("GAB: a one-day row inside a longer one is a phantom", () => {
    assert.equal(isPhantomWindow(GAB_PHANTOM, [GAB_1987, GAB_PHANTOM]), true);
    assert.equal(isPhantomWindow(GAB_1987, [GAB_1987, GAB_PHANTOM]), false);
  });

  it("the session both cover resolves to the LONGER window", () => {
    const r = resolveListingForDate(
      [GAB_PHANTOM, GAB_1987],
      open("2026-09-21"),
    );
    assert.ok(r.ok);
    assert.equal(r.listing.listingId, "GAB:NYSE:1987-11-05");
  });

  it("a session ONLY the short window covers still resolves to it", () => {
    // IPO start-date restatement (29 of prod's 80): nothing else covers
    // 06-25..06-29, so excluding the short row would unresolve real sessions.
    const early = win(
      "DSC:NASDAQ:2026-06-25",
      "2026-06-25",
      "2026-06-30",
      "NASDAQ",
    );
    const later = win(
      "DSC:NASDAQ:2026-06-29",
      "2026-06-29",
      "2026-09-22",
      "NASDAQ",
    );
    const both = [early, later];
    assert.equal(isPhantomWindow(early, both), true);
    const r = resolveListingForDate(both, open("2026-06-26"));
    assert.ok(r.ok);
    assert.equal(r.listing.listingId, early.listingId);
    const tie = resolveListingForDate(both, open("2026-06-30"));
    assert.ok(tie.ok);
    assert.equal(tie.listing.listingId, later.listingId);
  });

  it("is per VENUE: a short row on another exchange is not a phantom of this one", () => {
    const other = win(
      "GAB:NASDAQ:2026-09-21",
      "2026-09-21",
      "2026-09-21",
      "NASDAQ",
    );
    assert.equal(isPhantomWindow(other, [GAB_1987, other]), false);
  });

  it("six days is not a phantom; two short rows are not phantoms of each other", () => {
    const six = win("GAB:NYSE:2026-09-10", "2026-09-10", "2026-09-16");
    assert.equal(isPhantomWindow(six, [GAB_1987, six]), false);
    const a = win("X:NYSE:2026-01-01", "2026-01-01", "2026-01-03");
    const b = win("X:NYSE:2026-01-02", "2026-01-02", "2026-01-04");
    assert.equal(isPhantomWindow(a, [a, b]), false);
  });

  it("a short NEW occupant overlapping its predecessor's LAST day is a handover, not a phantom", () => {
    // The predecessor ends 09-21 (DELISTED); the new row runs 09-21..09-23 and
    // outlasts it. Handing 09-22 back to the predecessor would be the DOW hazard.
    const OLD = win(
      "HND:NYSE:1990-01-02",
      "1990-01-02",
      "2026-09-21",
      "NYSE",
      "DELISTED",
    );
    const NEW = win("HND:NYSE:2026-09-21", "2026-09-21", "2026-09-23");
    assert.equal(isPhantomWindow(NEW, [OLD, NEW]), false);
    // Same short row INSIDE a window that outlasts it stays a phantom.
    const LONGER = { ...OLD, listingEndDate: d("2026-09-23") };
    assert.equal(isPhantomWindow(NEW, [LONGER, NEW]), true);
  });

  it("findPhantomWindows reports exactly the phantoms of a master", () => {
    const found = findPhantomWindows([
      GAB_1987,
      GAB_PHANTOM,
      DOW_CHEMICAL,
      DOW_INC,
    ]);
    assert.deepEqual(
      found.map((w) => w.listingId),
      ["GAB:NYSE:2026-09-21"],
    );
  });
});

const bar = (date: string) => ({ date, close: 1 });

describe("MONEY-1617 — clipBarsToListingWindows files each bar under its window", () => {
  // RAM, measured: the 2021 row now ENDS 2023-03-31 and a 2026-06-24 row exists.
  const RAM_OLD = win(
    "RAM:NASDAQ:2021-07-09",
    "2021-07-09",
    "2023-03-31",
    "NASDAQ",
    "DELISTED",
  );
  const RAM_NEW = win(
    "RAM:NASDAQ:2026-06-24",
    "2026-06-24",
    "2026-09-22",
    "NASDAQ",
  );

  it("before, inside, in the GAP between two windows, and after", () => {
    // Both DELISTED here, so "after" is a real end; the ACTIVE case is below.
    const NEW_ENDED = { ...RAM_NEW, listingStatus: "DELISTED" };
    const r = clipBarsToListingWindows({
      bars: [
        bar("2021-07-08"), // before every window
        bar("2022-01-03"), // inside the OLD window
        bar("2024-01-02"), // the gap
        bar("2026-07-01"), // inside the NEW window
        bar("2026-09-30"), // after every window
      ],
      windows: [RAM_OLD, NEW_ENDED],
      fetched: NEW_ENDED,
    });
    assert.deepEqual(
      r.kept.map((k) => [k.bar.date, k.listingId, k.listingStatus]),
      [
        ["2022-01-03", RAM_OLD.listingId, "DELISTED"],
        ["2026-07-01", RAM_NEW.listingId, "DELISTED"],
      ],
    );
    assert.deepEqual(r.dropped, {
      OUTSIDE_EVERY_WINDOW: 3,
      AMBIGUOUS_WINDOW: 0,
    });
  });

  it("an ACTIVE window is open-ended: the master lagging a session must not drop the newest bar", () => {
    // RAM_NEW's master end is 2026-09-22; the nightly fetches 09-23 on a night
    // Tiingo's master has not caught up. A DELISTED end is a real end.
    const r = clipBarsToListingWindows({
      bars: [bar("2026-09-23"), bar("2023-04-03"), bar("2022-01-03")],
      windows: [RAM_OLD, RAM_NEW],
      fetched: RAM_NEW,
    });
    // ...and a bar filed under the OLD window carries ITS status, not the
    // fetched one's — the status routes it to the delisted cold tier.
    assert.deepEqual(
      r.kept.map((k) => [k.listingId, k.listingStatus]),
      [
        [RAM_NEW.listingId, "ACTIVE"],
        [RAM_OLD.listingId, "DELISTED"],
      ],
    );
    assert.equal(r.dropped.OUTSIDE_EVERY_WINDOW, 1);
  });

  it("the fetched listing is a window even when the sibling lookup came back empty", () => {
    const r = clipBarsToListingWindows({
      bars: [bar("2026-07-01"), bar("2026-01-02")],
      windows: [],
      fetched: RAM_NEW,
    });
    assert.deepEqual(
      r.kept.map((k) => k.listingId),
      [RAM_NEW.listingId],
    );
    assert.equal(r.dropped.OUTSIDE_EVERY_WINDOW, 1);
  });

  it("GAB: fetching the PHANTOM row files the session under the long window", () => {
    const r = clipBarsToListingWindows({
      bars: [bar("2026-09-21")],
      windows: [GAB_1987, GAB_PHANTOM],
      fetched: GAB_PHANTOM,
    });
    assert.equal(r.kept[0]!.listingId, GAB_1987.listingId);
  });

  describe("MONEY-1617 review — a tie goes to the fetched listing only when it is the OCCUPANT", () => {
    // Prod's B: Barnes Group to 2025 and Barrick from 1985 (its ABX history),
    // both NYSE. Tiingo serves only the current occupant, so a --only-delisted
    // fetch of Barnes receives BARRICK's series.
    const BARNES = win(
      "B:NYSE:1985-02-04",
      "1985-02-04",
      "2025-07-02",
      "NYSE",
      "DELISTED",
    );
    const BARRICK = win("B:NYSE:1985-06-24", "1985-06-24", "2026-09-22");

    it("a DELISTED fetch that is not the latest occupant DROPS the shared sessions", () => {
      const r = clipBarsToListingWindows({
        bars: [bar("2024-06-03"), bar("1985-03-01")],
        windows: [BARNES, BARRICK],
        fetched: BARNES,
      });
      // 1985-03-01: only Barnes covers it — resolved, not a tie.
      assert.deepEqual(
        r.kept.map((k) => k.listingId),
        [BARNES.listingId],
      );
      assert.equal(r.dropped.AMBIGUOUS_WINDOW, 1);
    });

    it("the ACTIVE occupant keeps them, exactly as before", () => {
      const r = clipBarsToListingWindows({
        bars: [bar("2024-06-03")],
        windows: [BARNES, BARRICK],
        fetched: BARRICK,
      });
      assert.deepEqual(
        r.kept.map((k) => k.listingId),
        [BARRICK.listingId],
      );
    });

    it("an ACTIVE fetch keeps a tie even when the occupant rule has no answer (two ACTIVE rows end together)", () => {
      // latestOccupantOf is null on a tie; the nightly's behaviour must not move.
      const TWIN = win("B:NYSE:2020-01-02", "2020-01-02", "2026-09-22");
      const r = clipBarsToListingWindows({
        bars: [bar("2024-06-03")],
        windows: [BARRICK, TWIN],
        fetched: TWIN,
      });
      assert.deepEqual(
        r.kept.map((k) => k.listingId),
        [TWIN.listingId],
      );
    });

    it("a DELISTED fetch that IS the unique latest occupant keeps them", () => {
      const EARLY = {
        ...BARRICK,
        listingStatus: "DELISTED",
        listingEndDate: d("2020-01-02"),
      };
      const r = clipBarsToListingWindows({
        bars: [bar("2010-06-01")],
        windows: [EARLY, BARNES],
        fetched: BARNES,
      });
      assert.deepEqual(
        r.kept.map((k) => k.listingId),
        [BARNES.listingId],
      );
    });

    it("the occupant is named from EVERY venue when the caller supplies them", () => {
      // Barnes is latest on NYSE, but the symbol's occupant trades on NASDAQ.
      const EARLY = {
        ...BARRICK,
        listingStatus: "DELISTED",
        listingEndDate: d("2020-01-02"),
      };
      const ELSEWHERE = win(
        "B:NASDAQ:2025-07-03",
        "2025-07-03",
        "2026-09-22",
        "NASDAQ",
      );
      const r = clipBarsToListingWindows({
        bars: [bar("2010-06-01")],
        windows: [EARLY, BARNES],
        fetched: BARNES,
        symbolWindows: [EARLY, BARNES, ELSEWHERE],
      });
      assert.equal(r.kept.length, 0);
      assert.equal(r.dropped.AMBIGUOUS_WINDOW, 1);
    });

    it("latestOccupantOf: unique latest wins; a tie, a single window or an Invalid Date is null", () => {
      assert.equal(
        latestOccupantOf([BARNES, BARRICK])?.listingId,
        BARRICK.listingId,
      );
      assert.equal(latestOccupantOf([BARRICK]), null);
      assert.equal(
        latestOccupantOf([
          BARRICK,
          { ...BARNES, listingEndDate: d("2026-09-22") },
        ]),
        null,
      );
      assert.equal(
        latestOccupantOf([BARNES, { ...BARRICK, listingEndDate: null }])
          ?.listingEndDate,
        null,
      );
      assert.equal(
        latestOccupantOf([
          BARRICK,
          { ...BARNES, listingEndDate: new Date("nope") },
        ]),
        null,
      );
    });
  });

  it("two REAL overlapping windows: the fetched one keeps the bar; another is never guessed", () => {
    const a = win(
      "SLVR:NASDAQ:2021-11-01",
      "2021-11-01",
      "2026-06-08",
      "NASDAQ",
    );
    const b = win(
      "SLVR:NASDAQ:2025-01-15",
      "2025-01-15",
      "2026-09-22",
      "NASDAQ",
    );
    const mine = clipBarsToListingWindows({
      bars: [bar("2025-06-02")],
      windows: [a, b],
      fetched: b,
    });
    assert.equal(mine.kept[0]!.listingId, b.listingId);
    const c = win(
      "SLVR:NASDAQ:2026-08-01",
      "2026-08-01",
      "2026-09-22",
      "NASDAQ",
    );
    const neither = clipBarsToListingWindows({
      bars: [bar("2025-06-02")],
      windows: [a, b, c],
      fetched: c,
    });
    assert.equal(neither.kept.length, 0);
    assert.equal(neither.dropped.AMBIGUOUS_WINDOW, 1);
  });
});
