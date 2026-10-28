/**
 * Gemini Model Registry — MONEY-229 Phase A, reworked for MONEY-619.
 *
 * Single source of truth for the user-pickable Gemini models AND the
 * tier→model routing policy (chat "fast lane" vs research "deep lane").
 *
 * Two lanes, keyed on the user's BASE plan (FREE / PRO / PREMIUM):
 *   - chat   (fast):  FREE 2.5-flash · PRO 3-flash-preview · PREMIUM 3.5-flash
 *   - research (deep): FREE 2.5-pro  · PRO/PREMIUM 3.1-pro-preview
 *
 * Research/analysis is finance-domain (DCF, forensic ratios, multi-step
 * thesis reasoning), so both paid tiers get the frontier 3.x Pro
 * (gemini-3.1-pro-preview) for the deep lane; tiers differentiate on chat
 * model + credits + concurrency.
 *
 * Normal chat never runs a Pro model — a Pro pick is downgraded to the
 * tier's Flash for latency — UNLESS the user opts into "thinking" mode,
 * which runs the tier's Pro model and is charged via credits (the caller
 * applies the charge; here `resolveChatModel({ thinking })` just returns
 * the deep-lane model).
 *
 * Plan collapsing: QUERY_PACK is a credit top-up, NOT a tier (→ FREE
 * base); ULTIMATE folds up to PREMIUM. See `resolveBasePlan`.
 *
 * Backend (MONEY-650): all models now run on the Gemini DEVELOPER API
 * (api key bound to the gemini-stockbook-qa SA), which is region-less — so
 * there is no per-model location split anymore. `getModelLocation` is kept
 * only for the legacy Vertex fallback (when no GOOGLE_GENAI_API_KEY is set).
 * Every id below is verified callable on the Developer API, so there is no
 * env gate.
 *
 * Adding a user-pickable model = one entry in GEMINI_MODELS.
 */

import { resolvePlanId, type PlanId } from "../subscription/plans";
// SDK-free access module ONLY — model-registry is pulled into the client
// bundle by the model pickers, so it must never (transitively) import
// `@anthropic-ai/sdk` (node:fs/node:path break webpack). See anthropic/access.
import {
  isClaudeConfigured,
  isClaudeAllowedForEmail,
} from "../anthropic/access";

export type ModelTier = "L1" | "L2" | "L3";
export type ModelProvider = "google" | "anthropic" | "openai" | "xai";
/** Collapsed routing tier used for model selection (3 buckets). */
export type BasePlanTier = "FREE" | "PRO" | "PREMIUM";

export interface ModelDefinition {
  /** Stable user-facing ID - also the Vertex AI model name. */
  id: string;
  /** Marketing name shown in the picker. */
  displayName: string;
  /** Provider grouping for the picker section header. */
  provider: ModelProvider;
  /** Abstract size class - drives the picker section ordering. */
  tier: ModelTier;
  /**
   * Credit adjustment applied on top of the action's base cost. Can be
   * negative to make a Pro model cheaper than the baseline.
   *   - 0 for the Flash family (free chat + paid-tier chat models)
   *   - -1 for 2.5-Pro (the cheap-but-capable Pro)
   *   - +2 for 3-Pro (deepest, most expensive)
   * Total cost is clamped at >= 0; "free chat" actions (l1_*) ignore
   * the premium entirely (see `getEffectiveCreditCost`).
   */
  creditPremium: number;
  /** Minimum plan required (rank-gated: FREE < PRO < PREMIUM). */
  requiresPlan: PlanId;
  /** Optional one-line description for the picker. */
  description?: string;
  /**
   * Registered for a SYSTEM lane, never offered to a user — MONEY-1314.
   *
   * Distinct from `founderOnly`, which gates a model behind an allowlist but
   * still SHOWS it. This one is not a chat model at all: it exists so
   * `resolveDocParseModel` can honour it (an unregistered id is ignored with a
   * warning and the 4x-priced fallback runs), and for no other reason.
   *
   * Without it, registering a model puts it in the user-facing picker:
   * `getPickerModelsForUser` filters on `founderOnly` / `isModelAvailable`,
   * NOT on `CHAT_MODEL_BY_TIER` — so checking the tier map, as the first
   * version of this branch's test did, checks the wrong gate entirely.
   */
  internalOnly?: boolean;
  /**
   * MONEY-626: founder-only model — Claude is gated to the allowlist (see
   * `anthropic/access.ts`). These are hidden from the picker and refused by
   * the resolvers for everyone else; Gemini stays the default for all.
   */
  founderOnly?: boolean;
}

