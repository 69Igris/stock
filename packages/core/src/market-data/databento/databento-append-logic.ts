/**
 * What the daily append should ask for — MONEY-1373. Pure: no I/O, no clock.
 *
 * The append extends what the harvest bought. Everything hard about it is the
 * gap arithmetic, and every part of that is a place where being wrong produces
 * a run that SUCCEEDS and does the wrong amount of work:
 *
 *   - asking for a session the vendor has not published yet returns an empty
 *     result, which is indistinguishable from a market holiday and from a
 *     broken query;
 *   - asking again for a session we already hold spends money on bytes we have;
 *   - and skipping a session because the previous run died leaves a hole that
 *     no count can see, because the next run's high-water mark has already
 *     moved past it.
 *
 * So the gap is computed from THREE facts, never two: our own high-water mark,
 * the US market calendar, and what the vendor says it holds.
 */

import {
  US_POST_CLOSE_MINUTES,
  isUsTradingDay,
  lastCompletedUsSession,
  usMarketDayBoundsUtc,
} from "../us-market-hours";

/**
 * How many sessions one execution may buy.
 *
 * A cap, not a target. After a long outage the honest response is to catch up
 * over several runs rather than to submit one enormous window: the append's
 * Cloud Run job is sized for a day, the budget guard REFUSES rather than
 * trimming, and a refusal on night one leaves the whole backlog unbought.
 * Oldest-first, so the gap closes from the far end and the series never has a
 * hole in the middle.
 */
export const DEFAULT_MAX_APPEND_SESSIONS = 30;

export type AppendSkipReason =
  /** Nothing has ever been loaded for this entry — the harvest has not run. */
  | "NO_HWM_RUN_HARVEST_FIRST"
  /** We already hold every session the calendar says exists. */
  | "UP_TO_DATE"
  /** The session exists on the calendar but the vendor has not released it. */
  | "NOT_YET_PUBLISHED"
  /**
   * Work WAS planned and submitted; the vendor had not finished within
   * `--max-wait-min`.
   *
   * Distinct from the three above because it is the only one that follows a
   * SPEND. The retry run resumes from the inventory; nothing is re-bought.
   */
  | "POLL_TIMEOUT";

/**
 * `ok` is an explicit discriminant rather than a `sessions.length` test.
 *
 * TypeScript cannot narrow `string[]` from `[]` on a length comparison, so a
 * caller writing `if (gap.sessions.length === 0)` would still see the union on
 * both sides and reach for `startMs` on the skip branch. A tag makes the two
 * shapes actually distinguishable at the call site.
 */
export type AppendGap =
  | {
      ok: true;
      sessions: string[];
      startMs: number;
      endMsExclusive: number;
      /** Sessions left over after the cap, for the log line. */
      deferred: number;
    }
  | { ok: false; sessions: []; skipReason: AppendSkipReason };

const DAY_MS = 86_400_000;

/** The next calendar date key after `dateKey`, in the ET calendar's own terms. */
function nextDateKey(dateKey: string): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The latest session the VENDOR has fully published.
 *
 * `datasetRangeEndUtcMs` is EXCLUSIVE — stated verbatim in the vendor's own
 * typed client ("The exclusive UTC end timestamp of the available range"). So a
 * session counts as available only when its END bound is at or before that
 * instant; treating the range end as inclusive would claim one session more
 * than exists every single night, and the empty result it fetched would read as
 * a quiet market.
 *
 * Walks back from the calendar's last completed session rather than forward
 * from the range end, so a vendor that is far behind still yields an answer
 * without an unbounded loop.
 */
