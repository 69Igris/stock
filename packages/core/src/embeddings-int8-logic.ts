/**
 * int8 BinData vectors for Atlas Vector Search — MONEY-1499 (data-platform B8).
 *
 * PURE. No Mongo, no network, no env, no clock. The shells are
 * `scripts/jobs/embeddings-v2-backfill.ts` (the migration + rename + census),
 * `scripts/ops/apply-atlas-search-indexes.ts` (the index), and the three
 * readers.
 *
 * ## What this executes, and what it deliberately does NOT
 *
 * `docs/reference/embeddings-decision-2026-09.md` §5 (B0 / MONEY-1471, measured
 * 2026-09-17 against prod) chose ONE of the three levers it costed:
 *
 *   (a) BinData int8 for the vector     29.4 GiB of 39.0 GiB available  <- THIS
 *   (b) content out to a chunk store     9.6 GiB                         DEFERRED
 *   (c) a duplication prune              UNSIZED — the sample cannot see it
 *
 * The reason is §2, and it inverts the intuitive reading: the VECTOR is
 * 33.56 GiB and the TEXT is only 10.68 GiB. Every row carries a fixed 6,144 B
 * of float64 whether its `content` is 8 bytes or 5,867. So `content` STAYS
 * INLINE in v2 — the absence of a `contentRef` here is a decision, not an
 * omission, and re-adding one buys 9.6 GiB at the cost of a GCS round trip on
 * a path that runs INSIDE a chat turn under a p95 budget.
 *
 * ## The two facts from MongoDB's own docs that this file exists to enforce
 *
 * Both were read off
 * https://www.mongodb.com/docs/atlas/atlas-vector-search/ingest-quantized-vectors/
 * on 2026-09-22, and both are SILENT when violated:
 *
 * 1. "If you specify automatic quantization on data that is not an array of
 *    float values, MongoDB Vector Search silently ignores that vector instead
 *    of indexing it, and those vectors will be skipped."
 *
 *    So an index that keeps `quantization: "scalar"` over a collection we have
 *    just rewritten to int8 indexes NOTHING. The backfill reports success, the
 *    collection shrinks exactly as predicted, `collStats` passes the footprint
 *    criterion — and retrieval returns zero rows. `checkVectorIndexField`
 *    refuses that combination by name.
 *
 * 2. The vendor's "Supported Similarity method" table, per stored type:
 *
 *      binData(int1)    euclidean                      (euclidean ONLY)
 *      binData(int8)    cosine, euclidean, dotProduct
 *      binData(float32) cosine, euclidean, dotProduct
 *      array(double)    cosine, euclidean, dotProduct
 *
 *    This ANSWERS the gate B0 §5 left open ("Confirm before arming: similarity
 *    is cosine ... Atlas constrains which similarity functions accept an int8
 *    BinData vector"). cosine IS among them for int8, so there is no
 *    normalization pass and no move to dotProduct, and the read path keeps the
 *    similarity it has. The restriction B0 was reaching for is real but applies
 *    to int1.
 *
 * ## Why the scale is not stored
 *
 * Quantization here is SYMMETRIC per-vector max-abs: `q = round(v * 127 / max|v|)`.
 * That is a positive scalar multiple, and cosine is invariant to a positive
 * scalar multiple — so the scale cancels on both sides of every comparison and
 * nothing in this repo needs it back. Every consumer of this vector uses
 * cosine: Atlas's `similarity: "cosine"`, and the two in-process fallbacks that
 * call `cosineSimilarity`. Storing it would be 8 B x 5.9M for a number no
 * reader reads, and v1 is KEPT for 30 days as the recovery path for the float
 * values themselves. Per-vector (rather than global) max-abs is also the
 * choice that maximises int8 resolution per row, which per-vector cosine
 * invariance makes free.
 *
 * ASYMMETRIC (min/max + zero-point) quantization would NOT be cosine-invariant
 * — the offset survives the normalisation — so do not "improve" this to a
 * min/max scheme without moving the similarity function too.
 */

import { EMBEDDING_DIMENSIONS } from "./embeddings";

// ── Collections and indexes ────────────────────────────────────────────────

export const V1_COLLECTION = "document_embeddings";
export const V2_COLLECTION = "document_embeddings_v2";
/**
 * Where v1 goes at cut-over. B0 §6: "RENAMED to `document_embeddings_v1_retired`,
 * never dropped, and kept 30 days." Nothing in this repo drops it; the drop is
 * a founder action after the window.
 */
