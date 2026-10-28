/**
 * Strategy engine — negative / edge coverage for the rule evaluator,
 * the strategy executor (evaluate_strategy tool + executeStrategy), and the
 * built-in strategy library shape.
 *
 * De-shadow guarantee: every test imports and executes the REAL exported
 * symbols and asserts THEIR output. No source logic is re-declared here.
 * Expected constants were derived by running the real source on fixed
 * fixtures, then pinned.
 *
 * Sources under test:
 *  - packages/research/src/lib/indicators.ts            (evaluateRule)
 *  - packages/research/src/tools/evaluate-strategy.ts   (evaluateStrategyTool — the executor)
 *  - packages/research/src/strategies/strategy-executor.ts (executeStrategy)
 *  - packages/research/src/strategies/builtin-strategies.ts (BUILTIN_STRATEGIES + lookups)
 *
 * Central safety property proven here: a NaN / Infinity indicator value
 * NEVER spuriously satisfies a rule (`met` stays a boolean `false` — every
 * comparison against NaN is false), and the executor's aggregate `score` /
 * `match` stay well-formed (no NaN leak) even when individual signal values
 * are NaN.
 *
 * Documented edge (not a code change here): evaluateRule() reads
 * `prices[prices.length - 1]` and several branches call `.toFixed()` on it,
 * so feeding an EMPTY prices array throws (currentPrice === undefined). The
 * production path is defended — evaluate_strategy gates `prices.length < 30`
 * BEFORE calling evaluateRule — so this only bites a direct caller passing
 * []. The test below pins the current throw so a regression to a silent-NaN
 * result is caught. See indicators.ts:654 (`const currentPrice = ...!`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRule,
  type StrategyRule,
  type SignalResult,
} from "../src/lib/indicators";
import { evaluateStrategyTool } from "../src/tools/evaluate-strategy";
import { executeStrategy } from "../src/strategies/strategy-executor";
import {
  BUILTIN_STRATEGIES,
  getStrategyById,
  getStrategiesByCategory,
  searchStrategies,
  getStrategyCategories,
  type BuiltInStrategy,
  type StrategyCategory,
} from "../src/strategies/builtin-strategies";

// ── Fixtures (deterministic, no randomness) ──────────────────

/** Strictly rising 60-bar close series → RSI saturates to 100. */
const RISING_60 = Array.from({ length: 60 }, (_, i) => 100 + i);
/** Flat 60-bar series. */
const FLAT_60 = Array.from({ length: 60 }, () => 100);
/** A 60-bar series with a NaN injected at the last (current) bar. */
const TAIL_NAN_60 = [...Array(59).fill(100), NaN];
/** A 60-bar series with an Infinity injected at the last bar. */
const TAIL_INF_60 = [...Array(59).fill(100), Infinity];

const VALID_SCAN_TYPES = new Set(["fundamental", "technical", "combined"]);
const VALID_CATEGORIES = new Set<StrategyCategory>([
  "value",
  "growth",
  "momentum",
  "income",
  "quality",
  "technical",
  "combined",
  "solvency",
  "cashflow",
  "shareholding",
  "corporate",
  "candlestick",
  "chart_pattern",
  "timeframe",
]);
const VALID_OPERATORS = new Set(["gt", "lt", "gte", "lte", "eq", "between"]);

// ════════════════════════════════════════════════════════════
// evaluateRule — the rule evaluator
// ════════════════════════════════════════════════════════════

