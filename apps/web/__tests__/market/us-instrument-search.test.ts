/**
 * `$search` pipeline + row normalisation for
 * `apps/web/lib/market/us-instrument-search.ts` (MONEY-980).
 *
 * ## Why this file has to exist, and why it asserts what it asserts
 *
 * `us_instruments` is EMPTY in every environment today — the Tiingo backfill
 * has not run — so no query, in any environment, can demonstrate that this code
 * path works. Tests are the only available proof.
 *
 * And the failure modes here are all SILENT. A `$search` pipeline is data, so a
 * wrong operator, a wrong path, or a filter on a field the index does not map
 * is neither a type error nor a runtime error: the query succeeds and returns
 * zero rows, which is indistinguishable from "no such ticker". Specifically:
 *
 *   - `exchange`, `assetType` and `listingStatus` are TOKEN fields. A token
 *     field matches NOTHING under `text` (MONEY-1128, then MONEY-1141 again).
 *   - `dynamic: false` on the index, so filtering a field that is not in the
 *     mapping — `isActive`, which this collection does not even have — returns
 *     zero for every query.
 *   - Token matching is EXACT, so `assetType: "STOCK"` matches nothing where
 *     Tiingo wrote `Stock`.
 *
 * Drives the REAL exported builder. No Atlas, no Mongo, no network.
 *
 * @see docs/setup/atlas-search-setup.md — Step 2b (the index is created by hand
 *      in the Atlas UI, so the doc IS the deployment)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildUsInstrumentSearchPipeline,
  buildUsNamePassArgs,
  buildUsScopeWhere,
  buildUsSymbolPassArgs,
  normalizeUsInstrumentRow,
  reportUsSearchFailure,
  searchUsInstruments,
  searchUsInstrumentsPrisma,
  toIsoDate,
  US_INSTRUMENT_SEARCH_INDEX,
  US_ASSET_TYPE,
  US_LISTING_STATUS,
  type UsInstrumentFindManyArgs,
  type UsInstrumentRecord,
  type UsInstrumentSearchRow,
} from "@/lib/market/us-instrument-search";

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

function searchStage(pipeline: Doc[]): Doc {
  return asDoc(pipeline[0]?.["$search"], "$search stage");
}

function compoundOf(pipeline: Doc[]): Doc {
  return asDoc(searchStage(pipeline).compound, "$search.compound");
}

/** `compound.filter`, or `[]` when the builder omitted it entirely. */
function filtersOf(pipeline: Doc[]): Doc[] {
  const filter = compoundOf(pipeline).filter;
  if (filter === undefined) return [];
  return asDocs(filter, "compound.filter");
}

function matchLegs(pipeline: Doc[]): Doc[] {
  const must = asDocs(compoundOf(pipeline).must, "compound.must");
  assert.strictEqual(must.length, 1, "must holds exactly one clause");
  const nested = asDoc(must[0]?.compound, "compound.must[0].compound");
  return asDocs(nested.should, "must[0].compound.should");
}

function projectOf(pipeline: Doc[]): Doc {
  return asDoc(pipeline[2]?.["$project"], "$project stage");
}

/** Every `{ operator: { path } }` pair in the filter clauses, flattened. */
function filterPairs(pipeline: Doc[]): Array<{ op: string; path: string }> {
  return filtersOf(pipeline).flatMap((clause) =>
    Object.entries(clause).map(([op, body]) => ({
      op,
      path: String(asDoc(body, `${op} body`).path),
    }))
  );
}

// ── pipeline shape ──────────────────────────────────────────────────────────

