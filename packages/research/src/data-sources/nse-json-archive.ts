/**
 * Raw NSE JSON archiving — MONEY-1098 (P5.7).
 *
 * The P5 syncs read NSE's cookie-gated JSON APIs (announcements, corporate
 * actions, board meetings, issues, pledges) and write PARSED rows. The raw
 * responses themselves were discarded — which breaks the archive-first rule
 * the file feeds already follow: a parser bug found next month could only be
 * fixed by re-scraping windows NSE may have thinned by then, and QA replay
 * has nothing to replay.
 *
 * This module gives the three NSE JSON fetchers one best-effort hook that
 * lands each MARKET-WIDE response in the same GCS feed archive the file
 * feeds use, keyed `feeds/NSE/api/{family}/{YYYY}/{MM}/{fetch-day}-{slug}.json`.
 * The slug is the sanitized path+query, so a windowed backfill (41
 * corporate-action windows in one afternoon) yields 41 distinct objects, and
 * re-fetching the same window on the same day overwrites idempotently.
 *
 * ## What is deliberately NOT archived
 *
 *   - Per-symbol calls (`symbol=` in the query). The weekly ownership fan-out
 *     alone is ~4 endpoints × ~2,000 symbols; millions of tiny objects whose
 *     content the DB already carries row-by-row is cost without a reader.
 *     Market-wide payloads are the ones a re-parse or replay actually wants.
 *   - Paths outside the family table. The drift guard's `daily-reports` poll
 *     is an index read (already diffed + recorded on the sync log), and an
 *     unknown path has no family to file under — new endpoints get archived
 *     by ADDING a row, not by guessing.
 *
 * ## Retention grammar: this module is DATE-STAMPED, always (MONEY-1195)
 *
 * The core file-feed seam has two grammars — `buildFeedArchiveKey` files a
 * descriptor carrying a `date` under `{YYYY}/{MM}/`, and one WITHOUT a date
 * under `current/`, overwritten in place every run. This module has only the
 * first: every key it builds carries the IST FETCH day. There is no `current/`
 * branch to opt into, and that is deliberate — these are accruing daily series,
 * and a `current/` key would overwrite yesterday's bytes with today's, leaving
 * an archive that holds exactly one day. For the endpoints here that serve only
 * the CURRENT reading (surveillance, FII/DII) those overwritten bytes are the
 * ONLY durable copy in existence, so `current/` would quietly destroy the very
 * history the archive is being kept for.
 *
 * The cost of that choice is real and is MONEY-1194's subject: a date-stamped
 * key ROTATES, so QA's replay can only hit if the prod→QA mirror lands before
 * QA's consumer asks. The `current/` masters replay reliably precisely because
 * their key never rotates. We take the miss:
 *
 *   - A replay miss is DESIGNED to be survivable — `getFeedAsset` falls back to
 *     the exchange and the run succeeds with correct data. It costs one extra
 *     scrape, which is recoverable on any later day by fixing the schedule.
 *   - A day of an unbackfillable series overwritten into `current/` is gone for
 *     good. Not recoverable at any price.
 *
 * Trading a permanent loss for a recoverable inefficiency is the only direction
 * that decision runs. MONEY-1194 owns fixing the schedule; nothing here should
 * pre-empt it.
 *
 * Honors the archive mode: writes only when `FEED_ARCHIVE_MODE=archive` and
 * the worker registered a store (`initFeedArchive`). Everywhere else —
 * Vercel, local dev, QA replay — it is a no-op, so the fetchers' never-throw
 * contract is untouched.
 */

import {
  FEED_ARCHIVE_WRITE_TIMEOUT_MS,
  getFeedArchiveStore,
  resolveFeedArchiveMode,
} from "@usemoney/core/market-data";

const logger = {
  warn: (...args: unknown[]) => console.warn("[nse-json-archive]", ...args),
};

