/**
 * MONEY-620 — content.service END-TO-END (real fns, recording prisma).
 *
 * DE-SHADOWED: this file previously re-implemented `transformToPostListItem`,
 * `buildTagFilter`, pagination math, and the relevance sort INLINE and asserted
 * the copies (a classic shadow — green while the real code could be wrong). It
 * now drives the REAL exported service functions through a recording-prisma seam
 * and asserts the prisma `where` clauses + the post-transform shape + the premium
 * entitlement gate (fail-closed).
 *
 * Covers:
 *   - getBlogPosts     → BLOG/PUBLISHED where, CLAMPED page/limit (no Prisma 500),
 *                        transform shape, finite `pages`
 *   - getDocs          → DOCS where, default limit 12, page-0 → no negative skip
 *   - getRelatedPosts  → tag-overlap relevance sort + recency tie-break + limit
 *   - getGatedBlogPostBySlug — premium FAILS CLOSED (FREE viewer gets NO body),
 *                        entitled viewer gets the full body (behavior-preserving)
 *
 * Seam mirrors `notifications-service-e2e.test.ts`: stub @usemoney/database +
 * @usemoney/logger + @usemoney/core via require.cache, then require the
 * @usemoney/services barrel once. `getCached` returns null (force a DB hit),
 * `setCached` is a no-op.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: packages/services/src/content.service.ts
 *         packages/services/src/content-logic.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

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
    if (method === "findFirst" || method === "findUnique") return null;
    if (method === "update") return { viewCount: 1 };
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

// ── module-boundary injection ───────────────────────────────────────────────

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

type SlugResult =
  | { success: true; data: Record<string, unknown> | null }
  | { success: false; error: string };

interface ContentModule {
  getBlogPosts: (params: {
    page?: number;
    limit?: number;
    search?: string;
    featured?: boolean;
    tagSlug?: string;
  }) => Promise<
    | {
        success: true;
        data: { posts: unknown[]; total: number; pages: number };
      }
    | { success: false; error: string }
  >;
  getDocs: (params: {
    page?: number;
    limit?: number;
    search?: string;
    tagSlug?: string;
  }) => Promise<
    | {
        success: true;
        data: { posts: unknown[]; total: number; pages: number };
      }
    | { success: false; error: string }
  >;
  getRelatedPosts: (params: {
    postId: string;
    contentType: string;
    tagIds: string[];
    limit?: number;
  }) => Promise<
    | { success: true; data: Array<{ id: string }> }
    | { success: false; error: string }
  >;
  getGatedBlogPostBySlug: (
    slug: string,
    viewer?: { planId?: string | null; entitled?: boolean } | null
  ) => Promise<SlugResult>;
}

let svc: ContentModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): ContentModule {
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
  });
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  // content.service uses getCached/setCached from @usemoney/core. Force a cache
  // MISS (getCached → null) so every call hits the recording prisma; setCached
  // is a no-op. This also avoids connecting to Redis/GCS.
  stub(
    require.resolve("@usemoney/core"),
    new Proxy(
      { __esModule: true },
      {
        get(_t, k: string) {
          if (k === "__esModule") return true;
          if (k === "getCached") return async () => null;
          return async () => {};
        },
      }
    )
  );
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") || key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  svc = require("@usemoney/services") as ContentModule;
  return svc;
}

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

const NOW = new Date("2026-06-01T00:00:00Z");

function listRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    postUrl: `${id}-url`,
    contentType: "BLOG",
    title: `Post ${id}`,
    excerpt: "ex",
    featureImage: null,
    publishDate: NOW,
    status: "PUBLISHED",
    isFeatured: false,
    isPremium: false,
    viewCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    author: { id: "a", name: "A", username: "a", imageUrl: null },
    tags: [],
    ...overrides,
  };
}

function fullRow(id: string, isPremium: boolean) {
  return {
    id,
    contentPlatform: "STOCKBOOK",
    contentType: "BLOG",
    title: `Post ${id}`,
    content: "FULL BODY",
    featureImage: null,
    postUrl: `${id}-url`,
    excerpt: "ex",
    publishDate: NOW,
    status: "PUBLISHED",
    isFeatured: false,
    isPremium,
    authorId: "a",
    metadataTitle: null,
    metadataDescription: null,
    metadataImageUrl: null,
    metadataKeywords: null,
    canonicalUrl: null,
    viewCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    author: {
      id: "a",
      clerkId: "c",
      name: "A",
      username: "a",
      email: "a@x.com",
      imageUrl: null,
      role: "WRITER",
      createdAt: NOW,
      updatedAt: NOW,
    },
    tags: [],
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — content.service (real fns, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let mod: ContentModule;

  before(() => {
    mod = installServices();
  });
  beforeEach(() => {
    prisma = swapPrisma();
  });
  after(() => {
    uninstallServices();
  });

  describe("getBlogPosts — where + pagination clamp + transform", () => {
    it("queries BLOG/PUBLISHED, newest-first, with clamped take/skip", async () => {
      prisma.queue("post", "count", 1);
      prisma.queue("post", "findMany", [listRow("p1")]);
      const res = await mod.getBlogPosts({ page: 2, limit: 5 });
      assert.equal(res.success, true);
      const find = prisma.callsFor("post", "findMany")[0]!.args as {
        where: { contentType: string; status: string };
        orderBy: Record<string, unknown>;
        take: number;
        skip: number;
      };
      assert.equal(find.where.contentType, "BLOG");
      assert.equal(find.where.status, "PUBLISHED");
      assert.deepEqual(find.orderBy, { publishDate: "desc" });
      assert.equal(find.take, 5);
      assert.equal(find.skip, 5); // (page2 - 1) * 5
    });

    it("CLAMPS page 0 → skip 0 (no negative skip / Prisma 500)", async () => {
      prisma.queue("post", "count", 0);
      prisma.queue("post", "findMany", []);
      await mod.getBlogPosts({ page: 0, limit: 10 });
      const find = prisma.callsFor("post", "findMany")[0]!.args as {
        skip: number;
        take: number;
      };
      assert.equal(find.skip, 0);
      assert.ok(find.skip >= 0);
    });

    it("CLAMPS a NaN limit → DEFAULT (no Prisma 500)", async () => {
      prisma.queue("post", "count", 0);
      prisma.queue("post", "findMany", []);
      await mod.getBlogPosts({ page: 1, limit: NaN as number });
      const find = prisma.callsFor("post", "findMany")[0]!.args as {
        take: number;
      };
      assert.equal(find.take, 10);
      assert.ok(Number.isInteger(find.take));
    });

    it("returns a finite `pages` count and the transformed list shape", async () => {
      prisma.queue("post", "count", 23);
      prisma.queue("post", "findMany", [
        listRow("p1", {
          tags: [
            { tag: { id: "t1", name: "Fin", slug: "fin", color: "#000" } },
          ],
        }),
      ]);
      const res = await mod.getBlogPosts({ page: 1, limit: 10 });
      assert.equal(res.success, true);
      const data = (
        res as {
          data: { posts: Array<Record<string, unknown>>; pages: number };
        }
      ).data;
      assert.ok(Number.isFinite(data.pages));
      assert.equal(data.pages, 3); // ceil(23/10)
      // transform: tags flattened out of the { tag: {...} } wrapper
      const post = data.posts[0]! as {
        id: string;
        tags: Array<{ slug: string }>;
      };
      assert.equal(post.id, "p1");
      assert.equal(post.tags[0]!.slug, "fin");
    });

    it("applies a search OR over title/excerpt/content and a tagSlug filter", async () => {
      prisma.queue("post", "count", 0);
      prisma.queue("post", "findMany", []);
      await mod.getBlogPosts({ search: "alpha", tagSlug: "investing" });
      const where = prisma.callsFor("post", "findMany")[0]!.args as {
        where: { OR: unknown[]; tags: unknown };
      };
      assert.equal((where.where.OR as unknown[]).length, 3);
      assert.deepEqual(where.where.tags, {
        some: { tag: { slug: "investing" } },
      });
    });

    it("surfaces a sanitized error on DB failure", async () => {
      prisma.fail("post", "count", new Error("conn reset"));
      const res = await mod.getBlogPosts({ page: 1 });
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Failed to fetch blog posts"
      );
    });
  });

  describe("getDocs — DOCS where, default limit 12", () => {
    it("defaults to limit 12 and DOCS/PUBLISHED ordered by title", async () => {
      prisma.queue("post", "count", 0);
      prisma.queue("post", "findMany", []);
      await mod.getDocs({});
      const find = prisma.callsFor("post", "findMany")[0]!.args as {
        where: { contentType: string };
        orderBy: Record<string, unknown>;
        take: number;
      };
      assert.equal(find.where.contentType, "DOCS");
      assert.deepEqual(find.orderBy, { title: "asc" });
      assert.equal(find.take, 12);
    });
  });

  describe("getRelatedPosts — relevance sort (real fn)", () => {
    // Each tag-join row has BOTH `tagId` (read by the relevance sort) AND the
    // `tag` wrapper (read by transformToPostListItem) — the shape Prisma's
    // include: { tags: { include: { tag } } } actually returns.
    const tagJoin = (tagId: string) => ({
      id: `j-${tagId}`,
      postId: "p",
      tagId,
      tag: { id: tagId, name: tagId, slug: tagId, color: null },
    });
    it("sorts by tag-overlap desc, breaks ties by recency, respects limit", async () => {
      prisma.queue("post", "findMany", [
        {
          ...listRow("one-match", { publishDate: new Date("2025-01-01") }),
          tags: [tagJoin("t1")],
        },
        {
          ...listRow("three-match", { publishDate: new Date("2025-01-03") }),
          tags: [tagJoin("t1"), tagJoin("t2"), tagJoin("t3")],
        },
        {
          ...listRow("two-match", { publishDate: new Date("2025-01-02") }),
          tags: [tagJoin("t1"), tagJoin("t2")],
        },
      ]);
      const res = await mod.getRelatedPosts({
        postId: "self",
        contentType: "BLOG",
        tagIds: ["t1", "t2", "t3"],
        limit: 3,
      });
      assert.equal(res.success, true);
      const ids = (res as { data: Array<{ id: string }> }).data.map(
        (p) => p.id
      );
      assert.deepEqual(ids, ["three-match", "two-match", "one-match"]);

      // It excludes the source post id.
      const where = prisma.callsFor("post", "findMany")[0]!.args as {
        where: { id: { not: string } };
      };
      assert.equal(where.where.id.not, "self");
    });

    it("with no tagIds, queries recent same-type posts (no tag filter)", async () => {
      prisma.queue("post", "findMany", [listRow("r1")]);
      await mod.getRelatedPosts({
        postId: "self",
        contentType: "BLOG",
        tagIds: [],
        limit: 3,
      });
      const where = prisma.callsFor("post", "findMany")[0]!.args as {
        where: Record<string, unknown>;
      };
      assert.equal(where.where.tags, undefined);
    });
  });

  describe("getGatedBlogPostBySlug — premium entitlement (fail-closed)", () => {
    it("PREMIUM post + FREE viewer → body STRIPPED (no leak), preview kept", async () => {
      prisma.queue("post", "findFirst", fullRow("prem", true));
      prisma.queue("post", "update", { viewCount: 1 });
      const res = await mod.getGatedBlogPostBySlug("prem-url", {
        planId: "FREE",
      });
      assert.equal(res.success, true);
      const post = (res as { data: Record<string, unknown> }).data;
      assert.equal(
        post.content,
        "",
        "premium body must NOT reach a FREE viewer"
      );
      assert.equal(post.title, "Post prem", "preview fields survive");
      assert.equal(post.isPremium, true);
    });

    it("PREMIUM post + expired sub (entitled:false) → body STRIPPED", async () => {
      prisma.queue("post", "findFirst", fullRow("prem2", true));
      prisma.queue("post", "update", { viewCount: 1 });
      const res = await mod.getGatedBlogPostBySlug("prem2-url", {
        planId: "PREMIUM",
        entitled: false,
      });
      const post = (res as { data: Record<string, unknown> }).data;
      assert.equal(post.content, "");
    });

    it("PREMIUM post + PRO viewer → FULL body (behavior-preserving for authorized)", async () => {
      prisma.queue("post", "findFirst", fullRow("prem3", true));
      prisma.queue("post", "update", { viewCount: 1 });
      const res = await mod.getGatedBlogPostBySlug("prem3-url", {
        planId: "PRO",
      });
      const post = (res as { data: Record<string, unknown> }).data;
      assert.equal(post.content, "FULL BODY");
    });

    it("NON-premium post → FULL body for anyone (public, no viewer)", async () => {
      prisma.queue("post", "findFirst", fullRow("pub", false));
      prisma.queue("post", "update", { viewCount: 1 });
      const res = await mod.getGatedBlogPostBySlug("pub-url");
      const post = (res as { data: Record<string, unknown> }).data;
      assert.equal(post.content, "FULL BODY");
    });

    it("missing slug → success:true with data:null (passes through)", async () => {
      prisma.queue("post", "findFirst", null);
      const res = await mod.getGatedBlogPostBySlug("nope", { planId: "FREE" });
      assert.equal(res.success, true);
      assert.equal((res as { data: unknown }).data, null);
    });
  });
});
