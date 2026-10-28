/**
 * Embed Stock Documents - Generate vector embeddings for RAG
 *
 * Reads StockDocument records with textContent, chunks them,
 * generates Gemini text-embedding-004 vectors, and stores in
 * DocumentEmbedding for chat RAG.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/data/embed-stock-documents.ts
 *
 *   # Options
 *   --limit 100             # Max documents to process (default: 500)
 *   --symbols RELIANCE,TCS  # Specific symbols only
 *   --force                 # Re-embed already embedded documents
 *   --doc-types financial_statement,screener_financials  # Specific types
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });
dotenv.config({
  path: path.resolve(__dirname, "..", "..", ".env.local"),
  override: true,
});

import { processStockDocumentEmbed } from "../../workers/src/processors/stock-document-embed";

const logger = {
  info: (...args: unknown[]) => console.log("[embed-stock-docs]", ...args),
  error: (...args: unknown[]) => console.error("[embed-stock-docs]", ...args),
};

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI args
  let limit = 500;
  let symbols: string[] | undefined;
  let forceReindex = false;
  let docTypes: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--symbols" && args[i + 1]) {
      symbols = args[i + 1]!.split(",").map((s) => s.trim().toUpperCase());
      i++;
    } else if (arg === "--force") {
      forceReindex = true;
    } else if (arg === "--doc-types" && args[i + 1]) {
      docTypes = args[i + 1]!.split(",").map((s) => s.trim());
      i++;
    }
  }

  logger.info(`Starting embedding pipeline`);
  logger.info(`  Limit: ${limit}`);
  logger.info(`  Symbols: ${symbols?.join(", ") || "all"}`);
  logger.info(`  Force reindex: ${forceReindex}`);
  logger.info(`  Doc types: ${docTypes?.join(", ") || "all"}`);
  logger.info("");

  const startTime = Date.now();

  await processStockDocumentEmbed({
    symbols,
    forceReindex,
    batchSize: limit,
    docTypes,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`\nDone in ${elapsed}s`);

  process.exit(0);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
