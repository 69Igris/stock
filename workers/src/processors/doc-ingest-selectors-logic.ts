/**
 * Every selection MONEY-1314 makes over a field it introduced — in ONE module,
 * pure, so the `isSet: false` arm can be asserted rather than remembered.
 *
 * ## Why these are not written inline at the call sites
 *
 * A Mongo `prisma db push` creates INDEXES, never FIELDS. All ~79,884
 * `stock_documents` rows that predate this branch carry NO `convertStatus`,
 * `parsePath` or `batchJobId` attribute, and Prisma's Mongo connector does not
 * treat absent as null — so `{ convertStatus: "PENDING" }` matches ZERO of
 * them. `@default` does not help: it applies only to rows Prisma itself
 * creates.
 *
 * The failure is silent in both directions. "Nothing to convert" and "the whole
 * corpus is unreachable" produce the same empty selection, the same log line
 * and the same successful exit. The class has caused MONEY-1050, MONEY-1205,
 * MONEY-1234 and MONEY-1236 — four times, each in a different file, each
 * written by someone who knew about the previous one. Centralising the arms is
 * the only version of "remember the isSet arm" that a reviewer can check.
 *
 * `doc-ingest-isset-arms.test.ts` asserts the arms exist, and carries a control
 * proving its own detector can fail.
 */

// MONEY-1319 review — DIRECT, not the archive-inclusive set. Neither lane in
// this file can open a container; see the `mimeType` arm of `buildConvertQuery`.
import { DIRECT_DOC_MIME_TYPES } from "@usemoney/core/market-data/doc-mime";
// IMPORTED, not re-declared — see the note on the re-export below. A bare
// `export { X } from "..."` would not bind the name for the query that uses it.
import { STALE_PROCESSING_MS } from "./stock-document-extract-logic";

/** `convertStatus` vocabulary. Mirrors the schema comment exactly. */
export const CONVERT_STATUS = {
  PENDING: "PENDING",
  CONVERTED: "CONVERTED",
  /** Every page needs OCR — nothing for the markdown lane to work with. */
  SCANNED_ONLY: "SCANNED_ONLY",
  FAILED: "FAILED",
} as const;

/** The two `parseStatus` values this branch adds to the existing vocabulary. */
export const BATCH_PARSE_STATUS = {
  /** Handed to a batch job; awaiting `batch-ingest`. */
  BATCHED: "BATCHED",
  /** The batch returned a per-row error. Sweepable through the online path. */
  FAILED_BATCH: "FAILED_BATCH",
} as const;

/**
 * Convertible: never converted, or Prisma wrote the default.
 *
 * The `isSet: false` arm is the load-bearing one — it is the entire existing
 * corpus. The `PENDING` arm covers rows this branch creates.
 */
export const PENDING_OR_ABSENT_CONVERT_STATUS: readonly Record<
  string,
  unknown
>[] = [
  { convertStatus: CONVERT_STATUS.PENDING },
  { convertStatus: { isSet: false } },
] as const;

/** Rows a batch is carrying — plus the absent arm, for partial writes. */
export const BATCHED_OR_ABSENT_PARSE_STATUS: readonly Record<
  string,
  unknown
>[] = [
  { parseStatus: BATCH_PARSE_STATUS.BATCHED },
  { parseStatus: { isSet: false } },
] as const;

/** Terminal batch outcomes the online sweep re-opens. */
export const SWEEPABLE_PARSE_STATUS: readonly string[] = [
  BATCH_PARSE_STATUS.FAILED_BATCH,
  "FAILED_VALIDATION",
  // MONEY-1314 — `FAILED` is transient by construction (CALL_FAILED /
  // UNCONFIGURED), and the ingest route ACKs 200 on EVERY path including a
  // throw. So Pub/Sub will never redeliver it and the sweep is the ONLY way
  // back into the queue: without this entry, one Gemini blip drops a document
  // permanently, with a terminal-looking status and no alert.
  "FAILED",
] as const;

/**
 * What `scan-convert` still has to look at.
 *
 * `unscannedOnly` is THE CURSOR. There is no checkpoint table and none is
 * wanted: the stamp the scan writes (`scannedPageCount`) is itself the
 * position, so resume is an O(1) index seek rather than a walk that
 * re-verifies finished work. `FeedBackfillProgress` was considered and does not
 * fit — it is keyed `(family, DateTime)` and resumes by loading a terminal set
 * and differencing it, which is the "resume that re-verifies has a ceiling"
 * shape this repo has already paid for.
 *
 * The cursor MUST be `{ isSet: false }` and never `null`: on an absent field a
 * `null` test matches nothing in EITHER direction, so a scan written that way
 * either re-reads the corpus forever or reads none of it, with no error.
 */