/**
 * Picker order — Pro models first (deepest reasoning surfaces on top),
 * then the paid-chat Flash family, then the FREE Flash family last. The
 * picker UI groups by `requiresPlan` for the section headers.
 *
 * MONEY-650: the registry mirrors the model ids that are actually callable
 * on the Gemini Developer API (verified via scripts/diag/list-models-detail
 * + confirm-key). The 3.x ids are the live preview ids — gemini-3.1-pro-preview
 * (the older gemini-3-pro-preview is deprecated) and gemini-3-flash-preview —
 * NOT the bare gemini-3-pro / gemini-3-flash names, which 404.
 */
export const GEMINI_MODELS: ModelDefinition[] = [
  // ── Deep lane (Pro) — newest first ──────────────────────────────
  {
    id: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    provider: "google",
    tier: "L3",
    creditPremium: 2,
    requiresPlan: "PRO",
    description: "Deepest reasoning · +2 credits",
  },
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    provider: "google",
    tier: "L2",
    creditPremium: -1,
    requiresPlan: "PRO",
    description: "Strong reasoning · best value",
  },
  // ── Fast lane (paid chat Flash) ─────────────────────────────────
  {
    /**
     * MONEY-1314 — REGISTERED FOR THE DOCUMENT LANE, NOT FOR CHAT.
     *
     * It is deliberately absent from `CHAT_MODEL_BY_TIER`: no user-facing tier
     * selects it, and the document backfill reaches it only by naming it in
     * `DOC_PARSE_MODEL`.
     *
     * Registration is not cosmetic here — it is the gate. `resolveDocParseModel`
     * honours an override ONLY when `getModelDefinition(id)` knows it AND
     * `isModelAvailable(id)` agrees, and an unregistered id is IGNORED with a
     * warning rather than forwarded. So before this entry existed,
     * `DOC_PARSE_MODEL=gemini-3.7-flash` silently ran the whole ~48,000-document
     * backfill on `gemini-3.5-flash` instead — at $1.50/$9.00 per 1M against
     * 3.7's $0.75/$3.75, i.e. FOUR TIMES the batch cost, with a warning line as
     * the only symptom.
     *
     * Live-verified 2026-09-01 on the Developer API: present in GET /v1beta/models,
     * and a `generateContent` with a `responseSchema` returned 200 with
     * `modelVersion: "gemini-3.7-flash"`. A `batchGenerateContent` submission was
     * accepted on the same key.
     *
     * PRICING NOTE: the $0.375/$1.875 batch rate is PROMOTIONAL and input doubles
     * on 1 Jan 2027. That is a reason to finish the drain promptly, not to pick a
     * different model.
     */
    id: "gemini-3.7-flash",
    internalOnly: true,
    displayName: "Gemini 3.7 Flash",
    provider: "google",
    tier: "L1",
    creditPremium: 0,
    requiresPlan: "PREMIUM",
    description: "Fastest 3.x · document extraction lane",
  },
  {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    provider: "google",
    tier: "L1",
    creditPremium: 0,
    requiresPlan: "PREMIUM",
    description: "Fastest · near-Pro quality",
  },
  {
    id: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash",
    provider: "google",
    tier: "L1",
    creditPremium: 0,
    requiresPlan: "PRO",
    description: "Fast · capable 3.x",
  },
  // ── FREE tier - kept stable ─────────────────────────────────────
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    provider: "google",
    tier: "L1",
    creditPremium: 0,
    requiresPlan: "FREE",
    description: "Fast · daily limit",
  },
  {
    id: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash Lite",
    provider: "google",
    tier: "L1",
    creditPremium: 0,
    requiresPlan: "FREE",
    description: "Cheapest · daily limit",
  },
  // ── Anthropic Claude (MONEY-626) — founder-only, opt-in over Gemini.
  // Multiple Opus minors are offered deliberately so the cheaper/older
  // tiers can be picked when Opus 4.8 isn't worth the cost. IDs follow
  // Anthropic's naming convention; a not-yet-served id degrades to Gemini
  // via the compat adapter's fallback, so listing them is safe.
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    provider: "anthropic",
    tier: "L3",
    creditPremium: 4,
    requiresPlan: "PRO",
    description: "Most capable Claude · highest cost",
    founderOnly: true,
  },
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    provider: "anthropic",
    tier: "L3",
    creditPremium: 3,
    requiresPlan: "PRO",
    description: "Prior Opus · cheaper than 4.8",
    founderOnly: true,
  },
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    provider: "anthropic",
    tier: "L3",
    creditPremium: 3,
    requiresPlan: "PRO",
    description: "Older Opus · lowest Opus cost",
    founderOnly: true,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    provider: "anthropic",
    tier: "L2",
    creditPremium: 1,
    requiresPlan: "PRO",
    description: "Balanced Claude · strong value",
    founderOnly: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    provider: "anthropic",
    tier: "L1",
    creditPremium: 0,
    requiresPlan: "PRO",
    description: "Fastest, cheapest Claude",
    founderOnly: true,
  },
];

