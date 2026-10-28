/**
 * MONEY-837: broker normalized types are canonical in @usemoney/types (this web
 * copy was a byte-identical duplicate). Re-export shim for back-compat — every
 * `@/lib/brokers/types` import keeps resolving to the same shapes.
 */
export type {
  MTFData,
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMutualFund,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types/broker";
