/**
 * Retriever seam tests (MONEY-781).
 *
 * Covers the pure gating helpers in packages/core/src/rag/retriever.ts:
 *   - vertexRagReady(): the flag + project + corpus env gate (both ways)
 *   - selectRetriever(): atlas-default vs vertex-when-supplied-AND-ready
 *
 * No network: both helpers are pure (env read + a `ready()` call on the
 * supplied stub). We build trivial in-memory Retriever stubs.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  vertexRagReady,
  selectRetriever,
  type Retriever,
} from "../src/rag/retriever";

const PROJECT = "GCP_PROJECT_ID";
const CORPUS = "VERTEX_RAG_CORPUS";
const ENABLED = "VERTEX_RAG_ENABLED";

function clearEnv(): void {
  delete process.env[PROJECT];
  delete process.env[CORPUS];
  delete process.env[ENABLED];
}

beforeEach(clearEnv);
afterEach(clearEnv);

/** A minimal Retriever stub with a controllable ready() flag. */
function stub(name: string, isReady: boolean): Retriever<string> {
  return {
    name,
    ready: () => isReady,
    retrieve: async () => [`${name}-chunk`],
  };
}

describe("vertexRagReady (flag + project + corpus gate)", () => {
  it("is false when nothing is set (atlas default)", () => {
    assert.strictEqual(vertexRagReady(), false);
  });

  it("is false when the flag is on but project + corpus are missing", () => {
    process.env[ENABLED] = "true";
    assert.strictEqual(vertexRagReady(), false);
  });

  it("is false when project + corpus are set but the flag is off", () => {
    process.env[PROJECT] = "p";
    process.env[CORPUS] = "c";
    assert.strictEqual(vertexRagReady(), false);
  });

  it("is false for a truthy-but-not-'true' flag value", () => {
    for (const v of ["1", "TRUE", "yes", "on"]) {
      clearEnv();
      process.env[ENABLED] = v;
      process.env[PROJECT] = "p";
      process.env[CORPUS] = "c";
      assert.strictEqual(
        vertexRagReady(),
        false,
        `flag value ${JSON.stringify(v)} must not flip readiness`,
      );
    }
  });

  it("is false when the corpus is missing even with flag + project", () => {
    process.env[ENABLED] = "true";
    process.env[PROJECT] = "p";
    assert.strictEqual(vertexRagReady(), false);
  });

  it("is false when the project is missing even with flag + corpus", () => {
    process.env[ENABLED] = "true";
    process.env[CORPUS] = "c";
    assert.strictEqual(vertexRagReady(), false);
  });

  it("is true only when flag='true' AND project AND corpus are all set", () => {
    process.env[ENABLED] = "true";
    process.env[PROJECT] = "p";
    process.env[CORPUS] = "c";
    assert.strictEqual(vertexRagReady(), true);
  });
});

describe("selectRetriever (atlas-default vs vertex-when-ready)", () => {
  it("returns atlas when no vertex retriever is supplied (current default)", () => {
    const atlas = stub("atlas", true);
    assert.strictEqual(selectRetriever(atlas), atlas);
  });

  it("returns atlas when vertex is supplied but reports NOT ready", () => {
    const atlas = stub("atlas", true);
    const vertex = stub("vertex-rag", false);
    assert.strictEqual(selectRetriever(atlas, vertex), atlas);
  });

  it("returns vertex when it is supplied AND reports ready", () => {
    const atlas = stub("atlas", true);
    const vertex = stub("vertex-rag", true);
    assert.strictEqual(selectRetriever(atlas, vertex), vertex);
  });

  it("returns atlas when vertex is explicitly undefined", () => {
    const atlas = stub("atlas", true);
    assert.strictEqual(selectRetriever(atlas, undefined), atlas);
  });

  it("the chosen retriever's retrieve() yields its own chunks", async () => {
    const atlas = stub("atlas", true);
    const vertex = stub("vertex-rag", true);
    const chosen = selectRetriever(atlas, vertex);
    assert.deepStrictEqual(await chosen.retrieve({ query: "q" }), [
      "vertex-rag-chunk",
    ]);
  });

  it("calls vertex.ready() to decide (gating is dynamic, not cached)", () => {
    const atlas = stub("atlas", true);
    let readyCalls = 0;
    const vertex: Retriever<string> = {
      name: "vertex-rag",
      ready: () => {
        readyCalls += 1;
        return false;
      },
      retrieve: async () => ["v"],
    };
    selectRetriever(atlas, vertex);
    assert.strictEqual(readyCalls, 1, "selectRetriever must consult ready()");
  });
});
