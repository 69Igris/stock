/**
 * Nightly XBRL → `StockFinancials` projection — MONEY-1220.
 *
 * ## Why this file exists at all
 *
 * MONEY-1115 built `processXbrlProjectionWrite` and every piece around it, then
 * shipped with `apply` defaulting to `false` and **no route, no topic, no
 * scheduler and no Cloud Run job**. The activation was gated on the F3
 * reconcile and was never itself scoped as a deliverable, so the engine sat on
 * `release` writing nothing while `stock_financials` stayed frozen at the March
 * Tickertape snapshot. "Merged" was mistaken for "live" for a release. This is
 * the wiring.
 *
 * ## The arm is an ENV VAR, and the message can only narrow it
 *
 * `apply` resolves as `msg.apply ?? env`. A message may turn the write OFF for
 * a single run (an operator dry-running a shape change) but **cannot turn it
 * on** when the environment has not been armed. The inverse — `msg.apply ||
 * env` — would let anyone with publish rights on the topic start overwriting a
 * table whose unique key has no `source`, i.e. the one place where a bad write
 * destroys the value it replaced. The env flip is a deploy, which is a review.
 *
 * ## Stale-first, or the batch never advances
 *
 * Selection takes only filings this job has not yet DECIDED about
 * (`UNPROJECTED_FILING_WHERE`) and orders them `[symbol asc, periodEnd desc]`,
 * so a page can only ever be cut inside one symbol. Deciding a filing stamps
 * `projectedAt`, which removes it from the next run's population — that stamp,
 * not the ordering, is what makes the batch advance. (This paragraph used to
 * claim selection ordered by `projectedAt` ASC. It never did, and describing a
 * cursor that does not exist is how the real one went unexamined while it
 * matched nothing at all — MONEY-1234.)
 *
 * MONEY-1211 is the cautionary tale: that job ordered by a column that was
 * constant across the whole population, so every run received the same 100 rows
 * forever, wrote them once, then skipped them nightly while the rest were never
 * selected. No error, no alert, no data.
 *
 * A filing whose write FAILED keeps its null stamp so the next run retries it.
 * One that was refused by `mayOverwriteFinancials` IS stamped — the refusal is
 * a decision, not a transient, and re-reading it every night forever would
 * starve the queue behind it.
 */

import { prisma } from "@usemoney/database";
import {
  processXbrlProjectionWrite,
  countWithheldWrites,
  describeNoWriteReason,
  summariseWriteDoors,
  UNPROJECTED_FILING_WHERE,
} from "./xbrl-projection-writer";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";

/** Filings per run. Pure DB + arithmetic, but the ack deadline is 600s. */
export const DEFAULT_PROJECTION_LIMIT = 500;

export interface XbrlProjectionMessage {
  /** Narrows only. Cannot arm a run the environment has not armed. */
  apply?: boolean;
  limit?: number;
  symbols?: string[];
  /**
   * Restrict the run to one projection bucket. Default: both.
   *
   * Was declared here and read by nothing at all — not forwarded by the route,
   * not passed to the writer, not a writer option. A payload asking for
   * QUARTERLY got a silent full-universe run instead (MONEY-1235).
   */
  periodTypes?: Array<"ANNUAL" | "QUARTERLY">;
  /**
   * Also write periods that have NO incumbent row. Defaults to false, and that
   * default is not changing here.
   *
   * Unlike `apply` this is not an arming switch and does not need to narrow: it
   * cannot cause a write on its own, because every write still requires the
   * environment-held `apply`. What it fixes is that the interlock had no OFF
   * ramp — the writer's header calls coverage gain "a separate, opt-in step"
   * and there was no way to opt in, so `createMissing` was false in every
   * production run that has ever executed.
   *
   * That is not a small default. `stock_financials` holds 0 QUARTERLY rows, so
   * every one of prod's 71,450 quarterly filings projects to a CREATE, and
   * every CREATE was suppressed: the Quarterly tab could never fill, however
   * long the job ran (MONEY-1235).
   *
   * Turn it on deliberately, scoped (`symbols` + a small `limit`), and check
   * the created rows against the filings by hand before any full run — a create
   * is a row the reconcile never compared, which is the risk the interlock was
   * built for and which is still real.
   */
  createMissing?: boolean;
}