function latestAvailableSession(
  lastCompleted: string,
  datasetRangeEndUtcMs: number,
  maxLookbackDays = 400,
): string | null {
  let key = lastCompleted;
  for (let i = 0; i < maxLookbackDays; i++) {
    // AVAILABLE means the vendor holds the session's WHOLE DATA DAY — through
    // 20:00 ET, the post-market close — not merely its regular close, and not
    // the ET calendar day end.
    //
    // Three instants that are easy to confuse, for one Friday:
    //   16:00 ET   the regular close
    //   20:00 ET   US_POST_CLOSE_MINUTES — the LAST INSTANT THAT CAN CARRY A BAR
    //   24:00 ET   `usMarketDayBoundsUtc().endMs`, our session key's boundary
    //
    // Testing against 24:00 ET judged every newest published session
    // unavailable and the append would have lagged one session behind the
    // vendor FOREVER (measured: hwm Thursday, vendor through Friday, verdict
    // NOT_YET_PUBLISHED) — because the vendor's range end sits at UTC
    // MIDNIGHT, which is 20:00 EDT and 19:00 EST, never 24:00 ET.
    //
    // Testing against 16:00 ET fixed that and introduced a quieter one. In EST
    // the vendor's UTC midnight is 19:00 ET, an hour INSIDE the data day, so
    // the request was clamped short of the session while the high-water mark
    // advanced past it — losing 19:00-20:00 ET on every winter session,
    // permanently and invisibly (`reportCoverage` counts sessions with at
    // least one bar).
    //
    // 20:00 ET is the honest test: it is exactly the data day, so a session
    // that passes it can be bought WHOLE, and one that does not is genuinely
    // not published yet and is simply picked up by the next run. In EDT the
    // vendor's midnight IS 20:00 ET, so nothing waits; in EST a session
    // becomes available one calendar day later, which is a lag in the vendor's
    // publishing rather than one in this code.
    if (
      isUsTradingDay(key) &&
      usMarketDayBoundsUtc(key).startMs + US_POST_CLOSE_MINUTES * 60_000 <=
        datasetRangeEndUtcMs
    ) {
      return key;
    }
    key = new Date(Date.parse(`${key}T00:00:00Z`) - DAY_MS)
      .toISOString()
      .slice(0, 10);
  }
  return null;
}

/**
 * The sessions this run should buy, or the named reason it should buy none.
 *
 * THE THREE SKIPS ARE DISTINCT VALUES, not one "nothing to do". They call for
 * opposite responses: `NO_HWM_RUN_HARVEST_FIRST` means the entry was never
 * harvested and a human has to decide; `UP_TO_DATE` is the healthy steady state
 * and is what the 18:00 retry run should report after a successful 15:00 one;
 * `NOT_YET_PUBLISHED` means come back later and is expected around the T+1
 * embargo. Collapsing them would make a never-harvested entry report the same
 * thing, forever, as a perfectly current one.
 */
