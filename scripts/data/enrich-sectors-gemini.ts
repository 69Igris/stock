/**
 * Enrich Stock Sectors via Gemini Flash
 *
 * Uses Gemini 2.5 Flash to classify stocks into sectors in bulk batches.
 * ~200 stocks per API call vs Yahoo's 1 stock/2 seconds.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/data/enrich-sectors-gemini.ts
 *
 *   # Options
 *   --batch-size 200    # Stocks per Gemini call (default: 200)
 *   --limit 5000        # Max stocks to process (default: all)
 *   --dry-run           # Show what would be updated without writing to DB
 *   --include-na        # Re-enrich stocks with sector="N/A" (default: only null)
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

import { VertexAI } from "@google-cloud/vertexai";
import prisma from "@usemoney/database";
import {
  getAllSectorNames,
  normalizeToNseSector,
} from "@usemoney/core/market-data";

// ── Config ──────────────────────────────────────────────────────────

/**
 * MONEY-1093 - the canonical taxonomy, NOT a list maintained here.
 *
 * This script used to declare its own 18-value vocabulary containing seven
 * names that are not NSE_SECTORS at all — "Real Estate", "Media &
 * Entertainment", "Automobile", "Chemicals", "Textiles", "Construction",
 * "Agriculture" — and wrote whatever Gemini returned straight to
 * InstrumentMapping.sector. Those are precisely the passthrough buckets
 * found in prod (Other 228, Construction 40, Real Estate 19, Media &
 * Entertainment 9, Agriculture 5): this script put them there.
 *
 * Deriving the list from getAllSectorNames() means the prompt can never
 * again drift from what the rest of the app can filter, group or display.
 */
const CANONICAL_SECTORS = getAllSectorNames();

const MODEL = "gemini-2.5-flash";
const DELAY_BETWEEN_BATCHES_MS = 1000;

const logger = {
  info: (...args: unknown[]) => console.log("[enrich-sectors]", ...args),
  error: (...args: unknown[]) => console.error("[enrich-sectors]", ...args),
  warn: (...args: unknown[]) => console.warn("[enrich-sectors]", ...args),
};

// ── Vertex AI Client ────────────────────────────────────────────────

function getVertexClient(): VertexAI {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error("GCP_PROJECT_ID not set");

  const keyBase64 = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
  if (keyBase64) {
    const keyJson = Buffer.from(keyBase64, "base64").toString("utf-8");
    const creds = JSON.parse(keyJson);
    process.env.GOOGLE_APPLICATION_CREDENTIALS =
      process.env.GOOGLE_APPLICATION_CREDENTIALS || "";

    // Write temp credentials file for Vertex AI SDK
    const fs = require("fs");
    const tmpPath = path.resolve(__dirname, "..", "..", ".tmp-sa-key.json");
    fs.writeFileSync(tmpPath, keyJson);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;

    return new VertexAI({
      project: projectId,
      location: process.env.GCP_LOCATION || "us-central1",
      googleAuthOptions: {
        keyFile: tmpPath,
        projectId,
      },
    });
  }

  // Fall back to ADC (local dev with gcloud auth)
  return new VertexAI({
    project: projectId,
    location: process.env.GCP_LOCATION || "us-central1",
  });
}

// ── Gemini Classification ───────────────────────────────────────────

interface StockInput {
  symbol: string;
  name: string;
  exchange: string;
}

interface ClassifiedStock {
  symbol: string;
  /** From the ASKED row, never from the model — see classifyBatch. */
  exchange: string;
  sector: string;
  industry: string;
}

