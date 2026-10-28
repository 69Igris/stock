/**
 * FIFO Trade Pairing Algorithm
 *
 * This algorithm pairs buy and sell trades using First-In-First-Out matching.
 * When partial fills occur, it creates split rows:
 * - Example: Buy 5 units, Sell 2 units → 2 closed rows + 3 open rows
 */

/**
 * Epsilon threshold for floating point quantity comparisons.
 * Quantities smaller than this are treated as zero to handle floating point precision errors.
 * Example: 3.012e-12 (0.000000000003) should be treated as 0.
 */
export const QUANTITY_EPSILON = 1e-6; // 0.000001

/**
 * Check if a quantity is effectively zero (within floating point precision).
 *
 * Exported so the real epsilon contract is unit-tested against THIS symbol
 * (no shadow copy). Non-finite inputs (NaN / ±Infinity) are explicitly NOT
 * "zero": `Math.abs(NaN) < eps` is `false` and `Math.abs(Infinity) < eps` is
 * `false`. Sanitization upstream (`isFiniteQuantity`) is what keeps those out
 * of the matching loop — see `pairTradesFIFO`.
 */
export function isEffectivelyZero(qty: number): boolean {
  return Math.abs(qty) < QUANTITY_EPSILON;
}

/**
 * True only for a real, tradable quantity: a finite number strictly greater
 * than the epsilon. Rejects NaN, +Infinity, -Infinity, 0 and negatives.
 *
 * A trade row whose quantity is not finite-positive cannot form a valid
 * position — without this guard a NaN/Infinity/negative quantity leaks
 * straight into a persisted PairedTradeView (qty: NaN / Infinity / -5) and a
 * NaN quantity poisons `totalRealizedPnL` via `Math.min(NaN, …)`.
 */
export function isFiniteQuantity(qty: number): boolean {
  return Number.isFinite(qty) && qty > QUANTITY_EPSILON;
}

/**
 * Coerce a price to a finite number. Non-finite prices (NaN / ±Infinity) are
 * normalized to 0 so realized P&L can never become NaN/Infinity. The upstream
 * `service.ts` already maps a missing price to 0 (`price || 0`), but Infinity
 * survives `||`, so the algorithm clamps defensively at its own boundary.
 */
export function sanitizePrice(price: number): number {
  return Number.isFinite(price) ? price : 0;
}

/**
 * Milliseconds for a Date, guarded against an Invalid Date.
 *
 * `new Date("garbage").getTime()` is `NaN`, which makes the FIFO sort
 * comparator non-deterministic and would later throw when persisted /
 * `.toISOString()`-ed. Unparseable dates sort to the epoch (0, i.e. oldest)
 * so they remain at a stable, deterministic position instead of poisoning the
 * comparator.
 */
