/**
 * int8 BinData vectors — MONEY-1499 (data-platform B8).
 *
 * The properties here are the ones the whole migration rests on, and every one
 * of them fails SILENTLY in production if it is wrong: a wrong subtype is
 * simply not indexed, `quantization: "scalar"` over int8 makes Atlas skip
 * every vector, and a quantization that does not preserve cosine ORDER
 * produces a search that answers plausibly and ranks wrongly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertObjectIdFilters,
  EXPECTED_DIMS,
  V1_COLLECTION,
  V1_INDEX,
  V2_COLLECTION,
  V2_INDEX,
  buildV2Document,
  buildRefusalDocument,
  buildVectorSearchStage,
  checkRenameReady,
  checkVectorIndexField,
  decodeInt8Vector,
  encodeInt8Vector,
  fromEjsonBinary,
  int8ToCosineVector,
  migrateRow,
  quantizeInt8,
  readTarget,
  resolveEmbeddingsMode,
  shouldAbortForRefusals,
  toEjsonBinary,
  toEjsonQueryVector,
  toNumberArray,
  writeTargets,
} from "../src/embeddings-int8-logic";

/** Deterministic pseudo-random 768-dim vector, no dependency on Math.random. */
function vec(seed: number, dims = EXPECTED_DIMS): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < dims; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push((s / 2147483648 - 0.5) * 0.2);
  }
  return out;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("quantizeInt8 — the transform cosine has to survive", () => {
  it("round-trips through the BSON vector payload unchanged", () => {
    const q = quantizeInt8(vec(1));
    assert.equal(q.ok, true);
    if (!q.ok) return;
    const payload = encodeInt8Vector(q.bytes);
    // header + data, and the header is the int8 dtype with zero padding.
    assert.equal(payload.length, EXPECTED_DIMS + 2);
    assert.equal(payload[0], 0x03);
    assert.equal(payload[1], 0);
    const back = decodeInt8Vector(payload);
    assert.equal(back.ok, true);
    if (!back.ok) return;
    assert.deepEqual(Array.from(back.bytes), Array.from(q.bytes));
  });

  it("PRESERVES cosine to within 1% — the claim the whole design rests on", () => {
    // If this drifts, retrieval still returns rows and still looks healthy; it
    // just ranks the wrong ones. There is no error to notice.
    for (const [a, b] of [
      [vec(1), vec(2)],
      [vec(7), vec(11)],
      [vec(101), vec(103)],
    ] as const) {
      const qa = quantizeInt8(a);
      const qb = quantizeInt8(b);
      assert.equal(qa.ok && qb.ok, true);
      if (!qa.ok || !qb.ok) return;
      const exact = cosine(a, b);
      const quantized = cosine(
        int8ToCosineVector(qa.bytes),
        int8ToCosineVector(qb.bytes),
      );
      assert.ok(
        Math.abs(exact - quantized) < 0.01,
        `cosine moved from ${exact} to ${quantized}`,
      );
    }
  });

  it("is INVARIANT to a positive rescale, which is why no scale is stored", () => {
    const base = vec(5);
    const scaled = base.map((x) => x * 37.5);
    const qa = quantizeInt8(base);
    const qb = quantizeInt8(scaled);
    assert.equal(qa.ok && qb.ok, true);
    if (!qa.ok || !qb.ok) return;
    assert.deepEqual(Array.from(qa.bytes), Array.from(qb.bytes));
  });

  it("keeps every component inside [-127, 127], symmetrically", () => {
    // This asserts the INVARIANT, not the clamp. Mutation-checked: removing
    // the clamp leaves the suite green, because at a per-vector max-abs scale
    // |q| can never exceed 127 and the clamp is unreachable. It stays in the
    // source as a saturation guard for a future scale change — and a scale
    // change IS caught, here and by the cosine test (mutation: a fixed scale
    // of 100000 fails both).
    //
    // -128 is the asymmetric end of int8, and it is the value that matters: a
    // component that overflowed would WRAP in an Int8Array to the opposite
    // sign, keeping its magnitude and reversing its direction.
    for (const seed of [1, 2, 3]) {
      const q = quantizeInt8(vec(seed));
      assert.equal(q.ok, true);
      if (!q.ok) return;
      const all = Array.from(q.bytes);
      assert.ok(
        all.every((b) => b >= -127 && b <= 127),
        "component out of range",
      );
      assert.ok(!all.includes(-128));
      // The extreme component maps to exactly one end of the range — which is
      // what makes the scale per-vector rather than global.
      assert.ok(Math.max(...all.map(Math.abs)) === 127);
    }
  });

  it("NAMES every refusal instead of coercing", () => {
    assert.deepEqual(quantizeInt8([]), { ok: false, reason: "EMPTY" });
    assert.deepEqual(quantizeInt8(null), { ok: false, reason: "EMPTY" });
    assert.deepEqual(quantizeInt8([1, 2, 3]), {
      ok: false,
      reason: "DIM_MISMATCH",
    });
    const withNaN = vec(3);
    withNaN[10] = Number.NaN;
    assert.deepEqual(quantizeInt8(withNaN), {
      ok: false,
      reason: "NON_FINITE",
    });
    const withInf = vec(3);
    withInf[10] = Number.POSITIVE_INFINITY;
    assert.deepEqual(quantizeInt8(withInf), {
      ok: false,
      reason: "NON_FINITE",
    });
    assert.deepEqual(quantizeInt8(new Array(EXPECTED_DIMS).fill(0)), {
      ok: false,
      reason: "ZERO_VECTOR",
    });
  });

  it("refuses a payload whose dtype byte is not int8", () => {
    const float32ish = new Uint8Array([0x27, 0, 1, 2, 3, 4]);
    const r = decodeInt8Vector(float32ish);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /not int8/);
  });
});

