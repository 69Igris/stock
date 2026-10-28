/**
 * NSE exchange circulars — MONEY-1187 (Data Engine P11 item 7).
 *
 * ## What this job is
 *
 * The ingestion half of "what did the exchange announce this week". NSE's
 * `/api/circulars` serves a dated window of every circular issued; this job
 * walks a trailing window, parses with the pure `parseCircularsResponse`, and
 * upserts `NseCircular`.
 *
 * The classifier and every parse decision live in
 * `@usemoney/core/market-data/circulars-logic`. This file does I/O.
 *
 * ## The identity trap — this is the one that silently loses data
 *
 * `circNumber` is NOT unique. Measured over one live 237-record window: 205
 * distinct numbers, and 26 numbers appearing more than once, because NSE
 * re-issues a circular under EVERY department it applies to (75736 is filed
 * under both "Listing" and "Emerge", same subject). Upserting on the number
 * alone silently discards half of every re-issued circular — and the surviving
 * row looks completely normal, so nothing about the result says anything is
 * missing.
 *
 * `(circularNumber, department)` is 237/237 unique on the same window, and is
 * the key both here and in the schema.
 *
 * ## The response is WRAPPED
 *
 * `{ data: [...], fromDate, toDate }`, not a bare array. A bare-array assumption
 * yields zero circulars from a perfectly good 200 — which reads as a quiet week
 * rather than as a broken parse. The parser handles it; this comment exists
 * because the temptation to "simplify" is real.
 *
 * ## Why PROD-ONLY
 *
 * It scrapes nseindia.com. QA receives `nse_circulars` via
 * `sync-prod-to-qa.sh`'s REFERENCE_COLLECTIONS — the table is market-wide with
 * no instrumentId FK, so it mirrors cleanly.
 *
 * ## Attachments are NOT downloaded here
 *
 * Only the metadata and the URL are stored. The PDFs are 100s of KB each and
 * several hundred arrive per fortnight; fetching them belongs to a separate,
 * explicitly-scoped job if a reader surface ever needs the text. Storing the
 * URL now costs nothing and keeps that door open.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import {
  parseCircularsResponse,
  type Circular,
} from "@usemoney/core/market-data";

const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[circulars-sync] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[circulars-sync] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[circulars-sync] ${msg}`, data),
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Trailing window. Wider than xbrl-sync's because circulars are cheap — one
 * request returns the whole window, with no per-record fan-out — so the overlap
 * costs a single call and buys immunity to a fortnight of missed runs.
 */
const DEFAULT_WINDOW_DAYS = 14;

function istToday(): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/** The API's query format: `DD-MM-YYYY`. Note it is NOT `cirDate`'s YYYYMMDD. */
function toApiDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

export interface CircularsSyncResult {
  ok: boolean;
  /** Rows the parser accepted. */
  parsed: number;
  /**
   * Rows present upstream but unparseable (no subject, impossible date, …).
   * Rejected, never coerced — a circular dated 20260230 must not become 2 March.
   */
  rejected: number;
  written: number;
  /**
   * True when the endpoint answered with an EMPTY window rather than rows.
   * Legitimate over a holiday fortnight, so not a failure — but reported as its
   * own value rather than as `parsed: 0`, because "NSE published nothing" and
   * "we could not read the response" must never look the same.
   */
  empty: boolean;
  window: { from: string; to: string };
}

async function writeCirculars(rows: readonly Circular[]): Promise<number> {
  let written = 0;
  for (const c of rows) {
    const data = {
      circularNumber: c.number,
      displayNumber: c.displayNumber,
      department: c.department,
      category: c.category,
      subject: c.subject,
      company: c.company,
      circularDate: c.issuedAt,
      topic: c.topic,
      fileUrl: c.attachment?.url ?? "",
      fileName: c.attachment?.filename ?? "",
      fileExt: c.attachment?.ext ?? "",
      approxSizeBytes: c.attachment?.approxSizeBytes ?? null,
    };
    await prisma.nseCircular.upsert({
      where: {
        circularNumber_department: {
          circularNumber: c.number,
          department: c.department,
        },
      },
      create: data,
      // A re-read overwrites: NSE does amend a circular's subject or replace its
      // attachment in place, and the later reading is the better one. The
      // trailing window makes re-reads the normal case, not the exception.
      update: data,
    });
    written++;
  }
  return written;
}

/**
 * The two I/O calls, injectable — MONEY-1238.
 *
 * Defaults ARE the production path (the module-level `fetchNseApiJson` and the
 * local `writeCirculars`), so a test that overrides them drives the REAL
 * function, the REAL `parseCircularsResponse` and the REAL branch table. There
 * is no second copy of the decision anywhere.
 */
