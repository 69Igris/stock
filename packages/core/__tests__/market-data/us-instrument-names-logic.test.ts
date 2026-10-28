/**
 * MONEY-980 TASK B3 — company-name attribution, parsing, and the run sizing.
 *
 * The hazard this file exists for produces a WRONG answer that nothing
 * downstream can distinguish from a right one: `/tiingo/daily/<ticker>` answers
 * for the CURRENT occupant of a ticker, and `us_instruments` deliberately
 * stores the predecessors. Writing the response's name onto a predecessor
 * labels Dow Chemical "Dow Inc" — a plausible string in a column no later run
 * can second-guess.
 *
 * Fixtures are TRANSCRIBED FROM LIVE RESPONSES probed 2026-08-28 against our
 * own token, not invented: AAPL, DOW, BRKL, VFIAX, HOS, CTEST-I (a real 200
 * with `name: null`) and LEH (a real 200 with null dates).
 *
 * Every assertion was MUTATION-CHECKED — the rule was broken, the case
 * confirmed RED, and the source restored. The mutations are named inline.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  US_ENRICH_BUDGET_MS,
  US_ENRICH_MAX_CHAIN_DEPTH,
  US_NAME_PAGE_SIZE,
  US_SEARCH_PAGE_SIZE,
  normalizeUsChainDepth,
  parseTiingoMetadata,
  resolveUsListingName,
  shouldChainUsEnrichment,
  usEnrichmentDeadlines,
  type TiingoDailyMetadata,
} from "../../src/market-data/instruments/us-instrument-names-logic";

/** Live response bodies, byte-for-byte in shape. */
const BODY = {
  AAPL: `{"ticker":"AAPL","name":"Apple Inc","description":"Apple Inc. (Apple) designs...","startDate":"1980-12-12","endDate":"2026-08-27","exchangeCode":"NASDAQ"}`,
  DOW: `{"ticker":"DOW","name":"Dow Inc","description":"Dow (NYSE: DOW) combines...","startDate":"2019-03-20","endDate":"2026-08-27","exchangeCode":"NYSE"}`,
  BRKL: `{"ticker":"BRKL","name":"Corgi BRKB 2x Daily ETF","description":"Corgi BRKB 2x Daily ETF","startDate":"2026-07-07","endDate":"2026-08-27","exchangeCode":"BATS"}`,
  VFIAX: `{"ticker":"VFIAX","name":"VANGUARD 500 INDEX FUND ADMIRAL SHARES","description":"The Fund employs...","startDate":"2000-11-13","endDate":"2026-08-27","exchangeCode":"NMFQS"}`,
  HOS: `{"ticker":"HOS","name":"Hornbeck Offshore Services Inc","description":"...","startDate":"2004-03-26","endDate":"2019-12-20","exchangeCode":"NYSE"}`,
  CTEST: `{"ticker":"CTEST-I","name":null,"description":null,"startDate":"2019-07-25","endDate":"2019-08-07","exchangeCode":"NYSE"}`,
  LEH: `{"ticker":"LEH","name":"LEHMAN BROTHERS HOLDINGS INC","description":"DELISTED - LEHMAN BROTHERS HOLDINGS INC","startDate":null,"endDate":null,"exchangeCode":null}`,
  NOT_FOUND: `{"detail":"Not found."}`,
};

const meta = (body: string): TiingoDailyMetadata => {
  const m = parseTiingoMetadata(body);
  assert.ok(m, `fixture did not parse: ${body.slice(0, 40)}`);
  return m;
};

