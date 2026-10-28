/**
 * List Dodo Products
 *
 * Read-only inspection of products in the configured Dodo environment
 * (test_mode unless NEXT_PUBLIC_DODO_MODE=live). Prints id, name, price,
 * currency, recurring flag, and payment frequency for every product
 * under the configured brand.
 *
 * Usage:
 *   npx tsx scripts/dodo-list-products.ts
 *
 * Env (auto-loaded from apps/web/.env):
 *   DODO_PAYMENTS_API_KEY  — required
 *   DODO_BRAND_ID          — optional filter
 *   NEXT_PUBLIC_DODO_MODE  — "live" or anything else (default test_mode)
 */

import { config } from "dotenv";
import path from "path";

// Load env from apps/web/.env so the Dodo client picks up the key.
config({ path: path.resolve(__dirname, "../.env") });

import { getDodoClient, getDodoMode } from "@usemoney/core/payments";

async function main() {
  const mode = getDodoMode();
  const brandId = process.env.DODO_BRAND_ID;
  console.log(`\nDodo mode: ${mode}${brandId ? `  ·  brand: ${brandId}` : ""}`);

  const client = getDodoClient();
  const response = await client.products.list({
    page_size: 100,
    archived: false,
    ...(brandId && { brand_id: brandId }),
  });

  const items = response.items ?? [];
  console.log(`Found ${items.length} active products:\n`);

  if (items.length === 0) {
    console.log("  (none — products need to be created)");
    return;
  }

  for (const p of items) {
    const priceField = (p as { price?: unknown }).price;
    const priceObj =
      priceField && typeof priceField === "object" && priceField !== null
        ? (priceField as Record<string, unknown>)
        : null;
    const flatPrice = typeof priceField === "number" ? priceField : null;

    const cents =
      flatPrice ??
      (typeof priceObj?.price === "number" ? (priceObj.price as number) : null);
    const currency =
      (typeof priceObj?.currency === "string"
        ? (priceObj.currency as string)
        : null) ??
      (p as { currency?: string }).currency ??
      "?";
    const frequency =
      (typeof priceObj?.payment_frequency_interval === "string"
        ? (priceObj.payment_frequency_interval as string)
        : null) ??
      (typeof priceObj?.payment_frequency === "string"
        ? (priceObj.payment_frequency as string)
        : null) ??
      null;
    const recurring =
      (p as { is_recurring?: boolean }).is_recurring ??
      priceObj?.type === "recurring_price";

    const priceStr =
      cents != null
        ? `${currency} ${(cents / 100).toLocaleString("en-IN")}`
        : "?";

    console.log(
      `  • ${p.name?.padEnd(34) ?? "(unnamed)"}  ${p.product_id}` +
        `\n      price: ${priceStr}` +
        `${frequency ? `  freq: ${frequency}` : ""}` +
        `  recurring: ${recurring ? "yes" : "no"}`
    );
  }
}

main().catch((err) => {
  console.error("\nFailed to list products:", err);
  process.exit(1);
});