const MODEL_BY_ID = new Map(GEMINI_MODELS.map((m) => [m.id, m]));

/**
 * Env-based gating registry: map a model id → an env var name. `isModelAvailable`
 * hides a gated model unless that env var is "true", and the resolve helpers
 * (`getResearchModel`, `resolveResearchModel`, `resolveChatModel`,
 * `isModelAvailableOnPlan`) degrade a gated id to the plan/lane default — so we
 * never hand a 404-ing id to the backend.
 *
 * MONEY-650: the gate is now EMPTY. On the Gemini Developer API every id in
 * GEMINI_MODELS is verified callable (the old `ENABLE_GEMINI_3X` gate existed
 * because the bare gemini-3-pro / gemini-3-flash names 404'd on Vertex; we no
 * longer reference those names — the live preview ids replace them). The
 * mechanism is retained (not deleted) so a future not-yet-rolled-out model can
 * be re-gated by adding one entry here, without touching the resolve helpers.
 */
const ENV_GATED_MODELS: Record<string, string> = {};

/**
 * Whether a model is currently selectable in this environment. Hidden
 * models are excluded from the picker AND fall back to the plan/lane
 * default at resolve time, so we never hand a 404-ing id to the backend.
 */
export function isModelAvailable(id: string): boolean {
  // MONEY-626: Claude models are available only when Claude is configured
  // (key present + kill switch off). The per-USER founder allowlist is a
  // separate check (`getAvailableModelsForUser` / the resolvers).
  const def = MODEL_BY_ID.get(id);
  if (def?.provider === "anthropic") return isClaudeConfigured();
  const envVar = ENV_GATED_MODELS[id];
  if (!envVar) return true;
  return process.env[envVar] === "true";
}

/** Models filtered to those currently selectable in this environment. */
export function getAvailableGeminiModels(): ModelDefinition[] {
  return GEMINI_MODELS.filter((m) => isModelAvailable(m.id));
}

/**
 * Models selectable for a SPECIFIC user (MONEY-626): every available Gemini
 * model for everyone, plus the founder-only Claude models when the user is
 * on the Claude allowlist. This is what the model pickers should call so a
 * non-allowlisted user never even sees Claude.
 */
