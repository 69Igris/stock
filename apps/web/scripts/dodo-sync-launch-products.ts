/**
 * Sync Dodo launch-offer products to match `packages/core/plans.ts`.
 *
 * For each named SKU in the EXPECTED_CATALOG, this script:
 *   1. Looks up the active product by name (filter: archived=false, brand).
 *   2. If absent → CREATE a new product with the expected price.
 *   3. If present at the wrong price → CREATE new at correct price, then
 *      ARCHIVE the old one. (Order matters: never leave a SKU with no
 *      active product. Existing subscriptions on the archived product
 *      continue to bill at their original price — Dodo subscriptions
 *      reference product_id, not name.)
 *   4. If present at the correct price → no-op.
 *
 * Idempotent: safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/dodo-sync-launch-products.ts            # dry run
 *   npx tsx scripts/dodo-sync-launch-products.ts --apply    # commit
 *
 * Env (auto-loaded from apps/web/.env):
 *   DODO_PAYMENTS_API_KEY  — required
 *   DODO_BRAND_ID          — required (script refuses to run unbranded)
 *   NEXT_PUBLIC_DODO_MODE  — "live" or anything else (default test_mode)
 *
 * After this runs, trigger the local DodoProduct cache sync so the web
 * app's `getDodoProductInfo()` lookup returns the new IDs:
 *   curl -X POST $WEB_URL/api/cron/sync-products
 */

import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env") });

import { getDodoClient, getDodoMode } from "@usemoney/core/payments";

type Cycle = "monthly" | "annual";

interface ExpectedProduct {
  /** Product name in Dodo — matches PRODUCT_PLAN_MAPPING in product-sync.ts. */
  name: string;
  /** Human-readable label for log lines. */
  label: string;
  /** Cycle determines payment_frequency_interval. */
  cycle: Cycle;
  /** Price in paise (₹1 = 100 paise). */
  priceInPaise: number;
  /** Description to attach to the new product. */
  description: string;
}

// MONEY-438 launch-offer catalog. Numbers mirror packages/core/plans.ts.
const EXPECTED_CATALOG: ExpectedProduct[] = [
  {
    name: "usemoney_pro_monthly",
    label: "PRO Monthly",
    cycle: "monthly",
    priceInPaise: 249_00,
    description:
      "Pro monthly subscription — unlimited brokers, 50 research credits/month.",
  },
  {
    name: "usemoney_pro_annual",
    label: "PRO Annual",
    cycle: "annual",
    priceInPaise: 1_999_00,
    description:
      "Pro annual subscription — unlimited brokers, 50 research credits/month, billed yearly.",
  },
  {
    name: "usemoney_premium",
    label: "Premium Monthly",
    cycle: "monthly",
    priceInPaise: 1_499_00,
    description:
      "Premium monthly subscription — everything in Pro plus 200 research credits/month and priority support.",
  },
  {
    name: "usemoney_premium_annual",
    label: "Premium Annual",
    cycle: "annual",
    priceInPaise: 14_999_00,
    description:
      "Premium annual subscription — everything in Pro plus 200 research credits/month, billed yearly.",
  },
];

function recurringPriceBody(cycle: Cycle, priceInPaise: number) {
  // Matches the shape of the existing live products inspected via Dodo:
  //   monthly: payment_frequency_interval=Month, subscription_period_count=10y
  //   annual:  payment_frequency_interval=Year,  subscription_period_count=10y
  // 10-year sub period is the "effectively forever" convention used by
  // every existing product on this brand — cancellation handling is at
  // the subscription level, not the product.
  return {
    type: "recurring_price" as const,
    currency: "INR" as const,
    price: priceInPaise,
    discount: 0,
    purchasing_power_parity: false,
    payment_frequency_count: 1,
    // `as const` on each branch is load-bearing: a bare conditional
    // between two string literals widens to `string`, which doesn't
    // satisfy Dodo's TimeInterval union and breaks the prod type-check
    // (Vercel builds cold, our local cache hid this).
    payment_frequency_interval:
      cycle === "annual" ? ("Year" as const) : ("Month" as const),
    subscription_period_count: 10,
    subscription_period_interval: "Year" as const,
    tax_inclusive: false,
    trial_period_days: 0,
  };
}

