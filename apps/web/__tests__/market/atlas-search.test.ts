/**
 * `$search` pipeline shape for apps/web/lib/market/atlas-search.ts.
 *
 * De-shadowed: every assertion below drives the REAL exported builders
 * (`buildInstrumentSearchPipeline`, `buildMfSearchPipeline`,
 * `buildAutocompletePipeline`), which MONEY-1128 extracted from the query
 * functions precisely so the operator/field pairing could be unit-tested
 * without a cluster. This file previously reimplemented those builders inline
 * and asserted against the copies, so it passed no matter what shipped — and
 * after MONEY-1128 it actively documented the superseded behaviour.
 *
 * Scope split, deliberately:
 *   - availability, the 5-minute latch and error classification are NOT here.
 *     They moved to the shared gate and are covered by
 *     `packages/core/__tests__/search-atlas-gate.test.ts` and
 *     `apps/web/__tests__/market/atlas-search-gate.test.ts`.
 *   - `atlas-search-gate.test.ts` owns the "operators a token-mapped field can
 *     match" argument end to end through prisma. This file owns the rest of the
 *     pipeline: which legs exist, their fuzzy settings, `$limit` and `$project`.
 *
 * Why the shape is worth pinning at all: a `$search` pipeline is data, so a
 * wrong operator, path or fuzzy setting is not a type error and not a runtime
 * error — the query simply returns fewer rows (or zero) and the caller falls
 * through to the regex fallback. There is no signal short of an assertion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildInstrumentSearchPipeline,
  buildMfSearchPipeline,
  buildAutocompletePipeline,
} from "@/lib/market/atlas-search";

// ── helpers ─────────────────────────────────────────────────────────────────

type Doc = Record<string, unknown>;

function asDoc(value: unknown, what: string): Doc {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${what} is an object`
  );
  return value as Doc;
}

function asDocs(value: unknown, what: string): Doc[] {
  assert.ok(Array.isArray(value), `${what} is an array`);
  return value as Doc[];
}

/** The operator key of every stage, in order. */
function stageShape(pipeline: Doc[]): string[][] {
  return pipeline.map((stage) => Object.keys(stage));
}

function searchStage(pipeline: Doc[]): Doc {
  return asDoc(pipeline[0]?.["$search"], "$search stage");
}

function compoundOf(pipeline: Doc[]): Doc {
  return asDoc(searchStage(pipeline).compound, "$search.compound");
}

function filtersOf(pipeline: Doc[]): Doc[] {
  return asDocs(compoundOf(pipeline).filter, "compound.filter");
}

/**
 * The scoring legs: `compound.must[0]` is itself a `compound` whose `should`
 * holds the alternative match strategies (prefix / typo / sector).
 */
function nestedCompound(pipeline: Doc[]): Doc {
  const must = asDocs(compoundOf(pipeline).must, "compound.must");
  assert.strictEqual(must.length, 1, "must holds exactly one clause");
  return asDoc(must[0]?.compound, "compound.must[0].compound");
}

function matchLegs(pipeline: Doc[]): Doc[] {
  return asDocs(nestedCompound(pipeline).should, "must[0].compound.should");
}

/** `[operator, path]` for each clause, in order — the clause's identity. */
function signature(clauses: Doc[]): Array<[string, unknown]> {
  return clauses.map((clause) => {
    const entries = Object.entries(clause);
    assert.strictEqual(
      entries.length,
      1,
      "a clause names exactly one operator"
    );
    const [operator, body] = entries[0] as [string, unknown];
    return [operator, asDoc(body, `${operator} body`).path];
  });
}

/** Body of the clause using `operator` on `path`. */
function clause(
  clauses: Doc[],
  operator: string,
  path: string | string[]
): Doc {
  const wanted = JSON.stringify(path);
  const found = clauses.find((c) => {
    const body = c[operator];
    return (
      body !== null &&
      typeof body === "object" &&
      JSON.stringify((body as Doc).path) === wanted
    );
  });
  assert.ok(found, `a \`${operator}\` clause on ${wanted} exists`);
  return asDoc(found[operator], `${operator} body`);
}

