/**
 * Repair undrawable OHLC rows in `daily_prices` — MONEY-1175 step 3.
 *
 * ## Why a migration and not a re-parse
 *
 * The census (scripts/data/audit-ohlc-violations.ts) found 53,069 undrawable
 * rows. The biggest class is cured by the MONEY-1175 re-parse, but 6,253 of
 * them are NOT, and it matters why: they come from NSE's own 1995-96 files,
 * where the exchange populated `OPEN` with `PREVCLOSE` verbatim. Verified
 * against the archived bytes —
 *
 *     cm05OCT1995: ACC,EQ,3338.35,3450,3341,3386.55,0.0,3338.35   OPEN == PREVCLOSE
 *     cm02JUN1997: ACC,EQ,1080,1094,1067.65,1079.45,0.0,1070.45   OPEN != PREVCLOSE
 *
 * — which is why the violations stop dead at the 1997 format change. Our parser
 * reads the column correctly, so re-parsing reproduces these rows byte for
 * byte. Only a post-hoc repair can fix them.
 *
 * ## Two causes, two repairs
 *
 *   open is a DIFFERENT QUANTITY (NSE prev-close, Yahoo's literal 0)
 *       -> clampCandleOpen: rebuild `open` from [low, high], touch nothing else.
 *          Widening the range here would assert a trade at yesterday's price.
 *
 *   the RANGE was under-reported (Yahoo's open==high==low with a real close)
 *       -> widenCandleRange: stretch low/high to span the observed prices.
 *          Clamping here would discard a real price we were given.
 *
 * Choosing per row rather than per table is the entire point; a single blanket
 * repair would corrupt whichever class it was not designed for.
 *
 * Rows whose high/low/close are themselves unusable are NOT repaired — there is
 * no trustworthy range to rebuild from. They are counted and listed so the
 * decision to delete them stays a human one.
 *
 * Usage:
 *   node --import tsx scripts/migrations/repair-daily-price-candles.ts
 *   node --import tsx scripts/migrations/repair-daily-price-candles.ts --apply
 *   node --import tsx scripts/migrations/repair-daily-price-candles.ts --apply --source=BHAVCOPY_HIST
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";
import {
  classifyCandle,
  repairCandle,
  type Candle,
  type CandleDefect,
} from "@usemoney/core/market-data";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const APPLY = argv.includes("--apply");
const SOURCE = arg("source");
const BATCH = Number(arg("batch") ?? 1000) || 1000;

const log = (...a: unknown[]) => console.log("[repair-candles]", ...a);

interface BadRow {
  _id: { $oid: string };
  date: { $date: string };
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

const IS_BAD = {
  $or: [
    { $not: { $gt: ["$open", 0] } },
    { $not: { $gt: ["$high", 0] } },
    { $not: { $gt: ["$low", 0] } },
    { $not: { $gt: ["$close", 0] } },
    { $gt: ["$low", "$high"] },
    { $lt: ["$open", "$low"] },
    { $gt: ["$open", "$high"] },
    { $lt: ["$close", "$low"] },
    { $gt: ["$close", "$high"] },
    {
      $and: [
        { $eq: ["$open", "$high"] },
        { $eq: ["$high", "$low"] },
        { $ne: ["$close", "$open"] },
      ],
    },
  ],
};

async function main(): Promise<void> {
  const match: Record<string, unknown> = { $expr: IS_BAD };
  if (SOURCE) match.source = SOURCE;

  const res = (await prisma.$runCommandRaw({
    aggregate: "daily_prices",
    pipeline: [
      { $match: match },
      {
        $project: {
          date: 1,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          source: 1,
        },
      },
    ],
    cursor: { batchSize: 100_000 },
    allowDiskUse: true,
  })) as { cursor: { firstBatch: BadRow[] } };

  const bad = res.cursor.firstBatch;
  log(
    `found ${bad.length.toLocaleString()} undrawable row(s)` +
      `${SOURCE ? ` (source=${SOURCE})` : ""} — mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  if (bad.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const updates: Array<{ id: string; c: Candle }> = [];
  const byDefect = new Map<CandleDefect, number>();
  const unrepairable: BadRow[] = [];

  for (const r of bad) {
    const c: Candle = { open: r.open, high: r.high, low: r.low, close: r.close };
    const defect = classifyCandle(c);
    byDefect.set(defect, (byDefect.get(defect) ?? 0) + 1);

    // Same dispatch the ingest path uses, so a later re-parse cannot undo this.
    const fixed = repairCandle(c);
    if (!fixed) {
      unrepairable.push(r);
      continue;
    }
    updates.push({ id: r._id.$oid, c: fixed });
  }

  log("defects:");
  for (const [d, n] of [...byDefect].sort((a, b) => b[1] - a[1])) {
    log(`   ${d.padEnd(16)} ${n.toLocaleString()}`);
  }
  log(
    `repairable ${updates.length.toLocaleString()}, ` +
      `UNREPAIRABLE ${unrepairable.length.toLocaleString()}`,
  );
  for (const r of unrepairable.slice(0, 5)) {
    log(
      `   unrepairable: ${r.date.$date.slice(0, 10)} o=${r.open} h=${r.high} ` +
        `l=${r.low} c=${r.close} [${r.source}]`,
    );
  }

  if (!APPLY) {
    log("dry-run: pass --apply to write. Nothing changed.");
    const sample = updates.slice(0, 3);
    for (const u of sample) {
      const before = bad.find((b) => b._id.$oid === u.id)!;
      log(
        `   would fix ${before.date.$date.slice(0, 10)} ` +
          `o=${before.open} h=${before.high} l=${before.low} c=${before.close}` +
          `  ->  o=${u.c.open} h=${u.c.high} l=${u.c.low} c=${u.c.close}`,
      );
    }
    await prisma.$disconnect();
    return;
  }

  let modified = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    const out = (await prisma.$runCommandRaw({
      update: "daily_prices",
      updates: chunk.map(({ id, c }) => ({
        q: { _id: { $oid: id } },
        // OHLC only — `source`, volume and the delivery columns written by
        // other feeds into these same rows must survive a cosmetic repair.
        u: { $set: { open: c.open, high: c.high, low: c.low, close: c.close } },
        multi: false,
      })),
      ordered: false,
    })) as { nModified?: number };
    modified += out.nModified ?? 0;
  }

  // Re-count so the exit state is measured, not assumed.
  const after = (await prisma.$runCommandRaw({
    count: "daily_prices",
    query: match,
  })) as { n?: number };

  log(
    `DONE: modified ${modified.toLocaleString()}; ` +
      `undrawable rows remaining ${(after.n ?? 0).toLocaleString()} ` +
      `(expected ${unrepairable.length.toLocaleString()} unrepairable)`,
  );
  if ((after.n ?? 0) > unrepairable.length) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[repair-candles] failed:", err);
  process.exitCode = 1;
});
