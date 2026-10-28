/**
 * Alert Evaluator Processor - MONEY-408.
 *
 * Evaluates active alerts against the latest market state and fires a
 * notification when a condition is satisfied. Idempotent via the
 * `lastFiredAt` + `cooldownMinutes` fields on the Alert row.
 *
 * Cron: every minute during market hours (9:00–16:00 IST Mon-Fri),
 * every 5 min off-hours.
 *
 * Supported kinds (CUSTOM is free-form and has no generic evaluator):
 *   - PRICE          - conditions: { threshold: number, direction: "above"|"below" }
 *   - VOLUME         - conditions: { multiplier: number } (vs real 30-day avg
 *                      from DailyPrice, excluding today)
 *   - EARNINGS_DATE  - conditions: { daysBefore: number } (earnings within N days)
 *   - NEWS           - conditions: { keywords?: string[] } (new symbol-tagged
 *                      NewsArticle since last fire, optional keyword filter)
 *   - CORPORATE_ACTION - conditions: { daysBefore?: number } (corp_action /
 *                      dividend / splits in UpcomingEvent within N days; dormant
 *                      until a corp-action writer populates those rows)
 *
 * MONEY-1204 (14e.3) added six DATA-ENGINE kinds. Every one of them reads a
 * PRECOMPUTED table — no scraping, no live fetch, nothing that leaves the
 * process except Prisma:
 *   - FLAG_TRANSITION  - StockFlag           ASM/GSM entry-exit, F&O ban, band change
 *   - DELIVERY_SPIKE   - DailyPrice          deliveryPct > 2x the 20-day mean
 *   - PLEDGE_INCREASE  - ShareholdingPattern pledgedPct up > 2pp QoQ
 *   - INSIDER_CLUSTER  - InsiderEvent        >= 3 BUY disclosures in 30 days
 *   - MWPL_HIGH        - MwplDaily           utilisation >= 80% (DORMANT, below)
 *   - FII_FLOW_STREAK  - InstitutionalFlow   >= 5 consecutive net-buy/sell days
 *
 * Their decision logic is PURE and lives in `alert-evaluator-logic.ts`; this
 * file only reads rows and writes notifications.
 *
 * ## Two independent "don't repeat" gates — do not collapse them
 *
 * `cooldownMinutes` limits the RATE (at most once an hour). The event-date gate
 * (`shouldSuppressRepeat`) limits REPETITION OF THE SAME FACT: each data-engine
 * evaluator returns the CROSSING DATE of the condition, and we stay silent when
 * `lastFiredAt >= eventDate`. A stock that entered ASM on 4-Aug and is still in
 * ASM on 5-Aug yields the same crossing date on both days and notifies exactly
 * ONCE; the exit on 21-Aug is a new crossing date and notifies again. A
 * cooldown cannot do that job (a 60-minute cooldown does nothing against a
 * DAILY cron restating a 40-day ban) and the event gate cannot do the
 * cooldown's. Neither is redundant. Full rationale: the module doc of
 * `alert-evaluator-logic.ts`.
 *
 * No schema change: `lastFiredAt` / `cooldownMinutes` already exist and the
 * crossing date is derived, never stored.
 *
 * ## Every swallow is COUNTED — MONEY-1238
 *
 * This file had no failure counter of any kind and reached Prisma through eight
 * `.catch(() => null)` / `.catch(() => [])` sites, each of which makes a
 * database error identical to an empty table. Two of them are market-WIDE and
 * cached per run, so `stockFlag.groupBy` failing silently disables every
 * FLAG_TRANSITION alert for every user — across 1,440 runs a day, each logging
 * `fired 0` and returning 200. Nothing moved.
 *
 * The swallows are still swallows (one unreadable table must not abort the
 * other eleven alert kinds), but they now go through {@link readOr}, which
 * COUNTS them. The count reaches `judgeAlertRun`, which reaches the route's
 * HTTP status. See that function for the transient-vs-deterministic split.
 *
 * `createNotification(...).catch(() => {})` was the same shape one layer down:
 * the write could fail and the loop still set `triggered = true` and stamped
 * `lastFiredAt`, so a notification that never landed was recorded as delivered
 * AND its cooldown then suppressed the retry. The loop now uses
 * `tryCreateNotification`, whose boolean IS `triggered`.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import type { NotificationType } from "@prisma/client";
import { tryCreateNotification } from "../lib/notifications";
import {
  type AlertEvent,
  type AlertRunTotals,
  type FlagObservationLite,
  evaluateDeliverySpike,
  evaluateFiiFlowStreak,
  evaluateFlagTransition,
  evaluateInsiderCluster,
  evaluateMwplHigh,
  evaluatePledgeIncrease,
  isSilentDelivery,
  judgeAlertRun,
  shouldSuppressRepeat,
  undeliverableChannels,
  DELIVERY_BASELINE_DAYS,
  INSIDER_CLUSTER_WINDOW_DAYS,
} from "./alert-evaluator-logic";

export interface AlertEvaluatorMessage {
  /** Optional user scope. When omitted, processes all ACTIVE alerts. */
  userId?: string;
  /** Skip cooldown check (admin override / replay). Default false. */
  force?: boolean;
}

