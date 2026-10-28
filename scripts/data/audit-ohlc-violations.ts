/**
 * OHLC invariant audit for `daily_prices` — MONEY-1175 step 3.
 *
 * ## What a "violation" is
 *
 * A candle is only drawable if `low <= min(open, close)` and
 * `high >= max(open, close)` and `low <= high`, with every price positive.
 * TradingView does not reject a malformed bar — it draws it, so a row where
 * `close < low` renders as a wick pointing the wrong way. These are silent
 * visual defects, which is why they need a census rather than spot checks.
 *
 * ## Why it classifies rather than just counts
 *
 * The remediation differs completely by cause:
 *
 *   DEGENERATE_FLAT   open == high == low but close differs. Not a real candle
 *                     at all — it is a single price copied into o/h/l with a
 *                     separate close. That is an INGEST shape bug (a source
 *                     that only gave us a close), fixable in code.
 *   LOW_GT_HIGH       low above high: columns are transposed or mis-mapped.
 *                     A parser bug, fixable in code, and the fix rides the
 *                     re-parse.
 *   OPEN_OUT/CLOSE_OUT o or c outside [low, high] while low <= high. Usually a
 *                     genuine exchange bad print — the exchange published it
 *                     that way. Not fixable by re-parsing; quarantine instead.
 *   NON_POSITIVE      a zero or negative price. Always garbage.
 *
 * Grouping by (source, era, class) is what tells us whether a fix belongs in a
 * parser (clustered in one source/era) or in a quarantine migration (scattered).
 *
 * Usage:
 *   node --import tsx scripts/data/audit-ohlc-violations.ts
 *   node --import tsx scripts/data/audit-ohlc-violations.ts --samples=5
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const SAMPLES = Number(arg("samples") ?? 3) || 3;

const log = (...a: unknown[]) => console.log(...a);

/**
 * Classification expression, evaluated inside Mongo so the whole audit is one
 * pass over the collection instead of streaming ~20M documents to the client.
 * Order matters — the first matching branch wins, so the most diagnostic
 * shapes are tested before the generic ones.
 */
const CLASSIFY = {
  $switch: {
    branches: [
      {
        case: {
          $or: [
            { $lte: ["$open", 0] },
            { $lte: ["$high", 0] },
            { $lte: ["$low", 0] },
            { $lte: ["$close", 0] },
          ],
        },
        then: "NON_POSITIVE",
      },
      {
        case: {
          $and: [
            { $eq: ["$open", "$high"] },
            { $eq: ["$high", "$low"] },
            { $ne: ["$close", "$open"] },
          ],
        },
        then: "DEGENERATE_FLAT",
      },
      { case: { $gt: ["$low", "$high"] }, then: "LOW_GT_HIGH" },
      {
        case: { $or: [{ $lt: ["$open", "$low"] }, { $gt: ["$open", "$high"] }] },
        then: "OPEN_OUT",
      },
      {
        case: {
          $or: [{ $lt: ["$close", "$low"] }, { $gt: ["$close", "$high"] }],
        },
        then: "CLOSE_OUT",
      },
    ],
    default: "OK",
  },
};

/** Any row failing at least one invariant. */
const IS_BAD = {
  $or: [
    { $lte: ["$open", 0] },
    { $lte: ["$high", 0] },
    { $lte: ["$low", 0] },
    { $lte: ["$close", 0] },
    { $gt: ["$low", "$high"] },
    { $lt: ["$open", "$low"] },
    { $gt: ["$open", "$high"] },
    { $lt: ["$close", "$low"] },
    { $gt: ["$close", "$high"] },
  ],
};

interface Bucket {
  _id: { source: string; year: number; klass: string };
  n: number;
}

