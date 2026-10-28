/**
 * Lake RELEASES — the immutable, versioned parquet artifact a backtest pins.
 * MONEY-1518 (data-platform B7). Pure decisions only; `scripts/jobs/lake-release.ts`
 * moves the bytes and this file decides what it is allowed to move.
 *
 * ## WHAT A RELEASE IS FOR, AND WHY IT IS NOT A CONVERSION
 *
 * `CANDLE_COLD_FORMAT` (MONEY-1384) already lets the cold shard store write
 * parquet, and B7 was framed as "flip it for the wide intraday shards". THE
 * MEASUREMENT SAYS NO. Re-run 2026-09-22 through `encodeColdShard` itself, on
 * the real prod objects `candles/US/M1/AAPL/{2024,2025}`:
 *
 *   rows      JSONL_GZ      PARQUET      delta
 *   123,072   1,912,970 B   2,364,453 B  +23.6%
 *   125,527   1,996,426 B   2,454,335 B  +22.9%
 *
 * The ticket's hypothesis was that ~86k rows "may well invert the ratio". It
 * does not. The fixed footer/schema/page cost amortises (D1's +68% falls to
 * +23%) and never crosses zero, because DEFLATE over a JSONL line whose keys
 * and symbol repeat on every row is already doing parquet's dictionary job.
 * Truncating the same real bars shows it is not even monotonic — +7.1% at
 * 50,000 rows, +25.3% at 100,000 — so a row-group boundary can make a BIGGER
 * shard worse. **Do not convert the cold store at any timeframe.**
 *
 * A release is therefore a SEPARATE ARTIFACT, not a re-encoding of the store:
 * built once per cut, laid out `market=`/`year=` so a sweep prunes partitions
 * without opening them, and holding the columns a backtest reads rather than
 * every column a symbol-year happens to carry. That read shape is what parquet
 * is bought for; the bytes on the cold store stay gzipped JSONL.
 *
 * ## IMMUTABILITY IS ENFORCED BY BIGQUERY, NOT BY A CHECK WE WROTE
 *
 * `EXPORT DATA` takes `overwrite` and defaults it to FALSE: an existing object
 * under the destination wildcard fails the statement. {@link buildExportSql}
 * therefore always spells `overwrite=false` and a test pins it, because the
 * alternative — read the prefix, then write it — is a race a retried job loses
 * against itself. A pre-flight existence check still runs in the job, for a
 * legible error rather than for safety.
 *
 * ## EXPORT DATA, NOT `bq extract`
 *
 * `gold.adjusted_bar_d1` is a VIEW (`dataform/definitions/gold/adjusted_bar_d1.sqlx`
 * — deliberately, because one new split restates every earlier row of a
 * listing and an incremental table would leave a decade of history on the old
 * basis). Extract jobs refuse a view. `EXPORT DATA ... AS SELECT` takes any
 * query, so the one primitive covers views, tables and the per-partition
 * predicates below. It is also free of charge and streams nothing through
 * Node — which is what makes a multi-GB release possible from a 2Gi job.
 *
 * ## THE FACTORS ARE EXPORTED, AND THAT IS WHAT RETIRES THE PYTHON PORT
 *
 * `adjusted_bar_d1` emits `price_factor` and `split_factor_cum` per (market,
 * listing_id, session_date). Carrying them in `bars_d1` lets an INTRADAY bar
 * be adjusted by joining its session date — so M1 is adjustable with NO second
 * implementation of CRSP. `scripts/quant/read_candles.py` re-implemented the
 * policy in Python precisely because it had raw bars and no factors; B7 gives
 * it the factors and deletes the port. Dropping these two columns to save
 * space would quietly restore the need for it.
 */
import { bucketForPrefix, type LakeEnv } from "./lake-layout";

/** `releases/` — already declared in `LAKE_PREFIXES`, routed to the lake bucket. */
export const RELEASE_PREFIX = "releases/";

/**
 * The adjustment policy THIS BUILD expects the gold view to be computing.
 *
 * `dataform/includes/adjustment.js` owns the value; `dataform-agreement.test.ts`
 * holds this copy equal to it, so a bump of one alone goes red in CI. It is an
 * EXPECTATION, not what the manifest prints — see {@link resolveAdjustmentPolicy}.
 * Bumped to `crsp-v3` together with the include (MONEY-1528/1537/1541),
 * before the first cut — so no release has ever carried `crsp-v2`.
 */
