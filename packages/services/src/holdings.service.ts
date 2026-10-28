/**
 * Holdings Service
 *
 * Handles holdings queries, sector enrichment, and cache management.
 * Source: apps/web/lib/actions/holdings.ts + apps/web/lib/db/holdings.ts
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached, clearHoldingsCache } from "@usemoney/core";
// Subpath, NOT the root barrel: these two are pure in-process helpers (a
// dedupe registry and a string builder), and the service tests stub the ROOT
// `@usemoney/core` with a catch-all Proxy that answers any unmodelled export
// with a no-op. Imported from the root, `singleFlight` silently became
// `async () => {}` and every LIVE service test got `undefined` back instead of
// its result. The I/O boundary the tests DO need to control — getCached /
// setCached — stays on the root import above.
import { singleFlight, generateCacheKey } from "@usemoney/core/cache";
import {
  enrichInstrumentsBySymbol,
  REAL_SECTOR_WHERE,
} from "@usemoney/core/market-data";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  computeHoldingValues,
  summarizeHoldings,
  groupHoldingsBySector,
  groupHoldingsByExchange,
  safeToDateString,
  isUsableSector,
  resolveSector,
  type HoldingGroup,
} from "./holdings-logic";
import { keysetPageById, type ListPageParams } from "./trades-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface HoldingItem {
  id: string;
  symbol: string;
  name: string | null;
  sector: string | null;
  exchange: string;
  quantity: number;
  t1Quantity: number;
  averagePrice: number;
  currentPrice: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  broker: string | null;
  brokerUserId: string | null;
  brokerName: string | null;
  brokerDisplayName?: string | null;
  purchaseDate?: string;
}

export interface HoldingSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: string;
}

export interface HoldingFilters {
  symbol?: string;
  sector?: string;
}

/**
 * Holdings query result. `sectorBreakdown`/`exchangeBreakdown` are additive,
 * finite-guarded groupings of the returned holdings — every bucket's subtotals
 * are computed from the SAME guarded per-holding values as `summary`, so their
 * union reconciles with the grand total even on a corrupt/poisoned row.
 */
export interface HoldingsResult {
  holdings: HoldingItem[];
  summary: HoldingSummary;
  sectorBreakdown: HoldingGroup[];
  exchangeBreakdown: HoldingGroup[];
  /**
   * Keyset for the next page, present ONLY when the caller passed a `limit`
   * (cursor pagination). `string` = more rows exist (pass it back as the next
   * cursor); `null` = last page. Absent entirely on the unbounded default path.
   */
  nextCursorId?: string | null;
}

/**
 * Apply optional keyset pagination to a FULL holdings result WITHOUT touching
 * the summary/breakdowns (which must reflect the entire portfolio). Returns the
 * result unchanged when no `limit` was requested — the cached object is never
 * mutated (a fresh object is spread when paginating).
 */
function applyHoldingsPage(
  result: HoldingsResult,
  page?: ListPageParams,
): HoldingsResult {
  if (!page || page.limit === undefined) return result;
  const { page: holdings, nextCursorId } = keysetPageById(
    result.holdings,
    page.limit,
    page.cursorId,
  );
  return { ...result, holdings, nextCursorId };
}

// ── Service Functions ──────────────────────────────────────────────

export async function getHoldings(
  userId: string,
  filters: HoldingFilters = {},
  page?: ListPageParams,
): Promise<ServiceResult<HoldingsResult>> {
  try {
    // MONEY-705 stampede protection. The flight key is the cache key itself
    // (`generateCacheKey` with the SAME module/userId/identifier/filters the
    // get+set pair below derives it from), so the flight can never collapse two
    // different users — or two different filter sets — onto one execution.
    // Pagination stays OUTSIDE the flight: the cached/computed value is always
    // the FULL result, so concurrent callers asking for different pages of the
    // same filter set still share one query and each slices its own page.
    const result = await singleFlight(
      generateCacheKey("holdings", userId, "list", filters),
      () => resolveHoldings(userId, filters),
    );
    return { success: true, data: applyHoldingsPage(result, page) };
  } catch (error) {
    logger.error({ error, userId }, "Holdings service error");
    return { success: false, error: "Failed to fetch holdings" };
  }
}

