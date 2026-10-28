/**
 * The COLD half of the 13F read (MONEY-979, T10).
 *
 * `us_13f_holdings` keeps a hot window — the two most recent report periods —
 * and the 13F evictor archives everything older to one gzipped JSONL object per
 * (manager, period) at `edgar/13f/{managerCik10}/{periodOfReport}`. A read of a
 * COLD quarter comes through here.
 *
 * ## Why a PORT and not a direct GCS call
 *
 * `@usemoney/storage` depends on `@usemoney/core`, so core CANNOT import it —
 * that is a cycle. Core owns the port and every decision around it; the worker
 * (or the Python service's TypeScript-side caller, if one ever exists)
 * registers a GCS-backed adapter at startup. This is the exact arrangement
 * `feed-archive.ts` and `candle-cold-store.ts` use, and it is reused rather
 * than reinvented so a unit test can inject a fake and nothing here needs GCP
 * to be covered.
 *
 * ## There is deliberately NO `list`
 *
 * `listFiles` in `@usemoney/storage` FAILS OPEN to `[]` on an auth or network
 * failure — MONEY-941, where an archive parse job read that as "0 files
 * archived, parse complete" and exited 0. An empty listing is therefore never
 * proof of absence. The read computes the ONE key it wants and `get`s it,
 * because `get` gives an answer that can be trusted in both directions: `null`
 * is a 404 and means genuinely absent, and anything else throws.
 */

import { gunzipSync, gzipSync } from "node:zlib";

// The SAME codec as the candle cold shards: gzip + JSONL, format sniffed from
// magic bytes rather than from the key (the key carries no extension, so a
// future producer can write parquet to the same keys and only the decoder
// grows a branch). `sniffColdShardFormat` is imported rather than mirrored so
// there is exactly one definition of what the magic bytes mean.
import {
  sniffColdShardFormat,
  type ColdShardFormat,
} from "../market-data/candles/candle-logic";
import type { UsHoldingRow } from "./types";

/* ─────────────────────────────────────────────────────────────────────────
   Keys
   ──────────────────────────────────────────────────────────────────────── */

/** Content type for a shard we write. Matches the candle shards. */
export const US_COLD_CONTENT_TYPE = "application/gzip";

export const US_13F_COLD_PREFIX = "edgar/13f";

/**
 * `edgar/13f/{managerCik10}/{YYYY-MM-DD}`.
 *
 * The date segment is the period-of-report as a UTC CALENDAR DAY, never an
 * instant: a 13F period is `2026-06-30`, and stamping it with a time would make
 * one quarter two different keys depending on which timezone the writer ran in.
 * A `periodOfReport` that will not parse throws rather than producing a key
 * spelled `.../Invalid Date` that would 404 forever and read as "this manager
 * held nothing".
 */
export function buildThirteenFColdKey(args: {
  managerCik10: string;
  periodOfReport: Date | string;
}): string {
  const cik = String(args.managerCik10 ?? "").trim();
  if (cik === "") {
    throw new Error("buildThirteenFColdKey: managerCik10 is required");
  }
  const d =
    args.periodOfReport instanceof Date
      ? args.periodOfReport
      : new Date(args.periodOfReport);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `buildThirteenFColdKey: unparseable periodOfReport ${String(args.periodOfReport)}`,
    );
  }
  return `${US_13F_COLD_PREFIX}/${cik}/${d.toISOString().slice(0, 10)}`;
}

/* ─────────────────────────────────────────────────────────────────────────
   The port
   ──────────────────────────────────────────────────────────────────────── */

/** Storage port. Implemented over GCS by the caller; faked in tests. */
export interface UsColdStore {
  /** Bytes at `key`, or `null` when the object genuinely does not exist. */
  get(key: string): Promise<Buffer | null>;
}

/**
 * How long one cold read may take.
 *
 * A bound is mandatory: `@google-cloud/storage` 7.x defaults to
 * `totalTimeout = 600s` with `maxRetries = 3`, and a Pub/Sub push handler's ack
 * deadline is also 600s — so one wedged object could consume the ENTIRE ack
 * budget, at which point Pub/Sub redelivers while run #1 is still live.
 */
export const US_COLD_TIMEOUT_MS = 20_000;

let store: UsColdStore | null = null;
let timeoutMs = US_COLD_TIMEOUT_MS;

