/**
 * Seed Step 10: ETF Data
 *
 * Fetches ETF profiles and ratios via Yahoo Finance quoteSummary.
 * ETFs don't have traditional PE/ROE - they have:
 *   - AUM (totalAssets)
 *   - Expense ratio (annualReportExpenseRatio)
 *   - NAV (navPrice)
 *   - Tracking index
 *   - Holdings count
 *   - Yield (yield)
 *
 * Stores in StockProfile (for description/sector) and StockRatios (for key metrics).
 *
 * Usage: DATABASE_URL="mongodb+srv://..." npx tsx scripts/seed/seed-etf-data.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const prisma = new PrismaClient();

function isValidSymbol(symbol: string): boolean {
  return (
    symbol.length >= 2 && /^[A-Z0-9]+$/.test(symbol) && /[A-Z]/.test(symbol)
  );
}

async function main() {
  const { fetchQuoteSummary: yahooFetchQuoteSummary } =
    await import("../../packages/core/src/market-data/yahoo-api");

  // Get all active ETFs (NSE first, then BSE-only)
  const nseEtfs = await prisma.instrumentMapping.findMany({
    where: { isActive: true, instrumentType: "ETF", exchange: "NSE" },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      yahooSymbol: true,
      name: true,
    },
    orderBy: { symbol: "asc" },
  });
  const nseValid = nseEtfs.filter((i) => isValidSymbol(i.symbol));
  const nseSymbols = new Set(nseValid.map((i) => i.symbol));

  // BSE-only ETFs skipped - seed NSE ETFs only
  const etfs = nseValid;

  // Check already profiled
  const existing = await prisma.stockProfile.findMany({
    where: {
      fetchedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
    select: { symbol: true, exchange: true },
  });
  const existingSet = new Set(existing.map((p) => `${p.symbol}:${p.exchange}`));

  console.log(
    `[seed-etf] NSE ETFs: ${nseValid.length}, Already profiled: ${existingSet.size} (BSE-only skipped)`,
  );
  console.log(`[seed-etf] Starting... (progress every 25 ETFs)`);

  let processed = 0,
    skipped = 0,
    failed = 0;
  const startTime = Date.now();

  for (const etf of etfs) {
    if (existingSet.has(`${etf.symbol}:${etf.exchange}`)) {
      skipped++;
      continue;
    }

    try {
      const summary = await yahooFetchQuoteSummary(etf.yahooSymbol, [
        "summaryProfile",
        "price",
        "defaultKeyStatistics",
        "summaryDetail",
      ]);
      if (!summary) {
        failed++;
        continue;
      }

      const s = summary as Record<string, unknown>;
      const profile = (s.summaryProfile || {}) as Record<string, unknown>;
      const price = (s.price || {}) as Record<string, unknown>;
      const keyStats = (s.defaultKeyStatistics || {}) as Record<
        string,
        unknown
      >;
      const detail = (s.summaryDetail || {}) as Record<string, unknown>;

      // Store profile
      await prisma.stockProfile.upsert({
        where: {
          symbol_exchange: { symbol: etf.symbol, exchange: etf.exchange },
        },
        update: {
          name:
            (price.longName as string) ||
            (price.shortName as string) ||
            etf.name,
          sector: (profile.category as string) || "ETF",
          industry: (profile.fundFamily as string) || null,
          description: profile.longBusinessSummary as string | null,
          website: profile.website as string | null,
          marketCap:
            (detail.totalAssets as number) ||
            (price.marketCap as number) ||
            null,
          fetchedAt: new Date(),
          source: "YAHOO",
        },
        create: {
          instrumentId: etf.id,
          symbol: etf.symbol,
          exchange: etf.exchange,
          name:
            (price.longName as string) ||
            (price.shortName as string) ||
            etf.name,
          sector: (profile.category as string) || "ETF",
          industry: (profile.fundFamily as string) || null,
          description: profile.longBusinessSummary as string | null,
          website: profile.website as string | null,
          marketCap:
            (detail.totalAssets as number) ||
            (price.marketCap as number) ||
            null,
          source: "YAHOO",
        },
      });

      // Store ETF-specific ratios (repurposing StockRatios for key metrics)
      await prisma.stockRatios.upsert({
        where: {
          symbol_exchange: { symbol: etf.symbol, exchange: etf.exchange },
        },
        update: {
          pe: detail.trailingPE as number | null,
          pb: keyStats.priceToBook as number | null,
          dividendYield: detail.yield as number | null,
          beta: keyStats.beta3Year as number | null,
          marketCap: (detail.totalAssets as number) || null,
          rawData: JSON.parse(JSON.stringify({ ...keyStats, ...detail })),
          fetchedAt: new Date(),
          source: "YAHOO",
        },
        create: {
          instrumentId: etf.id,
          symbol: etf.symbol,
          exchange: etf.exchange,
          pe: detail.trailingPE as number | null,
          pb: keyStats.priceToBook as number | null,
          dividendYield: detail.yield as number | null,
          beta: keyStats.beta3Year as number | null,
          marketCap: (detail.totalAssets as number) || null,
          rawData: JSON.parse(JSON.stringify({ ...keyStats, ...detail })),
          source: "YAHOO",
        },
      });

      processed++;
      if (processed <= 5)
        console.log(
          `[seed-etf] ✓ ${etf.symbol} - ${(price.longName as string) || etf.name}`,
        );

      const total = processed + failed;
      if (total > 0 && total % 25 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(
          `[seed-etf] ${processed}✓ ${failed}✗ ${skipped}⊘ / ${etfs.length} | ${elapsed}s elapsed`,
        );
      }

      await new Promise((r) => setTimeout(r, 500)); // Yahoo rate limit
    } catch (err: unknown) {
      failed++;
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 502 || status === 429) {
        console.log(
          `[seed-etf] ⏳ Rate limited (${status}) at ${etf.symbol}, backing off 10s...`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  console.log(
    `[seed-etf] Complete: processed=${processed}, skipped=${skipped}, failed=${failed}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
