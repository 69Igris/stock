/**
 * Fund Composition Service
 *
 * Extracts and caches portfolio holdings (stocks, sectors, market cap) for
 * Mutual Funds and ETFs using Gemini AI.
 *
 * Data flow:
 * 1. Check DB (FundHolding + FundCompositionMeta)
 * 2. If missing, clock-stale (>90 days) or CONTENT-stale, extract via Gemini
 * 3. Parse JSON response, validate, apply the provenance gate, persist to DB
 * 4. Return denormalized CompositionResult
 *
 * ## MONEY-1205 — this is a MODEL ESTIMATE, not a disclosure reading
 *
 * Nothing here reads a filed SEBI portfolio statement. Gemini is asked what it
 * believes a fund holds and answers from training data; the `dataAsOf` and
 * `confidence` it returns are its own claims about its own answer. Measured on
 * prod 2026-08-18: all 111 `fund_composition_meta` rows carry `dataAsOf` in
 * {2024-04, 2024-05, 2024-06} at confidence 0.95-0.99, while `extractedAt`
 * spans 2026-02 -> 2026-08 — six months of re-extraction returning the same
 * two-year-old content at 95%+ self-reported confidence.
 *
 * Two consequences are wired in below and must not be undone:
 *  - freshness is gated on the CONTENT (`dataAsOf`), not the clock
 *    (`extractedAt`). The clock gate can never fire: every re-extraction
 *    re-stamps `extractedAt = now` and re-arms a fresh 90-day window around
 *    identical stale content.
 *  - a content-stale result is recorded as FAILED, so it can never be served as
 *    authoritative — `getCompositionFromDb` only returns READY rows.
 */

import { prisma } from "@usemoney/database";
import { getGeminiModel, generateWithTimeout } from "../../gemini/models";
import {
  type ExtractedHolding,
  type ParsedGeminiResponse,
  isCompositionStale,
  isCompositionContentStale,
  contentStaleReason,
  decideCompositionPersist,
  isFailedRetryDue,
  isExtractionLockHeld,
  parseGeminiResponse,
  validateHoldings,
  buildExtractionPrompt,
} from "./fund-composition-logic";

// ============== TYPES ==============

// ExtractedHolding lives in ./fund-composition-logic (pure-logic source of
// truth); re-exported here so existing consumers keep importing it from this
// module / the market-data barrel.
export type { ExtractedHolding };

export interface CompositionResult {
  fundType: "MF" | "ETF" | "INDEX";
  fundId: string;
  holdings: ExtractedHolding[];
  sectorBreakdown: Array<{ sector: string; weight: number }>;
  capBreakdown: Array<{ cap: string; weight: number }>;
  assetBreakdown: Array<{ type: string; weight: number }>;
  totalHoldings: number;
  confidence: number;
  dataAsOf: string;
}

// ============== PUBLIC API ==============

/**
 * Get composition from DB if available and fresh, otherwise extract via Gemini.
 *
 * MONEY-1205 — three gates, in order:
 *  1. CONTENT staleness demotes a READY row whose `dataAsOf` cannot be tied to
 *     a recent disclosure. That row was a failed extraction recorded as a
 *     success; it is marked FAILED here and NOT re-extracted on the same call,
 *     because we have six months of measured evidence that an immediate
 *     re-extraction returns the identical stale content.
 *  2. CLOCK staleness (the original 90-day `extractedAt` gate) still applies to
 *     rows whose content IS current.
 *  3. A recent FAILED row is left alone for `FAILED_RETRY_COOLDOWN_MS`, and a
 *     row parked in EXTRACTING is treated as in-flight for `EXTRACTION_LOCK_MS`.
 *     Without (3), demoting a row in (1) would turn one bad row into an
 *     extraction on EVERY page view — a worse runaway than the one being fixed.
 */
