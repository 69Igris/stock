/**
 * MONEY-620 — chat-history.service END-TO-END (real fns, recording prisma).
 *
 * DE-SHADOW: this file previously re-implemented `listChatHistories` /
 * `fetchAllChatsForList` inline and asserted the COPY (a shadow — green while the
 * real service could be broken). It now drives the REAL exported functions from
 * `@usemoney/services` through a recording-prisma + controllable-cache seam and
 * asserts the actual behavior + the exact prisma `where` clauses.
 *
 * Chat history is IDOR-sensitive: a chat is addressed by a client-supplied `id`,
 * so EVERY read/mutation must additionally scope to the caller's `userId`. A bare
 * `{ id }` read or write would let user A reach user B's chat. These tests pin
 * that the where-clause carries BOTH:
 *
 *   - getChatHistoryById   → findFirst WHERE { id, userId }       (read IDOR)
 *   - saveChatHistory(id)  → updateMany WHERE { id, userId }      (write IDOR)
 *   - deleteChatHistory    → deleteMany WHERE { id, userId }      (delete IDOR)
 *   - archive/unarchive/rename → updateMany WHERE { id, userId }  (mutation IDOR)
 *
 * Plus the cache layer the shadow used to fake, now exercised for real:
 *   - cache hit → returns from getCached, no prisma read
 *   - cache miss + small set → prisma count+findMany, writes setCached
 *   - cache miss + >500 → direct paginated path, no cache write
 *   - search applied AFTER cache read (search NOT in the cache key)
 *   - pagination applied AFTER cache read
 *   - pagination CLAMP: a NaN/negative/huge skip|limit must NOT slice to an
 *     empty/wrong page (cached) and must reach Prisma as a valid Int (direct).
 *   - mutations bust the cache via clearChatCache(userId)
 *   - list error path returns success + empty (bell-safe), reads/writes surface
 *     a sanitized failure.
 *
 * Seam: `chat-history.service` hard-imports `prisma` from `@usemoney/database`,
 * the cache helpers from `@usemoney/core`, and `dbLogger` from `@usemoney/logger`.
 * We inject doubles via `require.cache` before requiring the `@usemoney/services`
 * barrel (the proven pattern from `notifications-service-e2e.test.ts`). The core
 * double is controllable per-test (force cache hit/miss; record clearChatCache).
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/chat-history.service.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "@usemoney/types";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "updateMany" || method === "deleteMany") return { count: 0 };
    if (method === "create") return { id: "created-id" };
    if (method === "findFirst" || method === "findUnique") return null;
    return [];
  }

  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;

  constructor() {
    const self = this;
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (model === "then") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (args?: unknown) => {
                    self.calls.push({ model, method, args });
                    const err = self.failures.get(`${model}.${method}`);
                    if (err) return Promise.reject(err);
                    return Promise.resolve(self.next(model, method));
                  };
                },
              }
            );
          }
          return target[model];
        },
      }
    ) as RecordingPrisma["client"];
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── controllable @usemoney/core cache double ────────────────────────────────

interface CacheControl {
  /** Next getCached return value (null = miss). Reset to null each test. */
  getCachedResult: unknown;
  clearCalls: string[];
  setCalls: Array<{ args: unknown[] }>;
  getCalls: Array<{ args: unknown[] }>;
}

const cacheControl: CacheControl = {
  getCachedResult: null,
  clearCalls: [],
  setCalls: [],
  getCalls: [],
};

function resetCacheControl(): void {
  cacheControl.getCachedResult = null;
  cacheControl.clearCalls = [];
  cacheControl.setCalls = [];
  cacheControl.getCalls = [];
}

// ── module-boundary injection (install once, swap prisma per test) ──────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};

function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") {
          return async (...args: unknown[]) => {
            cacheControl.getCalls.push({ args });
            return cacheControl.getCachedResult;
          };
        }
        if (k === "setCached") {
          return async (...args: unknown[]) => {
            cacheControl.setCalls.push({ args });
          };
        }
        if (k === "clearChatCache") {
          return async (userId: string) => {
            cacheControl.clearCalls.push(userId);
          };
        }
        // Any other core symbol the barrel touches → safe async no-op.
        return async () => undefined;
      },
    }
  );
}

let activePrisma = new RecordingPrisma();

const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined;
      if (!(model in target)) {
        target[model] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[model]![method]!(args);
            },
          }
        );
      }
      return target[model];
    },
  }
);

// ── service surface under test ──────────────────────────────────────────────

