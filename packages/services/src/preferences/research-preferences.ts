/**
 * Per-user research preferences (MONEY-219).
 *
 * Stored under `User.preferences.research`. The preferences shape decides:
 *   - Which research style the user gets by default (Auto / Quick / Deep / Custom)
 *   - When style = Custom, which skills are required on every research run
 *   - A free-text "research focus" string that biases the planner +
 *     synthesizer regardless of style (e.g. "I care about margin expansion
 *     and AI exposure")
 *
 * The preference set is namespaced under `preferences.research` so future
 * features can colocate their own buckets in the same Json field without a
 * schema migration.
 */

import { z } from "zod";
import { prisma } from "@usemoney/database";

// Skill IDs MUST match registered skills in
// `packages/research/src/skills/index.ts` - Zod refuses unknown values so a
// schema drift surfaces at write time rather than as a confusing planner
// error halfway through a research run.
//
// MONEY-219 v2: expanded from 7 to 16 skills covering institutional-grade
// quant + advisor coverage. Old IDs (`investment-thesis`, `peer-comparison`,
// `earnings-analysis`, `financial-deep-dive`, `stock-analysis`) are
// retained as DEPRECATED aliases so saved user preferences keep working -
// `applyResearchPreferences` expands them to their v2 equivalents at
// runtime. New v2 IDs are listed first.
export const RESEARCH_SKILL_IDS = [
  // ── v2 fundamentals + valuation ────────────────────────────────
  "fundamentals-core",
  "cash-flow-quality",
  "earnings-deep-dive",
  "dcf-valuation",
  "dividend-income",
  "relative-valuation",
  // ── v2 quant / technical ───────────────────────────────────────
  "quant-factor-scores",
  "technical-trend",
  "chart-pattern-detection",
  "regime-volatility",
  // ── v2 macro & flows ───────────────────────────────────────────
  "macro-sensitivities",
  "flows-and-positioning",
  // ── v2 forward + risk + governance + sentiment ─────────────────
  "forward-scenarios",
  "risk-portfolio-impact",
  // MONEY-669: L4-only VaR / stress pack (compute_var, drawdown, beta,
  // risk-adjusted returns, correlation) — included by default ONLY in
  // the l4-institutional preset so Advanced > Comprehensive.
  "risk-var-stress",
  "governance-flags",
  "news-sentiment-catalysts",
  // ── MONEY-793 (C1b): composed skills (advanced-tier; join l4-institutional)
  "portfolio-impact-on-user",
  "catalyst-calendar",
  "theme-evaluation",
  // ── MONEY-793 (C1b): promoted orphan packs ─────────────────────
  //   forensic-accounting is advanced-tier (joins l4-institutional);
  //   tax-planning / mf-deep-dive / global-funds are situational opt-ins
  //   (pickable but NOT in any preset default).
  "tax-planning",
  "mf-deep-dive",
  "global-funds",
  "forensic-accounting",
  // ── DEPRECATED v1 aliases (kept so saved prefs deserialise) ────
  "investment-thesis",
  "peer-comparison",
  "earnings-analysis",
  "financial-deep-dive",
  "stock-analysis",
  "macro-analysis",
] as const;
export type ResearchSkillId = (typeof RESEARCH_SKILL_IDS)[number];

/**
 * Aliases mapping old v1 IDs to one or more v2 IDs. Used by the planner
 * to expand stored preferences before computing the tool union.
 */
export const SKILL_ID_ALIASES: Partial<
  Record<ResearchSkillId, ResearchSkillId[]>
