/**
 * MONEY-1263 — permaTicker resolution via Tiingo's `utilities/search`.
 *
 * Every fixture below is REAL response shape captured 2026-08-28. The property
 * under test is refusal: a permaTicker is a claim that a corporate-action row
 * belongs to this instrument, so a near-match attaches another company's
 * dividends and splits to it — silently, and indistinguishably from correct
 * data.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveSearchMatch,
  parseSearchResponse,
  type TiingoSearchRow,
} from "../../src/market-data/instruments/tiingo-search-logic";
import { enrichUsInstrumentsWithPermaTicker } from "../../src/market-data/instruments/tiingo-search";

const row = (over: Partial<TiingoSearchRow>): TiingoSearchRow => ({
  ticker: "AAPL",
  name: "Apple Inc",
  permaTicker: "US000000000038",
  openFIGIComposite: "BBG000B9XRY4",
  assetType: "Stock",
  isActive: true,
  countryCode: "US",
  ...over,
});

describe("resolveSearchMatch", () => {
  test("resolves a clean single US match", () => {
    const r = resolveSearchMatch("DOW", [
      row({ ticker: "DOW", name: "Dow Inc", permaTicker: "US000000077649" }),
    ]);
    assert.equal(r.kind, "resolved");
    assert.equal(r.kind === "resolved" && r.permaTicker, "US000000077649");
  });

  test("THE FUZZY TRAP: query=APP returns APPB/APPC, and none of them is APP", () => {
    // Measured: `?query=APP` returns APP, APP, APPB, APPC, APPC, APPCF. This is
    // a PREFIX search, not a lookup. Taking results[0] would hand APP's row to
    // whichever prefix match happened to sort first.
    const r = resolveSearchMatch("APPB", [
      row({ ticker: "APP", permaTicker: "US000000000111" }),
      row({ ticker: "APPB", permaTicker: "US000000000222" }),
      row({ ticker: "APPC", permaTicker: "US000000000333" }),
    ]);
    assert.equal(r.kind === "resolved" && r.permaTicker, "US000000000222");
  });

  test("a prefix-only response resolves NOTHING for the queried ticker", () => {
    const r = resolveSearchMatch("APP", [
      row({ ticker: "APPB", permaTicker: "US000000000222" }),
      row({ ticker: "APPC", permaTicker: "US000000000333" }),
    ]);
    assert.equal(r.kind, "unmatched");
  });

  test("THE COUNTRY TRAP: AAPL returns both a US and a CA listing", () => {
    // Measured: AAPL yields US000000000038 AND CA000000137372, each an exact
    // ticker match, each genuinely Apple in its own market. Only ours is ours.
    const r = resolveSearchMatch("AAPL", [
      row({ countryCode: "CA", permaTicker: "CA000000137372" }),
      row({ countryCode: "US", permaTicker: "US000000000038" }),
    ]);
    assert.equal(r.kind === "resolved" && r.permaTicker, "US000000000038");
  });

  test("THE AMBIGUITY TRAP: two US rows share a ticker, so nothing is written", () => {
    // Measured: `?query=APP` returns the ticker APP TWICE. Picking either would
    // be a coin flip that reads as certainty downstream.
    const r = resolveSearchMatch("APP", [
      row({ ticker: "APP", permaTicker: "US000000000111" }),
      row({ ticker: "APP", permaTicker: "US000000000999" }),
    ]);
    assert.equal(r.kind, "ambiguous");
    assert.deepEqual(r.kind === "ambiguous" && r.candidates, [
      "US000000000111",
      "US000000000999",
    ]);
  });

  test("a non-US-only match is unmatched, not silently accepted", () => {
    const r = resolveSearchMatch("AAPL", [
      row({ countryCode: "CA", permaTicker: "CA000000137372" }),
    ]);
    assert.equal(r.kind, "unmatched");
  });

  test("matching is case-insensitive and whitespace-tolerant", () => {
    assert.equal(
      resolveSearchMatch("  aapl  ", [row({ ticker: "AAPL" })]).kind,
      "resolved",
    );
  });

  test("an empty permaTicker is NOT a resolution", () => {
    // An empty string written into a join key is worse than a null: it matches
    // nothing and looks populated.
    assert.equal(
      resolveSearchMatch("AAPL", [row({ permaTicker: "  " })]).kind,
      "unmatched",
    );
  });

  test("empty inputs are unmatched", () => {
    assert.equal(resolveSearchMatch("AAPL", []).kind, "unmatched");
    assert.equal(resolveSearchMatch("", [row({})]).kind, "unmatched");
  });

  test("a missing openFIGIComposite does not block the permaTicker", () => {
    const r = resolveSearchMatch("AAPL", [row({ openFIGIComposite: null })]);
    assert.equal(r.kind, "resolved");
    assert.equal(r.kind === "resolved" && r.openFIGIComposite, null);
  });
});

describe("parseSearchResponse", () => {
  test("parses the real seven-field shape", () => {
    const rows = parseSearchResponse(
      JSON.stringify([
        {
          name: "Apple Inc",
          ticker: "AAPL",
          permaTicker: "US000000000038",
          openFIGIComposite: "BBG000B9XRY4",
          assetType: "Stock",
          isActive: true,
          countryCode: "US",
        },
      ]),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.permaTicker, "US000000000038");
    assert.equal(rows[0]!.isActive, true);
  });

  test("drops a row missing ticker or permaTicker instead of half-parsing it", () => {
    const rows = parseSearchResponse(
      JSON.stringify([
        { ticker: "AAPL", permaTicker: "US000000000038" },
        { ticker: "NOPERMA" },
        { permaTicker: "US000000000999" },
        "not an object",
        null,
      ]),
    );
    assert.equal(rows.length, 1);
  });

  test("malformed JSON and non-arrays yield [], never a throw", () => {
    assert.deepEqual(parseSearchResponse("not json"), []);
    assert.deepEqual(parseSearchResponse('{"detail":"Not found."}'), []);
    assert.deepEqual(parseSearchResponse("[]"), []);
  });

  test("isActive is strict: only a real boolean true counts", () => {
    const rows = parseSearchResponse(
      JSON.stringify([
        { ticker: "A", permaTicker: "US1", isActive: "true" },
        { ticker: "B", permaTicker: "US2", isActive: true },
      ]),
    );
    assert.equal(rows[0]!.isActive, false);
    assert.equal(rows[1]!.isActive, true);
  });
});

/**
 * MONEY-1264 review, G2 + G3 — the enricher's two preflight guards.
 *
 * These exercise `tiingo-search.ts` (the impure leg), not the pure logic above.
 * They stay hermetic because BOTH guards return before the rotation query, so
 * no database is touched — which is itself the property under test.
 */