export function getAvailableModelsForUser(
  email: string | null | undefined,
  planId: PlanId | string,
): ModelDefinition[] {
  return GEMINI_MODELS.filter(
    (m) =>
      // `internalOnly` FIRST, matching getPickerModelsForUser. A system-lane
      // model is not a chat option for ANYONE, so it is excluded before any
      // entitlement is consulted. Without this the two sibling exports
      // disagreed — hidden from the picker, returned by the availability API —
      // and the registry test titled "internalOnly hides a model from EVERY
      // caller" only ever exercised the picker.
      !m.internalOnly &&
      isModelAvailable(m.id) &&
      isRestrictedModelAllowed(m, email, planId),
  );
}

/**
 * May this user reach a `founderOnly` model? — MONEY-1274 (MONEY-1155 #27,
 * "Allow Claude models in premium plans").
 *
 * Claude was allowlist-only: `founderOnly: true` on all five models and a gate
 * that knew about EMAILS and nothing else, so a paying PREMIUM subscriber could
 * not reach Claude at all. That is what #27 asks for.
 *
 * The fix deliberately adds no new concept. Each model already declares
 * `requiresPlan` — the purpose-built knob, enforced by rank in
 * `isModelAvailableOnPlan` — and every Claude model declares `"PRO"`. So a
 * restricted model is now allowed when the user's plan satisfies the model's
 * OWN requirement, exactly like every other model in the registry.
 *
 * The email allowlist is KEPT as an override rather than replaced, for two
 * reasons: the founder must keep access regardless of what plan the account is
 * on, and `CLAUDE_ALLOWED_EMAILS` is the documented route for adding interns
 * without giving them a subscription.
 *
 * NOTE the cost knob is per-model and unchanged: Claude Opus carries
 * `creditPremium: 4`, so access is metered in credits rather than unbounded.
 * To narrow Claude to the PREMIUM tier only, change `requiresPlan` on those
 * entries to "PREMIUM" — that single field is the whole control surface, which
 * is the point of routing through it rather than adding a second gate.
 */
function isRestrictedModelAllowed(
  model: ModelDefinition,
  email: string | null | undefined,
  planId: PlanId | string,
): boolean {
  if (!model.founderOnly) return true;
  if (isClaudeAllowedForEmail(email)) return true;
  return planRank(planId) >= modelRequiredRank(model.id);
}

/**
 * May this user's Claude PICK be honoured by the server? — MONEY-1274 (#27).
 *
 * The load-bearing half. `getPickerModelsForUser` only decides what the UI
 * SHOWS; the chat route decides what is actually resolved, and it previously
 * asked `isClaudeAvailableForEmail` — allowlist only. Widening the picker
 * without widening this would show a PREMIUM subscriber Claude and then
 * silently answer with Gemini, which is worse than not offering it: the user
 * pays the Claude credit premium in their head and cannot tell what they got.
 *
 * ONE rule, exported, so the picker and the resolver cannot drift — the
 * duplication that produced the two SIP formulas and the two market-cap
 * ladders. `isClaudeConfigured()` stays the floor: no key or kill-switch off
 * means no Claude for anyone, whatever their plan.
 */
export function isClaudeEntitled(
  email: string | null | undefined,
  planId: PlanId | string,
): boolean {
  if (!isClaudeConfigured()) return false;
  if (isClaudeAllowedForEmail(email)) return true;
  // Any Claude model the plan's rank satisfies is enough to honour a pick;
  // `resolveChatModel` / `resolveResearchModel` then degrade an out-of-plan
  // id to the plan default, so this cannot grant a model the rank forbids.
  return GEMINI_MODELS.some(
    (m) =>
      m.provider === "anthropic" && planRank(planId) >= modelRequiredRank(m.id),
  );
}

