/**
 * StockSage Research Planner
 *
 * Uses Gemini Flash to decompose a user query into an ordered task graph.
 * Supports fast (max 7 tasks) and advanced (unlimited) modes.
 * Can use pre-built skill plans or dynamically generate plans.
 */

import {
  getGeminiModel,
  generateWithTimeout,
  estimateTokenCount,
} from "@usemoney/core/gemini";
import { getPlannerPrompt, buildPlannerUserPrompt } from "./prompts";
import { matchSkill, getSkill } from "./skills/index";
import {
  extractSymbolsFromQuery,
  resolveSymbol,
} from "./data-sources/symbol-resolver";
import type { ResearchPlan, ResearchTask, ResearchMode } from "./types";
import type { Scratchpad } from "./scratchpad";

/** Tools allowed in fast mode - includes rich Screener.in/Tickertape data tools
 * so the LLM planner can pick the right source for quick_lookup queries
 * (e.g., "quarterly results" → fetch_quarterly_results, not Yahoo Finance) */
const FAST_MODE_TOOLS = new Set([
  "fetch_company_profile",
  "fetch_key_ratios",
  "fetch_stock_price",
  "fetch_news",
  "compute_health_score",
  "synthesize_report",
  // Screener.in / Tickertape rich data tools
  "fetch_quarterly_results",
  "fetch_screener_ratios",
  "fetch_shareholding_pattern",
  "fetch_income_statement",
  "fetch_balance_sheet",
  "fetch_cash_flow",
]);

export class ResearchPlanner {
  private toolNames: string[];

  constructor(toolNames: string[]) {
    this.toolNames = toolNames;
  }

  /**
   * Create a research plan from a user query.
   * First tries to match a pre-built skill, then falls back to LLM planning.
   */
  async plan(
    query: string,
    scratchpad: Scratchpad,
    skillHint?: string,
    mode: ResearchMode = "advanced",
    jobSymbols?: string[],
    /**
     * MONEY-240 follow-up (QA bundle B5): user's selected v2 skills.
     * Passed to the LLM planner so it knows which compute tools to
     * spawn - without this hint, the LLM emits a generic ~17-task
     * plan regardless of how many skills the user picked.
     */
    customSkills?: readonly string[],
  ): Promise<ResearchPlan> {
    // In fast mode, skip skill matching (skills produce large plans)
    // and go straight to fast LLM planning - UNLESS a skill hint is
    // explicitly provided (e.g. peer-comparison from intent mapper)
    if (mode === "fast" && !skillHint) {
      return this.llmPlan(query, scratchpad, mode);
    }

    // Try skill-based plan first (advanced mode)
    const skill = skillHint ? getSkill(skillHint) : matchSkill(query);

    if (skill) {
      // Prefer job-provided symbols (from intent mapper @mention extraction)
      // over re-extracting from the query text (which may contain noise words)
      const symbols = jobSymbols?.length
        ? jobSymbols
        : extractSymbolsFromQuery(query);
      const params: Record<string, unknown> = { query };

      if (skill.requiredParams.includes("symbol") && symbols.length > 0) {
        params.symbol = symbols[0];
      }
      if (skill.requiredParams.includes("symbols") && symbols.length > 0) {
        params.symbols = symbols;
      }
      if (skill.requiredParams.includes("sector")) {
        const sector = extractSectorFromQuery(query);
        if (sector) params.sector = sector;
      }

      const plan = skill.buildPlan(params);

      scratchpad.log("plan", {
        source: "skill",
        skill: skill.name,
        symbols: plan.symbols,
        taskCount: plan.tasks.length,
        complexity: plan.complexity,
        mode,
      });

      return plan;
    }

    // Fall back to LLM-based planning
    return this.llmPlan(query, scratchpad, mode, customSkills);
  }