export const V1_RETIRED_COLLECTION = "document_embeddings_v1_retired";

/** The live index, until MONEY-1499 it existed ONLY in the Atlas UI. */
export const V1_INDEX = "document_embeddings_vector_index";
export const V2_INDEX = "document_embeddings_v2_vector_index";

/** The manifest of rows the migration REFUSED. Never a silent skip. */
export const REFUSAL_COLLECTION = "document_embeddings_v2_refusals";
/** The resumable cursor. One document. */
export const CHECKPOINT_COLLECTION = "document_embeddings_v2_backfill_state";
/**
 * The BinData-round-trip canary. A throwaway collection holding ONE synthetic
 * row, so the probe can prove the query path works without writing anything
 * into v2 — see `scripts/ops/apply-atlas-search-indexes.ts --probe`.
 */
export const PROBE_COLLECTION = "document_embeddings_v2_probe";
export const PROBE_INDEX = "document_embeddings_v2_probe_index";

export const EXPECTED_DIMS = EMBEDDING_DIMENSIONS;

/**
 * The embedding space v1 is in — 100% of a 20,000-row sample, B0 §1. A row in
 * any OTHER space is refused to the manifest rather than mixed into one index,
 * because an Atlas vector index cannot hold two spaces (see the
 * `USE_GEMINI_EMBEDDING_001` note on the Prisma model).
 */
export const DEFAULT_CORPUS_MODEL = "text-embedding-004";

// ── The BSON vector binary format ──────────────────────────────────────────

/** BSON binary subtype 9 = Vector. NOT 0 (generic), which is what Prisma's `Bytes` writes. */
export const VECTOR_BINARY_SUBTYPE = 9;
/** Extended-JSON spells the subtype as a two-hex-digit string. */
export const VECTOR_BINARY_SUBTYPE_HEX = "09";

/** Data-type byte 0 of a vector payload. */
export const VECTOR_DTYPE_INT8 = 0x03;
export const VECTOR_DTYPE_FLOAT32 = 0x27;
export const VECTOR_DTYPE_PACKED_BIT = 0x10;

export type VectorDtype = "int8" | "int1" | "float32" | "array";

/**
 * A vector payload is `[dtype, padding, ...data]`. `padding` is the number of
 * bits to ignore in the final byte and is 0 for everything except int1.
 */
const VECTOR_HEADER_BYTES = 2;

// ── Quantization ───────────────────────────────────────────────────────────

/**
 * Why -127 and not -128: int8 runs -128..127, which is asymmetric. Mapping
 * `+max` to +127 and `-max` to -128 would apply a slightly different scale to
 * the two halves of the range — a per-SIGN scale, which is exactly the
 * asymmetry the header warns cosine does not survive. Clamping to -127 costs
 * one representable value and keeps the transform a single positive scalar.
 */
const INT8_MAX = 127;

export type QuantizeRefusal =
  | "EMPTY"
  | "NON_FINITE"
  | "ZERO_VECTOR"
  | "DIM_MISMATCH";

export type QuantizeResult =
  | { readonly ok: true; readonly bytes: Int8Array }
  | { readonly ok: false; readonly reason: QuantizeRefusal };

/**
 * float -> int8, symmetric per-vector max-abs.
 *
 * Refuses rather than coercing, and NAMES the refusal, because every one of
 * these shapes is a row the caller must put in the manifest. A `NaN` coerced
 * to 0 and a zero vector accepted are both rows that would sit in v2 looking
 * like data and match nothing.
 */
export function quantizeInt8(
  v: readonly number[] | null | undefined,
  expectedDims: number = EXPECTED_DIMS,
): QuantizeResult {
  if (!v || v.length === 0) return { ok: false, reason: "EMPTY" };
  if (v.length !== expectedDims) return { ok: false, reason: "DIM_MISMATCH" };

  let max = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) return { ok: false, reason: "NON_FINITE" };
    const a = x < 0 ? -x : x;
    if (a > max) max = a;
  }
  if (max === 0) return { ok: false, reason: "ZERO_VECTOR" };

  const scale = INT8_MAX / max;
  const bytes = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const q = Math.round(v[i]! * scale);
    // `Math.round` of `max * 127/max` is exactly 127, but float error can put
    // one component a whole unit out; clamp rather than let Int8Array wrap
    // (-128 + 1 would silently become the far end of the range).
    bytes[i] = q > INT8_MAX ? INT8_MAX : q < -INT8_MAX ? -INT8_MAX : q;
  }
  return { ok: true, bytes };
}

