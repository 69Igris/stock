/**
 * Tool → typed-block adapter tests (MONEY-587).
 *
 * Imports the REAL buildTypedBlockFromTool — typed-blocks.ts has only type
 * imports (no server / runtime deps), so it loads cleanly under tsx.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTypedBlockFromTool } from "@/lib/chat-tools/typed-blocks";

describe("buildTypedBlockFromTool (MONEY-587)", () => {
  it("returns null for an unmapped tool", () => {
    assert.equal(buildTypedBlockFromTool("get_unknown", []), null);
  });

  describe("get_holdings → holdings block", () => {
    it("maps Holding[] to typed rows", () => {
      const block = buildTypedBlockFromTool("get_holdings", [
        {
          symbol: "RELIANCE",
          sector: "Energy",
          quantity: 60,
          averagePrice: 2410,
          currentPrice: 2918.5,
          unrealizedPnL: 30510,
          pnlPercentage: 21.1,
        },
      ]);
      assert.equal(block?.type, "holdings");
      const b = block as { rows: Array<Record<string, unknown>> };
      assert.equal(b.rows.length, 1);
      assert.equal(b.rows[0]!.symbol, "RELIANCE");
      assert.equal(b.rows[0]!.qty, 60);
      assert.equal(b.rows[0]!.ltp, 2918.5);
      assert.equal(b.rows[0]!.pnl, 30510);
      assert.equal(b.rows[0]!.pnlPct, 21.1);
    });

    it("returns null for an empty holdings array", () => {
      assert.equal(buildTypedBlockFromTool("get_holdings", []), null);
    });
  });

  describe("get_portfolio_summary → portfolio block", () => {
    it("maps DashboardStats and derives the segment mix", () => {
      const block = buildTypedBlockFromTool("get_portfolio_summary", {
        portfolio: {
          totalValue: 1000000,
          totalPnL: 200000,
          pnlPercentage: "25.0",
          holdingsValue: 600000,
          mfValue: 300000,
          openPositionsValue: 100000,
        },
        trading: { todaysPnL: 5000, openTrades: 3 },
      });
      assert.equal(block?.type, "portfolio");
      const b = block as {
        totalValue: number;
        dayChange?: { amount: number; pct: number };
        totalPnL?: { pct: number };
        openPositions?: number;
        segments?: Array<{ label: string; pct: number }>;
      };
      assert.equal(b.totalValue, 1000000);
      assert.equal(b.dayChange?.amount, 5000);
      assert.equal(b.dayChange?.pct, 0.5); // 5000 / 1,000,000
      assert.equal(b.totalPnL?.pct, 25);
      assert.equal(b.openPositions, 3);
      assert.equal(b.segments?.length, 3);
      assert.equal(b.segments?.[0]!.label, "Equity");
      assert.equal(b.segments?.[0]!.pct, 60); // 600k / 1M
    });

    it("returns null when totalValue is missing", () => {
      assert.equal(
        buildTypedBlockFromTool("get_portfolio_summary", { portfolio: {} }),
        null
      );
    });
  });

  describe("get_stock_news → news block", () => {
    it("lowercases sentiment and derives the domain", () => {
      const block = buildTypedBlockFromTool("get_stock_news", [
        {
          title: "Infosys raises FY26 guidance",
          link: "https://www.livemint.com/x",
          source: "Mint",
          sentiment: "POSITIVE",
          pubDate: new Date().toISOString(),
        },
      ]);
      assert.equal(block?.type, "news");
      const b = block as { articles: Array<Record<string, unknown>> };
      assert.equal(b.articles[0]!.headline, "Infosys raises FY26 guidance");
      assert.equal(b.articles[0]!.sentiment, "positive");
      assert.equal(b.articles[0]!.domain, "livemint.com");
      assert.equal(b.articles[0]!.source, "Mint");
    });

    it("drops placeholder '#' links and unknown sentiment", () => {
      const block = buildTypedBlockFromTool("get_stock_news", [
        { title: "x", link: "#", sentiment: "MIXED" },
      ]);
      const b = block as { articles: Array<Record<string, unknown>> };
      assert.equal(b.articles[0]!.url, undefined);
      assert.equal(b.articles[0]!.domain, undefined);
      assert.equal(b.articles[0]!.sentiment, undefined);
    });
  });

  describe("portfolio_risk_analysis → risk block", () => {
    it("maps VaR / drawdown / concentration, scaling ALL fractions to percent", () => {
      // CONTRACT CHANGE (MONEY-1121). This fed var95: -2.3 / maxDrawdown:
      // -18.4 and asserted pass-through — i.e. it assumed those arrive as
      // percentages. They do not: `compute-var` derives them from
      // (curr - prev) / prev and computes the rupee figure as
      // |var95| * portfolioValue, which is only correct for a FRACTION;
      // `compute-drawdown` documents "a fraction of the prior peak". The old
      // case was internally inconsistent too — it passed concentration weights
      // as fractions (0.241 → 24.1) in the very same call.
      //
      // The card renders `{var1d}%`, so an unscaled fraction showed a -3% VaR
      // as "-0.03%" (MONEY-1095 item 10). Every field here is now a fraction
      // in and a percent out.
      const block = buildTypedBlockFromTool("portfolio_risk_analysis", {
        concentration: {
          hhi: 1480,
          topHoldings: [
            { symbol: "A", weight: 0.241, value: 1 },
            { symbol: "B", weight: 0.2, value: 1 },
            { symbol: "C", weight: 0.15, value: 1 },
            { symbol: "D", weight: 0.1, value: 1 },
            { symbol: "E", weight: 0.02, value: 1 },
          ],
        },
        var: { historical: { var95: -0.023 } },
        drawdown: { maxDrawdown: -0.184 },
      });
      assert.equal(block?.type, "risk");
      const b = block as {
        var1d?: number;
        maxDD?: number;
        concentration?: { top?: number; top5?: number; hhi?: number };
      };
      assert.equal(b.var1d, -2.3); // -0.023 * 100
      assert.equal(b.maxDD, -18.4); // -0.184 * 100
      assert.equal(b.concentration?.top, 24.1); // 0.241 * 100
      assert.equal(b.concentration?.top5, 71.1); // sum of 5 weights * 100
      assert.equal(b.concentration?.hhi, 1480); // an index, NOT a percentage
    });

    it("REGRESSION: the reported -0.03% VaR was really -3%", () => {
      // The exact figure from the bug report. A fraction of -0.03 is a 3%
      // one-day loss at 95% confidence; rendered unscaled it read "-0.03%",
      // which makes a portfolio look essentially risk-free.
      const block = buildTypedBlockFromTool("portfolio_risk_analysis", {
        concentration: {
          hhi: 5455,
          topHoldings: [{ symbol: "X", weight: 0.65 }],
        },
        var: { historical: { var95: -0.03 } },
      });
      assert.equal((block as { var1d?: number }).var1d, -3);
    });

    it("returns null when there is no concentration data", () => {
      assert.equal(
        buildTypedBlockFromTool("portfolio_risk_analysis", {}),
        null
      );
    });
  });

  describe("tax_report → empty financial year (MONEY-1121)", () => {
    // MONEY-1095 item 9 looked like a broken calculation: STCG ₹0, LTCG ₹0 and
    // four ₹0 advance-tax quarters, yet a live harvesting suggestion beside
    // them. Both halves were right — harvesting reads HOLDINGS, gains read
    // PAIRED TRADES — and the account simply had no realised trades that year.
    // Verified against the live data: the same query returns ₹16,111 STCG /
    // ₹3,222 tax for an account that does have trades.
    const emptyYear = {
      capitalGains: {
        fy: "2026-27",
        trades: [],
        totalTax: 0,
        equity: {
          stcg: { gains: 0, losses: 0, net: 0, tax: 0 },
          ltcg: {
            gains: 0,
            losses: 0,
            net: 0,
            exemption: 125000,
            taxable: 0,
            tax: 0,
          },
        },
      },
      harvesting: {
        opportunities: [
          {
            symbol: "ADANIPOWER",
            unrealizedLoss: -13,
            potentialTaxSaving: 3,
            type: "STCG",
          },
        ],
      },
      advanceTax: {
        installments: [
          { quarter: "Q1 (Jun 15)", amount: 0, paid: 0 },
          { quarter: "Q2 (Sep 15)", amount: 0, paid: 0 },
        ],
      },
    };

    it("flags the year as having no realised trades", () => {
      const b = buildTypedBlockFromTool("tax_report", emptyYear) as {
        noRealisedTrades?: boolean;
      };
      assert.equal(b.noRealisedTrades, true);
    });

    it("suppresses the ₹0 gains and advance-tax sections", () => {
      // A wall of zeros reads as broken software; the card says it in words.
      const b = buildTypedBlockFromTool("tax_report", emptyYear) as {
        stcg?: unknown;
        ltcg?: unknown;
        advance?: unknown;
      };
      assert.equal(b.stcg, undefined);
      assert.equal(b.ltcg, undefined);
      assert.equal(b.advance, undefined);
    });

    it("KEEPS harvesting — it is real and actionable", () => {
      // The one thing on that card that was never wrong.
      const b = buildTypedBlockFromTool("tax_report", emptyYear) as {
        harvest?: Array<{ symbol: string }>;
      };
      assert.equal(b.harvest?.length, 1);
      assert.equal(b.harvest?.[0]!.symbol, "ADANIPOWER");
    });

    it("does NOT flag a year that has real gains", () => {
      // The live numbers from the account that does trade.
      const b = buildTypedBlockFromTool("tax_report", {
        capitalGains: {
          fy: "2026-27",
          trades: new Array(1282).fill({}),
          totalTax: 3222,
          equity: {
            stcg: { gains: 1508833, losses: 1492722, net: 16111, tax: 3222 },
            ltcg: {
              gains: 39082,
              losses: 36891,
              net: 2191,
              exemption: 125000,
              taxable: 0,
              tax: 0,
            },
          },
        },
      }) as {
        noRealisedTrades?: boolean;
        stcg?: { gains: number; tax: number };
      };
      assert.equal(b.noRealisedTrades, undefined);
      assert.equal(b.stcg?.gains, 16111);
      assert.equal(b.stcg?.tax, 3222);
    });

    it("does NOT flag a zero year when the trade count is unknown", () => {
      // Absent `trades` means "we can't tell", which must not be reported to
      // the user as a confident "you sold nothing".
      const b = buildTypedBlockFromTool("tax_report", {
        capitalGains: {
          fy: "2026-27",
          totalTax: 0,
          equity: { stcg: { net: 0, tax: 0 }, ltcg: { net: 0, tax: 0 } },
        },
      }) as { noRealisedTrades?: boolean };
      assert.equal(b.noRealisedTrades, undefined);
    });
  });

  describe("get_fire_scenarios → fire block (task #40)", () => {
    it("projects the most-recent (first) scenario using real fields", () => {
      // Service returns scenarios ordered updatedAt desc, so list[0] is the
      // one to project — NOT a (non-existent) isDefault flag.
      const block = buildTypedBlockFromTool("get_fire_scenarios", [
        {
          id: "recent",
          name: "Aggressive FIRE",
          currentAge: 30,
          retirementAge: 45,
          currentCorpus: 4500000,
          monthlySavings: 60000,
          fireNumber: 30000000,
          yearsToFire: 12,
        },
        {
          id: "older",
          name: "Conservative",
          currentCorpus: 1,
          fireNumber: 1,
        },
      ]);
      assert.equal(block?.type, "fire");
      const b = block as unknown as {
        currentCorpus: number;
        targetCorpus: number;
        yearsToFI?: number;
        monthlySIP?: number;
      } & Record<string, unknown>;
      assert.equal(b.currentCorpus, 4500000);
      assert.equal(b.targetCorpus, 30000000);
      assert.equal(b.yearsToFI, 12);
      assert.equal(b.monthlySIP, 60000);
      // withdrawalRate is not a canonical FireScenario field — dropped.
      assert.equal(b.withdrawalRate, undefined);
    });

    it("derives yearsToFI from ages when yearsToFire is absent", () => {
      const block = buildTypedBlockFromTool("get_fire_scenarios", [
        {
          id: "x",
          currentAge: 28,
          retirementAge: 50,
          currentCorpus: 1000000,
          fireNumber: 25000000,
        },
      ]);
      const b = block as { yearsToFI?: number };
      assert.equal(b.yearsToFI, 22); // 50 - 28
    });

    it("returns null with no corpus target", () => {
      assert.equal(
        buildTypedBlockFromTool("get_fire_scenarios", [
          { id: "x", currentCorpus: 100 },
        ]),
        null
      );
      assert.equal(buildTypedBlockFromTool("get_fire_scenarios", []), null);
    });
  });

  describe("fire_plan → fire block (StockSage integration)", () => {
    it("builds the corpus gauge from the attached scenario-shaped plan", () => {
      const block = buildTypedBlockFromTool("fire_plan", {
        message: "Set your SIP to ₹90k.",
        scenarioName: "My FIRE Plan",
        mutated: true,
        plan: {
          currentCorpus: 1_800_000,
          fireNumber: 68_111_403,
          yearsToFire: 19,
          currentAge: 30,
          retirementAge: 50,
          monthlySavings: 90_000,
        },
      });
      assert.equal(block?.type, "fire");
      const b = block as unknown as {
        currentCorpus: number;
        targetCorpus: number;
        yearsToFI?: number;
        monthlySIP?: number;
      };
      assert.equal(b.currentCorpus, 1_800_000);
      assert.equal(b.targetCorpus, 68_111_403);
      assert.equal(b.yearsToFI, 19);
      assert.equal(b.monthlySIP, 90_000);
    });

    it("returns null (text-only reply) when no plan is attached", () => {
      assert.equal(
        buildTypedBlockFromTool("fire_plan", {
          message: "You can afford it.",
          mutated: false,
        }),
        null
      );
    });
  });

  describe("removed dead producers return null (task #40)", () => {
    // These tool names are NOT in the 33-tool registry — the dispatch cases
    // were removed. The blocks stay reachable via the LLM :::block whitelist,
    // but there is no tool producer, so the adapter must fall back to null.
    const deadTools = [
      "get_technical_indicators",
      "technical_analysis",
      "get_technical_analysis",
      "get_pnl_summary",
      "portfolio_pnl",
      "get_dividends",
      "dividend_calendar",
    ];
    for (const tool of deadTools) {
      it(`${tool} → null`, () => {
        assert.equal(
          buildTypedBlockFromTool(tool, { symbol: "TCS", rsi: 62 }),
          null
        );
      });
    }
  });
});
