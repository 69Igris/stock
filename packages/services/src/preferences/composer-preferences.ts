/**
 * Per-user composer preferences (MONEY-219 follow-up: steps 2–6).
 *
 * Stored alongside `User.preferences.research` under the same Json field.
 * Three sibling namespaces - kept separate so a future feature can grow
 * its own bucket without colliding with research / sources / tools:
 *
 *   - `User.preferences.connectors` - broker accounts active in research
 *   - `User.preferences.sources` - web grounding + active document IDs
 *   - `User.preferences.tools` - pinned indicators / screeners + persona
 *   - `User.preferences.pinnedInstruments` - Stocks · MFs · ETFs picker
 *   - `User.preferences.recentInstruments` - last-N mentioned symbols
 *   - `User.preferences.model` - selected synthesizer model (MONEY-229)
 *
 * Reads return defaults so callers never have to branch on null. Writes
 * merge with existing siblings so a partial update doesn't clobber other
 * buckets - same pattern as setResearchPreferences.
 */

import { z } from "zod";
import { prisma } from "@usemoney/database";
// Import directly from the model-registry submodule to avoid pulling
// the Vertex AI client (Node-only fs/child_process) into client-side
// bundles when this preference module is imported via server actions.
import { REGISTERED_MODEL_IDS } from "@usemoney/core/gemini/model-registry";

// ─── Connectors ────────────────────────────────────────────────────────

export const connectorPreferencesSchema = z.object({
  // ObjectIds of BrokerConnection rows the user has marked active in
  // research. Empty array = "all connected brokers active" (default).
  activeBrokerIds: z.array(z.string()),
});
export type ConnectorPreferences = z.infer<typeof connectorPreferencesSchema>;
export const DEFAULT_CONNECTOR_PREFERENCES: ConnectorPreferences = {
  activeBrokerIds: [],
};

// ─── Sources ───────────────────────────────────────────────────────────

export const sourcePreferencesSchema = z.object({
  webSearch: z.boolean(),
  webSearchUsedThisMonth: z.number().int().min(0),
  webSearchCap: z.number().int().min(0),
  webSearchResetAt: z.string().optional(), // ISO date
  // Mongo ObjectIds of UserDocument rows the user wants the chat to
  // search-and-cite by default. Empty = no document grounding.
  activeDocumentIds: z.array(z.string()),
});
export type SourcePreferences = z.infer<typeof sourcePreferencesSchema>;
export const DEFAULT_SOURCE_PREFERENCES: SourcePreferences = {
  webSearch: false,
  webSearchUsedThisMonth: 0,
  webSearchCap: 200,
  activeDocumentIds: [],
};

// ─── Tools ─────────────────────────────────────────────────────────────

// Indicator IDs MUST match the registered indicators in
// compute_technical_analysis. An unknown ID would be silently dropped by
// the planner; refusing at write time surfaces drift.
export const INDICATOR_IDS = [
  "rsi",
  "macd",
  "boll",
  "adx",
  "stoch",
  "obv",
  "mfi",
  "cci",
  "wr",
  "atr",
  "roc",
  "psar",
  "ichimoku",
  "supertrend",
  "pivots",
  "nr4",
] as const;
export type IndicatorId = (typeof INDICATOR_IDS)[number];

