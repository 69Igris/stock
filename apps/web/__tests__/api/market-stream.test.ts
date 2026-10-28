/**
 * Market Stream (SSE) — REAL logic test.
 *
 * Exercises the ACTUAL exported symbols from
 * `@/app/api/market/stream/stream-logic` (the pure module the stream route
 * imports) — NOT inline copies:
 *   - parseSymbols (split / trim / empty + size validation)
 *   - parseExchange (NSE default)
 *   - checkConnectionLimit / incrementConnection / decrementConnection
 *     (per-user connection tracking over an explicit Map)
 *   - formatConnectMessage / formatErrorMessage (SSE frame payloads)
 *   - MAX_CONNECTIONS_PER_USER / POLL_INTERVAL (constants)
 *
 * (Replaces the previous shadow version, which reimplemented every helper +
 * constant inline and asserted the copies.)
 *
 * Source: apps/web/app/api/market/stream/stream-logic.ts
 *         (imported by apps/web/app/api/market/stream/route.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONNECTIONS_PER_USER,
  POLL_INTERVAL,
  parseSymbols,
  parseExchange,
  checkConnectionLimit,
  incrementConnection,
  decrementConnection,
  formatConnectMessage,
  formatErrorMessage,
} from "@/app/api/market/stream/stream-logic";

describe("Market Stream Logic", () => {
  describe("Symbol validation", () => {
    it("should parse single symbol", () => {
      const result = parseSymbols("RELIANCE");
      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.symbols, ["RELIANCE"]);
    });

    it("should parse comma-separated symbols", () => {
      const result = parseSymbols("RELIANCE,TCS,INFY");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.symbols.length, 3);
    });

    it("should trim whitespace from symbols", () => {
      const result = parseSymbols(" RELIANCE , TCS , INFY ");
      assert.deepStrictEqual(result.symbols, ["RELIANCE", "TCS", "INFY"]);
    });

    it("should filter empty entries from trailing comma", () => {
      const result = parseSymbols("RELIANCE,TCS,");
      assert.strictEqual(result.symbols.length, 2);
    });

    it("should reject null symbols param", () => {
      const result = parseSymbols(null);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "symbols parameter required");
    });

    it("should reject empty string", () => {
      const result = parseSymbols("");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "symbols parameter required");
    });

    it("should reject only commas/whitespace", () => {
      const result = parseSymbols(",,,");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "No valid symbols provided");
    });

    it("should reject more than 50 symbols", () => {
      const symbols = Array.from({ length: 51 }, (_, i) => `SYM${i}`).join(",");
      const result = parseSymbols(symbols);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "Maximum 50 symbols allowed");
    });

    it("should accept exactly 50 symbols", () => {
      const symbols = Array.from({ length: 50 }, (_, i) => `SYM${i}`).join(",");
      const result = parseSymbols(symbols);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.symbols.length, 50);
    });
  });

  describe("Exchange parameter", () => {
    it("should default to NSE when null", () => {
      assert.strictEqual(parseExchange(null), "NSE");
    });

    it("should default to NSE when empty", () => {
      assert.strictEqual(parseExchange(""), "NSE");
    });

    it("should accept NSE", () => {
      assert.strictEqual(parseExchange("NSE"), "NSE");
    });

    it("should accept BSE", () => {
      assert.strictEqual(parseExchange("BSE"), "BSE");
    });
  });

  describe("Connection limit enforcement", () => {
    it("should allow first connection", () => {
      const connections = new Map<string, number>();
      const result = checkConnectionLimit(connections, "user_1");
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.currentCount, 0);
    });

    it("should allow up to 4 existing connections", () => {
      const connections = new Map<string, number>([["user_1", 4]]);
      const result = checkConnectionLimit(connections, "user_1");
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.currentCount, 4);
    });

    it("should reject at 5 connections", () => {
      const connections = new Map<string, number>([["user_1", 5]]);
      const result = checkConnectionLimit(connections, "user_1");
      assert.strictEqual(result.allowed, false);
    });

    it("should reject at more than 5 connections", () => {
      const connections = new Map<string, number>([["user_1", 10]]);
      const result = checkConnectionLimit(connections, "user_1");
      assert.strictEqual(result.allowed, false);
    });

    it("should track connections independently per user", () => {
      const connections = new Map<string, number>([
        ["user_1", 5],
        ["user_2", 2],
      ]);
      assert.strictEqual(
        checkConnectionLimit(connections, "user_1").allowed,
        false
      );
      assert.strictEqual(
        checkConnectionLimit(connections, "user_2").allowed,
        true
      );
    });
  });

  describe("Connection tracking", () => {
    it("should increment connection count", () => {
      const connections = new Map<string, number>();
      incrementConnection(connections, "user_1");
      assert.strictEqual(connections.get("user_1"), 1);
    });

    it("should increment existing count", () => {
      const connections = new Map<string, number>([["user_1", 3]]);
      incrementConnection(connections, "user_1");
      assert.strictEqual(connections.get("user_1"), 4);
    });

    it("should decrement connection count", () => {
      const connections = new Map<string, number>([["user_1", 3]]);
      decrementConnection(connections, "user_1");
      assert.strictEqual(connections.get("user_1"), 2);
    });

    it("should remove user when count reaches 0", () => {
      const connections = new Map<string, number>([["user_1", 1]]);
      decrementConnection(connections, "user_1");
      assert.strictEqual(connections.has("user_1"), false);
    });

    it("should remove user when count is already 0", () => {
      const connections = new Map<string, number>();
      decrementConnection(connections, "user_1");
      assert.strictEqual(connections.has("user_1"), false);
    });
  });

  describe("SSE message formatting", () => {
    it("should format connect message with symbols and exchange", () => {
      const msg = formatConnectMessage(["RELIANCE", "TCS"], "NSE");
      const parsed = JSON.parse(msg);
      assert.strictEqual(parsed.type, "connected");
      assert.deepStrictEqual(parsed.symbols, ["RELIANCE", "TCS"]);
      assert.strictEqual(parsed.exchange, "NSE");
      assert.ok(parsed.timestamp);
    });

    it("should format error message", () => {
      const msg = formatErrorMessage("Failed to fetch quotes");
      const parsed = JSON.parse(msg);
      assert.strictEqual(parsed.type, "error");
      assert.strictEqual(parsed.message, "Failed to fetch quotes");
    });
  });

  describe("Constants", () => {
    it("should have max connections per user of 5", () => {
      assert.strictEqual(MAX_CONNECTIONS_PER_USER, 5);
    });

    it("should have poll interval of 5000ms", () => {
      assert.strictEqual(POLL_INTERVAL, 5000);
    });
  });
});
