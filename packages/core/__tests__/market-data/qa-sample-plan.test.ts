/**
 * The QA sample plan must cover every collection the sync actually copies.
 *
 * The defect this file exists to prevent is a SILENT one. `--tier=sample`
 * iterates the plan, so a collection present in `REFERENCE_COLLECTIONS` but
 * absent from `SAMPLE_PLAN` is simply never copied — QA ends up with an empty
 * table that looks exactly like a table which is legitimately empty. No error,
 * no count, nothing in a log. That is the same shape as MONEY-1255 (a job that
 * answered 200 and wrote zero rows for five months) and it is why the coverage
 * assertion below reads the SHELL SCRIPT rather than a hand-kept list: a
 * hand-kept list is a second copy of the truth, and the two drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SAMPLE_PLAN,
  buildQuery,
  assertPlanIsDeliberate,
  capUniverse,
  estimateRows,
  type SampleUniverse,
  type SampleWindow,
} from "../../src/ops/qa-sample-plan";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SYNC = readFileSync(join(ROOT, "scripts/ops/sync-prod-to-qa.sh"), "utf8");

/**
 * Strip `#` comments before matching. The sync script DESCRIBES collections it
 * deliberately does not copy (the QA-DIRECT block names `daily_prices`,
 * `latest_quotes`, `intraday_bars` at length), so a match against raw text
 * would pick up prose and assert the opposite of the truth.
 */