> = {
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

/** Expand any v1 alias IDs to their v2 equivalents. Returns deduped v2 IDs. */
export function expandSkillAliases(
  ids: readonly ResearchSkillId[],
): ResearchSkillId[] {
  const out = new Set<ResearchSkillId>();
  for (const id of ids) {
    const expanded = SKILL_ID_ALIASES[id];
    if (expanded) {
      for (const e of expanded) out.add(e);
    } else {
      out.add(id);
    }
  }
  return Array.from(out);
}

export const RESEARCH_STYLES = [
  "auto",
  "quick",
  "deep",
  "comprehensive",
  "advanced",
  "custom",
] as const;
export type ResearchStyle = (typeof RESEARCH_STYLES)[number];

/**
 * Research-type presets - the new top-level choice on the picker.
 * Each preset bundles a default skill set + suggested model + base
 * credit floor. The user can ADD or REMOVE skills on top of a preset
 * for a given run; the resulting bundle is reflected in the
 * confirmation panel + dynamic credit estimate.
 */
export const RESEARCH_PRESETS = [
  "quick-pulse",
  "investment-thesis",
  "quant-deep-dive",
  "earnings-preview",
  "macro-sector-view",
  "risk-audit",
  "comprehensive",
  "l4-institutional",
  "custom",
] as const;
export type ResearchPresetId = (typeof RESEARCH_PRESETS)[number];

export interface ResearchPresetDef {
  id: ResearchPresetId;
  label: string;
  shortLabel: string;
  description: string;
  /** Skill IDs that ship pre-selected for this preset. */
  defaultSkills: ResearchSkillId[];
  /** Suggested Gemini model ID - picker still lets the user override. */
  suggestedModel: string;
  /** Floor on credit cost - dynamic billing pays at least this amount. */
  baseCredits: number;
  /** Approximate task budget; surfaced in the confirmation panel. */
  estimatedTasks: { min: number; max: number };
  /** Approximate seconds; surfaced in the confirmation panel. */
  estimatedSeconds: { min: number; max: number };
}

export const RESEARCH_PRESET_DEFS: Record<ResearchPresetId, ResearchPresetDef> =
  {
    "quick-pulse": {
      id: "quick-pulse",
      label: "Quick Pulse",
      shortLabel: "Pulse",
      description: "1-minute snapshot - health, growth, recent news.",
      defaultSkills: ["fundamentals-core"],
      suggestedModel: "gemini-2.5-flash",
      baseCredits: 1,
      estimatedTasks: { min: 6, max: 8 },
      estimatedSeconds: { min: 30, max: 60 },
    },
    "investment-thesis": {
      id: "investment-thesis",
      label: "Investment Thesis",
      shortLabel: "Thesis",
      description: "Build a buy/hold/sell thesis - DCF + peers + catalysts.",
      defaultSkills: [
        "fundamentals-core",
        "dcf-valuation",
        "relative-valuation",
        "news-sentiment-catalysts",
      ],
      suggestedModel: "gemini-2.5-pro",
      baseCredits: 4,
      estimatedTasks: { min: 18, max: 22 },
      estimatedSeconds: { min: 90, max: 180 },
    },
    "quant-deep-dive": {
      id: "quant-deep-dive",
      label: "Quant Deep Dive",
      shortLabel: "Quant",
      description:
        "Multi-factor scores, regime/volatility, technical signals, forward Monte-Carlo.",
      defaultSkills: [
        "quant-factor-scores",
        "technical-trend",
        "chart-pattern-detection",
        "regime-volatility",
        "forward-scenarios",
      ],
      suggestedModel: "gemini-2.5-pro",
      baseCredits: 6,
      estimatedTasks: { min: 24, max: 28 },
      estimatedSeconds: { min: 120, max: 240 },
    },
    "earnings-preview": {
      id: "earnings-preview",
      label: "Earnings Preview",
      shortLabel: "Earnings",
      description:
        "Beat/miss history, guidance sensitivity, consensus + catalysts.",
      defaultSkills: [
        "earnings-deep-dive",
        "news-sentiment-catalysts",
        "relative-valuation",
      ],
      suggestedModel: "gemini-2.5-pro",
      baseCredits: 3,
      estimatedTasks: { min: 12, max: 15 },
      estimatedSeconds: { min: 60, max: 120 },
    },
    "macro-sector-view": {
      id: "macro-sector-view",
      label: "Macro / Sector View",
      shortLabel: "Macro",
      description: "Rate, INR, Brent betas + FII/DII flows + sector rotation.",
      defaultSkills: [
        "macro-sensitivities",
        "flows-and-positioning",
        "relative-valuation",
      ],
      suggestedModel: "gemini-2.5-pro",
      baseCredits: 3,
      estimatedTasks: { min: 10, max: 14 },
      estimatedSeconds: { min: 60, max: 120 },
    },
    "risk-audit": {
      id: "risk-audit",
      label: "Risk Audit",
      shortLabel: "Risk",
      description:
        "Cash-flow quality + governance flags + drawdown/VaR + concentration.",
      defaultSkills: [
        "cash-flow-quality",
        "governance-flags",
        "regime-volatility",
        "risk-portfolio-impact",
      ],
      suggestedModel: "gemini-2.5-pro",
      baseCredits: 4,
      estimatedTasks: { min: 14, max: 18 },
      estimatedSeconds: { min: 90, max: 180 },
    },
    comprehensive: {
      id: "comprehensive",
      label: "Comprehensive",
      shortLabel: "Comprehensive",
      description: "Every skill - institutional-grade L3 deep dive.",
      defaultSkills: [
        "fundamentals-core",
        "cash-flow-quality",
        "earnings-deep-dive",
        "dcf-valuation",
        "dividend-income",
        "relative-valuation",
        "quant-factor-scores",
        "technical-trend",
        "chart-pattern-detection",
        "regime-volatility",
        "macro-sensitivities",
        "flows-and-positioning",
        "forward-scenarios",
        "risk-portfolio-impact",
        "governance-flags",
        "news-sentiment-catalysts",
      ],
      suggestedModel: "gemini-2.5-pro",
      baseCredits: 10,
      estimatedTasks: { min: 28, max: 32 },
      estimatedSeconds: { min: 180, max: 360 },
    },
    "l4-institutional": {
      id: "l4-institutional",
      label: "L4 Institutional",
      shortLabel: "L4",
      description:
        "Everything in Comprehensive + the VaR/stress risk pack, portfolio-impact, catalyst calendar, theme evaluation and forensic accounting on Gemini 3.1 Pro - deepest reasoning + longest synthesis.",
      // MONEY-669 + MONEY-793 (C1b): a strict superset of `comprehensive` —
      // the L4-only advanced packs (risk-var-stress + portfolio-impact +
      // catalyst-calendar + theme-evaluation + forensic-accounting) are the
      // documented diff.
      defaultSkills: [
        "fundamentals-core",
        "cash-flow-quality",
        "earnings-deep-dive",
        "dcf-valuation",
        "dividend-income",
        "relative-valuation",
        "quant-factor-scores",
        "technical-trend",
        "chart-pattern-detection",
        "regime-volatility",
        "macro-sensitivities",
        "flows-and-positioning",
        "forward-scenarios",
        "risk-portfolio-impact",
        "risk-var-stress",
        "governance-flags",
        "news-sentiment-catalysts",
        // MONEY-793 (C1b): advanced-tier composed + forensic packs. The
        // situational packs (tax-planning / mf-deep-dive / global-funds)
        // stay opt-in, so L4 is no longer literally "every v2 skill".
        "portfolio-impact-on-user",
        "catalyst-calendar",
        "theme-evaluation",
        "forensic-accounting",
      ],
      suggestedModel: "gemini-3.1-pro-preview",
      baseCredits: 15,
      estimatedTasks: { min: 32, max: 38 },
      estimatedSeconds: { min: 240, max: 480 },
    },
    custom: {
      id: "custom",
      label: "Custom",
      shortLabel: "Custom",
      description: "Pick exactly the skills you want - credits scale live.",
      defaultSkills: [],
      suggestedModel: "gemini-2.5-pro",
      baseCredits: 1,
      estimatedTasks: { min: 0, max: 32 },
      estimatedSeconds: { min: 30, max: 360 },
    },
  };

/**
 * The model defaulted onto every research run unless the user has
 * explicitly chosen a different one in their composer prefs. Per the
 * MONEY-219 redesign brief: research should default to 2.5 Pro across
 * ALL paid tiers - 3.0/3.1 require explicit opt-in via the picker.
 */
export const RESEARCH_DEFAULT_MODEL = "gemini-2.5-pro";

// ─── MONEY-794 (C1c): institutional run-parameters ─────────────────────────
//
// Optional knobs that tune HOW a run is parameterised without changing the
// skill set. Every field defaults to today's behaviour, so an unset value
// produces an identical plan + report to before. The threading mirrors
// `researchFocus`/`preset`: schema → action extras → ResearchJobMessage →
// `agent.run` task-param stamp → planner/synthesizer prompt directives.

/** Analysis time horizon. Maps onto `fetch_price_history` `period` + a
 *  synthesizer framing directive. Default "1y" = today's hardcoded period. */
export const RESEARCH_HORIZONS = ["1y", "3y", "5y"] as const;
export type ResearchHorizon = (typeof RESEARCH_HORIZONS)[number];

/** Benchmark the beta / relative analysis is framed against. Default
 *  "NIFTY50" → `^NSEI` (today's hardcoded benchmark). A free-text sector
 *  string is also accepted (mapped to its sector index downstream). */
export const RESEARCH_BENCHMARKS = ["NIFTY50", "SENSEX", "NIFTY500"] as const;
export type ResearchBenchmark = (typeof RESEARCH_BENCHMARKS)[number];

/** Known benchmark id → Yahoo index symbol. `^NSEI` (Nifty 50) is the
 *  historical hardcoded default; `isBenchmarkSymbol` already tolerates
 *  `^BSESN` (SENSEX) + `NIFTY` variants in beta decomposition. */
export const BENCHMARK_SYMBOLS: Record<ResearchBenchmark, string> = {
  NIFTY50: "^NSEI",
  SENSEX: "^BSESN",
  NIFTY500: "^CRSLDX",
};

/**
 * Map a benchmark choice to the index symbol used by `fetch_price_history` /
 * beta computation. A known id resolves to its `^…` ticker; anything else
 * (a free-text sector name) is returned untouched so a sector-index resolver
 * downstream can handle it. Omitted → `^NSEI` (today's default).
 */
export function resolveBenchmarkSymbol(benchmark?: string): string {
  if (!benchmark) return "^NSEI";
  const known = (BENCHMARK_SYMBOLS as Record<string, string>)[benchmark];
  return known ?? benchmark;
}

/** Report depth / length guidance for the synthesizer. Default "standard"
 *  = today's advanced-prompt depth. */
export const RESEARCH_REPORT_LENGTHS = ["brief", "standard", "full"] as const;
export type ResearchReportLength = (typeof RESEARCH_REPORT_LENGTHS)[number];

/**
 * DCF / WACC / scenario assumption overrides. Stamped onto the
 * dcf / wacc / scenario task params; each tool keeps its own default when
 * the override is omitted (compute_wacc Rf=7.2%/Rm=12%, etc.).
 */
export const researchAssumptionsSchema = z.object({
  /** Weighted average cost of capital override (fraction, e.g. 0.11 for 11%). */
  wacc: z.number().min(0).max(1).optional(),
  /** Terminal growth-rate override (fraction, e.g. 0.04 for 4%). */
  terminalGrowth: z.number().min(-1).max(1).optional(),
  /** Forward growth-rate override applied to projection years (fraction). */
  growthOverride: z.number().min(-1).max(5).optional(),
});
export type ResearchAssumptions = z.infer<typeof researchAssumptionsSchema>;

/**
 * Value-at-Risk configuration. Stamped onto the VaR / position-VaR task
 * params; the tools keep their 95% / 1-day defaults when omitted.
 */
export const researchVarConfigSchema = z.object({
  /** Confidence level for VaR (95 or 99). Default 95. */
  confidence: z.union([z.literal(95), z.literal(99)]).optional(),
  /** VaR holding horizon in trading days (1 or 10). Default 1. */
  horizonDays: z.union([z.literal(1), z.literal(10)]).optional(),
});
export type ResearchVarConfig = z.infer<typeof researchVarConfigSchema>;

export const researchPreferencesSchema = z.object({
  researchStyle: z.enum(RESEARCH_STYLES),
  customSkills: z.array(z.enum(RESEARCH_SKILL_IDS)),
  researchFocus: z
    .string()
    .trim()
    .max(280, "Custom focus must be ≤280 characters")
    .optional()
    .or(z.literal("")),
  /**
   * MONEY-219 - the preset the user picked last (drives the default
   * skill bundle for the next run). Optional so legacy prefs continue
   * to deserialise.
   */
  preset: z.enum(RESEARCH_PRESETS).optional(),
  /**
   * Skills the user *added* on top of the preset's defaults for the
   * next run. Persisted so a frequent "Investment Thesis +
   * governance-flags" combination survives reloads.
   */
  extraSkills: z.array(z.enum(RESEARCH_SKILL_IDS)).optional(),
  /**
   * Skills the user *removed* from the preset's defaults for the next
   * run. Persisted for the same reason as extraSkills.
   */
  removedSkills: z.array(z.enum(RESEARCH_SKILL_IDS)).optional(),
  /**
   * MONEY-239 C - user-saved skill bundles. Each bundle is a named
   * snapshot of {skills, model, focus} the user can re-apply with one
   * click via the picker's "My templates" section.
   */
  customPresets: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(80),
        skills: z.array(z.enum(RESEARCH_SKILL_IDS)),
        model: z.string().optional(),
        focus: z.string().max(280).optional(),
        createdAt: z.string().or(z.date()).optional(),
      }),
    )
    .max(20)
    .optional(),
  // ── MONEY-794 (C1c): institutional run-parameters (all optional; unset →
  //    identical plan/report to today). ───────────────────────────────────
  /** Analysis horizon → stamped onto `fetch_price_history.period` + a
   *  synthesizer framing directive. Omitted = today's per-skill default. */
  horizon: z.enum(RESEARCH_HORIZONS).optional(),
  /** Benchmark for beta / relative framing. A known id (NIFTY50/SENSEX/
   *  NIFTY500) or a free-text sector name; mapped to a symbol downstream.
   *  Omitted = `^NSEI`. */
  benchmark: z
    .enum(RESEARCH_BENCHMARKS)
    .or(z.string().trim().min(1).max(40))
    .optional(),
  /** DCF / WACC / scenario assumption overrides; omitted = tool defaults. */
  assumptions: researchAssumptionsSchema.optional(),
  /** Report depth guidance for the synthesizer. Omitted = "standard". */
  reportLength: z.enum(RESEARCH_REPORT_LENGTHS).optional(),
  /** VaR confidence / horizon overrides; omitted = 95% / 1-day. */
  varConfig: researchVarConfigSchema.optional(),
});

