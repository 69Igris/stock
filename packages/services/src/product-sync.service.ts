import { dodoClient } from "@usemoney/core/payments";
import { prisma } from "@usemoney/database";
import { paymentsLogger as logger } from "@usemoney/logger";
// Pure mapping + payload builders — SINGLE SOURCE OF TRUTH (no shadows). The
// sync loop CALLS these so the upsert payloads, product→plan map, list params
// and lookup query are defined once and the tests run the same code.
import {
  PRODUCT_PLAN_MAPPING,
  buildCreatePayload,
  buildListParams,
  buildProductQuery,
  buildUpdatePayload,
  mapProductToPlan,
} from "./product-sync-logic";

export async function syncDodoProducts(): Promise<{
  synced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let syncedCount = 0;
  // MONEY-481: track the set of currently-active product IDs from Dodo
  // so we can mark anything else in our local table as archived at the
  // end. Without this, rows that we archived in Dodo (e.g. the old
  // ₹499 PRO monthly product) stay around with archived=false locally
  // and getDodoProductInfo non-deterministically returns them → Dodo
  // 404s on checkout creation.
  const activeProductIds = new Set<string>();

  try {
    logger.info("Starting Dodo product sync...");

    // Fetch all products from Dodo, filtered by brand if specified
    const brandId = process.env.DODO_BRAND_ID;
    const response = await dodoClient.products.list(buildListParams(brandId));

    logger.info(`Fetched ${response.items?.length || 0} products from Dodo`);

    for (const product of response.items || []) {
      activeProductIds.add(product.product_id);
      try {
        // Find mapping for this product
        const mapping = mapProductToPlan(product.name);

        if (!mapping) {
          // Skip products not in our system
          logger.debug(
            `Skipping unmapped product: ${product.name} (${product.product_id})`,
          );
          continue;
        }

        logger.debug(
          `Syncing product: ${product.name} → ${mapping.planType}${
            mapping.billingPeriod ? ` (${mapping.billingPeriod})` : ""
          }`,
        );

        // Upsert product in database
        await prisma.dodoProduct.upsert({
          where: { productId: product.product_id },
          update: buildUpdatePayload(product, mapping),
          create: buildCreatePayload(product, mapping),
        });

        syncedCount++;
      } catch (productError: unknown) {
        const errorMsg = `Failed to sync ${product.product_id}: ${
          productError instanceof Error
            ? productError.message
            : String(productError)
        }`;
        logger.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    // MONEY-481: archive stale rows. Anything in our local table that
    // is NOT in the active set we just fetched must have been archived
    // (or deleted) in Dodo since the last sync. Mark it `archived: true`
    // so getDodoProductInfo's archived:false filter stops returning it.
    //
    // Guard: only reconcile when the Dodo fetch actually returned rows
    // — if the API call failed mid-iteration we'd have an empty active
    // set and would archive everything, breaking all checkouts.
    let archivedStale = 0;
    if (activeProductIds.size > 0) {
      const result = await prisma.dodoProduct.updateMany({
        where: {
          archived: false,
          productId: { notIn: Array.from(activeProductIds) },
        },
        data: { archived: true, lastSyncedAt: new Date() },
      });
      archivedStale = result.count;
      if (archivedStale > 0) {
        logger.info(
          `Archived ${archivedStale} stale local DodoProduct row(s) absent from Dodo active list`,
        );
      }
    }

    logger.info(
      `Product sync completed: ${syncedCount} synced, ${archivedStale} archived, ${errors.length} errors`,
    );
    return { synced: syncedCount, errors };
  } catch (error: unknown) {
    const errorMsg = `Dodo API error: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logger.error(errorMsg);
    errors.push(errorMsg);
    return { synced: 0, errors };
  }
}

// Get product ID for checkout
export async function getDodoProductId(
  planType: string,
  billingPeriod?: string,
): Promise<string | null> {
  const info = await getDodoProductInfo(planType, billingPeriod);
  return info?.productId || null;
}

// Get product info (ID + isRecurring) for checkout
export async function getDodoProductInfo(
  planType: string,
  billingPeriod?: string,
): Promise<{
  productId: string;
  isRecurring: boolean;
  price: number;
} | null> {
  try {
    const product = await prisma.dodoProduct.findFirst({
      where: buildProductQuery(planType, billingPeriod),
    });

    if (product) {
      logger.debug(
        `Found product for ${planType}${
          billingPeriod ? ` (${billingPeriod})` : ""
        }: ${product.productId} (recurring: ${product.isRecurring})`,
      );
      return {
        productId: product.productId,
        isRecurring: product.isRecurring,
        // MONEY-872: Dodo stores money in the smallest currency unit (PAISE for INR,
        // e.g. 149900 = ₹1,499) and DodoProduct.price mirrors that raw value. The app
        // works in RUPEES everywhere (PLAN_CONFIG, resolveCheckoutAmount's fallbacks,
        // the Payment.amount we record + show), so convert at this single boundary.
        // Treating the paise value as rupees recorded the amount 100× — ₹1,499 →
        // ₹1,49,900 (and with a 20% coupon, the ₹1,19,920 invoice the founder hit).
        price: product.price / 100,
      };
    }

    logger.warn(
      `No product found for ${planType}${
        billingPeriod ? ` (${billingPeriod})` : ""
      }`,
    );
    return null;
  } catch (error: unknown) {
    logger.error(
      `Error getting Dodo product info: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
