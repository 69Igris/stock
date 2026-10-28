/**
 * Brokers Module
 * Central export for all broker-related functionality
 */

// Base adapter
export { BaseBrokerAdapter } from "./base-adapter";

// Individual adapters
export {
  ZerodhaAdapter,
  UpstoxAdapter,
  DhanAdapter,
  FyersAdapter,
  AngelOneAdapter,
  GrowwAdapter,
  normalizeGrowwHolding,
  normalizeGrowwPosition,
  normalizeGrowwOrder,
  ICICIAdapter,
  HDFCAdapter,
  InteractiveBrokersAdapter,
  // Pure normalization helpers — each adapter's fetch/map methods delegate to
  // these; exported so they can be unit-tested without live API calls.
  mapIBKRExchange,
  mapIBKROrderStatus,
  mapIBKRSegment,
  mapIBKRHolding,
  mapIBKRPosition,
  mapIBKROrder,
  mapIBKRTrade,
  normalizeAngelOneHolding,
  normalizeAngelOnePosition,
  normalizeAngelOneOrder,
  normalizeAngelOneTrade,
  normalizeDhanHolding,
  normalizeDhanPosition,
  normalizeDhanOrder,
  normalizeDhanTrade,
} from "./adapters";

// Factory
export {
  getBrokerAdapter,
  getAllBrokerAdapters,
  clearAdapterCache,
} from "./factory";

// MONEY-837: rich broker CLIENT layer (relocated from apps/web). The single
// canonical fetch implementation that returns the FULL Normalized* shapes
// (sector / name / instrumentToken / MTF / position labels / MF metadata) —
// the prod worker, the web server action, and apps/api all consume these.
// `BrokerCredentials` is intentionally NOT re-exported here: the client layer's
// own (accessToken-required) shape lives at ./clients/base-client and would
// clash with the @usemoney/types one re-exported below. Import it from
// "@usemoney/core/brokers/clients/base-client" when the client shape is needed.
export {
  createBrokerClient,
  ZerodhaClient,
  UpstoxClient,
  DhanClient,
  FyersClient,
  AngelOneClient,
  GrowwClient,
  IciciClient,
  HdfcClient,
  InteractiveBrokersClient,
} from "./clients";
export {
  BaseBrokerClient,
  BROKER_HTTP_TIMEOUT_MS,
  BROKER_MAX_RETRIES,
  isRetryableStatus,
  backoffMs,
} from "./clients/base-client";

// Config
export {
  BROKER_CONFIGS,
  getBrokerConfig,
  getBrokerEnvKeys,
  getAllBrokerTypes,
  getTier1Brokers,
  getTier2Brokers,
} from "./config";

// Mock data (for testing/demo)
export {
  generateMockHoldings,
  generateMockPositions,
  generateMockOrders,
  generateMockTrades,
  generateMockMutualFunds,
  shouldUseMockData,
  MOCK_STOCK_SYMBOLS,
} from "./mock-data";

// Re-export types from @usemoney/types for convenience
export type {
  BrokerType,
  RefreshStrategy,
  ConnectionStatus,
  BrokerCredentials,
  AuthResult,
  BrokerInfo,
  BrokerConfig,
  HoldingData,
  PositionData,
  OrderData,
  TradeData,
  MutualFundData,
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMutualFund,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types";
