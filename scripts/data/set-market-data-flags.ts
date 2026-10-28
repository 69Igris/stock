/**
 * Read and set the market-data PlatformConfig flags. MONEY-1469 / MONEY-1470.
 *
 * Three rows gate the data-platform cutover, and all three are `Json` columns
 * whose VALUE SHAPE decides the outcome:
 *
 *   MARKET_DATA_TILES      A3 — the chart's /udf origin
 *   MARKET_DATA_QUOTES     A4 — the quote poller's origin
 *   MARKET_DATA_INTRADAY   A5 — WHICH PLAN TIERS may read intraday bars
 *
 * ## WHY THIS EXISTS RATHER THAN A MONGO ONE-LINER
 *
 * Every one of these fails SAFE, which means a wrong value is SILENT: it reads
 * as "off" / "nobody" and the platform keeps working exactly as before. An
 * operator who typed `{"enabled":true}` into `MARKET_DATA_INTRADAY` would see a
 * row, see `true`, and get nothing — because a bare boolean cannot say WHICH
 * tiers and is deliberately refused rather than read as "everyone".
 *
 * So this prints the RESOLVED EFFECT, computed by the same pure functions the
 * app calls, next to the raw value. The number that matters is what the app
 * will make of the row, not what is in it.
 *
 * ## Safety
 *
 *   - READ-ONLY by default. It prints all three rows for the target env.
 *   - `--apply` is required to write, needs a TTY, echoes the masked host and
 *     asks for "yes" — not keyed on `--env`, because the documented
 *     `DATABASE_URL=… --apply` form leaves `--env` null and would bypass an
 *     `--env`-keyed check entirely (the MONEY-1093 finding).
 *   - It prints the BEFORE and AFTER effect for every change, so a flip that
 *     resolves to the same thing is visible as a no-op rather than assumed.
 *
 * ## Usage
 *
 *   # read (safe, no writes)
 *   npx tsx scripts/data/set-market-data-flags.ts --env qa
 *   npx tsx scripts/data/set-market-data-flags.ts --env prod
 *
 *   # rehearse a change — prints before/after effect, writes nothing
 *   npx tsx scripts/data/set-market-data-flags.ts --env qa --quotes on
 *   npx tsx scripts/data/set-market-data-flags.ts --env qa --intraday PRO,PREMIUM,ULTIMATE
 *
 *   # write (interactive)
 *   npx tsx scripts/data/set-market-data-flags.ts --env qa --quotes on --apply
 *
 *   Options
 *     --env <qa|prod>        fetch DATABASE_URL from GCP Secret Manager
 *     --quotes <on|off>      MARKET_DATA_QUOTES
 *     --tiles <on|off>       MARKET_DATA_TILES
 *     --intraday <CSV|off>   MARKET_DATA_INTRADAY — tier names, e.g. PRO,PREMIUM
 *     --apply                actually write
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { PrismaClient } from "@prisma/client";

import {
  MARKET_DATA_TILES_FLAG,
  isTilesFlagEnabled,
} from "../../packages/core/src/market-data/udf/datafeed-target";
import {
  MARKET_DATA_QUOTES_FLAG,
  isQuotesFlagEnabled,
} from "../../packages/core/src/market-data/quotes/quotes-target";
import {
  MARKET_DATA_INTRADAY_FLAG,
  intradayTiers,
} from "../../packages/core/src/market-data/intraday/intraday-entitlement";

const GCP_PROJECT = "stock-book-483718";

function databaseUrlForEnv(env: "qa" | "prod"): string {
  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    ["secrets", "versions", "access", "latest", `--secret=${secret}`, `--project=${GCP_PROJECT}`],
    { encoding: "utf8", env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" } },
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/** Host only. `URL` keeps credentials in username/password, never in `host`. */
function maskedHost(uri: string): string | null {
  try {
    return new URL(uri).host || null;
  } catch {
    const authority = uri.replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    return (at >= 0 ? authority.slice(at + 1) : authority).trim() || null;
  }
}

