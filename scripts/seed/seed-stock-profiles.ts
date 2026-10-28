/**
 * Seed Step 8: Stock Profiles
 *
 * Fetches company profiles via Yahoo Finance quoteSummary for NSE instruments
 * that have a tickertapeSid (from step 6). Yahoo uses the yahooSymbol field.
 *
 * Usage: DATABASE_URL="mongodb+srv://..." npx tsx scripts/seed/seed-stock-profiles.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const prisma = new PrismaClient();

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

async function main() {
  const { fetchQuoteSummary: yahooFetchQuoteSummary } =
    await import("../../packages/core/src/market-data/yahoo-api");

  // Process instruments that have SID (from step 6) and no recent profile
  const instruments = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
    },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      yahooSymbol: true,
      tickertapeSid: true,
    },
    orderBy: { symbol: "asc" },
  });

  // Check already profiled
  const existing = await prisma.stockProfile.findMany({
    where: { fetchedAt: { gte: new Date(Date.now() - NINETY_DAYS) } },
    select: { symbol: true, exchange: true },
  });
  const existingSet = new Set(existing.map((p) => `${p.symbol}:${p.exchange}`));

  // Filter: has tickertapeSid (from step 6) and not already profiled
  const withSid = instruments.filter((i) => i.tickertapeSid);
  const toProcess = withSid.filter(
    (i) => !existingSet.has(`${i.symbol}:${i.exchange}`),
  );

  console.log(
    `[seed-profiles] ${withSid.length} with SID, ${existingSet.size} already profiled, ${toProcess.length} to process`,
  );
  console.log(`[seed-profiles] Starting... (Yahoo Finance, ~2 req/sec)`);

  let processed = 0,
    failed = 0;
  const startTime = Date.now();

  for (const inst of toProcess) {
    try {
      const summary = await yahooFetchQuoteSummary(inst.yahooSymbol, [
        "summaryProfile",
        "price",
      ]);
      if (!summary) {
        failed++;
        if (failed <= 5)
          console.log(
            `[seed-profiles] ✗ ${inst.symbol} (${inst.yahooSymbol}) - no summary returned`,
          );
        continue;
      }

      const s = summary as Record<string, unknown>;
      const profile = (s.summaryProfile || {}) as Record<string, unknown>;
      const price = (s.price || {}) as Record<string, unknown>;

      await prisma.stockProfile.upsert({
        where: {
          symbol_exchange: { symbol: inst.symbol, exchange: inst.exchange },
        },
        update: {
          name:
            (price.longName as string) ||
            (price.shortName as string) ||
            inst.symbol,
          sector: profile.sector as string | null,
          industry: profile.industry as string | null,
          description: profile.longBusinessSummary as string | null,
          website: profile.website as string | null,
          employees: profile.fullTimeEmployees as number | null,
          marketCap: price.marketCap as number | null,
          fetchedAt: new Date(),
          source: "YAHOO",
        },
        create: {
          instrumentId: inst.id,
          symbol: inst.symbol,
          exchange: inst.exchange,
          name:
            (price.longName as string) ||
            (price.shortName as string) ||
            inst.symbol,
          sector: profile.sector as string | null,
          industry: profile.industry as string | null,
          description: profile.longBusinessSummary as string | null,
          website: profile.website as string | null,
          employees: profile.fullTimeEmployees as number | null,
          marketCap: price.marketCap as number | null,
          source: "YAHOO",
        },
      });

      processed++;
      if (processed <= 3)
        console.log(
          `[seed-profiles] ✓ ${inst.symbol} - ${(price.longName as string) || inst.symbol}`,
        );

      if (processed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(
          `[seed-profiles] ${processed}✓ ${failed}✗ / ${toProcess.length} | ${elapsed}s`,
        );
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err: unknown) {
      failed++;
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 502 || status === 429) {
        console.log(
          `[seed-profiles] ⏳ Rate limited at ${inst.symbol}, backing off 10s...`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
      } else if (failed <= 5) {
        console.log(
          `[seed-profiles] ✗ ${inst.symbol} - ${(err as Error)?.message?.slice(0, 120) || "unknown error"}`,
        );
      }
    }
  }

  console.log(
    `[seed-profiles] Complete: ${processed}✓ ${failed}✗ / ${toProcess.length}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
