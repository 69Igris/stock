/**
 * The Databento spend guard — MONEY-1373.
 *
 * ## What this is, and how it differs from the Tiingo one it is modelled on
 *
 * `tiingo-budget.ts` counts REQUESTS against an hourly/daily plan ceiling, in
 * Redis, shared across every process that can spend the account. This guard
 * counts DOLLARS against a monthly budget, in Mongo, and the differences are
 * forced by the vendor rather than chosen:
 *
 *   - Databento bills per BATCH JOB by uncompressed size, not per request. A
 *     request counter would authorise one job that costs $4,000 and refuse a
 *     thousand that cost nothing.
 *   - The ledger is the `databento_batch_jobs` inventory, which has to exist
 *     anyway (it is the download manifest and the append's high-water mark).
 *     A second store would be a second version of the same fact.
 *   - Cloud Run JOBS carry no `REDIS_URL` — a job spec does not inherit the
 *     service's env block — and the two Databento entry points are jobs.
 *
 * ## The quote comes from `metadata.get_cost`, and it MUST
 *
 * The submit response's `cost_usd` is NULL until the job is processed —
 * verified against the vendor's own typed client, which documents it as "Will
 * be `None` until the job is processed", and against their published capture of
 * a queued job. A guard that read the price off the thing it was authorising
 * would compare against `null` on every call and let everything through.
 *
 * So: quote first (free), compare, then submit. The ledger records the QUOTE at
 * submission and the real figure when the poll loop later sees it, and sums
 * `costUsd ?? costUsdQuoted` so a month's spend is never understated by the
 * jobs still in flight.
 *
 * ## Over budget REFUSES. It never trims.
 *
 * A guard that narrowed a window to fit would buy a slice nobody asked for and
 * report success, and the coverage report would then show a gap attributable to
 * the vendor. Refusing is loud, costs nothing, and leaves the operator the two
 * real choices: raise the budget deliberately, or split the manifest entry.
 *
 * ## Every submit goes through here, and that is CHECKED
 *
 * `databento-budget-wiring.test.ts` scans the source tree for `submitBatchJob(`
 * and fails on any call site outside a `withDatabentoBudget(` frame. MONEY-1309
 * is why it is a scan rather than a review note: a budget guard wired at one of
 * five legs under-reported spend by ~80%, which is worse than no guard because
 * it manufactures headroom that does not exist.
 */

import type { DatabentoJob, DatabentoJobRequest } from "./databento-logic";

/* ─────────────────────────────────────────────────────────────────────────
   The budget
   ──────────────────────────────────────────────────────────────────────── */

/** What the append is expected to cost in a month, with room to be wrong. */
export const DEFAULT_DATABENTO_MONTHLY_BUDGET_USD = 25;

let warnedAboutDefault = false;

/**
 * `DATABENTO_MONTHLY_BUDGET_USD`, read PER CALL.
 *
 * Never a module-scope const. A module-level read freezes at import, and on a
 * warm Cloud Run container that turns a redeployed budget into no change at
 * all — the trap CLAUDE.md states for every flag in this repo and
 * `bse-client.ts` documents for its retry config.
 *
 * An unparseable or non-positive value falls back to the default and warns
 * ONCE per process: a per-call warning inside a job that submits fifty times is
 * not an alert, it is a way of hiding one.
 */
export function readDatabentoMonthlyBudgetUsd(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env["DATABENTO_MONTHLY_BUDGET_USD"] ?? "").trim();
  if (raw === "") return DEFAULT_DATABENTO_MONTHLY_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (!warnedAboutDefault) {
      warnedAboutDefault = true;
      console.warn(
        `[databento-budget] DATABENTO_MONTHLY_BUDGET_USD="${raw}" is not a ` +
          `positive number; using $${DEFAULT_DATABENTO_MONTHLY_BUDGET_USD}.`,
      );
    }
    return DEFAULT_DATABENTO_MONTHLY_BUDGET_USD;
  }
  return n;
}

/** Test hook — the once-per-process warning must not leak between cases. */
export function __resetDatabentoBudgetWarning(): void {
  warnedAboutDefault = false;
}

/**
 * The calendar month `at` falls in, in UTC.
 *
 * UTC rather than IST or ET, and it does not matter which as long as it is
 * stated: the budget is our own accounting boundary, not the vendor's billing
 * one. What WOULD matter is two readers disagreeing, so there is one function.
 */
export function monthWindowUtc(at: Date): { fromMs: number; toMs: number } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  return { fromMs: Date.UTC(y, m, 1), toMs: Date.UTC(y, m + 1, 1) };
}

/* ─────────────────────────────────────────────────────────────────────────
   The ledger seam
   ──────────────────────────────────────────────────────────────────────── */

