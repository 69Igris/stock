/**
 * Events Sync Processor — MONEY-408, source-swapped by MONEY-1098 (P5.3).
 *
 * Populates the `UpcomingEvent` table — the forward calendar behind the
 * earnings-reminder alert (`alert-evaluator.evaluateEarningsDate`), the
 * CORPORATE_ACTION alert branch, and the sector deep-dive / news "upcoming"
 * strip. Before MONEY-408 the table had a reader and no writer.
 *
 * ## Sources (MONEY-1098)
 *
 *   PRIMARY — NSE, whole universe, TWO windowed calls:
 *     `/api/corporate-board-meetings` and `/api/event-calendar`. Both accept a
 *     `from_date`/`to_date` window and return every listed company's scheduled
 *     events in it, so market-wide coverage costs 2 requests instead of one per
 *     symbol. NSE is also the PRIMARY RECORD for these dates — the board meeting
 *     intimation is the filing everyone else re-publishes.
 *
 *   FALLBACK — Yahoo Finance `calendarEvents`, per symbol, ONLY for tracked
 *     symbols the NSE window never mentioned. This used to be the primary and
 *     the only source: N requests for N symbols, capped at 200, i.e. the
 *     201st tracked symbol simply had no calendar.
 *
 *     MONEY-1217 widened WHICH symbols those are, from `alerts ∪ holdings ∪
 *     watchlist` (~102) to the WARM sync tier (~781, adds every index
 *     constituent), rotated stale-first on `InstrumentMapping.eventsSyncedAt`
 *     under the same per-run cap. See {@link gatherTargetSymbols}.
 *
 *   CORPORATE ACTIONS — NSE per-symbol `corporates-corporateActions`, unchanged
 *     from MONEY-408. It contributes EX-DATES, which the two events endpoints do
 *     not carry; it stays capped + paced because it is per-symbol.
 *
 * ## Idempotency (unchanged contract, now per-category)
 *
 * Forward-only: rows before today are dropped, and only future rows are ever
 * written (the history lives in `CorporateAction`, which is history-preserving
 * on purpose — see corporate-actions.service.ts).
 *
 * Per category, the job deletes the FUTURE rows of exactly the symbols it is
 * about to write and then bulk-inserts the fresh set. Re-running therefore
 * converges rather than duplicating, and a symbol the run knows nothing about
 * keeps its existing rows instead of being silently emptied. The delete/insert
 * are batched because the whole-universe swap turned the symbol list from ~200
 * into potentially a few thousand.
 *
 * Cron: once daily, 06:00 IST (pre-market), `events-sync-daily` in
 * `scripts/ops/setup-scheduler.sh`. Deterministic — no LLM in the hot path.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import {
  yahooFetchQuoteSummary,
  withExchangeFallback,
} from "@usemoney/core/market-data";
import {
  buildSyncTierWhere,
  loadSyncTierSymbols,
  type SyncTier,
} from "@usemoney/core/market-data/sync-tiers";
import {
  fetchNSECorporateActions,
  fetchNseApiJson,
  formatNSEDate,
} from "@usemoney/research/data-sources/nse-filings";
import {
  parseBoardMeetings,
  parseEventCalendar,
  toUpcomingEventRows,
  dedupeUpcomingEvents,
  selectFallbackSymbols,
  selectEventTargets,
  groupByCategory,
  startOfUtcDay,
  forwardWindow,
  chunk,
  type UpcomingEventRow,
  type EventCategory,
} from "./events-sync-logic";

export interface EventsSyncMessage {
  /** Explicit symbol override (bare NSE symbols, e.g. "RELIANCE"). */
  symbols?: string[];
  /** Cap on symbols fetched per run (default 200). */
  maxSymbols?: number;
  /** How far forward the NSE window reaches, in days (default 30). */
  forwardDays?: number;
}

/**
 * How far ahead the NSE whole-universe window looks.
 *
 * 30 days covers a full results season announcement lead-time (board meetings
 * are intimated ~2-3 weeks ahead under LODR Reg. 29) with room for a missed run.
 * Env-overridable for backfills / debugging.
 */
