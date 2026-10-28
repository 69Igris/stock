/**
 * The Databento counter names, spelled ONCE — MONEY-1373.
 *
 * ## Why a module rather than a string at each call site
 *
 * There were three literals and two of them already disagreed:
 * `databento-append.ts` emitted `databento.displaced_sessions` while every
 * other reader of that number — the runbook, the session writer's own counter
 * — calls it `sessionsDisplaced`. Nothing failed. A metric name is only ever
 * compared to itself by a human, so the two spellings simply became two series,
 * one of which had a monitor pointed at it and one of which had the data. That
 * is MONEY-1238's fault (a) with a different prefix.
 *
 * ## `displaced_d1` MUST READ ZERO
 *
 * It is a TRIPWIRE, not a metric anyone tunes, and the healthy value is
 * literally zero forever. `DATABENTO_SCHEMAS` — the Zod enum the manifest is
 * parsed against (`databento-manifest-logic.ts`) — contains no `ohlcv-1d`, so
 * NO manifest entry can name a daily schema and no harvest or append can
 * produce a daily bar. The session writer refuses a D1 displacement anyway and
 * counts the refusal here.
 *
 * So a non-zero value cannot mean "a lot of daily bars arrived". It means a
 * writer path reached the D1 series that no manifest can produce — a hand-run
 * job, a schema added to the enum without the writer being revisited, or a
 * mis-mapped timeframe. `> 0` is therefore the whole alert condition
 * (`scripts/ops/datadog/monitor-databento-d1.json`); there is no threshold to
 * pick and no baseline to learn.
 *
 * ## `spend_usd` is OUR accounting, not the vendor's invoice
 *
 * It is `sumMonthSpendUsd` over the `databento_batch_jobs` ledger: the sum of
 * `costUsd ?? costUsdQuoted` for the month, i.e. what this repo believes it has
 * authorised. Databento's own bill is computed on their side, on their calendar,
 * and can differ — a quote is not a charge, a job can be cancelled, and a month
 * boundary is a UTC window here and something else on an invoice. Read this
 * series as "how close is the guard to refusing the next submit", never as
 * "what will we be charged".
 *
 * Emitted as a GAUGE. A running monthly total is a LEVEL: incrementing it once
 * per run would sum the same month over and over.
 */

import { METRIC_PREFIX } from "@usemoney/datadog/constants";

/**
 * Metric names as PASSED to `incrementCounter` / `gauge`.
 *
 * These are NOT what arrives in Datadog — `datadog-metrics` is initialised with
 * `prefix: METRIC_PREFIX`, so the series is `stockbook.databento.…`. Anything
 * that QUERIES one (a monitor, a dashboard, a notebook) must use
 * {@link EMITTED_DATABENTO_METRICS}.
 */
export const DATABENTO_METRICS = {
  sessionsDisplaced: "databento.sessions_displaced",
  rowsDeleted: "databento.rows_deleted",
  quarantinedSymbols: "databento.quarantined_symbols",
  displacedD1: "databento.displaced_d1",
  spendUsd: "databento.spend_usd",
  expiringJobs: "databento.expiring_jobs",
  sessionsAppended: "databento.sessions_appended",
} as const;

/**
 * The fully-qualified series names that actually reach Datadog.
 *
 * DERIVED, never a second literal, for the same reason
 * `EMITTED_JOB_METRICS` is: a hand-copied `databento.displaced_d1` inside a
 * monitor template and a `prefix:` inside `metrics.ts` are two spellings of one
 * fact, and a mismatch between them is answered by permanent NO DATA — which
 * looks exactly like a tripwire that has never tripped. This repo has already
 * shipped that defect once (MONEY-1238), and `monitor-agreement.test.ts`
 * asserts the D1 monitor's query against this constant rather than against a
 * retyped string.
 */
export const EMITTED_DATABENTO_METRICS = {
  sessionsDisplaced: `${METRIC_PREFIX}${DATABENTO_METRICS.sessionsDisplaced}`,
  rowsDeleted: `${METRIC_PREFIX}${DATABENTO_METRICS.rowsDeleted}`,
  quarantinedSymbols: `${METRIC_PREFIX}${DATABENTO_METRICS.quarantinedSymbols}`,
  displacedD1: `${METRIC_PREFIX}${DATABENTO_METRICS.displacedD1}`,
  spendUsd: `${METRIC_PREFIX}${DATABENTO_METRICS.spendUsd}`,
  expiringJobs: `${METRIC_PREFIX}${DATABENTO_METRICS.expiringJobs}`,
  sessionsAppended: `${METRIC_PREFIX}${DATABENTO_METRICS.sessionsAppended}`,
} as const;
