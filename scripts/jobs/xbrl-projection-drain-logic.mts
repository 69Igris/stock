/**
 * `xbrl-projection-drain` — the PURE decisions (no Prisma, no clock, no argv).
 *
 * MONEY-1235. Every function here is a policy that only misbehaves ACROSS
 * batches — arming, termination, accumulation — which is exactly the shape that
 * cannot be observed from one run and cannot be asserted from inside
 * `xbrl-projection-drain.ts`, because that file calls `main()` at module top
 * level (the Cloud Run entry-point convention: running the bundle runs the job).
 * Importing it from a test would run the job against a real database.
 *
 * Same split, and the same reasoning, as `xbrl-ratios-logic.ts`: a selection or
 * a stop condition whose behaviour only shows up on the tenth batch has to be a
 * function you can call twice in a test.
 *
 * ## The termination problem, stated exactly
 *
 * `processXbrlProjectionWrite({ unprojectedOnly: true })` pages by a CURSOR that
 * is a column on the data — `XbrlFiling.projectedAt` — not by an offset. A page
 * advances only because the previous page STAMPED the rows it decided. So the
 * loop's exit condition is not "I have read N pages"; it is "the population
 * stopped shrinking".
 *
 * And the writer deliberately does not stamp everything it reads
 * (`xbrl-projection-writer.ts`, the cursor block):
 *
 *   - `apply === false`  -> stamps NOTHING AT ALL. A dry run re-reads the same
 *                          page forever. This is not a bug to fix in the writer;
 *                          a rehearsal that left a trace would make the first
 *                          armed run skip everything the rehearsal "decided".
 *   - `notDecidedIds`    -> create-suppressed and no-instrument. Neither is a
 *                          property of the filing, so stamping them would burn
 *                          the filing on a verdict that belongs to the RUN.
 *   - `failedIds`        -> retried next run with no new bytes.
 *
 * Each of those is a page that reads filings and moves the cursor zero. A naive
 * `while (filingsRead > 0)` loop spins on any of them until the 24 h task
 * timeout, having written nothing, and the only evidence is a log that repeats.
 * `decideAfterBatch()` is the guard, and it is proven by test rather than by
 * this comment.
 *
 * ## Why progress is measured by COUNTING, not by adding up counters
 *
 * The writer's result cannot tell you how many rows it stamped: `decided` is
 * `decidedIds \ (failedIds ∪ notDecidedIds)`, three sets that never leave the
 * function, and the public counters are per-STATEMENT (one filing yields up to
 * two) so they cannot be back-solved into a filing count. Any arithmetic here
 * would be a guess that goes wrong the first time a counter is added.
 *
 * So the loop asks the database the one question that actually decides whether
 * the next page differs from this one: **how many filings are still unprojected
 * in this run's scope?** That is the same population the next `findMany` will
 * select from. If it did not shrink, the next page is the same page.
 *
 * There is deliberately no checkpoint table, for the reason
 * `xbrl-backfill.ts` gives at length: the MONEY-1189 postmortem is a catalogue
 * of checkpoints recording DONE for work that never happened. `projectedAt` on
 * the rows IS the checkpoint, at exactly the granularity that matters, and
 * re-running is free because the writer SKIPs a row whose values already match.
 *
 * ## Why the extension is `.mts` — the only one in the repo, and it is load-bearing
 *
 * `scripts/` has no `package.json`, so it inherits the ROOT one, which declares
 * no `"type"` — i.e. CommonJS. `workers/` declares `"type": "module"`. A test
 * under `workers/__tests__/` is therefore ESM importing a CJS module, and Node
 * has to recover the named exports by STATIC ANALYSIS (cjs-module-lexer).
 * Measured on this exact file: it recovers nothing —
 *
 *     import * as m from ".../xbrl-projection-drain-logic";
 *     Object.keys(m)  ->  ["default"]
 *
 * — so every named import throws `SyntaxError: does not provide an export named
 * …` at instantiation. Nothing else in this repo imports a `scripts/` module
 * from a workspace test, which is why the boundary had never been crossed
 * before.
 *
 * `.mts` is ESM regardless of the nearest `package.json`, which makes the import
 * a real ESM-to-ESM binding in all three consumers: the test, the `.ts` job
 * entry point (Node 22's `require(esm)`), and the tsup/esbuild bundle. The job
 * entry point itself deliberately stays `.ts`: `job-build-provenance.test.ts`
 * parses tsup's entry map with `/"\.\.\/scripts\/jobs\/([\w-]+)\.ts"/`, so a
 * `.mts` ENTRY would drop out of the guard that checks every Cloud Run job
 * reports its build — coverage lost silently, which is the failure that guard
 * exists to catch.
 *
 * Import it as `./xbrl-projection-drain-logic.mjs`: that is the specifier
 * TypeScript (`moduleResolution: bundler`) and esbuild both map back to `.mts`.
 *
 * @see scripts/jobs/xbrl-projection-drain.ts (the only caller)
 */