export function computeAppendGap(args: {
  /** Latest ET session date we hold for this entry, or null. */
  hwmSessionDate: string | null;
  /** `metadata.get_dataset_range` end for this schema. EXCLUSIVE. */
  datasetRangeEndUtcMs: number | null;
  now: Date;
  maxSessions?: number;
}): AppendGap {
  const max = args.maxSessions ?? DEFAULT_MAX_APPEND_SESSIONS;
  if (max < 1) {
    throw new RangeError("computeAppendGap: maxSessions must be >= 1");
  }
  if (args.hwmSessionDate === null) {
    return { ok: false, sessions: [], skipReason: "NO_HWM_RUN_HARVEST_FIRST" };
  }

  const lastCompleted = lastCompletedUsSession(args.now);

  // An UNKNOWN range is not an available one. A null here means the metadata
  // call failed or was skipped, and treating that as "everything is available"
  // would submit a job for a session that may not exist — paying for an empty
  // result at exactly the moment the vendor is least able to serve it.
  const available =
    args.datasetRangeEndUtcMs === null
      ? null
      : latestAvailableSession(lastCompleted, args.datasetRangeEndUtcMs);
  if (available === null) {
    return { ok: false, sessions: [], skipReason: "NOT_YET_PUBLISHED" };
  }

  const target = available < lastCompleted ? available : lastCompleted;
  if (target <= args.hwmSessionDate) {
    // Which of the two bounds held it back decides what an operator should do,
    // so the two are reported separately even though both produce no work.
    return {
      ok: false,
      sessions: [],
      skipReason:
        lastCompleted <= args.hwmSessionDate
          ? "UP_TO_DATE"
          : "NOT_YET_PUBLISHED",
    };
  }

  const all: string[] = [];
  let key = nextDateKey(args.hwmSessionDate);
  while (key <= target) {
    if (isUsTradingDay(key)) all.push(key);
    key = nextDateKey(key);
  }
  if (all.length === 0) {
    // Every date in the gap was a weekend or a holiday. The calendar moved and
    // the market did not; that is UP_TO_DATE, not a hole.
    return { ok: false, sessions: [], skipReason: "UP_TO_DATE" };
  }

  const sessions = all.slice(0, max);
  // THE DATA DAY'S END, and DETERMINISTIC — a pure function of the session key.
  //
  // It cannot be `usMarketDayBoundsUtc().endMs` (24:00 ET): that is past the
  // vendor's UTC-midnight range end and every such request is answered 422
  // `data_end_after_available_end`.
  //
  // It must not be `min(sessionEnd, rangeEnd)` either, and that is the
  // subtler half. The APPEND's window IS its identity — `windowIsPinnedFor`
  // is HARVEST-only, deliberately, because the append buys a new session every
  // night — so `start` and `end` are in the unique key. A range end that moves
  // as the vendor publishes makes that key move with it: a session submitted
  // on Saturday that does not settle within `--max-wait-min` leaves a
  // SUBMITTED row, and Monday's run computes a LARGER end, misses the lookup,
  // and BUYS THE SAME SESSIONS AGAIN. That is the defect
  // `databento-budget.ts:250-259` documents on the harvest side, one purpose
  // over.
  //
  // 20:00 ET is both: it is <= the range end for every session
  // `latestAvailableSession` returned, so it never 422s, and it depends only
  // on the session key, so the key is stable forever.
  const endMsExclusive =
    usMarketDayBoundsUtc(sessions[sessions.length - 1]!).startMs +
    US_POST_CLOSE_MINUTES * 60_000;
  return {
    ok: true,
    sessions,
    startMs: usMarketDayBoundsUtc(sessions[0]!).startMs,
    endMsExclusive,
    deferred: all.length - sessions.length,
  };
}

/**
 * The high-water mark a `--from=YYYY-MM-DD` override implies.
 *
 * `--from` names the first session to FETCH, and the gap walk starts strictly
 * after the mark — so the mark is the trading day before it. Returning the raw
 * date would silently skip the very session the operator asked for, which is
 * the least visible way to get an override wrong.
 */