/**
 * Mutable per-RUN tally.
 *
 * Threaded as an argument rather than held at module scope: a Cloud Run
 * container serves many invocations, and a module-level counter would make a
 * per-run number a per-container one.
 */
interface RunTally {
  dataErrors: number;
  /**
   * Of those, the ones that disable an alert kind PLATFORM-WIDE — MONEY-1236.
   *
   * `dataErrors` counts both scopes and is what the run REPORTS. Only this
   * subset decides whether the run is RETRIED: see `judgeAlertRun`.
   */
  marketWideDataErrors: number;
  notifyFailures: number;
  alertErrors: number;
  /** Alerts that fired asking for a channel this worker cannot deliver. */
  channelGap: number;
  /** Alerts that fired asking for NO channel this worker can deliver. */
  silentFires: number;
}

/** What one run produced. Returned so the route can act on it (MONEY-1238). */
export interface AlertEvaluatorResult extends AlertRunTotals {
  ok: boolean;
  retriable: boolean;
  reason: string | null;
  channelGap: number;
  silentFires: number;
}

/**
 * Run one Prisma read, and COUNT a rejection instead of erasing it.
 *
 * The fallback behaviour is byte-identical to the `.catch(() => …)` it
 * replaces — deliberately, because one unreadable table must not abort the
 * other eleven alert kinds. What changes is that the run can now tell the
 * difference between "the table is empty" and "the table did not answer".
 */
async function readOr<T>(
  tally: RunTally,
  what: string,
  fallback: T,
  run: () => Promise<T>,
  scope: "PER_SYMBOL" | "MARKET_WIDE" = "PER_SYMBOL",
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    tally.dataErrors++;
    if (scope === "MARKET_WIDE") tally.marketWideDataErrors++;
    console.error(
      `[alert-evaluator] read FAILED (${what}) — treating as empty for this ` +
        `run, and the run is reported as not-ok:`,
      error instanceof Error ? error.message : String(error),
    );
    return fallback;
  }
}

interface PriceConditions {
  threshold: number;
  direction: "above" | "below";
}

interface VolumeConditions {
  multiplier: number;
}

interface EarningsConditions {
  daysBefore: number;
}

interface NewsConditions {
  /**
   * Optional keyword filter (case-insensitive substring match on title).
   * The live alert drawer writes a single `keyword` string; older/other
   * callers may write a `keywords` array — accept both.
   */
  keyword?: string;
  keywords?: string[];
}

interface CorpActionConditions {
  /** Fire when a corporate action falls within this many days (default 14). */
  daysBefore?: number;
  /** Optional action-type filter from the alert drawer, e.g. ["DIVIDEND","SPLIT"]. */
  actions?: string[];
}

// NSE action type → UpcomingEvent.category (matches the events-sync writer).
const ACTION_TO_CATEGORY: Record<string, string> = {
  DIVIDEND: "dividend",
  SPLIT: "splits",
  BONUS: "corp_action",
  RIGHTS: "corp_action",
};

function isWithinCooldown(
  lastFiredAt: Date | null,
  cooldownMinutes: number,
): boolean {
  if (!lastFiredAt) return false;
  const since = Date.now() - lastFiredAt.getTime();
  return since < cooldownMinutes * 60_000;
}

/**
 * Symbol → instrumentId via InstrumentMapping. `LatestQuote` and `DailyPrice`
 * are both keyed by instrumentId, not symbol.
 */
async function resolveInstrumentId(
  symbol: string,
  tally: RunTally,
): Promise<string | null> {
  const instrument = await readOr(
    tally,
    `instrumentMapping ${symbol}`,
    null as { id: string } | null,
    () =>
      prisma.instrumentMapping.findFirst({
        where: { symbol, isActive: true },
        select: { id: true },
      }),
  );
  return instrument?.id ?? null;
}

