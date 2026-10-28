/**
 * Backfill Clerk → MongoDB User + Subscription rows (MONEY-144)
 *
 * Audit (Apr 19): of 528 Clerk users, 12 had no DB User row and 215 had
 * a User row but no Subscription. This script walks the Clerk user list
 * and calls `ensureUserAndSubscription` for each — idempotent, so safe to
 * re-run.
 *
 * Usage:
 *   DATABASE_URL=... CLERK_SECRET_KEY=... npx tsx scripts/migrations/backfill-clerk-user-sync.ts
 *   DATABASE_URL=... CLERK_SECRET_KEY=... npx tsx scripts/migrations/backfill-clerk-user-sync.ts --dry-run
 *   DATABASE_URL=... CLERK_SECRET_KEY=... npx tsx scripts/migrations/backfill-clerk-user-sync.ts --limit=50
 *
 * Or via the shell wrapper that fetches secrets from GCP Secret Manager:
 *   ./scripts/migrations/backfill-clerk-user-sync.sh qa
 *   ./scripts/migrations/backfill-clerk-user-sync.sh prod --dry-run
 */

import "dotenv/config";
import { prisma } from "@usemoney/database";
import {
  ensureUserAndSubscription,
  countMissingSubscriptions,
} from "@usemoney/services";

interface ClerkUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email_addresses: Array<{ id: string; email_address: string }>;
  primary_email_address_id: string | null;
}

interface CliArgs {
  dryRun: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  return {
    dryRun: argv.includes("--dry-run"),
    limit: limitArg ? parseInt(limitArg.split("=")[1], 10) : null,
  };
}

const CLERK_API = "https://api.clerk.com/v1";
const PAGE_SIZE = 100;

async function fetchClerkUsersPage(
  secretKey: string,
  offset: number,
): Promise<ClerkUser[]> {
  const res = await fetch(
    `${CLERK_API}/users?limit=${PAGE_SIZE}&offset=${offset}`,
    {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Clerk API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ClerkUser[];
}

function getPrimaryEmail(u: ClerkUser): string | null {
  if (!u.email_addresses?.length) return null;
  if (u.primary_email_address_id) {
    const primary = u.email_addresses.find(
      (e) => e.id === u.primary_email_address_id,
    );
    if (primary) return primary.email_address;
  }
  return u.email_addresses[0].email_address;
}

function getFullName(u: ClerkUser): string {
  const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
  return name || "Trader";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const clerkSecret = process.env.CLERK_SECRET_KEY;
  if (!clerkSecret) {
    console.error("CLERK_SECRET_KEY env var is required");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL env var is required");
    process.exit(1);
  }

  console.log("Clerk → DB user/subscription backfill (MONEY-144)");
  console.log(`Mode: ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  if (args.limit) console.log(`Limit: ${args.limit}`);
  console.log("=".repeat(60));

  // Pre-flight: count current drift
  const dbUserCount = await prisma.user.count();
  const missingSubsBefore = await countMissingSubscriptions();
  console.log(`Pre-flight: ${dbUserCount} users in DB, ${missingSubsBefore} missing Subscription`);

  // Stream Clerk users page by page
  let offset = 0;
  let totalClerk = 0;
  let usersCreated = 0;
  let subscriptionsCreated = 0;
  let alreadySynced = 0;
  let failed = 0;
  const failures: Array<{ email: string; error: string }> = [];

  while (true) {
    const page = await fetchClerkUsersPage(clerkSecret, offset);
    if (page.length === 0) break;

    for (const cu of page) {
      totalClerk++;
      if (args.limit && totalClerk > args.limit) break;

      const email = getPrimaryEmail(cu);
      if (!email) {
        console.warn(`  ✗ ${cu.id} — no email, skip`);
        failed++;
        continue;
      }
      const name = getFullName(cu);

      if (args.dryRun) {
        // Just check whether we'd create anything
        const existingUser = await prisma.user.findUnique({
          where: { clerkId: cu.id },
          select: { id: true, subscription: { select: { id: true } } },
        });
        if (!existingUser) {
          usersCreated++;
          subscriptionsCreated++;
          console.log(`  [dry] would CREATE user+sub: ${email}`);
        } else if (!existingUser.subscription) {
          subscriptionsCreated++;
          console.log(`  [dry] would CREATE subscription: ${email}`);
        } else {
          alreadySynced++;
        }
        continue;
      }

      const result = await ensureUserAndSubscription({
        clerkId: cu.id,
        email,
        name,
      });
      if (!result.success) {
        failed++;
        failures.push({ email, error: result.error ?? "unknown" });
        console.error(`  ✗ ${email}: ${result.error}`);
        continue;
      }
      const { created } = result.data;
      if (created.user) usersCreated++;
      if (created.subscription) subscriptionsCreated++;
      if (!created.user && !created.subscription) alreadySynced++;
      if (created.user || created.subscription) {
        console.log(
          `  ✓ ${email} userCreated=${created.user} subCreated=${created.subscription}`,
        );
      }
    }

    if (args.limit && totalClerk >= args.limit) break;
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log("=".repeat(60));
  console.log(`Total Clerk users scanned: ${totalClerk}`);
  console.log(`Users created:             ${usersCreated}`);
  console.log(`Subscriptions created:     ${subscriptionsCreated}`);
  console.log(`Already in sync:           ${alreadySynced}`);
  console.log(`Failed:                    ${failed}`);

  if (failures.length > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  ${f.email}: ${f.error}`));
  }

  if (!args.dryRun) {
    const missingSubsAfter = await countMissingSubscriptions();
    console.log(
      `\nPost-flight: ${missingSubsAfter} users still missing Subscription (was ${missingSubsBefore})`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("Backfill failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