export type ResearchPreferencesInput = z.infer<
  typeof researchPreferencesSchema
>;

export interface ResearchPreferences extends ResearchPreferencesInput {
  updatedAt: Date;
}

export const DEFAULT_RESEARCH_PREFERENCES: ResearchPreferences = {
  researchStyle: "auto",
  customSkills: [],
  researchFocus: undefined,
  preset: undefined,
  extraSkills: undefined,
  removedSkills: undefined,
  customPresets: undefined,
  horizon: undefined,
  benchmark: undefined,
  assumptions: undefined,
  reportLength: undefined,
  varConfig: undefined,
  updatedAt: new Date(0), // sentinel = "never set"
};

/**
 * Compute the effective skill set for a given preset + user adjustments.
 * Used by the planner + confirmation panel + dynamic-credits estimator.
 *
 *   effective = (preset.defaultSkills ∪ extraSkills) − removedSkills
 *
 * v1 alias IDs in any of the three inputs are expanded to v2 first.
 */
export function resolveEffectiveSkills(input: {
  preset?: ResearchPresetId;
  extraSkills?: readonly ResearchSkillId[];
  removedSkills?: readonly ResearchSkillId[];
  /** Set when researchStyle === "custom" - overrides preset defaults. */
  customOnlySkills?: readonly ResearchSkillId[];
}): ResearchSkillId[] {
  if (input.customOnlySkills && input.customOnlySkills.length > 0) {
    return expandSkillAliases(input.customOnlySkills);
  }
  const presetDef = input.preset ? RESEARCH_PRESET_DEFS[input.preset] : null;
  const base = presetDef ? expandSkillAliases(presetDef.defaultSkills) : [];
  const extra = expandSkillAliases(input.extraSkills ?? []);
  const removed = expandSkillAliases(input.removedSkills ?? []);
  const removedSet = new Set<ResearchSkillId>();
  removed.forEach((r) => removedSet.add(r));
  const merged = new Set<ResearchSkillId>();
  base.forEach((id) => merged.add(id));
  extra.forEach((id) => merged.add(id));
  removedSet.forEach((r) => merged.delete(r));
  return Array.from(merged);
}