export async function getOrExtractComposition(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
): Promise<CompositionResult | null> {
  // 1. Check existing meta
  const meta = await prisma.fundCompositionMeta.findUnique({
    where: { fundType_fundId: { fundType, fundId } },
  });

  if (meta && meta.status === "READY") {
    // Content gate FIRST: a row can be minutes old on the clock and still be
    // reciting a two-year-old portfolio.
    if (isCompositionContentStale(meta.dataAsOf)) {
      await demoteContentStale(fundType, fundId, meta.dataAsOf);
      return null;
    }
    // If we have fresh data, return it from DB
    if (!isCompositionStale(meta.extractedAt)) {
      return buildResultFromDb(fundType, fundId, meta);
    }
  }

  // Another extraction is already running for this fund — don't spend a second
  // Gemini call on it.
  if (
    meta &&
    meta.status === "EXTRACTING" &&
    isExtractionLockHeld(meta.updatedAt)
  ) {
    return null;
  }

  // A recent failure stays failed; retrying it on every page view is the
  // runaway this ticket exists to stop.
  if (meta && meta.status === "FAILED" && !isFailedRetryDue(meta.updatedAt)) {
    return null;
  }

  // 2. Extract via Gemini
  return extractComposition(fundType, fundId);
}

/**
 * Force re-extraction via Gemini (bypasses freshness check).
 */
export async function refreshComposition(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
): Promise<CompositionResult | null> {
  return extractComposition(fundType, fundId);
}

/**
 * Read composition from DB only (no Gemini call). Returns null if not available.
 *
 * MONEY-1205 — a READY row whose CONTENT is stale is NOT available. It is
 * demoted to FAILED on the way out (a single idempotent upsert that can only
 * fire once per row, since the row is no longer READY afterwards) so the stored
 * record stops claiming an extraction succeeded. The demotion is best-effort:
 * this is a read path and a write failure must never turn a "no composition"
 * into a 500, so the return value does not depend on it.
 */
export async function getCompositionFromDb(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
): Promise<CompositionResult | null> {
  const meta = await prisma.fundCompositionMeta.findUnique({
    where: { fundType_fundId: { fundType, fundId } },
  });

  if (!meta || meta.status !== "READY") return null;

  if (isCompositionContentStale(meta.dataAsOf)) {
    await demoteContentStale(fundType, fundId, meta.dataAsOf);
    return null;
  }

  return buildResultFromDb(fundType, fundId, meta);
}

// ============== INTERNAL ==============

/**
 * Build CompositionResult from DB records.
 */
async function buildResultFromDb(
  fundType: string,
  fundId: string,
  meta: {
    totalHoldings: number;
    confidence: number | null;
    dataAsOf: string | null;
    sectorBreakdown: unknown;
    capBreakdown: unknown;
    assetBreakdown: unknown;
  },
): Promise<CompositionResult> {
  const holdings = await prisma.fundHolding.findMany({
    where: { fundType, fundId },
    orderBy: { weightPercent: "desc" },
  });

  return {
    fundType: fundType as "MF" | "ETF" | "INDEX",
    fundId,
    holdings: holdings.map((h) => ({
      holdingName: h.holdingName,
      holdingSymbol: h.holdingSymbol,
      isin: h.isin,
      holdingType: h.holdingType as ExtractedHolding["holdingType"],
      sector: h.sector,
      industry: h.industry,
      marketCap: h.marketCap as ExtractedHolding["marketCap"],
      weightPercent: h.weightPercent,
    })),
    sectorBreakdown:
      (meta.sectorBreakdown as Array<{
        sector: string;
        weight: number;
      }>) ?? [],
    capBreakdown:
      (meta.capBreakdown as Array<{
        cap: string;
        weight: number;
      }>) ?? [],
    assetBreakdown:
      (meta.assetBreakdown as Array<{
        type: string;
        weight: number;
      }>) ?? [],
    totalHoldings: meta.totalHoldings,
    confidence: meta.confidence ?? 0,
    dataAsOf: meta.dataAsOf ?? "",
  };
}

/**
 * Core extraction flow: look up fund info → call Gemini → persist.
 */