function eventsForwardDays(explicit?: number): number {
  if (Number.isFinite(explicit) && (explicit as number) > 0) {
    return Math.floor(explicit as number);
  }
  const n = Number(process.env.EVENTS_SYNC_FORWARD_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

/** NSE corp-actions are slow + rate-limited, so cap the per-run fan-out
 *  independently of the (cheaper) whole-universe events window. */
const CORP_ACTION_SYMBOL_CAP = 100;

/** Bound on `symbol: { in: [...] }` per delete and rows per insert. */
const DB_BATCH = 500;

/**
 * Which sync tier this job's fallback covers — MONEY-1217.
 *
 * WARM (portfolio ∪ watchlist ∪ index constituents, ~781 on prod) rather than
 * HOT (~78). The earnings calendar is read by SECTOR, and a sector is an index
 * concept: the hot tier is what a user already holds, which is exactly the
 * population a sector drill-down is NOT about.
 */
const EVENTS_SYNC_TIER: SyncTier = "warm";

/** Extract the next earnings date from a Yahoo `calendarEvents` payload. */
function extractEarningsDate(
  summary: Record<string, unknown> | null,
): { date: Date; epsForecast: number | null } | null {
  if (!summary) return null;
  const calendar = summary.calendarEvents as
    | Record<string, unknown>
    | undefined;
  const earnings = calendar?.earnings as Record<string, unknown> | undefined;
  const dateRaw = earnings?.earningsDate as Array<{ raw: number }> | undefined;
  const raw = dateRaw?.[0]?.raw;
  if (!raw) return null;
  const date = new Date(raw * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const eps = (earnings?.earningsAverage as { raw?: number } | undefined)?.raw;
  return { date, epsForecast: typeof eps === "number" ? eps : null };
}

// NSE actionType → UpcomingEvent.category. BONUS/RIGHTS fold into the generic
// `corp_action` bucket (the model has no dedicated category for them); the
// specific type is preserved in the title.
/**
 * The categories one corporate action can move BETWEEN across runs. A
 * re-classified action must not leave a row behind under its old category —
 * see the sweep in the writer for why that is not `writeCategory`'s job.
 * `earnings` is excluded: it comes from board meetings / Yahoo on a different
 * lifecycle, not from the corp-actions feed.
 */
const CORP_SWEEP_CATEGORIES: readonly EventCategory[] = [
  "corp_action",
  "dividend",
  "splits",
];

const ACTION_TO_CATEGORY: Record<string, EventCategory> = {
  DIVIDEND: "dividend",
  SPLIT: "splits",
  BONUS: "corp_action",
  RIGHTS: "corp_action",
};

/**
 * PRIMARY leg — one windowed, whole-universe call to EACH NSE events endpoint.
 *
 * Uses `fetchNseApiJson`, the exported cookie-session client in `nse-filings.ts`,
 * rather than a second copy of the Akamai handshake (that retry-on-403 is
 * load-bearing and a duplicate would drift the first time NSE changes it). The
 * client returns `null` on ANY failure — non-2xx, HTML challenge page, malformed
 * JSON — which the parsers below report as an unrecognised payload rather than
 * an empty market.
 */
async function fetchNseWindowEvents(
  now: Date,
  forwardDays: number,
): Promise<{ rows: UpcomingEventRow[]; skipped: number; degraded: string[] }> {
  const { from, to } = forwardWindow(now, forwardDays);
  const window = `from_date=${formatNSEDate(from)}&to_date=${formatNSEDate(to)}`;
  const startOfToday = startOfUtcDay(now);

  const degraded: string[] = [];
  let skipped = 0;
  const rows: UpcomingEventRow[] = [];

  const boardRaw = await fetchNseApiJson(
    `/api/corporate-board-meetings?index=equities&${window}`,
  );
  const board = parseBoardMeetings(boardRaw);
  // `fetchNseApiJson` returns null on ANY failure, and the parser reports an
  // unrecognised container the same way — so name which one it was. "NSE
  // changed its field names" and "Akamai served us a challenge page" need very
  // different responses, and a single DEGRADED line that can't tell them apart
  // is the kind of alert nobody acts on.
  if (board.unrecognizedPayload) {
    degraded.push(
      boardRaw === null
        ? "corporate-board-meetings (fetch failed)"
        : "corporate-board-meetings (unknown shape)",
    );
  }
  skipped += board.skipped;
  rows.push(...toUpcomingEventRows(board.rows, startOfToday, "NSE"));

  const calendarRaw = await fetchNseApiJson(
    `/api/event-calendar?index=equities&${window}`,
  );
  const calendar = parseEventCalendar(calendarRaw);
  if (calendar.unrecognizedPayload) {
    degraded.push(
      calendarRaw === null
        ? "event-calendar (fetch failed)"
        : "event-calendar (unknown shape)",
    );
  }
  skipped += calendar.skipped;
  // The event-calendar endpoint mixes purposes; the ticket scopes this leg to
  // results dates, which is also the only thing it adds over board meetings.
  rows.push(
    ...toUpcomingEventRows(calendar.rows, startOfToday, "NSE").filter(
      (r) => r.category === "earnings",
    ),
  );

  console.log(
    `[events-sync] NSE window ${formatNSEDate(from)}..${formatNSEDate(to)}: ` +
      `${board.rows.length} board meetings + ${calendar.rows.length} calendar rows ` +
      `-> ${rows.length} events, ${skipped} skipped` +
      (degraded.length ? `, DEGRADED: ${degraded.join(", ")}` : ""),
  );

  return { rows, skipped, degraded };
}

/**
 * FALLBACK leg — Yahoo `calendarEvents`, per symbol, for the tracked symbols the
 * NSE window never mentioned. Small batches so one slow symbol doesn't stall the
 * run; per-symbol try/catch so one failure doesn't cost the batch.
 */
async function fetchYahooEarnings(
  symbols: readonly string[],
  startOfToday: Date,
): Promise<UpcomingEventRow[]> {
  const out: UpcomingEventRow[] = [];
  const BATCH = 5;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (symbol) => {
        try {
          const summary = await withExchangeFallback(`${symbol}.NS`, (yf) =>
            yahooFetchQuoteSummary(yf, ["calendarEvents"]),
          );
          const ext = extractEarningsDate(summary);
          if (!ext) return null;
          return { symbol, ...ext };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (!r) continue;
      // Earnings reminders are forward-looking: drop dates already in the past.
      if (r.date < startOfToday) continue;
      out.push({
        date: r.date,
        symbol: r.symbol,
        title:
          r.epsForecast != null
            ? `${r.symbol} earnings (est. EPS ${r.epsForecast.toFixed(2)})`
            : `${r.symbol} earnings`,
        category: "earnings",
        source: "YAHOO",
      });
    }
  }
  return out;
}

/**
 * Fetch upcoming corporate actions (dividends / splits / bonuses / rights) from
 * NSE filings and map them to forward-dated rows, placed on the calendar by
 * EX-DATE — the date the two events endpoints do not carry, and the one that
 * matters for a corporate-action reminder. Best-effort: per-symbol try/catch +
 * gentle concurrency, since NSE is flaky.
 */
async function fetchCorpActions(
  symbols: readonly string[],
  startOfToday: Date,
): Promise<UpcomingEventRow[]> {
  const rows: UpcomingEventRow[] = [];
  const BATCH = 4;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (symbol) => {
        try {
          return await fetchNSECorporateActions(symbol);
        } catch {
          return [];
        }
      }),
    );
    for (let j = 0; j < batch.length; j++) {
      const symbol = batch[j]!;
      for (const a of results[j] ?? []) {
        // Skip actions with no ex-date or one already in the past.
        const exDate = a.exDate ? new Date(a.exDate) : null;
        if (
          !exDate ||
          Number.isNaN(exDate.getTime()) ||
          exDate < startOfToday
        ) {
          continue;
        }
        const type = (a.actionType || "").toUpperCase();
        const category = ACTION_TO_CATEGORY[type] ?? "corp_action";
        const detail = a.details ? ` — ${a.details}`.slice(0, 120) : "";
        rows.push({
          date: exDate,
          symbol,
          title: `${symbol} ${type || "corporate action"}${detail}`,
          category,
          source: "NSE",
        });
      }
    }
  }
  return rows;
}

