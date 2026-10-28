"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import { preferences } from "@usemoney/services";
import {
  getComposerPreferences,
  setComposerPreferences,
  buildComposerResetPatch,
} from "@usemoney/services/preferences";
import type {
  ResearchPreferences,
  ResearchPreferencesInput,
  ComposerPreferences,
  ConnectorPreferences,
  SourcePreferences,
  ToolsPreferences,
  InstrumentBasket,
} from "@usemoney/services/preferences";

export type {
  ResearchPreferences,
  ResearchPreferencesInput,
  ComposerPreferences,
  ConnectorPreferences,
  SourcePreferences,
  ToolsPreferences,
  InstrumentBasket,
} from "@usemoney/services/preferences";

/**
 * Read the signed-in user's research preferences. Returns the defaults
 * (style=auto, no custom skills, no focus) when the user hasn't saved any -
 * the popover UI uses this to render the empty state.
 */
export async function getMyResearchPreferencesAction(): Promise<
  | { success: true; data: ResearchPreferences }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const prefs = await preferences.getResearchPreferences(authUser.userId);
    return { success: true, data: prefs };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load research preferences",
    };
  }
}

/**
 * Save / update research preferences. Partial - pass only the fields you
 * want to change; the rest are preserved (so toggling style doesn't blow
 * away a custom focus the user previously typed).
 */
export async function setMyResearchPreferencesAction(
  input: Partial<ResearchPreferencesInput>
): Promise<
  | { success: true; data: ResearchPreferences }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const next = await preferences.setResearchPreferences(
      authUser.userId,
      input
    );
    return { success: true, data: next };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to save research preferences",
    };
  }
}

/**
 * Composer preferences - covers connectors, sources, tools, pinned
 * instruments, recents, and selected model. Read-side helper for the
 * popover sub-views that grew in MONEY-219 → 225.
 */
export async function getMyComposerPreferencesAction(): Promise<
  | { success: true; data: ComposerPreferences }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const data = await getComposerPreferences(authUser.userId);
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load composer preferences",
    };
  }
}

/**
 * "Reset all" in the composer's Research-preferences popover.
 *
 * Server-owned on purpose. The defaults live in @usemoney/services, whose
 * preferences module imports prisma, so a client component cannot import them
 * without pulling the DB client into the browser bundle. Resetting here keeps
 * ONE copy of the defaults and keeps the `sources` carve-out below on the
 * server, where a hand-crafted client call cannot route around it.
 *
 * Scope is the composer namespaces the popover edits. Research preferences
 * (style / skills / params / focus) are deliberately NOT touched.
 *
 * `sources` is reset field-by-field rather than whole. setComposerPreferences
 * merges shallowly per namespace, so writing the full default would also set
 * `webSearchUsedThisMonth: 0` and `webSearchCap: 200`. Neither is a
 * preference — the first is a usage meter, the second the plan's quota — so a
 * whole-namespace reset would refill the user's web-search allowance on every
 * click and stamp a raised cap back down to the default.
 */
export async function resetMyComposerPreferencesAction(): Promise<
  | { success: true; data: ComposerPreferences }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const next = await setComposerPreferences(
      authUser.userId,
      buildComposerResetPatch()
    );
    return { success: true, data: next };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to reset composer preferences",
    };
  }
}

/**
 * Composer preferences - atomic partial write. Each namespace
 * (connectors, sources, tools, pinnedInstruments, recentInstruments,
 * model) merges with existing values; siblings are untouched.
 */
export async function setMyComposerPreferencesAction(
  patch: Partial<{
    connectors: Partial<ConnectorPreferences>;
    sources: Partial<SourcePreferences>;
    tools: Partial<ToolsPreferences>;
    pinnedInstruments: Partial<InstrumentBasket>;
    recentInstruments: Partial<InstrumentBasket>;
    model: string | null;
    thinking: boolean;
  }>
): Promise<
  | { success: true; data: ComposerPreferences }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const next = await setComposerPreferences(authUser.userId, patch);
    return { success: true, data: next };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to save composer preferences",
    };
  }
}
