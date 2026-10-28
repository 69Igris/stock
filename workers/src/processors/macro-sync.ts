/**
 * Macro series sync — RBI / MOSPI / OEA (MONEY-1106, Data Engine P8b).
 *
 * I/O only. The source registry, both HTML parsers, the label map and the
 * freshness judgement are pure and unit-tested in
 * `@usemoney/core/market-data/macro-series`; this file fetches, writes, and
 * reports.
 *
 * ## Archive-first, and why it matters MORE here than for a bhavcopy
 *
 * Every page goes through `getFeedAsset`, so prod archives the raw HTML to
 * `feeds/RBI/{nsdp-*}/{YYYY}/{MM}/` and QA replays those exact bytes instead of
 * scraping RBI a second time (MONEY-1085).
 *
 * The bhavcopies are date-addressable: a missed day can always be re-walked
 * from NSE. These pages cannot. They serve a rolling window and nothing else —
 * measured 2026-08-13: 6 week-ended columns on the rates page, 3 months on the
 * prices page, and exactly ONE "as on" column on the forex page. So for forex
 * in particular, a week whose bytes we never captured is a week that does not
 * exist for us afterwards. The archive is the only durable copy, which is the
 * same argument surveillance-sync makes for NSE's live JSON reports.
 *
 * The key is DATED (not `current/`) even though the URL carries no date: the
 * page's content changes weekly and an undated key would overwrite the only
 * copy of last week's bytes on every run. `report-registry.ts` calls this the
 * `rolling` case and makes the same choice for the index-constituent lists.
 *
 * ## Failure, empty, and stale are three different outcomes
 *
 * Deliberate, and the reason this ticket was written the way it was:
 *
 *   fetched: false          the page did not come back (404 / throttle / throw).
 *                           NOTHING is written. A fetch failure must never be
 *                           allowed to assert "no observations this week".
 *   rows: 0, fetched: true  the page parsed and yielded no series we track —
 *                           real, reportable, and NOT ok (it means the table
 *                           moved under us).
 *   parsed: null            the page had no recognisable table at all. Also not
 *                           ok, and distinguished from the line above so the
 *                           log says which of the two happened.
 *   written < parsed        the page was read correctly and MongoDB refused
 *                           some or all of it — MONEY-1238, see below.
 *   freshness: STALE        the page returned fine and its newest period is old.
 *
 * All but the last set `ok = false`, so the route 500s and Pub/Sub retries.
 * STALE deliberately does NOT: a retry cannot un-freeze a discontinued page,
 * and a permanently-500ing job is how a retry storm starts. It is logged at
 * error level and surfaced in the result instead. See `judgeMacroFreshness` for
 * why the guard exists at all (nine NSDP tables serve 2012 data under a 200).
 *
 * ## `written` reaches the verdict — MONEY-1238
 *
 * `ok` used to be `fetched && recognised && parsed > 0`, three fetch/parse
 * properties and nothing about the write. `written` was computed, logged,
 * returned, and consulted by nobody, so a run in which every upsert threw
 * reported `written: 0, parsed: 90, ok: true` under a 200. The verdict now
 * lives in `macro-sync-logic.ts` and reads `written` and `writeFailed`; the
 * whole argument, including why a PARTIAL write is not ok on a page that serves
 * one non-backfillable column, is in that module's header.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import {
  MACRO_SOURCES,
  RBI_REFERER,
  emptyFeedAssetOutcome,
  getFeedAsset,
  judgeMacroFreshness,
  parseMacroSource,
  selectMacroSources,
  type MacroFreshness,
  type MacroObservation,
  type MacroSource,
} from "@usemoney/core/market-data";
import type { MacroSyncMessage } from "@usemoney/types/pubsub";
import { macroFailureReasons, macroRunOk } from "./macro-sync-logic";

const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[macro-sync] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[macro-sync] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[macro-sync] ${msg}`, data),
};

/** Per-source outcome. Every field is something a run can be judged on. */
export interface MacroSourceResult {
  sourceId: string;
  /** Bytes came back (from the archive or from RBI). */
  fetched: boolean;
  /** The page carried a recognisable table. False ⇒ the parser returned null. */
  recognised: boolean;
  /** Observations parsed out of the page. */
  parsed: number;
  /**
   * Value cells rejected at the parse boundary WITHIN A MAPPED ROW (an absence
   * marker, a bad date). A row we do not track is filtered by LABEL and its
   * cells are never read, so it lands in `unmapped` instead — keeping the two
   * apart is what makes a rising `skipped` mean "a series we follow started
   * publishing something unusable" rather than background noise.
   */
  skipped: number;
  /** Rows upserted (created + updated). A re-ingest makes this a no-op, not a gap. */
  written: number;
  /**
   * Rows whose upsert THREW — MONEY-1238.
   *
   * Its own field rather than `parsed - written`, because those two differ for
   * a second, innocent reason (a row the writer never reached) and collapsing
   * the two would make a DB refusal indistinguishable from an early return.
   * The rule this repo keeps re-learning: "couldn't determine" gets its own
   * value.
   */
  writeFailed: number;
  freshness: MacroFreshness;
  /** ISO day of the newest observation, for the log line. */
  newestPeriod: string | null;
  /** Row labels the page carried that we do not map — bounded, for triage. */
  unmapped: string[];
}

