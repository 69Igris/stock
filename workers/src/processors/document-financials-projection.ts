/**
 * Nightly document-financials → `StockFinancials` projection — MONEY-1255.
 *
 * The JOB. `document-financials-projection-logic.ts` is the write engine; this
 * file is the arming, the wiring and the outcome report.
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
 * ## MERGED IS NOT WIRED, and NOT-ARMED IS NOT NOT-WIRED
 *
 * MONEY-1115 built the XBRL projection and every piece around it, then shipped
 * with `apply` defaulting to false and **no route, no topic, no scheduler and
 * no Cloud Run job** — so the engine sat on `release` writing nothing while the
 * table stayed frozen, and "merged" was mistaken for "live" for a whole
 * release. This job ships WIRED and DISARMED, which are different states and
 * must stay distinguishable: the route exists, the outcome line fires on every
 * run, and what holds the door shut is `DOC_FINANCIALS_APPLY`.
 *
 * That variable ships **PRESENT and `"false"`** in both Cloud Build specs.
 * Absent and `"false"` must not be the same state: absent is exactly how
 * `MF_METADATA_PROVIDER` disabled its job silently for months (MONEY-1214), and
 * an operator reading a deploy spec has to be able to see that the switch
 * exists and is off.
 */

import { prisma } from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import {
  describeDocAuthorityState,
  docAuthorityState,
} from "@usemoney/core/market-data/document-financials-projection";
import {
  countUnprojectedExtracts,
  countWithheldWrites,
  describeNoWriteReason,
  processDocumentFinancialsProjectionWrite,
  summariseWriteDoors,
  DEFAULT_PAGE_SIZE,
  type DocProjectionWriteResult,
} from "./document-financials-projection-logic";

export interface DocFinancialsProjectionMessage {
  /** Narrows only. Cannot arm a run the environment has not armed. */
  apply?: boolean;
  /** Rows per page. */
  limit?: number;
  /** Pages this run will read. */
  maxPages?: number;
  symbols?: string[];
  periodTypes?: Array<"ANNUAL" | "QUARTERLY">;
  /**
   * Also write periods that have NO incumbent row. Defaults to false.
   *
   * Unlike `apply` this is not an arming switch and does not need to narrow: it
   * cannot cause a write on its own, because every write still requires the
   * environment-held `apply`.
   *
   * It is the majority path for the cohort this pipeline exists for — ~821
   * symbols hold zero `stock_financials` rows — and the default is still FALSE,
   * because a 100%-create run is ALSO the exact signature of a `periodLabel`
   * join bug. Turn it on deliberately, scoped (`symbols` + a small `limit`),
   * with a reconcile report whose CEILING check distinguished the two, and
   * check the created rows against the documents by hand before any full run.
   */
  createMissing?: boolean;
  /** Resume point from a previous run's `nextAfterSymbol`. */
  afterSymbol?: string;
}

export interface DocFinancialsProjectionResult {
  ok: boolean;
  applied: boolean;
  selected: number;
  written: number;
  blocked: number;
  failed: number;
  stamped: number;
  drained: boolean;
  nextAfterSymbol: string | null;
}

/**
 * True when the environment has armed the write.
 *
 * Compared against the LITERAL `"true"`, never `Boolean(value)`: an env var set
 * to `"false"` is a non-empty string and would arm the job under a truthiness
 * check — arming it in the one configuration meant to keep it off. That is the
 * same silent-inversion class as MONEY-1214's absent `MF_METADATA_PROVIDER`,
 * where a job ran cleanly for months writing nothing.
 *
 * Nothing else is accepted. Not `"1"`, not `"TRUE"`, not `"yes"` — a
 * case-insensitive or multi-spelling check is a second place for the arming
 * rule to live, and this one is guarding a table with no `source` in its unique
 * key.
 */
export function isDocProjectionArmed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.DOC_FINANCIALS_APPLY === "true";
}

/** `msg.apply` narrows; only the env can arm. See the file header. */
export function resolveDocApply(
  msg: DocFinancialsProjectionMessage | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const armed = isDocProjectionArmed(env);
  if (msg?.apply === false) return false;
  return armed;
}

