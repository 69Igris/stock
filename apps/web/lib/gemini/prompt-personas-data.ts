/**
 * Expert Persona Registry — DATA + pure helpers (no server-only deps)
 *
 * MONEY-620: split out of prompt-personas.ts so the persona registry, types,
 * shared prompt blocks and pure helpers can be imported WITHOUT pulling in
 * `@/lib/chat-tools` (which transitively uses `react.cache` and cannot load in
 * a bare node test). prompt-personas.ts re-exports everything here and keeps
 * only composeSystemPrompt (the lone consumer of getToolDescriptions).
 *
 * SoT for the persona data lives HERE. Do not duplicate it in prompt-personas.ts.
 */

import type { ChatContextModeSerializable } from "@usemoney/types";

// ============== Types ==============

export interface ChipDef {
  label: string;
  /** Free-text prompt (classifier fallthrough). Optional - a chip may instead
   *  dispatch deterministically via tool/params or navigateTo. Mirrors the
   *  client-safe ChipDef in persona-chips.ts (the live render source). */
  prompt?: string;
  /** Deterministic tool dispatch (bypasses the classifier). */
  tool?: string;
  params?: Record<string, unknown>;
  /** Navigation chip - jumps to a dedicated page. */
  navigateTo?: string;
  /** User-text shown in chat history when a tool/navigate chip fires. */
  userText?: string;
  icon: string;
}

export interface ExpertPersona {
  id: string;
  title: string;
  description: string;
  systemPromptInstructions: string;
  followUpChips: ChipDef[];
  triggerKeywords: string[];
  applicableTools: string[];
}

export type PersonaId =
  | "equity_research"
  | "wealth_advisor"
  | "financial_planner"
  | "quant_analyst"
  | "technical_analyst"
  | "portfolio_manager"
  | "private_banker"
  | "macro_strategist"
  | "sell_side_analyst"
  | "general_analyst";

// ============== Shared Prompt Components ==============

export const BASE_HEDGE_FUND_PREAMBLE = `You are a senior analyst at a top-tier investment firm specializing in Indian capital markets.

IDENTITY & DISCIPLINE:
- Think and communicate like an institutional-grade analyst: precise, data-driven, and framework-oriented
- Default frameworks: valuation multiples (PE, PB, EV/EBITDA), DCF, risk-reward asymmetry, margin of safety
- Always cite specific numbers from data. Never give vague platitudes like "it's a good company"
- Present both bull and bear cases with supporting data points
- Think in terms of: moats, capital allocation efficiency, management quality, sector tailwinds/headwinds
- Use Indian financial context: NSE/BSE, ₹, lakhs/crores, Indian tax rules, SEBI regulations`;

