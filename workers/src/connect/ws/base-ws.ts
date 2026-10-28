/**
 * Base WebSocket Client
 *
 * Abstract base class for broker WebSocket connections.
 * Provides common functionality for connection management,
 * subscription handling, and reconnection logic.
 */

import type { WebSocket } from "ws";

// ============== TYPES ==============

export interface Tick {
  symbol: string;
  instrumentToken?: number;
  lastPrice: number;
  lastQuantity?: number;
  averagePrice?: number;
  volume: number;
  buyQuantity?: number;
  sellQuantity?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePercent: number;
  lastTradeTime?: Date;
  timestamp: Date;
  depth?: MarketDepth;
}

export interface MarketDepth {
  buy: DepthLevel[];
  sell: DepthLevel[];
}

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface WebSocketConfig {
  /** WebSocket URL */
  url: string;
  /** Reconnect on disconnect */
  autoReconnect?: boolean;
  /** Max reconnection attempts */
  maxReconnectAttempts?: number;
  /** Reconnection delay in ms */
  reconnectDelay?: number;
  /** Heartbeat interval in ms */
  heartbeatInterval?: number;
}

export type TickCallback = (ticks: Tick[]) => void;
export type ConnectionCallback = (state: ConnectionState) => void;
export type ErrorCallback = (error: Error) => void;

// ============== BASE WEBSOCKET CLASS ==============

export abstract class BaseBrokerWebSocket<
  TCredentials = Record<string, string>,
> {
  protected ws: WebSocket | null = null;
  protected config: Required<WebSocketConfig>;
  protected state: ConnectionState = "disconnected";
  protected reconnectAttempts = 0;
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  protected reconnectTimer: NodeJS.Timeout | null = null;

  protected tickCallbacks: Set<TickCallback> = new Set();
  protected connectionCallbacks: Set<ConnectionCallback> = new Set();
  protected errorCallbacks: Set<ErrorCallback> = new Set();

  protected subscriptions: Set<string> = new Set();

  constructor(config: WebSocketConfig) {
    this.config = {
      url: config.url,
      autoReconnect: config.autoReconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
      reconnectDelay: config.reconnectDelay ?? 3000,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
    };
  }

  // ============== PUBLIC METHODS ==============

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === "connected";
  }

  /**
   * Connect to WebSocket
   */
  abstract connect(credentials: TCredentials): Promise<void>;

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.cleanup();
    this.setState("disconnected");
  }

  /**
   * Subscribe to symbols
   */
  abstract subscribe(symbols: string[]): void;

  /**
   * Unsubscribe from symbols
   */
  abstract unsubscribe(symbols: string[]): void;

  /**
   * Register tick callback
   */
  onTick(callback: TickCallback): () => void {
    this.tickCallbacks.add(callback);
    return () => this.tickCallbacks.delete(callback);
  }

  /**
   * Register connection state callback
   */
  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback);
    return () => this.connectionCallbacks.delete(callback);
  }

  /**
   * Register error callback
   */
  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  /**
   * Get subscribed symbols
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  // ============== PROTECTED METHODS ==============

  protected setState(state: ConnectionState): void {
    this.state = state;
    this.connectionCallbacks.forEach((cb) => cb(state));
  }

  protected emitTicks(ticks: Tick[]): void {
    this.tickCallbacks.forEach((cb) => cb(ticks));
  }

  protected emitError(error: Error): void {
    this.errorCallbacks.forEach((cb) => cb(error));
  }

  protected startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }

  protected stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  protected abstract sendHeartbeat(): void;

  protected scheduleReconnect(): void {
    if (!this.config.autoReconnect) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.setState("error");
      this.emitError(new Error("Max reconnection attempts reached"));
      return;
    }

    this.setState("reconnecting");
    this.reconnectAttempts++;

    const delay =
      this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    this.reconnectTimer = setTimeout(
      () => {
        this.reconnect();
      },
      Math.min(delay, 30000),
    ); // Max 30s delay
  }

  protected abstract reconnect(): void;

  protected cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }

  protected handleOpen(): void {
    this.setState("connected");
    this.reconnectAttempts = 0;
    this.startHeartbeat();

    // Re-subscribe to existing subscriptions
    if (this.subscriptions.size > 0) {
      this.subscribe(Array.from(this.subscriptions));
    }
  }

  protected handleClose(): void {
    this.stopHeartbeat();
    if (this.state !== "disconnected") {
      this.scheduleReconnect();
    }
  }

  protected handleError(error: unknown): void {
    console.error("WebSocket error:", error);
    this.emitError(new Error("WebSocket connection error"));
  }

  protected abstract handleMessage(data: unknown): void;
}

export default BaseBrokerWebSocket;
