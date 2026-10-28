/**
 * Paper Portfolio Service (MONEY-1062 P3a — parity divergence D2)
 *
 * The ORDER / CASH-PORTFOLIO paper-trading model that the LIVE web UI
 * (`apps/web/app/paper-trading/client.tsx`) actually uses — extracted so
 * `apps/api` (`/v1/paper/*`) can expose the SAME product mobile clients were
 * missing. Before this, `/v1/paper` only wrapped the LEGACY position model
 * (`paper.service.ts` create/close paper trade); mobile got a different product
 * than web (divergence D2). The legacy position endpoints are KEPT untouched;
 * this service is purely additive.
 *
 * Source (faithful port of the web action + its DB layer):
 *   apps/web/lib/actions/paper.ts
 *     :286 getOrCreatePortfolioAction   → getOrCreatePortfolio
 *     :316 placeOrderAction             → placeOrder
 *     :414 getOrdersAction              → getOrders
 *     :247 getPaperPerformanceAction    → getPerformance
 *     :439 getPaperDashboardStatsAction → getDashboardStats
 *     :499 resetPortfolioAction         → resetPortfolio
 *   apps/web/lib/db/paper-portfolio.ts  (getOrCreatePaperPortfolio, updatePortfolioCash, resetPortfolio)
 *   apps/web/lib/db/paper-order.ts      (createPaperOrder, getPaperOrders)
 *   apps/web/lib/db/paper.ts            (updateOrAveragePosition, createPaperPosition,
 *                                        getPaperPerformance, getPaperDashboardStats)
 *
 * PRICE-LOOKUP SEAM DECISION: the web `placeOrderAction` does NOT fetch a
 * quote — it takes the execution price straight from the request body
 * (`executedPrice = data.price || 0`, rejected when `<= 0`). MARKET orders rely
 * on the client supplying the current market price. There is therefore NO quote
 * seam to inject; `placeOrder` takes the price from its input exactly as the web
 * action does. The only injectable seam is `deps.prisma` (for the service tests).
 *
 * DUPLICATION (accepted, tracked): the pure P&L / cash / fill math below is
 * ported VERBATIM from `apps/web/lib/db/paper-logic.ts` (the source of truth for
 * this model). It is NOT imported from `packages/services/src/paper-logic.ts` —
 * that sibling copy backs the LEGACY position model and diverges (different
 * `summarizePaperPortfolio` shape, different `normalizeCreateValues` signature,
 * swapped `currentValue`/`investedValue` arg order, and it lacks
 * `averageIntoPosition` / `calculatePerformance` / `assetTypeForInstrumentType`).
 * The web action stays on its own copy too (web is NOT rewired). Converging the
 * three copies is a later cleanup; fidelity to the web model wins here.
 *
 * IDOR-safe: every read/write is scoped to the caller's Mongo `userId`.
 * G3: `placeOrder` validates (price > 0, sufficient cash) BEFORE any write, then
 * mirrors the web ordering — create order → update/average position → move cash.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { PlaceOrderData } from "@usemoney/validation";
import type { ServiceResult } from "./types";

// ════════════════════════════════════════════════════════════════════════════
// Pure math — ported VERBATIM from apps/web/lib/db/paper-logic.ts (see header).
// Behaviour-identical for finite inputs; every value is finite-guarded so a raw
// non-web caller (apps/api passes parsed-but-untrusted JSON) can never poison a
// persisted Prisma Float or a "₹NaN" total.
// ════════════════════════════════════════════════════════════════════════════

type PaperAssetType = "STOCK" | "FNO_FUTURES" | "FNO_OPTIONS" | "MF";

/** Coerce a possibly-non-finite numeric to a safe finite number (default 0). */
function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

/** P&L % — 0 unless the cost basis is a usable positive FINITE number and pnl is finite. */
function pnlPercentage(pnl: number, investedValue: number): number {
  if (!Number.isFinite(investedValue) || investedValue <= 0) return 0;
  if (!Number.isFinite(pnl)) return 0;
  return (pnl / investedValue) * 100;
}

/** Default trading segment for an asset type: OPTIONS/FUTURES/EQUITY. */
function defaultSegmentForAssetType(assetType: string): string {
  if (assetType === "FNO_OPTIONS") return "OPTIONS";
  if (assetType === "FNO_FUTURES") return "FUTURES";
  return "EQUITY";
}

/** Resolve segment: explicit wins, else the asset-type default. */
function resolveSegment(
  segment: string | null | undefined,
  assetType: string,
): string {
  return segment || defaultSegmentForAssetType(assetType);
}

