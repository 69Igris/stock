/**
 * Positions Service
 *
 * Handles position queries with broker/segment filter parsing.
 * Source: apps/web/lib/actions/positions.ts + apps/web/lib/db/positions.ts
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached, clearUserCache } from "@usemoney/core";
// Subpath, NOT the root barrel: these are pure in-process helpers (a dedupe
// registry and a string builder). The service tests stub the ROOT
// `@usemoney/core` with a catch-all Proxy that answers any unmodelled export
// with a no-op, so from the root `singleFlight` silently became `async () => {}`
// and the LIVE service tests got `undefined` instead of their result. The I/O
// boundary those tests DO need to control (getCached / setCached) stays on the
// root import above.
import { singleFlight, generateCacheKey } from "@usemoney/core/cache";
import type { Prisma } from "@prisma/client";
import { dbLogger as logger } from "@usemoney/logger";
import {
  getSegmentLabel,
  getProductTypeLabel,
  getSegmentFilterValues,
} from "./mappings";
import {
  finite,
  classifyPositionDirection,
  positionDirectionLabel,
  tradeTypeForQuantity,
  absQuantity,
  positionUnrealizedPnL,
  positionCostBasis,
  positionReturnPct,
  summarizeOpenPositions,
  startOfToday,
  computeClosedTodayRealizedPnL,
  safeIsoDate,
  type PositionSummaryInput,
} from "./positions-logic";
import { keysetPageById, type ListPageParams } from "./trades-logic";
import type { ServiceResult } from "./types";

// ── Types ──────────────────────────────────────────────────────────

export interface PositionItem {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  segment: string;
  segmentLabel?: string;
  tradeType: string;
  positionType: string;
  positionTypeLabel?: string;
  orderType: string;
  productType: string;
  productTypeLabel?: string;
  quantity: number;
  price: number;
  exitPrice: number | null;
  tradeValue: number | null;
  brokerage: number;
  taxes: number;
  realizedPnL: number;
  status: string;
  tradeDate: Date;
  exitDate: Date | null;
  broker: string | null;
  brokerUserId: string | null;
  brokerName: string | null;
  tags: string[];
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  /** Per-row return % = unrealizedPnL / costBasis * 100, clamped finite. */
  pnlPercentage?: number;
  sourceType?: string;
  isEditable?: boolean;
}

export interface PositionSummary {
  totalPositions: number;
  totalInvested: number;
  unrealizedPnL: number;
  longPositions: number;
  shortPositions: number;
  /** Σ |netQuantity * lastPrice| — finite mark-to-market notional (optional). */
  marketValue?: number;
  /** Book return % (unrealizedPnL / totalInvested * 100), clamped finite. */
  returnPct?: number;
}

export interface PositionFilters {
  symbol?: string;
  broker?: string;
  segment?: string;
}

/**
 * Positions query result. `nextCursorId` is present ONLY when the caller passed
 * a `limit` (cursor pagination); it is absent on the unbounded default path so
 * existing callers see the unchanged `{ positions, summary }` shape.
 */
export interface PositionsResult {
  positions: PositionItem[];
  summary: PositionSummary;
  nextCursorId?: string | null;
}

/**
 * Apply optional keyset pagination to a FULL positions result WITHOUT touching
 * the summary (which must reflect every open position). Returns the result
 * unchanged when no `limit` was requested; never mutates the cached object.
 */
function applyPositionsPage(
  result: PositionsResult,
  page?: ListPageParams,
): PositionsResult {
  if (!page || page.limit === undefined) return result;
  const { page: positions, nextCursorId } = keysetPageById(
    result.positions,
    page.limit,
    page.cursorId,
  );
  return { ...result, positions, nextCursorId };
}

// ── Service Functions ──────────────────────────────────────────────

export async function getPositions(
  userId: string,
  filters: PositionFilters = {},
  page?: ListPageParams,
): Promise<ServiceResult<PositionsResult>> {
  try {
    // MONEY-705 stampede protection — the flight key IS the cache key, so the
    // userId (and the filter version hash) partition the flight exactly the way
    // they partition the cache. Pagination stays outside the flight so callers
    // on different pages of the same filter set share one query.
    const result = await singleFlight(
      generateCacheKey("positions", userId, "list", filters),
      () => resolvePositions(userId, filters),
    );
    return { success: true, data: applyPositionsPage(result, page) };
  } catch (error) {
    logger.error({ error, userId }, "Positions service error");
    return { success: false, error: "Failed to fetch positions" };
  }
}

