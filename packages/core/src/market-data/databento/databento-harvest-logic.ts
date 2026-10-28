/**
 * The harvest's DECISIONS — MONEY-1373. Pure: no Prisma, no vendor, no clock.
 *
 * The job script does I/O and calls every export here, so the production path
 * and the tests run the same code. What is decided here is everything that can
 * be got wrong without failing: which chunks still need buying, which files a
 * sharded task owns, when a download window is about to close, and whether the
 * coverage of what landed matches the calendar.
 */

import { expectedSessions } from "./databento-logic";

/* ─────────────────────────────────────────────────────────────────────────
   Arming
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Is the write arm on?
 *
 * Compared against the LITERAL string, never `Boolean()`: `Boolean("false")` is
 * `true`, which would arm the job in the one configuration meant to keep it
 * off. Read PER CALL, never a module-scope const — a module-level read freezes
 * at import, and on a warm Cloud Run container that turns a redeployed switch
 * into no switch at all.
 */
export function isHarvestArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["DATABENTO_HARVEST_APPLY"] === "true";
}

export function isAppendArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["DATABENTO_APPEND_APPLY"] === "true";
}

export interface ApplyDecision {
  /** Will this run actually spend and write? */
  apply: boolean;
  /** Printed when `--apply` was asked for and refused. */
  armMissing: boolean;
}

/**
 * `--apply` ASKS; the environment ARMS. Both are required.
 *
 * A flag on the command line cannot arm a spend on its own — arming is a
 * deploy. And an armed environment does nothing without the flag, so a
 * scheduled dry run stays dry. When `--apply` is passed without the arm the run
 * continues AS A DRY RUN and says so loudly, rather than exiting: the operator
 * still gets the quote report they were going to get, which is the useful half.
 */
export function resolveApply(
  applyFlag: boolean,
  armed: boolean,
): ApplyDecision {
  if (!applyFlag) return { apply: false, armMissing: false };
  if (!armed) return { apply: false, armMissing: true };
  return { apply: true, armMissing: false };
}

/* ─────────────────────────────────────────────────────────────────────────
   The probe's two money guards
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The hard ceiling on what the entitlement probe may cost.
 *
 * Five cents. A one-symbol-day of `ohlcv-1m` is ~390 bars; an included window
 * quotes $0.00 and a metered one is fractions of a cent. Anything above this
 * means the request is not what it looks like — a mis-parsed range, the wrong
 * schema, a symbol list that resolved to everything.
 */
export const PROBE_MAX_USD = 0.05;

/**
 * Is this quote too expensive to probe?
 *
 * A FUNCTION, not an inline comparison, because the deploy contract could only
 * assert that the string `PROBE_MAX_USD` appeared in the probe. Widening the
 * comparison to `quoteUsd > PROBE_MAX_USD * 1000` passed the entire suite —
 * measured. The two guards below are the only things between a wrapper and an
 * unattended purchase, so they are decisions with their own tests rather than
 * text a regex can find.
 */
export function quoteExceedsProbeCap(
  quoteUsd: number,
  capUsd: number = PROBE_MAX_USD,
): boolean {
  // A non-finite quote is REFUSED, not compared. `NaN > cap` is false, so a
  // bare comparison would treat an unreadable quote as affordable.
  if (!Number.isFinite(quoteUsd)) return true;
  return quoteUsd > capUsd;
}

/**
 * May the probe spend, given the terminal it is attached to?
 *
 * Only from a TTY. There is deliberately no `--yes`: a prompt a wrapper can
 * answer is not a safeguard, and `run-market-data-job.sh` is exactly such a
 * wrapper. Inverting the original inline test — so the probe would spend when
 * NOT attached to a terminal — also passed the whole suite.
 */
export function mayPromptForSpend(isTty: boolean | undefined): boolean {
  return isTty === true;
}

