#!/usr/bin/env tsx
/**
 * `candles` holds rows that violate its own unique key. MONEY-1481.
 *
 * ## THE SYMPTOM, AND WHY IT BLOCKS EVERY DEVELOPER
 *
 * `prisma db push` — which `yarn dev` runs on every start — cannot build the
 * index the schema declares:
 *
 *   [+] Unique index `candles_symbol_exchange_timeframe_ts_key`
 *       on ({"symbol":1,"exchange":1,"timeframe":1,"ts":1})
 *   E11000 duplicate key error: dup key:
 *       { symbol: "DIA", exchange: "NYSE", timeframe: "M1",
 *         ts: new Date(1789763760000) }
 *
 * So `yarn dev` exits non-zero for everyone until this is cleared.
 *
 * ## WHERE THE DUPLICATES COME FROM
 *
 * `Candle` is `@@unique([symbol, exchange, timeframe, ts])` and TWO writers
 * reach M1 for a US symbol: the Tiingo realtime sink (`TIINGO_RT`, quote-mid
 * bars with a structural `volume: 0`) and the Databento append (`DATABENTO`,
 * trade-derived with real volume). `mayWriteIntoDay` exists precisely to keep
 * ONE source per (symbol, timeframe, session) — and the timestamp above,
 * 2026-09-18 20:36 UTC, is inside a US session where both are live.
 *
 * The index was never built, so nothing ever refused the second write.
 *
 * ## WHAT THIS DOES
 *
 * Keeps ONE row per key, chosen by the repo's OWN declared precedence
 * (`PRICE_SOURCE_AUTHORITY`: BHAVCOPY 100 > TIINGO 60 > DATABENTO 55 >
 * ZERODHA 50 > TIINGO_RT 20 > YAHOO 10 > unknown 1), and deletes the rest.
 * That is not an arbitrary tie-break: it is the same ordering `writeCash` and
 * `shouldUpgradePriceSource` already apply, so the survivor is the row the
 * platform would have kept had the index existed.
 *
 * TIES are broken by the LATEST `_id`, because a second write of the same
 * source is a correction of the first.
 *
 * ## SAFETY
 *
 *   - DRY RUN by default. It reports and writes nothing.
 *   - `--apply` requires a TTY and a typed "yes", and echoes the masked host
 *     first — the same discipline as `set-market-data-flags.ts`. `--yes` is the
 *     NON-INTERACTIVE consent for an operator or agent running it on someone's
 *     behalf; it must be typed alongside `--apply`, so it is two deliberate
 *     acts rather than a bypass.
 *   - It NEVER deletes a group it cannot rank: if every row in a group has the
 *     same authority AND the same `_id` ordering cannot be established, the
 *     group is REPORTED and skipped rather than guessed at.
 *
 * ## Usage
 *
 *   npx tsx scripts/data/dedupe-candles.ts                 # report only
 *   npx tsx scripts/data/dedupe-candles.ts --timeframe=M1  # narrow the scan
 *   npx tsx scripts/data/dedupe-candles.ts --apply         # delete losers (TTY prompt)
 *   npx tsx scripts/data/dedupe-candles.ts --apply --yes   # ...non-interactively
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  candleDedupeLosers,
  type DedupeRow,
} from "../../packages/core/src/market-data/candles/dedupe-logic";

type Row = DedupeRow;
interface Group {
  _id: { symbol: string; exchange: string; timeframe: string; ts: Date };
  rows: Row[];
}

function maskedHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable>";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const tf = args.find((a) => a.startsWith("--timeframe="))?.split("=")[1];

  const prisma = new PrismaClient();
  const url = process.env.DATABASE_URL ?? "";
  console.log(`\ncandles dedupe — ${maskedHost(url)}${tf ? ` (timeframe=${tf})` : ""}`);
  console.log(apply ? "MODE: APPLY (will delete)" : "MODE: dry run (no writes)\n");

  const match = tf ? [{ $match: { timeframe: tf } }] : [];
  const groups = (await prisma.$runCommandRaw({
    aggregate: "candles",
    pipeline: [
      ...match,
      {
        $group: {
          _id: {
            symbol: "$symbol",
            exchange: "$exchange",
            timeframe: "$timeframe",
            ts: "$ts",
          },
          rows: { $push: { _id: "$_id", source: "$source" } },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ],
    cursor: { batchSize: 200_000 },
    allowDiskUse: true,
  })) as unknown as { cursor?: { firstBatch?: Group[]; id?: unknown } };

  const batch = groups.cursor?.firstBatch ?? [];
  // A NON-EXHAUSTED CURSOR IS A REFUSAL, not a partial result. Following it is
  // unsafe here: JS mangles Mongo's 64-bit cursor ids past MAX_SAFE_INTEGER
  // (MONEY-1479), and a half-read duplicate set would delete from some groups
  // and not others while reporting success.
  const cursorId = groups.cursor?.id;
  if (cursorId !== undefined && String(cursorId) !== "0") {
    console.error(
      `REFUSING: the aggregation returned a non-exhausted cursor (${String(cursorId)}).\n` +
        `Re-run with --timeframe=M1 (or another value) to narrow the scan.`,
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  if (batch.length === 0) {
    console.log("No duplicate keys. `db push` will build the index cleanly.");
    await prisma.$disconnect();
    return;
  }

  const byTf = new Map<string, number>();
  const bySrcPair = new Map<string, number>();
  let extra = 0;
  const unrankable: Group[] = [];
  const toDelete: unknown[] = [];

  for (const g of batch) {
    const losers = candleDedupeLosers(g.rows);
    if (losers === null) {
      unrankable.push(g);
      continue;
    }
    extra += losers.length;
    byTf.set(g._id.timeframe, (byTf.get(g._id.timeframe) ?? 0) + losers.length);
    const pair = [...new Set(g.rows.map((r) => r.source ?? "null"))].sort().join(" + ");
    bySrcPair.set(pair, (bySrcPair.get(pair) ?? 0) + 1);
    for (const l of losers) toDelete.push(l._id);
  }

  console.log(`duplicate KEYS      : ${batch.length}`);
  console.log(`rows to delete      : ${extra}`);
  console.log(`unrankable groups   : ${unrankable.length} (skipped, never guessed)`);
  console.log("\nby timeframe:");
  for (const [k, v] of [...byTf].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(6)} ${v}`);
  }
  console.log("\nby source pair (which writers collided):");
  for (const [k, v] of [...bySrcPair].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }

  if (!apply) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to delete.");
    await prisma.$disconnect();
    return;
  }

  // `--yes` is the NON-INTERACTIVE consent, for an operator or an agent running
  // this on someone's behalf. It is a separate flag from `--apply` on purpose:
  // `--apply` says WHAT to do, `--yes` says "I have already read the dry run".
  // Passing both is two deliberate acts, which is the same bar the interactive
  // prompt sets — not a bypass of it.
  const preConsented = args.includes("--yes");
  if (!preConsented && !process.stdin.isTTY) {
    console.error(
      "\n--apply needs a TTY (it asks for confirmation), or --yes to confirm " +
        "non-interactively after reading the dry run.",
    );
    await prisma.$disconnect();
    process.exit(1);
  }
  if (!preConsented) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nDelete ${extra} row(s) from candles on ${maskedHost(url)}? type "yes": `,
  );
  rl.close();
  if (answer.trim() !== "yes") {
    console.log("Aborted.");
    await prisma.$disconnect();
    return;
  }
  }

  // Deleted in chunks: one 100k-element `$in` is a document-size risk and an
  // unbounded lock window.
  const CHUNK = 1_000;
  let done = 0;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const slice = toDelete.slice(i, i + CHUNK);
    // `$runCommandRaw` takes `InputJsonValue`, and the ids came back from an
    // aggregation as `unknown` (they are Mongo ObjectId wire objects). Cast the
    // COMMAND once rather than asserting a shape for the ids themselves — the
    // driver round-trips them unchanged, and inventing a type for them here
    // would be a claim about the wire format this script does not need to make.
    await prisma.$runCommandRaw({
      delete: "candles",
      deletes: [{ q: { _id: { $in: slice } }, limit: 0 }],
    } as unknown as Parameters<typeof prisma.$runCommandRaw>[0]);
    done += slice.length;
    console.log(`  deleted ${done}/${toDelete.length}`);
  }
  console.log("\nDone. Re-run `yarn workspace @usemoney/database db:push`.");
  await prisma.$disconnect();
}

/**
 * RUN ONLY WHEN INVOKED DIRECTLY.
 *
 * An unguarded `main()` executes on IMPORT, so `losersOf` — the pure function
 * that decides which row gets DELETED — could not be imported by a test at all:
 * the module connected to Mongo, ran, and exited before its exports resolved.
 * A delete rule nothing can execute is a delete rule nothing can check, which
 * is how the `[object Object]` tie-break shipped and ran.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
