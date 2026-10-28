/**
 * Watchlist Service
 *
 * CRUD operations for user watchlists and watchlist items.
 * Source: apps/web/lib/actions/watchlist.ts
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached, clearWatchlistCache } from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";

// ── Types ──────────────────────────────────────────────────────────

export interface WatchlistData {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  type: string;
  isDefault: boolean;
  order: number;
  itemCount: number;
  items: WatchlistItemData[];
  /** Latest mutation timestamp - surfaced in the sidebar as "Updated 2m ago" (MONEY-207). */
  updatedAt: Date;
}

export interface WatchlistItemData {
  id: string;
  symbol: string;
  exchange: string;
  instrumentId: string | null;
  sortOrder: number;
  addedAt: Date;
}

export interface CreateWatchlistInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  type?: "STOCK" | "MF";
}

export interface UpdateWatchlistInput {
  name?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface AddWatchlistItemInput {
  watchlistId: string;
  symbol: string;
  exchange: string;
  instrumentId?: string;
}

export interface ReorderWatchlistItemsInput {
  watchlistId: string;
  itemIds: string[];
}

export interface BatchAddWatchlistItemsInput {
  watchlistId: string;
  items: Array<{
    symbol: string;
    exchange: string;
    instrumentId?: string;
  }>;
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Get all watchlists with items (cached)
 */
export async function getWatchlists(
  userId: string,
): Promise<ServiceResult<WatchlistData[]>> {
  try {
    const cached = await getCached<WatchlistData[]>("watchlist", userId, "all");
    if (cached) {
      return { success: true, data: cached };
    }

    const watchlists = await Promise.race([
      prisma.watchList.findMany({
        where: { userId },
        include: {
          items: {
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: [
          { isDefault: "desc" },
          { order: "asc" },
          { createdAt: "asc" },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Watchlist query timed out after 8s")),
          8_000,
        ),
      ),
    ]);

    const data: WatchlistData[] = watchlists.map((wl) => ({
      id: wl.id,
      name: wl.name,
      description: wl.description,
      color: wl.color,
      icon: wl.icon,
      type: wl.type,
      isDefault: wl.isDefault,
      order: wl.order,
      itemCount: wl.items.length,
      updatedAt: wl.updatedAt,
      items: wl.items.map(
        (item: {
          id: string;
          symbol: string;
          exchange: string;
          instrumentId: string | null;
          sortOrder: number;
          addedAt: Date;
        }) => ({
          id: item.id,
          symbol: item.symbol,
          exchange: item.exchange,
          instrumentId: item.instrumentId,
          sortOrder: item.sortOrder,
          addedAt: item.addedAt,
        }),
      ),
    }));

    await setCached("watchlist", userId, "all", data);

    return { success: true, data };
  } catch (error) {
    logger.error({ error, userId }, "Get watchlists service error");
    return { success: false, error: "Failed to load watchlists" };
  }
}

/**
 * Create a new watchlist (checks name uniqueness)
 */
export async function createWatchlist(
  userId: string,
  data: CreateWatchlistInput,
): Promise<ServiceResult<WatchlistData>> {
  try {
    // Guard an absent/blank name BEFORE the uniqueness check. Prisma drops an
    // `undefined` where-value, so `findFirst({ where: { userId, name: undefined }})`
    // matches ANY of the user's watchlists → a bogus "already exists" (or, on
    // create, a NULL/blank-named row). A real name is required; reject up front.
    if (!data.name || data.name.trim() === "") {
      return {
        success: false,
        error: "Watchlist name is required",
        code: "INVALID_INPUT",
      };
    }

    // Check if name already exists
    const existing = await prisma.watchList.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) {
      return {
        success: false,
        error: "A watchlist with this name already exists",
      };
    }

    const watchlist = await prisma.watchList.create({
      data: {
        userId,
        name: data.name,
        description: data.description,
        color: data.color,
        icon: data.icon,
        type: data.type ?? "STOCK",
      },
      include: { items: true },
    });

    await clearWatchlistCache(userId);

    return {
      success: true,
      data: {
        id: watchlist.id,
        name: watchlist.name,
        description: watchlist.description,
        color: watchlist.color,
        icon: watchlist.icon,
        type: watchlist.type,
        isDefault: watchlist.isDefault,
        order: watchlist.order,
        itemCount: 0,
        updatedAt: watchlist.updatedAt,
        items: [],
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Create watchlist service error");
    return {
      success: false,
      error: "Failed to create watchlist",
      code: "INTERNAL",
    };
  }
}

/**
 * Update a watchlist (rename/re-color)
 */
export async function updateWatchlist(
  userId: string,
  watchlistId: string,
  data: UpdateWatchlistInput,
): Promise<ServiceResult<void>> {
  try {
    const watchlist = await prisma.watchList.findFirst({
      where: { id: watchlistId, userId },
    });
    if (!watchlist) {
      return { success: false, error: "Watchlist not found" };
    }

    // If renaming, check for name conflicts
    if (data.name && data.name !== watchlist.name) {
      const existing = await prisma.watchList.findFirst({
        where: {
          userId,
          name: data.name,
          id: { not: watchlistId },
        },
      });
      if (existing) {
        return {
          success: false,
          error: "A watchlist with this name already exists",
        };
      }
    }

    await prisma.watchList.update({
      where: { id: watchlistId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.color !== undefined && { color: data.color }),
        ...(data.icon !== undefined && { icon: data.icon }),
      },
    });

    await clearWatchlistCache(userId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, watchlistId },
      "Update watchlist service error",
    );
    return { success: false, error: "Failed to update watchlist" };
  }
}

/**
 * Delete a watchlist (verify ownership first)
 */
export async function deleteWatchlist(
  userId: string,
  watchlistId: string,
): Promise<ServiceResult<void>> {
  try {
    // Verify ownership
    const watchlist = await prisma.watchList.findFirst({
      where: { id: watchlistId, userId },
    });
    if (!watchlist) {
      return {
        success: false,
        error: "Watchlist not found",
        code: "NOT_FOUND",
      };
    }

    await prisma.watchList.delete({ where: { id: watchlistId } });

    await clearWatchlistCache(userId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, watchlistId },
      "Delete watchlist service error",
    );
    return {
      success: false,
      error: "Failed to delete watchlist",
      code: "INTERNAL",
    };
  }
}

/**
 * Add an item to a watchlist (upsert to handle duplicates)
 */
export async function addWatchlistItem(
  userId: string,
  data: AddWatchlistItemInput,
): Promise<ServiceResult<void>> {
  try {
    // Verify ownership
    const watchlist = await prisma.watchList.findFirst({
      where: { id: data.watchlistId, userId },
    });
    if (!watchlist) {
      return {
        success: false,
        error: "Watchlist not found",
        code: "NOT_FOUND",
      };
    }

    // Get current max sort order
    const lastItem = await prisma.watchlistItem.findFirst({
      where: { watchlistId: data.watchlistId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const nextOrder = (lastItem?.sortOrder ?? -1) + 1;

    // Add item (upsert to handle duplicates gracefully)
    await prisma.watchlistItem.upsert({
      where: {
        watchlistId_symbol_exchange: {
          watchlistId: data.watchlistId,
          symbol: data.symbol,
          exchange: data.exchange,
        },
      },
      create: {
        watchlistId: data.watchlistId,
        symbol: data.symbol,
        exchange: data.exchange,
        instrumentId: data.instrumentId,
        sortOrder: nextOrder,
      },
      update: {},
    });

    await clearWatchlistCache(userId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, userId }, "Add watchlist item service error");
    return { success: false, error: "Failed to add to watchlist" };
  }
}

/**
 * Remove an item from a watchlist (verify ownership through watchlist)
 */
export async function removeWatchlistItem(
  userId: string,
  itemId: string,
): Promise<ServiceResult<void>> {
  try {
    // Verify ownership through watchlist
    const item = await prisma.watchlistItem.findUnique({
      where: { id: itemId },
      include: { watchlist: { select: { userId: true } } },
    });

    if (!item || item.watchlist.userId !== userId) {
      return {
        success: false,
        error: "Item not found",
        code: "NOT_FOUND",
      };
    }

    await prisma.watchlistItem.delete({ where: { id: itemId } });

    await clearWatchlistCache(userId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, itemId },
      "Remove watchlist item service error",
    );
    return {
      success: false,
      error: "Failed to remove from watchlist",
      code: "INTERNAL",
    };
  }
}

/**
 * Reorder watchlist items (update sortOrder in a transaction)
 */
export async function reorderWatchlistItems(
  userId: string,
  data: ReorderWatchlistItemsInput,
): Promise<ServiceResult<void>> {
  try {
    // Verify ownership
    const watchlist = await prisma.watchList.findFirst({
      where: { id: data.watchlistId, userId },
    });
    if (!watchlist) {
      return { success: false, error: "Watchlist not found" };
    }

    // IDOR guard (MONEY-594 A01): the watchlist-ownership check above only
    // proves the caller owns `data.watchlistId` — it says nothing about the
    // client-supplied `itemIds`. A previous `update({ where: { id } })` loop
    // would reorder ANY watchlistItem by id, letting an attacker pass their
    // own watchlistId (passes the check) plus a victim's item ids. Scope every
    // child write to the verified watchlist via `updateMany` so an id that
    // does not belong to this watchlist matches zero rows and is silently
    // ignored instead of being mutated cross-user.
    const updates = data.itemIds.map((id, index) =>
      prisma.watchlistItem.updateMany({
        where: { id, watchlistId: watchlist.id },
        data: { sortOrder: index },
      }),
    );

    await prisma.$transaction(updates);

    await clearWatchlistCache(userId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, userId }, "Reorder watchlist items service error");
    return { success: false, error: "Failed to reorder items" };
  }
}

/**
 * Batch add items to a watchlist (bulk upsert in transaction)
 */
export async function batchAddWatchlistItems(
  userId: string,
  data: BatchAddWatchlistItemsInput,
): Promise<ServiceResult<{ addedCount: number }>> {
  try {
    const watchlist = await prisma.watchList.findFirst({
      where: { id: data.watchlistId, userId },
    });
    if (!watchlist) {
      return { success: false, error: "Watchlist not found" };
    }

    if (data.items.length === 0) {
      return { success: true, data: { addedCount: 0 } };
    }

    const lastItem = await prisma.watchlistItem.findFirst({
      where: { watchlistId: data.watchlistId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const nextOrder = (lastItem?.sortOrder ?? -1) + 1;

    const operations = data.items.map((item, index) =>
      prisma.watchlistItem.upsert({
        where: {
          watchlistId_symbol_exchange: {
            watchlistId: data.watchlistId,
            symbol: item.symbol,
            exchange: item.exchange,
          },
        },
        create: {
          watchlistId: data.watchlistId,
          symbol: item.symbol,
          exchange: item.exchange,
          instrumentId: item.instrumentId,
          sortOrder: nextOrder + index,
        },
        update: {},
      }),
    );

    await prisma.$transaction(operations);

    await clearWatchlistCache(userId);

    return { success: true, data: { addedCount: data.items.length } };
  } catch (error) {
    logger.error({ error, userId }, "Batch add watchlist items service error");
    return { success: false, error: "Failed to add items to watchlist" };
  }
}
