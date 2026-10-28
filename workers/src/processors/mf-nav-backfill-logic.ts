/**
 * MF NAV backfill processor — PURE helpers (no Prisma / network).
 *
 * `mf-nav-backfill.ts` resolves its params, decides when to stop, and judges the
 * run's health through the exports here, so those decisions are unit-testable
 * without booting Prisma or the MFAPI client. Mirrors `mf-metadata-sync-logic.ts`.
 *
 * @see workers/src/processors/mf-nav-backfill.ts (caller)
 */

export const DEFAULT_BATCH_SIZE = 200;
export const DEFAULT_DELAY_MS = 250;
/** Progress is logged every N schemes. */
export const PROGRESS_LOG_EVERY = 25;

/**
 * Wall-clock budget for one run, in ms.
 *
 * Pub/Sub's push `--ack-deadline` maxes out at **600 s**, and a run that cannot
 * finish inside it gets redelivered while still working — the failure mode
 * written up as STILL OPEN on `xbrl-sync` (1500 downloads x 600 ms of sleeping
 * = 900 s against a 600 s deadline). Rather than reason about average per-scheme
 * cost and hope, this job stops on the clock: whatever it has finished is
 * committed, and the next run resumes from where the selection query leaves off
 * (schemes with no history are re-selected until they have some). 420 s leaves
 * ~3 min of headroom for the in-flight scheme plus the final logging.
 */
export const DEFAULT_BUDGET_MS = 420_000;

export interface MfNavBackfillParams {
  /** Explicit schemes; empty means "use universe mode". */
  schemeCodes: string[];
  universe: boolean;
  batchSize: number;
  delayMs: number;
  force: boolean;
  budgetMs: number;
  reason: string;
}

/**
 * Resolve the job message into concrete params.
 *
 * Mode selection is explicit rather than inferred twice: a message carrying
 * `schemeCodes` runs those and ONLY those; universe mode is the default when no
 * codes are given, which is what the nightly Cloud Scheduler trigger sends
 * (`{"universe":true}`) and also what a bare `{}` should mean.
 */
export function resolveMfNavBackfillParams(data: {
  schemeCodes?: string[];
  universe?: boolean;
  batchSize?: number;
  delayMs?: number;
  force?: boolean;
  budgetMs?: number;
  reason?: string;
}): MfNavBackfillParams {
  const schemeCodes = (data.schemeCodes ?? [])
    .map((c) => String(c).trim())
    .filter((c) => c.length > 0);

  return {
    schemeCodes,
    universe: schemeCodes.length === 0 ? (data.universe ?? true) : false,
    batchSize: normalizePositive(data.batchSize, DEFAULT_BATCH_SIZE),
    delayMs: normalizeNonNegative(data.delayMs, DEFAULT_DELAY_MS),
    force: data.force ?? false,
    budgetMs: normalizePositive(data.budgetMs, DEFAULT_BUDGET_MS),
    reason: data.reason ?? "scheduler",
  };
}

