/**
 * Pure helpers for `ResearchModal` (MONEY-779 / MONEY-801), extracted out of the
 * `"use client"` component so the run-parameter assembly is unit-testable
 * without React / next-navigation / sonner / Clerk hooks.
 *
 * `ResearchModal.tsx` imports + calls these — there is no shadow copy. The
 * producer side (`buildRunParamsExtras` / `pctToFraction`) builds the SAME
 * `assumptions` / `varConfig` object that the server action's
 * `sanitizeAgainstSchema` (research-run-params-logic.ts) later validates, so the
 * two ends are pinned by tests at both layers.
 */

import type {
  ResearchHorizon,
  ResearchReportLength,
} from "@usemoney/services/preferences";

/** UI research-style chip. Mirrors the modal's local union. */
export type ResearchStyle =
  | "auto"
  | "quick"
  | "deep"
  | "comprehensive"
  | "advanced"
  | "custom";

/** Map UI style → worker mode. auto = let the planner pick (undefined). */
export function styleToMode(
  style: ResearchStyle
): "fast" | "advanced" | undefined {
  if (style === "quick") return "fast";
  if (style === "auto") return undefined;
  return "advanced";
}

/**
 * Map style → preset id (skill bundle). Each non-custom, non-auto style maps to
 * a deterministic preset so the skills picker resets to a sensible default on
 * every style change. auto (planner picks at runtime) and custom (user owns the
 * list) intentionally return undefined so the current selection is left alone.
 */
export function styleToPresetId(
  style: ResearchStyle
):
  | "quick-pulse"
  | "investment-thesis"
  | "comprehensive"
  | "l4-institutional"
  | undefined {
  if (style === "quick") return "quick-pulse";
  if (style === "deep") return "investment-thesis";
  if (style === "comprehensive") return "comprehensive";
  if (style === "advanced") return "l4-institutional";
  return undefined;
}

/**
 * Clamp the entity name at the data layer. Long MF/ETF scheme names used to blow
 * up the modal header before this hit the renderer. Caps at ~58 chars and
 * appends an ellipsis; the full text stays available via the `title` tooltip.
 */
export const NAME_MAX_CHARS = 58;
export function clampName(name: string | undefined | null): string {
  if (!name) return "";
  const cleaned = name.trim();
  if (cleaned.length <= NAME_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, NAME_MAX_CHARS).trim()}…`;
}

/** Shape of the run-param slice of the research action's extras. Field names
 *  mirror `ResearchActionExtras` (lib/actions/research.ts) exactly so they
 *  thread straight through to the ResearchJobMessage. */
export interface RunParamsExtras {
  horizon?: ResearchHorizon;
  benchmark?: string;
  reportLength?: ResearchReportLength;
  varConfig?: { confidence?: 95 | 99; horizonDays?: 1 | 10 };
  assumptions?: {
    wacc?: number;
    terminalGrowth?: number;
    growthOverride?: number;
  };
}

/**
 * Parse a percentage text field (e.g. "11" or "11.5") to a fraction (0.11),
 * rejecting out-of-range input so an absurd value (a fat-fingered "5000") never
 * reaches the worker's compute_dcf / compute_wacc params raw. Bounds are the
 * FRACTION limits the server schemas enforce (researchAssumptionsSchema):
 * wacc 0–1, terminalGrowth -1–1, growthOverride -1–5. Empty / non-finite /
 * out-of-bounds input → undefined (field stays unset; the tool keeps its own
 * default) — MONEY-779.
 */
export function pctToFraction(
  text: string,
  bounds: { min: number; max: number }
): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const pct = Number(trimmed);
  if (!Number.isFinite(pct)) return undefined;
  const fraction = pct / 100;
  if (fraction < bounds.min || fraction > bounds.max) return undefined;
  return fraction;
}

/**
 * Build the run-parameter extras, omitting every value the user left at its
 * behaviour-neutral default so an untouched run reproduces today's plan +
 * report exactly (the action only forwards each key when present):
 *   - horizon: only when explicitly chosen (undefined = per-skill default).
 *   - benchmark: only a non-empty selection ("" = default ^NSEI / NIFTY 50).
 *   - reportLength: "standard" IS the default, so only brief/full is sent.
 *   - varConfig: only when it deviates from 95% / 1-day.
 *   - assumptions: only the fields the user typed (each in % → fraction).
 */
export function buildRunParamsExtras(input: {
  horizon: ResearchHorizon | undefined;
  benchmark: string;
  reportLength: ResearchReportLength;
  varConfidence: 95 | 99;
  varHorizonDays: 1 | 10;
  waccPct: string;
  terminalGrowthPct: string;
  growthOverridePct: string;
}): RunParamsExtras {
  const out: RunParamsExtras = {};

  if (input.horizon) out.horizon = input.horizon;
  if (input.benchmark.trim()) out.benchmark = input.benchmark.trim();
  if (input.reportLength !== "standard") out.reportLength = input.reportLength;

  const varConfig: { confidence?: 95 | 99; horizonDays?: 1 | 10 } = {};
  if (input.varConfidence !== 95) varConfig.confidence = input.varConfidence;
  if (input.varHorizonDays !== 1) varConfig.horizonDays = input.varHorizonDays;
  if (Object.keys(varConfig).length > 0) out.varConfig = varConfig;

  // Bounds mirror researchAssumptionsSchema (packages/services) exactly so the
  // modal rejects the same out-of-range values the server action drops.
  const wacc = pctToFraction(input.waccPct, { min: 0, max: 1 });
  const terminalGrowth = pctToFraction(input.terminalGrowthPct, {
    min: -1,
    max: 1,
  });
  const growthOverride = pctToFraction(input.growthOverridePct, {
    min: -1,
    max: 5,
  });
  const assumptions: {
    wacc?: number;
    terminalGrowth?: number;
    growthOverride?: number;
  } = {};
  if (wacc !== undefined) assumptions.wacc = wacc;
  if (terminalGrowth !== undefined) assumptions.terminalGrowth = terminalGrowth;
  if (growthOverride !== undefined) assumptions.growthOverride = growthOverride;
  if (Object.keys(assumptions).length > 0) out.assumptions = assumptions;

  return out;
}
