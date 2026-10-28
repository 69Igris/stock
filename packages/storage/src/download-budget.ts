/**
 * How many whole objects may be in flight at once — MONEY-1322.
 *
 * ## The defect this exists to remove
 *
 * `scripts/ops/setup-feed-backfill-job.sh` step 4a stated the arithmetic and
 * then deployed against it:
 *
 *   "2Gi: the walk holds up to `--concurrency` (default 12) objects in memory
 *    at once, each capped at `--max-bytes` (default 100 MB), and stripping the
 *    envelope allocates a SECOND buffer per slot. Lower --concurrency rather
 *    than raising memory when a run is scoped to the large `stocks/` PDFs."
 *
 * 12 x 100 MB x 2 is ~2.4 GB against a task sized 2Gi. The mitigation is the
 * last sentence — PROSE, encoded nowhere — while the command the script PRINTS
 * for an operator to paste is a bare `--args="--apply"`, i.e. both prefixes, the
 * default concurrency and the default ceiling: the widest, heaviest run
 * available. The job was sized against its own documented worst case and asked
 * a human to remember the difference.
 *
 * An OOM kill on Cloud Run is the failure mode this job cannot report on
 * itself: the task disappears mid-object with no DONE line, so the run looks
 * like an infrastructure blip rather than a budget the operator blew.
 *
 * So the job DERIVES its pool at startup from two numbers it already knows —
 * the container's memory and the per-object ceiling — and logs the derivation.
 * Prose becomes arithmetic; `--concurrency` becomes a CAP the derivation may
 * lower but never raise.
 *
 * ## The per-slot model, read off the source rather than estimated
 *
 * A slot in the repair pool costs, at peak:
 *
 *   1x  `file.download()` collects the response chunks into an array and
 *       returns ONE concatenated Buffer. Both are live across the concat, so
 *       the download alone peaks at ~2x the object.
 *   1x  the settled buffer, which stays reachable for the whole slot —
 *       `stripMultipartEnvelope` returns `payload` as a `subarray`, i.e. a VIEW
 *       onto the downloaded bytes, not a copy. (The script's old comment said
 *       it "allocates a SECOND buffer"; it does not. The consequence is the
 *       same either way: the FULL object stays alive as long as the payload
 *       does, so a view is no cheaper than a copy here.)
 *   1x  `--apply` hands that payload to `uploadFile`, whose resumable stream
 *       buffers a chunk of it on the way out.
 *
 * {@link LIVE_BUFFERS_PER_SLOT} = 3 is that model. It is deliberately the
 * pessimistic reading: V8 frees the chunk array only when GC gets to it, and a
 * pool whose slots all peak together is exactly the moment GC is behind.
 *
 * {@link RUNTIME_RESERVE_MI} = 256 covers everything that is not a payload:
 * Node's own floor (~68 MB, measured for the doc-convert work in MONEY-1314),
 * the `@google-cloud/storage` client, a 500-object `getFiles` page with its
 * metadata, and the failure reporter's bounded maps.
 *
 * ## Why it lives in `@usemoney/storage` and not in the job
 *
 * Same reason the archive classifier does: a pure function here is unit-
 * testable, and a constant buried in a `scripts/jobs/*.ts` entry point is not —
 * that file calls `main()` at module scope, so importing it to test it RUNS it.
 * A budget nobody can test is the prose this replaces.
 */

/**
 * Live copies of one object a slot may hold at peak. See the module header —
 * download concat + retained buffer + upload chunk.
 */
export const LIVE_BUFFERS_PER_SLOT = 3;

/**
 * MiB withheld from the payload budget for the runtime itself: Node's ~68 MB
 * floor, the GCS client, one 500-object listing page, the reason tallies.
 */
export const RUNTIME_RESERVE_MI = 256;

/**
 * The memory a `feed-repair` task is provisioned with when nothing declares it.
 *
 * Used ONLY when the declaration is ABSENT, never when it is present and
 * unreadable — see {@link parseContainerMi}. Absence is the local-laptop case
 * and the not-yet-reprovisioned-job case, and assuming the deployed size is
 * safe in both directions: on Cloud Run it is exactly right, and on a 32 GB
 * laptop it only makes the run slower. Assuming the LAPTOP's size on Cloud Run
 * is the failure that cannot be undone.
 */
export const DEFAULT_CONTAINER_MI = 2048;

const BYTES_PER_MI = 1024 * 1024;

/**
 * Read a container memory declaration into MiB.
 *
 * Accepts a bare integer (MiB, the form an ops script writes) and the Cloud Run
 * size forms `512Mi` / `2Gi` (the form a human types, because it is what
 * `--memory` takes). Anything else THROWS.
 *
 * ## Set-but-unreadable THROWS; absent does not
 *
 * These are different states and must not collapse into one, which is the
 * MF_METADATA_PROVIDER lesson (MONEY-1214) and the `--memory` half of
 * MONEY-1314. `FEED_REPAIR_CONTAINER_MI=2G` — the correct Cloud Run spelling
 * minus one character — is a configuration that LOOKS applied. Falling back to
 * a default there reinstates the exact overshoot this module exists to prevent,
 * with a log line as the only symptom. Absent is a different claim ("nobody
 * told me"), it has a safe answer ({@link DEFAULT_CONTAINER_MI}), and the
 * caller is expected to say which one it used.
 *
 * @throws if `raw` is present but not a positive integer size.
 */
