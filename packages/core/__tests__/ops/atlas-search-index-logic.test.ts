/**
 * The Atlas search-index manifest and its planner — MONEY-1499 (B8).
 *
 * The manifest is the point of the ticket: `document_embeddings_vector_index`
 * existed ONLY in the Atlas UI, so there was no diff, no review and no way to
 * recreate it. These tests read the REAL shipped file, not a fixture — a
 * manifest that parses in a test and not in production would be the same
 * defect one layer up.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT_DRIFT,
  definitionsEqual,
  parseIndexManifest,
  planIndex,
  validateSpec,
  verdictFor,
  type IndexSpec,
} from "../../src/ops/atlas-search-index-logic";

/**
 * Resolved from THIS FILE, not from `process.cwd()` — `cwd` is the workspace
 * when turbo runs the suite and the repo root when a single file is run by
 * hand, and a path that is right in only one of those is a test that passes
 * locally and fails in CI (or the reverse, which is worse).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "ops",
  "atlas-search-indexes.json",
);

function loadManifest(): IndexSpec[] {
  return parseIndexManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
}

const V2_DEF = {
  fields: [
    {
      type: "vector",
      path: "embedding",
      numDimensions: 768,
      similarity: "cosine",
    },
    { type: "filter", path: "userId" },
    { type: "filter", path: "docType" },
  ],
};

const SPEC: IndexSpec = {
  collection: "document_embeddings_v2",
  name: "document_embeddings_v2_vector_index",
  type: "vectorSearch",
  manage: "apply",
  dtype: "int8",
  definition: V2_DEF,
};

describe("the SHIPPED manifest", () => {
  it("parses, and every declared index validates", () => {
    const specs = loadManifest();
    assert.ok(specs.length >= 2);
    for (const spec of specs) {
      assert.deepEqual(validateSpec(spec), [], `${spec.name} did not validate`);
    }
  });

  it("declares v1 as verify-only — the live 67 GiB index is never rebuilt by a script", () => {
    const v1 = loadManifest().find(
      (s) => s.collection === "document_embeddings",
    );
    assert.ok(v1, "v1's index must be declared, even though it is not managed");
    assert.equal(v1.manage, "verify-only");
  });

  it("declares NO quantization on the v2 index — the silent-skip trap", () => {
    // Atlas silently ignores a pre-quantized vector when the index asks for
    // automatic quantization. The collection would still shrink and the index
    // would still build; retrieval would simply return nothing.
    const v2 = loadManifest().find(
      (s) => s.collection === "document_embeddings_v2",
    );
    assert.ok(v2);
    assert.equal(v2.dtype, "int8");
    for (const f of v2.definition.fields) {
      assert.equal(
        f.quantization,
        undefined,
        "v2 must declare no quantization",
      );
    }
  });

  it("keeps v2 on the SAME similarity and dimensions as v1, so parity is about the vector alone", () => {
    const specs = loadManifest();
    const vectorField = (name: string) =>
      specs
        .find((s) => s.collection === name)!
        .definition.fields.find((f) => f.type === "vector")!;
    const v1 = vectorField("document_embeddings");
    const v2 = vectorField("document_embeddings_v2");
    assert.equal(v1.similarity, v2.similarity);
    assert.equal(v1.numDimensions, v2.numDimensions);
  });
});

describe("parseIndexManifest REFUSES rather than defaults", () => {
  const good = { indexes: [SPEC] };

  it("rejects an unrecognised `manage`", () => {
    assert.throws(
      () => parseIndexManifest({ indexes: [{ ...SPEC, manage: "maybe" }] }),
      /manage/,
    );
  });

  it("rejects an unrecognised `dtype`", () => {
    assert.throws(
      () => parseIndexManifest({ indexes: [{ ...SPEC, dtype: "int4" }] }),
      /dtype/,
    );
  });

  it("rejects a missing collection, name, type or fields", () => {
    for (const bad of [
      { ...SPEC, collection: "" },
      { ...SPEC, name: undefined },
      { ...SPEC, type: "search" },
      { ...SPEC, definition: { fields: [] } },
    ]) {
      assert.throws(() => parseIndexManifest({ indexes: [bad] }));
    }
  });

  it("rejects an empty or absent `indexes`", () => {
    assert.throws(() => parseIndexManifest({}), /indexes/);
    assert.throws(() => parseIndexManifest({ indexes: [] }), /indexes/);
  });

  it("accepts the good one", () => {
    assert.equal(parseIndexManifest(good).length, 1);
  });
});

describe("validateSpec", () => {
  it("catches quantization over an int8 collection", () => {
    const problems = validateSpec({
      ...SPEC,
      definition: {
        fields: [{ ...V2_DEF.fields[0], quantization: "scalar" }],
      },
    });
    assert.ok(problems.some((p) => /SILENTLY SKIP/.test(p)));
  });

  it("catches a definition with no vector field at all", () => {
    const problems = validateSpec({
      ...SPEC,
      definition: { fields: [{ type: "filter", path: "userId" }] },
    });
    assert.ok(problems.some((p) => /no field of type "vector"/.test(p)));
  });
});

describe("planIndex — four states, and `drift` is not a flavour of `update`", () => {
  const live = { name: SPEC.name, latestDefinition: V2_DEF, queryable: true };

  it("creates what is absent and no-ops what matches", () => {
    assert.equal(planIndex(SPEC, null).action, "create");
    assert.equal(planIndex(SPEC, live).action, "noop");
  });

  it("updates a managed index whose definition differs", () => {
    const changed = { ...live, latestDefinition: { fields: [] } };
    assert.equal(planIndex(SPEC, changed).action, "update");
  });

  it("NEVER writes a verify-only index, in either direction", () => {
    const vo: IndexSpec = { ...SPEC, manage: "verify-only" };
    // Absent on the cluster: still not created.
    assert.equal(planIndex(vo, null).action, "drift");
    // Different on the cluster: reported, not corrected.
    assert.equal(
      planIndex(vo, { ...live, latestDefinition: { fields: [] } }).action,
      "drift",
    );
    assert.equal(planIndex(vo, live).action, "noop");
  });

  it("is order-insensitive across the field array", () => {
    const reordered = {
      fields: [V2_DEF.fields[2], V2_DEF.fields[0], V2_DEF.fields[1]],
    };
    assert.equal(definitionsEqual(V2_DEF, reordered), true);
    assert.equal(
      definitionsEqual(V2_DEF, { fields: [V2_DEF.fields[0]] }),
      false,
    );
  });
});

describe("verdictFor", () => {
  it("exits 3 on drift and 0 otherwise", () => {
    const drift = planIndex({ ...SPEC, manage: "verify-only" }, null);
    const noop = planIndex(SPEC, { name: SPEC.name, latestDefinition: V2_DEF });
    assert.equal(verdictFor([noop]).exitCode, 0);
    assert.equal(verdictFor([noop, drift]).exitCode, EXIT_DRIFT);
  });

  it("counts a CREATE as a write, not as drift", () => {
    const create = planIndex(SPEC, null);
    const v = verdictFor([create]);
    assert.equal(v.exitCode, 0);
    assert.match(v.summary, /1 to write/);
  });
});
