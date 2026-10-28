/**
 * @usemoney/storage - GCP Cloud Storage utilities
 *
 * Handles file upload, download, and signed URL generation for Google Cloud Storage.
 * Supports both base64-encoded credentials (for Vercel/production) and file-based
 * credentials (for local development).
 */

import type { Writable } from "node:stream";

import {
  CRC32C,
  Storage,
  Bucket,
  type File,
  type GetFilesOptions,
} from "@google-cloud/storage";
import {
  httpStatusOf,
  isTransientError,
} from "@usemoney/core/ops/transient-error";
import { googleCredentials } from "@usemoney/core/gemini/credentials";

// ============================================================================
// Types
// ============================================================================

export interface UploadOptions {
  /** File content as Buffer */
  file: Buffer;
  /** The filename to use in storage */
  fileName: string;
  /** MIME type of the file */
  contentType: string;
  /** Optional folder/prefix in the bucket */
  folder?: string;
  /** User ID for tracking (optional) */
  userId?: string;
  /** Additional metadata */
  metadata?: Record<string, string>;
  /** Whether the file should be publicly accessible */
  isPublic?: boolean;
  /** Override the default bucket (e.g., for public content bucket) */
  bucketName?: string;
  /**
   * Explicit `Cache-Control` (MONEY-1467).
   *
   * Without it the header is derived from `isPublic` alone — one year for
   * public, one hour for private — and a PRIVATE object served through a CDN
   * gets `private, max-age=3600`, which tells the CDN not to store it at all.
   * Tiles are private objects deliberately served through `apps/market-data`
   * to a shared cache, so the writer has to state the policy: a closed year is
   * `immutable`, the nightly 5y is not.
   */
  cacheControl?: string;
  /**
   * Whole-upload re-attempts on a TRANSIENT failure (MONEY-1608). Default 0.
   * Backoff 15 s, 60 s, 240 s, … (x4), sized to ride out the multi-minute DNS
   * outage a laptop run hit on 2026-09-23. Anything `isTransientError` does
   * not accept — a 403, a missing bucket, a 4xx — is thrown on the first
   * attempt: retrying a permanent fault only delays the report of it.
   */
  retries?: number;
  /**
   * CREATE-ONLY: the write carries `ifGenerationMatch: 0`, so it can never
   * overwrite (MONEY-1608 review).
   *
   * This is what makes `retries` safe for a writer that holds only
   * `objectCreator`, as `lake-writer-{env}@` does on the lake bucket. An
   * attempt that COMMITTED but whose response was lost (or whose deadline
   * fired just after the commit) leaves the object in place, and a re-attempt
   * would be an overwrite — which needs `storage.objects.delete` and gets a
   * 403. So when a create-only write is refused (403 / 409 / 412), the object
   * is read back and the upload counts as DONE only if it holds exactly these
   * bytes: same size and same CRC32C. Anything else is thrown.
   */
  createOnly?: boolean;
  /**
   * Upload deadline in ms (MONEY-1157). Omitted → the SDK's own defaults
   * (`totalTimeout = 600s`, `maxRetries = 3`).
   *
   * That default is fine for a user-initiated upload but NOT for anything
   * running inside a Pub/Sub push handler: bhavcopy-sync's subscription uses
   * `--ack-deadline=600`, so a single slow upload can consume the entire ack
   * budget, Pub/Sub redelivers while run #1 is still live, and two concurrent
   * runs race the same `DailyPrice` unique key.
   *
   * Deliberately per-call rather than `retryOptions` on the shared client:
   * a global 30s cap would also apply to the large learning-content media
   * uploads, which legitimately take longer.
   *
   * Implemented by destroying the upload stream when the deadline passes
   * (MONEY-1169 moved uploads onto `createWriteStream`), which aborts the
   * in-flight request rather than merely abandoning the promise.
   */
  timeoutMs?: number;
}