/**
 * The symbols this run resolves calendars for — MONEY-1217.
 *
 * ## What changed and why
 *
 * This used to be `alerts ∪ holdings ∪ watchlist`, ~102 symbols on prod. The
 * NSE legs are whole-universe so they were unaffected, but the YAHOO FALLBACK
 * — the leg that covers everything NSE has not announced yet — could only ever
 * reach those 102. Meanwhile the surfaces reading `UpcomingEvent` ask by SECTOR
 * CONSTITUENT (238 names for Financial Services alone), so the population we
 * fetched and the population we render barely intersected.
 *
 * The population is now the WARM sync tier from
 * `@usemoney/core/market-data/sync-tiers` — portfolio ∪ watchlist ∪ index
 * constituents, measured at **781** on prod 2026-08-19 against a hot tier of 78.
 * That is the same definition `financial-data-sync` uses, imported rather than
 * re-derived, so the two jobs cannot drift into two answers about which symbols
 * the platform covers.
 *
 * ## Why it is not simply "fetch all 781"
 *
 * The fallback is one Yahoo request per symbol. 781 a night at a rate-limited
 * source is how a nightly job starts getting throttled, and a throttled fetch
 * returns nothing in a way that looks exactly like "no calendar published".
 * So the per-run cap stays, and the selection ROTATES stale-first on
 * `eventsSyncedAt` — nulls first on Mongo, i.e. never-synced symbols lead. At
 * the default 200/night the warm tier is covered every 4 runs.
 *
 * Ordering by anything constant instead (`analysisCount desc` over a population
 * where every row is 0, which is what `news-sync` and `financial-data-sync` both
 * did before MONEY-1211/1215) hands the same arbitrary 200 to every run forever
 * — with no error anywhere, because the job's own logs only count what it
 * processed.
 *
 * A tier-population failure degrades to the alert list rather than throwing:
 * the earnings-reminder path is the one with a user waiting on it.
 */