describe("parseTiingoMetadata", () => {
  test("the live key set is exactly six fields, and permaTicker is NOT one", () => {
    // Documented as absent in docs/reference/tiingo-endpoints.md and re-probed
    // 2026-08-28. If it ever appears, the corp-actions join gets much simpler
    // and this case is the thing that notices.
    const raw = JSON.parse(BODY.AAPL) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), [
      "description",
      "endDate",
      "exchangeCode",
      "name",
      "startDate",
      "ticker",
    ]);
    assert.equal("permaTicker" in raw, false);
  });

  test("a 200 with name: null parses, and keeps the null", () => {
    // CTEST-I is a real NYSE test ticker. A parser that coerced this would
    // write "null" or "" into a column whose emptiness is the search ranking
    // signal.
    // MUTATION: `name: String(r.name)` -> name becomes "null" and this fails.
    const m = meta(BODY.CTEST);
    assert.equal(m.ticker, "CTEST-I");
    assert.equal(m.name, null);
  });

  test("null dates survive as null (LEH)", () => {
    const m = meta(BODY.LEH);
    assert.equal(m.name, "LEHMAN BROTHERS HOLDINGS INC");
    assert.equal(m.startDate, null);
    assert.equal(m.exchangeCode, null);
  });

  test("a body with no ticker is not metadata", () => {
    // The 404 body shape. `getFeedAsset` maps 404 -> null so this should not
    // reach the parser, but "should not reach" is not a guarantee.
    assert.equal(parseTiingoMetadata(BODY.NOT_FOUND), null);
  });

  test("malformed input returns null rather than throwing", () => {
    for (const bad of ["", "not json", "[]", "null", '"a string"', "42"]) {
      assert.equal(parseTiingoMetadata(bad), null, bad);
    }
  });

  test("whitespace-only strings read as absent, not as values", () => {
    const m = parseTiingoMetadata(
      '{"ticker":"X","name":"   ","startDate":"  ","exchangeCode":""}',
    );
    assert.ok(m);
    assert.equal(m.name, null);
    assert.equal(m.startDate, null);
    assert.equal(m.exchangeCode, null);
  });
});