/** What the APP will make of a stored value — the number that matters. */
function effectOf(key: string, value: unknown): string {
  if (key === MARKET_DATA_TILES_FLAG) {
    return isTilesFlagEnabled(value)
      ? "chart reads /udf from the market-data SERVICE"
      : "chart reads /api/market/udf (legacy web route)";
  }
  if (key === MARKET_DATA_QUOTES_FLAG) {
    return isQuotesFlagEnabled(value)
      ? "quote poller reads the market-data SERVICE"
      : "quote poller reads /api/market/quote (legacy web route)";
  }
  const tiers = intradayTiers(value);
  return tiers.length === 0
    ? "intraday: NOBODY (a bare `true` is refused — it cannot say which tiers)"
    : `intraday allowed for: ${tiers.join(", ")}`;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const take = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const env = take("--env");
  if (env !== null && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be qa or prod (got ${env})`);
  }
  return {
    env: env as "qa" | "prod" | null,
    apply: argv.includes("--apply"),
    quotes: take("--quotes"),
    tiles: take("--tiles"),
    intraday: take("--intraday"),
  };
}

/** `on`/`off` -> the value we store. Anything else is refused, not guessed. */
function booleanValue(raw: string, flag: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true") return true;
  if (v === "off" || v === "false") return false;
  throw new Error(`${flag} takes on|off (got "${raw}")`);
}

/**
 * The plan ids a tier list may name — `BasePlan` in
 * `packages/services/src/subscription-logic.ts`, which is what the token
 * minter compares against.
 *
 * FREE is accepted, because "everyone signed in" is a legitimate thing to
 * choose deliberately; it just has to be typed out rather than implied.
 */
const KNOWN_TIERS = ["FREE", "PRO", "PREMIUM", "ULTIMATE"];

/**
 * `PRO,PREMIUM` -> `{tiers:[…]}`; `off` -> `{enabled:false}` (the rollback).
 *
 * UNKNOWN TIERS ARE REFUSED. `--intraday true` parsed to `{tiers:["TRUE"]}`,
 * which matches no plan — so the row granted nothing while this script cheerily
 * reported "intraday allowed for: TRUE". That is the exact
 * looks-configured-does-nothing failure the script exists to prevent, rebuilt
 * inside it.
 */
function intradayValue(raw: string): { tiers: string[] } | { enabled: false } {
  const v = raw.trim();
  if (v.toLowerCase() === "off") return { enabled: false };
  const tiers = v
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (tiers.length === 0) {
    throw new Error("--intraday takes a tier CSV (e.g. PRO,PREMIUM) or `off`");
  }
  const unknown = tiers.filter((t) => !KNOWN_TIERS.includes(t));
  if (unknown.length > 0) {
    throw new Error(
      `unknown plan tier(s): ${unknown.join(", ")}. ` +
        `Valid: ${KNOWN_TIERS.join(", ")}, or \`off\` to revoke. ` +
        "A tier that matches no plan grants nothing while looking configured.",
    );
  }
  return { tiers };
}

async function confirmWrite(uri: string, envLabel: string, changes: string[]): Promise<void> {
  const host = maskedHost(uri);
  if (!host) {
    // REFUSE rather than show a placeholder the operator cannot check.
    throw new Error("could not determine the target host; refusing to prompt");
  }
  if (!process.stdin.isTTY) {
    throw new Error("--apply needs an interactive terminal");
  }
  console.log(`\nAbout to WRITE to ${envLabel} (${host}):`);
  for (const c of changes) console.log(`   ${c}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nType "yes" to continue: ');
  rl.close();
  if (answer.trim() !== "yes") throw new Error("aborted");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const uri = args.env ? databaseUrlForEnv(args.env) : process.env.DATABASE_URL;
  if (!uri) throw new Error("pass --env <qa|prod> or set DATABASE_URL");
  const envLabel = args.env ?? "DATABASE_URL";

  const prisma = new PrismaClient({ datasources: { db: { url: uri } } });
  try {
    const keys = [MARKET_DATA_TILES_FLAG, MARKET_DATA_QUOTES_FLAG, MARKET_DATA_INTRADAY_FLAG];
    const rows = await prisma.platformConfig.findMany({ where: { key: { in: keys } } });
    const current = new Map(rows.map((r) => [r.key, r.value as unknown]));

    console.log(`\nmarket-data flags — ${envLabel} (${maskedHost(uri) ?? "?"})\n`);
    for (const key of keys) {
      const has = current.has(key);
      const value = current.get(key);
      console.log(`${key}`);
      console.log(`   stored : ${has ? JSON.stringify(value) : "(no row)"}`);
      console.log(`   effect : ${effectOf(key, has ? value : undefined)}\n`);
    }

    const pending: { key: string; value: unknown }[] = [];
    if (args.tiles !== null) {
      pending.push({ key: MARKET_DATA_TILES_FLAG, value: booleanValue(args.tiles, "--tiles") });
    }
    if (args.quotes !== null) {
      pending.push({ key: MARKET_DATA_QUOTES_FLAG, value: booleanValue(args.quotes, "--quotes") });
    }
    if (args.intraday !== null) {
      pending.push({ key: MARKET_DATA_INTRADAY_FLAG, value: intradayValue(args.intraday) });
    }
    if (pending.length === 0) {
      console.log("No changes requested — read-only run.");
      return;
    }

    // BEFORE and AFTER, both as EFFECT. A flip that resolves to the same thing
    // is then visible as a no-op rather than assumed to have done something.
    const changes = pending.map(({ key, value }) => {
      const before = effectOf(key, current.get(key));
      const after = effectOf(key, value);
      return `${key} = ${JSON.stringify(value)}\n      before: ${before}\n      after : ${after}`;
    });

    if (!args.apply) {
      console.log("DRY RUN — nothing written. Re-run with --apply.\n");
      for (const c of changes) console.log(`   ${c}\n`);
      return;
    }

    await confirmWrite(uri, envLabel, changes);
    for (const { key, value } of pending) {
      await prisma.platformConfig.upsert({
        where: { key },
        create: { key, value: value as never },
        update: { value: value as never },
      });
      console.log(`   wrote ${key}`);
    }
    console.log("\nDone. The app re-reads these within 30s (no deploy needed).");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