export interface MacroSyncResult {
  ok: boolean;
  sources: MacroSourceResult[];
}

/** UTC midnight of the current IST calendar day — the archive key's day. */
function istToday(): Date {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/**
 * Upsert observations on (seriesId, period).
 *
 * Sequential rather than a `createMany`: these pages yield tens of rows, not
 * thousands (90 + 24 + 10 on 2026-08-13), and `createMany` would throw the
 * whole batch on the FIRST unique collision — which, given the overlapping
 * rolling windows, is the normal case rather than an error.
 *
 * One row's failure never aborts the source: a partial write that reports
 * itself is strictly better than an all-or-nothing that reports a clean zero.
 *
 * "Reports itself" is now literal — MONEY-1238. The failure count is RETURNED
 * rather than only logged, because a number that reaches the caller can reach
 * the verdict and a `logger.error` cannot.
 */
async function writeObservations(
  rows: readonly MacroObservation[],
  releasedOn: Date | null,
): Promise<{ written: number; failed: number }> {
  let written = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await prisma.macroSeries.upsert({
        where: {
          seriesId_period: { seriesId: row.seriesId, period: row.period },
        },
        create: {
          seriesId: row.seriesId,
          period: row.period,
          value: row.value,
          unit: row.unit,
          frequency: row.frequency,
          source: row.source,
          label: row.label,
          releasedOn,
        },
        update: {
          // A revision IS expected: RBI restates provisional figures (CPI and
          // the reserves in particular) in later releases, so the newest read
          // of a period wins rather than the first.
          value: row.value,
          unit: row.unit,
          frequency: row.frequency,
          source: row.source,
          label: row.label,
          releasedOn,
        },
      });
      written++;
    } catch (err) {
      failed++;
      logger.error(
        { seriesId: row.seriesId, period: row.period.toISOString(), err },
        "upsert failed for one observation — continuing",
      );
    }
  }
  return { written, failed };
}

