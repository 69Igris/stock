#!/usr/bin/env tsx
/**
 * ETF `expenseRatio` coverage — a standing measurement.
 *
 * MONEY-209 Phase 1 shipped this to answer one question: how often does the ETF
 * screener's `expenseRatio` filter silently drop everything, and is an
 * enrichment worker worth building? Both halves of that question have since
 * been answered, in opposite directions, and the header is updated rather than
 * the script deleted — it never depended on either answer.
 *
 * ## What happened to Phase 2
 *
 * It shipped as `etf-expense-enrichment` against Kuvera via the captnemo proxy,
 * and it was a GUARANTEED no-op in every environment — not a job whose upstream
 * later died. `fetchKuveraMetadata` returns null unless
 * `MF_METADATA_PROVIDER === "kuvera"` and both cloudbuild specs set `"amfi"`,
 * so it could never reach its source; and that source 404s every ISIN anyway,
 * captnemo's own documented sample included. RETIRED in MONEY-1404.
 *
 * `expenseRatio` now comes from AMFI's own monthly TER publication, parsed by
 * `amfi-fund-metadata-provider.ts` on the `mf-metadata-weekly` schedule — a
 * primary source from the regulator, measured at 63.5% coverage on 2026-08-18
 * against the enrichment worker's zero.
 *
 * ## Why this script survives its own ticket
 *
 * It touches NONE of that. It is a read-only count over `instrument_mappings`
 * (active, `instrumentType: "ETF"`) joined to `mutual_fund_masters.expenseRatio`
 * by ISIN, and it writes nothing anywhere. The question it answers — what
 * fraction of ETFs actually carry an expense ratio — got more useful when the
 * source changed, not less: it is the only thing that says whether the AMFI TER
 * feed is keeping up, and a drop in this number is how a quietly-failing TER
 * parse would first become visible.
 *
 * Read it as a COVERAGE MEASUREMENT, not as a feasibility gate for a decision
 * that has already been taken twice.
 *
 * Output:
 *   - JSON to stdout: { totalEtfs, withExpense, coverage, missingSlugs }
 *   - human summary to stderr
 */

import { prisma } from "@usemoney/database";

interface CoverageReport {
  runAt: string;
  totalEtfs: number;
  withExpense: number;
  coverage: number;
  missingWithIsin: number;
  missingNoIsin: number;
  /** Sample of ETFs missing expense data (first 50). */
  sampleMissing: Array<{
    symbol: string;
    name: string;
    exchange: string;
    isin: string | null;
  }>;
}

async function main() {
  const t0 = Date.now();

  // Load all ETFs
  const etfs = await prisma.instrumentMapping.findMany({
    where: { isActive: true, instrumentType: "ETF" },
    select: { id: true, symbol: true, name: true, exchange: true, isin: true },
  });
  if (etfs.length === 0) {
    process.stderr.write(
      "No active ETFs in InstrumentMapping. Did seed-etf-data.ts run?\n",
    );
    process.exit(2);
  }

  // ETFs cross-link to MutualFundMaster via ISIN. Build the join.
  const isins = etfs.map((e) => e.isin).filter(Boolean) as string[];
  const mfRows =
    isins.length > 0
      ? await prisma.mutualFundMaster.findMany({
          where: {
            OR: [
              { isinGrowth: { in: isins } },
              { isinDividend: { in: isins } },
            ],
            expenseRatio: { not: null },
          },
          select: {
            isinGrowth: true,
            isinDividend: true,
            expenseRatio: true,
          },
        })
      : [];

  const expenseByIsin = new Map<string, number>();
  for (const m of mfRows) {
    if (m.isinGrowth && m.expenseRatio != null)
      expenseByIsin.set(m.isinGrowth, m.expenseRatio);
    if (m.isinDividend && m.expenseRatio != null)
      expenseByIsin.set(m.isinDividend, m.expenseRatio);
  }

  let withExpense = 0;
  let missingWithIsin = 0;
  let missingNoIsin = 0;
  const sampleMissing: CoverageReport["sampleMissing"] = [];

  for (const etf of etfs) {
    const has = etf.isin ? expenseByIsin.has(etf.isin) : false;
    if (has) {
      withExpense++;
    } else {
      if (etf.isin) missingWithIsin++;
      else missingNoIsin++;
      if (sampleMissing.length < 50) {
        sampleMissing.push({
          symbol: etf.symbol,
          name: etf.name,
          exchange: etf.exchange,
          isin: etf.isin ?? null,
        });
      }
    }
  }

  const report: CoverageReport = {
    runAt: new Date().toISOString(),
    totalEtfs: etfs.length,
    withExpense,
    coverage: etfs.length === 0 ? 0 : withExpense / etfs.length,
    missingWithIsin,
    missingNoIsin,
    sampleMissing,
  };

  console.log(JSON.stringify(report, null, 2));

  process.stderr.write(
    `\n=== ETF expense-ratio audit (MONEY-209 Phase 1) ===\n` +
      `Total ETFs: ${etfs.length}\n` +
      `With expense ratio: ${withExpense} (${(report.coverage * 100).toFixed(1)}%)\n` +
      `Missing - with ISIN (scrapable): ${missingWithIsin}\n` +
      `Missing - no ISIN (need scraping by symbol/name): ${missingNoIsin}\n` +
      `Took ${Date.now() - t0} ms.\n\n` +
      `Phase 2 decision matrix:\n` +
      `  - If coverage >= 80%: skip enrichment, ship the screener filter as-is.\n` +
      `  - If coverage 30-80% AND missingWithIsin > 50: write Kuvera-ISIN scraper.\n` +
      `  - If coverage < 30%: scope a multi-source scraper (AMFI + AMC + Morningstar fallback).\n`,
  );
}

main()
  .catch((err) => {
    process.stderr.write(`audit failed: ${String(err)}\n`);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