describe("resolveUsListingName — the recycled-ticker guard", () => {
  test("the current occupant IS named", () => {
    const out = resolveUsListingName(
      {
        symbol: "DOW",
        exchange: "NYSE",
        listingStartDate: "2019-03-20",
      },
      meta(BODY.DOW),
    );
    assert.deepEqual(out, { kind: "resolved", name: "Dow Inc" });
  });

  test("the PREDECESSOR is refused — Dow Chemical is not Dow Inc", () => {
    // The case the whole guard exists for. Dow Chemical held DOW@NYSE from
    // 1972-06-01; the endpoint has no way to describe it.
    // MUTATION: delete the `meta.startDate !== target.listingStartDate` arm ->
    // this returns {resolved, "Dow Inc"} and the 1972 row is mislabelled.
    const out = resolveUsListingName(
      { symbol: "DOW", exchange: "NYSE", listingStartDate: "1972-06-01" },
      meta(BODY.DOW),
    );
    assert.equal(out.kind, "not-this-listing");
    assert.match(
      (out as { reason: string }).reason,
      /starts 2019-03-20, this listing starts 1972-06-01/,
    );
  });

  test("BRKL: Brookline Bancorp does not become a leveraged ETF", () => {
    // Same shape, one venue apart — the successor is on BATS, the predecessor
    // on NASDAQ, so BOTH the date and the exchange disagree.
    const dead = resolveUsListingName(
      { symbol: "BRKL", exchange: "NASDAQ", listingStartDate: "1998-03-25" },
      meta(BODY.BRKL),
    );
    assert.equal(dead.kind, "not-this-listing");

    const live = resolveUsListingName(
      { symbol: "BRKL", exchange: "BATS", listingStartDate: "2026-07-07" },
      meta(BODY.BRKL),
    );
    assert.deepEqual(live, {
      kind: "resolved",
      name: "Corgi BRKB 2x Daily ETF",
    });
  });

  test("a DELISTED, non-recycled listing IS named — the leg's whole point", () => {
    // 31,314 of the 74,125 listings are delisted and user-visible in search.
    // A guard that refused them would make the leg pointless while looking
    // healthy — the BSE `namesCorroborate` failure, one table over.
    const out = resolveUsListingName(
      { symbol: "HOS", exchange: "NYSE", listingStartDate: "2004-03-26" },
      meta(BODY.HOS),
    );
    assert.deepEqual(out, {
      kind: "resolved",
      name: "Hornbeck Offshore Services Inc",
    });
  });

  test("a mutual fund is named too", () => {
    const out = resolveUsListingName(
      { symbol: "VFIAX", exchange: "NMFQS", listingStartDate: "2000-11-13" },
      meta(BODY.VFIAX),
    );
    assert.equal(out.kind, "resolved");
  });

  test("`endDate` is NOT a corroboration key — it disagrees 19% of the time", () => {
    // Measured: 7 of 37 probed rows had a metadata endDate differing from the
    // master's (fund NAVs and equity closes land a day apart). A guard that
    // checked it would refuse a fifth of the universe.
    // MUTATION: add `if (meta.endDate !== target.listingEndDate) refuse` ->
    // this case fails, and so does the whole leg in production.
    const drifted = { ...meta(BODY.AAPL), endDate: "2026-08-26" };
    const out = resolveUsListingName(
      { symbol: "AAPL", exchange: "NASDAQ", listingStartDate: "1980-12-12" },
      drifted,
    );
    assert.equal(out.kind, "resolved");
  });

  test("a disagreeing exchangeCode refuses; an ABSENT one does not", () => {
    // Corroboration, not identity. LEH-shaped responses carry no venue.
    // MUTATION: change `venue !== "" && venue !== exchange` to
    // `venue !== exchange` -> the second half of this case fails.
    const wrongVenue = resolveUsListingName(
      { symbol: "AAPL", exchange: "NYSE", listingStartDate: "1980-12-12" },
      meta(BODY.AAPL),
    );
    assert.equal(wrongVenue.kind, "not-this-listing");

    const noVenue = resolveUsListingName(
      { symbol: "AAPL", exchange: "NYSE", listingStartDate: "1980-12-12" },
      { ...meta(BODY.AAPL), exchangeCode: null },
    );
    assert.equal(noVenue.kind, "resolved");
  });

  test("a response for a DIFFERENT ticker is refused", () => {
    const out = resolveUsListingName(
      { symbol: "AAPL", exchange: "NASDAQ", listingStartDate: "1980-12-12" },
      meta(BODY.DOW),
    );
    assert.equal(out.kind, "not-this-listing");
    assert.match((out as { reason: string }).reason, /asked for AAPL/);
  });

  test("ticker matching is case- and whitespace-insensitive", () => {
    const out = resolveUsListingName(
      { symbol: " aapl ", exchange: "NASDAQ", listingStartDate: "1980-12-12" },
      meta(BODY.AAPL),
    );
    assert.equal(out.kind, "resolved");
  });

  test("a null name is `unnamed`, an ANSWER — not a failure and not a write", () => {
    const out = resolveUsListingName(
      { symbol: "CTEST-I", exchange: "NYSE", listingStartDate: "2019-07-25" },
      meta(BODY.CTEST),
    );
    assert.deepEqual(out, { kind: "unnamed" });
  });

  test("`unnamed` is checked BEFORE the date guard", () => {
    // Ordering matters for the COUNTERS: a nameless response on a predecessor
    // row is nothing-to-write for the boring reason, and reporting it as
    // `notThisListing` would inflate the number an operator reads as the
    // recycling ceiling.
    const out = resolveUsListingName(
      { symbol: "CTEST-I", exchange: "NYSE", listingStartDate: "1999-01-01" },
      meta(BODY.CTEST),
    );
    assert.equal(out.kind, "unnamed");
  });

  test("no startDate on either side is `unverifiable`, never a write", () => {
    // LEH's shape. It is not reachable from our population (LEH is absent from
    // supported_tickers.zip entirely), and the conservative arm costs nothing.
    // MUTATION: return {resolved} when meta.startDate is null -> this fails,
    // and a recycled ticker with a dateless response names the wrong company.
    const noMetaDate = resolveUsListingName(
      { symbol: "LEH", exchange: "NYSE", listingStartDate: "1994-01-01" },
      meta(BODY.LEH),
    );
    assert.equal(noMetaDate.kind, "unverifiable");

    const noRowDate = resolveUsListingName(
      { symbol: "AAPL", exchange: "NASDAQ", listingStartDate: null },
      meta(BODY.AAPL),
    );
    assert.equal(noRowDate.kind, "unverifiable");
  });
});