/** Fetch + parse + write ONE source. Never throws. */
async function syncSource(
  source: MacroSource,
  day: Date,
  now: Date,
): Promise<MacroSourceResult> {
  const empty: MacroSourceResult = {
    sourceId: source.id,
    fetched: false,
    recognised: false,
    parsed: 0,
    skipped: 0,
    written: 0,
    writeFailed: 0,
    freshness: "UNKNOWN",
    newestPeriod: null,
    unmapped: [],
  };

  let html: string;
  try {
    const outcome = emptyFeedAssetOutcome();
    const res = await getFeedAsset(
      source.url,
      RBI_REFERER,
      {
        exchange: "RBI",
        // Declared on the source, never derived here — see MacroSource.archiveFeed
        // for what a drift between this and `feed-payload.ts` would silently cost.
        feed: source.archiveFeed,
        date: day,
        // The URL is a query-parameterised .aspx route with no filename, so
        // without this the archive object would be named `BS_NSDPDisplay.aspx`
        // plus a query digest and `feedContentType` could not infer text/html.
        basename: `${source.id}.html`,
      },
      outcome,
    );

    if (res === null) {
      // getFeedAsset maps 404 → null. For a dated exchange file that means
      // "non-trading day"; for a FIXED RBI page it means the page moved. Either
      // way it is NOT data, so nothing is written and the run is not ok.
      logger.error(
        { source: source.id, url: source.url },
        "fetch returned null (404) — the page moved; NOT writing",
      );
      return empty;
    }
    if (outcome.rejected) {
      // The bytes failed `validateFeedPayload`, i.e. RBI answered 200 with
      // something that is not this table. The ingest could continue on them,
      // but it would only find no rows — say so plainly instead.
      //
      // NOTE this fires only when the archive is ARMED (`FEED_ARCHIVE_MODE`,
      // unset in both Cloud Run specs today), because that check runs on the
      // write path. It is a second line of defence, not the only one: in
      // passthrough mode the same bad payload reaches the parser, which finds
      // no `class="tablebg"` and returns null — reported below as "no
      // recognisable table". Both roads lead to a loud failure and no write.
      logger.error(
        { source: source.id },
        "payload rejected by the feed sanity check — not this table",
      );
      return empty;
    }
    html = await res.text();
  } catch (err) {
    logger.error({ source: source.id, err }, "fetch threw — NOT writing");
    return empty;
  }

  const parsed = parseMacroSource(source, html);
  if (parsed === null) {
    logger.error(
      { source: source.id, bytes: html.length },
      "page has no recognisable table — RBI changed the layout or the page is empty",
    );
    return { ...empty, fetched: true };
  }

  const freshness = judgeMacroFreshness(
    parsed.newestPeriod,
    now,
    source.maxAgeDays,
  );
  const base: MacroSourceResult = {
    sourceId: source.id,
    fetched: true,
    recognised: true,
    parsed: parsed.rows.length,
    skipped: parsed.skipped,
    written: 0,
    writeFailed: 0,
    freshness,
    newestPeriod: parsed.newestPeriod
      ? parsed.newestPeriod.toISOString().slice(0, 10)
      : null,
    unmapped: parsed.unmapped,
  };

  if (parsed.rows.length === 0) {
    logger.error(
      { source: source.id, unmapped: parsed.unmapped, skipped: parsed.skipped },
      "table parsed but matched ZERO tracked series — the row labels moved",
    );
    return base;
  }

  if (freshness === "STALE") {
    // Reported, not retried. See the module header.
    logger.error(
      {
        source: source.id,
        newestPeriod: base.newestPeriod,
        maxAgeDays: source.maxAgeDays,
      },
      "STALE: the page returned fine but its newest observation is older than " +
        "this source's threshold. RBI has ~9 NSDP tables frozen since 2012 " +
        "that still answer 200 — check whether this one joined them.",
    );
  }

  const { written, failed } = await writeObservations(
    parsed.rows,
    parsed.releaseDate,
  );
  if (written < parsed.rows.length) {
    // Loud on its own line, because the verdict below turns this into a 500 and
    // an operator reading the retry needs to know it was the WRITE, not RBI.
    logger.error(
      {
        source: source.id,
        parsed: parsed.rows.length,
        written,
        writeFailed: failed,
      },
      "the page was read correctly and not every observation was stored — " +
        "these pages are rolling windows and the forex page serves ONE 'as on' " +
        "column, so an un-stored week is not recoverable later",
    );
  }
  return { ...base, written, writeFailed: failed };
}

export async function processMacroSync(
  message: MacroSyncMessage = {},
): Promise<MacroSyncResult> {
  const sources = selectMacroSources(message.sourceIds);
  if (sources.length === 0) {
    // Only reachable when the caller named ids that match nothing. Loud,
    // because the alternative reading ("nothing to do") is wrong: the operator
    // asked for something specific and got silence.
    logger.error(
      { requested: message.sourceIds, known: MACRO_SOURCES.map((s) => s.id) },
      "no source matched the requested ids — nothing was fetched",
    );
    reportJobOutcome({
      job: "macro-sync",
      selected: 0,
      written: 0,
      failed: 1,
      skippedReason: "no sources resolved",
    });
    return { ok: false, sources: [] };
  }

  const day = istToday();
  const now = new Date();
  const results: MacroSourceResult[] = [];

  // Sequential on purpose. Three requests to one government host, and pacing
  // them is free — the whole run is under a second of network time either way.
  for (const source of sources) {
    results.push(await syncSource(source, day, now));
  }

  // MONEY-1238 — the verdict reads `written`/`writeFailed` as well as the
  // fetch/parse fields. The old expression was
  //   results.every((r) => r.fetched && r.recognised && r.parsed > 0)
  // which is `ok: true` for a source that parsed 90 rows and stored none.
  const ok = macroRunOk(results);
  if (!ok) {
    logger.error(
      { failures: macroFailureReasons(results) },
      "run NOT ok — the route will 500 and Pub/Sub will redeliver; the upsert " +
        "is keyed on (seriesId, period) so a redelivery re-writes the same rows",
    );
  }
  logger.info({ sources: results, ok }, "done");
  // Summed across sources. `parsed` is observations the parser accepted and
  // `written` is what the upsert landed. A source that could not be FETCHED, or
  // whose page was not RECOGNISED, contributes 0 to both and is counted as
  // failed — so an RBI layout change reports selected 0 / failed N rather than
  // looking like a quiet day.
  reportJobOutcome({
    job: "macro-sync",
    selected: results.reduce((n, r) => n + r.parsed, 0),
    written: results.reduce((n, r) => n + r.written, 0),
    failed: results.filter((r) => !r.fetched || !r.recognised).length,
    ...(ok ? {} : { skippedReason: macroFailureReasons(results).join("; ") }),
  });
  return { ok, sources: results };
}