export function hwmForFromDate(fromDateKey: string): string {
  let key = new Date(Date.parse(`${fromDateKey}T00:00:00Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
  for (let i = 0; i < 10; i++) {
    if (isUsTradingDay(key)) return key;
    key = new Date(Date.parse(`${key}T00:00:00Z`) - DAY_MS)
      .toISOString()
      .slice(0, 10);
  }
  throw new RangeError(
    `hwmForFromDate: no trading day within 10 days before ${fromDateKey}`,
  );
}

/**
 * Which inventory states COUNT as coverage for an entry.
 *
 * `LOADED` for an entry whose records become candles; `DOWNLOADED` counts too
 * for an archive-only entry, whose records never reach `candles` and so can
 * never reach `LOADED`.
 *
 * A FUNCTION with its own test, because the deploy contract could only forbid
 * the literals `"SUBMITTED"` and `"DONE"` appearing near the query. Adding
 * `"QUOTED"` — a real ledger state, written BEFORE anything is bought — passed
 * the whole suite, and would have let a window that was quoted and never
 * purchased advance the high-water mark past sessions nothing holds.
 */
export function terminalStatesFor(entry: { load: boolean }): string[] {
  return entry.load ? ["LOADED"] : ["DOWNLOADED", "LOADED"];
}

/**
 * The high-water mark of a MULTI-CHUNK entry: the end of the newest purchase
 * WINDOW that every chunk completed — MONEY-1539.
 *
 * A symbol set above 2,000 names is split into several jobs that share an
 * `entryId` and differ by `symbolsHash`, so `ohlcv-1h-master` is 8 chunks, and
 * one run buys ONE window `[start, end)` for all of them. The window is the
 * unit that is complete or not: it counts only when at least `expectedChunks`
 * distinct chunks reached a terminal state inside it. One chunk's success can
 * therefore never speak for the others — chunk B failing leaves the window
 * short, the mark stays at the previous complete window, and the next run
 * re-asks for B's sessions instead of starting past them.
 *
 * THIS USED TO BE THE MINIMUM OF EACH `symbolsHash`'S LATEST `end`, and on a
 * population that changes it never moved. MASTER is re-read from
 * `us_instruments` every run and gains or loses a listing most nights; one
 * insertion in the sorted list re-slices every chunk after it, so the nightly
 * hashes are NEW hashes. The harvest's 8 hashes were never bought again, so
 * their end — session 2026-09-08 — was the minimum on every later night, and
 * every append re-bought from 2026-09-09: 65 jobs, 2,161,992 records for
 * 473,832 unique bars, measured on prod 2026-09-23. The M1 entry never showed
 * it because a manifest symbol list hashes the same every night. The
 * "absent chunk" guard that preceded this (`perChunk.size < expectedChunks`)
 * was unreachable for the same reason — stale hashes kept the count at 8+.
 *
 * `null` when no window is complete, which the caller reports as
 * `NO_HWM_RUN_HARVEST_FIRST`: nothing has been fully bought, so a human
 * decides between a harvest and `--from`.
 *
 * ponytail: completeness is a COUNT of distinct hashes, not a match against
 * tonight's hashes (which by construction have no rows yet). If MASTER changed
 * BETWEEN the 15:00 and 18:00 runs of one day, old and new hashes could mix in
 * one window and over-count. It cannot today — the only writer of MASTER's
 * membership, us-instrument-master-sync, runs at 10:00 IST — and fixing it
 * properly needs the per-chunk symbol list on the row.
 *
 * PURE, and in this module rather than in the job script, because a source
 * scan cannot tell one selection policy from another that reads almost the
 * same.
 */
export function highWaterMarkFromChunks(
  rows: ReadonlyArray<{ symbolsHash: string; start: Date; end: Date }>,
  expectedChunks: number,
): { mark: string | null; furthest: string | null; furthestChunks: number } {
  const windows = new Map<string, { end: Date; hashes: Set<string> }>();
  for (const row of rows) {
    const key = `${row.start.getTime()}/${row.end.getTime()}`;
    let w = windows.get(key);
    if (w === undefined)
      windows.set(key, (w = { end: row.end, hashes: new Set() }));
    w.hashes.add(row.symbolsHash);
  }

  let mark: string | null = null;
  let furthest: string | null = null;
  let furthestChunks = 0;
  for (const w of windows.values()) {
    const session = sessionDateForExclusiveEnd(w.end);
    if (furthest === null || session > furthest) {
      furthest = session;
      furthestChunks = w.hashes.size;
    }
    if (w.hashes.size >= expectedChunks && (mark === null || session > mark)) {
      mark = session;
    }
  }
  return { mark, furthest, furthestChunks };
}

/**
 * The ET session date an inventory row's EXCLUSIVE `end` represents.
 *
 * One millisecond back, because `end` is the exclusive bound of the last
 * session bought — it lands at 00:00 ET of the FOLLOWING day, and reading it
 * directly would advance the high-water mark by one session that was never
 * fetched. That is the silent-hole failure this whole module exists to avoid.
 */
export function sessionDateForExclusiveEnd(end: Date): string {
  return etDateKey(new Date(end.getTime() - 1));
}

/** `YYYY-MM-DD` of an instant in America/New_York. */
function etDateKey(at: Date): string {
  // `en-CA` renders ISO order, which is why it is used here rather than a
  // hand-rolled offset table: the ET offset changes twice a year and a fixed
  // -5 would put every summer session on the wrong date.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