/**
 * int8 -> a vector suitable for `cosineSimilarity`. It is `Array.from` and
 * that is the whole point: cosine is invariant to the positive scale this
 * quantization applied, so the ORIGINAL magnitudes are not needed to rank.
 * Named rather than inlined so the next reader finds this comment instead of
 * concluding the scale was lost by accident.
 */
export function int8ToCosineVector(bytes: Int8Array): number[] {
  return Array.from(bytes);
}

// ── Encoding to / from BSON ────────────────────────────────────────────────

/** `Int8Array` -> the BSON vector payload `[0x03, 0x00, ...data]`. */
export function encodeInt8Vector(bytes: Int8Array): Uint8Array {
  const out = new Uint8Array(VECTOR_HEADER_BYTES + bytes.length);
  out[0] = VECTOR_DTYPE_INT8;
  out[1] = 0;
  out.set(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length),
    VECTOR_HEADER_BYTES,
  );
  return out;
}

export type DecodeResult =
  | { readonly ok: true; readonly bytes: Int8Array }
  | { readonly ok: false; readonly reason: string };

/**
 * The BSON vector payload -> `Int8Array`. Validates the header rather than
 * trusting it: a float32 payload decoded as int8 produces 4x the dimensions of
 * plausible-looking noise, which ranks and does not throw.
 */
export function decodeInt8Vector(payload: Uint8Array): DecodeResult {
  if (payload.length < VECTOR_HEADER_BYTES) {
    return {
      ok: false,
      reason: `payload shorter than the ${VECTOR_HEADER_BYTES}-byte header`,
    };
  }
  if (payload[0] !== VECTOR_DTYPE_INT8) {
    return {
      ok: false,
      reason: `dtype 0x${payload[0]!.toString(16)} is not int8 (0x03)`,
    };
  }
  if (payload[1] !== 0) {
    return { ok: false, reason: `padding ${payload[1]} must be 0 for int8` };
  }
  const body = payload.subarray(VECTOR_HEADER_BYTES);
  return {
    ok: true,
    bytes: new Int8Array(body.buffer, body.byteOffset, body.length),
  };
}

/**
 * MongoDB extended JSON v2 for a binary value.
 *
 * This is the transport, and it is not a stylistic choice. Every reader in this
 * repo issues `$vectorSearch` through `prisma.$runCommandRaw`, which speaks
 * extended JSON — and Prisma's own `Bytes` scalar writes BSON subtype 0
 * (generic), while Atlas requires subtype 9 (Vector). So the vector CANNOT go
 * through a typed Prisma field in either direction; it is written and read as
 * extended JSON through the raw command, and `DocumentEmbeddingV2` therefore
 * does not declare the field at all.
 */
/**
 * A `type`, NOT an `interface`, and that is not style. An interface has no
 * implicit index signature, so it is not assignable to `JsonObject` — which
 * would make the one value this module exists to produce the one value a
 * `$vectorSearch` stage could not hold.
 */
export type EjsonBinary = {
  readonly $binary: { readonly base64: string; readonly subType: string };
};

export function toEjsonBinary(
  payload: Uint8Array,
  subTypeHex: string = VECTOR_BINARY_SUBTYPE_HEX,
): EjsonBinary {
  return {
    $binary: {
      base64: Buffer.from(
        payload.buffer,
        payload.byteOffset,
        payload.length,
      ).toString("base64"),
      subType: subTypeHex,
    },
  };
}

/** Reads an extended-JSON binary back out of a `$runCommandRaw` result. */
export function fromEjsonBinary(value: unknown): Uint8Array | null {
  if (!value || typeof value !== "object") return null;
  const b = (value as { $binary?: { base64?: unknown } }).$binary;
  if (!b || typeof b.base64 !== "string") return null;
  try {
    return new Uint8Array(Buffer.from(b.base64, "base64"));
  } catch {
    return null;
  }
}

/** float vector -> the EJSON BinData a `$vectorSearch` queryVector needs. */
export function toEjsonQueryVector(v: readonly number[]): EjsonBinary | null {
  const q = quantizeInt8(v);
  if (!q.ok) return null;
  return toEjsonBinary(encodeInt8Vector(q.bytes));
}