/**
 * The exact options handed to `createWriteStream`, extracted as a pure
 * function so a unit test can pin them — see MONEY-1169 for why these two
 * specific settings are load-bearing and must never regress:
 *
 * - `resumable: true` (the SDK default, restated here on purpose). The
 *   non-resumable path is a `uploadType=multipart` request whose hand-built
 *   body was stored VERBATIM as object content on Cloud Run — every feed
 *   file and scraped document for ~3 months — because the workers image
 *   overlays a different node-fetch major under the transport. The resumable
 *   protocol sends metadata as plain JSON and bytes as a raw PUT: there is
 *   no multipart body for ANY http-client quirk to mis-frame. (The old
 *   `resumable: false` guarded against a v5-era `gcs-resumable-upload`
 *   configstore bug that v7 does not have — its resumable path has zero
 *   configstore references.)
 *
 * - CRC32C validation ON (by omission — the SDK default). It was previously
 *   `validation: false` because it "spuriously" failed on Cloud Run with
 *   "the uploaded data did not match the data from the server". That was
 *   this corruption being caught at write time. If any environment ever
 *   mangles an upload again, the write must THROW, not store garbage.
 */
export function buildStreamOptions(
  contentType: string,
  cacheControl: string,
  fileMetadata: Record<string, string>,
): {
  resumable: true;
  contentType: string;
  metadata: Record<string, string>;
} {
  return {
    resumable: true,
    contentType,
    metadata: {
      cacheControl,
      ...fileMetadata,
    },
  };
}

/** 403 / 409 / 412 — how GCS refuses a create-only write over an existing object. */
function isCreateRefusal(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status === 403 || status === 409 || status === 412;
}

/**
 * Does the object hold exactly `bytes`? Size AND CRC32C, never size alone —
 * two stage parts of one partition can easily share a length. A metadata read
 * that fails answers "no", so the original refusal is what gets thrown.
 */
export async function holdsExactly(
  file: File,
  bytes: Buffer,
): Promise<boolean> {
  try {
    const [meta] = await file.getMetadata();
    const crc = new CRC32C();
    crc.update(bytes);
    return (
      Number(meta.size) === bytes.length &&
      typeof meta.crc32c === "string" &&
      meta.crc32c === crc.toString()
    );
  } catch {
    return false;
  }
}

/** 15 s, 60 s, 240 s, … — `uploadFile`'s re-attempt backoff (MONEY-1608). */
export function retryDelayMs(attempt: number): number {
  return 15_000 * 4 ** (attempt - 1);
}

/**
 * Await one GCS write stream to a VERDICT — MONEY-1608.
 *
 * The promise both upload functions used to build listened for `finish` and
 * `error` and nothing else, with no timer unless the caller passed one. Two
 * ways that promise never settles, and neither is an error:
 *
 *  - the stream CLOSES without either event. A Writable destroyed with no
 *    error emits only `close`, and `createWriteStream`'s own default pipeline
 *    callback is exactly `writeStream.destroy(error || undefined)`;
 *  - nothing is emitted at all, because the SDK is parked on an internal
 *    promise with no socket or timer behind it.
 *
 * In both, nothing holds the event loop, so the process EXITS 0 with the
 * upload's caller still awaiting — `lake-replay-us` did exactly that on
 * 2026-09-23, 8 h into a prod run, mid-way through its final flush.
 *
 * So: `close` before `finish` REJECTS, and a deadline, when given, rejects
 * DIRECTLY as well as destroying the stream. Destroying alone is not enough —
 * `destroy()` on an already-closed stream emits nothing, and the timer that
 * fired was the last handle. The ref'd timer is also what keeps the process
 * alive long enough for either verdict to arrive. Settles exactly once.
 */
export function settleWriteStream(
  ws: Writable,
  opts: {
    label: string;
    timeoutMs?: number;
    onError?: (err: Error) => void;
    start: (ws: Writable) => void;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        opts.onError?.(err);
        reject(err);
      } else resolve();
    };
    const timer =
      typeof opts.timeoutMs === "number" &&
      Number.isFinite(opts.timeoutMs) &&
      opts.timeoutMs > 0
        ? setTimeout(() => {
            const err = new Error(
              `${opts.label}: timed out after ${opts.timeoutMs}ms`,
            );
            ws.destroy(err);
            settle(err);
          }, opts.timeoutMs)
        : undefined;
    ws.on("error", (err: Error) => settle(err));
    ws.on("finish", () => settle());
    ws.on("close", () =>
      settle(
        new Error(
          `${opts.label}: the write stream CLOSED without finishing or ` +
            "erroring — the upload's outcome is unknown (MONEY-1608)",
        ),
      ),
    );
    opts.start(ws);
  });
}

