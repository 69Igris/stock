/**
 * Market Data Manager
 *
 * Unified interface for market data from multiple sources.
 * Primary: Yahoo Finance (free, all users)
 * Upgrade: Broker WebSocket when connected
 *
 * Enhanced with LatestQuote DB cache layer:
 * - fetchQuote/fetchQuotes check LatestQuote table first (60s TTL)
 * - Falls back to direct Yahoo Finance API when DB cache is stale
 * - fetchQuoteByInstrumentId uses the DB-backed quote service
 */

import {
  getQuote,
  getQuotes,
  getQuoteByInstrumentId,
  getQuotesByInstrumentIds,
  QuoteData,
} from "./yahoo-client";
import { toYahooSymbol, Exchange } from "./symbol-mapper";
import { prisma } from "@usemoney/database";

// ============== TYPES ==============

export type DataSource =
  | "yahoo"
  | "zerodha"
  | "upstox"
  | "angel"
  | "disconnected";

export interface MarketDataSubscription {
  id: string;
  symbols: string[];
  exchange: Exchange;
  callback: (data: Map<string, QuoteData>) => void;
  interval: number;
}

export interface DataManagerConfig {
  /** Default polling interval in ms */
  defaultInterval?: number;
  /** Maximum symbols per subscription */
  maxSymbols?: number;
  /** Enable broker WebSocket when available */
  enableBrokerWS?: boolean;
}

// ============== MARKET DATA MANAGER ==============

export class MarketDataManager {
  private subscriptions: Map<string, MarketDataSubscription> = new Map();
  private intervalIds: Map<string, NodeJS.Timeout> = new Map();
  private config: Required<DataManagerConfig>;
  private currentSource: DataSource = "yahoo";

  constructor(config: DataManagerConfig = {}) {
    this.config = {
      defaultInterval: config.defaultInterval || 5000,
      maxSymbols: config.maxSymbols || 50,
      enableBrokerWS: config.enableBrokerWS ?? true,
    };
  }

  // ============== PUBLIC METHODS ==============

  /**
   * Get current data source
   */
  getDataSource(): DataSource {
    return this.currentSource;
  }

  /**
   * Set data source (called when broker connects/disconnects)
   */
  setDataSource(source: DataSource): void {
    this.currentSource = source;
    // Re-subscribe all active subscriptions with new source
    this.subscriptions.forEach((sub) => {
      this.unsubscribe(sub.id);
      this.subscribe(sub.symbols, sub.callback, {
        exchange: sub.exchange,
        interval: sub.interval,
      });
    });
  }

  /**
   * Subscribe to real-time quotes for symbols
   */
  subscribe(
    symbols: string[],
    callback: (data: Map<string, QuoteData>) => void,
    options: {
      exchange?: Exchange;
      interval?: number;
    } = {}
  ): string {
    const { exchange = "NSE", interval = this.config.defaultInterval } =
      options;

    // Limit symbols
    const limitedSymbols = symbols.slice(0, this.config.maxSymbols);

    // Generate subscription ID
    const id = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const subscription: MarketDataSubscription = {
      id,
      symbols: limitedSymbols,
      exchange,
      callback,
      interval,
    };

    this.subscriptions.set(id, subscription);

    // Start polling
    this.startPolling(subscription);

    return id;
  }

  /**
   * Unsubscribe from quotes
   */
  unsubscribe(subscriptionId: string): void {
    const intervalId = this.intervalIds.get(subscriptionId);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervalIds.delete(subscriptionId);
    }
    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Unsubscribe all
   */
  unsubscribeAll(): void {
    this.intervalIds.forEach((intervalId) => clearInterval(intervalId));
    this.intervalIds.clear();
    this.subscriptions.clear();
  }

  /**
   * Get single quote (one-time fetch)
   */
  async fetchQuote(
    symbol: string,
    exchange: Exchange = "NSE"
  ): Promise<QuoteData | null> {
    // Try DB-backed lookup first (resolves instrument and checks LatestQuote cache)
    try {
      const instrument = await prisma.instrumentMapping.findUnique({
        where: {
          symbol_exchange: {
            symbol: symbol.toUpperCase(),
            exchange,
          },
        },
        select: { id: true },
      });

      if (instrument) {
        return getQuoteByInstrumentId(instrument.id);
      }
    } catch {
      // DB unavailable - fall through to direct Yahoo fetch
    }

    // Fallback: direct Yahoo fetch
    const yahooSymbol = toYahooSymbol(symbol, exchange);
    return getQuote(yahooSymbol);
  }

