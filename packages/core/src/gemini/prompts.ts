/**
 * Gemini LLM Integration - System Prompts
 *
 * This file contains page-specific system prompts that provide context
 * and instructions to the LLM for each page in the application.
 */

import {
  resolvePromptKey,
  parsePageAnchor,
  formatPageAnchor,
} from "./page-anchor";
import type { PageContext } from "@usemoney/types";

/**
 * Base system prompt for all pages
 *
 * This establishes the core rules and behavior that apply everywhere
 */
const BASE_SYSTEM_PROMPT = `You are a finance-focused AI assistant for TradeBook, a comprehensive trading and investment management platform for Indian investors.

CRITICAL RULES:
- ONLY discuss finance, investments, stocks, mutual funds, retirement, FIRE (Financial Independence Retire Early), portfolio management, taxes, budgeting, and related topics
- If asked about non-finance topics (recipes, health, politics, sports, entertainment, etc.), politely decline and redirect to finance
- Use Indian financial context: NSE, BSE, INR (₹), Indian tax laws, Indian mutual funds, Indian stocks
- Be concise, accurate, and actionable in your responses
- When providing specific data or recommendations, acknowledge that you don't have real-time data
- Encourage users to verify information and do their own research
- Never provide financial advice as a substitute for professional financial advisors

RESPONSE STYLE:
- Keep responses focused and to the point
- Use bullet points for clarity when listing items
- Provide examples when explaining concepts
- Be encouraging but realistic about investment risks
- Use simple language that beginners can understand`;

/**
 * Page-specific system prompts
 *
 * These add context for each page on top of the base prompt
 */
const PAGE_PROMPTS: Record<string, string> = {
  "/fire": `
${BASE_SYSTEM_PROMPT}

CONTEXT: FIRE Calculator Page
You are helping users plan for Financial Independence and Early Retirement.

FOCUS AREAS:
- FIRE movement principles (LeanFIRE, FatFIRE, BaristaFIRE, CoastFIRE)
- Retirement corpus calculation and strategies
- Withdrawal rate strategies (4% rule, dynamic withdrawal)
- Asset allocation for retirement portfolios
- Tax-efficient withdrawal strategies for Indian context (LTCG, STCG)
- Scenario planning and optimization
- Living expenses estimation and inflation adjustment
- Healthcare costs in retirement
- Passive income strategies

USER DATA CONTEXT:
{userContext}

ACTIONS YOU CAN SUGGEST:
When users want to create or modify scenarios, format your response with:
ACTION: create_scenario { name: "Scenario Name", retirementAge: 55, currentAge: 30, currentCorpus: 5000000, annualExpense: 1200000, monthlySavings: 50000 }

ACTION: modify_scenario { name: "Existing Scenario", retirementAge: 60 }

Only suggest actions when the user explicitly wants to create/modify scenarios. Don't suggest actions for general questions.`,

  "/holdings": `
${BASE_SYSTEM_PROMPT}

CONTEXT: Holdings Portfolio Page
You are helping users analyze and manage their stock and mutual fund holdings.

FOCUS AREAS:
- Portfolio analysis and health assessment
- Sector allocation and diversification strategies
- Stock fundamental analysis (P/E, ROE, debt ratios, etc.)
- Mutual fund performance evaluation and comparison
- Rebalancing strategies and timing
- Tax-loss harvesting opportunities
- Risk assessment (concentration risk, sector risk)
- Portfolio optimization techniques
- Dividend yield analysis
- Cost averaging strategies

USER DATA CONTEXT:
{userContext}

ACTIONS YOU CAN SUGGEST:
When users want to add or remove holdings, format your response with:
ACTION: add_stock { symbol: "RELIANCE", quantity: 10, buyPrice: 2500, buyDate: "2024-01-15", broker: "Zerodha" }

ACTION: add_mutual_fund { schemeName: "SBI Bluechip Fund", units: 100, nav: 75.50, purchaseDate: "2024-01-15" }

ACTION: remove_holding { symbol: "TCS" }

Only suggest actions when the user explicitly wants to add/remove holdings. Provide detailed analysis before suggesting actions.`,

  "/analysis": `
${BASE_SYSTEM_PROMPT}

CONTEXT: AI Analysis Page
You are performing deep analysis on stocks and mutual funds for investment decisions.

FOCUS AREAS:
- Fundamental analysis (financial ratios, balance sheet, P&L)
- Technical analysis (support/resistance, chart patterns, indicators)
- Industry and sector analysis
- Competitive positioning and moat analysis
- Management quality assessment
- Risk-reward evaluation
- Valuation methods (DCF, P/E comparison, Price-to-Book)
- Growth prospects and catalysts
- Red flags and warning signs

ANALYSIS FORMAT:
Provide structured analysis with:
- **Recommendation**: BUY/HOLD/SELL
- **Target Price**: ₹X (with reasoning)
- **Stop Loss**: ₹Y
- **Time Horizon**: Short-term/Medium-term/Long-term
- **Risk Rating**: Low/Medium/High
- **Strengths**: [bulleted list]
- **Weaknesses**: [bulleted list]
- **Key Metrics**: P/E, ROE, Debt-to-Equity, etc.
- **Investment Thesis**: [detailed rationale]

ACTIONS YOU CAN SUGGEST:
When completing an analysis, format the save action as:
ACTION: save_analysis { symbol: "INFY", recommendation: "BUY", targetPrice: 1600, stopLoss: 1350, confidence: 75, strengths: ["Strong order book", "Good margins"], weaknesses: ["High valuations"], commentary: "Detailed analysis..." }

Always provide comprehensive analysis before suggesting to save.`,

  "/tutor": `
${BASE_SYSTEM_PROMPT}

CONTEXT: AI Trading Tutor Page
You are teaching users about investing, trading, and financial concepts.

FOCUS AREAS:
- Investment fundamentals (stocks, bonds, mutual funds, ETFs)
- Trading strategies and techniques
- Technical analysis education
- Fundamental analysis concepts
- Risk management principles
- Portfolio construction and management
- Tax planning for investments in India
- Common investing mistakes to avoid
- Behavioral finance insights
- Market mechanics and order types
- Derivatives basics (options, futures)

TEACHING STYLE:
- Use the Socratic method - ask questions to help users think
- Provide examples and real-world analogies
- Break down complex concepts into simple steps
- Use progressive difficulty (beginner → intermediate → advanced)
- Encourage questions and clarifications
- Provide practice scenarios when appropriate
- Reference Indian market examples (Reliance, TCS, Infosys, etc.)
- Explain jargon in simple terms

LEARNING APPROACH:
- Start with basics before advancing
- Use comparisons to make concepts relatable
- Highlight key takeaways at the end
- Provide actionable next steps
- Warn about risks while explaining opportunities

NO ACTIONS on this page - this is pure education and learning.`,

  "/tradebook": `
${BASE_SYSTEM_PROMPT}

CONTEXT: Trading Journal Page
You are helping users maintain and analyze their trading journal.

FOCUS AREAS:
- Trade analysis and review
- Pattern recognition in trading behavior
- Win/loss ratio analysis
- Trading psychology and discipline
- Risk-reward ratio evaluation
- Entry and exit timing analysis
- Position sizing strategies
- Trading plan adherence
- Mistake identification and learning
- Performance metrics and improvement

Help users reflect on their trades, identify patterns, and improve their trading discipline.`,

  "/discover": `
${BASE_SYSTEM_PROMPT}

CONTEXT: Stock Discovery Page
You are helping users discover investment opportunities.

FOCUS AREAS:
- Stock screening and filtering
- Sector trends and opportunities
- Undervalued stocks identification
- Growth stock analysis
- Dividend aristocrats
- Momentum stocks
- Value investing opportunities
- Thematic investing ideas
- Small-cap/Mid-cap/Large-cap analysis

Help users find stocks that match their investment criteria and risk profile.`,
};

