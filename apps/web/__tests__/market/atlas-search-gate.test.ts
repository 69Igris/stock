/**
 * MONEY-1128 — Atlas Search ↔ regex fallback, end to end through the REAL
 * modules.
 *
 * Not a shadow: `lib/market/atlas-search.ts` and `lib/market/content-search.ts`
 * are loaded for real through a `require.cache` seam that swaps only
 * `@usemoney/database`. The gate (`@usemoney/core/search/atlas-gate`) is the
 * REAL shared one — that is the point of the file, since the bug being fixed is
 * about which module owns the latch.
 *
 * What this proves that the gate's own unit tests cannot:
 *   1. a timeout thrown by prisma leaves the gate OPEN, so the very next
 *      request still issues `$search` (the production regression);
 *   2. an index-missing error DOES shut it, so we stop hammering a missing
 *      index;
 *   3. a deployment-level failure raised from CONTENT search also shuts
 *      INSTRUMENT search — the four private flags really did collapse into one;
 *   4. `SEARCH_BACKEND` short-circuits before prisma is touched at all;
 *   5. the `$search` filters use operators that a `token`-mapped field can
 *      actually match.
 *
 * Runs under `node --import tsx --test` (CJS). CWD must be apps/web.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// Silence the gate's real pino logger for the duration of the suite. Must run
// before the first require() of the gate (the static imports above pull in no
// logger, so this is early enough).
process.env.LOG_LEVEL = "fatal";

// ── module-cache seam ───────────────────────────────────────────────────────

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

const DB_MODULE = "@usemoney/database";
const GATE_MODULE = "@usemoney/core/search/atlas-gate";
const ATLAS_REL = "../../lib/market/atlas-search";
const CONTENT_REL = "../../lib/market/content-search";

interface RawCommand {
  aggregate: string;
  pipeline: Record<string, unknown>[];
}

interface Harness {
  /** Every `$runCommandRaw` the modules issued. */
  calls: RawCommand[];
  /** Thrown on the NEXT call when set (then cleared). */
  throwNext?: unknown;
  /** Documents the stub returns when it does not throw. */
  docs: Record<string, unknown>[];
}

function freshHarness(): Harness {
  return { calls: [], docs: [] };
}

interface AtlasModule {
  searchInstrumentsAtlas(
    query: string,
    options?: { types?: string[]; exchange?: string; limit?: number }
  ): Promise<unknown[] | null>;
  searchMutualFundsAtlas(
    query: string,
    options?: { limit?: number }
  ): Promise<unknown[] | null>;
  autocompleteInstruments(
    query: string,
    options?: { limit?: number; types?: string[] }
  ): Promise<unknown[] | null>;
  buildInstrumentSearchPipeline(
    query: string,
    options?: { types?: string[]; exchange?: string; limit?: number }
  ): Record<string, unknown>[];
  buildMfSearchPipeline(
    query: string,
    options?: { limit?: number }
  ): Record<string, unknown>[];
  buildAutocompletePipeline(
    query: string,
    options?: { limit?: number; types?: string[] }
  ): Record<string, unknown>[];
}

interface ContentModule {
  searchContentAtlas(
    query: string,
    options?: { contentType?: string; limit?: number }
  ): Promise<unknown[] | null>;
  buildContentSearchPipeline(
    query: string,
    options?: { contentType?: string; limit?: number }
  ): Record<string, unknown>[];
}

interface GateModule {
  resetSearchGate(): void;
  getSearchBackend(): "atlas" | "regex";
  SEARCH_INDEX: Record<string, string>;
}

interface Loaded {
  atlas: AtlasModule;
  content: ContentModule;
  gate: GateModule;
}