/**
 * Register (or clear, with `null`) the cold backend.
 *
 * Without a registration a cold read reports `absent` and NOT an error, which
 * is the correct default for local dev and for today, where the evictor has
 * written nothing: "everything we hold is hot" is true. The caller still learns
 * the difference — `getManagerHoldings` marks the result `degraded` with a
 * named reason when a filing says COLD and no store is registered, so an
 * unconfigured environment never silently reports an empty portfolio as a real
 * one.
 *
 * `options` re-resolves on EVERY call so registration is idempotent and a test
 * that tightened the deadline cannot leak it into the next one.
 */
export function setUsColdStore(
  next: UsColdStore | null,
  options?: { timeoutMs?: number },
): void {
  store = next;
  const value = options?.timeoutMs;
  timeoutMs =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : US_COLD_TIMEOUT_MS;
}

/** The registered store, or null. Exported for assertions in tests. */
export function getUsColdStore(): UsColdStore | null {
  return store;
}

/* ─────────────────────────────────────────────────────────────────────────
   Outcomes — absence and failure are NOT the same thing
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A shard whose bytes exist and whose rows do not. Distinct from `absent`
 * because the object WAS there, and distinct from `present` because zero rows
 * is not a portfolio.
 */
export const US_COLD_REASON_SHARD_EMPTY = "COLD_SHARD_EMPTY";

/**
 * A shard that held lines and produced no rows: every line failed
 * `parseThirteenFShard`'s per-line validation. Strictly worse than
 * `COLD_SHARD_EMPTY` — the writer wrote something and we understood none of it.
 */
export const US_COLD_REASON_SHARD_UNPARSEABLE = "COLD_SHARD_UNPARSEABLE";

/**
 * The four states a cold read can end in.
 *
 * Four and not two on purpose. `present` and `absent` are both ANSWERS;
 * `failed` is the ABSENCE of an answer, and the whole point of this type is
 * that the last one can never be mistaken for a manager who holds nothing.
 *
 * That mistake is this repo's most expensive recurring bug: `listFiles`
 * returning `[]` on an auth failure read as "nothing archived" (MONEY-941); a
 * checkpoint recorded DONE for work that never happened (MONEY-1189); a
 * subscription cache wrote a fail-open FREE into Redis (MONEY-1126). Here it
 * would be worse than any of them, because an empty 13F portfolio is not
 * visibly wrong — it just shows a manager who sold everything.
 *
 * ## Why `empty` is its own state and not `present` with no rows
 *
 * It arrived through the `present` door, which is the one door the three-state
 * design does not guard. The evictor has no `if not rows` guard, so a filing
 * whose holdings yield zero rows writes a 20-byte gzip of the empty string; the
 * reader decoded it, returned `{status:"present", rows: []}`, every
 * completeness check passed, and `getManagerHoldings` fell through to an empty
 * result with **`degraded: false`** — the manager-sold-everything render this
 * whole type exists to prevent, reached without ever touching `absent` or
 * `failed`. A shard of pure corruption lands in the same place: every JSONL
 * line is dropped per-line by design, and "all of them" is still `[]`.
 *
 * So: present-and-populated is an answer; present-and-empty is not one, and it
 * carries a reason saying which of the two shapes it is.
 */
export type UsColdHoldingsOutcome =
  | { status: "present"; rows: UsHoldingRow[] }
  | {
      status: "empty";
      /** `COLD_SHARD_EMPTY` or `COLD_SHARD_UNPARSEABLE`. */
      reason: string;
      /** Non-blank JSONL lines the shard held before per-line validation. */
      lines: number;
    }
  | { status: "absent" }
  | { status: "failed"; error: unknown };