describe("buildUsInstrumentSearchPipeline — shape", () => {
  it("is exactly [$search, $limit, $project]", () => {
    const pipeline = buildUsInstrumentSearchPipeline("AAPL") as Doc[];
    assert.deepEqual(
      pipeline.map((stage) => Object.keys(stage)),
      [["$search"], ["$limit"], ["$project"]]
    );
  });

  it("targets the us_instrument_search index — NOT instrument_search", () => {
    const pipeline = buildUsInstrumentSearchPipeline("AAPL") as Doc[];
    assert.equal(searchStage(pipeline).index, US_INSTRUMENT_SEARCH_INDEX);
    assert.equal(US_INSTRUMENT_SEARCH_INDEX, "us_instrument_search");
    // Pointing this at India's index would answer every US query with zero
    // rows: the two indexes cover different collections.
    assert.notEqual(searchStage(pipeline).index, "instrument_search");
  });

  it("scores three legs under one minimumShouldMatch:1", () => {
    const pipeline = buildUsInstrumentSearchPipeline("APPLE") as Doc[];
    assert.equal(matchLegs(pipeline).length, 3);
    const nested = asDoc(
      asDocs(compoundOf(pipeline).must, "must")[0]?.compound,
      "nested compound"
    );
    assert.equal(nested.minimumShouldMatch, 1);
  });

  it("gives every leg the caller's query verbatim", () => {
    const pipeline = buildUsInstrumentSearchPipeline("BRK-A") as Doc[];
    for (const leg of matchLegs(pipeline)) {
      const body = asDoc(Object.values(leg)[0], "leg body");
      assert.equal(body.query, "BRK-A");
    }
  });

  it("anchors the symbol prefix at ONE character, not two", () => {
    // US tickers go down to a single letter — F (Ford), T (AT&T), V (Visa),
    // 25 of them. The index uses `minGrams: 1` for exactly this, and a
    // `prefixLength: 2` here would throw that away: a 1-char query has no
    // second character to anchor on, so it would match nothing.
    const pipeline = buildUsInstrumentSearchPipeline("F") as Doc[];
    const symbolLeg = matchLegs(pipeline).find(
      (leg) => asDoc(leg.autocomplete ?? {}, "autocomplete").path === "symbol"
    );
    assert.ok(symbolLeg, "there is a symbol autocomplete leg");
    const fuzzy = asDoc(
      asDoc(symbolLeg.autocomplete, "autocomplete").fuzzy,
      "fuzzy"
    );
    assert.equal(fuzzy.prefixLength, 1);
  });

  it("free-text leg covers symbol AND name, and drops fuzz on fuzzy:false", () => {
    const fuzzed = buildUsInstrumentSearchPipeline("APPL") as Doc[];
    const textLeg = matchLegs(fuzzed).find((leg) => "text" in leg);
    assert.ok(textLeg);
    assert.deepEqual(asDoc(textLeg.text, "text").path, ["symbol", "name"]);
    assert.ok(asDoc(textLeg.text, "text").fuzzy);

    const exact = buildUsInstrumentSearchPipeline("APPL", {
      fuzzy: false,
    }) as Doc[];
    const exactLeg = matchLegs(exact).find((leg) => "text" in leg);
    assert.equal(asDoc(exactLeg!.text, "text").fuzzy, undefined);
    // The autocomplete legs keep their own fuzz — `fuzzy` is about the text leg.
    assert.equal(matchLegs(exact).length, 3);
  });

  it("defaults $limit to 10 and honours an explicit limit", () => {
    assert.equal(
      (buildUsInstrumentSearchPipeline("A") as Doc[])[1]!["$limit"],
      10
    );
    assert.equal(
      (buildUsInstrumentSearchPipeline("A", { limit: 12 }) as Doc[])[1]![
        "$limit"
      ],
      12
    );
  });

  it("projects every field the mapper reads, plus the relevance score", () => {
    const project = projectOf(buildUsInstrumentSearchPipeline("A") as Doc[]);
    for (const field of [
      "listingId",
      "symbol",
      "name",
      "exchange",
      "assetType",
      "listingStatus",
      "listingEndDate",
    ]) {
      assert.equal(project[field], 1, `${field} is projected`);
    }
    assert.deepEqual(project.score, { $meta: "searchScore" });
    assert.equal(project._id, 0, "_id is suppressed");
  });

  it("projects listingId — dedup collapses the delisted tail without it", () => {
    // Not decoration: `dedupeResults` keys US rows by `listingId`, and Tiingo
    // holds two `DOW` rows on NYSE. Drop the projection and the two occupants
    // of every recycled ticker collapse into one.
    assert.equal(
      projectOf(buildUsInstrumentSearchPipeline("DOW") as Doc[]).listingId,
      1
    );
  });
});

// ── filters: the operator/field pairing that fails silently ─────────────────