/**
 * Read the user's research preferences. Returns DEFAULT_RESEARCH_PREFERENCES
 * (style=auto) when the user hasn't saved any - callers don't need to
 * branch on null.
 */
export async function getResearchPreferences(
  userId: string,
): Promise<ResearchPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user?.preferences || typeof user.preferences !== "object") {
    return DEFAULT_RESEARCH_PREFERENCES;
  }
  const all = user.preferences as Record<string, unknown>;
  const research = all.research;
  if (!research || typeof research !== "object") {
    return DEFAULT_RESEARCH_PREFERENCES;
  }
  const raw = research as Record<string, unknown>;
  const parsed = researchPreferencesSchema.safeParse({
    researchStyle: raw.researchStyle,
    customSkills: raw.customSkills ?? [],
    researchFocus: raw.researchFocus || undefined,
    // MONEY-219 v2 + MONEY-794 (C1c): round-trip the persisted run-params so a
    // saved preset / horizon / benchmark survives a reload.
    preset: raw.preset,
    extraSkills: raw.extraSkills,
    removedSkills: raw.removedSkills,
    customPresets: raw.customPresets,
    horizon: raw.horizon,
    benchmark: raw.benchmark,
    assumptions: raw.assumptions,
    reportLength: raw.reportLength,
    varConfig: raw.varConfig,
  });
  if (!parsed.success) {
    // Drift / corruption - return defaults rather than throw, so the chat
    // surface keeps working even if a stale value is persisted.
    return DEFAULT_RESEARCH_PREFERENCES;
  }
  return {
    ...parsed.data,
    researchFocus: parsed.data.researchFocus || undefined,
    updatedAt: raw.updatedAt ? new Date(raw.updatedAt as string) : new Date(0),
  };
}

