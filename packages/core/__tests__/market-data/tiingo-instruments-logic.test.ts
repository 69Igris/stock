/**
 * MONEY-980 — US instrument master (Tiingo listings + EDGAR CIK join).
 *
 * The two properties pinned here are both cases where the WRONG answer looks
 * entirely normal: a recycled ticker resolving to the wrong company, and a
 * punctuation-normalised ticker inheriting a different issuer's CIK.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  selectPrimaryListings,
  usInstrumentTypeFor,
  toRawUsInstrument,
  TIINGO_SYNC_EXCHANGES,
  US_EXCHANGE_PREFERENCE,
} from "../../src/market-data/instruments/tiingo-instruments-logic";
import {
  padCik,
  normaliseUsTicker,
  toSecPreferredForm,
  classifyUsTickerShape,
  isExchangeTestSymbol,
  parseEdgarCompanyTickers,
  buildEdgarCikIndex,
  planEdgarCikEnrichment,
  UNMATCHED_SAMPLE_LIMIT,
} from "../../src/market-data/instruments/edgar-cik-logic";
import type { TiingoMasterRow } from "../../src/market-data/tiingo/tiingo-logic";

const row = (
  ticker: string,
  exchange: string,
  startDate: string,
  endDate: string,
  assetType = "Stock",
): TiingoMasterRow => ({
  ticker,
  exchange,
  assetType,
  priceCurrency: "USD",
  startDate,
  endDate,
});

const LIVE = "2026-08-27";

describe("selectPrimaryListings — one row per ticker", () => {
  test("DOW resolves to Dow Inc., never Dow Chemical", () => {
    // Both rows are identical in exchange, assetType and currency; only the
    // window differs. Tiingo's price endpoint serves the CURRENT occupant, so
    // keeping the 1972 window would create a row we could never fill.
    const { listings, stats } = selectPrimaryListings([
      row("DOW", "NYSE", "1972-06-01", "2017-08-31"),
      row("DOW", "NYSE", "2019-03-20", LIVE),
    ]);
    assert.equal(listings.length, 1);
    assert.equal(listings[0]!.listingId, "DOW:NYSE:2019-03-20");
    assert.equal(listings[0]!.listingStatus, "ACTIVE");
    assert.equal(stats.recycledDropped, 1);
  });

  test("the winner does not depend on input order", () => {
    const a = selectPrimaryListings([
      row("DOW", "NYSE", "1972-06-01", "2017-08-31"),
      row("DOW", "NYSE", "2019-03-20", LIVE),
    ]).listings[0]!.listingId;
    const b = selectPrimaryListings([
      row("DOW", "NYSE", "2019-03-20", LIVE),
      row("DOW", "NYSE", "1972-06-01", "2017-08-31"),
    ]).listings[0]!.listingId;
    assert.equal(a, b);
  });

  test("a cross-venue repeat collapses to ONE row", () => {
    // `@@unique([yahooSymbol])` binds tighter than `@@unique([symbol,exchange])`
    // because a US Yahoo symbol IS the bare ticker — so two venue rows would
    // fail the upsert. They would also be filled from the identical response:
    // /tiingo/daily/<ticker>/prices takes no exchange qualifier.
    const { listings, stats } = selectPrimaryListings([
      row("BRKL", "NASDAQ", "1998-03-25", "2025-09-02"),
      row("BRKL", "BATS", "2026-07-07", LIVE, "ETF"),
    ]);
    assert.equal(listings.length, 1);
    assert.equal(stats.crossVenueDropped, 1);
    assert.equal(listings[0]!.listingStatus, "ACTIVE");
  });

  test("a delisted ticker with no successor is KEPT, and graded DELISTED", () => {
    // A live row must be present for this to mean anything. `deriveListingStatus`
    // grades against the newest endDate among the IN-SCOPE rows, not the clock,
    // so a master consisting ONLY of delisted rows makes its own newest row the
    // reference and reads ACTIVE. That is degenerate rather than wrong — the
    // real file always carries ~14k live rows — but asserting the delisted case
    // without one would be asserting the degenerate path.
    const { listings } = selectPrimaryListings([
      row("ZZZZ", "NYSE", "1990-01-02", "2001-11-30"),
      row("LIVE", "NYSE", "1990-01-02", LIVE),
    ]);
    const dead = listings.find((l) => l.symbol === "ZZZZ");
    assert.ok(dead, "a delisted security is kept, not dropped");
    assert.equal(dead.listingStatus, "DELISTED");
    assert.equal(
      listings.find((l) => l.symbol === "LIVE")!.listingStatus,
      "ACTIVE",
    );
  });

  test("out-of-scope rows never reach the selection", () => {
    const { listings } = selectPrimaryListings([
      { ...row("CHINA", "SHG", "2010-01-01", LIVE), priceCurrency: "CNY" },
      row("PINKY", "PINK", "2010-01-01", LIVE),
      {
        ...row("CNYFUND", "NMFQS", "2010-01-01", LIVE, "Mutual Fund"),
        priceCurrency: "CNY",
      },
    ]);
    assert.deepEqual(listings, []);
  });

  test("a mutual fund IS in scope, and is typed MF", () => {
    // Funds were excluded until MONEY-980 widened the scope. The nightly job
    // has a NAV leg, and a leg with an empty population selects nothing, writes
    // nothing, and reads HEALTHY forever.
    const { listings } = selectPrimaryListings([
      row("VFINX", "NMFQS", "1976-08-31", LIVE, "Mutual Fund"),
    ]);
    assert.equal(listings.length, 1);
    assert.equal(listings[0]!.instrumentType, "MF");
    assert.equal(listings[0]!.exchange, "NMFQS");
  });

  test("NMFQS is in the sync scope, or the sweep deactivates every fund it wrote", () => {
    // `deactivateStaleInstruments` flips isActive on any row not in the run's
    // symbol@exchange set. A venue this provider ENUMERATES but does not DECLARE
    // would have its rows written and then deactivated in the same pass, with
    // no error and a COMPLETED sync log.
    assert.ok(TIINGO_SYNC_EXCHANGES.includes("NMFQS"));
  });

  test("an empty master yields an empty selection, not a delisted market", () => {
    // With no in-scope rows there is no reference date to grade against, so
    // defaulting everything to DELISTED would be a fabricated answer.
    const { listings } = selectPrimaryListings([]);
    assert.deepEqual(listings, []);
  });

  test("the preference list and sync scope stay aligned", () => {
    for (const ex of US_EXCHANGE_PREFERENCE) {
      assert.ok(
        TIINGO_SYNC_EXCHANGES.includes(ex),
        `${ex} is preferred but not in the sync scope — syncInstruments would ` +
          "not be told about it, and deactivateStaleInstruments would then " +
          "deactivate rows this provider is responsible for",
      );
    }
  });

  test("ETFs and equities are typed apart", () => {
    assert.equal(usInstrumentTypeFor("ETF"), "ETF");
    assert.equal(usInstrumentTypeFor("Stock"), "EQUITY");
  });

  test("a raw instrument carries the bare ticker, never a .NS suffix", () => {
    const { listings } = selectPrimaryListings([
      row("AAPL", "NASDAQ", "1980-12-12", LIVE),
    ]);
    const raw = toRawUsInstrument(listings[0]!);
    assert.equal(raw.symbol, "AAPL");
    assert.ok(!JSON.stringify(raw).includes(".NS"));
  });
});

describe("EDGAR CIK join", () => {
  test("pads a CIK to the 10 digits SEC uses", () => {
    assert.equal(padCik(320193), "0000320193");
    assert.equal(padCik("320193"), "0000320193");
    assert.equal(padCik(0), null);
    assert.equal(padCik("not a number"), null);
  });

  test("parses SEC's index-keyed object", () => {
    const rows = parseEdgarCompanyTickers(
      JSON.stringify({
        "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
        "1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corp" },
      }),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.ticker === "AAPL")!.cik, "0000320193");
  });

  test("drops a malformed entry instead of losing the file", () => {
    const rows = parseEdgarCompanyTickers(
      JSON.stringify({
        "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
        "1": { ticker: "BROKEN" },
        "2": "not an object",
      }),
    );
    assert.equal(rows.length, 1);
  });

  test("PUNCTUATION COLLISION: a preferred class never inherits another issuer's CIK", () => {
    // Measured against the real 795 KB file: `T-PC` (AT&T preferred) normalises
    // onto `TPC`, which is Tutor Perini — a different company. Without the
    // ambiguity rule Tutor Perini silently gets AT&T's CIK, and nothing about
    // the resulting row looks wrong.
    const idx = buildEdgarCikIndex([
      { ticker: "T-PC", cik: "0000732717", title: "AT&T" },
      { ticker: "TPC", cik: "0000077543", title: "Tutor Perini" },
    ]);
    assert.equal(idx.byTicker.get("TPC"), "0000077543", "exact match survives");
    assert.equal(
      idx.byNormalised.get(normaliseUsTicker("TPC")),
      undefined,
      "the normalised key is dropped, not resolved to one of the two",
    );
  });

  test("a ticker claimed by two different CIKs is dropped, not guessed", () => {
    const idx = buildEdgarCikIndex([
      { ticker: "DUP", cik: "0000000001", title: "One" },
      { ticker: "DUP", cik: "0000000002", title: "Two" },
    ]);
    assert.equal(idx.byTicker.get("DUP"), undefined);
    assert.deepEqual(idx.ambiguousTickers, ["DUP"]);
  });

  test("the same ticker repeated with the SAME cik is not ambiguous", () => {
    const idx = buildEdgarCikIndex([
      { ticker: "SAME", cik: "0000000001", title: "One" },
      { ticker: "SAME", cik: "0000000001", title: "One again" },
    ]);
    assert.equal(idx.byTicker.get("SAME"), "0000000001");
    assert.deepEqual(idx.ambiguousTickers, []);
  });

  test("the plan can only ever UPDATE ids it was given", () => {
    const idx = buildEdgarCikIndex([
      { ticker: "AAPL", cik: "0000320193", title: "Apple" },
    ]);
    const plan = planEdgarCikEnrichment(idx, [
      { id: "id-1", symbol: "AAPL", exchange: "NASDAQ", cik: null },
      { id: "id-2", symbol: "NOSUCH", exchange: "NASDAQ", cik: null },
    ]);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.updates[0]!.id, "id-1");
    assert.equal(plan.unmatched, 1);
    for (const u of plan.updates) {
      assert.ok(["id-1", "id-2"].includes(u.id), "never invents an id");
    }
  });

  test("a row that already holds the cik is not rewritten", () => {
    const idx = buildEdgarCikIndex([
      { ticker: "AAPL", cik: "0000320193", title: "Apple" },
    ]);
    const plan = planEdgarCikEnrichment(idx, [
      { id: "id-1", symbol: "AAPL", exchange: "NASDAQ", cik: "0000320193" },
    ]);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.alreadySet, 1);
  });
});

/* =====================================================================
   MONEY-1353 — making the enricher's REFUSAL legible.

   Every ticker below is a real symbol taken from the 1,170 ACTIVE US stocks
   that carried no CIK on prod 2026-09-05, and every CIK below is the real one
   from the archived `company_tickers.json`. A table of invented tickers would
   pass against any classifier, including a wrong one.
   ===================================================================== */