describe("extended JSON — the transport", () => {
  it("stamps subtype 09 on a vector and 00 on anything else", () => {
    const q = quantizeInt8(vec(1));
    assert.equal(q.ok, true);
    if (!q.ok) return;
    assert.equal(
      toEjsonBinary(encodeInt8Vector(q.bytes)).$binary.subType,
      "09",
    );
    assert.equal(
      toEjsonBinary(new Uint8Array([1, 2, 3]), "00").$binary.subType,
      "00",
    );
  });

  it("round-trips base64 back to the same bytes", () => {
    const payload = new Uint8Array([3, 0, 9, 250, 1]);
    const back = fromEjsonBinary(toEjsonBinary(payload));
    assert.deepEqual(back ? Array.from(back) : null, Array.from(payload));
  });

  it("returns null rather than throwing on anything that is not a binary", () => {
    for (const v of [null, undefined, 42, "x", {}, { $binary: {} }]) {
      assert.equal(fromEjsonBinary(v), null);
    }
  });
});

describe("toNumberArray — relaxed OR canonical extended JSON", () => {
  it("accepts plain numbers", () => {
    assert.deepEqual(toNumberArray([1, 2.5, -3]), [1, 2.5, -3]);
  });

  it("accepts the canonical spellings, so the serializer is not load-bearing", () => {
    assert.deepEqual(
      toNumberArray([
        { $numberDouble: "0.25" },
        { $numberInt: "3" },
        { $numberLong: "7" },
      ]),
      [0.25, 3, 7],
    );
  });

  it("returns null for a non-array or an unreadable element", () => {
    assert.equal(toNumberArray("nope"), null);
    assert.equal(toNumberArray([1, { $oid: "abc" }]), null);
  });
});