/**
 * Set / update the user's research preferences. Validates with Zod, merges
 * with existing values (so a partial update like `{ researchStyle: "deep" }`
 * doesn't blow away a previously-set focus text).
 */
export async function setResearchPreferences(
  userId: string,
  input: Partial<ResearchPreferencesInput>,
): Promise<ResearchPreferences> {
  const existing = await getResearchPreferences(userId);
  const merged = researchPreferencesSchema.parse({
    researchStyle: input.researchStyle ?? existing.researchStyle,
    customSkills: input.customSkills ?? existing.customSkills,
    researchFocus:
      input.researchFocus !== undefined
        ? input.researchFocus
        : existing.researchFocus,
    preset: input.preset ?? existing.preset,
    extraSkills: input.extraSkills ?? existing.extraSkills,
    removedSkills: input.removedSkills ?? existing.removedSkills,
    customPresets: input.customPresets ?? existing.customPresets,
    // MONEY-794 (C1c) - run-parameters; partial update preserves prior values.
    horizon: input.horizon ?? existing.horizon,
    benchmark: input.benchmark ?? existing.benchmark,
    assumptions: input.assumptions ?? existing.assumptions,
    reportLength: input.reportLength ?? existing.reportLength,
    varConfig: input.varConfig ?? existing.varConfig,
  });

  const next: ResearchPreferences = {
    ...merged,
    researchFocus: merged.researchFocus || undefined,
    updatedAt: new Date(),
  };

  // Read full preferences blob so we don't clobber sibling buckets.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const allPrefs =
    user?.preferences && typeof user.preferences === "object"
      ? (user.preferences as Record<string, unknown>)
      : {};

  await prisma.user.update({
    where: { id: userId },
    data: {
      preferences: {
        ...allPrefs,
        research: next,
      } as unknown as object,
    },
  });

  return next;
}