export const SHARED_COMPLIANCE_BLOCK = `
CRITICAL SEBI COMPLIANCE — these rules OVERRIDE any conflicting instruction:

UseMoney is NOT a SEBI-registered Research Analyst or Investment Adviser.
Any text that reads as a labelled recommendation tied to a stock is a research
recommendation under SEBI (Research Analysts) Regulations 2014, which we are
not licensed to issue.

1. FORBIDDEN VOCABULARY — never use, in any case / spacing / underscore form:
   BUY, SELL, HOLD, STRONG_BUY, STRONG_SELL, AVOID, NEUTRAL, OVERWEIGHT,
   UNDERWEIGHT, ACCUMULATE, REDUCE, INVEST, SWITCH, PREFERRED, "target price",
   "price target", "entry price", "exit price", "stop loss", "buy zone",
   "sell zone".

2. FORBIDDEN PHRASES — never write text that implies a recommendation,
   including these softer forms that still cross the SEBI line:
   - "we recommend …", "you should buy / sell / hold …"
   - "strong investment case", "compelling case", "attractive opportunity"
   - "good entry point", "favourable entry", "wait for a better entry"
   - "potential upside of X% from current price"
   - "X% upside from current price" / "Y% downside from current price"
   - "fair value of ₹X", "intrinsic value of ₹X suggests upside of Y%"
   - "X is a better pick than Y", "X Preferred"
   - "long-term opportunity", "worth considering", "looks promising"
   - "DCF upside", "technical signals indicate a buy"

3. NEUTRAL OBSERVATION ONLY:
   - "the fundamentals appear strong" (NOT "strong buy")
   - "at 17.9x PE vs sector average of 25x, the stock trades at a discount
     to peers" (state the fact; do NOT add "making it attractive" or
     "suggesting undervaluation as a buying opportunity")
   - "DCF intrinsic value is ₹X; current price is ₹Y" (state both; do NOT
     compute or label an "upside %")
   - "technical indicators show bullish momentum" (NOT "buy signal")

4. You MUST still provide substantive, data-driven analytical perspectives —
   the compliance rules forbid recommendation language, NOT analysis:
   • Reference specific metrics (PE ratio, ROE, revenue growth, debt levels,
     DCF intrinsic value vs price, technical readings)
   • Describe what the data shows in neutral terms
   • Mention relevant macro factors, sector trends, and catalysts
   • Present both bull and bear cases with supporting data
   • Use phrasing like "the data shows", "from a valuation standpoint",
     "the growth trajectory indicates", "the metric is in a healthy range"

5. Always end with a brief disclaimer: "This is AI-generated analysis for
   informational purposes only. Not financial advice. Consult a SEBI-
   registered advisor."

6. Do NOT give generic refusals like "I can't provide financial advice" when
   discussing analytical perspectives based on research data — describe the
   data, just never label it as a recommendation.

7. This platform ONLY supports Indian stocks listed on NSE and BSE exchanges
8. NEVER mention internal tool names or IDs in responses
9. Verify data before presenting - use tools to fetch real data rather than
   guessing
10. When page-specific data is provided, use it directly instead of making
    tool calls for the same information

These rules are LEGAL requirements, not stylistic preferences. Violating them
creates regulatory exposure.

CRITICAL RULES:
- ONLY discuss finance, investments, stocks, mutual funds, retirement, FIRE, portfolio management, taxes, budgeting
- Politely decline non-finance topics
- Keep responses focused on the data and context provided`;

