/**
 * Pure product-sync logic (no Prisma, no `dodopayments` SDK).
 *
 * `product-sync.ts` CALLS these helpers so the create/update upsert payloads,
 * the product→plan mapping, the list params and the lookup query are defined
 * exactly once. Previously this logic was inlined in `product-sync.ts` and a
 * second time inside `__tests__/payments/product-sync.test.ts` (a shadow whose
 * `PRODUCT_PLAN_MAPPING` had drifted to only the 4 legacy entries).
 */

// Type-only (erased at runtime — this module stays Prisma/SDK-free at load): the
// upsert payload's `metadata` must be Prisma's JSON input shape, not a bare
// Record<string, unknown> (which Prisma's *UpdateInput/*CreateInput reject).
import type { Prisma } from "@usemoney/database";

export interface DodoProductLike {
  product_id: string;
  business_id: string;
  name?: string | null;
  description?: string | null;
  price?: number | null;
  currency?: string | null;
  is_recurring?: boolean | null;
  tax_category?: string | null;
  image?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PlanMapping {
  planType: string;
  billingPeriod?: string;
}

export interface ProductUpdatePayload {
  name: string;
  description: string | null;
  price: number;
  currency: string;
  isRecurring: boolean;
  taxCategory: string | null;
  image: string | null;
  metadata: Prisma.InputJsonValue | null;
  archived: boolean;
  planType: string;
  billingPeriod: string | null;
  lastSyncedAt: Date;
}

export interface ProductCreatePayload {
  productId: string;
  businessId: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  isRecurring: boolean;
  taxCategory: string | null;
  image: string | null;
  metadata: Prisma.InputJsonValue | null;
  planType: string;
  billingPeriod: string | null;
}

export interface ProductListParams {
  page_size: number;
  archived: boolean;
  brand_id?: string;
}

export interface ProductLookupQuery {
  planType: string;
  billingPeriod: string | null;
  archived: boolean;
}

export interface SyncResult {
  synced: number;
  errors: string[];
}

// Map Dodo product names to our plan types.
// New usemoney_* products are canonical; old tradebook_* kept for transition.
export const PRODUCT_PLAN_MAPPING: Record<string, PlanMapping> = {
  // New product names
  usemoney_pro: { planType: "PRO" },
  usemoney_pro_annual: { planType: "PRO", billingPeriod: "annual" },
  usemoney_pro_monthly: { planType: "PRO", billingPeriod: "monthly" },
  usemoney_query_pack: { planType: "QUERY_PACK" },
  usemoney_premium: { planType: "PREMIUM", billingPeriod: "monthly" },
  usemoney_premium_annual: { planType: "PREMIUM", billingPeriod: "annual" },
  // Credit packs
  usemoney_credit_pack_50: { planType: "CREDIT_PACK_50" },
  usemoney_credit_pack_100: { planType: "CREDIT_PACK_100" },
  usemoney_credit_pack_250: { planType: "CREDIT_PACK_250" },
  usemoney_credit_pack_500: { planType: "CREDIT_PACK_500" },
  usemoney_credit_pack_1000: { planType: "CREDIT_PACK_1000" },
  // Ready for when ULTIMATE products are created
  usemoney_ultimate_monthly: { planType: "ULTIMATE", billingPeriod: "monthly" },
  usemoney_ultimate_annual: { planType: "ULTIMATE", billingPeriod: "annual" },
  // Legacy product names (kept for transition period)
  tradebook_pro: { planType: "PRO" },
  tradebook_ai_addon: { planType: "QUERY_PACK" },
  tradebook_ai_unlimited: { planType: "PREMIUM", billingPeriod: "monthly" },
  tradebook_ai_unlimited_annual: {
    planType: "PREMIUM",
    billingPeriod: "annual",
  },
};

/** Map a Dodo product name (case-insensitive) to our internal plan type. */
export function mapProductToPlan(
  name: string | null | undefined,
): PlanMapping | null {
  if (!name) return null;
  return PRODUCT_PLAN_MAPPING[name.toLowerCase()] || null;
}

/** Build the upsert `update` payload for a Dodo product. */
export function buildUpdatePayload(
  product: DodoProductLike,
  mapping: PlanMapping,
  now: Date = new Date(),
): ProductUpdatePayload {
  return {
    name: product.name || "",
    description: product.description || null,
    price: product.price || 0,
    currency: product.currency || "INR",
    isRecurring: product.is_recurring || false,
    taxCategory: product.tax_category || null,
    image: product.image || null,
    metadata: (product.metadata ?? null) as Prisma.InputJsonValue | null,
    archived: false,
    planType: mapping.planType,
    billingPeriod: mapping.billingPeriod || null,
    lastSyncedAt: now,
  };
}

/** Build the upsert `create` payload for a Dodo product. */
export function buildCreatePayload(
  product: DodoProductLike,
  mapping: PlanMapping,
): ProductCreatePayload {
  return {
    productId: product.product_id,
    businessId: product.business_id,
    name: product.name || "",
    description: product.description || null,
    price: product.price || 0,
    currency: product.currency || "INR",
    isRecurring: product.is_recurring || false,
    taxCategory: product.tax_category || null,
    image: product.image || null,
    metadata: (product.metadata ?? null) as Prisma.InputJsonValue | null,
    planType: mapping.planType,
    billingPeriod: mapping.billingPeriod || null,
  };
}

/** Build the `products.list()` request params (brand filter is optional). */
export function buildListParams(brandId?: string): ProductListParams {
  return {
    page_size: 100,
    archived: false,
    ...(brandId && { brand_id: brandId }),
  };
}

/** Build the `findFirst` query for getDodoProductInfo. */
export function buildProductQuery(
  planType: string,
  billingPeriod?: string,
): ProductLookupQuery {
  return {
    planType,
    billingPeriod: billingPeriod || null,
    archived: false,
  };
}

export interface ProductUpsertArgs {
  where: { productId: string };
  update: ProductUpdatePayload;
  create: ProductCreatePayload;
}

/**
 * Core per-product sync loop: for each mapped product, build the upsert args
 * and call `upsertFn`, accumulating a synced count and per-product errors.
 * Unmapped products are skipped. A throw from `upsertFn` is caught and recorded
 * (other products still process). The real DB upsert + the test both run this.
 */
export async function syncProductsCore(
  products: DodoProductLike[],
  upsertFn: (args: ProductUpsertArgs) => Promise<void>,
  now: Date = new Date(),
): Promise<SyncResult> {
  const errors: string[] = [];
  let syncedCount = 0;

  for (const product of products) {
    const mapping = mapProductToPlan(product.name);
    if (!mapping) continue;

    try {
      await upsertFn({
        where: { productId: product.product_id },
        update: buildUpdatePayload(product, mapping, now),
        create: buildCreatePayload(product, mapping),
      });
      syncedCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push(`Failed to sync ${product.product_id}: ${msg}`);
    }
  }

  return { synced: syncedCount, errors };
}
