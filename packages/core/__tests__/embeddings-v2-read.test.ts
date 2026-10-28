/**
 * Reading embedding rows out of either collection — MONEY-1499 (B8).
 *
 * The cursor drain is here because `$runCommandRaw` on a `find` returns
 * `cursor.firstBatch`, which the server caps at 101 documents whatever `limit`
 * asked for. Reading only that batch turns a request for 300 candidates into
 * 101 with no error — the truncation class MONEY-1189 already paid for, where
 * it manufactured gaps that looked like missing data.
 *
 * The loop's EXIT is tested as carefully as its progress: an unbounded loop
 * whose condition can never be true has run for days in this repo before.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeInt8Vector,
  quantizeInt8,
  toEjsonBinary,
  EXPECTED_DIMS,
} from "../src/embeddings-int8-logic";
import { drainCursor, findEmbeddingRows } from "../src/embeddings-v2-read";

type Cmd = Record<string, unknown>;

/** A fake server that hands back `pages` in order, then closes the cursor. */
function server(
  pages: Record<string, unknown>[][],
  idSpelling: "long" | "number" = "long",
) {
  const seen: Cmd[] = [];
  let i = 0;
  const id = (n: number) =>
    idSpelling === "long" ? { $numberLong: String(n) } : n;
  const raw = async (cmd: Cmd) => {
    seen.push(cmd);
    const page = pages[i] ?? [];
    const more = i < pages.length - 1;
    i++;
    return i === 1
      ? { cursor: { firstBatch: page, id: id(more ? 42 : 0) } }
      : { cursor: { nextBatch: page, id: id(more ? 42 : 0) } };
  };
  return { raw, seen };
}

const vector = (seed: number): number[] =>
  Array.from(
    { length: EXPECTED_DIMS },
    (_, i) => Math.sin(seed * (i + 1)) / 10,
  );

function binaryFor(seed: number) {
  const q = quantizeInt8(vector(seed));
  assert.equal(q.ok, true);
  if (!q.ok) throw new Error("unreachable");
  return toEjsonBinary(encodeInt8Vector(q.bytes));
}

describe("drainCursor", () => {
  it("collects EVERY batch, not just the first", () => {
    const { raw } = server([[{ n: 1 }, { n: 2 }], [{ n: 3 }], [{ n: 4 }]]);
    return drainCursor(raw, { find: "c" }, "c").then((rows) => {
      assert.deepEqual(
        rows.map((r) => r.n),
        [1, 2, 3, 4],
      );
    });
  });

  it("stops at cursor id 0 without a further getMore", async () => {
    const { raw, seen } = server([[{ n: 1 }]]);
    await drainCursor(raw, { find: "c" }, "c");
    assert.equal(seen.length, 1);
    assert.equal("getMore" in seen[0]!, false);
  });

  it("reads the id in either spelling — the serializer is not load-bearing", async () => {
    for (const spelling of ["long", "number"] as const) {
      const { raw } = server([[{ n: 1 }], [{ n: 2 }]], spelling);
      const rows = await drainCursor(raw, { find: "c" }, "c");
      assert.equal(rows.length, 2, `${spelling} spelling truncated`);
    }
  });

  it("asks for a batchSize, so the server does not cap the first batch at 101", async () => {
    const { raw, seen } = server([[]]);
    await drainCursor(raw, { find: "c" }, "c", 500);
    assert.equal(seen[0]!.batchSize, 500);
  });

  it("TERMINATES against a server that keeps returning the same non-zero id", async () => {
    // A loop whose exit can never be reached is a loop that runs until
    // something else kills it. This one leaves rather than spins.
    let calls = 0;
    const raw = async (cmd: Cmd) => {
      calls++;
      if (calls > 50) throw new Error("drainCursor did not terminate");
      return "getMore" in cmd
        ? { cursor: { nextBatch: [], id: { $numberLong: "7" } } }
        : { cursor: { firstBatch: [{ n: 1 }], id: { $numberLong: "7" } } };
    };
    const rows = await drainCursor(raw, { find: "c" }, "c");
    assert.deepEqual(
      rows.map((r) => r.n),
      [1],
    );
    assert.equal(calls, 2, "one find plus one getMore, then it gave up");
  });

  it("names the collection on the getMore — the command requires it", async () => {
    const { raw, seen } = server([[{ n: 1 }], [{ n: 2 }]]);
    await drainCursor(raw, { find: "things" }, "things");
    assert.equal(seen[1]!.collection, "things");
  });
});

describe("findEmbeddingRows", () => {
  it("reads v1's float array under off/dual", async () => {
    const { raw, seen } = server([
      [
        {
          content: "a",
          embedding: vector(1),
          docId: "d1",
          docType: "document",
          metadata: null,
        },
      ],
    ]);
    const { rows, undecodable } = await findEmbeddingRows(raw, {
      mode: "off",
      filter: {},
      limit: 10,
    });
    assert.equal(seen[0]!.find, "document_embeddings");
    assert.equal(undecodable, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.embedding.length, EXPECTED_DIMS);
    assert.equal(rows[0]!.docId, "d1");
    assert.equal(rows[0]!.docType, "document");
  });

  it("decodes v2's int8 BinData under on, from the v2 collection", async () => {
    const { raw, seen } = server([
      [
        {
          content: "a",
          embedding: binaryFor(1),
          docId: null,
          docType: "annual_report",
        },
      ],
    ]);
    const { rows, undecodable } = await findEmbeddingRows(raw, {
      mode: "on",
      filter: {},
      limit: 10,
    });
    assert.equal(seen[0]!.find, "document_embeddings_v2");
    assert.equal(undecodable, 0);
    assert.equal(rows[0]!.embedding.length, EXPECTED_DIMS);
    // Comparable with a float query vector: cosine is invariant to the
    // positive per-vector scale the quantization applied.
    assert.ok(rows[0]!.embedding.some((x) => x !== 0));
  });

  it("DROPS an undecodable row and COUNTS it, rather than scoring it 0", async () => {
    // A 0 would sort last and read as a weak match — a lie about a row we
    // failed to read at all.
    const { raw } = server([
      [
        { content: "good", embedding: binaryFor(1) },
        {
          content: "wrong subtype/shape",
          embedding: { $binary: { base64: "AAA=", subType: "00" } },
        },
        { content: "missing", embedding: null },
      ],
    ]);
    const { rows, undecodable } = await findEmbeddingRows(raw, {
      mode: "on",
      filter: {},
      limit: 10,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.content, "good");
    assert.equal(undecodable, 2);
  });

  it("always projects the fields both callers rank on", async () => {
    const { raw, seen } = server([[]]);
    await findEmbeddingRows(raw, { mode: "off", filter: {}, limit: 1 });
    assert.deepEqual(seen[0]!.projection, {
      content: 1,
      embedding: 1,
      metadata: 1,
      docId: 1,
      docType: 1,
    });
  });
});
