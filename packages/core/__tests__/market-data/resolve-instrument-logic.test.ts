/**
 * MONEY-980 — the pure half of cross-market instrument resolution.
 *
 * Every assertion here is written to FAIL against a plausible wrong
 * implementation, not merely to pass against the right one. Where a guard is
 * cheap to fake — "India wins", "the US side refuses" — the test also pins the
 * SHAPE that a broken version would produce, so weakening the guard cannot be
 * absorbed by an assertion that was already true.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  decideResolution,
  INDIA_CASH_VENUES,
  INDIA_VENUE_ORDER,
  marketForExchange,
  normalizeResolveSymbol,
  rankIndiaRows,
  rankUsRows,
  RESOLVE_ROW_LIMIT,
  toResolvedUs,
  yahooSymbolFor,
  type IndiaInstrumentRow,
  type UsInstrumentRow,
} from "../../src/market-data/instruments/resolve-instrument-logic";
import {
  SUPPORTED_EXCHANGES,
  YAHOO_SUFFIX_MAP,
} from "../../src/market-data/instruments/types";

function india(over: Partial<IndiaInstrumentRow> = {}): IndiaInstrumentRow {
  return {
    id: "in-1",
    symbol: "ACC",
    exchange: "NSE",
    name: "ACC Limited",
    yahooSymbol: "ACC.NS",
    instrumentType: "EQUITY",
    isin: "INE012A01025",
    isActive: true,
    ...over,
  };
}

function us(over: Partial<UsInstrumentRow> = {}): UsInstrumentRow {
  return {
    id: "us-1",
    listingId: "ACC:NASDAQ:2020-01-01",
    symbol: "ACC",
    exchange: "NASDAQ",
    name: "Atlas Corp",
    assetType: "Stock",
    listingStatus: "ACTIVE",
    listingStartDate: new Date("2020-01-01T00:00:00.000Z"),
    ...over,
  };
}

describe("normalizeResolveSymbol", () => {
  test("uppercases and strips the India Yahoo suffixes", () => {
    assert.equal(normalizeResolveSymbol("reliance.ns"), "RELIANCE");
    assert.equal(normalizeResolveSymbol("Reliance.BO"), "RELIANCE");
  });

  test("TRIMS BEFORE the anchored suffix strip", () => {
    // The regression: the strip is `$`-anchored, so trailing whitespace stops
    // it matching and the caller receives a WRONG-but-non-empty symbol that
    // sails past every `if (!symbol)` guard.
    assert.equal(normalizeResolveSymbol("  RELIANCE.NS  "), "RELIANCE");
    assert.equal(normalizeResolveSymbol("\tTCS.BO\n"), "TCS");
  });

  test("only the TRAILING suffix is stripped, not an interior match", () => {
    assert.equal(normalizeResolveSymbol("BSE.NSEX"), "BSE.NSEX");
    assert.equal(normalizeResolveSymbol("NSE"), "NSE");
  });

  test('returns "" for anything that cannot be a ticker', () => {
    assert.equal(normalizeResolveSymbol(""), "");
    assert.equal(normalizeResolveSymbol("   "), "");
    assert.equal(normalizeResolveSymbol(null), "");
    assert.equal(normalizeResolveSymbol(undefined), "");
    // Non-string reaching here from LLM planner output must not throw.
    assert.equal(
      normalizeResolveSymbol(42 as unknown as string),
      "",
      'a non-string must return "" rather than throwing',
    );
  });
});

describe("marketForExchange", () => {
  test("names the market for every venue each collection carries", () => {
    for (const venue of SUPPORTED_EXCHANGES) {
      assert.equal(marketForExchange(venue), "IN", `${venue} should be IN`);
    }
    for (const venue of ["NASDAQ", "NYSE", "AMEX", "NYSE ARCA", "NMFQS"]) {
      assert.equal(marketForExchange(venue), "US", `${venue} should be US`);
    }
  });

  test("is case- and whitespace-insensitive", () => {
    assert.equal(marketForExchange("  nasdaq "), "US");
    assert.equal(marketForExchange("nse"), "IN");
  });

  test('an unknown venue is null, NOT a silent "both"', () => {
    // The whole point: null must be distinguishable from "search everywhere".
    assert.equal(marketForExchange("LSE"), null);
    assert.equal(marketForExchange("TSX"), null);
    assert.equal(marketForExchange(""), null);
    assert.equal(marketForExchange("   "), null);
    assert.equal(marketForExchange(undefined), null);
    assert.equal(marketForExchange(null), null);
  });
});

describe("yahooSymbolFor", () => {
  test("India prefers the stored column", () => {
    assert.equal(yahooSymbolFor("IN", "ACC", "NSE", "ACC.NS"), "ACC.NS");
    // A stored value that disagrees with the venue still WINS — the column is
    // what `@@unique([yahooSymbol])` guarantees, the derivation is a fallback.
    assert.equal(yahooSymbolFor("IN", "ACC", "NSE", "ACC.BO"), "ACC.BO");
  });

  test("India derives the suffix when the stored value is blank", () => {
    assert.equal(yahooSymbolFor("IN", "ACC", "NSE", ""), "ACC.NS");
    assert.equal(yahooSymbolFor("IN", "ACC", "BSE", "   "), "ACC.BO");
    assert.equal(yahooSymbolFor("IN", "ACC", "NSE", null), "ACC.NS");
    assert.equal(yahooSymbolFor("IN", "ACC", "NSE", undefined), "ACC.NS");
  });

  test("an India venue with no suffix mapping falls back to .NS", () => {
    assert.equal(
      yahooSymbolFor("IN", "NIFTY24JANFUT", "NFO", ""),
      "NIFTY24JANFUT.NS",
    );
  });

  test("US is the BARE ticker and NEVER suffixed", () => {
    assert.equal(yahooSymbolFor("US", "AAPL", "NASDAQ"), "AAPL");
    assert.equal(yahooSymbolFor("US", "BRK-A", "NYSE"), "BRK-A");
    // Even a stored India-shaped value must not leak onto a US row: a US symbol
    // suffixed `.NS` collides with a real Indian ticker (INFY is both).
    assert.equal(yahooSymbolFor("US", "INFY", "NYSE", "INFY.NS"), "INFY");
  });
});

describe("liveness is computed POSITIVELY", () => {
  test("ACTIVE is live, DELISTED is not", () => {
    assert.equal(toResolvedUs(us({ listingStatus: "ACTIVE" })).active, true);
    assert.equal(toResolvedUs(us({ listingStatus: "DELISTED" })).active, false);
  });

  test("an UNKNOWN status reads as NOT live, not as live-by-default", () => {
    // A `!== "DELISTED"` implementation passes the two cases above and fails
    // here — which is the point of this case existing.
    assert.equal(
      toResolvedUs(us({ listingStatus: "SUSPENDED" })).active,
      false,
    );
    assert.equal(toResolvedUs(us({ listingStatus: "" })).active, false);
  });
});

describe("India ranking", () => {
  test("NSE beats BSE", () => {
    const ranked = rankIndiaRows([
      india({ id: "b", exchange: "BSE", yahooSymbol: "ACC.BO" }),
      india({ id: "a", exchange: "NSE", yahooSymbol: "ACC.NS" }),
    ]);
    assert.equal(ranked[0]?.exchange, "NSE");
    assert.equal(ranked[1]?.exchange, "BSE");
  });

  test("the venue order is NSE > BSE > NFO > BFO > MCX", () => {
    const shuffled = ["MCX", "BFO", "NSE", "NFO", "BSE"].map((exchange, i) =>
      india({ id: `id-${i}`, exchange, yahooSymbol: `ACC-${i}` }),
    );
    assert.deepEqual(
      rankIndiaRows(shuffled).map((r) => r.exchange),
      [...INDIA_VENUE_ORDER],
    );
  });

  test("LIVENESS outranks venue — a live BSE row beats a dead NSE row", () => {
    const ranked = rankIndiaRows([
      india({ id: "dead-nse", exchange: "NSE", isActive: false }),
      india({ id: "live-bse", exchange: "BSE", isActive: true }),
    ]);
    assert.equal(ranked[0]?.id, "live-bse");
    assert.equal(ranked[0]?.active, true);
  });

  test("an unranked venue sorts LAST, never first", () => {
    // A `?? -1` or a missing-key-is-0 bug would put the unknown venue ahead of
    // NSE, which is the failure mode worth pinning.
    const ranked = rankIndiaRows([
      india({ id: "weird", exchange: "SOMETHING_NEW" }),
      india({ id: "nse", exchange: "NSE" }),
    ]);
    assert.equal(ranked[0]?.exchange, "NSE");
    assert.equal(ranked[1]?.exchange, "SOMETHING_NEW");
  });

  test("the result does not depend on input order", () => {
    const rows = [
      india({ id: "c", exchange: "BSE" }),
      india({ id: "a", exchange: "NSE" }),
      india({ id: "b", exchange: "MCX" }),
    ];
    const forward = rankIndiaRows(rows).map((r) => r.id);
    const reverse = rankIndiaRows([...rows].reverse()).map((r) => r.id);
    assert.deepEqual(forward, reverse);
  });

  test("ranking does not mutate the caller's array", () => {
    const rows = [india({ id: "b", exchange: "BSE" }), india({ id: "a" })];
    const before = rows.map((r) => r.id);
    rankIndiaRows(rows);
    assert.deepEqual(
      rows.map((r) => r.id),
      before,
    );
  });

  test("INDIA_VENUE_ORDER covers every SUPPORTED_EXCHANGES venue", () => {
    // The structural guard: adding a venue to the ingest list without ranking
    // it here would silently give it rank "last" for every reader.
    for (const venue of SUPPORTED_EXCHANGES) {
      assert.ok(
        (INDIA_VENUE_ORDER as readonly string[]).includes(venue),
        `${venue} is a supported India venue but has no resolution rank`,
      );
    }
    assert.equal(INDIA_VENUE_ORDER.length, SUPPORTED_EXCHANGES.length);
    assert.equal(INDIA_VENUE_ORDER[0], "NSE", "NSE must rank first");
  });
});

describe("US ranking and the ambiguity refusal", () => {
  test("a recycled ticker with ONE live window resolves to it", () => {
    // NYSE's real case: Dow Chemical 1972-2017 and Dow Inc. 2019-.
    const result = decideResolution({
      india: [],
      us: [
        us({
          id: "old",
          listingId: "DOW:NYSE:1972-01-01",
          symbol: "DOW",
          exchange: "NYSE",
          name: "Dow Chemical",
          listingStatus: "DELISTED",
          listingStartDate: new Date("1972-01-01T00:00:00.000Z"),
        }),
        us({
          id: "new",
          listingId: "DOW:NYSE:2019-04-01",
          symbol: "DOW",
          exchange: "NYSE",
          name: "Dow Inc.",
          listingStatus: "ACTIVE",
          listingStartDate: new Date("2019-04-01T00:00:00.000Z"),
        }),
      ],
    });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.name, "Dow Inc.");
    assert.equal(result.instrument.listingId, "DOW:NYSE:2019-04-01");
    assert.equal(result.instrument.market, "US");
    // The delisted predecessor is disclosed, not discarded.
    assert.equal(result.alternatives.length, 1);
    assert.equal(result.alternatives[0]?.name, "Dow Chemical");
  });

  test("TWO live windows on ONE venue REFUSE rather than pick", () => {
    const result = decideResolution({
      india: [],
      us: [
        us({
          id: "a",
          listingId: "X:NYSE:2001-01-01",
          symbol: "X",
          exchange: "NYSE",
        }),
        us({
          id: "b",
          listingId: "X:NYSE:2015-01-01",
          symbol: "X",
          exchange: "NYSE",
        }),
      ],
    });
    assert.equal(result.status, "AMBIGUOUS");
    if (result.status !== "AMBIGUOUS") return;
    assert.equal(result.market, "US");
    assert.equal(result.candidates.length, 2);
    // A "picking" implementation would return RESOLVED here. Assert the shape
    // too, so the refusal cannot be faked by an AMBIGUOUS that still names one.
    assert.ok(!("instrument" in result));
    assert.match(result.reason, /2 US listings/);
  });

  test("TWO live windows on DIFFERENT venues also refuse", () => {
    // Same class: two live rows for one US ticker are two securities, whether
    // or not they share a venue.
    const result = decideResolution({
      india: [],
      us: [
        us({
          id: "a",
          listingId: "Z:NASDAQ:2001-01-01",
          symbol: "Z",
          exchange: "NASDAQ",
        }),
        us({
          id: "b",
          listingId: "Z:NMFQS:2015-01-01",
          symbol: "Z",
          exchange: "NMFQS",
          assetType: "Mutual Fund",
        }),
      ],
    });
    assert.equal(result.status, "AMBIGUOUS");
  });

  test("TWO delisted windows and nothing live also refuse", () => {
    const result = decideResolution({
      india: [],
      us: [
        us({
          id: "a",
          listingId: "Q:NYSE:1980-01-01",
          listingStatus: "DELISTED",
        }),
        us({
          id: "b",
          listingId: "Q:NYSE:1995-01-01",
          listingStatus: "DELISTED",
        }),
      ],
    });
    assert.equal(result.status, "AMBIGUOUS");
    if (result.status !== "AMBIGUOUS") return;
    assert.equal(
      result.candidates.every((c) => !c.active),
      true,
    );
  });

  test("the refusal reason names the candidates and CHOOSES none", () => {
    const result = decideResolution({
      india: [],
      us: [
        us({
          id: "a",
          listingId: "X:NYSE:2001-01-01",
          symbol: "X",
          exchange: "NYSE",
        }),
        us({
          id: "b",
          listingId: "X:NYSE:2015-01-01",
          symbol: "X",
          exchange: "NYSE",
        }),
      ],
    });
    if (result.status !== "AMBIGUOUS") {
      assert.fail("expected AMBIGUOUS");
      return;
    }
    assert.match(result.reason, /X:NYSE:2001-01-01/);
    assert.match(result.reason, /X:NYSE:2015-01-01/);
  });

  test("one live row and MANY delisted ones still resolves", () => {
    const rows = [
      us({ id: "d1", listingId: "L:1", listingStatus: "DELISTED" }),
      us({ id: "live", listingId: "L:live", listingStatus: "ACTIVE" }),
      us({ id: "d2", listingId: "L:2", listingStatus: "DELISTED" }),
    ];
    const result = decideResolution({ india: [], us: rows });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.listingId, "L:live");
    assert.equal(result.alternatives.length, 2);
  });

  test("live rows sort before delisted, then newest first", () => {
    const ranked = rankUsRows([
      us({
        id: "old",
        listingId: "a",
        listingStatus: "DELISTED",
        listingStartDate: new Date("1990-01-01"),
      }),
      us({
        id: "mid",
        listingId: "b",
        listingStatus: "DELISTED",
        listingStartDate: new Date("2005-01-01"),
      }),
      us({
        id: "new",
        listingId: "c",
        listingStatus: "ACTIVE",
        listingStartDate: new Date("2019-01-01"),
      }),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.id),
      ["new", "mid", "old"],
    );
  });

  test("a null listingStartDate sorts LAST within its liveness tier", () => {
    const ranked = rankUsRows([
      us({ id: "nodate", listingId: "a", listingStartDate: null }),
      us({
        id: "dated",
        listingId: "b",
        listingStartDate: new Date("1999-01-01"),
      }),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.id),
      ["dated", "nodate"],
    );
  });

  test("US ranking does not depend on input order", () => {
    const rows = [
      us({
        id: "a",
        listingId: "a",
        listingStatus: "DELISTED",
        listingStartDate: new Date("1990-01-01"),
      }),
      us({
        id: "b",
        listingId: "b",
        listingStatus: "ACTIVE",
        listingStartDate: new Date("2010-01-01"),
      }),
      us({
        id: "c",
        listingId: "c",
        listingStatus: "DELISTED",
        listingStartDate: new Date("2000-01-01"),
      }),
    ];
    assert.deepEqual(
      rankUsRows(rows).map((r) => r.id),
      rankUsRows([...rows].reverse()).map((r) => r.id),
    );
  });
});

describe("cross-market preference: India first, stated", () => {
  test("a bare symbol matching BOTH markets resolves to India", () => {
    // ACC is a real collision: ACC Limited on NSE/BSE and a US listing.
    const result = decideResolution({
      india: [india()],
      us: [us()],
    });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.market, "IN");
    assert.equal(result.instrument.exchange, "NSE");
    assert.equal(result.instrument.yahooSymbol, "ACC.NS");
  });

  test("the US match is DISCLOSED as an alternative, not discarded", () => {
    const result = decideResolution({ india: [india()], us: [us()] });
    if (result.status !== "RESOLVED") {
      assert.fail("expected RESOLVED");
      return;
    }
    assert.equal(result.alternatives.length, 1);
    assert.equal(result.alternatives[0]?.market, "US");
    assert.equal(result.alternatives[0]?.exchange, "NASDAQ");
  });

  test("a US AMBIGUITY does not block an India answer", () => {
    // Refusing here would break every India ticker that happens to collide.
    const result = decideResolution({
      india: [india()],
      us: [
        us({ id: "a", listingId: "ACC:NYSE:2001-01-01", exchange: "NYSE" }),
        us({ id: "b", listingId: "ACC:NYSE:2015-01-01", exchange: "NYSE" }),
      ],
    });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.market, "IN");
    // ...and both unnarrowed US rows still ride along.
    assert.equal(
      result.alternatives.filter((a) => a.market === "US").length,
      2,
    );
  });

  test("with NO India row the US answer is used", () => {
    const result = decideResolution({
      india: [],
      us: [us({ symbol: "AAPL" })],
    });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.market, "US");
    assert.equal(result.instrument.yahooSymbol, "AAPL");
    assert.equal(result.instrument.listingId, "ACC:NASDAQ:2020-01-01");
  });

  test("a DEAD India row still beats a LIVE US row", () => {
    // India-first is a MARKET preference, not a liveness one. Liveness ranks
    // WITHIN a market; it does not promote the other market. Stated here so a
    // future change to that rule is a failing test rather than a silent flip.
    const result = decideResolution({
      india: [india({ isActive: false })],
      us: [us()],
    });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.instrument.market, "IN");
    assert.equal(result.instrument.active, false);
  });

  test("nothing anywhere is NOT_FOUND, not an empty RESOLVED", () => {
    const result = decideResolution({ india: [], us: [] });
    assert.equal(result.status, "NOT_FOUND");
    assert.ok(!("instrument" in result));
    assert.ok(!("candidates" in result));
  });
});

describe("alternatives: the US candidates ride along, in rank order", () => {
  // MONEY-980 — the India-wins branch built its US tail from a THREE-ARM
  // ternary whose arms were provably identical (`usAmbiguous ? us : usWinner
  // === null ? [] : [usWinner, ...us.slice(1)]`). Three spellings of one value
  // read as three behaviours, and the obvious next edit is to make one of them
  // differ. These tests state the ONE behaviour over each former arm, so a
  // reintroduced branch that actually diverges fails here rather than shipping.

  test("arm 1 — an AMBIGUOUS US side discloses EVERY candidate, in order", () => {
    const older = us({
      id: "a",
      listingId: "ACC:NYSE:2001-01-01",
      exchange: "NYSE",
      listingStartDate: new Date("2001-01-01T00:00:00.000Z"),
    });
    const newer = us({
      id: "b",
      listingId: "ACC:NYSE:2015-01-01",
      exchange: "NYSE",
      listingStartDate: new Date("2015-01-01T00:00:00.000Z"),
    });
    const result = decideResolution({ india: [india()], us: [older, newer] });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.deepEqual(
      result.alternatives.map((a) => a.listingId),
      ["ACC:NYSE:2015-01-01", "ACC:NYSE:2001-01-01"],
      "newest-listed first — the same order rankUsRows produced",
    );
  });

  test("arm 2 — NO US rows contributes NOTHING, not an undefined hole", () => {
    const result = decideResolution({
      india: [india(), india({ id: "in-2", exchange: "BSE" })],
      us: [],
    });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.equal(result.alternatives.length, 1);
    assert.ok(result.alternatives.every((a) => a.market === "IN"));
  });

  test("arm 3 — an UNAMBIGUOUS US winner is disclosed exactly ONCE", () => {
    // The old arm rebuilt the list as `[usWinner, ...us.slice(1)]`. A version
    // that spelled it `[usWinner, ...us]` would duplicate the winner, which
    // no length-agnostic assertion would catch.
    const live = us({
      id: "live",
      listingId: "ACC:NASDAQ:2020-01-01",
      listingStatus: "ACTIVE",
    });
    const dead = us({
      id: "dead",
      listingId: "ACC:NASDAQ:1990-01-01",
      listingStatus: "DELISTED",
      listingStartDate: new Date("1990-01-01T00:00:00.000Z"),
    });
    const result = decideResolution({ india: [india()], us: [dead, live] });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    const ids = result.alternatives.map((a) => a.listingId);
    assert.deepEqual(ids, ["ACC:NASDAQ:2020-01-01", "ACC:NASDAQ:1990-01-01"]);
    assert.equal(new Set(ids).size, ids.length, "a candidate was duplicated");
  });

  test("India alternatives come FIRST, then the US ones", () => {
    const result = decideResolution({
      india: [india(), india({ id: "in-2", exchange: "BSE" })],
      us: [us()],
    });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.deepEqual(
      result.alternatives.map((a) => a.market),
      ["IN", "US"],
    );
  });

  test("the winner is NEVER also an alternative", () => {
    const result = decideResolution({ india: [india()], us: [us()] });
    assert.equal(result.status, "RESOLVED");
    if (result.status !== "RESOLVED") return;
    assert.ok(
      !result.alternatives.some((a) => a.id === result.instrument.id),
      "the chosen row must not be offered as an alternative to itself",
    );
  });
});

describe("INDIA_CASH_VENUES — the scope a company-NAME search means", () => {
  test("is exactly the venues whose `name` column holds an issuer", () => {
    assert.deepEqual([...INDIA_CASH_VENUES], ["NSE", "BSE"]);
  });

  test("is a SUBSET of INDIA_VENUE_ORDER, so every member is also ranked", () => {
    for (const venue of INDIA_CASH_VENUES) {
      assert.ok(
        (INDIA_VENUE_ORDER as readonly string[]).includes(venue),
        `${venue} is nameable but unranked — pickBestMatch would sort it last`,
      );
    }
  });

  test("EXCLUDES the derivative and commodity venues", () => {
    // NFO/BFO/MCX `name` values are contract identifiers
    // ("NIFTY25SEP25000CE"), so including them resolves a company query to a
    // contract every downstream company tool then fails on. This is the
    // widening an earlier pass described as "changes no result".
    for (const venue of ["NFO", "BFO", "MCX"]) {
      assert.ok(
        !(INDIA_CASH_VENUES as readonly string[]).includes(venue),
        `${venue} carries contract names, not company names`,
      );
    }
    assert.ok(
      INDIA_CASH_VENUES.length < INDIA_VENUE_ORDER.length,
      "the two lists answer different questions and must not converge",
    );
  });

  test("is every India venue that carries a Yahoo suffix", () => {
    // A cross-check against a list maintained elsewhere for another reason:
    // NSE and BSE are the only India venues Yahoo quotes, which is the same
    // set for the same underlying reason (they are the cash markets).
    for (const venue of INDIA_CASH_VENUES) {
      assert.ok(
        typeof YAHOO_SUFFIX_MAP[venue] === "string",
        `${venue} has no Yahoo suffix but is treated as a cash venue`,
      );
    }
  });
});

describe("the resolved shape carries what a caller needs to branch", () => {
  test("India rows carry instrumentType/isin and NO listingId", () => {
    const result = decideResolution({ india: [india()], us: [] });
    if (result.status !== "RESOLVED") {
      assert.fail("expected RESOLVED");
      return;
    }
    assert.equal(result.instrument.instrumentType, "EQUITY");
    assert.equal(result.instrument.isin, "INE012A01025");
    assert.equal(result.instrument.listingId, null);
    assert.equal(result.instrument.assetType, null);
  });

  test("US rows carry listingId/assetType and NO instrumentType", () => {
    const result = decideResolution({ india: [], us: [us()] });
    if (result.status !== "RESOLVED") {
      assert.fail("expected RESOLVED");
      return;
    }
    assert.equal(result.instrument.listingId, "ACC:NASDAQ:2020-01-01");
    assert.equal(result.instrument.assetType, "Stock");
    assert.equal(result.instrument.instrumentType, null);
    assert.equal(result.instrument.isin, null);
  });

  test("a US row whose name leg has not run yet reports null, not the symbol", () => {
    // `name = symbol` would erase the distinction search ranking depends on.
    const result = decideResolution({ india: [], us: [us({ name: null })] });
    if (result.status !== "RESOLVED") {
      assert.fail("expected RESOLVED");
      return;
    }
    assert.equal(result.instrument.name, null);
  });
});

describe("RESOLVE_ROW_LIMIT", () => {
  test("is large enough for every India venue plus room to spare", () => {
    assert.ok(
      RESOLVE_ROW_LIMIT > SUPPORTED_EXCHANGES.length,
      "the bound must not truncate a fully dual-listed India symbol",
    );
  });
});