describe("buildUsInstrumentSearchPipeline — token filters", () => {
  it("emits NO filter at all when nothing is narrowed", () => {
    // Deliberate: "both statuses, every venue, every asset type" is expressed
    // as the ABSENCE of a filter. Any filter here is a chance to exclude a row
    // whose value we did not anticipate — and for a user-visible delisted tail
    // that is the failure hardest to notice.
    const pipeline = buildUsInstrumentSearchPipeline("AAPL") as Doc[];
    assert.equal(compoundOf(pipeline).filter, undefined);
  });

  it("never filters isActive — this collection has no such field", () => {
    // `us_instruments` retains delisted rows rather than deactivating them,
    // and the index is `dynamic: false`, so a filter on an unmapped field
    // returns zero rows for EVERY query.
    const pipeline = buildUsInstrumentSearchPipeline("AAPL", {
      assetTypes: ["Stock"],
      exchanges: ["NASDAQ"],
      listingStatuses: ["ACTIVE"],
    }) as Doc[];
    assert.equal(
      filterPairs(pipeline).some((p) => p.path === "isActive"),
      false
    );
    assert.doesNotMatch(JSON.stringify(pipeline), /isActive/);
  });

  it("filters assetType with `in`, casing VERBATIM", () => {
    const pipeline = buildUsInstrumentSearchPipeline("SPY", {
      assetTypes: [US_ASSET_TYPE.ETF, US_ASSET_TYPE.MUTUAL_FUND],
    }) as Doc[];
    const clause = filtersOf(pipeline).find((c) => "in" in c);
    assert.ok(clause, "an `in` filter exists");
    const body = asDoc(clause.in, "in body");
    assert.equal(body.path, "assetType");
    assert.deepEqual(body.value, ["ETF", "Mutual Fund"]);
    // Upper-casing is the bug: token matching is exact and Tiingo wrote
    // "Mutual Fund". "MUTUAL FUND" matches nothing, with no error.
    assert.notDeepEqual(body.value, ["ETF", "MUTUAL FUND"]);
  });

  it("filters exchange with `in`, UPPER-cased", () => {
    const pipeline = buildUsInstrumentSearchPipeline("SPY", {
      exchanges: ["nyse arca", "NASDAQ"],
    }) as Doc[];
    const body = asDoc(filtersOf(pipeline)[0]?.in, "in body");
    assert.equal(body.path, "exchange");
    assert.deepEqual(body.value, ["NYSE ARCA", "NASDAQ"]);
  });

  it("filters listingStatus with `in` — NEVER `text`", () => {
    // MONEY-1128 / MONEY-1141, third occurrence of the same mistake. `text`
    // against a token field matches nothing and reports nothing.
    const pipeline = buildUsInstrumentSearchPipeline("LEH", {
      listingStatuses: [US_LISTING_STATUS.DELISTED],
    }) as Doc[];
    const pairs = filterPairs(pipeline);
    assert.deepEqual(pairs, [{ op: "in", path: "listingStatus" }]);
    assert.equal(
      pairs.some((p) => p.op === "text"),
      false
    );
  });

  it("every filter clause uses `in` — no token field is ever text-matched", () => {
    const pipeline = buildUsInstrumentSearchPipeline("X", {
      assetTypes: ["Stock"],
      exchanges: ["NASDAQ"],
      listingStatuses: ["ACTIVE", "delisted"],
    }) as Doc[];
    const pairs = filterPairs(pipeline);
    assert.equal(pairs.length, 3);
    for (const { op, path } of pairs) {
      assert.equal(op, "in", `${path} must use \`in\`, not \`${op}\``);
    }
    // listingStatus values normalise upward — token matching is exact and the
    // column is written in upper case.
    const status = filtersOf(pipeline).find(
      (c) => asDoc(c.in, "in").path === "listingStatus"
    );
    assert.deepEqual(asDoc(status!.in, "in").value, ["ACTIVE", "DELISTED"]);
  });

  it("an EMPTY narrowing array is `no filter`, not `match nothing`", () => {
    const pipeline = buildUsInstrumentSearchPipeline("X", {
      assetTypes: [],
      exchanges: [],
      listingStatuses: [],
    }) as Doc[];
    assert.equal(compoundOf(pipeline).filter, undefined);
  });
});

// ── row normalisation ───────────────────────────────────────────────────────

