/**
 * Staging: how a batch of silver rows becomes an object `bq load` can read.
 *
 * Pure — no GCS, no BigQuery, no clock.
 *
 * ## NDJSON, NOT PARQUET — a deliberate departure from the B2 prompt
 *
 * The prompt says "write Parquet to `lake/stage/…`". Two measured facts in this
 * repo argue the other way for THESE objects, and neither is an opinion:
 *
 * 1. **The repo's own parquet writer emits volume as DOUBLE, not INT64**,
 *    because `hyparquet` decodes INT64 as a JS `bigint` and the candle
 *    repository's `finite()` guard rejects one — "an INT64 column would drop
 *    every bar on read, silently" (root CLAUDE.md, MONEY-1384). A DOUBLE volume
 *    loaded into BigQuery's INT64 column is a precision question we would then
 *    own for ever.
 * 2. **Parquet COSTS space at D1 scale.** Measured 2026-09-08: a 252-bar
 *    symbol-year is 5,809 B as gzipped JSONL against 9,776 B as parquet, +68%.
 *    Its win is column projection and predicate pushdown for the Python
 *    backtest reader — a consumer these objects never have.
 *
 * A stage object is read exactly once, by `bq load`, and deleted at 14 days by
 * the `lake/stage/` lifecycle rule from S1. So the format question is only
 * "what loads correctly", and NDJSON's INT64-as-decimal-string is BigQuery's
 * own documented convention rather than a workaround.
 *
 * If a later consumer wants parquet here, the row shape does not change — only
 * the encoder does. That is why this module is separate from the loader.
 */

import type { PriceBarRow } from "./price-bar-logic";

/**
 * How every lake job writes a stage object — MONEY-1608. Spread into
 * `uploadFile`.
 *
 * `timeoutMs`: stage parts are NOT small. Measured on prod: 46.7 MiB
 * (derivatives_eod_in), 52.6 MiB (filing_registry), 32.1 MiB (trade_bar_h1).
 * Five minutes for the largest still needs only ~180 KB/s. The deadline is
 * also the ref'd timer that keeps the process alive while an upload is
 * outstanding: `lake-replay-us` exited 0 mid-flush on 2026-09-23 because an
 * upload with NO deadline was the last thing it awaited.
 *
 * `retries`: TRANSIENT failures only (network, 408/429/5xx, our deadline). The
 * SDK itself never retries these writes. Backoff is 15 s, 60 s, 240 s.
 *
 * `createOnly`: the lake writer holds objectCreator, not delete, so a
 * re-attempt must never overwrite. A stage key is DETERMINISTIC
 * ({@link stageKey}); when a re-attempt finds its object already there (an
 * earlier attempt committed and lost its response) `uploadFile` reads it back
 * and accepts it only if it holds exactly these bytes.
 */
export const STAGE_UPLOAD_POLICY = {
  timeoutMs: 300_000,
  retries: 3,
  createOnly: true,
} as const;

/**
 * The stage key for one partition.
 *
 * `lake/stage/{table}/{partitionKey}/{runId}.ndjson`
 *
 * ## The RUN ID is in the key, and that is the whole point
 *
 * Two runs loading the same partition must not write the same object. If they
 * did, run B could overwrite run A's bytes while A's `bq load` was still
 * reading them — a load that half-succeeds against two different inputs and
 * reports success. GCS has no rename and no locking; a unique key per run is
 * the only thing that makes concurrent runs safe.
 *
 * It also makes a failed load debuggable: the exact bytes BigQuery rejected are
 * still there, under the run that produced them, until the lifecycle rule
 * removes them.
 *
 * The partition key contains `/` (`US/2026-03`), which nests the object one
 * level deeper. That is intentional and harmless — every reader computes the
 * same key rather than listing.
 */