export interface CircularsSyncDeps {
  fetchJson?: (path: string) => Promise<unknown>;
  write?: (rows: readonly Circular[]) => Promise<number>;
  /**
   * The outcome reporter — MONEY-1328.
   *
   * Injectable for the same reason `corporate-actions-sync` made its one
   * injectable: a source scan can prove the CALL is above the `return`, and
   * nothing but running the function proves it EXECUTES. The two refusal exits
   * below are the ones the scan flagged, and neither can be reached from a test
   * that cannot observe an emission.
   */
  reportOutcome?: typeof reportJobOutcome;
}

export async function processCircularsSync(
  opts?: {
    windowDays?: number;
    from?: Date;
    to?: Date;
  },
  deps: CircularsSyncDeps = {},
): Promise<CircularsSyncResult> {
  const to = opts?.to ?? istToday();
  const from =
    opts?.from ??
    new Date(
      to.getTime() -
        (opts?.windowDays ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000,
    );
  const window = { from: toApiDate(from), to: toApiDate(to) };

  const path = `/api/circulars?fromDate=${window.from}&toDate=${window.to}`;
  const fetchJson =
    deps.fetchJson ?? ((p: string) => fetchNseApiJson<unknown>(p));
  const write = deps.write ?? writeCirculars;
  const report = deps.reportOutcome ?? reportJobOutcome;
  const payload = await fetchJson(path);
  if (payload === null) {
    // Throttle, challenge page and transport error all arrive as null. Never
    // write on one: "no circulars this fortnight" is a claim about the exchange,
    // and a failed fetch has no business making it.
    logger.error({ window }, "fetch returned null — NOT writing");
    // MONEY-1328 — this `return` used to leave the function having emitted
    // NOTHING, so a fortnight NSE blocked was byte-identical, in Datadog, to a
    // fortnight the schedule never fired. The emission goes here rather than in
    // a `finally` because this file's two OTHER refusal exits already emit from
    // inside their own block (the EMPTY and TOTAL-PARSE-FAILURE branches
    // below), and one file with two shapes for one rule is how the next reader
    // picks the wrong one.
    //
    // `transportFailures: 1` and not `failed: 1`: nothing was SELECTED, so
    // there is no row we failed to persist — there is a call that did not
    // answer, which is the distinction that counter exists for (MONEY-1250).
    //
    // THIS EXIT IS EMITTED ONCE PER DELIVERY ATTEMPT, UP TO FIVE TIMES.
    // `ok: false` makes the route answer 500, Pub/Sub retries, and
    // `--max-delivery-attempts=5` bounds it — so ONE blocked fortnight now
    // produces up to 5 `transportFailures: 1` outcomes where before MONEY-1328
    // it produced ZERO. That trade is right for the freshness monitor this fix
    // was for (`circulars-sync|36h`, `notify_no_data`), which only needs the
    // series to exist; it is wrong for anything that SUMS the counter, which
    // would read 5x the incidents.
    //
    // So a `transportFailures` alarm on this job must be written as a
    // presence/max over the window, not a sum — or read `deliveryAttempt` off
    // the push envelope and emit only on the first. No monitor sums it today
    // (verified against `apply-monitors.sh`: the only circulars row is the
    // freshness one), which is why this is written down rather than bounded in
    // code: bounding it would mean a live behaviour change to a scheduled job
    // to satisfy a query nobody has written yet.
    report({
      job: "circulars-sync",
      selected: 0,
      written: 0,
      transportFailures: 1,
      skippedReason:
        "fetch returned null — throttle, challenge page or transport error",
    });
    return {
      ok: false,
      parsed: 0,
      rejected: 0,
      written: 0,
      empty: false,
      window,
    };
  }

  const file = parseCircularsResponse(payload);
  if (file === null) {
    // The parser distinguishes THREE outcomes and this is the third: an
    // unrecognised shape. Distinct from `outcome: "EMPTY"` below, which is a
    // successful read of a genuinely empty window.
    logger.error(
      { window },
      "UNRECOGNISED response shape — NOT writing; the payload changed",
    );
    // MONEY-1328 — the second silent exit. NOT a transport failure: NSE
    // answered, and we could not read what it said. `selected: 0` because
    // nothing was recognised well enough to be a candidate, so the
    // zero-write monitor cannot alarm on it — the SKIPPED REASON is the signal
    // here, and it names a payload change rather than a quiet fortnight.
    report({
      job: "circulars-sync",
      selected: 0,
      written: 0,
      skippedReason: "UNRECOGNISED response shape — the payload changed",
    });
    return {
      ok: false,
      parsed: 0,
      rejected: 0,
      written: 0,
      empty: false,
      window,
    };
  }

  if (file.outcome === "EMPTY") {
    // MONEY-1238 — `outcome` is decided by `circulars.length > 0`
    // (circulars-logic.ts:678), and NOTHING about that expression can tell an
    // empty upstream window apart from a window where every record was
    // REJECTED. So a fortnight of 237 records whose shape we no longer
    // understand arrived here as `ok: true, empty: true` under the log line
    // "NSE published no circulars in this window" — the exact conflation the
    // parser's own header forbids ("empty must not collapse into broken"),
    // reintroduced one layer up.
    //
    // Rejections at ZERO accepted is a total parse failure, not a quiet
    // fortnight, and it is the one case worth a retry: nothing was written, the
    // key is (circularNumber, department) so a redelivery is idempotent, and
    // after 5 attempts the dead-letter consumer notifies the founder.
    //
    // WHY THIS KEEPS ITS 500 WHERE `ipo-sync`'s KEY DRIFT GAVE ONE UP —
    // MONEY-1236, reviewed and deliberately NOT changed.
    //
    // The rule "deterministic -> ACK, transient -> NACK" exists to stop a
    // permanent condition burning the retry budget nightly. Two things made this
    // job the exception:
    //
    //   1. `circulars-sync` emitted NO job outcome (unlike ipo-sync, xbrl-sync,
    //      news-sync and the rest). The DEAD-LETTER WAS ITS ONLY PATH TO A
    //      HUMAN. ACKing here would have made a total feed breakage completely
    //      silent, which is the defect this whole ticket family is about — not a
    //      fix for it.
    //   2. The schedule is FORTNIGHTLY, so the wasted budget is five fetches
    //      every two weeks. `ipo-sync` runs daily and its own file already
    //      ACKed the sibling deterministic case (`modelMissing`), so there the
    //      500 was both costly and internally inconsistent.
    //
    // POINT 1 IS NOW HISTORY — MONEY-1238 gave the job an outcome and
    // MONEY-1328 put one on EVERY exit, so a second path to a human exists. The
    // 500 is nevertheless LEFT AS IS: swapping a retry posture is a behaviour
    // change to a scheduled job that belongs to whoever measures the retry
    // budget, not to the ticket that fixed the metric. What has changed is that
    // the choice is now a choice rather than the only option.
    if (file.rejected.length > 0) {
      logger.error(
        { window, rejected: file.rejected.length },
        "TOTAL PARSE FAILURE — NSE returned records and NOT ONE parsed; this " +
          "is NOT an empty window",
      );
      report({
        job: "circulars-sync",
        selected: file.rejected.length,
        written: 0,
        failed: file.rejected.length,
        skippedReason: "TOTAL PARSE FAILURE — records returned, none parsed",
      });
      return {
        ok: false,
        parsed: 0,
        rejected: file.rejected.length,
        written: 0,
        empty: false,
        window,
      };
    }
    logger.warn({ window }, "NSE published no circulars in this window");
    report({ job: "circulars-sync", selected: 0, written: 0 });
    return {
      ok: true,
      parsed: 0,
      rejected: 0,
      written: 0,
      empty: true,
      window,
    };
  }

  const written = await write(file.circulars);
  // `selected` is PARSED circulars. `rejected` rows were refused at the parse
  // boundary and never had a write coming — counting them would alarm on a
  // payload we correctly declined to coerce. An EMPTY window reports selected 0,
  // which is why a holiday fortnight cannot page anyone.
  //
  // This is the reporter that lets the route's 500-on-total-parse-failure become
  // an ACK later: the dead-letter is currently this job's ONLY path to a human
  // (MONEY-1236). With an outcome row it has a second one.
  const result: CircularsSyncResult = {
    ok: true,
    parsed: file.circulars.length,
    rejected: file.rejected.length,
    written,
    empty: false,
    window,
  };
  // A PARTIAL rejection does not fail the run — some malformed rows are normal
  // and the accepted ones are real — but it must not hide inside an `info` line
  // whose headline number is the accepted count. This is the leading edge of the
  // same drift the branch above catches at 100%.
  if (file.rejected.length > 0) {
    logger.warn(
      result,
      `${file.rejected.length} of ${file.circulars.length + file.rejected.length} ` +
        `record(s) REJECTED — rising rejections mean the payload is changing`,
    );
  } else {
    logger.info(result, "done");
  }
  report({
    job: "circulars-sync",
    selected: result.parsed,
    written: result.written,
    failed: result.rejected,
    ...(result.rejected > 0
      ? {
          skippedReason: `${result.rejected} record(s) rejected at the parse boundary`,
        }
      : {}),
  });
  return result;
}