// ── The index-definition guard ─────────────────────────────────────────────

export interface VectorIndexField {
  readonly type?: unknown;
  readonly path?: unknown;
  readonly numDimensions?: unknown;
  readonly similarity?: unknown;
  readonly quantization?: unknown;
}

/** Per the vendor's own "Supported Similarity method" table — see the header. */
const SIMILARITY_BY_DTYPE: Readonly<Record<VectorDtype, readonly string[]>> = {
  int1: ["euclidean"],
  int8: ["cosine", "euclidean", "dotProduct"],
  float32: ["cosine", "euclidean", "dotProduct"],
  array: ["cosine", "euclidean", "dotProduct"],
};

export type IndexCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Refuses an index definition that would index the stored vectors WRONGLY or
 * NOT AT ALL. Reports every problem, not the first — a definition with two
 * faults fixed one at a time is two round trips against a cluster that takes
 * minutes to rebuild an index.
 */
export function checkVectorIndexField(
  field: VectorIndexField,
  opts: { dtype: VectorDtype; dims: number; path?: string },
): IndexCheck {
  const problems: string[] = [];

  if (field.type !== "vector") {
    problems.push(`type must be "vector", got ${JSON.stringify(field.type)}`);
  }
  if (opts.path !== undefined && field.path !== opts.path) {
    problems.push(
      `path must be "${opts.path}", got ${JSON.stringify(field.path)}`,
    );
  }
  if (field.numDimensions !== opts.dims) {
    problems.push(
      `numDimensions must be ${opts.dims}, got ${JSON.stringify(field.numDimensions)}`,
    );
  }

  const allowed = SIMILARITY_BY_DTYPE[opts.dtype];
  if (
    typeof field.similarity !== "string" ||
    !allowed.includes(field.similarity)
  ) {
    problems.push(
      `similarity ${JSON.stringify(field.similarity)} is not supported for ` +
        `${opts.dtype} vectors (allowed: ${allowed.join(", ")})`,
    );
  }

  // The silent one. Automatic quantization over a pre-quantized field makes
  // Atlas SKIP every vector rather than error, so the collection shrinks, the
  // index builds, and retrieval returns nothing.
  const q = field.quantization;
  const preQuantized = opts.dtype === "int8" || opts.dtype === "int1";
  if (preQuantized && q !== undefined && q !== null && q !== "none") {
    problems.push(
      `quantization ${JSON.stringify(q)} over pre-quantized ${opts.dtype} vectors makes ` +
        `Atlas SILENTLY SKIP every vector — it must be absent or "none"`,
    );
  }
  if (!preQuantized && q !== undefined && q !== null) {
    if (q !== "none" && q !== "scalar" && q !== "binary") {
      problems.push(
        `quantization ${JSON.stringify(q)} is not none | scalar | binary`,
      );
    }
  }

  if (opts.dtype === "int1" && opts.dims % 8 !== 0) {
    problems.push(
      `int1 numDimensions must be a multiple of 8, got ${opts.dims}`,
    );
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// ── The cut-over flag ──────────────────────────────────────────────────────

/**
 * Three states, and the third is not optional.
 *
 *   off   read v1, write v1                      (today)
 *   dual  read v1, write v1 AND v2               (while the backfill runs)
 *   on    read v2, write v2                      (after cut-over)
 *
 * `dual` exists because the backfill reads a moving collection: B0's own
 * re-measurement caught v1 growing 86,594 rows in one afternoon, and a
 * read-then-write migration with no dual-write finishes with a tail of
 * un-migrated rows. `on` STOPS the v1 write, which matters more than it looks:
 * once v1 has been renamed away, a `documentEmbedding.upsert` would CREATE a
 * fresh empty `document_embeddings` and write into it, silently, for ever.
 */
export type EmbeddingsMode = "off" | "dual" | "on";

export const EMBEDDINGS_V2_FLAG = "EMBEDDINGS_V2";

/**
 * Fail-safe in BOTH directions: an absent row, an unreadable one, a typo, a
 * value of the wrong shape, all resolve to `off` — the behaviour that exists
 * today. Nothing here can turn v2 on by accident.
 */
export function resolveEmbeddingsMode(flagValue: unknown): EmbeddingsMode {
  const raw =
    typeof flagValue === "string"
      ? flagValue
      : flagValue && typeof flagValue === "object"
        ? (flagValue as { mode?: unknown }).mode
        : undefined;
  return raw === "on" ? "on" : raw === "dual" ? "dual" : "off";
}

export interface ReadTarget {
  readonly collection: string;
  readonly index: string;
  /** true when the stored vectors are int8 BinData and the query must match. */
  readonly quantized: boolean;
}

export function readTarget(mode: EmbeddingsMode): ReadTarget {
  return mode === "on"
    ? { collection: V2_COLLECTION, index: V2_INDEX, quantized: true }
    : { collection: V1_COLLECTION, index: V1_INDEX, quantized: false };
}

/** Which collections a WRITE must land in, in the order it should attempt them. */
export function writeTargets(mode: EmbeddingsMode): readonly ("v1" | "v2")[] {
  return mode === "off" ? ["v1"] : mode === "dual" ? ["v1", "v2"] : ["v2"];
}

// ── The shared $vectorSearch stage ─────────────────────────────────────────

/**
 * A JSON value, structurally — which is what a Mongo command document IS.
 *
 * NOT `Record<string, unknown>`, and the difference is load-bearing rather
 * than pedantic. Prisma types `$runCommandRaw`'s argument as `InputJsonObject`
 * and `unknown` is not assignable to it, so a stage typed that way cannot be
 * put into a pipeline without a cast at every call site — and the cast that is
 * easiest to reach for widens the WHOLE command (`as never`), which deletes
 * the checking on `aggregate` and `cursor` too in order to silence one
 * element. This package must not depend on Prisma, so the type is declared
 * here and is structurally assignable to its input types.
 *
 * `RunCommandRaw`, the seam callers hand in, still takes
 * `Record<string, unknown>` — narrowing it is contravariant and would ripple
 * through every v2 writer for no behavioural gain.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export type JsonObject = { readonly [key: string]: JsonValue | undefined };

export interface VectorSearchStage {
  readonly aggregate: string;
  readonly stage: JsonObject;
}

/**
 * The ONE place that decides which collection, which index, and how the query
 * vector is encoded. Three call sites build different pipelines around it
 * (`fetch-document-context.ts`, and two in `apps/web/lib/gemini/vector-store.ts`)
 * and they must not each carry their own copy of the quantization decision —
 * a reader that kept sending a float array at a BinData index is a query that
 * either errors or, worse, ranks against nothing.
 *
 * Returns null when the query vector cannot be quantized; every caller already
 * degrades on a missing query vector, so that path needs no new handling.
 */
/**
 * Fields on these collections that are BSON ObjectId and must be filtered as
 * one — MONEY-1500.
 *
 * `userId` is `String @db.ObjectId`. Prisma COERCES a string on a `findMany`;
 * `$runCommandRaw` does not, and `mongot` compares the indexed BSON value. So
 * a bare string in a `$vectorSearch` pre-filter matches NOTHING — and returns
 * an empty batch WITHOUT throwing, which is the whole problem: every caller's
 * `catch` stays silent and the fallback beneath it is unreachable.
 *
 * Measured on prod 2026-09-22, same index, same query vector, via
 * `$runCommandRaw`:
 *
 *     filter userId as a STRING    ->  0 rows
 *     filter userId as {$oid: ...} ->  6 rows
 *
 * That shipped at FOUR call sites, including every user's own document search.
 * The guard lives HERE rather than at the call sites because a fifth caller
 * would reintroduce it — this is the one function all of them route through,
 * and it already exists to stop exactly this class of drift ("which
 * collection, which index and how the query vector is encoded are ONE
 * decision").
 *
 * It THROWS rather than coercing. A caller holding something that is not an
 * ObjectId is a caller whose intent we cannot guess, and silently repairing it
 * would hide the next instance of this bug the way the empty batch hid this
 * one.
 */
const OBJECT_ID_FILTER_FIELDS = ["userId"] as const;

const isEjsonOid = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { $oid?: unknown }).$oid === "string";

export function assertObjectIdFilters(filter: JsonObject | undefined): void {
  if (!filter) return;
  for (const field of OBJECT_ID_FILTER_FIELDS) {
    if (!(field in filter)) continue;
    const raw = filter[field];
    // Both spellings reach mongot identically: `{f: {$oid}}` and
    // `{f: {$eq: {$oid}}}` each returned 6 rows in the measurement above.
    const value = isEjsonOid(raw)
      ? raw
      : typeof raw === "object" && raw !== null
        ? (raw as { $eq?: JsonValue }).$eq
        : raw;
    if (!isEjsonOid(value)) {
      throw new Error(
        `$vectorSearch filter "${field}" must be an ObjectId in extended JSON ` +
          `(use oid() from @usemoney/core/embeddings-v2-write), got ` +
          `${JSON.stringify(raw)}. A bare string matches NOTHING here and ` +
          `returns an empty result without throwing — MONEY-1500.`,
      );
    }
  }
}

export function buildVectorSearchStage(args: {
  mode: EmbeddingsMode;
  queryVector: readonly number[];
  numCandidates: number;
  limit: number;
  path?: string;
  filter?: JsonObject;
}): VectorSearchStage | null {
  assertObjectIdFilters(args.filter);
  const target = readTarget(args.mode);
  let queryVector: JsonValue = args.queryVector;
  if (target.quantized) {
    const ejson = toEjsonQueryVector(args.queryVector);
    if (!ejson) return null;
    queryVector = ejson;
  }
  return {
    aggregate: target.collection,
    stage: {
      $vectorSearch: {
        index: target.index,
        path: args.path ?? "embedding",
        queryVector,
        numCandidates: args.numCandidates,
        limit: args.limit,
        ...(args.filter ? { filter: args.filter } : {}),
      },
    },
  };
}

// ── Migration refusals ─────────────────────────────────────────────────────

export type MigrationRefusal = QuantizeRefusal | "MODEL_MISMATCH";

export interface V1Row {
  readonly _id: unknown;
  readonly embedding?: unknown;
  readonly embeddingModel?: string | null;
}

/**
 * A stored `Float[]` back out of a `$runCommandRaw` result.
 *
 * Prisma returns RELAXED extended JSON, in which a double is a plain number —
 * but "relaxed" is a property of a serializer we do not control, and under
 * CANONICAL the same array arrives as `[{ $numberDouble: "0.1" }, ...]`. That
 * difference would make every single row fail `Number.isFinite` and be refused
 * as NON_FINITE: loud and fast, but for entirely the wrong reason, and an hour
 * of reading before anyone guessed at the serializer. Accepting both spellings
 * costs ten lines and removes the question.
 */
export function toNumberArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x === "number") {
      out[i] = x;
      continue;
    }
    if (x && typeof x === "object") {
      const w = x as Record<string, unknown>;
      const n = w.$numberDouble ?? w.$numberInt ?? w.$numberLong;
      if (typeof n === "string" || typeof n === "number") {
        out[i] = Number(n);
        continue;
      }
    }
    return null;
  }
  return out;
}