async function gatherTargetSymbols(maxSymbols: number): Promise<string[]> {
  const alerts = await prisma.alert
    .findMany({
      where: { kind: "EARNINGS_DATE", status: "ACTIVE", symbol: { not: null } },
      select: { symbol: true },
    })
    .catch((err: unknown) => {
      console.error("[events-sync] alert target lookup failed:", err);
      return [] as Array<{ symbol: string | null }>;
    });

  const rotation = await prisma.instrumentMapping
    .findMany({
      where: buildSyncTierWhere(
        EVENTS_SYNC_TIER,
        await loadSyncTierSymbols(EVENTS_SYNC_TIER, "events-sync"),
      ),
      select: { symbol: true },
      // Stale-first. `asc` puts NULLs first on MongoDB, which is what we want —
      // a never-synced symbol is the most stale thing there is. Written as plain
      // `asc` rather than `{ sort, nulls }` because that form needs Prisma's
      // `orderByNulls` preview flag, which this schema does not enable; the
      // `symbol` tiebreak makes the order total, so the rotation advances
      // deterministically instead of depending on storage order.
      orderBy: [{ eventsSyncedAt: "asc" }, { symbol: "asc" }],
      // Over-fetch relative to the cap so that alert symbols already present in
      // the tier do not shrink the rotation slice they displace.
      take: Math.max(maxSymbols, 1) * 2,
    })
    .catch((err: unknown) => {
      console.error(
        "[events-sync] warm-tier rotation lookup failed — falling back to " +
          "alert targets only:",
        err,
      );
      return [] as Array<{ symbol: string }>;
    });

  return selectEventTargets(
    alerts.flatMap((a) => (a.symbol ? [a.symbol] : [])),
    rotation.map((r) => r.symbol),
    maxSymbols,
  );
}

/**
 * Stamp the rotation marker for the symbols this run covered.
 *
 * Stamped for every TARGET, not only for the ones Yahoo was asked about: the
 * cap bounds the SELECTION, and a symbol NSE's whole-universe window already
 * answered for has had its calendar resolved just as much as one that needed a
 * fallback call. Stamping only the fallback subset would pin every NSE-covered
 * symbol at the head of the sort forever, which is the same
 * rotation-never-advances failure in a new costume.
 *
 * Stamped on failure as well as success, for the reason `news-sync` learned the
 * hard way: a symbol that cannot be fetched (delisted, no upstream coverage)
 * would otherwise keep its null marker, stay first, and own a slot on every
 * future run.
 *
 * Batched via `updateMany` — one write per DB_BATCH symbols, not per symbol —
 * and best-effort: a stamp failure must not fail a run that already wrote its
 * events, but it is logged, because silent stamp loss is indistinguishable from
 * a rotation that never advances.
 */