describe("evaluateRule — NaN / Infinity never spuriously fires a rule", () => {
  test("NaN tail price: `above` rule does NOT fire (met=false), value leaks NaN", () => {
    const r = evaluateRule(
      { indicator: "price_vs_sma", condition: "above", params: { period: 50 } },
      TAIL_NAN_60,
    );
    assert.equal(r.met, false, "NaN must never satisfy an `above` rule");
    assert.equal(typeof r.met, "boolean");
    // The aggregate-safety property lives in `met`; the raw signal value is
    // allowed to carry NaN (the executor never uses it for scoring).
    assert.ok(Number.isNaN(r.value), "value reflects the NaN input");
  });

  test("NaN tail price: the COMPLEMENT `below` rule ALSO does NOT fire", () => {
    // The crux: with NaN, BOTH `above` and `below` are false — a rule can
    // never be coerced true by NaN, and contradictory rules don't both fire.
    const r = evaluateRule(
      { indicator: "price_vs_sma", condition: "below", params: { period: 50 } },
      TAIL_NAN_60,
    );
    assert.equal(r.met, false, "NaN must never satisfy a `below` rule either");
  });

  test("Infinity tail price: Bollinger below_lower does NOT fire", () => {
    const r = evaluateRule(
      {
        indicator: "bollinger",
        condition: "below_lower",
        params: { period: 20 },
      },
      TAIL_INF_60,
    );
    assert.equal(r.met, false);
    assert.equal(typeof r.met, "boolean");
  });

  test("RSI on a NaN-poisoned series yields met=false and a NaN value", () => {
    const r = evaluateRule(
      {
        indicator: "rsi",
        condition: "above",
        value: 50,
        params: { period: 14 },
      },
      TAIL_NAN_60,
    );
    assert.equal(r.met, false);
    assert.ok(Number.isNaN(r.value));
  });
});

describe("evaluateRule — unknown / malformed rule handling", () => {
  test("unknown indicator returns a well-formed not-met result, never throws", () => {
    const r = evaluateRule(
      { indicator: "totally_made_up", condition: "above", value: 5 },
      FLAT_60,
    );
    assert.equal(r.met, false);
    assert.equal(r.indicator, "totally_made_up");
    assert.equal(r.value, 0);
    assert.match(r.detail, /Unknown indicator/);
  });

  test("unknown CONDITION on a known indicator defaults to not-met (no branch matched)", () => {
    const r = evaluateRule(
      {
        indicator: "rsi",
        condition: "sideways",
        value: 50,
        params: { period: 14 },
      },
      RISING_60,
    );
    assert.equal(r.met, false, "an unrecognised condition leaves met=false");
    assert.equal(r.condition, "sideways");
    assert.ok(Number.isFinite(r.value), "value is still the real RSI");
  });

  test("volume rule with NO volume data degrades gracefully (met=false)", () => {
    const r = evaluateRule(
      { indicator: "volume", condition: "above", params: { multiplier: 2 } },
      FLAT_60,
      undefined,
    );
    assert.equal(r.met, false);
    assert.match(r.detail, /not available/i);
  });

  test("HLC-requiring rule (cci) without highs/lows degrades gracefully", () => {
    const r = evaluateRule(
      { indicator: "cci", condition: "above", value: 100 },
      FLAT_60,
    );
    assert.equal(r.met, false);
    assert.match(r.detail, /HLC data required/);
  });

  test("ichimoku with insufficient bars (<52) returns not-met, never throws", () => {
    const short = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = evaluateRule(
      { indicator: "ichimoku", condition: "above_cloud" },
      short,
      undefined,
      short,
      short,
    );
    assert.equal(r.met, false);
    assert.match(r.detail, /52\+ bars/);
  });
});