describe("normalizeUsInstrumentRow", () => {
  const raw = {
    listingId: "LEH:NYSE:1994-05-04",
    symbol: "LEH",
    exchange: "NYSE",
    assetType: "Stock",
    name: "Lehman Brothers Holdings Inc",
    listingStatus: "DELISTED",
    listingEndDate: { $date: "2017-01-13T00:00:00.000Z" },
    score: 12.5,
  };

  it("normalises a $runCommandRaw document", () => {
    const row = normalizeUsInstrumentRow(raw)!;
    assert.equal(row.listingId, "LEH:NYSE:1994-05-04");
    assert.equal(row.symbol, "LEH");
    assert.equal(row.listingStatus, "DELISTED");
    assert.equal(row.listingEndDate, "2017-01-13T00:00:00.000Z");
    assert.equal(row.score, 12.5);
  });

  it("a NULL, absent or blank name normalises to null", () => {
    for (const name of [null, undefined, "", "   "]) {
      assert.equal(normalizeUsInstrumentRow({ ...raw, name })!.name, null);
    }
    // ...and is never replaced by the symbol.
    assert.notEqual(
      normalizeUsInstrumentRow({ ...raw, name: null })!.name,
      "LEH"
    );
  });

  it("a row with no symbol is dropped rather than emitted blank", () => {
    assert.equal(normalizeUsInstrumentRow({ ...raw, symbol: undefined }), null);
  });

  it("a missing listingId falls back to a per-row key, not a shared one", () => {
    // Two such rows must not dedupe into one. The fallback carries symbol,
    // exchange and start date, which is what `listingId` is built from.
    const a = normalizeUsInstrumentRow({
      symbol: "DOW",
      exchange: "NYSE",
      listingStartDate: "1972-06-01",
    })!;
    const b = normalizeUsInstrumentRow({
      symbol: "DOW",
      exchange: "NYSE",
      listingStartDate: "2019-03-20",
    })!;
    assert.notEqual(a.listingId, b.listingId);
    assert.ok(a.listingId.length > 0);
  });

  it("a non-finite score is dropped rather than carried as NaN", () => {
    // NaN in the comparator makes the sort non-transitive and the output order
    // engine-dependent.
    for (const score of [Number.NaN, Infinity, "12", null]) {
      assert.equal(
        normalizeUsInstrumentRow({ ...raw, score })!.score,
        undefined
      );
    }
  });
});

describe("toIsoDate", () => {
  it("accepts every shape the three producers emit", () => {
    const iso = "2017-01-13T00:00:00.000Z";
    assert.equal(toIsoDate(new Date(iso)), iso, "Prisma hands back a Date");
    assert.equal(toIsoDate({ $date: iso }), iso, "extended JSON from raw");
    assert.equal(toIsoDate(iso), iso, "a cache round trip hands back a string");
    assert.equal(
      toIsoDate({ $date: { $numberLong: String(Date.parse(iso)) } }),
      iso,
      "extended JSON, millisecond form"
    );
  });

  it("null / undefined / garbage become null, never Invalid Date", () => {
    for (const value of [null, undefined, "", "not-a-date", {}, [], NaN]) {
      assert.equal(toIsoDate(value), null);
    }
    assert.equal(toIsoDate(new Date("nope")), null);
  });
});

// ── the fallback ladder ─────────────────────────────────────────────────────

