/**
 * Vertex AI RAG Engine — pure helper tests (MONEY-782, P2b).
 *
 * Covers the side-effect-free helpers in packages/core/src/rag/vertex-rag.ts:
 *   - resolveCorpusName(): full-name passthrough vs bare-id expansion
 *   - mapRetrieveContextsResponse(): the :retrieveContexts → chunk adapter
 *   - vertexRagConfigured(): the flag + project + corpus gate
 *
 * These are imported from the real source module. No network: the source only
 * dynamic-uses `google-auth-library` inside the REST path (getAuth/rest), which
 * none of these pure helpers touch, so the import is side-effect-free.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCorpusName,
  mapRetrieveContextsResponse,
  vertexRagConfigured,
  ragCorpus,
  retrieveContexts,
  resetVertexRagAuth,
  buildMetadataFilter,
  buildRetrieveContextsBody,
  importFiles,
} from "../src/rag/vertex-rag";

const PROJECT = "GCP_PROJECT_ID";
const LOCATION = "VERTEX_RAG_LOCATION";
const CORPUS = "VERTEX_RAG_CORPUS";
const ENABLED = "VERTEX_RAG_ENABLED";

function clearEnv(): void {
  delete process.env[PROJECT];
  delete process.env[LOCATION];
  delete process.env[CORPUS];
  delete process.env[ENABLED];
}

beforeEach(() => {
  clearEnv();
  resetVertexRagAuth();
});
afterEach(() => {
  clearEnv();
  resetVertexRagAuth();
});

describe("resolveCorpusName", () => {
  it("passes through an already-full projects/.../ragCorpora/{id} name verbatim", () => {
    process.env[PROJECT] = "stock-book-483718";
    const full = "projects/other-proj/locations/asia-south1/ragCorpora/abc123";
    // The full name wins even when env project/location differ.
    assert.strictEqual(resolveCorpusName(full), full);
  });

  it("expands a bare id using GCP_PROJECT_ID + default location (us-central1)", () => {
    process.env[PROJECT] = "stock-book-483718";
    assert.strictEqual(
      resolveCorpusName("abc123"),
      "projects/stock-book-483718/locations/us-central1/ragCorpora/abc123",
    );
  });

  it("honours VERTEX_RAG_LOCATION when expanding a bare id", () => {
    process.env[PROJECT] = "stock-book-483718";
    process.env[LOCATION] = "asia-southeast1";
    assert.strictEqual(
      resolveCorpusName("xyz"),
      "projects/stock-book-483718/locations/asia-southeast1/ragCorpora/xyz",
    );
  });

  it("strips a leading 'ragCorpora/' tail before expanding", () => {
    process.env[PROJECT] = "p";
    assert.strictEqual(
      resolveCorpusName("ragCorpora/id99"),
      "projects/p/locations/us-central1/ragCorpora/id99",
    );
  });

  it("defaults to VERTEX_RAG_CORPUS when called with no argument", () => {
    process.env[PROJECT] = "p";
    process.env[CORPUS] = "envCorpus";
    assert.strictEqual(ragCorpus(), "envCorpus");
    assert.strictEqual(
      resolveCorpusName(),
      "projects/p/locations/us-central1/ragCorpora/envCorpus",
    );
  });
});

describe("mapRetrieveContextsResponse (chunk adapter)", () => {
  it("returns [] for a null body", () => {
    assert.deepStrictEqual(mapRetrieveContextsResponse(null), []);
  });

  it("returns [] when the nested contexts array is absent", () => {
    assert.deepStrictEqual(mapRetrieveContextsResponse({}), []);
    assert.deepStrictEqual(mapRetrieveContextsResponse({ contexts: {} }), []);
  });

  it("maps text + sourceUri + score straight through", () => {
    const out = mapRetrieveContextsResponse({
      contexts: {
        contexts: [{ text: "hello", sourceUri: "gs://b/f.pdf", score: 0.82 }],
      },
    });
    assert.deepStrictEqual(out, [
      { text: "hello", sourceUri: "gs://b/f.pdf", score: 0.82 },
    ]);
  });

  it("falls back to sourceDisplayName when sourceUri is missing", () => {
    const out = mapRetrieveContextsResponse({
      contexts: {
        contexts: [
          { text: "x", sourceDisplayName: "Annual Report", score: 0.5 },
        ],
      },
    });
    assert.strictEqual(out[0]!.sourceUri, "Annual Report");
  });

  it("derives score from distance (1 - distance) when score is absent", () => {
    const out = mapRetrieveContextsResponse({
      contexts: { contexts: [{ text: "x", distance: 0.3 }] },
    });
    assert.ok(Math.abs(out[0]!.score - 0.7) < 1e-9);
  });

  it("clamps a distance-derived score to >= 0 (distance can exceed 1)", () => {
    const out = mapRetrieveContextsResponse({
      contexts: { contexts: [{ text: "x", distance: 1.4 }] },
    });
    // 1 - 1.4 = -0.4 → clamped to 0, never negative.
    assert.strictEqual(out[0]!.score, 0);
  });

  it("defaults missing text → '', missing source → null, missing score → 0", () => {
    const out = mapRetrieveContextsResponse({
      contexts: { contexts: [{}] },
    });
    assert.deepStrictEqual(out, [{ text: "", sourceUri: null, score: 0 }]);
  });
});

describe("vertexRagConfigured (flag + project + corpus gate)", () => {
  it("is false when nothing is set (atlas default)", () => {
    assert.strictEqual(vertexRagConfigured(), false);
  });

  it("is false when the flag is on but project/corpus are missing", () => {
    process.env[ENABLED] = "true";
    assert.strictEqual(vertexRagConfigured(), false);
  });

  it("is false when the flag is truthy-but-not-'true'", () => {
    process.env[ENABLED] = "1";
    process.env[PROJECT] = "p";
    process.env[CORPUS] = "c";
    assert.strictEqual(vertexRagConfigured(), false);
  });

  it("is true only when flag='true' AND project AND corpus are all set", () => {
    process.env[ENABLED] = "true";
    process.env[PROJECT] = "p";
    process.env[CORPUS] = "c";
    assert.strictEqual(vertexRagConfigured(), true);
  });

  it("is false when the corpus is missing even with flag + project", () => {
    process.env[ENABLED] = "true";
    process.env[PROJECT] = "p";
    assert.strictEqual(vertexRagConfigured(), false);
  });
});

describe("resolveCorpusName — SSRF / URL-injection hardening", () => {
  it("refuses ('') a bare-id when GCP_PROJECT_ID is a host-breakout value", () => {
    // A poisoned project must not be interpolated into the path/host.
    process.env[PROJECT] = "evil.com/x";
    assert.strictEqual(resolveCorpusName("abc123"), "");
  });

  it("refuses ('') a bare-id when VERTEX_RAG_LOCATION breaks out of the host", () => {
    // "evil.com/x?" → https://evil.com/x?-aiplatform.googleapis.com/... (host evil.com)
    process.env[PROJECT] = "p";
    process.env[LOCATION] = "evil.com/x?";
    assert.strictEqual(resolveCorpusName("abc123"), "");
  });

  it("refuses ('') a corpus id containing path-traversal / injection chars", () => {
    process.env[PROJECT] = "p";
    for (const bad of [
      "../../foo",
      "id/../../bar",
      "id?x=1",
      "id#frag",
      "id with space",
      "id%2f..",
      "a@b",
    ]) {
      assert.strictEqual(
        resolveCorpusName(bad),
        "",
        `corpus id ${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  it("refuses ('') a full resource name that is not a strict projects/.../ragCorpora/{id} shape", () => {
    process.env[PROJECT] = "p";
    for (const bad of [
      "projects/../evil",
      "projects/p/locations/l/ragCorpora/id/../../x",
      "projects/p/locations/l/ragCorpora/id?x=1",
      "projects/p/locations/l/ragCorpora/i d",
      "projects/p/locations/l/ragCorpora/id@evil.com",
      "projects/p/locations/l/ragFiles/x", // wrong collection
    ]) {
      assert.strictEqual(
        resolveCorpusName(bad),
        "",
        `full name ${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  it("still passes through a well-formed full resource name verbatim", () => {
    process.env[PROJECT] = "p";
    const full = "projects/other/locations/asia-south1/ragCorpora/abc_123-x";
    assert.strictEqual(resolveCorpusName(full), full);
  });

  it("accepts a normal numeric/alphanumeric corpus id", () => {
    process.env[PROJECT] = "stock-book-483718";
    assert.strictEqual(
      resolveCorpusName("1234567890"),
      "projects/stock-book-483718/locations/us-central1/ragCorpora/1234567890",
    );
  });
});

describe("buildMetadataFilter (per-user / metadata scoping)", () => {
  it("returns undefined when neither userId nor metadataFilter is given", () => {
    assert.strictEqual(buildMetadataFilter(), undefined);
    assert.strictEqual(buildMetadataFilter({}), undefined);
    assert.strictEqual(buildMetadataFilter({ userId: "  " }), undefined);
  });

  it("synthesises a userId CEL equality predicate (==) from a safe userId", () => {
    assert.deepStrictEqual(buildMetadataFilter({ userId: "user-123" }), {
      metadata_filter: 'userId == "user-123"',
    });
  });

  it("accepts a Clerk-style id and a 24-char hex id (the real id shapes)", () => {
    assert.deepStrictEqual(buildMetadataFilter({ userId: "user_2abcXYZ-09" }), {
      metadata_filter: 'userId == "user_2abcXYZ-09"',
    });
    assert.deepStrictEqual(
      buildMetadataFilter({ userId: "5f1d2c3b4a5e6f7081920314" }),
      { metadata_filter: 'userId == "5f1d2c3b4a5e6f7081920314"' },
    );
  });

  it("fails closed (undefined) for an unsafe userId — never emits a broken-out predicate", () => {
    // Quotes, spaces, backslashes and CEL operators are all refused: no scope is
    // emitted rather than a predicate that could be escaped or injected.
    for (const bad of [
      'a" or 1=1 "b',
      'x"',
      "a b",
      "a\\b",
      "u==1",
      "id'or",
      "name.with.dots",
    ]) {
      assert.strictEqual(
        buildMetadataFilter({ userId: bad }),
        undefined,
        `unsafe userId ${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  it("passes an explicit metadataFilter through verbatim", () => {
    assert.deepStrictEqual(
      buildMetadataFilter({ metadataFilter: 'symbol == "INFY"' }),
      { metadata_filter: 'symbol == "INFY"' },
    );
  });

  it("explicit metadataFilter wins over userId", () => {
    assert.deepStrictEqual(
      buildMetadataFilter({
        userId: "u1",
        metadataFilter: 'docType == "filing"',
      }),
      { metadata_filter: 'docType == "filing"' },
    );
  });
});

describe("buildRetrieveContextsBody (request-shape mapping)", () => {
  const CORPUS = "projects/p/locations/us-central1/ragCorpora/abc";

  it("omits rag_retrieval_config for a bare shared-corpus query (just corpus + query text)", () => {
    // Contract: vertex_rag_store carries ONLY the corpus selector; top_k/filter
    // live on query.rag_retrieval_config. With neither, the config is absent.
    assert.deepStrictEqual(buildRetrieveContextsBody(CORPUS, "q"), {
      vertex_rag_store: { rag_resources: [{ rag_corpus: CORPUS }] },
      query: { text: "q" },
    });
  });

  it("puts top_k under query.rag_retrieval_config (NOT on vertex_rag_store)", () => {
    const body = buildRetrieveContextsBody(CORPUS, "q", { topK: 7 });
    assert.deepStrictEqual(body, {
      vertex_rag_store: { rag_resources: [{ rag_corpus: CORPUS }] },
      query: { text: "q", rag_retrieval_config: { top_k: 7 } },
    });
    // No filter on either node when there is no userId/metadataFilter.
    assert.ok(
      !("filter" in (body.vertex_rag_store as Record<string, unknown>)),
      "no filter on vertex_rag_store",
    );
  });

  it("attaches the per-user filter under query.rag_retrieval_config.filter (==) with top_k", () => {
    const body = buildRetrieveContextsBody(CORPUS, "q", {
      topK: 5,
      userId: "u-9",
    });
    assert.deepStrictEqual(body, {
      vertex_rag_store: { rag_resources: [{ rag_corpus: CORPUS }] },
      query: {
        text: "q",
        rag_retrieval_config: {
          top_k: 5,
          filter: { metadata_filter: 'userId == "u-9"' },
        },
      },
    });
    // The corpus selector must NOT carry the per-user filter (Vertex ignores it
    // there → a silent cross-user leak on a shared corpus).
    assert.ok(
      !("filter" in (body.vertex_rag_store as Record<string, unknown>)),
      "filter must not sit on vertex_rag_store",
    );
  });

  it("emits a filter-only rag_retrieval_config when userId is set without topK", () => {
    const body = buildRetrieveContextsBody(CORPUS, "q", { userId: "u-9" });
    assert.deepStrictEqual(body.query, {
      text: "q",
      rag_retrieval_config: {
        filter: { metadata_filter: 'userId == "u-9"' },
      },
    });
  });

  it("attaches an explicit metadataFilter passthrough under rag_retrieval_config.filter", () => {
    const body = buildRetrieveContextsBody(CORPUS, "q", {
      metadataFilter: 'symbol == "TCS"',
    });
    const cfg = (body.query as Record<string, unknown>)
      .rag_retrieval_config as Record<string, unknown>;
    assert.deepStrictEqual(cfg.filter, {
      metadata_filter: 'symbol == "TCS"',
    });
  });

  it("emits no scope (no filter) for an unsafe userId — fail closed", () => {
    const body = buildRetrieveContextsBody(CORPUS, "q", {
      topK: 3,
      userId: 'evil" or true "',
    });
    // top_k still present, but NO filter → caller (retrieveContexts) fails closed.
    assert.deepStrictEqual(body.query, {
      text: "q",
      rag_retrieval_config: { top_k: 3 },
    });
  });
});

describe("importFiles — inert when flag off / unconfigured (no network)", () => {
  it("returns false when no corpus is configured (never calls fetch/auth)", async () => {
    // No env → resolveCorpusName("") === "" → early return before auth/fetch.
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called when unconfigured");
    }) as typeof fetch;
    try {
      const ok = await importFiles(undefined, ["gs://b/o.pdf"]);
      assert.strictEqual(ok, false);
      assert.strictEqual(fetchCalled, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns false when there are no usable gs:// URIs (drops non-gs entries) — no network", async () => {
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called with no usable URIs");
    }) as typeof fetch;
    try {
      process.env[PROJECT] = "p";
      process.env[CORPUS] = "abc";
      // Only non-gs entries → filtered to empty → no-op before any fetch.
      const ok = await importFiles("abc", ["https://x/y", "file.pdf", ""]);
      assert.strictEqual(ok, false);
      assert.strictEqual(fetchCalled, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns false when the corpus resolves unsafe (SSRF guard) — no network", async () => {
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called on the refused path");
    }) as typeof fetch;
    try {
      process.env[PROJECT] = "evil.com/x"; // poisons resolveCorpusName → ""
      const ok = await importFiles("abc123", ["gs://b/o.pdf"]);
      assert.strictEqual(ok, false);
      assert.strictEqual(fetchCalled, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("retrieveContexts — flag-off / unconfigured safety (no network)", () => {
  it("returns [] when no corpus is configured (never calls fetch/auth)", async () => {
    // No env set → ragCorpus() === "" → early return before any auth/fetch.
    const out = await retrieveContexts("any query");
    assert.deepStrictEqual(out, []);
  });

  it("returns [] when the corpus arg resolves unsafe (SSRF guard) — no network", async () => {
    // Stub fetch to PROVE it is never called on the refused path.
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called on the refused path");
    }) as typeof fetch;
    try {
      process.env[PROJECT] = "evil.com/x"; // poisons resolveCorpusName → ""
      const out = await retrieveContexts("q", { corpus: "abc123" });
      assert.deepStrictEqual(out, []);
      assert.strictEqual(fetchCalled, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fails closed: a per-user query with an UNSAFE userId returns [] (never queries unscoped)", async () => {
    // A configured, safe corpus — only the userId is poisoned. Without the
    // fail-closed guard this would run the query against the SHARED corpus with
    // NO per-user scope (a cross-user leak). Prove fetch is never reached.
    const realFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called when failing closed");
    }) as typeof fetch;
    try {
      process.env[PROJECT] = "p";
      const out = await retrieveContexts("q", {
        corpus: "abc123",
        userId: 'evil" or true "',
      });
      assert.deepStrictEqual(out, []);
      assert.strictEqual(fetchCalled, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