interface ChatRecord {
  id: string;
  userId: string;
  pagePath: string;
  pageName: string;
  pageIcon?: string;
  customTitle?: string | null;
  messages: ChatMessage[];
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  title?: string;
  preview?: string;
  messageSummary?: { total: number; user: number; assistant: number };
}

type Ok<T> = { success: true; data: T };
type Err = { success: false; error: string };
type Result<T> = Ok<T> | Err;

interface ChatHistoryModule {
  saveChatHistory: (
    userId: string,
    pagePath: string,
    pageName: string,
    pageIcon: string | undefined,
    messages: ChatMessage[],
    chatId?: string,
    scenarioName?: string
  ) => Promise<Result<{ chatId: string }>>;
  listChatHistories: (
    userId: string,
    options?: {
      pagePath?: string;
      isArchived?: boolean;
      sortBy?: "date" | "lastMessage";
      order?: "asc" | "desc";
      limit?: number;
      skip?: number;
      searchQuery?: string;
    }
  ) => Promise<Result<{ chats: ChatRecord[]; totalCount: number }>>;
  getChatHistoryById: (
    userId: string,
    chatId: string
  ) => Promise<Result<ChatRecord | null>>;
  getChatHistoryByPage: (
    userId: string,
    pagePath: string,
    includeArchived?: boolean
  ) => Promise<Result<ChatRecord | null>>;
  archiveChatHistory: (userId: string, chatId: string) => Promise<Result<void>>;
  unarchiveChatHistory: (
    userId: string,
    chatId: string
  ) => Promise<Result<void>>;
  deleteChatHistory: (userId: string, chatId: string) => Promise<Result<void>>;
  renameChatHistory: (
    userId: string,
    chatId: string,
    title: string | null
  ) => Promise<Result<void>>;
}

let svc: ChatHistoryModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): ChatHistoryModule {
  if (svc) return svc;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
    // `Prisma` namespace is used only for types in the source (erased at
    // runtime), but keep a harmless object so any value-access never throws.
    Prisma: {},
  });
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") ||
        key.endsWith("/index.ts") ||
        key.endsWith("chat-history-logic.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  svc = require("@usemoney/services") as ChatHistoryModule;
  return svc;
}

/** Restore the pre-stub module cache so nothing leaks to sibling test files. */
function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  svc = null;
}

