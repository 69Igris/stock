import { clearModule } from "./operations";
import { deleteUserDB } from "./db";
import type { IDBCacheModule } from "./types";

/**
 * Client-side cache invalidation helpers.
 * Mirrors the server-side `lib/cache/invalidation.ts` patterns.
 */

/** Clear specific module(s) for the current user */
export async function clearIDBModules(
  userId: string,
  modules: IDBCacheModule | IDBCacheModule[]
): Promise<void> {
  const arr = Array.isArray(modules) ? modules : [modules];
  await Promise.all(arr.map((m) => clearModule(userId, m)));
}

/** After broker sync - invalidate portfolio-related modules */
export async function clearIDBBrokerSync(userId: string): Promise<void> {
  await clearIDBModules(userId, [
    "dashboard",
    "positions",
    "holdings",
    "mutual-funds",
    "trades",
  ]);
}

/** After trade create/update/delete */
export async function clearIDBTradeCache(userId: string): Promise<void> {
  await clearIDBModules(userId, ["dashboard", "trades"]);
}

/** After position close */
export async function clearIDBPositionCache(userId: string): Promise<void> {
  await clearIDBModules(userId, [
    "dashboard",
    "positions",
    "holdings",
    "trades",
  ]);
}

/** After holding or MF delete */
export async function clearIDBHoldingsCache(userId: string): Promise<void> {
  await clearIDBModules(userId, ["holdings", "mutual-funds", "dashboard"]);
}

/** After CSV import */
export async function clearIDBImportCache(userId: string): Promise<void> {
  await clearIDBModules(userId, ["dashboard", "trades"]);
}

/** After watchlist create/update/delete or item add/remove */
export async function clearIDBWatchlistCache(userId: string): Promise<void> {
  await clearIDBModules(userId, ["watchlist"]);
}

/** After document upload/import/delete */
export async function clearIDBDocumentsCache(userId: string): Promise<void> {
  await clearIDBModules(userId, ["documents"]);
}

/** On user logout or account switch - nuke entire per-user DB */
export async function clearIDBAllUserData(userId: string): Promise<void> {
  await deleteUserDB(userId);
}