describe("evaluateRule — insufficient-data / boundary behavior", () => {
  test("ema_crossover on a SINGLE-element series does not throw and met=false", () => {
    const r = evaluateRule(
      {
        indicator: "ema_crossover",
        condition: "crossover",
        params: { fast: 9, slow: 21 },
      },
      [100],
    );
    assert.equal(r.met, false, "fast == slow on a 1-bar series, not above");
    assert.ok(Number.isFinite(r.value), "EMA of [100] is finite (100)");
  });

  test("RSI `between` is INCLUSIVE on the upper bound (rsi 100 in [40,100])", () => {
    const inRange = evaluateRule(
      { indicator: "rsi", condition: "between", value: 40, value2: 100 },
      RISING_60,
    );
    assert.equal(inRange.met, true, "hi bound is inclusive");
    const outOfRange = evaluateRule(
      { indicator: "rsi", condition: "between", value: 40, value2: 99 },
      RISING_60,
    );
    assert.equal(outOfRange.met, false, "rsi 100 is outside [40,99]");
  });

  test("contradictory `above` vs `below` on the same data are mutually exclusive", () => {
    // Non-degenerate series so price != SMA50 exactly.
    const data = Array.from(
      { length: 60 },
      (_, i) => 100 + Math.sin(i / 3) * 5,
    );
    const above = evaluateRule(
      { indicator: "price_vs_sma", condition: "above", params: { period: 50 } },
      data,
    ).met;
    const below = evaluateRule(
      { indicator: "price_vs_sma", condition: "below", params: { period: 50 } },
      data,
    ).met;
    assert.notEqual(above, below, "exactly one of above/below must hold");
  });

  test("EMPTY prices array THROWS today (documented edge; pins current behavior)", () => {
    // currentPrice = prices[-1] === undefined, then detail calls .toFixed().
    // Production is defended by the evaluate_strategy `<30` guard; this pins
    // the primitive's current contract so a silent-NaN regression is caught.
    // See indicators.ts:654.
    assert.throws(
      () =>
        evaluateRule(
          {
            indicator: "price_vs_sma",
            condition: "above",
            params: { period: 50 },
          },
          [],
        ),
      /Cannot read properties of undefined/,
    );
  });

  test("huge series (50k bars) evaluates fast and returns a finite, well-formed result", () => {
    const huge = Array.from(
      { length: 50_000 },
      (_, i) => 100 + Math.sin(i / 50) * 10,
    );
    const t0 = Date.now();
    const r = evaluateRule(
      {
        indicator: "rsi",
        condition: "above",
        value: 50,
        params: { period: 14 },
      },
      huge,
    );
    const elapsed = Date.now() - t0;
    assert.equal(typeof r.met, "boolean");
    assert.ok(Number.isFinite(r.value));
    assert.ok(elapsed < 5_000, `evaluation took ${elapsed}ms (expected < 5s)`);
  });
});

// ════════════════════════════════════════════════════════════
// evaluateStrategyTool — the executor (aggregation + scoring)
// ════════════════════════════════════════════════════════════

describe("evaluateStrategyTool — executor returns a well-formed result (no NaN in score)", () => {
  /** 60 bars with a NaN injected mid-series. */
  const NAN_MID = Array.from({ length: 60 }, (_, i) =>
    i === 30 ? NaN : 100 + Math.sin(i),
  );

  test("NaN-poisoned prices: score is FINITE, match is boolean, every signal.met is boolean", async () => {
    const out = await evaluateStrategyTool.execute({
      symbol: "TEST.NS",
      prices: NAN_MID,
      strategy: {
        name: "NaN Stress",
        rules: [
          {
            indicator: "rsi",
            condition: "above",
            value: 50,
            params: { period: 14 },
          },
          {
            indicator: "price_vs_sma",
            condition: "above",
            params: { period: 50 },
          },
          { indicator: "macd", condition: "bullish" },
        ],
      },
    });
    assert.equal(out.success, true);
    const data = out.data as {
      score: number;
      match: boolean;
      riskLevel: string;
      signals: SignalResult[];
    };
    assert.ok(
      Number.isFinite(data.score),
      "score must never be NaN even when signal values are NaN",
    );
    assert.ok(
      data.score >= 0 && data.score <= 100,
      "score is a 0..100 percentage",
    );
    assert.equal(typeof data.match, "boolean");
    assert.ok(["low", "medium", "high"].includes(data.riskLevel));
    for (const s of data.signals) {
      assert.equal(
        typeof s.met,
        "boolean",
        "every signal.met is a clean boolean",
      );
    }
  });

  test("ALL-NaN prices: executor still succeeds with a finite score of 0", async () => {
    const out = await evaluateStrategyTool.execute({
      symbol: "X.NS",
      prices: Array(40).fill(NaN),
      strategy: {
        name: "allnan",
        rules: [{ indicator: "rsi", condition: "above", value: 50 }],
      },
    });
    assert.equal(out.success, true);
    const data = out.data as { score: number; match: boolean };
    assert.ok(Number.isFinite(data.score));
    assert.equal(data.score, 0, "no rule fires on all-NaN → 0% score");
    assert.equal(data.match, false);
  });

  test("score == 100 ⇒ match == true ⇒ riskLevel low (all-rules-met invariant)", async () => {
    // Strictly rising series: RSI=100>50 AND price>SMA50 → both rules met.
    const out = await evaluateStrategyTool.execute({
      symbol: "UP.NS",
      prices: RISING_60,
      strategy: {
        name: "all met",
        rules: [
          { indicator: "rsi", condition: "above", value: 50 },
          {
            indicator: "price_vs_sma",
            condition: "above",
            params: { period: 50 },
          },
        ],
      },
    });
    assert.equal(out.success, true);
    const data = out.data as {
      score: number;
      match: boolean;
      riskLevel: string;
    };
    assert.equal(data.score, 100);
    assert.equal(data.match, true);
    assert.equal(data.riskLevel, "low");
  });
});