describe("SEC preferred-form rewrite (MONEY-1353)", () => {
  test("rewrites OUR -P-<series> spelling into SEC's -P<series>", () => {
    // Tiingo separates every component; SEC collapses the class marker onto
    // the series letter. Measured: 382 ACTIVE rows carry this shape.
    assert.equal(toSecPreferredForm("T-P-C"), "T-PC");
    assert.equal(toSecPreferredForm("INN-P-F"), "INN-PF");
    assert.equal(toSecPreferredForm("BC-P-C"), "BC-PC");
    assert.equal(toSecPreferredForm("SPG-P-J"), "SPG-PJ");
  });

  test("KEEPS the dash — the character that separates two companies", () => {
    // This is the whole reason the rewrite exists rather than reusing
    // `normaliseUsTicker`. Stripping punctuation maps `T-P-C` onto `TPC`,
    // which is Tutor Perini's exact ticker.
    assert.notEqual(toSecPreferredForm("T-P-C"), normaliseUsTicker("T-P-C"));
    assert.equal(normaliseUsTicker("T-P-C"), "TPC");
    assert.ok(toSecPreferredForm("T-P-C").includes("-"));
  });

  test("leaves every non-preferred shape alone", () => {
    // A rewrite that touched units, warrants or share classes would be
    // inventing SEC spellings for securities SEC does not spell that way.
    for (const t of ["AAC-U", "ACHR-WS", "AIIA-R", "BRK-B", "AAPL", "NE-WS-A"])
      assert.equal(toSecPreferredForm(t), t, t);
  });

  test("RECOVERS the three preferreds the ambiguity guard correctly refuses", () => {
    // The measured case, end to end. Under punctuation-stripping alone all
    // three normalise onto a DIFFERENT registrant's exact ticker, so
    // `buildEdgarCikIndex` drops the normalised key and the row goes
    // unmatched. Reading SEC's own spelling resolves them against the
    // DISAMBIGUATED index instead.
    const idx = buildEdgarCikIndex([
      { ticker: "T-PC", cik: "0000732717", title: "AT&T INC." },
      { ticker: "TPC", cik: "0000077543", title: "TUTOR PERINI CORP" },
      { ticker: "INN-PF", cik: "0001497645", title: "Summit Hotel" },
      { ticker: "INNPF", cik: "0001889791", title: "INNOCAN PHARMA Corp" },
      { ticker: "BC-PC", cik: "0000014930", title: "BRUNSWICK CORP" },
      { ticker: "BCPC", cik: "0000009326", title: "BALCHEM CORP" },
    ]);
    // Precondition: the lossy index really has dropped all three keys.
    for (const k of ["TPC", "INNPF", "BCPC"])
      assert.equal(idx.byNormalised.get(k), undefined, k);

    const plan = planEdgarCikEnrichment(idx, [
      { id: "a", symbol: "T-P-C", exchange: "NYSE", cik: null },
      { id: "b", symbol: "INN-P-F", exchange: "NYSE", cik: null },
      { id: "c", symbol: "BC-P-C", exchange: "NYSE", cik: null },
    ]);
    assert.equal(plan.matchedSecForm, 3);
    assert.equal(plan.unmatched, 0);
    assert.deepEqual(
      plan.updates.map((u) => u.cik),
      ["0000732717", "0001497645", "0000014930"],
      "AT&T / Summit Hotel / Brunswick — NOT Tutor Perini / Innocan / Balchem",
    );
  });

  test("ATTRIBUTED to the exact index even when the lossy one would also hit", () => {
    // Ordering is load-bearing for the ACCOUNTING, not for the answer. 374 of
    // prod's 382 preferred rows resolve under BOTH paths and agree on the CIK,
    // so putting the punctuation pass first would still write the right value
    // — and would report every one of them as `matchedNormalised`, i.e. as
    // resolved by a key that discards the character separating two companies.
    // The counter is the only thing that can tell the two apart, so it has to
    // name the index that actually answered.
    const idx = buildEdgarCikIndex([
      { ticker: "SPG-PJ", cik: "0001063761", title: "SIMON PROPERTY GROUP" },
    ]);
    assert.equal(
      idx.byNormalised.get(normaliseUsTicker("SPG-P-J")),
      "0001063761",
      "precondition: the lossy path WOULD resolve this one",
    );
    const plan = planEdgarCikEnrichment(idx, [
      { id: "a", symbol: "SPG-P-J", exchange: "NYSE", cik: null },
    ]);
    assert.equal(plan.matchedSecForm, 1);
    assert.equal(plan.matchedNormalised, 0);
  });

  test("the two passes CANNOT disagree — byNormalised is built from byTicker", () => {
    // The structural invariant that makes the chain order immaterial, asserted
    // as a RELATIONSHIP rather than assumed in a comment. A SEC-form hit means
    // that SEC ticker is in `byTicker`; every `byTicker` entry seeds
    // `byNormalised` under its own normalised key; a second entry claiming that
    // key with a different CIK deletes it. So the normalised lookup is either
    // the SAME cik or absent — never a third answer.
    const idx = buildEdgarCikIndex([
      { ticker: "SPG-PJ", cik: "0001063761", title: "SIMON PROPERTY GROUP" },
      { ticker: "T-PC", cik: "0000732717", title: "AT&T INC." },
      { ticker: "TPC", cik: "0000077543", title: "TUTOR PERINI CORP" },
      { ticker: "BC-PC", cik: "0000014930", title: "BRUNSWICK CORP" },
    ]);
    for (const sym of ["SPG-P-J", "T-P-C", "BC-P-C", "FOO-P-A"]) {
      const viaSec = idx.byTicker.get(toSecPreferredForm(sym));
      const viaNorm = idx.byNormalised.get(normaliseUsTicker(sym));
      if (viaSec !== undefined && viaNorm !== undefined)
        assert.equal(viaSec, viaNorm, sym);
    }
  });

  test("the OTHER company keeps its own CIK — the collision is not traded", () => {
    // The rewrite must not become a second way to mis-attribute. Tutor Perini
    // is spelled `TPC` with no dash, so it hits the exact index and never
    // reaches the preferred pass at all.
    const idx = buildEdgarCikIndex([
      { ticker: "T-PC", cik: "0000732717", title: "AT&T INC." },
      { ticker: "TPC", cik: "0000077543", title: "TUTOR PERINI CORP" },
    ]);
    const plan = planEdgarCikEnrichment(idx, [
      { id: "a", symbol: "TPC", exchange: "NYSE", cik: null },
    ]);
    assert.equal(plan.matchedExact, 1);
    assert.equal(plan.matchedSecForm, 0);
    assert.equal(plan.updates[0]!.cik, "0000077543");
  });
});