export interface XbrlProjectionResult {
  ok: boolean;
  applied: boolean;
  selected: number;
  written: number;
  /**
   * Writes this run deliberately withheld — see `countWithheldWrites`.
   *
   * Was `result.skippedAuthority` alone, which is structurally ~0: AUTHORITY is
   * one of four skip reasons and the writer's own comment says it "cannot
   * happen while NSE_XBRL leads FINANCIALS_AUTHORITY". The doors that actually
   * close are the standalone guard (29.5% of winner periods), the create
   * suppression (EVERY quarterly write under the nightly payload) and the scale
   * quarantine, and none of the three reached this number (MONEY-1238).
   */
  blocked: number;
  failed: number;
  /** Filings whose `projectedAt` cursor this run advanced. See below. */
  stamped: number;
}

/**
 * True when the environment has armed the write.
 *
 * Compared against the literal `"true"`, never `Boolean(value)`: an env var set
 * to `"false"` is a non-empty string and would arm the job under a truthiness
 * check — the same silent-inversion class as MONEY-1214's absent
 * `MF_METADATA_PROVIDER`, where a job ran cleanly for months writing nothing.
 */
export function isProjectionArmed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.XBRL_PROJECTION_APPLY === "true";
}

/** `msg.apply` narrows; only the env can arm. See the file header. */
export function resolveApply(
  msg: XbrlProjectionMessage | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const armed = isProjectionArmed(env);
  if (msg?.apply === false) return false;
  return armed;
}

/**
 * Injectable seam — MONEY-1238, and the same shape the sibling `xbrl-ratios`
 * job already carries (`deps: { prisma?, now? }`).
 *
 * It exists so the OUTCOME LINE can be tested. Without it this function reaches
 * the real Prisma client and the real `process.env`, so the one thing this job
 * is for — reporting what a run did — was assertable only in production. Note
 * what is NOT here: there is no way to pass `apply`. `env` still has to say
 * `"true"`, so an injected env can no more arm a run than a message can.
 */
export interface XbrlProjectionDeps {
  prisma?: typeof prisma;
  /** Injectable clock, so `projectedAt` / `displacedAt` are deterministic. */
  now?: Date;
  /** Read by `resolveApply`. Cannot arm anything `process.env` would not. */
  env?: NodeJS.ProcessEnv;
}

