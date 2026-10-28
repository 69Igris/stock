/**
 * Intent Mapper
 *
 * Two-phase intent detection:
 * 1. Fast path: regex for simple data-fetch queries (holdings, trades, positions, MFs, FIRE, news)
 * 2. Flash path: LLM classification for analytical queries (research, screener, comparison, risk, tax)
 *
 * The fast path handles ~30% of queries instantly (no LLM call).
 * Everything else goes through Flash for proper understanding.
 */

export interface IntentMatch {
  tool: string;
  params: Record<string, unknown>;
  confidence: number;
  /** Persona ID resolved by Flash or keyword matching */
  persona?: string;
  /** Analysis tier resolved by Flash - overrides regex tier classifier */
  tier?: "L1" | "L2" | "L3";
}

/**
 * Pull a fund's display name out of the serialized @-mention the chat UI
 * injects — `@<symbol> (<name>, <exchange>)` (see ChatPromptArea's
 * handleSubmit + StockMentionPicker). Used to build a `[MUTUAL_FUND] <name>`
 * research query for a fund mention. Returns null when the mention is a bare
 * `@<symbol>` with no parenthetical, so the caller can fall back to the code.
 */
function parseMentionName(message: string, symbol: string): string | null {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `@<symbol> (<name>, <exchange>)` — capture greedily up to the LAST
  // ", <exchange>)" so a fund name that itself contains parentheses / commas
  // (e.g. "ICICI ... (erstwhile Bluechip Fund) - Direct Plan") isn't truncated
  // at an inner ")". The exchange token has no commas/parens by construction.
  const m = message.match(
    new RegExp(`@${escaped}\\s*\\((.+),\\s*[^,()]+\\)`, "i")
  );
  if (!m) return null;
  return m[1]!.trim() || null;
}

/**
 * FAST-PATH PATTERNS - Only simple, unambiguous data-fetch queries.
 *
 * These patterns trigger direct tool execution without any LLM call.
 * They ONLY match queries where the intent is crystal clear and no
 * natural language interpretation is needed.
 *
 * Everything analytical (research, screener, comparison, risk, tax,
 * financial data) goes through Flash for proper understanding.
 */