export type MigrationVerdict =
  | { readonly ok: true; readonly bytes: Int8Array }
  | { readonly ok: false; readonly reason: MigrationRefusal };

/**
 * One v1 row -> either an int8 vector or a NAMED refusal. A refusal is a
 * manifest entry, never a `continue`: "skipped silently" is the shape this
 * codebase keeps producing, where a counter reads healthy while rows vanish.
 */
export function migrateRow(
  row: V1Row,
  opts: { model: string; dims?: number },
): MigrationVerdict {
  const model = row.embeddingModel ?? DEFAULT_CORPUS_MODEL;
  if (model !== opts.model) return { ok: false, reason: "MODEL_MISMATCH" };
  const q = quantizeInt8(
    toNumberArray(row.embedding),
    opts.dims ?? EXPECTED_DIMS,
  );
  return q.ok ? { ok: true, bytes: q.bytes } : { ok: false, reason: q.reason };
}

/**
 * One v2 insert document, in extended JSON, ready for `$runCommandRaw`.
 *
 * The v1 row arrives from `$runCommandRaw` ALREADY in extended JSON — `_id`
 * and `userId` as `{$oid}`, the timestamps as `{$date}` — so those values are
 * carried across VERBATIM rather than parsed and re-serialised. Parsing them
 * would be a second place for an ObjectId to become a string, and a row whose
 * `userId` is a string matches no filter and belongs to no user while looking
 * entirely normal.
 *
 * `_id` is carried too: the two collections then join on the primary key, the
 * resumable cursor is that same ordering, and a re-run collides instead of
 * duplicating.
 */
