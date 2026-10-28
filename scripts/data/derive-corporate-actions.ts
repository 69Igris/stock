/**
 * Derive corporate actions from the price series — MONEY-1176.
 *
 * ## Why this exists alongside the feed backfill
 *
 * `corp-actions-backfill.ts` pulls the real thing from NSE and BSE, and where
 * it reaches, its rows are better: they carry the actual TYPE and ratio. But
 * NSE's corporate-actions API stops serving history around 2020 — measured
 * during the backfill, where the NSE leg plateaued at 5,634 rows while BSE kept
 * climbing — and BSE thins further back. `DailyPrice` reaches 1994-11-03.
 *
 * So this fills the tail the feeds cannot reach, and only the tail: every
 * candidate within a few days of a known feed action is discarded.
 *
 * ## Why it is trustworthy NOW and would not have been before
 *
 * The series is uniformly RAW since MONEY-1175. Before that it mixed raw
 * bhavcopy with split-ADJUSTED Yahoo, so a ratio jump was as likely to be the
 * source flipping as a real split. With one basis, a clean rational jump is a
 * real event.
 *
 * ## It does not guess the TYPE
 *
 * A factor of exactly 2 is equally a 1:1 bonus or a 2:1 split — different
 * events with different tax treatment. Rows are written as
 * `CAPITAL_ADJUSTMENT` with `details.observedRatio`, which is enough to ADJUST
 * a chart correctly without asserting something unverified. `source: "DERIVED"`
 * ranks below every real feed in price-adjust's precedence, so a later feed row
 * supersedes it.
 *
 * Usage:
 *   node --import tsx scripts/data/derive-corporate-actions.ts
 *   node --import tsx scripts/data/derive-corporate-actions.ts --apply
 *   node --import tsx scripts/data/derive-corporate-actions.ts --symbols=RELIANCE,INFY
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";
import {
  detectActions,
  reconcileCandidates,
  type DetectBar,
  toIstDateKey,
} from "@usemoney/core/market-data";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const APPLY = argv.includes("--apply");
const ONLY = arg("symbols")
  ?.split(",")
  .map((s) => s.trim().toUpperCase());
const MIN_ROWS = Number(arg("min-rows") ?? 250) || 250;
const LIMIT = Number(arg("limit") ?? 0) || 0;
/** Only high/medium-confidence candidates are written unless overridden. */
const MIN_CONFIDENCE = (arg("min-confidence") ?? "medium").toLowerCase();

const log = (...a: unknown[]) => console.log("[derive-actions]", ...a);

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

async function main(): Promise<void> {
  log(
    `mode=${APPLY ? "APPLY" : "DRY-RUN"} min-rows=${MIN_ROWS} ` +
      `min-confidence=${MIN_CONFIDENCE}${ONLY ? ` symbols=${ONLY.join(",")}` : ""}`,
  );

  const instruments = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      exchange: { in: ["NSE", "BSE"] },
      ...(ONLY ? { symbol: { in: ONLY } } : {}),
    },
    select: { id: true, symbol: true, exchange: true, isin: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  log(`scanning ${instruments.length.toLocaleString()} instrument(s)`);

  let scanned = 0;
  let detected = 0;
  let alreadyKnown = 0;
  let written = 0;
  let skippedThin = 0;
  let skippedConfidence = 0;
  const samples: string[] = [];

  for (const inst of instruments) {
    // EXCHANGE sources only. Yahoo rows are split-ADJUSTED and show no jump at
    // all, so including them would hide the very events being looked for.
    const rows = await prisma.dailyPrice.findMany({
      where: {
        instrumentId: inst.id,
        source: { in: ["BHAVCOPY", "BHAVCOPY_HIST"] },
      },
      select: { date: true, close: true, volume: true },
      orderBy: { date: "asc" },
    });
    if (rows.length < MIN_ROWS) {
      skippedThin++;
      continue;
    }
    scanned++;

    const candidates = detectActions(rows as DetectBar[]);
    if (candidates.length === 0) continue;
    detected += candidates.length;

    const known = await prisma.corporateAction.findMany({
      where: {
        OR: [
          { symbol: inst.symbol },
          ...(inst.isin ? [{ isin: inst.isin }] : []),
        ],
      },
      select: { type: true, exDate: true },
    });
    const { fresh, alreadyKnown: covered } = reconcileCandidates(
      candidates,
      known,
    );
    alreadyKnown += covered;

    for (const c of fresh) {
      if (RANK[c.confidence]! < (RANK[MIN_CONFIDENCE] ?? 1)) {
        skippedConfidence++;
        continue;
      }
      if (samples.length < 15) {
        samples.push(
          `${inst.symbol}/${inst.exchange} ${toIstDateKey(c.exDate)} ` +
            `x${(1 / c.snappedRatio).toFixed(3)} (obs ${c.observedRatio.toFixed(3)}) ` +
            `${c.confidence} ${c.prevClose} -> ${c.exClose}`,
        );
      }
      if (APPLY) {
        await prisma.corporateAction.upsert({
          where: {
            symbol_exchange_type_exDate: {
              symbol: inst.symbol,
              exchange: inst.exchange,
              type: "CAPITAL_ADJUSTMENT",
              exDate: c.exDate,
            },
          },
          create: {
            symbol: inst.symbol,
            isin: inst.isin,
            exchange: inst.exchange,
            type: "CAPITAL_ADJUSTMENT",
            exDate: c.exDate,
            ratio: c.snappedRatio,
            source: "DERIVED",
            details: {
              method: "price-derived",
              observedRatio: c.observedRatio,
              snappedRatio: c.snappedRatio,
              prevClose: c.prevClose,
              exClose: c.exClose,
              confidence: c.confidence,
              volumeRatio: c.volumeRatio,
            },
          },
          update: {
            ratio: c.snappedRatio,
            details: {
              method: "price-derived",
              observedRatio: c.observedRatio,
              snappedRatio: c.snappedRatio,
              prevClose: c.prevClose,
              exClose: c.exClose,
              confidence: c.confidence,
              volumeRatio: c.volumeRatio,
            },
          },
        });
      }
      written++;
    }
  }

  log(
    `DONE: scanned=${scanned} skipped-thin=${skippedThin} detected=${detected} ` +
      `already-known=${alreadyKnown} below-confidence=${skippedConfidence} ` +
      `${APPLY ? "written" : "would-write"}=${written}`,
  );
  log("samples:");
  for (const s of samples) log(`   ${s}`);
  if (!APPLY) log("dry-run: pass --apply to write. Nothing changed.");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[derive-actions] failed:", err);
  process.exitCode = 1;
});