// `import type` only — erased at build time, so this module stays free of
// Prisma, of `@usemoney/datadog`, and of every module-scope side effect the
// writer drags in. The type is imported rather than restated so that a renamed
// counter over there is a TYPE ERROR here, not a silently-zero total.
import type { XbrlProjectionWriteResult } from "../../workers/src/processors/xbrl-projection-writer";

/** The two buckets `StockFinancials` has. HALF_YEARLY/NINE_MONTH have none. */
export type ProjectionPeriodType = "ANNUAL" | "QUARTERLY";

/**
 * Filings per batch. 2000, not the writer's own 5000 default.
 *
 * The writer holds a whole page in memory — every row's `facts` JSON, plus one
 * `ScaleObservation` per row for the scale detector's per-symbol context — so
 * the page size is the job's memory profile. 2000 is the value the 2Gi job spec
 * in `scripts/ops/setup-xbrl-projection-drain-job.sh` is sized against.
 *
 * The ack deadline is NOT a factor here and must not be reintroduced as one:
 * this is a Cloud Run JOB (`--task-timeout=86400`), not a Pub/Sub push handler.
 * The 600 s ceiling that sets every OTHER batch size in this repo (see the
 * "Job throughput" table in CLAUDE.md) does not apply — the nightly
 * `xbrl-projection` push handler caps at 500 for exactly that reason, and that
 * cap is the whole reason this drain job has to exist.
 */
export const DEFAULT_DRAIN_LIMIT = 2000;

/**
 * Hard ceiling on `--limit`, matching `processXbrlProjection`'s own
 * `Math.min(5000, …)` clamp. One number, two callers: a drain batch that could
 * be larger than anything the nightly job can ask for would be exercising a
 * page size no other code path has ever run.
 */
export const MAX_DRAIN_LIMIT = 5000;

/**
 * Runaway guard, NOT a work limit — and the difference is the whole point.
 *
 * At `--limit=2000` this is 400,000 filings, ~4.4x prod's entire 90,188-filing
 * unprojected population. It exists so that a bug that defeats every other stop
 * condition still ends, in a state that reports `max-batches` instead of
 * burning a 24 h task. If a real drain ever reaches it, the answer is to look at
 * why the population is not shrinking, never to raise this.
 */
export const DEFAULT_MAX_BATCHES = 200;

/**
 * Wall-clock budget between batches. 6 h, against a 24 h task timeout.
 *
 * Deliberately far below the task timeout so the job ends by its OWN decision
 * and prints its summary. A run killed by Cloud Run at 24 h loses the final
 * report — the totals, the stop reason, the remaining count — which is the only
 * artifact that says whether to re-run.
 *
 * It is checked BETWEEN batches and cannot interrupt one: `processXbrlProjection
 * Write` has no cancellation. So the true worst case is `budget + one batch`,
 * and the task timeout must stay above that.
 */
export const DEFAULT_BUDGET_MS = 6 * 60 * 60 * 1000;

/** Examples carried into the final summary. The counters carry the volume. */
export const MAX_DRAIN_EXAMPLES = 20;

// ─── Arguments ────────────────────────────────────────────────────────────

