/**
 * Security identity. MONEY-1498 (data-platform B3).
 *
 * THE DOW CASE IS THE POINT OF THE TICKET and it is the first describe block:
 * one `DOW`/`NYSE` key must resolve to Dow Chemical for a 2017 as-of and Dow
 * Inc. for a 2020 one. Everything else here exists to stop that answer being
 * arrived at by luck.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveHeads,
  archiveIsCurrent,
  assertEnrichIsSafe,
  assertIsoDate,
  classifyInactive,
  confidenceFor,
  diffListings,
  endDateToValidTo,
  firstVersions,
  IDENTITY_FIELDS,
  IdentityEnrichError,
  inactivePrecedence,
  InvalidDateError,
  isListingStatus,
  isMapMethod,
  isMarket,
  isSourceSystem,
  MAP_METHODS,
  MIN_JOIN_CONFIDENCE,
  nextDay,
  planRebase,
  resolveListing,
  resolveSymbol,
  SOURCE_SYSTEMS,
  tradedTo,
  windowContains,
  type IncomingListing,
  type ListingRow,
  type SourceMapRow,
} from "../src/identity-logic";

/* ─────────────────────────────────────────────────────────────────────────
   Fixtures — the two occupants of DOW, from the real Tiingo master rows
   quoted in `model Candle` (schema.prisma).
   ──────────────────────────────────────────────────────────────────────── */

const DOW_CHEMICAL = "DOW:NYSE:1972-06-01";
const DOW_INC = "DOW:NYSE:2019-03-20";

/** As the seed builds them: the vendor's INCLUSIVE end date is converted. */
const DOW_MAP: SourceMapRow[] = [
  {
    source: "TIINGO",
    sourceKey: "DOW",
    listingId: DOW_CHEMICAL,
    validFrom: "1972-06-01",
    validTo: endDateToValidTo("2017-08-31"), // -> 2017-09-01, EXCLUSIVE
    method: "VENDOR_NATIVE",
    confidence: confidenceFor("VENDOR_NATIVE"),
  },
  {
    source: "TIINGO",
    sourceKey: "DOW",
    listingId: DOW_INC,
    validFrom: "2019-03-20",
    validTo: null,
    method: "VENDOR_NATIVE",
    confidence: confidenceFor("VENDOR_NATIVE"),
  },
];

function resolveDow(asOf: string) {
  return resolveListing(DOW_MAP, { source: "TIINGO", sourceKey: "DOW", asOf });
}

describe("resolveListing — the DOW case", () => {
  it("2017 resolves to Dow Chemical", () => {
    assert.equal(resolveDow("2017-06-15")?.listingId, DOW_CHEMICAL);
  });

  it("2020 resolves to Dow Inc.", () => {
    assert.equal(resolveDow("2020-06-15")?.listingId, DOW_INC);
  });

  it("the two answers are DIFFERENT — the whole point", () => {
    // Stated as its own case so a future change that collapses both windows
    // onto one listing fails here and not only in a count somewhere.
    assert.notEqual(
      resolveDow("2017-06-15")?.listingId,
      resolveDow("2020-06-15")?.listingId,
    );
  });

  it("Dow Chemical's FINAL TRADING DAY still resolves to Dow Chemical", () => {
    // The vendor says 2017-08-31 inclusive. Storing that verbatim as an
    // EXCLUSIVE valid_to makes the ticker belong to nobody on its own last
    // session — a hole that reads as "no data" rather than as an error.
    assert.equal(resolveDow("2017-08-31")?.listingId, DOW_CHEMICAL);
  });

  it("the day AFTER the last trading day resolves to nobody", () => {
    assert.equal(resolveDow("2017-09-01"), null);
  });

  it("the GAP between the two companies resolves to nobody, not to a guess", () => {
    // 2017-09-01 .. 2019-03-19: the ticker was genuinely unoccupied. Returning
    // the nearest listing here is how one company's bars get another's id.
    assert.equal(resolveDow("2018-06-15"), null);
  });

  it("Dow Inc.'s first day resolves to Dow Inc.", () => {
    assert.equal(resolveDow("2019-03-20")?.listingId, DOW_INC);
  });

  it("a half-open window admits EXACTLY ONE row on a same-day handover", () => {
    // SCD-2 closes with valid_to = today and opens with valid_from = today.
    // Closed-at-both-ends intervals would match BOTH rows on that day.
    const handover: SourceMapRow[] = [
      { ...DOW_MAP[0]!, validFrom: "2000-01-01", validTo: "2020-05-01" },
      { ...DOW_MAP[1]!, validFrom: "2020-05-01", validTo: null },
    ];
    const hits = handover.filter((r) =>
      windowContains(r.validFrom, r.validTo, "2020-05-01"),
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.listingId, DOW_INC);
  });
});

