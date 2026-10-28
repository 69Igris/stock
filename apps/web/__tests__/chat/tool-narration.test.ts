/**
 * Tests for deterministic, tool-aware narration (MONEY-587).
 *
 * Narration is skipped for list/data tools (rendered blocks ARE the answer) but
 * KEPT for synthesis tools (financial data / risk / tax). The deterministic
 * summary is tool-aware: counts for lists, totals for the portfolio summary,
 * and confirmation lines for write tools.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSkipNarration,
  countResultRows,
  deterministicToolSummary,
  DETERMINISTIC_LIST_TOOLS,
} from "../../lib/chat/tool-narration";

describe("tool-narration: shouldSkipNarration", () => {
  it("skips narration for every list/data tool", () => {
    for (const t of [
      "get_holdings",
      "get_positions",
      "get_trades",
      "get_mutual_funds",
      "get_paper_positions",
      "get_portfolio_summary",
      "get_stock_news",
      "get_fire_scenarios",
      "list_strategies",
      "get_user_documents",
      "get_scan_history",
      "get_scan_result",
      "run_screener",
      "run_strategy_scan",
    ]) {
      assert.equal(shouldSkipNarration(t), true, `${t} should skip`);
    }
  });

  it("KEEPS narration for synthesis tools (interpretation adds value)", () => {
    assert.equal(shouldSkipNarration("get_financial_data"), false);
    assert.equal(shouldSkipNarration("portfolio_risk_analysis"), false);
    assert.equal(shouldSkipNarration("tax_report"), false);
    assert.equal(shouldSkipNarration("run_research"), false);
  });

  it("is null/undefined safe", () => {
    assert.equal(shouldSkipNarration(undefined), false);
    assert.equal(shouldSkipNarration(null), false);
    assert.equal(shouldSkipNarration(""), false);
  });

  it("skip set covers the list/data tools (incl. web_search grounding)", () => {
    // 14 list/data tools + web_search (grounded answer is the message text) +
    // get_shareholding & get_corporate_actions (MONEY-610: each renders its own
    // card and carries a deterministic summary line) + summarize_post (MONEY-887:
    // generated summary is the message text) + fire_plan (server-side FIRE turn
    // returns its own finished reply) = 19.
    assert.equal(DETERMINISTIC_LIST_TOOLS.size, 19);
    assert.equal(shouldSkipNarration("fire_plan"), true);
    assert.equal(shouldSkipNarration("web_search"), true);
    // Anchor the count to real membership rather than a bare magic number.
    assert.equal(shouldSkipNarration("get_shareholding"), true);
    assert.equal(shouldSkipNarration("get_corporate_actions"), true);
  });
});

describe("tool-narration: countResultRows (wrapper-aware)", () => {
  it("counts bare arrays + common wrappers", () => {
    assert.equal(countResultRows([1, 2, 3]), 3);
    assert.equal(countResultRows({ data: [1, 2] }), 2);
    assert.equal(countResultRows({ results: [1] }), 1);
    assert.equal(countResultRows({ scans: [1, 2, 3, 4] }), 4);
    assert.equal(countResultRows({ documents: [1], total: 1 }), 1);
  });
  it("merges list_strategies { builtIn, custom }", () => {
    assert.equal(countResultRows({ builtIn: [1, 2], custom: [3] }), 3);
  });
  it("falls back to the first array property", () => {
    assert.equal(countResultRows({ foo: 1, bar: [1, 2] }), 2);
  });
  it("returns null for single-object / scalar payloads", () => {
    assert.equal(countResultRows({ totalValue: 100 }), null);
    assert.equal(countResultRows("x"), null);
    assert.equal(countResultRows(null), null);
  });
});

describe("tool-narration: deterministicToolSummary (list tools)", () => {
  it("screener pluralises + handles zero", () => {
    assert.match(
      deterministicToolSummary("run_screener", [{}, {}]),
      /Found 2 matching stocks/
    );
    assert.match(
      deterministicToolSummary("run_screener", [{}]),
      /Found 1 matching stock\b/
    );
    assert.match(
      deterministicToolSummary("run_screener", []),
      /No stocks matched/
    );
  });

  it("uses tool-specific nouns + verbs", () => {
    assert.match(
      deterministicToolSummary("get_holdings", [{}, {}, {}]),
      /You hold 3 holdings/
    );
    assert.match(
      deterministicToolSummary("get_trades", [{}, {}]),
      /Showing your 2 trades/
    );
    assert.match(
      deterministicToolSummary("list_strategies", {
        builtIn: [{}],
        custom: [{}],
      }),
      /Found 2 strategies/
    );
    assert.match(
      deterministicToolSummary("get_scan_history", { scans: [{}, {}] }),
      /Found 2 past scans/
    );
  });

  it("empty list/portfolio tools read naturally", () => {
    assert.match(
      deterministicToolSummary("get_holdings", []),
      /don't have any holdings/
    );
  });
});

describe("tool-narration: deterministicToolSummary (portfolio + news)", () => {
  it("portfolio summary reads its totals", () => {
    const out = deterministicToolSummary("get_portfolio_summary", {
      portfolio: { totalValue: 100000, totalPnL: 5000, pnlPercentage: 5 },
    });
    assert.match(out, /₹1,00,000/);
    assert.match(out, /\+5\.00%/);
  });
  it("news counts articles + handles zero", () => {
    assert.match(
      deterministicToolSummary("get_stock_news", [{}, {}, {}]),
      /3 recent articles/
    );
    assert.match(
      deterministicToolSummary("get_stock_news", []),
      /No recent news/
    );
  });
  it("summarize_post narrates its generated answer verbatim (MONEY-887)", () => {
    assert.equal(
      deterministicToolSummary("summarize_post", {
        answer: "Here is the gist of the newsletter.",
      }),
      "Here is the gist of the newsletter."
    );
    // Degrades to a lead line when the model returned nothing.
    assert.match(
      deterministicToolSummary("summarize_post", {}),
      /summary of the article/i
    );
  });
});

describe("tool-narration: deterministicToolSummary (write confirmations)", () => {
  it("buy/sell paper interpolate the record", () => {
    assert.match(
      deterministicToolSummary("buy_paper_position", {
        symbol: "TCS",
        quantity: 10,
        averagePrice: 4000,
      }),
      /bought 10 TCS at ₹4,000/
    );
    assert.match(
      deterministicToolSummary("sell_paper_position", { pnl: 1500 }),
      /profit of ₹1,500/
    );
    assert.match(
      deterministicToolSummary("sell_paper_position", { pnl: -500 }),
      /loss of ₹500/
    );
  });
  it("create/generate confirmations", () => {
    assert.match(
      deterministicToolSummary("create_fire_scenario", { name: "Retire@45" }),
      /Retire@45/
    );
    assert.match(
      deterministicToolSummary("generate_report", { type: "tax" }),
      /tax report/
    );
  });
});

describe("tool-narration: deterministicToolSummary (fallbacks + safety)", () => {
  it("unknown single-object tool falls back neutrally", () => {
    assert.equal(
      deterministicToolSummary("get_financial_data", { pe: 28 }),
      "Here's what I found below."
    );
  });
  it("never contains block markers or tool jargon", () => {
    const out = deterministicToolSummary("run_screener", {
      data: [{}, {}, {}],
    });
    assert.ok(!out.includes(":::"));
    assert.ok(!out.includes("run_screener"));
  });
});
