/**
 * Broker Adapters
 * Export all broker-specific adapter implementations
 */

export { ZerodhaAdapter } from "./zerodha";
export { UpstoxAdapter } from "./upstox";
export {
  DhanAdapter,
  normalizeDhanHolding,
  normalizeDhanPosition,
  normalizeDhanOrder,
  normalizeDhanTrade,
} from "./dhan";
export { FyersAdapter } from "./fyers";
export {
  AngelOneAdapter,
  normalizeAngelOneHolding,
  normalizeAngelOnePosition,
  normalizeAngelOneOrder,
  normalizeAngelOneTrade,
} from "./angel-one";
export {
  GrowwAdapter,
  // Row normalisers, exported so the field mapping is testable without HTTP —
  // mirrors `normalizeDhanHolding` in the sibling adapter.
  normalizeGrowwHolding,
  normalizeGrowwPosition,
  normalizeGrowwOrder,
} from "./groww";
export { ICICIAdapter } from "./icici";
export { HDFCAdapter } from "./hdfc";
export {
  InteractiveBrokersAdapter,
  mapIBKRExchange,
  mapIBKROrderStatus,
  mapIBKRSegment,
  mapIBKRHolding,
  mapIBKRPosition,
  mapIBKROrder,
  mapIBKRTrade,
} from "./interactive-brokers";
