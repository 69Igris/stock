/**
 * Chat Tool Registry — pure metadata (no server-action / auth imports)
 *
 * The chat-tool registry couples two concerns:
 *   1. PURE metadata — name, description, category, confirmation flag, Zod
 *      parameter schema, render type, contexts. (no I/O)
 *   2. The `execute` functions — which call server actions and therefore drag
 *      in `@/lib/actions` → `lib/auth.ts` (`react.cache`), which throws at
 *      module load outside a React server request.
 *
 * Everything in THIS file is concern #1 only, so it can be imported under
 * `node:test`. `registry.ts` imports `TOOL_METADATA` from here and attaches the
 * `execute` functions to build the live `CHAT_TOOLS`. The three query helpers
 * (`getToolsForContext`, `getTool`, `getToolDescriptions`) are generic over any
 * map of tool-metadata so both the real registry and the tests share one
 * implementation (no shadows, no dead exports).
 */

import { z } from "zod";
import type { ContentBlockType } from "@usemoney/types";

// ============== Metadata Interface ==============

/**
 * The side-effect-free description of a chat tool — `ChatTool` minus the
 * `execute` function. `registry.ts` extends this with `execute` to form the
 * full `ChatTool`.
 */
export interface ChatToolMetadata {
  name: string;
  description: string;
  category: "read" | "write" | "navigate";
  requiresConfirmation: boolean;
  parameters: z.ZodSchema;
  renderType: ContentBlockType;
  contexts: string[];
}

// ============== Parameter Schemas ==============

export const EmptyParams = z.object({});

export const HoldingsFilterParams = z.object({
  broker: z.string().optional(),
  sector: z.string().optional(),
  symbol: z.string().optional(),
});

export const PositionsFilterParams = z.object({
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  broker: z.string().optional(),
  symbol: z.string().optional(),
});

export const TradesFilterParams = z.object({
  symbol: z.string().optional(),
  tradeType: z.enum(["BUY", "SELL"]).optional(),
  broker: z.string().optional(),
  skip: z.number().int().min(0).optional(),
  limit: z.number().int().positive().optional(),
});

export const CreateFireScenarioParams = z.object({
  name: z.string(),
  currentAge: z.number().int().min(18),
  retirementAge: z.number().int().min(25),
  currentCorpus: z.number().min(0),
  monthlySavings: z.number().min(0).optional(),
});

export const FirePlanParams = z.object({
  // The user's raw FIRE request — the FIRE turn does the NL understanding, so
  // the classifier just forwards the message here.
  request: z.string(),
  // "edit" (default) mutates the plan; "ask" answers read-only.
  intent: z.enum(["edit", "ask"]).optional(),
  // Optional explicit target plan ("update my Aggressive plan").
  scenarioName: z.string().optional(),
});

export const PaperBuyParams = z.object({
  symbol: z.string(),
  quantity: z.number().int().positive(),
  price: z.number().positive(),
  exchange: z.string().optional(),
  segment: z.string().optional(),
  assetType: z.string().optional(),
});

export const PaperSellParams = z.object({
  positionId: z.string(),
  exitPrice: z.number().positive(),
});

export const ResearchParams = z.object({
  query: z.string().optional(),
  skill: z.string().optional(),
  symbols: z.array(z.string()).optional(),
  mode: z.enum(["fast", "advanced"]).optional(),
  description: z.string().optional(),
  // MONEY-221/222 - populated by the chat route when the user has saved
  // a non-Auto research style. The classifier never sets these itself.
  customSkills: z.array(z.string()).optional(),
  researchFocus: z.string().optional(),
  // MONEY-587 (task #36) - the chat route injects the resolved
  // effectiveModelId here so it survives Zod validation (object schemas
  // strip unknown keys) and reaches the run_research executor, which
  // forwards it to startResearchAction → worker synthesizer/validator.
  model: z.string().optional(),
});

export const RoastParams = z.object({
  // "overall" → roast the consolidated portfolio across all brokers.
  // "broker"  → roast a single broker connection (broker prop required).
  mode: z.enum(["overall", "broker"]).default("overall"),
  broker: z.string().optional(),
  assetType: z.enum(["stocks", "mf", "all"]).default("all"),
});

export const RoastSessionParams = z.object({
  sessionId: z.string(),
});

export const ResearchStatusParams = z.object({
  sessionId: z.string(),
});

export const FinancialDataParams = z.object({
  symbol: z.string(),
  modules: z.array(z.string()).optional(),
});

export const ComprehensiveAnalysisParams = z.object({
  analysisType: z.enum([
    "comprehensive_stock",
    "multi_comparison",
    "portfolio_optimization",
  ]),
  symbols: z.array(z.string()).optional(),
  query: z.string(),
});

