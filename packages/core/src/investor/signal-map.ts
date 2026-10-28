/**
 * Behaviour-signal → concept maps (MONEY-788, B3).
 *
 * The CAPTURE-TIME translation layer: when the user finishes a research run,
 * resolves a chat intent, or runs a portfolio roast, we map that activity to
 * the taxonomy concept slugs it exercises (see `concepts.ts`) so the mastery
 * model can be nudged with a NEUTRAL "they were exposed to this" signal.
 *
 * PURE + dependency-free — no Prisma, no I/O, no `concepts.ts` import. The
 * right-hand-side slugs are kept in sync with `concepts.ts` BY HAND and the
 * test (`investor-signal-map.test.ts`) asserts every slug here resolves to a
 * real concept. Only `capture.ts` (the DB seam) imports Prisma.
 *
 * Exported from `@usemoney/core/investor/signal-map`.
 */

import type { SignalDifficulty } from "./mastery";

/**
 * Research skill id → concept slugs the skill exercises. The skill id is the
 * `skill` stamped on the research plan (see `@usemoney/research` skills), with
 * a few aliases collapsed (e.g. `peer-comparison` / `multi-comparison` share a
 * mapping). Every slug below exists in `concepts.ts`.
 */
export const SKILL_CONCEPT_MAP: Record<string, string[]> = {
  // ── Stock fundamentals + valuation ────────────────────────────
  "stock-analysis": ["asset.equity", "valuation.pe-ratio"],
  "dcf-valuation": ["valuation.dcf", "valuation.pe-ratio"],
  "relative-valuation": ["valuation.pe-ratio", "valuation.pb-ratio"],
  "quant-factor-scores": ["asset.equity", "risk.beta", "valuation.pb-ratio"],
  "fundamentals-core": [
    "asset.equity",
    "valuation.pe-ratio",
    "valuation.pb-ratio",
  ],
  "cash-flow-quality": ["valuation.dcf", "asset.equity"],
  "earnings-deep-dive": ["asset.equity", "valuation.pe-ratio"],
  "financial-deep-dive": [
    "asset.equity",
    "valuation.pb-ratio",
    "valuation.dcf",
  ],
  "investment-thesis": [
    "asset.equity",
    "valuation.dcf",
    "portfolio.diversification",
  ],
  "peer-comparison": ["asset.equity", "valuation.pe-ratio"],
  "multi-comparison": ["asset.equity", "valuation.pe-ratio"],
  "governance-flags": ["asset.equity"],
  "shareholding-analysis": ["asset.equity"],
  "stock-screener": ["asset.equity", "valuation.pe-ratio"],
  "strategy-analysis": ["asset.equity", "risk.volatility"],

  // ── Risk ──────────────────────────────────────────────────────
  "stock-risk-analysis": ["risk.volatility", "risk.beta", "risk.drawdown"],
  "portfolio-risk-analysis": [
    "risk.var",
    "risk.concentration",
    "risk.drawdown",
    "portfolio.diversification",
  ],
  "risk-portfolio-impact": [
    "risk.var",
    "risk.concentration",
    "portfolio.diversification",
  ],
  "regime-volatility": ["risk.volatility", "risk.beta"],
  "forward-scenarios": ["risk.volatility", "risk.var"],

  // ── Technical ─────────────────────────────────────────────────
  "technical-trend": ["risk.volatility"],
  "chart-pattern-detection": ["risk.volatility"],

  // ── Derivatives / flows ───────────────────────────────────────
  "flows-and-positioning": ["asset.fno", "deriv.options-greeks"],

  // ── Portfolio ─────────────────────────────────────────────────
  "portfolio-analysis": [
    "portfolio.diversification",
    "portfolio.asset-allocation",
  ],
  "portfolio-optimization": [
    "portfolio.asset-allocation",
    "portfolio.rebalancing",
    "risk.concentration",
  ],

  // ── Mutual funds ──────────────────────────────────────────────
  "mf-analysis": ["asset.mutual-fund", "asset.etf"],
  "mf-comparison": ["asset.mutual-fund", "asset.etf"],
  "global-fund-comparison": ["asset.mutual-fund", "macro.inr-currency"],

  // ── Macro / sector ────────────────────────────────────────────
  "macro-analysis": [
    "macro.interest-rates",
    "macro.inr-currency",
    "macro.sectors",
  ],
  "macro-sensitivities": ["macro.interest-rates", "macro.inr-currency"],
  "sector-analysis": ["macro.sectors", "asset.equity"],
  "sector-deep-dive": ["macro.sectors", "asset.equity"],
  "news-sentiment-catalysts": ["macro.sectors", "asset.equity"],

  // ── Tax / income ──────────────────────────────────────────────
  "tax-analysis": ["tax.stcg", "tax.ltcg", "tax.harvesting"],
  "dividend-income": ["asset.equity", "asset.bonds"],
};

/**
 * Chat intent (resolved tool name) → concept slugs. `general_chat` maps to no
 * concepts (it's not a focused, conceptual interaction).
 */
export const CHAT_INTENT_CONCEPT_MAP: Record<string, string[]> = {
  run_research: ["asset.equity"],
  run_screener: ["asset.equity", "valuation.pe-ratio"],
  run_roast: ["portfolio.diversification", "risk.concentration"],
  get_stock_news: ["macro.sectors"],
  run_comparison: ["asset.equity", "valuation.pe-ratio"],
  tax_analysis: ["tax.stcg", "tax.ltcg"],
  fire_planning: ["portfolio.asset-allocation", "asset.bonds"],
  general_chat: [],
};

/** Concepts a portfolio roast always exercises. */
export const ROAST_CONCEPTS: string[] = [
  "portfolio.diversification",
  "risk.concentration",
  "portfolio.asset-allocation",
  "asset.equity",
];

/** Dedupe a slug list, preserving first-seen order. */
function dedupe(slugs: string[]): string[] {
  return [...new Set(slugs)];
}

/**
 * Concept slugs exercised by a research run. `symbols` is accepted for future
 * symbol-aware refinement (e.g. F&O symbols → `asset.fno`) but is currently
 * unused — the skill alone determines the concept set. Unknown skill → `[]`.
 */
export function conceptsForResearch(
  skill: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  symbols: string[] = [],
): string[] {
  if (!skill) return [];
  return dedupe(SKILL_CONCEPT_MAP[skill] ?? []);
}

/** Concept slugs exercised by a resolved chat intent. Unknown tool → `[]`. */
export function conceptsForChatIntent(tool: string | undefined): string[] {
  if (!tool) return [];
  return dedupe(CHAT_INTENT_CONCEPT_MAP[tool] ?? []);
}

/**
 * Map a research `mode` to the {@link SignalDifficulty} the mastery model
 * should treat the exposure as: a quick "fast" run is EASY exposure, a deep
 * "advanced"/"comprehensive" run is HARD, everything else MODERATE.
 */
export function difficultyForMode(mode: string | undefined): SignalDifficulty {
  if (mode === "fast") return "EASY";
  if (mode === "advanced" || mode === "comprehensive") return "HARD";
  return "MODERATE";
}