  /**
   * Get multiple quotes (one-time fetch)
   */
  async fetchQuotes(
    symbols: string[],
    exchange: Exchange = "NSE"
  ): Promise<Map<string, QuoteData>> {
    // Try DB-backed batch lookup first
    try {
      const instruments = await prisma.instrumentMapping.findMany({
        where: {
          symbol: { in: symbols.map((s) => s.toUpperCase()) },
          exchange,
        },
        select: { id: true, symbol: true },
      });

      if (instruments.length > 0) {
        const instrumentIds = instruments.map((i) => i.id);
        const dbQuotes = await getQuotesByInstrumentIds(instrumentIds);

        // Convert from instrumentId-keyed to symbol-keyed map
        const symbolById = new Map(instruments.map((i) => [i.id, i.symbol]));
        const result = new Map<string, QuoteData>();

        dbQuotes.forEach((quote, instId) => {
          const sym = symbolById.get(instId);
          if (sym) {
            result.set(sym, quote);
          }
        });

        // If we got results for all symbols, return
        if (result.size === symbols.length) {
          return result;
        }

        // Fetch missing symbols from Yahoo directly
        const missingSymbols = symbols.filter(
          (s) => !result.has(s.toUpperCase())
        );
        if (missingSymbols.length > 0) {
          const yahooSymbols = missingSymbols.map((s) =>
            toYahooSymbol(s, exchange)
          );
          const yahooQuotes = await getQuotes(yahooSymbols);
          yahooQuotes.forEach((quote, sym) => {
            result.set(sym, quote);
          });
        }

        return result;
      }
    } catch {
      // DB unavailable - fall through to direct Yahoo fetch
    }

    // Fallback: direct Yahoo fetch
    const yahooSymbols = symbols.map((s) => toYahooSymbol(s, exchange));
    return getQuotes(yahooSymbols);
  }

  /**
   * Get single quote by instrument DB ID.
   * Uses the LatestQuote DB cache with automatic refresh.
   */
  async fetchQuoteByInstrumentId(
    instrumentId: string
  ): Promise<QuoteData | null> {
    return getQuoteByInstrumentId(instrumentId);
  }

  /**
   * Get multiple quotes by instrument DB IDs.
   * Uses the LatestQuote DB cache with automatic refresh.
   */
  async fetchQuotesByInstrumentIds(
    instrumentIds: string[]
  ): Promise<Map<string, QuoteData>> {
    return getQuotesByInstrumentIds(instrumentIds);
  }

  /**
   * Get subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get active symbols across all subscriptions
   */
  getActiveSymbols(): string[] {
    const symbols = new Set<string>();
    this.subscriptions.forEach((sub) => {
      sub.symbols.forEach((s) => symbols.add(s));
    });
    return Array.from(symbols);
  }

  // ============== PRIVATE METHODS ==============

  private async startPolling(
    subscription: MarketDataSubscription
  ): Promise<void> {
    const { id, symbols, exchange, callback, interval } = subscription;

    // Fetch immediately
    await this.pollQuotes(symbols, exchange, callback);

    // Set up interval
    const intervalId = setInterval(async () => {
      await this.pollQuotes(symbols, exchange, callback);
    }, interval);

    this.intervalIds.set(id, intervalId);
  }

  private async pollQuotes(
    symbols: string[],
    exchange: Exchange,
    callback: (data: Map<string, QuoteData>) => void
  ): Promise<void> {
    try {
      const quotes = await this.fetchQuotes(symbols, exchange);
      callback(quotes);
    } catch (error) {
      console.error("Error polling quotes:", error);
      // Return empty map on error
      callback(new Map());
    }
  }
}

// ============== SINGLETON INSTANCE ==============

let dataManagerInstance: MarketDataManager | null = null;

export function getDataManager(config?: DataManagerConfig): MarketDataManager {
  if (!dataManagerInstance) {
    dataManagerInstance = new MarketDataManager(config);
  }
  return dataManagerInstance;
}

export function resetDataManager(): void {
  if (dataManagerInstance) {
    dataManagerInstance.unsubscribeAll();
    dataManagerInstance = null;
  }
}

export default MarketDataManager;