/* ─────────────────────────────────────────────────────────────────────────
   Concurrency
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The default number of archive downloads in flight.
 *
 * MEASURED on the first real harvest: a download averages ~1.5 s, essentially
 * all of it waiting on the vendor and on GCS — the process is idle throughout.
 * Serially that is 23.4 h for `ohlcv-1h-master`'s file count, which does not
 * fit inside the job's own 24 h task cap, so the step could not finish however
 * long it was left alone.
 *
 * EIGHT rather than "as many as there are files": every slot holds one
 * `fetch` body piped into one resumable GCS upload, and the GCS client buffers
 * a chunk per upload for retry. Eight is ~150-250 MB of buffers against a 4Gi
 * container, and it keeps us far enough under the vendor's rate limit that the
 * client's 429 ladder stays a safety net rather than the pacing mechanism.
 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 8;

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * A THIRD COPY, deliberately. `packages/services/src/concurrency-logic.ts` and
 * `market-data/tiingo/tiingo-rt-read.ts` each hold one, and neither is
 * reachable from here: `@usemoney/services` is not a dependency of core (the
 * arrow points the other way), and the Tiingo copy is module-private. Merging
 * the three is a real cleanup and a bigger diff than this whole change; it is
 * noted here so whoever does it can find all three.
 *
 * Results come back in INPUT order. Does NOT catch — a rejecting task rejects
 * the whole call, so a caller that needs per-item isolation (the download step
 * does: one bad file must not abandon the other 56,219) catches inside its own
 * task.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  // Below 1 would stall forever rather than degrade, which reads as a hung
  // download rather than as a bad flag.
  //
  // NON-FINITE IS THE WORSE HALF, and `Math.max(1, …)` does not cover it:
  // `Math.floor(NaN)` is `NaN`, `Math.max(1, NaN)` is `NaN`, and
  // `Array.from({length: NaN})` is `[]` — so `Promise.all([])` resolves
  // IMMEDIATELY having spawned no workers, and the call returns `items.length`
  // HOLES. Every file silently skipped, no error, and the step reporting
  // success: the MONEY-1255 shape at the scale of a whole harvest. `Infinity`
  // clamps here too — an unbounded pool is what the bound exists to prevent,
  // and every real caller passes a validated positive int.
  const width = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, () => worker()),
  );
  return results;
}

/**
 * One in-flight call per key, however many callers miss at once.
 *
 * A cache that stores the RESOLVED value only fills AFTER the first await, so
 * under the download step's 8-wide `mapWithConcurrency` pool the first 8 tasks
 * all see a miss and all reach the vendor — 8 `batch.list_files` calls for one
 * job, every one of them metered and identical. Storing the PROMISE before
 * awaiting it collapses them into one; the other 7 await the same call.
 *
 * A REJECTION IS EVICTED. A cached rejected promise is permanent: every later
 * caller would await the same failure, so one transient 5xx would wedge the
 * job for the rest of its 24 h task with nothing to retry through. Deleting
 * the key on rejection makes the next call a fresh attempt — the client's own
 * 429/5xx ladder runs inside `fetch`, below this.
 */
export function memoisedListFiles<T>(
  cache: Map<string, Promise<T[]>>,
  key: string,
  fetch: (key: string) => Promise<T[]>,
): Promise<T[]> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const inflight = fetch(key).catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, inflight);
  return inflight;
}

/* ─────────────────────────────────────────────────────────────────────────
   Sharding
   ──────────────────────────────────────────────────────────────────────── */

export interface ShardSpec {
  index: number;
  count: number;
}

/**
 * Resolve `--shard=i/n`, or Cloud Run's own task variables.
 *
 * Cloud Run sets `CLOUD_RUN_TASK_INDEX` (0-based) and `CLOUD_RUN_TASK_COUNT` on
 * EVERY task of a multi-task execution, so a job provisioned with `--tasks=4`
 * shards itself with no flag at all. An explicit flag wins, for a local run.
 *
 * `null` means UNSHARDED, which is one task rather than an error — an execution
 * reading `CLOUD_RUN_TASK_COUNT=1` is not sharded.
 */
