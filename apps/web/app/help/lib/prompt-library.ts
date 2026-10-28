export type PromptCategory =
  | "stock-analysis"
  | "screening"
  | "comparison"
  | "portfolio-intel"
  | "market-discovery"
  | "holdings-trades"
  | "mutual-funds"
  | "fire"
  // "paper-trading" prompt category entries were removed 2026-05-28 per
  // product decision; the type member is retained because the help/tabs
  // filter components still narrow on it (`c.id !== "paper-trading"`).
  | "paper-trading";

export type AnalysisTier = "L1" | "L2" | "L3";

export interface PromptItem {
  id: string;
  label: string;
  description: string;
  /**
   * Free-text fallback. Used when neither `tool` nor `navigateTo` is set -
   * the prompt is fired into chat and the classifier picks the route.
   *
   * MONEY-228: many entries used to rely on this and silently collapsed
   * to `get_dashboard_stats` because the classifier rounds any prompt
   * containing "portfolio" / "rebalance" / "sector" to the cheap
   * portfolio_query route. New entries should prefer `tool` (preferred)
   * or `navigateTo` (when no chat tool covers the feature).
   */
  prompt: string;
  /**
   * Deterministic tool dispatch. When set, the help center sends the
   * user to the dashboard with a URL param that fires the tool directly
   * via executeToolDirect - bypassing the classifier entirely.
   */
  tool?: string;
  params?: Record<string, unknown>;
  /**
   * Navigation entry. Sends the user to a dedicated page where the
   * canonical UI for the feature lives (e.g. /risk, /tax, /roast).
   */
  navigateTo?: string;
  icon: string;
  category: PromptCategory;
  tier?: AnalysisTier;
  credits?: number;
  estimatedTime?: "instant" | "~30s" | "~2min" | "~5min";
}

export interface CategoryConfig {
  id: PromptCategory;
  label: string;
  description: string;
  icon: string;
  color: string;
}

