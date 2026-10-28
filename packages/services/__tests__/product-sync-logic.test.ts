/**
 * Product Sync Tests
 *
 * De-shadowed (MONEY-620): previously this file re-implemented the product→plan
 * mapping, upsert payload builders, list params, lookup query and the sync loop
 * inline and asserted the copy. The inline `PRODUCT_PLAN_MAPPING` had drifted to
 * only the 4 legacy `tradebook_*` entries while production had ~17 (the canonical
 * `usemoney_*` names + credit packs). It now imports the REAL exports from
 * `@/lib/payments/product-sync-logic`, which `product-sync.ts` itself calls.
 *
 * Source: packages/services/src/product-sync-logic.ts (+ product-sync.service.ts)
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  PRODUCT_PLAN_MAPPING,
  type DodoProductLike,
  type PlanMapping,
  type ProductUpsertArgs,
  mapProductToPlan,
  buildUpdatePayload,
  buildCreatePayload,
  buildListParams,
  buildProductQuery,
  syncProductsCore,
} from "../src/product-sync-logic.ts";

// ============== HELPERS ==============

function makeDodoProduct(
  overrides: Partial<DodoProductLike> = {},
): DodoProductLike {
  return {
    product_id: "prod_abc123",
    business_id: "biz_xyz",
    name: "tradebook_pro",
    description: "PRO plan",
    price: 999,
    currency: "INR",
    is_recurring: false,
    tax_category: "digital_services",
    image: "https://example.com/pro.png",
    metadata: { tier: "pro" },
    ...overrides,
  };
}

// ============== TESTS ==============

describe("PRODUCT_PLAN_MAPPING", () => {
  it("should map tradebook_pro to PRO", () => {
    const mapping = PRODUCT_PLAN_MAPPING["tradebook_pro"];
    assert.equal(mapping.planType, "PRO");
    assert.equal(mapping.billingPeriod, undefined);
  });

  it("should map tradebook_ai_addon to QUERY_PACK", () => {
    const mapping = PRODUCT_PLAN_MAPPING["tradebook_ai_addon"];
    assert.equal(mapping.planType, "QUERY_PACK");
    assert.equal(mapping.billingPeriod, undefined);
  });

  it("should map tradebook_ai_unlimited to PREMIUM monthly", () => {
    const mapping = PRODUCT_PLAN_MAPPING["tradebook_ai_unlimited"];
    assert.equal(mapping.planType, "PREMIUM");
    assert.equal(mapping.billingPeriod, "monthly");
  });

  it("should map tradebook_ai_unlimited_annual to PREMIUM annual", () => {
    const mapping = PRODUCT_PLAN_MAPPING["tradebook_ai_unlimited_annual"];
    assert.equal(mapping.planType, "PREMIUM");
    assert.equal(mapping.billingPeriod, "annual");
  });

  // Canonical usemoney_* names (these were MISSING from the old shadow copy).
  it("should map the canonical usemoney_pro to PRO", () => {
    assert.equal(PRODUCT_PLAN_MAPPING["usemoney_pro"].planType, "PRO");
  });

  it("should map usemoney_premium to PREMIUM monthly", () => {
    const mapping = PRODUCT_PLAN_MAPPING["usemoney_premium"];
    assert.equal(mapping.planType, "PREMIUM");
    assert.equal(mapping.billingPeriod, "monthly");
  });

  it("should map usemoney_premium_annual to PREMIUM annual", () => {
    const mapping = PRODUCT_PLAN_MAPPING["usemoney_premium_annual"];
    assert.equal(mapping.planType, "PREMIUM");
    assert.equal(mapping.billingPeriod, "annual");
  });

  it("should map credit packs to their CREDIT_PACK_* plan types", () => {
    assert.equal(
      PRODUCT_PLAN_MAPPING["usemoney_credit_pack_50"].planType,
      "CREDIT_PACK_50",
    );
    assert.equal(
      PRODUCT_PLAN_MAPPING["usemoney_credit_pack_1000"].planType,
      "CREDIT_PACK_1000",
    );
  });

  it("should not have a mapping for arbitrary product names", () => {
    assert.equal(PRODUCT_PLAN_MAPPING["random_product"], undefined);
  });
});

describe("mapProductToPlan", () => {
  it("should return PRO mapping for tradebook_pro", () => {
    const result = mapProductToPlan("tradebook_pro");
    assert.deepEqual(result, { planType: "PRO" });
  });

  it("should return QUERY_PACK mapping for tradebook_ai_addon", () => {
    const result = mapProductToPlan("tradebook_ai_addon");
    assert.deepEqual(result, { planType: "QUERY_PACK" });
  });

  it("should return PREMIUM monthly for tradebook_ai_unlimited", () => {
    const result = mapProductToPlan("tradebook_ai_unlimited");
    assert.deepEqual(result, { planType: "PREMIUM", billingPeriod: "monthly" });
  });

  it("should return PREMIUM annual for tradebook_ai_unlimited_annual", () => {
    const result = mapProductToPlan("tradebook_ai_unlimited_annual");
    assert.deepEqual(result, { planType: "PREMIUM", billingPeriod: "annual" });
  });

  it("should resolve the canonical usemoney_pro name", () => {
    assert.deepEqual(mapProductToPlan("usemoney_pro"), { planType: "PRO" });
  });

  it("should be case-insensitive", () => {
    const result = mapProductToPlan("Tradebook_Pro");
    assert.deepEqual(result, { planType: "PRO" });
  });

  it("should handle mixed case", () => {
    const result = mapProductToPlan("TRADEBOOK_AI_ADDON");
    assert.deepEqual(result, { planType: "QUERY_PACK" });
  });

  it("should return null for unmapped product name", () => {
    assert.equal(mapProductToPlan("some_other_product"), null);
  });

  it("should return null for null name", () => {
    assert.equal(mapProductToPlan(null), null);
  });

  it("should return null for undefined name", () => {
    assert.equal(mapProductToPlan(undefined), null);
  });

  it("should return null for empty string", () => {
    assert.equal(mapProductToPlan(""), null);
  });
});

describe("buildUpdatePayload", () => {
  it("should extract all fields from a complete product", () => {
    const product = makeDodoProduct();
    const mapping: PlanMapping = { planType: "PRO" };

    const payload = buildUpdatePayload(product, mapping);

    assert.equal(payload.name, "tradebook_pro");
    assert.equal(payload.description, "PRO plan");
    assert.equal(payload.price, 999);
    assert.equal(payload.currency, "INR");
    assert.equal(payload.isRecurring, false);
    assert.equal(payload.taxCategory, "digital_services");
    assert.equal(payload.image, "https://example.com/pro.png");
    assert.deepEqual(payload.metadata, { tier: "pro" });
    assert.equal(payload.archived, false);
    assert.equal(payload.planType, "PRO");
    assert.equal(payload.billingPeriod, null);
    assert.ok(payload.lastSyncedAt instanceof Date);
  });

  it("should set billingPeriod from mapping", () => {
    const product = makeDodoProduct();
    const mapping: PlanMapping = {
      planType: "PREMIUM",
      billingPeriod: "monthly",
    };

    const payload = buildUpdatePayload(product, mapping);

    assert.equal(payload.billingPeriod, "monthly");
  });

  it("should default null description to null", () => {
    const product = makeDodoProduct({ description: null });
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.description, null);
  });

  it("should default null price to 0", () => {
    const product = makeDodoProduct({ price: null });
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.price, 0);
  });

  it("should default zero price to 0 (not falsy-swapped)", () => {
    const product = makeDodoProduct({ price: 0 });
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.price, 0);
  });

  it("should default null currency to INR", () => {
    const product = makeDodoProduct({ currency: null });
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.currency, "INR");
  });

  it("should default null is_recurring to false", () => {
    const product = makeDodoProduct({ is_recurring: null });
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.isRecurring, false);
  });

  it("should pass through true is_recurring", () => {
    const product = makeDodoProduct({ is_recurring: true });
    const payload = buildUpdatePayload(product, { planType: "PREMIUM" });
    assert.equal(payload.isRecurring, true);
  });

  it("should default null name to empty string", () => {
    const product = makeDodoProduct({ name: null });
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.name, "");
  });

  it("should default null metadata to null", () => {
    const product = makeDodoProduct({ metadata: null });
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.metadata, null);
  });

  it("should always set archived to false", () => {
    const product = makeDodoProduct();
    const payload = buildUpdatePayload(product, { planType: "PRO" });
    assert.equal(payload.archived, false);
  });
});

describe("buildCreatePayload", () => {
  it("should include productId and businessId", () => {
    const product = makeDodoProduct({
      product_id: "prod_123",
      business_id: "biz_456",
    });
    const payload = buildCreatePayload(product, { planType: "PRO" });

    assert.equal(payload.productId, "prod_123");
    assert.equal(payload.businessId, "biz_456");
  });

  it("should not include lastSyncedAt (unlike update)", () => {
    const product = makeDodoProduct();
    const payload = buildCreatePayload(product, { planType: "PRO" });
    assert.equal("lastSyncedAt" in payload, false);
  });

  it("should not include archived (unlike update)", () => {
    const product = makeDodoProduct();
    const payload = buildCreatePayload(product, { planType: "PRO" });
    assert.equal("archived" in payload, false);
  });

  it("should set billingPeriod from mapping", () => {
    const product = makeDodoProduct();
    const payload = buildCreatePayload(product, {
      planType: "PREMIUM",
      billingPeriod: "annual",
    });
    assert.equal(payload.billingPeriod, "annual");
  });

  it("should default billingPeriod to null when not in mapping", () => {
    const product = makeDodoProduct();
    const payload = buildCreatePayload(product, { planType: "QUERY_PACK" });
    assert.equal(payload.billingPeriod, null);
  });

  it("should handle all null product fields", () => {
    const product: DodoProductLike = {
      product_id: "p1",
      business_id: "b1",
      name: null,
      description: null,
      price: null,
      currency: null,
      is_recurring: null,
      tax_category: null,
      image: null,
      metadata: null,
    };
    const payload = buildCreatePayload(product, { planType: "PRO" });

    assert.equal(payload.name, "");
    assert.equal(payload.description, null);
    assert.equal(payload.price, 0);
    assert.equal(payload.currency, "INR");
    assert.equal(payload.isRecurring, false);
    assert.equal(payload.taxCategory, null);
    assert.equal(payload.image, null);
    assert.equal(payload.metadata, null);
  });
});

describe("buildListParams", () => {
  it("should always include page_size 100 and archived false", () => {
    const params = buildListParams();
    assert.equal(params.page_size, 100);
    assert.equal(params.archived, false);
  });

  it("should include brand_id when provided", () => {
    const params = buildListParams("brand_abc");
    assert.equal(params.brand_id, "brand_abc");
  });

  it("should not include brand_id when undefined", () => {
    const params = buildListParams(undefined);
    assert.equal("brand_id" in params, false);
  });

  it("should not include brand_id when empty string", () => {
    const params = buildListParams("");
    assert.equal("brand_id" in params, false);
  });
});

describe("syncProductsCore (core logic)", () => {
  it("should sync mapped products and return count", async () => {
    const upsertFn = mock.fn(async () => {});
    const products = [
      makeDodoProduct({ product_id: "p1", name: "tradebook_pro" }),
      makeDodoProduct({ product_id: "p2", name: "tradebook_ai_addon" }),
    ];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 2);
    assert.equal(result.errors.length, 0);
    assert.equal(upsertFn.mock.callCount(), 2);
  });

  it("should skip unmapped products", async () => {
    const upsertFn = mock.fn(async () => {});
    const products = [
      makeDodoProduct({ product_id: "p1", name: "tradebook_pro" }),
      makeDodoProduct({ product_id: "p2", name: "unknown_product" }),
      makeDodoProduct({ product_id: "p3", name: "tradebook_ai_addon" }),
    ];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 2);
    assert.equal(upsertFn.mock.callCount(), 2);
  });

  it("should pass correct where clause to upsert", async () => {
    const calls: ProductUpsertArgs[] = [];
    const upsertFn = async (args: ProductUpsertArgs): Promise<void> => {
      calls.push(args);
    };
    const products = [
      makeDodoProduct({ product_id: "prod_test_1", name: "tradebook_pro" }),
    ];

    await syncProductsCore(products, upsertFn);

    assert.deepEqual(calls[0].where, { productId: "prod_test_1" });
  });

  it("should set correct planType in upsert update and create", async () => {
    const calls: ProductUpsertArgs[] = [];
    const upsertFn = async (args: ProductUpsertArgs): Promise<void> => {
      calls.push(args);
    };
    const products = [
      makeDodoProduct({ product_id: "p1", name: "tradebook_ai_unlimited" }),
    ];

    await syncProductsCore(products, upsertFn);

    assert.equal(calls[0].update.planType, "PREMIUM");
    assert.equal(calls[0].update.billingPeriod, "monthly");
    assert.equal(calls[0].create.planType, "PREMIUM");
    assert.equal(calls[0].create.billingPeriod, "monthly");
  });

  it("should continue after per-product upsert failure", async () => {
    let callIdx = 0;
    const upsertFn = async (): Promise<void> => {
      callIdx++;
      if (callIdx === 1) throw new Error("DB timeout");
    };

    const products = [
      makeDodoProduct({ product_id: "p1", name: "tradebook_pro" }),
      makeDodoProduct({ product_id: "p2", name: "tradebook_ai_addon" }),
    ];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 1);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("p1"));
    assert.ok(result.errors[0].includes("DB timeout"));
  });

  it("should accumulate multiple errors", async () => {
    const upsertFn = async (): Promise<void> => {
      throw new Error("write failed");
    };

    const products = [
      makeDodoProduct({ product_id: "p1", name: "tradebook_pro" }),
      makeDodoProduct({ product_id: "p2", name: "tradebook_ai_addon" }),
    ];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 0);
    assert.equal(result.errors.length, 2);
  });

  it("should handle empty products array", async () => {
    const upsertFn = mock.fn(async () => {});

    const result = await syncProductsCore([], upsertFn);

    assert.equal(result.synced, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(upsertFn.mock.callCount(), 0);
  });

  it("should handle all products being unmapped", async () => {
    const upsertFn = mock.fn(async () => {});
    const products = [
      makeDodoProduct({ name: "random_product_1" }),
      makeDodoProduct({ name: "random_product_2" }),
    ];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(upsertFn.mock.callCount(), 0);
  });

  it("should skip products with null name", async () => {
    const upsertFn = mock.fn(async () => {});
    const products = [makeDodoProduct({ name: null })];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 0);
    assert.equal(upsertFn.mock.callCount(), 0);
  });

  it("should skip products with undefined name", async () => {
    const upsertFn = mock.fn(async () => {});
    const products = [makeDodoProduct({ name: undefined })];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 0);
  });

  it("should sync all four legacy plan types in one batch", async () => {
    const calls: ProductUpsertArgs[] = [];
    const upsertFn = async (args: ProductUpsertArgs): Promise<void> => {
      calls.push(args);
    };
    const products = [
      makeDodoProduct({ product_id: "p1", name: "tradebook_pro" }),
      makeDodoProduct({ product_id: "p2", name: "tradebook_ai_addon" }),
      makeDodoProduct({ product_id: "p3", name: "tradebook_ai_unlimited" }),
      makeDodoProduct({
        product_id: "p4",
        name: "tradebook_ai_unlimited_annual",
      }),
    ];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 4);
    assert.equal(result.errors.length, 0);

    // Verify each plan type was set correctly
    const planTypes = calls.map((c) => c.update.planType);
    assert.ok(planTypes.includes("PRO"));
    assert.ok(planTypes.includes("QUERY_PACK"));
    // Two PREMIUM entries (monthly + annual)
    assert.equal(planTypes.filter((t) => t === "PREMIUM").length, 2);
  });

  it("should handle non-Error throws in upsert", async () => {
    const upsertFn = async (): Promise<void> => {
      throw "string error";
    };

    const products = [
      makeDodoProduct({ product_id: "p1", name: "tradebook_pro" }),
    ];

    const result = await syncProductsCore(products, upsertFn);

    assert.equal(result.synced, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes("Unknown error"));
  });

  it("should preserve product field values in upsert payloads", async () => {
    const calls: ProductUpsertArgs[] = [];
    const upsertFn = async (args: ProductUpsertArgs): Promise<void> => {
      calls.push(args);
    };
    const product = makeDodoProduct({
      product_id: "p1",
      business_id: "biz_test",
      name: "tradebook_pro",
      description: "Test description",
      price: 1999,
      currency: "USD",
      is_recurring: true,
      tax_category: "software",
      image: "https://img.test/product.png",
      metadata: { custom: "data" },
    });

    await syncProductsCore([product], upsertFn);

    const call = calls[0];

    // Update payload
    assert.equal(call.update.name, "tradebook_pro");
    assert.equal(call.update.description, "Test description");
    assert.equal(call.update.price, 1999);
    assert.equal(call.update.currency, "USD");
    assert.equal(call.update.isRecurring, true);
    assert.equal(call.update.taxCategory, "software");
    assert.equal(call.update.image, "https://img.test/product.png");
    assert.deepEqual(call.update.metadata, { custom: "data" });

    // Create payload
    assert.equal(call.create.productId, "p1");
    assert.equal(call.create.businessId, "biz_test");
  });
});

describe("buildProductQuery", () => {
  it("should build query for PRO without billingPeriod", () => {
    const query = buildProductQuery("PRO");
    assert.deepEqual(query, {
      planType: "PRO",
      billingPeriod: null,
      archived: false,
    });
  });

  it("should build query for PREMIUM with monthly billingPeriod", () => {
    const query = buildProductQuery("PREMIUM", "monthly");
    assert.deepEqual(query, {
      planType: "PREMIUM",
      billingPeriod: "monthly",
      archived: false,
    });
  });

  it("should build query for PREMIUM with annual billingPeriod", () => {
    const query = buildProductQuery("PREMIUM", "annual");
    assert.deepEqual(query, {
      planType: "PREMIUM",
      billingPeriod: "annual",
      archived: false,
    });
  });

  it("should build query for QUERY_PACK without billingPeriod", () => {
    const query = buildProductQuery("QUERY_PACK");
    assert.deepEqual(query, {
      planType: "QUERY_PACK",
      billingPeriod: null,
      archived: false,
    });
  });

  it("should always set archived to false", () => {
    const query = buildProductQuery("ANYTHING");
    assert.equal(query.archived, false);
  });

  it("should convert undefined billingPeriod to null", () => {
    const query = buildProductQuery("PRO", undefined);
    assert.equal(query.billingPeriod, null);
  });

  it("should convert empty string billingPeriod to null", () => {
    const query = buildProductQuery("PRO", "");
    assert.equal(query.billingPeriod, null);
  });
});
