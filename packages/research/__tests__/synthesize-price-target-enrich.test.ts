/**
 * MONEY-1060 (RC5a + review fixes 7/8): enrichPriceTargetFromTasks must
 * reconstruct priceTarget.current from fetch_price_history's LAST CLOSE when
 * the quote / DCF / scenario / ratios sources are all absent — and must NOT
 * delete priceTarget in that case (the bug: the report showed no current
 * price). Review fixes:
 *
 *   fix 8 — benchmark price-history tasks (params.symbol starting "^", e.g.
 *   ^NSEI planned LAST by stock-risk-analysis) must never supply the price;
 *   the FIRST eligible task's close wins (subject planned first).
 *
 *   fix 7 — when the current price came from a STALE DB-fallback quote
 *   (stale:true / source:"db"), its asOf is threaded to
 *   priceTarget.currentAsOf so a week-old close isn't presented as live.
 *
 * De-shadow guarantee: imports the REAL enrichPriceTargetFromTasks
 * (packages/research/src/tools/synthesize-report.ts); no logic is re-declared
 * here. Mirrors the mocking style of synthesize-overlap-enrich.test.ts — a task
 * list of { tool, status, result[, params] } records driven straight through
 * the export.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichPriceTargetFromTasks } from "../src/tools/synthesize-report";

type Rec = Record<string, unknown>;
type Task = {
  tool: string;
  status?: string;
  result?: unknown;
  params?: Record<string, unknown>;
};

function priceHistoryTask(result: unknown, symbol?: string): Task {
  return {
    tool: "fetch_price_history",
    status: "completed",
    result,
    ...(symbol !== undefined ? { params: { symbol } } : {}),
  };
}

/** Three ascending daily bars; the last close (109.5) is the current price. */
const BARS = [
  {
    date: "2026-06-01",
    open: 100,
    high: 105,
    low: 99,
    close: 101,
    volume: 1000,
  },
  {
    date: "2026-06-02",
    open: 101,
    high: 108,
    low: 100,
    close: 107,
    volume: 1200,
  },
  {
    date: "2026-06-03",
    open: 107,
    high: 110,
    low: 105,
    close: 109.5,
    volume: 900,
  },
];

describe("enrichPriceTargetFromTasks — fetch_price_history last close (MONEY-1060)", () => {
  it("sets priceTarget.current to the last close when no other price source exists", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [priceHistoryTask(BARS)]);
    const pt = report.priceTarget as Rec | undefined;
    assert.ok(pt, "priceTarget was created (not deleted)");
    assert.equal(pt!.current, 109.5);
  });

  it("normalizes the { prices: [...] } wrapper shape", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [priceHistoryTask({ prices: BARS })]);
    assert.equal((report.priceTarget as Rec).current, 109.5);
  });

  it("does not delete an all-N/A priceTarget when price-history has a last close", () => {
    const report: Rec = {
      priceTarget: { current: "N/A", low: "N/A", mid: "N/A", high: "N/A" },
    };
    enrichPriceTargetFromTasks(report, [priceHistoryTask(BARS)]);
    const pt = report.priceTarget as Rec | undefined;
    assert.ok(pt, "priceTarget retained, not deleted");
    assert.equal(pt!.current, 109.5);
  });

  it("keeps the last close as the LOWEST priority — a real quote wins", () => {
    const report: Rec = {};
    // price-history listed BEFORE the quote to prove ordering can't let the
    // last close outrank a real fetch_stock_price value.
    enrichPriceTargetFromTasks(report, [
      priceHistoryTask(BARS),
      {
        tool: "fetch_stock_price",
        status: "completed",
        result: { TCS: { price: 3500 } },
      },
    ]);
    assert.equal((report.priceTarget as Rec).current, 3500);
  });

  it("still deletes an all-N/A priceTarget when NO price source (incl. price-history) has data", () => {
    const report: Rec = { priceTarget: { current: "N/A", mid: "N/A" } };
    enrichPriceTargetFromTasks(report, [
      { tool: "fetch_news", status: "completed", result: [{ headline: "x" }] },
    ]);
    assert.equal(report.priceTarget, undefined);
  });

  it("ignores an empty bars array (fabricates no current)", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [priceHistoryTask([])]);
    assert.equal(report.priceTarget, undefined);
  });

  it("ignores a non-positive last close", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      priceHistoryTask([{ date: "2026-06-03", close: 0 }]),
    ]);
    assert.equal(report.priceTarget, undefined);
  });

  it("ignores non-completed price-history tasks", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      { tool: "fetch_price_history", status: "failed", result: BARS },
    ]);
    assert.equal(report.priceTarget, undefined);
  });
});

