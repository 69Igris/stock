/**
 * FII/DII daily institutional flow sync — MONEY-1108 (P8d).
 *
 * ## What this job is
 *
 * The ingestion half of the "FII/DII bought/sold today" sentiment datum. NSE
 * publishes provisional cash-market figures for each institutional category at
 * `/api/fiidiiTradeReact`; this job fetches them once a day, parses them with
 * the pure `parseFiiDiiReport`, and upserts `InstitutionalFlow` rows keyed on
 * (date, category, segment). Derivables — flow streaks, the flow-vs-Nifty
 * overlay, monthly aggregates — all read that table; none of them belong here.
 *
 * ## Why DAILY, and why a miss is unrecoverable
 *
 * The endpoint takes NO date parameter. It serves TODAY's reading and nothing
 * else: there is no window to walk, no `from_date`/`to_date`, and no archive
 * page to re-scrape. A day we do not fetch is a day that never enters the
 * record — the exact property that makes `surveillance-sync` daily and
 * prod-only (MONEY-1189 P4.5), and the reason the SCHEDULE carries more risk in
 * this feature than the parser does.
 *
 * It is also why the raw bytes are archived. `fetchNseApiJson` files every
 * market-wide response under `feeds/NSE/api/fii-dii/` (the family added by
 * MONEY-1195, which is a hard prerequisite of this ticket — without that row
 * the archive call would file nothing while reporting success). If this parser
 * ever needs re-running, those bytes are the only durable copy that will exist.
 *
 * ## Why it is PROD-ONLY
 *
 * It scrapes nseindia.com directly, and the standing rule is that rate-limited
 * scraped sources run on prod only, with QA fed by the mirror. The table
 * `institutional_flows` is market-wide with no `instrumentId` foreign key, so —
 * unlike `daily_prices` — it can be copied down wholesale by
 * `sync-prod-to-qa.sh` without QA's own ObjectIds being disturbed. It is listed
 * in that script's REFERENCE_COLLECTIONS allowlist; without that line QA's copy
 * would stay permanently empty while this comment insisted otherwise, which is
 * exactly how `shareholding_patterns` and `index_memberships` were missed.
 *
 * ## Idempotency
 *
 * `InstitutionalFlow` carries a unique on (date, category, segment) — the
 * OPPOSITE call from `StockFlag`, which forbids one because consecutive days
 * ARE its datum. Here each key is a single scalar reading, so a re-run must
 * overwrite. Upserting on that unique makes a Pub/Sub redelivery a no-op
 * instead of doubling the day's flows in every aggregate built on them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO(MONEY-1108) — THE NSDL FPI LEG IS NOT IMPLEMENTED. DO NOT GUESS IT.
 *
 * The ticket names NSDL's fortnightly sector-wise FPI data as a second source.
 * It is deliberately absent, not overlooked, and shipping a guessed fetcher for
 * it would be worse than shipping nothing: a wrong URL 404s IDENTICALLY to a
 * non-publication day, so the leg would return zero rows forever and every log
 * line would read as success. That is the same silent-no-op failure this
 * ticket's own prerequisite (MONEY-1195) exists to prevent.
 *
 * What is actually unknown:
 *   - The endpoint. There is no NSDL code anywhere in this repo (verified by a
 *     tree-wide grep, 2026-08-13) — no URL, no client, no fixture. Nothing to
 *     copy the shape from.
 *   - The transport. NSDL's FPI monitor publishes as downloadable reports
 *     rather than a JSON API, so this may be a FILE feed belonging to
 *     `getFeedAsset` + `REPORT_REGISTRY` (a `FeedDescriptor` with an exchange,
 *     a feed slug and a basename) rather than to `archiveNseJsonResponse`.
 *     Those are different seams with different archive grammars, and picking
 *     the wrong one is not a small refactor.
 *   - The cadence and the period semantics. "Fortnightly, sector-wise" does not
 *     map onto this table: rows here are one scalar per (day, category,
 *     segment), with no sector dimension and no period-END vs period-COVERED
 *     distinction. Storing a fortnight's sector breakdown would need either a
 *     `sector` column and a period model, or its own table.
 *
 * How to unblock it: capture one real NSDL response (the report URL and its
 * content type) the way MONEY-1097 captured NSE's, decide file-feed vs JSON-API
 * from what comes back, then model the period/sector dimension explicitly. Only
 * then write the fetcher.
 *
 * The NSE cash leg below is complete and independently useful, which is why it
 * ships alone rather than waiting.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import {
  dedupeFlowRows,
  parseFiiDiiReport,
  type InstitutionalFlowRow,
} from "@usemoney/core/market-data";

const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[institutional-flow-sync] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[institutional-flow-sync] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[institutional-flow-sync] ${msg}`, data),
};

/** NSE's provisional cash-market FII/DII endpoint. Market-wide, undated. */
const FII_DII_PATH = "/api/fiidiiTradeReact";

/** IST is UTC+05:30 with no DST, so the trading day is exact arithmetic. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC midnight of the current IST calendar day. */
function istToday(): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

export interface InstitutionalFlowSyncResult {
  ok: boolean;
  /** Rows the parser accepted. */
  parsed: number;
  /** Rows the parser dropped (unknown category, non-finite money). */
  skipped: number;
  /** Rows written after collapsing duplicate keys. */
  written: number;
  /** Distinct IST trading days present in this payload, for the run log. */
  days: string[];
}

/**
 * Upsert one row per (date, category, segment).
 *
 * Sequential rather than a `createMany`: the payload is ~2 rows on an ordinary
 * day (one FII, one DII) and at most a few dozen if NSE serves a window, so
 * there is nothing to batch. `createMany` would also be wrong — it cannot
 * overwrite, and overwriting is the whole idempotency story here.
 */