describe("run sizing — the 600s deadline and the convergence sum", () => {
  test("both pages fit inside the budget at COMMERCIAL pacing", () => {
    // 3_600_000 / 20_000 = 180 ms per request, and the pacer spreads EVENLY.
    // If a page were raised past this the run would overrun the ack deadline
    // and Pub/Sub would redeliver INTO a still-running copy.
    const PACE_MS = Math.ceil(3_600_000 / 20_000);
    assert.equal(PACE_MS, 180);
    const nominalMs = (US_NAME_PAGE_SIZE + US_SEARCH_PAGE_SIZE) * PACE_MS;
    assert.equal(nominalMs, 360_000);
    assert.ok(
      nominalMs < US_ENRICH_BUDGET_MS,
      `pages cost ${nominalMs}ms against a ${US_ENRICH_BUDGET_MS}ms budget`,
    );
  });

  test("the budget leaves real headroom under the 600s ack deadline", () => {
    // The check is BETWEEN items, so the wall is `budget + one request`, and
    // one request can carry a 30s fetch timeout plus a retry ladder.
    const ACK_DEADLINE_MS = 600_000;
    assert.ok(ACK_DEADLINE_MS - US_ENRICH_BUDGET_MS >= 120_000);
  });

  test("the whole chain lands before us-eod-sync's 11:00 IST trigger", () => {
    // The two jobs spend the same metered account and `paceTiingoRequest` is
    // per-PROCESS state, so overlapping them paces independently against one
    // ceiling. Prod cron is `0 10 * * 2-6`; the EOD job is `0 11 * * 2-6`.
    // MUTATION: raise US_ENRICH_MAX_CHAIN_DEPTH to 10 -> 70 min, fails here.
    const worstCaseMs = US_ENRICH_MAX_CHAIN_DEPTH * US_ENRICH_BUDGET_MS;
    assert.ok(
      worstCaseMs < 60 * 60_000,
      `${worstCaseMs / 60_000} min of chain against a 60 min window`,
    );
  });

  test("the convergence arithmetic is what the comments claim", () => {
    // 74,125 listings (72,685 distinct tickers), 41,371 of them ACTIVE —
    // measured against the live master 2026-08-28.
    const LISTINGS = 74_125;
    const ACTIVE = 41_371;
    const runsPerNight = US_ENRICH_MAX_CHAIN_DEPTH; // depths 0..MAX-1
    assert.equal(Math.ceil(LISTINGS / (runsPerNight * US_NAME_PAGE_SIZE)), 9);
    assert.equal(Math.ceil(ACTIVE / (runsPerNight * US_SEARCH_PAGE_SIZE)), 8);

    // And the nightly spend stays inside COMMERCIAL's 150k/day beside
    // us-eod-sync's ~41,371.
    const nightly = runsPerNight * (US_NAME_PAGE_SIZE + US_SEARCH_PAGE_SIZE);
    assert.ok(nightly + ACTIVE < 150_000, `${nightly + ACTIVE} requests/day`);
  });
});

describe("usEnrichmentDeadlines", () => {
  test("the split is proportional to the pages and sums to the budget", () => {
    // MUTATION: give names the FULL budget -> the search leg gets zero rows a
    // night for a whole convergence cycle while every log line reads normally.
    const t0 = 1_700_000_000_000;
    const { nameDeadlineAtMs, searchDeadlineAtMs } = usEnrichmentDeadlines(t0);
    assert.equal(searchDeadlineAtMs, t0 + US_ENRICH_BUDGET_MS);
    assert.ok(nameDeadlineAtMs > t0);
    assert.ok(nameDeadlineAtMs < searchDeadlineAtMs);

    const PACE_MS = 180;
    // Each leg's slice must cover its own page at nominal pacing, or the
    // budget bites on a HEALTHY night.
    assert.ok(nameDeadlineAtMs - t0 >= US_NAME_PAGE_SIZE * PACE_MS);
    assert.ok(
      searchDeadlineAtMs - nameDeadlineAtMs >= US_SEARCH_PAGE_SIZE * PACE_MS,
    );
  });

  test("deadlines are absolute against the instant passed in", () => {
    const a = usEnrichmentDeadlines(1_000);
    const b = usEnrichmentDeadlines(2_000);
    assert.equal(b.nameDeadlineAtMs - a.nameDeadlineAtMs, 1_000);
    assert.equal(b.searchDeadlineAtMs - a.searchDeadlineAtMs, 1_000);
  });
});