describe("resolveListing — matching and ranking", () => {
  it("an unknown key is an ABSENCE, never a nearest match", () => {
    assert.equal(
      resolveListing(DOW_MAP, {
        source: "TIINGO",
        sourceKey: "NOPE",
        asOf: "2020-01-01",
      }),
      null,
    );
  });

  it("the SOURCE is part of the key — the same string from another vendor does not match", () => {
    assert.equal(
      resolveListing(DOW_MAP, {
        source: "KITE",
        sourceKey: "DOW",
        asOf: "2020-01-01",
      }),
      null,
    );
  });

  it("a key is trimmed but NOT case-folded", () => {
    assert.equal(
      resolveListing(DOW_MAP, {
        source: "TIINGO",
        sourceKey: "  DOW  ",
        asOf: "2020-01-01",
      })?.listingId,
      DOW_INC,
    );
    // Upper-casing would merge keys two vendors chose to spell differently.
    assert.equal(
      resolveListing(DOW_MAP, {
        source: "TIINGO",
        sourceKey: "dow",
        asOf: "2020-01-01",
      }),
      null,
    );
  });

  it("an empty key resolves to nothing rather than matching an empty stored key", () => {
    assert.equal(
      resolveListing(DOW_MAP, {
        source: "TIINGO",
        sourceKey: "   ",
        asOf: "2020-01-01",
      }),
      null,
    );
  });

  it("a DATED row outranks an UNDATED alias that also matches", () => {
    // An undated alias matches EVERY as-of by construction, so without the
    // datedness rung a previousSymbols row would win on the real listing's own
    // trading days.
    const rows: SourceMapRow[] = [
      {
        source: "NSE",
        sourceKey: "ETERNAL",
        listingId: "ETERNAL:NSE:2024-07-23",
        validFrom: "2024-07-23",
        validTo: null,
        method: "SYMBOL_VENUE_CURRENT",
        confidence: confidenceFor("SYMBOL_VENUE_CURRENT"),
      },
      {
        source: "NSE",
        sourceKey: "ETERNAL",
        listingId: "SOMETHINGELSE:NSE:1999-01-01",
        validFrom: null,
        validTo: null,
        method: "SYMBOL_ALIAS_UNDATED",
        confidence: confidenceFor("SYMBOL_ALIAS_UNDATED"),
      },
    ];
    const hit = resolveListing(rows, {
      source: "NSE",
      sourceKey: "ETERNAL",
      asOf: "2026-01-01",
    });
    assert.equal(hit?.listingId, "ETERNAL:NSE:2024-07-23");
    assert.equal(hit?.ambiguous, false);
  });

  it("a DATED row beats an UNDATED one of HIGHER confidence — the rung that earns its place", () => {
    // Neither of the two cases above proves the datedness rung, and both were
    // written believing they did. Measured with the rung deleted: both still
    // pass. The confidence rung decides the first, and the third rung's
    // `validFrom ?? ""` — which sorts an undated row last anyway — decides the
    // second.
    //
    // The rung bites in exactly one shape: an UNDATED row whose confidence is
    // HIGHER. Without it, confidence wins and a row that matches EVERY as-of by
    // construction outranks a real window — so a 2010 query would be answered
    // by a claim that says nothing about 2010.
    const rows: SourceMapRow[] = [
      {
        source: "TIINGO",
        sourceKey: "BRKL",
        listingId: "BRKL:NASDAQ:unknown",
        validFrom: null, // `buildListingId`'s real `unknown` branch
        validTo: null,
        method: "VENDOR_NATIVE",
        confidence: confidenceFor("VENDOR_NATIVE"), // 1.0 — the HIGHER one
      },
      {
        source: "TIINGO",
        sourceKey: "BRKL",
        listingId: "BRKL:NASDAQ:1998-03-24",
        validFrom: "1998-03-24",
        validTo: null,
        method: "SYMBOL_VENUE_DATED",
        confidence: confidenceFor("SYMBOL_VENUE_DATED"), // 0.9 — the LOWER one
      },
    ];
    assert.ok(
      confidenceFor("VENDOR_NATIVE") > confidenceFor("SYMBOL_VENUE_DATED"),
      "the fixture is only meaningful while the undated row is the more confident one",
    );

    const hit = resolveListing(rows, {
      source: "TIINGO",
      sourceKey: "BRKL",
      asOf: "2010-01-01",
    });
    assert.equal(
      hit?.listingId,
      "BRKL:NASDAQ:1998-03-24",
      "the DATED row must win",
    );
    assert.equal(hit?.dated, true);
    assert.equal(hit?.ambiguous, false);
  });

  it("two indistinguishable candidates naming DIFFERENT listings are flagged ambiguous", () => {
    const rows: SourceMapRow[] = [
      { ...DOW_MAP[1]!, listingId: "A:NYSE:2019-03-20" },
      { ...DOW_MAP[1]!, listingId: "B:NYSE:2019-03-20" },
    ];
    const hit = resolveListing(rows, {
      source: "TIINGO",
      sourceKey: "DOW",
      asOf: "2020-01-01",
    });
    assert.ok(hit);
    assert.equal(hit.ambiguous, true);
  });

  it("two identical candidates naming the SAME listing are not ambiguous", () => {
    const hit = resolveListing([DOW_MAP[1]!, { ...DOW_MAP[1]! }], {
      source: "TIINGO",
      sourceKey: "DOW",
      asOf: "2020-01-01",
    });
    assert.equal(hit?.ambiguous, false);
  });
});

