/**
 * MONEY-222 - Skill ID → Tool allow-list.
 *
 * Maps the user-facing custom skill IDs (the same set surfaced in the
 * popover at MONEY-220) to the compute / analysis / synthesis tools that
 * each skill owns. Used by `applyResearchPreferences` in agent.ts when
 * `researchStyle = custom`: any compute or analysis task whose tool is
 * NOT in the union of the user's selected skills is dropped from the
 * plan before execution.
 *
 * Design choices:
 *   - Data-fetch tasks (`fetch_*`) are NEVER trimmed. They're cheap
 *     (cached, parallel, on the order of seconds) and the synthesizer
 *     uses raw fetched data even for tools it doesn't compute over.
 *     Trimming them would break peer comparison + price-target enrichment.
 *   - `synthesize_report` is always kept (it's the report itself).
 *   - The `stock-analysis` skill is the umbrella - it includes the
 *     baseline tools every other skill builds on (health, growth,
 *     technicals).
 *
 * If a future skill adds a new compute tool, list it here. Otherwise the
 * trim will silently exclude it for users who picked that skill.
 */

import { isLakeQueryConfigured } from "../tools/query-lake";

/**
 * The user-facing skill IDs surfaced in the popover. Mirrors
 * `RESEARCH_SKILL_IDS` in `@usemoney/services/preferences` - we keep a
 * local copy so `packages/research` doesn't take a dependency on
 * `@usemoney/services` (services consume research, not the other way).
 * If the canonical list changes, both must move together.
 *
 * MONEY-219 v2: 16 institutional skills + 6 deprecated v1 aliases.
 * `expandSkillAliases` (mirrored from services) maps v1 → v2 at runtime.
 */
export type ResearchSkillId =
  // v2
  | "fundamentals-core"
  | "cash-flow-quality"
  | "earnings-deep-dive"
  | "dcf-valuation"
  | "dividend-income"
  | "relative-valuation"
  | "quant-factor-scores"
  | "technical-trend"
  | "chart-pattern-detection"
  | "regime-volatility"
  | "macro-sensitivities"
  | "flows-and-positioning"
  | "forward-scenarios"
  | "risk-portfolio-impact"
  // MONEY-669: L4-only VaR/stress pack
  | "risk-var-stress"
  | "governance-flags"
  | "news-sentiment-catalysts"
  // MONEY-793 (C1b): composed skills (allowlist-only, no buildPlan file) —
  // compose existing registered tools into new analytical lenses.
  | "portfolio-impact-on-user"
  | "catalyst-calendar"
  | "theme-evaluation"
  // MONEY-793 (C1b): orphan skill packs promoted to the picker (skill FILES
  // already exist; these wire them into the user-facing skill set).
  | "tax-planning"
  | "mf-deep-dive"
  | "global-funds"
  | "forensic-accounting"
  // v1 aliases (deprecated)
  | "investment-thesis"
  | "peer-comparison"
  | "earnings-analysis"
  | "financial-deep-dive"
  | "stock-analysis"
  | "macro-analysis";

/**
 * Registered tools THIS DEPLOYMENT cannot run, so no planner is offered them.
 * Read per call — MONEY-1597 review.
 *
 * `query_lake` needs LAKE_ENV and the lake-reader grant (MONEY-1605). Without
 * them every planned query_lake task fails, and every report then carries an
 * "unavailable source" line for a tool that was never going to answer. The
 * tool stays REGISTERED (its own refusal is intact, and the MONEY-650 guard
 * requires every allow-listed tool to resolve); it is only not PLANNED:
 * `getPlannerPrompt` drops it from AVAILABLE TOOLS, `buildPlannerUserPrompt`
 * does not count it toward a skill's task floor, and news-sentiment-catalysts
 * does not template it.
 */
export function unplannableTools(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return isLakeQueryConfigured(env) ? new Set() : new Set(["query_lake"]);
}

/**
 * Tools that must run on every plan regardless of the user's custom-skill
 * selection - without these the synthesizer has no facts to cite.
 */
export const ALWAYS_KEEP_TOOLS: ReadonlySet<string> = new Set<string>([
  // Synthesis is the final output - never trim.
  "synthesize_report",
  "compare_stocks",
  "generate_summary",
]);