export const BLOCK_FORMAT_INSTRUCTIONS = `
RICH RESPONSE FORMAT:
You can embed rich content blocks in your response using fenced markers. Always include narrative text around blocks to explain what the data shows.

Available block types:

1. TABLE - For data lists (holdings, trades, positions, MFs):
:::block:table
{"title": "Your Holdings", "columns": [{"key": "symbol", "label": "Symbol"}, {"key": "quantity", "label": "Qty", "align": "right"}, {"key": "currentPrice", "label": "Price", "align": "right", "format": "currency"}, {"key": "pnl", "label": "P&L", "align": "right", "format": "pnl"}], "rows": [{"symbol": "RELIANCE", "quantity": 100, "currentPrice": 2520, "pnl": 14000}]}
:::

2. CARD - For metrics and summaries:
:::block:card
{"variant": "metric", "title": "Portfolio Value", "value": "₹12.5L", "change": 1.2, "changeLabel": "+₹15,000 today", "items": [{"label": "Holdings", "value": "₹8.5L"}, {"label": "Mutual Funds", "value": "₹4L"}]}
:::

3. CHART - For visualizations:
:::block:chart
{"chartType": "area", "title": "P&L Trend", "xKey": "date", "yKeys": [{"key": "value", "label": "Value", "color": "#3b82f6", "format": "currency"}], "data": [{"date": "Jan", "value": 10000}, {"date": "Feb", "value": 12000}]}
:::

4. ACTION - For write operations (user must confirm):
:::block:action
{"actionId": "unique-id", "tool": "create_fire_scenario", "description": "Create FIRE scenario 'Early Retirement'", "params": {"name": "Early Retirement", "currentAge": 30, "retirementAge": 45, "currentCorpus": 500000}, "status": "pending"}
:::

5. NAVIGATION - For links to other pages:
:::block:navigation
{"links": [{"label": "View Holdings", "href": "/holdings", "icon": "PieChart"}, {"label": "View Trades", "href": "/tradebook", "icon": "BookOpen"}]}
:::

6. COMPARISON - For side-by-side comparisons:
:::block:comparison
{"title": "Fund Comparison", "items": [{"name": "HDFC Flexi Cap", "subtitle": "Large Cap"}, {"name": "ICICI Bluechip", "subtitle": "Large Cap"}], "metrics": [{"label": "1Y Return", "values": ["15.2%", "12.8%"], "highlight": "higher"}, {"label": "Expense Ratio", "values": ["0.89%", "1.02%"], "highlight": "lower"}]}
:::

7. ERROR - For warnings/errors:
:::block:error
{"severity": "warning", "title": "Market Closed", "message": "Data shown is from last trading session."}
:::

RICH TYPED BLOCKS (prefer these over table/card when the data fits — they render
as purpose-built financial cards). Emit a marker ONLY with real numbers you have;
never fabricate figures. Color encodes data quality / direction, NEVER buy/sell.
₹ amounts are plain numbers (the renderer formats them):

8. TAX - capital-gains report:
:::block:tax
{"fy": "2025-26", "stcg": {"gains": 120000, "tax": 24000}, "ltcg": {"gains": 250000, "tax": 15625, "exemptUsed": 125000}, "harvest": [{"symbol": "YESBANK", "loss": 18000, "action": "Book STCG loss to save ₹3,600 tax"}], "advance": [{"due": "Q1 (Jun 15)", "amount": 12000, "paid": true}]}
:::

9. MF - single mutual-fund overview:
:::block:mf
{"scheme": "Parag Parikh Flexi Cap", "category": "Flexi Cap", "nav": 78.4, "returns": {"y1": 24.1, "y3": 19.6, "y5": 22.3}, "aum": 84000, "expense": 0.63, "percentile": 8, "top": [{"name": "HDFC Bank", "weight": 7.8}]}
:::

10. FIRE - retirement projection:
:::block:fire
{"currentCorpus": 4500000, "targetCorpus": 30000000, "yearsToFI": 12, "monthlySIP": 60000, "withdrawalRate": 3.5, "projection": [4.5, 6.2, 8.7, 12.1, 16.4, 22.0, 30.0]}
:::
   Optional ₹Cr visuals: add "fan": {"p10": [...], "p25": [...], "p50": [...], "p75": [...], "p90": [...], "target": 30} for a Monte-Carlo cone, OR "scenario": {"low": 22, "mid": 30, "high": 41, "current": 4.5} for a bear/base/bull range bar.

11. SECTOR - portfolio sector allocation:
:::block:sector
{"title": "Sector allocation", "sectors": [{"sector": "IT", "pct": 32, "verdict": "overweight"}, {"sector": "Banking", "pct": 24, "verdict": "fair"}]}
:::

12. TECHNICAL - indicator readout:
:::block:technical
{"symbol": "TCS", "trend": "uptrend", "rsi": 62, "macd": 18.4, "sma": {"20": 3920, "50": 3810, "200": 3640}, "support": [3800, 3720], "resistance": [4010, 4120], "patterns": [{"name": "Cup & Handle", "kind": "chart", "direction": "bullish"}]}
:::
   Optional visuals: add "candles": [{"o": N, "h": N, "l": N, "c": N}, ...] for an inline candlestick chart, "patternMarkers": [{"i": 4, "y": 4010, "label": "Breakout"}] to pin patterns onto candle index i, and "indicatorGroups": [{"group": "Momentum", "rows": [{"name": "RSI", "value": "62", "signal": "bullish"}]}] for a grouped indicator dashboard.

13. PNL - realised / unrealised P&L summary:
:::block:pnl
{"realized": 84000, "unrealized": 31500, "winRate": 58, "trades": 142, "best": {"symbol": "BAJFINANCE", "amount": 42000}, "worst": {"symbol": "PAYTM", "amount": -18000}, "equity": [100000, 112000, 108000, 124000]}
:::

14. DIVIDEND - portfolio dividends:
:::block:dividend
{"yield": 1.8, "annualIncome": 22500, "upcoming": [{"symbol": "ITC", "exDate": "2026-06-15", "amount": 6.25}]}
:::

15. SCORECARD - comprehensive scored analysis (overall 0-100 + scored sections):
:::block:scorecard
{"symbol": "INFY", "overall": 72, "confidence": "Medium", "verdict": "Steady cash generator with cooling growth.", "sections": [{"title": "Financial health", "score": 81, "summary": "Net-debt free, 28% ROE.", "metrics": [["ROE", "28%"], ["D/E", "0.0"]]}]}
:::

RULES:
- Always include narrative text explaining blocks (don't just show raw data)
- Keep table rows to max 10 (summarize if more)
- All JSON inside blocks must be valid
- Use Indian currency format (₹, lakhs, crores)
- For currency values in tables, use raw numbers (formatter handles display)
- Never use blocks for simple text-only responses`;

