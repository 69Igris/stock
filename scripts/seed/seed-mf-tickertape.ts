/**
 * Seed Step 9: MF Data from Tickertape
 *
 * Fetches mutual fund overview + holdings from Tickertape for ALL active MFs
 * and enriches MutualFundMaster with additional data not in AMFI/Kuvera.
 *
 * Usage: DATABASE_URL="mongodb+srv://..." npx tsx scripts/seed/seed-mf-tickertape.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  fetchTickertapeMfOverview,
  fetchTickertapeMfHoldings,
} from "../../packages/research/src/data-sources/tickertape-mf-client";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const funds = await prisma.mutualFundMaster.findMany({
    where: { isActive: true },
    select: { id: true, schemeCode: true, schemeName: true },
    orderBy: { schemeName: "asc" },
    take: 14000,
  });

  console.log(`[seed-mf-tt] Found ${funds.length} active mutual funds (Tickertape MF API)`);
  console.log(`[seed-mf-tt] Starting... (progress every 100 funds)`);

  let processed = 0, skipped = 0, failed = 0;
  const startTime = Date.now();

  for (const fund of funds) {
    try {
      const overview = await fetchTickertapeMfOverview(fund.schemeName || fund.schemeCode);
      if (!overview) { skipped++; continue; }

      const updateData: Record<string, unknown> = {};
      if (overview.aum) updateData.aum = overview.aum;
      if (overview.expenseRatio) updateData.expenseRatio = overview.expenseRatio;
      if (overview.riskRating) updateData.riskRating = overview.riskRating;
      if (overview.returns.oneYear != null) updateData.return1Y = overview.returns.oneYear;
      if (overview.returns.threeYear != null) updateData.return3Y = overview.returns.threeYear;
      if (overview.returns.fiveYear != null) updateData.return5Y = overview.returns.fiveYear;

      if (Object.keys(updateData).length > 0) {
        await prisma.mutualFundMaster.update({
          where: { id: fund.id },
          data: updateData as Parameters<typeof prisma.mutualFundMaster.update>[0]["data"],
        });
      }

      const holdings = await fetchTickertapeMfHoldings(fund.schemeName || fund.schemeCode);
      if (holdings && holdings.length > 0) {
        await prisma.mutualFundMaster.update({
          where: { id: fund.id },
          data: {
            topHoldings: holdings.slice(0, 10) as Parameters<typeof prisma.mutualFundMaster.update>[0]["data"]["topHoldings"],
          },
        });
      }

      processed++;
      if (processed <= 3) console.log(`[seed-mf-tt] ✓ ${fund.schemeName?.slice(0, 50) || fund.schemeCode}`);

      const total = processed + failed;
      if (total > 0 && total % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (total / (Date.now() - startTime) * 1000 * 60).toFixed(1);
        console.log(`[seed-mf-tt] ${processed}✓ ${failed}✗ ${skipped}⊘ / ${funds.length} | ${elapsed}s | ~${rate}/min`);
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err: unknown) {
      failed++;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 502 || status === 429) {
        console.log(`[seed-mf-tt] ⏳ Rate limited (${status}), backing off 10s...`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  console.log(`[seed-mf-tt] Complete: processed=${processed}, skipped=${skipped}, failed=${failed}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
