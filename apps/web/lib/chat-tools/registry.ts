/**
 * Chat Tool Registry
 *
 * Maps chat tools to server actions for the AI assistant.
 * Each tool can be invoked by the LLM or via quick actions.
 *
 * The PURE metadata (names, descriptions, categories, confirmation flags, Zod
 * schemas, render types, contexts) and the generic query helpers live in
 * `./registry-metadata` so they can be imported under `node:test`. This module
 * imports that metadata and attaches the `execute` functions (which call server
 * actions and therefore pull in `lib/auth.ts` / `react.cache`). The exported
 * `getTool` / `getToolsForContext` / `getToolDescriptions` delegate to the
 * generic helpers in the metadata module so there is exactly one
 * implementation (no shadows, no dead exports).
 */

import type { ContentBlockType, ToolResult } from "@usemoney/types";
import {
  getDashboardStatsAction,
  getHoldingsAction,
  getPositionsAction,
  getTradesAction,
  getMutualFundsAction,
  getFireScenariosAction,
  getPaperPositionsAction,
  saveFireScenarioAction,
  createPaperPositionAction,
  closePaperPositionAction,
} from "@/lib/actions";
import { getPortfolioRiskAction } from "@/lib/actions/risk";
import { getTaxReportAction } from "@/lib/actions/tax";
import {
  getDocumentsAction,
  generateReportAction,
} from "@/lib/actions/documents";
import {
  startResearchAction,
  getResearchStatusAction,
  getResearchResultAction,
} from "@/lib/actions/research";
import {
  startRoastAction,
  getRoastStatusAction,
  canUseRoastAction,
} from "@/lib/actions/roast";
import { getRoastBySessionIdAction } from "@/lib/actions/roast-history";
import {
  startComprehensiveAnalysisAction,
  getAnalysisStatusAction,
  getAnalysisResultAction,
} from "@/lib/actions/analysis";
import {
  yahooFetchQuoteSummary,
  withExchangeFallback,
  normalizeTickerInput,
} from "@usemoney/core/market-data";
import { getStockNewsAction } from "@/lib/actions/news";
import {
  getShareholdingAction,
  getCorporateActionsAction,
} from "@/lib/actions/stock-tabs";
import {
  listStrategiesAction,
  runStrategyAction,
  createStrategyAction,
  getScanHistoryAction,
  getScanStatusAction,
  getScanResultAction,
} from "@/lib/actions/custom-strategy";
import {
  TOOL_METADATA,
  getTool as getToolFromMap,
  getToolsForContext as getToolsForContextFromMap,
  getToolDescriptions as getToolDescriptionsFromMap,
  type ChatToolMetadata,
} from "./registry-metadata";
import {
  inferResearchParams,
  buildResearchMessage,
} from "./registry-research-logic";

// ============== Tool Interface ==============

export interface ChatTool extends ChatToolMetadata {
  execute: (
    params: Record<string, unknown>,
    userId: string
  ) => Promise<ToolResult>;
}

// ============== Execute Functions ==============

/**
 * `execute` function for each tool, keyed by tool name. Merged with the pure
 * `TOOL_METADATA` below to form the live `CHAT_TOOLS`.
 */
const TOOL_EXECUTORS: Record<
  string,
  (params: Record<string, unknown>, userId: string) => Promise<ToolResult>