/**
 * The four `fetch_us_*` tools are deliberately NOT in this map — MONEY-979.
 *
 * They are REGISTERED (`registry.ts`), so the planner can still reach them on
 * the default, non-skill path; `applySkillPreferences` returns early when no
 * skill is selected, so this map gates the SKILL path only.
 *
 * Two reasons they stay out of it until MONEY-982:
 *
 * 1. **Currency.** Every downstream renderer in this repo prints a hardcoded
 *    rupee symbol. Putting a USD tool inside an India-oriented skill's plan is
 *    how USD reaches a rupee renderer — confidently-wrong numbers rather than a
 *    visible gap. That is the same reason these shipped as separate tools
 *    instead of a router inside `fetch_income_statement`.
 *
 * 2. **The task floor is literally `tools + 2`** (`prompts.ts`, the MINIMUM
 *    TASK COUNT derivation). Adding one US tool to `dcf-valuation` moved its
 *    floor from 8 to 9 for EVERY dcf query, Indian ones included, where that
 *    tool can never fire. MONEY-1120 lowered that floor precisely because a
 *    baseline unrelated to the selection pushed /dcf into a 14-task plan that
 *    overran the 480s budget and died before synthesis. Allow-listing a tool a
 *    query cannot use gives half of that back.
 *
 * When MONEY-982 lands dual-denomination rendering, add them per skill AND
 * update the task-floor expectations in
 * `apps/web/__tests__/research/synthesizer-prompt-required-sections.test.ts`
 * in the same change — that test is what caught this.
 */