/** Cache-read → compute → cache-write body, run at most once per key per flight. */
async function resolvePositions(
  userId: string,
  filters: PositionFilters,
): Promise<PositionsResult> {
  // Cache always holds the FULL result (keyed by filters, not page); pagination
  // is applied after the read so the summary stays over every open position.
  const cached = await getCached<PositionsResult>(
    "positions",
    userId,
    "list",
    filters,
  );

  if (cached) {
    logger.debug({ userId, filters }, "Positions from cache");
    return cached;
  }

  logger.debug({ userId, filters }, "Positions cache miss");

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
    const segmentValues = getSegmentFilterValues(filters.segment);
    where.segment = { in: segmentValues };
  }

  const dbPositions = await prisma.position.findMany({
    where: { ...where, netQuantity: { not: 0 } },
    orderBy: { lastUpdated: "desc" },
    select: {
      id: true,
      userId: true,
      symbol: true,
      exchange: true,
      segment: true,
      productType: true,
      netQuantity: true,
      averagePrice: true,
      lastPrice: true,
      netValue: true,
      realizedPnl: true,
      unrealizedPnl: true,
      totalPnl: true,
      tradeDate: true,
      broker: true,
      brokerUserId: true,
      lastUpdated: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const positions: PositionItem[] = dbPositions.map((pos) => {
    // Per-row unrealized P&L: trust the broker's pre-computed value when it is
    // finite; otherwise price-derive it (a non-finite stored unrealizedPnl on
    // a single row would otherwise render "NaN" in that row AND poison the
    // summary). Behaviour-preserving for the overwhelming finite-value case.
    const rowUnrealizedPnL = Number.isFinite(pos.unrealizedPnl)
      ? pos.unrealizedPnl
      : positionUnrealizedPnL(pos.netQuantity, pos.averagePrice, pos.lastPrice);
    // Per-row return % off the cost basis (|netValue|, falling back to
    // |avg*qty|), clamped so a zero-price option / hedged net value can't
    // emit Infinity/NaN.
    const rowCostBasis = positionCostBasis(
      pos.netValue,
      pos.averagePrice,
      pos.netQuantity,
    );
    return {
      id: pos.id,
      userId: pos.userId,
      symbol: pos.symbol,
      exchange: pos.exchange,
      segment: pos.segment,
      segmentLabel: getSegmentLabel(pos.segment),
      tradeType: tradeTypeForQuantity(pos.netQuantity),
      positionType: classifyPositionDirection(pos.netQuantity),
      positionTypeLabel: positionDirectionLabel(pos.netQuantity),
      orderType: "MARKET",
      productType: pos.productType,
      productTypeLabel: getProductTypeLabel(pos.productType),
      quantity: absQuantity(pos.netQuantity),
      price: pos.averagePrice,
      exitPrice: null,
      tradeValue: pos.netValue,
      brokerage: 0,
      taxes: 0,
      realizedPnL: finite(pos.realizedPnl),
      status: "OPEN",
      tradeDate: pos.tradeDate,
      exitDate: null,
      broker: pos.broker || null,
      brokerUserId: pos.brokerUserId || null,
      brokerName: pos.broker?.toLowerCase() || null,
      tags: [],
      notes: null,
      createdAt: pos.createdAt,
      updatedAt: pos.updatedAt,
      entryPrice: pos.averagePrice,
      currentPrice: pos.lastPrice,
      unrealizedPnL: finite(rowUnrealizedPnL),
      pnlPercentage: positionReturnPct(rowUnrealizedPnL, rowCostBasis),
      sourceType: undefined,
      isEditable: true,
    };
  });

  // Summary aggregation runs through the finite-guarded pure helper so a
  // single corrupt sync row (NaN/Infinity netValue or unrealizedPnl) cannot
  // poison totalInvested / unrealizedPnL into "₹NaN". Built from the raw DB
  // rows (same source the original `totalInvested`/`unrealizedPnL` reduces and
  // the long/short `filter`s used), but the row's FINITE unrealized P&L (which
  // already prefers stored-or-price-derived) is what feeds the summary so the
  // per-row and aggregate numbers agree. Long/short counts use the strict-
  // positive sign — a NaN netQuantity counts as neither, exactly like the
  // original two independent `> 0` / `< 0` filters.
  const summaryInputs: PositionSummaryInput[] = positions.map((p, i) => ({
    netQuantity: dbPositions[i]!.netQuantity,
    tradeValue: p.tradeValue,
    unrealizedPnL: p.unrealizedPnL,
    lastPrice: dbPositions[i]!.lastPrice,
  }));
  const summary = summarizeOpenPositions(summaryInputs);

  const result: PositionsResult = {
    positions,
    summary,
  };

  await setCached("positions", userId, "list", result, filters);
  return result;
}

// ── Closed Today ──────────────────────────────────────────────────

export interface ClosedTodayPosition {
  id: string;
  symbol: string;
  exchange: string;
  segment: string;
  segmentLabel?: string;
  productType: string;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  realizedPnL: number;
  tradeDate: Date;
  /** `YYYY-MM-DD` for tradeDate, or null on an Invalid Date (no throw). */
  tradeDateStr?: string | null;
  broker: string | null;
  brokerUserId: string | null;
}

/**
 * Get positions closed today (netQuantity === 0, tradeDate = today).
 */
export async function getClosedTodayPositions(
  userId: string,
): Promise<ServiceResult<ClosedTodayPosition[]>> {
  try {
    const todayStart = startOfToday();

    const dbPositions = await prisma.position.findMany({
      where: {
        userId,
        netQuantity: 0,
        tradeDate: { gte: todayStart },
      },
      orderBy: { lastUpdated: "desc" },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        segment: true,
        productType: true,
        buyQuantity: true,
        buyPrice: true,
        sellPrice: true,
        realizedPnl: true,
        tradeDate: true,
        broker: true,
        brokerUserId: true,
      },
    });

    return {
      success: true,
      data: dbPositions.map((pos) => {
        // Calculate P&L from prices — Zerodha's `realised` field is often 0.
        // The pure helper price-derives (sell-buy)*qty when all three are finite
        // & positive, else trusts the stored realizedPnl, and finite-guards the
        // result so a non-finite price/qty (Infinity passes a bare `> 0`) or a
        // corrupt stored P&L can never reach the UI as NaN/Infinity.
        const quantity = absQuantity(pos.buyQuantity);
        const computedPnL = computeClosedTodayRealizedPnL({
          buyPrice: pos.buyPrice,
          sellPrice: pos.sellPrice,
          quantity: pos.buyQuantity,
          realizedPnl: pos.realizedPnl,
        });

        return {
          id: pos.id,
          symbol: pos.symbol,
          exchange: pos.exchange,
          segment: pos.segment,
          segmentLabel: getSegmentLabel(pos.segment),
          productType: pos.productType,
          quantity,
          buyPrice: pos.buyPrice,
          sellPrice: pos.sellPrice,
          realizedPnL: computedPnL,
          tradeDate: pos.tradeDate,
          // Safe ISO date — never throws on a corrupt/Invalid tradeDate.
          tradeDateStr: safeIsoDate(pos.tradeDate),
          broker: pos.broker || null,
          brokerUserId: pos.brokerUserId || null,
        };
      }),
    };
  } catch (error) {
    logger.error({ error, userId }, "Closed-today positions service error");
    return { success: false, error: "Failed to fetch closed positions" };
  }
}

// ── Manual position add (MONEY-1062 P4d — apps/api parity) ─────────────────

export interface AddManualPositionInput {
  symbol: string;
  exchange: string;
  segment: string;
  productType: string;
  positionType: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  currentPrice?: number;
}

/**
 * Add a manual (off-broker) open Position. Port of addManualPositionAction
 * (apps/web/lib/actions/positions.ts:111) — the demo/auth gate + Next
 * `revalidatePath` stay in the caller; the service owns the row build + cache
 * clear. userId-scoped (Position.user connect). The DAY/NET derivation, the
 * LONG/SHORT quantity split, and the unrealized-P&L/pnl% math are byte-faithful
 * to the web action.
 */
export async function addManualPosition(
  userId: string,
  data: AddManualPositionInput,
): Promise<ServiceResult<{ positionId: string }>> {
  try {
    const price = data.currentPrice ?? data.entryPrice;
    const upperSymbol = data.symbol.toUpperCase();
    const netQty =
      data.positionType === "SHORT" ? -data.quantity : data.quantity;
    const buyQty = data.positionType === "LONG" ? data.quantity : 0;
    const sellQty = data.positionType === "SHORT" ? data.quantity : 0;
    const buyValue = buyQty * data.entryPrice;
    const sellValue = sellQty * data.entryPrice;
    const unrealizedPnl =
      data.positionType === "LONG"
        ? (price - data.entryPrice) * data.quantity
        : (data.entryPrice - price) * data.quantity;
    const pnlPct =
      data.entryPrice > 0
        ? (unrealizedPnl / (data.entryPrice * data.quantity)) * 100
        : 0;

    const posData: Prisma.PositionCreateInput = {
      user: { connect: { id: userId } },
      symbol: upperSymbol,
      exchange: data.exchange,
      segment: data.segment,
      productType: data.productType,
      positionType: data.productType === "MIS" ? "DAY" : "NET",
      buyQuantity: buyQty,
      sellQuantity: sellQty,
      netQuantity: netQty,
      buyPrice: data.positionType === "LONG" ? data.entryPrice : 0,
      sellPrice: data.positionType === "SHORT" ? data.entryPrice : 0,
      averagePrice: data.entryPrice,
      lastPrice: price,
      buyValue,
      sellValue,
      netValue: netQty * price,
      realizedPnl: 0,
      unrealizedPnl,
      totalPnl: unrealizedPnl,
      pnlPercentage: pnlPct,
      tradeDate: new Date(),
      segmentLabel: data.segment.includes("FO")
        ? "Futures & Options"
        : "Equity",
      productTypeLabel:
        data.productType === "MIS"
          ? "Intraday"
          : data.productType === "NRML"
            ? "Carry Forward"
            : "Cash & Carry",
    };

    const position = await prisma.position.create({ data: posData });

    await clearUserCache(userId, ["positions", "holdings", "dashboard"]);

    return { success: true, data: { positionId: position.id } };
  } catch (error) {
    logger.error({ error, userId }, "Add manual position service error");
    return {
      success: false,
      error: "Failed to add position. Please try again.",
    };
  }
}