export const ADJUSTMENT_POLICY_VERSION = "crsp-v3";

/**
 * The adjustment policy a release was cut under — READ FROM THE ROWS it exports.
 *
 * `adjusted_bar_d1` stamps `adjustment_policy_version` on every row, and the
 * manifest records the distinct value the cut actually read. It used to print
 * the constant above instead and compared it with nothing, so a policy bump on
 * either side alone would have published a manifest naming a policy none of
 * its rows carried, in an artifact that can never be corrected. A reader
 * comparing two releases has to be able to tell "the same policy, later data"
 * from "the policy moved", and only the first is safe to concatenate.
 *
 * REFUSED rather than named: rows that disagree with each other (a view
 * mid-redeploy), and rows that disagree with `expected` — a warehouse whose
 * Dataform has not been re-run since the policy moved. Both are fixed at the
 * source, before a cut; an immutable artifact cannot be fixed after one.
 */
export function resolveAdjustmentPolicy(
  values: readonly (string | null | undefined)[],
  expected: string = ADJUSTMENT_POLICY_VERSION,
): string {
  const distinct = [...new Set(values)];
  const only = distinct[0];
  if (distinct.length !== 1 || typeof only !== "string" || only.trim() === "") {
    throw new Error(
      `adjusted_bar_d1 carries ${distinct.length} adjustment_policy_version value(s) ` +
        `(${distinct.map((v) => JSON.stringify(v)).join(", ") || "none"}); a release ` +
        `records exactly one. A view mid-redeploy, or a policy change applied to ` +
        `part of the history, must be fixed at the source before a cut.`,
    );
  }
  if (only !== expected) {
    throw new Error(
      `adjusted_bar_d1 computes ${only}, and this build expects ${expected} ` +
        `(dataform/includes/adjustment.js). Re-run Dataform for this environment ` +
        `before cutting — a release is permanent, and would carry the stale policy.`,
    );
  }
  return only;
}

/** Manifest schema version. Bumped when a FIELD changes meaning, never on an edit. */
export const MANIFEST_VERSION = 1;

/**
 * THE DOUBLE RULE — every INT64 and NUMERIC column leaves as FLOAT64.
 *
 * `SELECT *` exported silver's types as they are: prices are NUMERIC(18, 6),
 * which parquet carries as DECIMAL, and `volume` is INT64. MONEY-1518 states
 * the rule for any writer in this builder — "VOLUME MUST BE WRITTEN AS DOUBLE,
 * NOT INT64" — because hyparquet decodes INT64 as a `bigint`, the repo's
 * `finite()` guard rejects it, and every bar would drop on a TypeScript read
 * with the file looking EMPTY rather than broken (`candle-logic.ts:856`).
 * DECIMAL is the same failure in Python: pyarrow hands pandas an object column
 * of `Decimal`, and `lake.py`'s intraday adjustment (`Decimal * float`) raises
 * on the first row.
 *
 * Driven by the source's own `INFORMATION_SCHEMA.COLUMNS`, not by a list typed
 * here: silver is edited by other tickets (`observed_ratio` arrived while this
 * was written), and a hand list would let the next NUMERIC column through.
 * A value exceeding 2^53 would lose precision as a double; no quantity this
 * lake holds comes near it, and identifiers (`publisher_id`) are uint32.
 */
export function doubleReplacements(
  columns: readonly { name: string; dataType: string }[],
): string[] {
  const out: string[] = [];
  for (const { name, dataType } of columns) {
    if (!/^(INT64|NUMERIC|BIGNUMERIC|DECIMAL|BIGDECIMAL)\b/i.test(dataType)) {
      continue;
    }
    // An identifier from INFORMATION_SCHEMA is spliced into SQL; anything that
    // is not a plain column name is refused rather than quoted.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,299}$/.test(name)) {
      throw new Error(
        `doubleReplacements: ${JSON.stringify(name)} is not a plain column name`,
      );
    }
    out.push(`CAST(${name} AS FLOAT64) AS ${name}`);
  }
  return out;
}

/**
 * `YYYY-MM-DDTHH-mm-ssZ` — the release id, and also the snapshot instant.
 *
 * ONE clock, not two. An id that did not carry its own time would need a
 * second field to say when the warehouse was read, and the two would
 * eventually disagree about the same cut. Colons are replaced with hyphens
 * because a colon in a GCS object name is legal but survives almost nothing
 * else intact — a local sync cache, a shell argument, a Windows path.
 */
