/**
 * Base Broker Client
 * Abstract class for all broker API clients
 */

import { BrokerType, getBrokerConfig } from "../config";
import {
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMutualFund,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types";

export interface BrokerCredentials {
  accessToken: string;
  refreshToken?: string;
  apiKey?: string;
  apiSecret?: string;
  userId?: string;
  tokenExpiry?: Date;
}

/** MONEY-582d: per-request timeout so a hung broker socket can't block the
 *  server action indefinitely. */
export const BROKER_HTTP_TIMEOUT_MS = 15_000;
/** MONEY-582d: retries AFTER the first attempt (so up to 3 total tries). */
export const BROKER_MAX_RETRIES = 2;

/**
 * MONEY-582d: which HTTP statuses are worth retrying — rate-limit (429) and
 * transient server errors (5xx). 4xx (other than 429) are deterministic client
 * errors; retrying an expired-token 401 or a bad-request 400 just wastes time.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** MONEY-582d: exponential backoff — 500ms, 1000ms, ... for attempt 0, 1, ... */
export function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export abstract class BaseBrokerClient {
  protected broker: BrokerType;
  protected credentials: BrokerCredentials;
  protected baseUrl: string;

  constructor(broker: BrokerType, credentials: BrokerCredentials) {
    this.broker = broker;
    this.credentials = credentials;
    this.baseUrl = getBrokerConfig(broker).baseUrl;
  }

  // Abstract methods that each broker must implement
  abstract getProfile(): Promise<BrokerProfile>;
  abstract getHoldings(): Promise<NormalizedHolding[]>;
  abstract getPositions(): Promise<NormalizedPosition[]>;
  abstract getTrades(
    fromDate?: Date,
    toDate?: Date,
  ): Promise<NormalizedTrade[]>;
  abstract getOrders(): Promise<NormalizedOrder[]>;
  abstract getMargins(): Promise<NormalizedMargins>;

  // Optional methods (not all brokers support)
  async getMutualFunds(): Promise<NormalizedMutualFund[]> {
    return [];
  }

  /**
   * Historical (multi-day) tradebook. Most brokers have no such endpoint and
   * default to empty; Zerodha implements it via the async Console/backoffice API.
   */
  async getHistoricalTrades(
    _fromDate: Date,
    _toDate: Date,
    _segments?: string[],
  ): Promise<NormalizedTrade[]> {
    return [];
  }

  // Token refresh (if supported)
  async refreshToken(): Promise<BrokerCredentials | null> {
    return null;
  }

  // Check if token is valid
  isTokenValid(): boolean {
    if (!this.credentials.tokenExpiry) return true;
    return new Date() < this.credentials.tokenExpiry;
  }

  /**
   * Helper for making authenticated requests.
   *
   * MONEY-582d: each attempt is bounded by a timeout (AbortController), transient
   * failures (429/5xx + network/abort) are retried with bounded exponential
   * backoff, and the thrown error is SANITIZED — the raw upstream body (which can
   * carry token/account context) is drained-and-discarded, never surfaced or
   * logged. "API Error: <status>" is preserved so MONEY-499 classifyBrokerError
   * and the MONEY-582e getMutualFunds 403 check still key on it.
   */
  protected async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.getAuthHeaders(),
      ...((options.headers as Record<string, string>) || {}),
    };

    for (let attempt = 0; attempt <= BROKER_MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        BROKER_HTTP_TIMEOUT_MS,
      );

      let response: Response;
      try {
        response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        // Network failure or timeout-abort. Retry while attempts remain;
        // otherwise throw a SANITIZED error (never the raw cause text).
        clearTimeout(timer);
        if (attempt < BROKER_MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        const isAbort = err instanceof Error && err.name === "AbortError";
        throw new Error(
          `${this.broker} API Error: ${
            isAbort ? "request timed out" : "network error"
          }`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        // `Response.json()` is typed `Promise<unknown>` under Node's undici
        // typings (and `Promise<any>` only when the DOM lib is present). The
        // caller declares the wire shape via `T`, so assert it here rather than
        // silently laundering an `any` into every broker call site.
        return response.json() as Promise<T>;
      }

      // Drain the body so the connection can be reused, but NEVER surface or log
      // the raw upstream body (sanitization rule).
      await response.text().catch(() => "");

      if (isRetryableStatus(response.status) && attempt < BROKER_MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }

      throw new Error(
        `${this.broker} API Error: ${response.status} - ${response.statusText}`,
      );
    }

    // Unreachable (the loop returns, continues, or throws) — keeps the type
    // checker satisfied that the function always settles.
    throw new Error(`${this.broker} API Error: exhausted retries`);
  }

  // Get auth headers for requests
  protected abstract getAuthHeaders(): Record<string, string>;
}