describe("US ticker shape classifier (MONEY-1353)", () => {
  test("the punctuated forms — the exchange's own notation", () => {
    assert.equal(classifyUsTickerShape("AAC-U"), "unit");
    assert.equal(classifyUsTickerShape("ACHR-WS"), "warrant");
    assert.equal(classifyUsTickerShape("AIIA-R"), "right");
    assert.equal(classifyUsTickerShape("T-P-C"), "preferred");
    assert.equal(classifyUsTickerShape("HWM-P"), "preferred");
    assert.equal(classifyUsTickerShape("EBR-B"), "shareClass");
    assert.equal(classifyUsTickerShape("CON-W"), "warrant");
  });

  test("the FIRST modifier segment decides, not the last", () => {
    // `HYT-R-W` is a RIGHT that is also when-issued; `NE-WS-A` is a WARRANT of
    // the A class. Reading the final segment calls the first a warrant and the
    // second a share class — both wrong, and both real rows on prod.
    assert.equal(classifyUsTickerShape("HYT-R-W"), "right");
    assert.equal(classifyUsTickerShape("NE-WS-A"), "warrant");
    assert.equal(classifyUsTickerShape("VST-WS-A"), "warrant");
  });

  test("NASDAQ's fifth letter, at exactly five characters", () => {
    assert.equal(classifyUsTickerShape("ASTSW"), "warrant");
    assert.equal(classifyUsTickerShape("AIMAU"), "unit");
    assert.equal(classifyUsTickerShape("AITRR"), "right");
    assert.equal(classifyUsTickerShape("FITBP"), "preferred");
    assert.equal(classifyUsTickerShape("LSXMA"), "shareClass");
  });

  test("a bare six-character WS suffix is a warrant", () => {
    // `AACTWS` is the one row on prod that carries the two-letter warrant
    // suffix without a dash. Six characters is outside the US ticker length
    // range, so the suffix is the only reading.
    assert.equal(classifyUsTickerShape("AACTWS"), "warrant");
    // But not at five, where `WS` would be eating a real fifth letter: the
    // NASDAQ convention already reads `ABCWS` as the S-suffixed form of ABCW.
    assert.equal(classifyUsTickerShape("ABCWS"), "plain");
  });

  test("a FOUR-character ticker ending in W/U/R is ordinary common stock", () => {
    // The convention's scope is the fifth letter. 47 rows in the CIK-less
    // population are four characters ending in one of these, and relabelling
    // every one of them as a derivative is what a length-blind rule does.
    for (const t of ["BREW", "ASTR", "AVGR", "AFAR", "AMAU", "BIOR"])
      assert.equal(classifyUsTickerShape(t), "plain", t);
  });

  test("a fifth letter with no single meaning stays plain, not guessed", () => {
    // V/T/L/Z/O are the next most common fifth letters in the measured
    // population and none of them names a security type across both NASDAQ and
    // the CTA tape.
    for (const t of ["ABCDV", "ABCDT", "ABCDL", "ABCDZ", "ABCDO"])
      assert.equal(classifyUsTickerShape(t), "plain", t);
  });

  test("plain tickers of every length stay plain", () => {
    for (const t of ["ABI", "ABL", "AGR", "ALE", "AAAC", "AAPL", "ACEI"])
      assert.equal(classifyUsTickerShape(t), "plain", t);
    assert.equal(classifyUsTickerShape(""), "plain");
    assert.equal(classifyUsTickerShape("   "), "plain");
  });

  test("`.` and `/` separators classify like `-`", () => {
    // Zero prod symbols carry either today; the classifier accepts them
    // because a vendor change would otherwise silently reclassify a whole
    // venue as `plain`.
    assert.equal(classifyUsTickerShape("BRK.B"), "shareClass");
    assert.equal(classifyUsTickerShape("BRK/B"), "shareClass");
  });

  test("exchange test symbols are a FLAG, not a seventh shape", () => {
    // `NTEST-P` is preferred-SPELLED and is also a test symbol; a shape and a
    // flag answer different questions and one cannot carry the other.
    assert.equal(classifyUsTickerShape("NTEST-P"), "preferred");
    assert.ok(isExchangeTestSymbol("NTEST-P"));
    for (const t of ["ATEST", "ATEST-A", "CTEST", "MTEST-A", "ZTEST", "ZXYZ-A"])
      assert.ok(isExchangeTestSymbol(t), t);
    for (const t of ["AAPL", "TESLA", "ATTEST", "PROTEST", "AAC-U"])
      assert.equal(isExchangeTestSymbol(t), false, t);
  });
});