/**
 * CLIENT-SAFE model list for the picker UI (MONEY-626). The browser bundle
 * has no ANTHROPIC_API_KEY, so `isModelAvailable` would hide every Claude
 * model even from the founder — the picker therefore gates founder-only
 * models on the EMAIL allowlist ALONE (the hardcoded founder default is
 * compiled in, so it works client-side). This is cosmetic: the server
 * resolvers still enforce the real gate (key present + allowlist), so a
 * picked Claude model on a misconfigured env simply falls back to Gemini.
 */
export function getPickerModelsForUser(
  email: string | null | undefined,
  planId: PlanId | string,
): ModelDefinition[] {
  return GEMINI_MODELS.filter((m) =>
    // `internalOnly` first: a system-lane model is not a chat option for
    // ANYONE, founder included, so it is excluded before the allowlist is
    // consulted rather than after.
    //
    // MONEY-1274 (#27) — a restricted model is then shown when the allowlist OR
    // the user's plan permits it. `isModelAvailable` is still skipped for these:
    // the browser bundle has no ANTHROPIC_API_KEY, so the env check would hide
    // Claude from everyone including the founder. Cosmetic either way — the
    // server resolvers enforce the real gate and fall back to Gemini.
    m.internalOnly
      ? false
      : m.founderOnly
        ? isRestrictedModelAllowed(m, email, planId)
        : isModelAvailable(m.id),
  );
}

/** Returns the registered set of model IDs (for Zod enum validation). */
export const REGISTERED_MODEL_IDS: readonly string[] = GEMINI_MODELS.map(
  (m) => m.id,
);

// ── Plan-rank helpers (FREE < PRO < PREMIUM) ──────────────────────

const BASE_RANK: Record<BasePlanTier, number> = {
  FREE: 0,
  PRO: 1,
  PREMIUM: 2,
};

/**
 * Collapse any stored planId to the 3-bucket routing tier.
 *   - PREMIUM / ULTIMATE → PREMIUM
 *   - PRO                → PRO
 *   - QUERY_PACK (a credit top-up, NOT a tier) / FREE / legacy → FREE
 * A QUERY_PACK buyer keeps their base plan in `planId`; a literal
 * QUERY_PACK row is only ever a legacy artifact, so it routes as FREE
 * (extra credits, not a higher model tier).
 */
export function resolveBasePlan(planId: PlanId | string): BasePlanTier {
  switch (resolvePlanId(String(planId))) {
    case "PREMIUM":
    case "ULTIMATE":
      return "PREMIUM";
    case "PRO":
      return "PRO";
    default:
      return "FREE";
  }
}

/** The user's plan rank (0/1/2). */
function planRank(planId: PlanId | string): number {
  return BASE_RANK[resolveBasePlan(planId)];
}

/** The minimum rank a model requires (from its `requiresPlan`). */
function modelRequiredRank(id: string): number {
  const def = MODEL_BY_ID.get(id);
  if (!def) return 99;
  switch (def.requiresPlan) {
    case "PREMIUM":
    case "ULTIMATE":
      return 2;
    case "PRO":
    case "QUERY_PACK":
      return 1;
    default:
      return 0;
  }
}

/** Default model when the user has no preference (legacy flat map). */
export const DEFAULT_MODEL_FOR_PLAN: Record<PlanId, string> = {
  FREE: "gemini-2.5-flash",
  PRO: "gemini-2.5-pro",
  QUERY_PACK: "gemini-2.5-flash",
  PREMIUM: "gemini-2.5-pro",
  ULTIMATE: "gemini-2.5-pro",
};

/**
 * Lookup by id. Returns null for unknown IDs so callers can fall back
 * to a plan-default rather than crashing.
 */
export function getModelDefinition(id: string): ModelDefinition | null {
  return MODEL_BY_ID.get(id) ?? null;
}

/** Returns the credit premium for a model (0 if unknown). */
export function getModelPremium(id: string): number {
  return MODEL_BY_ID.get(id)?.creditPremium ?? 0;
}

