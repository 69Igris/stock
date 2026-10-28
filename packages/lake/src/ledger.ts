/**
 * The lake ledger — BigQuery reads and writes. MONEY-1472 (B1).
 *
 * Thin on purpose: every DECISION lives in `ledger-logic.ts`, which imports
 * nothing and is fully tested. This file moves rows.
 *
 * ## WHY A CLIENT AND NOT `bq`
 *
 * `setup-lake.sh` shells out to the `bq` CLI, and that is right for PROVISIONING
 * — one-off, interactive, already in a shell. This is a RUNTIME ledger: every
 * loader claims a partition before it works and accepts it after, so a
 * subprocess per row would be both slow and unauthenticated inside Cloud Run,
 * where the CLI is not installed.
 *
 * ## IT FAILS LOUD, UNLIKE THE CACHE LAYERS IN THIS REPO
 *
 * A quote store that cannot reach Redis serves a miss and the caller falls back.
 * A LEDGER that cannot reach BigQuery has no safe default: "I could not find
 * out whether this partition is loaded" is not "it is not loaded", and guessing
 * either way is a silent double-load or a silent skip. So these throw.
 */
import { BigQuery, type Query } from "@google-cloud/bigquery";

/** One region for the whole data plane — the 14-Sep region rule. */
const LAKE_REGION = "asia-south1";
import {
  CoverageRefusedError,
  assertPartitionKey,
  decideClaim,
  decideCoverage,
  isPartitionState,
  isSourceObjectState,
  partitionIdentity,
  retryOnDmlConflict,
  type ClaimVerdict,
  type PartitionKey,
  type PartitionState,
  type SourceObjectState,
} from "./ledger-logic";

/** `LAKE_PROJECT` / `LAKE_ENV`, read PER CALL. */
function lakeConfig(): { projectId: string; dataset: string } {
  const projectId =
    process.env.LAKE_PROJECT ?? process.env.GCP_PROJECT_ID ?? "";
  const env = process.env.LAKE_ENV ?? "";
  if (!projectId)
    throw new Error("LAKE_PROJECT (or GCP_PROJECT_ID) is required");
  if (env !== "qa" && env !== "prod") {
    // REFUSED rather than defaulted. A ledger that silently picks `qa` writes a
    // production load's coverage into the wrong dataset, and the prod ledger
    // then reports the partition as never loaded — for ever.
    throw new Error(`LAKE_ENV must be "qa" or "prod" (got "${env}")`);
  }
  return { projectId, dataset: `lake_bronze_${env}` };
}

