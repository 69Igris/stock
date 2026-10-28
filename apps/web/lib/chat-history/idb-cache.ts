/**
 * IndexedDB cache for chat history list.
 *
 * Survives navigation, refresh, and tab close. Scoped by userId so cache
 * never leaks between accounts on a shared device.
 *
 * Storage: ~few MB at most (sidebar limit=50). Browser quotas are 50MB+ so
 * this is comfortably within budget.
 */

import type { ChatHistoryRecord } from "@/lib/actions/chat-history";

const DB_NAME = "usemoney-cache";
const DB_VERSION = 1;
const STORE = "chatHistory";

export interface CacheEntry {
  key: string;
  userId: string;
  data: ChatHistoryRecord[];
  totalCount: number;
  timestamp: number;
}

/**
 * Bumped when the SHAPE or SCOPE of a cached list changes, so entries written
 * by an older build cannot be served by a newer one (MONEY-1255).
 *
 * v2: StockSage's history stopped listing the Ask FIRE / Ask Screener chats.
 * Without this bump a returning user keeps their cached first page — which
 * still contains those rows — and the fix looks like it did not ship until the
 * cache happens to clear. The key carries no other scope marker, so there is
 * nothing else that would distinguish the two.
 */
const KEY_VERSION = "v2";

export function buildKey(
  userId: string,
  isArchived: boolean,
  searchQuery: string
): string {
  return `${KEY_VERSION}:${userId}:${isArchived ? "archived" : "active"}:${searchQuery}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB not available"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("userId", "userId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function rehydrateDates(chats: ChatHistoryRecord[]): ChatHistoryRecord[] {
  return chats.map((c) => ({
    ...c,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    lastMessageAt: new Date(c.lastMessageAt),
  }));
}

export async function idbGet(key: string): Promise<CacheEntry | null> {
  try {
    const db = await openDb();
    return new Promise<CacheEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined;
        if (!entry) return resolve(null);
        resolve({ ...entry, data: rehydrateDates(entry.data) });
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // IDB unavailable (Safari private mode, etc.) - degrade silently
    return null;
  }
}

export async function idbSet(
  key: string,
  userId: string,
  data: ChatHistoryRecord[],
  totalCount: number
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        key,
        userId,
        data,
        totalCount,
        timestamp: Date.now(),
      } satisfies CacheEntry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Storage quota / private mode - fail silently
  }
}

/** Clear all cache entries belonging to a user (sign-out, account switch). */
export async function idbClearForUser(userId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const idx = store.index("userId");
      const req = idx.openCursor(IDBKeyRange.only(userId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

/** Nuclear: clear the whole store. Use sparingly. */
export async function idbClearAll(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}
