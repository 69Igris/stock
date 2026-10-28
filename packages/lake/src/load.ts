/**
 * `bq load` from staged objects, and the purge that makes it re-runnable.
 * MONEY-1505 (data-platform B5).
 *
 * Thin, like `ledger.ts`: every DECISION lives in a pure module. This moves
 * bytes into BigQuery and fails loud when it cannot.
 *
 * ## WHY A LOAD JOB AND NOT `table.insert()`
 *
 * 151.5 million M1 rows and 38.8 million H1 rows. Streaming inserts are BILLED
 * per byte and capped per second; load jobs are FREE and are the documented
 * path for bulk. The staged objects they read are deleted by the
 * `lake/stage/` 14-day lifecycle rule from S1, so the intermediate costs
 * nothing beyond two weeks of Standard storage.
 *
 * ## `Table#load` CANNOT BE USED HERE, AND IT LOOKS LIKE IT CAN
 *
 * `@google-cloud/bigquery`'s `Table#load(source)` treats a STRING as a LOCAL
 * FILE PATH — `table.js` does `fs.createReadStream(source)` — so passing a
 * `gs://` URI produces ENOENT for a file that exists. Its `File[]` overload
 * wants `@google-cloud/storage` objects, and this package deliberately does not
 * depend on storage. `createJob` with an explicit `sourceUris` is the form that
 * takes a URI.
 *
 * ## A LOAD JOB IS ATOMIC; THE DELETE BEFORE IT IS NOT
 *
 * BigQuery applies a load job all-or-nothing, so a crash mid-load leaves no
 * rows. What is NOT atomic is the pair: a crash AFTER a successful load and
 * BEFORE `acceptPartition` leaves rows in the table and `LOADING` in the
 * ledger, and the next run would APPEND a second copy.
 *
 * `purgePartitionRange` is what closes that. Every load is preceded by a
 * delete of the range it is about to write, so a re-run is idempotent wherever
 * the previous attempt died. On a first run it deletes nothing and costs one
 * partition-pruned scan of an empty range.
 */
import { BigQuery } from "@google-cloud/bigquery";

import { retryOnDmlConflict } from "./ledger-logic";

/** One region for the whole data plane — the 14-Sep region rule. */
const LAKE_REGION = "asia-south1";

let client: BigQuery | null = null;

function bq(projectId: string): BigQuery {
  // Cached by PROJECT, matching `ledger.ts`: a script that changes the target
  // project between calls must not keep talking to the first one.
  if (!client || client.projectId !== projectId) {
    client = new BigQuery({ projectId, location: LAKE_REGION });
  }
  return client;
}

export class LoadJobFailedError extends Error {
  constructor(
    readonly jobId: string,
    detail: string,
  ) {
    super(`BigQuery load job ${jobId} failed: ${detail}`);
    this.name = "LoadJobFailedError";
  }
}

/** A safe BigQuery identifier. See `assertIdent`. */
const IDENT = /^[a-z][a-z0-9_]{0,127}$/;
/**
 * The project/dataset halves of a backquoted table path.
 *
 * DELIBERATELY NOT `IDENT`: a GCP project id carries HYPHENS
 * (`stock-book-483718`), which `IDENT` forbids, so guarding these with it
 * would refuse every real call. What matters for a value interpolated INSIDE
 * backticks is that it cannot close them or escape — so this rejects the
 * backtick, the backslash and whitespace, and requires at least one character.
 */
const QUALIFIER = /^[A-Za-z0-9_.:-]{1,1024}$/;

function assertQualifier(value: string, field: string): void {
  if (!QUALIFIER.test(value)) {
    throw new Error(
      `${field} must be a bare project/dataset name (got ${JSON.stringify(value)}) — ` +
        `it is interpolated inside backticks and cannot be bound as a parameter`,
    );
  }
}
/** `LAKE_PROJECT` / `LAKE_ENV`, read PER CALL — never a module-scope const. */
function silverConfig(): { projectId: string; dataset: string } {
  const projectId =
    process.env.LAKE_PROJECT ?? process.env.GCP_PROJECT_ID ?? "";
  const env = process.env.LAKE_ENV ?? "";
  if (!projectId)
    throw new Error("LAKE_PROJECT (or GCP_PROJECT_ID) is required");
  if (env !== "qa" && env !== "prod") {
    // REFUSED rather than defaulted, for `ledger.ts`'s reason: a loader that
    // silently picks `qa` writes production rows into the wrong dataset, and
    // the prod table then reports the month as never loaded — for ever.
    throw new Error(`LAKE_ENV must be "qa" or "prod" (got "${env}")`);
  }
  return { projectId, dataset: `lake_silver_${env}` };
}

