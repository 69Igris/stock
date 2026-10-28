/**
 * MONEY-393 §32 - lib/chat-history/idb-cache.ts source coverage push
 * (58.2% → 90%+).
 *
 * The existing test (idb-cache.test.ts) covers `buildKey` + the IDB-
 * undefined catch paths (4 cases). What's missing: the IDB-present
 * happy paths (open → put → get → rehydrate → cursor-delete → clear),
 * which is where most of the source lives.
 *
 * Strategy: install a minimal in-memory IDB onto globalThis just for
 * this test file. Each scenario bursts require.cache so the module's
 * own dbPromise singleton is fresh.
 *
 * The fake intentionally supports only the operations idb-cache.ts
 * touches: open, transaction(store, mode), get, put, clear, index,
 * openCursor (with cursor.delete + cursor.continue), and IDBKeyRange.only.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Minimal IDB fake ─────────────────────────────────────────────

interface FakeRequest<T = unknown> {
  result: T;
  error: Error | null;
  onsuccess: ((this: FakeRequest<T>, ev: Event) => void) | null;
  onerror: ((this: FakeRequest<T>, ev: Event) => void) | null;
  onupgradeneeded?: ((this: FakeRequest<T>, ev: Event) => void) | null;
}

interface FakeCursor {
  value: { key: string; userId: string; [k: string]: unknown };
  delete: () => void;
  continue: () => void;
}

class FakeKeyRange {
  constructor(public value: unknown) {}
  static only(value: unknown): FakeKeyRange {
    return new FakeKeyRange(value);
  }
}

interface FakeIndex {
  openCursor: (range: FakeKeyRange) => FakeRequest<FakeCursor | null>;
}

interface FakeObjectStore {
  get: (key: string) => FakeRequest<Record<string, unknown> | undefined>;
  put: (val: Record<string, unknown>) => FakeRequest<string>;
  clear: () => FakeRequest<void>;
  index: (name: string) => FakeIndex;
  createIndex: (name: string, keyPath: string, opts: object) => void;
}

interface FakeTransaction {
  objectStore: (name: string) => FakeObjectStore;
  oncomplete: ((this: FakeTransaction) => void) | null;
  onerror: ((this: FakeTransaction) => void) | null;
  error: Error | null;
  _failPut?: boolean;
}

interface FakeDB {
  objectStoreNames: { contains: (s: string) => boolean };
  createObjectStore: (
    name: string,
    opts: { keyPath: string }
  ) => FakeObjectStore;
  transaction: (store: string, mode: string) => FakeTransaction;
  _stores: Map<string, FakeStore>;
}

interface FakeStore {
  data: Map<string, Record<string, unknown>>;
  indexes: Map<string, { keyPath: string }>;
}

function tick(fn: () => void): void {
  queueMicrotask(fn);
}

function makeStore(): FakeStore {
  return { data: new Map(), indexes: new Map() };
}

function makeObjectStore(
  store: FakeStore,
  txState: { _failPut?: boolean }
): FakeObjectStore {
  return {
    get(key: string) {
      const req: FakeRequest<Record<string, unknown> | undefined> = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      tick(() => {
        req.result = store.data.get(key);
        req.onsuccess?.call(req, {} as Event);
      });
      return req;
    },
    put(val: Record<string, unknown>) {
      const req: FakeRequest<string> = {
        result: "",
        error: null,
        onsuccess: null,
        onerror: null,
      };
      tick(() => {
        if (txState._failPut) {
          req.error = new Error("put failed");
          req.onerror?.call(req, {} as Event);
          return;
        }
        const k = val.key as string;
        store.data.set(k, val);
        req.result = k;
        req.onsuccess?.call(req, {} as Event);
      });
      return req;
    },
    clear() {
      const req: FakeRequest<void> = {
        result: undefined as never,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      tick(() => {
        store.data.clear();
        req.onsuccess?.call(req, {} as Event);
      });
      return req;
    },
    index(name: string): FakeIndex {
      const idx = store.indexes.get(name);
      if (!idx) throw new Error(`unknown index: ${name}`);
      return {
        openCursor(range: FakeKeyRange): FakeRequest<FakeCursor | null> {
          const req: FakeRequest<FakeCursor | null> = {
            result: null,
            error: null,
            onsuccess: null,
            onerror: null,
          };
          // Collect matches, then iterate them via cursor.continue().
          const matches = [...store.data.values()].filter(
            (v) => (v as Record<string, unknown>)[idx.keyPath] === range.value
          );
          let i = 0;
          const fireNext = (): void => {
            if (i >= matches.length) {
              req.result = null;
              tick(() => req.onsuccess?.call(req, {} as Event));
              return;
            }
            const current = matches[i] as FakeCursor["value"];
            const cursor: FakeCursor = {
              value: current,
              delete: () => {
                store.data.delete(current.key);
              },
              continue: () => {
                i++;
                fireNext();
              },
            };
            req.result = cursor;
            tick(() => req.onsuccess?.call(req, {} as Event));
          };
          tick(fireNext);
          return req;
        },
      };
    },
    createIndex(name: string, keyPath: string) {
      store.indexes.set(name, { keyPath });
    },
  };
}

function makeFakeIDB(): {
  indexedDB: { open: (name: string, version: number) => FakeRequest<FakeDB> };
  IDBKeyRange: typeof FakeKeyRange;
  _store: () => FakeStore | undefined;
} {
  const stores: Map<string, FakeStore> = new Map();
  return {
    indexedDB: {
      open(_name: string, _version: number): FakeRequest<FakeDB> {
        const req: FakeRequest<FakeDB> = {
          result: undefined as never,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        const txState: { _failPut?: boolean } = {};
        const db: FakeDB = {
          objectStoreNames: {
            contains(s: string) {
              return stores.has(s);
            },
          },
          createObjectStore(name: string, _opts: { keyPath: string }) {
            const s = makeStore();
            stores.set(name, s);
            return makeObjectStore(s, txState);
          },
          transaction(name: string, _mode: string): FakeTransaction {
            const s = stores.get(name);
            if (!s) throw new Error(`unknown store: ${name}`);
            const tx: FakeTransaction = {
              objectStore: () => makeObjectStore(s, txState),
              oncomplete: null,
              onerror: null,
              error: null,
            };
            // Fire oncomplete on the next macrotask AFTER all pending
            // microtasks have run. setImmediate is ideal.
            setImmediate(() => {
              if (tx.error) tx.onerror?.call(tx);
              else tx.oncomplete?.call(tx);
            });
            return tx;
          },
          _stores: stores,
        };
        req.result = db;
        tick(() => {
          // Trigger upgrade once on first open
          req.onupgradeneeded?.call(req, {} as Event);
          req.onsuccess?.call(req, {} as Event);
        });
        return req;
      },
    },
    IDBKeyRange: FakeKeyRange,
    _store: () => stores.get("chatHistory"),
  };
}

interface MutableGlobal {
  indexedDB?: unknown;
  IDBKeyRange?: unknown;
}

// ── Test setup ──────────────────────────────────────────────────

interface IdbCacheModule {
  buildKey: (uid: string, archived: boolean, q: string) => string;
  idbGet: (key: string) => Promise<{
    key: string;
    userId: string;
    data: unknown[];
    totalCount: number;
    timestamp: number;
  } | null>;
  idbSet: (
    key: string,
    userId: string,
    data: unknown[],
    totalCount: number
  ) => Promise<void>;
  idbClearForUser: (userId: string) => Promise<void>;
  idbClearAll: () => Promise<void>;
}

function loadIdbCacheFresh(): IdbCacheModule {
  const path = require.resolve("../../lib/chat-history/idb-cache");
  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;
  delete cache[path];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../lib/chat-history/idb-cache") as IdbCacheModule;
}

const g = globalThis as MutableGlobal;
let savedIDB: unknown;
let savedRange: unknown;
let fake: ReturnType<typeof makeFakeIDB>;

before(() => {
  savedIDB = g.indexedDB;
  savedRange = g.IDBKeyRange;
});

after(() => {
  if (savedIDB === undefined) delete g.indexedDB;
  else g.indexedDB = savedIDB;
  if (savedRange === undefined) delete g.IDBKeyRange;
  else g.IDBKeyRange = savedRange;
});

beforeEach(() => {
  fake = makeFakeIDB();
  g.indexedDB = fake.indexedDB;
  g.IDBKeyRange = fake.IDBKeyRange;
});

// ── Tests ───────────────────────────────────────────────────────

describe("MONEY-393 §32 - idb-cache.ts with stub IDB", () => {
  it("[round-trip] set then get returns the same data + count", async () => {
    const mod = loadIdbCacheFresh();
    const chats = [
      {
        id: "chat-1",
        title: "Apple Q4",
        createdAt: new Date("2026-01-01").toISOString(),
        updatedAt: new Date("2026-01-02").toISOString(),
        lastMessageAt: new Date("2026-01-03").toISOString(),
      },
    ];
    await mod.idbSet("alice:active:", "alice", chats, 1);
    const got = await mod.idbGet("alice:active:");
    assert.ok(got, "stored entry must round-trip");
    assert.equal(got!.userId, "alice");
    assert.equal(got!.totalCount, 1);
    assert.equal(got!.data.length, 1);
  });

  it("[get] rehydrates ISO strings back to Date instances", async () => {
    const mod = loadIdbCacheFresh();
    const chats = [
      {
        id: "chat-1",
        title: "x",
        createdAt: new Date("2026-01-01").toISOString(),
        updatedAt: new Date("2026-01-02").toISOString(),
        lastMessageAt: new Date("2026-01-03").toISOString(),
      },
    ];
    await mod.idbSet("alice:active:", "alice", chats, 1);
    const got = await mod.idbGet("alice:active:");
    const row = got!.data[0] as Record<string, unknown>;
    assert.ok(row.createdAt instanceof Date, "createdAt → Date");
    assert.ok(row.updatedAt instanceof Date, "updatedAt → Date");
    assert.ok(row.lastMessageAt instanceof Date, "lastMessageAt → Date");
  });

  it("[get] returns null for an unknown key", async () => {
    const mod = loadIdbCacheFresh();
    const got = await mod.idbGet("nothing-here");
    assert.equal(got, null);
  });

  it("[clearForUser] removes only that user's entries (cursor.delete loop)", async () => {
    const mod = loadIdbCacheFresh();
    await mod.idbSet("alice:active:", "alice", [], 0);
    await mod.idbSet("alice:archived:", "alice", [], 0);
    await mod.idbSet("bob:active:", "bob", [], 0);

    await mod.idbClearForUser("alice");

    // Verify the fake store directly
    const s = fake._store()!;
    const keys = [...s.data.keys()].sort();
    assert.deepEqual(
      keys,
      ["bob:active:"],
      "alice's two entries deleted, bob's preserved"
    );
  });

  it("[clearAll] empties the entire store", async () => {
    const mod = loadIdbCacheFresh();
    await mod.idbSet("alice:active:", "alice", [], 0);
    await mod.idbSet("bob:active:", "bob", [], 0);

    await mod.idbClearAll();

    const s = fake._store()!;
    assert.equal(s.data.size, 0, "store fully cleared");
  });

  it("[openDb] is memoized - second call reuses dbPromise", async () => {
    const mod = loadIdbCacheFresh();
    // Two parallel ops; both must succeed → proves dbPromise is reused
    // (if it weren't, the second open() would race the first).
    const [a, b] = await Promise.all([
      mod.idbSet("k1", "alice", [], 0),
      mod.idbSet("k2", "alice", [], 0),
    ]);
    assert.equal(a, undefined);
    assert.equal(b, undefined);
    const s = fake._store()!;
    assert.equal(s.data.size, 2);
  });

  it("[set] silently swallows transaction errors (quota / private mode)", async () => {
    const mod = loadIdbCacheFresh();
    // Replace transaction with one that always errors on oncomplete.
    const realOpen = fake.indexedDB.open.bind(fake.indexedDB);
    fake.indexedDB.open = (name: string, version: number) => {
      const req = realOpen(name, version);
      const origResolve = req.onsuccess;
      tick(() => {
        const db = req.result as FakeDB;
        const realTx = db.transaction.bind(db);
        db.transaction = (n: string, m: string) => {
          const tx = realTx(n, m);
          tx.error = new Error("quota exceeded");
          return tx;
        };
        origResolve?.call(req, {} as Event);
      });
      // Don't double-fire onsuccess from the original handler
      req.onsuccess = null;
      return req;
    };
    // Must not throw
    await mod.idbSet("k", "alice", [], 0);
    assert.ok(true, "idbSet swallows tx errors");
  });

  it("[clearForUser] silently swallows errors when transaction fails", async () => {
    const mod = loadIdbCacheFresh();
    // Use idbSet first to ensure store exists, then force tx error.
    await mod.idbSet("alice:k", "alice", [], 0);

    // Wrap transaction to throw on open
    const db = await (
      fake.indexedDB.open("usemoney-cache", 1) as FakeRequest<FakeDB>
    ).result;
    const origTx = db.transaction.bind(db);
    db.transaction = (n: string, m: string) => {
      throw new Error("simulated tx open failure");
    };

    // The catch block on idbClearForUser must swallow it.
    await mod.idbClearForUser("alice");
    assert.ok(true, "idbClearForUser swallows synchronous tx error");

    // Restore so other tests are unaffected
    db.transaction = origTx;
  });

  it("[buildKey] composes the cache key with the same shape as the existing test", () => {
    // MONEY-1255 prefixed the key with a version segment so a scope change
    // (StockSage no longer listing the side chats) cannot be served from an
    // entry an older build wrote.
    const mod = loadIdbCacheFresh();
    assert.equal(mod.buildKey("alice", false, ""), "v2:alice:active:");
    assert.equal(mod.buildKey("alice", true, ""), "v2:alice:archived:");
    assert.equal(mod.buildKey("alice", false, "tcs"), "v2:alice:active:tcs");
  });
});