export const AnalysisStatusParams = z.object({
  sessionId: z.string(),
});

export const StockNewsParams = z.object({
  symbol: z.string(),
  limit: z.number().int().positive().optional(),
});

// MONEY-610: shareholding + corporate-actions quick reads share {symbol, exchange?}.
export const StockSymbolParams = z.object({
  symbol: z.string(),
  exchange: z.string().optional(),
});

export const WebSearchParams = z.object({
  query: z.string(),
});

export const SummarizePostParams = z.object({
  slug: z.string(),
  type: z.enum(["newsletter", "blog"]).optional(),
});

export const RunStrategyScanParams = z.object({
  strategyId: z.string(),
  isBuiltIn: z.boolean().optional(),
  limit: z.number().optional(),
});

export const ListStrategiesParams = z.object({
  category: z.string().optional(),
  search: z.string().optional(),
});

export const CreateStrategyParams = z.object({
  name: z.string(),
  description: z.string().optional(),
  filters: z.array(
    z.object({
      metric: z.string(),
      operator: z.string(),
      value: z.number(),
      source: z.string(),
    })
  ),
  scanType: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const GetScanHistoryParams = z.object({
  limit: z.number().optional(),
});

export const RunScreenerParams = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Natural language screening query (e.g. 'stocks with RSI < 30 in Nifty 50')"
    ),
  strategy: z
    .string()
    .optional()
    .describe(
      "Pre-built strategy name (e.g. 'value_investing', 'momentum', 'golden_cross')"
    ),
  filters: z
    .array(
      z.object({
        field: z.string(),
        operator: z.enum(["gt", "lt", "eq", "between"]),
        value: z.union([z.number(), z.tuple([z.number(), z.number()])]),
      })
    )
    .optional()
    .describe("Custom filters array"),
  exchange: z.string().optional().describe("Filter by exchange (NSE/BSE)"),
  indexFilter: z
    .string()
    .optional()
    .describe("Filter by index (e.g. 'NIFTY 50', 'SENSEX', 'NIFTY 100')"),
  limit: z.number().optional().describe("Max results (default 50)"),
  listStrategies: z
    .string()
    .optional()
    .describe("List available strategies, optionally by category"),
});

export const TaxReportParams = z.object({
  fy: z
    .string()
    .optional()
    .describe("Financial year e.g. '2025-26'. Defaults to current FY"),
});

export const GetUserDocumentsParams = z.object({
  category: z
    .string()
    .optional()
    .describe(
      "Filter by category: BROKER_STATEMENT, CONTRACT_NOTE, ANNUAL_REPORT, RESEARCH_REPORT, TAX_REPORT, RISK_REPORT, PORTFOLIO_STATEMENT, OTHER"
    ),
  search: z.string().optional().describe("Search by title or filename"),
});

export const GenerateReportParams = z.object({
  type: z
    .enum(["tax", "risk", "portfolio_statement"])
    .describe("Report type: tax, risk, or portfolio_statement"),
  fy: z
    .string()
    .optional()
    .describe("Financial year for tax report, e.g. '2025-26'"),
});

export const ScanIdParams = z.object({
  scanId: z.string(),
});

// ============== Tool Metadata Table ==============

/**
 * Pure metadata for every chat tool — the single source of truth for tool
 * names, descriptions, categories, confirmation flags, Zod schemas, render
 * types, and contexts. `registry.ts` merges each entry with its `execute`
 * function to produce the live `CHAT_TOOLS`.
 */