async function getLatestQuote(
  symbol: string,
  tally: RunTally,
): Promise<{
  price: number;
  volume: number;
  avgVolume30d: number;
} | null> {
  const instrumentId = await resolveInstrumentId(symbol, tally);
  if (!instrumentId) return null;
  const instrument = { id: instrumentId };

  const quote = await readOr(
    tally,
    `latestQuote ${symbol}`,
    null as { price: number | null; volume: number | null } | null,
    () =>
      prisma.latestQuote.findUnique({
        where: { instrumentId: instrument.id },
        select: { price: true, volume: true },
      }),
  );
  if (!quote || !quote.price) return null;

  // True 30-day average volume from the DailyPrice rollup, EXCLUDING today so
  // the baseline isn't damped by the very spike we're trying to detect. Zero
  // (no history) makes evaluateVolume bail rather than fire on a bogus ratio.
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const bars = await readOr(
    tally,
    `dailyPrice volume baseline ${symbol}`,
    [] as Array<{ volume: number }>,
    () =>
      prisma.dailyPrice.findMany({
        where: { instrumentId: instrument.id, date: { lt: startOfToday } },
        orderBy: { date: "desc" },
        take: 30,
        select: { volume: true },
      }),
  );
  const vols = bars.map((b) => b.volume).filter((v) => v > 0);
  const avgVolume30d = vols.length
    ? vols.reduce((a, b) => a + b, 0) / vols.length
    : 0;

  return {
    price: quote.price,
    volume: quote.volume ?? 0,
    avgVolume30d,
  };
}

/**
 * Write the notification and report whether the row LANDED — MONEY-1238.
 *
 * Every evaluator used to end `await createNotification(…).catch(() => {})`
 * followed by `return true`, so "the write threw" and "the user was notified"
 * were the same value. The caller then stamped `lastFiredAt`, and the cooldown
 * suppressed the retry that could have healed it. `tryCreateNotification` has
 * the identical never-throw contract and returns the outcome.
 */
async function notify(
  tally: RunTally,
  data: Parameters<typeof tryCreateNotification>[0],
): Promise<boolean> {
  const written = await tryCreateNotification(data);
  if (!written) tally.notifyFailures++;
  return written;
}

async function evaluatePrice(
  alert: {
    id: string;
    userId: string;
    symbol: string | null;
    conditions: unknown;
  },
  tally: RunTally,
): Promise<boolean> {
  if (!alert.symbol) return false;
  const c = alert.conditions as PriceConditions;
  if (typeof c?.threshold !== "number" || !c.direction) return false;
  const quote = await getLatestQuote(alert.symbol, tally);
  if (!quote) return false;
  const triggered =
    c.direction === "above"
      ? quote.price >= c.threshold
      : quote.price <= c.threshold;
  if (!triggered) return false;

  return notify(tally, {
    userId: alert.userId,
    type: "PRICE_ALERT",
    title: `${alert.symbol} crossed ₹${c.threshold}`,
    message: `LTP ${quote.price.toFixed(2)} ${c.direction === "above" ? "≥" : "≤"} ${c.threshold}`,
    metadata: {
      symbol: alert.symbol,
      alertId: alert.id,
      price: quote.price,
      threshold: c.threshold,
      direction: c.direction,
      deepLink: `/stock/${alert.symbol}`,
    },
  });
}

async function evaluateVolume(
  alert: {
    id: string;
    userId: string;
    symbol: string | null;
    conditions: unknown;
  },
  tally: RunTally,
): Promise<boolean> {
  if (!alert.symbol) return false;
  const c = alert.conditions as VolumeConditions;
  if (typeof c?.multiplier !== "number") return false;
  const quote = await getLatestQuote(alert.symbol, tally);
  if (!quote || quote.avgVolume30d <= 0) return false;
  const ratio = quote.volume / quote.avgVolume30d;
  if (ratio < c.multiplier) return false;

  return notify(tally, {
    userId: alert.userId,
    type: "VOLUME_ALERT",
    title: `${alert.symbol} volume spike`,
    message: `Today's volume is ${ratio.toFixed(2)}× the 30-day average`,
    metadata: {
      symbol: alert.symbol,
      alertId: alert.id,
      ratio,
      multiplier: c.multiplier,
      deepLink: `/stock/${alert.symbol}`,
    },
  });
}

async function evaluateEarningsDate(
  alert: {
    id: string;
    userId: string;
    symbol: string | null;
    conditions: unknown;
  },
  tally: RunTally,
): Promise<boolean> {
  if (!alert.symbol) return false;
  const c = alert.conditions as EarningsConditions;
  const days = c?.daysBefore ?? 7;
  const horizon = new Date(Date.now() + days * 86_400_000);
  const event = await readOr(
    tally,
    `upcomingEvent earnings ${alert.symbol}`,
    null as { date: Date; title: string } | null,
    () =>
      prisma.upcomingEvent.findFirst({
        where: {
          symbol: alert.symbol,
          category: "earnings",
          date: { gte: new Date(), lte: horizon },
        },
        orderBy: { date: "asc" },
        select: { date: true, title: true },
      }),
  );
  if (!event) return false;

  return notify(tally, {
    userId: alert.userId,
    type: "EARNINGS_REMINDER",
    title: `${alert.symbol} earnings ${event.date.toDateString()}`,
    message: event.title,
    metadata: {
      symbol: alert.symbol,
      alertId: alert.id,
      date: event.date.toISOString(),
      deepLink: `/stock/${alert.symbol}`,
    },
  });
}