export const PERSONA_IDS = ["marks", "damodaran", "rj"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export const toolsPreferencesSchema = z.object({
  pinnedIndicators: z.array(z.enum(INDICATOR_IDS)),
  pinnedScreenerIds: z.array(z.string()),
  persona: z.enum(PERSONA_IDS).nullable(),
});
export type ToolsPreferences = z.infer<typeof toolsPreferencesSchema>;
export const DEFAULT_TOOLS_PREFERENCES: ToolsPreferences = {
  pinnedIndicators: [],
  pinnedScreenerIds: [],
  persona: null,
};

// ─── Pinned + recent instruments ───────────────────────────────────────

export const instrumentBasketSchema = z.object({
  stocks: z.array(z.string()),
  mfs: z.array(z.string()),
  etfs: z.array(z.string()),
});
export type InstrumentBasket = z.infer<typeof instrumentBasketSchema>;
export const DEFAULT_INSTRUMENT_BASKET: InstrumentBasket = {
  stocks: [],
  mfs: [],
  etfs: [],
};

// ─── Model selection - MONEY-229 Phase B ─────────────────────────────
// Tightened from `z.string().max(64)` to a strict enum bound to the
// model registry. Unknown IDs are rejected at write time; a stale
// stored value (e.g. a deprecated model) falls back to `null` on read
// so the chat route can resolve a plan-default instead.

export const modelPreferenceSchema = z.string().refine(
  (id) => REGISTERED_MODEL_IDS.includes(id),
  (id) => ({ message: `Unknown model id: ${id}` }),
);

// ─── Thinking mode - MONEY-619 Phase 2 ───────────────────────────────
// When ON, a normal chat turn runs the tier's Pro ("deep lane") model
// instead of Flash and is charged via credits (the chat route applies the
// `l2_chat_thinking` charge + per-model premium). Default OFF so casual
// chat stays free + fast.

export const thinkingPreferenceSchema = z.boolean();

/**
 * Read-side coercion for the stored `thinking` flag. A stored boolean is
 * trusted as-is; anything else (missing field, legacy junk, wrong type)
 * falls back to the default-OFF. Extracted so the exact read rule
 * `getComposerPreferences` applies is unit-testable without a DB.
 */
export function readThinkingPreference(stored: unknown): boolean {
  return typeof stored === "boolean" ? stored : false;
}

/**
 * Write-side merge for the `thinking` flag. A present patch value is
 * schema-validated and overrides; an absent patch (`undefined`) preserves
 * the current value so a sibling-only write (e.g. model) doesn't clobber
 * the user's thinking toggle. Extracted so the exact merge rule
 * `setComposerPreferences` applies is unit-testable without a DB.
 */
export function mergeThinkingPreference(
  current: boolean,
  patch?: boolean,
): boolean {
  return patch !== undefined ? thinkingPreferenceSchema.parse(patch) : current;
}

// ─── All composer prefs (read-side aggregate) ──────────────────────────

export interface ComposerPreferences {
  connectors: ConnectorPreferences;
  sources: SourcePreferences;
  tools: ToolsPreferences;
  pinnedInstruments: InstrumentBasket;
  recentInstruments: InstrumentBasket;
  model: string | null;
  /** Opt-in "thinking" mode - runs the tier's Pro model, costs credits. */
  thinking: boolean;
}

export const DEFAULT_COMPOSER_PREFERENCES: ComposerPreferences = {
  connectors: DEFAULT_CONNECTOR_PREFERENCES,
  sources: DEFAULT_SOURCE_PREFERENCES,
  tools: DEFAULT_TOOLS_PREFERENCES,
  pinnedInstruments: DEFAULT_INSTRUMENT_BASKET,
  recentInstruments: DEFAULT_INSTRUMENT_BASKET,
  model: null,
  thinking: false,
};

/**
 * The patch the composer popover's "Reset all" applies.
 *
 * Lives here, beside the defaults it is built from, so the one rule that
 * makes it non-obvious sits next to the data it guards:
 *
 *   `sources` is reset FIELD BY FIELD, never whole. setComposerPreferences
 *   merges shallowly per namespace, so spreading the full
 *   DEFAULT_SOURCE_PREFERENCES would also write `webSearchUsedThisMonth: 0`
 *   and `webSearchCap: 200`. Neither is a preference — the first is a usage
 *   meter, the second the plan's quota — so a whole-namespace reset would
 *   refill the user's web-search allowance every time they clicked Reset all,
 *   and stamp a raised cap back down to the default.
 *
 * `recentInstruments`, `model` and `thinking` are deliberately absent: a
 * namespace omitted from the patch is left untouched by the merge.
 *
 * Pure and exported so the carve-out is asserted directly rather than through
 * a DB round-trip.
 */
export function buildComposerResetPatch(): {
  connectors: ConnectorPreferences;
  sources: Pick<SourcePreferences, "webSearch" | "activeDocumentIds">;
  tools: ToolsPreferences;
  pinnedInstruments: InstrumentBasket;
} {
  return {
    connectors: DEFAULT_CONNECTOR_PREFERENCES,
    sources: {
      webSearch: DEFAULT_SOURCE_PREFERENCES.webSearch,
      activeDocumentIds: DEFAULT_SOURCE_PREFERENCES.activeDocumentIds,
    },
    tools: DEFAULT_TOOLS_PREFERENCES,
    pinnedInstruments: DEFAULT_INSTRUMENT_BASKET,
  };
}

/**
 * Read all composer preference namespaces in one round-trip. Each
 * namespace falls back to its default if the stored value is missing
 * or fails Zod validation - the popover should never crash because of
 * a stale field.
 */
export async function getComposerPreferences(
  userId: string,
): Promise<ComposerPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  if (!user?.preferences || typeof user.preferences !== "object") {
    return DEFAULT_COMPOSER_PREFERENCES;
  }
  const all = user.preferences as Record<string, unknown>;

  return {
    connectors: parseOrDefault(
      all.connectors,
      connectorPreferencesSchema,
      DEFAULT_CONNECTOR_PREFERENCES,
    ),
    sources: parseOrDefault(
      all.sources,
      sourcePreferencesSchema,
      DEFAULT_SOURCE_PREFERENCES,
    ),
    tools: parseOrDefault(
      all.tools,
      toolsPreferencesSchema,
      DEFAULT_TOOLS_PREFERENCES,
    ),
    pinnedInstruments: parseOrDefault(
      all.pinnedInstruments,
      instrumentBasketSchema,
      DEFAULT_INSTRUMENT_BASKET,
    ),
    recentInstruments: parseOrDefault(
      all.recentInstruments,
      instrumentBasketSchema,
      DEFAULT_INSTRUMENT_BASKET,
    ),
    model:
      typeof all.model === "string" &&
      modelPreferenceSchema.safeParse(all.model).success
        ? (all.model as string)
        : null,
    thinking: readThinkingPreference(all.thinking),
  };
}

