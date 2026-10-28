import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapStatus,
  phaseForTool,
  iconForTool,
  humanize,
  isNonEmpty,
  deriveStage,
  toSentiment,
  extractArticles,
  extractMetricTiles,
  isNewsTool,
  isMetricsTool,
} from "../../components/stocksage/ResearchRunBlock";

/**
 * MONEY-672 / MONEY-678 (P8): the pure mappers behind the StockSage v2
 * research-run cards. These encode the reported-bug fixes, so they're the
 * highest-value thing to lock down.
 */

test("mapStatus normalizes raw tool statuses to the design states", () => {
  assert.equal(mapStatus("completed"), "done");
  assert.equal(mapStatus("success"), "done");
  assert.equal(mapStatus("ok"), "done");
  assert.equal(mapStatus("running"), "running");
  assert.equal(mapStatus("in_progress"), "running");
  assert.equal(mapStatus("polling"), "running");
  assert.equal(mapStatus("failed"), "failed");
  assert.equal(mapStatus("error"), "failed");
  assert.equal(mapStatus("timeout"), "failed");
  assert.equal(mapStatus("pending"), "pending");
  assert.equal(mapStatus(""), "pending");
});

test("isNonEmpty drives the empty-but-green fix", () => {
  // Empty / missing payloads → "no data" (not a blank green expand).
  assert.equal(isNonEmpty(null), false);
  assert.equal(isNonEmpty(undefined), false);
  assert.equal(isNonEmpty(""), false);
  assert.equal(isNonEmpty("   "), false);
  assert.equal(isNonEmpty([]), false);
  assert.equal(isNonEmpty({}), false);
  // The exact reported bug: a "successful" financial fetch with no rows.
  assert.equal(isNonEmpty({ annual: [], quarterly: [] }), false);
  assert.equal(isNonEmpty([[], {}, ""]), false);
  // Real data → has data (note: 0 and false are real values).
  assert.equal(isNonEmpty(0), true);
  assert.equal(isNonEmpty(false), true);
  assert.equal(isNonEmpty("INFY"), true);
  assert.equal(isNonEmpty([{ revenue: 100 }]), true);
  assert.equal(isNonEmpty({ annual: [{ revenue: 100 }], quarterly: [] }), true);
});

test("phaseForTool groups tools under the design phases", () => {
  assert.equal(phaseForTool("fetch_balance_sheet"), "Data fetch");
  assert.equal(phaseForTool("fetch_news"), "Data fetch");
  assert.equal(phaseForTool("fetch_price_history"), "Data fetch");
  assert.equal(phaseForTool("compute_dcf_valuation"), "Computation");
  assert.equal(phaseForTool("run_backtest"), "Computation");
  assert.equal(phaseForTool("synthesize_report"), "Synthesis");
  assert.equal(phaseForTool("score_company"), "Synthesis");
  assert.equal(phaseForTool("analyze_moat"), "Analysis");
});

test("iconForTool maps tools to design icon names", () => {
  assert.equal(iconForTool("fetch_news"), "newspaper");
  assert.equal(iconForTool("fetch_price_history"), "candle");
  assert.equal(iconForTool("fetch_technicals"), "candle");
  assert.equal(iconForTool("peer_comparison"), "scale");
  assert.equal(iconForTool("fetch_balance_sheet"), "file");
  assert.equal(iconForTool("fetch_business_profile"), "briefcase");
  assert.equal(iconForTool("compute_dcf"), "gauge");
  assert.equal(iconForTool("synthesize"), "sparkles");
  assert.equal(iconForTool("mystery_tool"), "database");
});

test("humanize prettifies snake_case tool ids", () => {
  assert.equal(humanize("fetch_balance_sheet"), "Fetch Balance Sheet");
  assert.equal(humanize("compute_dcf_valuation"), "Compute Dcf Valuation");
});

