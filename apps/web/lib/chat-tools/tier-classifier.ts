/**
 * Tier Classifier - FALLBACK ONLY
 *
 * This regex-based classifier is used ONLY when Flash classification fails.
 * The primary classifier is `classifyIntentWithFlash()` in intent-mapper.ts,
 * which understands natural language and has full tool context.
 *
 * Classifies every user message into L1 (Flash), L2 (Deep Dive), or L3 (Comprehensive)
 * analysis tiers using fast regex-based heuristics. No LLM call needed.
 *
 * Also maps tiers to credit actions for the unified credit system.
 *
 * L1: Single metric/fact, definitions, quick lookups - 0 credits, <5s
 * L2: "analyze", "research", @mention, skill keywords - 1-3 credits, ~2min
 * L3: "comprehensive", "full analysis", multi-stock deep compare - 3-10 credits, 5-25min
 */

import { RESEARCH_TIERS, type ResearchTierDef } from "./research-tiers";

// The chat classifier only auto-routes L1/L2/L3. L4 (12-segment institutional)
// and custom are EXPLICIT tiers selected in the analysis UI — they live in the
// RESEARCH_TIERS registry (research-tiers.ts), not in this chat union.
export type AnalysisTier = "L1" | "L2" | "L3";

/** Credit action string that maps to CREDIT_COSTS */
export type CreditAction =
  | "l1_flash"
  | "l1_definition"
  | "follow_up"
  | "portfolio_query"
  | "l2_research_fast"
  | "l2_research_advanced"
  | "l2_earnings_analysis"
  | "l2_financial_deep_dive"
  | "l2_investment_thesis"
  | "l2_dcf_valuation"
  | "l2_stock_screener"
  // MONEY-619 (Phase 2): a free chat turn upgraded to "thinking" mode (the
  // tier's Pro model). The classifier never emits this — the chat route
  // assigns it when the user opts into thinking — so it's deliberately not
  // in any L*_PATTERNS and not in L1_FREE_CREDIT_ACTIONS (it's a paid turn).
  | "l2_chat_thinking"
  | "l3_comprehensive_stock"
  | "l3_multi_comparison_base"
  | "l3_portfolio_optimization";

/**
 * L3 keywords - explicit deep analysis requests
 */
const L3_PATTERNS: RegExp[] = [
  /\b(comprehensive|full\s+analysis|complete\s+analysis|institutional)\b/i,
  /\b(detailed\s+report|exhaustive|in-depth\s+report)\b/i,
  /\bportfolio\s+optimization\b/i,
  // Multi-stock deep compare: "compare X, Y, Z in detail"
  /\b(compare|comparison)\b.*\b(in\s+detail|detailed|comprehensive|head\s+to\s+head)\b/i,
  // 3+ stock comparison (e.g., "TCS vs INFY vs WIPRO vs HCL")
  /\b[A-Z]{2,15}\s+(?:vs\.?|versus)\s+[A-Z]{2,15}\s+(?:vs\.?|versus)\s+[A-Z]{2,15}\b/i,
];

/**
 * L2 keywords - research/analysis requests that need the research agent or screener
 */