export function buildConvertQuery(opts: {
  /** Only rows the classifier has never stamped — the resume cursor. */
  unscannedOnly?: boolean;
  /**
   * Also re-select rows previously stamped FAILED.
   *
   * MONEY-1314 review — without this, `convertStatus: FAILED` was a BLACK
   * HOLE. No query selected it, `buildConvertClaimWhere` admitted it only
   * under `force` (which the backfill had no flag for), and `--rescan` only
   * dropped the `scannedPageCount` cursor while this OR-arm still excluded
   * every stamped row. So the one documented recovery lever was dead.
   *
   * That mattered because the backfill stamped FAILED on documents the worker
   * converts fine: it ran `looksLikePdf` on RAW bytes, before peeling the
   * MONEY-1169 multipart envelope, so a 212 MB intact annual report was
   * terminally marked unreadable and no query, claim or rescan could take it
   * back.
   */
  includeFailed?: boolean;
  docTypes?: string[];
  symbols?: string[];
}): Record<string, unknown> {
  return {
    OR: [
      ...PENDING_OR_ABSENT_CONVERT_STATUS,
      ...(opts.includeFailed ? [{ convertStatus: CONVERT_STATUS.FAILED }] : []),
    ],
    // PDFs only, and only rows whose object actually exists. ~7,234 rows carry
    // `gcsPath: ""` because BSE stopped serving the attachment; they are
    // skipped BY NAME here rather than by letting `assertSafeObjectKey` throw
    // once per document deep inside the loop.
    //
    // From the SHARED constant, never a literal. `normalizeDocMimeType`
    // collapses every PDF spelling onto `application/pdf` at write time, so a
    // literal happens to be correct today — and that is exactly the shape
    // MONEY-1255 warns about: "a rule restated in two places is a rule that
    // drifts", and this one already drifted once, between a filename and a
    // column, inside a single function. 1,211 rows were unreachable for the
    // life of the table as a result.
    //
    // "PDFs ONLY" IS TRUE AGAIN, and for two releases it was not. This arm read
    // `EXTRACTABLE_DOC_MIME_TYPES` while MONEY-1319 was adding
    // `application/zip` to it — so this comment said PDFs while the query
    // selected archives, and `scan-convert` would have handed raw ZIP bytes to
    // pdf-inspector. `DIRECT_DOC_MIME_TYPES` is the set whose bytes a reader
    // consumes AS THEY ARE; a container needs an unwrapping step this lane does
    // not have, and could not have cheaply: the sidecar it writes is
    // `${gcsPath}.md`, keyed on the OBJECT, so a member's markdown would sit
    // under a key naming the archive rather than the document.
    mimeType: { in: [...DIRECT_DOC_MIME_TYPES] },
    gcsPath: { notIn: [""] },
    ...(opts.unscannedOnly ? { scannedPageCount: { isSet: false } } : {}),
    ...(opts.docTypes && opts.docTypes.length > 0
      ? { docType: { in: opts.docTypes } }
      : {}),
    ...(opts.symbols && opts.symbols.length > 0
      ? { symbol: { in: opts.symbols.map((s) => s.toUpperCase()) } }
      : {}),
  };
}

/**
 * The alphabet a shard partitions on — MONEY-1339.
 *
 * Every `stock_documents.symbol` on prod begins with one of these: NSE and BSE
 * trading symbols are upper-case alphanumeric. A symbol that somehow begins
 * with something else matches NO shard and is therefore never converted, which
 * is why {@link buildShardWhere} is asserted to be a PARTITION rather than
 * merely a filter, and why the caller logs its own `remaining`.
 */
export const SHARD_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * One task's slice of the corpus, as a `symbol` prefix set — MONEY-1339.
 *
 * ## Why a prefix set rather than a modulus on the id
 *
 * The obvious shard is `hash(id) % n`, and Prisma's Mongo connector cannot
 * express it: there is no `$expr` in a Prisma `where`, so an arithmetic
 * predicate would have to become a raw command and lose the typed selector
 * (and with it the `isSet` arms this module exists to keep honest). `symbol` is
 * present on every row, indexed, and its first character is a free, stable
 * partition key.
 *
 * ROUND-ROBIN, not contiguous blocks. `A`-`E` to task 0 would hand one task
 * every symbol starting with a common letter; dealing the alphabet out
 * `charIndex % n` mixes the heavy letters across tasks. It does not balance
 * them perfectly — nothing cheap does — which is why each task reports its own
 * `remaining` instead of the run inferring progress from one number.
 *
 * A shard is composed with the convert query by the CALLER as
 * `{ AND: [convertWhere, shardWhere] }`, never merged key-by-key: both objects
 * carry a top-level `OR`, and spreading one over the other would silently drop
 * the convert query's status arms and select the whole corpus.
 */