/** Resolve side: explicit side wins, else positionType, else "LONG". */
function resolveSide(
  side: string | null | undefined,
  positionType: string | null | undefined,
): string {
  return side || positionType || "LONG";
}

/** Map an order instrumentType → stored assetType. */
function assetTypeForInstrumentType(instrumentType: string): PaperAssetType {
  if (instrumentType === "OPTIONS") return "FNO_OPTIONS";
  if (instrumentType === "FUTURES") return "FNO_FUTURES";
  if (instrumentType === "MF") return "MF";
  return "STOCK";
}

/** positionType for an order side: BUY → LONG, else SHORT. */
function positionTypeForSide(side: string): "LONG" | "SHORT" {
  return side === "BUY" ? "LONG" : "SHORT";
}

/** Invested value (cost basis) = quantity * averagePrice, finite-guarded. */
function investedValue(quantity: number, averagePrice: number): number {
  return finite(finite(quantity) * finite(averagePrice));
}

interface NormalizedCreateValues {
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
}

/**
 * Normalize the create input into the finite-guarded numbers persisted on a new
 * position. currentPrice defaults to averagePrice, currentValue to investedValue.
 */
function normalizeCreateValues(input: {
  quantity: number;
  averagePrice: number;
}): NormalizedCreateValues {
  const quantity = finite(input.quantity);
  const averagePrice = finite(input.averagePrice);
  const invested = investedValue(quantity, averagePrice);
  return {
    quantity,
    averagePrice,
    investedValue: invested,
    currentPrice: averagePrice,
    currentValue: invested,
  };
}

interface AveragedPosition {
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentValue: number;
}

/**
 * Average a new fill into an existing OPEN position. A zero (or non-finite)
 * total quantity collapses to a flat 0 position (guards the divide-by-zero when
 * legs net out) instead of persisting NaN/Infinity.
 */
function averageIntoPosition(
  existing: { quantity: number; averagePrice: number; currentPrice: number },
  fill: { quantity: number; price: number },
): AveragedPosition {
  const exQty = finite(existing.quantity);
  const exAvg = finite(existing.averagePrice);
  const exCurrent = finite(existing.currentPrice);
  const fillQty = finite(fill.quantity);
  const fillPrice = finite(fill.price);

  const totalQty = exQty + fillQty;
  if (!Number.isFinite(totalQty) || totalQty === 0) {
    return { quantity: 0, averagePrice: 0, investedValue: 0, currentValue: 0 };
  }
  const totalValue = exAvg * exQty + fillPrice * fillQty;
  const newAvgPrice = finite(totalValue / totalQty);
  return {
    quantity: totalQty,
    averagePrice: newAvgPrice,
    investedValue: finite(totalQty * newAvgPrice),
    currentValue: finite(totalQty * exCurrent),
  };
}

/** Fields the OPEN-position portfolio summary reduce reads off a row. */
interface PaperSummaryRow {
  status: string;
  assetType: string;
  investedValue: number;
  currentValue: number;
  benchmarkPnL?: number | null;
  dayPnl?: number | null;
}

interface PaperPortfolioSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: number;
  totalPositions: number;
  stockPositions: number;
  fnoPositions: number;
  mfPositions: number;
  benchmarkPnL: number;
  alpha: number;
  dayPnl: number;
}

/** Aggregate the OPEN-position portfolio summary (finite-guarded). */
function summarizePaperPortfolio(
  positions: PaperSummaryRow[],
): PaperPortfolioSummary {
  let totalInvested = 0;
  let totalCurrent = 0;
  let benchmarkPnL = 0;
  let dayPnl = 0;
  let openCount = 0;
  let stockCount = 0;
  let fnoCount = 0;
  let mfCount = 0;

  for (const p of positions) {
    if (p.status !== "OPEN") continue;
    totalInvested += finite(p.investedValue);
    totalCurrent += finite(p.currentValue);
    benchmarkPnL += finite(p.benchmarkPnL ?? 0);
    dayPnl += finite(p.dayPnl ?? 0);
    openCount += 1;
    if (p.assetType === "STOCK") stockCount += 1;
    else if (p.assetType === "FNO_FUTURES" || p.assetType === "FNO_OPTIONS")
      fnoCount += 1;
    else if (p.assetType === "MF") mfCount += 1;
  }

  const totalPnL = totalCurrent - totalInvested;
  return {
    totalInvested,
    totalCurrent,
    totalPnL,
    pnlPercentage: pnlPercentage(totalPnL, totalInvested),
    totalPositions: openCount,
    stockPositions: stockCount,
    fnoPositions: fnoCount,
    mfPositions: mfCount,
    benchmarkPnL,
    alpha: totalPnL - benchmarkPnL,
    dayPnl,
  };
}