function swapPrisma(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

// ── fixtures ────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<ChatRecord> = {}): ChatRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "c1",
    userId: "u1",
    pagePath: "/dashboard",
    pageName: "Dashboard",
    pageIcon: undefined,
    customTitle: null,
    messages: [{ role: "user", content: "hello" }],
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — chat-history.service (real fns, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let mod: ChatHistoryModule;

  before(() => {
    mod = installServices();
  });
  beforeEach(() => {
    prisma = swapPrisma();
    resetCacheControl();
  });
  after(() => {
    uninstallServices();
  });

  // ── cache layer (was the shadow's whole subject) ──────────────────────────
  describe("listChatHistories — cache layer", () => {
    it("cache HIT: returns from cache without touching prisma", async () => {
      cacheControl.getCachedResult = {
        chats: [makeRow({ id: "c1" }), makeRow({ id: "c2" })],
        totalCount: 2,
      };
      const res = await mod.listChatHistories("u1", { isArchived: false });
      assert.equal(res.success, true);
      const data = (res as Ok<{ chats: ChatRecord[]; totalCount: number }>)
        .data;
      assert.equal(data.totalCount, 2);
      assert.equal(data.chats.length, 2);
      assert.equal(prisma.callsFor("chatHistory", "count").length, 0);
      assert.equal(prisma.callsFor("chatHistory", "findMany").length, 0);
      assert.equal(cacheControl.setCalls.length, 0);
    });

    it("cache MISS + small set: prisma count+findMany, writes cache", async () => {
      prisma.queue("chatHistory", "count", 1);
      prisma.queue("chatHistory", "findMany", [makeRow({ id: "c1" })]);
      const res = await mod.listChatHistories("u1", { isArchived: false });
      assert.equal(res.success, true);
      assert.equal((res as Ok<{ totalCount: number }>).data.totalCount, 1);
      assert.equal(cacheControl.getCalls.length, 1);
      assert.equal(prisma.callsFor("chatHistory", "count").length, 1);
      assert.equal(prisma.callsFor("chatHistory", "findMany").length, 1);
      assert.equal(cacheControl.setCalls.length, 1);
    });

    it("cache MISS + >500 chats: direct path, NO cache write", async () => {
      prisma.queue("chatHistory", "count", 1000); // fetchAllChatsForList count
      prisma.queue("chatHistory", "findMany", []); // direct-path findMany
      prisma.queue("chatHistory", "count", 1000); // direct-path totalCount
      const res = await mod.listChatHistories("u1", { isArchived: false });
      assert.equal(res.success, true);
      assert.equal(cacheControl.setCalls.length, 0, "no cache write above cap");
    });

    it("getCached cache KEY excludes searchQuery (search applied after read)", async () => {
      cacheControl.getCachedResult = {
        chats: [
          makeRow({ id: "c1", pageName: "TCS notes" }),
          makeRow({ id: "c2", pageName: "Reliance" }),
        ],
        totalCount: 2,
      };
      const res = await mod.listChatHistories("u1", {
        isArchived: false,
        searchQuery: "tcs",
      });
      const data = (res as Ok<{ chats: ChatRecord[]; totalCount: number }>)
        .data;
      assert.equal(data.chats.length, 1);
      assert.equal(data.chats[0]!.id, "c1");
      assert.equal(data.totalCount, 1);
      // the filters arg (4th) passed to getCached must NOT contain searchQuery
      const filtersArg = cacheControl.getCalls[0]!.args[3] as Record<
        string,
        unknown
      >;
      assert.equal(filtersArg.searchQuery, undefined);
    });

    it("pagination applies AFTER cache read", async () => {
      cacheControl.getCachedResult = {
        chats: Array.from({ length: 10 }, (_, i) => makeRow({ id: `c${i}` })),
        totalCount: 10,
      };
      const page1 = await mod.listChatHistories("u1", { skip: 0, limit: 3 });
      cacheControl.getCalls = [];
      const page2 = await mod.listChatHistories("u1", { skip: 3, limit: 3 });
      const d1 = (page1 as Ok<{ chats: ChatRecord[]; totalCount: number }>)
        .data;
      const d2 = (page2 as Ok<{ chats: ChatRecord[]; totalCount: number }>)
        .data;
      assert.equal(d1.chats.length, 3);
      assert.equal(d1.chats[0]!.id, "c0");
      assert.equal(d2.chats.length, 3);
      assert.equal(d2.chats[0]!.id, "c3");
      assert.equal(d1.totalCount, 10);
      assert.equal(d2.totalCount, 10);
    });

    it("rehydrates ISO-string dates from a serialized cache entry", async () => {
      const iso = "2026-01-15T10:30:00.000Z";
      cacheControl.getCachedResult = {
        chats: [
          {
            ...makeRow({ id: "c1" }),
            createdAt: iso as unknown as Date,
            updatedAt: iso as unknown as Date,
            lastMessageAt: iso as unknown as Date,
          },
        ],
        totalCount: 1,
      };
      const res = await mod.listChatHistories("u1", { isArchived: false });
      const chat = (res as Ok<{ chats: ChatRecord[] }>).data.chats[0]!;
      assert.ok(chat.createdAt instanceof Date);
      assert.equal(chat.createdAt.toISOString(), iso);
    });
  });

  // ── pagination CLAMP (the pagination-500 bug class) ───────────────────────
  describe("listChatHistories — pagination clamp", () => {
    it("cached path: NaN skip/limit does NOT slice to empty (returns a page)", async () => {
      cacheControl.getCachedResult = {
        chats: Array.from({ length: 10 }, (_, i) => makeRow({ id: `c${i}` })),
        totalCount: 10,
      };
      const res = await mod.listChatHistories("u1", {
        skip: NaN as unknown as number,
        limit: NaN as unknown as number,
      });
      const data = (res as Ok<{ chats: ChatRecord[] }>).data;
      // NaN skip → 0, NaN limit → default(20) capped by list size → all 10.
      assert.equal(data.chats.length, 10);
      assert.equal(data.chats[0]!.id, "c0");
    });

    it("cached path: negative skip is treated as 0 (no wrap-around page)", async () => {
      cacheControl.getCachedResult = {
        chats: Array.from({ length: 5 }, (_, i) => makeRow({ id: `c${i}` })),
        totalCount: 5,
      };
      const res = await mod.listChatHistories("u1", {
        skip: -3 as unknown as number,
        limit: 2,
      });
      const data = (res as Ok<{ chats: ChatRecord[] }>).data;
      assert.equal(data.chats.length, 2);
      assert.equal(data.chats[0]!.id, "c0"); // not c2/c3 from a negative offset
    });

    it("direct path: huge limit is capped to MAX(100) before reaching Prisma", async () => {
      prisma.queue("chatHistory", "count", 1000); // >cap → direct path
      prisma.queue("chatHistory", "findMany", []);
      prisma.queue("chatHistory", "count", 1000);
      await mod.listChatHistories("u1", {
        limit: 99_999_999,
        skip: 0,
      });
      const args = prisma.callsFor("chatHistory", "findMany")[0]!.args as {
        take?: number;
        skip?: number;
      };
      assert.equal(args.take, 100, "take must be clamped to MAX, never huge");
      assert.equal(args.skip, 0);
    });

    it("direct path: NaN skip reaches Prisma as 0 (never a non-Int → no 500)", async () => {
      prisma.queue("chatHistory", "count", 1000);
      prisma.queue("chatHistory", "findMany", []);
      prisma.queue("chatHistory", "count", 1000);
      await mod.listChatHistories("u1", {
        limit: 10,
        skip: NaN as unknown as number,
      });
      const args = prisma.callsFor("chatHistory", "findMany")[0]!.args as {
        take?: number;
        skip?: number;
      };
      assert.equal(args.skip, 0);
      assert.equal(args.take, 10);
      assert.equal(typeof args.skip, "number");
      assert.ok(Number.isInteger(args.skip!));
    });
  });

  // ── derived fields on returned records (logic wired into the live path) ───
  describe("convertToChatHistoryRecord-derived fields", () => {
    it("getChatHistoryById attaches a derived title/preview/summary", async () => {
      prisma.queue("chatHistory", "findFirst", {
        ...makeRow({ id: "c1" }),
        customTitle: null,
        messages: [
          { role: "assistant", content: "Welcome!" },
          { role: "user", content: "What is my P&L this month?" },
          { role: "assistant", content: "It is up." },
        ],
      });
      const res = await mod.getChatHistoryById("u1", "c1");
      const chat = (res as Ok<ChatRecord | null>).data!;
      assert.equal(chat.title, "What is my P&L this month?");
      assert.equal(chat.preview, "What is my P&L this month?");
      assert.deepEqual(chat.messageSummary, {
        total: 3,
        user: 1,
        assistant: 2,
      });
    });

    it("malformed (non-array) messages → title falls back, no crash", async () => {
      prisma.queue("chatHistory", "findFirst", {
        ...makeRow({ id: "c1" }),
        messages: "corrupt-json" as unknown as ChatMessage[],
      });
      const res = await mod.getChatHistoryById("u1", "c1");
      assert.equal(res.success, true);
      const chat = (res as Ok<ChatRecord | null>).data!;
      assert.equal(chat.title, "New conversation");
      assert.deepEqual(chat.messages, []); // narrowed to a clean array
    });
  });

  // ── IDOR: reads ────────────────────────────────────────────────────────────
  describe("getChatHistoryById — read IDOR guard", () => {
    it("scopes findFirst to BOTH id AND userId", async () => {
      prisma.queue("chatHistory", "findFirst", makeRow({ id: "c-42" }));
      await mod.getChatHistoryById("owner-1", "c-42");
      const args = prisma.callsFor("chatHistory", "findFirst")[0]!.args as {
        where: { id: string; userId: string };
      };
      // CRITICAL: a bare { id } would let any user read anyone's chat.
      assert.equal(args.where.id, "c-42");
      assert.equal(args.where.userId, "owner-1");
    });

    it("returns null (not another user's row) when not found for this user", async () => {
      prisma.queue("chatHistory", "findFirst", null);
      const res = await mod.getChatHistoryById("intruder", "victim-chat");
      assert.equal(res.success, true);
      assert.equal((res as Ok<ChatRecord | null>).data, null);
    });

    it("surfaces a sanitized error when the read throws", async () => {
      prisma.fail("chatHistory", "findFirst", new Error("conn refused"));
      const res = await mod.getChatHistoryById("u1", "c1");
      assert.equal(res.success, false);
      assert.equal((res as Err).error, "Failed to get chat history");
    });
  });

  describe("getChatHistoryByPage — read IDOR guard", () => {
    it("scopes findFirst to userId + pagePath (+ isArchived:false by default)", async () => {
      prisma.queue("chatHistory", "findFirst", null);
      await mod.getChatHistoryByPage("owner-2", "/fire");
      const args = prisma.callsFor("chatHistory", "findFirst")[0]!.args as {
        where: { userId: string; pagePath: string; isArchived?: boolean };
      };
      assert.equal(args.where.userId, "owner-2");
      assert.equal(args.where.pagePath, "/fire");
      assert.equal(args.where.isArchived, false);
    });

    it("includeArchived=true drops the isArchived filter", async () => {
      prisma.queue("chatHistory", "findFirst", null);
      await mod.getChatHistoryByPage("owner-2", "/fire", true);
      const args = prisma.callsFor("chatHistory", "findFirst")[0]!.args as {
        where: { isArchived?: boolean };
      };
      assert.equal(args.where.isArchived, undefined);
    });
  });

  // ── IDOR: writes ────────────────────────────────────────────────────────────
  describe("saveChatHistory — write IDOR guard", () => {
    it("UPDATE branch scopes updateMany to BOTH id AND userId", async () => {
      prisma.queue("chatHistory", "updateMany", { count: 1 });
      const res = await mod.saveChatHistory(
        "owner-1",
        "/dashboard",
        "Dashboard",
        undefined,
        [{ role: "user", content: "hi" }],
        "chat-7"
      );
      assert.equal(res.success, true);
      const args = prisma.callsFor("chatHistory", "updateMany")[0]!.args as {
        where: { id: string; userId: string };
      };
      // CRITICAL: a bare { id } would let user A overwrite user B's chat.
      assert.equal(args.where.id, "chat-7");
      assert.equal(args.where.userId, "owner-1");
      assert.deepEqual(cacheControl.clearCalls, ["owner-1"]);
    });

    it("UPDATE on a foreign/missing chat (count 0) → 'not found', no cache bust", async () => {
      prisma.queue("chatHistory", "updateMany", { count: 0 });
      const res = await mod.saveChatHistory(
        "intruder",
        "/dashboard",
        "Dashboard",
        undefined,
        [{ role: "user", content: "steal" }],
        "victim-chat"
      );
      assert.equal(res.success, false);
      assert.equal((res as Err).error, "Chat history not found");
      assert.equal(cacheControl.clearCalls.length, 0);
    });

    it("CREATE branch persists under the caller's userId and busts cache", async () => {
      prisma.queue("chatHistory", "create", { id: "new-1" });
      const res = await mod.saveChatHistory(
        "owner-9",
        "/holdings",
        "Holdings",
        "icon",
        [{ role: "user", content: "what do I hold?" }]
      );
      assert.equal(res.success, true);
      assert.equal((res as Ok<{ chatId: string }>).data.chatId, "new-1");
      const args = prisma.callsFor("chatHistory", "create")[0]!.args as {
        data: { userId: string };
      };
      assert.equal(args.data.userId, "owner-9");
      assert.deepEqual(cacheControl.clearCalls, ["owner-9"]);
    });

    it("no user messages → early success, NO prisma write at all", async () => {
      const res = await mod.saveChatHistory(
        "u1",
        "/dashboard",
        "Dashboard",
        undefined,
        [{ role: "assistant", content: "Welcome!" }]
      );
      assert.equal(res.success, true);
      assert.equal(prisma.callsFor("chatHistory", "create").length, 0);
      assert.equal(prisma.callsFor("chatHistory", "updateMany").length, 0);
    });

    it("surfaces a sanitized error when the write throws", async () => {
      prisma.fail("chatHistory", "create", new Error("E11000 dup"));
      const res = await mod.saveChatHistory(
        "u1",
        "/dashboard",
        "Dashboard",
        undefined,
        [{ role: "user", content: "x" }]
      );
      assert.equal(res.success, false);
      assert.equal((res as Err).error, "Failed to save chat history");
    });
  });

  describe("deleteChatHistory — delete IDOR guard", () => {
    it("scopes deleteMany to BOTH id AND userId, busts cache", async () => {
      prisma.queue("chatHistory", "deleteMany", { count: 1 });
      const res = await mod.deleteChatHistory("owner-1", "chat-9");
      assert.equal(res.success, true);
      const args = prisma.callsFor("chatHistory", "deleteMany")[0]!.args as {
        where: { id: string; userId: string };
      };
      // CRITICAL: a bare { id } would let any user delete anyone's chat.
      assert.equal(args.where.id, "chat-9");
      assert.equal(args.where.userId, "owner-1");
      assert.deepEqual(cacheControl.clearCalls, ["owner-1"]);
    });

    it("deleting a foreign/missing chat (count 0) → 'not found', no cache bust", async () => {
      prisma.queue("chatHistory", "deleteMany", { count: 0 });
      const res = await mod.deleteChatHistory("intruder", "victim-chat");
      assert.equal(res.success, false);
      assert.equal((res as Err).error, "Chat history not found");
      assert.equal(cacheControl.clearCalls.length, 0);
    });

    it("surfaces a sanitized error when the delete throws", async () => {
      prisma.fail("chatHistory", "deleteMany", new Error("boom"));
      const res = await mod.deleteChatHistory("u1", "c1");
      assert.equal(res.success, false);
      assert.equal((res as Err).error, "Failed to delete chat history");
    });
  });

  describe("archive / unarchive / rename — mutation IDOR guard", () => {
    it("archive scopes updateMany to id+userId and sets isArchived:true", async () => {
      prisma.queue("chatHistory", "updateMany", { count: 1 });
      await mod.archiveChatHistory("owner-1", "c-1");
      const args = prisma.callsFor("chatHistory", "updateMany")[0]!.args as {
        where: { id: string; userId: string };
        data: { isArchived: boolean };
      };
      assert.equal(args.where.id, "c-1");
      assert.equal(args.where.userId, "owner-1");
      assert.equal(args.data.isArchived, true);
    });

    it("unarchive scopes updateMany to id+userId and sets isArchived:false", async () => {
      prisma.queue("chatHistory", "updateMany", { count: 1 });
      await mod.unarchiveChatHistory("owner-1", "c-1");
      const args = prisma.callsFor("chatHistory", "updateMany")[0]!.args as {
        where: { id: string; userId: string };
        data: { isArchived: boolean };
      };
      assert.equal(args.where.userId, "owner-1");
      assert.equal(args.data.isArchived, false);
    });

    it("rename scopes updateMany to id+userId; blank title clears to null", async () => {
      prisma.queue("chatHistory", "updateMany", { count: 1 });
      await mod.renameChatHistory("owner-1", "c-1", "   ");
      const args = prisma.callsFor("chatHistory", "updateMany")[0]!.args as {
        where: { id: string; userId: string };
        data: { customTitle: string | null };
      };
      assert.equal(args.where.userId, "owner-1");
      assert.equal(args.data.customTitle, null); // whitespace-only → cleared
    });

    it("rename trims and stores a non-blank title", async () => {
      prisma.queue("chatHistory", "updateMany", { count: 1 });
      await mod.renameChatHistory("owner-1", "c-1", "  My Title  ");
      const args = prisma.callsFor("chatHistory", "updateMany")[0]!.args as {
        data: { customTitle: string | null };
      };
      assert.equal(args.data.customTitle, "My Title");
    });

    it("archive of a foreign/missing chat (count 0) → 'not found'", async () => {
      prisma.queue("chatHistory", "updateMany", { count: 0 });
      const res = await mod.archiveChatHistory("intruder", "victim");
      assert.equal(res.success, false);
      assert.equal((res as Err).error, "Chat history not found");
    });
  });

  // ── error resilience: list stays bell-safe ────────────────────────────────
  describe("listChatHistories — error resilience", () => {
    it("returns success + EMPTY on a DB outage (never throws to the caller)", async () => {
      prisma.fail("chatHistory", "count", new Error("ns not found"));
      const res = await mod.listChatHistories("u1", { isArchived: false });
      assert.equal(res.success, true);
      assert.deepEqual(
        (res as Ok<{ chats: ChatRecord[]; totalCount: number }>).data,
        { chats: [], totalCount: 0 }
      );
    });

    it("malformed chatId (empty string) still scopes the query by userId", async () => {
      prisma.queue("chatHistory", "findFirst", null);
      const res = await mod.getChatHistoryById("u1", "");
      assert.equal(res.success, true);
      const args = prisma.callsFor("chatHistory", "findFirst")[0]!.args as {
        where: { id: string; userId: string };
      };
      assert.equal(args.where.id, "");
      assert.equal(args.where.userId, "u1");
    });

    it("empty chat list: cache hit with zero rows returns empty + totalCount 0", async () => {
      cacheControl.getCachedResult = { chats: [], totalCount: 0 };
      const res = await mod.listChatHistories("u1", { isArchived: false });
      const data = (res as Ok<{ chats: ChatRecord[]; totalCount: number }>)
        .data;
      assert.deepEqual(data.chats, []);
      assert.equal(data.totalCount, 0);
    });
  });
});