async function evaluateNews(
  alert: {
    id: string;
    userId: string;
    symbol: string | null;
    conditions: unknown;
  },
  lastFiredAt: Date | null,
  tally: RunTally,
): Promise<boolean> {
  if (!alert.symbol) return false;
  const c = (alert.conditions ?? {}) as NewsConditions;

  // Only consider articles newer than the last fire (or the last 6h on the
  // first run) so we notify on genuinely new coverage, not the same article on
  // every tick. The enriched NewsArticle table is symbol-tagged (MONEY-408).
  const since = lastFiredAt ?? new Date(Date.now() - 6 * 3_600_000);
  const articles = await readOr(
    tally,
    `newsArticle ${alert.symbol}`,
    [] as Array<{
      title: string;
      url: string;
      source: string;
      sentiment: string | null;
    }>,
    () =>
      prisma.newsArticle.findMany({
        where: {
          symbols: { has: alert.symbol },
          publishedAt: { gt: since },
        },
        orderBy: { publishedAt: "desc" },
        take: 10,
        select: { title: true, url: true, source: true, sentiment: true },
      }),
  );
  if (articles.length === 0) return false;

  const keywords = (c.keywords ?? (c.keyword ? [c.keyword] : []))
    .map((k) => k.toLowerCase())
    .filter(Boolean);
  const match = keywords.length
    ? articles.find((a) =>
        keywords.some((k) => a.title.toLowerCase().includes(k)),
      )
    : articles[0];
  if (!match) return false;

  return notify(tally, {
    userId: alert.userId,
    type: "NEWS_ALERT",
    title: `${alert.symbol}: ${match.title.slice(0, 80)}`,
    message: match.sentiment
      ? `${match.source} · ${match.sentiment}`
      : match.source,
    metadata: {
      symbol: alert.symbol,
      alertId: alert.id,
      url: match.url,
      sentiment: match.sentiment,
      deepLink: `/stock/${alert.symbol}`,
    },
  });
}

async function evaluateCorporateAction(
  alert: {
    id: string;
    userId: string;
    symbol: string | null;
    conditions: unknown;
  },
  tally: RunTally,
): Promise<boolean> {
  if (!alert.symbol) return false;
  const c = (alert.conditions ?? {}) as CorpActionConditions;
  const days = c?.daysBefore ?? 14;
  const horizon = new Date(Date.now() + days * 86_400_000);

  // Honour the drawer's action-type selection (e.g. ["DIVIDEND","SPLIT"]) by
  // mapping it to UpcomingEvent categories; fall back to all corp categories
  // when none chosen. Rows are populated by the events-sync NSE writer.
  const wanted = (c.actions ?? [])
    .map((a) => ACTION_TO_CATEGORY[a.toUpperCase()])
    .filter((x): x is string => Boolean(x));
  const categories = wanted.length
    ? Array.from(new Set(wanted))
    : ["corp_action", "dividend", "splits"];
  const event = await readOr(
    tally,
    `upcomingEvent corp-action ${alert.symbol}`,
    null as { date: Date; title: string; category: string } | null,
    () =>
      prisma.upcomingEvent.findFirst({
        where: {
          symbol: alert.symbol,
          category: { in: categories },
          date: { gte: new Date(), lte: horizon },
        },
        orderBy: { date: "asc" },
        select: { date: true, title: true, category: true },
      }),
  );
  if (!event) return false;

  return notify(tally, {
    userId: alert.userId,
    type: "CORPORATE_ACTION",
    title: `${alert.symbol} ${event.category.replace(/_/g, " ")}`,
    message: event.title,
    metadata: {
      symbol: alert.symbol,
      alertId: alert.id,
      date: event.date.toISOString(),
      category: event.category,
      deepLink: `/stock/${alert.symbol}`,
    },
  });
}

// ─── MONEY-1204 (14e.3) data-engine kinds ────────────────────────────────────

/** The alert kinds answered from precomputed data-engine tables. */
export const DATA_ENGINE_ALERT_KINDS = [
  "FLAG_TRANSITION",
  "DELIVERY_SPIKE",
  "PLEDGE_INCREASE",
  "INSIDER_CLUSTER",
  "MWPL_HIGH",
  "FII_FLOW_STREAK",
] as const;

export type DataEngineAlertKind = (typeof DATA_ENGINE_ALERT_KINDS)[number];

const DATA_ENGINE_KIND_SET = new Set<string>(DATA_ENGINE_ALERT_KINDS);