/**
 * User-friendly skill labels (used by the popover checklist in MONEY-220
 * and the redesigned confirmation panel in MONEY-219).
 */
export const RESEARCH_SKILL_LABELS: Record<ResearchSkillId, string> = {
  // v2
  "fundamentals-core": "Fundamentals Core",
  "cash-flow-quality": "Cash Flow Quality",
  "earnings-deep-dive": "Earnings Deep Dive",
  "dcf-valuation": "DCF Valuation",
  "dividend-income": "Dividend & Income",
  "relative-valuation": "Relative Valuation",
  "quant-factor-scores": "Quant Factor Scores",
  "technical-trend": "Technical Trend",
  "chart-pattern-detection": "Chart & Candle Patterns",
  "regime-volatility": "Regime & Volatility",
  "macro-sensitivities": "Macro Sensitivities",
  "flows-and-positioning": "Flows & Positioning",
  "forward-scenarios": "Forward Scenarios",
  "risk-portfolio-impact": "Risk & Portfolio Impact",
  "risk-var-stress": "VaR & Stress Pack",
  "governance-flags": "Governance Flags",
  "news-sentiment-catalysts": "News & Catalysts",
  // MONEY-793 (C1b): composed + promoted-orphan skills
  "portfolio-impact-on-user": "Portfolio Impact (yours)",
  "catalyst-calendar": "Catalyst Calendar",
  "theme-evaluation": "Theme Evaluation",
  "tax-planning": "Tax Planning",
  "mf-deep-dive": "MF Deep Dive",
  "global-funds": "Global Funds",
  "forensic-accounting": "Forensic Accounting",
  // v1 aliases (kept so saved prefs render labelled)
  "investment-thesis": "Investment Thesis (legacy)",
  "peer-comparison": "Peer Comparison (legacy)",
  "earnings-analysis": "Earnings Analysis (legacy)",
  "financial-deep-dive": "Financial Deep Dive (legacy)",
  "stock-analysis": "Technical Analysis (legacy)",
  "macro-analysis": "Macro & Sector Context (legacy)",
};