function assertIdent(value: string, field: string): void {
  if (!IDENT.test(value)) {
    throw new Error(
      `${field} must be a snake_case identifier (got ${JSON.stringify(value)}) — ` +
        `it is interpolated into SQL and cannot be bound as a parameter`,
    );
  }
}

export interface LoadResult {
  jobId: string;
  outputRows: number;
  inputFiles: number;
  badRecords: number;
}

/**
 * Load newline-delimited JSON from GCS into one table.
 *
 * `sourceUris` may contain a single `*` wildcard per URI, which is how one job
 * reads the many staged objects a partition was rolled into. Wildcards are the
 * reason the run id is in the stage key: `{runId}-*.ndjson` matches exactly
 * this run's objects and cannot pick up a concurrent run's.
 *
 * ## EVERY SETTING HERE IS A REFUSAL
 *
 *   autodetect: false       a guessed schema silently retypes a column. The
 *                           table's DDL is the schema and a row that does not
 *                           fit it is a defect, not something to accommodate.
 *   maxBadRecords: 0        BigQuery's default already refuses, but stating it
 *                           makes "load some of it" impossible to reach by
 *                           accident. A partially-loaded partition that then
 *                           passes coverage is the failure the ledger exists
 *                           to prevent.
 *   ignoreUnknownValues     LEFT FALSE. A field the table does not have is a
 *                           row-shape drift, and dropping it quietly is how a
 *                           renamed column becomes a column of NULLs.
 *   writeDisposition        WRITE_APPEND, because a partition spans many daily
 *                           partitions of the target and WRITE_TRUNCATE would
 *                           empty the whole TABLE. The purge above is what
 *                           scopes the replace.
 */
export async function loadNdjson(args: {
  projectId: string;
  dataset: string;
  table: string;
  sourceUris: readonly string[];
  jobPrefix?: string;
}): Promise<LoadResult> {
  if (args.sourceUris.length === 0) {
    throw new RangeError(
      "loadNdjson: no source uris. An empty load job SUCCEEDS and writes zero " +
        "rows, so the partition would be ACCEPTED having stored nothing — " +
        "decide what an empty partition means before calling this",
    );
  }
  for (const uri of args.sourceUris) {
    if (!uri.startsWith("gs://")) {
      throw new RangeError(
        `loadNdjson: "${uri}" is not a gs:// uri. A local path is silently a ` +
          "different operation in this client and fails as a missing file",
      );
    }
  }

  const [job] = await bq(args.projectId).createJob({
    jobPrefix: args.jobPrefix ?? "lake_load_",
    location: LAKE_REGION,
    configuration: {
      load: {
        sourceUris: [...args.sourceUris],
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        destinationTable: {
          projectId: args.projectId,
          datasetId: args.dataset,
          tableId: args.table,
        },
        writeDisposition: "WRITE_APPEND",
        createDisposition: "CREATE_NEVER",
        autodetect: false,
        maxBadRecords: 0,
        ignoreUnknownValues: false,
      },
    },
  });

  await job.promise();
  const [meta] = await job.getMetadata();
  const jobId = String(meta.jobReference?.jobId ?? "unknown");

  // CHECKED EXPLICITLY, even though `promise()` rejects on failure. A load job
  // can finish DONE and carry `status.errorResult`, and reading only the
  // promise would report a successful load of nothing.
  const errorResult = meta.status?.errorResult;
  if (errorResult) {
    const errors = (meta.status?.errors ?? [])
      .map((e: { message?: string }) => e.message)
      .filter(Boolean)
      .slice(0, 5)
      .join("; ");
    throw new LoadJobFailedError(
      jobId,
      `${errorResult.message ?? "no message"}${errors ? ` — ${errors}` : ""}`,
    );
  }

  const stats = meta.statistics?.load ?? {};
  return {
    jobId,
    outputRows: Number(stats.outputRows ?? 0),
    inputFiles: Number(stats.inputFiles ?? 0),
    badRecords: Number(stats.badRecords ?? 0),
  };
}

