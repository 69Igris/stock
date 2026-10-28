/**
 * Persona Follow-Up Chip Definitions
 *
 * Client-safe module - NO server-only imports.
 * Separated from prompt-personas.ts to avoid pulling @google/genai
 * into client bundles via the import chain.
 */

export interface ChipDef {
  label: string;
  /**
   * Free-text prompt fed into executeQuickAction → falls through the
   * classifier. Use {symbol} as placeholder - interpolated at render time.
   *
   * AVOID when a deterministic tool exists (the classifier collapses
   * adjacent prompts like "Roast my portfolio" / "Show sector allocation"
   * / "Suggest rebalancing" / "Compare against Nifty 50" all into the
   * cheapest portfolio_query route, returning the same dashboard summary
   * for every chip - the regression task #46 captured.)
   */
  prompt?: string;
  /**
   * Deterministic tool execution - bypasses the classifier entirely.
   * When set, chips dispatch via executeToolDirect with these params.
   */
  tool?: string;
  params?: Record<string, unknown>;
  /**
   * Navigation chip - jumps to a dedicated page where the feature
   * lives (e.g. /roast, /risk). The chat surface inserts a brief
   * confirmation message before navigating.
   */
  navigateTo?: string;
  /**
   * Default user-text shown in the chat history when a tool / navigate
   * chip fires (so the conversation reads naturally). Falls back to
   * the chip label when omitted.
   */
  userText?: string;
  icon: string;
}

/**
 * Follow-up chips per persona. Keys match PersonaId.
 */
