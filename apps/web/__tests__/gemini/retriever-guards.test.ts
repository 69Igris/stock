/**
 * Web RAG retriever guards (MONEY-807).
 *
 * `lib/gemini/retriever.ts` reads a loosely-typed `RetrieveOptions.filter`
 * (`Record<string, unknown>`). The hardening replaces blind `as` casts with
 * runtime narrowing (`readFilter`) and SHORT-CIRCUITS on an empty `userId` /
 * `symbol` rather than silently calling the underlying search with a coerced
 * `""` (or a `String(object)` → "[object Object]") scope.
 *
 * This drives the REAL exported retrievers (`atlasUserRetriever`,
 * `atlasStockRetriever`) — NOT a reimplementation. `@/lib/gemini/vector-store`
 * (which imports Prisma) and `@usemoney/core/rag/vertex-rag` are replaced in the
 * `require.cache` with recording doubles BEFORE the retriever module loads, so:
 *   - a missing/non-string scope returns `[]` and NEVER calls the search; and
 *   - a valid scope forwards ONLY a correctly-typed `docTypes` / `minScore`.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/gemini/retriever.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── module-cache seam ────────────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const RETRIEVER_REL = "../../lib/gemini/retriever";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(RETRIEVER_REL)];
}

// ── recorders ────────────────────────────────────────────────────────────────

interface SearchCall {
  scope: string; // userId or symbol
  query: string;
  options: { topK?: number; docTypes?: unknown; minScore?: unknown };
}

interface Harness {
  similarCalls: SearchCall[];
  stockCalls: SearchCall[];
  vertexCalls: number;
}

function freshHarness(): Harness {
  return { similarCalls: [], stockCalls: [], vertexCalls: 0 };
}

interface RetrieverModule {
  atlasUserRetriever: {
    retrieve: (opts: {
      query: string;
      topK?: number;
      filter?: Record<string, unknown>;
    }) => Promise<unknown[]>;
  };
  atlasStockRetriever: {
    retrieve: (opts: {
      query: string;
      topK?: number;
      filter?: Record<string, unknown>;
    }) => Promise<unknown[]>;
  };
}

function loadRetriever(h: Harness): RetrieverModule {
  const cache = moduleCache();

  const vectorStorePath = require.resolve("../../lib/gemini/vector-store");
  const vertexPath = require.resolve("@usemoney/core/rag/vertex-rag");
  const retrieverPath = require.resolve(RETRIEVER_REL);

  for (const p of [vectorStorePath, vertexPath]) snapshotOnce(p);

  cache[vectorStorePath] = {
    exports: {
      __esModule: true,
      searchSimilar: (
        userId: string,
        query: string,
        options: SearchCall["options"] = {}
      ) => {
        h.similarCalls.push({ scope: userId, query, options });
        return Promise.resolve([
          { content: "u", docType: "holdings", score: 1 },
        ]);
      },
      searchStockDocuments: (
        symbol: string,
        query: string,
        options: SearchCall["options"] = {}
      ) => {
        h.stockCalls.push({ scope: symbol, query, options });
        return Promise.resolve([{ content: "s", docType: "filing", score: 1 }]);
      },
    },
  };
  cache[vertexPath] = {
    exports: {
      __esModule: true,
      retrieveContexts: () => {
        h.vertexCalls += 1;
        return Promise.resolve([]);
      },
    },
  };

  delete cache[retrieverPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(RETRIEVER_REL) as RetrieverModule;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-807 — web retriever filter guards (real exports)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("atlasUserRetriever — userId scope", () => {
    it("short-circuits to [] on a MISSING userId (no search call)", async () => {
      const m = loadRetriever(h);
      const out = await m.atlasUserRetriever.retrieve({ query: "q" });
      assert.deepStrictEqual(out, []);
      assert.equal(h.similarCalls.length, 0, "must not call searchSimilar");
    });

    it("short-circuits on a NON-STRING userId instead of String()-ing it to junk", async () => {
      const m = loadRetriever(h);
      const out = await m.atlasUserRetriever.retrieve({
        query: "q",
        // a stray object would previously become "[object Object]"
        filter: { userId: { sneaky: true } as unknown as string },
      });
      assert.deepStrictEqual(out, []);
      assert.equal(h.similarCalls.length, 0);
    });

    it("short-circuits on an EMPTY-string userId", async () => {
      const m = loadRetriever(h);
      const out = await m.atlasUserRetriever.retrieve({
        query: "q",
        filter: { userId: "" },
      });
      assert.deepStrictEqual(out, []);
      assert.equal(h.similarCalls.length, 0);
    });

    it("forwards a valid userId + correctly-typed docTypes/minScore", async () => {
      const m = loadRetriever(h);
      await m.atlasUserRetriever.retrieve({
        query: "q",
        topK: 7,
        filter: {
          userId: "user-1",
          docTypes: ["holdings", "trades"],
          minScore: 0.42,
        },
      });
      assert.equal(h.similarCalls.length, 1);
      const call = h.similarCalls[0];
      assert.equal(call.scope, "user-1");
      assert.equal(call.options.topK, 7);
      assert.deepStrictEqual(call.options.docTypes, ["holdings", "trades"]);
      assert.equal(call.options.minScore, 0.42);
    });

    it("drops a malformed docTypes (not a string[]) and a non-finite minScore", async () => {
      const m = loadRetriever(h);
      await m.atlasUserRetriever.retrieve({
        query: "q",
        filter: {
          userId: "user-1",
          docTypes: "holdings", // a string, not string[]
          minScore: Number.NaN, // not finite
        },
      });
      assert.equal(h.similarCalls.length, 1);
      const opts = h.similarCalls[0].options;
      assert.equal(
        opts.docTypes,
        undefined,
        "malformed docTypes must be dropped"
      );
      assert.equal(
        opts.minScore,
        undefined,
        "non-finite minScore must be dropped"
      );
    });

    it("drops a docTypes array that contains a non-string element", async () => {
      const m = loadRetriever(h);
      await m.atlasUserRetriever.retrieve({
        query: "q",
        filter: { userId: "user-1", docTypes: ["holdings", 7] },
      });
      assert.equal(h.similarCalls[0].options.docTypes, undefined);
    });
  });

  describe("atlasStockRetriever — symbol scope", () => {
    it("short-circuits to [] on a MISSING symbol (no search call)", async () => {
      const m = loadRetriever(h);
      const out = await m.atlasStockRetriever.retrieve({ query: "q" });
      assert.deepStrictEqual(out, []);
      assert.equal(
        h.stockCalls.length,
        0,
        "must not call searchStockDocuments"
      );
    });

    it("short-circuits on a NON-STRING symbol", async () => {
      const m = loadRetriever(h);
      const out = await m.atlasStockRetriever.retrieve({
        query: "q",
        filter: { symbol: 123 as unknown as string },
      });
      assert.deepStrictEqual(out, []);
      assert.equal(h.stockCalls.length, 0);
    });

    it("forwards a valid symbol + typed options", async () => {
      const m = loadRetriever(h);
      await m.atlasStockRetriever.retrieve({
        query: "q",
        topK: 3,
        filter: { symbol: "TCS", minScore: 0.5 },
      });
      assert.equal(h.stockCalls.length, 1);
      assert.equal(h.stockCalls[0].scope, "TCS");
      assert.equal(h.stockCalls[0].options.minScore, 0.5);
      assert.equal(h.stockCalls[0].options.docTypes, undefined);
    });
  });
});