function load(h: Harness): Loaded {
  const cache = moduleCache();
  const dbPath = require.resolve(DB_MODULE);
  snapshotOnce(dbPath);

  const prismaStub = {
    $runCommandRaw: (command: RawCommand) => {
      h.calls.push(command);
      if (h.throwNext !== undefined) {
        const err = h.throwNext;
        h.throwNext = undefined;
        return Promise.reject(err);
      }
      return Promise.resolve({ cursor: { firstBatch: h.docs }, ok: 1 });
    },
  };
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: prismaStub,
      default: prismaStub,
      Prisma: {},
    },
  };

  // Force both search modules to re-bind to the stubbed prisma.
  delete cache[require.resolve(ATLAS_REL)];
  delete cache[require.resolve(CONTENT_REL)];

  /* eslint-disable @typescript-eslint/no-require-imports */
  const gate = require(GATE_MODULE) as GateModule;
  gate.resetSearchGate();
  return {
    atlas: require(ATLAS_REL) as AtlasModule,
    content: require(CONTENT_REL) as ContentModule,
    gate,
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ATLAS_REL)];
  delete cache[require.resolve(CONTENT_REL)];
}

// ── pipeline helpers ────────────────────────────────────────────────────────

function searchStage(
  pipeline: Record<string, unknown>[]
): Record<string, unknown> {
  const stage = pipeline.find((s) => "$search" in s);
  assert.ok(stage, "pipeline has a $search stage");
  return stage["$search"] as Record<string, unknown>;
}

function filterClauses(
  pipeline: Record<string, unknown>[]
): Record<string, unknown>[] {
  const compound = searchStage(pipeline).compound as Record<string, unknown>;
  return (compound.filter ?? []) as Record<string, unknown>[];
}

function clauseFor(
  clauses: Record<string, unknown>[],
  path: string
): { operator: string; clause: Record<string, unknown> } | null {
  for (const clause of clauses) {
    for (const [operator, body] of Object.entries(clause)) {
      if (
        body !== null &&
        typeof body === "object" &&
        (body as Record<string, unknown>).path === path
      ) {
        return { operator, clause: body as Record<string, unknown> };
      }
    }
  }
  return null;
}

// ── errors ──────────────────────────────────────────────────────────────────

const TIMEOUT_ERROR = new Error(
  "PlanExecutor error during aggregation :: caused by :: operation exceeded time limit"
);
const INDEX_MISSING_ERROR = new Error(
  'PlanExecutor error during aggregation :: caused by :: Search index with name "instrument_search" not found'
);
const NOT_ATLAS_ERROR = new Error(
  "Kind: Command failed: Error code 40324 (Location40324): PlanExecutor error during aggregation :: caused by :: Unrecognized pipeline stage name: '$search'"
);

// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1128 — Atlas search gate, real modules", () => {
  let h: Harness;

  beforeEach(() => {
    h = freshHarness();
    process.env.SEARCH_BACKEND = "atlas";
  });

  after(() => {
    delete process.env.SEARCH_BACKEND;
    restoreCache();
  });

  // ── 1. the regression ────────────────────────────────────────────────────

  describe("a transient failure must not latch the process", () => {
    it("REGRESSION: a PlanExecutor timeout falls back for ONE request only", async () => {
      const { atlas } = load(h);

      h.throwNext = TIMEOUT_ERROR;
      assert.strictEqual(await atlas.searchInstrumentsAtlas("reliance"), null);
      assert.strictEqual(h.calls.length, 1);

      // The next request must still reach Atlas. Before MONEY-1128 this
      // returned null WITHOUT touching prisma for the next 5 minutes.
      h.docs = [{ symbol: "RELIANCE", name: "Reliance Industries" }];
      const second = await atlas.searchInstrumentsAtlas("reliance");
      assert.strictEqual(h.calls.length, 2, "second request re-issued $search");
      assert.deepStrictEqual(second, h.docs);
    });

    it("REGRESSION: a timeout in MF search does not disable instrument search", async () => {
      const { atlas } = load(h);

      h.throwNext = TIMEOUT_ERROR;
      assert.strictEqual(await atlas.searchMutualFundsAtlas("hdfc"), null);

      h.docs = [{ symbol: "TCS" }];
      assert.notStrictEqual(await atlas.searchInstrumentsAtlas("tcs"), null);
      assert.strictEqual(h.calls.length, 2);
    });

    it("REGRESSION: autocomplete recovers on the very next keystroke", async () => {
      const { atlas } = load(h);

      h.throwNext = new Error(
        "MongoServerSelectionError: Server selection timed out"
      );
      assert.strictEqual(await atlas.autocompleteInstruments("rel"), null);

      h.docs = [
        {
          symbol: "RELIANCE",
          name: "Reliance",
          exchange: "NSE",
          instrumentType: "EQUITY",
        },
      ];
      const result = await atlas.autocompleteInstruments("reli");
      assert.strictEqual(h.calls.length, 2);
      assert.deepStrictEqual(result, [
        {
          symbol: "RELIANCE",
          name: "Reliance",
          type: "EQUITY",
          exchange: "NSE",
        },
      ]);
    });
  });

  // ── 2. genuine unavailability still latches ──────────────────────────────

  describe("a genuinely missing index still latches", () => {
    it("stops issuing $search after an index-not-found", async () => {
      const { atlas } = load(h);

      h.throwNext = INDEX_MISSING_ERROR;
      assert.strictEqual(await atlas.searchInstrumentsAtlas("reliance"), null);
      assert.strictEqual(h.calls.length, 1);

      assert.strictEqual(await atlas.searchInstrumentsAtlas("reliance"), null);
      assert.strictEqual(
        h.calls.length,
        1,
        "latched — no second round-trip to a missing index"
      );
    });

    it("keeps a sibling index usable when only one index is missing", async () => {
      const { atlas, content } = load(h);

      h.throwNext = new Error(
        'Search index with name "content_search" not found'
      );
      assert.strictEqual(await content.searchContentAtlas("sip"), null);

      h.docs = [{ symbol: "TCS" }];
      assert.notStrictEqual(await atlas.searchInstrumentsAtlas("tcs"), null);
      assert.strictEqual(h.calls.length, 2);
    });

    it("ONE gate: a deployment failure in content search also stops instrument search", async () => {
      const { atlas, content } = load(h);

      h.throwNext = NOT_ATLAS_ERROR;
      assert.strictEqual(await content.searchContentAtlas("sip"), null);
      assert.strictEqual(h.calls.length, 1);

      // Before MONEY-1128 these were four independent flags, so this call
      // would have gone straight to a `$search` the deployment cannot run.
      assert.strictEqual(await atlas.searchInstrumentsAtlas("tcs"), null);
      assert.strictEqual(await atlas.searchMutualFundsAtlas("hdfc"), null);
      assert.strictEqual(h.calls.length, 1);
    });

    it("rethrows an unclassified failure instead of silently degrading", async () => {
      const { atlas } = load(h);

      h.throwNext = new Error("BadValue: unknown operator 'nope'");
      await assert.rejects(() => atlas.searchInstrumentsAtlas("x"), {
        message: /unknown operator/,
      });
    });
  });

  // ── 3. the env override ──────────────────────────────────────────────────

  describe("SEARCH_BACKEND override", () => {
    it("SEARCH_BACKEND=regex skips prisma entirely on an Atlas URL", async () => {
      process.env.DATABASE_URL = "mongodb+srv://x@c0.abc.mongodb.net/app";
      process.env.SEARCH_BACKEND = "regex";
      const { atlas, content, gate } = load(h);

      assert.strictEqual(gate.getSearchBackend(), "regex");
      assert.strictEqual(await atlas.searchInstrumentsAtlas("tcs"), null);
      assert.strictEqual(await atlas.searchMutualFundsAtlas("hdfc"), null);
      assert.strictEqual(await atlas.autocompleteInstruments("tc"), null);
      assert.strictEqual(await content.searchContentAtlas("sip"), null);
      assert.strictEqual(h.calls.length, 0);
    });

    it("SEARCH_BACKEND=atlas enables $search on a non-Atlas connection string", async () => {
      process.env.DATABASE_URL = "mongodb://10.0.0.7:27017/app";
      process.env.SEARCH_BACKEND = "atlas";
      const { atlas, gate } = load(h);

      assert.strictEqual(gate.getSearchBackend(), "atlas");
      h.docs = [{ symbol: "TCS" }];
      assert.notStrictEqual(await atlas.searchInstrumentsAtlas("tcs"), null);
      assert.strictEqual(h.calls.length, 1);
    });
  });

  // ── 4. token-mapped filters ──────────────────────────────────────────────

  describe("$search filters must use operators the index mapping supports", () => {
    it("filters `exchange` with `equals`, not `text` (token mapping)", () => {
      const { atlas } = load(h);
      const pipeline = atlas.buildInstrumentSearchPipeline("tcs", {
        exchange: "NSE",
      });
      const match = clauseFor(filterClauses(pipeline), "exchange");

      assert.ok(match, "an exchange filter clause exists");
      assert.strictEqual(
        match.operator,
        "equals",
        "`text` cannot match a token-mapped field — it matches NOTHING"
      );
      assert.strictEqual(match.clause.value, "NSE");
    });

    it("normalises the exchange to the stored uppercase token", () => {
      const { atlas } = load(h);
      const pipeline = atlas.buildInstrumentSearchPipeline("tcs", {
        exchange: "nse",
      });
      const match = clauseFor(filterClauses(pipeline), "exchange");
      assert.strictEqual(match?.clause.value, "NSE");
    });

    it("omits the exchange filter entirely when no exchange is given", () => {
      const { atlas } = load(h);
      const pipeline = atlas.buildInstrumentSearchPipeline("tcs");
      assert.strictEqual(clauseFor(filterClauses(pipeline), "exchange"), null);
    });

    it("keeps `in` for the token-mapped instrumentType filter", () => {
      const { atlas } = load(h);
      const pipeline = atlas.buildInstrumentSearchPipeline("tcs", {
        types: ["EQUITY", "ETF"],
      });
      const match = clauseFor(filterClauses(pipeline), "instrumentType");
      assert.strictEqual(match?.operator, "in");
    });

    it("filters content status/platform/type with `equals` (all token-mapped)", () => {
      const { content } = load(h);
      const clauses = filterClauses(
        content.buildContentSearchPipeline("sip", { contentType: "BLOG" })
      );

      for (const [path, value] of [
        ["status", "PUBLISHED"],
        ["contentPlatform", "STOCKBOOK"],
        ["contentType", "BLOG"],
      ] as const) {
        const match = clauseFor(clauses, path);
        assert.ok(match, `${path} filter exists`);
        assert.strictEqual(match.operator, "equals", `${path} uses equals`);
        assert.strictEqual(match.clause.value, value);
      }
    });

    it("sends the exchange filter through to the real query", async () => {
      const { atlas } = load(h);
      h.docs = [];
      await atlas.searchInstrumentsAtlas("tcs", { exchange: "BSE" });

      const clauses = filterClauses(h.calls[0].pipeline);
      assert.strictEqual(clauseFor(clauses, "exchange")?.operator, "equals");
    });

    it("targets the shared index names", () => {
      const { atlas, content, gate } = load(h);
      assert.strictEqual(
        searchStage(atlas.buildInstrumentSearchPipeline("x")).index,
        gate.SEARCH_INDEX.INSTRUMENTS
      );
      assert.strictEqual(
        searchStage(atlas.buildMfSearchPipeline("x")).index,
        gate.SEARCH_INDEX.MUTUAL_FUNDS
      );
      assert.strictEqual(
        searchStage(atlas.buildAutocompletePipeline("x")).index,
        gate.SEARCH_INDEX.INSTRUMENTS
      );
      assert.strictEqual(
        searchStage(content.buildContentSearchPipeline("x")).index,
        gate.SEARCH_INDEX.CONTENT
      );
    });
  });

  // ── 5. no call site keeps a private copy of the gate ─────────────────────

  describe("the four former call sites resolve through the shared gate", () => {
    const REPO_ROOT = resolvePath(__dirname, "../../../..");
    const CALL_SITES = [
      "apps/web/lib/market/atlas-search.ts",
      "apps/web/lib/market/content-search.ts",
      "apps/content/lib/atlas-user-search.ts",
      "packages/services/src/discover.service.ts",
    ];

    for (const relative of CALL_SITES) {
      it(`${relative} imports the gate and keeps no private flag`, () => {
        const source = readFileSync(resolvePath(REPO_ROOT, relative), "utf8");
        const code = source
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");

        assert.match(
          code,
          /@usemoney\/core\/search\/atlas-gate/,
          "imports the shared gate"
        );
        assert.doesNotMatch(
          code,
          /includes\(\s*["']mongodb\.net["']/,
          "no private connection-string sniff"
        );
        assert.doesNotMatch(
          code,
          /atlasUnavailableUntil|markAtlasUnavailable/,
          "no private 5-minute latch"
        );
      });
    }
  });
});