export const PERSONA_CHIPS: Record<string, ChipDef[]> = {
  equity_research: [
    {
      label: "Deep Valuation",
      prompt: "Run a DCF valuation and cash flow quality analysis for {symbol}",
      icon: "TrendingUp",
    },
    {
      label: "Peer Comparison",
      prompt: "Compare {symbol} with its top sector peers on key metrics",
      icon: "Users",
    },
    {
      label: "Technical Overlay",
      prompt:
        "Add technical analysis for {symbol} - RSI, MACD, support/resistance",
      icon: "LineChart",
    },
    {
      label: "Latest News",
      prompt: "Show latest news headlines for {symbol}",
      icon: "Newspaper",
    },
    {
      label: "Investment Thesis",
      prompt:
        "Build a full investment thesis for {symbol} with bull and bear cases",
      icon: "Search",
    },
  ],

  wealth_advisor: [
    {
      label: "Compare Funds",
      prompt: "Compare my top mutual funds against their benchmark indices",
      icon: "BarChart3",
    },
    {
      label: "SIP Projection",
      prompt:
        "Project my SIP returns for the next 10 years with realistic assumptions",
      icon: "TrendingUp",
    },
    {
      label: "Category Analysis",
      prompt:
        "Analyse my mutual fund allocation across categories - am I over/under-exposed?",
      icon: "Search",
    },
    {
      label: "Expense Check",
      prompt:
        "Review expense ratios of my mutual funds - are any too expensive?",
      icon: "SlidersHorizontal",
    },
  ],

  financial_planner: [
    {
      label: "Stress Test",
      prompt:
        "Stress test my FIRE scenario with 8% inflation and bear market in year 1",
      icon: "SlidersHorizontal",
    },
    {
      label: "Optimize SIP",
      prompt: "Optimize my SIP allocation to reach FIRE faster",
      icon: "TrendingUp",
    },
    {
      label: "Tax Efficiency",
      prompt: "How can I make my FIRE strategy more tax-efficient?",
      icon: "Search",
    },
    {
      label: "Coast FIRE",
      prompt:
        "Calculate my Coast FIRE number - when can I stop saving aggressively?",
      icon: "Flame",
    },
  ],

  quant_analyst: [
    // Deterministic named-strategy screens. Dispatching via `tool` skips the
    // classifier, and a named `strategy` skips the screener's NL parser too —
    // so these are guaranteed-ready (no "could not parse" dead-ends). The old
    // free-text "Tighten/Sector Leaders/..." chips fell through the classifier
    // and could not be fulfilled (MONEY-587).
    {
      label: "Low Debt · High ROE",
      tool: "run_screener",
      params: { strategy: "low_debt_high_roe" },
      userText: "Screen for low-debt, high-ROE stocks",
      icon: "SlidersHorizontal",
    },
    {
      label: "Growth + Momentum",
      tool: "run_screener",
      params: { strategy: "growth_momentum" },
      userText: "Screen for growth + momentum stocks",
      icon: "TrendingUp",
    },
    {
      label: "GARP",
      tool: "run_screener",
      params: { strategy: "garp" },
      userText: "Screen for growth at a reasonable price (GARP)",
      icon: "Search",
    },
    {
      label: "All Strategies",
      navigateTo: "/strategies",
      userText: "Browse all screening strategies",
      icon: "BarChart3",
    },
  ],

  technical_analyst: [
    {
      label: "Weekly Timeframe",
      prompt:
        "Analyse {symbol} on the weekly timeframe - is the larger trend intact?",
      icon: "LineChart",
    },
    {
      label: "Volume Profile",
      prompt: "Show volume analysis for {symbol} - any divergences?",
      icon: "BarChart3",
    },
    {
      label: "Support/Resistance",
      prompt: "Map all key support and resistance levels for {symbol}",
      icon: "SlidersHorizontal",
    },
    {
      label: "MACD Signal",
      prompt: "What does the MACD signal for {symbol} say about momentum?",
      icon: "TrendingUp",
    },
  ],

  portfolio_manager: [
    {
      // Fires the start_roast chat tool. The tool's execute() runs
      // canUseRoastAction first (so the confirmation card shows credit
      // status + free-roast quota) then startRoastAction. ChatContext's
      // confirmAction handler kicks off startRoastPoll which mirrors the
      // run_research lifecycle - running progress, completed score +
      // commentary, failed state - all inline without leaving chat.
      label: "Roast Portfolio",
      tool: "start_roast",
      params: { mode: "overall", assetType: "all" },
      userText: "Roast my portfolio",
      icon: "Flame",
    },
    {
      // portfolio_risk_analysis returns sector concentration with HHI +
      // top concentrations + over/under-weight calls - deterministic,
      // bypasses the classifier that was collapsing every portfolio
      // chip into the cheap dashboard summary.
      label: "Sector Breakdown",
      tool: "portfolio_risk_analysis",
      params: { focus: "sector_allocation" },
      userText: "Show my portfolio sector allocation",
      icon: "BarChart3",
    },
    {
      // Rebalancing UI lives on /risk with full controls; navigate
      // there rather than asking the LLM to invent specific moves.
      label: "Rebalance",
      navigateTo: "/risk",
      userText: "Suggest portfolio rebalancing",
      icon: "SlidersHorizontal",
    },
    {
      // Dashboard shows portfolio vs Nifty chart + XIRR side-by-side.
      label: "Benchmark",
      navigateTo: "/dashboard",
      userText: "Compare my portfolio performance against Nifty 50",
      icon: "TrendingUp",
    },
  ],

  private_banker: [
    {
      label: "Tax Harvesting",
      prompt:
        "Which stocks should I consider for tax-loss harvesting this year?",
      icon: "Search",
    },
    {
      label: "Asset Allocation",
      prompt:
        "Analyse my overall asset allocation across equity, debt, gold, and real estate",
      icon: "BarChart3",
    },
    {
      label: "Goal Mapping",
      prompt:
        "Map my investments to financial goals - retirement, education, house",
      icon: "TrendingUp",
    },
    {
      label: "Tax Report",
      prompt: "Generate my capital gains tax report for this financial year",
      icon: "Newspaper",
    },
  ],

  macro_strategist: [
    // There is no deterministic macro / FII-DII / sector-rotation tool, and the
    // screener can't fulfil thematic "stocks that benefit from the macro theme"
    // queries. Per MONEY-587 (don't show suggestions the backend can't serve),
    // those free-text chips were removed and replaced with the closest ready
    // backends: an FII-favoured strategy screen, the user's sector exposure,
    // and the sector browser.
    {
      label: "FII Favourites",
      tool: "run_screener",
      params: { strategy: "strong_fundamentals_fii" },
      userText: "Screen for strong-fundamental stocks favoured by FIIs",
      icon: "TrendingUp",
    },
    {
      label: "My Sector Exposure",
      tool: "portfolio_risk_analysis",
      params: { focus: "sector_allocation" },
      userText: "Show my portfolio sector allocation",
      icon: "BarChart3",
    },
    {
      label: "Browse Sectors",
      navigateTo: "/discover",
      userText: "Browse sectors and themes",
      icon: "Search",
    },
    {
      label: "Dividend Aristocrats",
      tool: "run_screener",
      params: { strategy: "dividend_aristocrats" },
      userText: "Screen for consistent dividend-paying stocks",
      icon: "LineChart",
    },
  ],

  sell_side_analyst: [
    {
      label: "Add Competitor",
      prompt: "Add the next closest competitor to this comparison",
      icon: "Plus",
    },
    {
      label: "Valuation Matrix",
      prompt:
        "Show a detailed valuation matrix - PE, PB, EV/EBITDA, PEG for both stocks",
      icon: "BarChart3",
    },
    {
      label: "Scenario Analysis",
      prompt: "Run base/bull/bear scenario analysis for both stocks",
      icon: "SlidersHorizontal",
    },
    {
      label: "Sector Deep Dive",
      prompt: "Give me a sector deep dive covering all major players",
      icon: "Search",
    },
  ],

  general_analyst: [
    {
      label: "Analyse a Stock",
      prompt: "Research RELIANCE - give me a detailed analysis with score",
      icon: "TrendingUp",
    },
    {
      label: "Screen Stocks",
      tool: "run_screener",
      params: { strategy: "low_debt_high_roe" },
      userText: "Screen for low-debt, high-ROE stocks",
      icon: "Search",
    },
    {
      label: "Portfolio Summary",
      prompt: "Show me my portfolio summary with total value and P&L",
      icon: "BarChart3",
    },
  ],
};