export interface UploadResult {
  /** Public URL of the uploaded file */
  url: string;
  /** Full path in the bucket */
  fileName: string;
  /** Size of the uploaded file in bytes */
  fileSize: number;
  /** MIME type of the file */
  mimeType: string;
}

export interface SignedUrlOptions {
  /** Action type for the signed URL */
  action?: "read" | "write" | "delete" | "resumable";
  /** Expiry time in seconds (default: 900 = 15 minutes) */
  expiresIn?: number;
  /** Content type (required for write actions) */
  contentType?: string;
}

// ============================================================================
// Singleton Storage Client
// ============================================================================

let storage: Storage | null = null;
let bucket: Bucket | null = null;

/**
 * Get or initialize the GCP Storage client
 *
 * Environment variables:
 * - GCP_PROJECT_ID: Google Cloud project ID (required)
 * - GCP_STORAGE_BUCKET: Storage bucket name (required)
 *
 * Credentials resolve via the shared `googleCredentials()` resolver
 * (@usemoney/core/gemini/credentials), preserving the legacy precedence
 * (GCP_SERVICE_ACCOUNT_KEY_BASE64 first) and adding the
 * GOOGLE_APPLICATION_CREDENTIALS_JSON fallback:
 * - GCP_SERVICE_ACCOUNT_KEY_BASE64: Base64-encoded service account JSON (recommended for production)
 * - GOOGLE_APPLICATION_CREDENTIALS_JSON: Raw JSON or base64 service account
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to service account JSON key (for local development)
 * - else Application Default Credentials (Cloud Run attached SA)
 */
function getStorageClient(): Storage {
  if (storage) {
    return storage;
  }

  const projectId = process.env.GCP_PROJECT_ID;

  if (!projectId) {
    throw new Error(
      "GCP_PROJECT_ID environment variable is required for storage operations.",
    );
  }

  // Spread the resolver first, then pin projectId from the explicit
  // GCP_PROJECT_ID env — never the resolver's derived value.
  storage = new Storage({ ...googleCredentials(), projectId });

  return storage;
}

/**
 * Get the storage bucket
 */
