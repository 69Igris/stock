/**
 * Seed Step 7: Stock Financials
 *
 * Fetches income/balance/cash flow via Tickertape for instruments that
 * already have a tickertapeSid (populated by step 6 ratios seed).
 *
 * Only processes instruments where financialsSyncedAt is null or > 30 days old.
 * Uses api.tickertape.in with 1s delay between stocks.
 *
 * Usage: DATABASE_URL="mongodb+srv://..." npx tsx scripts/seed/seed-stock-financials.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  mapTickertapeStatementRow,
  tickertapeStatementColumns,
  shouldBumpFinancialsSyncedAt,
  type TickertapeStatementType,
} from "@usemoney/research/data-sources/db-store-logic";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const prisma = new PrismaClient();

const API_BASE = "https://api.tickertape.in";
const DELAY_MS = 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

async function fetchStatement(
  sid: string,
  type: "income" | "balancesheet" | "cashflow",
) {
  const resp = await fetch(
    `${API_BASE}/stocks/financials/${type}/${sid}/annual/normal`,
    {
      headers: { Accept: "application/json" },
    },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
  return data?.data || null;
}

const STMT_MAP: Record<string, TickertapeStatementType> = {
  income: "INCOME",
  balancesheet: "BALANCE_SHEET",
  cashflow: "CASH_FLOW",
};

async function main() {
  // Only process instruments that have a tickertapeSid (from step 6)
  // and haven't been synced recently
  // Get all instruments that have a tickertapeSid (set by step 6)
  // Prisma MongoDB: "not null" doesn't match missing fields, so filter in JS
  const allWithSid = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
    },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      tickertapeSid: true,
      financialsSyncedAt: true,
    },
    orderBy: { symbol: "asc" },
  });

  const instruments = allWithSid.filter(
    (i) =>
      i.tickertapeSid &&
      (!i.financialsSyncedAt ||
        Date.now() - i.financialsSyncedAt.getTime() > THIRTY_DAYS),
  );

  console.log(
    `[seed-financials] ${instruments.length} instruments need financials sync (of ${allWithSid.filter((i) => i.tickertapeSid).length} with SID)`,
  );
  console.log(
    `[seed-financials] Starting... (3 API calls per stock, ~1s delay)`,
  );

  let processed = 0,
    failed = 0;
  const startTime = Date.now();

  for (const inst of instruments) {
    const sid = inst.tickertapeSid!;

    try {
      let statementsStored = 0;

      for (const [stmtKey, stmtType] of Object.entries(STMT_MAP)) {
        const rows = await fetchStatement(
          sid,
          stmtKey as "income" | "balancesheet" | "cashflow",
        );
        if (!rows || rows.length === 0) continue;

        for (const row of rows) {
          // MONEY-1205 — THIS SCRIPT WROTE PROD'S ENTIRE `stock_financials`
          // TABLE (32,359 rows, 2026-03-21, 100% source TICKERTAPE) and it is
          // the reason 11 of the 13 typed columns are null on 100% of them.
          // It read `displayPeriod` (right — hence the rows exist at all) and
          // then `row.incNpat` / `row.bsTass` / `row.bsTdbt` / `row.bsTeq` /
          // `row.cfOcf` / `row.cfFcf`. The real keys are `incNinc` / `balTota`
          // / `balTdeb` / `balTeq` / `cafCfoa` / `cafFcf`. Only `incTrev` and
          // `incEbi` were guessed correctly, which is exactly the pair that is
          // populated in prod (12,209 / 12,212 rows).
          //
          // It now uses the SAME mapper as the four other writers, so a key can
          // only be wrong in one place.
          const mapped = mapTickertapeStatementRow(stmtType, row, "ANNUAL");
          if (!mapped) continue;
          const { period } = mapped;
          const columns = tickertapeStatementColumns(mapped);

          await prisma.stockFinancials.upsert({
            where: {
              symbol_exchange_statementType_periodType_period: {
                symbol: inst.symbol,
                exchange: inst.exchange,
                statementType: stmtType,
                periodType: "ANNUAL",
                period,
              },
            },
            update: {
              rawData: JSON.parse(JSON.stringify(row)),
              ...columns,
              fetchedAt: new Date(),
              source: "TICKERTAPE",
            },
            create: {
              instrumentId: inst.id,
              symbol: inst.symbol,
              exchange: inst.exchange,
              statementType: stmtType,
              periodType: "ANNUAL",
              period,
              rawData: JSON.parse(JSON.stringify(row)),
              ...columns,
              source: "TICKERTAPE",
            },
          });
          statementsStored++;
        }

        await new Promise((r) => setTimeout(r, 300)); // Between statement types
      }

      // MONEY-1205 — gate the staleness marker on having actually stored
      // something. This used to bump unconditionally, so a stock whose three
      // fetches ALL returned null (a 404 sid, a rate limit, an upstream blip)
      // was stamped "synced" and then skipped by the 30-day filter at the top of
      // this script AND by `isStale(financialsSyncedAt, "financials_annual")` in
      // the worker — a transient failure converted into a month of silence.
      // Same gate the worker uses, imported rather than re-implemented.
      if (shouldBumpFinancialsSyncedAt(statementsStored > 0, false)) {
        await prisma.instrumentMapping.update({
          where: { id: inst.id },
          data: { financialsSyncedAt: new Date() },
        });
      } else {
        console.log(
          `[seed-financials] ⚠ ${inst.symbol} - 0 statement rows stored; leaving financialsSyncedAt unset so it retries`,
        );
      }

      processed++;
      if (processed <= 3)
        console.log(
          `[seed-financials] ✓ ${inst.symbol} - ${statementsStored} statement rows stored`,
        );

      if (processed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (
          (processed / (Date.now() - startTime)) *
          1000 *
          60
        ).toFixed(1);
        console.log(
          `[seed-financials] ${processed}✓ ${failed}✗ / ${instruments.length} | ${elapsed}s | ~${rate}/min`,
        );
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));
    } catch (err: unknown) {
      failed++;
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 502 || status === 429) {
        console.log(
          `[seed-financials] ⏳ Rate limited at ${inst.symbol}, backing off 10s...`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  // Coverage report
  const seeded = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
      financialsSyncedAt: { not: null },
    },
  });
  const total = await prisma.instrumentMapping.count({
    where: { isActive: true, instrumentType: "EQUITY", exchange: "NSE" },
  });

  console.log(`[seed-financials] Complete: ${processed}✓ ${failed}✗`);
  console.log(
    `[seed-financials] Coverage: ${seeded}/${total} NSE instruments have financials (${total - seeded} missing - on-demand)`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