function normalizePositive(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeNonNegative(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/** Sleep after every scheme except the last. */
export function shouldSleepAfterIndex(index: number, total: number): boolean {
  return index < total - 1;
}

/** Emit a progress line after the scheme at `index` (1-based step). */
export function shouldLogProgress(index: number): boolean {
  return (index + 1) % PROGRESS_LOG_EVERY === 0;
}

/** Has the run used up its wall-clock budget? */
export function isBudgetExhausted(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number,
): boolean {
  return nowMs - startedAtMs >= budgetMs;
}

// ============== AMFI vs MFAPI RECONCILE (MONEY-1404 C2) ==============

/**
 * Relative gap above which the two upstreams are said to DISAGREE.
 *
 * 0.5%. A NAV is published to 4 decimal places by both sources for the same
 * scheme on the same day, so a real agreement is exact or near enough; this is
 * wide enough to absorb a rounding difference and narrow enough that a stale
 * day, a wrong scheme code or a units error cannot hide under it.
 *
 * MEASURED before it was chosen: 400 schemes sampled on prod 2026-09-13, every
 * one of which had an `MfNavHistory` row on its master's `navDate` — 400
 * compared, **0** disagreements at this tolerance. So the alarm starts silent,
 * which is the only state from which a first alert means something.
 */
export const MF_NAV_DISAGREEMENT_TOLERANCE = 0.005;

export type MfNavReconcileVerdict =
  | "no-master-nav"
  | "no-history-row"
  | "agree"
  | "disagree";

export interface MfNavReconcileResult {
  verdict: MfNavReconcileVerdict;
  /** Relative gap (0-1) when both sides had a value, else null. */
  drift: number | null;
}

/**
 * EACH SIDE IS DECODED WITH THE CONVENTION IT WAS ENCODED WITH.
 *
 * The two dates denote the same thing — a calendar day — and are built by
 * different arithmetic:
 *
 *   AMFI   `new Date(y, m-1, d)`                     LOCAL midnight
 *          (`amfi-mf-provider.ts`, which says so, and deliberately keeps it)
 *   MFAPI  `new Date("YYYY-MM-DDT00:00:00.000Z")`    UTC midnight
 *          (`mf-nav-service.ts`)
 *
 * On Cloud Run those are the SAME INSTANT, because the container runs in UTC —
 * which is exactly why this is dangerous rather than merely fiddly: any rule
 * works in the only environment that runs the job, and a wrong one is invisible
 * there. On a laptop in IST, local midnight of the 12th is `2026-09-11T18:30Z`
 * — a day EARLIER in UTC, so both instant-equality AND a naive shared UTC key
 * find nothing and report `compared: 0`. A reconcile that compares nothing
 * agrees with everything, forever.
 *
 * So: read the local-built date with local parts, the UTC-built one with UTC
 * parts, and both answer "2026-09-12" in every zone the writer and reader
 * share — which in production is one zone, UTC.
 */
function amfiDayKey(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function mfapiDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Does MFAPI's history agree with AMFI's master NAV on the master's own date?
 *
 * `MutualFundMaster.nav` is AMFI's (written by `mf-sync`); `MfNavHistory.nav`
 * is MFAPI.in's (written by this job). Same quantity, two vendors, and until
 * now NEVER compared — so either could have drifted, or stopped, and the only
 * symptom would have been a chart that disagreed with the number above it.
 *
 * A missing master NAV or a history with no row on that date are NOT
 * disagreements. They are the reasons a comparison could not be made, and they
 * are named so `compared` stays an honest denominator: this job's universe mode
 * deliberately selects schemes with no stored history, so early runs legitimately
 * compare very little.
 */
/**
 * How many stored schemes the standing reconcile checks per run — MONEY-1405.
 *
 * Small on purpose: this is two indexed reads over a rotating slice, and its
 * value is CONTINUITY rather than coverage. A sample that walks the universe
 * a page a night answers "do our two NAV sources still agree" forever; a full
 * sweep answers it once and costs a whole run's budget.
 */
export const MF_NAV_RECONCILE_SAMPLE = 400;

/**
 * The rotating slice of a sorted population for a given day.
 *
 * A reconcile with no rotation re-checks the same head for ever — the
 * MONEY-1211 shape, and the reason this is a function rather than a `slice(0,
 * n)` at the call site. Derived from the DAY rather than from a stored marker
 * because the population is a query result, not a table this job may stamp:
 * there is no row to write a cursor onto, and inventing one would mean writing
 * to `mf_nav_history` for bookkeeping.
 *
 * Wraps, so the slice is always `size` long until the population is smaller
 * than that.
 */
export function rotatingSlice<T>(
  sorted: readonly T[],
  size: number,
  dayIndex: number,
): T[] {
  if (sorted.length === 0 || size <= 0) return [];
  if (sorted.length <= size) return [...sorted];
  // A NEGATIVE index needs no correction. `x % n` is always in (-n, n), and
  // `Array.slice` reads a negative start as an offset from the END — which is
  // the same rotation. A `((x % n) + n) % n` guard was written here, mutation-
  // tested, found unkillable for every input, and removed rather than kept as
  // arithmetic that reads like a boundary fix and cannot change an answer.
  const start = (dayIndex * size) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, size);
}

/** Whole days since the epoch — the rotation index. */
export function dayIndex(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

export function reconcileSchemeNav(
  master: { nav: number | null; navDate: Date | null } | undefined,
  points: ReadonlyArray<{ date: Date; nav: number }>,
): MfNavReconcileResult {
  if (!master || master.nav === null || master.navDate === null) {
    return { verdict: "no-master-nav", drift: null };
  }
  // A zero or negative master NAV is not a NAV; dividing by it would emit
  // Infinity into a counter that is supposed to mean "how far apart".
  if (!Number.isFinite(master.nav) || master.nav <= 0) {
    return { verdict: "no-master-nav", drift: null };
  }

  const key = amfiDayKey(master.navDate);
  const match = points.find((p) => mfapiDayKey(p.date) === key);
  if (!match) return { verdict: "no-history-row", drift: null };

  const drift = Math.abs(master.nav - match.nav) / master.nav;
  return {
    verdict: drift > MF_NAV_DISAGREEMENT_TOLERANCE ? "disagree" : "agree",
    drift,
  };
}

// ============== RUN HEALTH (MONEY-1189 class) ==============

export interface MfNavBackfillTally {
  /** Schemes this run tried to backfill. */
  selected: number;
  /** Schemes where >= 1 row was written. */
  succeeded: number;
  /** Schemes where the upstream returned nothing usable (a real answer). */
  empty: number;
  /** Schemes where the fetch or write errored. */
  failed: number;
  /** Schemes already fully covered — nothing left to insert. */
  alreadyComplete: number;
  /** Rows written across the run. */
  inserted: number;
  /** True when the wall-clock budget cut the run short. */
  budgetExhausted: boolean;
  /** Schemes where AMFI's master NAV and MFAPI's history could be compared. */
  navCompared: number;
  /** Of those, how many differed by more than the tolerance. */
  navDisagreements: number;
}

export type MfNavBackfillHealthReason =
  | "ok"
  | "nothing-to-do"
  | "all-failed"
  | "no-rows-written"
  | "budget-starved";

export interface MfNavBackfillHealth {
  ok: boolean;
  level: "info" | "error";
  reason: MfNavBackfillHealthReason;
  message: string;
}

/**
 * Judge whether a completed run is evidence the pipeline works.
 *
 * Same discipline as `judgeMfMetadataHealth`: selecting work and writing
 * nothing is a failure, not a log line. The distinction that matters here is
 * between an upstream that ERRORED for everything (`all-failed` — retry is
 * worth it) and one that ANSWERED for everything but had nothing new
 * (`alreadyComplete`, which is the healthy steady state once the universe is
 * seeded and must never be an error).
 */
export function judgeMfNavBackfillHealth(
  tally: MfNavBackfillTally,
): MfNavBackfillHealth {
  const {
    selected,
    succeeded,
    failed,
    alreadyComplete,
    empty,
    inserted,
    budgetExhausted,
  } = tally;

  // THE BUDGET IS PART OF THE VERDICT — MONEY-1238.
  //
  // `budgetExhausted` was computed, logged, and read by nothing. It has to be
  // judged BEFORE `selected === 0`, because the processor sets
  // `tally.selected = i` when the budget cuts the loop — so a run whose budget
  // expired before the FIRST scheme reports `selected: 0` and falls into the
  // rung below, which answers "No schemes were missing NAV history."
  //
  // That is the worst possible reading: schemes WERE selected and DO need
  // backfill, none were touched, and the run announces the universe is
  // complete. Worse, it is self-perpetuating — if the selection query alone
  // exhausts the budget, every subsequent run does exactly the same thing and
  // the backfill never advances again, while every run reports success.
  //
  // Truncation WITH progress is a different thing and stays healthy: it is the
  // designed behaviour for a job bounded by Pub/Sub's 600s ack deadline (which
  // is Pub/Sub's maximum and cannot be raised), and the next run resumes.
  if (budgetExhausted && selected === 0) {
    return {
      ok: false,
      level: "error",
      reason: "budget-starved",
      message:
        `The wall-clock budget expired before a single scheme was processed, ` +
        `so this run made NO progress and the next one will repeat it ` +
        `identically. Schemes were selected — this is not an empty universe.`,
    };
  }

  if (selected === 0) {
    return {
      ok: true,
      level: "info",
      reason: "nothing-to-do",
      message: "No schemes were missing NAV history.",
    };
  }

  if (failed === selected) {
    return {
      ok: false,
      level: "error",
      reason: "all-failed",
      message:
        `All ${selected} schemes failed to backfill. MFAPI.in is unreachable, ` +
        `rate-limiting, or has changed shape.`,
    };
  }

  // Everything the upstream answered was either already stored or genuinely
  // empty. That is a real, healthy outcome — do not manufacture an error.
  if (succeeded === 0 && alreadyComplete + empty === selected - failed) {
    return {
      ok: true,
      level: "info",
      reason: "nothing-to-do",
      message:
        `No new rows: ${alreadyComplete} already complete, ${empty} with no ` +
        `upstream history, ${failed} failed.`,
    };
  }

  if (inserted === 0) {
    return {
      ok: false,
      level: "error",
      reason: "no-rows-written",
      message:
        `Selected ${selected} schemes and wrote ZERO rows ` +
        `(succeeded=${succeeded} failed=${failed} empty=${empty} ` +
        `alreadyComplete=${alreadyComplete}).`,
    };
  }

  return {
    ok: true,
    level: "info",
    reason: "ok",
    message:
      `Wrote ${inserted} NAV rows across ${succeeded}/${selected} schemes.` +
      (budgetExhausted
        ? ` TRUNCATED by the wall-clock budget — work remains, re-run to continue.`
        : ``),
  };
}
