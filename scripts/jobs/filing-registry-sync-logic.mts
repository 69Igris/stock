/**
 * `filing-registry-sync` — stage every row, then ONE MERGE. MONEY-1533, which
 * fixes the cost shape MONEY-1507 (C1) shipped with; MONEY-1517 (B6 lever 3)
 * is gated on this table's row count.
 *
 * The walk, the load and the MERGE are one function that takes its I/O as an
 * argument, because every property worth pinning here only shows up ACROSS
 * pages — how many MERGEs a run issues, how many load jobs, which of two
 * staged copies of an accession wins — and `filing-registry-sync.ts` calls
 * `main()` at module scope, so a test cannot import it.
 *
 * ## THE COST SHAPE THIS REPLACES
 *
 * The job used to issue one `MERGE ... USING UNNEST(@rows)` per 2,000-row
 * chunk. BigQuery bills a MERGE that has an UPDATE clause `q + t`, and `t` is
 * the WHOLE TARGET TABLE at the time the statement starts, however few rows it
 * touches. So every chunk re-billed everything the previous chunks had
 * written: quadratic in the table, ~28 TiB for one full walk. The arithmetic,
 * measured, is in the header of `filing-registry-sync.ts`.
 *
 * Now the rows reach BigQuery through LOAD jobs, which are free, into a
 * staging table that exists for one run, and ONE MERGE moves them into the
 * target. One target scan per run instead of one per 2,000 rows.
 *
 * ## ONE LOAD JOB PER RUN
 *
 * BigQuery caps load jobs at 1,500 per table per day. The rows are written as
 * ~STAGE_ROWS-row NDJSON objects under a run-scoped prefix and read by ONE
 * wildcard load, so the count is 1 however large the walk is — the same shape
 * `lake-load-databento` uses, and its reason: objects cost nothing, a load job
 * reads them all.
 *
 * ## LAST WRITE WINS, ACROSS OBJECTS
 *
 * BigQuery REFUSES a MERGE whose USING side matches one target row more than
 * once ("UPDATE/MERGE must match at most one source row"), which fails the
 * whole statement — now the whole RUN. The old code deduped with a `Map` over
 * one page; that cannot see a duplicate in another stage object. So
 * every staged row carries `stage_seq`, its position in the walk, and the
 * USING side keeps the highest one per accession. `us_filings.accession` is
 * unique and the walk cannot repeat one, so this does not fire today; it is
 * here because the cost of being wrong is a run, not a row.
 *
 * ## THE STAGING TABLE IS DISPOSABLE BY CONSTRUCTION
 *
 *   NAMED FOR THE RUN   `filing_registry_stage_{runId}`, created with a bare
 *                       CREATE TABLE — never IF NOT EXISTS or OR REPLACE — so
 *                       two runs can never share one, and a collision FAILS.
 *   EXPIRES             48 h after creation, set in the DDL. A run that dies
 *                       anywhere leaves a table BigQuery deletes on its own.
 *   DROPPED ON SUCCESS  right after the MERGE. Kept on failure, for the
 *                       post-mortem, until it expires.
 *
 * The stage objects sit under `lake/stage/`, which the lake bucket's lifecycle
 * rule deletes at 14 days (measured on `stockbook-lake-prod`, 2026-09-23).
 *
 * Import as `./filing-registry-sync-logic.mjs`; `.mts` for the reason
 * `xbrl-projection-drain-logic.mts` gives — a workspace test is ESM and
 * recovers no named exports from a CommonJS `scripts/` module.
 */
import {
  encodeNdjson,
  stageKey,
  stageShardPrefix,
} from "@usemoney/lake/stage-logic";
import {
  FILING_REGISTRY_PARSER_VERSION,
  type FilingRegistryRow,
} from "@usemoney/lake/events-logic";

