/**
 * Trade Pairing Module
 *
 * Provides FIFO-based trade pairing for buy/sell matching with row splitting
 * for partial fills.
 */

export {
  pairTradesFIFO,
  pairUserTrades,
  // Pure helpers — exported so tests assert the REAL source (no shadow copies).
  // pairTradesFIFO calls each of these, so the production path and the unit
  // tests execute the same code.
  QUANTITY_EPSILON,
  isEffectivelyZero,
  isFiniteQuantity,
  sanitizePrice,
  safeTime,
  resolveTradeDate,
  getGroupKey,
  sortByTradeTime,
  calculatePnL,
  calculatePnLPercentage,
  getPositionType,
  isEntryTrade,
  type TradeInput,
  type PairedTradeOutput,
  type PairingResult,
  type PairingStats,
  type CorporateActionInput,
} from "./algorithm";

// Corporate-action cost-basis transform (MONEY-840). Exported so the worker can
// reuse the matcher and tests assert the REAL source (no shadow copies).
export {
  corpActionAppliesToLot,
  computeCostBasisAdjustment,
  type CostBasisLot,
  type CostBasisAdjustment,
} from "./corp-actions";