export const SKILL_TOOL_ALLOWLIST: Record<ResearchSkillId, readonly string[]> =
  {
    // ── v2 fundamentals + valuation ─────────────────────────────────
    "fundamentals-core": [
      "compute_health_score",
      "compute_growth_metrics",
      "compute_accounting_quality",
      "compute_revenue_mix",
      "compute_investment_score",
      "compute_piotroski",
      "compute_altman_z",
      "compute_beneish_m",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
    ],
    "cash-flow-quality": [
      "compute_cash_flow_quality",
      "compute_capex_intensity",
      "compute_fcf_yield",
      "compute_working_capital_drag",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
    ],
    "earnings-deep-dive": [
      "compute_earnings_quality",
      "compute_earnings_estimates",
      "compute_earnings_surprise",
      "compute_guidance_sensitivity",
      "compute_growth_metrics",
      // MONEY-802: the management's earnings-call commentary is a first-class
      // earnings source. `fetch_youtube_candidates` discovers the concall video,
      // then `fetch_youtube_transcript` ingests its captions (chain the two; the
      // transcript fetch also accepts a planner-supplied url directly).
      "fetch_youtube_candidates",
      "fetch_youtube_transcript",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
    ],
    "dcf-valuation": [
      "compute_wacc",
      "compute_dcf",
      "compute_ddm",
      "compute_valuation_bands",
      "compute_scenario_analysis",
      "compute_dcf_sensitivity",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
    ],
    "dividend-income": [
      "compute_ddm",
      "compute_dividend_analysis",
      "compute_payout_coverage",
    ],
    "relative-valuation": [
      "compute_comparative_valuation",
      "compute_relative_valuation",
      "compute_sector_aggregates",
      "compute_valuation_bands",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
    ],
    // ── v2 quant / technical ────────────────────────────────────────
    "quant-factor-scores": [
      "compute_factor_scores",
      "compute_factor_zscore",
      "compute_composite_quant_score",
    ],
    "technical-trend": [
      "compute_technical_analysis",
      "compute_volume_profile",
      "compute_trend_strength",
    ],
    "chart-pattern-detection": [
      "detect_chart_patterns",
      "detect_candlestick_patterns",
      "detect_breakout_setups",
    ],
    "regime-volatility": [
      "compute_volatility_regime",
      "compute_drawdown_profile",
      "compute_beta_decomposition",
    ],
    // ── v2 macro & flows ────────────────────────────────────────────
    "macro-sensitivities": [
      "compute_macro_impact",
      "compute_commodity_correlation",
      "compute_rate_sensitivity",
      "fetch_macro_dashboard",
    ],
    "flows-and-positioning": [
      "fetch_fii_dii_flows",
      "compute_sector_rotation",
      "fetch_short_interest",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
      // 13F is the US equivalent of the FII/DII flow read: who owns it, and
      // who just sold out of it.
    ],
    // ── v2 forward + risk + governance + sentiment ──────────────────
    "forward-scenarios": [
      "compute_forward_scenarios",
      "compute_monte_carlo_returns",
    ],
    "risk-portfolio-impact": [
      "compute_position_var",
      "compute_concentration_delta",
      "compute_portfolio_beta_drift",
    ],
    // MONEY-669: L4-only stress pack — registry risk tools no skill
    // exposed (VaR, drawdown, beta, risk-adjusted returns, correlation).
    // Wired ONLY into the l4-institutional preset so Advanced runs a
    // strictly larger set than Comprehensive.
    "risk-var-stress": [
      "compute_var",
      "compute_drawdown",
      "compute_beta",
      "compute_risk_adjusted_returns",
      "compute_correlation_matrix",
    ],
    "governance-flags": [
      "compute_governance_flags",
      "fetch_promoter_holding",
      "fetch_related_party",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
      // Forms 3/4/5 and 13D/G are the US analogue of promoter holding.
    ],
    "news-sentiment-catalysts": [
      "fetch_news",
      "compute_news_sentiment",
      "fetch_corporate_actions",
      // MONEY-1597 (C5b) - `events_for_listing`: the returns that FOLLOWED each
      // of this listing's past filings and news, point-in-time, by event_id.
      // Returns are fractions, not currency, so no rupee-renderer hazard.
      "query_lake",
    ],

    // ── MONEY-793 (C1b): composed skills ────────────────────────────
    // "How does X affect MY portfolio" lens — position-level VaR + the
    // portfolio-delta / concentration / rebalancing / overlap compute tools.
    "portfolio-impact-on-user": [
      "compute_portfolio_delta",
      "compute_portfolio_concentration",
      "compute_rebalancing",
      "compute_holdings_overlap",
      "compute_position_var",
    ],
    // Upcoming catalysts: earnings dates, corporate actions, exchange
    // announcements + a news-sentiment read on the surrounding flow.
    // MONEY-802: an earnings-call / management-interview YouTube video is a
    // primary catalyst source. `fetch_youtube_candidates` discovers the video
    // and `fetch_youtube_transcript` makes its captions citable — chain the two
    // (the transcript fetch also runs directly when the planner supplies a url).
    "catalyst-calendar": [
      "fetch_earnings_calendar",
      "fetch_corporate_actions",
      "fetch_exchange_announcements",
      "compute_news_sentiment",
      "fetch_youtube_candidates",
      "fetch_youtube_transcript",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
      // 8-K item 2.02 is the US earnings release; the filing ledger is the
      // catalyst calendar for a US name.
      // MONEY-1597 (C5b) - how the stock, and the market, moved after past
      // catalysts of the same kind (events_for_listing, event_outcomes_by_type).
      "query_lake",
    ],
    // Investment-theme evaluation + sector rotation + advanced screening.
    "theme-evaluation": [
      "evaluate_theme",
      "compute_sector_rotation",
      "screen_stocks_advanced",
      // MONEY-1597 (C5b) - `universe_top_by`: a market ranked by one metric,
      // the cross-sectional read no per-symbol tool can give.
      "query_lake",
    ],

    // ── MONEY-793 (C1b): promoted orphan packs ──────────────────────
    // Tax-analysis skill's compute tools (capital gains, harvesting,
    // advance tax, ITR schedule).
    "tax-planning": [
      "compute_capital_gains_tax",
      "compute_tax_harvesting",
      "compute_advance_tax",
      "generate_itr_schedule",
    ],
    // Mutual-fund deep dive: analysis + constituent breakdown + the
    // fetch_mf_* data tools.
    "mf-deep-dive": [
      "compute_mf_analysis",
      "compute_constituent_analysis",
      "fetch_mf_overview",
      "fetch_mf_holdings",
      "fetch_mf_peers",
    ],
    // Global funds: cross-border fund fetch + comparison.
    "global-funds": [
      "fetch_global_fund",
      "compare_global_funds",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
    ],
    // Forensic accounting: Piotroski / Altman-Z / Beneish-M + accounting
    // quality + governance flags.
    "forensic-accounting": [
      "compute_piotroski",
      "compute_altman_z",
      "compute_beneish_m",
      "compute_accounting_quality",
      "compute_governance_flags",
      // MONEY-979 (T10) - SEC EDGAR. US symbols only; a no-op (empty result
      // with a named dataGap) for an Indian symbol, never a wrong number.
      // The as-filed, point-in-time statements are what a restatement hunt
      // needs: `asOf` returns the numbers as they stood, not as they were
      // later corrected.
    ],

    // ── DEPRECATED v1 aliases ───────────────────────────────────────
    // Kept so saved user prefs deserialise. expandSkillAliases() routes
    // v1 IDs to their v2 replacements before this map is consulted, so
    // these entries are a defensive fallback only.
    "investment-thesis": [
      "compute_health_score",
      "compute_growth_metrics",
      "compute_comparative_valuation",
      "compute_scenario_analysis",
      "compute_investment_score",
    ],
    "peer-comparison": [
      "compute_comparative_valuation",
      "compute_relative_valuation",
      "compute_sector_aggregates",
    ],
    "earnings-analysis": [
      "compute_earnings_quality",
      "compute_earnings_estimates",
      "compute_earnings_surprise",
      "compute_growth_metrics",
    ],
    "financial-deep-dive": [
      "compute_health_score",
      "compute_growth_metrics",
      "compute_cash_flow_quality",
      "compute_earnings_quality",
      "compute_accounting_quality",
      "compute_revenue_mix",
      "compute_dividend_analysis",
    ],
    "stock-analysis": [
      "compute_technical_analysis",
      "compute_health_score",
      "compute_growth_metrics",
      "compute_dcf",
      "compute_wacc",
      "compute_comparative_valuation",
      "compute_cash_flow_quality",
      "compute_earnings_quality",
      "compute_dividend_analysis",
      "compute_scenario_analysis",
      "detect_chart_patterns",
      "detect_candlestick_patterns",
      "fetch_user_documents",
    ],
    "macro-analysis": [
      "compute_macro_impact",
      "compute_commodity_correlation",
      "fetch_fii_dii_flows",
      "fetch_macro_dashboard",
    ],
  };