  private async llmPlan(
    query: string,
    scratchpad: Scratchpad,
    mode: ResearchMode = "advanced",
    customSkills?: readonly string[],
  ): Promise<ResearchPlan> {
    const model = getGeminiModel("fast");
    const systemPrompt = getPlannerPrompt(this.toolNames, mode);
    // MONEY-240 follow-up (B5): include the user's skill set in the
    // user-prompt so the LLM emits one task per relevant compute tool.
    // Without this, the LLM saw only the system prompt's "max 32"
    // ceiling but no signal to push past the conservative ~17.
    const userPrompt = buildPlannerUserPrompt(query, undefined, customSkills);

    const inputTokens = estimateTokenCount(systemPrompt + userPrompt);

    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const plannerTimeout = mode === "fast" ? 30_000 : 45_000;
    const response = await generateWithTimeout(
      model,
      fullPrompt,
      plannerTimeout,
    );

    const outputTokens = estimateTokenCount(response);

    scratchpad.log(
      "plan",
      {
        source: "llm",
        rawResponse: response,
        mode,
      },
      undefined,
      { input: inputTokens, output: outputTokens },
    );

    // Parse JSON from response
    const plan = parsePlanResponse(response, query, mode);
    return plan;
  }

  /**
   * Create additional tasks to fill gaps identified by the validator.
   */
  createRefinementTasks(
    gaps: string[],
    existingPlan: ResearchPlan,
  ): ResearchTask[] {
    const newTasks: ResearchTask[] = [];
    const existingTools = new Set(existingPlan.tasks.map((t) => t.tool));

    for (const gap of gaps) {
      const lower = gap.toLowerCase();

      if (
        lower.includes("peer") &&
        !existingTools.has("fetch_peer_companies")
      ) {
        for (const sym of existingPlan.symbols) {
          newTasks.push({
            id: `refine_peers_${newTasks.length}`,
            type: "data_fetch",
            tool: "fetch_peer_companies",
            params: { symbol: sym },
            dependsOn: [],
            status: "pending",
          });
        }
      }

      if (lower.includes("news") && !existingTools.has("fetch_news")) {
        for (const sym of existingPlan.symbols) {
          newTasks.push({
            id: `refine_news_${newTasks.length}`,
            type: "data_fetch",
            tool: "fetch_news",
            params: { symbol: sym },
            dependsOn: [],
            status: "pending",
          });
        }
      }

      if (
        (lower.includes("earnings") || lower.includes("eps")) &&
        !existingTools.has("fetch_earnings")
      ) {
        for (const sym of existingPlan.symbols) {
          newTasks.push({
            id: `refine_earnings_${newTasks.length}`,
            type: "data_fetch",
            tool: "fetch_earnings",
            params: { symbol: sym },
            dependsOn: [],
            status: "pending",
          });
        }
      }
    }

    return newTasks;
  }
}

