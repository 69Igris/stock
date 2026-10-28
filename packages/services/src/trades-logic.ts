/**
 * Trades pure-logic helpers (service layer).
 *
 * These are the side-effect-free calculation/aggregation helpers used by
 * `getTrades` (+ `createTrade` / `closePosition`) in `./trades.service.ts`.
 * They are isolated here (away from the Prisma-importing service) so they can
 * be unit-tested without pulling in the Prisma client at import time, and so the
 * LIVE user-facing tradebook path runs the SAME guarded math the test asserts —
 * no shadow, no inline unguarded arithmetic.
 *
 * Behaviour here is identical, for FINITE inputs, to the logic that previously
 * lived inline in `getTrades`; the service now CALLS these helpers. MONEY-840:
 * the read-time `pairTrades` FIFO pairer was REMOVED — status + realised P&L now
 * come from the persisted `PairedTradeView` the worker writes, surfaced via
 * `buildPairedStatusMap` / `buildRealizedPnLByTradeMap` here. The only
 * intentional behavioural differences are defensive:
 *
 *   - PAGINATION: `clampPagination` mirrors `./notifications-pagination.ts`.
 *     `getTrades` forwards `filters.limit`/`filters.skip` straight to Prisma
 *     `take`/`skip`. The web action (`TradeFilterSchema.parse`) and the api
 *     route both *pre*-validate, but the service is a library export callable
 *     with un-validated input, and Prisma 5 THROWS on a non-finite / negative
 *     `take`|`skip` (`Invalid value … Expected Int`) — a stray `?limit=abc`
 *     becomes a 500. Clamping makes the service safe by itself (defense-in-depth).
 *   - NON-FINITE: a `NaN`/`±Infinity` price or quantity (a corrupt sync/import
 *     row) can no longer poison `tradeValue`, an average price, a realized-P&L,
 *     or the win/loss totals (one bad row used to render "₹NaN").
 *   - INVALID DATE: a corrupt `tradeDate` no longer throws `RangeError` on
 *     `.toISOString()` while building the pairing group key or sorting — such a
 *     row simply lands in its own un-pairable bucket / sorts last.
 *
 * Mirrors the `finite()` precedent in `./dashboard-logic.ts` and the
 * `clampPagination` precedent in `./notifications-pagination.ts`.
 *
 * @see apps/web/__tests__/services/trades-poison-live.test.ts
 * @see apps/web/__tests__/services/trades-logic-unit.test.ts
 */

import { getSegmentFilterValues } from "./mappings";
import { fyWindowUtc } from "./tax-logic";