const INTENT_PATTERNS: {
  pattern: RegExp;
  tool: string;
  extractParams?: (match: RegExpMatchArray) => Record<string, unknown>;
}[] = [
  // ── Portfolio Roast ────────────────────────────────────────────────
  // MUST come before get_portfolio_summary - that pattern catches any
  // mention of "portfolio", which would shadow "roast my portfolio".
  // Matches: "roast my portfolio", "roast me", "rate my portfolio",
  // "score my holdings", "critique my portfolio".
  {
    pattern:
      /\broast\b.*\b(my|portfolio|holdings|me)\b|\b(my|portfolio|holdings)\b.*\broast\b|^\s*roast\s+me\s*$/i,
    tool: "start_roast",
    extractParams: (match) => {
      const msg = (match.input || "").toLowerCase();
      const assetType = /\bmutual\s*fund|\bmf\b|\bsip\b/.test(msg)
        ? "mf"
        : /\bstocks?\b|\bequit/.test(msg)
          ? "stocks"
          : "all";
      const broker = /\bzerodha\b/.test(msg)
        ? "ZERODHA"
        : /\bupstox\b/.test(msg)
          ? "UPSTOX"
          : /\bgroww\b/.test(msg)
            ? "GROWW"
            : /\bdhan\b/.test(msg)
              ? "DHAN"
              : /\bfyers\b/.test(msg)
                ? "FYERS"
                : /\bangel\b/.test(msg)
                  ? "ANGEL_ONE"
                  : undefined;
      return {
        mode: broker ? "broker" : "overall",
        ...(broker && { broker }),
        assetType,
      };
    },
  },
  {
    pattern:
      /\b(rate|score|critique|review|grade)\s+my\s+(portfolio|holdings)\b/i,
    tool: "start_roast",
    extractParams: () => ({ mode: "overall", assetType: "all" }),
  },

  // ── Market / indices / macro (MONEY-587) ──────────────────────────
  // MUST come before get_portfolio_summary + get_holdings - those broad
  // patterns catch the bare word "overview" ("market overview") and
  // "my … holdings" ("similar to my top holdings"), collapsing macro and
  // screener queries onto the cheap portfolio/holdings tools. This guard
  // deterministically routes market/index/macro phrasing to research
  // (with the macro-analysis skill) so a "Market overview - Nifty/Sensex/
  // Bank Nifty, sector heatmap, FII/DII, gainers/losers" question gets a
  // real market briefing instead of a portfolio summary.
  //
  // Two ways to match: (a) explicit market-overview framing or a macro
  // signal (heatmap / FII-DII / gainers-losers), or (b) two distinct
  // index names co-occurring (a list ⇒ overview). A single index name
  // alone is intentionally NOT matched - "compare 360ONE vs NIFTY50" is a
  // peer comparison and must fall through to Flash.
  {
    pattern:
      /\b(?:market\s*(?:overview|today|summary|snapshot|update|movers|wrap|breadth)|how\s*(?:is|are|'s)\s*(?:the\s*)?(?:market|markets|nifty|sensex|bank\s*nifty|indices)|sector\s*heatmap|fii\s*[/&]?\s*dii|fii\b[^.?!\n]*\bdii\b|top\s*(?:gainers?|losers?)|gainers?\s*(?:and|&|\/)\s*losers?)|(?:\bnifty\b|\bsensex\b)[^.?!\n]*?(?:\bsensex\b|\bbank\s*nifty\b|\bnifty\s*bank\b|\bnifty\b)/i,
    tool: "run_research",
    extractParams: () => ({ skill: "macro-analysis", mode: "advanced" }),
  },

  // ── Screener: "screen for…" / "stocks similar to…" (MONEY-587) ─────
  // MUST come before get_holdings - "stocks similar to my top holdings"
  // and "screen for … same sector and fundamentals" otherwise match the
  // "\b(...|my)\b.*\bholdings?\b" holdings pattern and return the raw
  // holdings table instead of running a screen. Routes screen/similarity
  // phrasing to run_screener (the NL parser inside extracts the criteria).
  // Deliberately scoped to explicit "screen…" / "similar to…" / "same
  // sector and fundamentals" phrasing only - generic "find stocks with
  // <filter>" still defers to Flash (its existing contract) so this guard
  // doesn't widen the fast-path beyond the collapse it fixes.
  {
    pattern:
      /\b(?:screen\s+(?:for|stocks?|me|the)|stocks?\s+similar\s+to|similar\s+to\s+my\b[^.?!\n]*\b(?:holdings?|portfolio|stocks?)|same\s+sector\s+and\s+(?:fundamentals?|metrics?)|screener\b)/i,
    tool: "run_screener",
  },

  // ── Portfolio data ────────────────────────────────────────────────
  {
    pattern:
      /\b(portfolio|dashboard|summary|overview|total\s*value|net\s*worth)\b/i,
    tool: "get_portfolio_summary",
  },

  // ── Holdings ──────────────────────────────────────────────────────
  {
    pattern: /\b(show|get|list|display|my)\b.*\bholdings?\b/i,
    tool: "get_holdings",
  },
  {
    pattern:
      /\b(what|which)\s*(stocks?|shares?)\s*(do\s*i|am\s*i)\s*(own|hold|have)\b/i,
    tool: "get_holdings",
  },
  {
    pattern: /\bholdings?\b.*\b(show|get|list|display|see)\b/i,
    tool: "get_holdings",
  },
  // Broker-filtered holdings
  {
    pattern:
      /\b(zerodha|upstox|groww|dhan|fyers|angel)\s*(holdings?|stocks?|portfolio)\b/i,
    tool: "get_holdings",
    extractParams: (match) => ({
      broker: match[1]!.toUpperCase(),
    }),
  },

  // ── Positions ─────────────────────────────────────────────────────
  {
    pattern: /\b(show|get|list|display|my|open|active)\b.*\bpositions?\b/i,
    tool: "get_positions",
  },

  // ── Trades ────────────────────────────────────────────────────────
  {
    pattern: /\b(show|get|list|display|my|recent)\b.*\btrades?\b/i,
    tool: "get_trades",
  },
  {
    pattern: /\b(trade|trading)\s*(history|book|journal)\b/i,
    tool: "get_trades",
  },

  // ── FIRE SIP edit (MUST precede the mutual-fund fast path) ────────
  // "increase/set/… my SIP" is otherwise shadowed by the mutual-fund pattern
  // below (it matches "my … sip"). An imperative verb means a FIRE-plan EDIT
  // (SIP = the plan's monthly-savings input), so intercept it here. A LIST
  // phrasing ("show my SIP") has no imperative verb and still routes to funds.
  {
    pattern:
      /\b(set|change|update|increase|decrease|raise|lower|bump|reduce|adjust)\b.*\bsip\b/i,
    tool: "fire_plan",
    extractParams: (m) => ({ request: m.input ?? "", intent: "edit" }),
  },

  // ── Mutual Funds ──────────────────────────────────────────────────
  {
    pattern: /\b(show|get|list|display|my)\b.*\b(mutual\s*fund|mf|sip)s?\b/i,
    tool: "get_mutual_funds",
  },

  // ── FIRE Scenarios ────────────────────────────────────────────────
  {
    pattern:
      /\b(show|get|list|display|my)\b.*\b(fire|retirement)\s*(scenario|plan|calculation)s?\b/i,
    tool: "get_fire_scenarios",
  },
  {
    pattern: /\bfire\s*(number|goal|target)\b/i,
    tool: "get_fire_scenarios",
  },
  {
    // FIRE plan EDIT — "retire at/by N" is unambiguous retirement-plan intent,
    // so fast-path it to fire_plan. Broader edits ("increase my SIP", "set
    // equity to 70%") are left to the Flash `fire_edit` intent, since SIP /
    // allocation collide with the mutual-fund and portfolio fast paths.
    pattern: /\bretire\s+(at|by)\s+\d{2}\b/i,
    tool: "fire_plan",
    extractParams: (m) => ({ request: m.input ?? "", intent: "edit" }),
  },

  // ── Paper Trading ─────────────────────────────────────────────────
  {
    pattern:
      /\b(show|get|list|display|my)\b.*\b(paper|virtual|simulated)\s*(position|trade|portfolio)s?\b/i,
    tool: "get_paper_positions",
  },

  // ── Live web search (Gemini Google-Search grounding) ──────────────
  // Explicit "search the web / look it up online" phrasing routes to the
  // grounded web_search tool. Stock-symbol news ("news RELIANCE") stays on
  // get_stock_news below; this fast path only fires on unambiguous web-search
  // intent so it doesn't shadow the symbol-scoped news patterns.
  {
    pattern:
      /\b(search|look\s*up|google|find\s+online)\b.*\b(web|internet|online)\b/i,
    tool: "web_search",
  },
  {
    pattern:
      /\b(search\s+the\s+web|search\s+online|web\s+search|google\s+(?:for|it))\b/i,
    tool: "web_search",
  },

  // ── Stock News (fast, no credits) ─────────────────────────────────
  {
    pattern:
      /\b(news|headlines?|latest\s*news|recent\s*news)\b.*\b([A-Z][A-Z0-9&]{1,14})\b/i,
    tool: "get_stock_news",
    extractParams: (match) => ({
      symbol: (match[2] || "").toUpperCase(),
    }),
  },
  {
    pattern:
      /\b([A-Z][A-Z0-9&]{1,14})\b.*\b(news|headlines?|latest\s*news|what.s\s*happening)\b/i,
    tool: "get_stock_news",
    extractParams: (match) => ({
      symbol: (match[1] || "").toUpperCase(),
    }),
  },
  {
    pattern:
      /\bwhat.s\s*(new|happening|going\s*on)\s*(with|for|at)\s*([A-Z][A-Z0-9&]{1,14})\b/i,
    tool: "get_stock_news",
    extractParams: (match) => ({
      symbol: (match[3] || "").toUpperCase(),
    }),
  },
  {
    pattern: /\b(news|headlines?)\b.*\[Mentioned:\s*@([A-Z][A-Z0-9&_]+)/i,
    tool: "get_stock_news",
    extractParams: (match) => ({
      symbol: (match[2] || "").toUpperCase(),
    }),
  },

  // ── @Mention detection (triggers research) ────────────────────────
  // The symbol token allows a NUMERIC lead so mutual-fund scheme codes
  // (@121281) and numeric-leading tickers (@360ONE, @5PAISA) match — the
  // old `@[A-Z]…` class dropped both, so a fund mention fell through to the
  // Flash classifier, which mislabelled "Research @<fund>" as an mf_analysis
  // → get_mutual_funds list-dump instead of researching the fund (MONEY-1073).
  {
    pattern: /\[Mentioned:\s*@([A-Za-z0-9][A-Za-z0-9&_]+)/i,
    tool: "run_research",
    extractParams: (match) => {
      const mentionRegex = /@([A-Za-z0-9][A-Za-z0-9&_]+)/gi;
      const fullMsg = match.input || "";
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = mentionRegex.exec(fullMsg)) !== null) {
        seen.add(m[1]!.toUpperCase());
      }
      const symbols = Array.from(seen);

      // Mutual funds are @-mentioned by their numeric AMFI scheme code
      // (@121281); every stock / ETF ticker carries at least one letter. A
      // lone all-digits mention is therefore a fund — route it to the SAME
      // single-fund path the /mf ResearchModal uses (MONEY-446): `assetType:
      // "mf"` (forces the `mf-analysis` skill + bills the heavier mf_analysis
      // estimate in startResearchAction) plus a `[MUTUAL_FUND] …` query. The
      // query prefix is what makes startResearchAction skip the equity-only
      // InstrumentMapping validation — a bare scheme code is not a NSE/BSE
      // symbol and is otherwise rejected ("Symbol not found on NSE/BSE").
      // `skill` is set too as a defensive hint (works even if the executor
      // ever stops forwarding assetType). The `[MUTUAL_FUND] <name>` query is
      // built in classifyIntentFast below from the ORIGINAL-case message
      // (match.input here is lowercased).
      if (symbols.length === 1 && /^\d+$/.test(symbols[0]!)) {
        return {
          symbols,
          assetType: "mf",
          skill: "mf-analysis",
          mode: "advanced",
        };
      }

      // Deterministic depth detection - multi-stock is always advanced
      // (peer comparison). Single-stock falls back to "advanced" when the
      // user uses depth-cue keywords; otherwise we let the LLM classifier
      // decide. Without this, "@RELIANCE deep research" routes to fast mode
      // (~7 tasks) because the few-shot prompt only contains "deep analysis"
      // - a one-word difference flipped the plan from 23 tasks to 7.
      const depthCue =
        /\b(deep|comprehensive|detailed|in[-\s]?depth|thorough|full|complete)\b.*\b(research|analysis|analy[sz]e|valuation|study|review|dive|breakdown)\b/i.test(
          fullMsg
        ) || /\bdeep[-\s]?dive\b/i.test(fullMsg);
      const mentionMode =
        symbols.length > 1 ? "advanced" : depthCue ? "advanced" : undefined;
      return {
        symbols: symbols.length > 0 ? symbols : undefined,
        skill: symbols.length > 1 ? "peer-comparison" : undefined,
        mode: mentionMode,
      };
    },
  },

  // ── Documents ─────────────────────────────────────────────────────
  {
    pattern: /\b(my|show|list|get)\b.*\b(document|uploaded|file)s?\b/i,
    tool: "get_user_documents",
  },
  {
    pattern: /\b(annual\s*report|contract\s*note|broker\s*statement)s?\b/i,
    tool: "get_user_documents",
  },
  {
    pattern: /\bwhat.*\b(uploaded|document|file)s?\b/i,
    tool: "get_user_documents",
  },
];

/**
 * Fast-path intent classification using keyword matching.
 * Only handles unambiguous data-fetch queries.
 */
export function classifyIntentFast(message: string): IntentMatch | null {
  const normalized = message.toLowerCase().trim();

  for (const { pattern, tool, extractParams } of INTENT_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      const params = extractParams ? extractParams(match) : {};

      // For research tools, always include the user's message as the query.
      if (tool === "run_research" && !params.query) {
        // A single-fund mention (assetType "mf" + a lone numeric scheme code)
        // needs a `[MUTUAL_FUND] <name>` query: the prefix makes
        // startResearchAction skip the equity-only symbol validation, and the
        // name is read from the ORIGINAL-case message so the label reads
        // properly (falls back to the scheme code when there's no name).
        const syms = params.symbols as string[] | undefined;
        if (params.assetType === "mf" && syms?.length === 1) {
          const name = parseMentionName(message, syms[0]!) ?? syms[0]!;
          params.query = `[MUTUAL_FUND] ${name}`;
        } else {
          params.query = message.trim();
        }
      }
      // web_search runs the grounded query — pass the raw message through.
      if (tool === "web_search" && !params.query) {
        params.query = message.trim();
      }
      // run_screener parses the raw message (NL → strategy/filters) inside the
      // executor, so the fast-path market/screener guards must forward it.
      if (tool === "run_screener" && !params.query) {
        params.query = message.trim();
      }

      return {
        tool,
        params,
        confidence: 0.8,
      };
    }
  }

  return null;
}

/**
 * Flash-based intent classification - PRIMARY classifier for analytical queries.
 *
 * Uses Gemini 2.5 Flash to determine:
 * 1. What is the user asking? (intent + tool)
 * 2. What stock(s) are referenced? (symbol extraction)
 * 3. Which expert persona should respond? (persona selection)
 * 4. What analysis depth is needed? (mode: fast/advanced)
 *
 * Called for ALL queries that don't match the fast-path data-fetch patterns.
 * This includes: research, screening, comparison, risk, tax, financial data,
 * definitions, market questions, and any ambiguous query.
 */
export async function classifyIntentWithFlash(
  message: string,
  conversationContext?: string,
  priorTurnContext?: import("./turn-context").ConversationState | null
): Promise<IntentMatch | { clarification: string } | null> {
  try {
    const { getVertexAIClient } = await import("@/lib/gemini/client");
    const { getLearnedExamples } =
      await import("@/lib/chat-tools/learned-patterns");
    const vertexAI = getVertexAIClient();
    const model = vertexAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    // Fetch learned corrections from the self-learning loop
    const learnedExamples = await getLearnedExamples();
    const learnedBlock =
      learnedExamples.length > 0
        ? `\nLEARNED CORRECTIONS (high priority - these override default rules):\n${learnedExamples
            .map(
              (e) =>
                `- "${e.exampleMessage}" → intent: "${e.correctIntent}"${e.correctTier ? `, tier: "${e.correctTier}"` : ""}${e.correctTool ? `, tool: "${e.correctTool}"` : ""}`
            )
            .join("\n")}\n`
        : "";

    // Build prior turn context block for the prompt
    let priorTurnContextBlock = "";
    if (priorTurnContext) {
      const { formatStateForPrompt, buildFollowUpRules } =
        await import("./turn-context");
      priorTurnContextBlock = `\nPRIOR TURN CONTEXT:\n${formatStateForPrompt(priorTurnContext)}\n\n${buildFollowUpRules()}\n`;
    }

    const prompt = `You are an intent classifier for an Indian stock trading assistant (UseMoney). Classify the user's message into intent, tier, and persona in a SINGLE response.
${learnedBlock}

INTENTS (pick the most specific match):
- "quick_lookup": Simple definition, single metric, or financial data lookup - no analysis needed (e.g., "what is RSI", "PE of TCS", "what is MACD", "explain SIP", "quarterly results for Infosys", "show financials of TCS", "key ratios of HDFC Bank", "balance sheet of Reliance", "revenue of TCS", "earnings of INFY")
- "quick_research": Quick stock analysis with a 0-100 quality score and observation-based commentary — NO buy/sell/hold verdict (MONEY-457, SEBI compliance). Examples of user phrasing that should still classify here: "analyse RELIANCE", "how is TCS doing", "should I buy INFY" (we surface analysis, not a verdict).
- "deep_research": Comprehensive analysis (e.g., "deep analysis of RELIANCE", "deep research of TCS", "deep dive into INFY", "comprehensive analysis", "detailed research", "in-depth study", "investment thesis for TCS", "DCF valuation", "earnings analysis", "full breakdown of HDFCBANK")
- "comparison": Compare 2+ stocks (e.g., "compare TCS vs INFY", "which is better TCS or WIPRO")
- "screener": Find/filter/screen/list stocks by any criteria - fundamental (PE, ROE, debt), technical (RSI, MACD, SMA), index membership (Nifty 50, Sensex), ownership (promoter/FII/DII holding), or descriptive (undervalued, oversold, high dividend). Examples: "list stocks with RSI < 30", "Nifty 50 stocks with low PE", "oversold large caps", "show me stocks with ROE > 20% and debt < 0.5", "which Nifty stocks are undervalued", "top dividend stocks", "stocks where promoter holding > 60%", "golden cross stocks", "find undervalued large caps"
- "news": Latest news/headlines for a SPECIFIC STOCK by symbol (e.g., "latest news RELIANCE", "headlines for TCS")
- "web_search": Live web search for fresh, real-time, or general information NOT tied to a single stock symbol — "search the web for X", "look up X online", "what's the latest on <topic/company/sector>", "what's happening with <event/policy/theme>", "is <X> true", general current-events or factual questions that need up-to-date web data. Use this (not "news") when the query is about a topic, event, policy, sector, person, or anything web-searchable rather than a single ticker's news feed.
- "portfolio": Portfolio holdings, positions, trades, summary
- "portfolio_roast": AI critique/scoring of user's portfolio with actionable feedback (e.g., "roast my portfolio", "rate my portfolio", "score my holdings on diversification", "critique my portfolio", "is my portfolio any good", "grade my portfolio"). DISTINCT from "portfolio" - roast triggers an async deep analysis with score + commentary, not a stats summary.
- "risk_analysis": Portfolio risk, VaR, drawdown, concentration, rebalancing
- "tax": Tax report, capital gains, LTCG/STCG, tax harvesting, advance tax
- "fire": LIST/SHOW the user's saved FIRE plans ("show my fire plans", "list my retirement scenarios")
- "fire_edit": CHANGE a FIRE/retirement plan value — set/increase/decrease SIP or savings, retirement age, corpus, asset allocation, withdrawal rate, tax; add/remove an expense or goal ("increase my FIRE SIP to 60k", "retire at 45", "set equity to 70%", "add a ₹20L car goal in 5 years", "make my plan more conservative")
- "fire_ask": a QUESTION about the user's FIRE/retirement plan — on-track, affordability, how-long, what-if ("is my plan on track?", "can I afford a ₹20L car in 5 years?", "when can I retire?", "will my money last to 90?")
- "mf_analysis": Mutual fund queries, SIP, fund comparison
- "report_generation": Generate PDF reports
- "general_chat": General finance question not fitting above
- "unclear": Can't determine - need to ask user

TIER (analysis depth - determines cost and execution path):
- "L1": Definitions, concepts, simple facts, greetings - no tool execution needed, answer from knowledge (e.g., "what is RSI", "explain PE ratio", "how does SIP work")
- "L2": Needs data/tool execution - stock research, screening, risk analysis, tax report, comparisons, financial data lookup (e.g., "analyse TCS", "stocks with RSI < 30", "my portfolio risk", "capital gains report")
- "L3": Multi-segment comprehensive analysis, 3+ stock comparisons, portfolio optimization (e.g., "comprehensive analysis of RELIANCE", "compare TCS vs INFY vs WIPRO in detail")

PERSONAS (pick the most relevant expert):
- "equity_research": Single stock analysis, scoring, fundamentals
- "wealth_advisor": Mutual funds, SIP, fund selection
- "financial_planner": FIRE, retirement, corpus planning
- "quant_analyst": Stock screening, factor-based filtering, quantitative strategies
- "technical_analyst": RSI, MACD, chart patterns, price action, support/resistance
- "portfolio_manager": Holdings review, rebalancing, diversification, allocation
- "private_banker": Tax optimization, cross-asset wealth, insurance, estate
- "macro_strategist": Market overview, sectors, FII/DII, RBI, macro economics
- "sell_side_analyst": Stock comparison, X vs Y, head-to-head
- "general_analyst": Fallback for unclear or mixed queries

AVAILABLE TOOLS (what the system can actually execute):
- run_research: Deep stock analysis via research agent. Has 14 skills: stock-analysis, peer-comparison, earnings-analysis, financial-deep-dive, investment-thesis, dcf-valuation, stock-screener, technical-analysis, and more. Uses Tickertape, Screener.in, and Chartink APIs for real data.
- run_screener: Screen stocks using fundamental filters (PE, ROE, D/E), technical indicators (RSI, MACD, SMA), or 50+ pre-built strategies (value_investing, momentum, golden_cross, etc.). Has Chartink strategy sync. Can filter by index (Nifty 50/100/500).
- get_financial_data: Quick Yahoo Finance lookup - PE, PB, ROE, price, key ratios for a single stock.
- get_stock_news: Google News headlines for a stock.
- portfolio_risk_analysis: VaR, Sharpe, drawdown, concentration, correlation heatmap, rebalancing suggestions.
- start_roast: Async portfolio critique - AI scoring + honest commentary on holdings + MFs. Returns a sessionId; results land in /roast/[id]. Requires confirmation (5 credits or 1 free roast/month). Params: mode ("overall" / "broker"), broker (when mode=broker), assetType ("stocks" / "mf" / "all").
- tax_report: Indian capital gains (STCG s111A, LTCG s112A), tax harvesting, advance tax, ITR schedule.
- get_holdings / get_positions / get_trades / get_mutual_funds: User's portfolio data.
- get_fire_scenarios / create_fire_scenario: FIRE retirement planning (LIST plans / make a blank plan).
- fire_plan: EDIT the user's existing FIRE plan or ANSWER a FIRE/retirement question in natural language, from any page ("increase my SIP to 60k", "retire at 45", "set equity to 70%", "is my plan on track?"). Use for CHANGING a FIRE value or asking whether the plan works.
- generate_report: PDF reports (tax, risk, portfolio statement).

SCREENER CAPABILITIES (if user mentions ANY of these, classify as "screener"):

PRE-BUILT STRATEGIES (34):
Fundamental: value_investing, dividend_aristocrats, growth_stocks, garp, low_debt_bluechips, high_roce, turnaround, small_cap_gems, high_margin, cash_rich
Technical: bullish_trend, bearish_trend, momentum, volume_breakout, golden_cross, death_cross, bollinger_squeeze, 52w_high_breakout, oversold_bounce, overbought, near_support, macd_bullish_crossover
Combined: buffett_style, peter_lynch_peg, value_with_momentum, quality_breakout, dividend_tech_buy, growth_momentum

FUNDAMENTAL FILTERS (19): PE, PB, EV/EBITDA, PEG, ROE, ROA, ROCE, gross margin, operating margin, net margin, revenue growth (1Y/3Y/5Y), earnings growth (1Y/3Y/5Y), debt-to-equity, current ratio, interest coverage, beta, dividend yield, market cap, book value

TECHNICAL FILTERS (23): RSI (14), MACD (line/signal/histogram), SMA (20/50/200), EMA (12/26), Bollinger bands (upper/lower/bandwidth), ATR, stochastic (K/D), Williams %R, OBV, volume ratio, 52-week high/low distance, golden cross, death cross

OWNERSHIP FILTERS (Screener.in exclusive): promoter holding %, FII holding %, DII holding %, public holding %

INDEX FILTERS: Nifty 50, Nifty 100, Nifty 200, Nifty 500, Sensex, large cap, mid cap, small cap

ANY mention of these metrics + filtering intent (find, list, screen, stocks with, show me, which stocks) = "screener" intent.

IMPORTANT: If the user asks to find/list/filter stocks by ANY criteria (technical, fundamental, index, descriptive, ownership), classify as "screener" with tier "L2". The screener has real Tickertape + Chartink data.

Extract any stock names/symbols mentioned. If the user refers to a previously discussed stock ("above stock", "this stock", "the same"), resolve from conversation context.

${conversationContext ? `Recent conversation context:\n${conversationContext}\n` : ""}${priorTurnContextBlock}
User message: "${message}"

Respond ONLY in this JSON format (no markdown, no explanation):
{"intent": "screener", "tier": "L2", "stocks": [], "mode": "fast", "confidence": 0.9, "persona": "quant_analyst"}

For "screener" intent, also extract:
{"intent": "screener", "tier": "L2", "stocks": [], "confidence": 0.9, "persona": "quant_analyst", "screenerStrategy": "value_investing", "screenerFilters": [{"field": "rsi_14", "operator": "lt", "value": 30}]}

For "unclear", add a "question" field:
{"intent": "unclear", "tier": "L1", "question": "Would you like a quick overview or a detailed deep-dive?", "stocks": [], "confidence": 0.5, "persona": "general_analyst"}`;

    const result = await model.generateContent(prompt);
    const text =
      result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      intent: string;
      tier?: string;
      stocks?: string[];
      mode?: string;
      confidence?: number;
      question?: string;
      persona?: string;
    };

    // Handle "unclear" - return clarification question
    if (parsed.intent === "unclear" && parsed.question) {
      return { clarification: parsed.question };
    }

    // Map Flash intent to tool
    const intentToTool: Record<string, string> = {
      quick_lookup: "run_research",
      quick_research: "run_research",
      deep_research: "run_research",
      comparison: "run_research",
      screener: "run_screener",
      news: "get_stock_news",
      web_search: "web_search",
      portfolio: "get_portfolio_summary",
      portfolio_roast: "start_roast",
      risk_analysis: "portfolio_risk_analysis",
      tax: "tax_report",
      fire: "get_fire_scenarios",
      fire_edit: "fire_plan",
      fire_ask: "fire_plan",
      mf_analysis: "get_mutual_funds",
      report_generation: "generate_report",
      general_chat: "",
    };

    const tool = intentToTool[parsed.intent];
    if (tool === undefined) return null; // unknown intent

    // Resolve tier from Flash response
    const resolvedTier =
      parsed.tier === "L1" || parsed.tier === "L2" || parsed.tier === "L3"
        ? (parsed.tier as "L1" | "L2" | "L3")
        : undefined;

    // For general_chat (no tool needed), still return result with tier+persona
    // so Flash-first routing can set tier correctly (e.g., L1 definitions)
    if (!tool) {
      return {
        tool: "",
        params: { query: message.trim() },
        confidence: parsed.confidence || 0.7,
        persona: parsed.persona || undefined,
        tier: resolvedTier,
      };
    }

    const params: Record<string, unknown> = { query: message.trim() };

    if (parsed.stocks && parsed.stocks.length > 0) {
      params.symbols = parsed.stocks;
    }

    // Route screener queries - pass query for NL parsing inside run_screener.
    // Flash-extracted strategy/filters are hints but can fail Zod validation,
    // so only pass them if they look well-formed. The NL parser inside
    // run_screener handles extraction from the query string as fallback.
    if (parsed.intent === "screener") {
      const rawStrategy = (parsed as Record<string, unknown>).screenerStrategy;
      if (typeof rawStrategy === "string" && rawStrategy) {
        params.strategy = rawStrategy;
      }
      // Don't pass screenerFilters directly - they often don't match the strict
      // Zod schema (Flash uses "less_than" vs "lt", etc.). Let the NL parser
      // inside run_screener handle filter extraction from the query string.
    } else if (parsed.intent === "deep_research") {
      params.mode = "advanced";
    } else if (parsed.intent === "comparison") {
      params.mode = "advanced";
      params.skill = "peer-comparison";
    } else if (parsed.intent === "quick_research") {
      params.mode = parsed.mode || "fast";
    } else if (parsed.intent === "quick_lookup") {
      // run_research in fast mode - let the LLM planner pick the right tool
      params.mode = "fast";
      if (parsed.stocks && parsed.stocks.length > 0) {
        params.symbols = parsed.stocks;
      }
    } else if (parsed.intent === "news") {
      // get_stock_news expects params.symbol (singular)
      if (parsed.stocks && parsed.stocks.length > 0) {
        params.symbol = parsed.stocks[0];
      }
    } else if (parsed.intent === "fire_edit" || parsed.intent === "fire_ask") {
      // fire_plan does its own NL understanding server-side; forward the raw
      // message plus whether this is a mutating edit or a read-only question
      // (drives scenario targeting + persistence). Strip symbols so the strict
      // Zod schema doesn't reject unexpected keys.
      params.request = message.trim();
      params.intent = parsed.intent === "fire_ask" ? "ask" : "edit";
      delete params.symbols;
    } else if (parsed.intent === "web_search") {
      // web_search only takes { query } (already set above). Strip symbols so
      // the strict Zod schema doesn't see unexpected keys.
      delete params.symbols;
    } else if (parsed.intent === "portfolio_roast") {
      // start_roast wants mode/broker/assetType. Defaults are fine for
      // bare "roast my portfolio" - confirmation card lets user adjust.
      const lower = message.toLowerCase();
      const broker = /\bzerodha\b/.test(lower)
        ? "ZERODHA"
        : /\bupstox\b/.test(lower)
          ? "UPSTOX"
          : /\bgroww\b/.test(lower)
            ? "GROWW"
            : /\bdhan\b/.test(lower)
              ? "DHAN"
              : /\bfyers\b/.test(lower)
                ? "FYERS"
                : /\bangel\b/.test(lower)
                  ? "ANGEL_ONE"
                  : undefined;
      const assetType = /\bmutual\s*fund|\bmf\b|\bsip\b/.test(lower)
        ? "mf"
        : /\bstocks?\b|\bequit/.test(lower)
          ? "stocks"
          : "all";
      params.mode = broker ? "broker" : "overall";
      if (broker) params.broker = broker;
      params.assetType = assetType;
      // start_roast doesn't take symbols - strip them so Zod passes.
      delete params.symbols;
    }

    return {
      tool,
      params,
      confidence: parsed.confidence || 0.7,
      persona: parsed.persona || undefined,
      tier: resolvedTier,
    };
  } catch (error) {
    console.warn("[intent-mapper] Flash classification failed:", error);
    return null;
  }
}

/**
 * Parse TOOL_CALL markers from LLM response
 *
 * Format: TOOL_CALL: { "tool": "name", "params": {...} }
 * Handles one level of nested braces (e.g. params: { key: "value" })
 */
const TOOL_CALL_REGEX = /TOOL_CALL:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g;

export function parseToolCalls(response: string): IntentMatch[] {
  const matches: IntentMatch[] = [];
  TOOL_CALL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_REGEX.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.tool) {
        matches.push({
          tool: parsed.tool,
          params: parsed.params || {},
          confidence: 0.9,
        });
      }
    } catch {
      // Invalid JSON in tool call, skip
    }
  }

  return matches;
}

/**
 * Remove TOOL_CALL markers from response text
 */
export function removeToolCallMarkers(response: string): string {
  return response.replace(TOOL_CALL_REGEX, "").trim();
}