export function releaseId(now: Date): string {
  // BEFORE toISOString, which throws a bare `RangeError: Invalid time value`
  // naming neither the caller nor the subject. An id is the one string a
  // reader pins forever; the error that refuses to mint one has to say why.
  if (Number.isNaN(now.getTime())) {
    throw new Error(
      "releaseId: refusing to name a release from an Invalid Date",
    );
  }
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(":", "-")}Z`;
}

const RELEASE_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/**
 * Validate a caller-supplied id BEFORE it becomes half of an object key.
 *
 * Shape-checked rather than merely non-empty: `..`, a `/`, or a leading `-`
 * reshapes the key and can walk a write out of `releases/` entirely, which
 * `bucketForPrefix` would then either refuse (loud) or — for a value that
 * still starts with the prefix — route correctly into the WRONG release. The
 * regex admits exactly what {@link releaseId} emits.
 */
export function parseReleaseId(raw: string): string {
  const id = raw.trim();
  if (!RELEASE_ID_RE.test(id)) {
    throw new Error(
      `Not a release id: ${JSON.stringify(raw)}. Expected YYYY-MM-DDTHH-mm-ssZ ` +
        `(e.g. 2026-09-22T00-00-00Z).`,
    );
  }
  return id;
}

/**
 * `releases/{id}/{relPath}`, and it ASKS `bucketForPrefix` whether that routes.
 *
 * The call is not decoration. `lake-layout.ts` refuses an unknown prefix
 * rather than defaulting to a bucket, and the A1/A2 briefs' `bars/` is the
 * standing example of a path that reads fine and throws — so a key built here
 * and never routed would fail at the first write of a release instead of at
 * the first test.
 */
export function releaseKey(env: LakeEnv, id: string, relPath: string): string {
  const clean = relPath.replace(/^\/+/, "");
  // `.trim() === ""` rather than `clean === ""`: GCS happily stores an object
  // literally named "   ", so a whitespace-only relPath is a file nobody can
  // name back and nothing reports. Control characters are refused for the same
  // reason `cold_key` refuses them — they reshape the key invisibly.
  if (
    clean.trim() === "" ||
    clean.includes("..") ||
    /[\u0000-\u001f\u007f]/.test(clean)
  ) {
    throw new Error(
      `releaseKey: ${JSON.stringify(relPath)} is empty or escapes the release`,
    );
  }
  const key = `${RELEASE_PREFIX}${parseReleaseId(id)}/${clean}`;
  bucketForPrefix(key, env); // throws UnknownPrefixError if `releases/` were ever dropped
  return key;
}

/** `gs://{bucket}/{key}` for the same key. */
export function releaseUri(env: LakeEnv, id: string, relPath: string): string {
  const key = releaseKey(env, id, relPath);
  return `gs://${bucketForPrefix(key, env)}/${key}`;
}

/**
 * ARM FLAG. `"true"` and nothing else.
 *
 * Compared against the LITERAL string because `Boolean("false")` is true,
 * which arms a job in the one configuration meant to keep it off; and read PER
 * CALL through a default parameter because a module-scope read freezes at
 * import and turns a redeployed switch into no switch on a warm container.
 * Both traps are on file against `XBRL_PROJECTION_APPLY`, `TIINGO_PLAN`,
 * `DATABENTO_HARVEST_APPLY` and `CANDLE_COLD_FORMAT`.
 */
export function resolveReleaseApply(
  raw: string | undefined = process.env.LAKE_RELEASE_APPLY,
): boolean {
  return raw?.trim().toLowerCase() === "true";
}

/**
 * One exportable dataset in a release.
 *
 * `partitionBy` is the GRAIN, and it is the only thing standing between the
 * 256 MB–1 GB rule (`lake-layout.md` §7) and a release of thousands of tiny
 * objects. It is a fixed property of the source rather than something a
 * planner derives, because the sizes that would feed such a planner have never
 * been measured against a real release — and a planner fed a guess produces a
 * confident wrong layout.
 */
export interface ReleaseDataset {
  /** Directory under the release. */
  readonly name: string;
  /** Unqualified source, resolved against its dataset at build time. */
  readonly source: string;
  /** `silver` or `gold`. */
  readonly layer: "silver" | "gold";
  /** Hive partition columns, outermost first. `[]` = one flat directory. */
  readonly partitionBy: readonly ("market" | "year" | "month")[];
  /** Date column the `year`/`month` partitions are derived from, when partitioned by time. */
  readonly dateColumn?: string;
  /** The column whose single distinct value the manifest records as `adjustmentPolicy`. */
  readonly policyColumn?: string;
  /** Why this table is in a release at all — read by nobody, kept for the next reader. */
  readonly why: string;
}