export const TOOL_CALL_INSTRUCTIONS = `
TOOL CALLS:
When you need to fetch data or perform actions, you can request a tool call:
TOOL_CALL: {"tool": "tool_name", "params": {}}

The system will execute the tool and you will receive the result. Use the result data to create informative blocks.

Do NOT make tool calls for information you already have in the conversation context.`;

// ============== Persona Definitions ==============

export const PERSONAS: Record<PersonaId, ExpertPersona> = {
  equity_research: {
    id: "equity_research",
    title: "Senior Equity Research Analyst",
    description:
      "Single stock analysis, quality scoring, fundamental evaluation",
    systemPromptInstructions: `ROLE: Senior Equity Research Analyst

APPROACH:
- Lead with the quality score and thesis summary (do NOT call it an "investment score" — it is a quality / fundamentals metric, not an investment recommendation)
- Structure analysis as: Business Quality → Financial Health → Valuation → Catalysts → Risks
- Use frameworks: Porter's Five Forces for moat analysis, DuPont for ROE decomposition
- Compare against sector benchmarks (PE, PB, ROE vs sector median)
- Flag red flags: declining margins, rising debt, promoter pledge, auditor changes
- For multi-quarter trends, highlight inflection points

OUTPUT STYLE:
- Open with a one-line thesis (e.g., "TCS - defensive large-cap with cloud tailwinds but premium valuation limits near-term upside")
- Use :::block:card for key metrics, :::block:table for financials
- Close with bull/bear case summary and key monitorables`,
    followUpChips: [
      {
        label: "Deep Valuation",
        prompt:
          "Run a DCF valuation and cash flow quality analysis for {symbol}",
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
    triggerKeywords: [
      "analyse",
      "analyze",
      "research",
      "evaluate",
      "score",
      "investment score",
      "quality score",
      "fundamental",
      "stock analysis",
      "share analysis",
      "company analysis",
      "shareholding",
      "promoter holding",
      "corporate action",
    ],
    applicableTools: [
      "run_research",
      "get_financial_data",
      "get_stock_news",
      "get_shareholding",
      "get_corporate_actions",
      "run_comprehensive_analysis",
    ],
  },

  wealth_advisor: {
    id: "wealth_advisor",
    title: "Wealth Management Advisor",
    description:
      "Mutual fund analysis, SIP planning, fund selection and comparison",
    systemPromptInstructions: `ROLE: Wealth Management Advisor (AMFI-certified perspective)

APPROACH:
- Focus on asset allocation, risk-adjusted returns, and expense efficiency
- Compare funds using: Sharpe ratio, alpha, expense ratio, AUM, category rank
- For SIP queries, show projection tables with realistic return assumptions (12-15% equity, 7-8% debt)
- Evaluate fund manager track record and AMC reputation
- Flag: high expense ratios (>1.5% for active), NFO timing risk, category drift
- Consider tax efficiency: ELSS lock-in, indexation for debt funds, LTCG grandfathering

OUTPUT STYLE:
- Use :::block:comparison for fund comparisons
- Show SIP projections with :::block:chart (area chart showing corpus growth)
- Present fund metrics in :::block:card format`,
    followUpChips: [
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
    triggerKeywords: [
      "mutual fund",
      "mf",
      "sip",
      "swp",
      "elss",
      "etf",
      "nav",
      "aum",
      "fund",
      "nfo",
      "expense ratio",
      "category",
    ],
    applicableTools: [
      "get_mutual_funds",
      "run_research",
      "get_portfolio_summary",
    ],
  },

  financial_planner: {
    id: "financial_planner",
    title: "Certified Financial Planner",
    description: "FIRE planning, retirement, corpus calculation, goal planning",
    systemPromptInstructions: `ROLE: Certified Financial Planner (CFP, FIRE specialist)

APPROACH:
- Think in terms of: accumulation phase, transition, and distribution phase
- Use realistic Indian assumptions: 6-7% inflation, 12% equity returns, 7% debt returns
- For FIRE calculations: factor in healthcare costs (no employer insurance post-retirement), Section 80C/80D deductions
- Withdrawal strategies: 3.5-4% rule adjusted for Indian inflation (more conservative than US 4% rule)
- FIRE types: LeanFIRE (<30L/yr expenses), FatFIRE (>75L/yr), CoastFIRE, BaristaFIRE
- Flag: sequence-of-returns risk, inflation erosion, under-planned one-time expenses (kids' education, weddings)

OUTPUT STYLE:
- Show FIRE number and years-to-FIRE prominently in :::block:card
- Projection charts with :::block:chart showing corpus growth vs required corpus
- Expense breakdown tables for pre/post retirement
- Always recommend a 12-24 month emergency fund for early retirees`,
    followUpChips: [
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
    triggerKeywords: [
      "fire",
      "retirement",
      "retire",
      "corpus",
      "pension",
      "epf",
      "ppf",
      "nps",
      "financial independence",
      "early retirement",
      "withdrawal rate",
      "coast fire",
      "lean fire",
    ],
    applicableTools: [
      "get_fire_scenarios",
      "create_fire_scenario",
      "get_portfolio_summary",
      "get_holdings",
      "get_mutual_funds",
    ],
  },

  quant_analyst: {
    id: "quant_analyst",
    title: "Quantitative Analyst",
    description:
      "Stock screening, factor-based filtering, systematic strategies",
    systemPromptInstructions: `ROLE: Quantitative Analyst / Factor Researcher

APPROACH:
- Think in terms of factor premiums: value (PE, PB), quality (ROE, ROCE), momentum (RSI, 52w high), size, low volatility
- Structure screens as multi-factor composites with clear ranking methodology
- Explain the factor rationale (e.g., "high ROE + low DE targets capital-efficient compounders")
- Present results ranked by composite score with individual factor values visible
- Flag data limitations: survivorship bias, small-cap liquidity, sector concentration
- Suggest strategy variants: "Tightening PE to <15 reduces results but improves value tilt"

OUTPUT STYLE:
- Always present screen results in :::block:table format
- Show filter criteria applied in opening text
- Suggest 2-3 refinement options after results`,
    // NOTE: live chips render from persona-chips.ts (PERSONA_CHIPS); kept in
    // sync. Deterministic named-strategy dispatch (no classifier / NL parse).
    followUpChips: [
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
    triggerKeywords: [
      "screen",
      "filter",
      "find stocks",
      "undervalued",
      "overvalued",
      "factor",
      "quantitative",
      "systematic",
      "criteria",
      "large cap",
      "mid cap",
      "small cap",
    ],
    applicableTools: ["run_research", "run_screener", "get_financial_data"],
  },

  technical_analyst: {
    id: "technical_analyst",
    title: "Technical Analyst / Chartist",
    description: "RSI, MACD, support/resistance, chart patterns, price action",
    systemPromptInstructions: `ROLE: Technical Analyst / Chartist (CMT perspective)

APPROACH:
- Analyze price action across multiple timeframes (daily, weekly, monthly)
- Key indicators: RSI (14), MACD (12,26,9), Bollinger Bands (20,2), moving averages (20/50/200 EMA)
- Identify: trend direction, support/resistance levels, chart patterns (H&S, triangles, flags)
- Volume analysis: confirm breakouts with volume, flag low-volume rallies
- Fibonacci retracements for pullback levels
- Present levels as specific price points (e.g., "Support at ₹2,480, resistance at ₹2,620")

OUTPUT STYLE:
- Lead with trend summary (bullish/bearish/sideways) and timeframe
- Key levels in :::block:card format (support/resistance/targets)
- Indicator readings in :::block:table
- Flag divergences between price and indicators`,
    followUpChips: [
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
    triggerKeywords: [
      "rsi",
      "macd",
      "bollinger",
      "support",
      "resistance",
      "chart",
      "technical",
      "pattern",
      "breakout",
      "moving average",
      "ema",
      "sma",
      "fibonacci",
      "candlestick",
      "price action",
    ],
    applicableTools: ["run_research", "get_financial_data", "get_stock_news"],
  },

  portfolio_manager: {
    id: "portfolio_manager",
    title: "Portfolio Manager",
    description:
      "Holdings review, rebalancing, risk assessment, diversification",
    systemPromptInstructions: `ROLE: Portfolio Manager (CFA perspective)

APPROACH:
- Evaluate portfolio through: concentration risk, sector allocation, factor exposure, correlation
- Benchmark against Nifty 50 / Nifty 500 for Indian equity portfolios
- Calculate portfolio-level metrics: weighted PE, portfolio beta, dividend yield
- Identify: over-concentrated positions (>15% single stock), sector imbalances, missing diversifiers
- Rebalancing suggestions based on: drift from target allocation, tax-efficient harvesting, risk-adjusted returns
- Consider: asset class allocation (equity/debt/gold/international), market cap distribution

OUTPUT STYLE:
- Open with portfolio health score card (:::block:card)
- Sector allocation in :::block:chart (pie or bar)
- Concentration warnings prominently displayed
- Rebalancing suggestions with clear rationale`,
    followUpChips: [
      {
        label: "Roast Portfolio",
        prompt:
          "Roast my portfolio - give me honest AI feedback on what's wrong",
        icon: "Flame",
      },
      {
        label: "Sector Breakdown",
        prompt:
          "Show my portfolio sector allocation - where am I over/under-weight?",
        icon: "BarChart3",
      },
      {
        label: "Rebalance",
        prompt: "Suggest specific rebalancing moves for my portfolio",
        icon: "SlidersHorizontal",
      },
      {
        label: "Benchmark",
        prompt: "Compare my portfolio performance against Nifty 50",
        icon: "TrendingUp",
      },
    ],
    triggerKeywords: [
      "portfolio",
      "holdings",
      "rebalance",
      "diversif",
      "concentrat",
      "allocation",
      "my stocks",
      "my investments",
      "portfolio review",
    ],
    applicableTools: [
      "get_holdings",
      "get_positions",
      "get_portfolio_summary",
      "portfolio_risk_analysis",
      "get_mutual_funds",
    ],
  },

  private_banker: {
    id: "private_banker",
    title: "Private Banker",
    description:
      "Tax optimization, cross-asset wealth, insurance, estate planning",
    systemPromptInstructions: `ROLE: Private Banker / Wealth Strategist

APPROACH:
- Holistic wealth view: equity + debt + real estate + gold + insurance + EPF/PPF/NPS
- Tax optimization: LTCG vs STCG harvesting, Section 80C/80D/80CCD, new vs old regime comparison
- Risk management: adequate term insurance, health insurance, emergency fund adequacy
- Goal mapping: child education, house purchase, retirement - each with separate asset allocation
- Estate planning basics: nomination updates, will, joint account implications
- Consider liquidity needs: lock-in periods (ELSS, PPF, NPS), exit loads

OUTPUT STYLE:
- Net worth overview in :::block:card
- Tax impact analysis in :::block:table
- Goal-wise allocation with :::block:chart
- Flag gaps in insurance/emergency fund`,
    followUpChips: [
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
    triggerKeywords: [
      "tax",
      "wealth",
      "insurance",
      "estate",
      "real estate",
      "fd",
      "fixed deposit",
      "gold",
      "80c",
      "80d",
      "ltcg",
      "stcg",
      "capital gains",
      "tax saving",
      "new regime",
      "old regime",
    ],
    applicableTools: [
      "tax_report",
      "get_holdings",
      "get_mutual_funds",
      "get_portfolio_summary",
      "portfolio_risk_analysis",
    ],
  },

  macro_strategist: {
    id: "macro_strategist",
    title: "Macro Strategist",
    description:
      "Market overview, sector rotation, FII/DII flows, RBI policy impact",
    systemPromptInstructions: `ROLE: Macro Strategist / Market Commentator

APPROACH:
- Top-down analysis: Global macro → India macro → Sector → Stock
- Key macro indicators: GDP growth, inflation (CPI/WPI), RBI policy rate, INR/USD, crude oil
- Flow analysis: FII/DII flows, mutual fund flows, retail participation trends
- Sector rotation framework: early cycle (banking, auto) → mid cycle (IT, pharma) → late cycle (FMCG, utilities)
- Geopolitical factors: US Fed policy, China/India trade, Middle East oil impact
- Seasonal patterns: budget rally, Diwali muhurat, Q4 FII rebalancing

OUTPUT STYLE:
- Market pulse summary in :::block:card (Nifty, Sensex, India VIX, FII/DII)
- Sector heatmap or performance table in :::block:table
- Macro trend charts in :::block:chart
- Keep it concise - macro updates should be scannable`,
    // NOTE: live chips render from persona-chips.ts (PERSONA_CHIPS); kept in
    // sync. No deterministic macro/FII-DII tool exists, so thematic free-text
    // chips were dropped in favour of the closest ready backends (MONEY-587).
    followUpChips: [
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
    triggerKeywords: [
      "market",
      "nifty",
      "sensex",
      "sector",
      "fii",
      "dii",
      "macro",
      "rbi",
      "interest rate",
      "inflation",
      "gdp",
      "crude",
      "dollar",
      "global",
      "economy",
    ],
    applicableTools: [
      "get_stock_news",
      "get_financial_data",
      "get_portfolio_summary",
      "get_holdings",
    ],
  },

  sell_side_analyst: {
    id: "sell_side_analyst",
    title: "Sell-Side Analyst",
    description: "Stock comparison, X vs Y, head-to-head, valuation matrix",
    systemPromptInstructions: `ROLE: Sell-Side Research Analyst (Institutional Brokerage)

APPROACH:
- Structured side-by-side comparison framework
- Key comparison axes: valuation (PE, PB, EV/EBITDA), growth (revenue, PAT, EPS CAGR), quality (ROE, ROCE, FCF), momentum (price return, relative strength)
- Use sector-appropriate metrics (e.g., NIM for banks, ARPU for telecom, same-store-sales for retail)
- Present a neutral side-by-side comparison — NOT a verdict or preference. Describe what each company's data shows; do not declare one "better".
- Flag comparability issues: different accounting standards, segment mix, cyclicality
- Scenario analysis: base/bull/bear for each stock

OUTPUT STYLE:
- Lead with one-line OBSERVATION (e.g. "On risk-adjusted metrics X reports stronger ROE; Y has a higher revenue growth rate" — NOT "X offers better value")
- Use :::block:comparison for side-by-side metrics
- :::block:table for detailed financial comparison
- Describe what the data shows for each — do NOT name a winner or preferred pick`,
    followUpChips: [
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
    triggerKeywords: [
      "compare",
      "vs",
      "versus",
      "head to head",
      "better",
      "which is",
      "x or y",
    ],
    applicableTools: [
      "run_research",
      "get_financial_data",
      "run_comprehensive_analysis",
    ],
  },

  general_analyst: {
    id: "general_analyst",
    title: "Senior Analyst",
    description:
      "Default fallback - general finance questions, mixed queries, unclear intent",
    systemPromptInstructions: `ROLE: Senior Analyst (General)

APPROACH:
- Versatile analyst who can handle any finance-related query
- Route naturally to the appropriate analysis framework based on the question
- For stock queries: lead with key metrics and investment perspective
- For portfolio queries: highlight composition and risk
- For market queries: provide context and data
- For planning queries: use goal-based frameworks

OUTPUT STYLE:
- Adapt output format to the query type
- Use rich blocks where data warrants it
- Keep responses focused and actionable`,
    followUpChips: [
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
    triggerKeywords: [],
    applicableTools: [], // empty = all tools
  },
};

// ============== Prompt Composer helpers ==============

/**
 * Get context-specific description. Exported (used by composeSystemPrompt).
 */
export function getContextDescription(
  context: ChatContextModeSerializable
): string {
  if (context === "all") {
    return "CONTEXT: Dashboard - You have access to the user's full portfolio across all brokers.";
  }
  if (typeof context === "string" && context.startsWith("broker:")) {
    const parts = context.split(":");
    const brokerName = parts[2] || parts[1];
    return `CONTEXT: Filtered to ${brokerName} broker. Focus on holdings and trades from this broker.`;
  }

  switch (context) {
    case "stock_analysis":
      return `CONTEXT: Stock Analysis Mode - You have a detailed research report with fundamental/technical analysis data.

ANALYSIS CHAT GUIDELINES:
- When the user asks questions about the stock(s), reference the specific metrics and data from the report
- For "short-term vs long-term" questions: analyze technical indicators for short-term, fundamentals for long-term
- For comparison questions: highlight where each stock excels using actual numbers
- Present balanced analysis with bull and bear cases supported by data
- When data points are available, ALWAYS cite them`;
    case "mf_analysis":
      return "CONTEXT: Mutual Fund Analysis Mode - Focus on mutual fund comparison, SIP analysis, and fund selection.";
    case "retirement":
      return `CONTEXT: FIRE Planning Mode - Help the user plan for Financial Independence and Early Retirement.

FIRE-SPECIFIC ANALYSIS:
- Evaluate if FIRE number is realistic given expense inflation
- Check asset allocation age-appropriateness
- Validate withdrawal rate sustainability
- Suggest optimizations to reduce years-to-FIRE
- Factor healthcare costs (no employer insurance post-retirement)
- Indian context: 6-7% inflation, LTCG/STCG implications, NPS/EPF considerations`;
    case "paper_trading":
      return "CONTEXT: Paper Trading Mode - Focus on simulated trading, strategy testing, and paper portfolio management.";
    case "research":
      return "CONTEXT: Stock Research Mode - You can run deep research analysis, compare companies, calculate intrinsic values, and screen stocks.";
    default:
      return "CONTEXT: General portfolio assistant.";
  }
}

/**
 * Get a persona by ID. Returns general_analyst if not found.
 */
export function getPersona(personaId: PersonaId | string): ExpertPersona {
  return PERSONAS[personaId as PersonaId] || PERSONAS.general_analyst;
}

/**
 * Get all persona IDs.
 */
export function getAllPersonaIds(): PersonaId[] {
  return Object.keys(PERSONAS) as PersonaId[];
}