export interface DrainArgs {
  /**
   * ASK to write. Default FALSE.
   *
   * This is only half of the arm — see `resolveDrainApply`. Present-and-true
   * here plus an unarmed environment is still a dry run.
   */
  apply: boolean;
  /** Force a dry run even alongside `--apply`. Narrows; never arms. */
  dryRun: boolean;
  /**
   * Also write periods with NO incumbent row. Default FALSE.
   *
   * Not an arming switch (it cannot cause a write on its own — every write
   * still needs `apply`), but it is the switch without which this job cannot do
   * the thing it was built for: prod holds 0 QUARTERLY `stock_financials` rows
   * against 71,450 QUARTERLY filings, so EVERY quarterly write is a CREATE.
   * With this off, a quarterly drain reads its whole population and writes zero
   * — and, worse, stamps nothing, so it also cannot advance (MONEY-1235).
   */
  createMissing: boolean;
  /** Restrict to one bucket. Undefined = both. */
  periodTypes?: ProjectionPeriodType[];
  /** Filings per batch. */
  limit: number;
  /** Restrict to these symbols. Undefined = every symbol. */
  symbols?: string[];
  /** Runaway guard. */
  maxBatches: number;
  /** Wall-clock budget in milliseconds, checked between batches. */
  budgetMs: number;
}

export interface DrainArgParse {
  args: DrainArgs;
  /** Non-empty = refuse to run. See `parseDrainArgs` on why typos are fatal. */
  errors: string[];
}

/** Every flag this job accepts. Anything else is a typo and is FATAL. */
const KNOWN_BOOLEAN_FLAGS = new Set([
  "--apply",
  "--dry-run",
  "--create-missing",
]);
const KNOWN_VALUE_FLAGS = new Set([
  "period-types",
  "limit",
  "symbols",
  "max-batches",
  "budget-sec",
]);

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
  max?: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    errors.push(`--${name}=${raw} is not a positive integer`);
    return fallback;
  }
  if (max !== undefined && n > max) {
    errors.push(`--${name}=${n} exceeds the maximum of ${max}`);
    return fallback;
  }
  return n;
}

/**
 * argv -> `DrainArgs`, with every default on the SAFE side.
 *
 * ## An unknown flag is a hard error, and that is not pedantry
 *
 * `xbrl-backfill.ts` ignores flags it does not recognise. That is survivable
 * there because its expensive modes are opt-IN: a mistyped flag produces a
 * smaller run, not a wrong one.
 *
 * Here the polarity is inverted and the cost is asymmetric. `--apply` is the
 * flag that makes the job do anything at all, so `--aply` would parse as "no
 * flags given", run one dry batch, stop with reason `dry-run`, exit 0, and look
 * exactly like a successful rehearsal. A founder-invoked job that reports
 * success for a six-hour window in which it wrote nothing is the MONEY-1220
 * "merged is not live" shape restated at the command line.
 *
 * `gcloud run jobs execute --args` splits on COMMAS, which makes a stray comma
 * inside a flag a routine mistake rather than a rare one.
 */