/**
 * THE RELEASE CONTENTS.
 *
 * `events` is absent DELIBERATELY. `instrument_event` holds 5,323 rows on prod
 * and all of them are `TIINGO_NEWS` — a news feed, not a point-in-time fact a
 * backtest may condition on, and `listingId` is null wherever the CIK resolved
 * to nothing (C1's accepted degradation until C3 lands). Publishing it inside
 * an artifact whose whole promise is reproducibility would put an unjoinable,
 * single-source table beside six joinable ones under one manifest. It goes in
 * when C3 makes it linkable, as a new dataset entry and a manifest bump.
 */
export const RELEASE_DATASETS: readonly ReleaseDataset[] = [
  {
    name: "instruments/listing",
    source: "listing",
    layer: "silver",
    partitionBy: [],
    why: "the identity spine; every listing_id in every other file resolves here, and its validity windows ARE the survivorship-free universe",
  },
  {
    name: "instruments/symbol_history",
    source: "symbol_history",
    layer: "silver",
    partitionBy: [],
    why: "the labels a listing wore — its universe name on a date; label START dates are not known",
  },
  {
    name: "corporate_actions",
    source: "corporate_action",
    layer: "silver",
    partitionBy: [],
    why: "the inputs the adjustment factors were computed FROM, so a factor can be re-derived",
  },
  {
    name: "bars_d1",
    source: "adjusted_bar_d1",
    layer: "gold",
    partitionBy: ["market", "year"],
    dateColumn: "session_date",
    policyColumn: "adjustment_policy_version",
    // MEASURED 2026-09-22, and it is not what the B7 brief assumes. That brief
    // names `bars_d1/market=US/`, but `adjusted_bar_d1` is a VIEW over
    // `lake_silver.price_bar_d1`, and that table is INDIA-ONLY: 14,291,560
    // rows, every one `market = "IN"`, 1994-11-03 to 2026-09-22. US daily bars
    // live in the `candles` store (Mongo hot window + GCS cold shards) and
    // have never been ingested into silver. So `market=US` under this dataset
    // is not a partition that comes back empty — it is one `planPartitions`
    // is never handed, because the census that feeds it asks the table.
    // Nothing here is wrong; hard-coding a US partition would produce an empty
    // directory that reads as a quiet market.
    //
    // CORRECTED after review: this said the US D1 leg "is a MISSING LOADER".
    // It was, when this was written in an isolated worktree — MONEY-1513 lands
    // that loader in this same commit. It has not been RUN, which is why the
    // census still returns no US grain; that is a run, not a gap.
    //
    // The count below was measured the same day as `lake-replay-us.ts`'s and
    // the two disagree (14,291,560 vs 13,185,397) because the India replay was
    // mid-flight between them. Both are honest snapshots; neither is the
    // table's size now. Read the table, not this comment.
    why: "raw AND adjusted AND the two factors — the factors are what let M1 be adjusted",
  },
  {
    name: "bars_m1",
    source: "trade_bar_m1",
    layer: "silver",
    partitionBy: ["market", "year", "month"],
    dateColumn: "session_date",
    why: "the intraday baseline; month-grained because a US M1 year is ~40M rows",
  },
] as const;

/** One `EXPORT DATA` statement's worth of work. */
export interface ExportPartition {
  readonly dataset: string;
  /** Hive path segments, e.g. `["market=US", "year=2024"]`. */
  readonly segments: readonly string[];
  /** `WHERE` terms ANDed together. Empty = the whole source. */
  readonly predicates: readonly string[];
}

/**
 * Expand one dataset into its partitions for a given cut.
 *
 * YEARS ARE SUPPLIED, NEVER INFERRED HERE. A pure function cannot ask
 * BigQuery what years a table holds, and guessing a range is how a release
 * silently ships nine years of a ten-year table — the partition simply is not
 * written and nothing counts what was never asked for. The job passes the
 * distinct (market, year) pairs it measured; this function only shapes them.
 */