async function writeFlows(
  rows: readonly InstitutionalFlowRow[],
): Promise<number> {
  let written = 0;
  for (const row of rows) {
    await prisma.institutionalFlow.upsert({
      where: {
        date_category_segment: {
          date: row.date,
          category: row.category,
          segment: row.segment,
        },
      },
      create: {
        date: row.date,
        category: row.category,
        segment: row.segment,
        buyValue: row.buyValue,
        sellValue: row.sellValue,
        netValue: row.netValue,
        source: row.source,
      },
      // A same-day re-run refreshes the figures: NSE's numbers are PROVISIONAL
      // and it does revise them, so the later reading is the better one.
      update: {
        buyValue: row.buyValue,
        sellValue: row.sellValue,
        netValue: row.netValue,
        source: row.source,
      },
    });
    written++;
  }
  return written;
}

/**
 * The three collaborators, injectable — MONEY-1328.
 *
 * Defaults ARE the production path, so the route passes nothing and behaves
 * exactly as before. The shape mirrors `CircularsSyncDeps` and
 * `CorporateActionsSyncDeps` for the reason `corporate-actions-sync` states:
 * a source scan can prove the report SITS above a `return`, and only running
 * the function proves it EXECUTES — and this job's two refusal exits are
 * unreachable from a test that cannot replace the fetch or observe the
 * emission.
 */
export interface InstitutionalFlowSyncDeps {
  fetchJson?: (path: string) => Promise<unknown>;
  write?: (rows: readonly InstitutionalFlowRow[]) => Promise<number>;
  reportOutcome?: typeof reportJobOutcome;
}

export async function processInstitutionalFlowSync(
  deps: InstitutionalFlowSyncDeps = {},
): Promise<InstitutionalFlowSyncResult> {
  const fetchJson = deps.fetchJson ?? ((p: string) => fetchNseApiJson(p));
  const write = deps.write ?? writeFlows;
  const report = deps.reportOutcome ?? reportJobOutcome;
  const day = istToday();

  /**
   * MONEY-1328 — the run's outcome, mutated in place and emitted from the
   * `finally` below, so EVERY exit reports.
   *
   * This job gets the STRONGEST shape rather than a per-branch emit, and the
   * reason is the property stated at the top of this file: the endpoint takes
   * no date parameter and serves only the current reading, so **a day that goes
   * silent never enters the record and nothing afterwards can tell that it
   * did**. Before this, both refusal exits returned having emitted nothing —
   * so a day NSE blocked us and a day the schedule never fired produced the
   * identical (empty) Datadog series, and neither could be told from a market
   * holiday. That is the `stock-document-extract` defect (MONEY-1255) on the
   * one job in this directory whose data cannot be re-fetched later.
   *
   * `ok` starts FALSE. A run that dies between here and the end of the `try`
   * must not report itself successful on the way out.
   */
  const result: InstitutionalFlowSyncResult = {
    ok: false,
    parsed: 0,
    skipped: 0,
    written: 0,
    days: [],
  };
  let transportFailures = 0;
  let skippedReason: string | undefined;

  try {
    const payload = await fetchJson(FII_DII_PATH);
    if (payload === null) {
      // fetchNseApiJson maps a throttle, an HTML challenge page and a transport
      // error alike to null. Never write on a null: "no institutional flows
      // today" is a meaningful claim about the market, and a failed fetch has no
      // business making it.
      logger.error({ path: FII_DII_PATH }, "fetch returned null — NOT writing");
      // Counted as a TRANSPORT failure, not a row failure: nothing was
      // selected, so there is no row we could not persist — there is an
      // upstream that did not answer (MONEY-1250).
      transportFailures = 1;
      skippedReason =
        "fetch returned null — throttle, challenge page or transport error";
      return result;
    }

    const out = parseFiiDiiReport(payload, day);
    result.skipped = out.skipped;
    if (out.rows.length === 0) {
      // Zero rows from a 200 means either NSE changed the payload shape or it
      // served an empty body. Both are failures, not holidays — the scheduler
      // already skips weekends, and a real trading day always has both
      // categories. Returning ok:false lets Pub/Sub retry while the previous
      // day's rows stay untouched.
      logger.error(
        { path: FII_DII_PATH, skipped: out.skipped },
        "parsed to ZERO rows — NOT writing; check the payload shape",
      );
      skippedReason =
        "parsed to ZERO rows from a 200 — the payload shape changed";
      return result;
    }

    const rows = dedupeFlowRows(out.rows);
    const written = await write(rows);
    const days = [
      ...new Set(rows.map((r) => r.date.toISOString().slice(0, 10))),
    ];

    result.ok = true;
    result.parsed = out.rows.length;
    result.written = written;
    result.days = days.sort();
    logger.info(result, "done");
    return result;
  } finally {
    // `selected` is PARSED rows — the ones that should reach the table.
    // `skipped` (unknown category, non-finite money) never had a write coming,
    // so counting it as SELECTED would alarm on a payload the parser correctly
    // rejected. Both refusal exits above leave `parsed` at 0, so an NSE block
    // reports `selected 0 / written 0` and cannot page anyone on the
    // zero-write rule — the SKIPPED REASON and `transportFailures` are what
    // separate it from a genuinely quiet day.
    report({
      job: "institutional-flow-sync",
      selected: result.parsed,
      written: result.written,
      failed: result.skipped,
      transportFailures,
      ...(skippedReason ? { skippedReason } : {}),
    });
  }
}