export function parseContainerMi(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const m = /^(\d+)(Mi|Gi)?$/.exec(trimmed);
  if (!m) {
    throw new Error(
      `container memory "${raw}" is not a size: expected MiB as a bare ` +
        `integer (2048), or a Cloud Run size (512Mi, 2Gi). Refusing to guess ` +
        `— a mis-set ceiling reads as a configured one and the task is ` +
        `OOM-killed with no summary line (MONEY-1322).`,
    );
  }
  const n = Number(m[1]);
  const mi = m[2] === "Gi" ? n * 1024 : n;
  if (!Number.isFinite(mi) || mi <= 0) {
    throw new Error(
      `container memory "${raw}" resolves to ${mi}MiB — must be positive.`,
    );
  }
  return mi;
}

export interface DownloadConcurrencyPlan {
  /** The pool size to actually use. Always >= 1. */
  concurrency: number;
  /** What the caller asked for, before the memory ceiling was applied. */
  requested: number;
  containerMi: number;
  /** Bytes available for payloads after {@link RUNTIME_RESERVE_MI}. */
  budgetBytes: number;
  /** Peak bytes one slot may hold: `maxBytes * LIVE_BUFFERS_PER_SLOT`. */
  perSlotBytes: number;
  /**
   * Does `concurrency * perSlotBytes` fit `budgetBytes`?
   *
   * FALSE only when a SINGLE object of `maxBytes` cannot fit — the floor of 1
   * has been applied and the run may still be OOM-killed. The caller must warn;
   * refusing to start would be worse, because one-at-a-time is exactly how the
   * five oversized `stocks/` PDFs get repaired (MONEY-1323).
   */
  fitsWorstCase: boolean;
  /** One line, ready to log. The derivation, not just the answer. */
  why: string;
}

/**
 * Derive a pool size whose WORST CASE fits the container.
 *
 * `maxBytes` is the per-object ceiling the caller enforces — `--max-bytes` for
 * the repair walk, which downloads whole objects. The AUDIT passes
 * `ARCHIVE_AUDIT_HEAD_BYTES` instead, because it reads ~1 KiB per object and a
 * memory bound derived from `--max-bytes` would slow a 425,425-object,
 * latency-bound walk for no reason. One function, one honest argument each.
 *
 * Pure: no env, no clock. The container size is resolved by the caller (see
 * {@link parseContainerMi}) precisely so this can be pinned in a unit test.
 */
export function deriveDownloadConcurrency(args: {
  requested: number;
  containerMi: number;
  maxBytes: number;
  reserveMi?: number;
  buffersPerSlot?: number;
}): DownloadConcurrencyPlan {
  const {
    requested,
    containerMi,
    maxBytes,
    reserveMi = RUNTIME_RESERVE_MI,
    buffersPerSlot = LIVE_BUFFERS_PER_SLOT,
  } = args;

  const perSlotBytes = Math.max(1, Math.ceil(maxBytes * buffersPerSlot));
  const budgetBytes = Math.max(0, (containerMi - reserveMi) * BYTES_PER_MI);
  const affordable = Math.floor(budgetBytes / perSlotBytes);

  // Floor of 1, ceiling of what was asked for. The derivation may only ever
  // LOWER the pool: a caller that passed `--concurrency=2` for its own reasons
  // (an upstream rate limit, a shared budget) must not be overridden upward by
  // an arithmetic that knows nothing about those reasons.
  const safeRequested =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1;
  const concurrency = Math.max(1, Math.min(safeRequested, affordable));
  const fitsWorstCase = concurrency * perSlotBytes <= budgetBytes;

  // Sub-MiB values print as KiB: the AUDIT's ceiling is one head read (1 KiB),
  // and rendering it "0MiB ceiling x 3 = 0MiB per slot" makes a correct
  // derivation read as a broken one.
  const mib = (n: number) =>
    n < BYTES_PER_MI
      ? `${(n / 1024).toFixed(n < 1024 ? 2 : 0)}Ki`
      : `${(n / BYTES_PER_MI).toFixed(0)}Mi`;
  const why =
    `concurrency=${concurrency} (requested ${safeRequested}) — ` +
    `${containerMi}MiB task less ${reserveMi}MiB runtime reserve = ` +
    `${mib(budgetBytes)}B for payloads; ${mib(maxBytes)}B ceiling x ` +
    `${buffersPerSlot} live buffers = ${mib(perSlotBytes)}B per slot; ` +
    `${affordable} slot(s) affordable` +
    (concurrency < safeRequested
      ? ` — LOWERED from ${safeRequested} to fit`
      : "") +
    (fitsWorstCase
      ? ` | worst case ${mib(concurrency * perSlotBytes)}B of ` +
        `${mib(budgetBytes)}B`
      : ` | DOES NOT FIT: one object of ${mib(maxBytes)}B needs ` +
        `${mib(perSlotBytes)}B and only ${mib(budgetBytes)}B is available` +
        ` — raise the task memory or lower --max-bytes`);

  return {
    concurrency,
    requested: safeRequested,
    containerMi,
    budgetBytes,
    perSlotBytes,
    fitsWorstCase,
    why,
  };
}
