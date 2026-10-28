/**
 * MONEY-620 — content server actions END-TO-END (real action handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a textbook SHADOW. Under a "// LOGIC FUNCTIONS
 * (mirrors content.ts)" banner it re-declared `calculatePagination`,
 * `calculateTotalPages`, `transformToPostListItem`, `buildSearchClause`,
 * `buildTagFilter`, `sortByTagRelevance`, `shouldIncrementViewCount`,
 * `sortGlossaryAlpha`, and `filterPublishedByType` — then asserted the COPIES.
 * It imported NOTHING from `lib/actions/content.ts`. Several of those copies
 * weren't even real action logic (the action delegates relevance sorting +
 * publish filtering to the SERVICE), so the shadow asserted code that does not
 * exist in the action at all.
 *
 * This rewrite drives the REAL exported actions from `lib/actions/content.ts`
 * through a `require.cache` seam, and asserts the action's OWN load-bearing
 * behaviour:
 *
 *   - Atlas fast-path vs. service fallback: when `searchContentAtlas` returns
 *     results, the action uses them (and the service is NEVER called); when it
 *     returns `null` (Atlas unavailable / non-Atlas DB), the action FALLS THROUGH
 *     to the service — the dual-path contract the screener/content search depends
 *     on across prod (Atlas) vs QA (regex/service).
 *   - `atlasResultsToPostListItems`: PRESERVES Atlas relevance ordering and DROPS
 *     ids the DB fetch didn't return (deleted-between-index-and-read) — proven by
 *     a recording prisma whose `post.findMany` returns rows out of order.
 *   - Atlas-path pagination: slices the fetched window by (page,limit) and
 *     reports `pages = ceil(total/limit)`.
 *   - Cache HIT short-circuits BOTH Atlas and the service (no double work, no
 *     stale recompute).
 *   - GRACEFUL DEGRADE: every action swallows a thrown dependency and returns its
 *     empty/fallback shape ([] or {posts:[],total:0,pages:0} or null) — a content
 *     page must never 500 because the service threw (the never-dead-end contract).
 *   - Search routing: a tagSlug/featured query SKIPS Atlas (Atlas can't filter by
 *     tag) and uses the service directly.
 *
 * `@usemoney/types` is value-free (types only). The service, Atlas search, cache
 * wrapper, and prisma are recorded stubs so we assert what the action ROUTES to.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/content.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recorders ───────────────────────────────────────────────────────────────

interface AtlasCall {
  query: string;
  options: { contentType?: string; limit?: number };
}
interface ServiceCall {
  fn: string;
  args: unknown[];
}
interface PrismaFindCall {
  args: unknown;
}
interface CacheGetCall {
  module: string;
  scope: string;
  id: string;
  params: unknown;
}
interface CacheSetCall {
  module: string;
  scope: string;
  id: string;
  value: unknown;
}

interface Harness {
  atlasCalls: AtlasCall[];
  /** Atlas result for the next call: `null` ⇒ Atlas unavailable (fall through). */
  atlasResult: unknown;
  serviceCalls: ServiceCall[];
  serviceReturns: Record<string, unknown>;
  /** Per-fn forced throw (graceful-degrade probe). */
  serviceThrows: Record<string, Error>;
  prismaFindCalls: PrismaFindCall[];
  /** Rows `prisma.post.findMany` returns (in whatever order we choose). */
  prismaPosts: Array<Record<string, unknown>>;
  cacheGetCalls: CacheGetCall[];
  cacheSetCalls: CacheSetCall[];
  /** When set, the next getCached returns this (a cache HIT). */
  cacheHit?: unknown;
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

// Snapshot the cache entries we overwrite (captured ONCE) so the original modules
// are restored in `after()`. Without this our stubs for `@usemoney/services` /
// `@/lib/prisma` / `@/lib/cache/wrapper` / `@/lib/market/content-search` would leak
// into sibling suites that load REAL versions later in the SAME process.
const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}
function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  // Drop the action module so a later importer re-binds it to the REAL deps.
  delete cache[require.resolve(ACTION_REL)];
}