describe("map confidence", () => {
  it("every declared method has a confidence — no method can be silently unpriced", () => {
    for (const m of MAP_METHODS) {
      const c = confidenceFor(m);
      assert.ok(c > 0 && c <= 1, `${m} -> ${c}`);
    }
  });

  it("an UNDATED alias sits exactly ON the join floor and a NAME match below it", () => {
    assert.equal(confidenceFor("SYMBOL_ALIAS_UNDATED"), MIN_JOIN_CONFIDENCE);
    assert.ok(confidenceFor("NAME_FUZZY") < MIN_JOIN_CONFIDENCE);
  });

  it("a NAME_FUZZY row is stored but never used as a join key", () => {
    // It is worth STORING — it is how an operator finds candidates — and
    // implausible to silently hang a price series on.
    const rows: SourceMapRow[] = [
      {
        source: "SEC",
        sourceKey: "Dow Chemical Company",
        listingId: DOW_CHEMICAL,
        validFrom: "1972-06-01",
        validTo: null,
        method: "NAME_FUZZY",
        confidence: confidenceFor("NAME_FUZZY"),
      },
    ];
    const q = {
      source: "SEC",
      sourceKey: "Dow Chemical Company",
      asOf: "2000-01-01",
    } as const;
    assert.equal(resolveListing(rows, q), null);
    // ...and reachable when a caller deliberately lowers the floor to triage.
    assert.equal(
      resolveListing(rows, { ...q, minConfidence: 0 })?.listingId,
      DOW_CHEMICAL,
    );
  });

  it("India's current-only seed is priced BELOW a dated match, because it is a guess", () => {
    // `InstrumentMapping` is overwritten on every instrument-sync, so it
    // asserts today and nothing else. The number is how the table says so.
    assert.ok(
      confidenceFor("SYMBOL_VENUE_CURRENT") <
        confidenceFor("SYMBOL_VENUE_DATED"),
      "a current-only claim must never outrank a dated one",
    );
  });

  it("A US answer is DATED and an India current-only answer is NOT", () => {
    // The field a point-in-time reader checks. Without it, "we know this was
    // true in 2017" and "we know this is true now and nothing about 2017" are
    // the same shape, and the second reads exactly like the first.
    assert.equal(resolveDow("2017-06-15")?.dated, true);

    const india: SourceMapRow[] = [
      {
        source: "NSE",
        sourceKey: "RELIANCE",
        listingId: "RELIANCE:NSE:unknown",
        // UNDATED on purpose: NSE symbol-change history is not archived by
        // this repo, so a `valid_from` here would be fabricated.
        validFrom: null,
        validTo: null,
        method: "SYMBOL_VENUE_CURRENT",
        confidence: confidenceFor("SYMBOL_VENUE_CURRENT"),
      },
    ];
    const hit = resolveListing(india, {
      source: "NSE",
      sourceKey: "RELIANCE",
      // An as-of from LONG before the seed. The row still matches — a price
      // join needs it to — but the answer says it is not a dated claim.
      asOf: "2005-01-01",
    });
    assert.equal(hit?.listingId, "RELIANCE:NSE:unknown");
    assert.equal(
      hit?.dated,
      false,
      "an India current-only answer must not claim a window",
    );
    assert.equal(hit?.method, "SYMBOL_VENUE_CURRENT");
  });

  it("an unknown method THROWS rather than defaulting to a number nobody chose", () => {
    assert.throws(
      () => confidenceFor("MADE_UP" as never),
      /no confidence declared/,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   SCD-2
   ──────────────────────────────────────────────────────────────────────── */

const BASE: ListingRow = {
  listingId: "ZOMATO:NSE:2021-07-23",
  market: "IN",
  venue: "NSE",
  symbol: "ZOMATO",
  isin: "INE758T01015",
  name: "Zomato Limited",
  assetType: "EQUITY",
  currency: "INR",
  status: "ACTIVE",
  validFrom: "2021-07-23",
  validTo: null,
  permaTicker: null,
  cik10: null,
  cusip: null,
  sector: "Consumer Services",
  industry: "Food Delivery",
  source: "NSE",
};

function incomingFrom(
  row: ListingRow,
  patch: Partial<IncomingListing> = {},
): IncomingListing {
  const { validFrom: _f, validTo: _t, ...rest } = row;
  return { ...rest, listedFrom: null, listedTo: null, ...patch };
}

describe("diffListings — SCD-2 closes and opens, never updates in place", () => {
  it("a renamed symbol CLOSES the old row and OPENS a successor", () => {
    const d = diffListings({
      current: [BASE],
      incoming: [
        incomingFrom(BASE, { symbol: "ETERNAL", name: "Eternal Limited" }),
      ],
      today: "2026-09-22",
    });

    assert.equal(d.close.length, 1);
    assert.equal(d.open.length, 1);
    assert.equal(d.enrich.length, 0, "a rename is NEVER an in-place edit");
    assert.equal(d.unchanged, 0);

    assert.equal(d.close[0]!.validTo, "2026-09-22");
    assert.equal(
      d.close[0]!.validFrom,
      BASE.validFrom,
      "the close addresses the row by its START",
    );
    assert.match(d.close[0]!.reason, /symbol/);

    assert.equal(d.open[0]!.symbol, "ETERNAL");
    assert.equal(d.open[0]!.validFrom, "2026-09-22");
    assert.equal(d.open[0]!.validTo, null);
  });

  it("the close and the open MEET — no gap, no overlap, on the same day", () => {
    const d = diffListings({
      current: [BASE],
      incoming: [incomingFrom(BASE, { symbol: "ETERNAL" })],
      today: "2026-09-22",
    });
    assert.equal(d.close[0]!.validTo, d.open[0]!.validFrom);
    // Half-open, so exactly one of the two contains the handover day.
    assert.equal(
      windowContains(BASE.validFrom, d.close[0]!.validTo, "2026-09-22"),
      false,
    );
    assert.equal(
      windowContains(d.open[0]!.validFrom, null, "2026-09-22"),
      true,
    );
  });

  it("THE INPUT ROW IS NOT MUTATED — an update-in-place would show up here", () => {
    // The strongest statement a pure function can make about "never updates in
    // place": a deep snapshot of the input is unchanged after the call.
    const snapshot = JSON.stringify(BASE);
    diffListings({
      current: [BASE],
      incoming: [incomingFrom(BASE, { symbol: "ETERNAL", status: "DELISTED" })],
      today: "2026-09-22",
    });
    assert.equal(JSON.stringify(BASE), snapshot);
  });

  it("EVERY identity field triggers a close+open, one by one", () => {
    // Iterated rather than spot-checked: a field quietly dropped from
    // IDENTITY_FIELDS would become an in-place edit, silently.
    const alt: Record<string, unknown> = {
      symbol: "OTHER",
      venue: "BSE",
      market: "US",
      isin: "INE000000000",
      name: "Something Else Ltd",
      assetType: "ETF",
      currency: "USD",
      status: "DELISTED",
    };
    for (const field of IDENTITY_FIELDS) {
      const d = diffListings({
        current: [BASE],
        incoming: [
          incomingFrom(BASE, {
            [field]: alt[field],
          } as Partial<IncomingListing>),
        ],
        today: "2026-09-22",
      });
      assert.equal(d.close.length, 1, `${field} must close a row`);
      assert.equal(d.open.length, 1, `${field} must open a row`);
      assert.equal(d.enrich.length, 0, `${field} must NOT be an in-place edit`);
    }
  });

  it("ABSENCE FROM THE SOURCE DOES NOT CLOSE A ROW", () => {
    // `listFiles` fails open to `[]`, one layer down. A fetch that returns
    // nothing looks exactly like an empty market, and closing on absence lets
    // one bad run retire the whole universe with a valid_to that asserts a
    // delisting which never happened.
    const d = diffListings({
      current: [BASE],
      incoming: [],
      today: "2026-09-22",
    });
    assert.deepEqual(d.close, []);
    assert.deepEqual(d.open, []);
    assert.deepEqual(d.enrich, []);
  });

  it("a DELISTING is closed, because the source positively said so", () => {
    const d = diffListings({
      current: [BASE],
      incoming: [incomingFrom(BASE, { status: "DELISTED" })],
      today: "2026-09-22",
    });
    assert.equal(d.close.length, 1);
    assert.equal(d.open[0]!.status, "DELISTED");
  });

  it("a brand-new listing OPENS and closes nothing", () => {
    const d = diffListings({
      current: [],
      incoming: [incomingFrom(BASE)],
      today: "2026-09-22",
    });
    assert.equal(d.open.length, 1);
    assert.equal(d.close.length, 0);
    assert.equal(d.open[0]!.validFrom, "2026-09-22");
  });

  it("an identical row is UNCHANGED — the nightly is a no-op on a quiet day", () => {
    const d = diffListings({
      current: [BASE],
      incoming: [incomingFrom(BASE)],
      today: "2026-09-22",
    });
    assert.equal(d.unchanged, 1);
    assert.equal(d.close.length + d.open.length + d.enrich.length, 0);
  });

  it("ENRICHMENT is written in place and opens no version", () => {
    const d = diffListings({
      current: [BASE],
      incoming: [
        incomingFrom(BASE, {
          sector: "Consumer Discretionary",
          cik10: "0000012345",
        }),
      ],
      today: "2026-09-22",
    });
    assert.equal(d.close.length, 0);
    assert.equal(d.open.length, 0);
    assert.equal(d.enrich.length, 1);
    assert.deepEqual(d.enrich[0]!.fields, {
      cik10: "0000012345",
      sector: "Consumer Discretionary",
    });
    assert.equal(
      d.enrich[0]!.validFrom,
      BASE.validFrom,
      "addresses the OPEN version",
    );
  });

  it("an enrich op carrying an identity field is REFUSED", () => {
    assert.throws(
      () =>
        assertEnrichIsSafe({
          listingId: BASE.listingId,
          validFrom: BASE.validFrom,
          fields: { symbol: "SNEAKY" } as never,
        }),
      IdentityEnrichError,
    );
  });

  it("an ALREADY-CLOSED row is history and is never re-closed", () => {
    const closed: ListingRow = { ...BASE, validTo: "2024-01-01" };
    const d = diffListings({
      current: [closed],
      incoming: [incomingFrom(BASE, { symbol: "ETERNAL" })],
      today: "2026-09-22",
    });
    // Nothing open to close, so this is a fresh open rather than a second close
    // of a row that already has a valid_to.
    assert.equal(d.close.length, 0);
    assert.equal(d.open.length, 1);
  });

  it("with two open rows for one listing the LATER start is treated as live", () => {
    const older: ListingRow = { ...BASE, validFrom: "2021-07-23" };
    const newer: ListingRow = {
      ...BASE,
      validFrom: "2025-01-01",
      symbol: "ETERNAL",
    };
    const d = diffListings({
      current: [older, newer],
      incoming: [incomingFrom(newer)],
      today: "2026-09-22",
    });
    assert.equal(
      d.unchanged,
      1,
      "compared against the LATER row, not the first one seen",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1544 — first versions are dated by the SOURCE, later ones by the day
   they are observed. Prod shapes: every identity/1 row opened 2026-09-22.
   ──────────────────────────────────────────────────────────────────────── */

const SEED_DAY = "2026-09-22";

/** Dow Chemical as `buildUs` now builds it: DELISTED, Tiingo window 1972-06-01..2017-08-31. */
const DOW_CHEM_IN: IncomingListing = {
  listingId: DOW_CHEMICAL,
  market: "US",
  venue: "NYSE",
  symbol: "DOW",
  isin: null,
  name: "Dow Chemical",
  assetType: "Stock",
  currency: "USD",
  status: "DELISTED",
  permaTicker: null,
  cik10: "0000029915",
  cusip: null,
  sector: null,
  industry: null,
  source: "TIINGO",
  listedFrom: "1972-06-01",
  listedTo: endDateToValidTo("2017-08-31"),
};

const DOW_INC_IN: IncomingListing = {
  ...DOW_CHEM_IN,
  listingId: DOW_INC,
  name: "Dow Inc.",
  status: "ACTIVE",
  listedFrom: "2019-03-20",
  listedTo: null,
};

/** What identity/1 wrote for a listing: one open row from the day it ran. */
function seedRow(inc: IncomingListing): ListingRow {
  const { listedFrom: _f, listedTo: _t, ...row } = inc;
  return { ...row, validFrom: SEED_DAY, validTo: null };
}

describe("firstVersions — a listing's FIRST version is dated by its source", () => {
  it("an ACTIVE US listing opens on Tiingo's listingStartDate, not the run day", () => {
    const rows = firstVersions(DOW_INC_IN, SEED_DAY);
    assert.deepEqual(
      rows.map((r) => [r.status, r.validFrom, r.validTo]),
      [["ACTIVE", "2019-03-20", null]],
    );
  });

  it("a DELISTED listing is ACTIVE through its last session, then DELISTED — one open row", () => {
    const rows = firstVersions(DOW_CHEM_IN, SEED_DAY);
    assert.deepEqual(
      rows.map((r) => [r.status, r.validFrom, r.validTo]),
      [
        ["ACTIVE", "1972-06-01", "2017-09-01"],
        ["DELISTED", "2017-09-01", null],
      ],
    );
    // Half-open: tradable ON its inclusive last session, not the day after.
    const tradable = (d: string) =>
      rows.some(
        (r) =>
          r.status === "ACTIVE" && windowContains(r.validFrom, r.validTo, d),
      );
    assert.equal(tradable("2017-08-31"), true);
    assert.equal(tradable("2017-09-01"), false);
    assert.equal(tradable("1972-05-31"), false);
  });

  it("with NO source date it opens on the observed day — India with no bar", () => {
    const rows = firstVersions(incomingFrom(BASE), SEED_DAY);
    assert.deepEqual(
      rows.map((r) => [r.status, r.validFrom, r.validTo]),
      [["ACTIVE", SEED_DAY, null]],
    );
  });

  it("India with a first bar opens on it", () => {
    const rows = firstVersions(
      incomingFrom(BASE, { listedFrom: "2021-07-23" }),
      SEED_DAY,
    );
    assert.equal(rows[0]!.validFrom, "2021-07-23");
  });

  it("DELISTED with no window is ONE DELISTED row — never an invented ACTIVE window", () => {
    const rows = firstVersions({ ...DOW_CHEM_IN, listedTo: null }, SEED_DAY);
    assert.deepEqual(
      rows.map((r) => [r.status, r.validFrom, r.validTo]),
      [["DELISTED", SEED_DAY, null]],
    );
  });

  it("never carries the source fields onto a stored row", () => {
    for (const r of firstVersions(DOW_CHEM_IN, SEED_DAY)) {
      assert.equal("listedFrom" in r, false);
      assert.equal("listedTo" in r, false);
    }
  });

  it("refuses a malformed source date rather than sorting it", () => {
    assert.throws(
      () => firstVersions({ ...DOW_INC_IN, listedFrom: "2019-3-20" }, SEED_DAY),
      InvalidDateError,
    );
  });
});

describe("diffListings — FIRST versions from the source, LATER ones on the observed day", () => {
  it("a listing new to the table opens at its source dates", () => {
    const d = diffListings({
      current: [],
      incoming: [DOW_CHEM_IN, DOW_INC_IN],
      today: "2026-09-24",
    });
    assert.deepEqual(
      d.open.map((r) => [r.listingId, r.status, r.validFrom, r.validTo]),
      [
        [DOW_CHEMICAL, "ACTIVE", "1972-06-01", "2017-09-01"],
        [DOW_CHEMICAL, "DELISTED", "2017-09-01", null],
        [DOW_INC, "ACTIVE", "2019-03-20", null],
      ],
    );
  });

  it("a delisting on an EXISTING listing is dated from the source's end, and the pair MEETS there", () => {
    const current = firstVersions(DOW_INC_IN, SEED_DAY);
    const d = diffListings({
      current,
      incoming: [{ ...DOW_INC_IN, status: "DELISTED", listedTo: "2026-09-20" }],
      today: "2026-09-24",
    });
    assert.deepEqual(
      d.close.map((c) => [c.validFrom, c.validTo, c.datedBy]),
      [["2019-03-20", "2026-09-20", "SOURCE_END"]],
    );
    assert.deepEqual(
      d.open.map((r) => [r.status, r.validFrom, r.validTo]),
      [["DELISTED", "2026-09-20", null]],
    );
  });

  it("any OTHER change is still dated the day it is observed", () => {
    const d = diffListings({
      current: firstVersions(DOW_INC_IN, SEED_DAY),
      incoming: [{ ...DOW_INC_IN, name: "Dow Inc. (renamed)" }],
      today: "2026-09-24",
    });
    assert.deepEqual(
      d.close.map((c) => [c.validTo, c.datedBy]),
      [["2026-09-24", "OBSERVED"]],
    );
  });

  it("the nightly after a first DELISTED open is a no-op — its open row is the DELISTED one", () => {
    const d = diffListings({
      current: firstVersions(DOW_CHEM_IN, SEED_DAY),
      incoming: [DOW_CHEM_IN],
      today: "2026-09-24",
    });
    assert.equal(d.unchanged, 1);
    assert.equal(d.close.length + d.open.length + d.enrich.length, 0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1602 — India instruments the master no longer lists. Shapes from prod
   2026-09-23: the archive head, the MANBRO -> KDGREEN rename, the InvITs still
   printing after they fell out of the master.
   ──────────────────────────────────────────────────────────────────────── */

const HEAD = { newest: "2026-09-22", staleIds: 0 };
const TODAY = "2026-09-23";
/** `classifyInactive` on a quiet night: today, and no sibling admitted yet. */
const classify = (
  a: Omit<Parameters<typeof classifyInactive>[0], "today" | "siblingSameIsin"> &
    Partial<Parameters<typeof classifyInactive>[0]>,
) => classifyInactive({ today: TODAY, siblingSameIsin: [], ...a });

describe("changeDate — a source end dates a delisting only when it is SANE", () => {
  const open: ListingRow = { ...seedRow(DOW_INC_IN), validFrom: "2019-03-20" };
  const delisting = (
    listedTo: string | null,
    patch: Partial<IncomingListing> = {},
  ) =>
    ({
      ...DOW_INC_IN,
      status: "DELISTED",
      listedTo,
      ...patch,
    }) as IncomingListing;
  const date = (inc: IncomingListing, cur: ListingRow = open) =>
    diffListings({
      current: [cur],
      incoming: [inc],
      today: "2026-09-24",
    }).close.map((c) => [c.validTo, c.datedBy]);

  it("end+1 EQUAL to the open version's valid_from would make it zero-length — falls back", () => {
    assert.deepEqual(date(delisting("2019-03-20")), [
      ["2026-09-24", "NOT_AFTER_OPEN_VERSION"],
    ]);
    // One day later is the first sane date.
    assert.deepEqual(date(delisting("2019-03-21")), [
      ["2019-03-21", "SOURCE_END"],
    ]);
  });

  it("end+1 BEFORE the open version's valid_from would reverse SCD order — falls back", () => {
    assert.deepEqual(date(delisting("2019-01-01")), [
      ["2026-09-24", "NOT_AFTER_OPEN_VERSION"],
    ]);
  });

  it("end+1 AFTER the observed day is a claim about the future — falls back; ON the day is fine", () => {
    assert.deepEqual(date(delisting("2026-09-25")), [
      ["2026-09-24", "AFTER_OBSERVED_DAY"],
    ]);
    assert.deepEqual(date(delisting("2026-09-24")), [
      ["2026-09-24", "SOURCE_END"],
    ]);
  });

  it("a delisting with no source end, or arriving with another change, is dated the observed day", () => {
    assert.deepEqual(date(delisting(null)), [["2026-09-24", "NO_SOURCE_END"]]);
    assert.deepEqual(
      date(delisting("2026-09-20", { name: "Dow (in liquidation)" })),
      [["2026-09-24", "OTHER_FIELDS_CHANGED"]],
    );
  });

  it("a RE-listing, or a rename of an already-DELISTED listing, is not a delisting — OBSERVED", () => {
    const gone: ListingRow = { ...open, status: "DELISTED" };
    assert.deepEqual(date({ ...DOW_INC_IN, listedTo: "2026-09-20" }, gone), [
      ["2026-09-24", "OBSERVED"],
    ]);
    assert.deepEqual(
      date(delisting("2026-09-20", { name: "Dow (old)" }), gone),
      [["2026-09-24", "OBSERVED"]],
    );
  });
});

describe("archiveHeads — is the bar archive WHOLE under the ids identity joins?", () => {
  it("MID-REWRITE: any bar id on the old spelling is counted, per venue", () => {
    const h = archiveHeads(
      [
        { listingId: "OLD:NSE", venue: "NSE", last: "2026-09-22" }, // pre-rewrite spelling
        { listingId: "OLD:NSE:unknown", venue: "NSE", last: "2003-04-30" },
        { listingId: "NEW:BSE", venue: "BSE", last: "2026-09-22" },
      ],
      new Set(["OLD:NSE:unknown", "NEW:BSE:unknown"]),
    );
    assert.deepEqual(h.get("NSE"), { newest: "2026-09-22", staleIds: 1 });
    assert.deepEqual(h.get("BSE"), { newest: "2026-09-22", staleIds: 1 });
    assert.equal(archiveIsCurrent(h.get("NSE"), TODAY), false);
  });

  it("the NEWEST session on the new spelling is NOT enough — a catch-up replay of the current month", () => {
    // Measured shape: v2 bars at the head (the replay of the current month)
    // while 2009..2026 is still v1. A newest-only test called this current.
    const h = archiveHeads(
      [
        { listingId: "MID:NSE", venue: "NSE", last: "2015-06-30" },
        { listingId: "CUR:NSE:unknown", venue: "NSE", last: "2026-09-22" },
      ],
      new Set(["CUR:NSE:unknown"]),
    );
    assert.deepEqual(h.get("NSE"), { newest: "2026-09-22", staleIds: 1 });
    assert.equal(archiveIsCurrent(h.get("NSE"), TODAY), false);
  });

  it("a venue whose newest session is more than ARCHIVE_MAX_LAG_DAYS old is NOT current — a lost final month", () => {
    // Every bar on the new spelling, but `replaceMonth` deleted September and
    // its load failed: the newest session is August's.
    const head = (newest: string) => ({ newest, staleIds: 0 });
    assert.equal(archiveIsCurrent(head("2026-08-31"), TODAY), false);
    assert.equal(archiveIsCurrent(head("2026-09-13"), TODAY), true); // 10 days: a holiday run
    assert.equal(archiveIsCurrent(head("2026-09-12"), TODAY), false);
  });

  it("current only when EVERY bar id is joinable", () => {
    const h = archiveHeads(
      [
        { listingId: "MID:NSE:unknown", venue: "NSE", last: "2015-06-30" },
        { listingId: "CUR:NSE:unknown", venue: "NSE", last: "2026-09-22" },
      ],
      new Set(["MID:NSE:unknown", "CUR:NSE:unknown"]),
    );
    assert.deepEqual(h.get("NSE"), { newest: "2026-09-22", staleIds: 0 });
    assert.equal(archiveIsCurrent(h.get("NSE"), TODAY), true);
    assert.equal(archiveIsCurrent(undefined, TODAY), false);
  });
});

describe("classifyInactive — an inactive India instrument is a listing only on its bars", () => {
  it("DELISTED from the day after its last bar, ACTIVE from its first", () => {
    assert.deepEqual(
      classify({
        bars: { first: "1995-01-02", last: "2010-05-31" },
        head: HEAD,
        activeSameIsin: [],
      }),
      {
        admit: true,
        status: "DELISTED",
        listedFrom: "1995-01-02",
        listedTo: "2010-06-01",
      },
    );
  });

  it("still printing on the venue's newest session is NOT a delisting — the InvITs", () => {
    assert.deepEqual(
      classify({
        bars: { first: "2017-06-06", last: "2026-09-22" },
        head: HEAD,
        activeSameIsin: [],
      }),
      {
        admit: true,
        status: "ACTIVE",
        listedFrom: "2017-06-06",
        listedTo: null,
      },
    );
  });

  it("NO BARS is refused by name, never a listing", () => {
    assert.deepEqual(classify({ bars: null, head: HEAD, activeSameIsin: [] }), {
      admit: false,
      reason: "NO_BARS",
    });
  });

  it("MID-REWRITE nothing is admitted — a last bar read now is the rewrite's frontier", () => {
    for (const head of [
      { newest: "2026-09-22", staleIds: 3 },
      // The head is on the new spelling and the middle is not.
      { newest: "2003-04-30", staleIds: 1 },
      undefined,
    ]) {
      // With bars AND without: mid-rewrite "no bars" is not evidence either —
      // its bars may still sit on the old spelling.
      for (const bars of [{ first: "1995-01-02", last: "2003-04-30" }, null]) {
        assert.deepEqual(classify({ bars, head, activeSameIsin: [] }), {
          admit: false,
          reason: "ARCHIVE_NOT_CURRENT",
        });
      }
    }
  });

  it("the same ISIN trading on the same days as an ACTIVE instrument is one security — refused", () => {
    assert.deepEqual(
      classify({
        bars: { first: "2026-02-02", last: "2026-02-23" },
        head: HEAD,
        activeSameIsin: [{ first: "2024-01-01", last: "2026-09-22" }],
      }),
      { admit: false, reason: "OVERLAPS_ACTIVE" },
    );
  });

  it("a RENAME is admitted: the old symbol's bars end before the new one's start", () => {
    // MANBRO -> KDGREEN on BSE, same ISIN, measured on prod.
    const v = classify({
      bars: { first: "2024-01-01", last: "2026-08-18" },
      head: HEAD,
      activeSameIsin: [{ first: "2026-08-19", last: "2026-09-22" }],
    });
    assert.equal(v.admit, true);
    // Touching on one day IS an overlap.
    assert.deepEqual(
      classify({
        bars: { first: "2024-01-01", last: "2026-08-19" },
        head: HEAD,
        activeSameIsin: [{ first: "2026-08-19", last: "2026-09-22" }],
      }),
      { admit: false, reason: "OVERLAPS_ACTIVE" },
    );
  });

  it("STILL TRADING is a year without a print, not one quiet night — the InvITs print on 17-51 of 60 sessions", () => {
    const at = (last: string) =>
      classify({
        bars: { first: "2017-06-06", last },
        head: HEAD,
        activeSameIsin: [],
      });
    // NDRINVIT's longest quiet gap in two years: 83 days.
    assert.deepEqual(at("2026-07-01"), {
      admit: true,
      status: "ACTIVE",
      listedFrom: "2017-06-06",
      listedTo: null,
    });
    // The boundary: exactly STILL_TRADING_DAYS before the newest session is still trading…
    assert.deepEqual(at("2025-09-22"), {
      admit: true,
      status: "ACTIVE",
      listedFrom: "2017-06-06",
      listedTo: null,
    });
    // …one day more is not, and it ends at its own last bar.
    assert.deepEqual(at("2025-09-21"), {
      admit: true,
      status: "DELISTED",
      listedFrom: "2017-06-06",
      listedTo: "2025-09-22",
    });
  });

  it("a listing already OPEN is not closed by a quiet night", () => {
    const stored: ListingRow = {
      ...BASE,
      validFrom: "2017-06-06",
      validTo: null,
    };
    const v = classify({
      bars: { first: "2017-06-06", last: "2026-09-12" }, // ten quiet sessions
      head: HEAD,
      activeSameIsin: [],
    });
    assert.ok(v.admit);
    const inc = incomingFrom(BASE, {
      status: v.status,
      listedFrom: v.listedFrom,
      listedTo: v.listedTo,
    });
    const d = diffListings({
      current: [stored],
      incoming: [inc],
      today: TODAY,
    });
    assert.equal(d.unchanged, 1);
    assert.deepEqual(d.close, []);
  });

  it("two instruments the master no longer lists, one ISIN, same days: the second is refused OVERLAPS_SIBLING", () => {
    assert.deepEqual(
      classify({
        bars: { first: "2017-10-30", last: "2025-10-30" },
        head: HEAD,
        activeSameIsin: [],
        siblingSameIsin: [{ first: "2017-10-30", last: "2025-10-30" }],
      }),
      { admit: false, reason: "OVERLAPS_SIBLING" },
    );
    // Disjoint windows are two listings, not one counted twice.
    const v = classify({
      bars: { first: "2017-10-30", last: "2018-10-30" },
      head: HEAD,
      activeSameIsin: [],
      siblingSameIsin: [{ first: "2019-01-01", last: "2025-10-30" }],
    });
    assert.equal(v.admit, true);
  });

  it("inactivePrecedence: more bars wins, then the listing id — the same winner every night", () => {
    const rows = [
      { listingId: "SGBOCT25A:BSE:unknown", bars: 12 },
      { listingId: "SGBOCT25:BSE:unknown", bars: 300 },
      { listingId: "B:BSE:unknown", bars: 5 },
      { listingId: "A:BSE:unknown", bars: 5 },
    ];
    assert.deepEqual(
      [...rows].sort(inactivePrecedence).map((r) => r.listingId),
      [
        "SGBOCT25:BSE:unknown",
        "SGBOCT25A:BSE:unknown",
        "A:BSE:unknown",
        "B:BSE:unknown",
      ],
    );
  });

  it("an admitted inactive row opens its window through firstVersions, and the next night is a no-op", () => {
    const v = classify({
      bars: { first: "1995-01-02", last: "2010-05-31" },
      head: HEAD,
      activeSameIsin: [],
    });
    assert.ok(v.admit);
    const inc = incomingFrom(BASE, {
      status: v.status,
      listedFrom: v.listedFrom,
      listedTo: v.listedTo,
    });
    const first = diffListings({
      current: [],
      incoming: [inc],
      today: "2026-09-24",
    });
    assert.deepEqual(
      first.open.map((r) => [r.status, r.validFrom, r.validTo]),
      [
        ["ACTIVE", "1995-01-02", "2010-06-01"],
        ["DELISTED", "2010-06-01", null],
      ],
    );
    const next = diffListings({
      current: first.open,
      incoming: [inc],
      today: "2026-09-25",
    });
    assert.equal(next.unchanged, 1);
  });

  it("a listing ACTIVE in the table that goes inactive CLOSES from its last bar — never rewritten", () => {
    const stored: ListingRow = {
      ...BASE,
      validFrom: "2021-07-23",
      validTo: null,
    };
    const v = classify({
      bars: { first: "2021-07-23", last: "2025-06-30" },
      head: { newest: "2026-09-23", staleIds: 0 },
      activeSameIsin: [],
    });
    assert.ok(v.admit && v.status === "DELISTED");
    const inc = incomingFrom(BASE, {
      status: v.status,
      listedFrom: v.listedFrom,
      listedTo: v.listedTo,
    });
    const d = diffListings({
      current: [stored],
      incoming: [inc],
      today: "2026-09-24",
    });
    assert.deepEqual(
      d.close.map((c) => [c.validFrom, c.validTo, c.datedBy]),
      [["2021-07-23", "2025-07-01", "SOURCE_END"]],
    );
    assert.deepEqual(
      d.open.map((r) => [r.status, r.validFrom, r.validTo]),
      [["DELISTED", "2025-07-01", null]],
    );
    // And the rebase leaves the closed pair alone.
    const after = [{ ...stored, validTo: "2025-07-01" }, ...d.open];
    const plan = planRebase({ current: after, incoming: [inc] });
    assert.deepEqual(plan.ops, []);
  });
});

describe("planRebase — re-date what identity/1 opened on the run day", () => {
  it("prod's seed shape: every first version moves to its source date", () => {
    const plan = planRebase({
      current: [seedRow(DOW_CHEM_IN), seedRow(DOW_INC_IN)],
      incoming: [DOW_CHEM_IN, DOW_INC_IN],
    });
    assert.deepEqual(
      plan.ops.map((o) => [
        o.listingId,
        o.replaces.validFrom,
        o.rows.map((r) => [r.status, r.validFrom, r.validTo]),
      ]),
      [
        [
          DOW_CHEMICAL,
          SEED_DAY,
          [
            ["ACTIVE", "1972-06-01", "2017-09-01"],
            ["DELISTED", "2017-09-01", null],
          ],
        ],
        [DOW_INC, SEED_DAY, [["ACTIVE", "2019-03-20", null]]],
      ],
    );
  });

  it("A SECOND PLAN OVER THE REWRITTEN TABLE IS EMPTY — the re-run creates no duplicate version", () => {
    const first = planRebase({
      current: [seedRow(DOW_CHEM_IN), seedRow(DOW_INC_IN)],
      incoming: [DOW_CHEM_IN, DOW_INC_IN],
    });
    const rewritten = first.ops.flatMap((o) => o.rows);
    const second = planRebase({
      current: rewritten,
      incoming: [DOW_CHEM_IN, DOW_INC_IN],
    });
    assert.deepEqual(second.ops, []);
    assert.equal(second.unchanged, 2);
    assert.deepEqual(second.cannotRedate, []);
  });

  it("keeps the STORED identity; only the dates come from today's source", () => {
    // Seeded ACTIVE, DELISTED since: the rebase dates the ACTIVE row it
    // stored, and the delisting is the nightly's to record, on its observed day.
    const plan = planRebase({
      current: [seedRow(DOW_INC_IN)],
      incoming: [{ ...DOW_INC_IN, status: "DELISTED", listedTo: "2026-09-20" }],
    });
    assert.deepEqual(
      plan.ops[0]!.rows.map((r) => [r.status, r.validFrom, r.validTo]),
      [["ACTIVE", "2019-03-20", null]],
    );
  });

  it("an undated source leaves the row alone — India with no bar", () => {
    const plan = planRebase({
      current: [seedRow(incomingFrom(BASE))],
      incoming: [incomingFrom(BASE)],
    });
    assert.deepEqual(plan.ops, []);
    assert.equal(plan.unchanged, 1);
  });

  it("a FIRST version is re-dated even with versions after it — its observed END is kept", () => {
    // rebase -> nightly -> rebase again: the nightly recorded a rename on
    // 09-23, and the first version's start is still the seed day.
    const renamed: ListingRow[] = [
      { ...seedRow(DOW_INC_IN), validTo: "2026-09-23" },
      {
        ...seedRow(DOW_INC_IN),
        name: "Dow Inc. (new)",
        validFrom: "2026-09-23",
      },
    ];
    const plan = planRebase({ current: renamed, incoming: [DOW_INC_IN] });
    assert.deepEqual(
      plan.ops.map((o) => [
        o.kind,
        o.replaces.validFrom,
        o.replaces.validTo,
        o.rows.map((r) => [r.status, r.validFrom, r.validTo]),
      ]),
      [
        [
          "REDATE",
          SEED_DAY,
          "2026-09-23",
          [["ACTIVE", "2019-03-20", "2026-09-23"]],
        ],
      ],
    );
    // Applied, the next plan is empty.
    const after = [...plan.ops.flatMap((o) => o.rows), renamed[1]!];
    assert.deepEqual(
      planRebase({ current: after, incoming: [DOW_INC_IN] }).ops,
      [],
    );

    // ONE CLOSED row — a close whose open never landed — is re-dated the same way.
    const closedOnly: ListingRow[] = [
      { ...seedRow(DOW_INC_IN), validTo: "2026-09-23" },
    ];
    assert.deepEqual(
      planRebase({ current: closedOnly, incoming: [DOW_INC_IN] }).ops.map((o) =>
        o.rows.map((r) => [r.validFrom, r.validTo]),
      ),
      [[["2019-03-20", "2026-09-23"]]],
    );
  });

  it("a source start NOT before the first version's end would cross it — named and left alone", () => {
    const renamed: ListingRow[] = [
      { ...seedRow(DOW_INC_IN), validTo: "2026-09-23" },
      {
        ...seedRow(DOW_INC_IN),
        name: "Dow Inc. (new)",
        validFrom: "2026-09-23",
      },
    ];
    for (const listedFrom of ["2026-09-23", "2026-09-24"]) {
      const plan = planRebase({
        current: renamed,
        incoming: [{ ...DOW_INC_IN, listedFrom }],
      });
      assert.deepEqual(plan.ops, [], listedFrom);
      assert.deepEqual(plan.cannotRedate, [DOW_INC], listedFrom);
    }

    // TWO OPEN rows — the crash state diffListings tolerates.
    const twoOpen: ListingRow[] = [
      seedRow(DOW_INC_IN),
      { ...seedRow(DOW_INC_IN), validFrom: "2026-09-23" },
    ];
    const plan2 = planRebase({ current: twoOpen, incoming: [DOW_INC_IN] });
    assert.deepEqual(plan2.ops, []);
    assert.deepEqual(plan2.cannotRedate, [DOW_INC]);
  });

  it("GAB: a seed-day DELISTED first version the source says has traded ACTIVE since 1987 is a seed glitch — re-dated ACTIVE", () => {
    const gab: IncomingListing = {
      ...DOW_INC_IN,
      listingId: "GAB:NYSE:1987-11-05",
      symbol: "GAB",
      status: "ACTIVE",
      listedFrom: "1987-11-05",
      listedTo: null,
    };
    const seed = {
      ...seedRow(gab),
      status: "DELISTED" as const,
      parserVersion: "identity/1",
    };
    const plan = planRebase({ current: [seed], incoming: [gab] });
    assert.deepEqual(
      plan.ops.map((o) =>
        o.rows.map((r) => [r.status, r.validFrom, r.validTo]),
      ),
      [[["ACTIVE", "1987-11-05", null]]],
    );
    // So tonight's diff has nothing to flip.
    const night = diffListings({
      current: plan.ops.flatMap((o) => o.rows),
      incoming: [gab],
      today: "2026-09-23",
    });
    assert.equal(night.unchanged, 1);
  });

  it("the glitch rule is SEED-only: an identity/2 DELISTED first version the source now calls ACTIVE is a RE-listing — never rewritten", () => {
    const relisted: IncomingListing = {
      ...DOW_INC_IN,
      status: "ACTIVE",
      listedFrom: "2019-03-20",
      listedTo: null,
    };
    // First seen (by identity/2) delisted with no window, on 2026-09-24.
    const first = {
      ...seedRow(relisted),
      status: "DELISTED" as const,
      validFrom: "2026-09-24",
      parserVersion: "identity/2",
    };
    const plan = planRebase({ current: [first], incoming: [relisted] });
    assert.deepEqual(plan.ops, []);
    // The nightly records the re-listing on the day it sees it.
    const { parserVersion: _p, ...row } = first;
    const night = diffListings({
      current: [row],
      incoming: [relisted],
      today: "2026-10-01",
    });
    assert.deepEqual(
      night.close.map((c) => [c.validTo, c.datedBy]),
      [["2026-10-01", "OBSERVED"]],
    );
  });

  it("RESTAMP: a first version already right but stamped identity/1 is rewritten with the current stamp", () => {
    const row = {
      ...firstVersions(DOW_INC_IN, SEED_DAY)[0]!,
      parserVersion: "identity/1",
    };
    const plan = planRebase({ current: [row], incoming: [DOW_INC_IN] });
    assert.deepEqual(
      plan.ops.map((o) => [
        o.kind,
        o.rows.map((r) => [r.validFrom, r.validTo]),
      ]),
      [["RESTAMP", [["2019-03-20", null]]]],
    );
    assert.equal("parserVersion" in plan.ops[0]!.rows[0]!, false);
    // An India listing with no bar: nothing to re-date, still re-stamped.
    const noBar = {
      ...seedRow(incomingFrom(BASE)),
      parserVersion: "identity/1",
    };
    assert.deepEqual(
      planRebase({ current: [noBar], incoming: [incomingFrom(BASE)] }).ops.map(
        (o) => o.kind,
      ),
      ["RESTAMP"],
    );
    // Stamped by the current parser: unchanged.
    const done = { ...row, parserVersion: "identity/2" };
    const again = planRebase({ current: [done], incoming: [DOW_INC_IN] });
    assert.deepEqual(again.ops, []);
    assert.equal(again.unchanged, 1);
  });

  it("a listing no source carries today is counted, not guessed at — only re-stamped", () => {
    const plan = planRebase({ current: [seedRow(DOW_INC_IN)], incoming: [] });
    assert.deepEqual(plan.ops, []);
    assert.equal(plan.notInSource, 1);
    // Stamped identity/1, it keeps its start and takes the current stamp, or
    // it would hold its market's universe floor at the seed day for ever.
    const stamped = { ...seedRow(DOW_INC_IN), parserVersion: "identity/1" };
    const plan2 = planRebase({ current: [stamped], incoming: [] });
    assert.deepEqual(
      plan2.ops.map((o) => [
        o.kind,
        o.rows.map((r) => [r.validFrom, r.validTo]),
      ]),
      [["RESTAMP", [[SEED_DAY, null]]]],
    );
    assert.equal(plan2.notInSource, 1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   symbol_history
   ──────────────────────────────────────────────────────────────────────── */

describe("resolveSymbol", () => {
  const rows = [
    {
      listingId: "ETERNAL:NSE:2021-07-23",
      symbol: "ETERNAL",
      venue: "NSE",
      validFrom: "2025-03-01",
      validTo: null,
    },
    {
      listingId: "ETERNAL:NSE:2021-07-23",
      symbol: "ZOMATO",
      venue: "NSE",
      // UNDATED: previousSymbols carries the label and not the date.
      validFrom: null,
      validTo: null,
    },
  ];

  it("a retired ticker still finds its security — the MONEY-1177 shape", () => {
    const hit = resolveSymbol(rows, {
      symbol: "ZOMATO",
      venue: "NSE",
      asOf: "2022-01-01",
    });
    assert.equal(hit?.listingId, "ETERNAL:NSE:2021-07-23");
    assert.equal(
      hit?.dated,
      false,
      "and it reports that the window is a guess",
    );
  });

  it("the current ticker resolves as DATED", () => {
    const hit = resolveSymbol(rows, {
      symbol: "ETERNAL",
      venue: "NSE",
      asOf: "2026-01-01",
    });
    assert.equal(hit?.dated, true);
  });

  it("the venue is part of the key", () => {
    assert.equal(
      resolveSymbol(rows, {
        symbol: "ETERNAL",
        venue: "BSE",
        asOf: "2026-01-01",
      }),
      null,
    );
  });

  it("a dated row wins over an undated alias for the same symbol", () => {
    const both = [
      {
        listingId: "REAL",
        symbol: "X",
        venue: "NSE",
        validFrom: "2020-01-01",
        validTo: null,
      },
      {
        listingId: "ALIAS",
        symbol: "X",
        venue: "NSE",
        validFrom: null,
        validTo: null,
      },
    ];
    assert.equal(
      resolveSymbol(both, { symbol: "X", venue: "NSE", asOf: "2021-01-01" })
        ?.listingId,
      "REAL",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Dates and vocabularies
   ──────────────────────────────────────────────────────────────────────── */

describe("dates", () => {
  it("nextDay crosses a month, a year and a leap day", () => {
    assert.equal(nextDay("2026-01-31"), "2026-02-01");
    assert.equal(nextDay("2026-12-31"), "2027-01-01");
    assert.equal(nextDay("2024-02-28"), "2024-02-29"); // leap
    assert.equal(nextDay("2025-02-28"), "2025-03-01"); // not
  });

  it("a date that MATCHES THE PATTERN but is not a real day is refused", () => {
    // 2017-02-30 passes a regex and then sorts between 02-28 and 03-01, which
    // is nowhere. A pattern check alone is not a date check.
    assert.throws(() => assertIsoDate("2017-02-30"), InvalidDateError);
    assert.throws(() => assertIsoDate("2017-13-01"), InvalidDateError);
    assert.throws(() => assertIsoDate("2017-8-31"), InvalidDateError); // unpadded
    assert.throws(
      () => assertIsoDate("2017-08-31T00:00:00Z"),
      InvalidDateError,
    );
    assert.throws(() => assertIsoDate(20170831 as never), InvalidDateError);
  });

  it("tradedTo ends a DELISTED listing's window and NEVER an active one's", () => {
    // Tiingo stamps every ACTIVE row with its latest session; read as an end,
    // it closed all 81,093 active Tiingo map rows on prod at the run day.
    assert.equal(tradedTo("DELISTED", "2017-08-31"), "2017-09-01");
    assert.equal(tradedTo("ACTIVE", "2026-09-22"), null);
    assert.equal(tradedTo("DELISTED", null), null);
  });

  it("endDateToValidTo pushes an inclusive end out by one day, and passes null through", () => {
    assert.equal(endDateToValidTo("2017-08-31"), "2017-09-01");
    assert.equal(endDateToValidTo(null), null);
  });

  it("an open-ended window contains any future as-of", () => {
    assert.equal(windowContains("2020-01-01", null, "2099-01-01"), true);
    assert.equal(windowContains(null, null, "1900-01-01"), true);
  });

  it("resolveListing refuses a malformed as-of rather than comparing it as a string", () => {
    assert.throws(
      () =>
        resolveListing(DOW_MAP, {
          source: "TIINGO",
          sourceKey: "DOW",
          asOf: "2020/01/01",
        }),
      InvalidDateError,
    );
  });
});

describe("closed vocabularies", () => {
  it("the fifteen source systems the spec names are all present", () => {
    for (const s of [
      "TIINGO",
      "DATABENTO",
      "SEC",
      "NSE",
      "BSE",
      "KITE",
      "UPSTOX",
      "GROWW",
      "ANGEL",
      "DHAN",
      "FYERS",
      "ICICI",
      "HDFC",
      "IBKR",
      "YAHOO",
    ]) {
      assert.ok(isSourceSystem(s), s);
    }
    assert.equal(SOURCE_SYSTEMS.length, 15);
  });

  it("an unknown value is refused by every guard", () => {
    assert.equal(isSourceSystem("ROBINHOOD"), false);
    assert.equal(isMarket("EU"), false);
    assert.equal(isListingStatus("SUSPENDED"), false);
    assert.equal(isMapMethod("VIBES"), false);
    assert.equal(isSourceSystem(null), false);
  });

  it("market is US or IN only — it is a COLUMN, not a dataset", () => {
    assert.ok(isMarket("US"));
    assert.ok(isMarket("IN"));
  });
});