function parseOrDefault<T>(raw: unknown, schema: z.ZodType<T>, fallback: T): T {
  const result = schema.safeParse(raw);
  return result.success ? result.data : fallback;
}

/**
 * Atomic write helper. Pass any subset of the namespaces and they merge
 * into the existing preferences blob - every other sibling (including
 * `research`) stays untouched.
 */
export async function setComposerPreferences(
  userId: string,
  patch: Partial<{
    connectors: Partial<ConnectorPreferences>;
    sources: Partial<SourcePreferences>;
    tools: Partial<ToolsPreferences>;
    pinnedInstruments: Partial<InstrumentBasket>;
    recentInstruments: Partial<InstrumentBasket>;
    model: string | null;
    thinking: boolean;
  }>,
): Promise<ComposerPreferences> {
  const current = await getComposerPreferences(userId);

  const merged: ComposerPreferences = {
    connectors: patch.connectors
      ? connectorPreferencesSchema.parse({
          ...current.connectors,
          ...patch.connectors,
        })
      : current.connectors,
    sources: patch.sources
      ? sourcePreferencesSchema.parse({
          ...current.sources,
          ...patch.sources,
        })
      : current.sources,
    tools: patch.tools
      ? toolsPreferencesSchema.parse({
          ...current.tools,
          ...patch.tools,
        })
      : current.tools,
    pinnedInstruments: patch.pinnedInstruments
      ? instrumentBasketSchema.parse({
          ...current.pinnedInstruments,
          ...patch.pinnedInstruments,
        })
      : current.pinnedInstruments,
    recentInstruments: patch.recentInstruments
      ? instrumentBasketSchema.parse({
          ...current.recentInstruments,
          ...patch.recentInstruments,
        })
      : current.recentInstruments,
    model:
      patch.model !== undefined
        ? patch.model && modelPreferenceSchema.parse(patch.model)
          ? patch.model
          : null
        : current.model,
    thinking: mergeThinkingPreference(current.thinking, patch.thinking),
  };

  // Merge with the full preferences blob so research / future buckets
  // survive untouched.
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
        connectors: merged.connectors,
        sources: merged.sources,
        tools: merged.tools,
        pinnedInstruments: merged.pinnedInstruments,
        recentInstruments: merged.recentInstruments,
        model: merged.model,
        thinking: merged.thinking,
      } as unknown as object,
    },
  });

  return merged;
}

/**
 * Append a symbol to recentInstruments[kind], keeping at most N entries
 * (default 8) - used by the chat route to track what the user mentioned
 * last so the picker's "Recents" tab is fresh.
 */
export async function recordRecentInstrument(
  userId: string,
  kind: keyof InstrumentBasket,
  symbol: string,
  cap = 8,
): Promise<void> {
  const current = await getComposerPreferences(userId);
  const existing = current.recentInstruments[kind];
  const next = [symbol, ...existing.filter((s) => s !== symbol)].slice(0, cap);
  await setComposerPreferences(userId, {
    recentInstruments: {
      ...current.recentInstruments,
      [kind]: next,
    },
  });
}

// ─── Persona prompt - used by the synthesizer (MONEY-222 followup) ─────

export const PERSONA_PROMPTS: Record<PersonaId, string> = {
  marks:
    "Apply Howard Marks' lens: cycles, second-level thinking, asymmetric risk, downside-first. Frame every claim around probability + magnitude of being wrong.",
  damodaran:
    "Apply Aswath Damodaran's discipline: story → numbers → valuation. Lead with the narrative, then the model. Flag every assumption.",
  rj: "Apply Rakesh Jhunjhunwala's lens: India compounders, conviction sizing, multi-bagger horizon. Focus on owner-operator quality + scalability.",
};
