/**
 * Trades Service
 *
 * Handles trades CRUD, pairing, and close position logic.
 * Source: apps/web/lib/actions/trades.ts + apps/web/lib/db/trades.ts
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@usemoney/database";
import type { Prisma } from "@prisma/client";
import {
  getCached,
  setCached,
  clearTradeCache,
  clearPositionCache,
} from "@usemoney/core";
// Subpath, NOT the root barrel: these are pure in-process helpers (a dedupe
// registry and a string builder). The service tests stub the ROOT
// `@usemoney/core` with a catch-all Proxy that answers any unmodelled export
// with a no-op, so from the root `singleFlight` silently became `async () => {}`
// and the LIVE service tests got `undefined` instead of their result. The I/O
// boundary those tests DO need to control (getCached / setCached) stays on the
// root import above.
import { singleFlight, generateCacheKey } from "@usemoney/core/cache";
import { publishPairingJob } from "@usemoney/pubsub/publish";
import { dbLogger as logger } from "@usemoney/logger";
import type {
  TradeFormData,
  TradeFilterInput,
  ClosePositionInput,
} from "@usemoney/validation";
import { getSegmentLabel, getProductTypeLabel } from "./mappings";
import type { ServiceResult } from "./types";
import {
  buildTradeWhereClause,
  buildPairedViewWhereClause,
  buildPairedStatusMap,
  buildRealizedPnLByTradeMap,
  clampPagination,
  assembleTradeStats,
  aggregatePairedStats,
  resolveTradeValue,
  sanitizeNullableMoney,
  finite,
  tradeValue as computeTradeValue,
  calculateTradeRealizedPnL,
  calculateClosePositionPnL,
  availableFinancialYears,
  type FinancialYearOption,
  type PairedStats,
} from "./trades-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface TradeItem {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  segment: string;
  segmentLabel?: string;
  tradeType: string;
  positionType: string;
  orderType: string;
  productType: string;
  productTypeLabel?: string;
  quantity: number;
  price: number;
  exitPrice: number | null;
  tradeValue: number | null;
  brokerage: number;
  taxes: number;
  realizedPnL: number | null;
  status: string;
  tradeDate: Date;
  exitDate: Date | null;
  broker: string | null;
  brokerUserId: string | null;
  brokerName: string | null;
  brokerDisplayName?: string | null;
  tags: string[];
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceType?: string;
  isEditable?: boolean;
}

export interface TradeStats {
  totalPnL: number;
  winRate: number;
  winners: number;
  losers: number;
  /** Count of CLOSED trades (win-rate denominator; client sub-line). MONEY-846. */
  closedCount: number;
  totalTrades: number;
  /**
   * MONEY-1257 — BUY / SELL split across the WHOLE filtered set, not the
   * current page.
   *
   * The tradebook tile rendered the server `total` as its headline over a
   * split the CLIENT derived from `trades` — i.e. one page. At PAGE_SIZE=100
   * that showed "125" above "20 buys · 0 sells": two different populations
   * presented as one fact. The "0 sells" made it read as "you have never
   * sold", which is a claim about someone's trading history.
   *
   * Scoped by the same `where` as `totalTrades`, so buyCount + sellCount ===
   * totalTrades for any filter.
   */
  buyCount: number;
  sellCount: number;
}

// Re-export the FY option shape + the pure FY helper so callers (apps/web
// action) can type the response and compute FYs for the demo path without
// reaching into trades-logic directly (trades-logic isn't on the package barrel).
export type { FinancialYearOption } from "./trades-logic";
export { availableFinancialYears } from "./trades-logic";

// ── Service Functions ──────────────────────────────────────────────

/** What {@link getTrades} caches and returns (the FULL filtered page + stats). */
export interface TradesResult {
  trades: TradeItem[];
  total: number;
  stats: TradeStats;
}

export async function getTrades(
  userId: string,
  filters: TradeFilterInput,
): Promise<ServiceResult<TradesResult>> {
  try {
    // MONEY-705 stampede protection — the flight key IS the cache key, so the
    // userId and the filter version hash partition the flight exactly the way
    // they partition the cache (never two users on one flight).
    const result = await singleFlight(
      generateCacheKey("trades", userId, "list", filters),
      () => resolveTrades(userId, filters),
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, userId }, "Trades service error");
    return { success: false, error: "Failed to fetch trades" };
  }
}