/**
 * Injectable seam, the same shape the sibling XBRL job carries.
 *
 * It exists so the OUTCOME LINE can be tested — without it this function
 * reaches the real Prisma client and the real `process.env`, so the one thing
 * this job is for (reporting what a run did) would be assertable only in
 * production. Note what is NOT here: there is no way to pass `apply`. `env`
 * still has to say `"true"`, so an injected env can no more arm a run than a
 * message can.
 */
export interface DocFinancialsProjectionDeps {
  prisma?: typeof prisma;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * ONE structured summary, on every exit — including the throw and the idle run.
 *
 * `result` is null exactly when the writer threw before returning. That case
 * reports `selected: 0, written: 0, failed: 1` rather than nothing at all: a
 * silent run and a healthy idle run are the same picture from a dashboard, and
 * telling them apart after the fact is impossible.
 *
 * ## What the reason string has to carry, and why
 *
 * "wrote 0 rows" is ambiguous between *nothing needed writing* and *every door
 * closed*, and those need opposite responses — one is a fixpoint, the other is
 * an incident. So the per-decision counts travel WITH the outcome:
 * created / updated / displaced, and every skip reason by name.
 *
 * THE CURSOR IS IN THIS LINE and is half the reason it exists. `stamped` comes
 * from the stamp `updateMany`'s own `count`; `stampAttempted` is its
 * denominator. `stamped < stampAttempted`, or `stampFailed`, means the cursor
 * did not advance — the next run re-reads and re-writes this exact page,
 * nightly, forever, while `written` and `failed` both look perfect. That is
 * MONEY-1211, and it is invisible in every other number here. `drained` is the
 * other half: a run that never reaches the end of the population advances only
 * by the cursor filter, so `drained=false` alongside `stamped=0` means nothing
 * is moving at all.
 */
function reportOutcome(
  result: DocProjectionWriteResult | null,
  apply: boolean,
  authority: string,
): void {
  if (!result) {
    reportJobOutcome({
      job: "document-financials-projection",
      selected: 0,
      written: 0,
      failed: 1,
      skippedReason:
        `THREW before returning a result — no counters are available. This is ` +
        `reported rather than skipped because a silent run and a healthy idle ` +
        `run look identical from a dashboard. authority=${authority} ` +
        `apply=${apply}`,
    });
    return;
  }

  const selected = result.extractsRead;
  const written = result.created + result.updated;
  const blocked = countWithheldWrites(result);
  const measurements =
    `selected=${selected} written=${written} blocked=${blocked} ` +
    `created=${result.created} updated=${result.updated} ` +
    `displaced=${result.displaced} periods=${result.periods} ` +
    `statementsProjected=${result.statementsProjected} ` +
    `emptyExtracts=${result.emptyExtracts} ` +
    `pagesRead=${result.pagesRead} drained=${result.drained} ` +
    `nextAfterSymbol=${result.nextAfterSymbol ?? "-"} ` +
    `budgetExhausted=${result.budgetExhausted} ` +
    `deferredByPagination=${result.deferredByPagination} ` +
    `stampAttempted=${result.stampAttempted} stamped=${result.stamped} ` +
    `stampFailed=${result.stampFailed} ` +
    `authority=${authority} ` +
    `doors=[${summariseWriteDoors(result)}]`;

  reportJobOutcome({
    job: "document-financials-projection",
    selected,
    written,
    failed: result.failed,
    // Order is deliberate. `not-armed` outranks everything, because in that
    // state every other counter is a dry-run artefact and reporting them as
    // blockers would send someone hunting a data bug that is really an
    // unflipped env var. `idle` comes next, because a run that selected nothing
    // cannot have been blocked by anything. What the ordering does NOT do is
    // discard the counters — every branch carries them.
    skippedReason: !apply
      ? `not-armed (DOC_FINANCIALS_APPLY !== 'true'); counts are a dry run; ` +
        `${measurements}`
      : selected === 0
        ? `idle — nothing unprojected matched the selector, so there was ` +
          `nothing to write. This is reported as 0/0 rather than left silent, ` +
          `so a healthy idle night is distinguishable from a dead job; ` +
          `${measurements}`
        : written === 0
          ? `${describeNoWriteReason(result)}; ${measurements}`
          : measurements,
  });
}

export async function processDocumentFinancialsProjection(
  msg?: DocFinancialsProjectionMessage,
  deps: DocFinancialsProjectionDeps = {},
): Promise<DocFinancialsProjectionResult> {
  const apply = resolveDocApply(msg, deps.env);
  const limit = Math.max(1, Math.min(5000, msg?.limit ?? DEFAULT_PAGE_SIZE));

  // The AUTHORITY STATE, on every run. `DOC_PDF` may or may not be declared in
  // `FINANCIALS_AUTHORITY` yet, and the two states behave differently — undeclared
  // ranks LAST, so the job can fill empty cells and displace nothing. Both are
  // safe; only one is the decision that was made. An unreported difference
  // between "configured" and "not configured" is MONEY-1214 exactly.
  const authority = docAuthorityState();

  console.log(
    `[document-financials-projection] Starting (apply=${apply}, limit=${limit}` +
      `${msg?.symbols?.length ? `, symbols=${msg.symbols.length}` : ""}` +
      `, authority=${authority})`,
  );

  // ── The outcome is emitted from a `finally`, on EVERY exit ──────────
  //
  // Including the throwing one, and including the idle one. Two failure shapes
  // this closes, both observed in this repo rather than imagined:
  //
  //  1. **A THROW emitted nothing.** The one run an operator most needs a
  //     metric for is the one that died, and a `reportJobOutcome` sitting on
  //     the happy path is exactly the one that does not fire.
  //  2. **An IDLE run emitted nothing.** `stock-document-extract` put its
  //     report BELOW an empty-queue early return, so a night with nothing to do
  //     was SILENT — and a freshness monitor with `notify_no_data:true` would
  //     have gone red the moment the backlog finished draining, then been muted
  //     as a false alarm. An idle run reports 0/0, so "nothing to do" and "the
  //     job is dead" are distinguishable from the outside. They are the same
  //     picture otherwise.
  let result: DocProjectionWriteResult | null = null;
  try {
    result = await processDocumentFinancialsProjectionWrite(
      {
        apply,
        limit,
        ...(msg?.maxPages ? { maxPages: msg.maxPages } : {}),
        ...(msg?.symbols ? { symbols: msg.symbols } : {}),
        ...(msg?.periodTypes ? { periodTypes: msg.periodTypes } : {}),
        createMissing: msg?.createMissing === true,
        ...(msg?.afterSymbol ? { afterSymbol: msg.afterSymbol } : {}),
        // The cursor. Without it this job re-reads the same first page every
        // night forever — MONEY-1211, which this repo has shipped three times.
        unprojectedOnly: true,
        ...(deps.now ? { now: deps.now } : {}),
      },
      { prisma: deps.prisma },
    );
  } finally {
    reportOutcome(result, apply, authority);
  }

  // Mapped from the writer's own vocabulary rather than invented here, so a
  // rename over there is a type error and not a silently-zero metric.
  const selected = result.extractsRead;
  const written = result.created + result.updated;
  const blocked = countWithheldWrites(result);

  if (authority !== "BELOW_XBRL_ONLY") {
    console.warn(
      `[document-financials-projection] AUTHORITY: ` +
        `${describeDocAuthorityState(authority)}`,
    );
  }

  // `ok` comes from the WRITER, which sets it from its own `failed` count.
  // Hardcoding `true` one layer up is the completeness-signal-at-the-wrong-
  // granularity defect this repo has shipped six times (MONEY-1189/1238).
  return {
    ok: result.ok,
    applied: apply,
    selected,
    written,
    blocked,
    failed: result.failed,
    stamped: result.stamped,
    drained: result.drained,
    nextAfterSymbol: result.nextAfterSymbol,
  };
}

/**
 * Count of extracts still awaiting a projection decision. Read-only; used by
 * the route to say something useful when a run selects nothing, instead of a
 * bare zero — "0 selected" is ambiguous between "everything is projected" and
 * "the selector is broken", and that ambiguity is the whole MONEY-1220 defect
 * class.
 */
export async function countPendingExtracts(): Promise<number> {
  return countUnprojectedExtracts();
}