test("deriveStage maps run status/progress to the lifecycle stepper", () => {
  assert.equal(
    deriveStage({ status: "failed", progress: 50, tasks: [] }),
    "FAILED"
  );
  assert.equal(
    deriveStage({ status: "completed", progress: 100, tasks: [] }),
    "COMPLETED"
  );
  // MONEY-778: the very-early window surfaces QUEUED (stepper's first node).
  assert.equal(
    deriveStage({ status: "running", progress: 1, tasks: [] }),
    "QUEUED"
  );
  assert.equal(
    deriveStage({ status: "running", progress: 5, tasks: [] }),
    "PLANNING"
  );
  assert.equal(
    deriveStage({ status: "running", progress: 40, tasks: [] }),
    "RESEARCHING"
  );
  assert.equal(
    deriveStage({ status: "running", progress: 80, tasks: [] }),
    "ANALYZING"
  );
  assert.equal(
    deriveStage({ status: "running", progress: 95, tasks: [] }),
    "SYNTHESIZING"
  );
});

/* ── MONEY-778: typed task previews (news cards + computation tiles) ── */

test("isNewsTool / isMetricsTool route tools to the right typed preview", () => {
  for (const t of ["fetch_news", "compute_news_sentiment", "fetch_filings"]) {
    assert.equal(isNewsTool(t), true, `${t} → news`);
  }
  for (const t of [
    "compute_dcf_valuation",
    "compute_ddm",
    "compute_scenario_analysis",
    "compute_quant_score",
    "compute_forward_scenarios",
  ]) {
    assert.equal(isMetricsTool(t), true, `${t} → metrics`);
  }
  assert.equal(isNewsTool("fetch_balance_sheet"), false);
  assert.equal(isMetricsTool("fetch_news"), false);
});

test("toSentiment maps strings and [-1,1] scores", () => {
  assert.equal(toSentiment("POSITIVE"), "positive");
  assert.equal(toSentiment("bearish"), "negative");
  assert.equal(toSentiment("neutral"), "neutral");
  assert.equal(toSentiment(0.8), "positive");
  assert.equal(toSentiment(-0.5), "negative");
  assert.equal(toSentiment(0.05), "neutral");
  assert.equal(toSentiment(undefined), undefined);
  assert.equal(toSentiment({}), undefined);
});

test("extractArticles defensively handles varied news shapes + caps at 4", () => {
  // fetch_news shape: { data: [...] }
  const a = extractArticles({
    data: [
      {
        title: "Infy Q3 up 11%",
        source: "Economic Times",
        url: "https://economictimes.indiatimes.com/x",
        date: "2d ago",
        score: 0.7,
      },
    ],
  });
  assert.equal(a.length, 1);
  assert.equal(a[0]!.title, "Infy Q3 up 11%");
  assert.equal(a[0]!.source, "Economic Times");
  assert.equal(a[0]!.domain, "economictimes.indiatimes.com");
  assert.equal(a[0]!.sentiment, "positive");

  // compute_news_sentiment shape: { articles: [...] }; bare array; items[]
  assert.equal(extractArticles({ articles: [{ title: "x" }] }).length, 1);
  assert.equal(extractArticles([{ title: "y" }]).length, 1);
  // rows with no title are skipped; cap at 4
  const many = extractArticles({
    data: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}` })),
  });
  assert.equal(many.length, 4);
  // garbage → empty (caller falls back to the generic preview)
  assert.deepEqual(extractArticles(null), []);
  assert.deepEqual(extractArticles({ nope: 1 }), []);
});

test("extractMetricTiles surfaces scalars, scrubs advice fields, unwraps symbol", () => {
  // advice-adjacent forward values are dropped; currentPrice + facts stay.
  const tiles = extractMetricTiles({
    currentPrice: 1293,
    expectedValue: 933.35,
    upside: -27.8,
    intrinsicValue: 1712,
    wacc: "11.8%",
  });
  const labels = tiles.map((t) => t.label);
  assert.ok(labels.includes("currentPrice"));
  assert.ok(labels.includes("intrinsicValue"), "intrinsic shows (per design)");
  assert.ok(labels.includes("wacc"));
  assert.ok(!labels.includes("expectedValue"), "expectedValue scrubbed");
  assert.ok(!labels.includes("upside"), "upside scrubbed");

  // single-symbol wrapper { INFY: {...} } is unwrapped to the inner scalars.
  const wrapped = extractMetricTiles({ INFY: { pe: 24.3, roe: "31%" } });
  assert.deepEqual(wrapped.map((t) => t.label).sort(), ["pe", "roe"]);
  assert.deepEqual(extractMetricTiles("nope"), []);
});
