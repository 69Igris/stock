/**
 * Holding Validation Schema Tests
 *
 * Tests for Zod validation schemas for holding operations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HoldingFormSchema } from "@usemoney/validation/holding";

describe("Holding Validation Schemas", () => {
  describe("HoldingFormSchema", () => {
    it("should validate a complete valid holding", () => {
      const validHolding = {
        symbol: "RELIANCE",
        name: "Reliance Industries Ltd",
        sector: "Energy",
        exchange: "NSE",
        quantity: 100,
        averagePrice: 2500.5,
        currentPrice: 2600,
        brokerName: "ZERODHA",
      };

      const result = HoldingFormSchema.safeParse(validHolding);
      assert.ok(
        result.success,
        `Validation failed: ${JSON.stringify(result.error?.errors)}`
      );
      assert.strictEqual(result.data?.symbol, "RELIANCE");
    });

    it("should transform symbol to uppercase", () => {
      const holding = {
        symbol: "reliance",
        quantity: 100,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.symbol, "RELIANCE");
    });

    it("should apply default values", () => {
      const minimalHolding = {
        symbol: "TCS",
        quantity: 50,
        averagePrice: 3500,
      };

      const result = HoldingFormSchema.safeParse(minimalHolding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.sector, "Other");
      assert.strictEqual(result.data?.exchange, "NSE");
      assert.strictEqual(result.data?.brokerName, "manual");
    });

    it("should fail when symbol is empty", () => {
      const holding = {
        symbol: "",
        quantity: 100,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
      assert.ok(result.error?.errors.some((e) => e.path.includes("symbol")));
    });

    it("should fail for negative quantity", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: -10,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
    });

    it("should fail for zero quantity", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 0,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
    });

    it("should fail for negative average price", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 100,
        averagePrice: -100,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
    });

    it("should fail for zero average price", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 100,
        averagePrice: 0,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
    });

    it("should validate both exchange types", () => {
      const exchanges = ["NSE", "BSE"];

      for (const exchange of exchanges) {
        const holding = {
          symbol: "TEST",
          quantity: 100,
          averagePrice: 100,
          exchange,
        };

        const result = HoldingFormSchema.safeParse(holding);
        assert.ok(result.success, `Exchange ${exchange} should be valid`);
      }
    });

    it("should fail for invalid exchange", () => {
      const holding = {
        symbol: "TEST",
        quantity: 100,
        averagePrice: 100,
        exchange: "INVALID",
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
    });

    it("should handle optional current price", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 100,
        averagePrice: 2500,
        currentPrice: 2600,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.currentPrice, 2600);
    });

    it("should allow missing current price", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 100,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.currentPrice, undefined);
    });

    it("should fail for negative current price", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 100,
        averagePrice: 2500,
        currentPrice: -100,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
    });

    it("should handle optional name", () => {
      const holding = {
        symbol: "RELIANCE",
        name: "Reliance Industries",
        quantity: 100,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.name, "Reliance Industries");
    });

    it("should handle optional sector", () => {
      const holding = {
        symbol: "RELIANCE",
        sector: "Energy",
        quantity: 100,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.sector, "Energy");
    });

    it("should truncate symbol at 50 characters", () => {
      const holding = {
        symbol: "A".repeat(60),
        quantity: 100,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(!result.success);
    });

    it("should handle decimal quantity", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 10.5,
        averagePrice: 2500,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.quantity, 10.5);
    });

    it("should handle decimal prices", () => {
      const holding = {
        symbol: "RELIANCE",
        quantity: 100,
        averagePrice: 2500.75,
        currentPrice: 2600.5,
      };

      const result = HoldingFormSchema.safeParse(holding);
      assert.ok(result.success);
      assert.strictEqual(result.data?.averagePrice, 2500.75);
      assert.strictEqual(result.data?.currentPrice, 2600.5);
    });
  });
});