/**
 * Delete the rows a load is about to replace.
 *
 * Scoped by (market, source, session_date range) rather than by the ledger's
 * parser version, and that is deliberate: a parser-version bump produces a NEW
 * ledger identity, so `decideClaim` says load — and the OLD version's rows must
 * go, or the partition would hold two parses of the same bytes and every
 * aggregate would double-count while looking entirely normal.
 *
 * Returns the number of rows removed, so a re-run is visible in the log rather
 * than inferred.
 *
 * THAT INTENT NEVER HELD UNTIL MONEY-1538 — see {@link dateBound}. The range
 * bounds went out as NULL, this DELETE removed nothing, and a re-load appended.
 */
export async function purgePartitionRange(args: {
  projectId: string;
  dataset: string;
  table: string;
  market: string;
  source: string;
  fromDate: string;
  toDate: string;
}): Promise<number> {
  const [job] = await bq(args.projectId).createQueryJob({
    ...buildPurgeRangeSql(args),
    location: LAKE_REGION,
  });
  await job.promise();
  const [meta] = await job.getMetadata();
  return Number(meta.statistics?.query?.numDmlAffectedRows ?? 0);
}

/**
 * A `YYYY-MM-DD` bound, bound as a STRING and parsed IN SQL — MONEY-1538.
 *
 * NEVER a `DATE`-typed param carrying a string. `@google-cloud/bigquery`
 * serialises every DATE/TIME-family param by reading `value.value` — present on
 * a `BigQuery.date()` object, absent on a string — so a string is DROPPED and
 * the parameter reaches BigQuery with no value, i.e. NULL. Measured through
 * the client itself:
 *
 *     string + DATE      {"parameterType":{"type":"DATE"},"parameterValue":{}}
 *     string + STRING    {"parameterType":{"type":"STRING"},"parameterValue":{"value":"1995-03-01"}}
 *
 * `session_date >= NULL` is UNKNOWN for every row, so both month DELETEs in
 * this file matched NOTHING from the day they shipped, and every RE-load — a
 * retried month, a superseded month, a parser-version reload — appended a
 * second copy. Prod job `1271a6e5-…` shows `market` and `source` bound and
 * `from`/`to` empty; 315,609 duplicate rows followed.
 *
 * `PARSE_DATE` rather than `DATE(@x)` because it REFUSES a malformed bound with
 * an error, where a lenient cast would be one more way to delete the wrong range.
 */
function dateBound(param: string): string {
  return `PARSE_DATE('%Y-%m-%d', @${param})`;
}

/**
 * The DELETE `purgePartitionRange` issues, as data — MONEY-1538.
 *
 * Extracted for the same reason as {@link buildDeleteMonthSql}: a statement
 * built inside an `async` function that talks to BigQuery can only be tested by
 * talking to BigQuery, which is why the NULL binding survived every suite. And
 * it gets the SAME identifier guards, which it never had — it interpolated
 * `table`, `projectId` and `dataset` unchecked while its sibling refused a
 * backtick (MONEY-1516 review #17 guarded one of the two).
 */
export function buildPurgeRangeSql(args: {
  projectId: string;
  dataset: string;
  table: string;
  market: string;
  source: string;
  fromDate: string;
  toDate: string;
}): {
  query: string;
  params: Record<string, string>;
  types: Record<string, string>;
} {
  assertIdent(args.table, "table");
  assertQualifier(args.projectId, "projectId");
  assertQualifier(args.dataset, "dataset");
  return {
    query: `DELETE FROM \`${args.projectId}.${args.dataset}.${args.table}\`
            WHERE market = @market AND source = @source
              AND session_date BETWEEN ${dateBound("from_date")} AND ${dateBound("to_date")}`,
    params: {
      market: args.market,
      source: args.source,
      from_date: args.fromDate,
      to_date: args.toDate,
    },
    types: {
      market: "STRING",
      source: "STRING",
      from_date: "STRING",
      to_date: "STRING",
    },
  };
}

/**
 * Replace one month of one market in a silver table, from staged NDJSON.
 *
 * ## DELETE, THEN LOAD — in that order, and both are required
 *
 * `bq load` APPENDS. Two things make a second append of the same month real
 * rather than theoretical, and both have happened in this repo:
 *
 *   - a crash between the load and `acceptPartition`. The rows are in; the
 *     ledger says LOADING; the six-hour lease expires; the next run reloads.
 *   - a REPAIRED archive object (MONEY-1169 rewrote thousands of feed files in
 *     place). The month's `source_hash` changes, so the ledger correctly says
 *     "load this again" — and without the delete the month holds both parses.
 *
 * A crash BETWEEN the two leaves a GAP, which the ledger's un-ACCEPTED claim
 * makes visible and the next run repairs. The other order leaves a MIXTURE,
 * which nothing can detect. Same reasoning as Databento's session displacement.
 *
 * ## THE BOUNDS COME FROM THE CALLER, COMPUTED
 *
 * `monthDeleteBounds` derives them from the partition key, so the rows deleted
 * and the rows loaded are the same month by construction. A hand-written
 * `BETWEEN` here would be a second spelling of the partition, free to disagree.
 *
 * ## THE DELETE IS SCOPED BY `source`, NOT BY `parser_version`
 *
 * `parser_version` is in the ledger key so that a parser FIX re-runs over bytes
 * that have not changed. The rows such a reload must remove therefore carry the
 * PREVIOUS version, and a predicate naming the NEW one removes nothing at all —
 * leaving the month holding both parses. See `monthDeleteBounds`.
 */