/** The inventory row this guard reads and writes. */
export interface DatabentoJobRow {
  id: string;
  jobId: string | null;
  state: string;
  costUsd: number | null;
  costUsdQuoted: number;
}

/** Identity of a window. Two requests with the same key are the same purchase. */
export interface BudgetKey {
  purpose: string;
  entryId: string;
  schema: string;
  symbolsHash: string;
  start: Date;
  end: Date;
}

export interface DatabentoBudgetDeps {
  /** An existing row for this exact window, or null. */
  findExistingJob(key: BudgetKey): Promise<DatabentoJobRow | null>;
  /**
   * An existing row for this (purpose, entry, schema, symbol set) IGNORING the
   * window bounds — the guard against a re-buy when the window itself moved.
   *
   * Required for `HARVEST` and unused for anything else. See
   * {@link windowIsPinnedFor}.
   */
  findEntryPurchase?(
    key: Omit<BudgetKey, "start" | "end">,
  ): Promise<DatabentoJobRow | null>;
  /** Σ (costUsd ?? costUsdQuoted) over rows SUBMITTED inside the window. */
  sumMonthSpendUsd(window: { fromMs: number; toMs: number }): Promise<number>;
  /** Create the row in `QUOTED` before anything is spent. */
  createQuotedJob(
    args: BudgetKey & {
      dataset: string;
      symbolCount: number;
      costUsdQuoted: number;
      /**
       * The split shape being bought, recorded on the row. Taken from the
       * REQUEST rather than the manifest: the manifest can be corrected after
       * a purchase, and a reader asking "how is this job shaped" must get the
       * answer for THIS row, not for what the entry would buy today.
       */
      splitSymbols: boolean;
      splitDuration: string;
      /**
       * A rebuyable row with NO vendor job to take over instead of inserting
       * — MONEY-1539. Inserting beside it collides with the window's
       * `@@unique` on a same-window retry. Null when there is none, and
       * always null for a row that carries a `jobId`: overwriting that id
       * would detach its archived bytes from the ledger (MONEY-1540).
       */
      reclaimRowId: string | null;
    },
  ): Promise<DatabentoJobRow>;
  /** Record the vendor's job id and move the row to `SUBMITTED`. */
  markSubmitted(rowId: string, job: DatabentoJob): Promise<void>;
  /** Record a submission that threw, so the row is not mistaken for spend. */
  markFailed(rowId: string, detail: string): Promise<void>;
  now(): Date;
}

/** Raised when a submission would take the month past its budget. */
export class DatabentoBudgetExceededError extends Error {
  constructor(
    readonly quoteUsd: number,
    readonly spentUsd: number,
    readonly budgetUsd: number,
    readonly entryId: string,
  ) {
    super(
      `[databento-budget] REFUSED ${entryId}: the quote is $${quoteUsd.toFixed(2)}, ` +
        `$${spentUsd.toFixed(2)} is already committed this month, and the budget ` +
        `is $${budgetUsd.toFixed(2)}. Not trimming the request — a narrowed ` +
        "window buys a slice nobody asked for and reports success. Raise " +
        "DATABENTO_MONTHLY_BUDGET_USD deliberately, or split the manifest entry.",
    );
    this.name = "DatabentoBudgetExceededError";
  }
}

export type BudgetOutcome =
  | { status: "reused"; row: DatabentoJobRow; quoteUsd: number | null }
  | { status: "dry-run"; quoteUsd: number; spentUsd: number; budgetUsd: number }
  | {
      status: "submitted";
      row: DatabentoJobRow;
      job: DatabentoJob;
      quoteUsd: number;
    };

export interface BudgetSpec extends BudgetKey {
  dataset: string;
  symbolCount: number;
  /** The window, for the quote. */
  request: DatabentoJobRequest;
  /** False leaves everything untouched and reports what it WOULD do. */
  apply: boolean;
}

/**
 * Quote, compare, record, submit.
 *
 * ## The idempotent window lookup comes FIRST
 *
 * Before anything else: a row for this exact `(purpose, entryId, schema,
 * symbolsHash, start, end)` that is not FAILED or EXPIRED means this window has
 * already been bought, and it is returned unchanged. A window is never bought
 * twice — which is what makes the harvest resumable after a killed task, and
 * what stops an operator's re-run of a manifest entry from spending the whole
 * budget again.
 *
 * ## Order of the writes
 *
 * The row is created in `QUOTED` BEFORE the submission and moved to `SUBMITTED`
 * after it. Every prefix of that is safe: a crash after the create leaves a
 * `QUOTED` row with no vendor job, which the next run's idempotent lookup
 * ignores (it is not a purchase) and which the operator can see. The inverse —
 * submitting first and recording after — loses the job id on a crash, and a job
 * that exists at the vendor and not in our ledger is spend nobody can find.
 */