/**
 * Whether a plan can pick this model. MONEY-619: rank-based, so the tiers
 * actually differentiate — a PRO user can NOT pick a PREMIUM-only model
 * (previously any paid plan could pick anything). Also gates on
 * env-availability so a saved-but-now-disabled model routes to the default.
 */
export function isModelAvailableOnPlan(id: string, planId: PlanId): boolean {
  const def = MODEL_BY_ID.get(id);
  if (!def) return false;
  if (!isModelAvailable(id)) return false;
  return planRank(planId) >= modelRequiredRank(id);
}

/**
 * Effective credit cost for an action × model pair.
 *
 *   cost = max(0, baseCost + premium)
 *
 * Special case: free chat actions (`l1_*`) always cost 0 regardless of
 * the selected model. NOTE: a "thinking" chat turn is intentionally NOT
 * an `l1_*` action (the caller charges it as a paid action) so the Pro
 * model premium applies — that is how thinking-mode is billed.
 */
export function getEffectiveCreditCost(
  action: string,
  modelId: string,
  baseCost: number,
): number {
  if (
    action.startsWith("l1_") ||
    action === "follow_up" ||
    action === "portfolio_query"
  ) {
    return 0;
  }
  const premium = getModelPremium(modelId);
  return Math.max(0, baseCost + premium);
}

/** Resolve the model ID a user should use, honoring saved prefs. */
export function resolveModelId(
  preferredId: string | null | undefined,
  planId: PlanId,
): string {
  if (preferredId && isModelAvailableOnPlan(preferredId, planId)) {
    return preferredId;
  }
  const base = resolvePlanId(String(planId)) as PlanId;
  return DEFAULT_MODEL_FOR_PLAN[base] ?? "gemini-2.5-flash";
}

// ── MONEY-619: tier→model routing (two lanes) ─────────────────────

/** Chat "fast lane" model per base tier. */
export const CHAT_MODEL_BY_TIER: Record<BasePlanTier, string> = {
  FREE: "gemini-2.5-flash",
  PRO: "gemini-3-flash-preview",
  PREMIUM: "gemini-3.5-flash",
};

/** Research "deep lane" model per base tier. */
export const RESEARCH_MODEL_BY_TIER: Record<BasePlanTier, string> = {
  FREE: "gemini-2.5-pro",
  PRO: "gemini-3.1-pro-preview",
  PREMIUM: "gemini-3.1-pro-preview",
};

const CHAT_FALLBACK_MODEL = "gemini-2.5-flash";
const RESEARCH_FALLBACK_MODEL = "gemini-2.5-pro";

/** Returns `modelId` if currently available, else the lane fallback. */
function withAvailability(modelId: string, fallback: string): string {
  return isModelAvailable(modelId) ? modelId : fallback;
}

export interface ChatModelOptions {
  /** The user's saved composer model pick (`User.preferences.model`). */
  userPick?: string | null;
  /**
   * Opt-in "thinking" mode — run the tier's Pro model for this chat turn.
   * The caller is responsible for charging credits (a thinking turn is a
   * paid action, not a free `l1_*`).
   */
  thinking?: boolean;
  /**
   * MONEY-626: the caller-resolved Claude entitlement (founder allowlist).
   * Only when true is an explicit Claude pick honored; otherwise Claude
   * picks are ignored and the user gets the Gemini default.
   */
  claudeAllowed?: boolean;
}

/**
 * Pick the model for a NORMAL chat turn.
 *   - default: the tier's Flash model (a Pro pick is downgraded to Flash
 *     for latency — the chat hot path never pays Pro cost).
 *   - `thinking`: the tier's Pro model (deep lane), billed by the caller.
 * An explicit Flash pick the plan allows is honored (e.g. flash-lite).
 */