describe("evaluateStrategyTool — input guards (executor contract)", () => {
  test("fewer than 30 prices is rejected", async () => {
    const out = await evaluateStrategyTool.execute({
      symbol: "X",
      prices: Array(10).fill(100),
      strategy: {
        name: "n",
        rules: [{ indicator: "rsi", condition: "above", value: 50 }],
      },
    });
    assert.equal(out.success, false);
    assert.match(String(out.error), /30 price data points/);
  });

  test("empty rules array is rejected", async () => {
    const out = await evaluateStrategyTool.execute({
      symbol: "X",
      prices: Array(40).fill(100),
      strategy: { name: "n", rules: [] },
    });
    assert.equal(out.success, false);
    assert.match(String(out.error), /required/);
  });

  test("empty symbol is rejected", async () => {
    const out = await evaluateStrategyTool.execute({
      symbol: "",
      prices: Array(40).fill(100),
      strategy: {
        name: "n",
        rules: [{ indicator: "rsi", condition: "above", value: 50 }],
      },
    });
    assert.equal(out.success, false);
    assert.match(String(out.error), /required/);
  });
});

// ════════════════════════════════════════════════════════════
// executeStrategy — the DB-first executor (early-return paths only;
// the screener/DB path is exercised elsewhere — keep this orphan-free)
// ════════════════════════════════════════════════════════════

describe("executeStrategy — empty / invalid filters resolve without touching the DB", () => {
  test("empty filters → well-formed result, no DB call, errors populated", async () => {
    const r = await executeStrategy({
      name: "Empty",
      filters: [],
      logic: "AND",
      scanType: "fundamental",
    });
    assert.equal(r.strategyName, "Empty");
    assert.equal(r.scanType, "fundamental");
    assert.equal(r.strategyId, "custom");
    assert.equal(r.stockCount, 0);
    assert.deepEqual(r.stocks, []);
    assert.deepEqual(r.errors, ["No valid filters to execute"]);
    assert.ok(Number.isFinite(r.executionTimeMs) && r.executionTimeMs >= 0);
    assert.ok(
      !Number.isNaN(Date.parse(r.executedAt)),
      "executedAt is a valid ISO timestamp",
    );
  });

  test("filters with undefined value are dropped → also short-circuits before any DB query", async () => {
    const r = await executeStrategy({
      name: "Invalid",
      // value === undefined is filtered out by convertToScreenerFilters.
      filters: [
        {
          metric: "pe",
          operator: "lt",
          value: undefined as unknown as number,
          source: "fundamental",
        },
      ],
      logic: "AND",
      scanType: "fundamental",
    });
    assert.equal(r.stockCount, 0);
    assert.deepEqual(r.errors, ["No valid filters to execute"]);
  });

  test("filters with empty metric are dropped → short-circuits", async () => {
    const r = await executeStrategy({
      name: "BlankMetric",
      filters: [
        { metric: "", operator: "gt", value: 10, source: "fundamental" },
      ],
      logic: "OR",
      scanType: "technical",
    });
    assert.equal(r.stockCount, 0);
    assert.deepEqual(r.errors, ["No valid filters to execute"]);
  });
});

// ════════════════════════════════════════════════════════════
// BUILTIN_STRATEGIES — strategy library shape
// ════════════════════════════════════════════════════════════