describe("checkVectorIndexField — the SILENT failures", () => {
  const base = { type: "vector", path: "embedding", numDimensions: 768 };

  it("REFUSES automatic quantization over int8 — Atlas would skip every vector", () => {
    const r = checkVectorIndexField(
      { ...base, similarity: "cosine", quantization: "scalar" },
      { dtype: "int8", dims: 768 },
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.problems.some((p) => /SILENTLY SKIP/.test(p)));
  });

  it("ACCEPTS cosine for int8 — the gate B0 left open", () => {
    // The vendor's own supported-similarity table: binData(int8) takes
    // cosine, euclidean and dotProduct. If this ever flips, the migration
    // needs a normalization pass and a read-path change in three files.
    for (const similarity of ["cosine", "euclidean", "dotProduct"]) {
      assert.deepEqual(
        checkVectorIndexField(
          { ...base, similarity },
          { dtype: "int8", dims: 768 },
        ),
        { ok: true },
      );
    }
  });

  it("holds int1 to euclidean ONLY", () => {
    assert.deepEqual(
      checkVectorIndexField(
        { ...base, similarity: "euclidean", numDimensions: 768 },
        { dtype: "int1", dims: 768 },
      ),
      { ok: true },
    );
    const r = checkVectorIndexField(
      { ...base, similarity: "cosine" },
      { dtype: "int1", dims: 768 },
    );
    assert.equal(r.ok, false);
  });

  it("reports EVERY problem, not just the first", () => {
    const r = checkVectorIndexField(
      {
        type: "filter",
        path: "wrong",
        numDimensions: 1,
        similarity: "nope",
        quantization: "binary",
      },
      { dtype: "int8", dims: 768, path: "embedding" },
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(
      r.problems.length >= 5,
      `only ${r.problems.length} problems reported`,
    );
  });

  it("still allows scalar/binary quantization over FLOAT vectors", () => {
    assert.deepEqual(
      checkVectorIndexField(
        { ...base, similarity: "cosine", quantization: "scalar" },
        { dtype: "array", dims: 768 },
      ),
      { ok: true },
    );
  });
});

describe("the cut-over flag", () => {
  it("fails safe to off for anything unrecognised", () => {
    for (const v of [
      undefined,
      null,
      "",
      "ON",
      "true",
      1,
      {},
      { mode: "yes" },
      [],
    ]) {
      assert.equal(
        resolveEmbeddingsMode(v),
        "off",
        `${JSON.stringify(v)} must resolve off`,
      );
    }
  });

  it("reads both a bare string and a { mode } object", () => {
    assert.equal(resolveEmbeddingsMode("dual"), "dual");
    assert.equal(resolveEmbeddingsMode("on"), "on");
    assert.equal(resolveEmbeddingsMode({ mode: "on" }), "on");
  });

  it("routes reads and writes per mode — and `on` STOPS writing v1", () => {
    assert.deepEqual(readTarget("off"), {
      collection: V1_COLLECTION,
      index: V1_INDEX,
      quantized: false,
    });
    assert.deepEqual(readTarget("dual"), {
      collection: V1_COLLECTION,
      index: V1_INDEX,
      quantized: false,
    });
    assert.deepEqual(readTarget("on"), {
      collection: V2_COLLECTION,
      index: V2_INDEX,
      quantized: true,
    });
    assert.deepEqual(writeTargets("off"), ["v1"]);
    assert.deepEqual(writeTargets("dual"), ["v1", "v2"]);
    // Load-bearing: after v1 is renamed away, a v1 write would silently
    // re-create an empty `document_embeddings` and fill it for ever.
    assert.deepEqual(writeTargets("on"), ["v2"]);
  });
});

describe("buildVectorSearchStage — one decision, three call sites", () => {
  const q = vec(9);

  it("sends a FLOAT ARRAY at the v1 index under off/dual", () => {
    for (const mode of ["off", "dual"] as const) {
      const s = buildVectorSearchStage({
        mode,
        queryVector: q,
        numCandidates: 72,
        limit: 18,
      });
      assert.ok(s);
      assert.equal(s.aggregate, V1_COLLECTION);
      const stage = s.stage.$vectorSearch as Record<string, unknown>;
      assert.equal(stage.index, V1_INDEX);
      assert.ok(Array.isArray(stage.queryVector));
    }
  });

  it("sends an int8 BinData at the v2 index under on", () => {
    const s = buildVectorSearchStage({
      mode: "on",
      queryVector: q,
      numCandidates: 72,
      limit: 18,
    });
    assert.ok(s);
    assert.equal(s.aggregate, V2_COLLECTION);
    const stage = s.stage.$vectorSearch as Record<string, unknown>;
    assert.equal(stage.index, V2_INDEX);
    const bin = (stage.queryVector as { $binary?: { subType?: string } })
      .$binary;
    assert.equal(bin?.subType, "09");
  });

  it("carries the filter through and omits it when absent", () => {
    // `{$oid}`, not the bare `{$eq:"u"}` this asserted until MONEY-1500. The
    // old fixture encoded the DEFECT as intended behaviour: a bare string is
    // carried through faithfully and then matches nothing at all, which is
    // precisely how the bug survived a test suite.
    const uid = { $oid: "000000000000000000000001" };
    const withFilter = buildVectorSearchStage({
      mode: "off",
      queryVector: q,
      numCandidates: 1,
      limit: 1,
      filter: { userId: uid },
    });
    assert.deepEqual(
      (withFilter!.stage.$vectorSearch as Record<string, unknown>).filter,
      { userId: uid },
    );
    const without = buildVectorSearchStage({
      mode: "off",
      queryVector: q,
      numCandidates: 1,
      limit: 1,
    });
    assert.ok(
      !("filter" in (without!.stage.$vectorSearch as Record<string, unknown>)),
    );
  });

  it("returns null under v2 when the query vector will not quantize", () => {
    assert.equal(
      buildVectorSearchStage({
        mode: "on",
        queryVector: [],
        numCandidates: 1,
        limit: 1,
      }),
      null,
    );
    assert.equal(toEjsonQueryVector([]), null);
  });
});

describe("migrateRow + the v2 document", () => {
  const sha = (s: string) => new Uint8Array([s.length & 0xff, 1, 2, 3]);

  it("refuses a row from another embedding space BY NAME", () => {
    assert.deepEqual(
      migrateRow(
        { _id: 1, embedding: vec(1), embeddingModel: "gemini-embedding-001" },
        { model: "text-embedding-004" },
      ),
      { ok: false, reason: "MODEL_MISMATCH" },
    );
  });

  it("treats a MISSING embeddingModel as the legacy default", () => {
    const r = migrateRow(
      { _id: 1, embedding: vec(1) },
      { model: "text-embedding-004" },
    );
    assert.equal(r.ok, true);
  });

  it("carries _id and userId VERBATIM and writes docId as an explicit null", () => {
    const q = quantizeInt8(vec(1));
    assert.equal(q.ok, true);
    if (!q.ok) return;
    const row = {
      _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaaaa" },
      userId: { $oid: "bbbbbbbbbbbbbbbbbbbbbbbb" },
      docType: "annual_report",
      content: "hello",
      chunkId: 4,
      createdAt: { $date: "2026-01-01T00:00:00Z" },
      updatedAt: { $date: "2026-01-02T00:00:00Z" },
    };
    const doc = buildV2Document(row, q.bytes, {
      model: "text-embedding-004",
      sha256: sha,
    });
    assert.deepEqual(doc._id, row._id);
    assert.deepEqual(doc.userId, row.userId);
    assert.deepEqual(doc.createdAt, row.createdAt);
    // ABSENT and null are different documents to a unique index.
    assert.equal(doc.docId, null);
    assert.ok("docId" in doc);
    assert.equal(doc.dims, EXPECTED_DIMS);
    assert.equal(
      (doc.embedding as { $binary: { subType: string } }).$binary.subType,
      "09",
    );
    assert.equal(
      (doc.contentSha as { $binary: { subType: string } }).$binary.subType,
      "00",
    );
  });

  it("records the refusal with the row's own shape, for the manifest", () => {
    const m = buildRefusalDocument(
      {
        _id: 1,
        userId: 2,
        docType: "drhp",
        embedding: [1, 2, 3],
        embeddingModel: "x",
      },
      "DIM_MISMATCH",
      "2026-09-22T00:00:00.000Z",
    );
    assert.equal(m.reason, "DIM_MISMATCH");
    assert.equal(m.dims, 3);
    assert.equal(m.docId, null);
  });
});

describe("shouldAbortForRefusals — a ceiling that cannot fire on noise", () => {
  it("does not judge before the sample means anything", () => {
    // 2 of 50 is 4%, over the 1% rate — and it must NOT abort. Comparing a
    // ratio before the population is meaningful is the same
    // not-measured-is-not-passed defect from the other side.
    assert.equal(shouldAbortForRefusals(50, 2), false);
    assert.equal(shouldAbortForRefusals(9_999, 9_999), false);
  });

  it("fires above 1% once the sample is big enough", () => {
    assert.equal(shouldAbortForRefusals(10_000, 101), true);
    assert.equal(shouldAbortForRefusals(10_000, 100), false);
    assert.equal(shouldAbortForRefusals(1_000_000, 0), false);
  });
});

describe("checkRenameReady — the one irreversible move", () => {
  const ok = {
    v1Count: 100,
    v2Count: 100,
    mode: "on" as const,
    armed: true,
    outstanding: 0,
    refusalCount: 0,
    acceptedRefusals: 0,
  };

  it("passes only when armed, cut over, and every v1 row is accounted for", () => {
    assert.deepEqual(checkRenameReady(ok), { ok: true });
    assert.deepEqual(checkRenameReady({ ...ok, v2Count: 105 }), { ok: true });
  });

  /**
   * MONEY-1499 review, F3 — the count comparison stops being a completeness
   * check the moment mode flips to "on".
   */
  it("REGRESSION: refuses while rows sit past the checkpoint, even when v2 > v1", () => {
    // The soak shape: mode "on" freezes v1 and v2 grows on live traffic, so
    // `v2Count >= v1Count` goes trivially true. B0 measured v1 gaining 86,594
    // rows in one afternoon, and the runbook waits SEVEN DAYS here.
    const soak = { ...ok, v1Count: 100, v2Count: 400_000, outstanding: 37 };
    const r = checkRenameReady(soak);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /37 v1 row\(s\) sit past the backfill/);
  });

  it("names the DUAL-WRITE cause, not just the count", () => {
    // A row written by the dual path after the checkpoint passed it is already
    // in v2 and still counts here. Refusing is right; misdiagnosing it as
    // un-migrated sends the operator looking for data loss that is not there.
    const r = checkRenameReady({ ...ok, outstanding: 5 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /run ONE MORE backfill pass/);
  });

  /**
   * MONEY-1499 review — the refusal budget. `REFUSAL_ABORT_RATE` lets a
   * COMPLETE backfill leave v2 legitimately smaller than v1, and the old rung
   * was wrong in both directions without a refusal term.
   */
  it("REGRESSION: a complete backfill WITH refusals is not refused for ever", () => {
    const withRefusals = {
      ...ok,
      v1Count: 100,
      v2Count: 90,
      refusalCount: 10,
      acceptedRefusals: 10,
    };
    assert.deepEqual(checkRenameReady(withRefusals), { ok: true });
  });

  it("REGRESSION: refused rows are not absorbed by live v2 growth", () => {
    // The other direction. Once v2 has overtaken v1 the old `v2 >= v1` rung had
    // no term that could see 10 refused rows — and after the rename the v1
    // vectors are gone.
    const r = checkRenameReady({
      ...ok,
      v1Count: 100,
      v2Count: 400_000,
      refusalCount: 10,
      acceptedRefusals: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /--accept-refusals=10/);
  });

  it("refuses when neither migrated nor refused accounts for every row", () => {
    const r = checkRenameReady({
      ...ok,
      v1Count: 100,
      v2Count: 80,
      refusalCount: 5,
      acceptedRefusals: 5,
    });
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.match(r.reason, /15 rows are neither migrated nor refused/);
  });

  /**
   * MONEY-1499 review — the earlier version of this case was VACUOUS: it
   * passed because `NaN !== 0` already refused, so deleting the finite check
   * left it green. The guard now covers EVERY count, and each one is pinned
   * separately because `NaN <= 0` and `NaN < NaN` are both false — two of the
   * three quantitative rungs used to stop evaluating in silence.
   */
  for (const field of [
    "v1Count",
    "v2Count",
    "outstanding",
    "refusalCount",
  ] as const) {
    it(`REGRESSION: a non-finite ${field} refuses, and says which`, () => {
      const r = checkRenameReady({ ...ok, [field]: Number.NaN });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.match(r.reason, new RegExp(field));
        assert.match(r.reason, /never a count of zero/);
      }
    });
  }

  it("refuses an unarmed run", () => {
    const r = checkRenameReady({ ...ok, armed: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not armed/);
  });

  it("refuses while any reader or writer is still on v1", () => {
    for (const mode of ["off", "dual"] as const) {
      const r = checkRenameReady({ ...ok, mode });
      assert.equal(r.ok, false, `mode ${mode} must refuse`);
    }
  });

  it("refuses a v1 count of zero rather than treating it as caught up", () => {
    // 0 >= 0 would otherwise pass, and a count that cannot be right must
    // never authorise the rename.
    const r = checkRenameReady({ ...ok, v1Count: 0, v2Count: 0 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /0 rows/);
  });
});

/**
 * MONEY-1500 — the bug this guard exists for shipped at FOUR call sites and
 * was invisible, because the wrong spelling returns an EMPTY result rather
 * than an error. Measured on prod 2026-09-22, same index, same query vector,
 * through `$runCommandRaw`:
 *
 *     filter userId as a STRING     ->  0 rows
 *     filter userId as {$oid: ...}  ->  6 rows
 *
 * So the research agent's filing context and EVERY user's own document search
 * had been returning nothing, silently, with each caller's `catch` never
 * firing and its fallback unreachable.
 */
describe("assertObjectIdFilters — MONEY-1500", () => {
  const OID = { $oid: "000000000000000000000001" };

  it("accepts both spellings mongot actually honours", () => {
    // Both returned 6 rows in the prod measurement, so both must pass.
    assertObjectIdFilters({ userId: OID });
    assertObjectIdFilters({ userId: { $eq: OID } });
  });

  it("REGRESSION: refuses the bare string that shipped", () => {
    assert.throws(
      () =>
        assertObjectIdFilters({ userId: { $eq: "000000000000000000000001" } }),
      /must be an ObjectId in extended JSON/,
    );
  });

  it("REGRESSION: refuses a bare string with no $eq wrapper either", () => {
    assert.throws(
      () => assertObjectIdFilters({ userId: "000000000000000000000001" }),
      /MONEY-1500/,
    );
  });

  it("names the offending value, so the fix is not a hunt", () => {
    assert.throws(
      () => assertObjectIdFilters({ userId: { $eq: "abc" } }),
      /"abc"/,
    );
  });

  it("ignores filters it has no rule for, and an absent filter", () => {
    // docType is a genuine string field — the guard must not overreach.
    assertObjectIdFilters({ docType: { $in: ["annual_report"] } });
    assertObjectIdFilters(undefined);
    assertObjectIdFilters({});
  });

  it("is wired INTO buildVectorSearchStage, not merely exported", () => {
    // A guard nothing calls is the shape this repo keeps shipping. Prove the
    // real entry point refuses, rather than trusting the helper in isolation.
    assert.throws(
      () =>
        buildVectorSearchStage({
          mode: "off",
          queryVector: new Array(768).fill(0.1),
          numCandidates: 72,
          limit: 6,
          filter: { userId: { $eq: "000000000000000000000001" } },
        }),
      /MONEY-1500/,
    );
    const ok = buildVectorSearchStage({
      mode: "off",
      queryVector: new Array(768).fill(0.1),
      numCandidates: 72,
      limit: 6,
      filter: { userId: OID },
    });
    assert.ok(ok, "the correct spelling must still build a stage");
  });
});
