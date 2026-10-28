/**
 * The lake ledger's decisions. MONEY-1472 (data-platform B1).
 *
 * Pure: no BigQuery, no clock, no filesystem. `ledger.ts` is the I/O shell.
 * Every later load prompt (B2, B2-IN, B5) asks this module whether its work is
 * already done, so a wrong answer here is either a silently skipped load or a
 * doubled one, in a table nobody reads row by row.
 *
 * ## WHAT REPLACES WHAT
 *
 * Databento's file inventory lives in `DatabentoBatchJob.files`, a Mongo `Json`
 * array, and load coverage is a LOG LINE in the harvest runbook. Neither is
 * queryable, neither survives a re-parse, and neither can answer "is this
 * partition already loaded?" — the only question that makes a replay idempotent.
 */

/* ─────────────────────────────────────────────────────────────────────────
   States
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A raw object's state. STRINGS, not a BigQuery enum.
 *
 * BigQuery has no ENUM type, and a hand-rolled one costs a schema migration
 * every time a state is added. The set is closed HERE and validated on write,
 * which is where an unknown value can still be refused.
 */
export const SOURCE_OBJECT_STATES = [
  "PRESENT",
  "VERIFIED",
  "MISSING",
  "EXPIRED",
] as const;
export type SourceObjectState = (typeof SOURCE_OBJECT_STATES)[number];

/**
 * A partition's load state.
 *
 *   LOADING     claimed, in flight
 *   ACCEPTED    loaded and the coverage gate passed — the ONLY state that skips
 *   REJECTED    loaded and refused; the rows are in `quarantine`
 *   SUPERSEDED  a later (source_hash, parser_version) for the same partition
 *               was accepted, so this row is history rather than truth
 */
export const PARTITION_STATES = [
  "LOADING",
  "ACCEPTED",
  "REJECTED",
  "SUPERSEDED",
] as const;
export type PartitionState = (typeof PARTITION_STATES)[number];

export function isSourceObjectState(v: unknown): v is SourceObjectState {
  return (
    typeof v === "string" &&
    (SOURCE_OBJECT_STATES as readonly string[]).includes(v)
  );
}