export function parseDrainArgs(argv: readonly string[]): DrainArgParse {
  const errors: string[] = [];

  const value = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };

  for (const token of argv) {
    if (KNOWN_BOOLEAN_FLAGS.has(token)) continue;
    const named = /^--([\w-]+)=/.exec(token);
    if (named && KNOWN_VALUE_FLAGS.has(named[1]!)) continue;
    errors.push(
      `unknown argument "${token}" — refusing to run rather than silently ` +
        `treating it as a dry run (a mistyped --apply is indistinguishable ` +
        `from a deliberate rehearsal)`,
    );
  }

  const limit = parsePositiveInt(
    value("limit"),
    DEFAULT_DRAIN_LIMIT,
    "limit",
    errors,
    MAX_DRAIN_LIMIT,
  );
  const maxBatches = parsePositiveInt(
    value("max-batches"),
    DEFAULT_MAX_BATCHES,
    "max-batches",
    errors,
  );
  const budgetSec = parsePositiveInt(
    value("budget-sec"),
    DEFAULT_BUDGET_MS / 1000,
    "budget-sec",
    errors,
  );

  let periodTypes: ProjectionPeriodType[] | undefined;
  const rawPeriodTypes = value("period-types");
  if (rawPeriodTypes !== undefined) {
    const tokens = rawPeriodTypes
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    const bad = tokens.filter((t) => t !== "ANNUAL" && t !== "QUARTERLY");
    if (bad.length > 0) {
      // Silently dropping an unrecognised token would widen the run to BOTH
      // buckets — the opposite of what was asked for — and the operator would
      // read the wider result as confirmation.
      errors.push(
        `--period-types has unrecognised value(s): ${bad.join(", ")}. ` +
          `Only ANNUAL and QUARTERLY project to a StockFinancials bucket; ` +
          `HALF_YEARLY and NINE_MONTH are refused by the writer and have none.`,
      );
    } else if (tokens.length === 0) {
      errors.push("--period-types was given but empty");
    } else {
      periodTypes = [...new Set(tokens)] as ProjectionPeriodType[];
    }
  }

  let symbols: string[] | undefined;
  const rawSymbols = value("symbols");
  if (rawSymbols !== undefined) {
    const list = [
      ...new Set(
        rawSymbols
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (list.length === 0) {
      // An empty list must not silently mean "every symbol": that turns a
      // scoped pilot into a whole-universe write.
      errors.push(
        "--symbols was given but empty. Omit the flag for every symbol; an " +
          "empty list is never interpreted as one.",
      );
    } else {
      symbols = list;
    }
  }

  return {
    args: {
      apply: argv.includes("--apply"),
      dryRun: argv.includes("--dry-run"),
      createMissing: argv.includes("--create-missing"),
      periodTypes,
      limit,
      symbols,
      maxBatches,
      budgetMs: budgetSec * 1000,
    },
    errors,
  };
}

// ─── Arming ───────────────────────────────────────────────────────────────

/**
 * True when the ENVIRONMENT has armed the write.
 *
 * Compared against the literal `"true"`, never `Boolean(value)`.
 * `Boolean("false")` is `true`, which would arm the job in the one
 * configuration meant to keep it off — and "false" is exactly the value both
 * `workers/cloudbuild.*.yaml` and the drain job's own spec ship.
 *
 * ## Why the comparison is restated here rather than imported
 *
 * `isProjectionArmed` in `workers/src/processors/xbrl-projection.ts` is the same
 * one-line rule, but that module imports Prisma and `@usemoney/datadog` at
 * module scope, and this file's entire purpose is to be importable by a test
 * with neither. The duplication is closed from BOTH ends instead of tolerated:
 *
 *   - `xbrl-projection-drain-logic.test.ts` reads the processor's source and
 *     asserts it still compares against the same literal, so a change over
 *     there goes red here.
 *   - `xbrl-projection-drain.ts` imports the REAL `isProjectionArmed` and
 *     refuses to start if the two disagree about the live environment.
 *
 * A restated rule with a drift guard on each side is safer than a shared rule
 * that drags a database client into a pure-logic test.
 */
export function isDrainArmed(env: NodeJS.ProcessEnv): boolean {
  return env.XBRL_PROJECTION_APPLY === "true";
}

/**
 * Does this run WRITE? Both halves are required, and the CLI half can only
 * narrow.
 *
 *   write  <=>  `--apply` given  AND  `XBRL_PROJECTION_APPLY === "true"`
 *
 * The environment is the arm because flipping it is a deploy, which is a
 * review. `StockFinancials` is `@@unique([symbol, exchange, statementType,
 * periodType, period])` with **no `source`**, so the first XBRL write to a
 * period destroys the incumbent value with nothing left to reconcile against —
 * a one-way door that must not be openable by a command-line argument.
 *
 * `--dry-run` narrows on top of everything, so an operator can rehearse an
 * armed environment without editing the job spec.
 */
export function resolveDrainApply(
  args: Pick<DrainArgs, "apply" | "dryRun">,
  env: NodeJS.ProcessEnv,
): boolean {
  if (args.dryRun) return false;
  if (!args.apply) return false;
  return isDrainArmed(env);
}

// ─── Termination ──────────────────────────────────────────────────────────

/**
 * Why the loop stopped. Every one of these is REACHABLE — there is no
 * "shouldn't happen" member, because an unreachable stop reason is a stop
 * condition nobody can test.
 */
export type DrainStop =
  /** A page came back empty: the scoped population is exhausted. */
  | "drained"
  /** `apply` is false, so nothing was stamped and page 2 would be page 1. */
  | "dry-run"
  /** Filings were read and the population did not shrink. */
  | "no-advance"
  /** The runaway guard. */
  | "max-batches"
  /** The wall-clock budget, checked between batches. */
  | "budget";

export interface BatchProgress {
  /** Filings the writer's page selected. */
  filingsRead: number;
  /** Scoped unprojected filings BEFORE the batch. */
  remainingBefore: number;
  /** Scoped unprojected filings AFTER the batch. */
  remainingAfter: number;
}

export interface DrainLoopState {
  /** Resolved by `resolveDrainApply` — the env-and-flag conjunction. */
  apply: boolean;
  /** Batches COMPLETED, including the one just observed. */
  batchesRun: number;
  maxBatches: number;
  elapsedMs: number;
  budgetMs: number;
}

/**
 * The one decision that makes this loop provably terminate.
 *
 * Every branch below is a state in which running another batch either cannot
 * help or must not happen. The ORDER is the whole design:
 *
 *  1. `drained` first. An empty page is the success case and outranks a
 *     simultaneous budget or batch cap, which would report a PARTIAL run over
 *     finished work and send someone back to re-run it.
 *  2. `dry-run` before `no-advance`. A dry run stamps nothing BY DESIGN, so it
 *     always looks like a stalled cursor. Reporting it as `no-advance` would
 *     make the normal rehearsal read like a defect, and the next person would
 *     "fix" the writer's dry-run-leaves-no-trace rule — which exists so the
 *     first armed run does not skip everything a rehearsal decided.
 *  3. `no-advance` before the caps. It is terminal and diagnostic; `budget` and
 *     `max-batches` are merely "come back later" and would hide it.
 *
 * `remainingAfter >= remainingBefore` rather than `===` on purpose. A count that
 * GREW means `xbrl-sync` inserted filings while the drain ran, and in that state
 * a batch that also stamped nothing is still not converging. Either way the
 * population is not shrinking, which is the only property this loop can make
 * progress on; the summary prints both numbers so the cause is visible.
 */
export function decideAfterBatch(
  state: DrainLoopState,
  progress: BatchProgress,
): DrainStop | null {
  if (progress.filingsRead === 0) return "drained";
  if (!state.apply) return "dry-run";
  if (progress.remainingAfter >= progress.remainingBefore) return "no-advance";
  if (state.batchesRun >= state.maxBatches) return "max-batches";
  if (state.elapsedMs >= state.budgetMs) return "budget";
  return null;
}

// ─── Accumulation ─────────────────────────────────────────────────────────

export interface DrainTotals {
  batches: number;
  /**
   * Every numeric top-level key of `XbrlProjectionWriteResult`, summed.
   *
   * Scanned rather than enumerated, for the reason `describeNoWriteReason`
   * gives: the hand-written list is what failed. Its previous version named
   * seven counters and missed three that were added in the same ticket, one of
   * which fires on 29.5% of winner periods. A counter added to the writer is
   * totalled here the day it appears, with no edit.
   */
  counters: Record<string, number>;
  /** `result.refused`, summed per refusal reason. */
  refused: Record<string, number>;
  /** Batches whose page hit `--limit` (so a trailing symbol was deferred). */
  truncatedBatches: number;
  /** Batches the writer reported `ok: false` on — i.e. that had row failures. */
  notOkBatches: number;
  /** A sample across the whole run, capped. The counters carry the volume. */
  examples: string[];
}

export function emptyDrainTotals(): DrainTotals {
  return {
    batches: 0,
    counters: {},
    refused: {},
    truncatedBatches: 0,
    notOkBatches: 0,
    examples: [],
  };
}

/** Fold one batch's result into the running totals. Mutates and returns it. */
export function accumulate(
  totals: DrainTotals,
  result: XbrlProjectionWriteResult,
): DrainTotals {
  totals.batches++;
  for (const [key, val] of Object.entries(result)) {
    if (typeof val !== "number") continue;
    totals.counters[key] = (totals.counters[key] ?? 0) + val;
  }
  for (const [key, val] of Object.entries(result.refused)) {
    if (typeof val !== "number") continue;
    totals.refused[key] = (totals.refused[key] ?? 0) + val;
  }
  if (result.truncatedByLimit) totals.truncatedBatches++;
  if (!result.ok) totals.notOkBatches++;
  for (const line of result.examples) {
    if (totals.examples.length >= MAX_DRAIN_EXAMPLES) break;
    totals.examples.push(line);
  }
  return totals;
}

// ─── Outcome ──────────────────────────────────────────────────────────────

export interface DrainOutcome {
  stop: DrainStop;
  apply: boolean;
  totals: DrainTotals;
  remainingAtStart: number;
  remainingAtEnd: number;
  elapsedMs: number;
}

/**
 * `drained` but the scoped population is NOT empty — a filter DRIFT, not a
 * finished run.
 *
 * The loop's remaining-count and the writer's own `findMany` build their `where`
 * from the same three inputs (`UNPROJECTED_FILING_WHERE`, `symbols`,
 * `periodTypes`). If the writer's page comes back empty while the count still
 * sees rows, the two filters have diverged, and "drained" is a lie of exactly
 * the kind MONEY-1234 shipped: `countUnprojectedFilings` asked
 * `{ projectedAt: null }` — which matches nothing on Mongo — and printed a
 * permanent all-clear over a 90,188-filing backlog.
 */
export function hasFilterMismatch(outcome: DrainOutcome): boolean {
  return outcome.stop === "drained" && outcome.remainingAtEnd > 0;
}

/**
 * Exit code. Non-zero means INCOMPLETE, matching `xbrl-backfill.ts`.
 *
 * A dry run that stops on `dry-run` is a SUCCESSFUL rehearsal and exits 0 — the
 * job did exactly what an unarmed run is supposed to do. Everything that leaves
 * work undone, or that cannot explain itself, exits 1.
 */
export function drainExitCode(outcome: DrainOutcome): 0 | 1 {
  if ((outcome.totals.counters.failed ?? 0) > 0) return 1;
  if (hasFilterMismatch(outcome)) return 1;
  if (outcome.stop === "drained") return 0;
  if (outcome.stop === "dry-run") return 0;
  return 1;
}

/**
 * One structured summary line for the whole run.
 *
 * Deliberately includes the ZERO case and the stop reason together: a job that
 * selects rows and writes none is the defect MONEY-1220/1235 exist to remove,
 * and it has to be legible in a log line rather than inferred from a table that
 * stopped growing.
 */
export function describeDrainOutcome(outcome: DrainOutcome): string {
  const c = outcome.totals.counters;
  const n = (k: string): number => c[k] ?? 0;
  const mins = Math.round(outcome.elapsedMs / 60_000);
  return (
    `stop=${outcome.stop} apply=${outcome.apply} batches=${outcome.totals.batches} ` +
    `elapsed=${mins}m | read=${n("filingsRead")} periods=${n("periods")} ` +
    `created=${n("created")} updated=${n("updated")} displaced=${n("displaced")} ` +
    `failed=${n("failed")} | remaining ${outcome.remainingAtStart} -> ` +
    `${outcome.remainingAtEnd}`
  );
}

/**
 * The actionable half — what the operator should DO about `stop`.
 *
 * Written per-reason rather than as one generic "see the logs", because the
 * three terminal reasons need three different next moves and getting them
 * confused costs a six-hour run.
 */
export function describeDrainStop(
  outcome: DrainOutcome,
  args: Pick<DrainArgs, "createMissing" | "limit">,
): string {
  switch (outcome.stop) {
    case "drained":
      return hasFilterMismatch(outcome)
        ? `DRAINED is WRONG: the writer's page came back empty while ` +
            `${outcome.remainingAtEnd} filing(s) are still unprojected in the ` +
            `same scope. The loop's count filter and the writer's selection ` +
            `filter have DIVERGED — that is MONEY-1234's defect (a filter that ` +
            `matches nothing reporting an all-clear), not a finished run. ` +
            `Compare UNPROJECTED_FILING_WHERE against countRemaining() before ` +
            `re-running.`
        : `Drained: no unprojected filings remain in scope.`;
    case "dry-run":
      return (
        `DRY RUN — one batch only, and that is not a truncation. An unarmed ` +
        `run stamps no projectedAt, so batch 2 would select the identical ` +
        `page and every batch after it would too. To drain, the environment ` +
        `must carry XBRL_PROJECTION_APPLY=true AND the command must pass ` +
        `--apply.`
      );
    case "no-advance":
      return (
        `STALLED: a page read ${outcome.totals.counters.filingsRead ?? 0} ` +
        `filing(s) across ${outcome.totals.batches} batch(es) and the ` +
        `unprojected population did not shrink ` +
        `(${outcome.remainingAtStart} -> ${outcome.remainingAtEnd}). The ` +
        `writer stamps only DECIDED filings; create-suppressed and ` +
        `no-instrument outcomes are deliberately NOT decisions, so a page made ` +
        `entirely of them can never advance and the loop stopped rather than ` +
        `spinning to the task timeout.` +
        (args.createMissing
          ? ` --create-missing is ON, so the likely cause is filings with no ` +
            `resolved instrument (instrument_mappings), or per-row failures. ` +
            `Check skippedNoInstrument and failed below.`
          : ` --create-missing is OFF and prod holds ZERO quarterly ` +
            `stock_financials rows, so every quarterly write is a CREATE and ` +
            `every CREATE is suppressed. This is the expected stall for a ` +
            `quarterly drain without it.`) +
        ` A scoped re-run (--symbols=…) steps past a saturated page.`
      );
    case "max-batches":
      return (
        `PARTIAL — hit the runaway guard at ${outcome.totals.batches} ` +
        `batch(es) with ${outcome.remainingAtEnd} filing(s) still ` +
        `unprojected. Re-running resumes for free: projectedAt on the rows IS ` +
        `the checkpoint, and the writer SKIPs a row whose values already ` +
        `match. Do not raise --max-batches without first asking why ` +
        `${args.limit} per batch was not enough.`
      );
    case "budget":
      return (
        `PARTIAL — the ${Math.round(outcome.elapsedMs / 60_000)}m wall-clock ` +
        `budget ended the run with ${outcome.remainingAtEnd} filing(s) still ` +
        `unprojected. Re-run to continue; it resumes for free.`
      );
  }
}

// ─── The loop ─────────────────────────────────────────────────────────────

export interface DrainDeps {
  /** Run one batch. Injected so the loop is testable without a database. */
  runBatch: (batchIndex: number) => Promise<XbrlProjectionWriteResult>;
  /** Unprojected filings in THIS RUN'S SCOPE. The progress marker. */
  countRemaining: () => Promise<number>;
  /** Injectable clock — `Date.now` in production. */
  now: () => number;
  /** Per-batch progress line. */
  onBatch?: (
    batchIndex: number,
    result: XbrlProjectionWriteResult,
    progress: BatchProgress,
  ) => void;
}

/**
 * Page until the backlog is drained, or until it provably cannot be.
 *
 * Fully injected — no Prisma, no `Date.now`, no console — so every stop
 * condition is reachable from a test in milliseconds. That matters more here
 * than usual: three of the five stop reasons only occur after several batches
 * against a real 90,188-row table, and "we will notice it in prod" is how a
 * job spins to a 24 h timeout writing nothing.
 *
 * Idempotence is INHERITED, not implemented: re-running is safe because
 * `planFinancialsWrite` returns SKIP when the row already carries our stamp,
 * our numbers and our filing's provenance. There is no resume state here on
 * purpose.
 */
export async function runDrainLoop(
  plan: { apply: boolean; maxBatches: number; budgetMs: number },
  deps: DrainDeps,
): Promise<DrainOutcome> {
  const startedAt = deps.now();
  const totals = emptyDrainTotals();
  const remainingAtStart = await deps.countRemaining();

  // A zero/negative cap must not still run one batch. `parseDrainArgs` clamps
  // it, but the loop is public and a caller that passes 0 means 0.
  if (plan.maxBatches < 1) {
    return {
      stop: "max-batches",
      apply: plan.apply,
      totals,
      remainingAtStart,
      remainingAtEnd: remainingAtStart,
      elapsedMs: deps.now() - startedAt,
    };
  }

  let remaining = remainingAtStart;

  for (;;) {
    const result = await deps.runBatch(totals.batches);
    accumulate(totals, result);
    const after = await deps.countRemaining();
    const progress: BatchProgress = {
      filingsRead: result.filingsRead,
      remainingBefore: remaining,
      remainingAfter: after,
    };
    deps.onBatch?.(totals.batches - 1, result, progress);
    remaining = after;

    const stop = decideAfterBatch(
      {
        apply: plan.apply,
        batchesRun: totals.batches,
        maxBatches: plan.maxBatches,
        elapsedMs: deps.now() - startedAt,
        budgetMs: plan.budgetMs,
      },
      progress,
    );
    if (stop) {
      return {
        stop,
        apply: plan.apply,
        totals,
        remainingAtStart,
        remainingAtEnd: remaining,
        elapsedMs: deps.now() - startedAt,
      };
    }
  }
}