function getBucket(): Bucket {
  if (bucket) {
    return bucket;
  }

  const bucketName = process.env.GCP_STORAGE_BUCKET;

  if (!bucketName) {
    throw new Error(
      "GCP_STORAGE_BUCKET environment variable is required for storage operations.",
    );
  }

  const client = getStorageClient();
  bucket = client.bucket(bucketName);
  return bucket;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Upload a file to GCP Cloud Storage
 *
 * @param options - Upload options including file, fileName, contentType
 * @returns Upload result with URL and metadata
 *
 * @example
 * ```typescript
 * const result = await uploadFile({
 *   file: buffer,
 *   fileName: "image.png",
 *   contentType: "image/png",
 *   folder: "content/images",
 *   isPublic: true,
 * });
 * console.log(result.url); // https://storage.googleapis.com/bucket/content/images/image.png
 * ```
 */
export async function uploadFile(
  options: UploadOptions,
): Promise<UploadResult> {
  const {
    file,
    fileName,
    contentType,
    folder,
    userId,
    metadata = {},
    isPublic = true,
    bucketName: overrideBucket,
    timeoutMs,
  } = options;

  // MONEY-865: resolve the bucket up-front, cycle-correct. A PUBLIC upload must
  // target a PUBLIC bucket — the explicit bucketName, else
  // GCP_PUBLIC_STORAGE_BUCKET — and NEVER the private GCP_STORAGE_BUCKET (which
  // silently returned storage.googleapis.com URLs that 403 — the bug that broke
  // blog feature images + studio media). Fail loudly when no bucket resolves
  // instead of producing a dead public URL.
  const resolvedBucket = isPublic
    ? overrideBucket || process.env.GCP_PUBLIC_STORAGE_BUCKET
    : overrideBucket || process.env.GCP_STORAGE_BUCKET;
  if (!resolvedBucket) {
    throw new Error(
      isPublic
        ? "uploadFile(isPublic=true): no public bucket configured — set GCP_PUBLIC_STORAGE_BUCKET or pass an explicit bucketName."
        : "uploadFile: no bucket configured — set GCP_STORAGE_BUCKET or pass an explicit bucketName.",
    );
  }
  const targetBucket = getStorageClient().bucket(resolvedBucket);
  const filePath = folder ? `${folder}/${fileName}` : fileName;
  const gcsFile = targetBucket.file(filePath);

  // Prepare metadata
  const fileMetadata: Record<string, string> = {
    ...metadata,
    contentType,
  };

  if (userId) {
    fileMetadata.uploadedBy = userId;
  }

  // Upload the file.
  //
  // Note: Do NOT set `public: true` - it uses legacy ACLs which fail
  // when uniform bucket-level access is enabled.
  //
  // MONEY-1169: this MUST stay on the resumable path with validation on —
  // see buildStreamOptions for the full story. The two options that used to
  // live here (`resumable: false`, `validation: false`) were a pair of stale
  // workarounds that compounded: the first forced every write onto the
  // multipart wire format that corrupts inside the workers image, and the
  // second silenced the CRC32C check that was correctly reporting it. The
  // result was three months of every feed file and scraped document being
  // stored with the multipart envelope as its content.
  const streamOptions = buildStreamOptions(
    contentType,
    options.cacheControl ??
      (isPublic
        ? "public, max-age=31536000" // 1 year for public content
        : "private, max-age=3600"), // 1 hour for private content
    fileMetadata,
  );

  // MONEY-1157 deadline (destroy on expiry, so the in-flight request is torn
  // down rather than abandoned) and MONEY-1608 settle-on-close — both in
  // `settleWriteStream`, shared with `uploadStream`.
  //
  // MONEY-1608 `retries`: the SDK never retries a write with no
  // `ifGenerationMatch` itself — it is "conditionally idempotent" and
  // `startResumableUpload_` sets `maxRetries = 0` for it — so without this a
  // single transient reset fails the call. Only TRANSIENT failures are
  // re-attempted; see `createOnly` for why a re-attempt never overwrites.
  const attempts = 1 + Math.max(0, Math.floor(options.retries ?? 0));
  for (let attempt = 1; ; attempt++) {
    try {
      await settleWriteStream(
        gcsFile.createWriteStream({
          ...streamOptions,
          ...(options.createOnly
            ? { preconditionOpts: { ifGenerationMatch: 0 } }
            : {}),
        }),
        {
          label: `uploadFile(${filePath})`,
          timeoutMs,
          start: (ws) => ws.end(file),
        },
      );
      break;
    } catch (err) {
      if (
        options.createOnly &&
        isCreateRefusal(err) &&
        (await holdsExactly(gcsFile, file))
      ) {
        break; // an earlier attempt committed these bytes
      }
      if (attempt >= attempts || !isTransientError(err)) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
    }
  }

  // Construct the URL for the uploaded file (resolvedBucket computed above).
  const url = isPublic
    ? `https://storage.googleapis.com/${resolvedBucket}/${filePath}`
    : `gs://${resolvedBucket}/${filePath}`;

  return {
    url,
    fileName: filePath,
    fileSize: file.length,
    mimeType: contentType,
  };
}

/**
 * Stream bytes into the PRIVATE bucket without ever holding the object —
 * MONEY-1373.
 *
 * `uploadFile` takes a whole `Buffer`, which is right for the documents and
 * media it was written for and wrong for a vendor archive: one Databento file
 * is hundreds of megabytes and the harvest holds one in flight per slot.
 * MONEY-1337 is the record of what buffering whole objects costs — a converter
 * OOM-killed twice, a 48,000-document backlog stalled for days.
 *
 * It reuses `buildStreamOptions`, so the two MONEY-1169 properties that must
 * never regress (`resumable: true`; CRC32C validation ON by omission) are
 * stated once and inherited rather than restated here.
 *
 * ALWAYS private. There is no `isPublic` on purpose: this exists for archives,
 * and the public path resolves a DIFFERENT bucket — the MONEY-865 trap that a
 * boolean parameter is exactly how somebody gets wrong.
 */
export async function uploadStream(options: {
  fileName: string;
  folder?: string;
  contentType: string;
  body: NodeJS.ReadableStream;
  timeoutMs?: number;
  bucketName?: string;
  metadata?: Record<string, string>;
}): Promise<{ fileName: string }> {
  const resolvedBucket = options.bucketName || process.env.GCP_STORAGE_BUCKET;
  if (!resolvedBucket) {
    throw new Error(
      "uploadStream: no bucket configured — set GCP_STORAGE_BUCKET or pass an explicit bucketName.",
    );
  }
  const filePath = options.folder
    ? `${options.folder}/${options.fileName}`
    : options.fileName;
  const gcsFile = getStorageClient().bucket(resolvedBucket).file(filePath);

  const streamOptions = buildStreamOptions(
    options.contentType,
    "private, max-age=3600",
    { ...(options.metadata ?? {}) },
  );

  await settleWriteStream(gcsFile.createWriteStream(streamOptions), {
    label: `uploadStream(${filePath})`,
    timeoutMs: options.timeoutMs,
    // THE SOURCE HAS TO DIE TOO. Error propagation was one-directional: the
    // body's failure destroyed the write stream, but a write-stream failure —
    // including this function's own timeout — left the body alive and its
    // socket held. Over a harvest's ~1,500 files with retries that
    // accumulates. `ReadableStream` in the public type; a Node `Readable` at
    // runtime, which is what `pipe` relies on. Narrowed rather than widened so
    // a genuinely web-stream caller is a no-op instead of a crash.
    onError: (err) =>
      (options.body as unknown as { destroy?: (e?: Error) => void }).destroy?.(
        err,
      ),
    start: (ws) => {
      // The SOURCE's failure has to reach this promise too. Without it a
      // broken download would leave the write stream open until its own
      // timeout and report a timeout rather than the real cause.
      options.body.on("error", (err: Error) => ws.destroy(err));
      options.body.pipe(ws);
    },
  });

  return { fileName: filePath };
}

/**
 * A read stream for an object, or `null` when it genuinely is not there —
 * MONEY-1373.
 *
 * The two-way answer matters as much here as it does for `downloadFile`:
 * `null` means absent and anything else throws, so a caller can never read a
 * credentials failure as an empty archive. `exists()` is checked first because
 * `createReadStream` reports a missing object as a stream error, and a stream
 * error is not something a caller can distinguish from a transport fault.
 */
export async function downloadStream(
  fileName: string,
): Promise<NodeJS.ReadableStream | null> {
  const bucket = getBucket();
  const file = bucket.file(fileName);
  const [exists] = await file.exists();
  if (!exists) return null;
  return file.createReadStream();
}

/**
 * Delete a file from GCP Cloud Storage
 *
 * @param fileName - Full path of the file in the bucket
 *
 * @example
 * ```typescript
 * await deleteFile("content/images/image.png");
 * ```
 */
export async function deleteFile(fileName: string): Promise<void> {
  const bucket = getBucket();
  const file = bucket.file(fileName);

  try {
    await file.delete();
  } catch (error) {
    // Ignore "the object is not there" — deleting an absent object is a no-op.
    // A MISSING BUCKET is a different 404 and must not be swallowed: it would
    // report every delete as succeeding against a bucket that does not exist.
    if (isObjectNotFound(error)) return;
    throw error;
  }
}

/**
 * Generate a signed URL for temporary access to a file
 *
 * @param fileName - Full path of the file in the bucket
 * @param options - Signed URL options
 * @returns Signed URL string
 *
 * @example
 * ```typescript
 * // Read access for 15 minutes
 * const url = await getSignedUrl("videos/lesson-1.mp4", { expiresIn: 900 });
 *
 * // Write access for uploading
 * const uploadUrl = await getSignedUrl("uploads/temp.jpg", {
 *   action: "write",
 *   contentType: "image/jpeg",
 *   expiresIn: 300,
 * });
 * ```
 */
export async function getSignedUrl(
  fileName: string,
  options: SignedUrlOptions = {},
): Promise<string> {
  const { action = "read", expiresIn = 900, contentType } = options;

  const bucket = getBucket();
  const file = bucket.file(fileName);

  const [url] = await file.getSignedUrl({
    version: "v4",
    action,
    expires: Date.now() + expiresIn * 1000,
    contentType: action === "write" ? contentType : undefined,
  });

  return url;
}

/**
 * Check if a file exists in the bucket
 *
 * @param fileName - Full path of the file in the bucket
 * @returns True if file exists
 */
/* ─────────────────────────────────────────────────────────────────────────
   404 IS TWO DIFFERENT ANSWERS (MONEY-979)
   ──────────────────────────────────────────────────────────────────────── */

/**
 * GCS answers **404 for a nonexistent BUCKET** exactly as it does for a
 * nonexistent object. Measured, not inferred, against the live API:
 *
 * ```
 * GET /storage/v1/b/<bucket-that-does-not-exist>/o/foo?alt=media
 *   -> HTTP 404  "The specified bucket does not exist."
 * GET /storage/v1/b/<real-bucket>/o/<object-that-does-not-exist>?alt=media
 *   -> HTTP 404  "No such object: <bucket>/<object>"
 * ```
 *
 * and against `@google-cloud/storage` 7.18 itself, which turns both into an
 * `ApiError` with `code === 404`, `instanceof Error`, and `"code" in error`.
 * The ONLY difference is the text, and `catch` was discarding it.
 *
 * So a misspelled, deleted or rotated `GCP_STORAGE_BUCKET` made every
 * `downloadFile` return `null` — no throw, no log, no distinguishing signal.
 * For the 13F cold store that is the worst possible shape: `null` is the port's
 * word for "this quarter is genuinely not archived", so a whole-bucket
 * misconfiguration would have reported EVERY manager as holding nothing, with
 * `COLD_SHARD_ABSENT` as its diagnosis and nothing anywhere naming the bucket.
 * It is the MONEY-941 failure (`listFiles` failing open to `[]`) one layer
 * down, and this package already carries that scar in `listFiles`.
 *
 * Matching the BUCKET phrasing rather than the object one is deliberate. The
 * inverse ("return null only when the message says `No such object`") would
 * turn every ordinary absent object into a THROW the day Google reworded the
 * message — a new failure path on the common case, to catch a rare one. This
 * direction can only ever fail back to today's behaviour.
 *
 * Both spellings are covered: the JSON API's prose and the XML API's
 * `NoSuchBucket` code, which surfaces on the signed-URL / media paths.
 */
export function isBucketNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!("code" in error) || (error as { code?: unknown }).code !== 404) {
    return false;
  }
  return /bucket\s+does\s+not\s+exist|no\s*such\s*bucket/i.test(error.message);
}