export function buildShardWhere(
  index: number,
  count: number,
): Record<string, unknown> {
  if (!Number.isInteger(index) || !Number.isInteger(count)) {
    throw new TypeError(`shard must be integers, received ${index}/${count}`);
  }
  if (count < 1) throw new RangeError(`shard count must be >= 1, got ${count}`);
  if (index < 0 || index >= count) {
    throw new RangeError(`shard index ${index} is outside 0..${count - 1}`);
  }
  // MORE TASKS THAN LETTERS IS A SILENT NO-OP, so it is refused loudly.
  //
  // At `count > 36` the tasks past the alphabet's end receive an EMPTY prefix
  // list, and an empty `OR` selects nothing. Each of those tasks would then
  // report `selected=0 remaining=0` and exit 0 — indistinguishable from a
  // drained queue, on a job whose whole failure mode is looking finished while
  // work remains.
  if (count > SHARD_ALPHABET.length) {
    throw new RangeError(
      `shard count ${count} exceeds the ${SHARD_ALPHABET.length}-character ` +
        "shard alphabet; tasks past the end would select nothing and report a " +
        "drained queue",
    );
  }
  const prefixes = [...SHARD_ALPHABET].filter((_, k) => k % count === index);
  return { OR: prefixes.map((c) => ({ symbol: { startsWith: c } })) };
}

/**
 * Rows belonging to one submitted batch job, for `batch-ingest`.
 *
 * Matched on `batchJobId` AND a BATCHED-or-absent status arm: a row whose
 * status write landed but whose job-id write did not (or vice versa) is
 * exactly what an at-least-once pipeline produces, and leaving it unselectable
 * would strand it in a state no sweep looks at.
 */
export function buildBatchIngestQuery(
  batchJobId: string,
): Record<string, unknown> {
  return {
    batchJobId,
    OR: [...BATCHED_OR_ABSENT_PARSE_STATUS],
  };
}

/**
 * Rows the online sweep re-opens: the RESIDUE a batch left behind.
 *
 * MONEY-1314 — this used to carry a bare `{ parseStatus: { isSet: false } }`
 * arm, copied from its siblings without their scoping. `parseStatus` is
 * genuinely ABSENT on ~43,105 pre-existing rows, and after `scan-convert`
 * every one of them is CONVERTED with a sidecar and still has no
 * `parseStatus` — so the sweep matched the WHOLE CORPUS and ran the ONLINE
 * per-document path (the most expensive lane, no batch discount) over the
 * oldest N, none of which were the residue the subcommand exists for.
 *
 * The tell that the wide arm was never the intent: `PENDING`, the value Prisma
 * actually writes on a new row, was NOT admitted. An absent status and a
 * PENDING status mean the same thing, and only one was matched.
 *
 * So the arm is gone. What remains is exactly the terminal outcomes a batch
 * can leave: a per-row batch error and an arithmetic-gate rejection. `FAILED`
 * is included too — the route ACKs 200 on every path, so a transient model
 * error has NO other way back into the queue, and without it one Gemini blip
 * drops a document permanently.
 *
 * ## The two IN-FLIGHT statuses are also residue — MONEY-1341
 *
 * `BATCHED` and `PROCESSING` are claims, not answers. They say "somebody is
 * working on this", and nothing checks whether that somebody still exists.
 * Measured on prod 2026-09-05: 22 rows carry `BATCHED` against two
 * compare-mode pilot batches (compare grades a batch and deliberately writes
 * nothing, so it never releases the status it was handed), and 2 carry
 * `PROCESSING` from 2026-09-01. No query selects either. They are the
 * MONEY-1314 black hole in its other form — there the status was terminal and
 * unswept, here it is transitional and never completed.
 *
 * They are admitted only once STALE, and the two ages differ because the
 * claims do: a batch legitimately runs for many hours (there is no SLA and 24h
 * is normal), while a `PROCESSING` document is one online call inside a 600s
 * ack deadline. An age is the only available signal — neither status carries a
 * heartbeat — so the thresholds are set well past each lane's real worst case
 * rather than tightly.
 */