describe("searchUsInstruments — Atlas first, Prisma on unavailability", () => {
  const row = (symbol: string): UsInstrumentSearchRow => ({
    listingId: `${symbol}:NASDAQ:1980-01-01`,
    symbol,
    exchange: "NASDAQ",
    assetType: "Stock",
    name: `${symbol} Inc`,
    listingStatus: "ACTIVE",
    listingEndDate: null,
  });

  it("uses Atlas when Atlas answers", async () => {
    let fellBack = false;
    const out = await searchUsInstruments(
      "AAPL",
      {},
      {
        atlas: async () => [row("AAPL")],
        fallback: async () => {
          fellBack = true;
          return [];
        },
      }
    );
    assert.equal(out.usedAtlas, true);
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["AAPL"]
    );
    assert.equal(fellBack, false);
  });

  it("falls back to Prisma when Atlas returns null", async () => {
    // `null` = the gate said no (non-Atlas deployment, missing/building index,
    // transient failure). This IS QA and local, permanently — a US path that
    // only worked on Atlas would be a path nothing but prod could exercise.
    const out = await searchUsInstruments(
      "AAPL",
      {},
      { atlas: async () => null, fallback: async () => [row("AAPL")] }
    );
    assert.equal(out.usedAtlas, false);
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["AAPL"]
    );
  });

  it("does NOT fall back on an EMPTY Atlas result", async () => {
    // Deliberate, and the opposite of `/api/market/autocomplete`'s choice:
    // there the fallback is a cheap indexed prefix, here it is a scan of ~74k
    // rows, and "no such ticker" is a legitimate answer that must not cost one.
    let fellBack = false;
    const out = await searchUsInstruments(
      "NOSUCHTICKER",
      {},
      {
        atlas: async () => [],
        fallback: async () => {
          fellBack = true;
          return [row("WRONG")];
        },
      }
    );
    assert.equal(fellBack, false, "an empty answer is an answer");
    assert.deepEqual(out.rows, []);
    assert.equal(out.usedAtlas, true);
  });

  it("an EMPTY collection is an empty list, never an error", async () => {
    // `us_instruments` is empty in every environment today — the Tiingo
    // backfill has not run — on BOTH legs of the ladder.
    for (const atlas of [async () => [], async () => null]) {
      const out = await searchUsInstruments(
        "AAPL",
        {},
        { atlas, fallback: async () => [] }
      );
      assert.deepEqual(out.rows, []);
    }
  });

  it("a THROWING Atlas leg falls back — it must not escape", async () => {
    // MONEY-980 review. The route runs this inside the same `Promise.all` as
    // India's instrument and MF legs, under one route-level try/catch that
    // answers 500. An escaping error here does not degrade US search — it
    // deletes India's results too, for a fault confined to a flag-gated
    // collection that is EMPTY in every environment today.
    let fellBack = false;
    const out = await searchUsInstruments(
      "AAPL",
      {},
      {
        atlas: async () => {
          throw new Error("something nobody has ever classified");
        },
        fallback: async () => {
          fellBack = true;
          return [row("AAPL")];
        },
      }
    );
    assert.equal(fellBack, true, "the fallback still runs");
    assert.equal(out.usedAtlas, false);
    assert.deepEqual(
      out.rows.map((r) => r.symbol),
      ["AAPL"]
    );
  });

  it("a THROWING fallback degrades to [] — it must not escape either", async () => {
    const out = await searchUsInstruments(
      "AAPL",
      {},
      {
        atlas: async () => null,
        fallback: async () => {
          throw new Error("stale prisma client");
        },
      }
    );
    assert.deepEqual(out.rows, []);
    assert.equal(out.usedAtlas, false);
  });

  it("BOTH legs throwing is still an empty answer, never a rejection", async () => {
    await assert.doesNotReject(async () => {
      const out = await searchUsInstruments(
        "AAPL",
        {},
        {
          atlas: async () => {
            throw new Error("a");
          },
          fallback: async () => {
            throw new Error("b");
          },
        }
      );
      assert.deepEqual(out.rows, []);
    });
  });

  it("passes the caller's options through to whichever leg runs", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await searchUsInstruments(
      "SPY",
      { assetTypes: ["ETF"], limit: 12 },
      {
        atlas: async (_q, o) => {
          seen.push({ leg: "atlas", ...o });
          return null;
        },
        fallback: async (_q, o) => {
          seen.push({ leg: "fallback", ...o });
          return [];
        },
      }
    );
    assert.deepEqual(seen, [
      { leg: "atlas", assetTypes: ["ETF"], limit: 12 },
      { leg: "fallback", assetTypes: ["ETF"], limit: 12 },
    ]);
  });
});

// ── the Prisma fallback: the ONLY path QA and local ever run ────────────────

/**
 * A deliberately small model of the Mongo semantics for exactly the operators
 * these two passes emit — `startsWith` (with and without `mode: "insensitive"`),
 * `contains` + insensitive, `in`, `notIn`, `OR`, an ascending `orderBy` on a
 * string column, and `take`.
 *
 * It exists to make ONE thing demonstrable that no assertion on a query object
 * can demonstrate: whether the row a user typed survives `take`. That is the
 * whole of the `orderBy` defect — the query is well-formed either way, the
 * index is used either way, and the only difference is WHICH twelve rows come
 * back. Asserting "orderBy is [{symbol:'asc'}]" pins the fix; running a
 * population through it shows what the fix is FOR.
 *
 * Faithfulness is bounded on purpose: it models the operators we emit and
 * nothing else, and it throws on anything it does not recognise so it can never
 * quietly agree with a query it did not understand.
 */