/**
 * A 404 that means "the object is not there", i.e. a real answer.
 *
 * Anything else 404 — today only a missing bucket — is a CONFIGURATION
 * failure and must propagate.
 */
function isObjectNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === 404 &&
    !isBucketNotFound(error)
  );
}

export async function fileExists(fileName: string): Promise<boolean> {
  const bucket = getBucket();
  const file = bucket.file(fileName);

  try {
    const [exists] = await file.exists();
    return exists;
  } catch {
    return false;
  }
}

/**
 * Download a file from GCP Cloud Storage
 *
 * @param fileName - Full path of the file in the bucket
 * @returns File content as Buffer, or null if not found
 */
export async function downloadFile(
  fileName: string,
  options?: { bucketName?: string },
): Promise<Buffer | null> {
  // MONEY-1467 — an explicit bucket, for objects that do NOT live in the
  // content bucket. Tiles live in `stockbook-lake-{env}` (the lake contract
  // routes the `tiles/` prefix there), and without this the tile reader would
  // silently read the CONTENT bucket, 404 on every key, and report the lake as
  // empty — which is indistinguishable from "the builder has not run yet".
  //
  // `uploadFile` already took a `bucketName`; only the read half was missing,
  // so a writer could target the lake and the matching reader could not.
  // Default path is byte-identical to before: no option, no behaviour change.
  const bucket = options?.bucketName
    ? getStorageClient().bucket(options.bucketName)
    : getBucket();
  const file = bucket.file(fileName);

  try {
    const [content] = await file.download();
    return content;
  } catch (error) {
    // `null` means "this object is not there" and callers act on it — the 13F
    // cold store turns it into `absent`. A MISSING BUCKET is also a 404 and is
    // not that answer; see `isBucketNotFound`.
    if (isObjectNotFound(error)) return null;
    throw error;
  }
}

