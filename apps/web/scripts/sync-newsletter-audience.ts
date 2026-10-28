/**
 * Sync all registered users to the Resend newsletter audience.
 *
 * Reads every User row from MongoDB and upserts each into the
 * Resend newsletter audience configured for the current environment:
 *   dev / qa  →  fface17c-b20c-4798-92bc-8ed48f267b45  (usemoney-newsletter-dev)
 *   prod      →  169f6d19-ec82-472f-9375-99e4fb0172c8  (usemoney-newsletter)
 *
 * The audience ID is controlled by RESEND_AUDIENCE_NEWSLETTER_ID in the
 * environment (loaded from apps/web/.env). `addToNewsletterAudience` is
 * idempotent — Resend returns success for contacts that already exist.
 *
 * Usage:
 *   RECOMMENDED (env-aware — resolves DATABASE_URL / RESEND keys per env from
 *   GCP Secret Manager, same pattern as seed-env.sh / trigger-resend-sync.sh):
 *     ./scripts/ops/sync-newsletter-audience.sh qa|prod|all [--dry-run] [--limit=N]
 *
 *   Direct (requires apps/web/.env pointed at the target env):
 *   npx tsx scripts/sync-newsletter-audience.ts
 *   npx tsx scripts/sync-newsletter-audience.ts --dry-run
 *   npx tsx scripts/sync-newsletter-audience.ts --limit=50
 *   npx tsx scripts/sync-newsletter-audience.ts --dry-run --limit=10
 *
 * Or via the workspace script:
 *   yarn workspace @usemoney/web tsx scripts/sync-newsletter-audience.ts
 *
 * Env (auto-loaded from apps/web/.env):
 *   DATABASE_URL                — required (MongoDB connection string)
 *   RESEND_AUDIENCE_NEWSLETTER_ID — required (abort if missing)
 *
 * CLI flags:
 *   --dry-run   List emails without calling the Resend API
 *   --limit=N   Process only the first N users (useful for smoke-testing)
 */

import "dotenv/config";
import path from "path";
// Ensure apps/web/.env is loaded when the script is invoked from any cwd
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: path.resolve(__dirname, "../.env"), override: false });

import { prisma } from "@usemoney/database";
import { addToNewsletterAudience } from "@usemoney/email";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  dryRun: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1] ?? "", 10) : null;
  return { dryRun, limit };
}

// ---------------------------------------------------------------------------
// Name splitting helper (matches the pattern used in newsletter/subscribe)
// ---------------------------------------------------------------------------

function splitName(name: string | null | undefined): {
  firstName: string | undefined;
  lastName: string | undefined;
} {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { firstName: undefined, lastName: undefined };
  const [first, ...rest] = trimmed.split(" ");
  return {
    firstName: first || undefined,
    lastName: rest.length > 0 ? rest.join(" ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Throttle helper — resolves after `ms` milliseconds
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dryRun, limit } = parseArgs(process.argv);

  const audienceId = process.env.RESEND_AUDIENCE_NEWSLETTER_ID;
  if (!audienceId) {
    console.error(
      "✗ RESEND_AUDIENCE_NEWSLETTER_ID is not set. " +
        "Set it in apps/web/.env (dev: fface17c-b20c-4798-92bc-8ed48f267b45 | " +
        "prod: 169f6d19-ec82-472f-9375-99e4fb0172c8) and re-run."
    );
    process.exit(1);
  }

  console.log("─────────────────────────────────────────────────────");
  console.log("  Resend Newsletter Audience Sync");
  console.log("─────────────────────────────────────────────────────");
  console.log(`  Audience ID : ${audienceId}`);
  console.log(`  Mode        : ${dryRun ? "DRY RUN (no API calls)" : "LIVE"}`);
  if (limit !== null) console.log(`  Limit       : ${limit} users`);
  console.log("─────────────────────────────────────────────────────\n");

  // Fetch users — only those with a valid, non-empty email
  const users = await prisma.user.findMany({
    where: {
      email: { not: "" },
      isActive: true,
    },
    select: {
      email: true,
      name: true,
    },
    ...(limit !== null && { take: limit }),
    orderBy: { createdAt: "asc" },
  });

  console.log(`Fetched ${users.length} active user(s) from the database.\n`);

  const startedAt = Date.now();
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of users) {
    const email = user.email.toLowerCase().trim();
    if (!email) {
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  (dry-run) ${email}`);
      synced++;
      continue;
    }

    const { firstName, lastName } = splitName(user.name);

    const result = await addToNewsletterAudience({
      email,
      firstName,
      lastName,
    });

    if (result.ok) {
      console.log(`  ✓ ${email}`);
      synced++;
    } else {
      console.log(`  ✗ ${email} — ${result.error ?? "unknown error"}`);
      failed++;
    }

    // Throttle: ~75 ms between calls — polite to Resend's rate limits
    await sleep(75);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("\n─────────────────────────────────────────────────────");
  console.log(
    `  synced ${synced} · skipped ${skipped} · failed ${failed} · elapsed ${elapsed}s`
  );
  console.log("─────────────────────────────────────────────────────\n");
}

main()
  .catch((err: unknown) => {
    console.error("\nFatal error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