// ---------------------------------------------------------------------------
// Non-finite guard (local, per task: do not import a shared finite())
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Trade aggregation is a SUM/PRODUCT surface: a single `NaN`/`Infinity` addend
 * or factor poisons the whole reduce (one bad trade row => the tradebook renders
 * "₹NaN" P&L). Stored broker/import values are occasionally `NaN`/`Infinity`,
 * so every value that enters a sum, a product, a ratio, or a downstream
 * `.toFixed()`/`.toLocaleString()` is funnelled through this guard first.
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 * Local twin of `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Pagination clamp (mirrors ./notifications-pagination.ts)
// ---------------------------------------------------------------------------

/** Default page size when `limit` is omitted/unusable. */
export const DEFAULT_TRADE_LIMIT = 20;

/**
 * Hard ceiling on a single tradebook page. Bounds memory + payload regardless
 * of what a caller (or a hand-crafted `?limit=` query) asks for. Matches the
 * `TradeFilterSchema` ceiling (`z.number().max(100)`).
 */
export const MAX_TRADE_LIMIT = 100;

export interface TradePaginationBounds {
  /** Safe `take`: integer in [1, MAX_TRADE_LIMIT]. */
  take: number;
  /** Safe `skip`: non-negative integer. */
  skip: number;
}

/**
 * Coerce a possibly-untrusted numeric input to a finite integer, or `null` when
 * it can't be (NaN, ±Infinity, non-number). Floats are truncated toward zero.
 */
function toFiniteInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Clamp a (limit, skip) pair into safe Prisma `take`/`skip` bounds.
 *
 * - `limit`: NaN / Infinity / non-number / ≤ 0 → DEFAULT_TRADE_LIMIT;
 *   anything above MAX_TRADE_LIMIT is capped to it; floats truncated.
 * - `skip`: NaN / Infinity / non-number / negative → 0; floats truncated.
 *
 * Pure + total: never throws, always returns a finite positive `take` and a
 * non-negative `skip` — so `prisma.trade.findMany({ take, skip })` can never
 * throw the Prisma "Expected Int" error on a stray query string.
 */
export function clampPagination(
  limit: unknown = DEFAULT_TRADE_LIMIT,
  skip: unknown = 0,
): TradePaginationBounds {
  const rawLimit = toFiniteInt(limit);
  const take =
    rawLimit === null || rawLimit <= 0
      ? DEFAULT_TRADE_LIMIT
      : Math.min(rawLimit, MAX_TRADE_LIMIT);

  const rawSkip = toFiniteInt(skip);
  const safeSkip = rawSkip === null || rawSkip < 0 ? 0 : rawSkip;

  return { take, skip: safeSkip };
}

// ---------------------------------------------------------------------------
// Trade value
// ---------------------------------------------------------------------------

/**
 * Trade value = quantity × price, finite-guarded.
 *
 * A `NaN`/`Infinity` quantity or price (corrupt import) must never produce a
 * `NaN`/`Infinity` `tradeValue` that a consumer would feed to
 * `.toFixed()`/`.toLocaleString()`. Either factor being non-finite collapses
 * the product to 0.
 */
export function tradeValue(
  quantity: number | null | undefined,
  price: number | null | undefined,
): number {
  return finite(finite(quantity) * finite(price));
}

// ---------------------------------------------------------------------------
// Date helpers (Invalid-Date safe)
// ---------------------------------------------------------------------------

/**
 * The `YYYY-MM-DD` key a trade is grouped under for FIFO pairing, or `null`
 * when the date is unusable. `new Date("garbage").toISOString()` throws
 * `RangeError`; one corrupt `tradeDate` would otherwise crash the whole
 * tradebook. A `null` key forces the row into its own un-pairable bucket
 * (it stays OPEN), which is the safe, non-throwing outcome.
 */
export function safeISODateKey(value: Date | string | number): string | null {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  // ISO timestamps always contain a "T", so [0] is always a string.
  return new Date(time).toISOString().split("T")[0]!;
}

/**
 * Descending tradeDate comparator that never throws and never mis-orders on an
 * Invalid Date. Valid dates sort newest-first; any Invalid Date sorts AFTER all
 * valid ones (so a corrupt row sinks to the bottom rather than scrambling the
 * page via `NaN` comparisons, which would leave the array order undefined).
 */
export function compareTradeDateDesc(
  a: { tradeDate: Date | string | number },
  b: { tradeDate: Date | string | number },
): number {
  const ta = new Date(a.tradeDate).getTime();
  const tb = new Date(b.tradeDate).getTime();
  const aBad = !Number.isFinite(ta);
  const bBad = !Number.isFinite(tb);
  if (aBad && bBad) return 0;
  if (aBad) return 1; // a after b
  if (bBad) return -1; // b after a
  return tb - ta; // newest first
}

// ---------------------------------------------------------------------------
// Persisted-pairing read mapping (MONEY-840)
// ---------------------------------------------------------------------------
//
// The tradebook no longer pairs trades per-page at read time (the old
// `pairTrades` did, keyed by symbol+exchange+broker+TRADE-DATE — which meant a
// multi-day delivery, BUY on day 1 and SELL on day 30, never paired and showed
// OPEN forever). Status + realised P&L now come from the PERSISTED
// `PairedTradeView` rows the worker's FIFO engine wrote (full per-symbol history,
// not date-keyed). These pure helpers turn those view rows into the per-Trade-row
// status pill + per-row realised P&L the service maps onto each Trade.

/** The PairedTradeView columns the read-mapping helpers consume. */
export interface PairedViewRow {
  /** Every Trade.id that contributed to this paired lot (buys + sells). */
  sourceTradeIds: string[];
  /** The opening (BUY) Trade.id, if known. */
  entryTradeId: string | null;
  /** The closing (SELL) Trade.id — the row that "realised" the lot — if known. */
  exitTradeId: string | null;
  /** Lot status as computed by the FIFO engine. */
  status: string;
  /** Realised P&L of the lot (CLOSED/PARTIAL), or null. */
  realizedPnL: number | null;
}

/** Per-Trade-row status derived from the persisted views. */
export type PairedRowStatus = "CLOSED" | "PARTIAL" | "OPEN";

/** Status precedence — a trade that touches a CLOSED lot outranks PARTIAL/OPEN. */
const STATUS_RANK: Record<PairedRowStatus, number> = {
  OPEN: 0,
  PARTIAL: 1,
  CLOSED: 2,
};

/** Collect every Trade.id a view references (sources + entry + exit), de-duped. */
function tradeIdsOfView(view: PairedViewRow): string[] {
  const ids = new Set<string>(view.sourceTradeIds ?? []);
  if (view.entryTradeId) ids.add(view.entryTradeId);
  if (view.exitTradeId) ids.add(view.exitTradeId);
  return Array.from(ids);
}

/**
 * Map each Trade.id to its strongest paired status across all the persisted
 * `PairedTradeView` rows it appears in. A trade can sit in several lots (e.g. one
 * big buy partly closed by several sells, with an open remainder) — we surface
 * the HIGHEST-precedence status (CLOSED > PARTIAL > OPEN) so a fully-realised lot
 * shows CLOSED and a part-closed holding shows PARTIAL.
 *
 * A view `status` that isn't one of the three known values is treated as OPEN
 * (rank 0) so it can never spuriously mark a row CLOSED. Trades absent from every
 * view (e.g. just synced, before pairing ran, or a still-open buy with no lot
 * yet) won't appear in the map at all — the caller defaults them to OPEN.
 */
export function buildPairedStatusMap(
  views: PairedViewRow[],
): Map<string, PairedRowStatus> {
  const map = new Map<string, PairedRowStatus>();
  for (const view of views) {
    const status: PairedRowStatus =
      view.status === "CLOSED" || view.status === "PARTIAL"
        ? view.status
        : "OPEN";
    for (const id of tradeIdsOfView(view)) {
      const prev = map.get(id);
      if (prev === undefined || STATUS_RANK[status] > STATUS_RANK[prev]) {
        map.set(id, status);
      }
    }
  }
  return map;
}

/**
 * Map each closing-side Trade.id to the realised P&L it locked in. Each
 * CLOSED/PARTIAL view's `realizedPnL` is attributed to its `exitTradeId` (the
 * SELL that realised the lot) — that's the row a user expects to show a ₹ figure
 * in the tradebook. A trade that's the exit of multiple lots accumulates them.
 *
 * Finite-guarded: a corrupt/non-finite stored `realizedPnL` contributes 0 rather
 * than poisoning the row (and, downstream, any `.toFixed()`/`.toLocaleString()`).
 * OPEN views (no realised component) and views with no `exitTradeId` are skipped.
 */
export function buildRealizedPnLByTradeMap(
  views: PairedViewRow[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const view of views) {
    if (view.status === "OPEN") continue;
    const exitId = view.exitTradeId;
    if (!exitId) continue;
    const pnl = finite(view.realizedPnL);
    map.set(exitId, finite((map.get(exitId) ?? 0) + pnl));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Where-clause building (IDOR-scoped, no injection)
// ---------------------------------------------------------------------------

/** Filters consumed by `buildTradeWhereClause` (subset of TradeFilterInput). */
export interface TradeWhereFilters {
  symbol?: string;
  broker?: string;
  segment?: string;
  tradeType?: string;
  productType?: string;
  fromDate?: string;
  toDate?: string;
}

/**
 * Build the Prisma where clause for trade queries.
 *
 * SECURITY: `userId` is always the FIRST key, so every query is scoped to the
 * caller — no filter value can widen the scope to another user's rows (IDOR).
 * String filters are passed as Prisma operators (`contains`/`in`/equality), not
 * interpolated into a query, so there is no injection surface. `"all"` disables
 * the broker/segment/tradeType filters. Broker handling differs from positions:
 * `"manual"` maps to `brokerName: "manual"` (not `broker: null`), and a
 * `"BROKER:brokerUserId"` value is split into the two equality filters.
 */
export function buildTradeWhereClause(
  userId: string,
  filters: TradeWhereFilters,
): Record<string, unknown> {
  const where: Record<string, unknown> = { userId };

  if (filters.symbol) {
    where.symbol = { contains: filters.symbol, mode: "insensitive" };
  }
  if (filters.broker && filters.broker !== "all") {
    if (filters.broker === "manual") {
      where.brokerName = "manual";
    } else if (filters.broker.includes(":")) {
      const [broker, brokerUserId] = filters.broker.split(":");
      where.broker = broker;
      if (brokerUserId) where.brokerUserId = brokerUserId;
    } else {
      where.broker = filters.broker;
    }
  }
  if (filters.segment && filters.segment !== "all") {
    where.segment = { in: getSegmentFilterValues(filters.segment) };
  }
  if (filters.tradeType && filters.tradeType !== "all") {
    where.tradeType = filters.tradeType;
  }
  if (filters.productType && filters.productType !== "all") {
    where.productType = filters.productType;
  }
  if (filters.fromDate || filters.toDate) {
    const dateFilter: Record<string, Date> = {};
    // MONEY-846: the FY/period window is IST-anchored, NOT naive-UTC and NOT the
    // server's LOCAL zone. The previous code did `gte = new Date(fromDate)`
    // (UTC midnight) and `toDate.setHours(23,59,59,999)` (LOCAL midnight-1ms) —
    // so (a) a trade in the +5:30 sliver after 1-Apr IST midnight (US stocks,
    // crypto, manual/off-hours, date-only timestamps) was dropped or mis-bucketed,
    // and (b) `setHours` made the upper bound DIFFER between prod (UTC runtime)
    // and an IST dev box. Both bounds now resolve to the IST wall-clock instant
    // via `istDayBound` (the single source of truth shared with tax-logic's
    // `fyWindowUtc`). A caller may pass either a date-only `YYYY-MM-DD` (rolling
    // pills, custom dates) — interpreted as the IST start/end of that day — or a
    // full ISO instant (the FY dropdown, which now emits `fyWindowUtc` bounds) —
    // taken as-is. An unparseable bound yields an Invalid Date; Prisma rejects it
    // and the service's try/catch turns it into a sanitized failure (no leak).
    if (filters.fromDate)
      dateFilter.gte = istDayBound(filters.fromDate, "start");
    if (filters.toDate) dateFilter.lte = istDayBound(filters.toDate, "end");
    where.tradeDate = dateFilter;
  }

  return where;
}

/**
 * Resolve a trade-window bound to its precise UTC instant, IST-anchored
 * (MONEY-846). The Indian financial year / period filter is keyed off IST
 * wall-clock days, but the DB stores UTC instants, so a bound must be the IST
 * day boundary converted to UTC (subtract the +5:30 offset).
 *
 * - A FULL ISO instant (contains `T`, e.g. the `fyWindowUtc` bound the FY
 *   dropdown now emits, `"2025-03-31T18:30:00.000Z"`) is already an exact
 *   instant → returned verbatim (the `which` is ignored; the caller pre-baked
 *   the correct edge).
 * - A date-only `YYYY-MM-DD` (rolling pills / custom-date inputs) is interpreted
 *   as that calendar day IN IST: `start` → 00:00:00.000 IST, `end` →
 *   23:59:59.999 IST, each converted to the matching UTC instant.
 *
 * An unparseable value yields an Invalid Date (its `.getTime()` is `NaN`), which
 * is propagated unchanged — `buildTradeWhereClause`'s caller relies on Prisma
 * rejecting it rather than this layer throwing.
 */
export function istDayBound(value: string, which: "start" | "end"): Date {
  // A full ISO instant already pins the exact moment — don't re-anchor it.
  if (value.includes("T")) return new Date(value);
  // Date-only `YYYY-MM-DD`: build the IST wall-clock edge as a UTC instant.
  // `Date.UTC(y, m, d, …)` gives the UTC instant of that wall-clock time; we
  // then subtract the IST offset so it represents the IST wall-clock moment.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return new Date(value); // malformed → Invalid Date (Prisma rejects)
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo) - 1; // Date.UTC month is 0-indexed
  const day = Number(d);
  const utcOfIstWallClock =
    which === "start"
      ? Date.UTC(year, month, day, 0, 0, 0, 0)
      : Date.UTC(year, month, day, 23, 59, 59, 999);
  return new Date(utcOfIstWallClock - IST_OFFSET_MS);
}

/** India Standard Time offset from UTC in ms (UTC+5:30, no DST). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Build the Prisma where clause for the PERSISTED `PairedTradeView` stats query
 * (MONEY-840), from the SAME trade filters the tradebook applies, so the realised
 * P&L / win-rate strip responds to the active symbol/broker/segment/date filter.
 *
 * Mirrors `buildTradeWhereClause` but onto the view's columns. The columns that
 * map cleanly carry over: `symbol` (contains), `broker`(+`brokerUserId`),
 * `segment` (bucketed via the shared `getSegmentFilterValues`), and the date
 * window onto `entryDate` (IST-anchored via `istDayBound`, same as the trade
 * query). The trade-only filters `tradeType` and `productType` are intentionally
 * dropped: a paired LOT spans both a BUY and a SELL, so a one-sided side/product
 * filter has no meaning on a lot — this matches `getPairedTrades`, which also
 * doesn't filter views by tradeType. `userId` is always the first key (IDOR).
 *
 * Note: `manual` maps to `broker: null` here (the view stores the BrokerType enum
 * or null), NOT `brokerName` — the view has no `brokerName` column.
 */
export function buildPairedViewWhereClause(
  userId: string,
  filters: TradeWhereFilters,
): Record<string, unknown> {
  const where: Record<string, unknown> = { userId };

  if (filters.symbol) {
    where.symbol = { contains: filters.symbol, mode: "insensitive" };
  }
  if (filters.broker && filters.broker !== "all") {
    if (filters.broker === "manual") {
      where.broker = null;
    } else if (filters.broker.includes(":")) {
      const [broker, brokerUserId] = filters.broker.split(":");
      where.broker = broker;
      if (brokerUserId) where.brokerUserId = brokerUserId;
    } else {
      where.broker = filters.broker;
    }
  }
  if (filters.segment && filters.segment !== "all") {
    where.segment = { in: getSegmentFilterValues(filters.segment) };
  }
  if (filters.fromDate || filters.toDate) {
    const dateFilter: Record<string, Date> = {};
    if (filters.fromDate)
      dateFilter.gte = istDayBound(filters.fromDate, "start");
    if (filters.toDate) dateFilter.lte = istDayBound(filters.toDate, "end");
    where.entryDate = dateFilter;
  }

  return where;
}

// ---------------------------------------------------------------------------
// Stats aggregation
// ---------------------------------------------------------------------------

export interface TradeStats {
  totalPnL: number;
  winRate: number;
  winners: number;
  losers: number;
  /**
   * Count of CLOSED trades (the win-rate denominator). The client renders a
   * win-rate sub-line off this (`stats.closedCount`); it was computed by the
   * service but dropped from the returned stats (MONEY-846 Pair 1c), so the
   * sub-line vanished after any fetch. Always a non-negative integer.
   */
  closedCount: number;
  totalTrades: number;
  /**
   * MONEY-1257 — BUY / SELL split across the WHOLE filtered set.
   *
   * The tradebook tile put the server `total` above a split the CLIENT derived
   * from one page, so "125" sat over "20 buys · 0 sells" — two populations
   * shown as one fact, and the "0 sells" read as a claim that the user had
   * never sold. Scoped by the same `where` as `totalTrades`, so
   * buyCount + sellCount === totalTrades for any filter.
   */
  buyCount: number;
  sellCount: number;
}

/**
 * Assemble tradebook stats from the DB-level aggregates `getTrades` computes:
 * the summed realized P&L of CLOSED trades, the winner count (CLOSED with
 * `realizedPnL > 0`), the CLOSED count, and the (filtered) total count.
 *
 * - `totalPnL` is finite-guarded so a corrupt stored sum can't surface "₹NaN".
 * - `winRate` is `round(winners / closed * 100)`, or 0 when there are no closed
 *   trades (no divide-by-zero → `NaN`). `winners`/`losers`/counts are clamped to
 *   safe non-negative integers so `losers = closed - winners` is never negative.
 */
export function assembleTradeStats(
  closedRealizedPnLSum: number | null | undefined,
  winnerCount: number | null | undefined,
  closedCount: number | null | undefined,
  total: number | null | undefined,
  /**
   * MONEY-1257 — BUY/SELL over the same filtered set as `total`.
   *
   * Optional so existing callers (and the demo path) keep compiling; omitted,
   * both read 0, which the tile renders as "0 buys · 0 sells" rather than a
   * wrong split. Passing a page-scoped count here would recreate the bug this
   * parameter exists to fix.
   */
  buyCount?: number | null,
  sellCount?: number | null,
): TradeStats {
  const closed = Math.max(0, Math.trunc(finite(closedCount)));
  const winners = Math.min(
    closed,
    Math.max(0, Math.trunc(finite(winnerCount))),
  );
  const totalTrades = Math.max(0, Math.trunc(finite(total)));

  return {
    totalPnL: finite(closedRealizedPnLSum),
    winRate: closed > 0 ? Math.round((winners / closed) * 100) : 0,
    winners,
    losers: closed - winners,
    closedCount: closed,
    totalTrades,
    // Clamped like the others: a negative or non-finite count would render as
    // "-3 buys", and these are counts, never measurements.
    buyCount: Math.max(0, Math.trunc(finite(buyCount))),
    sellCount: Math.max(0, Math.trunc(finite(sellCount))),
  };
}

// ---------------------------------------------------------------------------
// View mapping
// ---------------------------------------------------------------------------

/**
 * Recompute a row's `tradeValue` for display, preferring a stored finite value
 * and otherwise deriving qty×price (finite-guarded). Guarantees the value a
 * consumer renders is always a finite number, never `NaN`/`Infinity`.
 */
export function resolveTradeValue(
  stored: number | null | undefined,
  quantity: number | null | undefined,
  price: number | null | undefined,
): number {
  if (stored != null && Number.isFinite(stored)) return stored;
  return tradeValue(quantity, price);
}

/**
 * Sanitize a nullable money field (`realizedPnL` / `exitPrice`) for display.
 * `null`/`undefined` is preserved (a legitimate "no value" the UI renders as
 * "—"), but a `NaN`/`±Infinity` — whether stored on the row or produced by a
 * pairing computation — collapses to `null` rather than leaking to a consumer's
 * `.toFixed()`/`.toLocaleString()` (which would render "NaN"/"Infinity").
 * `0` is a real value and is kept.
 */
export function sanitizeNullableMoney(
  value: number | null | undefined,
): number | null {
  if (value == null) return null;
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Available financial years (dynamic FY dropdown — MONEY-847)
// ---------------------------------------------------------------------------

/** One Indian financial year option for the Tradebook FY dropdown. */
export interface FinancialYearOption {
  /** Stable id, e.g. "fy-2025" (the FY START calendar year). */
  id: string;
  /** Human label, e.g. "FY 25-26". */
  label: string;
  /** Inclusive ISO start (1 Apr), e.g. "2025-04-01". Display/label only. */
  from: string;
  /** Inclusive ISO end (31 Mar of the next year), e.g. "2026-03-31". Display/label only. */
  to: string;
  /**
   * Inclusive lower-bound UTC INSTANT of the FY, IST-anchored (MONEY-846):
   * 1-Apr 00:00:00.000 IST as UTC, e.g. `"2025-03-31T18:30:00.000Z"` for FY
   * 2025. This is what the client passes to `getTradesAction` as `fromDate` so
   * the DB window is IST-correct — `from`/`to` are date-only and the prior code
   * keyed the query off them, dropping/mis-bucketing the +5:30 IST sliver.
   */
  gte: string;
  /**
   * Inclusive upper-bound UTC INSTANT of the FY, IST-anchored (MONEY-846):
   * 31-Mar 23:59:59.999 IST as UTC, e.g. `"2026-03-31T18:29:59.999Z"` for FY
   * 2025. Passed to `getTradesAction` as `toDate`.
   */
  lte: string;
}

/**
 * The Indian financial-year START calendar year for a given instant, evaluated
 * on the IST (Asia/Kolkata, UTC+05:30) calendar — NOT the server's local zone.
 *
 * The FY runs 1 Apr → 31 Mar. A trade stamped just after midnight IST on 1 Apr
 * (i.e. ~18:30 UTC on 31 Mar) belongs to the NEW FY; computing the month in UTC
 * would mis-bucket it into the previous FY. We therefore shift the instant by
 * +5:30 and read the UTC calendar of the shifted value (no Intl / DST — IST has
 * a fixed offset). Months are 0-indexed: Jan=0 … Mar=2, Apr=3.
 */
export function fyStartYearIST(value: Date | string | number): number | null {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0 = Jan
  // Jan/Feb/Mar (0,1,2) still belong to the FY that STARTED the previous Apr.
  return month >= 3 ? year : year - 1;
}

/** Build a single FY option from its start calendar year. */
export function financialYearOption(startYear: number): FinancialYearOption {
  const endYear = startYear + 1;
  // "FY 25-26" — last two digits of each calendar year, zero-padded.
  const yy = (y: number) => String(y % 100).padStart(2, "0");
  // IST-anchored UTC instants (MONEY-846) — the SAME single-source-of-truth math
  // tax-logic uses for the capital-gains FY window. `fyWindowUtc` takes a
  // "YYYY-YYYY" label; the start year alone determines the window.
  const { gte, lte } = fyWindowUtc(`${startYear}-${endYear}`);
  return {
    id: `fy-${startYear}`,
    label: `FY ${yy(startYear)}-${yy(endYear)}`,
    from: `${startYear}-04-01`,
    to: `${endYear}-03-31`,
    gte: gte.toISOString(),
    lte: lte.toISOString(),
  };
}

/**
 * Given the earliest and latest trade dates a user has, return every Indian FY
 * (1 Apr – 31 Mar, IST boundary) spanned by that range, NEWEST first.
 *
 * Pure + total: `null`/Invalid-Date inputs (no trades, or a corrupt min/max)
 * yield `[]`. If min > max (shouldn't happen, but defensively) the two are
 * swapped so the span is still correct. Used by the `getAvailableFYs` service to
 * populate the Tradebook FY dropdown from the user's real data, instead of two
 * hard-coded fy/pfy pills.
 */
export function availableFinancialYears(
  minDate: Date | string | number | null | undefined,
  maxDate: Date | string | number | null | undefined,
): FinancialYearOption[] {
  if (minDate == null || maxDate == null) return [];
  let lo = fyStartYearIST(minDate);
  let hi = fyStartYearIST(maxDate);
  if (lo === null || hi === null) return [];
  if (lo > hi) [lo, hi] = [hi, lo];
  const out: FinancialYearOption[] = [];
  for (let y = hi; y >= lo; y--) out.push(financialYearOption(y));
  return out;
}

// ---------------------------------------------------------------------------
// Single-trade realized P&L (createTrade / closePosition)
// ---------------------------------------------------------------------------

/**
 * Realized P&L recorded by `createTrade` when an exit price is present.
 * SHORT profits when price falls; LONG (default / any non-SHORT) profits when
 * price rises. Brokerage is subtracted. Finite-guarded so a corrupt
 * price/exit/quantity can't persist a `NaN`/`Infinity` `realizedPnL`.
 */
export function calculateTradeRealizedPnL(
  positionType: string,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  brokerage: number,
): number {
  const e = finite(entryPrice);
  const x = finite(exitPrice);
  const q = finite(quantity);
  const pnl = positionType === "SHORT" ? (e - x) * q : (x - e) * q;
  return finite(pnl - finite(brokerage));
}

/**
 * P&L for closing a position (`closePosition`). LONG profits when the exit
 * exceeds entry; otherwise (SHORT / any non-LONG) profits when entry exceeds
 * exit. Brokerage is subtracted. Finite-guarded.
 */
export function calculateClosePositionPnL(
  positionType: string,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  brokerage: number,
): number {
  const e = finite(entryPrice);
  const x = finite(exitPrice);
  const q = finite(quantity);
  const pnl = positionType === "LONG" ? (x - e) * q : (e - x) * q;
  return finite(pnl - finite(brokerage));
}

// ---------------------------------------------------------------------------
// Paired-trade aggregate stats (MONEY-729 — /v1/paired/stats)
// ---------------------------------------------------------------------------

/** The PairedTradeView columns the stats aggregator consumes (projection). */
export interface PairedStatsRow {
  /** Lot status as computed by the FIFO engine (OPEN / CLOSED / PARTIAL). */
  status: string;
  /** Realised P&L of the lot, or null (only CLOSED lots carry a realised figure). */
  realizedPnL: number | null;
}

/** Aggregate stats over a user's persisted PairedTradeView rows. */
export interface PairedStats {
  totalTrades: number;
  openPositions: number;
  closedPositions: number;
  partialPositions: number;
  totalRealizedPnL: number;
  /** round(winners / closedPositions * 100); 0 when nothing is closed. */
  winRate: number;
  winners: number;
  losers: number;
  /** Mean realised P&L of winning CLOSED lots (0 when none). */
  averageWin: number;
  /** Mean realised LOSS (positive magnitude) of losing CLOSED lots (0 when none). */
  averageLoss: number;
  /** grossProfit / grossLoss (0 when there is no loss to divide by). */
  profitFactor: number;
}

/**
 * Aggregate a user's PairedTradeView rows into the tradebook stats strip.
 *
 * Status counts span ALL rows; realised P&L / win-rate / winners-losers /
 * averages are sourced from CLOSED lots ONLY — the SAME semantics the web
 * `getPairedTrades` uses (closedCount is the win-rate denominator, matching
 * `assembleTradeStats`). Every money field is `finite()`-guarded: one corrupt
 * stored `realizedPnL` (NaN/Infinity from a bad sync/import) can never poison the
 * summed P&L, an average, or the profit factor into "₹NaN". Divide-by-zero is
 * clamped everywhere (no closed lots → winRate 0; no winners → averageWin 0; no
 * losing magnitude → profitFactor 0). Pure + total: never throws.
 */
export function aggregatePairedStats(rows: PairedStatsRow[]): PairedStats {
  let openPositions = 0;
  let closedPositions = 0;
  let partialPositions = 0;
  let winners = 0;
  let losers = 0;
  let totalRealizedPnL = 0;
  let grossProfit = 0;
  let grossLoss = 0; // positive magnitude of losses

  for (const row of rows) {
    if (row.status === "CLOSED") {
      closedPositions++;
      const pnl = finite(row.realizedPnL);
      totalRealizedPnL = finite(totalRealizedPnL + pnl);
      if (pnl > 0) {
        winners++;
        grossProfit = finite(grossProfit + pnl);
      } else if (pnl < 0) {
        losers++;
        grossLoss = finite(grossLoss + Math.abs(pnl));
      }
    } else if (row.status === "PARTIAL") {
      partialPositions++;
    } else {
      // Any non-CLOSED / non-PARTIAL status (OPEN or unknown) counts as open.
      openPositions++;
    }
  }

  return {
    totalTrades: rows.length,
    openPositions,
    closedPositions,
    partialPositions,
    totalRealizedPnL,
    winRate:
      closedPositions > 0 ? Math.round((winners / closedPositions) * 100) : 0,
    winners,
    losers,
    averageWin: winners > 0 ? finite(grossProfit / winners) : 0,
    averageLoss: losers > 0 ? finite(grossLoss / losers) : 0,
    profitFactor: grossLoss > 0 ? finite(grossProfit / grossLoss) : 0,
  };
}

// ---------------------------------------------------------------------------
// Generic keyset pager (MONEY-402 — portfolio list cursor pagination)
// ---------------------------------------------------------------------------
//
// Colocated with the other pagination helpers (clampPagination) — domain-
// agnostic. The portfolio list services (holdings / positions / mutual funds)
// read the FULL result set to compute their summary/breakdowns over EVERYTHING,
// then hand the array here to bound the RESPONSE to one page. Slicing in memory
// (rather than a DB `take`/`skip`) is what keeps the summary correct over the
// whole set while still giving the mobile client a stable forward-paging cursor
// — the SAME shape the watchlist route already exposes.

/**
 * Optional cursor page for the portfolio list services (holdings / positions /
 * mutual funds). Additive: when omitted (or `limit` absent) the service returns
 * the FULL, unbounded list exactly as before — existing apps/web server-action
 * callers pass nothing and are unaffected. When `limit` is set, the returned
 * list is a bounded page and the result's `nextCursorId` carries the keyset for
 * the next page (the summary stays computed over ALL rows).
 */
export interface ListPageParams {
  limit?: number;
  cursorId?: string | null;
}

/** One page produced by {@link keysetPageById}. */
export interface KeysetPage<T> {
  /** The bounded page of items (≤ `limit`). */
  page: T[];
  /** The last item's id when a further page exists, else `null`. */
  nextCursorId: string | null;
}

/**
 * Keyset-slice a stably-ordered array by an `id` cursor.
 *
 * `cursorId` is the id of the LAST item the client already saw: paging resumes
 * at the item AFTER it. A missing / stale / tampered cursor id (`findIndex` →
 * -1) falls back to the first page — never throws, never returns a negative
 * slice. `nextCursorId` is the last returned item's id when more rows remain
 * beyond this page, else `null` (signalling the final page). `limit` is assumed
 * pre-clamped by the caller; a non-positive/NaN limit simply yields an empty
 * page (`slice(start, start+NaN)` → []).
 */
export function keysetPageById<T extends { id: string }>(
  items: T[],
  limit: number,
  cursorId?: string | null,
): KeysetPage<T> {
  const found = cursorId ? items.findIndex((it) => it.id === cursorId) : -1;
  const start = found >= 0 ? found + 1 : 0;
  const page = items.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursorId = last && start + limit < items.length ? last.id : null;
  return { page, nextCursorId };
}