async function stampEventsSynced(symbols: readonly string[]): Promise<void> {
  const now = new Date();
  for (const batch of chunk(Array.from(new Set(symbols)), DB_BATCH)) {
    try {
      await prisma.instrumentMapping.updateMany({
        where: { symbol: { in: batch } },
        data: { eventsSyncedAt: now },
      });
    } catch (err) {
      console.warn("[events-sync] eventsSyncedAt stamp failed:", err);
    }
  }
}

/**
 * Idempotent write for ONE category: delete the future rows of exactly the
 * symbols being written, then bulk-insert. Both halves are batched — the
 * whole-universe swap can hand this a few thousand symbols, and an unbounded
 * `$in` is how a Mongo query stops being fast without ever being wrong.
 */
async function writeCategory(
  category: EventCategory,
  rows: readonly UpcomingEventRow[],
  startOfToday: Date,
): Promise<number> {
  const symbols = Array.from(new Set(rows.map((r) => r.symbol)));
  for (const batch of chunk(symbols, DB_BATCH)) {
    await prisma.upcomingEvent.deleteMany({
      where: { symbol: { in: batch }, category, date: { gte: startOfToday } },
    });
  }

  let written = 0;
  for (const batch of chunk(rows, DB_BATCH)) {
    const res = await prisma.upcomingEvent.createMany({
      data: batch.map((r) => ({
        date: r.date,
        symbol: r.symbol,
        title: r.title,
        category: r.category,
        source: r.source,
      })),
    });
    written += res.count;
  }
  return written;
}

