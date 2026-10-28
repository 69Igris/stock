"use server";

/**
 * Watchlist Server Actions
 *
 * CRUD operations for user watchlists and watchlist items.
 */

import { getAuthenticatedUser } from "@/lib/auth";
import {
  getWatchlists as getWatchlistsService,
  createWatchlist as createWatchlistService,
  updateWatchlist as updateWatchlistService,
  deleteWatchlist as deleteWatchlistService,
  addWatchlistItem as addWatchlistItemService,
  removeWatchlistItem as removeWatchlistItemService,
  reorderWatchlistItems as reorderWatchlistItemsService,
  batchAddWatchlistItems as batchAddWatchlistItemsService,
} from "@usemoney/services";
import type {
  CreateWatchlistInput,
  UpdateWatchlistInput,
  AddWatchlistItemInput,
  ReorderWatchlistItemsInput,
  BatchAddWatchlistItemsInput,
} from "@usemoney/services";
import { getMfsBySchemeCodesAction } from "@/lib/actions/discover-mf";
import type { DiscoverMutualFund } from "@/lib/actions/discover-mf";
import { isDemoSession } from "@/lib/demo/session";
import { demoWatchlists } from "@/lib/demo/data";
import { dbLogger as logger } from "@usemoney/logger";

/** True when the error is a genuine timeout thrown by withActionTimeout. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("timed out after");
}

/** Race a promise against a timeout - rejects with an error if too slow */
function withActionTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Re-export types for consumers
export type {
  WatchlistData,
  WatchlistItemData,
  CreateWatchlistInput,
  UpdateWatchlistInput,
  AddWatchlistItemInput,
  ReorderWatchlistItemsInput,
  BatchAddWatchlistItemsInput,
} from "@usemoney/services";

// ============== GET WATCHLISTS ==============

export async function getWatchlistsAction(): Promise<{
  success: boolean;
  data?: import("@usemoney/services").WatchlistData[];
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: true,
      data: demoWatchlists as unknown as import("@usemoney/services").WatchlistData[],
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  try {
    return await withActionTimeout(
      getWatchlistsService(authUser.userId),
      10_000,
      "getWatchlists"
    );
  } catch (error) {
    logger.error({ error, userId: authUser.userId }, "getWatchlists failed");
    return {
      success: false,
      error: isTimeoutError(error)
        ? "Request timed out. Please try again."
        : "Couldn't load watchlists. Please try again.",
    };
  }
}

// ============== CREATE WATCHLIST ==============

export async function createWatchlistAction(
  data: CreateWatchlistInput
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").WatchlistData;
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return createWatchlistService(authUser.userId, data);
}

// ============== UPDATE WATCHLIST ==============

export async function updateWatchlistAction(
  watchlistId: string,
  data: UpdateWatchlistInput
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return updateWatchlistService(authUser.userId, watchlistId, data);
}

// ============== DELETE WATCHLIST ==============

export async function deleteWatchlistAction(
  watchlistId: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return deleteWatchlistService(authUser.userId, watchlistId);
}

// ============== ADD ITEM TO WATCHLIST ==============

export async function addWatchlistItemAction(
  data: AddWatchlistItemInput
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return addWatchlistItemService(authUser.userId, data);
}

// ============== REMOVE ITEM FROM WATCHLIST ==============

export async function removeWatchlistItemAction(
  itemId: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return removeWatchlistItemService(authUser.userId, itemId);
}

// ============== REORDER ITEMS ==============

export async function reorderWatchlistItemsAction(
  data: ReorderWatchlistItemsInput
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  return reorderWatchlistItemsService(authUser.userId, data);
}

// ============== BATCH ADD ITEMS ==============

export async function batchAddWatchlistItemsAction(
  data: BatchAddWatchlistItemsInput
): Promise<{ success: boolean; addedCount?: number; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  const result = await batchAddWatchlistItemsService(authUser.userId, data);
  if (result?.success) {
    return { success: true, addedCount: result?.data.addedCount };
  }
  return result;
}

// ============== MF DATA FOR WATCHLIST ==============

export type { DiscoverMutualFund as MfWatchlistData };

export async function getWatchlistMfDataAction(schemeCodes: string[]): Promise<{
  success: boolean;
  data?: Map<string, DiscoverMutualFund>;
  error?: string;
}> {
  if (!schemeCodes.length) {
    return { success: true, data: new Map() };
  }

  try {
    const result = await withActionTimeout(
      getMfsBySchemeCodesAction(schemeCodes),
      10_000,
      "getWatchlistMfData"
    );
    if (!result?.success || !result?.data) {
      return {
        success: false,
        error: result?.error ?? "Failed to fetch MF data",
      };
    }

    const map = new Map<string, DiscoverMutualFund>();
    for (const fund of result?.data) {
      map.set(fund.schemeCode, fund);
    }
    return { success: true, data: map };
  } catch (error) {
    logger.error(
      { error, schemeCount: schemeCodes.length },
      "getWatchlistMfData failed"
    );
    return {
      success: false,
      error: isTimeoutError(error)
        ? "Request timed out. Please try again."
        : "Couldn't load watchlist fund data. Please try again.",
    };
  }
}