const SYNC_CODE = SYNC.replace(/^\s*#.*$/gm, "");

function bashArray(name: string): Set<string> {
  const at = SYNC_CODE.indexOf(`${name}=(`);
  assert.ok(at > 0, `${name} not found in sync-prod-to-qa.sh`);
  const block = SYNC_CODE.slice(at, SYNC_CODE.indexOf("\n)", at));
  return new Set([...block.matchAll(/^\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]!));
}

const UNIVERSE: SampleUniverse = {
  inSymbols: ["RELIANCE", "TCS", "ACC"],
  usSymbols: ["AAPL", "MSFT", "LEH"],
  usFundSymbols: ["VFIAX", "FXAIX"],
  isins: ["INE002A01018"],
  schemeCodes: ["119551"],
};
const WINDOW: SampleWindow = {
  years: 2,
  now: new Date("2026-08-28T00:00:00.000Z"),
};

test("the plan covers every collection the sync copies", () => {
  const shell = bashArray("REFERENCE_COLLECTIONS");
  const planned = new Set(SAMPLE_PLAN.map((d) => d.collection));

  const uncovered = [...shell].filter((c) => !planned.has(c));
  assert.deepEqual(
    uncovered,
    [],
    `in REFERENCE_COLLECTIONS but missing from SAMPLE_PLAN — these would silently never reach QA: ${uncovered.join(", ")}`,
  );
});

test("every planned collection states why", () => {
  for (const d of SAMPLE_PLAN) {
    assert.ok(
      d.why.trim().length > 20,
      `${d.collection}: rationale too thin to be a decision`,
    );
  }
});

test("no collection is planned twice", () => {
  const seen = new Set<string>();
  for (const d of SAMPLE_PLAN) {
    assert.ok(!seen.has(d.collection), `${d.collection} appears twice`);
    seen.add(d.collection);
  }
});

test("a symbol bound emits $in on the declared field, per market", () => {
  const flags = SAMPLE_PLAN.find((d) => d.collection === "stock_flags")!;
  const q = buildQuery(flags, UNIVERSE, WINDOW);
  assert.deepEqual(q["symbol"], { $in: ["RELIANCE", "TCS", "ACC"] });

  const candles = SAMPLE_PLAN.find((d) => d.collection === "candles")!;
  const qc = buildQuery(candles, UNIVERSE, WINDOW);
  assert.deepEqual(
    qc["symbol"],
    { $in: ["AAPL", "MSFT", "LEH"] },
    "a US collection must draw from the US list",
  );
});

test("scheme- and isin-bounded collections do NOT use the symbol list", () => {
  const nav = SAMPLE_PLAN.find((d) => d.collection === "mf_nav_history")!;
  const q = buildQuery(nav, UNIVERSE, WINDOW);
  assert.deepEqual(q["schemeCode"], { $in: ["119551"] });
  assert.equal(
    q["symbol"],
    undefined,
    "mf_nav_history has no symbol field — a symbol filter returns zero rows",
  );

  const holdings = SAMPLE_PLAN.find(
    (d) => d.collection === "mf_portfolio_holdings",
  )!;
  assert.deepEqual(buildQuery(holdings, UNIVERSE, WINDOW)["isin"], {
    $in: ["INE002A01018"],
  });
});

test("the time bound is Extended JSON, not a bare ISO string", () => {
  const flags = SAMPLE_PLAN.find((d) => d.collection === "stock_flags")!;
  const q = buildQuery(flags, UNIVERSE, WINDOW) as {
    date: { $gte: { $date: string } };
  };
  // mongodump parses --query as Extended JSON. A bare string compares as a
  // STRING against a BSON date and matches NOTHING — and an empty result is
  // indistinguishable from "no rows in the window", so this cannot be caught
  // downstream.
  assert.equal(
    typeof q.date.$gte,
    "object",
    "a bare string here silently copies zero rows",
  );
  assert.equal(q.date.$gte.$date, "2024-08-28T00:00:00.000Z");
});

test("`all` and `recent` bounds emit no symbol filter", () => {
  const ipos = SAMPLE_PLAN.find((d) => d.collection === "upcoming_ipos")!;
  // An IPO is not yet listed, so it can never be in a top-500-by-mcap sample.
  // Filtering it by symbol empties QA's IPO surface.
  assert.deepEqual(buildQuery(ipos, UNIVERSE, WINDOW), {});

  const pos = SAMPLE_PLAN.find((d) => d.collection === "market_positioning")!;
  const q = buildQuery(pos, UNIVERSE, WINDOW);
  assert.equal(
    q["symbol"],
    undefined,
    "market-wide rows have no symbol dimension",
  );
  assert.ok(q["date"], "…so time is the only bound that returns rows");
});

test("an empty symbol list is REFUSED, not treated as match-all", () => {
  const empty: SampleUniverse = { ...UNIVERSE, usSymbols: [] };
  const problems = assertPlanIsDeliberate(SAMPLE_PLAN, empty);
  assert.ok(
    problems.some((p) => p.includes("candles") && p.includes("0 US symbols")),
    `expected a refusal naming candles; got: ${problems.join(" | ")}`,
  );
  // And prove the guard is not vacuous: a full universe must produce none.
  assert.deepEqual(assertPlanIsDeliberate(SAMPLE_PLAN, UNIVERSE), []);
});

test("$in over an empty list matches nothing (the reason the guard exists)", () => {
  const empty: SampleUniverse = { ...UNIVERSE, usSymbols: [] };
  const candles = SAMPLE_PLAN.find((d) => d.collection === "candles")!;
  assert.deepEqual(
    buildQuery(candles, empty, WINDOW)["symbol"],
    { $in: [] },
    "documents the trap: $in:[] is a valid query that copies zero rows",
  );
});

test("the estimate shows a real saving", () => {
  const { before, after } = estimateRows(SAMPLE_PLAN, UNIVERSE, 11_738);
  assert.ok(
    before > 12_000_000,
    `prod reference tier measured 12.75M rows, got ${before}`,
  );
  assert.ok(
    after < before / 10,
    `sampling should cut an order of magnitude; ${before} -> ${after}`,
  );
});

test("the four biggest tables are all bounded", () => {
  // 85% of the reference tier is these four. If any becomes `all`, the sample
  // tier stops being a sample.
  for (const c of [
    "stock_flags",
    "mf_nav_history",
    "slb_positions",
    "derivative_summary",
  ]) {
    const d = SAMPLE_PLAN.find((x) => x.collection === c)!;
    assert.notEqual(
      d.bound.kind,
      "all",
      `${c} is ${d.prodRows} rows — it must be bounded`,
    );
    assert.ok(d.timeField, `${c} must carry a history window`);
  }
});

test("us_fund_nav draws from the FUND vector, never the equity one", () => {
  // Its only writer selects `assetType === "Mutual Fund"` (49,414 of 72,685 US
  // listings). The equity manifest is S&P 500 + ETFs + delisted STOCKS and
  // holds no fund, so binding this table to `usSymbols` sampled it against a
  // list it can never match: zero rows, the empty-guard skips, and the run
  // reports "empty-in-prod" and exits 0.
  const d = SAMPLE_PLAN.find((x) => x.collection === "us_fund_nav")!;
  const q = buildQuery(d, UNIVERSE, WINDOW);
  assert.deepEqual(q["symbol"], { $in: ["VFIAX", "FXAIX"] });

  const candles = SAMPLE_PLAN.find((x) => x.collection === "candles")!;
  assert.deepEqual(
    buildQuery(candles, UNIVERSE, WINDOW)["symbol"],
    { $in: ["AAPL", "MSFT", "LEH"] },
    "every OTHER US collection still draws from the equity vector",
  );
});

test("an empty fund vector is REFUSED, and named as a fund vector", () => {
  const noFunds: SampleUniverse = { ...UNIVERSE, usFundSymbols: [] };
  const problems = assertPlanIsDeliberate(SAMPLE_PLAN, noFunds);
  assert.ok(
    problems.some((p) => p.includes("us_fund_nav") && p.includes("FUND")),
    `expected a refusal naming us_fund_nav and the FUND vector; got: ${problems.join(" | ")}`,
  );
  // …and it must not fire when the vector is populated.
  assert.deepEqual(assertPlanIsDeliberate(SAMPLE_PLAN, UNIVERSE), []);
});

test("--universe caps EVERY dimension, not just the ones with tickers", () => {
  // The flag was parsed, echoed into the banner and documented in --help while
  // being forwarded nowhere, so it printed a confident "universe=100" and
  // copied the full manifest.
  const big: SampleUniverse = {
    inSymbols: ["A", "B", "C"],
    usSymbols: ["D", "E", "F"],
    usFundSymbols: ["G", "H", "I"],
    isins: ["I1", "I2", "I3"],
    schemeCodes: ["S1", "S2", "S3"],
  };
  const c = capUniverse(big, 2);
  assert.deepEqual(c.inSymbols, ["A", "B"]);
  assert.deepEqual(c.usSymbols, ["D", "E"]);
  assert.deepEqual(c.usFundSymbols, ["G", "H"]);
  assert.deepEqual(c.isins, ["I1", "I2"]);
  assert.deepEqual(c.schemeCodes, ["S1", "S2"]);
});

test("a nonsensical cap is a no-op, never an empty universe", () => {
  // Silently emptying the universe here would turn a typo into 39 collections
  // that match nothing — and `mongorestore --drop` makes that destructive.
  for (const n of [0, -5, NaN, Infinity]) {
    assert.deepEqual(capUniverse(UNIVERSE, n), UNIVERSE, `cap ${n}`);
  }
});