export function safeTime(date: Date): number {
  const t = date.getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** True for a `Date` that parses to a real instant (not `Invalid Date`). */
function isValidDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * The effective FIFO timestamp for a trade as a GUARANTEED-valid Date.
 *
 * Mirrors the algorithm's `tradeTime || tradeDate` precedence but is
 * Invalid-Date-aware: a present-but-unparseable `tradeTime` falls through to
 * `tradeDate`, and if neither parses the trade is anchored to the Unix epoch.
 * This is what stops an `Invalid Date` from being written into a persisted
 * PairedTradeView.entryDate/exitDate (which Prisma rejects and `.toISOString()`
 * throws on). A row that reaches the epoch sentinel is also the oldest, which
 * keeps FIFO ordering deterministic.
 */
export function resolveTradeDate(trade: {
  tradeTime: Date | null;
  tradeDate: Date;
}): Date {
  if (trade.tradeTime && isValidDate(trade.tradeTime)) return trade.tradeTime;
  if (isValidDate(trade.tradeDate)) return trade.tradeDate;
  return new Date(0); // epoch sentinel — never an Invalid Date
}

import type {
  BrokerType,
  TradeSource,
  PairedTradeStatus,
} from "@prisma/client";
import {
  type CorporateActionInput,
  computeCostBasisAdjustment,
} from "./corp-actions";

export type { CorporateActionInput } from "./corp-actions";

// Input trade structure (from database)
export interface TradeInput {
  id: string;
  userId: string;
  symbol: string;
  isin: string | null; // ISIN for matching across symbol name changes
  exchange: string;
  segment: string;
  broker: BrokerType | null;
  brokerUserId: string | null;
  tradeType: string; // "BUY" or "SELL"
  positionType: string;
  productType: string;
  quantity: number;
  price: number;
  tradeDate: Date;
  tradeTime: Date | null;
  sourceType: TradeSource;
  segmentLabel?: string | null;
  productTypeLabel?: string | null;
}

// Output structure for PairedTradeView
export interface PairedTradeOutput {
  userId: string;
  sourceTradeIds: string[];
  entryTradeId: string | null;
  exitTradeId: string | null;
  symbol: string;
  isin: string | null; // ISIN for matching across symbol name changes
  exchange: string;
  segment: string;
  broker: BrokerType | null;
  brokerUserId: string | null;
  entryDate: Date;
  entryPrice: number;
  entryQuantity: number;
  exitDate: Date | null;
  exitPrice: number | null;
  quantity: number;
  realizedPnL: number | null;
  pnlPercentage: number | null;
  status: PairedTradeStatus;
  positionType: string;
  productType: string;
  sourceType: TradeSource;
  tradeType: string;
  segmentLabel: string | null;
  productTypeLabel: string | null;
}

// Internal structure for tracking remaining quantity
interface TradeWithRemaining extends TradeInput {
  remainingQty: number;
}

// Statistics from the pairing operation
export interface PairingStats {
  totalTrades: number;
  openPositions: number;
  closedPositions: number;
  partialPositions: number;
  totalRealizedPnL: number;
}

// Result from the pairing algorithm
export interface PairingResult {
  pairedViews: PairedTradeOutput[];
  stats: PairingStats;
}

/**
 * Generate a unique grouping key for trades
 * Groups by: (ISIN or symbol) + exchange + productType + broker + brokerUserId
 *
 * IMPORTANT: ISIN is used as the primary identifier when available because:
 * - Mutual fund names can change over time (e.g., "MIRAE ASSET NYSE FANG+ ETF" vs "MIRAE ASSET NYSE FANG ETF")
 * - Stock symbols can change during corporate actions
 * - ISIN (International Securities Identification Number) remains constant
 *
 * productType is important: MIS (intraday) and CNC (delivery) should be paired separately
 */
export function getGroupKey(trade: TradeInput): string {
  // Use ISIN as primary identifier if available, otherwise fall back to symbol
  const securityIdentifier = trade.isin || trade.symbol;
  return `${securityIdentifier}|${trade.exchange}|${trade.productType}|${trade.broker || ""}|${trade.brokerUserId || ""}`;
}

/**
 * Sort trades by trade time (oldest first for FIFO).
 *
 * Stable: Array.prototype.sort is stable in V8/Node, so trades with identical
 * timestamps keep their input order (FIFO tie-break). `safeTime` guards an
 * Invalid Date (`getTime()` → NaN) so the comparator never returns NaN.
 */
export function sortByTradeTime(trades: TradeInput[]): TradeInput[] {
  return [...trades].sort((a, b) => {
    const dateA = a.tradeTime || a.tradeDate;
    const dateB = b.tradeTime || b.tradeDate;
    return safeTime(dateA) - safeTime(dateB);
  });
}

/**
 * Calculate P&L based on position type
 * LONG: (exitPrice - entryPrice) × quantity
 * SHORT: (entryPrice - exitPrice) × quantity
 */
export function calculatePnL(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  positionType: string,
): number {
  if (positionType === "SHORT") {
    return (entryPrice - exitPrice) * quantity;
  }
  // LONG position (default)
  return (exitPrice - entryPrice) * quantity;
}

/**
 * Calculate P&L percentage
 */
export function calculatePnLPercentage(
  entryPrice: number,
  exitPrice: number,
  positionType: string,
): number {
  if (entryPrice === 0) return 0;

  if (positionType === "SHORT") {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }
  // LONG position (default)
  return ((exitPrice - entryPrice) / entryPrice) * 100;
}

/**
 * Determine position type from trade type
 * BUY as entry = LONG position
 * SELL as entry = SHORT position
 */
export function getPositionType(entryTradeType: string): string {
  return entryTradeType === "BUY" ? "LONG" : "SHORT";
}

/**
 * Check if a trade is an entry trade for the position type
 */
export function isEntryTrade(tradeType: string, positionType: string): boolean {
  if (positionType === "LONG") return tradeType === "BUY";
  if (positionType === "SHORT") return tradeType === "SELL";
  // Default: BUY is entry
  return tradeType === "BUY";
}

/**
 * Main FIFO Trade Pairing Algorithm
 *
 * Process:
 * 1. Group trades by symbol + exchange + broker
 * 2. Sort by trade time (oldest first)
 * 3. Apply corporate-action cost-basis adjustment to each BUY lot (MONEY-840)
 * 4. For each group, match entries with exits using FIFO
 * 5. Split trades when partial matches occur
 * 6. Create OPEN rows for remaining unmatched entries
 *
 * Corporate actions (optional, default `[]`): SPLIT/BONUS restate Holdings, so a
 * pre-action BUY lot must be scaled into post-action units BEFORE it can be
 * matched — quantity UP, per-unit price DOWN, total cost preserved (see
 * `corp-actions.ts`). The function stays PURE: actions are PASSED IN, never
 * fetched here. Each (lot, action) pair is absorbed exactly once per pass via a
 * per-lot `appliedActionIds` set, so re-running with the same inputs yields
 * identical lots (idempotent). `now` defaults to the wall clock so an
 * announced-but-not-yet-ex action does not adjust a lot the broker hasn't
 * restated yet.
 */
export function pairTradesFIFO(
  trades: TradeInput[],
  corporateActions: CorporateActionInput[] = [],
  now: Date = new Date(),
): PairingResult {
  const pairedViews: PairedTradeOutput[] = [];
  let totalRealizedPnL = 0;
  let openPositions = 0;
  let closedPositions = 0;
  let partialPositions = 0;

  // Group trades by symbol + exchange + broker
  const tradeGroups = new Map<string, TradeInput[]>();

  for (const trade of trades) {
    const key = getGroupKey(trade);
    if (!tradeGroups.has(key)) {
      tradeGroups.set(key, []);
    }
    tradeGroups.get(key)!.push(trade);
  }

  // Process each group
  for (const [, groupTrades] of Array.from(tradeGroups)) {
    // Drop rows that can't form a valid position BEFORE matching:
    //  - quantity not finite-positive (NaN / ±Infinity / 0 / negative) would
    //    otherwise leak a garbage PairedTradeView (qty: NaN/Infinity/-5) and a
    //    NaN quantity poisons realized P&L via Math.min(NaN, …).
    // Prices are clamped to finite (Infinity/NaN → 0) so P&L stays a number.
    // Sanitize BEFORE sorting so FIFO order is computed from the resolved,
    // guaranteed-valid effective dates (an Invalid tradeTime that falls back to
    // a valid tradeDate must order by tradeDate, not at the epoch).
    const sanitized = groupTrades
      .filter((t) => isFiniteQuantity(t.quantity))
      .map((t) => {
        // Pin both date fields to a single guaranteed-valid effective date so
        // every downstream `tradeTime || tradeDate` read emits a valid
        // entryDate/exitDate (never an Invalid Date that Prisma/.toISOString()
        // would reject).
        const effective = resolveTradeDate(t);
        return {
          ...t,
          price: sanitizePrice(t.price),
          tradeDate: effective,
          tradeTime: effective,
        };
      });
    const sorted = sortByTradeTime(sanitized);

    // Queues for unmatched entries (with remaining quantities)
    const buyQueue: TradeWithRemaining[] = [];
    const sellQueue: TradeWithRemaining[] = [];

    for (const trade of sorted) {
      const tradeWithRemaining: TradeWithRemaining = {
        ...trade,
        remainingQty: trade.quantity,
      };

      // A BUY is the entry leg of a LONG position; everything else (SELL) opens
      // a SHORT. `isEntryTrade(_, "LONG")` is exactly "is this a BUY?".
      if (isEntryTrade(trade.tradeType, "LONG")) {
        // MONEY-840: apply corporate-action cost-basis adjustment to the BUY lot
        // BEFORE it can match a (post-action) SELL or land in the open book. A
        // 1:5 split scales 10 @ ₹1000 → 50 @ ₹200: quantity ×ratio, price
        // ÷ratio, total cost preserved. Only qty-changing actions strictly after
        // the lot's trade date (and already ex) apply; each is absorbed once via
        // `appliedActionIds`. No corporate actions ⇒ factor 1 (no-op).
        if (corporateActions.length > 0) {
          const adjustment = computeCostBasisAdjustment(
            {
              isin: tradeWithRemaining.isin,
              symbol: tradeWithRemaining.symbol,
              exchange: tradeWithRemaining.exchange,
              tradeDate: tradeWithRemaining.tradeDate,
            },
            corporateActions,
            now,
          );
          if (adjustment.factor !== 1) {
            tradeWithRemaining.quantity *= adjustment.factor;
            tradeWithRemaining.price /= adjustment.factor;
            tradeWithRemaining.remainingQty = tradeWithRemaining.quantity;
          }
        }

        // Try to match with pending sells (for short positions)
        let remaining = tradeWithRemaining.remainingQty;

        while (!isEffectivelyZero(remaining) && sellQueue.length > 0) {
          const sell = sellQueue[0]!; // Non-null assertion - we checked length > 0
          const matchQty = Math.min(remaining, sell.remainingQty);

          // Create closed paired view (SHORT position closed by BUY).
          // Use the BUY lot via `tradeWithRemaining` so any corporate-action
          // cost-basis adjustment applied above flows into the exit price.
          const pnl = calculatePnL(
            sell.price,
            tradeWithRemaining.price,
            matchQty,
            "SHORT",
          );
          const pnlPercentage = calculatePnLPercentage(
            sell.price,
            tradeWithRemaining.price,
            "SHORT",
          );

          pairedViews.push({
            userId: trade.userId,
            sourceTradeIds: [sell.id, trade.id],
            entryTradeId: sell.id,
            exitTradeId: trade.id,
            symbol: trade.symbol,
            isin: trade.isin || sell.isin, // Use ISIN from either trade
            exchange: trade.exchange,
            segment: trade.segment,
            broker: trade.broker,
            brokerUserId: trade.brokerUserId,
            entryDate: sell.tradeTime || sell.tradeDate,
            entryPrice: sell.price,
            entryQuantity: sell.quantity,
            exitDate: trade.tradeTime || trade.tradeDate,
            exitPrice: tradeWithRemaining.price,
            quantity: matchQty,
            realizedPnL: pnl,
            pnlPercentage: pnlPercentage,
            status: "CLOSED",
            positionType: "SHORT",
            productType: trade.productType,
            sourceType: trade.sourceType,
            tradeType: "SELL",
            segmentLabel: trade.segmentLabel || null,
            productTypeLabel: trade.productTypeLabel || null,
          });

          totalRealizedPnL += pnl;
          closedPositions++;

          // Update remaining quantities
          remaining -= matchQty;
          sell.remainingQty -= matchQty;

          // Remove fully matched sell from queue (use epsilon for float comparison)
          if (isEffectivelyZero(sell.remainingQty)) {
            sellQueue.shift();
          }
        }

        // If there's remaining quantity, add to buy queue (use epsilon for float comparison)
        if (!isEffectivelyZero(remaining)) {
          tradeWithRemaining.remainingQty = remaining;
          buyQueue.push(tradeWithRemaining);
        }
      } else {
        // SELL trade - try to match with pending buys (for long positions)
        let remaining = tradeWithRemaining.remainingQty;

        while (!isEffectivelyZero(remaining) && buyQueue.length > 0) {
          const buy = buyQueue[0]!; // Non-null assertion - we checked length > 0
          const matchQty = Math.min(remaining, buy.remainingQty);

          // Create closed paired view (LONG position closed by SELL)
          const pnl = calculatePnL(buy.price, trade.price, matchQty, "LONG");
          const pnlPercentage = calculatePnLPercentage(
            buy.price,
            trade.price,
            "LONG",
          );

          pairedViews.push({
            userId: trade.userId,
            sourceTradeIds: [buy.id, trade.id],
            entryTradeId: buy.id,
            exitTradeId: trade.id,
            symbol: trade.symbol,
            isin: trade.isin || buy.isin, // Use ISIN from either trade
            exchange: trade.exchange,
            segment: trade.segment,
            broker: trade.broker,
            brokerUserId: trade.brokerUserId,
            entryDate: buy.tradeTime || buy.tradeDate,
            entryPrice: buy.price,
            entryQuantity: buy.quantity,
            exitDate: trade.tradeTime || trade.tradeDate,
            exitPrice: trade.price,
            quantity: matchQty,
            realizedPnL: pnl,
            pnlPercentage: pnlPercentage,
            status: "CLOSED",
            positionType: "LONG",
            productType: trade.productType,
            sourceType: trade.sourceType,
            tradeType: "BUY",
            segmentLabel: trade.segmentLabel || null,
            productTypeLabel: trade.productTypeLabel || null,
          });

          totalRealizedPnL += pnl;
          closedPositions++;

          // Update remaining quantities
          remaining -= matchQty;
          buy.remainingQty -= matchQty;

          // Remove fully matched buy from queue (use epsilon for float comparison)
          if (isEffectivelyZero(buy.remainingQty)) {
            buyQueue.shift();
          }
        }

        // If there's remaining quantity, add to sell queue (use epsilon for float comparison)
        if (!isEffectivelyZero(remaining)) {
          tradeWithRemaining.remainingQty = remaining;
          sellQueue.push(tradeWithRemaining);
        }
      }
    }

    // Create OPEN rows for remaining unmatched entries
    // Skip entries with effectively zero remaining quantity (floating point precision)
    for (const buy of buyQueue) {
      // Skip if remaining quantity is effectively zero (fully matched with float rounding)
      if (isEffectivelyZero(buy.remainingQty)) {
        continue;
      }

      pairedViews.push({
        userId: buy.userId,
        sourceTradeIds: [buy.id],
        entryTradeId: buy.id,
        exitTradeId: null,
        symbol: buy.symbol,
        isin: buy.isin,
        exchange: buy.exchange,
        segment: buy.segment,
        broker: buy.broker,
        brokerUserId: buy.brokerUserId,
        entryDate: buy.tradeTime || buy.tradeDate,
        entryPrice: buy.price,
        entryQuantity: buy.quantity,
        exitDate: null,
        exitPrice: null,
        quantity: buy.remainingQty,
        realizedPnL: null,
        pnlPercentage: null,
        status: buy.remainingQty < buy.quantity ? "PARTIAL" : "OPEN",
        positionType: getPositionType(buy.tradeType), // BUY entry → "LONG"
        productType: buy.productType,
        sourceType: buy.sourceType,
        tradeType: "BUY",
        segmentLabel: buy.segmentLabel || null,
        productTypeLabel: buy.productTypeLabel || null,
      });

      if (buy.remainingQty < buy.quantity) {
        partialPositions++;
      } else {
        openPositions++;
      }
    }

    for (const sell of sellQueue) {
      // Skip if remaining quantity is effectively zero (fully matched with float rounding)
      if (isEffectivelyZero(sell.remainingQty)) {
        continue;
      }

      pairedViews.push({
        userId: sell.userId,
        sourceTradeIds: [sell.id],
        entryTradeId: sell.id,
        exitTradeId: null,
        symbol: sell.symbol,
        isin: sell.isin,
        exchange: sell.exchange,
        segment: sell.segment,
        broker: sell.broker,
        brokerUserId: sell.brokerUserId,
        entryDate: sell.tradeTime || sell.tradeDate,
        entryPrice: sell.price,
        entryQuantity: sell.quantity,
        exitDate: null,
        exitPrice: null,
        quantity: sell.remainingQty,
        realizedPnL: null,
        pnlPercentage: null,
        status: sell.remainingQty < sell.quantity ? "PARTIAL" : "OPEN",
        positionType: getPositionType(sell.tradeType), // SELL entry → "SHORT"
        productType: sell.productType,
        sourceType: sell.sourceType,
        tradeType: "SELL",
        segmentLabel: sell.segmentLabel || null,
        productTypeLabel: sell.productTypeLabel || null,
      });

      if (sell.remainingQty < sell.quantity) {
        partialPositions++;
      } else {
        openPositions++;
      }
    }
  }

  // Sort paired views by entry date (newest first for display).
  // safeTime guards an Invalid entryDate so the comparator never returns NaN.
  pairedViews.sort((a, b) => safeTime(b.entryDate) - safeTime(a.entryDate));

  return {
    pairedViews,
    stats: {
      totalTrades: trades.length,
      openPositions,
      closedPositions,
      partialPositions,
      totalRealizedPnL,
    },
  };
}

/**
 * Convenience function to pair trades for a specific user
 * Can be used with date filtering for incremental pairing
 */
export function pairUserTrades(
  trades: TradeInput[],
  userId: string,
): PairingResult {
  const userTrades = trades.filter((t) => t.userId === userId);
  return pairTradesFIFO(userTrades);
}