export function buildV2Document(
  row: Record<string, unknown>,
  bytes: Int8Array,
  opts: { model: string; sha256: (s: string) => Uint8Array; dims?: number },
): Record<string, unknown> {
  const content = typeof row.content === "string" ? row.content : "";
  return {
    _id: row._id,
    userId: row.userId,
    docType: row.docType,
    // `docId` is nullable in v1 and the unique key includes it, so an ABSENT
    // key and an explicit null are not the same document to Mongo. Write the
    // null.
    docId: row.docId ?? null,
    content,
    chunkId: row.chunkId ?? 0,
    contentSha: toEjsonBinary(opts.sha256(content), "00"),
    embedding: toEjsonBinary(encodeInt8Vector(bytes)),
    embeddingModel: opts.model,
    dims: opts.dims ?? EXPECTED_DIMS,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A manifest entry. The row is not migrated and this is the record of why. */
export function buildRefusalDocument(
  row: Record<string, unknown>,
  reason: MigrationRefusal,
  atIso: string,
): Record<string, unknown> {
  return {
    _id: row._id,
    userId: row.userId,
    docType: row.docType,
    docId: row.docId ?? null,
    chunkId: row.chunkId ?? 0,
    embeddingModel: row.embeddingModel ?? null,
    dims: Array.isArray(row.embedding) ? row.embedding.length : null,
    reason,
    at: atIso,
  };
}

/**
 * The refusal ceiling. B0 measured the corpus as 100% one model at 768 dims, so
 * a run that starts refusing rows in bulk has found something the measurement
 * did not — a second embedding space, a truncated write path — and the right
 * answer is to stop and look, not to manifest 400,000 rows and report success.
 *
 * Only judged once the sample is big enough to mean anything: two refusals in
 * the first fifty rows is noise, and a ratio compared before that is the
 * "not measured is not passed" defect from the other side.
 */
export const REFUSAL_ABORT_RATE = 0.01;
export const REFUSAL_ABORT_MIN_SCANNED = 10_000;

export function shouldAbortForRefusals(
  scanned: number,
  refused: number,
): boolean {
  if (scanned < REFUSAL_ABORT_MIN_SCANNED) return false;
  return refused / scanned > REFUSAL_ABORT_RATE;
}

// ── The rename gate ────────────────────────────────────────────────────────

export type RenameVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * B0 §6's rollback criterion, as a refusal rather than a runbook step.
 *
 * Renaming v1 away is the one irreversible-in-practice move in this migration:
 * afterwards every reader that has not been cut over reads a collection that
 * does not exist, and every WRITER that has not been cut over silently creates
 * a new empty one. So it is refused unless v2 plus the NAMED REFUSALS account
 * for every v1 row — "account for", not "at least as many as", because a
 * refused row is one v1 holds and v2 never will; and v1 keeps growing under
 * `dual`, so an equality test against a moving collection would never pass.
 */
export function checkRenameReady(args: {
  v1Count: number;
  v2Count: number;
  mode: EmbeddingsMode;
  armed: boolean;
  /**
   * Rows of v1 the backfill has NOT reached — MONEY-1499 review, F3.
   *
   * REQUIRED, not optional. `v2Count >= v1Count` looked like a completeness
   * check and stops being one the moment mode flips to "on": writeTargets is
   * then ["v2"] alone, so v1 is FROZEN and v2 keeps growing on live traffic.
   * B0 measured v1 gaining 86,594 rows in an afternoon; the runbook then waits
   * SEVEN DAYS between arming and renaming. Over that week v2 can exceed v1 by
   * several hundred thousand rows while masking exactly that many un-migrated
   * ones.
   *
   * Those rows are not lost — v1 is renamed and kept 30 days — but they become
   * INVISIBLE: after the rename `V1_COLLECTION` does not exist, so re-running
   * the backfill reports "reached the end" and `--verify` reports v1 = 0.
   * Nothing points the backfill at the retired name. The only symptom is worse
   * retrieval.
   *
   * IT IS NOT `v1 - v2 - refusals`, and this docblock said it was. That
   * subtraction is a DIFFERENT number — it goes NEGATIVE in "on" mode for the
   * very reason above — and `verify()` now prints both under distinct labels.
   * This one is the LEFTOVER SET, `_id > checkpoint`.
   *
   * A ROW DUAL-WRITTEN AFTER THE CHECKPOINT PASSED IT COUNTS HERE, and that is
   * deliberate rather than a wart. ObjectIds are time-ordered, so a live write
   * during `dual` lands past `lastId` even though `upsertEmbeddingsV2` already
   * put it in v2. The WALK is what settles it: in "on" mode v1 is FROZEN, so
   * one more backfill pass reaches every such row, finds it already present,
   * and advances `lastId` to the true end. That final pass is a runbook step
   * and the refusal below names it — because "the gate refuses the correct
   * end-state" and "the gate found un-migrated rows" must not read alike.
   */
  outstanding: number;
  /**
   * Rows the backfill REFUSED by name — MONEY-1499 review.
   *
   * The job budgets up to `REFUSAL_ABORT_RATE` of these, so a COMPLETE
   * backfill legitimately leaves v2 smaller than v1. Without this term the
   * count rung was wrong in BOTH directions: it refused a finished migration
   * for ever, and then passed it unremarked the moment live traffic grew v2
   * past v1 — taking the refused rows with it.
   */
  refusalCount: number;
  /**
   * The refusal count the OPERATOR has read and accepted.
   *
   * A refused row is a vector that will not exist in v2 after v1 is renamed
   * away, so it must cost a human a deliberate number rather than being
   * absorbed by an inequality. It is also the recoverable case: a wrong
   * `--model` refuses rows the right model would migrate, and the checkpoint
   * advances past them either way.
   */
  acceptedRefusals: number;
}): RenameVerdict {
  if (!args.armed) {
    return {
      ok: false,
      reason: 'not armed — EMBEDDINGS_V2_RENAME_APPLY is not "true"',
    };
  }
  if (args.mode !== "on") {
    return {
      ok: false,
      reason: `mode is "${args.mode}" — every reader and writer must be on v2 before v1 is renamed away`,
    };
  }
  // EVERY count, not just `outstanding` — MONEY-1499 review.
  //
  // `NaN <= 0` and `NaN < NaN` are both FALSE, so a count that could not be
  // read used to satisfy two of the three quantitative rungs by failing to
  // evaluate. The `v1Count <= 0` rung exists to refuse "a count that cannot be
  // right" and was blind to the exact shape a count takes when it cannot be
  // taken at all.
  const unreadable = (
    [
      ["v1Count", args.v1Count],
      ["v2Count", args.v2Count],
      ["outstanding", args.outstanding],
      ["refusalCount", args.refusalCount],
      ["acceptedRefusals", args.acceptedRefusals],
    ] as ReadonlyArray<readonly [string, number]>
  ).filter(([, n]) => !Number.isFinite(n));
  if (unreadable.length > 0) {
    return {
      ok: false,
      reason:
        `${unreadable.map(([k]) => k).join(", ")} did not read as a finite ` +
        `number — a count that could not be taken is never a count of zero`,
    };
  }
  if (args.v1Count <= 0) {
    return {
      ok: false,
      reason:
        "v1 reported 0 rows — refusing to act on a count that cannot be right",
    };
  }
  // ACCOUNTED FOR, not merely larger. A refused row is one v1 holds and v2
  // never will, so it belongs on this side of the comparison or a complete
  // migration is refused for ever.
  const accounted = args.v2Count + args.refusalCount;
  if (accounted < args.v1Count) {
    return {
      ok: false,
      reason:
        `v2 has ${args.v2Count} rows and ${args.refusalCount} were refused, ` +
        `accounting for ${accounted} of v1's ${args.v1Count} — ` +
        `${args.v1Count - accounted} rows are neither migrated nor refused`,
    };
  }
  // The check the count comparison above cannot make once mode is "on".
  if (args.outstanding !== 0) {
    return {
      ok: false,
      reason:
        `${args.outstanding} v1 row(s) sit past the backfill checkpoint. A v2 ` +
        `count larger than v1's proves nothing here: in "on" mode v1 is frozen ` +
        `and v2 grows on live traffic, so that comparison goes trivially true ` +
        `while un-migrated rows remain. NOTE these may be rows the DUAL phase ` +
        `already wrote to v2 — v1 is frozen now, so run ONE MORE backfill ` +
        `pass, which reaches them, finds them present and clears this.`,
    };
  }
  // A refusal must cost a human a number, never be absorbed by an inequality.
  if (args.refusalCount !== args.acceptedRefusals) {
    return {
      ok: false,
      reason:
        `${args.refusalCount} row(s) were REFUSED and will not exist in v2 ` +
        `after the rename (--verify prints them by reason). Re-run with ` +
        `--accept-refusals=${args.refusalCount} once you have read them.`,
    };
  }
  return { ok: true };
}