export function isPartitionState(v: unknown): v is PartitionState {
  return (
    typeof v === "string" && (PARTITION_STATES as readonly string[]).includes(v)
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   The idempotency key
   ──────────────────────────────────────────────────────────────────────── */

/**
 * What identifies one load attempt.
 *
 * FIVE parts, and each earns its place:
 *
 *   dataset + table     where the rows land
 *   partitionKey        which slice (a date, a symbol-year — the loader's unit)
 *   sourceHash          WHICH BYTES. A vendor re-issuing a file with corrected
 *                       data has the same partition and different content, and
 *                       must re-load rather than skip.
 *   parserVersion       WHICH CODE. A parser bug fixed in B5 has to re-run over
 *                       bytes that have not changed — without this the fix can
 *                       never reach already-loaded partitions, which is exactly
 *                       how a stamped-but-wrong row becomes permanent.
 */
export interface PartitionKey {
  dataset: string;
  table: string;
  partitionKey: string;
  sourceHash: string;
  parserVersion: string;
}

/**
 * The separator for the composite identity.
 *
 * A NUL, not `|` or `:`. A partition key is caller-supplied — a date, a symbol,
 * a symbol-year — and symbols in this repo legitimately contain both of those
 * (`664UP30-SG`, `BRK.B`, `RELIANCE:NSE`). Joining on a character the inputs
 * can carry lets two DIFFERENT keys collapse onto one identity, which reads as
 * "already loaded" and silently skips a real load.
 */
const KEY_SEP = String.fromCharCode(0);

/** A stable, collision-resistant string for the five-part key. */
export function partitionIdentity(k: PartitionKey): string {
  return [
    k.dataset,
    k.table,
    k.partitionKey,
    k.sourceHash,
    k.parserVersion,
  ].join(KEY_SEP);
}

export class InvalidPartitionKeyError extends Error {
  constructor(field: string, value: unknown) {
    super(
      `partition key field "${field}" is empty or not a string (${String(value)}) — ` +
        "an empty component collapses distinct partitions onto one identity, " +
        "which reads as ALREADY LOADED and silently skips the load",
    );
    this.name = "InvalidPartitionKeyError";
  }
}

/** Refuse a key with an empty component rather than hash it into a collision. */
export function assertPartitionKey(k: PartitionKey): void {
  for (const field of [
    "dataset",
    "table",
    "partitionKey",
    "sourceHash",
    "parserVersion",
  ] as const) {
    const v = k[field];
    if (typeof v !== "string" || v.trim() === "") {
      throw new InvalidPartitionKeyError(field, v);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   The claim decision — the one every loader asks
   ──────────────────────────────────────────────────────────────────────── */

/**
 * How long a LOADING claim is honoured before another run may take it.
 *
 * A claim that is never released would otherwise block its partition FOR EVER:
 * a Cloud Run task killed mid-load leaves LOADING behind, and a claim check
 * that treats LOADING as "someone is working" would then skip that partition on
 * every subsequent run, silently, with the ledger reporting healthy.
 *
 * Six hours: longer than any single partition load, short enough that a crash
 * costs one cycle rather than a manual repair.
 */
export const CLAIM_LEASE_MS = 6 * 3600_000;

/**
 * A skip carries WHY, as a value rather than as prose — MONEY-1516 review.
 *
 * The two skips mean opposite things to an operator and the callers could not
 * tell them apart: `reason` is free text, so both summarised as "already
 * ACCEPTED — nothing to do". Measured the hard way — a spread load died on a
 * missing `GCP_STORAGE_BUCKET` holding four claims, and the next run reported
 * every month ACCEPTED with `wrote 0` while `spread_cost_daily` stayed EMPTY
 * and would have stayed empty for the six hours of the lease.
 *
 *   "accepted"  the work is DONE. An empty run is health.
 *   "leased"    the work is NOT done and this run may not do it. Another
 *               process holds the claim — or held it and died. Work remains.
 *
 * This is the same rule `databento-append` already follows with its three
 * distinct skip reasons: collapsing a never-harvested entry and a current one
 * into one message makes the broken state indistinguishable from the healthy
 * one, forever.
 */
export type ClaimVerdict =
  | { action: "skip"; kind: "accepted" | "leased"; reason: string }
  | { action: "load"; reason: string };

export interface ExistingClaim {
  state: PartitionState;
  /** When the row was last written. Epoch ms. */
  loadedAtMs: number;
}

/**
 * Should this loader do the work?
 *
 * ONLY `ACCEPTED` skips. The other three states are each a reason to run:
 *
 *   REJECTED    the last attempt failed its gate; re-running is the fix
 *   SUPERSEDED  this exact (hash, version) lost to a later one — but a caller
 *               asking again with THIS identity is deliberately re-running a
 *               specific version, and refusing would make a rollback impossible
 *   LOADING     in flight, honoured only while the lease holds
 *
 * A null row means never attempted, which is the common case.
 */
export function decideClaim(
  existing: ExistingClaim | null,
  nowMs: number,
): ClaimVerdict {
  if (!existing) return { action: "load", reason: "no prior attempt" };

  if (existing.state === "ACCEPTED") {
    return {
      action: "skip",
      kind: "accepted",
      reason: "already ACCEPTED for this (source hash, parser version)",
    };
  }

  if (existing.state === "LOADING") {
    const ageMs = nowMs - existing.loadedAtMs;
    if (ageMs <= CLAIM_LEASE_MS) {
      return {
        action: "skip",
        kind: "leased",
        reason: `another run claimed it ${Math.round(ageMs / 60_000)}m ago and the lease holds`,
      };
    }
    // The lease EXPIRED. A killed task must not park a partition for ever.
    return {
      action: "load",
      reason: `a LOADING claim went stale (${Math.round(ageMs / 3600_000)}h) — reclaiming`,
    };
  }

  return {
    action: "load",
    reason: `prior attempt is ${existing.state}; re-running`,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Coverage — what makes an ACCEPT honest
   ──────────────────────────────────────────────────────────────────────── */

export type CoverageVerdict =
  | { accept: true }
  | { accept: false; reason: string };

/**
 * May this partition be ACCEPTED?
 *
 * A load that wrote SOME rows is not a load that succeeded, and `ACCEPTED` is
 * what makes every future run skip — so accepting a partial partition freezes
 * the gap permanently. `expectedSessions` is the loader's own count of what the
 * source says should be there; `actualSessions` is what landed.
 *
 * ZERO EXPECTED IS A REFUSAL, not a pass. `0 >= 0` is true, so a loader that
 * could not work out what to expect would otherwise accept an empty partition
 * for ever — the not-measured-is-not-passed defect this repo has now shipped at
 * four layers.
 */
export function decideCoverage(args: {
  rowCount: number;
  expectedSessions: number;
  actualSessions: number;
}): CoverageVerdict {
  const { rowCount, expectedSessions, actualSessions } = args;

  if (!Number.isFinite(expectedSessions) || expectedSessions <= 0) {
    return {
      accept: false,
      reason:
        "expectedSessions is zero or unknown — the loader could not say what " +
        "should be here, and an unmeasured partition must not be ACCEPTED",
    };
  }
  if (!Number.isFinite(rowCount) || rowCount <= 0) {
    return { accept: false, reason: "no rows were written" };
  }
  if (!Number.isFinite(actualSessions) || actualSessions < expectedSessions) {
    return {
      accept: false,
      reason: `partial: ${actualSessions}/${expectedSessions} sessions present`,
    };
  }
  return { accept: true };
}

/**
 * `acceptPartition`'s refusal. A CLASS, so a caller can continue past exactly
 * this and nothing else — matched with `instanceof`, never a message regex.
 */
export class CoverageRefusedError extends Error {
  /** `decideCoverage`'s reason, e.g. `partial: 19/23 sessions present`. */
  readonly reason: string;
  constructor(reason: string) {
    super(`refusing to ACCEPT this partition: ${reason}`);
    this.name = "CoverageRefusedError";
    this.reason = reason;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   One refused month must not end the run — MONEY-1612
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The sessions a loader EXPECTED and did not get, sorted. The loader holds both
 * sets already; naming the dates is what turns "19/23" into something an
 * operator can check against a holiday list or the archive.
 */
export function missingSessions(
  expected: Iterable<string>,
  present: ReadonlySet<string>,
): string[] {
  return [...new Set(expected)].filter((d) => !present.has(d)).sort();
}

export interface PartitionRefusal {
  table: string;
  partitionKey: string;
  reason: string;
  rowCount: number;
  expectedSessions: number;
  actualSessions: number;
  missingSessions: readonly string[];
}

/** `REFUSED <table> <partition> partial: a/b sessions present — missing: …` */
export function formatRefusal(r: PartitionRefusal): string {
  const missing = r.missingSessions.length
    ? r.missingSessions.join(", ")
    : "(not computable)";
  return `REFUSED ${r.table} ${r.partitionKey} ${r.reason} — missing: ${missing}`;
}

/** The ledger calls `acceptOrRefuse` makes. Injected so it can be tested. */
export interface RefusalLedger {
  accept(
    key: PartitionKey,
    args: {
      runId: string;
      rowCount: number;
      expectedSessions: number;
      actualSessions: number;
    },
  ): Promise<void>;
  reject(
    key: PartitionKey,
    args: {
      runId: string;
      rowCount: number;
      expectedSessions: number;
      actualSessions: number;
    },
  ): Promise<void>;
  quarantine(args: {
    dataset: string;
    table: string;
    partitionKey: string;
    runId: string;
    reason: string;
    sample?: unknown;
  }): Promise<void>;
}

/**
 * ACCEPT a loaded partition, or — on a COVERAGE refusal only — mark it REJECTED
 * and return the refusal so the caller can go on to the next partition.
 *
 * Before this, `lake-replay-in` let `CoverageRefusedError` escape: the first
 * partial month exited the container 1 and every later month was never tried
 * (prod, 2026-09-23, delivery_daily from 2019-10), and the refused month sat in
 * LOADING for the six-hour lease instead of reading as refused.
 *
 * REJECTED, not left LOADING: it releases the claim now (`decideClaim` loads
 * over REJECTED), it carries the counts, and the named reason plus the missing
 * dates go to `quarantine`, which is where the REJECTED state says to look.
 *
 * The rows already loaded are LEFT in silver. Nothing trusts the ledger's
 * ACCEPTED for reads — Dataform is forbidden from reading `partition_load`
 * (dataform-agreement.test.ts) — so the gate protects the SKIP, not the data;
 * deleting would drop real sessions to make a hole the gate already names.
 * Same choice `lake-load-databento` made for this refusal.
 *
 * ANY OTHER ERROR PROPAGATES. Only a refusal is a per-partition verdict; a
 * BigQuery failure is not, and must still stop the run.
 */
export async function acceptOrRefuse(
  key: PartitionKey,
  args: {
    runId: string;
    rowCount: number;
    expectedSessions: number;
    actualSessions: number;
    missingSessions: readonly string[];
  },
  ledger: RefusalLedger,
): Promise<PartitionRefusal | null> {
  const { missingSessions: missing, ...counts } = args;
  try {
    await ledger.accept(key, counts);
    return null;
  } catch (err) {
    if (!(err instanceof CoverageRefusedError)) throw err;
    const refusal: PartitionRefusal = {
      table: key.table,
      partitionKey: key.partitionKey,
      reason: err.reason,
      rowCount: counts.rowCount,
      expectedSessions: counts.expectedSessions,
      actualSessions: counts.actualSessions,
      missingSessions: missing,
    };
    // REJECT FIRST: it is what releases the lease. If the quarantine write
    // then fails, that failure is an "other error" and ABORTS THE RUN like any
    // other — the run does not carry on. Ordering only decides what the abort
    // leaves behind: a REJECTED partition, re-loadable by the next run, instead
    // of a LOADING one held for the six-hour lease.
    await ledger.reject(key, counts);
    await ledger.quarantine({
      dataset: key.dataset,
      table: key.table,
      partitionKey: key.partitionKey,
      runId: counts.runId,
      reason: `COVERAGE_REFUSED ${err.reason}`,
      sample: {
        expectedSessions: counts.expectedSessions,
        actualSessions: counts.actualSessions,
        rowCount: counts.rowCount,
        missingSessions: missing,
      },
    });
    return refusal;
  }
}

/** Thrown at the END of a run that refused anything, so it never exits 0. */
export class PartitionsRefusedError extends Error {
  readonly refusals: readonly PartitionRefusal[];
  constructor(refusals: readonly PartitionRefusal[]) {
    super(
      `${refusals.length} partition(s) REFUSED by the coverage gate — the run ` +
        `continued past each, and is FAILED:\n` +
        refusals.map(formatRefusal).join("\n"),
    );
    this.name = "PartitionsRefusedError";
    this.refusals = refusals;
  }
}

export function throwIfRefused(refusals: readonly PartitionRefusal[]): void {
  if (refusals.length > 0) throw new PartitionsRefusedError(refusals);
}

/* ─────────────────────────────────────────────────────────────────────────
   Object keys
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A `gs://` URI for a bucket and key.
 *
 * Built rather than concatenated at call sites: a doubled slash makes a
 * DIFFERENT `object_uri` for the same object, so the ledger would hold two rows
 * for one file and `state` would disagree between them.
 */
export function objectUri(bucket: string, key: string): string {
  const b = bucket.replace(/^gs:\/\//, "").replace(/\/+$/, "");
  const k = key.replace(/^\/+/, "");
  if (!b || !k)
    throw new Error(`cannot build an object uri from ${bucket} + ${key}`);
  return `gs://${b}/${k}`;
}

/** A run id: the job name plus the start instant — stable and sortable. */
export function runId(job: string, startedAtMs: number): string {
  if (!job.trim()) throw new Error("runId needs a job name");
  return `${job}-${new Date(startedAtMs).toISOString().replace(/[:.]/g, "-")}`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Concurrent-DML conflicts
   ──────────────────────────────────────────────────────────────────────── */

/**
 * BigQuery's answer when two DML statements on one table collide.
 *
 * Measured 2026-09-23 on `lake-load-databento-prod` (ohlcv-1h 2023), with
 * three sibling executions and local lake jobs all writing the ledger:
 *
 *     Could not serialize access to table
 *     stock-book-483718:lake_bronze_prod.partition_load due to concurrent update
 *
 * It arrives as the job's error (`reason: "invalidQuery"`), so the REASON
 * cannot tell it apart from a real SQL error and the TEXT is the only
 * discriminator. Matched on the message and on every entry of `errors[]`,
 * because the client puts it in one or the other depending on which call
 * surfaced the job's failure.
 */
const DML_CONFLICT =
  /could not serialize access to table .+ due to concurrent update/i;

export function isDmlConcurrencyConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; errors?: unknown };
  if (typeof e.message === "string" && DML_CONFLICT.test(e.message)) {
    return true;
  }
  return (
    Array.isArray(e.errors) &&
    e.errors.some(
      (x) =>
        !!x &&
        typeof x === "object" &&
        typeof (x as { message?: unknown }).message === "string" &&
        DML_CONFLICT.test((x as { message: string }).message),
    )
  );
}

/** Attempts in total (first try + retries) before a conflict is final. */
export const DML_CONFLICT_ATTEMPTS = 6;

/**
 * Re-run `statement` while — and ONLY while — BigQuery reports a concurrent-DML
 * conflict. MONEY-1608 addendum.
 *
 * WHY A RETRY IS SAFE: a DML job is atomic, and this error is the job itself
 * FAILING — it committed nothing. Re-issuing the statement is therefore its
 * first effective execution, not a second one. Every other error is thrown on
 * the first attempt: a retry cannot tell a transient fault from a real one,
 * and a statement that is wrong must fail loudly.
 *
 * Backoff is JITTERED over an exponential ceiling (2 s, 4 s, 8 s … capped at
 * 60 s; each wait is uniform in [ceiling/2, ceiling)): the conflict is caused
 * by concurrent writers, and a fixed delay would line them up to collide
 * again. `sleep` and `random` are injected so
 * this module stays free of clocks.
 */
export async function retryOnDmlConflict<T>(
  statement: () => Promise<T>,
  io: {
    sleep: (ms: number) => Promise<void>;
    random?: () => number;
    attempts?: number;
  },
): Promise<T> {
  const attempts = io.attempts ?? DML_CONFLICT_ATTEMPTS;
  const random = io.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await statement();
    } catch (err) {
      if (!isDmlConcurrencyConflict(err) || attempt >= attempts) throw err;
      const ceiling = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      await io.sleep(Math.floor(ceiling / 2 + random() * (ceiling / 2)));
    }
  }
}