/** IST is UTC+05:30 with no DST — a constant offset, so arithmetic is exact. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Outcome tallies for JSON archiving, mirroring `FeedArchiveCounters` in the
 * core seam.
 *
 * Without these a bucket-IAM gap is invisible: every `put` fails, every
 * warning goes to a log nobody greps, all five nightly jobs finish green, and
 * `feeds/NSE/api/` stays empty for weeks while NSE thins its archive. Counted
 * outcomes are what MONEY-1157 added to the file feeds for the same reason —
 * a processor can diff these across a run and put the delta on its sync log.
 */
export interface NseJsonArchiveCounters {
  archived: number;
  failed: number;
  timedOut: number;
  /** Path matched no family, or was per-symbol — deliberately not archived. */
  skipped: number;
}

let counters: NseJsonArchiveCounters = {
  archived: 0,
  failed: 0,
  timedOut: 0,
  skipped: 0,
};

export function readNseJsonArchiveCounters(): NseJsonArchiveCounters {
  return { ...counters };
}

export function resetNseJsonArchiveCounters(): void {
  counters = { archived: 0, failed: 0, timedOut: 0, skipped: 0 };
}

/**
 * `/api/` path prefix → archive family. First match wins; longest prefixes
 * first where one shadows another.
 */
const FAMILY_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["corporates-corporateActions", "corporate-actions"],
  ["corporate-announcements", "announcements"],
  ["corporate-board-meetings", "board-meetings"],
  ["event-calendar", "event-calendar"],
  ["all-upcoming-issues", "issues"],
  ["ipo-current-issue", "issues"],
  ["public-past-issues", "issues"],
  ["integrated-filing-results", "integrated-filings"],
  ["corporate-pledgedata", "pledge"],
  // MONEY-1189 — surveillance. These two endpoints serve ONLY the current
  // list (no date parameter, no history), so archiving forward is the only
  // way depth is ever acquired: a day not archived is a day permanently
  // unrecoverable, unlike the dated CSV families which can be re-walked.
  ["reportASM", "surveillance-asm"],
  ["reportGSM", "surveillance-gsm"],
  // MONEY-1195 — FII/DII daily institutional cash-market flows.
  //
  // This endpoint is MARKET-WIDE: one small row set describing the WHOLE
  // market for a day, not a per-symbol fan-out. So it is not touched by the
  // `symbol=` exclusion above, and it is precisely the shape this archive
  // exists for — which is why the gap was worth its own ticket rather than
  // being folded into MONEY-1193's per-symbol sweep.
  //
  // The family row has to come FIRST, before any fetcher calls the seam.
  // `archiveNseJsonResponse` files by TABLE, not by guess: an unmatched path
  // returns a null key, takes the `skipped++` branch and returns normally, so
  // wiring the seam into the fetcher WITHOUT this row would have reported
  // success while writing nothing anywhere. That is the same silent-no-op
  // failure shape MONEY-1193 was about, so it must not be reintroduced by the
  // ticket that cites it.
  ["fiidiiTradeReact", "fii-dii"],
  // MONEY-1198 — the exchange's OWN top gainers/losers, plus the live
  // whole-market index snapshot.
  //
  // Market-wide by construction: ONE ~35 KB response carries all seven of
  // NSE's buckets (NIFTY … allSec), and `/api/allIndices` carries all 139
  // indices in one body. No `symbol=` anywhere, so the per-symbol exclusion
  // above does not apply and these are exactly the shape this archive is for.
  //
  // The row must exist BEFORE the fetcher runs, for the reason spelled out on
  // fii-dii directly above: an unmatched path returns a null key, takes the
  // `skipped++` branch and returns normally, so the job would report success
  // while archiving nothing. Same silent-no-op the FII/DII leg had to have its
  // own ticket for.
  //
  // NOTE ON INTRADAY OVERWRITE, which is deliberate and worth knowing. This
  // module keys on the IST FETCH DAY plus a slug of path+query, and the query
  // is constant across a session ("?index=gainers"), so all ~100 polls of one
  // day write the SAME key and the archive retains the LAST snapshot of each
  // day rather than every poll. That is accepted: the accruing store for
  // intraday granularity is `market_movers` (one row per bucket/symbol/day,
  // carrying `snapshotAt`), and the archive's job here is re-parse insurance
  // plus the closing picture. Do not "fix" it by folding a clock reading into
  // the path — the path is the REQUEST, and changing it changes what we ask
  // NSE for.
  ["live-analysis-variations", "movers"],
  ["allIndices", "index-live"],
];