describe("BUILTIN_STRATEGIES — every library entry is structurally valid", () => {
  test("the library is non-empty and every id is unique", () => {
    assert.ok(
      BUILTIN_STRATEGIES.length > 0,
      "strategy library must not be empty",
    );
    const ids = BUILTIN_STRATEGIES.map((s) => s.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      "duplicate strategy ids would shadow each other in getStrategyById",
    );
  });

  test("every entry has a non-empty id+name, a valid scanType, a valid category, and a filters array", () => {
    for (const s of BUILTIN_STRATEGIES) {
      assert.ok(
        s.id && typeof s.id === "string",
        `bad id on ${JSON.stringify(s.name)}`,
      );
      assert.ok(s.name && typeof s.name === "string", `bad name on ${s.id}`);
      assert.ok(
        VALID_SCAN_TYPES.has(s.scanType),
        `bad scanType on ${s.id}: ${s.scanType}`,
      );
      assert.ok(
        VALID_CATEGORIES.has(s.category),
        `bad category on ${s.id}: ${s.category}`,
      );
      assert.ok(
        Array.isArray(s.filters),
        `filters must be an array on ${s.id}`,
      );
      assert.ok(Array.isArray(s.tags), `tags must be an array on ${s.id}`);
    }
  });

  test("every filter has a finite numeric value, a valid operator, and `between` carries value2", () => {
    for (const s of BUILTIN_STRATEGIES) {
      for (const f of s.filters) {
        assert.ok(
          typeof f.value === "number" && Number.isFinite(f.value),
          `non-finite filter value on ${s.id}:${f.metric}`,
        );
        assert.ok(
          VALID_OPERATORS.has(f.operator),
          `bad operator on ${s.id}:${f.metric}: ${f.operator}`,
        );
        assert.ok(
          ["fundamental", "technical"].includes(f.source),
          `bad source on ${s.id}:${f.metric}: ${f.source}`,
        );
        if (f.operator === "between") {
          assert.ok(
            typeof f.value2 === "number" && Number.isFinite(f.value2),
            `between operator missing value2 on ${s.id}:${f.metric}`,
          );
        }
      }
    }
  });

  test("every fundamental/combined entry has at least one filter to run", () => {
    // Technical entries may legitimately delegate to a chartinkQuery or to a
    // pattern/delivery scan handled elsewhere, so they are exempt here.
    const fundamentalWithoutFilters = BUILTIN_STRATEGIES.filter(
      (s) => s.scanType !== "technical" && s.filters.length === 0,
    );
    assert.deepEqual(
      fundamentalWithoutFilters.map((s) => s.id),
      [],
      "a fundamental/combined strategy with no filters can never match anything",
    );
  });
});

describe("BUILTIN_STRATEGIES — lookup helpers operate on the real library", () => {
  test("getStrategyById round-trips every real id and returns undefined for an unknown id", () => {
    for (const s of BUILTIN_STRATEGIES) {
      const found = getStrategyById(s.id);
      assert.ok(found, `getStrategyById failed for ${s.id}`);
      assert.equal(found.id, s.id);
    }
    assert.equal(getStrategyById("__does_not_exist__"), undefined);
  });

  test("getStrategiesByCategory partitions the library and the counts sum to the total", () => {
    const cats = getStrategyCategories();
    const sum = cats.reduce((acc, c) => acc + c.count, 0);
    assert.equal(
      sum,
      BUILTIN_STRATEGIES.length,
      "category counts must cover every entry",
    );
    for (const c of cats) {
      const bucket: BuiltInStrategy[] = getStrategiesByCategory(c.category);
      assert.equal(
        bucket.length,
        c.count,
        `count mismatch for category ${c.category}`,
      );
      assert.ok(bucket.every((s) => s.category === c.category));
      assert.ok(c.label.length > 0, `missing label for ${c.category}`);
    }
  });

  test("searchStrategies('') matches everything; a nonsense query matches nothing", () => {
    assert.equal(
      searchStrategies("").length,
      BUILTIN_STRATEGIES.length,
      "empty query is a substring of every name → matches all",
    );
    assert.equal(searchStrategies("zzzqqq_no_such_strategy").length, 0);
  });

  test("searchStrategies finds a known strategy by a token in its name", () => {
    const hits = searchStrategies("graham");
    assert.ok(hits.length > 0, "expected at least one Graham strategy");
    assert.ok(
      hits.every(
        (s) =>
          s.name.toLowerCase().includes("graham") ||
          s.description.toLowerCase().includes("graham") ||
          s.tags.some((t) => t.includes("graham")),
      ),
    );
  });
});