/** Raised when a cold read could not be completed. Never cached. */
export class UsColdStoreUnavailableError extends Error {
  readonly key: string;
  constructor(key: string, cause?: unknown) {
    super(`us cold store unavailable for ${key}`);
    this.name = "UsColdStoreUnavailableError";
    this.key = key;
    if (cause !== undefined) this.cause = cause;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Codec — gz-JSONL, one holding per line
   ──────────────────────────────────────────────────────────────────────── */

/**
 * One JSONL line, keyed by the PRISMA FIELD NAMES.
 *
 * Not the candle codec's short keys (`s`, `x`, `tf`, …). That compression is
 * worth its opacity at 200M candle rows across 231,825 shards; a 13F shard is a
 * few thousand rows and the schema is the stated contract with the Python
 * writer ("the Python writers emit these exact field names"). A second,
 * undocumented naming convention between two languages is how a field silently
 * stops being written.
 *
 * Dates are ISO-8601 strings. Deliberately SELF-DESCRIBING — `managerCik10` and
 * `periodOfReport` are already in the object key and are stored again anyway,
 * because an archived object that cannot be identified from its own bytes is an
 * unidentifiable blob (MONEY-1204): `gsutil cat … | gunzip | head -1` must
 * produce a complete, unambiguous holding.
 */
interface ColdHoldingLine {
  accession?: unknown;
  rowIndex?: unknown;
  managerCik10?: unknown;
  managerName?: unknown;
  periodOfReport?: unknown;
  filedAt?: unknown;
  cusip?: unknown;
  figi?: unknown;
  issuerName?: unknown;
  titleOfClass?: unknown;
  valueUsd?: unknown;
  shares?: unknown;
  sharesType?: unknown;
  putCall?: unknown;
  symbol?: unknown;
}

/**
 * A number, or `null`. NOT `Number(x)` — `Number(null)`, `Number("")`,
 * `Number([])` and `Number(false)` are all **0**, so the naive coercion turns a
 * shard line that omitted `valueUsd` into a holding worth zero dollars instead
 * of a line that is dropped as unparseable.
 */
function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d =
    value instanceof Date
      ? value
      : new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Rows → the shard's uncompressed text, one JSON object per line. */
export function serializeThirteenFShard(rows: readonly UsHoldingRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        accession: r.accession,
        rowIndex: r.rowIndex,
        managerCik10: r.managerCik10,
        managerName: r.managerName,
        periodOfReport: r.periodOfReport.toISOString(),
        filedAt: r.filedAt.toISOString(),
        cusip: r.cusip,
        figi: r.figi,
        issuerName: r.issuerName,
        titleOfClass: r.titleOfClass,
        valueUsd: r.valueUsd,
        shares: r.shares,
        sharesType: r.sharesType,
        putCall: r.putCall,
        symbol: r.symbol,
      }),
    )
    .join("\n");
}

/**
 * Shard text → rows.
 *
 * Tolerant PER LINE and strict about nothing else: one corrupt line is dropped
 * rather than thrown on, for the same reason `parseColdShard` drops a bad
 * candle — one damaged line must not cost a whole manager-quarter. A line with
 * no `cusip`, no parseable `periodOfReport` or a non-finite `valueUsd`/`shares`
 * is not a holding, and a `NaN` position is exactly the poison this codebase
 * has chased through five subsystems.
 */
export function parseThirteenFShard(text: string): UsHoldingRow[] {
  const out: UsHoldingRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let raw: ColdHoldingLine;
    try {
      raw = JSON.parse(trimmed) as ColdHoldingLine;
    } catch {
      continue;
    }
    const cusip = str(raw.cusip);
    const accession = str(raw.accession);
    const managerCik10 = str(raw.managerCik10);
    const periodOfReport = dateOrNull(raw.periodOfReport);
    const filedAt = dateOrNull(raw.filedAt);
    const valueUsd = finite(raw.valueUsd);
    const shares = finite(raw.shares);
    if (
      cusip === null ||
      accession === null ||
      managerCik10 === null ||
      periodOfReport === null ||
      filedAt === null ||
      valueUsd === null ||
      shares === null
    ) {
      continue;
    }
    out.push({
      accession,
      rowIndex: finite(raw.rowIndex) ?? 0,
      managerCik10,
      managerName: str(raw.managerName),
      periodOfReport,
      filedAt,
      cusip,
      figi: str(raw.figi),
      issuerName: str(raw.issuerName) ?? "",
      titleOfClass: str(raw.titleOfClass) ?? "",
      valueUsd,
      shares,
      sharesType: str(raw.sharesType) ?? "SH",
      putCall: str(raw.putCall),
      symbol: str(raw.symbol),
      currency: "USD",
    });
  }
  return out.sort((a, b) => b.valueUsd - a.valueUsd || a.rowIndex - b.rowIndex);
}

/** Rows → the exact bytes stored at the cold key. */
export function encodeThirteenFShard(rows: readonly UsHoldingRow[]): Buffer {
  return gzipSync(Buffer.from(serializeThirteenFShard(rows), "utf8"));
}

/**
 * Stored bytes → rows, format chosen by magic bytes rather than by key.
 *
 * Unrecognised bytes THROW with a message that says exactly what is missing.
 * The alternative — treating them as an empty quarter — is the MONEY-1189
 * shape: a completeness check that reports SUCCESS for work that never
 * happened. Absence and unreadability must never look alike.
 */
export function decodeThirteenFShard(body: Buffer): UsHoldingRow[] {
  return decodeThirteenFShardDetailed(body).rows;
}