/**
 * States whose row is NOT a purchase, so the window may be bought again.
 *
 * `QUOTED` is the one that had to be added, and its absence was a permanent
 * wedge rather than a cosmetic gap. The guard creates the row in `QUOTED`
 * BEFORE `batch.submit_job`, deliberately, so a crash between the two leaves a
 * visible row rather than spend nobody can find. But `QUOTED` also counted as
 * "already bought", and NOTHING ELSE SELECTS IT: the harvest's poll takes
 * `[SUBMITTED, PROCESSING]`, its download takes `DONE`, its load takes
 * `[DOWNLOADED, DONE]`, and the append's high-water mark counts
 * `[DOWNLOADED, LOADED]`. So a task killed in that window — a redeploy SIGTERM,
 * an OOM, the 24h cap — left a chunk that was never bought, never downloaded,
 * never loaded, and reported on every subsequent run as
 * `already bought (job pending, state QUOTED)`. No counter moved.
 *
 * Four comments in this repo already asserted this behaviour, including the one
 * six lines below the check that contradicted it. `nextActionFor` returns
 * `"quote"` for a QUOTED row and always did — it simply was not consulted.
 *
 * Re-quoting is SAFE rather than a second spend: the row carries no `jobId`, so
 * no vendor job exists for it.
 *
 * AND IT IS A TAKEOVER, NOT AN INSERT — MONEY-1539. This comment used to say
 * `createQuotedJob` was "a fresh insert", and the window's `@@unique` refuses
 * exactly that: every same-day retry of a QUOTED or FAILED window died on a
 * unique-constraint error before quoting (7 times on prod, 2026-09-10..18, the
 * 18:00 IST retry each time). So the guard hands the stale row's id to
 * `createQuotedJob` as `reclaimRowId`, which re-arms it in place.
 */
/**
 * Is this purpose's window FIXED once bought?
 *
 * YES for `HARVEST`, and this is the fix for the worst defect in the branch.
 * Every manifest entry carries `end: "latest"`, which `resolveEntryRange`
 * resolves against `now` — so `end` is a DIFFERENT instant on every trading
 * day. The idempotency key contains `start` and `end`, so a harvest re-run on
 * any later day missed the lookup entirely and re-quoted and re-submitted the
 * whole 3.4-year history. Measured: a Tuesday run resolves `end` to
 * 2026-09-05T04:00Z and a Wednesday run to 2026-09-09T04:00Z.
 *
 * That is not an exotic path. It is what an operator does when the 24h task
 * cap kills a large entry part-way and they re-run the same command the next
 * morning — the exact thing the runbook tells them to do. The only thing that
 * would have stopped it is the monthly ceiling throwing part-way through,
 * leaving the entry half-bought.
 *
 * NO for `APPEND`, which is the whole point of the distinction: it buys a new
 * session every night, so its window MUST be part of its identity or every
 * night after the first would report "already bought" and the series would
 * stop extending.
 *
 * `PROBE` does not need pinning — its `entryId` already carries the symbol and
 * the date — but it is harmless there and is left out to keep the rule to one
 * sentence.
 */
export function windowIsPinnedFor(purpose: string): boolean {
  return purpose === "HARVEST";
}

/**
 * States a window may be bought AGAIN from.
 *
 * `FAILED` and `EXPIRED` are the vendor's outcomes; `QUOTED` is ours — a crash
 * between writing the row and submitting, so no vendor job exists for it.
 *
 * THE SPLIT SHAPE IS NOT IN THE KEY, and that is a real gap rather than an
 * oversight worth papering over. `DatabentoBatchJob`'s unique key is
 * `(purpose, entryId, schema, symbolsHash, start, end)` — it cannot tell a
 * window bought as daily files from the same window bought as symbol-year
 * files, though the two are 217x apart in load cost (MONEY-1373: 439,569 cold
 * shard writes against 2,028).
 *
 * So a row bought with the WRONG shape is `DOWNLOADED`, not rebuyable, and
 * would be reused forever. Correcting it is a deliberate OPERATOR step —
 * delete the ledger row, then re-run the entry — documented in
 * `docs/reference/databento-harvest-runbook.md`. It is NOT a code path on
 * purpose: an automatic re-buy keyed on a shape mismatch is a machine that can
 * spend money because a manifest field changed, and this ledger exists to make
 * exactly that impossible.
 */
export function isRebuyableState(state: string): boolean {
  return state === "FAILED" || state === "EXPIRED" || state === "QUOTED";
}

