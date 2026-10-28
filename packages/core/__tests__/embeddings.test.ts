/**
 * Embeddings env-gating + request-body builder tests (MONEY-619 Phase 5).
 *
 * Covers the PURE helpers in packages/core/src/embeddings.ts:
 *   - getEmbeddingModel(): env-gated model choice (flag on/off)
 *   - buildEmbeddingRequestBody(): model-dependent Vertex :predict body
 *
 * These are imported from the real source module (no network — the source
 * only dynamic-imports google-auth-library inside generateEmbedding, which we
 * never call here, so the import is side-effect-free).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getEmbeddingModel,
  buildEmbeddingRequestBody,
} from "../src/embeddings";

const FLAG = "USE_GEMINI_EMBEDDING_001";

afterEach(() => {
  delete process.env[FLAG];
});

describe("getEmbeddingModel (env-gated)", () => {
  it("defaults to text-embedding-004 when the flag is unset", () => {
    delete process.env[FLAG];
    assert.strictEqual(getEmbeddingModel(), "text-embedding-004");
  });

  it("returns gemini-embedding-001 only when the flag is exactly 'true'", () => {
    process.env[FLAG] = "true";
    assert.strictEqual(getEmbeddingModel(), "gemini-embedding-001");
  });

  it("stays on text-embedding-004 for truthy-but-not-'true' values", () => {
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env[FLAG] = v;
      assert.strictEqual(
        getEmbeddingModel(),
        "text-embedding-004",
        `flag value ${JSON.stringify(v)} must not flip the model`,
      );
    }
  });
});

describe("buildEmbeddingRequestBody — text-embedding-004 (legacy, unchanged)", () => {
  it("emits exactly { instances: [{ content }] } with no parameters/task_type", () => {
    const body = buildEmbeddingRequestBody("hello world", "text-embedding-004");
    assert.deepStrictEqual(body, { instances: [{ content: "hello world" }] });
  });

  it("ignores the taskType argument for the legacy model", () => {
    const body = buildEmbeddingRequestBody(
      "q",
      "text-embedding-004",
      "RETRIEVAL_QUERY",
    );
    assert.deepStrictEqual(body, { instances: [{ content: "q" }] });
    assert.strictEqual("parameters" in body, false);
    assert.strictEqual("task_type" in body.instances[0]!, false);
  });

  it("does not set outputDimensionality for the legacy model", () => {
    const body = buildEmbeddingRequestBody("x", "text-embedding-004");
    assert.strictEqual(body.parameters, undefined);
  });
});

describe("buildEmbeddingRequestBody — gemini-embedding-001 (new)", () => {
  it("sets outputDimensionality:768 in parameters", () => {
    const body = buildEmbeddingRequestBody("doc text", "gemini-embedding-001");
    assert.deepStrictEqual(body.parameters, { outputDimensionality: 768 });
  });

  it("defaults the instance task_type to RETRIEVAL_DOCUMENT", () => {
    const body = buildEmbeddingRequestBody("doc text", "gemini-embedding-001");
    assert.strictEqual(body.instances[0]!.content, "doc text");
    assert.strictEqual(body.instances[0]!.task_type, "RETRIEVAL_DOCUMENT");
  });

  it("honors an explicit RETRIEVAL_QUERY task_type", () => {
    const body = buildEmbeddingRequestBody(
      "my query",
      "gemini-embedding-001",
      "RETRIEVAL_QUERY",
    );
    assert.strictEqual(body.instances[0]!.task_type, "RETRIEVAL_QUERY");
    assert.deepStrictEqual(body.parameters, { outputDimensionality: 768 });
  });

  it("produces a single instance carrying the content", () => {
    const body = buildEmbeddingRequestBody("solo", "gemini-embedding-001");
    assert.strictEqual(body.instances.length, 1);
    assert.strictEqual(body.instances[0]!.content, "solo");
  });
});

describe("getEmbeddingModel + buildEmbeddingRequestBody integration", () => {
  it("flag OFF → legacy body shape from the resolved model", () => {
    delete process.env[FLAG];
    const model = getEmbeddingModel();
    const body = buildEmbeddingRequestBody("t", model, "RETRIEVAL_QUERY");
    assert.strictEqual(model, "text-embedding-004");
    assert.deepStrictEqual(body, { instances: [{ content: "t" }] });
  });

  it("flag ON → 768-dim + task_type body from the resolved model", () => {
    process.env[FLAG] = "true";
    const model = getEmbeddingModel();
    const body = buildEmbeddingRequestBody("t", model, "RETRIEVAL_QUERY");
    assert.strictEqual(model, "gemini-embedding-001");
    assert.strictEqual(body.parameters?.outputDimensionality, 768);
    assert.strictEqual(body.instances[0]!.task_type, "RETRIEVAL_QUERY");
  });
});