async function extractComposition(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
): Promise<CompositionResult | null> {
  // Mark status as EXTRACTING
  await prisma.fundCompositionMeta.upsert({
    where: { fundType_fundId: { fundType, fundId } },
    create: {
      fundType,
      fundId,
      status: "EXTRACTING",
      extractedAt: new Date(),
    },
    update: { status: "EXTRACTING", updatedAt: new Date() },
  });

  try {
    // 1. Get fund info for context
    const fundInfo = await getFundInfo(fundType, fundId);
    if (!fundInfo) {
      await markFailed(fundType, fundId, "Fund not found in database");
      return null;
    }

    // 2. Build prompt
    const prompt = buildExtractionPrompt(fundType, fundInfo);

    // 3. Call Gemini 2.5 Pro (advanced mode with thinking)
    const model = getGeminiModel("advanced");
    const rawResponse = await generateWithTimeout(model, prompt, 60000);

    // 4. Parse JSON from response
    const parsed = parseGeminiResponse(rawResponse);
    if (!parsed) {
      await markFailed(fundType, fundId, "Failed to parse Gemini response");
      return null;
    }

    // 5. Validate and clean holdings
    const validHoldings = validateHoldings(parsed.holdings);
    if (validHoldings.length === 0) {
      await markFailed(fundType, fundId, "No valid holdings extracted");
      return null;
    }

    // 6. Persist to DB — the provenance gate can reject the write.
    const stored = await persistComposition(
      fundType,
      fundId,
      validHoldings,
      parsed,
    );
    if (!stored) {
      // A rejected extraction must not be RETURNED either, or the caller would
      // render exactly the content we just refused to store.
      return null;
    }

    // 7. Return result
    return {
      fundType,
      fundId,
      holdings: validHoldings,
      sectorBreakdown: parsed.sectorBreakdown ?? [],
      capBreakdown: parsed.capBreakdown ?? [],
      assetBreakdown: parsed.assetBreakdown ?? [],
      totalHoldings: validHoldings.length,
      // 0, not `parsed.confidence`. MONEY-1405 D6 stopped PERSISTING the
      // model's self-grade; returning it here would put the same number on the
      // same render for one request and 0 for every request after the cache
      // expired — the field disagreeing with itself depending on whether the
      // answer came from Gemini or from the row it just wrote.
      confidence: 0,
      dataAsOf: parsed.dataAsOf ?? "",
    };
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Unknown extraction error";
    console.error(
      `[fund-composition] Extraction failed for ${fundType}:${fundId}:`,
      msg,
    );
    await markFailed(fundType, fundId, msg);
    return null;
  }
}

/**
 * Look up fund name/AMC/category from the appropriate master table.
 */
async function getFundInfo(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
): Promise<{ name: string; issuer: string; category: string } | null> {
  if (fundType === "MF") {
    const mf = await prisma.mutualFundMaster.findFirst({
      where: { schemeCode: fundId },
    });
    if (!mf) return null;
    return {
      name: mf.schemeName,
      issuer: mf.amcName,
      category: mf.category,
    };
  }

  // ETF or INDEX - look up from InstrumentMapping
  const inst = await prisma.instrumentMapping.findFirst({
    where: {
      symbol: fundId,
      instrumentType: fundType === "INDEX" ? "INDEX" : "ETF",
      isActive: true,
    },
  });
  if (!inst) return null;
  return {
    name: inst.name,
    issuer: inst.name,
    category: fundType === "INDEX" ? "Index" : "ETF",
  };
}

/**
 * Persist holdings and meta to DB. Deletes old holdings first.
 *
 * MONEY-1205 — the provenance gate lives HERE, at the single write, so no call
 * site can bypass it. When {@link decideCompositionPersist} says FAILED:
 *  - the meta row is written FAILED with the reason, NOT READY. Recording a
 *    failed extraction as a success is the whole defect: a `dataAsOf` 27 months
 *    behind `now` was stored with `status: "READY"` and `confidence: 0.95`, and
 *    the ETF page then printed both as provenance.
 *  - the existing `FundHolding` rows are LEFT ALONE — neither replaced with the
 *    stale ones nor deleted. Writing holdings we have just judged unusable is
 *    the same lie one table over, and deleting them would starve
 *    `getMfPortfolioSection`'s fallback (mf-portfolio-section.service.ts), which
 *    reads `FundHolding` when the AMC publishes nothing machine-readable.
 *
 * Returns whether the composition was stored as READY.
 */