export function resolveShard(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ShardSpec | null {
  if (flag !== undefined && flag.trim() !== "") {
    const m = /^(\d+)\/(\d+)$/.exec(flag.trim());
    if (!m) {
      throw new RangeError(`resolveShard: "${flag}" is not of the form i/n`);
    }
    return check(Number(m[1]), Number(m[2]));
  }

  const rawCount = env["CLOUD_RUN_TASK_COUNT"];
  if (rawCount === undefined || rawCount.trim() === "") return null;
  if (!/^\d+$/.test(rawCount.trim())) {
    throw new RangeError(
      `resolveShard: CLOUD_RUN_TASK_COUNT="${rawCount}" is not an integer`,
    );
  }
  const count = Number(rawCount.trim());
  if (count === 1) return null;

  // The two variables are read SEPARATELY rather than joined into "i/n",
  // because the failure they guard against is asymmetric. An absent index
  // beside a count above 1 must THROW: defaulting it to 0 would have every
  // task of the execution claim shard 0, so all N tasks would load the same
  // files and the other N-1 shares would never load at all — at N times the
  // cost, with counters that look entirely plausible.
  const rawIndex = env["CLOUD_RUN_TASK_INDEX"];
  if (rawIndex === undefined || !/^\d+$/.test(rawIndex.trim())) {
    throw new RangeError(
      `resolveShard: CLOUD_RUN_TASK_COUNT=${count} but ` +
        `CLOUD_RUN_TASK_INDEX=${JSON.stringify(rawIndex)}. Refusing to assume ` +
        "task 0 — every task would then claim the same shard, load the same " +
        "files, and leave the rest unloaded.",
    );
  }
  return check(Number(rawIndex.trim()), count);
}

function check(index: number, count: number): ShardSpec | null {
  if (count < 1)
    throw new RangeError(`resolveShard: count ${count} is below 1`);
  if (index >= count) {
    throw new RangeError(
      `resolveShard: index ${index} is out of range for ${count} task(s)`,
    );
  }
  return count === 1 ? null : { index, count };
}

/**
 * Does this shard own `name`?
 *
 * A stable hash of the FILENAME, so the partition is identical on every task
 * and on every re-run — two tasks must never both load one file, and no file
 * may be owned by nobody. FNV-1a, the same one the manifest hash uses.
 */
export function shardOwns(name: string, shard: ShardSpec | null): boolean {
  if (shard === null) return true;
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shard.count === shard.index;
}

/* ─────────────────────────────────────────────────────────────────────────
   Expiry
   ──────────────────────────────────────────────────────────────────────── */

/**
 * How close to expiry is too close.
 *
 * Batch files expire 30 days after SUBMISSION — not after completion, which is
 * the reading that would leave a job with less time than it appears to have. A
 * job whose files are not all downloaded within two days of that deadline is
 * reported at ERROR level, because after it passes the only remedy is to BUY
 * THE WINDOW AGAIN, and by then the Standard subscription is likely cancelled.
 */
export const EXPIRY_WARNING_DAYS = 2;

export function isExpiringSoon(
  tsExpiration: Date | null,
  now: Date,
  days: number = EXPIRY_WARNING_DAYS,
): boolean {
  if (tsExpiration === null) return false;
  return tsExpiration.getTime() - now.getTime() < days * 86_400_000;
}

/* ─────────────────────────────────────────────────────────────────────────
   Coverage
   ──────────────────────────────────────────────────────────────────────── */

export interface CoverageInput {
  symbol: string;
  /** ET session dates that produced at least one bar. */
  sessionsPresent: readonly string[];
  fromDateKey: string;
  toDateKey: string;
}

export interface CoverageReport {
  symbol: string;
  expected: number;
  present: number;
  missingCount: number;
  /**
   * WHICH sessions are missing, or `null` when they were not enumerated.
   *
   * `null` and `[]` are different answers and must not be one value. `[]` says
   * nothing is missing; `null` says we counted rather than listed, which is
   * what the MASTER-scale pass does — 14,000 symbols x ~800 sessions of date
   * strings is ~90 MB of arrays through a 16 MB BSON ceiling, so the first pass
   * counts and only the shortfalls are enumerated. A single `string[]` would
   * have made "we did not ask" render as "nothing is missing", which is the
   * absent-vs-empty confusion this repo has paid for repeatedly (MONEY-1050,
   * MONEY-1234, MONEY-1235).
   */
  missing: string[] | null;
  /** 0..1. `expected === 0` yields `null`, never 1 — see below. */
  ratio: number | null;
}

function ratioOf(expected: number, present: number): number | null {
  // `null`, never 1, when nothing was expected. "Complete" and "there was
  // nothing to be complete about" are different answers, and a run that
  // reported 100% for an empty range would look like its best night.
  return expected === 0 ? null : present / expected;
}

/**
 * What SHOULD be there against what is, with the gaps NAMED.
 *
 * The denominator comes from the US market calendar rather than from the data.
 * A completeness check whose denominator is derived from what arrived can only
 * ever report 100% — the wrong-granularity class this repo has met five times
 * (MONEY-1189), and the reason `expectedSessions` refuses a year the holiday
 * table has no opinion about rather than counting closures as gaps.
 */
export function computeCoverage(input: CoverageInput): CoverageReport {
  const expected = expectedSessions(input.fromDateKey, input.toDateKey);
  const present = new Set(input.sessionsPresent);
  const missing = expected.filter((d) => !present.has(d));
  const got = expected.length - missing.length;
  return {
    symbol: input.symbol,
    expected: expected.length,
    present: got,
    missingCount: missing.length,
    missing,
    ratio: ratioOf(expected.length, got),
  };
}

/**
 * The same verdict from a COUNT, for the pass that cannot afford the lists.
 *
 * `present` is a DISTINCT-session count from the aggregation, so it can never
 * exceed `expected` unless the calendar and the data disagree about what a
 * session is — which is worth seeing rather than clamping away, so
 * `missingCount` floors at 0 while `present` is reported raw.
 */
export function coverageFromCount(args: {
  symbol: string;
  present: number;
  fromDateKey: string;
  toDateKey: string;
}): CoverageReport {
  const expected = expectedSessions(args.fromDateKey, args.toDateKey).length;
  return {
    symbol: args.symbol,
    expected,
    present: args.present,
    missingCount: Math.max(0, expected - args.present),
    missing: null,
    ratio: ratioOf(expected, Math.min(args.present, expected)),
  };
}

/**
 * The worst offenders, for the job-outcome line.
 *
 * Sorted by MISSING COUNT rather than by ratio: a symbol missing 200 of 800
 * sessions is a bigger problem than one missing 2 of 3, even though the second
 * has the worse ratio, and an operator has a fixed amount of attention.
 */
export function worstCoverage(
  reports: readonly CoverageReport[],
  limit = 10,
): CoverageReport[] {
  return [...reports]
    .filter((r) => r.missingCount > 0)
    .sort(
      (a, b) =>
        b.missingCount - a.missingCount || (a.symbol < b.symbol ? -1 : 1),
    )
    .slice(0, limit);
}

/* ─────────────────────────────────────────────────────────────────────────
   The plan
   ──────────────────────────────────────────────────────────────────────── */

/** What the inventory already knows about one window. */
export interface InventoryState {
  state: string;
  jobId: string | null;
  /** Files recorded on the row, if any. */
  filesTotal: number;
  filesVerified: number;
  loadedAt: Date | null;
}

export type ChunkAction =
  | "quote"
  | "poll"
  | "download"
  | "load"
  | "coverage"
  | "done"
  | "expired";

/**
 * What a chunk needs NEXT, given what the inventory says about it.
 *
 * THE STATE TABLE, not the gate — and the difference matters because the
 * docstring here claimed to be the gate and was not called by anything. Each
 * harvest step selects its own rows with its own `where`, and this function is
 * what those queries are DERIVED from and what pins them in the tests.
 *
 * It earned its keep anyway: it returns `"quote"` for a `QUOTED` row, which is
 * the correct answer, while `withDatabentoBudget` treated that row as a
 * completed purchase and no step selected it at all. The disagreement between
 * this table and the guard was the bug, and the guard is the half that moved.
 *
 * Wiring the steps through it is a real refactor and belongs in its own change;
 * what must NOT happen again is a comment here asserting a gate that is not
 * wired.
 */
export function nextActionFor(
  state: InventoryState | null,
  loadable: boolean,
): ChunkAction {
  if (state === null) return "quote";
  switch (state.state) {
    case "QUOTED":
      // A row created but never submitted: the previous run died between the
      // two writes. It is NOT a purchase, so it is re-quoted rather than
      // polled.
      return "quote";
    case "SUBMITTED":
    case "PROCESSING":
      return "poll";
    case "DONE":
      return state.filesTotal > 0 && state.filesVerified >= state.filesTotal
        ? loadable
          ? "load"
          : "coverage"
        : "download";
    case "DOWNLOADED":
      return loadable ? "load" : "done";
    case "LOADED":
      return "done";
    case "EXPIRED":
      return "expired";
    case "FAILED":
      return "quote";
    default:
      // An unrecognised state is re-quoted rather than assumed complete. The
      // idempotent lookup in the budget guard is what stops that becoming a
      // second purchase.
      return "quote";
  }
}

/** Does this action need the vendor, i.e. can it run at all in a dry run? */
export function actionSpendsOrFetches(action: ChunkAction): boolean {
  return action === "quote" || action === "poll" || action === "download";
}