export async function replaceMonth(args: {
  table: string;
  /**
   * The market to scope the DELETE to, or `null` for a table that HAS NO
   * `market` column — `fund_nav_d1` is the only one today (MONEY-1513).
   *
   * EXPLICIT `null`, never optional. An omitted field would let a caller that
   * simply forgot it widen the delete across both markets of the SHARED
   * `price_bar_d1` — thirteen million India rows removed by a US load that
   * reported success. Spelling it makes the type checker ask.
   */
  market: string | null;
  /** `YYYY-MM-DD`, inclusive. */
  fromInclusive: string;
  /** `YYYY-MM-DD`, EXCLUSIVE — so a 31-day month needs no special case. */
  toExclusive: string;
  /** The `source` column value this load writes. Scopes the DELETE. */
  source: string;
  /** `gs://…` uris, wildcards allowed. */
  sourceUris: readonly string[];
  /** The partition column. `session_date` on every table this loads today. */
  dateColumn?: string;
}): Promise<{ deleted: number; loaded: number }> {
  const dateColumn = args.dateColumn ?? "session_date";
  assertIdent(args.table, "table");
  assertIdent(dateColumn, "dateColumn");
  if (args.sourceUris.length === 0) {
    // A load over zero uris SUCCEEDS with zero rows, so the caller would accept
    // a month it never wrote. Refuse rather than discover it a quarter later.
    throw new Error(
      `replaceMonth(${args.table}): refusing a load with no source uris — ` +
        `it would succeed, write nothing, and the partition would be ACCEPTED`,
    );
  }

  const deleted = await deleteMonth({ ...args, dateColumn });
  const loaded = await loadStage(args.table, args.sourceUris);
  return { deleted, loaded };
}

/**
 * The DELETE a month-replace issues, as data — MONEY-1514 review.
 *
 * Extracted from `deleteMonth` because the market-clause decision had NO test:
 * mutating `scopeMarket` to a constant `true` left the whole lake suite green
 * at 317/317, while making every `fund_nav_d1` delete name a column that table
 * does not have. `usDeleteScope` pins which pair a caller passes; this pins
 * what the statement does with them, which is a different question and was the
 * unguarded half.
 */
