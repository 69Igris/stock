/**
 * Zerodha WebSocket Client
 *
 * Real-time market data streaming from Zerodha Kite.
 * WebSocket URL: wss://ws.kite.trade/
 *
 * Supports:
 * - LTP (Last Traded Price) mode
 * - Quote mode (OHLC + volume)
 * - Full mode (Quote + market depth)
 */

import {
  BaseBrokerWebSocket,
  Tick,
  MarketDepth,
  DepthLevel,
  WebSocketConfig,
} from "./base-ws";
import { WebSocket } from "ws";

// ============== TYPES ==============

export type ZerodhaMode = "ltp" | "quote" | "full";

interface ZerodhaCredentials {
  apiKey: string;
  accessToken: string;
}

interface ZerodhaTick {
  instrument_token: number;
  last_price: number;
  last_quantity?: number;
  average_price?: number;
  volume?: number;
  buy_quantity?: number;
  sell_quantity?: number;
  ohlc?: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  change?: number;
  last_trade_time?: number;
  timestamp?: number;
  depth?: {
    buy: Array<{ price: number; quantity: number; orders: number }>;
    sell: Array<{ price: number; quantity: number; orders: number }>;
  };
}

// Instrument token to symbol mapping
const tokenToSymbol = new Map<number, string>();
const symbolToToken = new Map<string, number>();

// ============== ZERODHA WEBSOCKET ==============

export class ZerodhaWebSocket extends BaseBrokerWebSocket<ZerodhaCredentials> {
  private credentials: ZerodhaCredentials | null = null;
  private mode: ZerodhaMode = "quote";
  private subscribedTokens: Set<number> = new Set();

  constructor(config?: Partial<WebSocketConfig>) {
    super({
      url: "wss://ws.kite.trade/",
      ...config,
    });
  }

  // ============== PUBLIC METHODS ==============

  /**
   * Set streaming mode
   */
  setMode(mode: ZerodhaMode): void {
    this.mode = mode;
    if (this.isConnected() && this.subscribedTokens.size > 0) {
      this.setModeForTokens(Array.from(this.subscribedTokens));
    }
  }

  /**
   * Map instrument token to symbol
   */
  setInstrumentMapping(token: number, symbol: string): void {
    tokenToSymbol.set(token, symbol);
    symbolToToken.set(symbol, token);
  }

  /**
   * Bulk set instrument mappings
   */
  setInstrumentMappings(
    mappings: Array<{ token: number; symbol: string }>,
  ): void {
    mappings.forEach(({ token, symbol }) => {
      tokenToSymbol.set(token, symbol);
      symbolToToken.set(symbol, token);
    });
  }

  /**
   * Connect to Zerodha WebSocket
   */
  async connect(credentials: ZerodhaCredentials): Promise<void> {
    this.credentials = credentials;

    return new Promise((resolve, reject) => {
      try {
        this.setState("connecting");

        const url = `${this.config.url}?api_key=${credentials.apiKey}&access_token=${credentials.accessToken}`;
        this.ws = new WebSocket(url);
        this.ws.binaryType = "arraybuffer";

        this.ws.onopen = () => {
          this.handleOpen();
          resolve();
        };

        this.ws.onclose = () => {
          this.handleClose();
        };

        this.ws.onerror = (error) => {
          this.handleError(error);
          reject(new Error("WebSocket connection failed"));
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        this.setState("error");
        reject(error);
      }
    });
  }

  /**
   * Subscribe to symbols (using instrument tokens)
   */
  subscribe(symbols: string[]): void {
    const tokens = symbols
      .map((s) => symbolToToken.get(s))
      .filter((t): t is number => t !== undefined);

    if (tokens.length === 0) {
      console.warn("No valid instrument tokens found for symbols:", symbols);
      return;
    }

    symbols.forEach((s) => this.subscriptions.add(s));
    tokens.forEach((t) => this.subscribedTokens.add(t));

    if (this.isConnected()) {
      this.sendSubscribe(tokens);
      this.setModeForTokens(tokens);
    }
  }

  /**
   * Subscribe directly with instrument tokens
   */
  subscribeTokens(tokens: number[]): void {
    tokens.forEach((t) => this.subscribedTokens.add(t));

    if (this.isConnected()) {
      this.sendSubscribe(tokens);
      this.setModeForTokens(tokens);
    }
  }

  /**
   * Unsubscribe from symbols
   */
  unsubscribe(symbols: string[]): void {
    const tokens = symbols
      .map((s) => symbolToToken.get(s))
      .filter((t): t is number => t !== undefined);

    symbols.forEach((s) => this.subscriptions.delete(s));
    tokens.forEach((t) => this.subscribedTokens.delete(t));

    if (this.isConnected() && tokens.length > 0) {
      this.sendUnsubscribe(tokens);
    }
  }

  /**
   * Unsubscribe directly with instrument tokens
   */
  unsubscribeTokens(tokens: number[]): void {
    tokens.forEach((t) => this.subscribedTokens.delete(t));

    if (this.isConnected()) {
      this.sendUnsubscribe(tokens);
    }
  }

  // ============== PROTECTED METHODS ==============

  protected sendHeartbeat(): void {
    // Zerodha doesn't require heartbeat, but we can send a ping
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Binary ping frame
      const ping = new Uint8Array([0x00]);
      this.ws.send(ping);
    }
  }