export function parsePlanResponse(
  response: string,
  query: string,
  mode: ResearchMode = "advanced",
): ResearchPlan {
  // Extract JSON from response (may be wrapped in markdown code blocks)
  let jsonStr = response;
  const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1]!.trim();
  }

  try {
    const parsed = JSON.parse(jsonStr) as {
      symbols?: string[];
      complexity?: string;
      tasks?: Array<{
        id: string;
        type: string;
        tool: string;
        params: Record<string, unknown>;
        dependsOn: string[];
      }>;
    };

    const symbols = (parsed.symbols || []).map((s: string) => resolveSymbol(s));

    let tasks: ResearchTask[] = (parsed.tasks || []).map((t) => ({
      id: t.id,
      type: t.type as ResearchTask["type"],
      tool: t.tool,
      params: t.params || {},
      dependsOn: t.dependsOn || [],
      status: "pending" as const,
    }));

    // In fast mode, filter out tools not in the allowed set and cap at 7
    if (mode === "fast") {
      tasks = tasks.filter((t) => FAST_MODE_TOOLS.has(t.tool));
      if (tasks.length > 7) {
        // Keep the synthesis task and trim data tasks
        const synthesis = tasks.find((t) => t.tool === "synthesize_report");
        const dataTasks = tasks
          .filter((t) => t.tool !== "synthesize_report")
          .slice(0, 6);
        tasks = synthesis ? [...dataTasks, synthesis] : dataTasks;
      }
    }

    // In advanced mode, cap at 56 tasks (55 data/compute + 1 synthesis).
    // History: 18 → 32 → 56. Bumped for MONEY-498: the 16 v2 institutional
    // skills reference ~50 unique compute/fetch tools (factor scores, volatility
    // regime, governance flags, …); the old 32 cap clipped a "comprehensive"
    // plan before it could surface the 40-50 cited params the deep tier
    // promises. The matched-skill / customSkills paths are uncapped (allowlist
    // driven); this cap only bounds the free-form advanced LLM plan.
    if (mode === "advanced" && tasks.length > 56) {
      const synthesis = tasks.find((t) => t.tool === "synthesize_report");
      const dataTasks = tasks
        .filter((t) => t.tool !== "synthesize_report")
        .slice(0, 55);
      tasks = synthesis ? [...dataTasks, synthesis] : dataTasks;
    }

    // Clean up dangling dependsOn references (task was filtered or LLM hallucinated ID)
    const validIds = new Set(tasks.map((t) => t.id));
    for (const t of tasks) {
      t.dependsOn = t.dependsOn.filter((dep) => validIds.has(dep));
    }

    return {
      query,
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity:
        (parsed.complexity as ResearchPlan["complexity"]) ||
        (mode === "fast" ? "simple" : "moderate"),
    };
  } catch (e) {
    console.warn("[planner] plan JSON parse failed", e);
    // Build a minimal fallback ONLY when the query names a real symbol. Never
    // default to an arbitrary stock (was "RELIANCE.NS"): a query the planner
    // fumbled must not silently return a confident report on the WRONG company
    // (MONEY-612 trust). No symbol → throw so the agent surfaces an honest
    // failure (and the processor refunds) instead of a wrong-stock report.
    const symbols = extractSymbolsFromQuery(query).map((s) => resolveSymbol(s));
    const symbol = symbols[0];
    if (!symbol) {
      throw new Error(
        "Planner could not build a plan and no stock symbol was identified in the query.",
      );
    }

    if (mode === "fast") {
      return buildFastFallbackPlan(query, symbol);
    }

    return buildAdvancedFallbackPlan(query, symbol);
  }
}

export function buildFastFallbackPlan(
  query: string,
  symbol: string,
): ResearchPlan {
  return {
    query,
    symbols: [symbol],
    tasks: [
      {
        id: "fast_profile",
        type: "data_fetch",
        tool: "fetch_company_profile",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fast_ratios",
        type: "data_fetch",
        tool: "fetch_key_ratios",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fast_price",
        type: "data_fetch",
        tool: "fetch_stock_price",
        params: { symbols: [symbol] },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fast_news",
        type: "data_fetch",
        tool: "fetch_news",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fast_health",
        type: "computation",
        tool: "compute_health_score",
        params: { symbol },
        dependsOn: ["fast_ratios"],
        status: "pending",
      },
      {
        id: "fast_report",
        type: "synthesis",
        tool: "synthesize_report",
        params: { query },
        dependsOn: [
          "fast_profile",
          "fast_ratios",
          "fast_price",
          "fast_news",
          "fast_health",
        ],
        status: "pending",
      },
    ],
    estimatedSteps: 6,
    complexity: "simple",
  };
}

/**
 * Comprehensive fallback plan for advanced mode when LLM parsing fails.
 * Mirrors the stock-analysis skill structure (fetch + compute + synthesis).
 */