/**
 * v1 → v2 alias map (mirrors `SKILL_ID_ALIASES` in
 * `packages/services/src/preferences/research-preferences.ts` - kept local
 * to avoid a services dependency cycle).
 */
const V1_TO_V2_ALIASES: Partial<Record<ResearchSkillId, ResearchSkillId[]>> = {
  "investment-thesis": [
    "fundamentals-core",
    "dcf-valuation",
    "relative-valuation",
  ],
  "peer-comparison": ["relative-valuation"],
  "earnings-analysis": ["earnings-deep-dive"],
  "financial-deep-dive": ["fundamentals-core", "cash-flow-quality"],
  "stock-analysis": [
    "fundamentals-core",
    "technical-trend",
    "chart-pattern-detection",
  ],
  "macro-analysis": ["macro-sensitivities", "flows-and-positioning"],
};

/**
 * Expand any v1 alias IDs in the input to v2 IDs. Pure helper.
 */
export function expandSkillAliases(ids: readonly string[]): ResearchSkillId[] {
  const out = new Set<ResearchSkillId>();
  for (const id of ids) {
    const expanded = V1_TO_V2_ALIASES[id as ResearchSkillId];
    if (expanded) {
      for (const e of expanded) out.add(e);
    } else if ((SKILL_TOOL_ALLOWLIST as Record<string, unknown>)[id]) {
      out.add(id as ResearchSkillId);
    }
  }
  return Array.from(out);
}

/**
 * Build the union of allowed tools for the user's selected skill IDs.
 * Auto-expands v1 aliases to their v2 replacements before computing the
 * union.
 */
export function buildAllowedToolSet(
  customSkills: readonly string[],
): Set<string> {
  const allowed = new Set<string>(ALWAYS_KEEP_TOOLS);
  const expanded = expandSkillAliases(customSkills);
  for (const skill of expanded) {
    const tools = SKILL_TOOL_ALLOWLIST[skill];
    if (tools) {
      for (const t of tools) allowed.add(t);
    }
  }
  return allowed;
}