export const TOOL_METADATA: Record<string, ChatToolMetadata> = {
  get_stock_news: {
    name: "get_stock_news",
    description:
      "Get recent news articles for a stock. Returns headlines, sources, and links from Google News. Fast - no AI credits consumed.",
    category: "read",
    requiresConfirmation: false,
    parameters: StockNewsParams,
    renderType: "card",
    contexts: ["all", "stock_analysis"],
  },

  get_shareholding: {
    name: "get_shareholding",
    description:
      "Get the quarterly shareholding pattern (promoter / FII / DII / public %) for a stock. Fast - no AI credits consumed. Use for 'shareholding of X', 'promoter holding', 'FII/DII stake'.",
    category: "read",
    requiresConfirmation: false,
    parameters: StockSymbolParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  get_corporate_actions: {
    name: "get_corporate_actions",
    description:
      "Get recent corporate actions (dividends, splits, bonuses, rights) for a stock from NSE filings, with ex-date and record date. Fast - no AI credits consumed. Use for 'dividends of X', 'corporate actions', 'stock split', 'bonus issue'.",
    category: "read",
    requiresConfirmation: false,
    parameters: StockSymbolParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  web_search: {
    name: "web_search",
    description:
      "Search the live web (Google Search grounding) for the latest information, news, or what's happening with a company/topic, and answer with cited web sources. Use for 'search the web for X', 'latest on X', 'what's the news/happening with X', or any question that needs fresh, real-time web data. Read-only — no AI credits gated.",
    category: "read",
    requiresConfirmation: false,
    parameters: WebSearchParams,
    renderType: "news",
    contexts: ["all", "stock_analysis", "research"],
  },
  summarize_post: {
    name: "summarize_post",
    description:
      "Summarise a specific UseMoney newsletter or blog post (by its slug) and relate it to investing / portfolio management on UseMoney. Reads the post from the UseMoney database (not the web), so it works for new or unlisted posts. Used by the 'Discuss with UseMoney AI' link in emails. Read-only — no AI credits gated.",
    category: "read",
    requiresConfirmation: false,
    parameters: SummarizePostParams,
    renderType: "text",
    contexts: ["all"],
  },

  get_portfolio_summary: {
    name: "get_portfolio_summary",
    description:
      "Get the user's complete portfolio summary including total value, P&L, holdings value, MF value, and open positions. Use when user asks about their portfolio overview or dashboard stats.",
    category: "read",
    requiresConfirmation: false,
    parameters: EmptyParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "mf_analysis"],
  },

  get_holdings: {
    name: "get_holdings",
    description:
      "Get the user's stock holdings with details like symbol, quantity, average price, current price, and P&L. Can filter by broker, sector, or symbol.",
    category: "read",
    requiresConfirmation: false,
    parameters: HoldingsFilterParams,
    renderType: "table",
    contexts: ["all", "stock_analysis"],
  },

  get_positions: {
    name: "get_positions",
    description:
      "Get the user's open and closed trading positions with entry/exit prices and P&L. Can filter by status, broker, or symbol.",
    category: "read",
    requiresConfirmation: false,
    parameters: PositionsFilterParams,
    renderType: "table",
    contexts: ["all", "stock_analysis"],
  },

  get_trades: {
    name: "get_trades",
    description:
      "Get the user's trade history showing completed trades with symbol, type (BUY/SELL), quantity, price, and realized P&L.",
    category: "read",
    requiresConfirmation: false,
    parameters: TradesFilterParams,
    renderType: "table",
    contexts: ["all"],
  },

  get_mutual_funds: {
    name: "get_mutual_funds",
    description:
      "Get the user's mutual fund holdings with scheme name, units, NAV, invested amount, current value, and returns.",
    category: "read",
    requiresConfirmation: false,
    parameters: EmptyParams,
    renderType: "table",
    contexts: ["all", "mf_analysis"],
  },

  get_fire_scenarios: {
    name: "get_fire_scenarios",
    description:
      "Get the user's FIRE (Financial Independence, Retire Early) scenarios with retirement planning details.",
    category: "read",
    requiresConfirmation: false,
    parameters: EmptyParams,
    renderType: "card",
    contexts: ["all", "retirement"],
  },

  get_paper_positions: {
    name: "get_paper_positions",
    description:
      "Get the user's paper trading (simulated) positions with unrealized P&L.",
    category: "read",
    requiresConfirmation: false,
    parameters: EmptyParams,
    renderType: "table",
    contexts: ["all", "paper_trading"],
  },

  create_fire_scenario: {
    name: "create_fire_scenario",
    description:
      "Create a new FIRE retirement planning scenario with parameters like current age, retirement age, corpus, and savings.",
    category: "write",
    requiresConfirmation: true,
    parameters: CreateFireScenarioParams,
    renderType: "card",
    contexts: ["all", "retirement"],
  },

  fire_plan: {
    name: "fire_plan",
    description:
      "Edit the user's existing FIRE (Financial Independence, Retire Early) plan, or answer a FIRE/retirement question, in natural language — e.g. 'increase my SIP to 60k', 'retire at 45', 'set equity to 70%', 'is my plan on track?', 'can I afford a ₹20L car in 5 years?'. Works from any page against the user's saved FIRE scenario and edits it in place. Use this — NOT get_fire_scenarios (which only LISTS plans) or create_fire_scenario (only makes a blank plan) — whenever the user wants to CHANGE a FIRE parameter or asks whether their retirement plan works.",
    category: "write",
    requiresConfirmation: false,
    parameters: FirePlanParams,
    renderType: "text",
    contexts: ["all", "retirement"],
  },

  buy_paper_position: {
    name: "buy_paper_position",
    description:
      "Buy a paper trading (simulated) position. Does not use real money.",
    category: "write",
    requiresConfirmation: true,
    parameters: PaperBuyParams,
    renderType: "card",
    contexts: ["all", "paper_trading"],
  },

  sell_paper_position: {
    name: "sell_paper_position",
    description: "Sell/close a paper trading (simulated) position.",
    category: "write",
    requiresConfirmation: true,
    parameters: PaperSellParams,
    renderType: "card",
    contexts: ["all", "paper_trading"],
  },

  run_research: {
    name: "run_research",
    description:
      "Start a stock research analysis. Supports 'fast' mode (quick scorecard) and 'advanced' mode (comprehensive report). Runs asynchronously and returns a sessionId for polling.",
    category: "write",
    requiresConfirmation: true,
    parameters: ResearchParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  get_research_status: {
    name: "get_research_status",
    description:
      "Check the progress of an ongoing research session. Returns status, progress percentage, and current step.",
    category: "read",
    requiresConfirmation: false,
    parameters: ResearchStatusParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  get_research_result: {
    name: "get_research_result",
    description:
      "Get the completed research report with rich content blocks (tables, charts, cards).",
    category: "read",
    requiresConfirmation: false,
    parameters: ResearchStatusParams,
    renderType: "text",
    contexts: ["all", "stock_analysis", "research"],
  },

  start_roast: {
    name: "start_roast",
    description:
      "Start a portfolio roast - AI scoring + honest commentary on the user's holdings + mutual funds. Async; returns a sessionId for polling. Surfaces the credit cost and free-roast quota in the confirmation card.",
    category: "write",
    requiresConfirmation: true,
    parameters: RoastParams,
    renderType: "card",
    contexts: ["all", "portfolio"],
  },

  get_roast_status: {
    name: "get_roast_status",
    description:
      "Poll the progress of an ongoing roast session. Returns status, progress percentage, and current step.",
    category: "read",
    requiresConfirmation: false,
    parameters: RoastSessionParams,
    renderType: "card",
    contexts: ["all", "portfolio"],
  },

  get_roast_result: {
    name: "get_roast_result",
    description:
      "Fetch a completed roast - score, top issues, recommendations, full commentary. Use after get_roast_status reports COMPLETED.",
    category: "read",
    requiresConfirmation: false,
    parameters: RoastSessionParams,
    renderType: "text",
    contexts: ["all", "portfolio"],
  },

  get_financial_data: {
    name: "get_financial_data",
    description:
      "Quick synchronous lookup of financial data for a stock - key ratios, price, profile, quarterly results, earnings, balance sheet. No full research needed. Use this for 'show quarterly results', 'financials of X', 'key ratios', 'earnings', 'revenue'.",
    category: "read",
    requiresConfirmation: false,
    parameters: FinancialDataParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  portfolio_risk_analysis: {
    name: "portfolio_risk_analysis",
    description:
      "Analyze portfolio risk - concentration, correlation, VaR, drawdown, Sharpe ratio, rebalancing suggestions",
    category: "read",
    requiresConfirmation: false,
    parameters: EmptyParams,
    renderType: "card",
    contexts: ["all", "risk", "portfolio"],
  },

  tax_report: {
    name: "tax_report",
    description:
      "Generate Indian capital gains tax report - STCG (s111A), LTCG (s112A), tax harvesting, advance tax, ITR schedule",
    category: "read",
    requiresConfirmation: false,
    parameters: TaxReportParams,
    renderType: "card",
    contexts: ["all", "tax"],
  },

  get_user_documents: {
    name: "get_user_documents",
    description:
      "List user's uploaded documents, imported files, and generated reports",
    category: "read",
    requiresConfirmation: false,
    parameters: GetUserDocumentsParams,
    renderType: "table",
    contexts: ["all", "documents"],
  },

  generate_report: {
    name: "generate_report",
    description:
      "Generate a downloadable PDF report (tax, risk, or portfolio statement)",
    category: "write",
    requiresConfirmation: true,
    parameters: GenerateReportParams,
    renderType: "card",
    contexts: ["all", "documents"],
  },

  run_comprehensive_analysis: {
    name: "run_comprehensive_analysis",
    description:
      "Run a comprehensive multi-segment analysis (L3). Requires credit approval. Supports comprehensive_stock, multi_comparison, and portfolio_optimization.",
    category: "write",
    requiresConfirmation: true,
    parameters: ComprehensiveAnalysisParams,
    renderType: "card",
    contexts: ["all", "analysis", "stock_analysis", "research"],
  },

  get_analysis_status: {
    name: "get_analysis_status",
    description:
      "Check the progress of an ongoing comprehensive analysis (L3). Returns segment-level progress.",
    category: "read",
    requiresConfirmation: false,
    parameters: AnalysisStatusParams,
    renderType: "card",
    contexts: ["all", "analysis", "stock_analysis", "research"],
  },

  get_analysis_result: {
    name: "get_analysis_result",
    description:
      "Get the completed comprehensive analysis report with all segments.",
    category: "read",
    requiresConfirmation: false,
    parameters: AnalysisStatusParams,
    renderType: "text",
    contexts: ["all", "analysis", "stock_analysis", "research"],
  },

  run_screener: {
    name: "run_screener",
    description:
      "Screen stocks using fundamental filters (PE, ROE, D/E), technical indicators (RSI, MACD, SMA), or pre-built strategies. Supports combined fundamental + technical screening.",
    category: "read",
    requiresConfirmation: false,
    parameters: RunScreenerParams,
    renderType: "table",
    contexts: ["all", "stock_analysis", "analysis"],
  },

  run_strategy_scan: {
    name: "run_strategy_scan",
    description:
      "Run a saved or built-in strategy scan to find stocks matching specific criteria. Returns a scanId for polling - use get_scan_status to check progress and get_scan_result to get the matching stocks.",
    category: "write",
    requiresConfirmation: false,
    parameters: RunStrategyScanParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  get_scan_status: {
    name: "get_scan_status",
    description:
      "Check the progress of a running strategy scan. Returns status (PENDING, RUNNING, COMPLETED, FAILED) and stock count.",
    category: "read",
    requiresConfirmation: false,
    parameters: ScanIdParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  get_scan_result: {
    name: "get_scan_result",
    description:
      "Get the completed strategy scan results with matching stocks, metrics, and execution details.",
    category: "read",
    requiresConfirmation: false,
    parameters: ScanIdParams,
    renderType: "table",
    contexts: ["all", "stock_analysis", "research"],
  },

  list_strategies: {
    name: "list_strategies",
    description:
      "List available strategies including user's custom strategies and built-in strategies. Can filter by category or search by name.",
    category: "read",
    requiresConfirmation: false,
    parameters: ListStrategiesParams,
    renderType: "table",
    contexts: ["all", "stock_analysis", "research"],
  },

  create_strategy: {
    name: "create_strategy",
    description:
      "Create a new custom stock screening strategy from natural language. Define filters with metrics, operators, and values to find stocks matching specific criteria.",
    category: "write",
    requiresConfirmation: true,
    parameters: CreateStrategyParams,
    renderType: "card",
    contexts: ["all", "stock_analysis", "research"],
  },

  get_scan_history: {
    name: "get_scan_history",
    description:
      "Get recent scan results showing previously executed strategy scans with scan name, stock count, and execution time.",
    category: "read",
    requiresConfirmation: false,
    parameters: GetScanHistoryParams,
    renderType: "table",
    contexts: ["all", "stock_analysis", "research"],
  },
};

// ============== Generic Query Helpers ==============

/**
 * Get tools available for a given context. Generic over any map of
 * metadata-bearing tools so the real registry (`CHAT_TOOLS`, with `execute`)
 * and a pure metadata map share one implementation.
 */
export function getToolsForContext<T extends { contexts: string[] }>(
  tools: Record<string, T>,
  context: string
): T[] {
  return Object.values(tools).filter(
    (tool) => tool.contexts.includes(context) || tool.contexts.includes("all")
  );
}

/**
 * Get a tool by name from a metadata-bearing map.
 *
 * Uses an own-property check so an LLM-emitted tool name that collides with an
 * inherited `Object.prototype` key (e.g. "toString", "constructor") resolves to
 * `undefined` (an unknown tool) instead of leaking a prototype function that
 * downstream code would mis-treat as a `ChatTool`.
 */
export function getTool<T>(
  tools: Record<string, T>,
  name: string
): T | undefined {
  return Object.prototype.hasOwnProperty.call(tools, name)
    ? tools[name]
    : undefined;
}

/** Build the system-prompt tool list for a given context. */
export function getToolDescriptions<
  T extends {
    name: string;
    description: string;
    category: string;
    requiresConfirmation: boolean;
    contexts: string[];
  },
>(tools: Record<string, T>, context: string): string {
  const filtered = getToolsForContext(tools, context);
  return filtered
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description} [${tool.category}]${tool.requiresConfirmation ? " (requires confirmation)" : ""}`
    )
    .join("\n");
}