export function planPartitions(
  dataset: ReleaseDataset,
  grains: readonly { market: string; year?: number; month?: number }[],
): ExportPartition[] {
  if (dataset.partitionBy.length === 0) {
    return [{ dataset: dataset.name, segments: [], predicates: [] }];
  }
  const dateCol = dataset.dateColumn;
  if (dateCol === undefined) {
    throw new Error(`${dataset.name}: partitioned by time with no dateColumn`);
  }
  const out: ExportPartition[] = [];
  for (const g of grains) {
    const segments: string[] = [];
    const predicates: string[] = [];
    for (const col of dataset.partitionBy) {
      if (col === "market") {
        assertPartitionValue("market", g.market);
        segments.push(`market=${g.market}`);
        predicates.push(`market = ${quote(g.market)}`);
      } else if (col === "year") {
        const year = requireInt("year", g.year);
        segments.push(`year=${year}`);
        predicates.push(`EXTRACT(YEAR FROM ${dateCol}) = ${year}`);
      } else {
        const month = requireInt("month", g.month);
        if (month < 1 || month > 12) {
          throw new Error(`planPartitions: month ${month} is not a month`);
        }
        // Zero-padded so `month=2` and `month=02` cannot both exist and a
        // lexical listing orders the year correctly.
        segments.push(`month=${String(month).padStart(2, "0")}`);
        predicates.push(`EXTRACT(MONTH FROM ${dateCol}) = ${month}`);
      }
    }
    out.push({ dataset: dataset.name, segments, predicates });
  }
  return out;
}

function requireInt(what: string, value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `planPartitions: ${what} must be an integer (got ${String(value)})`,
    );
  }
  return value;
}

