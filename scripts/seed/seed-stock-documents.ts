/**
 * Seed Stock Documents - Steps 11a/11b/11c
 *
 * Downloads financial documents and stores in GCS for RAG indexing.
 * Can run per data source in parallel:
 *
 * Usage:
 *   # All sources (sequential)
 *   DATABASE_URL=... npx tsx scripts/seed/seed-stock-documents.ts
 *
 *   # Per source (run in parallel terminals)
 *   DATABASE_URL=... npx tsx scripts/seed/seed-stock-documents.ts --source tickertape
 *   DATABASE_URL=... npx tsx scripts/seed/seed-stock-documents.ts --source nse-filings
 *   DATABASE_URL=... npx tsx scripts/seed/seed-stock-documents.ts --source nse-reports
 *
 *   # Options
 *   --limit 50              # Max symbols to process (default: 500)
 *   --symbols RELIANCE,TCS  # Specific symbols only
 *   --source tickertape     # Only Tickertape financial statements (fast, no rate limit)
 *   --source nse-filings    # Only NSE quarterly result PDFs
 *   --source nse-reports    # Only NSE annual report PDFs
 */

// Load environment variables (GCS credentials, etc.)
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });
dotenv.config({
  path: path.resolve(__dirname, "..", "..", ".env.local"),
  override: true,
});

import prisma from "@usemoney/database";
import { getOrFetchStockDocuments } from "../../packages/research/src/data-sources/stock-document-fetcher";
import type { StockDocType } from "../../packages/research/src/data-sources/stock-document-paths";

const logger = {
  info: (...args: unknown[]) => console.log("[seed-stock-docs]", ...args),
  error: (...args: unknown[]) => console.error("[seed-stock-docs]", ...args),
};

type Source = "tickertape" | "nse-filings" | "nse-reports" | "screener" | "all";

const SOURCE_CONFIG: Record<
  Source,
  {
    label: string;
    docType?: StockDocType;
    delayMs: number;
  }
> = {
  tickertape: {
    label: "Tickertape Financial Statements",
    docType: "financial_statement",
    delayMs: 500, // Tickertape is fast, minimal delay
  },
  "nse-filings": {
    label: "NSE Quarterly Result PDFs",
    docType: "quarterly_result",
    delayMs: 3000, // NSE needs slow rate
  },
  "nse-reports": {
    label: "NSE Annual Report PDFs",
    docType: "annual_report",
    delayMs: 3000,
  },
  screener: {
    label: "Screener.in Documents (Concalls, Annual Reports)",
    docType: "concall_transcript",
    delayMs: 3000, // Screener community convention: 3s between requests
  },
  all: {
    label: "All Sources",
    docType: undefined, // All doc types
    delayMs: 3000,
  },
};

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const symbolsIdx = args.indexOf("--symbols");
  const sourceIdx = args.indexOf("--source");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] || "500") : 500;
  const specificSymbols =
    symbolsIdx >= 0
      ? (args[symbolsIdx + 1] || "").split(",").filter(Boolean)
      : null;
  const source: Source =
    sourceIdx >= 0 ? (args[sourceIdx + 1] as Source) || "all" : "all";

  const config = SOURCE_CONFIG[source] || SOURCE_CONFIG.all;

  logger.info("=".repeat(60));
  logger.info(`Step 11: Seed Stock Documents - ${config.label}`);
  logger.info("=".repeat(60));

  let symbols: string[];

  if (specificSymbols && specificSymbols.length > 0) {
    symbols = specificSymbols.map((s) => s.toUpperCase().trim());
    logger.info(
      `Processing ${symbols.length} specified symbols: ${symbols.join(", ")}`,
    );
  } else {
    // Get stocks with Tickertape SID (financial data available)
    const instruments = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        instrumentType: "EQUITY",
        exchange: { in: ["NSE", "BSE"] },
        tickertapeSid: { not: null },
      },
      select: { symbol: true, exchange: true, analysisCount: true },
      orderBy: { analysisCount: "desc" },
      take: limit * 2,
    });

    // Filter for clean equity symbols
    const validInstruments = instruments.filter((i) =>
      /^[A-Z][A-Z0-9&]{1,19}$/.test(i.symbol),
    );

    symbols = [...new Set(validInstruments.map((i) => i.symbol))].slice(
      0,
      limit,
    );
    logger.info(
      `Found ${symbols.length} stocks (from ${instruments.length} total, limit: ${limit})`,
    );
  }

  let processed = 0;
  let totalDocs = 0;
  let failed = 0;
  const startTime = Date.now();

  for (const symbol of symbols) {
    try {
      // Timeout per symbol to prevent hanging on slow/blocked sources
      const timeoutMs = 60_000; // 60s max per symbol
      const fetchPromise = getOrFetchStockDocuments(symbol, config.docType);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs),
      );
      const docs = await Promise.race([fetchPromise, timeoutPromise]);
      totalDocs += docs.length;
      processed++;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const eta =
        processed > 0
          ? (
              (((Date.now() - startTime) / processed) *
                (symbols.length - processed)) /
              1000 /
              60
            ).toFixed(1)
          : "?";

      if (docs.length > 0) {
        logger.info(
          `[${processed}/${symbols.length}] ${symbol}: ${docs.length} docs (${elapsed}s elapsed, ~${eta}min remaining)`,
        );
      }

      // Rate limit per source
      if (processed < symbols.length) {
        await new Promise((r) => setTimeout(r, config.delayMs));
      }
    } catch (err) {
      failed++;
      logger.error(
        `Failed for ${symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  logger.info("=".repeat(60));
  logger.info(`Seed Complete - ${config.label}`);
  logger.info(`  Symbols processed: ${processed}`);
  logger.info(`  Symbols failed: ${failed}`);
  logger.info(`  Total documents: ${totalDocs}`);
  logger.info(`  Total time: ${totalTime} minutes`);
  logger.info("=".repeat(60));

  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error("Seed failed:", err);
  process.exit(1);
});