export function stageKey(args: {
  table: string;
  partitionKey: string;
  runId: string;
  /**
   * One shard of a multi-object partition. MONEY-1497.
   *
   * B2's US loader holds a listing-month in memory and writes one object. The
   * India replay cannot: one month of NSE F&O UDiFF is every strike on every
   * underlying for ~21 sessions — millions of rows — so it streams ONE OBJECT
   * PER DAY-FILE and hands `bq load` a wildcard over the run's folder.
   *
   * Given, the object nests one level deeper: `.../{runId}/{part}.ndjson`. That
   * is what makes the wildcard `.../{runId}/*` safe — it can only ever match
   * this run's own shards, never a concurrent run's, which is the same reason
   * the run id is in the key at all.
   */
  part?: string;
}): string {
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (!value || /[\u0000-\u001f]/.test(value)) {
      throw new Error(
        `stageKey: ${name} must be a non-empty control-character-free string, ` +
          `got ${JSON.stringify(value)} — a malformed key silently files the ` +
          `object somewhere the loader will not look for it`,
      );
    }
  }
  const base = `lake/stage/${args.table}/${args.partitionKey}/${args.runId}`;
  return args.part === undefined
    ? `${base}.ndjson`
    : `${base}/${args.part}.ndjson`;
}

/**
 * The `bq load` wildcard covering every shard a run wrote for one partition.
 *
 * DERIVED from `stageKey` rather than restated. A prefix that disagrees with
 * the key by one character matches ZERO objects, and `bq load` over zero
 * objects SUCCEEDS with zero rows — so the partition would be ACCEPTED having
 * stored nothing, which is the silent-empty-partition shape the ledger exists
 * to prevent.
 */
export function stageShardPrefix(args: {
  table: string;
  partitionKey: string;
  runId: string;
}): string {
  const sample = stageKey({ ...args, part: "x" });
  return sample.slice(0, sample.lastIndexOf("/") + 1);
}

/**
 * Encode rows as newline-delimited JSON.
 *
 * ## A TRAILING NEWLINE, always
 *
 * BigQuery tolerates its absence, but a missing final newline is the classic
 * way two concatenated NDJSON files produce one corrupt line. Emitting it makes
 * concatenation safe by construction rather than by nobody having tried it.
 *
 * ## An EMPTY batch throws rather than producing an empty object
 *
 * A zero-byte stage object loads successfully and adds zero rows, so the
 * partition would be ACCEPTED having stored nothing — the exact silent-success
 * shape the ledger exists to prevent. The caller must decide what an empty
 * partition means; this function will not decide it by writing nothing.
 */
/**
 * GENERIC over the row type since MONEY-1505 (B5). `price_bar_d1`,
 * `trade_bar_m1`, `trade_bar_h1` and `spread_cost_daily` all stage the same
 * way, and the encoder has no opinion about columns — narrowing it to
 * `PriceBarRow` would have forced a second, identical encoder for the bar
 * tables, and the empty-batch refusal below is the part nobody should copy.
 *
 * The DEFAULT type parameter is main's, and it is kept deliberately: every
 * pre-existing caller passes a `PriceBarRow` and states no type argument, so
 * dropping the default would break them for no gain.
 */
export function encodeNdjson<T extends object = PriceBarRow>(
  rows: readonly T[],
): string {
  if (rows.length === 0) {
    throw new Error(
      "encodeNdjson: refusing to encode zero rows — an empty stage object " +
        "loads successfully and adds nothing, so the partition would be " +
        "ACCEPTED having stored nothing. Decide what an empty partition means " +
        "before calling this.",
    );
  }
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/**
 * De-duplicate bars that appear in BOTH the hot window and a cold shard.
 *
 * `planShardYears` deliberately does NOT subtract the hot window, because the
 * current year's shard exists once `candle-evict` has archived part of it and
 * the boundary moves under a long replay. So overlap is EXPECTED, not a defect
 * — and it must be removed before load, or the partition gets two rows for one
 * session and every downstream aggregate double-counts.
 *
 * ## The hot row wins
 *
 * Both describe the same session, but the hot row is the one a later correction
 * would have been written to: `candle-repository` updates OHLC in place on an
 * upgrade, while a cold shard is a point-in-time archive. Preferring the shard
 * would silently revert a corrected bar.
 */
export function dedupeBySession<
  T extends { listingId: string; sessionDate: string },
>(hot: readonly T[], cold: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of hot) {
    const k = `${row.listingId}\u0000${row.sessionDate}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  for (const row of cold) {
    const k = `${row.listingId}\u0000${row.sessionDate}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}