export async function processEventsSync(
  data: EventsSyncMessage,
): Promise<void> {
  const maxSymbols = data.maxSymbols ?? 200;
  const now = new Date();
  const startOfToday = startOfUtcDay(now);

  const targets =
    data.symbols && data.symbols.length > 0
      ? data.symbols.map((s) => s.toUpperCase()).slice(0, maxSymbols)
      : await gatherTargetSymbols(maxSymbols);

  // ── 1. PRIMARY: NSE whole-universe window (two calls) ──────────────────────
  const nse = await fetchNseWindowEvents(
    now,
    eventsForwardDays(data.forwardDays),
  );
  let nseRows = nse.rows;

  // An explicit symbol override scopes EVERY leg, so a targeted re-sync of one
  // ticker can't rewrite the whole market's calendar.
  if (data.symbols && data.symbols.length > 0) {
    const wanted = new Set(targets);
    nseRows = nseRows.filter((r) => wanted.has(r.symbol));
  }

  // ── 2. FALLBACK: Yahoo, only for tracked symbols NSE didn't cover ──────────
  const fallbackSymbols = selectFallbackSymbols(targets, nseRows);
  if (fallbackSymbols.length > 0) {
    console.log(
      `[events-sync] NSE covered ${targets.length - fallbackSymbols.length}/${targets.length} ` +
        `${EVENTS_SYNC_TIER}-tier targets; falling back to Yahoo for ${fallbackSymbols.length}`,
    );
  }
  const yahooRows = await fetchYahooEarnings(fallbackSymbols, startOfToday);

  // ── 3. Corporate actions by EX-DATE (NSE per-symbol, capped + paced) ───────
  const corpTargets = targets.slice(0, CORP_ACTION_SYMBOL_CAP);
  if (targets.length > CORP_ACTION_SYMBOL_CAP) {
    console.log(
      `[events-sync] Corp-actions capped to ${CORP_ACTION_SYMBOL_CAP}/${targets.length} symbols (NSE rate limits)`,
    );
  }
  const corpRows = await fetchCorpActions(corpTargets, startOfToday);

  // Advance the rotation as soon as every per-symbol leg has RUN — before the
  // "nothing to write" return below, not after it.
  //
  // The marker means "we last attempted this symbol's calendar", not "we last
  // found something for it". Gating the stamp on a successful write would freeze
  // the rotation for the whole of an NSE outage: the same 200 symbols would be
  // retried every night while the other ~580 never got a look, and the logs
  // would show a job doing exactly as much work as usual. The cost of this
  // choice is the mirror image and much smaller — on a night the upstream is
  // down, those 200 wait one extra cycle (~4 days at the default cap) — and it
  // self-heals, which a frozen rotation does not.
  await stampEventsSynced(targets);

  // ── 4. Merge + dedupe, then one scoped delete+insert per category ──────────
  // NSE first so it wins every collision against the Yahoo fallback.
  const all = dedupeUpcomingEvents([...nseRows, ...corpRows, ...yahooRows]);
  const summary: string[] = [];
  let writtenRows = 0;

  if (all.length === 0) {
    // NOT an early return any more — MONEY-1238. This branch IS the failure
    // this job needs a monitor for: three sources over a whole-market 30-day
    // window producing zero forward events is an NSE challenge page or a broken
    // parser, never a quiet market. Returning here skipped the outcome report
    // entirely, so the one run worth alerting on was the one run that emitted
    // no metric — and `notify_no_data` would have called that a missing job
    // rather than an empty one.
    console.log(
      "[events-sync] No forward events from any source — nothing to write",
    );
  } else {
    // Cross-category sweep for corp actions, BEFORE the per-category writes.
    //
    // `writeCategory` deletes only within the category it is writing, and
    // `groupByCategory` only yields categories the fresh fetch produced — so an
    // action that changed TYPE (NSE reports the dividend withdrawn and a bonus
    // scheduled) left the old dividend row alive under a category nobody was
    // writing that run. alert-evaluator's CORPORATE_ACTION branch then fires a
    // reminder for an action that no longer exists, and the calendar shows both.
    // Sweeping the whole corp family for the affected symbols fixes the re-type.
    //
    // Scoped to symbols that ANSWERED, deliberately, not to every symbol queried:
    // `fetchNSECorporateActions` returns [] for a throttled fetch exactly as it
    // does for "no actions", so sweeping the queried set would erase every real
    // reminder on an NSE-403 night. RESIDUAL, accepted: a fully WITHDRAWN action
    // (symbol returns nothing at all) still leaves its row until its date passes
    // — deleting on a signal we cannot distinguish from failure is the worse
    // trade.
    const corpSymbols = Array.from(
      new Set(
        corpRows
          .filter((r) => CORP_SWEEP_CATEGORIES.includes(r.category))
          .map((r) => r.symbol),
      ),
    );
    for (const batch of chunk(corpSymbols, DB_BATCH)) {
      await prisma.upcomingEvent.deleteMany({
        where: {
          symbol: { in: batch },
          category: { in: [...CORP_SWEEP_CATEGORIES] },
          date: { gte: startOfToday },
        },
      });
    }

    for (const [category, rows] of groupByCategory(all)) {
      const written = await writeCategory(category, rows, startOfToday);
      writtenRows += written;
      summary.push(`${category}=${written}`);
    }

    console.log(
      `[events-sync] Wrote ${writtenRows} events (${summary.join(", ")}) — ` +
        `NSE ${nseRows.length + corpRows.length}, Yahoo ${yahooRows.length}` +
        (nse.degraded.length ? `; DEGRADED: ${nse.degraded.join(", ")}` : ""),
    );
  }

  // MONEY-1238 — the machine-readable half. `events-sync` was one of four jobs
  // this repo MONITORS for the zero-write class while emitting no metric at
  // all, so its monitor sat in NO DATA from the day it was created.
  //
  // The two numbers, and why they are in different units:
  //
  //   selected  SYMBOLS this run chose to work on — the warm-tier rotation
  //             slice ∪ active earnings alerts. It is deliberately NOT
  //             `all.length`: the failure worth paging for is "every source
  //             returned nothing", and in that state `all.length` is 0, so a
  //             row-based `selected` would report the broken run as an idle
  //             one. `targets` is non-zero whenever the job had a reason to
  //             run, which is exactly what `selected` has to mean.
  //
  //   written   ROWS actually persisted, summed from `createMany`'s own counts
  //             — not `all.length` (what we intended to write) and not the
  //             number of categories that did not throw.
  //
  // Mixed units are fine here because the monitor only ever compares each
  // against zero. The question the pair answers is "did a run that had a reason
  // to run produce any rows at all", and both halves of that are honest.
  const perSource =
    `nse=${nseRows.length} corp=${corpRows.length} yahoo=${yahooRows.length} ` +
    `deduped=${all.length} nseSkipped=${nse.skipped}` +
    (nse.degraded.length ? ` DEGRADED=[${nse.degraded.join(", ")}]` : "");

  reportJobOutcome({
    job: "events-sync",
    selected: targets.length,
    written: writtenRows,
    skippedReason:
      targets.length > 0 && writtenRows === 0
        ? `no event row written for ${targets.length} target symbol(s): ${perSource}`
        : perSource,
  });
}