/**
 * Rows per stage object. ~54 MB of NDJSON at the 543.7 B/row measured on a
 * 50,000-row prod sample, so one object is the job's memory high-water mark;
 * a full walk is ~188 objects, all read by one load.
 *
 * ponytail: objects go up uncompressed and in line with the walk, so a full
 * run uploads ~10.2 GB on top of its Mongo reads. gzip measured 7.4-11.9x
 * smaller, but no loader here has proven BigQuery's gzip detection on a
 * `.ndjson` key — prove it on QA before switching.
 */
export const STAGE_ROWS = 100_000;
/** Staging-table lifetime. A full walk measured ~75 min of Mongo reads. */
export const STAGE_TTL_HOURS = 48;

const TARGET = "filing_registry";
const KEY = { table: TARGET, partitionKey: "US" } as const;

/**
 * The staging columns — the SAME wire types the old per-chunk UNNEST struct
 * carried (dates and timestamps as the mapper's STRINGs), so the MERGE body is
 * the statement it replaced with `S` reading a table instead of a parameter.
 *
 * Keyed by the row type: a field added to `FilingRegistryRow` without a column
 * here is a COMPILE error, rather than a load that fails at the end of an
 * hour-long walk (`ignoreUnknownValues: false`) or a column of NULLs.
 */
const STAGE_COLUMNS: Record<keyof FilingRegistryRow, string> = {
  accession: "STRING NOT NULL",
  market: "STRING",
  cik10: "STRING",
  listing_id: "STRING",
  form: "STRING",
  filed_at: "STRING",
  accepted_at: "STRING",
  period_of_report: "STRING",
  items: "ARRAY<STRING>",
  primary_document: "STRING",
  is_xbrl: "BOOL",
  is_inline_xbrl: "BOOL",
  size_bytes: "INT64",
  parse_class: "STRING",
  status: "STRING",
  raw_path: "STRING",
  source_object_uri: "STRING",
  source_record_key: "STRING",
  observed_at: "STRING",
};

/**
 * The run's staging table. Safe to interpolate by construction: the run id is
 * lowercased and everything outside `[a-z0-9_]` becomes `_`, which is also a
 * valid BigQuery table name.
 */
export function stagingTableName(runId: string): string {
  return `${TARGET}_stage_${runId.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

export function buildCreateStagingSql(stageRef: string): string {
  const cols = [
    "stage_seq INT64 NOT NULL",
    ...Object.entries(STAGE_COLUMNS).map(([c, t]) => `${c} ${t}`),
  ];
  return `CREATE TABLE ${stageRef} (
  ${cols.join(",\n  ")}
)
OPTIONS (expiration_timestamp = TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL ${STAGE_TTL_HOURS} HOUR))`;
}

/**
 * The ONE MERGE. Everything after `ON` is the pre-MONEY-1533 statement,
 * verbatim, so the column semantics — including which conversions are SAFE —
 * did not move.
 */
export function buildMergeSql(targetRef: string, stageRef: string): string {
  return `MERGE ${targetRef} T
USING (
  SELECT s.* EXCEPT (stage_seq), @parser_version AS parser_version,
         @run_id AS pipeline_run_id, @ingested_at AS ingested_at
  FROM ${stageRef} s
  QUALIFY ROW_NUMBER() OVER (PARTITION BY accession ORDER BY stage_seq DESC) = 1
) S
ON T.accession = S.accession
WHEN MATCHED THEN UPDATE SET
  market = S.market, cik10 = S.cik10, listing_id = S.listing_id,
  form = S.form, filed_at = PARSE_DATE('%Y-%m-%d', S.filed_at),
  accepted_at = SAFE_CAST(S.accepted_at AS TIMESTAMP),
  period_of_report = SAFE.PARSE_DATE('%Y-%m-%d', S.period_of_report),
  items = S.items, primary_document = S.primary_document,
  is_xbrl = S.is_xbrl, is_inline_xbrl = S.is_inline_xbrl,
  size_bytes = S.size_bytes, parse_class = S.parse_class,
  status = S.status, raw_path = S.raw_path,
  source_object_uri = S.source_object_uri,
  source_record_key = S.source_record_key,
  parser_version = S.parser_version,
  pipeline_run_id = S.pipeline_run_id,
  observed_at = CAST(S.observed_at AS TIMESTAMP),
  ingested_at = S.ingested_at
