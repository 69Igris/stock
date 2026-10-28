"use server";

/**
 * Saved-bundle CRUD - MONEY-239 C.
 *
 * A "bundle" is a named snapshot of {skills, model, focus} the user
 * can re-apply with one click via the picker's "My templates" section
 * or via the result-footer "Save this bundle as ..." chip.
 *
 * Stored under `User.preferences.research.customPresets` (the field
 * was added to the v2 schema in the same PR for forward-compat). Cap:
 * 20 bundles per user - keeps the picker scannable + bounds the JSON
 * column size.
 *
 * No new Prisma model required.
 */

import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getResearchPreferences,
  setResearchPreferences,
  RESEARCH_SKILL_IDS,
  type ResearchSkillId,
} from "@usemoney/services/preferences";

const MAX_BUNDLES_PER_USER = 20;
const MAX_NAME_LEN = 80;

const SaveSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  skills: z.array(z.enum(RESEARCH_SKILL_IDS)).min(1),
  model: z.string().optional(),
  focus: z.string().max(280).optional(),
});

const RenameSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
});

const DeleteSchema = z.object({
  id: z.string().min(1),
});

export interface SavedBundle {
  id: string;
  name: string;
  skills: ResearchSkillId[];
  model?: string;
  focus?: string;
  createdAt: string;
}

interface ActionResult<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

export async function listSavedBundlesAction(): Promise<
  ActionResult<SavedBundle[]>
> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) return { success: false, error: "Unauthorized" };

  const prefs = await getResearchPreferences(authUser.userId);
  const bundles = (prefs.customPresets ?? []).map(
    (b): SavedBundle => ({
      id: b.id,
      name: b.name,
      skills: b.skills,
      model: b.model,
      focus: b.focus,
      createdAt:
        typeof b.createdAt === "string"
          ? b.createdAt
          : b.createdAt instanceof Date
            ? b.createdAt.toISOString()
            : new Date(0).toISOString(),
    })
  );
  return { success: true, data: bundles };
}

export async function saveBundleAction(
  input: z.infer<typeof SaveSchema>
): Promise<ActionResult<SavedBundle>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) return { success: false, error: "Unauthorized" };

  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const prefs = await getResearchPreferences(authUser.userId);
  const existing = prefs.customPresets ?? [];

  // Same-name check - overwrite rather than spawn a duplicate.
  const lowerName = parsed.data.name.trim().toLowerCase();
  const sameName = existing.find(
    (b) => b.name.trim().toLowerCase() === lowerName
  );

  let nextBundles: typeof existing;
  let savedBundle: SavedBundle;

  if (sameName) {
    savedBundle = {
      id: sameName.id,
      name: parsed.data.name,
      skills: parsed.data.skills,
      model: parsed.data.model,
      focus: parsed.data.focus,
      createdAt:
        typeof sameName.createdAt === "string"
          ? sameName.createdAt
          : new Date().toISOString(),
    };
    nextBundles = existing.map((b) => (b.id === sameName.id ? savedBundle : b));
  } else {
    if (existing.length >= MAX_BUNDLES_PER_USER) {
      return {
        success: false,
        error: `You've hit the ${MAX_BUNDLES_PER_USER}-bundle cap. Delete one to add a new template.`,
      };
    }
    savedBundle = {
      id: uuidv4(),
      name: parsed.data.name,
      skills: parsed.data.skills,
      model: parsed.data.model,
      focus: parsed.data.focus,
      createdAt: new Date().toISOString(),
    };
    nextBundles = [...existing, savedBundle];
  }

  await setResearchPreferences(authUser.userId, {
    customPresets: nextBundles,
  });

  return { success: true, data: savedBundle };
}

export async function renameBundleAction(
  input: z.infer<typeof RenameSchema>
): Promise<ActionResult<SavedBundle>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) return { success: false, error: "Unauthorized" };

  const parsed = RenameSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const prefs = await getResearchPreferences(authUser.userId);
  const existing = prefs.customPresets ?? [];
  const target = existing.find((b) => b.id === parsed.data.id);
  if (!target) return { success: false, error: "Bundle not found" };

  // Collision check - refuse to rename onto a name that already
  // exists on a different bundle.
  const lowerNew = parsed.data.name.trim().toLowerCase();
  if (
    existing.some(
      (b) => b.id !== target.id && b.name.trim().toLowerCase() === lowerNew
    )
  ) {
    return {
      success: false,
      error: "A bundle with that name already exists.",
    };
  }

  const renamed: SavedBundle = {
    id: target.id,
    name: parsed.data.name,
    skills: target.skills,
    model: target.model,
    focus: target.focus,
    createdAt:
      typeof target.createdAt === "string"
        ? target.createdAt
        : new Date(0).toISOString(),
  };
  const nextBundles = existing.map((b) => (b.id === target.id ? renamed : b));

  await setResearchPreferences(authUser.userId, {
    customPresets: nextBundles,
  });

  return { success: true, data: renamed };
}

export async function deleteBundleAction(
  input: z.infer<typeof DeleteSchema>
): Promise<ActionResult> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) return { success: false, error: "Unauthorized" };

  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const prefs = await getResearchPreferences(authUser.userId);
  const existing = prefs.customPresets ?? [];
  const nextBundles = existing.filter((b) => b.id !== parsed.data.id);
  if (nextBundles.length === existing.length) {
    return { success: false, error: "Bundle not found" };
  }

  await setResearchPreferences(authUser.userId, {
    customPresets: nextBundles,
  });

  return { success: true };
}