export const STALE_BATCHED_MS = 48 * 60 * 60 * 1000;

/**
 * The PROCESSING age is NOT this module's to choose — MONEY-1346.
 *
 * It was declared here as a second `export const STALE_PROCESSING_MS = 6 * 60 *
 * 60 * 1000`, identical in name and value to the one in
 * `stock-document-extract-logic.ts`. Two lanes, one name, one number, two
 * definitions: a change to either reads as a change to both, and only one of
 * them moves. That is the drift class this file argues against three times
 * over (`decideTextSource`, `SCANNED_SHARE_VISION_THRESHOLD`).
 *
 * The value belongs THERE rather than here because that is where its sizing
 * argument lives, and the argument is not about either lane's work — it is
 * about the ack deadline that bounds any online claim: 420s of run budget plus
 * one in-flight document inside a 600s ceiling, so no honest claim survives ten
 * minutes, and six hours is ~36x that. A `PROCESSING` row means the same thing
 * on both lanes, so it goes stale at the same age on both.
 *
 * `STALE_BATCHED_MS` above stays local and is deliberately eight times larger:
 * a BATCHED claim is a Vertex batch job with no SLA where 24h is normal, which
 * is a different fact about a different mechanism.
 */
export { STALE_PROCESSING_MS };

export function buildSweepQuery(opts: { now: Date }): Record<string, unknown> {
  const at = opts.now.getTime();
  return {
    OR: [
      { parseStatus: { in: [...SWEEPABLE_PARSE_STATUS] } },
      // `updatedAt` is `@updatedAt` on `StockDocument`, so it is present on
      // every row and needs no `isSet` arm — unlike `parseStatus` itself. And
      // the status here is a LITERAL rather than a negation on purpose: a
      // stale row by definition HAS the value, so equality is both correct and
      // the direction that cannot accidentally match an absent field.
      {
        parseStatus: BATCH_PARSE_STATUS.BATCHED,
        updatedAt: { lt: new Date(at - STALE_BATCHED_MS) },
      },
      {
        parseStatus: "PROCESSING",
        updatedAt: { lt: new Date(at - STALE_PROCESSING_MS) },
      },
    ],
    // DIRECT, not the archive-inclusive set — see `buildConvertQuery`. The
    // sweep runs the ONLINE per-document path, the most expensive lane there
    // is, so a container selected here is a metered call spent on bytes no
    // model can read.
    mimeType: { in: [...DIRECT_DOC_MIME_TYPES] },
    gcsPath: { notIn: [""] },
  };
}

/**
 * Narrow a convert claim to one row.
 *
 * ⚠️ THIS IS NOT A COMPARE-AND-SWAP, and the earlier docblock here said it was.
 *
 * The caller writes `convertStatus: PENDING`, which is a value this predicate
 * ALSO MATCHES. So a row that is already PENDING satisfies the filter, the
 * write changes nothing, and `updateMany` reports `count: 1` for BOTH of two
 * concurrent deliveries. There is no mutual exclusion whatsoever — the
 * `count === 0` branch at the call site fires only when the row was already
 * CONVERTED or SCANNED_ONLY.
 *
 * That is left as it is, deliberately, rather than fixed into a real lease:
 *
 *   - The work it guards is IDEMPOTENT. Two concurrent conversions of one
 *     document write the same sidecar to the same key with the same bytes and
 *     the same row update. The cost of a duplicate is ~1 s of CPU and one GCS
 *     read, not a wrong answer.
 *   - A real claim needs a NEW status plus a LEASE, and a lease that expires
 *     wrongly is worse than the duplicate it prevents: a `CONVERTING` row that
 *     no query admits is a document stuck forever, which is the failure this
 *     lane already suffered once through `convertStatus: FAILED`.
 *
 * So the guarantee is stated honestly instead of implied. If exclusion is ever
 * actually needed, the shape to copy is `pubsub-dedupe-logic.ts`'s leased
 * marker — an insert arbitrated by a unique index, with a lease longer than
 * the ack deadline and a compare-and-swap steal — not a status column.
 *
 * `force` widens the filter to FAILED so a deliberate re-run can reach a row
 * the ordinary pass will not.
 */
export function buildConvertClaimWhere(
  id: string,
  force = false,
): Record<string, unknown> {
  return {
    id,
    OR: force
      ? [
          ...PENDING_OR_ABSENT_CONVERT_STATUS,
          { convertStatus: { in: [CONVERT_STATUS.FAILED] } },
        ]
      : [...PENDING_OR_ABSENT_CONVERT_STATUS],
  };
}