/**
 * Get file metadata
 *
 * @param fileName - Full path of the file in the bucket
 * @returns File metadata or null if not found
 */
export async function getFileMetadata(
  fileName: string,
): Promise<Record<string, unknown> | null> {
  const bucket = getBucket();
  const file = bucket.file(fileName);

  try {
    const [metadata] = await file.getMetadata();
    return metadata as Record<string, unknown>;
  } catch (error) {
    // Same split as `downloadFile`: absent object -> null, absent bucket ->
    // throw. A `null` here reads as "no such object", which is the wrong answer
    // to give about a bucket that does not exist.
    if (isObjectNotFound(error)) return null;
    throw error;
  }
}

/**
 * The bucket's metadata (lifecycle rules, soft-delete policy, …), read through
 * the SAME credentialed client
 * everything else uses.
 *
 * Exists because the first version of the caller built its own
 * `new Storage({ projectId })`, which silently bypassed
 * `GCP_SERVICE_ACCOUNT_KEY_BASE64` and fell back to Application Default
 * Credentials — expired on a laptop, `invalid_rapt` on every call. Any helper
 * that constructs its own client is a second credential path, and the one that
 * is not exercised in production is the one that breaks.
 *
 * THROWS. A caller must be able to tell "this bucket has no rules" from "I
 * could not ask", because the two render identically and only one of them is a
 * finding.
 */
