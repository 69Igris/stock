/**
 * Migrate Existing Users to Resend Audience Segments
 *
 * Queries all users from the User table, checks their subscription status +
 * payment history, and adds them to the appropriate Resend audience:
 *  - Never-paid users (currently free)              → usemoney-free
 *  - Currently paid (PRO, PREMIUM, ULTIMATE)        → usemoney-paid
 *  - Previously paid, now on FREE plan              → usemoney-downgrade
 *  - ALL users (security notifications)             → usemoney-security
 *
 * Rate-limited to respect Resend's 10 req/sec limit.
 *
 * Required env vars:
 *   DATABASE_URL, RESEND_API_KEY,
 *   RESEND_AUDIENCE_FREE_ID, RESEND_AUDIENCE_PAID_ID,
 *   RESEND_AUDIENCE_USEMONEY_SECURITY_ID
 *
 * Optional env vars:
 *   RESEND_AUDIENCE_DOWNGRADED_ID (if unset, downgraded users go to free)
 *
 * Usage: npx tsx scripts/migrations/migrate-resend-segments.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { Resend } from "resend";

// Validate required env vars
const REQUIRED_ENV = [
  "DATABASE_URL",
  "RESEND_API_KEY",
  "RESEND_AUDIENCE_FREE_ID",
  "RESEND_AUDIENCE_PAID_ID",
  "RESEND_AUDIENCE_USEMONEY_SECURITY_ID",
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const AUDIENCE_FREE_ID = process.env.RESEND_AUDIENCE_FREE_ID!;
const AUDIENCE_PAID_ID = process.env.RESEND_AUDIENCE_PAID_ID!;
const AUDIENCE_DOWNGRADED_ID = process.env.RESEND_AUDIENCE_DOWNGRADED_ID || "";
const AUDIENCE_USEMONEY_SECURITY_ID =
  process.env.RESEND_AUDIENCE_USEMONEY_SECURITY_ID!;
const PAID_PLANS = new Set(["PRO", "PREMIUM", "ULTIMATE"]);

if (!AUDIENCE_DOWNGRADED_ID) {
  console.warn(
    "⚠ RESEND_AUDIENCE_DOWNGRADED_ID not set - downgraded users will fall into 'free' segment",
  );
}

// Rate limiter: 8 req/sec to stay safely under Resend's 10 req/sec limit
const RATE_LIMIT_MS = 125; // 1000ms / 8 = 125ms between requests

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const prisma = new PrismaClient();
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Fetch all active users with their subscriptions
    // Fetch all users - isActive filter skipped because older documents
    // may not have the field, and Prisma's Boolean type doesn't allow null queries.
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        subscription: {
          select: {
            planId: true,
            status: true,
          },
        },
        payments: {
          where: { status: "COMPLETED" },
          select: { id: true },
          take: 1, // We only need to know if any completed payment exists
        },
      },
    });

    console.log(`Found ${users.length} users to migrate\n`);

    let freeCount = 0;
    let paidCount = 0;
    let downgradedCount = 0;
    let securityCount = 0;
    let errorCount = 0;

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const isPaid =
        user.subscription?.status === "ACTIVE" &&
        PAID_PLANS.has(user.subscription.planId);
      const hasEverPaid = user.payments.length > 0;

      // 3-way resolution: paid > downgraded > free
      let audienceId: string;
      let segmentLabel: string;
      if (isPaid) {
        audienceId = AUDIENCE_PAID_ID;
        segmentLabel = "paid";
      } else if (hasEverPaid && AUDIENCE_DOWNGRADED_ID) {
        audienceId = AUDIENCE_DOWNGRADED_ID;
        segmentLabel = "downgraded";
      } else {
        audienceId = AUDIENCE_FREE_ID;
        segmentLabel = "free";
      }

      // Parse name into first/last
      const [firstName, ...rest] = (user.name || "").split(" ");
      const contactData = {
        email: user.email,
        firstName: firstName || undefined,
        lastName: rest.join(" ") || undefined,
        unsubscribed: false,
      };

      try {
        // Add to free/paid/downgraded segment
        await resend.contacts.create({ audienceId, ...contactData });
        if (isPaid) paidCount++;
        else if (segmentLabel === "downgraded") downgradedCount++;
        else freeCount++;

        await sleep(RATE_LIMIT_MS);

        // Add to security segment (ALL users)
        await resend.contacts.create({
          audienceId: AUDIENCE_USEMONEY_SECURITY_ID,
          ...contactData,
        });
        securityCount++;

        if ((i + 1) % 50 === 0) {
          console.log(
            `Progress: ${i + 1}/${users.length} (free: ${freeCount}, paid: ${paidCount}, downgraded: ${downgradedCount}, security: ${securityCount}, errors: ${errorCount})`,
          );
        }
      } catch (err) {
        errorCount++;
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`Failed to add ${user.email} to ${segmentLabel}: ${msg}`);
      }

      // Rate limiting
      await sleep(RATE_LIMIT_MS);
    }

    console.log("\n========== Migration Complete ==========");
    console.log(`Total users:       ${users.length}`);
    console.log(`Free segment:      ${freeCount}`);
    console.log(`Paid segment:      ${paidCount}`);
    console.log(`Downgraded segment:${downgradedCount}`);
    console.log(`Security segment:  ${securityCount}`);
    console.log(`Errors:            ${errorCount}`);
    console.log("========================================");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