/** Cache-read → compute → cache-write body, run at most once per key per flight. */
async function resolveHoldings(
  userId: string,
  filters: HoldingFilters,
): Promise<HoldingsResult> {
  // Check cache. The cache always holds the FULL result (keyed by filters, NOT
  // by page/cursor); pagination is applied AFTER the read so the summary and
  // breakdowns stay computed over the entire portfolio.
  const cached = await getCached<HoldingsResult>(
    "holdings",
    userId,
    "list",
    filters,
  );

  if (cached) {
    logger.debug({ userId, filters }, "Holdings from cache");
    return cached;
  }

  logger.debug({ userId, filters }, "Holdings cache miss");

  // Build query
  const where: Record<string, unknown> = { userId };
  if (filters.symbol) {
    where.symbol = { contains: filters.symbol, mode: "insensitive" };
  }
  if (filters.sector && filters.sector !== "all") {
    where.sector = filters.sector;
  }

  const dbHoldings = await prisma.holding.findMany({
    where: {
      ...where,
      OR: [{ quantity: { gt: 0 } }, { t1Quantity: { gt: 0 } }],
    },
    orderBy: { lastUpdated: "desc" },
    select: {
      id: true,
      symbol: true,
      name: true,
      tradingSymbol: true,
      sector: true,
      exchange: true,
      quantity: true,
      t1Quantity: true,
      averagePrice: true,
      currentPrice: true,
      investedValue: true,
      currentValue: true,
      unrealizedPnL: true,
      pnlPercentage: true,
      broker: true,
      brokerUserId: true,
      createdAt: true,
      lastUpdated: true,
    },
  });

  // Enrich holdings missing a USABLE sector from InstrumentMapping. Sector is
  // a property of the company, not the exchange listing, so `resolveSector`
  // falls back across exchanges: a BSE holding inherits the SAME symbol's NSE
  // sector when the sparse BSE row is unenriched or stuck at the "N/A" SKIPPED
  // sentinel. (A naive `sector != null` join treats "N/A" as valid — it isn't.)
  const needsSector = dbHoldings.filter((h) => !isUsableSector(h.sector));
  if (needsSector.length > 0) {
    const symbols = [...new Set(needsSector.map((h) => h.symbol))];
    const instruments = await prisma.instrumentMapping.findMany({
      where: { symbol: { in: symbols }, sector: REAL_SECTOR_WHERE },
      select: { symbol: true, exchange: true, sector: true },
    });
    for (const h of needsSector) {
      const sector = resolveSector(h.symbol, h.exchange, instruments);
      if (sector) {
        (h as typeof h & { sector: string }).sector = sector;
      }
    }

    // On-demand sector enrichment (best-effort, fire-and-forget) for any held
    // name STILL without a usable sector on ANY exchange — bounded, idempotent,
    // never awaited, never throws. A newly-bought / freshly-demerged stock
    // whose InstrumentMapping row hasn't been enriched yet fills in within a
    // refresh or two instead of waiting up to a week for the cron.
    // `enrichInstrumentsBySymbol` skips rows already enriched or marked
    // permanently-unresolvable ("N/A"), so a dead symbol is never re-fetched.
    const stillMissing = needsSector
      .filter((h) => !isUsableSector(h.sector))
      .map((h) => ({ symbol: h.symbol, exchange: h.exchange }));
    if (stillMissing.length > 0) {
      void enrichInstrumentsBySymbol(stillMissing).catch((err: unknown) => {
        logger.warn(
          { err, userId, count: stillMissing.length },
          "On-demand sector enrichment failed (non-fatal)",
        );
      });
    }
  }

  // Transform to UI format with T1 settlement handling. All monetary math is
  // delegated to the pure, finite-guarded helpers in ./holdings-logic so one
  // corrupt sync row (NaN/Infinity value, Invalid-Date createdAt) can never
  // poison the portfolio total ("₹NaN") or 500 the whole response.
  const holdings: HoldingItem[] = dbHoldings.map((holding) => {
    const v = computeHoldingValues(holding);

    return {
      id: holding.id,
      symbol: holding.symbol,
      name: holding.name || holding.tradingSymbol || holding.symbol,
      sector: holding.sector,
      exchange: holding.exchange,
      quantity: holding.quantity,
      t1Quantity: v.t1Quantity,
      averagePrice: holding.averagePrice,
      currentPrice: holding.currentPrice,
      investedValue: v.investedValue,
      currentValue: v.currentValue,
      unrealizedPnL: v.unrealizedPnL,
      pnlPercentage: v.pnlPercentage,
      broker: holding.broker,
      brokerUserId: holding.brokerUserId,
      brokerName: holding.broker?.toLowerCase() ?? null,
      brokerDisplayName: holding.broker,
      purchaseDate: safeToDateString(holding.createdAt),
    };
  });

  const result: HoldingsResult = {
    holdings,
    summary: summarizeHoldings(holdings),
    sectorBreakdown: groupHoldingsBySector(holdings),
    exchangeBreakdown: groupHoldingsByExchange(holdings),
  };

  await setCached("holdings", userId, "list", result, filters);
  return result;
}

export async function deleteHolding(
  userId: string,
  holdingId: string,
): Promise<ServiceResult<void>> {
  try {
    // Check if trade exists and is a manual entry
    const trade = await prisma.trade.findFirst({
      where: { id: holdingId, userId },
      select: { brokerTradeId: true, broker: true, brokerName: true },
    });

    if (!trade) {
      return { success: false, error: "Holding not found", code: "NOT_FOUND" };
    }

    if (
      trade.brokerTradeId ||
      (trade.broker && trade.broker !== "MANUAL") ||
      (trade.brokerName && trade.brokerName !== "manual")
    ) {
      return {
        success: false,
        error:
          "Cannot delete broker-synced holdings. Only manual entries can be deleted.",
      };
    }

    const deleted = await prisma.trade.deleteMany({
      where: { id: holdingId, userId },
    });

    if (deleted.count === 0) {
      return {
        success: false,
        error: "Holding not found or already deleted",
        code: "NOT_FOUND",
      };
    }

    await clearHoldingsCache(userId);
    return {
      success: true,
      data: undefined,
      message: "Holding deleted successfully!",
    };
  } catch (error) {
    logger.error({ error, userId, holdingId }, "Delete holding service error");
    return {
      success: false,
      error: "Failed to delete holding",
      code: "INTERNAL",
    };
  }
}
