/**
 * Broker Adapter Factory
 * Create broker adapters by type
 */

import type { BrokerType } from "@usemoney/types";
import { BaseBrokerAdapter } from "./base-adapter";
import {
  ZerodhaAdapter,
  UpstoxAdapter,
  DhanAdapter,
  FyersAdapter,
  AngelOneAdapter,
  GrowwAdapter,
  ICICIAdapter,
  HDFCAdapter,
  InteractiveBrokersAdapter,
} from "./adapters";

// Cache adapters to avoid creating multiple instances
const adapterCache = new Map<BrokerType, BaseBrokerAdapter>();

/**
 * Get a broker adapter instance by broker type
 * Adapters are cached for reuse
 */
export function getBrokerAdapter(broker: BrokerType): BaseBrokerAdapter {
  if (adapterCache.has(broker)) {
    return adapterCache.get(broker)!;
  }

  let adapter: BaseBrokerAdapter;

  switch (broker) {
    case "ZERODHA":
      adapter = new ZerodhaAdapter();
      break;
    case "UPSTOX":
      adapter = new UpstoxAdapter();
      break;
    case "DHAN":
      adapter = new DhanAdapter();
      break;
    case "FYERS":
      adapter = new FyersAdapter();
      break;
    case "ANGEL_ONE":
      adapter = new AngelOneAdapter();
      break;
    case "GROWW":
      adapter = new GrowwAdapter();
      break;
    case "ICICI":
      adapter = new ICICIAdapter();
      break;
    case "HDFC":
      adapter = new HDFCAdapter();
      break;
    case "INTERACTIVE_BROKERS":
      adapter = new InteractiveBrokersAdapter();
      break;
    default:
      throw new Error(`Unknown broker type: ${broker}`);
  }

  adapterCache.set(broker, adapter);
  return adapter;
}

/**
 * Get all available broker adapters
 */
export function getAllBrokerAdapters(): Map<BrokerType, BaseBrokerAdapter> {
  const brokers: BrokerType[] = [
    "ZERODHA",
    "UPSTOX",
    "DHAN",
    "FYERS",
    "ANGEL_ONE",
    "GROWW",
    "ICICI",
    "HDFC",
    "INTERACTIVE_BROKERS",
  ];

  for (const broker of brokers) {
    getBrokerAdapter(broker);
  }

  return adapterCache;
}

/**
 * Clear adapter cache (useful for testing)
 */
export function clearAdapterCache(): void {
  adapterCache.clear();
}