async function persistComposition(
  fundType: string,
  fundId: string,
  holdings: ExtractedHolding[],
  parsed: ParsedGeminiResponse,
): Promise<boolean> {
  const decision = decideCompositionPersist(parsed.dataAsOf);
  if (decision.status === "FAILED") {
    console.warn(
      `[fund-composition] Rejecting extraction for ${fundType}:${fundId}: ${decision.errorMessage}`,
    );
    await markFailed(
      fundType,
      fundId,
      decision.errorMessage ?? "Stale content",
    );
    return false;
  }

  // Delete existing holdings for this fund
  await prisma.fundHolding.deleteMany({
    where: { fundType, fundId },
  });

  // Insert new holdings
  await prisma.fundHolding.createMany({
    data: holdings.map((h) => ({
      fundType,
      fundId,
      holdingName: h.holdingName,
      holdingSymbol: h.holdingSymbol,
      isin: h.isin,
      holdingType: h.holdingType,
      sector: h.sector,
      industry: h.industry,
      marketCap: h.marketCap,
      weightPercent: h.weightPercent,
      source: "gemini",
    })),
  });

  // Upsert meta.
  //
  // MONEY-1405 D6 — `confidence` is NOT WRITTEN any more. The column stays
  // (111 historical rows carry a value and deleting it would destroy the
  // evidence this decision rests on), but nothing puts a new number in it.
  // It is the MODEL's grade of its OWN answer, it defaults to 0.7 when the
  // model does not volunteer one, and on prod every one of those 111 rows sat
  // at 0.95-0.99 while reciting a 26-28 month old portfolio. A `dataAsOf` of
  // "2024-05" stored at 0.98 is a recollection grading itself, and a
  // self-report cannot be evidence about itself.
  await prisma.fundCompositionMeta.upsert({
    where: { fundType_fundId: { fundType, fundId } },
    create: {
      fundType,
      fundId,
      totalHoldings: holdings.length,
      extractedAt: new Date(),
      source: "GEMINI_RECALL",
      status: "READY",
      sectorBreakdown: parsed.sectorBreakdown,
      capBreakdown: parsed.capBreakdown,
      assetBreakdown: parsed.assetBreakdown,
      dataAsOf: parsed.dataAsOf,
    },
    update: {
      totalHoldings: holdings.length,
      extractedAt: new Date(),
      source: "GEMINI_RECALL",
      status: "READY",
      sectorBreakdown: parsed.sectorBreakdown,
      capBreakdown: parsed.capBreakdown,
      assetBreakdown: parsed.assetBreakdown,
      dataAsOf: parsed.dataAsOf,
      errorMessage: null,
    },
  });

  return true;
}

/**
 * MONEY-1205 — demote a stored READY row whose CONTENT is stale.
 *
 * Best-effort by design: `getCompositionFromDb` is a read path (an API GET and
 * the cached service read both land there) and must not 500 because a write
 * failed. The caller's decision to withhold the composition does not depend on
 * this succeeding.
 */
async function demoteContentStale(
  fundType: string,
  fundId: string,
  dataAsOf: string | null,
): Promise<void> {
  try {
    await markFailed(fundType, fundId, contentStaleReason(dataAsOf));
  } catch (error) {
    console.error(
      `[fund-composition] Failed to demote content-stale ${fundType}:${fundId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Mark extraction as failed.
 */
async function markFailed(
  fundType: string,
  fundId: string,
  errorMessage: string,
): Promise<void> {
  await prisma.fundCompositionMeta.upsert({
    where: { fundType_fundId: { fundType, fundId } },
    create: {
      fundType,
      fundId,
      status: "FAILED",
      extractedAt: new Date(),
      errorMessage,
    },
    update: {
      status: "FAILED",
      errorMessage,
      updatedAt: new Date(),
    },
  });
}