/**
 * NotificationType for each data-engine kind.
 *
 * All six point at `SYSTEM` because the Prisma `NotificationType` enum does not
 * (yet) carry dedicated members for them, and inventing one at the call site
 * would fail the write — `createNotification` swallows the error, so the alert
 * would silently never notify. The precise kind travels in
 * `metadata.alertKind`, so the UI can already discriminate. When the enum gains
 * FLAG_TRANSITION/… members this map is the single line to change.
 */
const DATA_ENGINE_NOTIFICATION_TYPE: Record<
  DataEngineAlertKind,
  NotificationType
> = {
  FLAG_TRANSITION: "SYSTEM",
  DELIVERY_SPIKE: "SYSTEM",
  PLEDGE_INCREASE: "SYSTEM",
  INSIDER_CLUSTER: "SYSTEM",
  MWPL_HIGH: "SYSTEM",
  FII_FLOW_STREAK: "SYSTEM",
};

/** How far back the flag-state diff looks (calendar days). */
const FLAG_LOOKBACK_DAYS = 30;
/** How far back the flow-streak walk looks (calendar days). */
const FLOW_LOOKBACK_DAYS = 60;

/**
 * The prefix every DATABLE `ShareholdingPattern.quarter` starts with.
 *
 * `normalizeQuarter` (packages/research/.../ownership-logic.ts) canonicalises a
 * parseable period to `YYYY-MM` and keeps anything else VERBATIM and
 * upper-cased — `"Q1FY26"`, `"JUN 2026"`. In ASCII `"Q" > "2"`, so under
 * `orderBy: { quarter: "desc" }` every verbatim label sorts ABOVE every real
 * quarter. With `take: 8` and eight such labels the evaluator receives ZERO
 * datable rows, `evaluatePledgeIncrease` returns null, and a genuine +5.00pp
 * pledge jump is never reported — silently, because "no datable rows" and "no
 * jump" are the same `null`.
 *
 * Filtering in the QUERY rather than re-ranking after the fact is what matters:
 * a correct in-memory sort cannot recover a row the `take` already dropped.
 * `packages/research/src/data-sources/db-store.ts` defends the same table by
 * over-reading and re-ranking; this path caps at 8 and cannot, so it excludes
 * instead. `evaluatePledgeIncrease` still drops anything `quarterEndDate`
 * cannot parse, so a label that merely begins with "20" is harmless.
 */
const DATABLE_QUARTER_PREFIX = "20";

/**
 * Per-run caches for the two MARKET-WIDE reads.
 *
 * `observedDates` (which days the flag feed published) and `tradingDates`
 * (which days the flow table holds anything) are identical for every alert in
 * a run, and both are what makes an ABSENCE legible — "the flag cleared" vs
 * "NSE published nothing", "the FII row is missing" vs "the market was shut".
 * Fetching them once per run rather than once per alert keeps the added query
 * cost O(1) instead of O(alerts).
 */
