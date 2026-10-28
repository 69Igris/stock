/**
 * `document_embeddings_v2`'s shape, and who is allowed to write v1 — MONEY-1499.
 *
 * Two guards, both against defects that produce NO ERROR:
 *
 *   1. If `DocumentEmbeddingV2` ever declares `embedding`, Prisma will write
 *      it as BSON binary subtype 0. Atlas does not treat subtype 0 as a
 *      vector, so `mongot` indexes nothing — the collection still shrinks, the
 *      index still builds, `collStats` still passes B8's footprint criterion,
 *      and retrieval returns zero rows.
 *   2. If a new writer calls `prisma.documentEmbedding.upsert/create/delete`
 *      without also going through the v2 helpers, its rows exist in v1 alone.
 *      Before the cut-over that is a tail the backfill never sees; after it,
 *      v1 has been renamed away and Mongo silently CREATES a fresh empty
 *      `document_embeddings` for the write to land in, for ever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..");

const SCHEMA = readFileSync(
  join(ROOT, "packages", "database", "prisma", "schema.prisma"),
  "utf8",
);

function modelBlock(name: string): string {
  const start = SCHEMA.indexOf(`model ${name} {`);
  assert.notEqual(start, -1, `model ${name} not found in schema.prisma`);
  const end = SCHEMA.indexOf("\n}", start);
  return SCHEMA.slice(start, end);
}

describe("DocumentEmbeddingV2", () => {
  const block = modelBlock("DocumentEmbeddingV2");

  it("does NOT declare `embedding` — Prisma cannot write BSON subtype 9", () => {
    assert.equal(
      /^\s*embedding\s/m.test(block),
      false,
      "the vector is written and read as extended JSON through $runCommandRaw; " +
        "declaring it here makes Prisma write subtype 0, which Atlas will not index",
    );
  });

  it("maps to `document_embeddings_v2` and keeps v1's business key", () => {
    assert.match(block, /@@map\("document_embeddings_v2"\)/);
    assert.match(block, /@@unique\(\[userId, docType, docId, chunkId\]\)/);
  });

  it("keeps `content` INLINE — B0 deferred the chunk store, it is not a gap", () => {
    // docs/reference/embeddings-decision-2026-09.md §2: the vector is
    // 33.56 GiB and the text 10.68, so quantizing is 29.4 of the 39.0 GiB
    // available. Moving the text out costs a GCS round trip on a path that
    // runs inside a chat turn, for the remaining 9.6.
    assert.match(block, /^\s*content\s+String/m);
    assert.equal(/contentRef/.test(block), false);
  });

  it("cascades on user deletion, exactly as v1 does", () => {
    assert.match(block, /onDelete:\s*Cascade/);
    assert.match(modelBlock("DocumentEmbedding"), /onDelete:\s*Cascade/);
  });
});

describe("every v1 WRITER also reaches v2", () => {
  const WRITE_CALL =
    /prisma\.documentEmbedding\.(upsert|create|createMany|delete|deleteMany|updateMany|update)\b/;
  const V2_IMPORT = /@usemoney\/core\/embeddings-v2-write/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (
        ["node_modules", ".next", "dist", ".turbo", "__tests__"].includes(entry)
      )
        continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
    }
    return out;
  }

  it("has no write to `document_embeddings` in a file that cannot write v2", () => {
    const files = [
      ...walk(join(ROOT, "apps", "web", "lib")),
      ...walk(join(ROOT, "packages", "research", "src")),
      ...walk(join(ROOT, "workers", "src")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!WRITE_CALL.test(src)) continue;
      if (!V2_IMPORT.test(src)) offenders.push(file.slice(ROOT.length + 1));
    }
    assert.deepEqual(
      offenders,
      [],
      "these files write v1 embeddings and never touch v2 — after the rename " +
        "their writes land in a fresh empty collection nobody reads",
    );
  });

  it("finds the writers it is supposed to be guarding (the scan is not inert)", () => {
    // A scan that matches nothing passes for ever. This is the floor: if the
    // population drops to zero, the guard above has stopped meaning anything.
    const files = [
      ...walk(join(ROOT, "apps", "web", "lib")),
      ...walk(join(ROOT, "workers", "src")),
    ];
    const writers = files.filter((f) =>
      WRITE_CALL.test(readFileSync(f, "utf8")),
    );
    assert.ok(
      writers.length >= 3,
      `expected at least 3 v1 writers, found ${writers.length}`,
    );
  });
});
