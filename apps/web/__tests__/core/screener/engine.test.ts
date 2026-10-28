/**
 * Screener Engine Tests — REAL source (de-shadowed for MONEY-620).
 *
 * Previously this suite re-declared `matchesTechnicalFilters`,
 * `isFundamental`, `isTechnical`, `TECHNICAL_FIELD_MAP`, the field sets, and a
 * "simulated runScreener" sort/limit helper INLINE and asserted the copies —
 * a textbook shadow test (the real `engine.ts` was never imported, so a bug in
 * production filter-matching would still ship green). It now imports the REAL
 * exported symbols from `@usemoney/core/screener/engine`. The route/sort/limit
 * helpers that live ONLY inside the Prisma-bound `runScreener` are still
 * exercised via small local mirrors (and labelled as such) because that code
 * path can't be invoked without a DB — but every pure classification/matching
 * function is now the genuine article.
 *
 * Source: packages/core/src/screener/engine.ts
 *
 * Negative / edge coverage added on top of the original happy path:
 *  - matchesTechnicalFilters with a NaN / Infinity indicator value (the bug
 *    this de-shadow caught: relational ops silently passed a non-finite metric)
 *  - contradictory filters (rsi > 70 AND rsi < 30) → no match
 *  - reversed `between` bounds
 *  - empty universe / all-filtered-out semantics at the matcher level
 *  - normalizeField aliases + the alias→fundamental gotcha
 *  - sort with NaN sort keys, limit boundaries (0, 1, > length)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FUNDAMENTAL_FIELDS,
  TECHNICAL_FIELDS,
  TECHNICAL_FIELD_MAP,
  isFundamental,
  isTechnical,
  normalizeField,
  matchesTechnicalFilters,
  type ScreenerFilter,
  type ScreenerResult,
} from "@usemoney/core/screener/engine";
import type { TechnicalIndicators } from "@usemoney/core/market-data/technical-indicators";

// ── Local mirrors of the route/sort/limit logic that lives INSIDE the
//    Prisma-bound runScreener (not separately exported). Clearly labelled —
//    these are NOT the assertion target; the pure functions above are. ──────

function classifyFilters(filters: ScreenerFilter[]): {
  fundamentalFilters: ScreenerFilter[];
  technicalFilters: ScreenerFilter[];
  routeType: "fundamental" | "technical" | "combined";
} {
  // Mirrors runScreener's routing: note it normalizes nothing here (matches
  // the real engine, which classifies on the raw field for routing).
  const fundamentalFilters = filters.filter((f) => isFundamental(f.field));
  const technicalFilters = filters.filter((f) => isTechnical(f.field));
  let routeType: "fundamental" | "technical" | "combined";
  if (fundamentalFilters.length > 0 && technicalFilters.length === 0) {
    routeType = "fundamental";
  } else if (fundamentalFilters.length === 0 && technicalFilters.length > 0) {
    routeType = "technical";
  } else {
    routeType = "combined";
  }
  return { fundamentalFilters, technicalFilters, routeType };
}

function sortResults(
  candidates: ScreenerResult[],
  options?: { sortBy?: string; sortDir?: "asc" | "desc"; limit?: number }
): ScreenerResult[] {
  const result = [...candidates];
  if (options?.sortBy) {
    const dir = options.sortDir === "asc" ? 1 : -1;
    result.sort((a, b) => {
      const aVal = (a as unknown as Record<string, unknown>)[
        options.sortBy!
      ] as number;
      const bVal = (b as unknown as Record<string, unknown>)[
        options.sortBy!
      ] as number;
      return ((aVal || 0) - (bVal || 0)) * dir;
    });
  }
  const limit = options?.limit || 50;
  return result.slice(0, limit);
}

// ── Real field-set + classifier tests ──────────────────────────────

describe("Screener Engine — real field sets", () => {
  it("FUNDAMENTAL_FIELDS has 24 entries and excludes technical fields", () => {
    assert.equal(FUNDAMENTAL_FIELDS.size, 24);
    assert.ok(FUNDAMENTAL_FIELDS.has("pe"));
    assert.ok(FUNDAMENTAL_FIELDS.has("debtToEquity"));
    assert.ok(!FUNDAMENTAL_FIELDS.has("rsi_14"));
    assert.ok(!FUNDAMENTAL_FIELDS.has("golden_cross"));
  });

  it("TECHNICAL_FIELDS has 23 entries and excludes fundamental fields", () => {
    assert.equal(TECHNICAL_FIELDS.size, 23);
    assert.ok(TECHNICAL_FIELDS.has("rsi_14"));
    assert.ok(TECHNICAL_FIELDS.has("price_above_sma200"));
    assert.ok(!TECHNICAL_FIELDS.has("pe"));
  });

  it("field sets are disjoint", () => {
    for (const field of FUNDAMENTAL_FIELDS) {
      assert.ok(!TECHNICAL_FIELDS.has(field), `${field} in both sets`);
    }
  });

  it("TECHNICAL_FIELD_MAP has one entry per technical field, all keys in the set", () => {
    assert.equal(Object.keys(TECHNICAL_FIELD_MAP).length, 23);
    // BOTH DIRECTIONS — MONEY-1238. This suite checked only map-subset-of-set,
    // which is the SAFE half: a map key with no matching field is inert. The
    // dangerous half is a field in TECHNICAL_FIELDS with NO map entry — it
    // passes `isTechnical` upstream, reaches `matchesTechnicalFilters`, and
    // before this ticket hit a `continue` that silently DROPPED the filter, so
    // the screen returned the entire universe while appearing to narrow it.
    // `matchesTechnicalFilters` now fails closed, and this assertion makes the
    // branch unreachable rather than merely survivable.
    for (const field of TECHNICAL_FIELDS) {
      assert.ok(
        field in TECHNICAL_FIELD_MAP,
        `${field} is filterable but has no TECHNICAL_FIELD_MAP entry — every ` +
          `screen using it would have returned the whole universe`
      );
    }
    for (const key of Object.keys(TECHNICAL_FIELD_MAP)) {
      assert.ok(
        TECHNICAL_FIELDS.has(key),
        `${key} missing from TECHNICAL_FIELDS`
      );
    }
    assert.equal(TECHNICAL_FIELD_MAP["rsi_14"], "rsi14");
    assert.equal(
      TECHNICAL_FIELD_MAP["distance_52w_high"],
      "distanceFrom52WeekHigh"
    );
    assert.equal(TECHNICAL_FIELD_MAP["pe"], undefined);
  });

  it("isFundamental / isTechnical classify correctly incl. empty + unknown", () => {
    assert.equal(isFundamental("pe"), true);
    assert.equal(isFundamental("rsi_14"), false);
    assert.equal(isFundamental("unknown_field"), false);
    assert.equal(isFundamental(""), false);
    assert.equal(isTechnical("rsi_14"), true);
    assert.equal(isTechnical("pe"), false);
    assert.equal(isTechnical(""), false);
  });
});

// ── normalizeField (alias resolution) — real source ─────────────────

describe("Screener Engine — normalizeField (real)", () => {
  it("resolves known aliases to canonical StockRatios columns", () => {
    assert.equal(normalizeField("peg"), "pegRatio");
    assert.equal(normalizeField("revenueGrowth1Y"), "revenueGrowth");
    assert.equal(normalizeField("earningsGrowth1Y"), "earningsGrowth");
    assert.equal(normalizeField("ev_to_ebitda"), "evToEbitda");
    assert.equal(normalizeField("debt_to_equity"), "debtToEquity");
  });

  it("passes unknown fields through unchanged", () => {
    assert.equal(normalizeField("zzz"), "zzz");
    assert.equal(normalizeField(""), "");
    assert.equal(normalizeField("pe"), "pe");
  });

  it("EDGE: a raw alias is NOT fundamental until normalized (drop-gotcha)", () => {
    // The NL parser emits "peg"; isFundamental("peg") is false, so a screen
    // that forgot to normalize would silently drop it. normalizeField first,
    // THEN classify — this is exactly what runFundamentalScreen does.
    assert.equal(isFundamental("peg"), false);
    assert.equal(isFundamental(normalizeField("peg")), true);
  });
});

// ── matchesTechnicalFilters — REAL source, happy path ───────────────

describe("matchesTechnicalFilters — real, operators", () => {
  const ind = (o: Partial<TechnicalIndicators>) => o as TechnicalIndicators;

  it("gt: matches strictly greater, not equal", () => {
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 65 }), [
        { field: "rsi_14", operator: "gt", value: 60 },
      ]),
      true
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 60 }), [
        { field: "rsi_14", operator: "gt", value: 60 },
      ]),
      false
    );
  });

  it("lt / between / eq behave at the boundaries", () => {
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 30 }), [
        { field: "rsi_14", operator: "lt", value: 30 },
      ]),
      false
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 40 }), [
        { field: "rsi_14", operator: "between", value: [40, 70] },
      ]),
      true
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 70 }), [
        { field: "rsi_14", operator: "between", value: [40, 70] },
      ]),
      true
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 50 }), [
        { field: "rsi_14", operator: "eq", value: 50 },
      ]),
      true
    );
  });

  it("gte / lte boundaries (operators only the real source has)", () => {
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 60 }), [
        { field: "rsi_14", operator: "gte", value: 60 },
      ]),
      true
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 60 }), [
        { field: "rsi_14", operator: "lte", value: 60 },
      ]),
      true
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 61 }), [
        { field: "rsi_14", operator: "lte", value: 60 },
      ]),
      false
    );
  });

  it("boolean indicators coerce to 1/0", () => {
    assert.equal(
      matchesTechnicalFilters(ind({ goldenCross: true }), [
        { field: "golden_cross", operator: "eq", value: 1 },
      ]),
      true
    );
    assert.equal(
      matchesTechnicalFilters(ind({ goldenCross: false }), [
        { field: "golden_cross", operator: "eq", value: 1 },
      ]),
      false
    );
  });

  it("unmapped filter fields are skipped (not a hard fail)", () => {
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 65 }), [
        { field: "rsi_14", operator: "gt", value: 60 },
        { field: "unknown_field", operator: "gt", value: 0 },
      ]),
      true
    );
  });

  it("empty filter array → vacuously matches", () => {
    assert.equal(matchesTechnicalFilters(ind({ rsi14: 50 }), []), true);
  });
});

// ── matchesTechnicalFilters — NEGATIVE / EDGE (the bug surface) ──────

describe("matchesTechnicalFilters — non-finite values (regression: NaN leak)", () => {
  const ind = (o: Partial<TechnicalIndicators>) => o as TechnicalIndicators;

  it("undefined / null indicator → reject", () => {
    assert.equal(
      matchesTechnicalFilters(ind({}), [
        { field: "rsi_14", operator: "gt", value: 50 },
      ]),
      false
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: null as unknown as number }), [
        { field: "rsi_14", operator: "lt", value: 50 },
      ]),
      false
    );
  });

  it("NaN indicator → reject for gt/lt/between (was: silently matched)", () => {
    // Before the fix, every relational comparison against NaN is false, so the
    // matcher never hit its "fail" branch and a NaN-metric stock leaked into
    // results. Correct behavior: treat non-finite like a missing value.
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: NaN }), [
        { field: "rsi_14", operator: "gt", value: 50 },
      ]),
      false,
      "NaN must NOT pass a gt filter"
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: NaN }), [
        { field: "rsi_14", operator: "lt", value: 50 },
      ]),
      false,
      "NaN must NOT pass an lt filter"
    );
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: NaN }), [
        { field: "rsi_14", operator: "between", value: [40, 70] },
      ]),
      false,
      "NaN must NOT pass a between filter"
    );
  });

  it("Infinity / -Infinity indicator → reject", () => {
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: Infinity }), [
        { field: "rsi_14", operator: "gt", value: 50 },
      ]),
      false
    );
    assert.equal(
      matchesTechnicalFilters(ind({ macd: -Infinity }), [
        { field: "macd", operator: "lt", value: 0 },
      ]),
      false
    );
  });

  it("a finite metric alongside an unrelated NaN field still evaluates the finite one", () => {
    // rsi14 finite & passes; macd is NaN but no macd filter is applied.
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 65, macd: NaN }), [
        { field: "rsi_14", operator: "gt", value: 60 },
      ]),
      true
    );
    // ...but the moment a filter touches the NaN field, the stock is rejected.
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 65, macd: NaN }), [
        { field: "rsi_14", operator: "gt", value: 60 },
        { field: "macd", operator: "gt", value: 0 },
      ]),
      false
    );
  });
});

describe("matchesTechnicalFilters — contradictory & reversed filters", () => {
  const ind = (o: Partial<TechnicalIndicators>) => o as TechnicalIndicators;

  it("contradictory rsi > 70 AND rsi < 30 can never match", () => {
    for (const rsi of [10, 30, 50, 70, 90]) {
      assert.equal(
        matchesTechnicalFilters(ind({ rsi14: rsi }), [
          { field: "rsi_14", operator: "gt", value: 70 },
          { field: "rsi_14", operator: "lt", value: 30 },
        ]),
        false,
        `rsi=${rsi} must not satisfy a contradiction`
      );
    }
  });

  it("reversed between bounds [70, 40] rejects mid-range values (min>max edge)", () => {
    // Source does `[min, max] = value` then `numVal < min || numVal > max`.
    // With [70,40]: 50 < 70 → reject. Documents that reversed bounds = empty set.
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: 50 }), [
        { field: "rsi_14", operator: "between", value: [70, 40] },
      ]),
      false
    );
  });

  it("eq against NaN value rejects (already correct pre-fix)", () => {
    assert.equal(
      matchesTechnicalFilters(ind({ rsi14: NaN }), [
        { field: "rsi_14", operator: "eq", value: 50 },
      ]),
      false
    );
  });
});

// ── Routing classification (local mirror, labelled) ─────────────────

describe("runScreener routing classification (mirror)", () => {
  it("routes pure fundamental / pure technical / combined", () => {
    assert.equal(
      classifyFilters([
        { field: "pe", operator: "lt", value: 15 },
        { field: "roe", operator: "gt", value: 15 },
      ]).routeType,
      "fundamental"
    );
    assert.equal(
      classifyFilters([{ field: "rsi_14", operator: "gt", value: 60 }])
        .routeType,
      "technical"
    );
    assert.equal(
      classifyFilters([
        { field: "pe", operator: "lt", value: 25 },
        { field: "rsi_14", operator: "between", value: [40, 70] },
      ]).routeType,
      "combined"
    );
  });

  it("EDGE: all-unknown fields classify as empty → combined (else) branch", () => {
    const { fundamentalFilters, technicalFilters, routeType } = classifyFilters(
      [
        { field: "promoterHolding", operator: "gt", value: 50 },
        { field: "fiiHolding", operator: "gt", value: 10 },
      ]
    );
    assert.equal(fundamentalFilters.length, 0);
    assert.equal(technicalFilters.length, 0);
    assert.equal(routeType, "combined");
  });

  it("EDGE: empty filter list classifies as combined with zero filters", () => {
    const { routeType, fundamentalFilters, technicalFilters } = classifyFilters(
      []
    );
    assert.equal(routeType, "combined");
    assert.equal(fundamentalFilters.length + technicalFilters.length, 0);
  });
});

// ── Sort + limit boundaries (local mirror, labelled) ────────────────

describe("sort + pagination boundaries (mirror)", () => {
  const rows: ScreenerResult[] = [
    { symbol: "A", exchange: "NSE", name: "A", pe: 20 },
    { symbol: "B", exchange: "NSE", name: "B", pe: 10 },
    { symbol: "C", exchange: "NSE", name: "C", pe: 30 },
    { symbol: "D", exchange: "NSE", name: "D", pe: 5 },
  ];

  it("sorts asc / desc by a numeric field", () => {
    assert.equal(
      sortResults(rows, { sortBy: "pe", sortDir: "asc" })[0]!.symbol,
      "D"
    );
    assert.equal(
      sortResults(rows, { sortBy: "pe", sortDir: "desc" })[0]!.symbol,
      "C"
    );
  });

  it("EDGE: null/undefined/NaN sort keys are treated as 0", () => {
    const withHoles: ScreenerResult[] = [
      { symbol: "X", exchange: "NSE", name: "X", pe: null },
      { symbol: "Y", exchange: "NSE", name: "Y", pe: 15 },
      { symbol: "Z", exchange: "NSE", name: "Z", pe: undefined },
      { symbol: "W", exchange: "NSE", name: "W", pe: NaN },
    ];
    const sorted = sortResults(withHoles, { sortBy: "pe", sortDir: "asc" });
    // null/undefined/NaN → (val || 0) === 0, all sort below the 15
    assert.equal(sorted[sorted.length - 1]!.symbol, "Y");
  });

  it("EDGE: empty universe stays empty after sort+limit", () => {
    assert.deepEqual(sortResults([], { sortBy: "pe", limit: 10 }), []);
  });

  it("EDGE: limit 0 falls back to default 50 (|| 0 is falsy in source)", () => {
    const many: ScreenerResult[] = Array.from({ length: 80 }, (_, i) => ({
      symbol: `S${i}`,
      exchange: "NSE",
      name: `S${i}`,
      pe: i,
    }));
    // `options.limit || 50` → 0 is falsy → 50. Documents the real behavior.
    assert.equal(sortResults(many, { limit: 0 }).length, 50);
  });

  it("EDGE: limit 1 and limit > length", () => {
    const many: ScreenerResult[] = Array.from({ length: 3 }, (_, i) => ({
      symbol: `S${i}`,
      exchange: "NSE",
      name: `S${i}`,
      pe: i,
    }));
    assert.equal(sortResults(many, { limit: 1 }).length, 1);
    assert.equal(sortResults(many, { limit: 999 }).length, 3);
  });
});