async function classifyBatch(
  client: VertexAI,
  stocks: StockInput[],
): Promise<ClassifiedStock[]> {
  const model = client.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  });

  const stockList = stocks
    .map((s) => `${s.symbol} | ${s.name} | ${s.exchange}`)
    .join("\n");

  const prompt = `You are a stock market sector classifier for Indian stocks (NSE/BSE).

Given the list of stocks below, classify each into ONE sector and ONE industry.

SECTORS (use EXACTLY these names):
${CANONICAL_SECTORS.map((s) => `- ${s}`).join("\n")}

If NONE of the above genuinely fits, return the sector as the exact string
"UNKNOWN". Do NOT invent a sector name and do NOT guess a poor fit — an
unclassified stock is corrected later by the Yahoo enrichment pipeline,
whereas a wrong sector silently corrupts every sector aggregate.

RULES:
- Use the stock name to determine the sector
- "industry" should be a specific sub-category (e.g., "Private Banks", "IT Services", "Pharmaceuticals", "Auto Components")
- For investment/holding/trading companies, use "Financial Services" with industry "Investment Company"
- For unknown/unclear companies return "UNKNOWN". Do NOT guess. Many rows in
  this dataset are NOT companies at all — bonds, debentures and government
  securities are stored alongside equities, and their names look like
  "885PFL31" or "697NABAR36". Guessing gives a bond a sector, which then
  distorts every sector aggregate that includes it.
- Return ONLY valid JSON array, no markdown

STOCKS:
${stockList}

Return a JSON array of objects with exactly these fields:
[{"symbol":"SYMBOL","sector":"Sector Name","industry":"Industry Name"}, ...]`;

  const result = await model.generateContent(prompt);
  const text =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as ClassifiedStock[];

    // Validate sector names. "Other" is NO LONGER accepted — it was the
    // single largest source of non-canonical values (228 rows in prod).
    // An UNKNOWN (or anything off-vocabulary) is DROPPED rather than
    // written: leaving a row unclassified is honest and recoverable,
    // writing a junk bucket is neither.
    const validSectors = new Set(CANONICAL_SECTORS);
    // The SECTOR was validated against the taxonomy; the SYMBOL was not
    // validated against anything. `c.symbol` goes straight into the write's
    // `where`, so a model that normalises "M&MFIN" to "M&M", or simply echoes a
    // symbol from its own priors, wrote stock A's classification onto stock B —
    // a CONFIDENTLY WRONG sector rather than an absent one, which is exactly
    // what the prompt rewrite above exists to prevent.
    //
    // The exchange is carried from the ASKED row, not from the model, so the
    // write can pin symbol+exchange instead of spanning both listings.
    const asked = new Map(stocks.map((s) => [s.symbol, s.exchange]));
    return parsed
      .filter((s) => s.symbol && s.sector && validSectors.has(s.sector))
      .filter((s) => asked.has(s.symbol))
      .map((s) => ({ ...s, exchange: asked.get(s.symbol)! }));
  } catch (err) {
    logger.error("Failed to parse Gemini response:", text.slice(0, 200));
    return [];
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let batchSize = 200;
  let limit = 0; // 0 = all
  let dryRun = false;
  let includeNA = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--batch-size" && args[i + 1]) {
      batchSize = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--include-na") {
      includeNA = true;
    }
  }

  // EQUITY only, and that filter is load-bearing.
  //
  // The nightly bhavcopy backfill now CLEARS sector/industry when it types a row
  // DEBT, so `sector: null` is no longer a synonym for "an equity we have not
  // enriched yet" — it is also every bond the worker just cleaned. Without the
  // type filter this documented "classify stocks into canonical sectors" script
  // feeds unvalidated model output straight back onto bonds, which is exactly the
  // corruption the retype removed. It also falsified the "a retyped row is
  // excluded from re-enrichment" claim that five other files rely on: true of the
  // sector-enrichment PIPELINE, false of this script until now.
  const whereClause = {
    instrumentType: "EQUITY",
    isActive: true,
    // ABSENT, not just null — MONEY-1236. Prisma's Mongo connector does not
    // match a MISSING key with `{sector: null}`, and `sector` is optional on a
    // collection that predates it. Measured on prod 2026-08-21, SCOPED to the
    // exact filter below (isActive EQUITY) rather than the whole table:
    //
    //     total                       20,953
    //     sector ABSENT                1,974   <- invisible to a bare null
    //     sector EXPLICIT null             2   <- all a bare null could ever find
    //     sector "N/A" (SECTOR_SKIPPED) 10,005
    //
    // Without `--include-na` this script looked for un-enriched equities and
    // could see TWO of the 1,976 that qualify. It then reported that population
    // as the truth and finished successfully, every run. The `N/A` arm masked it:
    // anyone running with `--include-na` got 10,005 rows and no reason to suspect
    // the other arm was returning almost nothing.
    ...(includeNA
      ? {
          OR: [
            { sector: null },
            { sector: { isSet: false } },
            { sector: "N/A" },
          ],
        }
      : { OR: [{ sector: null }, { sector: { isSet: false } }] }),
  };

  const totalCount = await prisma.instrumentMapping.count({
    where: whereClause,
  });
  const processCount = limit > 0 ? Math.min(limit, totalCount) : totalCount;

  logger.info(`Total instruments to enrich: ${totalCount}`);
  logger.info(
    `Processing: ${processCount} (batch size: ${batchSize}, include N/A: ${includeNA})`,
  );
  if (dryRun) logger.info("DRY RUN - no DB writes");

  const client = getVertexClient();

  /** Consecutive 429s tolerated before the run gives up. */
  const MAX_RATE_LIMIT_RETRIES = 5;
  let rateLimitRetries = 0;
  let processed = 0;
  let enriched = 0;
  let failed = 0;
  let batchNum = 0;

  while (processed < processCount) {
    batchNum++;
    const take = Math.min(batchSize, processCount - processed);

    const stocks = await prisma.instrumentMapping.findMany({
      where: whereClause,
      select: { symbol: true, name: true, exchange: true },
      take,
      // Skip already processed ones by using sector filter
      // (each batch updates sectors, so next query gets fresh nulls)
    });

    if (stocks.length === 0) {
      logger.info("No more instruments to enrich");
      break;
    }

    const inputs: StockInput[] = stocks.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      exchange: s.exchange,
    }));

    logger.info(
      `Batch ${batchNum}: classifying ${inputs.length} stocks (${processed + 1}-${processed + inputs.length} of ${processCount})...`,
    );

    try {
      const classified = await classifyBatch(client, inputs);
      rateLimitRetries = 0; // a successful call clears the consecutive-429 count
      logger.info(
        `  Gemini returned ${classified.length}/${inputs.length} classifications`,
      );

      if (!dryRun && classified.length > 0) {
        // Batch update using transactions
        const updates = classified.map((c) =>
          prisma.instrumentMapping.updateMany({
            where: {
              symbol: c.symbol,
              // Pinned to the listing we ASKED about. Keyed on symbol alone this
              // spanned both the NSE and BSE row for a dual-listed name, writing
              // one model answer onto two instruments.
              exchange: c.exchange,
              // Same EQUITY + isActive guard as the SELECT. The write is keyed on
              // symbol alone, so it spans both exchange listings — and without
              // the type filter it would land on a bond whose sector the nightly
              // retype had just cleared, even though the candidate came from an
              // equity-only query.
              instrumentType: "EQUITY",
              isActive: true,
              // Same absent-vs-null rule as the selection above (MONEY-1236);
              // this guard re-checks the row is still un-enriched at write
              // time, so a narrower predicate here would refuse to write
              // exactly the 3,168 rows the selection now finds.
              ...(includeNA
                ? {
                    OR: [
                      { sector: null },
                      { sector: { isSet: false } },
                      { sector: "N/A" },
                    ],
                  }
                : { OR: [{ sector: null }, { sector: { isSet: false } }] }),
            },
            data: {
              // Normalised on write as well as validated above. The
              // validation is the real guard; this makes a future edit to
              // the prompt or the parser unable to reintroduce a raw value.
              sector: normalizeToNseSector(c.sector),
              industry: c.industry,
            },
          }),
        );

        const results = await prisma.$transaction(updates);
        const updated = results.reduce((sum, r) => sum + r.count, 0);
        enriched += updated;
        logger.info(`  Updated ${updated} instruments in DB`);
      } else if (dryRun && classified.length > 0) {
        // Show sample in dry run
        classified.slice(0, 5).forEach((c) => {
          logger.info(`  [dry-run] ${c.symbol} → ${c.sector} / ${c.industry}`);
        });
        enriched += classified.length;
      }

      // Track any that Gemini didn't classify
      const classifiedSymbols = new Set(classified.map((c) => c.symbol));
      const missed = inputs.filter((s) => !classifiedSymbols.has(s.symbol));
      if (missed.length > 0) {
        failed += missed.length;
        logger.warn(
          `  ${missed.length} stocks not classified: ${missed
            .slice(0, 5)
            .map((s) => s.symbol)
            .join(", ")}${missed.length > 5 ? "..." : ""}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`  Batch ${batchNum} failed: ${msg}`);
      failed += inputs.length;

      // If rate limited, wait longer — but BOUNDED.
      //
      // This `continue`s without incrementing `processed`, and the query that
      // refills `stocks` is driven by `sector: null`, so a sustained 429 was an
      // unbounded loop: same batch, same 30s wait, forever, with no output but a
      // repeating warning. Capped so a quota exhaustion ends the run instead of
      // occupying a terminal indefinitely.
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        rateLimitRetries++;
        if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
          logger.error(
            `  Rate limited ${rateLimitRetries} times in a row — giving up. ` +
              `${processed} rows were classified before this. Re-run later to ` +
              `continue; already-classified rows are excluded by the query.`,
          );
          break;
        }
        logger.warn(
          `  Rate limited - waiting 30s before retry ` +
            `(${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})...`,
        );
        await new Promise((r) => setTimeout(r, 30_000));
        continue; // Retry same batch (stocks still have null sector)
      }
    }

    processed += stocks.length;

    // Delay between batches
    if (processed < processCount) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  logger.info("");
  logger.info("═══════════════════════════════════════");
  logger.info(`  Processed: ${processed}`);
  logger.info(`  Enriched:  ${enriched}`);
  logger.info(`  Failed:    ${failed}`);
  logger.info(`  Duration:  ${Math.round(process.uptime())}s`);
  logger.info("═══════════════════════════════════════");

  // Cleanup temp credentials file
  try {
    const fs = require("fs");
    const tmpPath = path.resolve(__dirname, "..", "..", ".tmp-sa-key.json");
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {}

  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error("Fatal:", err);
  process.exit(1);
});