/** Cache-read → compute → cache-write body, run at most once per key per flight. */
async function resolveTrades(
  userId: string,
  filters: TradeFilterInput,
): Promise<TradesResult> {
  const cached = await getCached<TradesResult>(
    "trades",
    userId,
    "list",
    filters,
  );

  if (cached) {
    logger.debug({ userId }, "Trades from cache");
    return cached;
  }

  logger.debug({ userId }, "Trades cache miss");

  // IDOR-scoped where (userId first; "all" disables filters; manual →
  // brokerName; "BROKER:userId" split). Built by the shared, unit-tested helper.
  const where = buildTradeWhereClause(userId, filters);

  // MONEY-840: status + realised P&L + the stats strip now come from the
  // PERSISTED PairedTradeView (the worker's FIFO engine writes it on every
  // sync/import), NOT from stored Trade.status/Trade.realizedPnL — sync never
  // sets those, so the old per-page `pairTrades` was the only thing producing a
  // status, and it was date-keyed (a multi-day delivery never paired → OPEN
  // forever, P&L 0). The stats query is the SAME trade filter mapped onto the
  // view's columns (so the strip stays filter-responsive).
  // The pure builder is Prisma-free (returns Record<string, unknown>); cast to
  // the typed Prisma where input here, where the @prisma/client types live.
  const viewWhere = buildPairedViewWhereClause(
    userId,
    filters,
  ) as Prisma.PairedTradeViewWhereInput;
  const closedViewWhere: Prisma.PairedTradeViewWhereInput = {
    ...viewWhere,
    status: "CLOSED",
  };

  // Clamp pagination so a NaN / negative / absurd take|skip (an un-validated
  // caller, or a stray `?limit=abc` that reached this library) can never throw
  // the Prisma "Expected Int" 500 — mirrors notifications-pagination.
  const { take, skip } = clampPagination(filters.limit, filters.skip);

  const [
    trades,
    total,
    closedAgg,
    winnerCount,
    closedCount,
    buyCount,
    sellCount,
  ] = await Promise.all([
    prisma.trade.findMany({
      where,
      orderBy: { tradeDate: "desc" },
      take,
      skip,
    }),
    prisma.trade.count({ where }),
    // Realised P&L = Σ realizedPnL of CLOSED paired LOTS (filter-scoped).
    prisma.pairedTradeView.aggregate({
      where: closedViewWhere,
      _sum: { realizedPnL: true },
    }),
    // Winners = CLOSED lots with realised P&L > 0.
    prisma.pairedTradeView.count({
      where: { ...closedViewWhere, realizedPnL: { gt: 0 } },
    }),
    // closedCount = the win-rate denominator (# CLOSED lots).
    prisma.pairedTradeView.count({ where: closedViewWhere }),
    // MONEY-1257: BUY/SELL over the same filtered set as `total`, so the
    // tile's split sums to its own headline. Counted here rather than
    // client-side, where it could only ever see one page.
    prisma.trade.count({ where: { ...where, tradeType: "BUY" } }),
    prisma.trade.count({ where: { ...where, tradeType: "SELL" } }),
  ]);

  // Per-row status + realised P&L: fetch only the persisted views that touch
  // the trades ON THIS PAGE (bounded by the page size, ≤ MAX_TRADE_LIMIT), via
  // an OR over the three id links the view carries. Then derive the maps with
  // the pure helpers and stamp each Trade row.
  const pageTradeIds = trades.map((t) => t.id);
  const pageViews =
    pageTradeIds.length > 0
      ? await prisma.pairedTradeView.findMany({
          where: {
            userId,
            OR: [
              { sourceTradeIds: { hasSome: pageTradeIds } },
              { entryTradeId: { in: pageTradeIds } },
              { exitTradeId: { in: pageTradeIds } },
            ],
          },
          select: {
            sourceTradeIds: true,
            entryTradeId: true,
            exitTradeId: true,
            status: true,
            realizedPnL: true,
          },
        })
      : [];
  const statusByTrade = buildPairedStatusMap(pageViews);
  const realizedByTrade = buildRealizedPnLByTradeMap(pageViews);

  const mappedTrades: TradeItem[] = trades.map((trade) => {
    const t = trade as unknown as TradeItem;
    // A trade absent from every view (just synced before pairing ran, or a
    // still-open buy with no lot yet) defaults to OPEN. Realised P&L is only
    // attributed to the closing (SELL) row of a CLOSED/PARTIAL lot.
    const status = statusByTrade.get(trade.id) ?? "OPEN";
    const realizedPnL = realizedByTrade.has(trade.id)
      ? realizedByTrade.get(trade.id)!
      : null;
    return {
      ...t,
      status,
      // Re-derive/sanitize the money fields defensively: a corrupt stored
      // value must never leave NaN/Infinity for a consumer's
      // .toFixed()/.toLocaleString().
      tradeValue: resolveTradeValue(t.tradeValue, t.quantity, t.price),
      realizedPnL: sanitizeNullableMoney(realizedPnL),
      exitPrice: sanitizeNullableMoney(t.exitPrice),
      broker: (trade.broker as string) || null,
      brokerUserId: (trade.brokerUserId as string) || null,
      brokerDisplayName: (trade.broker as string) || null,
      segmentLabel: getSegmentLabel(trade.segment as string),
      productTypeLabel: getProductTypeLabel(trade.productType as string),
      sourceType: (trade.sourceType as string) || undefined,
      isEditable: (trade.isEditable as boolean) ?? true,
    };
  });

  const result = {
    trades: mappedTrades,
    total,
    // finite-guarded sum + divide-by-zero-safe win rate + non-negative counts.
    // Sourced from PairedTradeView CLOSED lots (above), not Trade.status.
    stats: assembleTradeStats(
      closedAgg._sum?.realizedPnL,
      winnerCount,
      closedCount,
      total,
      buyCount,
      sellCount,
    ),
  };

  await setCached("trades", userId, "list", result, filters);
  return result;
}

