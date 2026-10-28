/**
 * Seed Step 6: Stock Ratios
 *
 * Fetches ratios for ALL stocks via Tickertape screener API in batches.
 * Instead of one-by-one SID resolution (slow, rate-limited), we:
 *   1. Fetch ALL stocks from screener in batches of 50 (sorted by market cap)
 *   2. Match each result to our InstrumentMapping by ticker symbol
 *   3. Upsert into StockRatios
 *
 * Tickertape has ~5,700 stocks. At 50/batch with 1s delay = ~2 minutes total.
 *
 * Usage: DATABASE_URL="mongodb+srv://..." npx tsx scripts/seed/seed-stock-ratios.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const prisma = new PrismaClient();

const API_URL = "https://api.tickertape.in/screener/query";
const BATCH_SIZE = 50;
const DELAY_MS = 1000; // 1s between batches

const RATIO_FIELDS = [
  "ticker",
  "name",
  "mrktCapf",
  "pe",
  "pb",
  "roe",
  "roa",
  "roce",
  "evEBITDA",
  "pegRatio",
  "grossMrgn",
  "operMrgn",
  "netMrgn",
  "revGrwAn",
  "netPftGrw",
  "revGrw3yr",
  "netPftGrw3yr",
  "revGrw5yr",
  "netPftGrw5yr",
  "debt2Eq",
  "curRatio",
  "intCover",
  "beta",
  "divYield",
  "entVal",
  "tgtPrice",
  "recom",
];

interface ScreenerEntry {
  sid: string;
  stock: {
    advancedRatios: Record<string, unknown>;
    info: { name: string; ticker: string; sector?: string };
  };
}

async function fetchBatch(
  offset: number,
): Promise<{ results: ScreenerEntry[]; total: number }> {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      match: {},
      sortBy: "mrktCapf",
      sortOrder: -1,
      project: RATIO_FIELDS,
      offset,
      count: BATCH_SIZE,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Screener API returned ${resp.status}`);
  }

  const data = (await resp.json()) as {
    data?: {
      results?: ScreenerEntry[];
      stats?: { count?: number };
    };
  };

  return {
    results: data?.data?.results || [],
    total: data?.data?.stats?.count || 0,
  };
}

async function main() {
  // Build a lookup map: ticker → instrumentMapping record
  const instruments = await prisma.instrumentMapping.findMany({
    where: { isActive: true, instrumentType: "EQUITY", exchange: "NSE" },
    select: { id: true, symbol: true, exchange: true },
  });

  const instrumentMap = new Map<
    string,
    { id: string; symbol: string; exchange: string }
  >();
  for (const inst of instruments) {
    instrumentMap.set(inst.symbol, inst);
  }

  console.log(`[seed-ratios] ${instrumentMap.size} NSE instruments in DB`);

  // Fetch first batch to get total count
  const first = await fetchBatch(0);
  const totalOnTickertape = first.total;
  console.log(
    `[seed-ratios] ${totalOnTickertape} stocks on Tickertape, fetching in batches of ${BATCH_SIZE}...`,
  );

  let processed = 0,
    matched = 0,
    unmatched = 0,
    failed = 0;
  const startTime = Date.now();
  let offset = 0;

  while (offset < totalOnTickertape) {
    try {
      const batch = offset === 0 ? first : await fetchBatch(offset);

      for (const entry of batch.results) {
        const ticker = entry.stock?.info?.ticker;
        if (!ticker) {
          unmatched++;
          continue;
        }

        const inst = instrumentMap.get(ticker);
        if (!inst) {
          unmatched++;
          continue;
        }

        const r = entry.stock.advancedRatios || {};
        const info = entry.stock.info || {};

        try {
          await prisma.stockRatios.upsert({
            where: {
              symbol_exchange: { symbol: inst.symbol, exchange: inst.exchange },
            },
            update: {
              // Re-assert the FK on update, not only on create. The row is
              // keyed by symbol+exchange, so a re-seeded InstrumentMapping
              // (fresh ObjectIds) makes an existing row take this branch and
              // keep a DEAD instrumentId. `instrument` is a REQUIRED relation,
              // so Prisma then throws on any query selecting it and every
              // fundamental screener filter silently returns nothing. Keeping
              // this line makes re-seeding self-healing — see
              // scripts/ops/repair-stock-ratios-links.ts for the repair.
              instrumentId: inst.id,
              pe: r.pe as number | null,
              pb: r.pb as number | null,
              evToEbitda: r.evEBITDA as number | null,
              pegRatio: r.pegRatio as number | null,
              roe: r.roe as number | null,
              roa: r.roa as number | null,
              roce: r.roce as number | null,
              grossMargin: r.grossMrgn as number | null,
              operatingMargin: r.operMrgn as number | null,
              netMargin: r.netMrgn as number | null,
              revenueGrowth: r.revGrwAn as number | null,
              earningsGrowth: r.netPftGrw as number | null,
              revenueGrowth3Y: r.revGrw3yr as number | null,
              earningsGrowth3Y: r.netPftGrw3yr as number | null,
              revenueGrowth5Y: r.revGrw5yr as number | null,
              earningsGrowth5Y: r.netPftGrw5yr as number | null,
              debtToEquity: r.debt2Eq as number | null,
              currentRatio: r.curRatio as number | null,
              interestCoverage: r.intCover as number | null,
              beta: r.beta as number | null,
              dividendYield: r.divYield as number | null,
              marketCap: r.mrktCapf as number | null,
              enterpriseValue: r.entVal as number | null,
              targetPrice: r.tgtPrice as number | null,
              recommendation: r.recom as string | null,
              rawData: JSON.parse(JSON.stringify(r)),
              fetchedAt: new Date(),
              source: "TICKERTAPE",
            },
            create: {
              instrumentId: inst.id,
              symbol: inst.symbol,
              exchange: inst.exchange,
              pe: r.pe as number | null,
              pb: r.pb as number | null,
              evToEbitda: r.evEBITDA as number | null,
              pegRatio: r.pegRatio as number | null,
              roe: r.roe as number | null,
              roa: r.roa as number | null,
              roce: r.roce as number | null,
              grossMargin: r.grossMrgn as number | null,
              operatingMargin: r.operMrgn as number | null,
              netMargin: r.netMrgn as number | null,
              revenueGrowth: r.revGrwAn as number | null,
              earningsGrowth: r.netPftGrw as number | null,
              revenueGrowth3Y: r.revGrw3yr as number | null,
              earningsGrowth3Y: r.netPftGrw3yr as number | null,
              revenueGrowth5Y: r.revGrw5yr as number | null,
              earningsGrowth5Y: r.netPftGrw5yr as number | null,
              debtToEquity: r.debt2Eq as number | null,
              currentRatio: r.curRatio as number | null,
              interestCoverage: r.intCover as number | null,
              beta: r.beta as number | null,
              dividendYield: r.divYield as number | null,
              marketCap: r.mrktCapf as number | null,
              enterpriseValue: r.entVal as number | null,
              targetPrice: r.tgtPrice as number | null,
              recommendation: r.recom as string | null,
              rawData: JSON.parse(JSON.stringify(r)),
              source: "TICKERTAPE",
            },
          });

          // Also cache the SID and sync timestamp
          await prisma.instrumentMapping.update({
            where: { id: inst.id },
            data: { tickertapeSid: entry.sid, ratiosSyncedAt: new Date() },
          });

          matched++;
          if (matched <= 5) {
            console.log(
              `[seed-ratios] ✓ ${ticker} - PE:${r.pe ?? "-"} ROE:${(r.roe as number)?.toFixed(1) ?? "-"}% MCap:${r.mrktCapf ? Math.round(r.mrktCapf as number).toLocaleString("en-IN") : "-"}`,
            );
          }
        } catch {
          failed++;
        }

        processed++;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = (
        ((offset + batch.results.length) / totalOnTickertape) *
        100
      ).toFixed(1);
      console.log(
        `[seed-ratios] Batch ${offset / BATCH_SIZE + 1}: ${matched}✓ ${unmatched}⊘ ${failed}✗ | ${pct}% | ${elapsed}s`,
      );
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 502 || status === 429) {
        console.log(
          `[seed-ratios] ⏳ Rate limited at offset ${offset}, backing off 10s...`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
        continue; // Retry same offset
      }
      console.error(`[seed-ratios] Batch at offset ${offset} failed:`, err);
    }

    offset += BATCH_SIZE;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(
    `[seed-ratios] Complete: ${matched} matched, ${unmatched} unmatched (not in our DB), ${failed} DB errors, ${processed} total from Tickertape`,
  );

  // Report: which NSE instruments in our DB have NO ratios seeded?
  const seeded = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
      ratiosSyncedAt: { not: null },
    },
  });
  const totalNSE = await prisma.instrumentMapping.count({
    where: { isActive: true, instrumentType: "EQUITY", exchange: "NSE" },
  });
  const missing = totalNSE - seeded;
  console.log(
    `[seed-ratios] Coverage: ${seeded}/${totalNSE} NSE instruments have ratios (${missing} missing - these will be fetched on-demand when analyzed)`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
