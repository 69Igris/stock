import { openDB, type IDBPDatabase } from "idb";
import type { IDBCacheEntry } from "./types";

const DB_VERSION = 1;
const STORE_NAME = "cache";

interface CacheDB {
  cache: {
    key: string;
    value: IDBCacheEntry;
    indexes: {
      "by-module": string;
      "by-timestamp": number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<CacheDB>> | null = null;
let currentDbName: string | null = null;

function dbName(userId: string): string {
  return `usemoney-cache-${userId}`;
}

/**
 * Get or open the per-user IndexedDB database.
 * Reuses the same promise if the userId hasn't changed.
 */
export function getDB(userId: string): Promise<IDBPDatabase<CacheDB>> {
  const name = dbName(userId);
  if (dbPromise && currentDbName === name) return dbPromise;

  // Close previous DB handle if switching users
  if (dbPromise && currentDbName !== name) {
    dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }

  currentDbName = name;
  dbPromise = openDB<CacheDB>(name, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("by-module", "module", { unique: false });
        store.createIndex("by-timestamp", "timestamp", { unique: false });
      }
    },
  });

  return dbPromise;
}

/**
 * Delete the entire database for a given user (logout / user switch).
 */
export async function deleteUserDB(userId: string): Promise<void> {
  const name = dbName(userId);
  // Close the handle if it matches
  if (dbPromise && currentDbName === name) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // ignore
    }
    dbPromise = null;
    currentDbName = null;
  }

  // indexedDB.deleteDatabase is fire-and-forget
  if (typeof indexedDB !== "undefined") {
    indexedDB.deleteDatabase(name);
  }
}

/** Check whether IndexedDB is available (private browsing, etc.) */
export function isIDBAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export { STORE_NAME };