export async function getBucketMetadata(): Promise<Record<string, unknown>> {
  const [meta] = await getBucket().getMetadata();
  return meta as unknown as Record<string, unknown>;
}

/** One object, as the JSON API describes it. */
export interface ObjectSummary {
  name: string;
  /** Bytes. The JSON API returns this as a STRING; it is coerced here. */
  size: number;
  /** STANDARD | NEARLINE | COLDLINE | ARCHIVE. */
  storageClass: string;
  /**
   * The GCS generation — which VERSION of this key. MONEY-1474.
   *
   * `null` means "the listing did not say", which is a DIFFERENT fact from any
   * number. A ledger uses this as half its identity, so a fabricated 0 would be
   * a version pin matching no object that exists.
   */
  generation: number | null;
  /** `null` means the listing did not say. Never guessed. */
  contentType: string | null;
  /** When the object was CREATED. `null` means the listing did not say. */
  timeCreated: Date | null;
}

/**
 * Coerce a JSON-API numeric field, keeping "absent" DISTINCT from a value.
 *
 * `Number(null)` and `Number("")` are BOTH 0 and BOTH pass `Number.isFinite`,
 * so the obvious `Number.isFinite(Number(x)) ? Number(x) : null` records an
 * absent generation as a confident `0`. That is this repo's standing rule
 * inverted — "couldn't determine" must be its own value, never a fail-open
 * default (MONEY-1474).
 */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stream every object under `prefix` with its size and storage class.
 *
 * ## THIS ONE THROWS, and that is the whole point
 *
 * `listFiles` below fails OPEN to `[]` — deliberately, for callers that treat
 * "no files" and "could not look" alike. That contract is wrong for a SIZE
 * REPORT: a listing truncated by an auth failure or a network blip would render
 * as a smaller prefix, and a smaller prefix reads as a smaller transfer bill
 * and a MOVE recommendation for data that should have stayed. An error here
 * propagates and the report is not written at all.
 *
 * ## Paged, and never accumulated
 *
 * `bucket.getFiles({ prefix })` auto-paginates and buffers EVERY object into
 * one array before resolving. Against `edgar/`, which the design notes size at
 * ~330 GB/yr of raw filings, that is an OOM rather than a slow call. This pages
 * explicitly and yields, so the caller aggregates as it goes and peak memory is
 * one page.
 *
 * Callers must still treat the result as a SIZE measurement and never as
 * evidence about the presence of a particular object — for that, compute the
 * key and `get` it, or ask the ledger.
 */