let client: BigQuery | null = null;
function bq(): BigQuery {
  const { projectId } = lakeConfig();
  // Cached by PROJECT: a test or a script that changes LAKE_PROJECT between
  // calls must not keep talking to the first one.
  if (!client || client.projectId !== projectId) {
    // LOCATION STATED. `lake-smoke.ts` pins asia-south1 and says a green run in
    // the wrong region "would certify exactly the thing it exists to check".
    client = new BigQuery({ projectId, location: LAKE_REGION });
  }
  return client;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Every ledger statement that can stand alone goes through here — MONEY-1608.
 *
 * Several jobs write `partition_load` at once (four Databento loads plus the
 * local replays, on 2026-09-23), BigQuery aborts one of two colliding DML
 * statements, and without a retry that one abort killed a whole year's load.
 * {@link retryOnDmlConflict} says why re-running an aborted statement is safe.
 *
 * `writePartitionState` deliberately does NOT: `claimPartition` must retry its
 * READ as well as its write, so the retry wraps the whole claim instead.
 */
async function dml(query: Query): Promise<void> {
  await retryOnDmlConflict(() => bq().query(query), { sleep });
}

/** Fully-qualified, backticked table id. */
function tableId(table: string): string {
  const { projectId, dataset } = lakeConfig();
  return `\`${projectId}.${dataset}.${table}\``;
}

/* ─────────────────────────────────────────────────────────────────────────
   source_object
   ──────────────────────────────────────────────────────────────────────── */

export interface SourceObjectRow {
  dataset: string;
  source: string;
  objectUri: string;
  generation?: number | null;
  bytes?: number | null;
  sha256?: string | null;
  contentType?: string | null;
  acquiredAt: Date;
  vendorJobId?: string | null;
  vendorFileName?: string | null;
  costUsd?: number | null;
  entitlement?: string | null;
  state: SourceObjectState;
  verifiedAt?: Date | null;
}

/**
 * Record one raw object. MERGE on `object_uri` ALONE.
 *
 * ## WHY NOT (object_uri, generation), WHICH IS WHAT THIS SHIPPED WITH
 *
 * An object URI identifies an object; `generation` identifies the VERSION we
 * last looked at. Keying on both made them two identities, and the two writers
 * disagree about the second by construction:
 *
 *   the harvest mirror  `toLedgerSourceObjects` is PURE and cannot HEAD, so it
 *                       writes generation NULL
 *   the backfill        HEADs every object, so it writes a real generation
 *
 * `(uri, NULL)` never matches `(uri, 17…)`, so the second writer took
 * `WHEN NOT MATCHED THEN INSERT` and produced a SECOND permanent row for the
 * same object — with a `state` that can disagree with the first, in a table
 * CLUSTERED ON `state`. The one question this table exists to answer then had
 * two answers and nothing saying which was current.
 *
 * On `object_uri` alone, a later HEAD UPDATES the row it should have updated,
 * and `generation` becomes what it always was: an attribute of the current
 * version, not part of the identity.
 *
 * ## AND THE UPDATE MUST COVER THE PARTITION COLUMN
 *
 * `acquired_at` used to be INSERT-only. `toLedgerSourceObjects` computes it as
 * `downloadedAt ?? submittedAt ?? now`, and the harvest mirrors a row before it
 * reaches DOWNLOADED — so the first write lands `submittedAt`, days early, and
 * the table is `PARTITION BY DATE(acquired_at)`. Frozen there, every
 * partition-pruned query answers from the wrong partition and no re-run
 * repairs it. Same for `dataset`, `source` and the vendor columns: the bucket
 * mapping was already wrong once for every row, and an INSERT-only column
 * makes that unfixable by re-running.
 */
/**
 * Record MANY raw objects in ONE statement. MONEY-1472.
 *
 * `recordSourceObject` is one BigQuery query job per FILE, and prod's Databento
 * inventory is 66,046 files across 44 job rows. At the measured 1-3 s per MERGE
 * that is 18-55 HOURS against the backfill's 2 h task timeout — so the job could
 * never finish, and because `markLedgerBacked` only fires after a whole row is
 * written, the 21,365-file `ohlcv-1s-baseline` row could never be marked at all:
 * every execution re-MERGEd its first few thousand files for ever.
 *
 * Three costs collapse at once. BigQuery caps concurrent mutating DML at ~2 per
 * table, bills a 10 MB minimum per query, and the single-row MERGE carries no
 * predicate on `acquired_at` — so on a `PARTITION BY DATE(acquired_at)` table
 * every statement scans every partition. 66,046 x 10 MB is ~660 GB billed per
 * pass; batched, it is ~14 statements.
 *
 * CHUNKED rather than one giant statement: a query has a hard size limit and an
 * UNNEST of 42,084 structs would breach it.
 */
export async function recordSourceObjects(
  rows: readonly SourceObjectRow[],
  chunkSize = 5_000,
): Promise<void> {
  for (const r of rows) {
    if (!isSourceObjectState(r.state)) {
      throw new Error(`invalid source_object state "${r.state}"`);
    }
  }
  // LAST WRITE WINS per uri, deduped BEFORE the statement. BigQuery refuses a
  // MERGE whose USING side matches one target row more than once ("UPDATE/MERGE
  // must match at most one source row"), and one vendor manifest listing a file
  // twice would fail the whole batch rather than the row.
  const byUri = new Map<string, SourceObjectRow>();
  for (const r of rows) byUri.set(r.objectUri, r);
  const deduped = [...byUri.values()];

  for (let i = 0; i < deduped.length; i += chunkSize) {
    const chunk = deduped.slice(i, i + chunkSize);
    const sql = `
      MERGE ${tableId("source_object")} T
      USING UNNEST(@rows) S
      ON T.object_uri = S.object_uri
      WHEN MATCHED THEN UPDATE SET
        dataset = S.dataset, source = S.source, generation = S.generation,
        bytes = S.bytes, sha256 = S.sha256, content_type = S.content_type,
        acquired_at = S.acquired_at, vendor_job_id = S.vendor_job_id,
        vendor_file_name = S.vendor_file_name, cost_usd = S.cost_usd,
        entitlement = S.entitlement, state = S.state, verified_at = S.verified_at
      WHEN NOT MATCHED THEN INSERT (
        dataset, source, object_uri, generation, bytes, sha256, content_type,
        acquired_at, vendor_job_id, vendor_file_name, cost_usd, entitlement,
        state, verified_at
      ) VALUES (
        S.dataset, S.source, S.object_uri, S.generation, S.bytes, S.sha256,
        S.content_type, S.acquired_at, S.vendor_job_id, S.vendor_file_name,
        S.cost_usd, S.entitlement, S.state, S.verified_at
      )`;
    await dml({
      query: sql,
      params: {
        rows: chunk.map((r) => ({
          dataset: r.dataset,
          source: r.source,
          object_uri: r.objectUri,
          generation: r.generation ?? null,
          bytes: r.bytes ?? null,
          sha256: r.sha256 ?? null,
          content_type: r.contentType ?? null,
          acquired_at: r.acquiredAt,
          vendor_job_id: r.vendorJobId ?? null,
          vendor_file_name: r.vendorFileName ?? null,
          cost_usd: r.costUsd ?? null,
          entitlement: r.entitlement ?? null,
          state: r.state,
          verified_at: r.verifiedAt ?? null,
        })),
      },
      // EXPLICIT, because every field is nullable and BigQuery cannot infer the
      // type of a struct field that is null in every element of the array.
      types: {
        rows: [
          {
            dataset: "STRING",
            source: "STRING",
            object_uri: "STRING",
            generation: "INT64",
            bytes: "INT64",
            sha256: "STRING",
            content_type: "STRING",
            acquired_at: "TIMESTAMP",
            vendor_job_id: "STRING",
            vendor_file_name: "STRING",
            cost_usd: "NUMERIC",
            entitlement: "STRING",
            state: "STRING",
            verified_at: "TIMESTAMP",
          },
        ],
      },
    });
  }
}

export async function recordSourceObject(row: SourceObjectRow): Promise<void> {
  if (!isSourceObjectState(row.state)) {
    // BigQuery has no ENUM, so this is the only place an unknown state can be
    // refused. Stored, it would simply be a string nobody queries for.
    throw new Error(`invalid source_object state "${row.state}"`);
  }
  const sql = `
    MERGE ${tableId("source_object")} T
    USING (SELECT @object_uri AS object_uri) S
    ON T.object_uri = S.object_uri
    WHEN MATCHED THEN UPDATE SET
      dataset = @dataset, source = @source, generation = @generation,
      bytes = @bytes, sha256 = @sha256, content_type = @content_type,
      acquired_at = @acquired_at, vendor_job_id = @vendor_job_id,
      vendor_file_name = @vendor_file_name,
      state = @state, verified_at = @verified_at, cost_usd = @cost_usd,
      entitlement = @entitlement
    WHEN NOT MATCHED THEN INSERT (
      dataset, source, object_uri, generation, bytes, sha256, content_type,
      acquired_at, vendor_job_id, vendor_file_name, cost_usd, entitlement,
      state, verified_at
    ) VALUES (
      @dataset, @source, @object_uri, @generation, @bytes, @sha256, @content_type,
      @acquired_at, @vendor_job_id, @vendor_file_name, @cost_usd, @entitlement,
      @state, @verified_at
    )`;
  await dml({
    query: sql,
    params: {
      dataset: row.dataset,
      source: row.source,
      object_uri: row.objectUri,
      generation: row.generation ?? null,
      bytes: row.bytes ?? null,
      sha256: row.sha256 ?? null,
      content_type: row.contentType ?? null,
      acquired_at: row.acquiredAt,
      vendor_job_id: row.vendorJobId ?? null,
      vendor_file_name: row.vendorFileName ?? null,
      cost_usd: row.costUsd ?? null,
      entitlement: row.entitlement ?? null,
      state: row.state,
      verified_at: row.verifiedAt ?? null,
    },
    // TYPES ARE EXPLICIT for every nullable parameter. BigQuery infers a
    // parameter's type from its VALUE, and a `null` has no type — the query
    // fails at runtime with "Parameter type must be provided", which a
    // backfill would hit only on the first row that happens to be missing a
    // field.
    types: {
      dataset: "STRING",
      source: "STRING",
      object_uri: "STRING",
      generation: "INT64",
      bytes: "INT64",
      sha256: "STRING",
      content_type: "STRING",
      acquired_at: "TIMESTAMP",
      vendor_job_id: "STRING",
      vendor_file_name: "STRING",
      cost_usd: "NUMERIC",
      entitlement: "STRING",
      state: "STRING",
      verified_at: "TIMESTAMP",
    },
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   pipeline_run
   ──────────────────────────────────────────────────────────────────────── */

export async function beginRun(args: {
  runId: string;
  job: string;
  gitSha?: string | null;
  startedAt: Date;
}): Promise<void> {
  await dml({
    query: `INSERT ${tableId("pipeline_run")}
              (run_id, job, git_sha, started_at, status)
            VALUES (@run_id, @job, @git_sha, @started_at, 'RUNNING')`,
    params: {
      run_id: args.runId,
      job: args.job,
      git_sha: args.gitSha ?? null,
      started_at: args.startedAt,
    },
    types: {
      run_id: "STRING",
      job: "STRING",
      git_sha: "STRING",
      started_at: "TIMESTAMP",
    },
  });
}

export async function endRun(args: {
  runId: string;
  status: "SUCCESS" | "FAILED";
  finishedAt: Date;
  rowsIn?: number;
  rowsOut?: number;
  rowsRejected?: number;
  bytesScanned?: number;
  notes?: string | null;
}): Promise<void> {
  await dml({
    query: `UPDATE ${tableId("pipeline_run")}
            SET finished_at = @finished_at, status = @status,
                rows_in = @rows_in, rows_out = @rows_out,
                rows_rejected = @rows_rejected, bytes_scanned = @bytes_scanned,
                notes = @notes
            WHERE run_id = @run_id`,
    params: {
      run_id: args.runId,
      status: args.status,
      finished_at: args.finishedAt,
      rows_in: args.rowsIn ?? null,
      rows_out: args.rowsOut ?? null,
      rows_rejected: args.rowsRejected ?? null,
      bytes_scanned: args.bytesScanned ?? null,
      notes: args.notes ?? null,
    },
    types: {
      run_id: "STRING",
      status: "STRING",
      finished_at: "TIMESTAMP",
      rows_in: "INT64",
      rows_out: "INT64",
      rows_rejected: "INT64",
      bytes_scanned: "INT64",
      notes: "STRING",
    },
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   partition_load — the idempotency surface
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Claim a partition, or learn that it is already done.
 *
 * Reads the CURRENT row, asks `decideClaim`, and writes LOADING only when the
 * verdict is `load`. The read and the write are two statements, so two runs
 * starting in the same instant can both claim — which is why the lease exists
 * rather than a lock: a double-claim costs a duplicated load that the next
 * ACCEPT collapses, while a lock that is never released costs the partition for
 * ever. BigQuery offers no row lock to take here anyway.
 */
export async function claimPartition(
  key: PartitionKey,
  args: { runId: string; nowMs?: number },
): Promise<ClaimVerdict> {
  assertPartitionKey(key);
  // THE WHOLE CLAIM IS RETRIED, not its write alone. A conflict aborts the
  // LOADING write, and by the time a retry runs another writer may have
  // ACCEPTED or leased this partition — re-issuing the write blind would
  // overwrite that with LOADING. Re-running from the READ asks `decideClaim`
  // again against the current row, so a retry can only ever reach the verdict
  // a fresh claim would.
  return retryOnDmlConflict(() => claimOnce(key, args), { sleep });
}

async function claimOnce(
  key: PartitionKey,
  args: { runId: string; nowMs?: number },
): Promise<ClaimVerdict> {
  const nowMs = args.nowMs ?? Date.now();

  const [rows] = await bq().query({
    query: `SELECT state, UNIX_MILLIS(loaded_at) AS loaded_at_ms
            FROM ${tableId("partition_load")}
            WHERE dataset = @dataset AND \`table\` = @table
              AND partition_key = @partition_key
              AND source_hash = @source_hash
              AND parser_version = @parser_version
            ORDER BY loaded_at DESC
            LIMIT 1`,
    params: {
      dataset: key.dataset,
      table: key.table,
      partition_key: key.partitionKey,
      source_hash: key.sourceHash,
      parser_version: key.parserVersion,
    },
    types: {
      dataset: "STRING",
      table: "STRING",
      partition_key: "STRING",
      source_hash: "STRING",
      parser_version: "STRING",
    },
  });

  const row = (rows as { state?: unknown; loaded_at_ms?: unknown }[])[0];
  const existing =
    row && isPartitionState(row.state)
      ? { state: row.state, loadedAtMs: Number(row.loaded_at_ms ?? 0) }
      : null;

  const verdict = decideClaim(existing, nowMs);
  if (verdict.action === "load") {
    await writePartitionState(key, {
      state: "LOADING",
      runId: args.runId,
      loadedAt: new Date(nowMs),
    });
  }
  return verdict;
}

export async function acceptPartition(
  key: PartitionKey,
  args: {
    runId: string;
    rowCount: number;
    expectedSessions: number;
    actualSessions: number;
  },
): Promise<void> {
  assertPartitionKey(key);

  // THE GATE IS INSIDE, NOT BESIDE.
  //
  // `decideCoverage` existed with a careful docstring and NO PRODUCTION
  // CALLER: its only callers were its own tests, and this function wrote
  // ACCEPTED without consulting any of the three numbers it was handed. A
  // guard that cannot fire is not a guard.
  //
  // It matters more here than almost anywhere, because ACCEPTED is what makes
  // every future run SKIP. A loader whose calendar lookup came back empty would
  // call this with `expectedSessions: 0`, the row would be written ACCEPTED,
  // and the empty month would be frozen permanently with the ledger reporting
  // healthy — the exact scenario `decideCoverage`'s own comment describes.
  //
  // It THROWS rather than returning a verdict: a caller that has just loaded
  // rows and cannot accept them must stop, not continue with a boolean it may
  // ignore. `rejectPartition` is the deliberate other path.
  const verdict = decideCoverage(args);
  if (!verdict.accept) throw new CoverageRefusedError(verdict.reason);

  // Retried as a unit: an ACCEPT is the intended final state whatever the row
  // held, so re-issuing it after an aborted attempt is the same write.
  await retryOnDmlConflict(
    () =>
      writePartitionState(key, {
        state: "ACCEPTED",
        loadedAt: new Date(),
        ...args,
      }),
    { sleep },
  );

  // SUPERSEDE the older ACCEPTED rows for this partition.
  //
  // `writePartitionState`'s MERGE matches on all five key columns INCLUDING
  // `source_hash` and `parser_version`, so a re-issued file or a re-parse
  // INSERTS a new row and leaves the old one ACCEPTED. Two ACCEPTED rows for
  // one partition makes `SUM(row_count) WHERE state='ACCEPTED'` double-count
  // while looking entirely normal, with nothing on either row saying which is
  // current. `SUPERSEDED` is declared for exactly this and had no writer.
  await supersedeOlderAccepted(key);
}

// Defined in the pure module so `acceptOrRefuse` can catch it by CLASS without
// importing BigQuery; re-exported here so existing `instanceof` checks against
// `@usemoney/lake/ledger` keep matching the same class — MONEY-1612.
export { CoverageRefusedError };

/** Mark every OTHER accepted row for this partition as history. */
async function supersedeOlderAccepted(key: PartitionKey): Promise<void> {
  await dml({
    query: `UPDATE ${tableId("partition_load")}
            SET state = 'SUPERSEDED'
            WHERE dataset = @dataset AND \`table\` = @table
              AND partition_key = @partition_key
              AND state = 'ACCEPTED'
              AND NOT (source_hash = @source_hash AND parser_version = @parser_version)`,
    params: {
      dataset: key.dataset,
      table: key.table,
      partition_key: key.partitionKey,
      source_hash: key.sourceHash,
      parser_version: key.parserVersion,
    },
    types: {
      dataset: "STRING",
      table: "STRING",
      partition_key: "STRING",
      source_hash: "STRING",
      parser_version: "STRING",
    },
  });
}

export async function rejectPartition(
  key: PartitionKey,
  args: {
    runId: string;
    rowCount?: number;
    // Optional, so the Databento call sites that never measured coverage keep
    // writing NULL (IFNULL keeps any prior measurement). A COVERAGE refusal
    // passes both, so the REJECTED row says how partial it was — MONEY-1612.
    expectedSessions?: number;
    actualSessions?: number;
  },
): Promise<void> {
  assertPartitionKey(key);
  await retryOnDmlConflict(
    () =>
      writePartitionState(key, {
        state: "REJECTED",
        runId: args.runId,
        rowCount: args.rowCount ?? 0,
        expectedSessions: args.expectedSessions,
        actualSessions: args.actualSessions,
        loadedAt: new Date(),
      }),
    { sleep },
  );
}

async function writePartitionState(
  key: PartitionKey,
  args: {
    state: PartitionState;
    runId: string;
    loadedAt: Date;
    rowCount?: number;
    expectedSessions?: number;
    actualSessions?: number;
  },
): Promise<void> {
  const sql = `
    MERGE ${tableId("partition_load")} T
    USING (SELECT @dataset AS dataset, @table AS \`table\`,
                  @partition_key AS partition_key, @source_hash AS source_hash,
                  @parser_version AS parser_version) S
    ON  T.dataset = S.dataset AND T.\`table\` = S.\`table\`
    AND T.partition_key = S.partition_key AND T.source_hash = S.source_hash
    AND T.parser_version = S.parser_version
    WHEN MATCHED THEN UPDATE SET
      state = @state, run_id = @run_id, loaded_at = @loaded_at,
      -- IFNULL, NOT a bare assignment. A transition that does not MEASURE must
      -- not ERASE a measurement. \`claimPartition\` passes none of these three
      -- and \`rejectPartition\` passes only row_count, so an unconditional SET
      -- nulled the coverage evidence an earlier ACCEPTED or SUPERSEDED row had
      -- recorded — worst on the path it exists for: \`decideClaim\` returns
      -- \`load\` for SUPERSEDED so a rollback is possible, and the claim then
      -- wiped row_count/expected/actual BEFORE the re-run had produced anything
      -- to replace them. A re-run that then failed left LOADING with no numbers
      -- and no record of what the superseded load had contained.
      row_count = IFNULL(@row_count, T.row_count),
      expected_sessions = IFNULL(@expected_sessions, T.expected_sessions),
      actual_sessions = IFNULL(@actual_sessions, T.actual_sessions)
    WHEN NOT MATCHED THEN INSERT (
      dataset, \`table\`, partition_key, source_hash, parser_version,
      run_id, state, row_count, expected_sessions, actual_sessions, loaded_at
    ) VALUES (
      @dataset, @table, @partition_key, @source_hash, @parser_version,
      @run_id, @state, @row_count, @expected_sessions, @actual_sessions, @loaded_at
    )`;
  await bq().query({
    query: sql,
    params: {
      dataset: key.dataset,
      table: key.table,
      partition_key: key.partitionKey,
      source_hash: key.sourceHash,
      parser_version: key.parserVersion,
      run_id: args.runId,
      state: args.state,
      row_count: args.rowCount ?? null,
      expected_sessions: args.expectedSessions ?? null,
      actual_sessions: args.actualSessions ?? null,
      loaded_at: args.loadedAt,
    },
    types: {
      dataset: "STRING",
      table: "STRING",
      partition_key: "STRING",
      source_hash: "STRING",
      parser_version: "STRING",
      run_id: "STRING",
      state: "STRING",
      row_count: "INT64",
      expected_sessions: "INT64",
      actual_sessions: "INT64",
      loaded_at: "TIMESTAMP",
    },
  });
}

/**
 * Serialise a quarantine sample without throwing.
 *
 * `JSON.stringify` THROWS on a BigInt — and a B5 loader's rejected bar carries
 * `volume` as one, because hyparquet decodes INT64 as a JS bigint
 * (CANDLE_COLD_FORMAT states this). The throw would escape `quarantine()` on
 * the REJECT path, leaving the partition LOADING and the reason lost: a failure
 * recorder that fails on the failures it exists to record.
 */
function safeJson(value: unknown): string {
  try {
    const out = JSON.stringify(value ?? null, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    return out === undefined ? "null" : out;
  } catch (err) {
    return JSON.stringify({ unserialisable: String(err) });
  }
}

/** Record refused rows. `reason` is NAMED — a boolean cannot be triaged. */
export async function quarantine(args: {
  dataset: string;
  table: string;
  partitionKey: string;
  runId: string;
  reason: string;
  sample?: unknown;
}): Promise<void> {
  await dml({
    query: `INSERT ${tableId("quarantine")}
              (dataset, \`table\`, partition_key, run_id, reason, sample, rejected_at)
            VALUES (@dataset, @table, @partition_key, @run_id, @reason,
                    PARSE_JSON(@sample), CURRENT_TIMESTAMP())`,
    params: {
      dataset: args.dataset,
      table: args.table,
      partition_key: args.partitionKey,
      run_id: args.runId,
      reason: args.reason,
      sample: safeJson(args.sample),
    },
    types: {
      dataset: "STRING",
      table: "STRING",
      partition_key: "STRING",
      run_id: "STRING",
      reason: "STRING",
      sample: "STRING",
    },
  });
}

export { partitionIdentity };
