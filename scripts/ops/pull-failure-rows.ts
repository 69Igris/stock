/**
 * pull-failure-rows.ts — READ-ONLY pull of broker_integration_failures
 * for the Boundless × Anthropic Depth submission (BAD-7 / MONEY-512).
 *
 * Prints markdown you can paste straight back: counts by errorClass,
 * the 5 most recent rows per class, plus the two special buckets the
 * failure log needs — AI-layer faults (claudeSessionId set) and
 * VALIDATION/UNKNOWN rows.
 *
 * Resolves DATABASE_URL the same way as seed-env.sh: a qa/prod target
 * fetches DATABASE_URL_QA / DATABASE_URL_PROD from GCP Secret Manager.
 *
 * Prerequisites (qa/prod targets): gcloud CLI installed + authenticated.
 *
 * Usage:
 *   yarn tsx scripts/ops/pull-failure-rows.ts qa                # QA database
 *   yarn tsx scripts/ops/pull-failure-rows.ts prod              # Production
 *   yarn tsx scripts/ops/pull-failure-rows.ts prod --days 14    # custom window
 *   yarn tsx scripts/ops/pull-failure-rows.ts --url "mongodb+srv://…"
 *   DATABASE_URL="…" yarn tsx scripts/ops/pull-failure-rows.ts  # env-var fallback
 *
 * No writes anywhere in this file.
 */

import { execFileSync } from "node:child_process";
import { MongoClient } from "mongodb";

const PROJECT_ID = "stock-book-483718"; // same as seed-env.sh / test-env.sh

// ── arg parsing (seed-env.sh conventions: positional target + flags) ──
let target: "qa" | "prod" | null = null;
let directUrl: string | null = null;
let days = 21;
let dbName: string | null = null;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "qa":
    case "prod":
      target = argv[i] as "qa" | "prod";
      break;
    case "--url":
      directUrl = argv[++i] ?? null;
      break;
    case "--days":
      days = Number(argv[++i]) || 21;
      break;
    case "--db":
      dbName = argv[++i] ?? null;
      break;
    default:
      console.error(`Unknown argument: ${argv[i]}`);
      usageAndExit();
  }
}

function usageAndExit(): never {
  console.error(
    [
      'Usage: yarn tsx scripts/ops/pull-failure-rows.ts [qa|prod] [--days N]',
      '       yarn tsx scripts/ops/pull-failure-rows.ts --url "mongodb+srv://…" [--days N]',
      "",
      "  qa | prod    Fetch DATABASE_URL_QA / DATABASE_URL_PROD from GCP Secret Manager",
      "  --url URL    Use a direct MongoDB connection string",
      "  --days N     Lookback window in days (default 21)",
      "",
      "  Fallback: a plain DATABASE_URL env var is used when no target/--url given.",
    ].join("\n"),
  );
  process.exit(1);
}

function resolveDatabaseUrl(): { url: string; label: string } {
  if (directUrl) return { url: directUrl, label: "direct --url" };

  if (target) {
    const secret = target === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
    try {
      const url = execFileSync(
        "gcloud",
        ["secrets", "versions", "access", "latest", `--secret=${secret}`, `--project=${PROJECT_ID}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (!url) throw new Error("empty secret");
      return { url, label: target.toUpperCase() };
    } catch {
      console.error(`Failed to fetch ${secret} from GCP Secret Manager. Check:`);
      console.error(`  gcloud secrets versions list ${secret} --project=${PROJECT_ID}`);
      console.error(`  gcloud auth login   (if not authenticated)`);
      process.exit(1);
    }
  }

  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, label: "env DATABASE_URL" };
  usageAndExit();
}

interface FailureRow {
  userIdHash: string;
  broker: string;
  operation: string;
  errorClass: string;
  errorCode?: string | null;
  userFacingMessage: string;
  recoveryAction?: string | null;
  claudeSessionId?: string | null;
  createdAt: Date;
}

function fmt(r: FailureRow): string {
  const d = r.createdAt.toISOString().replace("T", " ").slice(0, 16);
  return [
    `  - **${d}** · ${r.broker} · \`${r.operation}\` · code=\`${r.errorCode ?? "—"}\``,
    `    recovery=\`${r.recoveryAction ?? "—"}\` · ai-session=${r.claudeSessionId ? `\`${r.claudeSessionId.slice(0, 12)}…\`` : "no"} · user=\`${r.userIdHash.slice(0, 8)}…\``,
    `    userFacingMessage: "${r.userFacingMessage}"`,
  ].join("\n");
}

async function main() {
  const { url, label } = resolveDatabaseUrl();
  const client = new MongoClient(url);
  await client.connect();
  try {
    const db = dbName ? client.db(dbName) : client.db();
    const col = db.collection<FailureRow>("broker_integration_failures");
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await col
      .find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .toArray();

    console.log(
      `# Failure pull — env: ${label} · db: ${db.databaseName} · last ${days}d · ${rows.length} rows · generated ${new Date().toISOString().slice(0, 10)}\n`,
    );

    // ── diagnostics when empty: are we even looking at the right database? ──
    if (rows.length === 0) {
      const total = await col.countDocuments({});
      console.log(`## Diagnostics (0 rows in window)\n`);
      console.log(`- collection total ignoring date filter: **${total}**`);
      const colls = await db.listCollections().toArray();
      console.log(`- db \`${db.databaseName}\` has ${colls.length} collections${colls.length ? ":" : ""}`);
      colls.slice(0, 25).forEach((c) => console.log(`    - ${c.name}`));
      try {
        const { databases } = await client.db().admin().listDatabases();
        console.log(`- databases on this cluster (→ rerun with \`--db <name>\` if the app writes elsewhere):`);
        databases.forEach((d) => console.log(`    - ${d.name} (${Math.round((d.sizeOnDisk ?? 0) / 1024 / 1024)} MB)`));
      } catch {
        console.log(`- (no privilege to list databases — check the db path in the URI vs Vercel's DATABASE_URL)`);
      }
      return;
    }

    // 1 · counts by errorClass
    const byClass = new Map<string, FailureRow[]>();
    for (const r of rows) {
      (byClass.get(r.errorClass) ?? byClass.set(r.errorClass, []).get(r.errorClass)!).push(r);
    }
    console.log("## Counts by errorClass\n");
    for (const [cls, list] of [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`- **${cls}** — ${list.length}`);
    }

    // 2 · per-class samples (5 most recent each)
    console.log("\n## Samples per class (5 most recent each)\n");
    for (const [cls, list] of byClass) {
      console.log(`### ${cls} (${list.length} total)\n`);
      list.slice(0, 5).forEach((r) => console.log(fmt(r) + "\n"));
    }

    // 3 · AI-layer faults — skeleton #4 wants ≥1 of these
    const ai = rows.filter((r) => r.claudeSessionId);
    console.log(`\n## AI-layer faults (claudeSessionId set) — ${ai.length} rows · feeds Failure #4\n`);
    ai.slice(0, 10).forEach((r) => console.log(fmt(r) + "\n"));

    // 4 · VALIDATION / UNKNOWN — feeds Failure #5
    const odd = rows.filter((r) => r.errorClass === "VALIDATION" || r.errorClass === "UNKNOWN");
    console.log(`\n## VALIDATION / UNKNOWN — ${odd.length} rows · feeds Failure #5\n`);
    odd.slice(0, 10).forEach((r) => console.log(fmt(r) + "\n"));
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