async function main(): Promise<void> {
  const total = (await prisma.$runCommandRaw({ count: "daily_prices" })) as {
    n?: number;
  };
  log(`daily_prices total rows: ${(total.n ?? 0).toLocaleString()}`);
  log("scanning for OHLC invariant violations (one full pass)…\n");

  const res = (await prisma.$runCommandRaw({
    aggregate: "daily_prices",
    pipeline: [
      { $match: { $expr: IS_BAD } },
      {
        $group: {
          _id: {
            source: "$source",
            year: { $year: "$date" },
            klass: CLASSIFY,
          },
          n: { $sum: 1 },
        },
      },
      { $sort: { n: -1 } },
    ],
    cursor: { batchSize: 100_000 },
    allowDiskUse: true,
  })) as { cursor: { firstBatch: Bucket[] } };

  const buckets = res.cursor.firstBatch;
  const grand = buckets.reduce((s, b) => s + b.n, 0);
  log(
    `TOTAL VIOLATIONS: ${grand.toLocaleString()} of ${(total.n ?? 0).toLocaleString()} rows ` +
      `(${((grand / (total.n || 1)) * 100).toFixed(3)}%)\n`,
  );

  // ── by class ──
  const byClass = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byClassSource = new Map<string, number>();
  const yearsByClass = new Map<string, Set<number>>();
  for (const b of buckets) {
    byClass.set(b._id.klass, (byClass.get(b._id.klass) ?? 0) + b.n);
    bySource.set(b._id.source, (bySource.get(b._id.source) ?? 0) + b.n);
    const k = `${b._id.klass}|${b._id.source}`;
    byClassSource.set(k, (byClassSource.get(k) ?? 0) + b.n);
    (yearsByClass.get(b._id.klass) ?? yearsByClass.set(b._id.klass, new Set()).get(b._id.klass)!).add(b._id.year);
  }

  log("BY CLASS");
  for (const [k, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
    const years = [...(yearsByClass.get(k) ?? [])].sort();
    const span =
      years.length === 0
        ? ""
        : years.length === 1
          ? ` [${years[0]}]`
          : ` [${years[0]}..${years[years.length - 1]}, ${years.length} yrs]`;
    log(`  ${k.padEnd(16)} ${n.toLocaleString().padStart(9)}${span}`);
  }

  log("\nBY SOURCE");
  for (const [k, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
    log(`  ${k.padEnd(16)} ${n.toLocaleString().padStart(9)}`);
  }

  log("\nCLASS x SOURCE  (where the fix belongs)");
  for (const [k, n] of [...byClassSource].sort((a, b) => b[1] - a[1])) {
    const [klass, source] = k.split("|");
    log(`  ${(klass ?? "").padEnd(16)} ${(source ?? "").padEnd(16)} ${n.toLocaleString().padStart(9)}`);
  }

  // ── concentration by year, to spot a single-era parser bug ──
  log("\nTOP YEARS");
  const byYear = new Map<number, number>();
  for (const b of buckets) byYear.set(b._id.year, (byYear.get(b._id.year) ?? 0) + b.n);
  for (const [y, n] of [...byYear].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    log(`  ${y}  ${n.toLocaleString().padStart(9)}`);
  }

  // ── samples per class, for eyeballing against the archived bytes ──
  log("\nSAMPLES");
  for (const klass of byClass.keys()) {
    const s = (await prisma.$runCommandRaw({
      aggregate: "daily_prices",
      pipeline: [
        { $match: { $expr: { $and: [IS_BAD, { $eq: [CLASSIFY, klass] }] } } },
        { $limit: SAMPLES },
        {
          $lookup: {
            from: "instrument_mappings",
            localField: "instrumentId",
            foreignField: "_id",
            as: "inst",
          },
        },
        {
          $project: {
            _id: 0,
            date: 1,
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            source: 1,
            symbol: { $first: "$inst.symbol" },
            exchange: { $first: "$inst.exchange" },
          },
        },
      ],
      cursor: {},
    })) as {
      cursor: {
        firstBatch: Array<Record<string, unknown> & { date: { $date: string } }>;
      };
    };
    log(`  ${klass}`);
    for (const r of s.cursor.firstBatch) {
      log(
        `    ${String(r.symbol ?? "?").padEnd(12)} ${String(r.exchange ?? "?").padEnd(4)} ` +
          `${String(r.date.$date).slice(0, 10)}  o=${r.open} h=${r.high} l=${r.low} c=${r.close}  [${r.source}]`,
      );
    }
  }

  log("\nREADING THE RESULT");
  log("  concentrated in ONE source+era -> parser bug; fix rides the re-parse.");
  log("  spread across sources/eras     -> exchange bad prints; quarantine instead.");
  log("  DEGENERATE_FLAT on a live feed -> ingest shape bug, fix at the writer.");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[audit-ohlc] failed:", err);
  process.exitCode = 1;
});