export async function withDatabentoBudget(
  spec: BudgetSpec,
  deps: DatabentoBudgetDeps,
  quote: () => Promise<number>,
  submit: () => Promise<DatabentoJob>,
): Promise<BudgetOutcome> {
  // THE WINDOW-PINNED LOOKUP FIRST, for a purpose whose window is fixed once
  // bought. It ignores `start`/`end`, which for a HARVEST entry move with the
  // calendar and would otherwise make every re-run a fresh purchase.
  const existing =
    (windowIsPinnedFor(spec.purpose) && deps.findEntryPurchase
      ? await deps.findEntryPurchase({
          purpose: spec.purpose,
          entryId: spec.entryId,
          schema: spec.schema,
          symbolsHash: spec.symbolsHash,
        })
      : null) ?? (await deps.findExistingJob(spec));
  if (existing !== null && !isRebuyableState(existing.state)) {
    return {
      status: "reused",
      row: existing,
      quoteUsd: existing.costUsdQuoted,
    };
  }

  const quoteUsd = await quote();
  const budgetUsd = readDatabentoMonthlyBudgetUsd();
  const window = monthWindowUtc(deps.now());
  const spentUsd = await deps.sumMonthSpendUsd(window);

  if (spentUsd + quoteUsd > budgetUsd) {
    throw new DatabentoBudgetExceededError(
      quoteUsd,
      spentUsd,
      budgetUsd,
      spec.entryId,
    );
  }

  if (!spec.apply) {
    return { status: "dry-run", quoteUsd, spentUsd, budgetUsd };
  }

  const row = await deps.createQuotedJob({
    purpose: spec.purpose,
    entryId: spec.entryId,
    schema: spec.schema,
    symbolsHash: spec.symbolsHash,
    start: spec.start,
    end: spec.end,
    dataset: spec.dataset,
    symbolCount: spec.symbolCount,
    costUsdQuoted: quoteUsd,
    splitSymbols: spec.request.splitSymbols,
    splitDuration: spec.request.splitDuration,
    // `existing` is null or rebuyable here. Only a row with no vendor job is
    // taken over; an EXPIRED row keeps its job id and its archived bytes.
    reclaimRowId:
      existing !== null && existing.jobId === null ? existing.id : null,
  });

  let job: DatabentoJob;
  try {
    job = await submit();
  } catch (err) {
    // The row exists and would otherwise sit in QUOTED forever, counting as
    // neither spend nor work. Marking it FAILED is what lets the idempotent
    // lookup retry this window on the next run.
    await deps
      .markFailed(row.id, err instanceof Error ? err.message : String(err))
      .catch(() => {});
    throw err;
  }
  await deps.markSubmitted(row.id, job);
  return { status: "submitted", row, job, quoteUsd };
}

/**
 * What a run should print about the money, whether or not it spent any.
 *
 * A dry run's whole product is this line — it is what the QA job reports and
 * what the runbook reads to confirm the subscription is live (an included
 * window quotes $0.00, a metered one does not).
 */
export function formatBudgetLine(args: {
  entryId: string;
  outcome: BudgetOutcome;
}): string {
  const { entryId, outcome } = args;
  switch (outcome.status) {
    case "reused":
      return `[databento-budget] ${entryId}: already bought (job ${outcome.row.jobId ?? "pending"}, state ${outcome.row.state}) — no quote, no spend`;
    case "dry-run":
      return `[databento-budget] ${entryId}: DRY RUN quote $${outcome.quoteUsd.toFixed(2)}, committed $${outcome.spentUsd.toFixed(2)}, budget $${outcome.budgetUsd.toFixed(2)}`;
    case "submitted":
      return `[databento-budget] ${entryId}: submitted ${outcome.job.id} at a quoted $${outcome.quoteUsd.toFixed(2)}`;
  }
}

/**
 * The quote and the vendor's eventual figure, compared.
 *
 * Not a guard — by the time the real cost is known the money is spent. It is a
 * WARNING that the quote endpoint and the billing engine disagree, which would
 * mean the budget is being enforced against the wrong number and nothing else
 * would ever say so.
 */
export function reportQuoteDrift(args: {
  entryId: string;
  jobId: string;
  quotedUsd: number;
  actualUsd: number | null;
}): string | null {
  if (args.actualUsd === null) return null;
  const delta = Math.abs(args.actualUsd - args.quotedUsd);
  if (delta <= 0.01) return null;
  return (
    `[databento-budget] QUOTE DRIFT on ${args.entryId} (${args.jobId}): quoted ` +
    `$${args.quotedUsd.toFixed(2)}, billed $${args.actualUsd.toFixed(2)}. The ` +
    "budget is enforced against the quote, so a systematic drift means it is " +
    "guarding the wrong number."
  );
}