/** A partition VALUE becomes a path segment and a SQL literal. Both are injectable. */
function assertPartitionValue(what: string, value: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw new Error(
      `planPartitions: ${what} ${JSON.stringify(value)} is not a safe partition value`,
    );
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * The `EXPORT DATA` statement for one partition.
 *
 * `overwrite=false` is spelled explicitly even though it is the default, and a
 * test pins it: this is the whole immutability guarantee of a release, and a
 * default is something a future edit removes without noticing it was load-bearing.
 *
 * The uri carries exactly ONE `*` — BigQuery rejects more, and a uri with none
 * fails the moment a result exceeds one file, which is precisely the release
 * that matters.
 *
 * `replace` is `SELECT * REPLACE (...)` — every column still leaves, so the
 * FACTORS cannot be dropped by it, and only the named ones change type. It is
 * how {@link doubleReplacements} reaches the statement.
 */
export function buildExportSql(args: {
  readonly uriPrefix: string;
  readonly qualifiedSource: string;
  readonly predicates: readonly string[];
  readonly columns?: readonly string[];
  readonly replace?: readonly string[];
}): string {
  const { uriPrefix, qualifiedSource, predicates, columns, replace } = args;
  if (uriPrefix.includes("*")) {
    throw new Error(
      `buildExportSql: uriPrefix must not already contain a wildcard: ${uriPrefix}`,
    );
  }
  if (!uriPrefix.startsWith("gs://")) {
    throw new Error(
      `buildExportSql: uriPrefix must be a gs:// uri (got ${uriPrefix})`,
    );
  }
  const projected = columns !== undefined && columns.length > 0;
  const replaced = replace !== undefined && replace.length > 0;
  if (projected && replaced) {
    throw new Error(
      "buildExportSql: `columns` and `replace` are exclusive — REPLACE only applies to SELECT *",
    );
  }
  const select = projected
    ? columns.join(", ")
    : replaced
      ? `* REPLACE (${replace.join(", ")})`
      : "*";
  const where =
    predicates.length > 0 ? `\n  WHERE ${predicates.join(" AND ")}` : "";
  return [
    "EXPORT DATA OPTIONS(",
    `  uri = '${uriPrefix}/part-*.parquet',`,
    "  format = 'PARQUET',",
    "  compression = 'SNAPPY',",
    "  overwrite = false",
    ") AS",
    `SELECT ${select}`,
    `  FROM \`${qualifiedSource}\`${where}`,
  ].join("\n");
}

/** One file as the manifest records it. */
export interface ManifestFile {
  readonly path: string;
  readonly bytes: number;
  /**
   * NAMED, never bare. GCS populates `crc32c` on every object including
   * composites and validates it on every read, and it costs nothing to record;
   * it is what {@link verifyManifest} compares against bucket METADATA.
   */
  readonly checksum: { readonly algo: "crc32c"; readonly value: string };
  /**
   * sha256 of the object's bytes, hex — the ticket's "sha256 per file", and
   * the one digest a reader holding a LOCAL COPY can check with a standard
   * library (`hashlib`; Python has no crc32c in the box). It costs the job one
   * streamed read-back of every object, in-region and not billed as egress.
   * This is what `lake.py`'s `verify_release()` checks a sync cache against.
   */
  readonly sha256: string;
}

export interface ReleaseManifest {
  readonly manifestVersion: number;
  readonly releaseId: string;
  readonly env: LakeEnv;
  /** Warehouse snapshot instant. Equals `releaseId` decoded — carried so a reader need not parse. */
  readonly snapshotAt: string;
  readonly gitSha: string;
  readonly adjustmentPolicy: string;
  /** How the universe was chosen, in words, because a row count cannot say it. */
  readonly universeRule: string;
  /** Trading calendars the sessions in this release were stamped against. */
  readonly calendars: readonly string[];
  readonly licence: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly files: readonly ManifestFile[];
}

/**
 * LICENCE NOTES TRAVEL WITH THE BYTES.
 *
 * Tiingo COMMERCIAL is internal-use-only and Databento's EQUS.MINI is a venue
 * blend rather than the SIP — two facts that live in CLAUDE.md today and would
 * be lost the moment a release parquet is opened by anything that has not read
 * it. A release is the most portable artifact this platform produces, so it is
 * the one that most needs to carry its own terms.
 */
export const RELEASE_LICENCE_NOTES: readonly string[] = [
  "US prices derive from Tiingo (COMMERCIAL: INTERNAL USE ONLY — displaying them to a user is redistribution, MONEY-1262) and Databento EQUS.MINI.",
  "EQUS.MINI is a single anonymized consolidated publisher — a venue BLEND, a subset of the SIP. A backtest sized against it is sized against a subset.",
  "India prices derive from NSE/BSE bhavcopy.",
  "Not for redistribution. Not investment advice.",
];

/**
 * Verify a manifest against what the bucket actually holds.
 *
 * Returns the DISAGREEMENTS rather than a boolean, and treats extra files as a
 * disagreement too: a release is immutable, so an object the manifest does not
 * name is either a partial write from a crashed cut or a second cut that
 * landed on the same id, and a reader scanning `bars_d1/**` would read it
 * either way. A boolean would collapse "one file short" and "one file too
 * many" into the same word.
 */
export function verifyManifest(
  manifest: ReleaseManifest,
  actual: readonly { path: string; bytes: number; crc32c: string }[],
): string[] {
  const problems: string[] = [];
  const seen = new Map(actual.map((f) => [f.path, f]));
  for (const want of manifest.files) {
    const got = seen.get(want.path);
    if (got === undefined) {
      problems.push(`MISSING ${want.path}`);
      continue;
    }
    seen.delete(want.path);
    if (got.bytes !== want.bytes) {
      problems.push(
        `SIZE ${want.path}: manifest ${want.bytes}, bucket ${got.bytes}`,
      );
    }
    if (got.crc32c !== want.checksum.value) {
      problems.push(
        `CRC ${want.path}: manifest ${want.checksum.value}, bucket ${got.crc32c}`,
      );
    }
  }
  for (const path of seen.keys()) problems.push(`UNLISTED ${path}`);
  return problems;
}

/**
 * Refuse to publish a manifest for a cut that exported nothing.
 *
 * A dataset naming zero rows is not a quiet day — every table in
 * {@link RELEASE_DATASETS} is a standing population — and a manifest is the
 * one artifact a reader trusts without looking. `trade_bar_m1` held ZERO rows
 * on prod when this was written (MONEY-1514/1515 block its loader), so this is
 * the live case rather than a hypothetical: without the refusal a release
 * would ship a complete-looking manifest whose `bars_m1` is an empty
 * directory, and every backtest over it would report a clean run on no data.
 */
export function assertReleaseComplete(
  rowCounts: Readonly<Record<string, number>>,
): void {
  const empty = RELEASE_DATASETS.map((d) => d.name).filter(
    (name) => (rowCounts[name] ?? 0) <= 0,
  );
  if (empty.length > 0) {
    throw new Error(
      `Refusing to publish a release: ${empty.join(", ")} exported zero rows. ` +
        `An empty dataset in an immutable artifact is indistinguishable from a working one ` +
        `at read time. Fix the source or drop the dataset from RELEASE_DATASETS deliberately.`,
    );
  }
}