/** One-line tooltip shown next to each skill chip. */
export const RESEARCH_SKILL_DESCRIPTIONS: Record<ResearchSkillId, string> = {
  "fundamentals-core":
    "Health score · growth metrics · accounting flags · revenue mix",
  "cash-flow-quality":
    "OCF vs EPS · CapEx intensity · FCF yield · working-capital drag",
  "earnings-deep-dive":
    "Beat/miss history · estimate dispersion · guidance sensitivity",
  "dcf-valuation": "WACC · DCF · terminal sensitivity · scenario fan",
  "dividend-income": "DDM · payout · coverage · dividend history",
  "relative-valuation":
    "Peer comparison · sector aggregates · valuation bands · EV/x curves",
  "quant-factor-scores":
    "Value · Quality · Momentum · Low-vol composite z-scores",
  "technical-trend": "Trend strength · MA crossovers · ADX · volume profile",
  "chart-pattern-detection":
    "Chart patterns · candlestick formations · breakout setups",
  "regime-volatility":
    "ATR/IVR · vol regime · drawdown profile · regime-conditional beta",
  "macro-sensitivities":
    "Rate · INR · Brent betas · RBI impact · commodity correlation",
  "flows-and-positioning": "FII / DII flows · sector rotation · short interest",
  "forward-scenarios":
    "Monte-Carlo returns · pattern-matching forward outcomes",
  "risk-portfolio-impact":
    "Position-VaR · concentration delta · portfolio beta drift",
  "risk-var-stress":
    "VaR · max drawdown · beta · Sharpe/Sortino · correlation matrix",
  "governance-flags":
    "Promoter pledging · related-party · auditor change · RPT sigma",
  "news-sentiment-catalysts":
    "Recent news · sentiment classification · upcoming catalysts",
  "portfolio-impact-on-user":
    "Portfolio delta · concentration · rebalancing · overlap · position-VaR",
  "catalyst-calendar":
    "Earnings calendar · corporate actions · exchange filings · news sentiment",
  "theme-evaluation":
    "Theme evaluation · sector rotation · advanced stock screening",
  "tax-planning": "Capital-gains tax · harvesting · advance tax · ITR schedule",
  "mf-deep-dive":
    "MF analysis · constituent breakdown · overview/holdings/peers",
  "global-funds": "Global fund fetch · cross-border fund comparison",
  "forensic-accounting":
    "Piotroski · Altman-Z · Beneish-M · accounting quality · governance flags",
  "investment-thesis": "Legacy - expands to fundamentals + DCF + peers",
  "peer-comparison": "Legacy - expands to relative-valuation",
  "earnings-analysis": "Legacy - expands to earnings-deep-dive",
  "financial-deep-dive": "Legacy - expands to fundamentals + cash-flow",
  "stock-analysis": "Legacy - expands to fundamentals + technical + patterns",
  "macro-analysis": "Legacy - expands to macro-sensitivities + flows",
};