export async function* streamObjectSummaries(
  prefix: string,
  pageSize = 1000,
  opts: { softDeleted?: boolean } = {},
): AsyncGenerator<ObjectSummary> {
  const bucket = getBucket();
  let pageToken: string | undefined;

  do {
    // `GetFilesResponse` is a 3-tuple (files, nextQuery, apiResponse); destructure
    // the two that matter and read them through the library's own types.
    // `softDeleted: true` returns ONLY soft-deleted objects, never live ones —
    // the two passes are disjoint and a caller sums them. GCS BILLS FOR
    // SOFT-DELETED BYTES throughout the retention window, so a size report that
    // omits them under-reports the storage line by whatever was deleted that
    // week. Live-only is right for every other caller, so it stays the default.
    const query: GetFilesOptions = {
      prefix,
      autoPaginate: false,
      maxResults: pageSize,
      pageToken,
    };
    // `softDeleted` is newer than the typings in this version, hence the cast at
    // the one property rather than over the whole call — casting the object
    // would have silently selected the CALLBACK overload.
    if (opts.softDeleted) (query as Record<string, unknown>).softDeleted = true;

    const [files, nextQuery] = await bucket.getFiles(query);

    for (const file of files) {
      const meta = (file.metadata ?? {}) as Record<string, unknown>;
      // `size` arrives as a string. `Number(undefined)` is NaN, which would
      // poison every total downstream — a NaN byte count renders as "—" and
      // silently drops that object from the sum.
      const size = Number(meta.size);
      const created =
        typeof meta.timeCreated === "string"
          ? new Date(meta.timeCreated)
          : null;
      yield {
        name: file.name,
        // `0` here is deliberate and PREDATES the fields below: this is a SIZE
        // REPORT's sum, where NaN renders as "—" and drops the object silently.
        // The new fields take the opposite default because a ledger must not
        // fabricate an identity — see `numOrNull`.
        size: Number.isFinite(size) ? size : 0,
        storageClass:
          typeof meta.storageClass === "string" ? meta.storageClass : "UNKNOWN",
        generation: numOrNull(meta.generation),
        contentType:
          typeof meta.contentType === "string" ? meta.contentType : null,
        timeCreated:
          created && !Number.isNaN(created.getTime()) ? created : null,
      };
    }

    pageToken = (nextQuery as { pageToken?: string } | null)?.pageToken;
  } while (pageToken);
}

/**
 * List files with a given prefix
 *
 * @param prefix - Directory prefix (e.g., "content/images/")
 * @returns Array of file paths
 */
export async function listFiles(prefix: string): Promise<string[]> {
  const bucket = getBucket();

  try {
    const [files] = await bucket.getFiles({ prefix });
    return files.map((file) => file.name);
  } catch (error) {
    // The empty return is kept for callers that treat "no files" and "could not
    // look" the same way, but it MUST be logged (MONEY-941). Swallowing this
    // silently makes an auth or network failure indistinguishable from an empty
    // prefix, and the difference is the difference between "nothing to do" and
    // "everything is broken": the archive parse job read this as "0 files
    // archived, parse complete" on a credentials failure and exited 0.
    console.error(
      `[storage] listFiles("${prefix}") FAILED — returning [], which callers ` +
        `cannot distinguish from an empty prefix:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// MONEY-1169: detection + repair of the multipart-envelope corruption.
export {
  isMultipartEnvelope,
  stripMultipartEnvelope,
  type StrippedEnvelope,
} from "./multipart-envelope";

// Read-only archive integrity classification (MONEY-1204 / 14a.1). Lives beside
// the envelope detector it reuses, so there is exactly one implementation of
// "is this object corrupt".
export {
  classifyArchivedObject,
  // MONEY-1323: exported so `feed-repair`'s `verifyPayload` can CALL it instead
  // of carrying a second copy of the same rules. The copies had already
  // diverged on `<?xml-stylesheet`, `.xls/.xlsx` and `.xml`.
  classifyPayloadBytes,
  archiveFamilyOf,
  recordArchiveVerdict,
  emptyFamilyAudit,
  isEnvelopeVerdictKind,
  ARCHIVE_AUDIT_HEAD_BYTES,
  ENVELOPE_VERDICT_KINDS,
  type ArchiveVerdict,
  type ArchiveVerdictKind,
  type ArchiveFamilyAudit,
  type PayloadVerdict,
} from "./archive-audit";

// MONEY-1322: derive the repair pool from the container's memory and the
// per-object ceiling, so the job self-limits instead of relying on an operator
// remembering the sentence in the provisioning script.
export {
  deriveDownloadConcurrency,
  parseContainerMi,
  LIVE_BUFFERS_PER_SLOT,
  RUNTIME_RESERVE_MI,
  DEFAULT_CONTAINER_MI,
  type DownloadConcurrencyPlan,
} from "./download-budget";