export async function processXbrlProjection(
  msg?: XbrlProjectionMessage,
  deps: XbrlProjectionDeps = {},
): Promise<XbrlProjectionResult> {
  const apply = resolveApply(msg, deps.env);
  const limit = Math.max(
    1,
    Math.min(5000, msg?.limit ?? DEFAULT_PROJECTION_LIMIT),
  );

  console.log(
    `[xbrl-projection] Starting (apply=${apply}, limit=${limit}` +
      `${msg?.symbols?.length ? `, symbols=${msg.symbols.length}` : ""})`,
  );

  const result = await processXbrlProjectionWrite(
    {
      apply,
      limit,
      symbols: msg?.symbols,
      periodTypes: msg?.periodTypes,
      createMissing: msg?.createMissing === true,
      // The cursor. Without it this job re-reads the same first `limit` filings
      // every night forever — see the option's own comment in the writer.
      unprojectedOnly: true,
      ...(deps.now ? { now: deps.now } : {}),
    },
    { prisma: deps.prisma },
  );

  // Mapped from the writer's own vocabulary rather than invented here, so a
  // rename over there is a type error, not a silently-zero metric.
  const selected = result.filingsRead;
  const written = result.created + result.updated;
  const blocked = countWithheldWrites(result);
  const failed = result.failed;
  const stamped = result.stamped;

  // ── The measurements, on EVERY branch ────────────────────────────────────
  //
  // MONEY-1238. This used to be reachable only through `describeNoWriteReason`,
  // which is only called when `written === 0`, so:
  //
  //   armed, partial    (the NORMAL armed run) -> `skippedReason: undefined`
  //   not armed                                -> "counts are a dry run",
  //                                               and then NO COUNTS
  //
  // An armed run writing 400 of 500 said nothing at all about the other 100,
  // and the dry run promised numbers it did not print. The sibling
  // `xbrl-ratios` job appends its measurements on all three branches, which is
  // the model followed here.
  //
  // THE CURSOR IS IN THIS LINE, and it is the reason the line exists.
  // `stamped` comes from the stamp `updateMany`'s own `count`; `stampAttempted`
  // is its denominator. `stamped < stampAttempted`, or `stampFailed`, means the
  // cursor did not advance — the next run re-reads and re-writes this exact
  // page, nightly, forever, while `written` and `failed` both look perfect.
  // That is MONEY-1211, which this repo has now shipped three times, and it is
  // invisible in every other number here.
  //
  // `describeNoWriteReason`'s scan matches `/^(skipped|refused)/`, so a field
  // named `stamped` can never be picked up by it. It is named explicitly for
  // that reason, not by oversight.
  const measurements =
    `selected=${selected} written=${written} blocked=${blocked} ` +
    `created=${result.created} updated=${result.updated} ` +
    `displaced=${result.displaced} periods=${result.periods} ` +
    `statementsProjected=${result.statementsProjected} ` +
    `stampAttempted=${result.stampAttempted} stamped=${stamped} ` +
    `stampFailed=${result.stampFailed} ` +
    `truncatedByLimit=${result.truncatedByLimit} ` +
    `scaleContextFetched=${result.scaleContextFetched} ` +
    `scaleContextTruncated=${result.scaleContextTruncated} ` +
    `doors=[${summariseWriteDoors(result)}]`;

  // ONE structured summary, always — including the zero case. A job that
  // selects rows and writes none is the defect this whole ticket exists to
  // remove; it has to be visible in a log line and in a metric, not inferred
  // from a table that stopped growing.
  reportJobOutcome({
    job: "xbrl-projection",
    selected,
    written,
    failed,
    // The reason is assembled from the writer's OWN refusal counters, so "0
    // written" is never reported without saying which door closed. Order is
    // deliberate: not-armed outranks everything, because in that state every
    // other counter is a dry-run artefact and reporting them as blockers would
    // send someone hunting a data bug that is really an unflipped env var.
    // What the ordering no longer does is DISCARD the counters — every branch
    // carries them now.
    skippedReason: !apply
      ? `not-armed (XBRL_PROJECTION_APPLY !== 'true'); counts are a dry run; ${measurements}`
      : selected > 0 && written === 0
        ? `${describeNoWriteReason(result)}; ${measurements}`
        : measurements,
  });

  // `ok` comes from the WRITER, which sets `out.ok = out.failed === 0` under a
  // comment naming "the completeness-signal-at-the-wrong-granularity defect
  // this repo has now shipped five times (MONEY-1189)". It was then hardcoded
  // `true` right here, one layer up, which threw that judgement away — the
  // sixth instance of the same defect, inside the fix for the fifth
  // (MONEY-1238).
  return {
    ok: result.ok,
    applied: apply,
    selected,
    written,
    blocked,
    failed,
    stamped,
  };
}

/**
 * Count of filings still awaiting projection. Read-only; used by the route to
 * say something useful when a run selects nothing, instead of a bare zero.
 */
export async function countUnprojectedFilings(): Promise<number> {
  return prisma.xbrlFiling.count({ where: UNPROJECTED_FILING_WHERE });
}