interface ProductSlim {
  product_id: string;
  name?: string | null;
  price?: unknown;
  is_recurring?: boolean | null;
}

function readPriceInPaise(p: ProductSlim): number | null {
  const priceField = p.price;
  if (typeof priceField === "number") return priceField;
  if (priceField && typeof priceField === "object") {
    const v = (priceField as Record<string, unknown>).price;
    return typeof v === "number" ? v : null;
  }
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = getDodoMode();
  const brandId = process.env.DODO_BRAND_ID;

  if (!brandId) {
    console.error(
      "Refusing to run without DODO_BRAND_ID set — would touch every brand on the account."
    );
    process.exit(1);
  }

  console.log(`\nDodo mode: ${mode}  ·  brand: ${brandId}`);
  console.log(
    apply ? "Mode: APPLY (will mutate Dodo)" : "Mode: DRY RUN (no changes)\n"
  );

  const client = getDodoClient();

  // Fetch all active products in this brand once; we'll filter by name.
  const listResp = await client.products.list({
    page_size: 100,
    archived: false,
    brand_id: brandId,
  });
  const active = listResp.items ?? [];

  for (const expected of EXPECTED_CATALOG) {
    const existing = active.find(
      (p) => (p.name ?? "").toLowerCase() === expected.name
    );
    const currentPriceInPaise = existing ? readPriceInPaise(existing) : null;

    if (existing && currentPriceInPaise === expected.priceInPaise) {
      console.log(
        `✓ ${expected.label.padEnd(18)} ${existing.product_id}  ` +
          `already at ₹${(expected.priceInPaise / 100).toLocaleString("en-IN")}`
      );
      continue;
    }

    if (existing) {
      const fromStr =
        currentPriceInPaise != null
          ? `₹${(currentPriceInPaise / 100).toLocaleString("en-IN")}`
          : "(unknown)";
      const toStr = `₹${(expected.priceInPaise / 100).toLocaleString("en-IN")}`;
      console.log(
        `✗ ${expected.label.padEnd(18)} ${existing.product_id}  ` +
          `at ${fromStr} → needs replacement at ${toStr}`
      );

      if (!apply) continue;

      // 1. Create new product (same name).
      const created = await client.products.create({
        name: expected.name,
        description: expected.description,
        tax_category: "saas",
        brand_id: brandId,
        price: recurringPriceBody(expected.cycle, expected.priceInPaise),
        metadata: {
          plan_version: "v2",
          launch_offer: "money_438",
        },
      });
      console.log(`    → created ${created.product_id} at ${toStr}`);

      // 2. Only after the new one exists do we archive the old.
      await client.products.archive(existing.product_id);
      console.log(`    → archived ${existing.product_id}`);
    } else {
      const toStr = `₹${(expected.priceInPaise / 100).toLocaleString("en-IN")}`;
      console.log(
        `✗ ${expected.label.padEnd(18)} (missing)  → would create at ${toStr}`
      );

      if (!apply) continue;
      const created = await client.products.create({
        name: expected.name,
        description: expected.description,
        tax_category: "saas",
        brand_id: brandId,
        price: recurringPriceBody(expected.cycle, expected.priceInPaise),
        metadata: {
          plan_version: "v2",
          launch_offer: "money_438",
        },
      });
      console.log(`    → created ${created.product_id}`);
    }
  }

  console.log("\nDone.");
  if (apply) {
    console.log(
      "Next: trigger product sync so getDodoProductInfo() returns the new IDs:\n" +
        "  curl -X POST $WEB_URL/api/cron/sync-products"
    );
  } else {
    console.log("Re-run with --apply to commit these changes.");
  }
}

main().catch((err) => {
  console.error("\nFailed:", err);
  process.exit(1);
});