WHEN NOT MATCHED THEN INSERT
  (accession, market, cik10, listing_id, form, filed_at, accepted_at,
   period_of_report, items, primary_document, is_xbrl, is_inline_xbrl,
   size_bytes, parse_class, status, raw_path, source_object_uri,
   source_record_key, parser_version, pipeline_run_id, observed_at,
   ingested_at)
VALUES
  (S.accession, S.market, S.cik10, S.listing_id, S.form,
   PARSE_DATE('%Y-%m-%d', S.filed_at),
   SAFE_CAST(S.accepted_at AS TIMESTAMP),
   SAFE.PARSE_DATE('%Y-%m-%d', S.period_of_report),
   S.items, S.primary_document, S.is_xbrl, S.is_inline_xbrl,
   S.size_bytes, S.parse_class, S.status, S.raw_path,
   S.source_object_uri, S.source_record_key, S.parser_version,
   S.pipeline_run_id, CAST(S.observed_at AS TIMESTAMP),
   S.ingested_at)`;
}

/**
 * BigQuery's LOGICAL size of a value — what on-demand bills per byte scanned.
 * STRING is 2 + its UTF-8 length, INT64/FLOAT64 8, BOOL 1, NULL 0, and an
 * ARRAY or a row the sum of its parts (cloud.google.com/bigquery/pricing,
 * "data size calculation"). Exact for the staging table, whose dates are
 * strings; it is how a dry run can say what an --apply would cost.
 */
export function logicalBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return 2 + Buffer.byteLength(value, "utf8");
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 1;
  if (typeof value === "object") {
    return Object.values(value).reduce<number>(
      (n, v) => n + logicalBytes(v),
      0,
    );
  }
  throw new TypeError(`logicalBytes: no BigQuery size for a ${typeof value}`);
}

/** Bytes as decimal GB to 3 significant digits, so a small slice is not "0.00". */
export function gb(bytes: number): string {
  return `${(bytes / 1e9).toPrecision(3)} GB`;
}

export interface Statement {
  sql: string;
  params?: Record<string, unknown>;
  types?: Record<string, string>;
  /** Validate and price only. Bills nothing. */
  dryRun?: boolean;
}

export interface StatementStats {
  /** A dry run's estimate, or what the statement processed. */
  bytesProcessed: number;
  bytesBilled: number;
  /** DML only: rows inserted + updated. */
  affectedRows: number;
}

/** The three effects. The job wires BigQuery + GCS; a test wires arrays. */
export interface RegistryIO {
  query(statement: Statement): Promise<StatementStats>;
  /** Write one stage object at `key` in the run's bucket. */
  upload(key: string, ndjson: string): Promise<void>;
  /** ONE load job reading `sourceUri` (a wildcard) into `table`. Output rows. */
  load(table: string, sourceUri: string): Promise<number>;
}

export interface SyncResult {
  /** Rows walked, and staged when applying. */
  rows: number;
  /** Stage objects written — or, in a dry run, that an --apply would write. */
  objects: number;
  /** `logicalBytes` of every staged row: what the MERGE scans on the staging side. */
  stagedBytes: number;
  /** Null for a dry run and for an empty walk, which issue no MERGE. */
  merge: (StatementStats & { estimatedBytes: number }) | null;
}

/**
 * Walk the pages, stage them, merge once.
 *
 * `io: null` is the dry run: the walk, the counts and the size estimate, with
 * no BigQuery statement and no object written.
 */
export async function syncFilingRegistry(args: {
  pages: AsyncIterable<readonly FilingRegistryRow[]>;
  io: RegistryIO | null;
  projectId: string;
  dataset: string;
  bucket: string;
  runId: string;
  log: (line: string) => void;
  stageRows?: number;
}): Promise<SyncResult> {
  const { io, log } = args;
  const stageRows = args.stageRows ?? STAGE_ROWS;
  const stageTable = stagingTableName(args.runId);
  const ref = (t: string) => `\`${args.projectId}.${args.dataset}.${t}\``;
  const stageRef = ref(stageTable);
  const keyArgs = { ...KEY, runId: args.runId };

  // FIRST, before an hour of walking: it proves the write grant on the dataset
  // while failing is still cheap.
  if (io) {
    await io.query({ sql: buildCreateStagingSql(stageRef) });
    log(`staging table ${stageTable} (expires in ${STAGE_TTL_HOURS} h)`);
  }

  let rows = 0;
  let objects = 0;
  let stagedBytes = 0;
  let buffered = 0;
  let parts: string[] = [];
  const flush = async (): Promise<void> => {
    if (buffered === 0) return;
    if (io) {
      await io.upload(
        stageKey({ ...keyArgs, part: String(objects).padStart(6, "0") }),
        parts.join(""),
      );
      log(`  staged object ${objects}: ${buffered} rows`);
    }
    objects++;
    parts = [];
    buffered = 0;
  };

  for await (const page of args.pages) {
    if (page.length === 0) continue;
    // `stage_seq` is the position in the WALK, across every object — the
    // MERGE's tie-break. A per-object counter would restart at 0 and let an
    // earlier copy of an accession outrank a later one.
    const staged = page.map((r, i) => ({ stage_seq: rows + i, ...r }));
    rows += staged.length;
    for (const s of staged) stagedBytes += logicalBytes(s);
    if (io) parts.push(encodeNdjson(staged));
    buffered += staged.length;
    if (buffered >= stageRows) await flush();
  }
  await flush();

  if (!io) return { rows, objects, stagedBytes, merge: null };

  if (rows === 0) {
    // No load: a wildcard over zero objects is an error, not an empty load.
    await io.query({ sql: `DROP TABLE ${stageRef}` });
    log("nothing to merge; staging table dropped");
    return { rows, objects, stagedBytes, merge: null };
  }

  const loaded = await io.load(
    stageTable,
    `gs://${args.bucket}/${stageShardPrefix(keyArgs)}*`,
  );
  // WHAT WE STAGED MUST BE WHAT LANDED. A wildcard that missed an object loads
  // the rest and succeeds, and the MERGE would then report a clean run short
  // by exactly the rows B6's count gate is about to disagree with.
  if (loaded !== rows) {
    throw new Error(
      `staged ${rows} rows in ${objects} object(s) but the load wrote ${loaded} ` +
        `into ${stageTable} — refusing to MERGE a partial stage`,
    );
  }
  log(`loaded ${loaded} rows into ${stageTable} with ONE load job`);

  const merge: Statement = {
    sql: buildMergeSql(ref(TARGET), stageRef),
    params: {
      parser_version: FILING_REGISTRY_PARSER_VERSION,
      run_id: args.runId,
      // ONE instant per run: the moment the rows enter the target.
      ingested_at: new Date(),
    },
    types: {
      parser_version: "STRING",
      run_id: "STRING",
      ingested_at: "TIMESTAMP",
    },
  };
  const estimatedBytes = (await io.query({ ...merge, dryRun: true }))
    .bytesProcessed;
  log(
    `MERGE plan: at most ${gb(estimatedBytes)} scanned (dry run, billed ` +
      `nothing); ${gb(stagedBytes)} of it is the staging table`,
  );
  const stats = await io.query(merge);
  log(
    `merged ${stats.affectedRows} accession(s) from ${rows} staged row(s); ` +
      `billed ${gb(stats.bytesBilled)}`,
  );

  try {
    await io.query({ sql: `DROP TABLE ${stageRef}` });
  } catch (err) {
    // The rows are in. A failed drop is housekeeping the expiration already
    // covers, and failing the run here would send the operator back through
    // an hour-long walk for a table that deletes itself.
    log(
      `WARN could not drop ${stageTable} (${err instanceof Error ? err.message : String(err)}) — ` +
        `it expires within ${STAGE_TTL_HOURS} h`,
    );
  }
  return { rows, objects, stagedBytes, merge: { ...stats, estimatedBytes } };
}