> = {
  get_stock_news: async (params) => {
    const { symbol, limit } = params as { symbol: string; limit?: number };
    const result = await getStockNewsAction(symbol, limit || 8);
    if (result.success && result.data) {
      return {
        tool: "get_stock_news",
        success: true,
        data: result.data.articles,
        renderType: "card",
      };
    }
    return {
      tool: "get_stock_news",
      success: false,
      error: result.error || "Failed to fetch news",
    };
  },

  get_shareholding: async (params) => {
    const { symbol, exchange } = params as {
      symbol: string;
      exchange?: string;
    };
    const result = await getShareholdingAction({
      symbol,
      exchange: exchange || "NSE",
    });
    if (result.success) {
      return {
        tool: "get_shareholding",
        success: true,
        data: result.data.shareholding,
        renderType: "card",
      };
    }
    return {
      tool: "get_shareholding",
      success: false,
      error: result.error || "Failed to fetch shareholding",
    };
  },

  get_corporate_actions: async (params) => {
    const { symbol, exchange } = params as {
      symbol: string;
      exchange?: string;
    };
    const result = await getCorporateActionsAction({
      symbol,
      exchange: exchange || "NSE",
    });
    if (result.success) {
      return {
        tool: "get_corporate_actions",
        success: true,
        data: result.data.actions,
        renderType: "card",
      };
    }
    return {
      tool: "get_corporate_actions",
      success: false,
      error: result.error || "Failed to fetch corporate actions",
    };
  },

  // Live web search via Gemini Google-Search grounding (MONEY-587, task #39).
  // Read-only, no confirmation. Returns a SEBI-scrubbed grounded answer plus
  // the cited WEB sources. The sources render in the CitationsRail WEB group
  // (they're shaped as NewsBlock articles so collectWeb picks them up) and the
  // answer carries [n] citation markers tied to those sources.
  web_search: async (params) => {
    const query = (params.query as string)?.trim();
    if (!query) {
      return {
        tool: "web_search",
        success: false,
        error: "No search query provided",
      };
    }
    const { groundedGenerate } = await import("@/lib/gemini/grounding");
    const prompt = `Answer the following using up-to-date information from the web. Be concise and factual. When you state a fact drawn from a source, cite it inline with a bracketed number like [1], [2] that matches the source order. Do not give buy/sell/hold advice or price targets.\n\nQuestion: ${query}`;
    const result = await groundedGenerate(prompt);

    // Shape sources as NewsBlock articles so the existing WEB SourceGroup
    // (CitationsRail.collectWeb) and the news typed-block renderer pick them
    // up with zero new plumbing. `i` is preserved as the citation index.
    const articles = result.sources.map((s) => ({
      headline: s.title,
      source: s.source,
      domain: s.domain,
      link: s.url,
      url: s.url,
      cite: s.i,
      snippet: s.snippet,
    }));

    return {
      tool: "web_search",
      success: true,
      data: {
        answer: result.text,
        articles,
        sources: result.sources,
        queries: result.queries,
        grounded: result.grounded,
      },
      renderType: "news",
    };
  },

  get_portfolio_summary: async () => {
    const result = await getDashboardStatsAction();
    if (result.success) {
      return {
        tool: "get_portfolio_summary",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "get_portfolio_summary",
      success: false,
      error: result.error || "Failed to fetch portfolio",
    };
  },

  get_holdings: async (params) => {
    const filters = params as {
      broker?: string;
      sector?: string;
      symbol?: string;
    };
    const result = await getHoldingsAction(filters);
    if (result.success && result.data) {
      return {
        tool: "get_holdings",
        success: true,
        data: result.data.holdings,
        renderType: "table",
      };
    }
    return {
      tool: "get_holdings",
      success: false,
      error: result.error || "Failed to fetch holdings",
    };
  },

  get_positions: async (params) => {
    const filters = params as {
      status?: string;
      broker?: string;
      symbol?: string;
    };
    const result = await getPositionsAction(filters);
    if (result.success && result.data) {
      return {
        tool: "get_positions",
        success: true,
        data: result.data.positions,
        renderType: "table",
      };
    }
    return {
      tool: "get_positions",
      success: false,
      error: result.error || "Failed to fetch positions",
    };
  },

  get_trades: async (params) => {
    const filters = {
      skip: 0,
      limit: (params.limit as number) || 20,
      symbol: params.symbol as string | undefined,
      broker: params.broker as string | undefined,
      tradeType: params.tradeType as string | undefined,
    };
    const result = await getTradesAction(filters);
    if (result.success && result.data) {
      return {
        tool: "get_trades",
        success: true,
        data: result.data.trades,
        renderType: "table",
      };
    }
    return {
      tool: "get_trades",
      success: false,
      error: result.error || "Failed to fetch trades",
    };
  },

  get_mutual_funds: async () => {
    const result = await getMutualFundsAction();
    if (result.success && result.data) {
      return {
        tool: "get_mutual_funds",
        success: true,
        data: result.data.funds,
        renderType: "table",
      };
    }
    return {
      tool: "get_mutual_funds",
      success: false,
      error: result.error || "Failed to fetch mutual funds",
    };
  },

  get_fire_scenarios: async () => {
    const result = await getFireScenariosAction();
    if (result.success) {
      return {
        tool: "get_fire_scenarios",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "get_fire_scenarios",
      success: false,
      error: result.error || "Failed to fetch FIRE scenarios",
    };
  },

  get_paper_positions: async () => {
    const result = await getPaperPositionsAction();
    if (result.success && result.data) {
      return {
        tool: "get_paper_positions",
        success: true,
        data: result.data.positions,
        renderType: "table",
      };
    }
    return {
      tool: "get_paper_positions",
      success: false,
      error: result.error || "Failed to fetch paper positions",
    };
  },

  create_fire_scenario: async (params) => {
    const scenarioData = {
      name: params.name as string,
      currentAge: params.currentAge as number,
      retirementAge: params.retirementAge as number,
      currentCorpus: params.currentCorpus as number,
      monthlySavings: (params.monthlySavings as number) || 0,
      lifeExpectancy: 80,
      withdrawalRate: 4,
      salaryIncrement: 5,
      savingsIncrement: 5,
      assetClasses: [],
      expenses: [],
      oneTimeExpenses: [],
    };
    const result = await saveFireScenarioAction(scenarioData);
    if (result.success) {
      return {
        tool: "create_fire_scenario",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "create_fire_scenario",
      success: false,
      error: result.error || "Failed to create scenario",
    };
  },

  buy_paper_position: async (params) => {
    const positionData = {
      symbol: params.symbol as string,
      quantity: params.quantity as number,
      averagePrice: params.price as number,
      exchange: (params.exchange as string) || "NSE",
      segment: (params.segment as string) || "EQUITY",
      assetType: ((params.assetType as string) || "STOCK") as
        | "STOCK"
        | "FNO_FUTURES"
        | "FNO_OPTIONS"
        | "MF",
    };
    const result = await createPaperPositionAction(positionData);
    if (result.success) {
      return {
        tool: "buy_paper_position",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "buy_paper_position",
      success: false,
      error: result.error || "Failed to buy paper position",
    };
  },

  sell_paper_position: async (params) => {
    const result = await closePaperPositionAction(
      params.positionId as string,
      params.exitPrice as number
    );
    if (result.success) {
      return {
        tool: "sell_paper_position",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "sell_paper_position",
      success: false,
      error: result.error || "Failed to sell paper position",
    };
  },

  run_research: async (params, userId) => {
    // De-shadowed (MONEY-620): the auto-detection lives in
    // registry-research-logic.ts so it can be unit-tested without the registry's
    // react.cache chain.
    const { query, skill, mode, symbols } = inferResearchParams(params);
    // MONEY-221/222 - when the chat route resolves the user's saved
    // research preferences, it forwards customSkills + researchFocus
    // through the intent params so the research worker can bias its
    // plan + synthesis. Both are optional and only applied when the
    // user picked a non-Auto style (route-level concern, not here).
    const customSkills = Array.isArray(params.customSkills)
      ? (params.customSkills as string[])
      : undefined;
    const researchFocus =
      typeof params.researchFocus === "string" && params.researchFocus
        ? (params.researchFocus as string)
        : undefined;
    // MONEY-587 (task #36) - the chat route resolves the user's
    // effectiveModelId and injects it into the run_research params; forward
    // it so the worker synthesizer/validator runs on the chosen (and
    // premium-billed) model rather than the hard-coded 2.5-pro.
    const model =
      typeof params.model === "string" && params.model
        ? (params.model as string)
        : undefined;
    // MONEY-801 (C1c) — forward the institutional run-params the chat route
    // resolved from saved prefs into the run_research confirmation params.
    // Previously stripped here, so the chat run-path never delivered them to the
    // worker (the ResearchModal path passes them directly). These are coarse
    // string/object coercions only — startResearchAction Zod-validates the
    // assumptions + varConfig against the server schemas and drops/clamps any
    // out-of-range value (MONEY-779) before forwarding to the worker; each
    // field is behaviour-neutral when unset.
    const horizon =
      typeof params.horizon === "string" && params.horizon
        ? (params.horizon as "1y" | "3y" | "5y")
        : undefined;
    const benchmark =
      typeof params.benchmark === "string" && params.benchmark
        ? (params.benchmark as string)
        : undefined;
    const reportLength =
      typeof params.reportLength === "string" && params.reportLength
        ? (params.reportLength as "brief" | "standard" | "full")
        : undefined;
    const varConfig =
      params.varConfig && typeof params.varConfig === "object"
        ? (params.varConfig as { confidence?: 95 | 99; horizonDays?: 1 | 10 })
        : undefined;
    const assumptions =
      params.assumptions && typeof params.assumptions === "object"
        ? (params.assumptions as {
            wacc?: number;
            terminalGrowth?: number;
            growthOverride?: number;
          })
        : undefined;
    // MONEY-1073 — a single-fund chat mention (classifier sets assetType "mf"
    // for an all-digit AMFI scheme-code @mention) routes through the same
    // single-fund path the /mf ResearchModal uses: startResearchAction forces
    // the `mf-analysis` skill + bills the mf_analysis estimate. Forwarded here
    // so the chat run-path reaches that path; unset for stocks/ETFs (unchanged).
    const assetType = params.assetType === "mf" ? ("mf" as const) : undefined;
    const extras = {
      customSkills,
      researchFocus,
      model,
      horizon,
      benchmark,
      reportLength,
      varConfig,
      assumptions,
      assetType,
    };
    const hasExtras = Object.values(extras).some((v) => v !== undefined);
    const result = await startResearchAction(
      userId,
      query,
      skill,
      symbols,
      mode,
      hasExtras ? extras : undefined
    );
    if (result.success) {
      return {
        tool: "run_research",
        success: true,
        data: {
          sessionId: result.sessionId,
          mode,
          message: buildResearchMessage(mode),
        },
        renderType: "card",
      };
    }
    return {
      tool: "run_research",
      success: false,
      error: result.error || "Failed to start research",
    };
  },

  get_research_status: async (params) => {
    const result = await getResearchStatusAction(params.sessionId as string);
    if (result.success) {
      return {
        tool: "get_research_status",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "get_research_status",
      success: false,
      error: result.error || "Failed to get status",
    };
  },

  get_research_result: async (params) => {
    const result = await getResearchResultAction(params.sessionId as string);
    if (result.success) {
      return {
        tool: "get_research_result",
        success: true,
        data: result.data,
        renderType: "text",
      };
    }
    return {
      tool: "get_research_result",
      success: false,
      error: result.error || "Failed to get result",
    };
  },

  // Portfolio Roast (chat-side flow - mirrors run_research lifecycle so the
  // chip / slash command can run a roast without leaving the conversation).
  start_roast: async (params) => {
    const mode = (params.mode as "overall" | "broker") || "overall";
    const broker = params.broker as string | undefined;
    const assetType = (params.assetType as "stocks" | "mf" | "all") || "all";

    // Pre-flight credit + access check so the confirmation block shows
    // accurate state. Failures here surface as inline errors instead
    // of after-the-fact toast messages.
    const credit = await canUseRoastAction();
    if (!credit.allowed) {
      return {
        tool: "start_roast",
        success: false,
        error:
          credit.message ||
          "You're out of free roasts this month. Upgrade your plan or wait until the monthly reset.",
      };
    }

    const result = await startRoastAction({ mode, broker, assetType });
    if (result.success) {
      return {
        tool: "start_roast",
        success: true,
        data: {
          sessionId: result.sessionId,
          mode,
          assetType,
          isFreeRoast: credit.isFreeRoast,
          warnings: result.warnings,
          message: credit.isFreeRoast
            ? "Free roast in progress - I'll surface the score and commentary here as soon as the analysis lands. Estimated time: ~2 minutes."
            : "Roast in progress (1 advanced credit) - score + commentary will appear here when the analysis completes.",
        },
        renderType: "card",
      };
    }
    return {
      tool: "start_roast",
      success: false,
      error: result.error || "Failed to start roast",
    };
  },

  get_roast_status: async (params) => {
    const result = await getRoastStatusAction(params.sessionId as string);
    if (result.success) {
      return {
        tool: "get_roast_status",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "get_roast_status",
      success: false,
      error: result.error || "Failed to get roast status",
    };
  },

  get_roast_result: async (params) => {
    const result = await getRoastBySessionIdAction(params.sessionId as string);
    if (result.success && result.data) {
      return {
        tool: "get_roast_result",
        success: true,
        data: result.data,
        renderType: "text",
      };
    }
    return {
      tool: "get_roast_result",
      success: false,
      error: result.error || "Roast result not available",
    };
  },

  get_financial_data: async (params) => {
    // MONEY-1121 - strip the chat @-mention token. `/quote @HDFCBANK` used to
    // reach Yahoo verbatim and come back "No data found for @HDFCBANK", the
    // error echoing the character that broke it. Normalised here rather than
    // in the slash-command layer so a direct model call is covered too.
    const symbol = normalizeTickerInput(String(params.symbol ?? ""));
    const modules = (params.modules as string[]) || [
      "defaultKeyStatistics",
      "financialData",
      "price",
      "earnings",
      "incomeStatementHistory",
      "balanceSheetHistory",
    ];

    try {
      // Wrapped so a bare Indian ticker resolves: the unsuffixed form is
      // tried first (US tickers), then .NS, then .BO.
      const data = await withExchangeFallback(symbol, (sym) =>
        yahooFetchQuoteSummary(sym, modules)
      );
      if (data) {
        return {
          tool: "get_financial_data",
          success: true,
          data,
          renderType: "card",
        };
      }
      return {
        tool: "get_financial_data",
        success: false,
        error: `No data found for ${symbol}`,
      };
    } catch (error) {
      return {
        tool: "get_financial_data",
        success: false,
        error: `Failed to fetch data: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },

  portfolio_risk_analysis: async () => {
    const result = await getPortfolioRiskAction();
    if (result.success) {
      return {
        tool: "portfolio_risk_analysis",
        success: true,
        data: result.data,
        renderType: "card" as ContentBlockType,
      };
    }
    return {
      tool: "portfolio_risk_analysis",
      success: false,
      error: result.error || "Failed to analyze portfolio risk",
    };
  },

  tax_report: async (params) => {
    const fy = params.fy as string | undefined;
    const result = await getTaxReportAction(fy);
    if (result.success) {
      return {
        tool: "tax_report",
        success: true,
        data: result.data,
        renderType: "card" as ContentBlockType,
      };
    }
    return {
      tool: "tax_report",
      success: false,
      error: result.error || "Failed to generate tax report",
    };
  },

  get_user_documents: async (params) => {
    const result = await getDocumentsAction({
      category: params.category as string | undefined,
      search: params.search as string | undefined,
      limit: 20,
    });
    if (result.success && result.data) {
      return {
        tool: "get_user_documents",
        success: true,
        data: result.data,
        renderType: "table" as ContentBlockType,
      };
    }
    return {
      tool: "get_user_documents",
      success: false,
      error: result.error || "Failed to fetch documents",
    };
  },

  generate_report: async (params) => {
    const result = await generateReportAction(params.type as string, {
      fy: params.fy as string | undefined,
    });
    if (result.success && result.data) {
      return {
        tool: "generate_report",
        success: true,
        data: {
          documentId: result.data.documentId,
          message: `${params.type} report generation started. You'll be notified when it's ready.`,
        },
        renderType: "card" as ContentBlockType,
      };
    }
    return {
      tool: "generate_report",
      success: false,
      error: result.error || "Failed to generate report",
    };
  },

  run_comprehensive_analysis: async (params) => {
    const result = await startComprehensiveAnalysisAction({
      analysisType: params.analysisType as string,
      symbols: params.symbols as string[] | undefined,
      query: params.query as string,
    });
    if (result.success && result.data) {
      return {
        tool: "run_comprehensive_analysis",
        success: true,
        data: {
          sessionId: result.data.sessionId,
          creditsReserved: result.data.creditsReserved,
          estimatedMinutes: result.data.estimatedMinutes,
          totalSegments: result.data.totalSegments,
          message: `Comprehensive analysis started! Using ${result.data.creditsReserved} credits. Estimated time: ~${result.data.estimatedMinutes} minutes.`,
        },
        renderType: "card" as ContentBlockType,
      };
    }
    return {
      tool: "run_comprehensive_analysis",
      success: false,
      error: result.error || "Failed to start comprehensive analysis",
    };
  },

  get_analysis_status: async (params) => {
    const result = await getAnalysisStatusAction(params.sessionId as string);
    if (result.success && result.data) {
      return {
        tool: "get_analysis_status",
        success: true,
        data: result.data,
        renderType: "card" as ContentBlockType,
      };
    }
    return {
      tool: "get_analysis_status",
      success: false,
      error: result.error || "Failed to get analysis status",
    };
  },

  get_analysis_result: async (params) => {
    const result = await getAnalysisResultAction(params.sessionId as string);
    if (result.success && result.data) {
      return {
        tool: "get_analysis_result",
        success: true,
        data: result.data,
        renderType: "text" as ContentBlockType,
      };
    }
    return {
      tool: "get_analysis_result",
      success: false,
      error: result.error || "Failed to get analysis result",
    };
  },

  run_screener: async (params, _userId) => {
    const { executeRunScreener } =
      await import("@usemoney/research/tools/run-screener");
    const result = await executeRunScreener(
      params as Parameters<typeof executeRunScreener>[0]
    );
    if (!result.success) {
      return {
        tool: "run_screener",
        success: false,
        error: result.error || "Screener failed",
      };
    }
    return {
      tool: "run_screener",
      success: true,
      data: result.data,
    };
  },

  run_strategy_scan: async (params) => {
    const { strategyId, isBuiltIn, limit } = params as {
      strategyId: string;
      isBuiltIn?: boolean;
      limit?: number;
    };
    const result = await runStrategyAction(strategyId, { isBuiltIn, limit });
    if (result.success && result.data) {
      return {
        tool: "run_strategy_scan",
        success: true,
        data: {
          scanId: result.data.scanId,
          status: result.data.status,
          message: "Strategy scan started! Checking results...",
        },
        renderType: "card",
      };
    }
    return {
      tool: "run_strategy_scan",
      success: false,
      error: result.error || "Failed to run strategy scan",
    };
  },

  get_scan_status: async (params) => {
    const { scanId } = params as { scanId: string };
    const result = await getScanStatusAction(scanId);
    if (result.success && result.data) {
      return {
        tool: "get_scan_status",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "get_scan_status",
      success: false,
      error: result.error || "Failed to get scan status",
    };
  },

  get_scan_result: async (params) => {
    const { scanId } = params as { scanId: string };
    const result = await getScanResultAction(scanId);
    if (result.success && result.data) {
      return {
        tool: "get_scan_result",
        success: true,
        data: result.data,
        renderType: "table",
      };
    }
    return {
      tool: "get_scan_result",
      success: false,
      error: result.error || "Failed to get scan result",
    };
  },

  list_strategies: async (params) => {
    const { category, search } = params as {
      category?: string;
      search?: string;
    };
    const result = await listStrategiesAction({ category, search });
    if (result.success && result.data) {
      return {
        tool: "list_strategies",
        success: true,
        data: result.data,
        renderType: "table",
      };
    }
    return {
      tool: "list_strategies",
      success: false,
      error: result.error || "Failed to list strategies",
    };
  },

  create_strategy: async (params) => {
    const { name, description, filters, scanType, category, tags } = params as {
      name: string;
      description?: string;
      filters: Array<{
        metric: string;
        operator: string;
        value: number;
        source: string;
      }>;
      scanType?: string;
      category?: string;
      tags?: string[];
    };
    const result = await createStrategyAction({
      name,
      description,
      filters,
      scanType: scanType || "fundamental",
      category,
      tags,
    });
    if (result.success && result.data) {
      return {
        tool: "create_strategy",
        success: true,
        data: result.data,
        renderType: "card",
      };
    }
    return {
      tool: "create_strategy",
      success: false,
      error: result.error || "Failed to create strategy",
    };
  },

  get_scan_history: async (params) => {
    const { limit } = params as { limit?: number };
    const result = await getScanHistoryAction({ limit });
    if (result.success && result.data) {
      return {
        tool: "get_scan_history",
        success: true,
        data: result.data,
        renderType: "table",
      };
    }
    return {
      tool: "get_scan_history",
      success: false,
      error: result.error || "Failed to get scan history",
    };
  },

  // MONEY-887: summarise a specific UseMoney post by slug (DB-backed) and relate
  // it to investing on UseMoney. Dispatched deterministically from the email
  // "Discuss with UseMoney AI" CTA so it can't collapse to get_portfolio_summary.
  summarize_post: async (params) => {
    const slug = (params.slug as string)?.trim();
    if (!slug) {
      return {
        tool: "summarize_post",
        success: false,
        error: "No article was specified to summarise.",
      };
    }
    const { summarizePost } = await import("./summarize-post");
    return summarizePost(
      slug,
      (params.type as "newsletter" | "blog") || "newsletter"
    );
  },

  // StockSage ↔ FIRE: edit a saved FIRE plan or answer a FIRE question from ANY
  // page (server-side two-tier turn against a saved scenario). Dynamic import
  // keeps the FIRE chat internals off the registry's static graph.
  fire_plan: async (params, userId) => {
    const { runFirePlan } = await import("./fire-plan");
    return runFirePlan(
      params as {
        request: string;
        intent?: "edit" | "ask";
        scenarioName?: string;
      },
      userId
    );
  },
};

// ============== Tool Definitions ==============

/**
 * The live registry: each pure metadata entry merged with its `execute`
 * function. Built from the single source of truth (`TOOL_METADATA`) so the
 * tests can assert the same metadata the production code uses.
 */
export const CHAT_TOOLS: Record<string, ChatTool> = Object.fromEntries(
  Object.entries(TOOL_METADATA).map(([name, meta]) => {
    const execute = TOOL_EXECUTORS[name];
    if (!execute) {
      throw new Error(`Chat tool "${name}" has metadata but no execute fn`);
    }
    return [name, { ...meta, execute }];
  })
);

/**
 * Get tools available for a given context
 */
export function getToolsForContext(context: string): ChatTool[] {
  return getToolsForContextFromMap(CHAT_TOOLS, context);
}

/**
 * Get a tool by name
 */
export function getTool(name: string): ChatTool | undefined {
  return getToolFromMap(CHAT_TOOLS, name);
}

/**
 * Get tool descriptions for system prompt
 */
export function getToolDescriptions(context: string): string {
  return getToolDescriptionsFromMap(CHAT_TOOLS, context);
}