describe("enrichUsInstrumentsWithPermaTicker — the guards run BEFORE the rotation query", () => {
  let savedKey: string | undefined;
  let savedFlag: string | undefined;
  let savedDb: string | undefined;
  const realError = console.error;

  beforeEach(() => {
    savedKey = process.env.TIINGO_API_KEY;
    savedFlag = process.env.TIINGO_SEARCH_ENRICH;
    savedDb = process.env.DATABASE_URL;
    // A guard that returns early cannot reach Prisma. Removing the URL makes
    // that falsifiable rather than assumed: if either guard ever stops
    // short-circuiting, the call below reports a Prisma validation error
    // instead of the message asserted, and these tests go red immediately
    // rather than quietly stamping 800 live rows.
    delete process.env.DATABASE_URL;
    console.error = () => {};
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.TIINGO_API_KEY;
    else process.env.TIINGO_API_KEY = savedKey;
    if (savedFlag === undefined) delete process.env.TIINGO_SEARCH_ENRICH;
    else process.env.TIINGO_SEARCH_ENRICH = savedFlag;
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    console.error = realError;
  });

  test("G2 — a missing TIINGO_API_KEY is ONE loud failure, not 5,600 quiet ones", async () => {
    // Without the preflight the key resolves inside `search()`, whose blanket
    // `catch` converts the throw to `null`; the loop then counts a
    // `transportFailure` AND stamps the row. That is 800 rows per run x up to 7
    // chained runs = 5,600 ACTIVE rows a night stamped `searchSyncedAt` with no
    // permaTicker written, reported as upstream failures against an upstream
    // that was never called, and pushed to the back of an 8-night rotation.
    delete process.env.TIINGO_API_KEY;
    process.env.TIINGO_SEARCH_ENRICH = "on";

    const res = await enrichUsInstrumentsWithPermaTicker({ limit: 5 });

    assert.equal(
      res.error,
      "TIINGO_API_KEY is not set",
      "the missing secret must be reported as itself, not as a DB or upstream error",
    );
    // The numbers that made the old failure invisible. `selected` proves the
    // rotation query never ran; `transportFailures` proves nothing was blamed
    // on Tiingo.
    assert.equal(res.selected, 0, "no page may be selected");
    assert.equal(res.transportFailures, 0, "an uncalled upstream cannot fail");
    assert.equal(res.written, 0);
    assert.equal(
      res.disabled,
      false,
      "a missing secret is a FAILURE, not a deliberate skip",
    );
  });

  test("G3 — the kill switch survives a YAML trailing space", async () => {
    // `US_NAME_ENRICH` / `US_MASTER_SYNC` trim and this one did not, while both
    // cloudbuild specs present all four as one family that behaves identically.
    // A key IS present here, so an untrimmed guard falls through to the API-key
    // preflight and then the rotation query — `disabled` stays false and the
    // operator who turned the leg off is still spending quota.
    process.env.TIINGO_API_KEY = "test-token-not-a-real-key";
    for (const raw of ["off", "off ", " off", " OFF ", "\toff\n"]) {
      process.env.TIINGO_SEARCH_ENRICH = raw;
      const res = await enrichUsInstrumentsWithPermaTicker({ limit: 5 });
      assert.equal(res.disabled, true, `${JSON.stringify(raw)} must disable`);
      assert.equal(res.error, undefined, "a deliberate skip is not an error");
      assert.equal(res.selected, 0);
    }
  });

  test("a value that is not `off` still ARMS the leg", async () => {
    // The catch-all half: a guard that trimmed its way into matching everything
    // would disable the leg permanently — the same outage, opposite costume.
    // With the flag armed and a key present, control reaches the rotation
    // query, which fails here only because DATABASE_URL was removed.
    process.env.TIINGO_API_KEY = "test-token-not-a-real-key";
    process.env.TIINGO_SEARCH_ENRICH = "on";

    const res = await enrichUsInstrumentsWithPermaTicker({ limit: 5 });
    assert.equal(res.disabled, false);
    assert.match(
      res.error ?? "",
      /DATABASE_URL/,
      "control must have reached the rotation query",
    );
  });
});