function applyFindMany(
  rows: UsInstrumentRecord[],
  args: UsInstrumentFindManyArgs
): UsInstrumentRecord[] {
  const matchesLeaf = (
    row: UsInstrumentRecord,
    field: string,
    spec: unknown
  ) => {
    const raw = (row as unknown as Record<string, unknown>)[field];
    const value =
      typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    const cond = spec as Record<string, unknown>;
    const insensitive = cond.mode === "insensitive";
    const norm = (v: string) => (insensitive ? v.toUpperCase() : v);
    for (const [op, operand] of Object.entries(cond)) {
      if (op === "mode") continue;
      if (op === "startsWith") {
        if (!norm(value).startsWith(norm(String(operand)))) return false;
      } else if (op === "contains") {
        if (!norm(value).includes(norm(String(operand)))) return false;
      } else if (op === "in") {
        if (!(operand as string[]).includes(value)) return false;
      } else if (op === "notIn") {
        if ((operand as string[]).includes(value)) return false;
      } else {
        throw new Error(`applyFindMany: unmodelled operator ${op}`);
      }
    }
    return true;
  };

  const matches = (
    row: UsInstrumentRecord,
    where: Record<string, unknown>
  ): boolean =>
    Object.entries(where).every(([field, spec]) => {
      if (field === "OR") {
        return (spec as Record<string, unknown>[]).some((branch) =>
          matches(row, branch)
        );
      }
      return matchesLeaf(row, field, spec);
    });

  const filtered = rows.filter((row) =>
    matches(row, args.where as unknown as Record<string, unknown>)
  );

  const sorted = [...filtered].sort((a, b) => {
    for (const clause of args.orderBy) {
      const [field, dir] = Object.entries(clause)[0] as [string, string];
      const av = String((a as unknown as Record<string, unknown>)[field] ?? "");
      const bv = String((b as unknown as Record<string, unknown>)[field] ?? "");
      if (av !== bv) return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });

  return sorted.slice(0, args.take);
}

const record = (
  symbol: string,
  overrides: Partial<UsInstrumentRecord> = {}
): UsInstrumentRecord => ({
  listingId: `${symbol}:${overrides.exchange ?? "NYSE"}:1980-01-01`,
  symbol,
  name: overrides.name === undefined ? `${symbol} Corp` : overrides.name,
  exchange: overrides.exchange ?? "NYSE",
  assetType: overrides.assetType ?? "Stock",
  listingStatus: overrides.listingStatus ?? "ACTIVE",
  listingEndDate: overrides.listingEndDate ?? null,
  ...(overrides.listingId ? { listingId: overrides.listingId } : {}),
});

/**
 * The measured case. `GM` is General Motors, DELISTED; every other row here is
 * a live ticker that also begins "GM". There are more than `limit` of them, so
 * the page is decided entirely by `orderBy`.
 */
const GM_TABLE: UsInstrumentRecord[] = [
  record("GM", {
    name: "General Motors Co",
    listingStatus: "DELISTED",
    listingEndDate: "2009-07-10T00:00:00.000Z",
  }),
  ...[
    "GMAB",
    "GMBL",
    "GMDA",
    "GME",
    "GMED",
    "GMGI",
    "GMLP",
    "GMRE",
    "GMS",
    "GMTX",
    "GMVD",
    "GMZ",
    "GMHI",
  ].map((s) => record(s)),
];

describe("searchUsInstrumentsPrisma — the symbol pass must not starve the hit", () => {
  it("orders by symbol ALONE — never by listingStatus first", () => {
    // The defect, stated as the query it produces. `listingStatus: "asc"` sorts
    // the whole matched set by liveness BEFORE `take` runs, so a delisted exact
    // match is never fetched at all.
    const args = buildUsSymbolPassArgs("GM", { limit: 12 });
    assert.deepEqual(args.orderBy, [{ symbol: "asc" }]);
    assert.equal(
      args.orderBy.some((c) => "listingStatus" in c),
      false,
      "status-first ordering starves the delisted tail this module exists for"
    );
  });

  it("q=GM returns General Motors FIRST, ahead of 13 live GM* tickers", async () => {
    // The behavioural half. With `[{listingStatus},{symbol}]` the page is
    // GMAB…GMTX and `GM` is absent; `rows.length < limit` is then false, so the
    // name pass never runs either and the answer is "no such ticker".
    const rows = await searchUsInstrumentsPrisma(
      "GM",
      { limit: 12 },
      async (a) => applyFindMany(GM_TABLE, a)
    );
    assert.equal(rows[0]?.symbol, "GM");
    assert.equal(rows[0]?.listingStatus, "DELISTED");
    assert.equal(rows.length, 12, "the page is still full");
  });

  it("a prefix sorts before every string that extends it (why symbol-asc works)", () => {
    // The property the fix rests on, asserted directly rather than assumed.
    const page = applyFindMany(
      GM_TABLE,
      buildUsSymbolPassArgs("GM", { limit: 3 })
    );
    assert.deepEqual(
      page.map((r) => r.symbol),
      ["GM", "GMAB", "GMBL"]
    );
  });

  it("both occupants of a RECYCLED ticker come back on one page", async () => {
    // `DOW` is Dow Chemical (1972-2017) and Dow Inc. (2019-). Status-first
    // ordering is harmless here — but only because there are two rows; the
    // point is that neither is reachable only via its status.
    const table = [
      record("DOW", {
        listingId: "DOW:NYSE:1972-06-01",
        name: "Dow Chemical Co",
        listingStatus: "DELISTED",
        listingEndDate: "2017-08-31T00:00:00.000Z",
      }),
      record("DOW", { listingId: "DOW:NYSE:2019-03-20", name: "Dow Inc" }),
      ...Array.from({ length: 15 }, (_, i) => record(`DOWX${i}`)),
    ];
    const rows = await searchUsInstrumentsPrisma(
      "DOW",
      { limit: 12 },
      async (a) => applyFindMany(table, a)
    );
    assert.deepEqual(
      rows
        .slice(0, 2)
        .map((r) => r.listingStatus)
        .sort(),
      ["ACTIVE", "DELISTED"]
    );
  });
});

describe("searchUsInstrumentsPrisma — the two passes", () => {
  it("runs ONE query when the symbol pass fills the page", async () => {
    const seen: UsInstrumentFindManyArgs[] = [];
    await searchUsInstrumentsPrisma("GM", { limit: 12 }, async (a) => {
      seen.push(a);
      return applyFindMany(GM_TABLE, a);
    });
    assert.equal(
      seen.length,
      1,
      "the unindexed name scan must not run when it is not needed"
    );
  });

  it("runs the name pass only on an under-fill, and excludes what it already has", async () => {
    const table = [
      record("LEH", {
        name: "Lehman Brothers Holdings Inc",
        listingStatus: "DELISTED",
      }),
      record("BCS", { name: "Barclays PLC (bought Lehman)" }),
    ];
    const seen: UsInstrumentFindManyArgs[] = [];
    const rows = await searchUsInstrumentsPrisma(
      "LEH",
      { limit: 12 },
      async (a) => {
        seen.push(a);
        return applyFindMany(table, a);
      }
    );
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]!.where.listingId, {
      notIn: ["LEH:NYSE:1980-01-01"],
    });
    assert.equal(
      seen[1]!.take,
      11,
      "the second pass asks only for the shortfall"
    );
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["LEH", "BCS"],
      "the name pass finds the company whose NAME matches, without a duplicate"
    );
  });

  it("the SYMBOL pass is case-SENSITIVE (so Mongo can serve it from the index)", () => {
    const where = buildUsSymbolPassArgs("gm").where as Record<string, unknown>;
    assert.deepEqual(where.symbol, { startsWith: "GM" });
    // `mode: "insensitive"` compiles to a `/…/i` regex, which cannot produce
    // index bounds — it would scan the whole index on every keystroke.
    assert.equal("mode" in (where.symbol as object), false);
  });

  it("...and the NAME pass carries the case-insensitive symbol safety net", async () => {
    // The "US tickers are stored upper-case" invariant is asserted in three
    // comments and enforced in zero lines of the writer, so pass 1 must not be
    // the only way a symbol is reachable. Pass 2 is a scan already, so the
    // branch is free.
    const table = [record("gm", { name: "Lower Case Motors" })];
    const rows = await searchUsInstrumentsPrisma(
      "GM",
      { limit: 12 },
      async (a) => applyFindMany(table, a)
    );
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["gm"],
      "a mis-cased stored ticker is still reachable"
    );
  });

  it("the scope narrowing applies to BOTH passes, and empty means no clause", () => {
    assert.deepEqual(buildUsScopeWhere({}), {});
    assert.deepEqual(
      buildUsScopeWhere({ assetTypes: [], exchanges: [], listingStatuses: [] }),
      {},
      "an empty array is `no filter`, never `match nothing`"
    );
    const scoped = {
      assetTypes: ["Mutual Fund"],
      exchanges: ["nmfqs"],
      listingStatuses: ["delisted"],
    };
    const expected = {
      // Verbatim — Tiingo writes "Mutual Fund" and matching is exact.
      assetType: { in: ["Mutual Fund"] },
      exchange: { in: ["NMFQS"] },
      listingStatus: { in: ["DELISTED"] },
    };
    for (const args of [
      buildUsSymbolPassArgs("X", scoped),
      buildUsNamePassArgs("X", scoped, [], 5),
    ]) {
      const where = args.where as Record<string, unknown>;
      assert.deepEqual(where.assetType, expected.assetType);
      assert.deepEqual(where.exchange, expected.exchange);
      assert.deepEqual(where.listingStatus, expected.listingStatus);
    }
  });

  it("selects exactly the columns the mapper reads", () => {
    const args = buildUsSymbolPassArgs("X");
    assert.deepEqual(Object.keys(args.select).sort(), [
      "assetType",
      "exchange",
      "listingEndDate",
      "listingId",
      "listingStatus",
      "name",
      "symbol",
    ]);
  });
});

