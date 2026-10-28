/**
 * Saved Screens Service (MONEY-1062 P4c — discovery-power parity).
 *
 * Faithful extraction of the saved-screens server actions for apps/api:
 *   - apps/web/lib/actions/saved-screens.ts:56  `saveScreenAction`         → saveScreen
 *   - apps/web/lib/actions/saved-screens.ts:118 `listSavedScreensAction`   → listSavedScreens
 *   - apps/web/lib/actions/saved-screens.ts:156 `loadSavedScreenAction`    → loadSavedScreen
 *   - apps/web/lib/actions/saved-screens.ts:191 `renameSavedScreenAction`  → renameSavedScreen
 *   - apps/web/lib/actions/saved-screens.ts:255 `deleteSavedScreenAction`  → deleteSavedScreen
 *
 * `countFilters` is ported verbatim from apps/web/lib/actions/saved-screens-logic.ts.
 *
 * STRIPPED (web/next glue): Clerk `auth()` + `getOrCreateDbUser` (the route owns
 * auth and passes the resolved Mongo userId, exactly like alerts.service). Zod
 * input validation moves to the route (the alerts/discover precedent); the
 * service owns the DB + ownership/collision business logic.
 *
 * SECURITY (IDOR): every read/write is scoped to the caller's `userId`. Rename
 * confirms ownership via findFirst BEFORE the update (a Prisma `update` would
 * no-op silently on a foreign id) and rejects a same-mode name collision;
 * delete uses a scoped `deleteMany` (count 0 → not-found, no cross-user oracle).
 *
 * @see packages/services/__tests__/parity-p4c-saved-screens.service.test.ts
 */

import { prisma } from "@usemoney/database";
import type { Prisma } from "@prisma/client";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";

export type ScreenerModeId = "stocks" | "mf" | "etf";

export interface SavedScreenSummary {
  id: string;
  name: string;
  mode: ScreenerModeId;
  query: string | null;
  /** Filter count — surfaced in the sidebar so users see screen complexity. */
  filterCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SavedScreenDetail extends SavedScreenSummary {
  /** Raw filter JSON. Caller casts to the right Screen/Mf/Etf filters union. */
  filters: Record<string, unknown>;
}

export interface SaveScreenInput {
  name: string;
  mode: ScreenerModeId;
  filters: Record<string, unknown>;
  query?: string | null;
}

export interface RenameScreenInput {
  id: string;
  name: string;
}

/** Injectable IO seam (ESM suite passes a fake prisma via `deps`). */
export interface SavedScreensServiceDeps {
  prisma?: typeof prisma;
}

/**
 * Count "active" filters in a screener filter bag. Skips the `limit` key
 * (paging, not a filter); treats null/undefined/empty-string/whitespace/
 * empty-array as "not set"; numeric `0` is a real value and is counted.
 * Ported from apps/web/lib/actions/saved-screens-logic.ts.
 */
export function countFilters(filters: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(filters)) {
    if (k === "limit") continue;
    if (v == null) continue;
    if (typeof v === "string" && v.trim().length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n++;
  }
  return n;
}

/** Save a new screen OR overwrite an existing one with the same (mode, name). */
export async function saveScreen(
  userId: string,
  input: SaveScreenInput,
  deps: SavedScreensServiceDeps = {},
): Promise<ServiceResult<SavedScreenSummary>> {
  const db = deps.prisma ?? prisma;
  const { name, mode, filters, query } = input;
  try {
    const row = await db.savedScreen.upsert({
      where: { userId_mode_name: { userId, mode, name } },
      create: {
        userId,
        mode,
        name,
        filters: filters as Record<string, unknown> as Prisma.InputJsonValue,
        query: query ?? null,
      },
      update: {
        filters: filters as Record<string, unknown> as Prisma.InputJsonValue,
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
  } catch (error) {
    logger.error({ error, userId }, "saveScreen service error");
    // MONEY-1062 (Round C / C3#4): code so routes map a DB blip to 500, not 404.
    return { success: false, error: "Failed to save screen", code: "INTERNAL" };
  }
}

/** List the caller's saved screens, optionally filtered by mode. */
export async function listSavedScreens(
  userId: string,
  mode?: ScreenerModeId,
  deps: SavedScreensServiceDeps = {},
): Promise<ServiceResult<SavedScreenSummary[]>> {
  const db = deps.prisma ?? prisma;
  try {
    const rows = await db.savedScreen.findMany({
      where: { userId, ...(mode ? { mode } : {}) },
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
  } catch (error) {
    logger.error({ error, userId }, "listSavedScreens service error");
    // MONEY-1062 (Round C / C3#4): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to list saved screens",
      code: "INTERNAL",
    };
  }
}

/** Load a single screen by id (ownership-scoped). */
export async function loadSavedScreen(
  userId: string,
  id: string,
  deps: SavedScreensServiceDeps = {},
): Promise<ServiceResult<SavedScreenDetail>> {
  const db = deps.prisma ?? prisma;
  try {
    const row = await db.savedScreen.findFirst({ where: { id, userId } });
    if (!row)
      return { success: false, error: "Screen not found", code: "NOT_FOUND" };

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
  } catch (error) {
    logger.error({ error, userId, id }, "loadSavedScreen service error");
    // MONEY-1062 (Round C / C3#4): code so routes map a DB blip to 500, not 404.
    return { success: false, error: "Failed to load screen", code: "INTERNAL" };
  }
}

/**
 * Rename a screen. Confirms ownership, then rejects a same-mode name collision
 * (surfaced to the route as a 409-ish conflict).
 */
export async function renameSavedScreen(
  userId: string,
  input: RenameScreenInput,
  deps: SavedScreensServiceDeps = {},
): Promise<ServiceResult<SavedScreenSummary>> {
  const db = deps.prisma ?? prisma;
  const { id, name } = input;
  try {
    const existing = await db.savedScreen.findFirst({ where: { id, userId } });
    if (!existing)
      return { success: false, error: "Screen not found", code: "NOT_FOUND" };

    const collision = await db.savedScreen.findFirst({
      where: { userId, mode: existing.mode, name, NOT: { id } },
      select: { id: true },
    });
    if (collision) {
      return {
        success: false,
        error: `A screen named "${name}" already exists for this mode`,
        code: "CONFLICT",
      };
    }

    const row = await db.savedScreen.update({ where: { id }, data: { name } });
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
  } catch (error) {
    logger.error({ error, userId, id }, "renameSavedScreen service error");
    // MONEY-1062 (Round C / C3#4): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to rename screen",
      code: "INTERNAL",
    };
  }
}

/** Delete a screen (scoped delete → foreign id is a no-op not-found). */
export async function deleteSavedScreen(
  userId: string,
  id: string,
  deps: SavedScreensServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const res = await db.savedScreen.deleteMany({ where: { id, userId } });
    if (res.count === 0)
      return { success: false, error: "Screen not found", code: "NOT_FOUND" };
    return { success: true, data: { id } };
  } catch (error) {
    logger.error({ error, userId, id }, "deleteSavedScreen service error");
    // MONEY-1062 (Round C / C3#4): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to delete screen",
      code: "INTERNAL",
    };
  }
}