export function buildAdvancedFallbackPlan(
  query: string,
  symbol: string,
): ResearchPlan {
  return {
    query,
    symbols: [symbol],
    tasks: [
      // Phase 1: Data fetch (parallel)
      {
        id: "fb_profile",
        type: "data_fetch",
        tool: "fetch_company_profile",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_financials",
        type: "data_fetch",
        tool: "fetch_income_statement",
        params: { symbol, quarterly: true },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_balance",
        type: "data_fetch",
        tool: "fetch_balance_sheet",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_cashflow",
        type: "data_fetch",
        tool: "fetch_cash_flow",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_ratios",
        type: "data_fetch",
        tool: "fetch_key_ratios",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_earnings",
        type: "data_fetch",
        tool: "fetch_earnings",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_price",
        type: "data_fetch",
        tool: "fetch_stock_price",
        params: { symbols: [symbol] },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_history",
        type: "data_fetch",
        tool: "fetch_price_history",
        params: { symbol, period: "1y" },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_peers",
        type: "data_fetch",
        tool: "fetch_peer_companies",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      {
        id: "fb_news",
        type: "data_fetch",
        tool: "fetch_news",
        params: { symbol },
        dependsOn: [],
        status: "pending",
      },
      // Phase 2: Computations
      {
        id: "fb_health",
        type: "computation",
        tool: "compute_health_score",
        params: {},
        dependsOn: ["fb_ratios", "fb_profile"],
        status: "pending",
      },
      {
        id: "fb_growth",
        type: "computation",
        tool: "compute_growth_metrics",
        params: {},
        dependsOn: ["fb_financials"],
        status: "pending",
      },
      {
        id: "fb_wacc",
        type: "computation",
        tool: "compute_wacc",
        params: {},
        dependsOn: ["fb_ratios", "fb_price"],
        status: "pending",
      },
      {
        id: "fb_dcf",
        type: "computation",
        tool: "compute_dcf",
        params: {},
        // Includes `fb_financials` (income statement) so the executor can
        // plumb netIncome through as the third-tier FCF fallback inside
        // compute_dcf when cash-flow data is missing (Tickertape returns
        // empty `annual` for shorter histories - see fetch-cash-flow.ts).
        // Without this dep DCF silently nulls out for those symbols.
        dependsOn: [
          "fb_cashflow",
          "fb_financials",
          "fb_price",
          "fb_ratios",
          "fb_wacc",
        ],
        status: "pending",
      },
      {
        id: "fb_technicals",
        type: "computation",
        tool: "compute_technical_analysis",
        params: {},
        dependsOn: ["fb_history"],
        status: "pending",
      },
      {
        id: "fb_scenarios",
        type: "computation",
        tool: "compute_scenario_analysis",
        params: {},
        dependsOn: ["fb_dcf", "fb_wacc", "fb_price"],
        status: "pending",
      },
      // Phase 3: Synthesis
      {
        id: "fb_report",
        type: "synthesis",
        tool: "synthesize_report",
        params: { query },
        dependsOn: [
          "fb_profile",
          "fb_financials",
          "fb_balance",
          "fb_cashflow",
          "fb_ratios",
          "fb_earnings",
          "fb_price",
          "fb_history",
          "fb_peers",
          "fb_news",
          "fb_health",
          "fb_growth",
          "fb_wacc",
          "fb_dcf",
          "fb_technicals",
          "fb_scenarios",
        ],
        status: "pending",
      },
    ],
    estimatedSteps: 17,
    complexity: "moderate",
  };
}

export function extractSectorFromQuery(query: string): string | undefined {
  // Order is preserved from the original list — the "first match wins" rule is
  // asserted by tests ("it and technology companies" -> "it") — with the
  // real-estate tokens appended. None of them collides with an earlier entry.
  const sectors = [
    "banking",
    "it",
    "pharma",
    "auto",
    "energy",
    "fmcg",
    "metals",
    "realty",
    "finance",
    "technology",
    "healthcare",
    // "real estate" was absent entirely, so every natural phrasing of the
    // sector returned undefined and the downstream skills did
    // `String(undefined).toLowerCase()` — surfacing a raw TypeError to the user
    // on a FAILED run with the credit spent. Only the NSE-flavoured "realty"
    // worked.
    "real estate",
    "realestate",
    "property",
    // The remaining CANONICAL sector names. This function is the ONLY producer
    // of `params.sector` and `planner.ts` the only caller of `buildPlan`, so a
    // name absent here can never reach a skill — which made the five new
    // baskets and the whole canonical alias block in sector-analysis.ts dead
    // code from the query path. 8 of the 13 canonical names produced an empty
    // report. Fixing the baskets without fixing this was one layer below the
    // bug.
    "financial services",
    "financials",
    // Bare "financial" — "how is the financial sector" returned UNDEFINED,
    // because only the full canonical name and the plural were tokens and
    // neither is a prefix of "financial". The most natural phrasing of the
    // largest sector on the exchange produced no report at all.
    "financial",
    "consumer discretionary",
    "industrials",
    "commodities",
    "telecommunication",
    "telecom",
    "utilities",
    "diversified",
    // "services" LAST: it is a substring of "financial services" and would
    // otherwise win first-match for that phrase.
    "services",
  ];
  /**
   * Tokens that are ordinary English words as well as sector names.
   *
   * These must be FOLLOWED by a sector-context word to count. Without that,
   * "sector analysis of Tata Consultancy Services" resolved to `services` and
   * returned a report built from IRCTC, INDIGO and CONCOR, and "Bajaj Finance"
   * resolved to `finance` and answered with private banks — confidently wrong
   * reports about the wrong companies, where the previous behaviour was an
   * honest `undefined`.
   *
   * A leading context word does NOT disambiguate: the TCS query literally
   * contains "sector analysis". The distinguishing feature is that the sector
   * reading has the token MODIFYING a following noun ("services sector"), while
   * the company reading has it terminating a proper noun ("Consultancy
   * Services").
   */
  const AMBIGUOUS = new Set(["services", "finance", "property"]);
  const SECTOR_CONTEXT = /^(sector|industry|stocks?|companies|space|firms?)\b/;

  const lower = query.toLowerCase();
  for (const sector of sectors) {
    // Word-START boundary, deliberately NOT a full `\b...\b`.
    //
    // A leading boundary is what distinguishes the wanted substring matches
    // from the unwanted ones: "pharma" SHOULD match "pharmaceutical" and "auto"
    // SHOULD match "automobile" (both asserted by tests), but "it" must NOT
    // match inside "util-it-ies" or "commod-it-ies" — which it did, so asking
    // about Utilities returned an analysis of TCS, Infosys and Wipro. Anchoring
    // only the START keeps the suffix matches and kills the infix ones.
    // Two-letter tokens are anchored at BOTH ends; longer ones only at the
    // start.
    //
    // A start-anchor alone was not enough for "it": it matches the beginning of
    // "ITC" — a top-10 NSE name that sits in this repo's own FMCG basket — so
    // "ITC sector analysis" returned a confident report built from TCS, Infosys
    // and Wipro. Longer tokens still need the loose end, because
    // "pharma"->"pharmaceutical" and "auto"->"automobile" are wanted matches.
    const body = sector.replace(/\s+/g, "\\s+");
    const re = new RegExp(
      sector.length <= 2 ? `\\b${body}\\b` : `\\b${body}`,
      "i",
    );
    const m = re.exec(lower);
    if (!m) continue;
    if (AMBIGUOUS.has(sector)) {
      const after = lower.slice(m.index + m[0].length).trimStart();
      if (!SECTOR_CONTEXT.test(after)) continue;
    }
    return sector;
  }
  // No recognized sector in the query — return undefined rather than silently
  // analyzing "banking" (MONEY-612 trust). The caller leaves params.sector
  // unset, so the sector tool degrades to "no data" instead of wrong-sector.
  return undefined;
}