export function buildDeleteMonthSql(args: {
  projectId: string;
  dataset: string;
  table: string;
  market: string | null;
  fromInclusive: string;
  toExclusive: string;
  source: string;
  dateColumn: string;
}): {
  query: string;
  params: Record<string, string>;
  types: Record<string, string>;
} {
  // `market` is a CLAUSE, not a parameter that can be null — MONEY-1513.
  // `fund_nav_d1` HAS NO `market` COLUMN (`002_silver_price_bars.sql`: it keys
  // on `perma_ticker`, which is not derivable from the master), so naming it
  // would fail the statement outright with "Unrecognized name: market". A NULL
  // parameter is the other wrong answer: `market = NULL` is UNKNOWN for every
  // row, so the DELETE would silently match NOTHING and the load that follows
  // would APPEND a second copy of the month — the duplicate this delete exists
  // to prevent, reached through the path added to support the new table.
  //
  // WHAT THIS GUARD DOES *NOT* PREVENT, corrected after review. Earlier prose
  // here (and in `us-sink-logic.ts`) claimed a null market "removes THIRTEEN
  // MILLION India rows". It cannot: the DELETE also carries
  // `AND source = @source`, India's `price_bar_d1` rows are `BHAVCOPY_HIST`
  // (`india-sink-logic.ts`) and the US replay passes each bar's own source
  // (`TIINGO` on prod), so no India row can match whatever `market` does. What
  // it DOES do is widen the delete across every other US source in the month
  // and then replace only the one being loaded. Stated exactly, because a
  // reader who measures the dramatic version and finds it false will conclude
  // the GUARD is unnecessary rather than the PROSE wrong.
  //
  // `!= null`, not `!== null`: an untyped caller passing `undefined` would
  // otherwise take the scoped branch and bind `market` as NULL, which is
  // precisely the UNKNOWN-matches-nothing case this exists to refuse.
  // GUARDED HERE, NOT ONLY IN `replaceMonth` — MONEY-1516 review (#17).
  //
  // These four values are interpolated into SQL and none can be bound as a
  // parameter. `assertIdent` used to sit in `replaceMonth` alone, and when this
  // function was EXTRACTED AND EXPORTED the guard stayed behind: every caller
  // reaching `buildDeleteMonthSql` directly — the tests already are one — got
  // unvalidated interpolation of `table` and `dateColumn` into a DELETE. A
  // guard belongs at the point of interpolation, because that is the thing
  // that travels when the code is refactored.
  assertIdent(args.table, "table");
  assertIdent(args.dateColumn, "dateColumn");
  assertQualifier(args.projectId, "projectId");
  assertQualifier(args.dataset, "dataset");

  const scopeMarket = args.market != null;
  return {
    // The bounds are STRING params parsed in SQL — `dateBound` says why. Typed
    // `DATE` they reached BigQuery as NULL and this DELETE matched nothing.
    query: `DELETE FROM \`${args.projectId}.${args.dataset}.${args.table}\`
            WHERE ${scopeMarket ? "market = @market\n              AND " : ""}${args.dateColumn} >= ${dateBound("from")}
              AND ${args.dateColumn} <  ${dateBound("to")}
              AND source = @source`,
    params: {
      ...(scopeMarket ? { market: args.market as string } : {}),
      from: args.fromInclusive,
      to: args.toExclusive,
      source: args.source,
    },
    types: {
      ...(scopeMarket ? { market: "STRING" } : {}),
      from: "STRING",
      to: "STRING",
      source: "STRING",
    },
  };
}

async function deleteMonth(args: {
  table: string;
  market: string | null;
  fromInclusive: string;
  toExclusive: string;
  source: string;
  dateColumn: string;
}): Promise<number> {
  const { projectId, dataset } = silverConfig();
  // RETRIED ON A CONCURRENT-DML CONFLICT — MONEY-1608. Two replays share
  // `price_bar_d1` (IN and US both DELETE-then-load a month of it), and
  // BigQuery aborts one of two colliding DELETEs. The DELETE is atomic, so an
  // aborted one removed nothing and re-issuing it is its first execution.
  return retryOnDmlConflict(
    async () => {
      const [job] = await bq(projectId).createQueryJob(
        buildDeleteMonthSql({ ...args, projectId, dataset }),
      );
      await job.promise();
      const [md] = await job.getMetadata();
      return Number(md?.statistics?.query?.numDmlAffectedRows ?? 0);
    },
    { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  );
}

async function loadStage(
  table: string,
  sourceUris: readonly string[],
): Promise<number> {
  const { projectId, dataset } = silverConfig();
  const [job] = await bq(projectId).createJob({
    configuration: {
      load: {
        sourceUris: [...sourceUris],
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        destinationTable: { projectId, datasetId: dataset, tableId: table },
        writeDisposition: "WRITE_APPEND",
        // BOTH OF THESE ARE THE POINT, and both default the permissive way.
        //
        // `ignoreUnknownValues` false: a field the table does not have FAILS
        // the load. True would let a renamed column vanish silently — the row
        // count would be right and the column empty, which is the shape of
        // every defect this lane has paid for.
        //
        // `maxBadRecords` 0: one unparseable row fails the month rather than
        // loading 20,999 of 21,000 and reporting success. The ledger's whole
        // job is that ACCEPTED means complete.
        ignoreUnknownValues: false,
        maxBadRecords: 0,
        // The DDL owns the schema. Autodetect would INFER one from the first
        // rows — turning a NUMERIC price column into FLOAT64 on a fresh table
        // and an INT64 count into a string, neither of which errors.
        autodetect: false,
      },
    },
    location: LAKE_REGION,
  });
  await job.promise();
  const [md] = await job.getMetadata();
  const errors = md?.status?.errorResult;
  if (errors) {
    throw new Error(
      `load into ${dataset}.${table} failed: ${errors.reason ?? "?"} ${errors.message ?? ""}`,
    );
  }
  return Number(md?.statistics?.load?.outputRows ?? 0);
}
