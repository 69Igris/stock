/**
 * Chat Tool Registry Tests (lib/chat-tools/registry-metadata.ts)
 *
 * DE-SHADOWED (MONEY-620): previously this file re-declared every tool's
 * metadata, the Zod parameter schemas, and the getTool/getToolsForContext/
 * getToolDescriptions helpers inline and asserted the COPIES — with a fabricated
 * tool list (only 14 of the real 36), a "requiresConfirmation ⇔ write"
 * invariant the real registry does NOT hold (`run_strategy_scan` is write +
 * no-confirmation), and a `ScreenerParams` schema missing the real `query` and
 * `indexFilter` fields.
 *
 * The pure metadata + schemas + helpers now live in `registry-metadata.ts`
 * (extracted out of `registry.ts` so they import cleanly under node:test, away
 * from the `execute` → server-action → `lib/auth.ts` `react.cache` chain).
 * This test imports and asserts the REAL exports.
 *
 * The live `CHAT_TOOLS` (metadata + `execute` server-action calls) and the
 * `execute` behavior are exercised by the executor / chat-route suites that run
 * in the Next.js runtime; they cannot be imported here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TOOL_METADATA,
  getTool,
  getToolsForContext,
  getToolDescriptions,
  EmptyParams,
  HoldingsFilterParams,
  PositionsFilterParams,
  TradesFilterParams,
  CreateFireScenarioParams,
  PaperBuyParams,
  PaperSellParams,
  ResearchParams,
  FinancialDataParams,
  RunScreenerParams,
} from "@/lib/chat-tools/registry-metadata";

const ALL_TOOL_NAMES = Object.keys(TOOL_METADATA);

const WRITE_TOOL_NAMES = [
  "create_fire_scenario",
  "buy_paper_position",
  "sell_paper_position",
  "run_research",
  "start_roast",
  "generate_report",
  "run_comprehensive_analysis",
  "create_strategy",
  "run_strategy_scan",
  "fire_plan",
];

// Writes that intentionally do NOT require confirmation: run_strategy_scan and
// fire_plan (fire_plan edits are reversible, sandboxed to the user's own FIRE
// plan, and meant to be fluid — like the /fire sliders — so no confirm step).
const NO_CONFIRM_WRITE_NAMES = new Set(["run_strategy_scan", "fire_plan"]);

describe("Chat Tool Registry (metadata)", () => {
  // ───────────────────── Tool definitions ─────────────────────

  describe("TOOL_METADATA structure", () => {
    it("should have 37 tools", () => {
      assert.strictEqual(ALL_TOOL_NAMES.length, 37);
    });

    it("should key every entry by its own name", () => {
      for (const [name, meta] of Object.entries(TOOL_METADATA)) {
        assert.strictEqual(meta.name, name, `key/name mismatch for ${name}`);
      }
    });

    it("should include the core read tools", () => {
      const expected = [
        "get_portfolio_summary",
        "get_holdings",
        "get_positions",
        "get_trades",
        "get_mutual_funds",
        "get_fire_scenarios",
        "get_paper_positions",
        "get_research_status",
        "get_research_result",
        "get_financial_data",
      ];
      for (const name of expected) {
        assert.ok(ALL_TOOL_NAMES.includes(name), `Missing tool: ${name}`);
      }
    });

    it("should classify exactly 27 read and 10 write tools", () => {
      const reads = ALL_TOOL_NAMES.filter(
        (n) => TOOL_METADATA[n]!.category === "read"
      );
      const writes = ALL_TOOL_NAMES.filter(
        (n) => TOOL_METADATA[n]!.category === "write"
      );
      assert.strictEqual(reads.length, 27);
      assert.strictEqual(writes.length, 10);
    });

    it("should mark exactly the known write tools as 'write'", () => {
      const writes = ALL_TOOL_NAMES.filter(
        (n) => TOOL_METADATA[n]!.category === "write"
      ).sort();
      assert.deepStrictEqual(writes, [...WRITE_TOOL_NAMES].sort());
    });

    it("should require confirmation for every write tool EXCEPT the no-confirm writes", () => {
      // Real-registry invariant (the old shadow asserted a false
      // write⇔confirmation equivalence): run_strategy_scan and fire_plan are
      // writes that do NOT require confirmation; every other write does.
      for (const name of WRITE_TOOL_NAMES) {
        const expected = !NO_CONFIRM_WRITE_NAMES.has(name);
        assert.strictEqual(
          TOOL_METADATA[name]!.requiresConfirmation,
          expected,
          `${name} confirmation flag wrong`
        );
      }
    });

    it("should never require confirmation for a read tool", () => {
      for (const name of ALL_TOOL_NAMES) {
        if (TOOL_METADATA[name]!.category === "read") {
          assert.strictEqual(
            TOOL_METADATA[name]!.requiresConfirmation,
            false,
            `read tool ${name} should not require confirmation`
          );
        }
      }
    });

    it("should give every tool a non-empty description, a Zod schema, and contexts", () => {
      for (const [name, meta] of Object.entries(TOOL_METADATA)) {
        assert.ok(meta.description.length > 0, `${name} has empty description`);
        assert.strictEqual(
          typeof meta.parameters.safeParse,
          "function",
          `${name} parameters is not a Zod schema`
        );
        assert.ok(
          Array.isArray(meta.contexts) && meta.contexts.length > 0,
          `${name} has no contexts`
        );
        assert.ok(
          ["read", "write", "navigate"].includes(meta.category),
          `${name} has invalid category`
        );
      }
    });

    it("should include 'all' in every tool's contexts (always-available baseline)", () => {
      for (const [name, meta] of Object.entries(TOOL_METADATA)) {
        assert.ok(
          meta.contexts.includes("all"),
          `${name} missing 'all' context`
        );
      }
    });
  });

  // ───────────────────── Parameter Schemas ─────────────────────

  describe("Parameter schemas", () => {
    describe("EmptyParams", () => {
      it("should accept empty object", () => {
        assert.ok(EmptyParams.safeParse({}).success);
      });

      it("should strip unknown fields", () => {
        assert.ok(EmptyParams.safeParse({ foo: "bar" }).success);
      });
    });

    describe("HoldingsFilterParams", () => {
      it("should accept empty object (all optional)", () => {
        assert.ok(HoldingsFilterParams.safeParse({}).success);
      });

      it("should accept broker filter", () => {
        const result = HoldingsFilterParams.safeParse({ broker: "ZERODHA" });
        assert.ok(result.success);
        assert.strictEqual(result.data?.broker, "ZERODHA");
      });

      it("should accept sector filter", () => {
        assert.ok(HoldingsFilterParams.safeParse({ sector: "IT" }).success);
      });

      it("should accept symbol filter", () => {
        assert.ok(HoldingsFilterParams.safeParse({ symbol: "TCS" }).success);
      });

      it("should accept all filters combined", () => {
        const result = HoldingsFilterParams.safeParse({
          broker: "ZERODHA",
          sector: "IT",
          symbol: "TCS",
        });
        assert.ok(result.success);
      });

      it("should reject non-string broker", () => {
        assert.ok(!HoldingsFilterParams.safeParse({ broker: 123 }).success);
      });
    });

    describe("PositionsFilterParams", () => {
      it("should accept OPEN status", () => {
        assert.ok(PositionsFilterParams.safeParse({ status: "OPEN" }).success);
      });

      it("should accept CLOSED status", () => {
        assert.ok(
          PositionsFilterParams.safeParse({ status: "CLOSED" }).success
        );
      });

      it("should reject invalid status", () => {
        assert.ok(
          !PositionsFilterParams.safeParse({ status: "PENDING" }).success
        );
      });
    });

    describe("TradesFilterParams", () => {
      it("should accept BUY tradeType", () => {
        assert.ok(TradesFilterParams.safeParse({ tradeType: "BUY" }).success);
      });

      it("should accept SELL tradeType", () => {
        assert.ok(TradesFilterParams.safeParse({ tradeType: "SELL" }).success);
      });

      it("should reject invalid tradeType", () => {
        assert.ok(!TradesFilterParams.safeParse({ tradeType: "HOLD" }).success);
      });

      it("should accept skip >= 0", () => {
        assert.ok(TradesFilterParams.safeParse({ skip: 0 }).success);
      });

      it("should reject negative skip", () => {
        assert.ok(!TradesFilterParams.safeParse({ skip: -1 }).success);
      });

      it("should accept positive limit", () => {
        assert.ok(TradesFilterParams.safeParse({ limit: 10 }).success);
      });

      it("should reject limit of 0", () => {
        assert.ok(!TradesFilterParams.safeParse({ limit: 0 }).success);
      });

      it("should reject non-integer skip", () => {
        assert.ok(!TradesFilterParams.safeParse({ skip: 1.5 }).success);
      });
    });

    describe("CreateFireScenarioParams", () => {
      it("should accept valid scenario", () => {
        const result = CreateFireScenarioParams.safeParse({
          name: "My Plan",
          currentAge: 30,
          retirementAge: 55,
          currentCorpus: 1000000,
        });
        assert.ok(result.success);
      });

      it("should reject age below 18", () => {
        assert.ok(
          !CreateFireScenarioParams.safeParse({
            name: "Plan",
            currentAge: 17,
            retirementAge: 55,
            currentCorpus: 0,
          }).success
        );
      });

      it("should reject retirementAge below 25", () => {
        assert.ok(
          !CreateFireScenarioParams.safeParse({
            name: "Plan",
            currentAge: 20,
            retirementAge: 24,
            currentCorpus: 0,
          }).success
        );
      });

      it("should reject negative corpus", () => {
        assert.ok(
          !CreateFireScenarioParams.safeParse({
            name: "Plan",
            currentAge: 30,
            retirementAge: 55,
            currentCorpus: -100,
          }).success
        );
      });

      it("should accept optional monthlySavings", () => {
        const result = CreateFireScenarioParams.safeParse({
          name: "Plan",
          currentAge: 30,
          retirementAge: 55,
          currentCorpus: 0,
          monthlySavings: 50000,
        });
        assert.ok(result.success);
        assert.strictEqual(result.data?.monthlySavings, 50000);
      });

      it("should reject missing name", () => {
        assert.ok(
          !CreateFireScenarioParams.safeParse({
            currentAge: 30,
            retirementAge: 55,
            currentCorpus: 0,
          }).success
        );
      });
    });

    describe("PaperBuyParams", () => {
      it("should accept valid buy params", () => {
        assert.ok(
          PaperBuyParams.safeParse({
            symbol: "TCS",
            quantity: 10,
            price: 3500,
          }).success
        );
      });

      it("should reject zero quantity", () => {
        assert.ok(
          !PaperBuyParams.safeParse({
            symbol: "TCS",
            quantity: 0,
            price: 3500,
          }).success
        );
      });

      it("should reject zero price", () => {
        assert.ok(
          !PaperBuyParams.safeParse({ symbol: "TCS", quantity: 10, price: 0 })
            .success
        );
      });

      it("should reject negative price", () => {
        assert.ok(
          !PaperBuyParams.safeParse({
            symbol: "TCS",
            quantity: 10,
            price: -100,
          }).success
        );
      });

      it("should reject non-integer quantity", () => {
        assert.ok(
          !PaperBuyParams.safeParse({
            symbol: "TCS",
            quantity: 10.5,
            price: 3500,
          }).success
        );
      });

      it("should accept optional exchange and segment", () => {
        assert.ok(
          PaperBuyParams.safeParse({
            symbol: "TCS",
            quantity: 1,
            price: 3500,
            exchange: "BSE",
            segment: "F&O",
          }).success
        );
      });
    });

    describe("PaperSellParams", () => {
      it("should accept valid sell params", () => {
        assert.ok(
          PaperSellParams.safeParse({
            positionId: "pos-123",
            exitPrice: 3600,
          }).success
        );
      });

      it("should reject zero exit price", () => {
        assert.ok(
          !PaperSellParams.safeParse({
            positionId: "pos-123",
            exitPrice: 0,
          }).success
        );
      });

      it("should reject missing positionId", () => {
        assert.ok(!PaperSellParams.safeParse({ exitPrice: 3600 }).success);
      });
    });

    describe("ResearchParams", () => {
      it("should accept valid research params", () => {
        assert.ok(
          ResearchParams.safeParse({ query: "Analyze TCS stock" }).success
        );
      });

      it("should accept optional skill", () => {
        assert.ok(
          ResearchParams.safeParse({
            query: "Compare",
            skill: "peer-comparison",
          }).success
        );
      });

      it("should accept optional symbols array", () => {
        assert.ok(
          ResearchParams.safeParse({
            query: "Analyze",
            symbols: ["TCS", "INFY"],
          }).success
        );
      });

      it("should accept the real 'mode' enum (fast|advanced)", () => {
        assert.ok(ResearchParams.safeParse({ mode: "fast" }).success);
        assert.ok(ResearchParams.safeParse({ mode: "advanced" }).success);
        assert.ok(!ResearchParams.safeParse({ mode: "turbo" }).success);
      });

      it("should accept the real route-injected model/customSkills/researchFocus fields", () => {
        const result = ResearchParams.safeParse({
          query: "Analyze",
          model: "gemini-3-pro",
          customSkills: ["fundamentals"],
          researchFocus: "valuation",
        });
        assert.ok(result.success);
        assert.strictEqual(result.data?.model, "gemini-3-pro");
      });

      it("should accept empty object — query is OPTIONAL in the real schema", () => {
        // The real ResearchParams makes `query` optional (the executor infers
        // it from symbols/description). The old shadow wrongly made it
        // required.
        assert.ok(ResearchParams.safeParse({}).success);
      });

      it("should accept empty symbols array", () => {
        assert.ok(
          ResearchParams.safeParse({ query: "Broad analysis", symbols: [] })
            .success
        );
      });
    });

    describe("FinancialDataParams", () => {
      it("should accept symbol only", () => {
        assert.ok(FinancialDataParams.safeParse({ symbol: "TCS.NS" }).success);
      });

      it("should accept symbol with modules", () => {
        assert.ok(
          FinancialDataParams.safeParse({
            symbol: "TCS.NS",
            modules: ["defaultKeyStatistics", "price"],
          }).success
        );
      });

      it("should reject missing symbol", () => {
        assert.ok(
          !FinancialDataParams.safeParse({ modules: ["price"] }).success
        );
      });
    });

    // run_screener was the most-wrong shadow: its inline copy omitted the real
    // `query` and `indexFilter` fields. Assert the REAL schema.
    describe("RunScreenerParams (real schema)", () => {
      it("should accept the natural-language query field (was missing from the shadow)", () => {
        const result = RunScreenerParams.safeParse({
          query: "stocks with RSI < 30 in Nifty 50",
        });
        assert.ok(result.success);
        assert.strictEqual(
          result.data?.query,
          "stocks with RSI < 30 in Nifty 50"
        );
      });

      it("should accept the indexFilter field (was missing from the shadow)", () => {
        const result = RunScreenerParams.safeParse({ indexFilter: "NIFTY 50" });
        assert.ok(result.success);
        assert.strictEqual(result.data?.indexFilter, "NIFTY 50");
      });

      it("should accept strategy as optional string", () => {
        assert.ok(
          RunScreenerParams.safeParse({ strategy: "value_investing" }).success
        );
        assert.ok(RunScreenerParams.safeParse({}).success);
      });

      it("should validate filters array with valid operators", () => {
        const result = RunScreenerParams.safeParse({
          filters: [
            { field: "pe_ratio", operator: "lt", value: 20 },
            { field: "roe", operator: "gt", value: 15 },
          ],
        });
        assert.ok(result.success);
        assert.strictEqual(result.data?.filters?.length, 2);
      });

      it("should validate 'between' operator with a tuple value", () => {
        const result = RunScreenerParams.safeParse({
          filters: [
            { field: "pe_ratio", operator: "between", value: [10, 25] },
          ],
        });
        assert.ok(result.success);
        assert.deepStrictEqual(result.data?.filters?.[0]!.value, [10, 25]);
      });

      it("should accept exchange + limit", () => {
        const result = RunScreenerParams.safeParse({
          exchange: "NSE",
          limit: 50,
        });
        assert.ok(result.success);
        assert.strictEqual(result.data?.exchange, "NSE");
        assert.strictEqual(result.data?.limit, 50);
      });

      it("should reject an invalid operator in filters", () => {
        assert.ok(
          !RunScreenerParams.safeParse({
            filters: [{ field: "pe_ratio", operator: "gte", value: 20 }],
          }).success
        );
      });

      it("should reject a non-number scalar value in filters", () => {
        assert.ok(
          !RunScreenerParams.safeParse({
            filters: [{ field: "pe_ratio", operator: "lt", value: "twenty" }],
          }).success
        );
      });

      it("should accept all valid operators: gt, lt, eq, between", () => {
        for (const op of ["gt", "lt", "eq", "between"] as const) {
          const value = op === "between" ? [10, 20] : 15;
          const result = RunScreenerParams.safeParse({
            filters: [{ field: "test", operator: op, value }],
          });
          assert.ok(result.success, `Operator '${op}' should be valid`);
        }
      });
    });
  });

  // ───────────────────── getToolsForContext ─────────────────────

  describe("getToolsForContext", () => {
    it("should return all 37 tools for the 'all' context", () => {
      assert.strictEqual(getToolsForContext(TOOL_METADATA, "all").length, 37);
    });

    it("should include the paper-trading tools for 'paper_trading'", () => {
      const names = getToolsForContext(TOOL_METADATA, "paper_trading").map(
        (t) => t.name
      );
      assert.ok(names.includes("get_paper_positions"));
      assert.ok(names.includes("buy_paper_position"));
      assert.ok(names.includes("sell_paper_position"));
    });

    it("should return all 37 for any context because every tool has 'all'", () => {
      // Every tool carries the 'all' context, so context filtering can only
      // ADD specificity, never exclude — all 37 always match.
      assert.strictEqual(
        getToolsForContext(TOOL_METADATA, "paper_trading").length,
        37
      );
      assert.strictEqual(
        getToolsForContext(TOOL_METADATA, "unknown_context").length,
        37
      );
    });

    it("should include the stock-analysis tools for 'stock_analysis'", () => {
      const names = getToolsForContext(TOOL_METADATA, "stock_analysis").map(
        (t) => t.name
      );
      assert.ok(names.includes("get_portfolio_summary"));
      assert.ok(names.includes("get_holdings"));
      assert.ok(names.includes("run_research"));
      assert.ok(names.includes("get_financial_data"));
    });

    it("should include the MF tools for 'mf_analysis'", () => {
      const names = getToolsForContext(TOOL_METADATA, "mf_analysis").map(
        (t) => t.name
      );
      assert.ok(names.includes("get_portfolio_summary"));
      assert.ok(names.includes("get_mutual_funds"));
    });

    it("should include the FIRE tools for 'retirement'", () => {
      const names = getToolsForContext(TOOL_METADATA, "retirement").map(
        (t) => t.name
      );
      assert.ok(names.includes("get_fire_scenarios"));
      assert.ok(names.includes("create_fire_scenario"));
    });

    it("should include the research tools for 'research'", () => {
      const names = getToolsForContext(TOOL_METADATA, "research").map(
        (t) => t.name
      );
      assert.ok(names.includes("run_research"));
      assert.ok(names.includes("get_research_status"));
      assert.ok(names.includes("get_research_result"));
      assert.ok(names.includes("get_financial_data"));
    });
  });

  // ───────────────────── getTool ─────────────────────

  describe("getTool", () => {
    it("should return a tool by name", () => {
      const tool = getTool(TOOL_METADATA, "get_holdings");
      assert.ok(tool);
      assert.strictEqual(tool.name, "get_holdings");
    });

    it("should return undefined for a non-existent tool", () => {
      assert.strictEqual(getTool(TOOL_METADATA, "nonexistent_tool"), undefined);
    });

    it("should return undefined for an empty string", () => {
      assert.strictEqual(getTool(TOOL_METADATA, ""), undefined);
    });

    it("should be case-sensitive", () => {
      assert.strictEqual(getTool(TOOL_METADATA, "Get_Holdings"), undefined);
    });

    it("should not resolve inherited Object.prototype keys", () => {
      // Guard against prototype pollution / accidental hits on "toString" etc.
      assert.strictEqual(getTool(TOOL_METADATA, "toString"), undefined);
      assert.strictEqual(getTool(TOOL_METADATA, "constructor"), undefined);
    });
  });

  // ───────────────────── getToolDescriptions ─────────────────────

  describe("getToolDescriptions", () => {
    it("should return a non-empty string", () => {
      assert.ok(getToolDescriptions(TOOL_METADATA, "all").length > 0);
    });

    it("should start each line with '- '", () => {
      const lines = getToolDescriptions(TOOL_METADATA, "all").split("\n");
      for (const line of lines) {
        assert.ok(
          line.startsWith("- "),
          `Line doesn't start with '- ': ${line}`
        );
      }
    });

    it("should include every tool name", () => {
      const descriptions = getToolDescriptions(TOOL_METADATA, "all");
      for (const name of ALL_TOOL_NAMES) {
        assert.ok(descriptions.includes(name), `Missing tool name: ${name}`);
      }
    });

    it("should include [read] and [write] category tags", () => {
      const descriptions = getToolDescriptions(TOOL_METADATA, "all");
      assert.ok(descriptions.includes("[read]"));
      assert.ok(descriptions.includes("[write]"));
    });

    it("should include '(requires confirmation)' for confirming write tools", () => {
      assert.ok(
        getToolDescriptions(TOOL_METADATA, "all").includes(
          "(requires confirmation)"
        )
      );
    });

    it("should never tag a [read] line with '(requires confirmation)'", () => {
      const lines = getToolDescriptions(TOOL_METADATA, "all").split("\n");
      for (const line of lines) {
        if (line.includes("[read]")) {
          assert.ok(
            !line.includes("(requires confirmation)"),
            `Read tool should not have confirmation: ${line}`
          );
        }
      }
    });

    it("should emit one line per tool (37) for the 'all' context", () => {
      const lines = getToolDescriptions(TOOL_METADATA, "all").split("\n");
      assert.strictEqual(lines.length, 37);
    });

    it("should not tag run_strategy_scan (write, no-confirm) with '(requires confirmation)'", () => {
      const line = getToolDescriptions(TOOL_METADATA, "all")
        .split("\n")
        .find((l) => l.startsWith("- run_strategy_scan:"));
      assert.ok(line, "run_strategy_scan line missing");
      assert.ok(line!.includes("[write]"));
      assert.ok(!line!.includes("(requires confirmation)"));
    });
  });
});
