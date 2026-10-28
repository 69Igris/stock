/**
 * Writing and deleting `document_embeddings_v2`. MONEY-1499 (B8).
 *
 * ## Why a writer exists at all, when the ticket only named readers
 *
 * B0 re-measured v1 mid-afternoon and found it had grown 86,594 rows since
 * the morning (docs/reference/embeddings-decision-2026-09.md, "The collection
 * is growing WHILE B8 would run"). A read-then-write migration over a moving
 * collection has to say what happens to rows written after its cursor passes,
 * and there are exactly two answers: dual-write, or a permanent tail.
 *
 * Worse is the far side of the cut-over. Once v1 has been RENAMED to
 * `document_embeddings_v1_retired`, a `prisma.documentEmbedding.upsert` does
 * not fail — MongoDB creates `document_embeddings` on first write. So an
 * un-migrated writer would quietly refill an empty collection nobody reads,
 * for ever, with no error and no counter moving anywhere. Hence
 * `writeTargets(mode)`: `off` -> v1, `dual` -> both, `on` -> v2 only.
 *
 * DELETES matter more than writes and are easy to forget. A user deleting a
 * document must have their chunks removed from BOTH collections while both
 * exist; deleting from v1 alone leaves the text and its vector live in v2 and
 * retrievable. That is a privacy defect, not a consistency one, which is why
 * `deleteEmbeddingsV2` exists beside the upsert rather than being deferred.
 *
 * ## Why this is raw rather than Prisma
 *
 * The vector is BSON BinData subtype 9. Prisma's `Bytes` scalar writes subtype
 * 0, Atlas does not treat subtype 0 as a vector, and `DocumentEmbeddingV2`
 * therefore does not declare the field. Everything here goes through
 * `$runCommandRaw` in extended JSON, the same transport the `$vectorSearch`
 * stage already uses.
 */

import { createHash } from "node:crypto";
import {
  EXPECTED_DIMS,
  V2_COLLECTION,
  encodeInt8Vector,
  quantizeInt8,
  toEjsonBinary,
  type QuantizeRefusal,
} from "./embeddings-int8-logic";

export type RunCommandRaw = (cmd: Record<string, unknown>) => Promise<unknown>;

export interface EmbeddingUpsert {
  readonly userId: string;
  readonly docType: string;
  readonly docId: string | null;
  readonly chunkId: number;
  readonly content: string;
  readonly embedding: number[];
  readonly embeddingModel: string;
  readonly metadata?: unknown;
}

export interface V2WriteResult {
  readonly written: number;
  /** Rows whose vector could not be quantized, with the reason NAMED. */
  readonly refused: ReadonlyArray<{ key: string; reason: QuantizeRefusal }>;
}

const sha256 = (s: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(s).digest());

/**
 * Upsert on the SAME business key as v1 — `(userId, docType, docId, chunkId)`.
 *
 * `docId` is written as an explicit `null` rather than omitted: it is part of
 * a unique index, and to MongoDB an absent field and a null field are
 * different documents, so omitting it would create a second row for the same
 * logical chunk.
 */
export async function upsertEmbeddingsV2(
  raw: RunCommandRaw,
  rows: readonly EmbeddingUpsert[],
  now: Date = new Date(),
): Promise<V2WriteResult> {
  const refused: { key: string; reason: QuantizeRefusal }[] = [];
  const updates: Record<string, unknown>[] = [];
  const iso = now.toISOString();

  for (const row of rows) {
    const q = quantizeInt8(row.embedding);
    if (!q.ok) {
      refused.push({
        key: `${row.userId}/${row.docType}/${row.docId ?? "null"}/${row.chunkId}`,
        reason: q.reason,
      });
      continue;
    }
    updates.push({
      q: {
        userId: { $oid: row.userId },
        docType: row.docType,
        docId: row.docId,
        chunkId: row.chunkId,
      },
      u: {
        $set: {
          content: row.content,
          contentSha: toEjsonBinary(sha256(row.content), "00"),
          embedding: toEjsonBinary(encodeInt8Vector(q.bytes)),
          embeddingModel: row.embeddingModel,
          dims: EXPECTED_DIMS,
          metadata: row.metadata ?? null,
          updatedAt: { $date: iso },
        },
        $setOnInsert: { createdAt: { $date: iso } },
      },
      upsert: true,
    });
  }

  if (updates.length === 0) return { written: 0, refused };

  // `ordered: false` so one bad row cannot abandon the rest of a batch.
  const res = (await raw({
    update: V2_COLLECTION,
    updates,
    ordered: false,
  })) as {
    n?: number;
    writeErrors?: { errmsg?: string }[];
  };
  if (res.writeErrors && res.writeErrors.length > 0) {
    throw new Error(
      `v2 upsert failed: ${res.writeErrors[0]?.errmsg ?? "unknown"}`,
    );
  }
  return {
    written: typeof res.n === "number" ? res.n : updates.length,
    refused,
  };
}

/**
 * Delete from v2 with a RAW filter.
 *
 * The caller passes extended JSON, because `userId` is an ObjectId and a
 * string there matches nothing — silently, and in the one direction that
 * matters: a delete that matches nothing reports success and leaves the rows
 * live. `oid()` below is the only correct spelling and is exported so no call
 * site has to remember it.
 */
export async function deleteEmbeddingsV2(
  raw: RunCommandRaw,
  filter: Record<string, unknown>,
): Promise<number> {
  const res = (await raw({
    delete: V2_COLLECTION,
    deletes: [{ q: filter, limit: 0 }],
  })) as { n?: number };
  return typeof res.n === "number" ? res.n : 0;
}

/** An ObjectId in extended JSON. See the note on `deleteEmbeddingsV2`. */
export function oid(id: string): { $oid: string } {
  return { $oid: id };
}