describe("unmatched breakdown (MONEY-1353)", () => {
  const idx = buildEdgarCikIndex([
    { ticker: "AAPL", cik: "0000320193", title: "Apple" },
  ]);

  test("buckets the refusal by venue, and the totals agree", () => {
    const plan = planEdgarCikEnrichment(idx, [
      { id: "1", symbol: "AAPL", exchange: "NASDAQ", cik: null },
      { id: "2", symbol: "ASTSW", exchange: "NASDAQ", cik: null },
      { id: "3", symbol: "AITRR", exchange: "NASDAQ", cik: null },
      { id: "4", symbol: "ACHR-WS", exchange: "NYSE", cik: null },
      { id: "5", symbol: "AAAC", exchange: "BATS", cik: null },
    ]);
    assert.equal(plan.matched, 1);
    assert.equal(plan.unmatched, 4);
    assert.deepEqual(plan.unmatchedByExchange, {
      NASDAQ: 2,
      NYSE: 1,
      BATS: 1,
    });
    // The invariant that makes the breakdown trustworthy: it is a PARTITION of
    // `unmatched`, so no row can be counted twice or dropped.
    assert.equal(
      Object.values(plan.unmatchedByExchange).reduce((a, b) => a + b, 0),
      plan.unmatched,
    );
  });

  test("a blank symbol is refused INTO the breakdown, not beside it", () => {
    // The empty-symbol branch used to bump the bare counter on its own. With
    // three things to keep in step that is exactly how one drifts, and the
    // partition assertion above would then be false in production only.
    const plan = planEdgarCikEnrichment(idx, [
      { id: "1", symbol: "   ", exchange: "NYSE", cik: null },
    ]);
    assert.equal(plan.unmatched, 1);
    assert.deepEqual(plan.unmatchedByExchange, { NYSE: 1 });
    assert.deepEqual(plan.unmatchedSample, ["(blank)"]);
  });

  test("a blank EXCHANGE lands in a named bucket, never in an empty key", () => {
    const plan = planEdgarCikEnrichment(idx, [
      { id: "1", symbol: "NOSUCH", exchange: "", cik: null },
    ]);
    assert.deepEqual(plan.unmatchedByExchange, { UNKNOWN: 1 });
  });

  test("the sample is BOUNDED — a 1,170-entry log line is unreadable", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `id-${i}`,
      symbol: `NONE${i}`,
      exchange: "NASDAQ",
      cik: null,
    }));
    const plan = planEdgarCikEnrichment(idx, many);
    assert.equal(plan.unmatched, 200);
    assert.equal(plan.unmatchedSample.length, UNMATCHED_SAMPLE_LIMIT);
    assert.equal(UNMATCHED_SAMPLE_LIMIT, 20);
    // FIRST 20, in arrival order — a sample taken from the end would show
    // whatever the last page happened to hold.
    assert.equal(plan.unmatchedSample[0], "NONE0");
    assert.equal(plan.unmatchedSample[19], "NONE19");
  });

  test("a fully-joined universe reports an EMPTY breakdown, not a zero row", () => {
    const plan = planEdgarCikEnrichment(idx, [
      { id: "1", symbol: "AAPL", exchange: "NASDAQ", cik: null },
    ]);
    assert.equal(plan.unmatched, 0);
    assert.deepEqual(plan.unmatchedByExchange, {});
    assert.deepEqual(plan.unmatchedSample, []);
  });
});