/** Fields the performance reduce reads off a CLOSED row. */
interface PaperPerformanceRow {
  symbol: string;
  realizedPnL?: number | null;
  benchmarkPnL?: number | null;
}

interface PaperPerformance {
  totalTrades: number;
  closedTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalRealizedPnL: number;
  totalBenchmarkPnL: number;
  totalAlpha: number;
  avgWin: number;
  avgLoss: number;
  bestTradePnL: number;
  worstTradePnL: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
}

/** Win rate as a PERCENTAGE (0 when no closed trades). */
function calculateWinRate(winners: number, closedTrades: number): number {
  const w = finite(winners);
  const c = finite(closedTrades);
  if (c <= 0) return 0;
  return (w / c) * 100;
}

/** Mean of a P&L list, 0 for empty; finite-guarded sum. */
function average(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + finite(b), 0);
  return finite(sum / values.length);
}

/** Full paper-trading performance block from CLOSED + OPEN rows (finite-guarded). */
function calculatePerformance(
  closedRows: ReadonlyArray<PaperPerformanceRow>,
  openCount: number,
): PaperPerformance {
  const winners = closedRows.filter((p) => finite(p.realizedPnL) > 0);
  const losers = closedRows.filter((p) => finite(p.realizedPnL) < 0);

  const totalRealizedPnL = closedRows.reduce(
    (sum, p) => sum + finite(p.realizedPnL),
    0,
  );
  const totalBenchmarkPnL = closedRows.reduce(
    (sum, p) => sum + finite(p.benchmarkPnL),
    0,
  );

  const winPnls = winners.map((p) => finite(p.realizedPnL));
  const lossPnls = losers.map((p) => finite(p.realizedPnL));
  const allPnls = closedRows.map((p) => finite(p.realizedPnL));

  const bestTradePnL = allPnls.length > 0 ? Math.max(...allPnls) : 0;
  const worstTradePnL = allPnls.length > 0 ? Math.min(...allPnls) : 0;

  const bestRow =
    closedRows.find((p) => finite(p.realizedPnL) === bestTradePnL) ?? null;
  const worstRow =
    closedRows.find((p) => finite(p.realizedPnL) === worstTradePnL) ?? null;

  return {
    totalTrades: closedRows.length + finite(openCount),
    closedTrades: closedRows.length,
    winners: winners.length,
    losers: losers.length,
    winRate: calculateWinRate(winners.length, closedRows.length),
    totalRealizedPnL: finite(totalRealizedPnL),
    totalBenchmarkPnL: finite(totalBenchmarkPnL),
    totalAlpha: finite(finite(totalRealizedPnL) - finite(totalBenchmarkPnL)),
    avgWin: average(winPnls),
    avgLoss: average(lossPnls),
    bestTradePnL: finite(bestTradePnL),
    worstTradePnL: finite(worstTradePnL),
    bestTrade: bestRow
      ? { symbol: bestRow.symbol, pnl: finite(bestRow.realizedPnL) }
      : null,
    worstTrade: worstRow
      ? { symbol: worstRow.symbol, pnl: finite(worstRow.realizedPnL) }
      : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════════════

/** Injectable IO seam. Defaults to the shared Prisma client; tests inject a fake. */
export interface PaperPortfolioDeps {
  prisma?: typeof prisma;
}

export interface PaperPortfolioView {
  id: string;
  initialCapital: number;
  cash: number;
}

export interface PlaceOrderResult {
  orderId: string;
  executedPrice: number;
}

export interface PaperPerformanceView {
  totalTrades: number;
  closedTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalRealizedPnL: number;
  totalBenchmarkPnL: number;
  totalAlpha: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
}

export interface PaperDashboardView {
  portfolio: PaperPortfolioView;
  positions: {
    open: number;
    closed: number;
    totalInvested: number;
    totalCurrentValue: number;
    totalPnl: number;
    totalPnlPercentage: number;
    dayPnl: number;
  };
  performance: {
    winRate: number;
    totalTrades: number;
    winners: number;
    losers: number;
    avgWin: number;
    avgLoss: number;
    bestTrade: number;
    worstTrade: number;
  };
}

const INITIAL_CAPITAL = 1_000_000;

// ════════════════════════════════════════════════════════════════════════════
// Internal Prisma helpers (mirror the web DB layer, scoped to userId)
// ════════════════════════════════════════════════════════════════════════════

/** Mirror apps/web/lib/db/paper-portfolio.ts#getOrCreatePaperPortfolio. */
async function getOrCreatePortfolioRow(db: typeof prisma, userId: string) {
  let portfolio = await db.paperPortfolio.findUnique({ where: { userId } });
  if (!portfolio) {
    portfolio = await db.paperPortfolio.create({
      data: { userId, initialCapital: INITIAL_CAPITAL, cash: INITIAL_CAPITAL },
    });
  }
  return portfolio;
}

/**
 * Update or average a fill into the caller's OPEN position for this symbol+side.
 * Mirror apps/web/lib/db/paper.ts#updateOrAveragePosition (+ its createPaperPosition
 * for the new-position branch). Grouping key is symbol.toUpperCase() + order side.
 */
async function upsertAveragedPosition(
  db: typeof prisma,
  userId: string,
  portfolioId: string,
  data: {
    symbol: string;
    name: string;
    exchange: string;
    instrumentType: string;
    side: string;
    quantity: number;
    price: number;
    stopLoss?: number;
    target?: number;
    strategy?: string;
    optionType?: string;
    strikePrice?: number;
    expiry?: Date;
    lotSize?: number;
  },
): Promise<void> {
  const existing = await db.paperPosition.findFirst({
    where: {
      userId,
      portfolioId,
      symbol: data.symbol.toUpperCase(),
      side: data.side,
      status: "OPEN",
    },
  });

  if (existing) {
    const avg = averageIntoPosition(
      {
        quantity: existing.quantity,
        averagePrice: existing.averagePrice,
        currentPrice: existing.currentPrice,
      },
      { quantity: data.quantity, price: data.price },
    );
    await db.paperPosition.update({
      where: { id: existing.id },
      data: {
        quantity: avg.quantity,
        averagePrice: avg.averagePrice,
        investedValue: avg.investedValue,
        currentValue: avg.currentValue,
        stopLoss: data.stopLoss ?? existing.stopLoss,
        target: data.target ?? existing.target,
        strategy: data.strategy ?? existing.strategy,
      },
    });
    return;
  }

  // New position (mirror createPaperPosition; persisted `side` = the order side).
  const assetType = assetTypeForInstrumentType(data.instrumentType);
  const positionType = positionTypeForSide(data.side);
  const norm = normalizeCreateValues({
    quantity: data.quantity,
    averagePrice: data.price,
  });
  await db.paperPosition.create({
    data: {
      userId,
      portfolioId,
      symbol: data.symbol.toUpperCase(),
      name: data.name,
      assetType,
      segment: resolveSegment(undefined, assetType),
      exchange: data.exchange || "NSE",
      positionType,
      side: resolveSide(data.side, positionType),
      quantity: norm.quantity,
      lotSize: data.lotSize,
      averagePrice: norm.averagePrice,
      investedValue: norm.investedValue,
      currentPrice: norm.currentPrice,
      currentValue: norm.currentValue,
      unrealizedPnL: 0,
      pnlPercentage: 0,
      dayPnl: 0,
      optionType: data.optionType,
      strikePrice: data.strikePrice,
      expiryDate: data.expiry,
      benchmarkPnL: 0,
      alpha: 0,
      stopLoss: data.stopLoss,
      target: data.target,
      strategy: data.strategy,
      status: "OPEN",
      tags: [],
      entryDate: new Date(),
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Service functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get (or lazily create) the caller's paper portfolio.
 * Mirror getOrCreatePortfolioAction (apps/web/lib/actions/paper.ts:286).
 */
export async function getOrCreatePaperPortfolio(
  userId: string,
  deps: PaperPortfolioDeps = {},
): Promise<ServiceResult<PaperPortfolioView>> {
  const db = deps.prisma ?? prisma;
  try {
    const portfolio = await getOrCreatePortfolioRow(db, userId);
    return {
      success: true,
      data: {
        id: portfolio.id,
        initialCapital: portfolio.initialCapital,
        cash: portfolio.cash,
      },
    };
  } catch (error) {
    logger.error(
      { error, userId },
      "Get or create paper portfolio service error",
    );
    return {
      success: false,
      error: "Failed to get portfolio",
      code: "INTERNAL",
    };
  }
}

/**
 * Place a paper order against the caller's cash portfolio.
 * Mirror placeOrderAction (apps/web/lib/actions/paper.ts:316) EXACTLY:
 *   price from the body (no quote fetch) → reject `<= 0` (INVALID_INPUT) →
 *   cash-check BUY (INVALID_INPUT) → create order → update/average position →
 *   move cash (BUY debits, SELL credits). All money fields finite-guarded.
 *
 * (Behaviour-neutral omission vs web: the web action does a redundant
 * `getOrCreatePaperPortfolio` re-fetch just before moving cash whose result is
 * discarded — the portfolio provably already exists, so it is dropped here.)
 */
export async function placePaperOrder(
  userId: string,
  input: PlaceOrderData,
  deps: PaperPortfolioDeps = {},
): Promise<ServiceResult<PlaceOrderResult>> {
  const db = deps.prisma ?? prisma;
  try {
    const portfolio = await getOrCreatePortfolioRow(db, userId);

    // MARKET orders execute at the client-supplied price (no quote seam).
    const executedPrice = finite(input.price);
    if (executedPrice <= 0) {
      return {
        success: false,
        error: "Price is required for order execution",
        code: "INVALID_INPUT",
      };
    }

    const totalCost = finite(executedPrice * finite(input.quantity));

    if (input.side === "BUY" && totalCost > portfolio.cash) {
      return {
        success: false,
        error: `Insufficient cash. Available: ₹${portfolio.cash.toLocaleString(
          "en-IN",
        )}, Required: ₹${totalCost.toLocaleString("en-IN")}`,
        code: "INVALID_INPUT",
      };
    }

    // 1) Order record (EXECUTED). Mirror createPaperOrder; note the web action
    //    does NOT forward triggerPrice, so neither do we.
    const order = await db.paperOrder.create({
      data: {
        userId,
        portfolioId: portfolio.id,
        symbol: input.symbol.toUpperCase(),
        name: input.name,
        exchange: input.exchange || "NSE",
        instrumentType: input.instrumentType || "EQUITY",
        side: input.side,
        orderType: input.orderType || "MARKET",
        status: "EXECUTED",
        quantity: input.quantity,
        price: input.price,
        executedPrice,
        executedAt: new Date(),
        stopLoss: input.stopLoss,
        target: input.target,
        strategy: input.strategy,
        optionType: input.optionType,
        strikePrice: input.strikePrice,
        expiry: input.expiry,
        lotSize: input.lotSize,
      },
    });

    // 2) Update or average the position.
    await upsertAveragedPosition(db, userId, portfolio.id, {
      symbol: input.symbol,
      name: input.name,
      exchange: input.exchange,
      instrumentType: input.instrumentType,
      side: input.side,
      quantity: input.quantity,
      price: executedPrice,
      stopLoss: input.stopLoss,
      target: input.target,
      strategy: input.strategy,
      optionType: input.optionType,
      strikePrice: input.strikePrice,
      expiry: input.expiry,
      lotSize: input.lotSize,
    });

    // 3) Move cash: BUY debits, SELL credits.
    const cashChange = input.side === "BUY" ? -totalCost : totalCost;
    await db.paperPortfolio.update({
      where: { id: portfolio.id },
      data: { cash: { increment: cashChange } },
    });

    return { success: true, data: { orderId: order.id, executedPrice } };
  } catch (error) {
    logger.error({ error, userId }, "Place paper order service error");
    return { success: false, error: "Failed to place order", code: "INTERNAL" };
  }
}

/**
 * List the caller's recent paper orders (newest first).
 * Mirror getOrdersAction (:414) → getPaperOrders. Not cursor-paginated (the web
 * action is not); `limit` caps the take (the route clamps it to [1, 100]).
 */
export async function getPaperOrders(
  userId: string,
  opts: { limit?: number; status?: string } = {},
  deps: PaperPortfolioDeps = {},
): Promise<ServiceResult<Array<Record<string, unknown>>>> {
  const db = deps.prisma ?? prisma;
  try {
    const orders = await db.paperOrder.findMany({
      where: { userId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.limit ?? 50,
    });
    return {
      success: true,
      data: orders as unknown as Array<Record<string, unknown>>,
    };
  } catch (error) {
    logger.error({ error, userId }, "Get paper orders service error");
    return {
      success: false,
      error: "Failed to fetch orders",
      code: "INTERNAL",
    };
  }
}

/**
 * Closed-trade performance summary for the caller.
 * Mirror getPaperPerformanceAction (:247) → getPaperPerformance.
 */
export async function getPaperPerformance(
  userId: string,
  deps: PaperPortfolioDeps = {},
): Promise<ServiceResult<PaperPerformanceView>> {
  const db = deps.prisma ?? prisma;
  try {
    const closed = await db.paperPosition.findMany({
      where: { userId, status: "CLOSED" },
      orderBy: { realizedPnL: "desc" },
    });
    const open = await db.paperPosition.findMany({
      where: { userId, status: "OPEN" },
    });
    const perf = calculatePerformance(closed, open.length);
    return {
      success: true,
      data: {
        totalTrades: perf.totalTrades,
        closedTrades: perf.closedTrades,
        winners: perf.winners,
        losers: perf.losers,
        winRate: perf.winRate,
        totalRealizedPnL: perf.totalRealizedPnL,
        totalBenchmarkPnL: perf.totalBenchmarkPnL,
        totalAlpha: perf.totalAlpha,
        bestTrade: perf.bestTrade,
        worstTrade: perf.worstTrade,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get paper performance service error");
    return {
      success: false,
      error: "Failed to fetch performance",
      code: "INTERNAL",
    };
  }
}

/**
 * Combined dashboard stats (portfolio + open/closed position totals + closed
 * performance). Mirror getPaperDashboardStatsAction (:439) → getPaperDashboardStats.
 */
export async function getPaperDashboardStats(
  userId: string,
  deps: PaperPortfolioDeps = {},
): Promise<ServiceResult<PaperDashboardView>> {
  const db = deps.prisma ?? prisma;
  try {
    const portfolio = await getOrCreatePortfolioRow(db, userId);
    const open = await db.paperPosition.findMany({
      where: { userId, status: "OPEN" },
    });
    const closed = await db.paperPosition.findMany({
      where: { userId, status: "CLOSED" },
    });
    const s = summarizePaperPortfolio(open);
    const perf = calculatePerformance(closed, open.length);

    return {
      success: true,
      data: {
        portfolio: {
          id: portfolio.id,
          initialCapital: portfolio.initialCapital,
          cash: portfolio.cash,
        },
        positions: {
          open: open.length,
          closed: closed.length,
          totalInvested: s.totalInvested,
          totalCurrentValue: s.totalCurrent,
          totalPnl: s.totalPnL,
          totalPnlPercentage: s.pnlPercentage,
          dayPnl: s.dayPnl,
        },
        performance: {
          winRate: perf.winRate,
          totalTrades: perf.closedTrades,
          winners: perf.winners,
          losers: perf.losers,
          avgWin: perf.avgWin,
          avgLoss: perf.avgLoss,
          bestTrade: perf.bestTradePnL,
          worstTrade: perf.worstTradePnL,
        },
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get paper dashboard stats service error");
    return {
      success: false,
      error: "Failed to fetch dashboard stats",
      code: "INTERNAL",
    };
  }
}

/**
 * Reset the caller's paper portfolio: purge orders, CLOSE all positions, and
 * restore cash to the initial capital — in ONE transaction (mirror
 * resetPortfolioAction (:499) → resetPortfolio). Idempotent: a caller with no
 * portfolio yet is a success no-op (`data: null`), matching the web action.
 */
export async function resetPaperPortfolio(
  userId: string,
  deps: PaperPortfolioDeps = {},
): Promise<ServiceResult<PaperPortfolioView | null>> {
  const db = deps.prisma ?? prisma;
  try {
    const portfolio = await db.paperPortfolio.findUnique({ where: { userId } });
    if (!portfolio) {
      return { success: true, data: null };
    }

    await db.$transaction([
      db.paperOrder.deleteMany({ where: { portfolioId: portfolio.id } }),
      db.paperPosition.updateMany({
        where: { portfolioId: portfolio.id },
        data: { status: "CLOSED", exitDate: new Date() },
      }),
      db.paperPortfolio.update({
        where: { id: portfolio.id },
        data: { cash: portfolio.initialCapital },
      }),
    ]);

    const updated = await db.paperPortfolio.findUnique({ where: { userId } });
    return {
      success: true,
      data: updated
        ? {
            id: updated.id,
            initialCapital: updated.initialCapital,
            cash: updated.cash,
          }
        : null,
    };
  } catch (error) {
    logger.error({ error, userId }, "Reset paper portfolio service error");
    return {
      success: false,
      error: "Failed to reset portfolio",
      code: "INTERNAL",
    };
  }
}
