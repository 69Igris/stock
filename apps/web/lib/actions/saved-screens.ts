"use server";

/**
 * Saved Screens - server actions (MONEY-201).
 *
 * Persists named bundles of screener filters per (user, mode) so users
 * can re-run a query without rebuilding the filter sidebar each time.
 *
 * Mode is "stocks" | "mf" | "etf". `filters` is the JSON shape MONEY-196
 * emits via URL state - same keys, same values, no transform needed when
 * reloading a saved screen back into the screener.
 *
 * Server actions are scoped to the authenticated user (Clerk → DB user
 * resolution via getOrCreateDbUser). Demo sessions cannot save screens -
 * the UI shows a sign-up CTA instead.
 */

import { prisma } from "@usemoney/database";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { getOrCreateDbUser } from "@/lib/db/user";
import type { ServiceResult } from "@usemoney/services";
import {
  SaveSchema,
  RenameSchema,
  countFilters,
} from "@/lib/actions/saved-screens-logic";

// ============== TYPES ==============

export type ScreenerModeId = "stocks" | "mf" | "etf";

export interface SavedScreenSummary {
  id: string;
  name: string;
  mode: ScreenerModeId;
  query: string | null;
  /** Filter count - surfaced in the sidebar so users see screen complexity. */
  filterCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SavedScreenDetail extends SavedScreenSummary {
  /** Raw filter JSON. Caller is responsible for casting to the right
   *  ScreenFilters / MfScreenFilters / EtfScreenFilters union member. */
  filters: Record<string, unknown>;
}

// Validation schemas + the countFilters helper live in
// ./saved-screens-logic (pure, unit-tested). Imported above.

// ============== ACTIONS ==============

/** Save a new screen OR overwrite an existing one with the same (mode,name). */
export async function saveScreenAction(
  input: z.input<typeof SaveSchema>
): Promise<ServiceResult<SavedScreenSummary>> {
  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { userId } = await auth();
  if (!userId) {
    return { success: false, error: "Sign in to save screens" };
  }

  const dbUser = await getOrCreateDbUser(userId);
  if (!dbUser) {
    return { success: false, error: "Failed to resolve user" };
  }

  const { name, mode, filters, query } = parsed.data;

  try {
    const row = await prisma.savedScreen.upsert({
      where: {
        userId_mode_name: { userId: dbUser.id, mode, name },
      },
      create: {
        userId: dbUser.id,
        mode,
        name,
        // Mongo Json column accepts arbitrary Record - cast keeps Prisma's
        // strict InputJsonValue happy without weakening our zod schema.
        filters: filters as Record<string, unknown> as never,
        query: query ?? null,
      },
      update: {
        filters: filters as Record<string, unknown> as never,
        query: query ?? null,
      },
    });

    return {
      success: true,
      data: {
        id: row.id,
        name: row.name,
        mode: row.mode as ScreenerModeId,
        query: row.query,
        filterCount: countFilters(filters),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  } catch (err) {
    console.error("saveScreenAction error", err);
    return { success: false, error: "Failed to save screen" };
  }
}

/** List the user's saved screens, optionally filtered by mode. */
export async function listSavedScreensAction(
  mode?: ScreenerModeId
): Promise<ServiceResult<SavedScreenSummary[]>> {
  const { userId } = await auth();
  if (!userId) return { success: true, data: [] };

  const dbUser = await getOrCreateDbUser(userId);
  if (!dbUser) return { success: true, data: [] };

  try {
    const rows = await prisma.savedScreen.findMany({
      where: {
        userId: dbUser.id,
        ...(mode ? { mode } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mode: r.mode as ScreenerModeId,
        query: r.query,
        filterCount: countFilters(r.filters as Record<string, unknown>),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  } catch (err) {
    console.error("listSavedScreensAction error", err);
    return { success: false, error: "Failed to list saved screens" };
  }
}

/** Load a single screen by id (for re-applying filters on the screener). */
export async function loadSavedScreenAction(
  id: string
): Promise<ServiceResult<SavedScreenDetail>> {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not signed in" };
  const dbUser = await getOrCreateDbUser(userId);
  if (!dbUser) return { success: false, error: "Failed to resolve user" };

  try {
    const row = await prisma.savedScreen.findFirst({
      where: { id, userId: dbUser.id },
    });
    if (!row) return { success: false, error: "Screen not found" };

    const filters = row.filters as Record<string, unknown>;
    return {
      success: true,
      data: {
        id: row.id,
        name: row.name,
        mode: row.mode as ScreenerModeId,
        query: row.query,
        filterCount: countFilters(filters),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        filters,
      },
    };
  } catch (err) {
    console.error("loadSavedScreenAction error", err);
    return { success: false, error: "Failed to load screen" };
  }
}

/** Rename a screen (collision against another screen in the same mode → 409-ish). */
export async function renameSavedScreenAction(
  input: z.input<typeof RenameSchema>
): Promise<ServiceResult<SavedScreenSummary>> {
  const parsed = RenameSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { id, name } = parsed.data;

  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not signed in" };
  const dbUser = await getOrCreateDbUser(userId);
  if (!dbUser) return { success: false, error: "Failed to resolve user" };

  try {
    // Confirm ownership before allowing the rename.
    const existing = await prisma.savedScreen.findFirst({
      where: { id, userId: dbUser.id },
    });
    if (!existing) return { success: false, error: "Screen not found" };

    // Prevent collision with another screen in the same mode.
    const collision = await prisma.savedScreen.findFirst({
      where: {
        userId: dbUser.id,
        mode: existing.mode,
        name,
        NOT: { id },
      },
      select: { id: true },
    });
    if (collision) {
      return {
        success: false,
        error: `A screen named "${name}" already exists for this mode`,
      };
    }

    const row = await prisma.savedScreen.update({
      where: { id },
      data: { name },
    });
    return {
      success: true,
      data: {
        id: row.id,
        name: row.name,
        mode: row.mode as ScreenerModeId,
        query: row.query,
        filterCount: countFilters(row.filters as Record<string, unknown>),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  } catch (err) {
    console.error("renameSavedScreenAction error", err);
    return { success: false, error: "Failed to rename screen" };
  }
}

/** Delete a screen (irreversible). */
export async function deleteSavedScreenAction(
  id: string
): Promise<ServiceResult<{ id: string }>> {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Not signed in" };
  const dbUser = await getOrCreateDbUser(userId);
  if (!dbUser) return { success: false, error: "Failed to resolve user" };

  try {
    // deleteMany so a wrong-id silently fails instead of throwing P2025.
    const res = await prisma.savedScreen.deleteMany({
      where: { id, userId: dbUser.id },
    });
    if (res.count === 0) return { success: false, error: "Screen not found" };
    return { success: true, data: { id } };
  } catch (err) {
    console.error("deleteSavedScreenAction error", err);
    return { success: false, error: "Failed to delete screen" };
  }
}