/**
 * Archive key for a market-wide NSE JSON response, or null when the path is
 * per-symbol, unknown, or not an `/api/` path. Pure — the falsifiable part.
 */
export function nseJsonArchiveKey(
  path: string,
  fetchedAt: Date,
): string | null {
  if (!path.startsWith("/api/")) return null;
  // Per-symbol fan-outs are deliberately excluded — see the header.
  if (/[?&]symbol=/.test(path)) return null;
  const rest = path.slice("/api/".length);
  const family = FAMILY_BY_PREFIX.find(([prefix]) =>
    rest.startsWith(prefix),
  )?.[1];
  if (!family) return null;

  // IST calendar day, not UTC. The core feed archive keys on IST after
  // MONEY-1157 removed exactly this drift, and an Indian trading day is what
  // these payloads describe. On UTC, every run between 00:00 and 05:29 IST —
  // the 04:30 corp-actions slot, any overnight Pub/Sub retry — filed under the
  // PREVIOUS day (and, at a month boundary, the previous month's prefix),
  // which breaks this module's own same-day-overwrite idempotency promise.
  const ist = new Date(fetchedAt.getTime() + IST_OFFSET_MS);
  const iso = ist.toISOString().slice(0, 10);
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  // Sanitized path+query keeps windowed backfills distinct (the date params
  // survive into the slug) and stays readable in a bucket listing.
  const slug = rest
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `feeds/NSE/api/${family}/${yyyy}/${mm}/${iso}-${slug}.json`;
}

/**
 * Best-effort archive of a successful NSE JSON response. Never throws, never
 * slows a fetch beyond the archive write deadline, and is a no-op unless the
 * archive is armed and registered. Callers pass the RAW text (not the parsed
 * object) so the archived bytes are exactly what NSE served.
 */
export async function archiveNseJsonResponse(
  path: string,
  text: string,
): Promise<void> {
  try {
    if (resolveFeedArchiveMode() !== "archive") return;
    const store = getFeedArchiveStore();
    if (!store) return;
    const key = nseJsonArchiveKey(path, new Date());
    if (!key) {
      counters.skipped++;
      return;
    }

    // Bounded: an archive stall must not eat a scheduled job's ack budget.
    // On timeout the write is abandoned; its eventual rejection is swallowed.
    // `settled` absorbs both outcomes so it can NEVER reject: a write
    // abandoned at the deadline would otherwise surface as an unhandled
    // rejection when it fails minutes later, and a fast rejection would be
    // counted twice (once by the race throwing, once by a trailing .catch).
    const settled = store
      .put(key, Buffer.from(text, "utf8"), "application/json")
      .then(
        () => "ok" as const,
        (err: unknown) => {
          logger.warn(
            `NSE JSON archive PUT failed for ${key}:`,
            err instanceof Error ? err.message : err,
          );
          return "failed" as const;
        },
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(
        () => resolve("timeout"),
        FEED_ARCHIVE_WRITE_TIMEOUT_MS,
      );
    });
    const outcome = await Promise.race([settled, deadline]).finally(() =>
      clearTimeout(timer),
    );
    if (outcome === "timeout") {
      counters.timedOut++;
      logger.warn(`NSE JSON archive timed out for ${key}`);
    } else if (outcome === "failed") {
      counters.failed++;
    } else {
      counters.archived++;
    }
  } catch (err) {
    counters.failed++;
    logger.warn(
      "NSE JSON archive failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