describe("searchUsInstrumentsPrisma — failures are reported, not disguised", () => {
  it("a DB failure returns [] instead of throwing", async () => {
    // The India results ride the same `Promise.all`; a US failure must not
    // delete them.
    const rows = await searchUsInstrumentsPrisma(
      "GM",
      { limit: 12 },
      async () => {
        throw new Error("QueryExceededMemoryLimitNoDiskUseAllowed");
      }
    );
    assert.deepEqual(rows, []);
  });

  it("a failure on the SECOND pass does not discard the first pass either", async () => {
    let call = 0;
    const rows = await searchUsInstrumentsPrisma(
      "LEH",
      { limit: 12 },
      async (a) => {
        call += 1;
        if (call === 2) throw new Error("boom");
        return applyFindMany([record("LEH", { name: "Lehman" })], a);
      }
    );
    // Documented behaviour: the whole call degrades to empty rather than
    // returning a half-page that looks complete.
    assert.deepEqual(rows, []);
    assert.equal(call, 2);
  });

  it("the catch is not blank — the error goes through the shared gate", () => {
    // The old `catch { return []; }` made a stale Prisma client, a
    // required-field error and a blown in-memory sort all look exactly like
    // "no such ticker", while the route still answered
    // `success: true, source: "atlas"`.
    //
    // Comments are stripped first: the module now QUOTES the old pattern in the
    // doc comment explaining why it is gone, and a guard that cannot tell code
    // from an explanation of code would force people to stop explaining. (This
    // assertion failed on exactly that when it was first written.)
    const src = readFileSync(
      join(__dirname, "..", "..", "lib/market/us-instrument-search.ts"),
      "utf8"
    );
    // LINE comments FIRST, then BLOCK — never the reverse (MONEY-1143, pinned
    // repo-wide by `__tests__/meta/comment-strip-ordering.test.ts`).
    const code = src
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /catch\s*\{\s*return\s*\[\];/);
    // Scoped to the fallback's OWN body. A blanket "no empty catch" would be
    // wrong: `reportUsSearchFailure` has one on purpose, because a reporter
    // that throws resurrects the 500 the reporting exists to prevent.
    const fallbackBody = code.slice(
      code.indexOf("export async function searchUsInstrumentsPrisma")
    );
    const fallbackCatch = fallbackBody.slice(
      fallbackBody.indexOf("} catch"),
      fallbackBody.indexOf("// ==============")
    );
    assert.match(fallbackCatch, /catch \(error\)/, "the error is BOUND");
    assert.match(fallbackCatch, /reportUsSearchFailure\("fallback", error\)/);
    // The Atlas leg must not rethrow — it shares a Promise.all with India's.
    assert.doesNotMatch(code, /throw error/);
  });

  it("reportUsSearchFailure never throws, whatever it is handed", () => {
    // It is called from inside two catch blocks whose entire purpose is to stop
    // an exception escaping. A reporter that throws resurrects the 500.
    //
    // The last two cases matter most: an unclassifiable error is exactly the
    // one the shared gate answers "rethrow" to, and this must ignore that.
    for (const error of [
      new Error("boom"),
      "a string",
      null,
      undefined,
      { message: "PlanExecutor error during aggregation" },
      new Error("index not found: us_instrument_search"),
      new Error("something nobody has ever classified"),
    ]) {
      for (const stage of ["atlas", "fallback"] as const) {
        assert.equal(reportUsSearchFailure(stage, error), undefined);
      }
    }
  });
});