// ── fix 8: benchmark (^) skip + keep-first among price-history tasks ─────────

/** Nifty-scale bars — obviously NOT a stock price if promoted. */
const NIFTY_BARS = [
  {
    date: "2026-06-02",
    open: 23900,
    high: 24100,
    low: 23800,
    close: 24000,
    volume: 0,
  },
  {
    date: "2026-06-03",
    open: 24000,
    high: 24300,
    low: 23950,
    close: 24250,
    volume: 0,
  },
];

describe("enrichPriceTargetFromTasks — benchmark guard (MONEY-1060 fix 8)", () => {
  it("benchmark planned LAST: the subject's close wins, not the index level", () => {
    // stock-risk-analysis plans the subject history first and ^NSEI last; the
    // pre-fix loop overwrote per task, promoting 24250 as the "current price".
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      priceHistoryTask(BARS, "TCS.NS"),
      priceHistoryTask(NIFTY_BARS, "^NSEI"),
    ]);
    assert.equal((report.priceTarget as Rec).current, 109.5);
  });

  it("caret-only: an index-only history never promotes a price (priceTarget still deleted)", () => {
    const report: Rec = {
      priceTarget: { current: "N/A", low: "N/A", mid: "N/A", high: "N/A" },
    };
    enrichPriceTargetFromTasks(report, [priceHistoryTask(NIFTY_BARS, "^NSEI")]);
    assert.equal(
      report.priceTarget,
      undefined,
      "an all-N/A priceTarget with only benchmark data must be removed",
    );
  });

  it("first-wins with two stocks: the first task's close is kept", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      priceHistoryTask(BARS, "TCS.NS"), // last close 109.5
      priceHistoryTask(
        [
          {
            date: "2026-06-03",
            open: 1490,
            high: 1510,
            low: 1480,
            close: 1500,
            volume: 100,
          },
        ],
        "INFY.NS",
      ),
    ]);
    assert.equal((report.priceTarget as Rec).current, 109.5);
  });

  it("a task with NO params stays eligible (defensive keep-first)", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      priceHistoryTask(BARS), // no params at all
      priceHistoryTask(NIFTY_BARS, "^NSEI"),
    ]);
    assert.equal((report.priceTarget as Rec).current, 109.5);
  });

  it("an empty first series does not block a later non-benchmark series", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      priceHistoryTask([], "TCS.NS"),
      priceHistoryTask(BARS, "INFY.NS"),
    ]);
    assert.equal((report.priceTarget as Rec).current, 109.5);
  });
});

// ── fix 7: stale DB quote → priceTarget.currentAsOf ──────────────────────────

describe("enrichPriceTargetFromTasks — stale-quote asOf threading (MONEY-1060 fix 7)", () => {
  const STALE_QUOTE = {
    "TCS.NS": {
      symbol: "TCS.NS",
      price: 3900,
      source: "db",
      stale: true,
      asOf: "2026-06-28T00:00:00.000Z",
    },
  };

  it("threads the stale DB quote's asOf onto priceTarget.currentAsOf", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      { tool: "fetch_stock_price", status: "completed", result: STALE_QUOTE },
    ]);
    const pt = report.priceTarget as Rec;
    assert.equal(pt.current, 3900);
    assert.equal(pt.currentAsOf, "2026-06-28T00:00:00.000Z");
  });

  it("a fresh live quote carries NO currentAsOf", () => {
    const report: Rec = {};
    enrichPriceTargetFromTasks(report, [
      {
        tool: "fetch_stock_price",
        status: "completed",
        result: { "TCS.NS": { symbol: "TCS.NS", price: 4000 } },
      },
    ]);
    const pt = report.priceTarget as Rec;
    assert.equal(pt.current, 4000);
    assert.equal(pt.currentAsOf, undefined);
  });

  it("an LLM-provided real current wins and no stale asOf is attached", () => {
    const report: Rec = { priceTarget: { current: 4100 } };
    enrichPriceTargetFromTasks(report, [
      { tool: "fetch_stock_price", status: "completed", result: STALE_QUOTE },
    ]);
    const pt = report.priceTarget as Rec;
    assert.equal(pt.current, 4100, "a valid LLM current is never overwritten");
    assert.equal(pt.currentAsOf, undefined);
  });
});
