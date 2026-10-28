/**
 * Reading embedding ROWS (not vector-searching them). MONEY-1499 (B8).
 *
 * Two callers rank chunks in process with `cosineSimilarity` rather than
 * through `$vectorSearch`:
 *
 *   - `fetch-document-context.ts`'s fallback, when Atlas throws. That is not
 *     a dev-only path — in prod it is what stands between a `$vectorSearch`
 *     failure and an empty answer.
 *   - `user-document-retriever.ts`, always: a pinned set is a handful of
 *     documents, and the vector index's pre-filter does not declare `docId`.
 *
 * Both used `prisma.documentEmbedding.findMany({ select: { embedding: true } })`,
 * and that cannot work against v2 — the vector there is BSON BinData subtype 9,
 * which Prisma's `Bytes` scalar neither writes nor reads, and which
 * `DocumentEmbeddingV2` therefore does not declare at all. So this is the one
 * place the raw find and the int8 decode live, instead of two copies drifting
 * apart in two packages.
 */

import {
  decodeInt8Vector,
  fromEjsonBinary,
  int8ToCosineVector,
  readTarget,
  toNumberArray,
  type EmbeddingsMode,
} from "./embeddings-int8-logic";

export interface EmbeddingRow {
  readonly content: string;
  /**
   * Comparable with `cosineSimilarity` against a float query vector in BOTH
   * modes. Under v2 these are int8 magnitudes rather than the model's floats,
   * and that is sound because cosine is invariant to the positive per-vector
   * scale the quantization applied — see `embeddings-int8-logic.ts`.
   */
  readonly embedding: number[];
  readonly metadata: unknown;
  readonly docId: string | null;
  readonly docType: string;
}

export type RunCommandRaw = (cmd: Record<string, unknown>) => Promise<unknown>;

interface RawCursor {
  cursor?: {
    firstBatch?: Record<string, unknown>[];
    nextBatch?: Record<string, unknown>[];
    id?: unknown;
    ns?: string;
  };
}

/** `{ $numberLong: "0" }` or `0` — the serializer decides, and both mean done. */
function cursorId(v: unknown): string {
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const n = (v as { $numberLong?: unknown }).$numberLong;
    if (typeof n === "string" || typeof n === "number") return String(n);
  }
  return "0";
}

/**
 * Run a command that returns a cursor, and DRAIN it.
 *
 * A `find` through `$runCommandRaw` hands back `cursor.firstBatch`, which the
 * server caps at 101 documents (or 16 MB) regardless of the `limit` asked for.
 * Reading only that batch is how a request for 300 candidates silently becomes
 * 101 and a page of 500 silently becomes 101 — no error, no warning, just less
 * data. This repo has already paid for that once: MONEY-1189, where truncated
 * `firstBatch` reads manufactured gaps that looked like missing data.
 *
 * It also leaves the server-side cursor open until it times out. Draining
 * closes it.
 */
export async function drainCursor(
  raw: RunCommandRaw,
  command: Record<string, unknown>,
  collection: string,
  batchSize = 1000,
): Promise<Record<string, unknown>[]> {
  const first = (await raw({ ...command, batchSize })) as RawCursor;
  const out = [...(first.cursor?.firstBatch ?? [])];
  let id = cursorId(first.cursor?.id);
  while (id !== "0") {
    const next = (await raw({
      getMore: { $numberLong: id },
      collection,
      batchSize,
    })) as RawCursor;
    const batch = next.cursor?.nextBatch ?? [];
    out.push(...batch);
    const nextId = cursorId(next.cursor?.id);
    // A server that keeps handing back the same id with nothing in it would
    // spin for ever; stop rather than loop.
    if (batch.length === 0 && nextId === id) break;
    id = nextId;
  }
  return out;
}

/**
 * `find` against whichever collection the mode selects, decoding the vector.
 *
 * A row whose vector cannot be decoded is DROPPED rather than scored 0: a 0
 * would sort it last and look like a weak match, which is a lie about a row we
 * failed to read. The count of dropped rows is returned so a caller that cares
 * can say so.
 */
export async function findEmbeddingRows(
  raw: RunCommandRaw,
  args: {
    mode: EmbeddingsMode;
    filter: Record<string, unknown>;
    limit: number;
    projection?: Record<string, 1>;
  },
): Promise<{ rows: EmbeddingRow[]; undecodable: number }> {
  const target = readTarget(args.mode);
  const docs = await drainCursor(
    raw,
    {
      find: target.collection,
      filter: args.filter,
      projection: {
        content: 1,
        embedding: 1,
        metadata: 1,
        docId: 1,
        docType: 1,
        ...args.projection,
      },
      limit: args.limit,
    },
    target.collection,
  );

  const rows: EmbeddingRow[] = [];
  let undecodable = 0;
  for (const doc of docs) {
    const embedding = target.quantized
      ? decodeStored(doc.embedding)
      : toNumberArray(doc.embedding);
    if (!embedding || embedding.length === 0) {
      undecodable++;
      continue;
    }
    rows.push({
      content: typeof doc.content === "string" ? doc.content : "",
      embedding,
      metadata: doc.metadata ?? null,
      docId: typeof doc.docId === "string" ? doc.docId : null,
      docType: typeof doc.docType === "string" ? doc.docType : "",
    });
  }
  return { rows, undecodable };
}

function decodeStored(value: unknown): number[] | null {
  const payload = fromEjsonBinary(value);
  if (!payload) return null;
  const decoded = decodeInt8Vector(payload);
  return decoded.ok ? int8ToCosineVector(decoded.bytes) : null;
}