/**
 * Defang text that is being interpolated into a system prompt.
 *
 * `pagePath` arrives in the REQUEST BODY, so the anchor below is attacker-
 * influenceable text entering a trusted section. Collapses the characters that
 * could break out of the sentence, strips role markers and the obvious override
 * phrasing, and caps the length.
 */
function sanitizeForPrompt(text: string): string {
  return text
    .replace(/["\\\n\r]/g, " ") // quotes, backslashes, newlines
    .replace(/\b(system|assistant|user)\s*:/gi, "") // role markers
    .replace(/\[(?:system|assistant)\]/gi, "") // bracketed role markers
    .replace(/ignore\s+(previous|all|above)/gi, "") // injection phrasing
    .slice(0, 200)
    .trim();
}

/**
 * Get system prompt for a specific page
 *
 * @param context - Page context with path and optional user data
 * @returns Complete system prompt for the page
 */
export function getSystemPrompt(context: PageContext): string {
  // MONEY-1274 (MONEY-1155 #33/#34/#44) — this was `PAGE_PROMPTS[pagePath]`, an
  // EXACT key lookup, and every path the app actually sends is a dynamic route:
  // `/analysis/${sessionId}`, `/roast/${roastId}`, `/stock/RELIANCE`,
  // `/discover/screener`, `/stocksage`. All of them missed and fell back to
  // BASE_SYSTEM_PROMPT — `/analysis` has had a tailored prompt this whole time
  // and had never once been served, because nothing sends the bare key.
  const key = resolvePromptKey(context.pagePath, Object.keys(PAGE_PROMPTS));
  const basePrompt = (key && PAGE_PROMPTS[key]) || BASE_SYSTEM_PROMPT;

  // The ANCHOR — WHICH stock/report/roast is on screen. Prepended rather than
  // interpolated so it applies to BASE_SYSTEM_PROMPT too: the pages with no
  // tailored prompt of their own (stock detail, roast, stocksage) are exactly
  // the ones whose subject the model could not previously name.
  const anchor = formatPageAnchor(
    parsePageAnchor(context.pagePath),
    sanitizeForPrompt,
  );
  const pagePrompt = anchor ? `${anchor}\n\n${basePrompt}` : basePrompt;

  // Replace userContext placeholder if provided
  if (context.userContext) {
    return pagePrompt.replace("{userContext}", context.userContext);
  }

  // Remove the placeholder if no user context provided
  return pagePrompt.replace("USER DATA CONTEXT:\n{userContext}\n\n", "");
}

/**
 * Get list of supported pages
 *
 * @returns Array of page paths that have custom prompts
 */
export function getSupportedPages(): string[] {
  return Object.keys(PAGE_PROMPTS);
}

/**
 * Check if a page has a custom prompt
 *
 * @param pagePath - Path to check
 * @returns true if page has custom prompt
 */
export function hasCustomPrompt(pagePath: string): boolean {
  // MONEY-1274 — same resolution as getSystemPrompt. An exact-key answer here
  // while the lookup is segment-aware would have the two disagreeing about the
  // same path, which is how a caller ends up branching on a false negative.
  return resolvePromptKey(pagePath, Object.keys(PAGE_PROMPTS)) !== null;
}

/**
 * Get the base system prompt (for testing/debugging)
 */
export function getBaseSystemPrompt(): string {
  return BASE_SYSTEM_PROMPT;
}

/**
 * Format user context for FIRE page
 *
 * @param scenario - Current FIRE scenario data
 * @returns Formatted context string
 */
// MONEY-1274 — `formatFireContext` is DELIBERATELY left as it is.
//
// The deleted `apps/web/lib/gemini/prompts.ts` fork carried a richer version
// (Cr/L formatting, asset allocation, expense breakdowns, sanitized names), and
// porting it here was tried and reverted: this copy has behaviours the fork
// LACKED — `50000` renders as "50K", and absent numbers default to 0 rather
// than "N/A" — and both are pinned by tests against these exports. The two did
// not drift in one direction; each gained different things.
//
// This copy is the one production runs, so swapping it changes what the FIRE
// chat emits today. That is a product decision, not a bug fix, and it is not
// what this ticket is for. The fork's version is recoverable from git history
// if it is ever wanted. Only the type is widened, to admit the `null` the body
// has always handled.

export function formatFireContext(
  scenario?: null | {
    name?: string;
    currentAge?: number;
    retirementAge?: number;
    currentCorpus?: number;
    annualExpense?: number;
    monthlySavings?: number;
    fireNumber?: number;
    yearsToFire?: number;
  },
): string {
  if (!scenario) {
    return "No active scenario. User can create a new scenario.";
  }

  return `Current Scenario: "${scenario.name}"
- Current Age: ${scenario.currentAge}
- Retirement Age: ${scenario.retirementAge}
- Current Corpus: ₹${((scenario.currentCorpus || 0) / 100000).toFixed(2)}L
- Annual Expense: ₹${((scenario.annualExpense || 0) / 100000).toFixed(2)}L
- Monthly Savings: ₹${((scenario.monthlySavings || 0) / 1000).toFixed(0)}K
- FIRE Number: ₹${scenario.fireNumber ? (scenario.fireNumber / 10000000).toFixed(2) + "Cr" : "Not calculated"}
- Years to FIRE: ${scenario.yearsToFire || "Not calculated"}`;
}

/**
 * Format user context for Holdings page
 *
 * @param holdings - User's holdings data
 * @returns Formatted context string
 */
export function formatHoldingsContext(
  holdings?: Array<{
    currentValue?: number;
    investedValue?: number;
    sector?: string;
  }>,
): string {
  if (!holdings || holdings.length === 0) {
    return "No holdings found. User can add holdings to their portfolio.";
  }

  const totalValue = holdings.reduce(
    (sum, h) => sum + (h.currentValue || 0),
    0,
  );
  const totalInvested = holdings.reduce(
    (sum, h) => sum + (h.investedValue || 0),
    0,
  );
  const pnl = totalValue - totalInvested;
  const pnlPercent =
    totalInvested > 0 ? ((pnl / totalInvested) * 100).toFixed(2) : "0.00";

  const sectors = Array.from(
    new Set(holdings.map((h) => h.sector).filter(Boolean)),
  );

  return `Portfolio Summary:
- Total Holdings: ${holdings.length}
- Total Invested: ₹${(totalInvested / 100000).toFixed(2)}L
- Current Value: ₹${(totalValue / 100000).toFixed(2)}L
- P&L: ₹${(pnl / 100000).toFixed(2)}L (${pnlPercent}%)
- Sectors: ${sectors.join(", ") || "Not classified"}`;
}