/**
 * Return the Indian financial years (1 Apr – 31 Mar, IST boundary) the user's
 * trades span, newest first — powers the Tradebook FY dropdown (MONEY-847).
 *
 * Aggregates the min & max `tradeDate` across the user's trades in ONE Prisma
 * query (IDOR-scoped on userId), then derives the FY list with the pure,
 * unit-tested `availableFinancialYears` helper. Returns `[]` when the user has
 * no trades — the client then shows only the rolling quick pills.
 */
export async function getAvailableFYs(
  userId: string,
): Promise<ServiceResult<{ fys: FinancialYearOption[] }>> {
  try {
    const agg = await prisma.trade.aggregate({
      where: { userId },
      _min: { tradeDate: true },
      _max: { tradeDate: true },
    });
    const fys = availableFinancialYears(agg._min.tradeDate, agg._max.tradeDate);
    return { success: true, data: { fys } };
  } catch (error) {
    logger.error({ error, userId }, "getAvailableFYs service error");
    return { success: false, error: "Failed to load financial years" };
  }
}

export async function createTrade(
  userId: string,
  data: TradeFormData,
): Promise<ServiceResult<TradeItem>> {
  try {
    let realizedPnL = data.realizedPnL;
    if (data.exitPrice && !realizedPnL) {
      // Shared finite-guarded P&L (SHORT profits on a fall, LONG on a rise),
      // brokerage subtracted — same code the unit test asserts.
      realizedPnL = calculateTradeRealizedPnL(
        data.positionType,
        data.price,
        data.exitPrice,
        data.quantity,
        data.brokerage || 20,
      );
    }

    // Generate unique brokerTradeId for manual trades to avoid unique constraint violation
    // Constraint: @@unique([userId, broker, brokerUserId, brokerTradeId])
    const manualTradeId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const trade = await prisma.trade.create({
      data: {
        userId,
        symbol: data.symbol,
        exchange: data.exchange,
        segment: data.segment,
        tradeType: data.tradeType,
        positionType: data.positionType,
        orderType: data.orderType,
        productType: data.productType,
        quantity: data.quantity,
        price: data.price,
        exitPrice: data.exitPrice,
        tradeValue: computeTradeValue(data.quantity, data.price),
        brokerage: data.brokerage,
        taxes: 0,
        realizedPnL,
        status: data.exitPrice ? "CLOSED" : "OPEN",
        tradeDate: new Date(data.tradeDate),
        brokerName: data.broker || "manual",
        brokerTradeId: manualTradeId,
        sourceType: "MANUAL",
        tags: data.tags || [],
        notes: data.notes,
      },
    });

    await clearTradeCache(userId);
    return {
      success: true,
      data: trade as unknown as TradeItem,
      message: "Trade added successfully!",
    };
  } catch (error) {
    logger.error({ error, userId }, "Create trade service error");
    return { success: false, error: "Failed to create trade" };
  }
}

export async function updateTrade(
  userId: string,
  tradeId: string,
  data: Partial<TradeFormData>,
): Promise<ServiceResult<{ updated: number }>> {
  try {
    const result = await prisma.trade.updateMany({
      where: { id: tradeId, userId },
      data: data as Record<string, unknown>,
    });
    await clearTradeCache(userId);
    return {
      success: true,
      data: { updated: result.count },
      message: "Trade updated successfully!",
    };
  } catch (error) {
    logger.error({ error, userId, tradeId }, "Update trade service error");
    return {
      success: false,
      error: "Failed to update trade",
      code: "INTERNAL",
    };
  }
}