function limitOf(pipeline: Doc[]): unknown {
  return pipeline[1]?.["$limit"];
}

function projectionOf(pipeline: Doc[]): Doc {
  return asDoc(pipeline[2]?.["$project"], "$project stage");
}

const PREFIX_FUZZY = { maxEdits: 1, prefixLength: 1 };
const WORD_FUZZY = { maxEdits: 1, prefixLength: 2 };

// ════════════════════════════════════════════════════════════════════════════

describe("buildInstrumentSearchPipeline (real module)", () => {
  it("is exactly [$search, $limit, $project]", () => {
    assert.deepStrictEqual(stageShape(buildInstrumentSearchPipeline("tcs")), [
      ["$search"],
      ["$limit"],
      ["$project"],
    ]);
  });

  it("targets the instrument_search index", () => {
    assert.strictEqual(
      searchStage(buildInstrumentSearchPipeline("tcs")).index,
      "instrument_search"
    );
  });

  it("scores five alternative match strategies under one minimumShouldMatch:1", () => {
    const pipeline = buildInstrumentSearchPipeline("tcs");
    assert.strictEqual(nestedCompound(pipeline).minimumShouldMatch, 1);
    assert.deepStrictEqual(signature(matchLegs(pipeline)), [
      ["autocomplete", "symbol"],
      ["autocomplete", "name"],
      ["text", ["symbol", "name"]],
      ["text", "sector"],
      // MONEY-1177 — former tickers (ZOMATO -> ETERNAL).
      ["text", "previousSymbols"],
    ]);
  });

  it("the previousSymbols leg is SAFE before the Atlas index maps the field", () => {
    // The INSTRUMENTS index definition lives in the Atlas UI, not this repo, so
    // this leg ships before the field is mapped. That is deliberate and safe
    // ONLY because it sits inside a `should` with minimumShouldMatch: 1 —
    // Atlas does not error on an unmapped path, the leg simply matches nothing
    // until the index catches up. If either property ever changes, a search for
    // a live symbol could start returning zero results.
    const pipeline = buildInstrumentSearchPipeline("tcs");
    assert.strictEqual(nestedCompound(pipeline).minimumShouldMatch, 1);
    const legs = matchLegs(pipeline);
    assert.ok(
      legs.length > 1,
      "previousSymbols must never be the ONLY leg — it would be the whole query"
    );
    assert.deepStrictEqual(
      clause(legs, "text", "previousSymbols").query,
      "tcs"
    );
  });

  it("gives every leg the caller's query verbatim", () => {
    const legs = matchLegs(buildInstrumentSearchPipeline("reliance ind"));
    for (const leg of legs) {
      const body = asDoc(Object.values(leg)[0], "leg body");
      assert.strictEqual(body.query, "reliance ind");
    }
  });

  it("tunes prefix fuzziness per path: symbol from 1 char, name from 2", () => {
    const legs = matchLegs(buildInstrumentSearchPipeline("tcs"));
    assert.deepStrictEqual(
      clause(legs, "autocomplete", "symbol").fuzzy,
      PREFIX_FUZZY
    );
    assert.deepStrictEqual(
      clause(legs, "autocomplete", "name").fuzzy,
      WORD_FUZZY
    );
  });

  it("fuzzy-matches the free-text symbol/name leg by default", () => {
    const legs = matchLegs(buildInstrumentSearchPipeline("relianse"));
    assert.deepStrictEqual(
      clause(legs, "text", ["symbol", "name"]).fuzzy,
      WORD_FUZZY
    );
  });

  it("fuzzy:false drops fuzzy from the text leg but keeps the autocomplete legs", () => {
    const legs = matchLegs(
      buildInstrumentSearchPipeline("tcs", { fuzzy: false })
    );
    const text = clause(legs, "text", ["symbol", "name"]);
    assert.ok(
      !("fuzzy" in text),
      "fuzzy is omitted, not set to undefined (Atlas rejects a null operator)"
    );
    assert.deepStrictEqual(
      clause(legs, "autocomplete", "symbol").fuzzy,
      PREFIX_FUZZY,
      "prefix matching is not what `fuzzy:false` turns off"
    );
  });

  it("matches the sector leg exactly — no fuzz on a taxonomy value", () => {
    const sector = clause(
      matchLegs(buildInstrumentSearchPipeline("IT")),
      "text",
      "sector"
    );
    assert.deepStrictEqual(Object.keys(sector).sort(), ["path", "query"]);
  });

  it("always filters isActive=true", () => {
    const filters = filtersOf(buildInstrumentSearchPipeline("tcs"));
    assert.deepStrictEqual(filters[0], {
      equals: { path: "isActive", value: true },
    });
  });

  it("carries the requested instrumentType values into an `in` filter", () => {
    const filters = filtersOf(
      buildInstrumentSearchPipeline("tcs", { types: ["EQUITY", "ETF"] })
    );
    assert.deepStrictEqual(signature(filters), [
      ["equals", "isActive"],
      ["in", "instrumentType"],
    ]);
    assert.deepStrictEqual(clause(filters, "in", "instrumentType").value, [
      "EQUITY",
      "ETF",
    ]);
  });

  it("omits the type filter for an empty types array", () => {
    const filters = filtersOf(
      buildInstrumentSearchPipeline("tcs", { types: [] })
    );
    assert.deepStrictEqual(signature(filters), [["equals", "isActive"]]);
  });

  it("filters exchange with `equals` on the uppercased token", () => {
    const filters = filtersOf(
      buildInstrumentSearchPipeline("tcs", { exchange: "nse" })
    );
    assert.deepStrictEqual(filters[filters.length - 1], {
      equals: { path: "exchange", value: "NSE" },
    });
  });

  it("defaults $limit to 15 and honours an explicit limit", () => {
    assert.strictEqual(limitOf(buildInstrumentSearchPipeline("tcs")), 15);
    assert.strictEqual(
      limitOf(buildInstrumentSearchPipeline("tcs", { limit: 5 })),
      5
    );
  });

  it("projects exactly the fields the caller reads, plus the relevance score", () => {
    assert.deepStrictEqual(projectionOf(buildInstrumentSearchPipeline("tcs")), {
      symbol: 1,
      name: 1,
      exchange: 1,
      yahooSymbol: 1,
      instrumentType: 1,
      sector: 1,
      score: { $meta: "searchScore" },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe("buildMfSearchPipeline (real module)", () => {
  it("is exactly [$search, $limit, $project]", () => {
    assert.deepStrictEqual(stageShape(buildMfSearchPipeline("hdfc")), [
      ["$search"],
      ["$limit"],
      ["$project"],
    ]);
  });

  it("targets the mf_search index", () => {
    assert.strictEqual(
      searchStage(buildMfSearchPipeline("hdfc")).index,
      "mf_search"
    );
  });

  it("scores three alternative match strategies under one minimumShouldMatch:1", () => {
    const pipeline = buildMfSearchPipeline("hdfc");
    assert.strictEqual(nestedCompound(pipeline).minimumShouldMatch, 1);
    assert.deepStrictEqual(signature(matchLegs(pipeline)), [
      ["autocomplete", "schemeName"],
      ["autocomplete", "amcName"],
      ["text", ["schemeName", "amcName", "schemeCode", "category"]],
    ]);
  });

  it("gives every leg the caller's query verbatim", () => {
    const legs = matchLegs(buildMfSearchPipeline("hdfc fle"));
    for (const leg of legs) {
      const body = asDoc(Object.values(leg)[0], "leg body");
      assert.strictEqual(body.query, "hdfc fle");
    }
  });

  it("prefix-matches scheme and AMC names from 2 characters", () => {
    const legs = matchLegs(buildMfSearchPipeline("hdfc"));
    assert.deepStrictEqual(
      clause(legs, "autocomplete", "schemeName").fuzzy,
      WORD_FUZZY
    );
    assert.deepStrictEqual(
      clause(legs, "autocomplete", "amcName").fuzzy,
      WORD_FUZZY
    );
  });

  it("fuzzy-matches the free-text leg by default and drops it on fuzzy:false", () => {
    const path = ["schemeName", "amcName", "schemeCode", "category"];
    assert.deepStrictEqual(
      clause(matchLegs(buildMfSearchPipeline("hdfc")), "text", path).fuzzy,
      WORD_FUZZY
    );
    const strict = clause(
      matchLegs(buildMfSearchPipeline("hdfc", { fuzzy: false })),
      "text",
      path
    );
    assert.ok(!("fuzzy" in strict));
  });

  it("filters on isActive and nothing else", () => {
    assert.deepStrictEqual(filtersOf(buildMfSearchPipeline("hdfc")), [
      { equals: { path: "isActive", value: true } },
    ]);
  });

  it("defaults $limit to 10 and honours an explicit limit", () => {
    assert.strictEqual(limitOf(buildMfSearchPipeline("hdfc")), 10);
    assert.strictEqual(
      limitOf(buildMfSearchPipeline("hdfc", { limit: 20 })),
      20
    );
  });

  it("projects exactly the MF fields, plus the relevance score", () => {
    assert.deepStrictEqual(projectionOf(buildMfSearchPipeline("hdfc")), {
      schemeCode: 1,
      schemeName: 1,
      amcName: 1,
      category: 1,
      nav: 1,
      score: { $meta: "searchScore" },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe("buildAutocompletePipeline (real module)", () => {
  it("is exactly [$search, $limit, $project]", () => {
    assert.deepStrictEqual(stageShape(buildAutocompletePipeline("rel")), [
      ["$search"],
      ["$limit"],
      ["$project"],
    ]);
  });

  it("targets the instrument_search index", () => {
    assert.strictEqual(
      searchStage(buildAutocompletePipeline("rel")).index,
      "instrument_search"
    );
  });

  it("puts the legs in a top-level `should` — there is no `must` to satisfy", () => {
    const compound = compoundOf(buildAutocompletePipeline("rel"));
    assert.ok(!("must" in compound), "a must clause would AND the two paths");
    assert.strictEqual(compound.minimumShouldMatch, 1);
  });

  it("edge-grams symbol and name with sequential tokenOrder and no fuzz", () => {
    const should = asDocs(
      compoundOf(buildAutocompletePipeline("rel")).should,
      "compound.should"
    );
    assert.deepStrictEqual(should.slice(0, 2), [
      {
        autocomplete: {
          query: "rel",
          path: "symbol",
          tokenOrder: "sequential",
        },
      },
      {
        autocomplete: { query: "rel", path: "name", tokenOrder: "sequential" },
      },
    ]);
  });

  it("carries a `text` leg so a long query is not answered with nothing", () => {
    // MONEY-1205. The two edge-gram legs above are sequential PHRASE matches
    // and, measured against prod, they die at four tokens: "SBI NIFTY 200" → 1
    // hit, "SBI NIFTY 200 QUALITY" → 0; "Reliance Industries Limited" → 1,
    // "Tata Consultancy Services Limited" → 0 — for names present verbatim in
    // the collection. Every PfSymbolPicker and both news-alert drawers went
    // blank for anyone typing a full company name. `text` is a per-token OR
    // under the enclosing minimumShouldMatch: 1, so a long query degrades to
    // best-overlap-first instead of empty.
    const should = asDocs(
      compoundOf(buildAutocompletePipeline("tata consultancy services limited"))
        .should,
      "compound.should"
    );
    assert.deepStrictEqual(signature(should), [
      ["autocomplete", "symbol"],
      ["autocomplete", "name"],
      ["text", ["symbol", "name"]],
    ]);
    assert.deepStrictEqual(clause(should, "text", ["symbol", "name"]), {
      query: "tata consultancy services limited",
      path: ["symbol", "name"],
      fuzzy: { maxEdits: 1, prefixLength: 2 },
    });
  });

  it("still requires only ONE leg to match (the legs must not become an AND)", () => {
    const compound = compoundOf(buildAutocompletePipeline("rel"));
    assert.ok(!("must" in compound));
    assert.strictEqual(compound.minimumShouldMatch, 1);
  });

  it("always filters isActive=true", () => {
    assert.deepStrictEqual(filtersOf(buildAutocompletePipeline("rel")), [
      { equals: { path: "isActive", value: true } },
    ]);
  });

  it("carries the requested instrumentType values into an `in` filter", () => {
    const filters = filtersOf(
      buildAutocompletePipeline("rel", { types: ["EQUITY"] })
    );
    assert.deepStrictEqual(signature(filters), [
      ["equals", "isActive"],
      ["in", "instrumentType"],
    ]);
    assert.deepStrictEqual(clause(filters, "in", "instrumentType").value, [
      "EQUITY",
    ]);
  });

  it("omits the type filter for an empty types array", () => {
    const filters = filtersOf(buildAutocompletePipeline("rel", { types: [] }));
    assert.deepStrictEqual(signature(filters), [["equals", "isActive"]]);
  });

  it("defaults $limit to 8 and honours an explicit limit", () => {
    assert.strictEqual(limitOf(buildAutocompletePipeline("rel")), 8);
    assert.strictEqual(
      limitOf(buildAutocompletePipeline("rel", { limit: 3 })),
      3
    );
  });

  it("projects the four dropdown fields and suppresses _id", () => {
    assert.deepStrictEqual(projectionOf(buildAutocompletePipeline("rel")), {
      symbol: 1,
      name: 1,
      exchange: 1,
      instrumentType: 1,
      _id: 0,
    });
  });
});

/**
 * MONEY-1263 — the Atlas path must be venue-scoped, and this defect is
 * PROD-ONLY.
 *
 * QA has no Atlas Search index and falls back to the regex query, which already
 * pins `exchange: { in: ["NSE","BSE"] }`. So an unscoped Atlas filter cannot be
 * reproduced in QA at all: the feature tests clean there and then returns US
 * securities to Indian users on prod, once the US master lands ~72,685 rows in
 * the shared `instrument_mappings` collection — the Atlas index covers new
 * documents automatically, so nothing has to be re-indexed for it to happen.
 */
describe("instrument search is scoped to Indian venues (MONEY-1263)", () => {
  const filtersOf = (
    pipeline: Record<string, unknown>[]
  ): Record<string, unknown>[] => {
    const search = pipeline[0]?.$search as Record<string, unknown> | undefined;
    const compound = search?.compound as Record<string, unknown> | undefined;
    return (compound?.filter ?? []) as Record<string, unknown>[];
  };
  const exchangeFilter = (
    pipeline: Record<string, unknown>[]
  ): Record<string, unknown> | undefined =>
    filtersOf(pipeline).find(
      (f) =>
        (f.in as { path?: string } | undefined)?.path === "exchange" ||
        (f.equals as { path?: string } | undefined)?.path === "exchange"
    );

  it("emits an `in` filter on the token-mapped exchange field", () => {
    const pipeline = buildInstrumentSearchPipeline("AAPL", {
      exchanges: ["NSE", "BSE"],
    });
    const ex = exchangeFilter(pipeline);
    assert.ok(ex, "no exchange filter emitted");
    assert.deepEqual((ex.in as { value: string[] }).value, ["NSE", "BSE"]);
  });

  it("uses `in`, never `text` — text cannot match a token field", () => {
    // MONEY-1128: `text` against a token-mapped field matches NOTHING and
    // returns zero rows silently. That is why this asserts the OPERATOR rather
    // than merely the presence of a filter.
    const pipeline = buildInstrumentSearchPipeline("AAPL", {
      exchanges: ["NSE", "BSE"],
    });
    for (const f of filtersOf(pipeline)) {
      assert.notEqual(
        (f.text as { path?: string } | undefined)?.path,
        "exchange",
        "exchange filtered with `text`, which silently matches nothing"
      );
    }
  });

  it("normalises casing, because token matching is exact", () => {
    const pipeline = buildInstrumentSearchPipeline("x", {
      exchanges: ["nse", "bse"],
    });
    assert.deepEqual(
      (exchangeFilter(pipeline)!.in as { value: string[] }).value,
      ["NSE", "BSE"]
    );
  });

  it("omitting the scope emits NO exchange filter — the state this fixes", () => {
    // Pinned so an unscoped search is a deliberate choice at a call site,
    // never the default a new caller inherits.
    assert.equal(
      exchangeFilter(buildInstrumentSearchPipeline("AAPL", {})),
      undefined
    );
  });
});