  protected reconnect(): void {
    if (this.credentials) {
      this.connect(this.credentials).catch((error) => {
        console.error("Reconnection failed:", error);
        this.scheduleReconnect();
      });
    }
  }

  protected handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const ticks = this.parseBinaryMessage(data);
      if (ticks.length > 0) {
        this.emitTicks(ticks);
      }
    } else if (typeof data === "string") {
      try {
        const json = JSON.parse(data);
        if (json.type === "error") {
          this.emitError(new Error(json.data || "Unknown error"));
        }
      } catch {
        // Not JSON, ignore
      }
    }
  }

  // ============== PRIVATE METHODS ==============

  private sendSubscribe(tokens: number[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const message = JSON.stringify({
      a: "subscribe",
      v: tokens,
    });
    this.ws.send(message);
  }

  private sendUnsubscribe(tokens: number[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const message = JSON.stringify({
      a: "unsubscribe",
      v: tokens,
    });
    this.ws.send(message);
  }

  private setModeForTokens(tokens: number[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const message = JSON.stringify({
      a: "mode",
      v: [this.mode, tokens],
    });
    this.ws.send(message);
  }

  private parseBinaryMessage(buffer: ArrayBuffer): Tick[] {
    const ticks: Tick[] = [];
    const dataView = new DataView(buffer);

    // Check if it's a heartbeat (1 byte)
    if (buffer.byteLength === 1) {
      return ticks;
    }

    // Parse based on packet size
    let offset = 0;
    while (offset < buffer.byteLength) {
      const packetSize = this.getPacketSize();

      if (offset + packetSize > buffer.byteLength) break;

      const tick = this.parsePacket(dataView, offset, packetSize);
      if (tick) {
        ticks.push(tick);
      }

      offset += packetSize;
    }

    return ticks;
  }

  private getPacketSize(): number {
    switch (this.mode) {
      case "ltp":
        return 8; // instrument_token (4) + last_price (4)
      case "quote":
        return 44; // LTP + OHLC + volume etc.
      case "full":
        return 184; // Quote + market depth
      default:
        return 44;
    }
  }

  private parsePacket(
    dataView: DataView,
    offset: number,
    size: number,
  ): Tick | null {
    try {
      const instrumentToken = dataView.getInt32(offset, false);
      const symbol =
        tokenToSymbol.get(instrumentToken) || `TOKEN_${instrumentToken}`;

      // Parse based on mode/size
      if (size === 8) {
        // LTP mode
        const lastPrice = dataView.getInt32(offset + 4, false) / 100;
        return {
          symbol,
          instrumentToken,
          lastPrice,
          volume: 0,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          change: 0,
          changePercent: 0,
          timestamp: new Date(),
        };
      }

      // Quote or Full mode
      const lastPrice = dataView.getInt32(offset + 4, false) / 100;
      const lastQuantity = dataView.getInt32(offset + 8, false);
      const averagePrice = dataView.getInt32(offset + 12, false) / 100;
      const volume = dataView.getInt32(offset + 16, false);
      const buyQuantity = dataView.getInt32(offset + 20, false);
      const sellQuantity = dataView.getInt32(offset + 24, false);
      const open = dataView.getInt32(offset + 28, false) / 100;
      const high = dataView.getInt32(offset + 32, false) / 100;
      const low = dataView.getInt32(offset + 36, false) / 100;
      const close = dataView.getInt32(offset + 40, false) / 100;

      const change = lastPrice - close;
      const changePercent = close > 0 ? (change / close) * 100 : 0;

      const tick: Tick = {
        symbol,
        instrumentToken,
        lastPrice,
        lastQuantity,
        averagePrice,
        volume,
        buyQuantity,
        sellQuantity,
        open,
        high,
        low,
        close,
        change,
        changePercent,
        timestamp: new Date(),
      };

      // Parse market depth for full mode
      if (size === 184) {
        tick.depth = this.parseMarketDepth(dataView, offset + 44);
      }

      return tick;
    } catch (error) {
      console.error("Error parsing packet:", error);
      return null;
    }
  }

  private parseMarketDepth(dataView: DataView, offset: number): MarketDepth {
    const buy: DepthLevel[] = [];
    const sell: DepthLevel[] = [];

    // 5 levels each, 12 bytes per level (quantity: 4, price: 4, orders: 4)
    for (let i = 0; i < 5; i++) {
      const buyOffset = offset + i * 12;
      buy.push({
        quantity: dataView.getInt32(buyOffset, false),
        price: dataView.getInt32(buyOffset + 4, false) / 100,
        orders: dataView.getInt32(buyOffset + 8, false),
      });

      const sellOffset = offset + 60 + i * 12;
      sell.push({
        quantity: dataView.getInt32(sellOffset, false),
        price: dataView.getInt32(sellOffset + 4, false) / 100,
        orders: dataView.getInt32(sellOffset + 8, false),
      });
    }

    return { buy, sell };
  }
}

export default ZerodhaWebSocket;