const L2_PATTERNS: RegExp[] = [
  /\b(analyz|analyse|research|evaluate)\w*/i,
  /\bshould\s+i\s+(buy|sell|invest|hold)\b/i,
  /\b(dcf|valuation|intrinsic\s+value|fair\s+value)\b/i,
  /\b(deep\s+dive|thorough)\b/i,
  /\b(bull\s+case|bear\s+case|investment\s+thesis)\b/i,
  /\b(earnings\s+analysis|financial\s+deep\s+dive|balance\s+sheet\s+analysis)\b/i,
  /\b(cash\s+flow\s+quality|accounting\s+quality)\b/i,
  /\b(screen|filter|find)\s+(stocks?|companies|shares)\b/i,
  /\b(sector\s+analysis|peer\s+comparison)\b/i,
  // @mention triggers research
  /\[Mentioned:\s*@[A-Z]/i,
  // "X vs Y" comparison (2 stocks)
  /\b[A-Z]{2,15}\s+(?:vs\.?|versus|compared?\s*(?:to|with))\s+[A-Z]{2,15}\b/i,
  // Explicit research commands
  /\b(look\s+into|check\s+out|tell\s+me\s+about)\b.*\b(stock|share|company)\b/i,
  /\b(future|outlook|prospects?|growth\s+potential)\b.*\b(of|for)\b/i,
  /\bgood\s+to\s+(buy|sell|hold|invest)\b/i,
  /\b(details?|information|info)\b.*\b(share|stock|company)\b/i,
  // Screener - natural language stock filtering (catches what "screen/filter/find" misses)
  /\b(list|show|give|share)\b.*\bstocks?\b.*\b(with|where|having|below|above|under|over|<|>)\b/i,
  /\bstocks?\b.*\b(rsi|pe|pb|roe|roce|debt|macd|sma|ema|volume|market\s*cap)\b.*\d/i,
  /\b(nifty\s*(?:50|100|200|500)|large\s*cap|mid\s*cap|small\s*cap)\b.*\b(stocks?|with|where)\b/i,
  /\b(undervalued|overvalued|oversold|overbought|high\s*dividend|low\s*pe|high\s*roe)\b.*\b(stocks?|companies|in\s*nifty)\b/i,
  // Risk, tax, compare - analytical tools
  /\b(portfolio|my)\s*(risk|risky|volatile|volatility)\b/i,
  /\b(var|value\s*at\s*risk|sharpe|sortino|drawdown|rebalanc)\b/i,
  /\b(capital\s*gains?|tax)\s*(report|comput|calculat|harvest)/i,
  /\b(stcg|ltcg)\s*(tax|capital)/i,
  /\b(compare|comparison)\b.*\b(stock|company|share|fund)\b/i,
];

/**
 * Follow-up patterns - questions about an already-completed analysis
 */
const FOLLOW_UP_PATTERNS: RegExp[] = [
  /\b(explain|what\s+does|what\s+did|what\s+about|tell\s+me\s+more)\b.*\b(above|report|analysis|result|score|rating)\b/i,
  /\b(the\s+dcf|the\s+m-?score|the\s+z-?score|the\s+report|the\s+roast)\b/i,
  /\bwhat\s+(does|did)\s+(this|that|it)\s+(mean|show|indicate|suggest)\b/i,
  /\b(clarify|elaborate|expand\s+on|break\s+down)\b/i,
  /\b(why\s+is|why\s+did|how\s+come)\b.*\b(score|rating|recommendation)\b/i,
];

/**
 * Classify a user message into an analysis tier.
 *
 * Priority: L3 > L2 > L1 (check most specific first)
 *
 * @param message - The user's chat message
 * @param pagePath - Current page path (for context hints)
 * @param context - Optional chat context mode
 * @returns The analysis tier
 */
export function classifyTier(
  message: string,
  pagePath: string,
  context?: string
): AnalysisTier {
  const msg = message.trim();

  // L3: Check comprehensive patterns first (most specific)
  for (const pattern of L3_PATTERNS) {
    if (pattern.test(msg)) {
      return "L3";
    }
  }

  // L2: Check research/analysis patterns
  for (const pattern of L2_PATTERNS) {
    if (pattern.test(msg)) {
      return "L2";
    }
  }

  // L1: Everything else - quick facts, definitions, simple lookups
  return "L1";
}

/**
 * Check if a query is eligible for L1 Flash (free tier).
 * L1 is free for ALL plans including FREE, rate-limited by existing limiter.
 */
export function isFlashEligible(tier: AnalysisTier): boolean {
  return tier === "L1";
}

/**
 * Map a classifier tier to its canonical registry definition (MONEY-612).
 * `research-tiers.ts` is the single source of truth for tier metadata
 * (label, model, segment count, credit action, free) — used by the UI tier
 * picker and the analysis layer so the L1–L4 distinction stays consistent.
 */
export function describeTier(tier: AnalysisTier): ResearchTierDef {
  return RESEARCH_TIERS[tier.toLowerCase() as keyof typeof RESEARCH_TIERS];
}

/**
 * Detect if a message is a follow-up about a completed analysis.
 * Follow-ups cost 0 credits - they're served from cached report + Flash.
 */
export function isFollowUp(message: string, hasExistingChat: boolean): boolean {
  if (!hasExistingChat) return false;

  const msg = message.trim();
  return FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(msg));
}

/**
 * Map a tier + message intent to a credit action string.
 * The action string maps to CREDIT_COSTS for pricing.
 */