export async function deleteTrade(
  userId: string,
  tradeId: string,
): Promise<ServiceResult<void>> {
  try {
    const trade = await prisma.trade.findFirst({
      where: { id: tradeId, userId },
      select: { brokerTradeId: true, broker: true, brokerName: true },
    });

    if (!trade) {
      return { success: false, error: "Trade not found", code: "NOT_FOUND" };
    }

    if (
      trade.brokerTradeId ||
      (trade.broker && trade.broker !== "MANUAL") ||
      (trade.brokerName && trade.brokerName !== "manual")
    ) {
      return {
        success: false,
        error:
          "Cannot delete broker-synced trades. Only manual entries can be deleted.",
      };
    }

    const result = await prisma.trade.deleteMany({
      where: { id: tradeId, userId },
    });

    if (result.count === 0) {
      return {
        success: false,
        error: "Trade not found or already deleted",
        code: "NOT_FOUND",
      };
    }

    await clearTradeCache(userId);
    return {
      success: true,
      data: undefined,
      message: "Trade deleted successfully!",
    };
  } catch (error) {
    logger.error({ error, userId, tradeId }, "Delete trade service error");
    return {
      success: false,
      error: "Failed to delete trade",
      code: "INTERNAL",
    };
  }
}

export async function closePosition(
  userId: string,
  data: ClosePositionInput,
): Promise<ServiceResult<{ pnl: number }>> {
  try {
    const trade = await prisma.trade.findFirst({
      where: { id: data.positionId, userId },
    });

    if (!trade) {
      return { success: false, error: "Position not found" };
    }

    // Idempotency guard (MONEY-1062 review): re-closing an already-CLOSED trade
    // would overwrite its stored exitPrice/exitDate/realizedPnL with a fresh
    // price. Reject instead so a double-tap / retry can't rewrite realised P&L.
    if (trade.status === "CLOSED") {
      return { success: false, error: "Position already closed" };
    }

    // Shared finite-guarded close P&L (LONG profits on a rise, else on a fall),
    // brokerage subtracted. finite() keeps a corrupt stored price/quantity/
    // brokerage from making `finalPnl` NaN — which would render "₹NaN" in the
    // success message below (`.toFixed(2)`).
    const finalPnl = calculateClosePositionPnL(
      trade.positionType,
      trade.price,
      data.exitPrice,
      trade.quantity,
      trade.brokerage,
    );

    await prisma.trade.update({
      where: { id: data.positionId },
      data: {
        exitPrice: data.exitPrice,
        exitDate: new Date(),
        status: "CLOSED",
        realizedPnL: finalPnl,
      },
    });

    await clearPositionCache(userId);
    return {
      success: true,
      data: { pnl: finalPnl },
      message: `Position closed! P&L: ₹${finalPnl.toFixed(2)}`,
    };
  } catch (error) {
    logger.error({ error, userId }, "Close position service error");
    return { success: false, error: "Failed to close position" };
  }
}

// ── Paired trades (MONEY-729) ──────────────────────────────────────
//
// The persisted `PairedTradeView` (written by the worker's FIFO engine via
// @usemoney/core/pairing on every sync/import) is the LIVE source of the
// entry/exit-matched tradebook. These reads are STRICTLY userId-scoped (IDOR):
// the where clause is built by the shared `buildPairedViewWhereClause`, whose
// first key is always `userId`, so no symbol/broker filter can widen the read to
// another user's lots.

/** Filters for the paired-trade view read. */
export interface PairedTradeFilters {
  symbol?: string;
  broker?: string;
  segment?: string;
  /** OPEN | CLOSED | PARTIAL | "all"/undefined (no status filter). */
  status?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  skip?: number;
}

/** A paired lot as returned to the API (money fields finite-sanitized). */
export interface PairedTradeViewItem {
  id: string;
  symbol: string;
  isin: string | null;
  exchange: string;
  segment: string;
  segmentLabel: string;
  broker: string | null;
  brokerUserId: string | null;
  entryDate: Date;
  entryPrice: number;
  entryQuantity: number;
  exitDate: Date | null;
  exitPrice: number | null;
  quantity: number;
  realizedPnL: number | null;
  pnlPercentage: number | null;
  status: string;
  positionType: string;
  productType: string;
  tradeType: string | null;
}

/**
 * List a user's paired-trade lots (paginated). Offset pagination — the route
 * bridges it to an opaque `{ skip }` cursor. `status` is applied on the view's
 * own column (OPEN/CLOSED/PARTIAL); "all"/undefined leaves it unfiltered.
 */