describe("normalizeUsChainDepth", () => {
  test("anything that is not a finite non-negative number reads as 0", () => {
    for (const bad of [
      undefined,
      null,
      "3",
      {},
      [],
      NaN,
      Infinity,
      -Infinity,
      -1,
      -0.5,
      true,
    ]) {
      assert.equal(normalizeUsChainDepth(bad), 0, String(bad));
    }
  });

  test("a forged large value is CLAMPED to the ceiling, which ENDS the chain", () => {
    // Clamping up rather than to 0 is the safe direction: at the ceiling
    // `shouldChainUsEnrichment` refuses, so a hostile message terminates
    // immediately instead of buying itself a fresh chain.
    // MUTATION: `return 0` for out-of-range -> a forged 99999 restarts the
    // chain at depth 0 and this fails.
    assert.equal(normalizeUsChainDepth(99_999), US_ENRICH_MAX_CHAIN_DEPTH);
    assert.equal(
      shouldChainUsEnrichment({
        chainDepth: normalizeUsChainDepth(99_999),
        nameSelected: US_NAME_PAGE_SIZE,
        namePageSize: US_NAME_PAGE_SIZE,
        searchSelected: US_SEARCH_PAGE_SIZE,
        searchPageSize: US_SEARCH_PAGE_SIZE,
      }),
      false,
    );
  });

  test("fractions floor", () => {
    assert.equal(normalizeUsChainDepth(2.9), 2);
    assert.equal(normalizeUsChainDepth(0.4), 0);
  });
});

describe("shouldChainUsEnrichment — the termination proof", () => {
  const full = (chainDepth: number) => ({
    chainDepth,
    nameSelected: US_NAME_PAGE_SIZE,
    namePageSize: US_NAME_PAGE_SIZE,
    searchSelected: US_SEARCH_PAGE_SIZE,
    searchPageSize: US_SEARCH_PAGE_SIZE,
  });

  test("an adversarial always-more-work environment still terminates", () => {
    // The bound must not depend on the database, the clock or the queue. Drive
    // the decision in a loop against a page that is ALWAYS full and assert the
    // loop ends — and that it ends at exactly MAX runs, so the constant means
    // what the comments compute with.
    let depth = 0;
    let runs = 1;
    while (shouldChainUsEnrichment(full(depth))) {
      depth += 1;
      runs += 1;
      assert.ok(runs <= 1000, "chain did not terminate");
    }
    assert.equal(runs, US_ENRICH_MAX_CHAIN_DEPTH);
  });

  test("either leg filling its page is enough to chain", () => {
    assert.equal(
      shouldChainUsEnrichment({ ...full(0), searchSelected: 0 }),
      true,
    );
    assert.equal(
      shouldChainUsEnrichment({ ...full(0), nameSelected: 0 }),
      true,
    );
  });

  test("both legs short ends the chain", () => {
    assert.equal(
      shouldChainUsEnrichment({
        ...full(0),
        nameSelected: US_NAME_PAGE_SIZE - 1,
        searchSelected: US_SEARCH_PAGE_SIZE - 1,
      }),
      false,
    );
  });

  test("a CONVERGED night still chains — progress is NOT the condition", () => {
    // These legs converge, so a fully-converged run writes zero and must still
    // advance the rotation. Making writes the chain condition would stop the
    // job the moment it finished its job.
    assert.equal(shouldChainUsEnrichment(full(0)), true);
  });
});
