/**
 * The Tickertape `POST /screener/query` ratio contract — MONEY-1205.
 *
 * ## Why this is a CAPTURED-FIXTURE test
 *
 * Same reason as `tickertape-statement-mapper.test.ts`, and the same bug class
 * one layer down. `fetchTickertapeStockRatios` shipped a request body the
 * endpoint does not understand and a `project` list in which 20 of 27 names do
 * not exist upstream. Neither is detectable by a test that writes its own
 * input: a hand-made response would have been written from the very assumption
 * that produced the bug, and would have gone green while `ratios-sync-daily`
 * wrote nothing for five months.
 *
 * So the inputs below are REAL response bodies, fetched read-only from
 * `api.tickertape.in` on 2026-08-18 and checked in verbatim under
 * `__tests__/fixtures/`:
 *
 *   tickertape-screener-ratios-HDBK.json
 *       the corrected query. Carries the two edge cases that matter —
 *       `dbtEqt: 0` (a REAL zero) and `qcur: null` / `aint: null` (a bank has no
 *       meaningful current ratio, positively reported as unavailable).
 *   tickertape-screener-ratios-multi.json
 *       three sids. Proves results come back OUT of request order.
 *   tickertape-screener-ratios-legacy-match-HDBK.json
 *       the body the BROKEN client sent, verbatim. `success: true`, zero
 *       results — the failure was a well-formed success, which is why nothing
 *       ever alerted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildTickertapeRatiosQuery,
  selectRatiosEntry,
  mapTickertapeRatiosPayload,
  TICKERTAPE_RATIO_WIRE_KEYS,
  TICKERTAPE_RATIO_UNMAPPED,
  TICKERTAPE_RATIO_PROJECTION,
  type TickertapeScreenerResponse,
} from "../src/data-sources/tickertape-ratios-logic";
import { mapRatioFields } from "../src/data-sources/db-store-logic";

const FIXTURES = join(import.meta.dirname, "fixtures");

function loadFixture(name: string): TickertapeScreenerResponse {
  return JSON.parse(
    readFileSync(join(FIXTURES, name), "utf8"),
  ) as TickertapeScreenerResponse;
}

const HDBK = loadFixture("tickertape-screener-ratios-HDBK.json");
const MULTI = loadFixture("tickertape-screener-ratios-multi.json");
const LEGACY = loadFixture("tickertape-screener-ratios-legacy-match-HDBK.json");

const hdbkRatios = (
  HDBK.data?.results as Array<{
    stock: { advancedRatios: Record<string, unknown> };
  }>
)[0].stock.advancedRatios;

// ══════════════════════════════════════════════════════════════════════
// The fixtures themselves — guard the premises everything else rests on.
// ══════════════════════════════════════════════════════════════════════

describe("captured screener fixtures (the premises)", () => {
  it("the LEGACY query body returns success:true with ZERO results", () => {
    // This is the entire five-month outage in one object. Not a 4xx, not a
    // thrown error — a valid success envelope carrying nothing, which
    // `fetchTickertapeStockRatios` correctly turned into null and `syncRatios`
    // correctly treated as "nothing to write".
    assert.equal(LEGACY.success, true);
    assert.deepEqual(LEGACY.data?.results, []);
    assert.equal(LEGACY.data?.stats?.count, 0);
  });

  it("the CORRECTED query body returns exactly one entry, for the sid asked", () => {
    assert.equal(HDBK.success, true);
    const results = HDBK.data?.results as unknown[];
    assert.equal(results.length, 1);
    assert.equal((results[0] as { sid: string }).sid, "HDBK");
  });

  it("results come back OUT of request order", () => {
    // Requested [RELI, TCS, HDBK]; the capture returned [RELI, HDBK, TCS].
    // This is why `selectRatiosEntry` matches on sid instead of taking [0].
    const order = (MULTI.data?.results as Array<{ sid: string }>).map(
      (r) => r.sid,
    );
    assert.deepEqual(order, ["RELI", "HDBK", "TCS"]);
    assert.notDeepEqual(order, ["RELI", "TCS", "HDBK"]);
  });

  it("carries a REAL zero and an EXPLICIT null in the same payload", () => {
    // The two values that every naive coercion destroys, in one real response.
    assert.equal(hdbkRatios.dbtEqt, 0);
    assert.equal(Object.hasOwn(hdbkRatios, "dbtEqt"), true);
    assert.equal(hdbkRatios.qcur, null);
    assert.equal(hdbkRatios.aint, null);
  });

  it("does NOT carry ticker/name in advancedRatios — they are on stock.info", () => {
    // `ticker` and `name` were in the old `project` list. They are not
    // projectable fields; asking for them returns nothing.
    assert.equal(Object.hasOwn(hdbkRatios, "ticker"), false);
    assert.equal(Object.hasOwn(hdbkRatios, "name"), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The request body — bug 1.
// ══════════════════════════════════════════════════════════════════════

describe("buildTickertapeRatiosQuery", () => {
  it("selects the stock with a TOP-LEVEL sids array", () => {
    const body = buildTickertapeRatiosQuery("HDBK");
    assert.deepEqual(body.sids, ["HDBK"]);
  });

  it("puts NOTHING about sid inside `match`", () => {
    // The regression that cost five months: `match` is the FILTER object and
    // `sid` is not a filter. An unrecognised filter is ignored, not rejected.
    const body = buildTickertapeRatiosQuery("HDBK");
    assert.deepEqual(body.match, {});
    assert.equal(
      Object.hasOwn(body.match, "sid"),
      false,
      "sid moved back into `match` — this returns the empty set for every symbol",
    );
  });

  it("never asks for fewer rows than sids requested", () => {
    // `count` truncates the page while `stats.count` reports the true total, so
    // count < sids.length silently drops entries.
    const body = buildTickertapeRatiosQuery("HDBK");
    assert.ok(body.count >= body.sids.length);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The projection — bug 2. Tied to a REAL response so an invented name fails.
// ══════════════════════════════════════════════════════════════════════

describe("TICKERTAPE_RATIO_WIRE_KEYS is grounded in a real response", () => {
  it("every projected wire key is present in the captured payload", () => {
    // The fixture is a verbatim capture of THIS projection. Adding a wire name
    // the endpoint does not serve makes the projection ask for something the
    // fixture cannot contain, and this fails — which is exactly how the 20
    // invented names (`evEBITDA`, `debt2Eq`, `curRatio`, `netMrgn`, …) should
    // have been caught.
    for (const wire of TICKERTAPE_RATIO_PROJECTION) {
      assert.equal(
        Object.hasOwn(hdbkRatios, wire),
        true,
        `projected "${wire}" is absent from the captured response — the endpoint drops unknown projections SILENTLY`,
      );
    }
  });

  it("the captured payload holds nothing the projection did not ask for", () => {
    // The other direction: proves the fixture really is a capture of this
    // projection and not a stale body from some other request.
    const projected = new Set(TICKERTAPE_RATIO_PROJECTION);
    for (const key of Object.keys(hdbkRatios)) {
      assert.equal(
        projected.has(key),
        true,
        `fixture carries "${key}" which the projection does not request — fixture is stale`,
      );
    }
  });

  it("derives the projection from the map, so the two cannot drift", () => {
    assert.equal(
      TICKERTAPE_RATIO_PROJECTION.length,
      Object.keys(TICKERTAPE_RATIO_WIRE_KEYS).length,
    );
  });

  it("keeps the unmapped columns unmapped", () => {
    // The failure mode this guards is someone "completing" the map with a
    // near-miss field — `aopm` (EBITDA Margin) into `operatingMargin`, or
    // `epsg` (EPS growth) into `earningsGrowth`. Both are different numbers
    // wearing the column's name, which is the fabrication class MONEY-1205 is
    // about.
    for (const column of Object.keys(TICKERTAPE_RATIO_UNMAPPED)) {
      assert.equal(
        Object.hasOwn(TICKERTAPE_RATIO_WIRE_KEYS, column),
        false,
        `${column} gained a wire mapping — no free field on this endpoint MEANS ${column}`,
      );
    }
  });

  it("every unmapped column is a real StockRatios column", () => {
    // Keeps the exclusion list honest: it must name columns that exist, not
    // fields nobody ever stored.
    const columns = Object.keys(mapRatioFields({}) as object).concat(
      // mapRatioFields returns only resolved keys, so probe with a payload
      // that resolves everything it knows about.
      Object.keys(
        mapRatioFields(
          Object.fromEntries(
            [
              "pe",
              "pb",
              "evToEbitda",
              "pegRatio",
              "roe",
              "roa",
              "roce",
              "grossMargin",
              "operatingMargin",
              "netMargin",
              "revenueGrowth",
              "earningsGrowth",
              "revenueGrowth3Y",
              "earningsGrowth3Y",
              "revenueGrowth5Y",
              "earningsGrowth5Y",
              "debtToEquity",
              "currentRatio",
              "interestCoverage",
              "beta",
              "divYield",
              "mCap",
              "enterpriseValue",
              "targetPrice",
            ].map((k) => [k, 1]),
          ),
        ),
      ),
    );
    const known = new Set(columns);
    for (const column of Object.keys(TICKERTAPE_RATIO_UNMAPPED)) {
      if (column === "recommendation") continue; // string column, probed below
      assert.equal(
        known.has(column),
        true,
        `${column} is not a StockRatios column mapRatioFields knows`,
      );
    }
    assert.equal(
      Object.hasOwn(
        mapRatioFields({ recommendation: "BUY" }),
        "recommendation",
      ),
      true,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Entry selection — the mis-attribution guard.
// ══════════════════════════════════════════════════════════════════════

describe("selectRatiosEntry", () => {
  it("picks the entry for the sid asked, not the first row", () => {
    const entry = selectRatiosEntry("TCS", MULTI.data?.results);
    assert.equal(entry?.sid, "TCS");
    // [0] is RELI in this real capture — the bug that would have been shipped.
    assert.notEqual(entry?.sid, "RELI");
  });

  it("returns null rather than a WRONG stock when the sid is absent", () => {
    // The live failure mode: `match: { sid: "RELI" }` is IGNORED and returns
    // the whole 5,858-row universe sorted by something else. Under `results[0]`
    // that writes another company's ratios onto this symbol's row — and
    // `StockRatios` is @@unique([symbol, exchange]), one row per symbol with no
    // period dimension to fall back on.
    assert.equal(selectRatiosEntry("INFY", MULTI.data?.results), null);
  });

  it("returns null on an empty page and on a non-array", () => {
    assert.equal(selectRatiosEntry("HDBK", LEGACY.data?.results), null);
    assert.equal(selectRatiosEntry("HDBK", undefined), null);
    assert.equal(selectRatiosEntry("HDBK", null), null);
    assert.equal(selectRatiosEntry("HDBK", { sid: "HDBK" }), null);
  });

  it("matches case- and whitespace-insensitively", () => {
    assert.equal(selectRatiosEntry(" hdbk ", MULTI.data?.results)?.sid, "HDBK");
  });

  it("skips entries with a non-string sid instead of throwing", () => {
    const results = [{ sid: 42 }, { sid: null }, { sid: "HDBK", stock: {} }];
    assert.equal(selectRatiosEntry("HDBK", results)?.sid, "HDBK");
  });
});

// ══════════════════════════════════════════════════════════════════════
// The mapper — absence vs null vs zero, on real data.
// ══════════════════════════════════════════════════════════════════════

describe("mapTickertapeRatiosPayload", () => {
  it("maps the captured HDFCBANK response onto the client's names", () => {
    const out = mapTickertapeRatiosPayload("HDBK", HDBK)!;
    assert.ok(out);
    assert.equal(out.ticker, "HDFCBANK");
    assert.equal(out.name, "HDFC Bank Limited");
    assert.equal(out.pe, 14.775686274242855);
    assert.equal(out.pb, 1.8462423617141182);
    assert.equal(out.roe, 13.261197178569569);
    assert.equal(out.roa, 1.6322321934491217);
    assert.equal(out.evToEbitda, 7.841107875293814);
    assert.equal(out.netMargin, 15.34443523621885);
    assert.equal(out.revenueGrowth, 5.21258221186105);
    assert.equal(out.revenueGrowth5Y, 26.020497798089792);
    assert.equal(out.divYield, 2.124005945429724);
    assert.equal(out.mCap, 1123335.881415);
    assert.equal(out.enterpriseValue, 833794.7914149999);
  });

  it("PRESERVES a real zero — HDFCBANK's debt-to-equity is 0, not absent", () => {
    const out = mapTickertapeRatiosPayload("HDBK", HDBK)!;
    assert.equal(out.debtToEquity, 0);
    assert.equal(
      Object.hasOwn(out, "debtToEquity"),
      true,
      "a real 0 was dropped — `parseFloat(x) || null` and `Number(x) || undefined` both do this",
    );
  });

  it("PRESERVES an explicit null — a bank has no meaningful current ratio", () => {
    const out = mapTickertapeRatiosPayload("HDBK", HDBK)!;
    assert.equal(out.currentRatio, null);
    assert.equal(out.interestCoverage, null);
    assert.equal(Object.hasOwn(out, "currentRatio"), true);
  });

  it("OMITS what the endpoint did not return — never a null over a live value", () => {
    // `StockRatios` has no period dimension: the nightly `update:` spread
    // replaces the symbol's ENTIRE ratio set, so an absent field written as
    // null erases a good value.
    const out = mapTickertapeRatiosPayload("HDBK", HDBK)!;
    for (const column of Object.keys(TICKERTAPE_RATIO_UNMAPPED)) {
      assert.equal(
        Object.hasOwn(out, column),
        false,
        `${column} present — it would be spread into the update and NULL the column`,
      );
    }
  });

  it("returns null for the LEGACY query's empty page", () => {
    assert.equal(mapTickertapeRatiosPayload("HDBK", LEGACY), null);
  });

  it("returns null for a missing / malformed envelope", () => {
    assert.equal(mapTickertapeRatiosPayload("HDBK", null), null);
    assert.equal(mapTickertapeRatiosPayload("HDBK", undefined), null);
    assert.equal(mapTickertapeRatiosPayload("HDBK", {}), null);
    assert.equal(
      mapTickertapeRatiosPayload("HDBK", {
        data: { results: [{ sid: "HDBK" }] },
      }),
      null,
      "an entry with no `stock` is not a result",
    );
  });

  it("falls back to the sid when info is missing, never to an empty string", () => {
    const out = mapTickertapeRatiosPayload("HDBK", {
      data: {
        results: [{ sid: "HDBK", stock: { advancedRatios: { roe: 1 } } }],
      },
    })!;
    assert.equal(out.ticker, "HDBK");
    assert.equal(out.name, "HDBK");
  });

  it("drops non-finite and non-numeric values instead of coercing them", () => {
    const out = mapTickertapeRatiosPayload("HDBK", {
      data: {
        results: [
          {
            sid: "HDBK",
            stock: {
              advancedRatios: {
                roe: Number.NaN,
                roce: "12.5",
                dbtEqt: 0,
                pftMrg: {},
              },
            },
          },
        ],
      },
    })!;
    assert.equal(Object.hasOwn(out, "roe"), false, "NaN resolved");
    assert.equal(Object.hasOwn(out, "roce"), false, "a string resolved");
    assert.equal(Object.hasOwn(out, "netMargin"), false, "an object resolved");
    assert.equal(out.debtToEquity, 0, "the real zero was collateral damage");
  });

  it("lets the MAPPING win over a colliding raw wire key", () => {
    // Raw fields are spread first for provenance; the normalised names are
    // written over them. If the wire ever ships a `pe` that disagrees with
    // `apef`, the mapping decides — not the spread order.
    const out = mapTickertapeRatiosPayload("HDBK", {
      data: {
        results: [
          {
            sid: "HDBK",
            stock: { advancedRatios: { apef: 14.7, pe: 999 } },
          },
        ],
      },
    })!;
    assert.equal(out.pe, 14.7);
  });

  it("does NOT let an undocumented alias fill a column the mapping missed", () => {
    // `pe`, `pb` and `divYield` are undocumented aliases that this endpoint
    // still answers but the filter catalogue does not list. If `apef` ever
    // stops resolving, the column must go ABSENT rather than silently fall back
    // to an alias nobody verified — absence is recoverable, a wrong number is
    // not.
    const out = mapTickertapeRatiosPayload("HDBK", {
      data: {
        results: [
          { sid: "HDBK", stock: { advancedRatios: { pe: 999, roe: 12 } } },
        ],
      },
    })!;
    assert.equal(Object.hasOwn(out, "pe"), false);
    assert.equal(out.roe, 12);
  });

  it("keeps the raw wire fields for rawData provenance", () => {
    const out = mapTickertapeRatiosPayload("HDBK", HDBK)!;
    assert.equal(out.apef, 14.775686274242855);
    assert.equal(out.mrktCapf, 1123335.881415);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The seam that matters: fixture -> client payload -> StockRatios columns.
// ══════════════════════════════════════════════════════════════════════

describe("captured response -> StockRatios columns (end to end)", () => {
  it("resolves 16 columns from the real HDFCBANK response", () => {
    const payload = mapTickertapeRatiosPayload("HDBK", HDBK)!;
    const columns = mapRatioFields(payload as Record<string, unknown>);
    assert.equal(
      Object.keys(columns).length,
      16,
      `expected 16 columns, got ${Object.keys(columns).length}: ${Object.keys(columns).join(",")}`,
    );
    assert.equal(columns.debtToEquity, 0);
    assert.equal(columns.currentRatio, null);
    assert.equal(columns.marketCap, 1123335.881415);
    assert.equal(columns.dividendYield, 2.124005945429724);
  });

  it("resolves ZERO columns from the legacy query — the outage, reproduced", () => {
    const payload = mapTickertapeRatiosPayload("HDBK", LEGACY);
    assert.equal(payload, null);
    // `syncRatios` does `if (!ratios) return;` — nothing is written, and that
    // is the correct response to "nothing was learned". The bug was upstream.
  });

  it("an absent field cannot clobber the incumbent through the update spread", () => {
    const payload = mapTickertapeRatiosPayload("HDBK", HDBK)!;
    const columns = mapRatioFields(payload as Record<string, unknown>);
    const incumbent = {
      operatingMargin: 21.4,
      pegRatio: 1.8,
      recommendation: "BUY",
      targetPrice: 2100,
      roe: 1,
    };
    const after = { ...incumbent, ...columns };
    assert.equal(after.operatingMargin, 21.4, "operatingMargin was NULLED");
    assert.equal(after.pegRatio, 1.8, "pegRatio was NULLED");
    assert.equal(after.recommendation, "BUY", "recommendation was NULLED");
    assert.equal(after.targetPrice, 2100, "targetPrice was NULLED");
    assert.equal(
      after.roe,
      13.261197178569569,
      "the resolvable field IS updated",
    );
  });
});