export const categories: CategoryConfig[] = [
  {
    id: "stock-analysis",
    label: "Stock Analysis",
    description: "Quick research, deep dives, and comprehensive analysis",
    icon: "TrendingUp",
    color: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  {
    id: "screening",
    label: "Stock Screening",
    description: "Screen stocks by fundamental and technical criteria",
    icon: "Filter",
    color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  },
  {
    id: "comparison",
    label: "Comparison",
    description: "Compare stocks, funds, and sectors head to head",
    icon: "GitCompare",
    color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
  {
    id: "portfolio-intel",
    label: "Portfolio Intelligence",
    description: "AI-powered portfolio analysis, roast, and risk",
    icon: "Brain",
    color: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  },
  {
    id: "market-discovery",
    label: "Market Discovery",
    description: "Discover trending stocks, sectors, and themes",
    icon: "Compass",
    color: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  {
    id: "holdings-trades",
    label: "Holdings & Trades",
    description: "View, filter, and analyse your holdings and trades",
    icon: "Briefcase",
    color: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
  },
  {
    id: "mutual-funds",
    label: "Mutual Funds",
    description: "Track, compare, and analyse mutual fund investments",
    icon: "Landmark",
    color: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  },
  {
    id: "fire",
    label: "FIRE Planning",
    description: "Plan your path to financial independence",
    icon: "Flame",
    color: "bg-red-500/10 text-red-400 border-red-500/20",
  },
  // Paper Trading category removed 2026-05-28 per product decision.
];

export const prompts: PromptItem[] = [
  // ─── Stock Analysis (12) ───
  // MONEY-228 phase 2 - entries with a clear single-skill research target
  // dispatch run_research directly (mirrors the MONEY-223 slash shortcuts:
  // /quick, /deep, /dcf, /earnings, /thesis, /technical). The `prompt`
  // string is preserved as the query so the planner can still extract
  // any user-edited symbol.
  {
    id: "quick-analysis",
    label: "Analyse a Stock",
    description: "Quick research with score and recommendation",
    prompt: "Analyse RELIANCE - give me a quick research with score",
    tool: "run_research",
    params: { mode: "fast" },
    icon: "TrendingUp",
    category: "stock-analysis",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "deep-dive",
    label: "Deep Dive Analysis",
    description: "Detailed analysis with DCF, cash flow, and earnings",
    prompt: "Deep dive into TCS - detailed analysis with valuation",
    tool: "run_research",
    params: { mode: "advanced" },
    icon: "Search",
    category: "stock-analysis",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "comprehensive-analysis",
    label: "Comprehensive Analysis",
    description: "Full research report with scenario analysis",
    prompt:
      "Comprehensive analysis of HDFC Bank - full research report with scenarios",
    tool: "run_research",
    params: { mode: "advanced" },
    icon: "FileText",
    category: "stock-analysis",
    tier: "L3",
    credits: 10,
    estimatedTime: "~5min",
  },
  {
    id: "dcf-valuation",
    label: "DCF Valuation",
    description: "Intrinsic value calculation using DCF model",
    prompt: "Calculate the intrinsic value of HDFC Bank using DCF valuation",
    tool: "run_research",
    params: {
      mode: "advanced",
      skill: "dcf-valuation",
      customSkills: ["dcf-valuation"],
    },
    icon: "Calculator",
    category: "stock-analysis",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "earnings-analysis",
    label: "Earnings Analysis",
    description: "Recent quarterly earnings and financial data",
    prompt:
      "Show recent earnings and quarterly results for Infosys with analysis",
    tool: "run_research",
    params: {
      mode: "advanced",
      skill: "earnings-analysis",
      customSkills: ["earnings-analysis"],
    },
    icon: "BarChart3",
    category: "stock-analysis",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "investment-thesis",
    label: "Investment Thesis",
    description: "Bull and bear case with conviction level",
    prompt:
      "Build an investment thesis for RELIANCE - bull case, bear case, and conviction",
    tool: "run_research",
    params: {
      mode: "advanced",
      skill: "investment-thesis",
      customSkills: ["investment-thesis"],
    },
    icon: "Lightbulb",
    category: "stock-analysis",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "financial-ratios",
    label: "Financial Ratios",
    description: "Key ratios like PE, ROE, ROCE, D/E",
    prompt:
      "Show me PE, PB, ROE, ROCE, and debt-to-equity ratio for Tata Motors",
    // get_financial_data is the synchronous lookup tool - no research run
    // needed for plain ratio fetches. The user can edit the symbol in
    // the prompt before firing.
    tool: "get_financial_data",
    params: { symbol: "TATAMOTORS" },
    icon: "BarChart3",
    category: "stock-analysis",
    tier: "L1",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "sector-analysis",
    label: "Sector Analysis",
    description: "Analyse an entire sector with top companies",
    prompt: "Analyse the IT sector - top companies, valuation, and outlook",
    tool: "run_research",
    params: { mode: "advanced", skill: "sector-deep-dive" },
    icon: "Layers",
    category: "stock-analysis",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "should-i-buy",
    label: "Should I Buy?",
    description: "Buy recommendation at current price",
    prompt: "Should I buy Bajaj Finance at the current price?",
    tool: "run_research",
    params: { mode: "fast" },
    icon: "HelpCircle",
    category: "stock-analysis",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "concall-insights",
    label: "Concall Insights",
    description: "Key takeaways from latest conference call",
    prompt:
      "What did RELIANCE management say in their latest concall? Key takeaways",
    tool: "run_research",
    params: { mode: "advanced", skill: "earnings-analysis" },
    icon: "MessageSquare",
    category: "stock-analysis",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "technical-analysis",
    label: "Technical Analysis",
    description: "RSI, MACD, moving averages, and trend analysis",
    prompt:
      "Technical analysis of RELIANCE - RSI, MACD, moving averages, support/resistance",
    tool: "run_research",
    params: {
      mode: "advanced",
      skill: "stock-analysis",
      customSkills: ["stock-analysis"],
    },
    icon: "LineChart",
    category: "stock-analysis",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "research-stock",
    label: "Research Any Stock",
    description: "Type any stock symbol for instant research",
    prompt: "Research and analyze ITC stock with buy/sell recommendation",
    tool: "run_research",
    params: { mode: "fast" },
    icon: "Search",
    category: "stock-analysis",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },

  // ─── Stock Screening (8) ───
  // MONEY-228 phase 3 - every entry dispatches run_screener with the
  // natural-language prompt as input. The screener tool already parses
  // these phrases into filter chips; bypassing the cheap-tool classifier
  // means a "screen for X" prompt lands on the screener every time
  // instead of accidentally rounding to portfolio_query.
  {
    id: "value-screen",
    label: "Value Stocks Screen",
    description: "Undervalued stocks with strong fundamentals",
    prompt:
      "Screen stocks with PE below 15, ROE above 15%, and market cap above 10000 crore",
    tool: "run_screener",
    icon: "Filter",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "momentum-screen",
    label: "Momentum Strategy",
    description: "Stocks with strong price momentum",
    prompt: "Run momentum strategy - stocks breaking 52-week highs with volume",
    tool: "run_screener",
    icon: "TrendingUp",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "dividend-screen",
    label: "High Dividend Yield",
    description: "Stocks with dividend yield above 3%",
    prompt: "Screen for stocks with dividend yield above 3% in Nifty 500",
    tool: "run_screener",
    icon: "Banknote",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "oversold-screen",
    label: "Oversold Stocks",
    description: "Technically oversold with RSI below 30",
    prompt: "Find stocks with RSI below 30 and PE under 15 - oversold value",
    tool: "run_screener",
    icon: "ArrowDownRight",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "growth-screen",
    label: "Growth Stocks",
    description: "High revenue and earnings growth",
    prompt:
      "Screen for growth stocks with revenue growth above 20% and ROE above 18%",
    tool: "run_screener",
    icon: "Rocket",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "low-debt-screen",
    label: "Low Debt Companies",
    description: "Strong balance sheets with minimal debt",
    prompt: "Find companies with debt-to-equity below 0.5 and strong cash flow",
    tool: "run_screener",
    icon: "Shield",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "combined-screen",
    label: "Combined Strategy",
    description: "Fundamental + technical combined screen",
    prompt:
      "Find undervalued large caps with high ROE, low debt, and RSI below 40",
    tool: "run_screener",
    icon: "Layers",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "custom-screen",
    label: "Custom Screen",
    description: "Build your own screening criteria",
    prompt:
      "Screen stocks with: market cap > 5000 crore, PE < 25, ROE > 12%, promoter holding > 50%",
    tool: "run_screener",
    icon: "SlidersHorizontal",
    category: "screening",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },

  // ─── Comparison (6) ───
  // MONEY-228 phase 3 - peer-comparison runs with skill = peer-comparison
  // and customSkills = [peer-comparison] so the planner trim from MONEY-222
  // strips everything else.
  {
    id: "stock-vs-stock",
    label: "Stock vs Stock",
    description: "Head-to-head comparison of two stocks",
    prompt: "Compare TCS vs INFY - financials, valuation, and recommendation",
    tool: "run_research",
    params: {
      mode: "advanced",
      skill: "peer-comparison",
      customSkills: ["peer-comparison"],
    },
    icon: "GitCompare",
    category: "comparison",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "multi-stock-comparison",
    label: "Multi-Stock Comparison",
    description: "Compare 3+ stocks in the same sector",
    prompt: "Compare TCS vs INFY vs Wipro vs HCL Tech - who's the best?",
    tool: "run_research",
    params: {
      mode: "advanced",
      skill: "peer-comparison",
      customSkills: ["peer-comparison"],
    },
    icon: "GitCompare",
    category: "comparison",
    tier: "L3",
    credits: 7,
    estimatedTime: "~5min",
  },
  {
    id: "mf-comparison",
    label: "Mutual Fund Comparison",
    description: "Compare mutual funds by returns and holdings",
    prompt:
      "Compare Axis Bluechip Fund vs Mirae Asset Large Cap - returns and holdings",
    // MF comparison page handles this natively; chat side would need a
    // dedicated MF-comparison tool that doesn't exist yet.
    navigateTo: "/compare",
    icon: "BarChart3",
    category: "comparison",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "sector-comparison",
    label: "Sector vs Sector",
    description: "Compare performance across sectors",
    prompt:
      "Compare IT sector vs Banking sector - returns, valuation, and outlook",
    tool: "run_research",
    params: { mode: "advanced", skill: "sector-deep-dive" },
    icon: "Layers",
    category: "comparison",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "portfolio-benchmark",
    label: "Portfolio vs Benchmark",
    description: "Compare your portfolio against Nifty 50",
    prompt:
      "Compare my portfolio performance against Nifty 50 - am I beating the index?",
    // The dashboard renders portfolio-vs-Nifty inline; chat-side comparison
    // tool would burn an LLM credit for what is a lookup, not analysis.
    navigateTo: "/dashboard",
    icon: "Target",
    category: "comparison",
    tier: "L2",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "bank-comparison",
    label: "Banking Comparison",
    description: "Compare top Indian banks",
    prompt:
      "Compare HDFC Bank vs ICICI Bank vs SBI - which is the best bank stock?",
    tool: "run_research",
    params: {
      mode: "advanced",
      skill: "peer-comparison",
      customSkills: ["peer-comparison"],
    },
    icon: "Landmark",
    category: "comparison",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },

  // ─── Portfolio Intelligence (6) ───
  // Was 8 — `risk-analysis` + `tax-analysis` are commented out below,
  // disabled with the `/risk` and `/tax` slash commands.
  // MONEY-228 - every prompt here that ALSO mentioned "portfolio" used to
  // collapse to get_dashboard_stats via the cheap classifier route. Each
  // entry now dispatches deterministically (`tool` for chat-side flows,
  // `navigateTo` for surfaces with a dedicated page).
  {
    id: "portfolio-summary",
    label: "Portfolio Summary",
    description: "Total value, P&L, and segment breakdown",
    prompt: "Show me my portfolio summary with total value and P&L breakdown",
    tool: "get_portfolio_summary",
    icon: "PieChart",
    category: "portfolio-intel",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "portfolio-roast",
    label: "Portfolio Roast",
    description: "Honest AI feedback on your portfolio",
    prompt: "Roast my portfolio - give me honest AI feedback with scores",
    tool: "start_roast",
    params: { mode: "overall", assetType: "all" },
    icon: "Flame",
    category: "portfolio-intel",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  // DISABLED - the Help Center twins of the `/risk` and `/tax` slash commands,
  // commented out with them (see lib/chat/slash-commands/registry.ts). These
  // cards dispatch their tool DIRECTLY via `?tool=...`, bypassing the slash
  // registry entirely, so unregistering the commands does not remove them —
  // they have to be disabled here as well.
  //
  // Deliberately still live: `portfolio-health` and `sector-allocation` (both
  // reuse portfolio_risk_analysis) and `rebalance-suggestions` (navigates to
  // the /risk page). They are presented as distinct features, and the /risk
  // and /tax pages themselves were not part of this change.
  // {
  //   id: "risk-analysis",
  //   label: "Risk Analysis",
  //   description: "VaR, concentration risk, and drawdown analysis",
  //   prompt:
  //     "Run a risk analysis on my portfolio - VaR, concentration, and drawdown",
  //   tool: "portfolio_risk_analysis",
  //   icon: "ShieldAlert",
  //   category: "portfolio-intel",
  //   tier: "L2",
  //   credits: 3,
  //   estimatedTime: "~2min",
  // },
  // {
  //   id: "tax-analysis",
  //   label: "Tax Report",
  //   description: "STCG, LTCG, and tax harvesting analysis",
  //   prompt:
  //     "Generate a tax analysis report - STCG, LTCG, and harvesting opportunities",
  //   tool: "tax_report",
  //   icon: "Receipt",
  //   category: "portfolio-intel",
  //   tier: "L2",
  //   credits: 3,
  //   estimatedTime: "~2min",
  // },
  {
    id: "portfolio-health",
    label: "Portfolio Health Check",
    description: "Concentration risk and diversification analysis",
    prompt:
      "Analyze my portfolio health, concentration risk, and diversification",
    // portfolio_risk_analysis uses EmptyParams - params.focus was being
    // silently dropped, making this entry render the same generic risk
    // card as the others. Removed the dead param. Future: extend the
    // tool's Zod schema if focus-specific renders are needed.
    tool: "portfolio_risk_analysis",
    icon: "Activity",
    category: "portfolio-intel",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "sector-allocation",
    label: "Sector Allocation",
    description: "Portfolio allocation by sector",
    prompt: "Show my portfolio sector allocation with percentage breakdown",
    tool: "portfolio_risk_analysis",
    icon: "PieChart",
    category: "portfolio-intel",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "rebalance-suggestions",
    label: "Rebalance Suggestions",
    description: "AI-powered portfolio rebalancing ideas",
    prompt:
      "Suggest portfolio rebalancing to improve diversification and reduce risk",
    // No chat tool wraps the rebalance flow yet; /risk has the canonical UI.
    navigateTo: "/risk",
    icon: "BarChart3",
    category: "portfolio-intel",
    tier: "L2",
    credits: 3,
    estimatedTime: "~2min",
  },
  {
    id: "investment-summary",
    label: "Investment Summary",
    description: "Invested vs current value with returns",
    prompt:
      "Show my total invested amount versus current value with overall returns",
    tool: "get_portfolio_summary",
    icon: "IndianRupee",
    category: "portfolio-intel",
    credits: 0,
    estimatedTime: "instant",
  },

  // ─── Market Discovery (7) ───
  // MONEY-228 phase 3 - most market-discovery entries dispatch to /markets
  // (the canonical Markets Overview page from MONEY-195). LLM-routed prompts
  // collapse these all to portfolio_query. AI-recommendation entries
  // route through run_research.
  {
    id: "market-today",
    label: "Market Today",
    description: "Today's market performance and movers",
    prompt:
      "How is the market performing today? Top gainers and losers with analysis",
    navigateTo: "/discover/markets",
    icon: "Activity",
    category: "market-discovery",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "top-gainers",
    label: "Top Gainers Today",
    description: "Stocks with highest gains today",
    prompt: "Which stocks are the top gainers today and why?",
    navigateTo: "/discover/markets",
    icon: "ArrowUpRight",
    category: "market-discovery",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "nifty-analysis",
    label: "Nifty 50 Analysis",
    description: "Index analysis with PE and outlook",
    prompt: "Show analysis of Nifty 50 - current level, PE, and outlook",
    // run_research can't resolve "Nifty 50" as a stock symbol - the
    // planner errors. Indices live on /discover/markets which has the
    // dedicated index cards (Nifty 50, BankNifty, Sensex, etc.).
    navigateTo: "/discover/markets",
    icon: "BarChart3",
    category: "market-discovery",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "sector-performance",
    label: "Sector Performance",
    description: "Best and worst performing sectors",
    prompt: "Which sectors are performing best and worst this month?",
    navigateTo: "/discover/sectors",
    icon: "Layers",
    category: "market-discovery",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "trending-stocks",
    label: "Trending Stocks",
    description: "Stocks trending on high volume",
    prompt: "Which stocks are trending today with unusual volume activity?",
    navigateTo: "/discover/markets",
    icon: "Sparkles",
    category: "market-discovery",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "suggest-stocks",
    label: "Suggest Stocks",
    description: "Browse strategy-driven stock ideas",
    prompt:
      "Suggest stocks to research based on my current portfolio and investing style",
    // run_research with mode=advanced needs symbols to plan; "based on
    // my portfolio" can't be resolved into a symbol set. Send to the
    // screener where the user can pick a strategy preset (value,
    // momentum, dividend, etc.) and browse curated ideas.
    navigateTo: "/discover/screener",
    icon: "Sparkles",
    category: "market-discovery",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "large-cap-movers",
    label: "Large Cap Movers",
    description: "Biggest large cap moves this week",
    prompt: "Which large cap stocks have moved the most this week?",
    navigateTo: "/discover/markets",
    icon: "TrendingUp",
    category: "market-discovery",
    credits: 0,
    estimatedTime: "instant",
  },

  // ─── Holdings & Trades (8) ───
  // MONEY-228 phase 3 - direct tool dispatch via get_holdings / get_trades.
  // Trade history and broker split land on dedicated pages.
  {
    id: "all-holdings",
    label: "All Holdings",
    description: "Complete holdings with quantity and price",
    prompt:
      "Show my current stock holdings with quantity, average price, and current value",
    tool: "get_holdings",
    icon: "Briefcase",
    category: "holdings-trades",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "holdings-by-sector",
    label: "Holdings by Sector",
    description: "Sector-wise allocation breakdown",
    prompt: "Show my holdings grouped by sector with allocation percentage",
    tool: "portfolio_risk_analysis",
    icon: "PieChart",
    category: "holdings-trades",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "unrealized-pnl",
    label: "Unrealized P&L",
    description: "Unrealized profit/loss on all holdings",
    prompt: "Show unrealized P&L for all my holdings sorted by profit",
    tool: "get_holdings",
    icon: "TrendingUp",
    category: "holdings-trades",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "recent-trades",
    label: "Recent Trades",
    description: "Trades from the last 30 days",
    prompt: "Show my recent trades from the last 30 days",
    tool: "get_trades",
    params: { limit: 30 },
    icon: "Clock",
    category: "holdings-trades",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "profitable-trades",
    label: "Profitable Trades",
    description: "Closed trades with positive P&L",
    prompt: "Show all my profitable closed trades sorted by P&L",
    tool: "get_trades",
    params: { tradeType: "SELL", limit: 50 },
    icon: "TrendingUp",
    category: "holdings-trades",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "win-rate",
    label: "Trading Win Rate",
    description: "Overall win rate and average P&L per trade",
    prompt: "What is my overall trading win rate and average P&L per trade?",
    navigateTo: "/tradebook",
    icon: "Percent",
    category: "holdings-trades",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "broker-split",
    label: "Broker-wise Split",
    description: "Portfolio split across connected brokers",
    prompt: "Show my portfolio split across all connected brokers",
    navigateTo: "/brokers",
    icon: "Link2",
    category: "holdings-trades",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "trade-history",
    label: "Trade History",
    description: "Complete trade log",
    prompt: "Show my complete trade history",
    navigateTo: "/tradebook",
    icon: "BookOpen",
    category: "holdings-trades",
    credits: 0,
    estimatedTime: "instant",
  },

  // ─── Mutual Funds (6) ───
  // MONEY-228 phase 3 - get_mutual_funds is the canonical tool; category
  // split + investment value land on get_portfolio_summary which surfaces
  // the same numbers without an extra MF-specific tool.
  {
    id: "my-mutual-funds",
    label: "My Mutual Funds",
    description: "All MF investments with NAV and returns",
    prompt: "Show my mutual fund investments with current NAV and returns",
    tool: "get_mutual_funds",
    icon: "Landmark",
    category: "mutual-funds",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "mf-returns",
    label: "MF Returns",
    description: "Returns across all mutual funds",
    prompt: "Show returns on all my mutual fund investments",
    tool: "get_mutual_funds",
    icon: "TrendingUp",
    category: "mutual-funds",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "sip-performance",
    label: "SIP Performance",
    description: "How your SIPs are performing",
    prompt: "How are my SIP investments performing?",
    tool: "get_mutual_funds",
    icon: "Repeat",
    category: "mutual-funds",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "top-mf",
    label: "Top Performing MF",
    description: "Best-returning mutual funds",
    prompt: "Which of my mutual funds have given the best returns?",
    tool: "get_mutual_funds",
    icon: "Crown",
    category: "mutual-funds",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "mf-category-split",
    label: "MF Category Split",
    description: "Equity, debt, and hybrid allocation",
    prompt: "Show my mutual fund allocation by category - equity, debt, hybrid",
    tool: "get_mutual_funds",
    icon: "PieChart",
    category: "mutual-funds",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "mf-value",
    label: "MF Investment Value",
    description: "Total MF investment and returns",
    prompt: "What is my total mutual fund investment value and total returns?",
    tool: "get_portfolio_summary",
    icon: "IndianRupee",
    category: "mutual-funds",
    credits: 0,
    estimatedTime: "instant",
  },

  // ─── FIRE Planning (7) ───
  // MONEY-228 phase 3 - get_fire_scenarios reads the user's saved
  // retirement plans; create + projection navigate to /fire which has
  // the dedicated calculator UI.
  {
    id: "fire-scenarios",
    label: "My FIRE Scenarios",
    description: "View saved retirement scenarios",
    prompt: "Show my FIRE scenarios and retirement progress",
    tool: "get_fire_scenarios",
    icon: "Flame",
    category: "fire",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "fire-number",
    label: "FIRE Number",
    description: "Calculate your FIRE target",
    prompt: "What is my FIRE number based on my current expenses?",
    navigateTo: "/fire",
    icon: "Target",
    category: "fire",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "create-fire-plan",
    label: "Create FIRE Plan",
    description: "Build a new retirement scenario",
    prompt:
      "Create a FIRE scenario: age 30, retire at 50, corpus 20 lakhs, monthly savings 50000",
    navigateTo: "/fire",
    icon: "Plus",
    category: "fire",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "years-to-fire",
    label: "Years to FIRE",
    description: "Time to financial independence",
    prompt: "How many years until I reach financial independence?",
    tool: "get_fire_scenarios",
    icon: "Calendar",
    category: "fire",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "sip-projection",
    label: "SIP Projection",
    description: "Project SIP returns over time",
    prompt: "Project my SIP of 25000 per month for 20 years at 12% return",
    navigateTo: "/fire",
    icon: "TrendingUp",
    category: "fire",
    credits: 0,
    estimatedTime: "instant",
  },
  {
    id: "retirement-corpus",
    label: "Retirement Corpus",
    description: "How much you need to retire",
    prompt:
      "How much corpus do I need to retire with 1 lakh monthly expenses at age 55?",
    navigateTo: "/fire",
    icon: "Banknote",
    category: "fire",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },
  {
    id: "coast-fire",
    label: "Coast FIRE",
    description: "When can you stop saving?",
    prompt: "At what age can I stop saving and still retire comfortably by 60?",
    navigateTo: "/fire",
    icon: "Sunset",
    category: "fire",
    tier: "L1",
    credits: 1,
    estimatedTime: "~30s",
  },

  // ─── Paper Trading prompts (6) removed 2026-05-28 per product decision. ───
  // get_paper_positions tool still registered in chat-tools; reachable via
  // /paper-trading direct URL.
];