export async function getPairedTrades(
  userId: string,
  filters: PairedTradeFilters = {},
): Promise<ServiceResult<{ trades: PairedTradeViewItem[]; total: number }>> {
  try {
    const where = buildPairedViewWhereClause(
      userId,
      filters,
    ) as Prisma.PairedTradeViewWhereInput;
    if (filters.status && filters.status !== "all") {
      where.status =
        filters.status as Prisma.PairedTradeViewWhereInput["status"];
    }

    // Clamp so a stray `?limit=abc`/negative skip can never throw Prisma's
    // "Expected Int" 500 (defense-in-depth; the route also pre-clamps).
    const { take, skip } = clampPagination(filters.limit, filters.skip);

    const [rows, total] = await Promise.all([
      prisma.pairedTradeView.findMany({
        where,
        orderBy: { entryDate: "desc" },
        take,
        skip,
      }),
      prisma.pairedTradeView.count({ where }),
    ]);

    const trades: PairedTradeViewItem[] = rows.map((v) => ({
      id: v.id,
      symbol: v.symbol,
      isin: v.isin ?? null,
      exchange: v.exchange,
      segment: v.segment,
      segmentLabel: getSegmentLabel(v.segment),
      broker: (v.broker as string) || null,
      brokerUserId: v.brokerUserId || null,
      entryDate: v.entryDate,
      // Re-sanitize money defensively — a corrupt stored value must never leave
      // NaN/Infinity for a consumer's .toFixed()/.toLocaleString().
      entryPrice: finite(v.entryPrice),
      entryQuantity: finite(v.entryQuantity),
      exitDate: v.exitDate ?? null,
      exitPrice: sanitizeNullableMoney(v.exitPrice),
      quantity: finite(v.quantity),
      realizedPnL: sanitizeNullableMoney(v.realizedPnL),
      pnlPercentage: sanitizeNullableMoney(v.pnlPercentage),
      status: v.status,
      positionType: v.positionType,
      productType: v.productType,
      tradeType: v.tradeType ?? null,
    }));

    return { success: true, data: { trades, total } };
  } catch (error) {
    logger.error({ error, userId }, "Get paired trades service error");
    return { success: false, error: "Failed to fetch paired trades" };
  }
}

/**
 * Aggregate stats (realised P&L, win rate, counts, averages, profit factor)
 * over the user's PairedTradeView, honouring the same symbol/broker/segment/date
 * filters as the list (pagination excluded). Only `{ status, realizedPnL }` is
 * projected, and the pure `aggregatePairedStats` does the finite-guarded math.
 */
export async function getPairedTradeStats(
  userId: string,
  filters: PairedTradeFilters = {},
): Promise<ServiceResult<PairedStats>> {
  try {
    const where = buildPairedViewWhereClause(
      userId,
      filters,
    ) as Prisma.PairedTradeViewWhereInput;

    const rows = await prisma.pairedTradeView.findMany({
      where,
      select: { status: true, realizedPnL: true },
    });

    return { success: true, data: aggregatePairedStats(rows) };
  } catch (error) {
    logger.error({ error, userId }, "Get paired stats service error");
    return { success: false, error: "Failed to fetch paired stats" };
  }
}

/**
 * Trigger a full FIFO re-pair for the user (MONEY-840: pairing is worker-only).
 * Mirrors the web `triggerRepairingAction`: pre-create a POLLABLE BackgroundJob
 * row (best-effort — the worker updates it by jobId via updateMany, a no-op
 * without a pre-existing row), then publish the pairing job to Cloud Run. The
 * work is async, so the caller polls `/v1/jobs/:jobId` for completion.
 */
export async function triggerTradePairing(
  userId: string,
): Promise<ServiceResult<{ jobId: string; status: string }>> {
  try {
    const jobId = randomUUID();

    // Best-effort tracking row — a failed insert must never block the publish.
    try {
      await prisma.backgroundJob.create({
        data: {
          jobId,
          userId,
          jobType: "TRADE_PAIRING",
          status: "PENDING",
          progress: 0,
          queuedAt: new Date(),
        },
      });
    } catch (err) {
      logger.warn(
        { err, jobId, userId },
        "triggerTradePairing: job row create failed (continuing)",
      );
    }

    await publishPairingJob({ jobId, userId });

    return {
      success: true,
      data: { jobId, status: "PENDING" },
      message: "Trade re-pairing triggered",
    };
  } catch (error) {
    logger.error({ error, userId }, "Trigger trade pairing service error");
    return { success: false, error: "Failed to trigger trade re-pairing" };
  }
}