interface RunContext {
  flagObservations?: FlagObservationLite[];
  flowTradingDates?: Date[];
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * `groupBy`, NOT `findMany({ distinct })`.
 *
 * `distinct` de-duplicates AFTER the rows are read, so on `StockFlag` — which
 * carries a row per symbol per day for whole-universe families like PRICE_BAND
 * — it would drag ~100k documents across the wire once per run to learn ~22
 * dates. `groupBy` compiles to a server-side `$group` served by the model's
 * `@@index([date])`, and returns exactly the days.
 *
 * Grouped by `["kind", "date"]`, NOT by `["date"]` alone. A single market-wide
 * day list conflates the families: `WK52_HIGH_LOW` and `SHORT_SELLING` publish
 * the whole universe every session, so with a date-only group EVERY trading day
 * reads as a day the surveillance and F&O-ban files also published. A stock
 * under continuous ASM whose surveillance file skipped one day then produces a
 * fabricated EXIT/ENTRY pair and a "entered surveillance" notification (see
 * `FlagTransitionInput.observations`). The extra grouping key costs ~7x the
 * group count — roughly 150 rows instead of 22 — and is still one query per
 * run.
 */
async function getFlagObservations(
  ctx: RunContext,
  tally: RunTally,
): Promise<FlagObservationLite[]> {
  if (ctx.flagObservations) return ctx.flagObservations;
  // MONEY-1238 — the most expensive swallow in the file. This read is
  // market-WIDE and cached for the whole run, so one rejection silently
  // disables FLAG_TRANSITION for every user at once: `observations` arrives
  // empty, `detectFlagTransitions` has no day list to diff against, and every
  // ASM/GSM entry and exit on the platform goes unreported while the run logs
  // `fired 0` and answers 200. It is counted now.
  const rows = await readOr(
    tally,
    "stockFlag.groupBy (MARKET-WIDE — every FLAG_TRANSITION alert depends on it)",
    [] as Array<{ kind: string; date: Date }>,
    async () => {
      // Called, then mapped, rather than returned inline: Prisma's `groupBy`
      // overload resolution reads the CONTEXTUAL return type, and a generic
      // helper's `Promise<T>` makes it pick the wrong one (TS2345).
      const grouped = await prisma.stockFlag.groupBy({
        by: ["kind", "date"],
        where: { date: { gte: daysAgo(FLAG_LOOKBACK_DAYS) } },
        orderBy: [{ kind: "asc" }, { date: "asc" }],
      });
      return grouped.map((r) => ({ kind: r.kind, date: r.date }));
    },
    "MARKET_WIDE",
  );
  ctx.flagObservations = rows.map((r) => ({ kind: r.kind, date: r.date }));
  return ctx.flagObservations;
}

async function getFlowTradingDates(
  ctx: RunContext,
  tally: RunTally,
): Promise<Date[]> {
  if (ctx.flowTradingDates) return ctx.flowTradingDates;
  const rows = await readOr(
    tally,
    "institutionalFlow.groupBy (MARKET-WIDE — every FII_FLOW_STREAK alert depends on it)",
    [] as Array<{ date: Date }>,
    async () => {
      // Same contextual-typing constraint as getFlagObservations above.
      const grouped = await prisma.institutionalFlow.groupBy({
        by: ["date"],
        where: { date: { gte: daysAgo(FLOW_LOOKBACK_DAYS) } },
        orderBy: { date: "asc" },
      });
      return grouped.map((r) => ({ date: r.date }));
    },
    "MARKET_WIDE",
  );
  ctx.flowTradingDates = rows.map((r) => r.date);
  return ctx.flowTradingDates;
}

/**
 * Read the precomputed rows for one data-engine alert and hand them to the pure
 * evaluator. Returns the event (carrying its CROSSING DATE) or null.
 */
async function evaluateDataEngineAlert(
  alert: {
    kind: string;
    symbol: string | null;
    conditions: unknown;
  },
  ctx: RunContext,
  tally: RunTally,
): Promise<AlertEvent | null> {
  const { kind, symbol, conditions } = alert;

  // FII_FLOW_STREAK is the one market-WIDE kind: InstitutionalFlow has no
  // symbol column at all (one row per day/category/segment for the whole
  // market), so it needs no `alert.symbol`.
  if (kind === "FII_FLOW_STREAK") {
    const rawCategory =
      conditions && typeof conditions === "object"
        ? (conditions as Record<string, unknown>).category
        : undefined;
    const category =
      typeof rawCategory === "string" && rawCategory.trim()
        ? rawCategory.trim().toUpperCase()
        : "FII";
    const [rows, tradingDates] = await Promise.all([
      prisma.institutionalFlow.findMany({
        where: { category, date: { gte: daysAgo(FLOW_LOOKBACK_DAYS) } },
        select: { date: true, netValue: true },
        orderBy: { date: "asc" },
      }),
      getFlowTradingDates(ctx, tally),
    ]);
    return evaluateFiiFlowStreak({ category, rows, tradingDates, conditions });
  }

  if (!symbol) return null;

  if (kind === "FLAG_TRANSITION") {
    const [rows, observations] = await Promise.all([
      prisma.stockFlag.findMany({
        where: { symbol, date: { gte: daysAgo(FLAG_LOOKBACK_DAYS) } },
        select: { date: true, kind: true, value: true },
        orderBy: { date: "asc" },
      }),
      getFlagObservations(ctx, tally),
    ]);
    return evaluateFlagTransition({ symbol, rows, observations, conditions });
  }

  if (kind === "DELIVERY_SPIKE") {
    const instrumentId = await resolveInstrumentId(symbol, tally);
    if (!instrumentId) return null;
    // One extra row so the newest bar can be judged against the 20 BEFORE it —
    // including today in its own baseline damps exactly the spike being looked
    // for (same reason evaluateVolume excludes today).
    const bars = await prisma.dailyPrice.findMany({
      where: { instrumentId },
      orderBy: { date: "desc" },
      take: DELIVERY_BASELINE_DAYS + 1,
      select: { date: true, deliveryPct: true },
    });
    const latest = bars[0];
    if (!latest || bars.length < 2) return null;
    return evaluateDeliverySpike({
      symbol,
      latest,
      baseline: bars.slice(1),
      conditions,
    });
  }

  if (kind === "PLEDGE_INCREASE") {
    const rows = await prisma.shareholdingPattern.findMany({
      // The prefix filter is what keeps the `take` cap spendable on rows the
      // evaluator can actually date — see DATABLE_QUARTER_PREFIX.
      where: { symbol, quarter: { startsWith: DATABLE_QUARTER_PREFIX } },
      orderBy: { quarter: "desc" },
      take: 8,
      select: { quarter: true, pledgedPct: true },
    });
    return evaluatePledgeIncrease({ symbol, rows, conditions });
  }

  if (kind === "INSIDER_CLUSTER") {
    // 3x the window so a slid window still has its older members in hand.
    const events = await prisma.insiderEvent.findMany({
      where: {
        symbol,
        date: { gte: daysAgo(INSIDER_CLUSTER_WINDOW_DAYS * 3) },
      },
      orderBy: { date: "asc" },
      select: { date: true, action: true, category: true, person: true },
    });
    return evaluateInsiderCluster({ symbol, events, conditions });
  }

  if (kind === "MWPL_HIGH") {
    // DORMANT BY DESIGN: MwplDaily.utilisationPct is NULL on every row and
    // stays null until a source for the DENOMINATOR (the market-wide position
    // limit) exists — `mwpl_cli`'s registry path 404s and it has zero archived
    // objects, and the neighbouring `oi_cli_limit` carries a PER-CLIENT limit,
    // a different quantity that would yield a plausible WRONG utilisation this
    // alert would then fire on. The evaluator is gated on `!= null` and simply
    // returns null today; when a real feed lands it starts working with no code
    // change. Do NOT substitute another denominator to make it fire.
    const rows = await prisma.mwplDaily.findMany({
      where: { symbol },
      orderBy: { date: "desc" },
      take: 30,
      select: { date: true, utilisationPct: true },
    });
    return evaluateMwplHigh({ symbol, rows, conditions });
  }

  return null;
}

export async function processAlertEvaluator(
  data: AlertEvaluatorMessage,
): Promise<AlertEvaluatorResult> {
  const where: Record<string, unknown> = { status: "ACTIVE" };
  if (data.userId) where.userId = data.userId;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alerts = await (prisma as any).alert.findMany({ where });

  const ctx: RunContext = {};
  const tally: RunTally = {
    dataErrors: 0,
    marketWideDataErrors: 0,
    notifyFailures: 0,
    alertErrors: 0,
    channelGap: 0,
    silentFires: 0,
  };
  let fired = 0;
  let suppressedAsRepeat = 0;
  for (const alert of alerts as Array<{
    id: string;
    userId: string;
    kind: string;
    symbol: string | null;
    conditions: unknown;
    notifyChannels: string[];
    lastFiredAt: Date | null;
    cooldownMinutes: number;
  }>) {
    if (
      !data.force &&
      isWithinCooldown(alert.lastFiredAt, alert.cooldownMinutes)
    ) {
      continue;
    }

    let triggered = false;
    try {
      if (alert.kind === "PRICE") {
        triggered = await evaluatePrice(alert, tally);
      } else if (alert.kind === "VOLUME") {
        triggered = await evaluateVolume(alert, tally);
      } else if (alert.kind === "EARNINGS_DATE") {
        triggered = await evaluateEarningsDate(alert, tally);
      } else if (alert.kind === "NEWS") {
        triggered = await evaluateNews(alert, alert.lastFiredAt, tally);
      } else if (alert.kind === "CORPORATE_ACTION") {
        triggered = await evaluateCorporateAction(alert, tally);
      } else if (DATA_ENGINE_KIND_SET.has(alert.kind)) {
        const event = await evaluateDataEngineAlert(alert, ctx, tally);
        if (event) {
          // EVENT IDEMPOTENCY (not the cooldown — see the module doc). The
          // evaluator returned the date the condition CROSSED; if we have
          // already fired at or after it, this is the same fact restated (a
          // flag still set, a streak still running) and we stay silent.
          // `force` is an explicit admin replay and bypasses both gates.
          if (
            !data.force &&
            shouldSuppressRepeat(alert.lastFiredAt, event.eventDate)
          ) {
            suppressedAsRepeat++;
          } else {
            triggered = await notify(tally, {
              userId: alert.userId,
              type: DATA_ENGINE_NOTIFICATION_TYPE[
                alert.kind as DataEngineAlertKind
              ],
              title: event.title,
              message: event.message,
              metadata: {
                ...event.metadata,
                alertId: alert.id,
                alertKind: alert.kind,
                symbol: alert.symbol,
                eventDate: event.eventDate.toISOString(),
                ...(alert.symbol ? { deepLink: `/stock/${alert.symbol}` } : {}),
              },
            });
          }
        }
      }
    } catch (error) {
      tally.alertErrors++;
      console.warn(
        `[alert-evaluator] alert ${alert.id} threw:`,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }

    if (triggered) {
      fired++;

      // MONEY-1238 — `notifyChannels` is READ. It was declared on two of this
      // file's alert types and never used, which is worse than absent: a field
      // named for a delivery channel reads as coverage. What it actually
      // describes is a gap. This worker delivers IN_APP and nothing else, while
      // BOTH creation surfaces tick Email by default, so an alert asking for
      // EMAIL gets a `Notification` row and no email; an alert asking ONLY for
      // EMAIL or PUSH gets nothing it asked for and a `lastFiredAt` that says
      // it was delivered. Wiring real email needs @usemoney/email, a template
      // and a sender identity — a feature, not this fix — so the field is wired
      // to the one thing reachable from here: the run's reported numbers. The
      // gap is now measured instead of assumed.
      const undelivered = undeliverableChannels(alert.notifyChannels ?? []);
      if (undelivered.length > 0) tally.channelGap++;
      if (isSilentDelivery(alert.notifyChannels ?? [])) {
        tally.silentFires++;
        console.warn(
          `[alert-evaluator] alert ${alert.id} fired but requests only ` +
            `${undelivered.join("/")} — this worker delivers IN_APP only, so ` +
            `the user was NOT notified on any channel they chose`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).alert.update({
        where: { id: alert.id },
        data: { lastFiredAt: new Date() },
      });
    }
  }

  const totals: AlertRunTotals = {
    evaluated: alerts.length,
    fired,
    suppressedAsRepeat,
    dataErrors: tally.dataErrors,
    marketWideDataErrors: tally.marketWideDataErrors,
    notifyFailures: tally.notifyFailures,
    alertErrors: tally.alertErrors,
  };
  const verdict = judgeAlertRun(totals);

  const line =
    `[alert-evaluator] Evaluated ${alerts.length} alerts, fired ${fired}, ` +
    `suppressed ${suppressedAsRepeat} as already-reported events, ` +
    `dataErrors ${tally.dataErrors} (${tally.marketWideDataErrors} market-wide), ` +
    `notifyFailures ${tally.notifyFailures}, ` +
    `alertErrors ${tally.alertErrors}, channelGap ${tally.channelGap}, ` +
    `silentFires ${tally.silentFires}`;
  if (verdict.ok) {
    console.log(line);
  } else {
    console.error(`${line} — NOT OK: ${verdict.reason}`);
  }

  // MONEY-1250 — `selected` is CONDITIONS MET, not alerts evaluated.
  //
  // This job runs `* 9-15 * * 1-5` plus `*/5` off-hours: ~624 times a day,
  // against every ACTIVE alert row. Pairing `evaluated` with `fired` would
  // report "selected 4,000, wrote 0" on almost every one of those runs, because
  // an alert whose price threshold was not crossed is supposed to write
  // nothing. That alarm fires all day, gets muted inside a week, and then the
  // one run that IS broken is invisible — which is the failure this monitor
  // exists to prevent, reproduced by the monitor.
  //
  // `fired + notifyFailures` is the honest denominator. Every evaluator ends by
  // RETURNING `notify(...)`, and it only reaches that call once its condition
  // is confirmed, so each alert that met its condition lands in exactly one of
  // the two: `fired` when the Notification row was persisted (which is also
  // when `alert.update` stamps `lastFiredAt`), `notifyFailures` when the write
  // threw. There is no third outcome. So `selected > 0 && written === 0` reads
  // as "every alert that fired failed to notify anybody", and a quiet market
  // reports `selected 0` and cannot page.
  //
  // `suppressedAsRepeat` is deliberately excluded: the event-date idempotency
  // gate declining to re-notify is a correct non-write, not an owed one.
  const conditionsMet = fired + tally.notifyFailures;
  reportJobOutcome({
    job: "alert-evaluator",
    selected: conditionsMet,
    written: fired,
    failed: tally.notifyFailures + tally.alertErrors,
    // `marketWideDataErrors` is carried here because it is the one counter that
    // makes a run RETRIABLE (`judgeAlertRun`): a failed groupBy disables a whole
    // alert KIND platform-wide, and it can do that while `conditionsMet` is 0 —
    // which is precisely a state the selected/written pair cannot see.
    skippedReason:
      `${verdict.reason ?? "ok"}; evaluated=${alerts.length} ` +
      `conditionsMet=${conditionsMet} fired=${fired} ` +
      `notifyFailures=${tally.notifyFailures} ` +
      `suppressedAsRepeat=${suppressedAsRepeat} ` +
      `dataErrors=${tally.dataErrors} ` +
      `marketWideDataErrors=${tally.marketWideDataErrors} ` +
      `alertErrors=${tally.alertErrors} channelGap=${tally.channelGap} ` +
      `silentFires=${tally.silentFires}`,
  });

  return {
    ...totals,
    ok: verdict.ok,
    retriable: verdict.retriable,
    reason: verdict.reason,
    channelGap: tally.channelGap,
    silentFires: tally.silentFires,
  };
}
