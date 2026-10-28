/**
 * Trade Validation Schema Tests
 *
 * Tests for Zod validation schemas for trade operations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TradeFormSchema,
  ClosePositionSchema,
  TradeFilterSchema,
} from "@usemoney/validation/trade";

describe("Trade Validation Schemas", () => {
  describe("TradeFormSchema", () => {
    it("should validate a complete valid trade", () => {
      const validTrade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        broker: "manual",
        exchange: "NSE",
        segment: "EQUITY",
        positionType: "LONG",
        tradeType: "BUY",
        orderType: "MARKET",
        quantity: "100",
        price: "2500.50",
        productType: "CNC",
      };

      const result = TradeFormSchema.safeParse(validTrade);
      assert.ok(
        result.success,
        `Validation failed: ${JSON.stringify(result.error?.errors)}`
      );
      assert.strictEqual(result.data?.symbol, "RELIANCE");
      assert.strictEqual(result.data?.quantity, 100);
      assert.strictEqual(result.data?.price, 2500.5);
    });

    it("should transform symbol to uppercase", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "reliance",
        quantity: "100",
        price: "2500",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(result.success);
      assert.strictEqual(result.data?.symbol, "RELIANCE");
    });

    it("should apply default values", () => {
      const minimalTrade = {
        tradeDate: "2024-01-15",
        symbol: "TCS",
        quantity: "50",
        price: "3500",
      };

      const result = TradeFormSchema.safeParse(minimalTrade);
      assert.ok(result.success);
      assert.strictEqual(result.data?.broker, "manual");
      assert.strictEqual(result.data?.exchange, "NSE");
      assert.strictEqual(result.data?.segment, "EQUITY");
      assert.strictEqual(result.data?.positionType, "LONG");
      assert.strictEqual(result.data?.tradeType, "BUY");
      assert.strictEqual(result.data?.orderType, "MARKET");
      assert.strictEqual(result.data?.productType, "CNC");
    });

    it("should fail when symbol is empty", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "",
        quantity: "100",
        price: "2500",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
      assert.ok(result.error?.errors.some((e) => e.path.includes("symbol")));
    });

    it("should fail when trade date is missing", () => {
      const trade = {
        symbol: "RELIANCE",
        quantity: "100",
        price: "2500",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
    });

    it("should fail for negative quantity", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "-10",
        price: "2500",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
      assert.ok(result.error?.errors.some((e) => e.path.includes("quantity")));
    });

    it("should fail for zero quantity", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "0",
        price: "2500",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
    });

    it("should fail for negative price", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "-100",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
    });

    it("should fail for zero price", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "0",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
    });

    it("should validate all exchange types", () => {
      const exchanges = ["NSE", "BSE", "NFO", "MCX", "NCDEX", "CDS", "CRYPTO"];

      for (const exchange of exchanges) {
        const trade = {
          tradeDate: "2024-01-15",
          symbol: "TEST",
          quantity: "100",
          price: "100",
          exchange,
        };

        const result = TradeFormSchema.safeParse(trade);
        assert.ok(result.success, `Exchange ${exchange} should be valid`);
      }
    });

    it("should fail for invalid exchange", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "TEST",
        quantity: "100",
        price: "100",
        exchange: "INVALID",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
    });

    it("should validate all segment types", () => {
      const segments = [
        "EQUITY",
        "FUTURES",
        "OPTIONS",
        "COMMODITY",
        "CASH",
        "CRYPTO",
      ];

      for (const segment of segments) {
        const trade = {
          tradeDate: "2024-01-15",
          symbol: "TEST",
          quantity: "100",
          price: "100",
          segment,
        };

        const result = TradeFormSchema.safeParse(trade);
        assert.ok(result.success, `Segment ${segment} should be valid`);
      }
    });

    it("should validate all trade types", () => {
      const tradeTypes = ["BUY", "SELL"];

      for (const tradeType of tradeTypes) {
        const trade = {
          tradeDate: "2024-01-15",
          symbol: "TEST",
          quantity: "100",
          price: "100",
          tradeType,
        };

        const result = TradeFormSchema.safeParse(trade);
        assert.ok(result.success, `Trade type ${tradeType} should be valid`);
      }
    });

    it("should validate all order types", () => {
      const orderTypes = ["MARKET", "LIMIT", "SL", "SL-M"];

      for (const orderType of orderTypes) {
        const trade = {
          tradeDate: "2024-01-15",
          symbol: "TEST",
          quantity: "100",
          price: "100",
          orderType,
        };

        const result = TradeFormSchema.safeParse(trade);
        assert.ok(result.success, `Order type ${orderType} should be valid`);
      }
    });

    it("should validate all product types", () => {
      const productTypes = ["CNC", "MIS", "NRML"];

      for (const productType of productTypes) {
        const trade = {
          tradeDate: "2024-01-15",
          symbol: "TEST",
          quantity: "100",
          price: "100",
          productType,
        };

        const result = TradeFormSchema.safeParse(trade);
        assert.ok(
          result.success,
          `Product type ${productType} should be valid`
        );
      }
    });

    it("should handle optional exit price", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "2500",
        exitPrice: "2600",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(result.success);
      assert.strictEqual(result.data?.exitPrice, 2600);
    });

    it("should handle empty exit price as null", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "2500",
        exitPrice: "",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(result.success);
      assert.strictEqual(result.data?.exitPrice, null);
    });

    it("should handle brokerage with default", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "2500",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(result.success);
      assert.strictEqual(result.data?.brokerage, 20);
    });

    it("should parse comma-separated tags", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "2500",
        tags: "swing, momentum, breakout",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(result.success);
      assert.deepStrictEqual(result.data?.tags, [
        "swing",
        "momentum",
        "breakout",
      ]);
    });

    it("should handle empty tags", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "2500",
        tags: "",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(result.success);
      assert.deepStrictEqual(result.data?.tags, []);
    });

    it("should handle notes field", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "RELIANCE",
        quantity: "100",
        price: "2500",
        notes: "Bought on breakout above resistance",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(result.success);
      assert.strictEqual(
        result.data?.notes,
        "Bought on breakout above resistance"
      );
    });

    it("should truncate symbol at 50 characters", () => {
      const trade = {
        tradeDate: "2024-01-15",
        symbol: "A".repeat(60),
        quantity: "100",
        price: "2500",
      };

      const result = TradeFormSchema.safeParse(trade);
      assert.ok(!result.success);
    });
  });

  describe("ClosePositionSchema", () => {
    it("should validate valid close position input", () => {
      const input = {
        positionId: "pos123",
        exitPrice: 2600,
      };

      const result = ClosePositionSchema.safeParse(input);
      assert.ok(result.success);
      assert.strictEqual(result.data?.positionId, "pos123");
      assert.strictEqual(result.data?.exitPrice, 2600);
    });

    it("should fail for empty position ID", () => {
      const input = {
        positionId: "",
        exitPrice: 2600,
      };

      const result = ClosePositionSchema.safeParse(input);
      assert.ok(!result.success);
    });

    it("should fail for negative exit price", () => {
      const input = {
        positionId: "pos123",
        exitPrice: -100,
      };

      const result = ClosePositionSchema.safeParse(input);
      assert.ok(!result.success);
    });

    it("should fail for zero exit price", () => {
      const input = {
        positionId: "pos123",
        exitPrice: 0,
      };

      const result = ClosePositionSchema.safeParse(input);
      assert.ok(!result.success);
    });

    it("should handle decimal exit price", () => {
      const input = {
        positionId: "pos123",
        exitPrice: 2600.75,
      };

      const result = ClosePositionSchema.safeParse(input);
      assert.ok(result.success);
      assert.strictEqual(result.data?.exitPrice, 2600.75);
    });
  });

  describe("TradeFilterSchema", () => {
    it("should validate empty filter (all optional)", () => {
      const result = TradeFilterSchema.safeParse({});
      assert.ok(result.success);
      assert.strictEqual(result.data?.limit, 20); // default
      assert.strictEqual(result.data?.skip, 0); // default
    });

    it("should validate filter with symbol", () => {
      const filter = {
        symbol: "RELIANCE",
      };

      const result = TradeFilterSchema.safeParse(filter);
      assert.ok(result.success);
      assert.strictEqual(result.data?.symbol, "RELIANCE");
    });

    it("should validate filter with all fields", () => {
      const filter = {
        symbol: "RELIANCE",
        broker: "ZERODHA",
        segment: "EQUITY",
        tradeType: "BUY",
        fromDate: "2024-01-01",
        toDate: "2024-12-31",
        limit: 50,
        skip: 10,
      };

      const result = TradeFilterSchema.safeParse(filter);
      assert.ok(result.success);
      assert.strictEqual(result.data?.limit, 50);
      assert.strictEqual(result.data?.skip, 10);
    });

    it("should cap limit at 100", () => {
      const filter = {
        limit: 200,
      };

      const result = TradeFilterSchema.safeParse(filter);
      assert.ok(!result.success);
    });

    it("should reject negative skip", () => {
      const filter = {
        skip: -10,
      };

      const result = TradeFilterSchema.safeParse(filter);
      assert.ok(!result.success);
    });

    it("should reject limit less than 1", () => {
      const filter = {
        limit: 0,
      };

      const result = TradeFilterSchema.safeParse(filter);
      assert.ok(!result.success);
    });
  });
});