function freshHarness(): Harness {
  return {
    atlasCalls: [],
    atlasResult: null,
    serviceCalls: [],
    serviceReturns: {},
    serviceThrows: {},
    prismaFindCalls: [],
    prismaPosts: [],
    cacheGetCalls: [],
    cacheSetCalls: [],
  };
}

// A full Prisma-shaped post row (the include shape `atlasResultsToPostListItems`
// selects: author + tags[{tag}]). Only the fields the transform reads matter.
function postRow(
  id: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    postUrl: `slug-${id}`,
    contentType: "BLOG",
    title: `Post ${id}`,
    excerpt: null,
    featureImage: null,
    publishDate: new Date("2025-06-01"),
    status: "PUBLISHED",
    isFeatured: false,
    isPremium: false,
    viewCount: 0,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    author: { id: "a1", name: "Author", username: "author", imageUrl: null },
    tags: [],
    ...over,
  };
}

// An AtlasContentResult (the action maps `_id.$oid` → DB id ordering).
function atlasHit(id: string, score: number): Record<string, unknown> {
  return {
    _id: { $oid: id },
    title: `Post ${id}`,
    excerpt: null,
    postUrl: `slug-${id}`,
    contentType: "BLOG",
    featureImage: null,
    publishDate: null,
    score,
  };
}

interface ContentActionModule {
  getBlogPostsAction: (params: {
    page?: number;
    limit?: number;
    search?: string;
    featured?: boolean;
    tagSlug?: string;
  }) => Promise<{ posts: Array<{ id: string }>; total: number; pages: number }>;
  getGlossaryTermsAction: (search?: string) => Promise<Array<{ id: string }>>;
  getDocsAction: (params: {
    page?: number;
    limit?: number;
    search?: string;
    tagSlug?: string;
  }) => Promise<{ posts: Array<{ id: string }>; total: number; pages: number }>;
  getNewslettersAction: (params: {
    page?: number;
    limit?: number;
    tagSlug?: string;
  }) => Promise<{ posts: unknown[]; total: number; pages: number }>;
  getRelatedPostsAction: (params: {
    postId: string;
    contentType: "BLOG" | "GLOSSARY" | "NEWSLETTER";
    tagIds: string[];
    limit?: number;
  }) => Promise<unknown[]>;
  getFeaturedBlogPostsAction: (limit?: number) => Promise<unknown[]>;
  getBlogPostBySlugAction: (slug: string) => Promise<unknown | null>;
  getTagsAction: () => Promise<unknown[]>;
  getTagBySlugAction: (slug: string) => Promise<unknown | null>;
  getGlossaryTermsForHelpAction: () => Promise<unknown[]>;
}

const ACTION_REL = "../../lib/actions/content";

