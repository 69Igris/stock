/**
 * Canonical research-tier registry (MONEY-612).
 *
 * Single source of truth for the L1 / L2 / L3 / L4 / custom analysis tiers.
 * The audit found tier logic scattered: L1 lives in `flash-responder.ts`, L2 in
 * the agent's fast/advanced configs, L3/L4 in `analysis.ts` segment arrays, and
 * custom in `apply-preferences.ts`. This module documents the distinction in
 * ONE place so the classifier, the analysis actions, the credit layer, and the
 * UI all read the same definitions.
 *
 * This is METADATA only — it does not change pricing or behaviour. Credit costs
 * stay owned by `CREDIT_COSTS` (@usemoney/core); `creditAction` here points at
 * the primary key each tier bills against.
 */

export type ResearchTierId = "l1" | "l2" | "l3" | "l4" | "custom";

export interface ResearchTierDef {
  id: ResearchTierId;
  /** Short label for the UI ("Flash", "Deep Dive", …). */
  label: string;
  /** Plain-English, one-line description of what the tier does. */
  description: string;
  /**
   * How the tier is chosen:
   *  - "auto"     → picked by the chat classifier from the user's message
   *  - "explicit" → an explicit user choice (analysis UI / skill picker)
   */
  selection: "auto" | "explicit";
  /** Gemini model tier used for the synthesis pass. */
  model: "flash" | "pro";
  /** Number of segment passes (0 = single-pass / no segment chain). */
  segments: number;
  /** Whether the agent runs the validate → refine loop. */
  validates: boolean;
  /** Primary CREDIT_COSTS action key this tier bills against. */
  creditAction: string;
  /** True if the tier is free for every plan. */
  free: boolean;
}

export const RESEARCH_TIERS: Record<ResearchTierId, ResearchTierDef> = {
  l1: {
    id: "l1",
    label: "Flash",
    description:
      "Instant in-chat answer to a single fact or quick lookup — one Flash call, no agent, no credits.",
    selection: "auto",
    model: "flash",
    segments: 0,
    validates: false,
    creditAction: "l1_flash",
    free: true,
  },
  l2: {
    id: "l2",
    label: "Deep Dive",
    description:
      "A single research report run by the agent (plan → tools → synthesize). 'fast' is a trimmed pass; 'advanced' adds the validate → refine loop.",
    selection: "auto",
    model: "pro",
    segments: 0,
    validates: true,
    creditAction: "l2_research_fast",
    free: false,
  },
  l3: {
    id: "l3",
    label: "Comprehensive",
    description:
      "Six-segment comprehensive analysis — each segment is a fresh agent run scoped to one skill area, chained via Pub/Sub, then synthesized.",
    selection: "explicit",
    model: "pro",
    segments: 6,
    validates: true,
    creditAction: "l3_comprehensive_stock",
    free: false,
  },
  l4: {
    id: "l4",
    label: "Advanced",
    description:
      "Twelve-segment institutional-depth analysis (quant, regime, macro, governance, forward scenarios + an executive synthesis). Currently billed at the L3 comprehensive rate.",
    selection: "explicit",
    model: "pro",
    segments: 12,
    validates: true,
    creditAction: "l3_comprehensive_stock",
    free: false,
  },
  custom: {
    id: "custom",
    label: "Custom",
    description:
      "User-selected skills + research focus applied on top of a chosen depth (apply-preferences). Cost scales with the depth and skill count.",
    selection: "explicit",
    model: "pro",
    segments: 0,
    validates: true,
    creditAction: "l2_research_advanced",
    free: false,
  },
};

/** Display order for tier pickers. */
export const TIER_ORDER: readonly ResearchTierId[] = [
  "l1",
  "l2",
  "l3",
  "l4",
  "custom",
] as const;

export function getResearchTier(id: ResearchTierId): ResearchTierDef {
  return RESEARCH_TIERS[id];
}

/**
 * Resolve a chat-classifier label ("L1" | "L2" | "L3" | "L4") to its registry
 * definition. Returns null for anything that isn't a known tier.
 */
export function tierFromLabel(label: string): ResearchTierDef | null {
  const id = label.toLowerCase();
  return id in RESEARCH_TIERS ? RESEARCH_TIERS[id as ResearchTierId] : null;
}