export function determineCreditAction(
  tier: AnalysisTier,
  message: string,
  options?: {
    hasExistingChat?: boolean;
    isToolExecution?: boolean;
  }
): CreditAction {
  // Follow-up detection - free
  if (options?.hasExistingChat && isFollowUp(message, true)) {
    return "follow_up";
  }

  // L1: always free
  if (tier === "L1") {
    return "l1_flash";
  }

  // L3: map to specific action
  if (tier === "L3") {
    const msg = message.toLowerCase();
    if (/portfolio\s+optimization/i.test(msg)) {
      return "l3_portfolio_optimization";
    }
    if (/\b(compare|comparison|vs\.?|versus)\b/i.test(msg)) {
      return "l3_multi_comparison_base";
    }
    return "l3_comprehensive_stock";
  }

  // L2: determine sub-action by intent
  const msg = message.toLowerCase();

  if (/\b(dcf|valuation|intrinsic\s+value|fair\s+value)\b/i.test(msg)) {
    return "l2_dcf_valuation";
  }
  if (/\b(earnings\s+analysis|quarterly\s+results|earnings)\b/i.test(msg)) {
    return "l2_earnings_analysis";
  }
  if (/\b(financial\s+deep\s+dive|balance\s+sheet|financials)\b/i.test(msg)) {
    return "l2_financial_deep_dive";
  }
  if (/\b(investment\s+thesis|bull\s+case|bear\s+case)\b/i.test(msg)) {
    return "l2_investment_thesis";
  }
  if (/\b(screen|filter|find)\s+(stocks?|companies|shares)\b/i.test(msg)) {
    return "l2_stock_screener";
  }
  if (/\bstocks?\b.*\b(rsi|pe|pb|roe|roce|macd)\b.*\d/i.test(msg)) {
    return "l2_stock_screener";
  }
  if (/\b(list|show|share)\b.*\bstocks?\b.*\b(with|where|<|>)\b/i.test(msg)) {
    return "l2_stock_screener";
  }
  if (
    /\b(undervalued|oversold|overbought|nifty\s*50)\b.*\bstocks?\b/i.test(msg)
  ) {
    return "l2_stock_screener";
  }

  // Default L2: "fast" research (1 credit)
  return "l2_research_fast";
}

/**
 * Free-chat lock for L1 turns (MONEY-224).
 *
 * Why this exists:
 *   The "free chat" promise on the landing page depends on `l1_flash` having
 *   cost 0 in `CREDIT_COSTS` AND on the credit action staying l1_flash from
 *   classification through `consumeCredits`. As the route grows (slash
 *   commands, persistent style, prior-turn context, custom focus, future
 *   features), there's a real risk of a future change accidentally
 *   reclassifying a casual L1 chat as `l2_research_*` and silently charging
 *   a free user - or worse, blocking them entirely when they're out of
 *   credits.
 *
 * What it does:
 *   - When a turn was originally classified L1 with no toolExecution and no
 *     fast-path intent, this guard refuses any later attempt to upgrade
 *     `creditAction` to a non-zero-cost tier.
 *   - Logs a warning so the regression is observable, then forces back to
 *     `l1_flash`.
 *   - Returns the safe action so the caller can use the result.
 *
 * Caller pattern:
 *   ```
 *   creditAction = determineCreditAction(tier, ...);
 *   const wasL1 = tier === "L1" && !toolExecution && !inputValidation.fastIntent;
 *   creditAction = assertL1Sticky({
 *     proposed: creditAction,
 *     wasOriginallyL1: wasL1,
 *     requestId,
 *   });
 *   ```
 */
const FREE_ACTIONS: ReadonlySet<CreditAction> = new Set<CreditAction>([
  "l1_flash",
  "l1_definition",
  "follow_up",
  "portfolio_query",
]);

export function assertL1Sticky(args: {
  proposed: CreditAction;
  wasOriginallyL1: boolean;
  requestId?: string;
}): CreditAction {
  if (!args.wasOriginallyL1) return args.proposed;
  if (FREE_ACTIONS.has(args.proposed)) return args.proposed;

  // Tier was L1 at classification time but something downstream wants to
  // charge for it. Refuse + warn - never silently bill a free L1 turn.
  console.warn(
    "[free-chat-guard] Refused L1→%s upgrade for request %s - forcing l1_flash. " +
      "If this was intentional (e.g. a slash command that promotes a free chat " +
      "to research), update the caller to pass wasOriginallyL1=false.",
    args.proposed,
    args.requestId ?? "(no-id)"
  );
  return "l1_flash";
}

/** Read-only view of free actions for tests + introspection. */
export const L1_FREE_CREDIT_ACTIONS = FREE_ACTIONS;