function loadAction(h: Harness): ContentActionModule {
  const cache = moduleCache();

  const prismaPath = require.resolve("../../lib/prisma");
  const cachePath = require.resolve("../../lib/cache/wrapper");
  const searchPath = require.resolve("../../lib/market/content-search");
  const servicesPath = require.resolve("@usemoney/services");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [prismaPath, cachePath, searchPath, servicesPath]) {
    snapshotOnce(p);
  }

  const prismaStub = {
    post: {
      findMany: (args: unknown) => {
        h.prismaFindCalls.push({ args });
        return Promise.resolve(h.prismaPosts);
      },
    },
  };
  cache[prismaPath] = {
    exports: { __esModule: true, prisma: prismaStub, default: prismaStub },
  };

  cache[cachePath] = {
    exports: {
      __esModule: true,
      getCached: (
        module: string,
        scope: string,
        id: string,
        params: unknown
      ) => {
        h.cacheGetCalls.push({ module, scope, id, params });
        const hit = h.cacheHit;
        h.cacheHit = undefined;
        return Promise.resolve(hit ?? null);
      },
      setCached: (
        module: string,
        scope: string,
        id: string,
        value: unknown
      ) => {
        h.cacheSetCalls.push({ module, scope, id, value });
        return Promise.resolve();
      },
    },
  };

  cache[searchPath] = {
    exports: {
      __esModule: true,
      searchContentAtlas: (
        query: string,
        options: { contentType?: string; limit?: number } = {}
      ) => {
        h.atlasCalls.push({ query, options });
        return Promise.resolve(h.atlasResult);
      },
    },
  };

  const svcFn =
    (name: string) =>
    (...args: unknown[]) => {
      const err = h.serviceThrows[name];
      if (err) return Promise.reject(err);
      h.serviceCalls.push({ fn: name, args });
      return Promise.resolve(h.serviceReturns[name] ?? { success: false });
    };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getBlogPosts: svcFn("getBlogPosts"),
      getBlogPostBySlug: svcFn("getBlogPostBySlug"),
      getFeaturedBlogPosts: svcFn("getFeaturedBlogPosts"),
      getLatestBlogPosts: svcFn("getLatestBlogPosts"),
      getGlossaryPosts: svcFn("getGlossaryPosts"),
      getGlossaryPostBySlug: svcFn("getGlossaryPostBySlug"),
      getGlossaryTermsForHelp: svcFn("getGlossaryTermsForHelp"),
      getNewsletters: svcFn("getNewsletters"),
      getNewsletterBySlug: svcFn("getNewsletterBySlug"),
      getDocs: svcFn("getDocs"),
      getDocBySlug: svcFn("getDocBySlug"),
      getTags: svcFn("getTags"),
      getTagBySlug: svcFn("getTagBySlug"),
      getRelatedPosts: svcFn("getRelatedPosts"),
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ContentActionModule;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — content actions (real handlers, Atlas/service routing)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  // Restore the real module cache so our stubs never leak into a sibling suite
  // running later under the full `node --test __tests__/**` glob (single process).
  after(() => {
    restoreCache();
  });

  // ── getBlogPostsAction: Atlas fast-path vs service fallback ──────────────
  describe("getBlogPostsAction", () => {
    it("uses Atlas results when available and does NOT call the service", async () => {
      h.atlasResult = [atlasHit("p1", 9), atlasHit("p2", 8)];
      h.prismaPosts = [postRow("p1"), postRow("p2")];
      const action = loadAction(h);
      const res = await action.getBlogPostsAction({ search: "investing" });
      assert.equal(res.total, 2);
      assert.equal(res.posts.length, 2);
      // Atlas was consulted with the BLOG contentType.
      assert.equal(h.atlasCalls.length, 1);
      assert.equal(h.atlasCalls[0]!.options.contentType, "BLOG");
      // The Prisma service was NOT used (Atlas short-circuits it).
      assert.equal(
        h.serviceCalls.some((c) => c.fn === "getBlogPosts"),
        false
      );
    });

    it("PRESERVES Atlas relevance order even when prisma returns rows reordered", async () => {
      h.atlasResult = [atlasHit("p2", 9), atlasHit("p1", 8)]; // p2 ranks first
      // DB returns them in the OPPOSITE order — the action must re-order to Atlas.
      h.prismaPosts = [postRow("p1"), postRow("p2")];
      const action = loadAction(h);
      const res = await action.getBlogPostsAction({ search: "x" });
      assert.deepEqual(
        res.posts.map((p) => p.id),
        ["p2", "p1"],
        "must follow Atlas score order, not DB order"
      );
    });

    it("DROPS an Atlas id the DB fetch no longer returns (deleted-between-read)", async () => {
      h.atlasResult = [atlasHit("p1", 9), atlasHit("ghost", 8)];
      h.prismaPosts = [postRow("p1")]; // 'ghost' was deleted after indexing
      const action = loadAction(h);
      const res = await action.getBlogPostsAction({ search: "x" });
      assert.deepEqual(
        res.posts.map((p) => p.id),
        ["p1"]
      );
      assert.equal(res.total, 1);
    });

    it("falls through to the SERVICE when Atlas is unavailable (null)", async () => {
      h.atlasResult = null; // Atlas index missing / non-Atlas DB
      h.serviceReturns.getBlogPosts = {
        success: true,
        data: { posts: [{ id: "svc-1" }], total: 1, pages: 1 },
      };
      const action = loadAction(h);
      const res = await action.getBlogPostsAction({ search: "x" });
      assert.equal(h.atlasCalls.length, 1, "Atlas was attempted");
      const call = h.serviceCalls.find((c) => c.fn === "getBlogPosts");
      assert.ok(call, "service is the fallback");
      assert.equal(res.posts[0]!.id, "svc-1");
    });

    it("a tagSlug query SKIPS Atlas (Atlas can't filter by tag) → service", async () => {
      h.serviceReturns.getBlogPosts = {
        success: true,
        data: { posts: [{ id: "tagged" }], total: 1, pages: 1 },
      };
      const action = loadAction(h);
      await action.getBlogPostsAction({ search: "x", tagSlug: "finance" });
      assert.equal(h.atlasCalls.length, 0, "tag filter must bypass Atlas");
      assert.ok(h.serviceCalls.find((c) => c.fn === "getBlogPosts"));
    });

    it("a featured query SKIPS Atlas → service", async () => {
      h.serviceReturns.getBlogPosts = {
        success: true,
        data: { posts: [], total: 0, pages: 0 },
      };
      const action = loadAction(h);
      await action.getBlogPostsAction({ search: "x", featured: true });
      assert.equal(h.atlasCalls.length, 0);
      assert.ok(h.serviceCalls.find((c) => c.fn === "getBlogPosts"));
    });

    it("Atlas path paginates: page 2 / limit 2 slices the fetched window", async () => {
      h.atlasResult = [
        atlasHit("p1", 9),
        atlasHit("p2", 8),
        atlasHit("p3", 7),
        atlasHit("p4", 6),
        atlasHit("p5", 5),
      ];
      h.prismaPosts = ["p1", "p2", "p3", "p4", "p5"].map((id) => postRow(id));
      const action = loadAction(h);
      const res = await action.getBlogPostsAction({
        search: "x",
        page: 2,
        limit: 2,
      });
      // total=5, page 2 of 2 → ids p3,p4 ; pages = ceil(5/2)=3.
      assert.deepEqual(
        res.posts.map((p) => p.id),
        ["p3", "p4"]
      );
      assert.equal(res.total, 5);
      assert.equal(res.pages, 3);
    });

    it("a cache HIT short-circuits BOTH Atlas and the service", async () => {
      h.cacheHit = { posts: [{ id: "cached" }], total: 1, pages: 1 };
      const action = loadAction(h);
      const res = await action.getBlogPostsAction({ search: "x" });
      assert.equal(res.posts[0]!.id, "cached");
      assert.equal(h.atlasCalls.length, 0, "cache hit must not hit Atlas");
      assert.equal(
        h.serviceCalls.length,
        0,
        "cache hit must not hit the service"
      );
    });

    it("GRACEFUL DEGRADE: a service throw yields the empty shape, never a 500", async () => {
      h.atlasResult = null;
      h.serviceThrows.getBlogPosts = new Error("prisma exploded");
      const action = loadAction(h);
      let res!: { posts: unknown[]; total: number; pages: number };
      await assert.doesNotReject(async () => {
        res = await action.getBlogPostsAction({ search: "x" });
      });
      assert.deepEqual(res, { posts: [], total: 0, pages: 0 });
    });

    it("a service {success:false} also degrades to the empty shape", async () => {
      h.atlasResult = null;
      h.serviceReturns.getBlogPosts = { success: false, error: "boom" };
      const action = loadAction(h);
      const res = await action.getBlogPostsAction({ search: "x" });
      assert.deepEqual(res, { posts: [], total: 0, pages: 0 });
    });

    it("a browse (no search) goes straight to the service (no Atlas)", async () => {
      h.serviceReturns.getBlogPosts = {
        success: true,
        data: { posts: [{ id: "b" }], total: 1, pages: 1 },
      };
      const action = loadAction(h);
      await action.getBlogPostsAction({ page: 1, limit: 10 });
      assert.equal(
        h.atlasCalls.length,
        0,
        "browse has no text query → no Atlas"
      );
      assert.ok(h.serviceCalls.find((c) => c.fn === "getBlogPosts"));
    });
  });

  // ── getGlossaryTermsAction ──────────────────────────────────────────────
  describe("getGlossaryTermsAction", () => {
    it("uses Atlas results (GLOSSARY) and skips the service", async () => {
      h.atlasResult = [atlasHit("g1", 9)];
      h.prismaPosts = [postRow("g1", { contentType: "GLOSSARY" })];
      const action = loadAction(h);
      const res = await action.getGlossaryTermsAction("delta");
      assert.equal(res.length, 1);
      assert.equal(res[0]!.id, "g1");
      assert.equal(h.atlasCalls[0]!.options.contentType, "GLOSSARY");
      assert.equal(
        h.serviceCalls.some((c) => c.fn === "getGlossaryPosts"),
        false
      );
    });

    it("falls through to the service when Atlas is null", async () => {
      h.atlasResult = null;
      h.serviceReturns.getGlossaryPosts = {
        success: true,
        data: [{ id: "svc-g" }],
      };
      const action = loadAction(h);
      const res = await action.getGlossaryTermsAction("delta");
      assert.equal(res[0]!.id, "svc-g");
    });

    it("no-search browse skips Atlas and uses the service", async () => {
      h.serviceReturns.getGlossaryPosts = {
        success: true,
        data: [{ id: "all-g" }],
      };
      const action = loadAction(h);
      const res = await action.getGlossaryTermsAction();
      assert.equal(h.atlasCalls.length, 0);
      assert.equal(res[0]!.id, "all-g");
    });

    it("GRACEFUL DEGRADE: a service throw → empty array", async () => {
      h.serviceThrows.getGlossaryPosts = new Error("db down");
      const action = loadAction(h);
      let res!: unknown[];
      await assert.doesNotReject(async () => {
        res = await action.getGlossaryTermsAction();
      });
      assert.deepEqual(res, []);
    });
  });

  // ── getDocsAction ───────────────────────────────────────────────────────
  describe("getDocsAction", () => {
    it("uses Atlas (DOCS) results and slices for pagination", async () => {
      h.atlasResult = [atlasHit("d1", 9), atlasHit("d2", 8), atlasHit("d3", 7)];
      h.prismaPosts = ["d1", "d2", "d3"].map((id) =>
        postRow(id, { contentType: "DOCS" })
      );
      const action = loadAction(h);
      const res = await action.getDocsAction({
        search: "x",
        page: 1,
        limit: 2,
      });
      assert.equal(h.atlasCalls[0]!.options.contentType, "DOCS");
      assert.deepEqual(
        res.posts.map((p) => p.id),
        ["d1", "d2"]
      );
      assert.equal(res.total, 3);
      assert.equal(res.pages, 2); // ceil(3/2)
    });

    it("tagSlug bypasses Atlas → service", async () => {
      h.serviceReturns.getDocs = {
        success: true,
        data: { posts: [{ id: "svc-d" }], total: 1, pages: 1 },
      };
      const action = loadAction(h);
      await action.getDocsAction({ search: "x", tagSlug: "guide" });
      assert.equal(h.atlasCalls.length, 0);
      assert.ok(h.serviceCalls.find((c) => c.fn === "getDocs"));
    });

    it("GRACEFUL DEGRADE on service throw → empty shape", async () => {
      h.atlasResult = null;
      h.serviceThrows.getDocs = new Error("nope");
      const action = loadAction(h);
      const res = await action.getDocsAction({ search: "x" });
      assert.deepEqual(res, { posts: [], total: 0, pages: 0 });
    });
  });

  // ── delegating actions: forward + unwrap + degrade ──────────────────────
  describe("delegating read actions (forward args, unwrap, degrade)", () => {
    it("getNewslettersAction forwards params and unwraps service data", async () => {
      h.serviceReturns.getNewsletters = {
        success: true,
        data: { posts: [{ id: "n1" }], total: 1, pages: 1 },
      };
      const action = loadAction(h);
      const res = await action.getNewslettersAction({ page: 2, limit: 5 });
      const call = h.serviceCalls.find((c) => c.fn === "getNewsletters");
      assert.deepEqual(call!.args[0], { page: 2, limit: 5 });
      assert.equal(res.total, 1);
    });

    it("getNewslettersAction degrades to empty shape on a service throw", async () => {
      h.serviceThrows.getNewsletters = new Error("x");
      const action = loadAction(h);
      const res = await action.getNewslettersAction({ page: 1 });
      assert.deepEqual(res, { posts: [], total: 0, pages: 0 });
    });

    it("getRelatedPostsAction forwards the whole params object + degrades to []", async () => {
      h.serviceReturns.getRelatedPosts = {
        success: true,
        data: [{ id: "r1" }],
      };
      const action = loadAction(h);
      const ok = await action.getRelatedPostsAction({
        postId: "p1",
        contentType: "BLOG",
        tagIds: ["t1", "t2"],
        limit: 3,
      });
      const call = h.serviceCalls.find((c) => c.fn === "getRelatedPosts");
      assert.deepEqual(call!.args[0], {
        postId: "p1",
        contentType: "BLOG",
        tagIds: ["t1", "t2"],
        limit: 3,
      });
      assert.equal((ok[0] as { id: string }).id, "r1");

      // degrade
      h.serviceThrows.getRelatedPosts = new Error("boom");
      const action2 = loadAction(h);
      const res = await action2.getRelatedPostsAction({
        postId: "p1",
        contentType: "BLOG",
        tagIds: [],
      });
      assert.deepEqual(res, []);
    });

    it("getBlogPostBySlugAction returns the post on success, null on failure", async () => {
      h.serviceReturns.getBlogPostBySlug = {
        success: true,
        data: { id: "post", postUrl: "slug" },
      };
      const action = loadAction(h);
      const found = await action.getBlogPostBySlugAction("slug");
      assert.equal((found as { id: string }).id, "post");

      // failure → null
      h.serviceReturns.getBlogPostBySlug = { success: false };
      const action2 = loadAction(h);
      assert.equal(await action2.getBlogPostBySlugAction("missing"), null);
    });

    it("getBlogPostBySlugAction degrades to null on a service throw", async () => {
      h.serviceThrows.getBlogPostBySlug = new Error("db");
      const action = loadAction(h);
      let res: unknown = "sentinel";
      await assert.doesNotReject(async () => {
        res = await action.getBlogPostBySlugAction("slug");
      });
      assert.equal(res, null);
    });

    it("getTagsAction unwraps data and degrades to [] on throw", async () => {
      h.serviceReturns.getTags = { success: true, data: [{ id: "tag1" }] };
      const action = loadAction(h);
      assert.equal(
        (await action.getTagsAction())[0] !== undefined
          ? ((await action.getTagsAction())[0] as { id: string }).id
          : undefined,
        "tag1"
      );

      h.serviceThrows.getTags = new Error("x");
      const action2 = loadAction(h);
      assert.deepEqual(await action2.getTagsAction(), []);
    });

    it("getTagBySlugAction returns data on success, null on failure/throw", async () => {
      h.serviceReturns.getTagBySlug = {
        success: true,
        data: { id: "t", slug: "finance" },
      };
      const action = loadAction(h);
      assert.equal(
        ((await action.getTagBySlugAction("finance")) as { slug: string }).slug,
        "finance"
      );

      h.serviceThrows.getTagBySlug = new Error("x");
      const action2 = loadAction(h);
      assert.equal(await action2.getTagBySlugAction("finance"), null);
    });

    it("getFeaturedBlogPostsAction degrades to [] on throw", async () => {
      h.serviceThrows.getFeaturedBlogPosts = new Error("x");
      const action = loadAction(h);
      assert.deepEqual(await action.getFeaturedBlogPostsAction(3), []);
    });

    it("getGlossaryTermsForHelpAction unwraps data and degrades to [] on throw", async () => {
      h.serviceReturns.getGlossaryTermsForHelp = {
        success: true,
        data: [{ term: "Alpha", definition: "excess return" }],
      };
      const action = loadAction(h);
      const ok = await action.getGlossaryTermsForHelpAction();
      assert.equal((ok[0] as { term: string }).term, "Alpha");

      h.serviceThrows.getGlossaryTermsForHelp = new Error("x");
      const action2 = loadAction(h);
      assert.deepEqual(await action2.getGlossaryTermsForHelpAction(), []);
    });
  });
});