/** Rows plus how many non-blank lines they were parsed FROM. */
export interface DecodedThirteenFShard {
  readonly rows: UsHoldingRow[];
  /**
   * Non-blank JSONL lines in the shard, counted BEFORE per-line validation.
   *
   * The difference between this and `rows.length` is the only thing that
   * separates "the evictor archived an empty quarter" from "the shard is
   * corrupt and every line was dropped". Both decode to `[]`, and treating them
   * alike is how a parse failure renders as a portfolio.
   */
  readonly lines: number;
}

export function decodeThirteenFShardDetailed(
  body: Buffer,
): DecodedThirteenFShard {
  const format: ColdShardFormat = sniffColdShardFormat(body);
  if (format === "JSONL_GZ") {
    const text = gunzipSync(body).toString("utf8");
    return {
      rows: parseThirteenFShard(text),
      lines: text.split("\n").filter((l) => l.trim() !== "").length,
    };
  }
  if (format === "PARQUET") {
    throw new Error(
      "decodeThirteenFShard: shard is parquet, but no parquet decoder is " +
        "installed. See the format note in candle-logic.ts — add a decoder " +
        "branch here; the key layout and every caller stay unchanged.",
    );
  }
  throw new Error(
    `decodeThirteenFShard: unrecognised shard format (first bytes ${body
      .subarray(0, 4)
      .toString("hex")}). Expected gzip (1f8b).`,
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   The read
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Read ONE evicted (manager, period) shard.
 *
 * NOT cached, deliberately. A cached cold shard would need the `:last-good`
 * twin `cachedWithStaleFallback` writes and an eviction entry point to match —
 * machinery whose only customer would be a read of a quarter nobody looked at
 * recently. `candle-cold-store` carries it because a chart request touches a
 * decade of shards on every page load; this one touches at most a handful, once.
 *
 * The failure contract is the whole point: a storage error surfaces as
 * `failed`, never as `absent`, and never as `[]`.
 */
export async function readThirteenFColdShard(args: {
  managerCik10: string;
  periodOfReport: Date | string;
  /** Explicit `coldPath` from `us_13f_filings`, when the writer recorded one. */
  coldPath?: string | null;
}): Promise<UsColdHoldingsOutcome> {
  const active = store;
  if (!active) return { status: "absent" };

  let key: string;
  try {
    key =
      typeof args.coldPath === "string" && args.coldPath.length > 0
        ? args.coldPath
        : buildThirteenFColdKey(args);
  } catch (error) {
    // An unbuildable key is a FAILURE to answer, not an answer.
    return { status: "failed", error };
  }

  try {
    const body = await withDeadline(active.get(key), key);
    if (body === null) return { status: "absent" };
    const decoded = decodeThirteenFShardDetailed(body);
    if (decoded.rows.length === 0) {
      // Bytes, no holdings. NOT `present`: see the note on
      // `UsColdHoldingsOutcome`. Either the evictor archived a quarter with no
      // rows (a 20-byte gzip of the empty string — it has no `if not rows`
      // guard), or every line was dropped by per-line validation. Neither is a
      // portfolio, and both used to arrive as `present` with `rows: []`, which
      // is `degraded: false` all the way to the render.
      return {
        status: "empty",
        reason:
          decoded.lines === 0
            ? US_COLD_REASON_SHARD_EMPTY
            : US_COLD_REASON_SHARD_UNPARSEABLE,
        lines: decoded.lines,
      };
    }
    return { status: "present", rows: decoded.rows };
  } catch (error) {
    return { status: "failed", error };
  }
}

/**
 * Await `work`, giving up after the configured deadline.
 *
 * The three properties it must have are copied from `candle-cold-store.ts`
 * exactly, and each one is a bug that has actually happened here:
 *
 *   - the timer is cleared on EVERY exit, or a settled race leaves a live
 *     `setTimeout` holding the event loop open for the full deadline — a
 *     delayed shutdown in a worker and an orphaned handle in a test;
 *   - the abandoned promise gets its own no-op rejection handler, or a `work`
 *     that rejects AFTER the deadline surfaces as an unhandled rejection and
 *     takes the process down over an error already reported;
 *   - attaching that handler does not consume the rejection for the `await`
 *     below, so a `work` that rejects BEFORE the deadline still propagates.
 */
function withDeadline<T>(work: Promise<T>, key: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {});
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new UsColdStoreUnavailableError(
            key,
            new Error(`timed out after ${timeoutMs}ms`),
          ),
        ),
      timeoutMs,
    );
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
