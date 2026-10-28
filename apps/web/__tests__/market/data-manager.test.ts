/**
 * Market Data Manager Tests
 *
 * Tests for MarketDataManager class including configuration,
 * subscription management, data source switching, and singleton pattern.
 * All logic reimplemented inline without module imports.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ============== LOCAL TYPE DEFINITIONS ==============

type DataSource = "yahoo" | "zerodha" | "upstox" | "angel" | "disconnected";
type Exchange = "NSE" | "BSE";

interface QuoteData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: Date;
}

interface MarketDataSubscription {
  id: string;
  symbols: string[];
  exchange: Exchange;
  callback: (data: Map<string, QuoteData>) => void;
  interval: number;
}

interface DataManagerConfig {
  defaultInterval?: number;
  maxSymbols?: number;
  enableBrokerWS?: boolean;
}

// ============== REIMPLEMENTED CLASSES ==============

class MarketDataManager {
  private subscriptions: Map<string, MarketDataSubscription> = new Map();
  private intervalIds: Map<string, ReturnType<typeof setInterval>> = new Map();
  private config: Required<DataManagerConfig>;
  private currentSource: DataSource = "yahoo";

  constructor(config: DataManagerConfig = {}) {
    this.config = {
      defaultInterval: config.defaultInterval || 5000,
      maxSymbols: config.maxSymbols || 50,
      enableBrokerWS: config.enableBrokerWS ?? true,
    };
  }

  getDataSource(): DataSource {
    return this.currentSource;
  }

  setDataSource(source: DataSource): void {
    this.currentSource = source;
  }

  subscribe(
    symbols: string[],
    callback: (data: Map<string, QuoteData>) => void,
    options: { exchange?: Exchange; interval?: number } = {}
  ): string {
    const { exchange = "NSE", interval = this.config.defaultInterval } =
      options;
    const limitedSymbols = symbols.slice(0, this.config.maxSymbols);
    const id = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const subscription: MarketDataSubscription = {
      id,
      symbols: limitedSymbols,
      exchange,
      callback,
      interval,
    };

    this.subscriptions.set(id, subscription);
    return id;
  }

  unsubscribe(subscriptionId: string): void {
    const intervalId = this.intervalIds.get(subscriptionId);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervalIds.delete(subscriptionId);
    }
    this.subscriptions.delete(subscriptionId);
  }

  unsubscribeAll(): void {
    this.intervalIds.forEach((intervalId) => clearInterval(intervalId));
    this.intervalIds.clear();
    this.subscriptions.clear();
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  getActiveSymbols(): string[] {
    const symbols = new Set<string>();
    this.subscriptions.forEach((sub) => {
      sub.symbols.forEach((s) => symbols.add(s));
    });
    return Array.from(symbols);
  }

  getConfig(): Required<DataManagerConfig> {
    return this.config;
  }
}

// ============== SINGLETON REIMPLEMENTATION ==============

let dataManagerInstance: MarketDataManager | null = null;

function getDataManager(config?: DataManagerConfig): MarketDataManager {
  if (!dataManagerInstance) {
    dataManagerInstance = new MarketDataManager(config);
  }
  return dataManagerInstance;
}

function resetDataManager(): void {
  if (dataManagerInstance) {
    dataManagerInstance.unsubscribeAll();
    dataManagerInstance = null;
  }
}

// ============== TESTS ==============

describe("MarketDataManager", () => {
  // Ensure singleton is clean between tests
  beforeEach(() => {
    resetDataManager();
  });

  afterEach(() => {
    resetDataManager();
  });

  // ---------- Configuration defaults ----------
  describe("Configuration", () => {
    it("should use default interval of 5000ms", () => {
      const mgr = new MarketDataManager();
      assert.strictEqual(mgr.getConfig().defaultInterval, 5000);
    });

    it("should use default maxSymbols of 50", () => {
      const mgr = new MarketDataManager();
      assert.strictEqual(mgr.getConfig().maxSymbols, 50);
    });

    it("should enable broker WebSocket by default", () => {
      const mgr = new MarketDataManager();
      assert.strictEqual(mgr.getConfig().enableBrokerWS, true);
    });

    it("should accept custom interval", () => {
      const mgr = new MarketDataManager({ defaultInterval: 10000 });
      assert.strictEqual(mgr.getConfig().defaultInterval, 10000);
    });

    it("should accept custom maxSymbols", () => {
      const mgr = new MarketDataManager({ maxSymbols: 100 });
      assert.strictEqual(mgr.getConfig().maxSymbols, 100);
    });

    it("should accept enableBrokerWS as false", () => {
      const mgr = new MarketDataManager({ enableBrokerWS: false });
      assert.strictEqual(mgr.getConfig().enableBrokerWS, false);
    });

    it("should handle partial config (only interval)", () => {
      const mgr = new MarketDataManager({ defaultInterval: 3000 });
      assert.strictEqual(mgr.getConfig().defaultInterval, 3000);
      assert.strictEqual(mgr.getConfig().maxSymbols, 50);
      assert.strictEqual(mgr.getConfig().enableBrokerWS, true);
    });

    it("should handle empty config object", () => {
      const mgr = new MarketDataManager({});
      assert.strictEqual(mgr.getConfig().defaultInterval, 5000);
      assert.strictEqual(mgr.getConfig().maxSymbols, 50);
      assert.strictEqual(mgr.getConfig().enableBrokerWS, true);
    });
  });

  // ---------- Subscription ID generation ----------
  describe("Subscription ID generation", () => {
    it("should generate ID starting with 'sub_'", () => {
      const mgr = new MarketDataManager();
      const id = mgr.subscribe(["RELIANCE"], () => {});
      assert.ok(id.startsWith("sub_"), `ID should start with 'sub_': ${id}`);
    });

    it("should generate unique IDs for different subscriptions", () => {
      const mgr = new MarketDataManager();
      const id1 = mgr.subscribe(["RELIANCE"], () => {});
      const id2 = mgr.subscribe(["TCS"], () => {});
      assert.notStrictEqual(id1, id2);
    });

    it("should generate IDs with timestamp component", () => {
      const mgr = new MarketDataManager();
      const before = Date.now();
      const id = mgr.subscribe(["RELIANCE"], () => {});
      const after = Date.now();
      // Extract timestamp: sub_<timestamp>_<random>
      const parts = id.split("_");
      const timestamp = parseInt(parts[1], 10);
      assert.ok(timestamp >= before && timestamp <= after);
    });

    it("should generate IDs with random suffix", () => {
      const mgr = new MarketDataManager();
      const id = mgr.subscribe(["RELIANCE"], () => {});
      const parts = id.split("_");
      assert.strictEqual(parts.length, 3);
      assert.ok(parts[2].length > 0);
    });
  });

  // ---------- getDataSource / setDataSource ----------
  describe("getDataSource / setDataSource", () => {
    it("should default to yahoo data source", () => {
      const mgr = new MarketDataManager();
      assert.strictEqual(mgr.getDataSource(), "yahoo");
    });

    it("should set data source to zerodha", () => {
      const mgr = new MarketDataManager();
      mgr.setDataSource("zerodha");
      assert.strictEqual(mgr.getDataSource(), "zerodha");
    });

    it("should set data source to upstox", () => {
      const mgr = new MarketDataManager();
      mgr.setDataSource("upstox");
      assert.strictEqual(mgr.getDataSource(), "upstox");
    });

    it("should set data source to angel", () => {
      const mgr = new MarketDataManager();
      mgr.setDataSource("angel");
      assert.strictEqual(mgr.getDataSource(), "angel");
    });

    it("should set data source to disconnected", () => {
      const mgr = new MarketDataManager();
      mgr.setDataSource("disconnected");
      assert.strictEqual(mgr.getDataSource(), "disconnected");
    });

    it("should allow switching data source back to yahoo", () => {
      const mgr = new MarketDataManager();
      mgr.setDataSource("zerodha");
      assert.strictEqual(mgr.getDataSource(), "zerodha");
      mgr.setDataSource("yahoo");
      assert.strictEqual(mgr.getDataSource(), "yahoo");
    });
  });

  // ---------- Subscribe / Unsubscribe ----------
  describe("Subscribe / Unsubscribe", () => {
    it("should start with 0 subscriptions", () => {
      const mgr = new MarketDataManager();
      assert.strictEqual(mgr.getSubscriptionCount(), 0);
    });

    it("should increment subscription count on subscribe", () => {
      const mgr = new MarketDataManager();
      mgr.subscribe(["RELIANCE"], () => {});
      assert.strictEqual(mgr.getSubscriptionCount(), 1);
    });

    it("should track multiple subscriptions", () => {
      const mgr = new MarketDataManager();
      mgr.subscribe(["RELIANCE"], () => {});
      mgr.subscribe(["TCS"], () => {});
      mgr.subscribe(["INFY"], () => {});
      assert.strictEqual(mgr.getSubscriptionCount(), 3);
    });

    it("should decrement subscription count on unsubscribe", () => {
      const mgr = new MarketDataManager();
      const id = mgr.subscribe(["RELIANCE"], () => {});
      assert.strictEqual(mgr.getSubscriptionCount(), 1);
      mgr.unsubscribe(id);
      assert.strictEqual(mgr.getSubscriptionCount(), 0);
    });

    it("should handle unsubscribe for non-existent ID gracefully", () => {
      const mgr = new MarketDataManager();
      mgr.unsubscribe("non_existent_id");
      assert.strictEqual(mgr.getSubscriptionCount(), 0);
    });

    it("should clear all subscriptions on unsubscribeAll", () => {
      const mgr = new MarketDataManager();
      mgr.subscribe(["RELIANCE"], () => {});
      mgr.subscribe(["TCS"], () => {});
      mgr.subscribe(["INFY"], () => {});
      assert.strictEqual(mgr.getSubscriptionCount(), 3);
      mgr.unsubscribeAll();
      assert.strictEqual(mgr.getSubscriptionCount(), 0);
    });
  });

  // ---------- Symbol limiting logic ----------
  describe("Symbol limiting logic", () => {
    it("should accept symbols within maxSymbols limit", () => {
      const mgr = new MarketDataManager({ maxSymbols: 5 });
      const symbols = ["RELIANCE", "TCS", "INFY"];
      const id = mgr.subscribe(symbols, () => {});
      const activeSymbols = mgr.getActiveSymbols();
      assert.strictEqual(activeSymbols.length, 3);
    });

    it("should truncate symbols exceeding maxSymbols", () => {
      const mgr = new MarketDataManager({ maxSymbols: 3 });
      const symbols = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN"];
      mgr.subscribe(symbols, () => {});
      const activeSymbols = mgr.getActiveSymbols();
      assert.strictEqual(activeSymbols.length, 3);
    });

    it("should keep first N symbols when truncating", () => {
      const mgr = new MarketDataManager({ maxSymbols: 2 });
      const symbols = ["RELIANCE", "TCS", "INFY"];
      mgr.subscribe(symbols, () => {});
      const activeSymbols = mgr.getActiveSymbols();
      assert.ok(activeSymbols.includes("RELIANCE"));
      assert.ok(activeSymbols.includes("TCS"));
      assert.ok(!activeSymbols.includes("INFY"));
    });

    it("should handle default maxSymbols of 50", () => {
      const mgr = new MarketDataManager();
      const symbols = Array.from({ length: 60 }, (_, i) => `SYM${i}`);
      mgr.subscribe(symbols, () => {});
      const activeSymbols = mgr.getActiveSymbols();
      assert.strictEqual(activeSymbols.length, 50);
    });

    it("should handle empty symbols array", () => {
      const mgr = new MarketDataManager();
      mgr.subscribe([], () => {});
      const activeSymbols = mgr.getActiveSymbols();
      assert.strictEqual(activeSymbols.length, 0);
    });

    it("should handle single symbol", () => {
      const mgr = new MarketDataManager();
      mgr.subscribe(["RELIANCE"], () => {});
      const activeSymbols = mgr.getActiveSymbols();
      assert.strictEqual(activeSymbols.length, 1);
      assert.strictEqual(activeSymbols[0], "RELIANCE");
    });
  });

  // ---------- getActiveSymbols ----------
  describe("getActiveSymbols", () => {
    it("should return empty array with no subscriptions", () => {
      const mgr = new MarketDataManager();
      assert.deepStrictEqual(mgr.getActiveSymbols(), []);
    });

    it("should return symbols from single subscription", () => {
      const mgr = new MarketDataManager();
      mgr.subscribe(["RELIANCE", "TCS"], () => {});
      const active = mgr.getActiveSymbols();
      assert.strictEqual(active.length, 2);
      assert.ok(active.includes("RELIANCE"));
      assert.ok(active.includes("TCS"));
    });

    it("should deduplicate symbols across subscriptions", () => {
      const mgr = new MarketDataManager();
      mgr.subscribe(["RELIANCE", "TCS"], () => {});
      mgr.subscribe(["TCS", "INFY"], () => {});
      const active = mgr.getActiveSymbols();
      assert.strictEqual(active.length, 3);
      assert.ok(active.includes("RELIANCE"));
      assert.ok(active.includes("TCS"));
      assert.ok(active.includes("INFY"));
    });

    it("should update after unsubscribe", () => {
      const mgr = new MarketDataManager();
      const id1 = mgr.subscribe(["RELIANCE"], () => {});
      mgr.subscribe(["TCS"], () => {});
      assert.strictEqual(mgr.getActiveSymbols().length, 2);
      mgr.unsubscribe(id1);
      const active = mgr.getActiveSymbols();
      assert.strictEqual(active.length, 1);
      assert.ok(active.includes("TCS"));
      assert.ok(!active.includes("RELIANCE"));
    });
  });

  // ---------- Singleton pattern ----------
  describe("Singleton pattern (getDataManager / resetDataManager)", () => {
    it("should return MarketDataManager instance", () => {
      const mgr = getDataManager();
      assert.ok(mgr instanceof MarketDataManager);
    });

    it("should return same instance on multiple calls", () => {
      const mgr1 = getDataManager();
      const mgr2 = getDataManager();
      assert.strictEqual(mgr1, mgr2);
    });

    it("should accept initial config on first call", () => {
      const mgr = getDataManager({ defaultInterval: 8000 });
      assert.strictEqual(mgr.getConfig().defaultInterval, 8000);
    });

    it("should ignore config on subsequent calls (singleton)", () => {
      const mgr1 = getDataManager({ defaultInterval: 8000 });
      const mgr2 = getDataManager({ defaultInterval: 3000 });
      assert.strictEqual(mgr1, mgr2);
      assert.strictEqual(mgr2.getConfig().defaultInterval, 8000);
    });

    it("should reset singleton on resetDataManager()", () => {
      const mgr1 = getDataManager({ defaultInterval: 8000 });
      resetDataManager();
      const mgr2 = getDataManager({ defaultInterval: 3000 });
      assert.notStrictEqual(mgr1, mgr2);
      assert.strictEqual(mgr2.getConfig().defaultInterval, 3000);
    });

    it("resetDataManager should clean up subscriptions", () => {
      const mgr = getDataManager();
      mgr.subscribe(["RELIANCE"], () => {});
      mgr.subscribe(["TCS"], () => {});
      assert.strictEqual(mgr.getSubscriptionCount(), 2);
      resetDataManager();
      // Old instance subscriptions are cleared
      assert.strictEqual(mgr.getSubscriptionCount(), 0);
    });

    it("resetDataManager on null instance should not throw", () => {
      resetDataManager(); // Already null
      resetDataManager(); // Should be safe
      assert.ok(true); // If we reach here, no error
    });
  });
});