export function resolveChatModel(
  planId: PlanId | string,
  opts: ChatModelOptions = {},
): string {
  // MONEY-626: an allowlisted user's explicit Claude pick wins in BOTH
  // lanes with NO Flash downgrade — picking Opus/Sonnet/Haiku for chat is
  // the whole point. Non-allowlisted callers pass claudeAllowed=false, so a
  // forged Claude pick silently falls through to the Gemini default below.
  if (opts.userPick && opts.claudeAllowed) {
    const pick = MODEL_BY_ID.get(opts.userPick);
    if (pick?.provider === "anthropic" && isModelAvailable(opts.userPick)) {
      return opts.userPick;
    }
  }
  if (opts.thinking) {
    return resolveResearchModel(planId, opts.userPick, opts.claudeAllowed);
  }
  if (opts.userPick) {
    const def = MODEL_BY_ID.get(opts.userPick);
    if (
      def &&
      def.tier === "L1" &&
      isModelAvailableOnPlan(opts.userPick, resolvePlanId(String(planId)))
    ) {
      return opts.userPick;
    }
  }
  const tier = resolveBasePlan(planId);
  return withAvailability(CHAT_MODEL_BY_TIER[tier], CHAT_FALLBACK_MODEL);
}

/**
 * Pick the model for a RESEARCH run. Honors an explicit Pro-tier pick the
 * plan allows; otherwise the tier default (FREE 2.5-pro, PRO/PREMIUM 3-pro).
 */
export function resolveResearchModel(
  planId: PlanId | string,
  userPick?: string | null,
  claudeAllowed?: boolean,
): string {
  // MONEY-626: honor an allowlisted user's Claude pick (any tier); ignored
  // for everyone else so research stays Gemini-default.
  if (userPick && claudeAllowed) {
    const pick = MODEL_BY_ID.get(userPick);
    if (pick?.provider === "anthropic" && isModelAvailable(userPick)) {
      return userPick;
    }
  }
  if (userPick) {
    const def = MODEL_BY_ID.get(userPick);
    if (
      def &&
      def.tier !== "L1" &&
      def.provider !== "anthropic" &&
      isModelAvailableOnPlan(userPick, resolvePlanId(String(planId)))
    ) {
      return userPick;
    }
  }
  const tier = resolveBasePlan(planId);
  return withAvailability(
    RESEARCH_MODEL_BY_TIER[tier],
    RESEARCH_FALLBACK_MODEL,
  );
}

/**
 * The Vertex location to call a model in — DEAD CODE, kept as a tripwire.
 *
 * MONEY-1314 corrected this docblock. It used to say the 3.x family "is
 * global-endpoint-only (404s in regional endpoints like asia-south1 /
 * us-central1)", which put THREE incompatible claims in this repo:
 *
 *   here            3.x works on Vertex, at the `global` endpoint only
 *   client.ts:355   3.x is "NOT on Vertex (where they 404)" — at all
 *   this file:25    "there is no per-model location split anymore"
 *
 * (a) and (b) cannot both be true, and nothing falsifies either — both are
 * prose. Settling it needs a live probe of a regional Vertex endpoint against
 * the `global` one under this project's Vertex credentials, which nobody has
 * run.
 *
 * What IS verified is that the question does not currently arise. This
 * function has ZERO production callers: its only references in the repo are
 * its own definition, the doc line at the top of this file, and one test.
 * Every configured environment sets `GOOGLE_GENAI_API_KEY`, and
 * `getVertexAIClient` then ignores `location` outright (`client.ts:364-372`,
 * cacheKey `"genai-developer-api"`).
 *
 * It is kept rather than deleted because an unmigrated environment falling
 * back to Vertex should fail at the API with an unmistakable model error,
 * which is what returning `"global"` for an id Vertex does not serve produces.
 * A regional URL would fail more quietly and look like a networking problem.
 */
export function getModelLocation(modelId: string): string {
  if (modelId.startsWith("gemini-3")) return "global";
  return process.env.GCP_LOCATION || "us-central1";
}
