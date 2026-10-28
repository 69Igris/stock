/**
 * Fund Composition Service
 *
 * Serves a fund's portfolio composition — holdings, sector donut, market-cap
 * donut — and says WHICH of two very different sources produced it.
 * Source: apps/web/lib/actions/fund-composition.ts
 *
 * ## MONEY-1405 D4/D5 — the disclosure comes first now
 *
 * This used to read exactly one table, `FundHolding`, which is written by one
 * thing: `gemini-2.5-pro` asked what it believes a fund holds, with no document
 * in front of it. The AMC's own SEBI-mandated monthly portfolio statement has
 * been ingested the whole time in `mf_portfolio_holdings` and was never read by
 * this surface at all.
 *
 * So the order is now the same one `getMfPortfolioSection` already applies to
 * the holdings TABLE: official disclosure, and the model recollection only when
 * there is no disclosure to serve. The result carries which one it was
 * (`source`), because the panel renders a provenance chip off it and the two
 * are not interchangeable.
 *
 * The ETF path is the same call. ETFs are schemes and appear in the SAME
 * monthly AMC file — ICICI's Jul-2026 ZIP carries `ICICI Prudential Nifty 50
 * ETF.xlsx` at 50 holdings and 99.69% of NAV — they are just addressed by
 * trading symbol rather than by scheme code, so the caller passes the scheme
 * code it already resolved through `lib/fund/fund-identity`.
 */

import {
  getCompositionFromDb,
  getOrExtractComposition,
  normalizeIndexSlug,
  resolveIndexRoute,
  schemeCodeWhere,
  type CompositionResult,
} from "@usemoney/core/market-data";
import { getCached, setCached } from "@usemoney/core";
import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  normalizeComposition,
  type NormalizedComposition,
} from "./fund-composition-logic";
import {
  buildCompositionFromDisclosure,
  capBucketsBySymbol,
  crossCheckIndexSubset,
  droppingAllZero,
  indexIdForFundName,
  resolveInstrumentsByIsin,
  CAP_INDEX_PRIORITY,
  type CapBucket,
  type CompositionSource,
} from "./fund-composition-from-disclosure";

// ── Types ──────────────────────────────────────────────────────────

/**
 * The fund composition the service returns. Structurally a
 * {@link NormalizedComposition} (every weight finite-guarded, holdings sorted by
 * weight DESC, breakdowns sorted DESC + derived from holdings when missing).
 * The service ALWAYS populates `coveragePercent` and `source`, but both are
 * surfaced as optional here so existing external constructors of
 * `FundCompositionData` (e.g. the demo-data literal in `FundCompositionSection`)
 * stay valid without change. Kept derived from the logic type so the field list
 * has a single source of truth in `fund-composition-logic.ts`.
 */
export type FundCompositionData = Omit<
  NormalizedComposition,
  "coveragePercent"
> & { coveragePercent?: number; source?: CompositionSource };

// ── Helpers ────────────────────────────────────────────────────────

/**
 * One bounded page of holdings for the newest month a scheme disclosed.
 *
 * Wide enough for a full index-fund portfolio (a Nifty 500 tracker discloses
 * ~500 lines) with room to spare — the same ceiling and the same reason as
 * `HOLDING_ROWS_PER_PERIOD` in `mf-portfolio-section.service.ts`. Only ONE
 * month is read here: this surface renders a snapshot, not the month-over-month
 * diff that needs two.
 */
const DISCLOSURE_ROW_CAP = 800;

/**
 * What the disclosure read found, as THREE states rather than two.
 *
 * `NONE` is a determinate answer — this scheme has disclosed nothing — and is
 * cacheable. `UNAVAILABLE` is "we could not tell", which must never be cached
 * and must never look like `NONE`: caching a failure is how a transient blip
 * becomes a day of serving a model recollection over a filed disclosure, and
 * the failing read here (`index_constituents`, which only colours the cap
 * donut) is not even the one carrying the portfolio.
 */
type DisclosureLookup =
  | { status: "FOUND"; data: FundCompositionData }
  | { status: "NONE" }
  | { status: "UNAVAILABLE" };

/**
 * Sanitize a raw `CompositionResult` (from cache miss → DB/Gemini) into the
 * finite-guarded {@link FundCompositionData} the UI renders. Runs the pure
 * allocation math in `./fund-composition-logic.ts` so the LIVE path and the
 * regression tests execute the SAME guards — a corrupt `NaN`/`Infinity` weight
 * can no longer render as `"NaN%"`, poison the coverage total, or crown the
 * wrong top holding, and an Invalid-Date `dataAsOf` can no longer surface.
 */
function toServiceData(result: CompositionResult): FundCompositionData {
  // Through {@link served}, so the RECALL MISS gets the same all-zero guard the
  // cache HIT does — MONEY-1401 L1. It did not: `normalizeComposition` DERIVES
  // a breakdown from the holdings whenever the stored one is empty, and an
  // all-zero recollection derives all-zero slices whose `length > 0` is what
  // the panel guards on. So an empty circle with a `0.0%` legend rendered on
  // first view and then correctly vanished for the next 24h — the same defect
  // `served()` was added for, on the other side of the cache.
  return served({ ...normalizeComposition(result), source: "GEMINI_RECALL" });
}

/**
 * Build a composition out of the AMC's own disclosure.
 *
 * The read is deliberately quiet about everything except the three states in
 * {@link DisclosureLookup}: a sector join that resolves nothing still produces
 * a usable composition (every line lands in "Unclassified" and the weights
 * still sum), so only the ABSENCE of disclosed rows falls through to the model
 * recollection.
 *
 * It catches its OWN errors rather than letting them reach `getFundComposition`'s
 * outer catch. It used to be the only step in that function with no try/catch,
 * so a thrown DB error here — including one from `index_constituents`, which
 * decides nothing but the cap donut's colours — skipped `getCompositionFromDb`
 * entirely and cost the reader a perfectly good stored composition. Only the
 * `logIndexSubsetCheck` diagnostic had that guard.
 */
async function compositionFromDisclosure(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
  schemeCode: string,
): Promise<DisclosureLookup> {
  try {
    return await readDisclosure(fundType, fundId, schemeCode);
  } catch (error) {
    logger.warn(
      { error, fundType, fundId, schemeCode },
      "Fund composition disclosure read failed; falling back to the stored composition",
    );
    return { status: "UNAVAILABLE" };
  }
}

async function readDisclosure(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
  schemeCode: string,
): Promise<DisclosureLookup> {
  // MONEY-1294 — matches the primary code OR any plan variant. AMFI splits one
  // filed portfolio across up to four codes and this surface is reached by
  // whichever one the caller resolved, so consulting only the primary answered
  // "no disclosure" for three plans of a fund whose portfolio was in the table.
  const newest = await prisma.mfPortfolioHolding.findFirst({
    where: schemeCodeWhere(schemeCode),
    orderBy: { period: "desc" },
    select: { period: true, amc: true, schemeKey: true },
  });
  if (!newest) return { status: "NONE" };

  // Narrowed to the newest row's OWN (amc, schemeKey), not to the scheme code
  // alone. The table's identity is (period, amc, schemeKey, instrumentName) and
  // `amfiSchemeCode` is a nullable join handle on top of it, so two sheets
  // resolving to one code would union into a single portfolio whose weights sum
  // to ~200 and are then silently rescaled back to 100 by the donut pass.
  //
  // `amc` is HALF of that identity and was missing here. `schemeKey` is a
  // normalisation of the PRINTED SCHEME NAME alone — nothing in it is unique to
  // a filer — so two AMCs printing the same name are one key, and the read
  // would serve one fund's holdings for the other. MEASURED on prod 2026-09-13:
  // 0 of 662 keys span more than one AMC today, but 9 of them carry no AMC name
  // at all (Shriram and Baroda BNP print the SEBI category line as the scheme
  // name — "an-open-ended-liquid-scheme-…"), which is exactly the shape that
  // collides as coverage grows from 13 filers to 17. Latent, and one field.
  //
  // The read still sits on `@@index([schemeKey, period(sort: Desc)])`; `amc`
  // filters inside that.
  //
  // MONEY-1401 — this line used to add "(`amfiSchemeCode` has none)". That was
  // true when it was written and was made FALSE by the same commit
  // (8a2f8199 added `@@index([amfiSchemeCode, period(sort: Desc)])` and
  // `@@index([amfiSchemeCodes, period(sort: Desc)])` to schema.prisma). See the
  // note on {@link NoDisclosure} for what that does and does not buy.
  const rows = await prisma.mfPortfolioHolding.findMany({
    where: {
      amc: newest.amc,
      schemeKey: newest.schemeKey,
      period: newest.period,
    },
    orderBy: [{ percentToNav: "desc" }],
    take: DISCLOSURE_ROW_CAP,
    select: {
      instrumentName: true,
      isin: true,
      holdingType: true,
      percentToNav: true,
      schemeName: true,
    },
  });
  if (rows.length === 0) return { status: "NONE" };

  const isins = Array.from(
    new Set(
      rows
        .map((r) => r.isin)
        .filter((i): i is string => typeof i === "string" && i.trim() !== ""),
    ),
  );

  // One ISIN can carry several instrument rows — an NSE one and a BSE one, and
  // (measured, twice on prod) two NSE ones across a rename. `isActive` is
  // selected because the ranking in `resolveInstrumentsByIsin` uses it; it
  // ranks, it never filters.
  const instruments = isins.length
    ? await prisma.instrumentMapping.findMany({
        where: { isin: { in: isins } },
        select: {
          isin: true,
          symbol: true,
          exchange: true,
          sector: true,
          industry: true,
          isActive: true,
        },
      })
    : [];
  const instrumentsByIsin = resolveInstrumentsByIsin(instruments);

  const constituents = await prisma.indexConstituent.findMany({
    where: { indexId: { in: CAP_INDEX_PRIORITY.map(([id]) => id) } },
    select: { indexId: true, symbol: true },
  });
  const capBySymbol = capBucketsBySymbol(constituents);
  const capByIsin = new Map<string, CapBucket>();
  for (const [isin, facts] of instrumentsByIsin.entries()) {
    const bucket = capBySymbol.get(facts.symbol);
    if (bucket) capByIsin.set(isin, bucket);
  }

  const data = buildCompositionFromDisclosure(
    { fundType, fundId, period: newest.period, holdings: rows },
    instrumentsByIsin,
    capByIsin,
  );

  if (fundType === "ETF") {
    await logIndexSubsetCheck(fundId, rows[0]?.schemeName ?? "", data.holdings);
  }
  return { status: "FOUND", data };
}

/**
 * D5 — log whether the ETF's disclosure contains every constituent of the index
 * it is named after. NEVER blocking: NSE's constituent CSVs carry no weights,
 * so membership can only ever be a cross-check, and a miss is as likely to be a
 * rebalance between the disclosure month and today as it is a parse gap.
 */
async function logIndexSubsetCheck(
  fundId: string,
  schemeName: string,
  holdings: ReadonlyArray<{ holdingSymbol: string | null }>,
): Promise<void> {
  try {
    const indexId = indexIdForFundName(
      schemeName,
      resolveIndexRoute,
      normalizeIndexSlug,
    );
    if (!indexId) return;
    const rows = await prisma.indexConstituent.findMany({
      where: { indexId },
      select: { symbol: true },
    });
    const check = crossCheckIndexSubset(
      indexId,
      rows.map((r) => r.symbol),
      holdings.map((h) => h.holdingSymbol),
    );
    if (!check) return;
    logger.info(
      {
        fundId,
        indexId: check.indexId,
        constituents: check.constituents,
        missing: check.missing.length,
        sample: check.missing.slice(0, 10),
      },
      "Fund composition index subset cross-check",
    );
  } catch (error) {
    logger.warn({ error, fundId }, "Index subset cross-check failed");
  }
}

// ── Cache keys ─────────────────────────────────────────────────────

/**
 * Written under the disclosure key when a scheme has demonstrably disclosed
 * nothing, so the next read can skip straight to the recollection.
 *
 * It is a DETERMINATE answer, which is the whole reason it may be cached at
 * all: `UNAVAILABLE` (the read failed) is never written here.
 *
 * IT IS STILL WORTH CACHING, but not for the reason this used to give. Both
 * arms of `schemeCodeWhere` ARE indexed now — MONEY-1294 added
 * `@@index([amfiSchemeCode, period(sort: Desc)])` and
 * `@@index([amfiSchemeCodes, period(sort: Desc)])` in the same commit that
 * filled the columns — so the lookup this saves is an index probe, not a
 * collection scan over 54,248 rows. What it saves is a round trip per view for
 * the ~4 in 5 schemes that have no disclosure at all.
 *
 * THE INDEXES EXIST IN `schema.prisma`, WHICH IS NOT THE SAME AS EXISTING IN A
 * DATABASE. Mongo has no migrations here: an index is created by a manual
 * `yarn workspace @usemoney/database prisma db push`, PER ENVIRONMENT. Until
 * that has been run against an environment, the read there really is a
 * collection scan — so do not read this paragraph as a statement about prod
 * until `db.mf_portfolio_holdings.getIndexes()` says so.
 */
interface NoDisclosure {
  none: true;
}

function isNoDisclosure(v: unknown): v is NoDisclosure {
  return (
    typeof v === "object" && v !== null && (v as NoDisclosure).none === true
  );
}

/**
 * The cache key, and it carries the SOURCE.
 *
 * It did not, and that was a data-integrity bug rather than a tidiness one.
 * `/compare` calls `triggerCompositionExtractionAction(fundType, id)` with no
 * scheme code; for an MF the service derives `resolvedSchemeCode = fundId`, and
 * an MF `fundId` IS the AMFI scheme code — so the recollection landed on
 * `MF:119598:119598`, byte-identical to the key `/mf/[schemeCode]` reads, and
 * replaced a filed SEBI disclosure with a model's memory of one for 24h. The
 * ETF path escaped only by accident (`ETF:SYM:` vs `ETF:SYM:<code>`), which is
 * why no test saw it.
 *
 * A disclosure is filed fact and a recollection is a model's memory. They get
 * separate slots, and the read below prefers the filing — so neither write can
 * displace the other whatever order the two pages are visited in.
 */
function compositionCacheKey(
  fundType: string,
  fundId: string,
  schemeCode: string | undefined,
  source: CompositionSource,
): string {
  return `${fundType}:${fundId}:${schemeCode ?? ""}:${source}`;
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Get fund composition from the AMC disclosure, else DB/cache (no Gemini call).
 * Returns data: null when neither source has anything.
 *
 * `schemeCode` is the AMFI code the disclosure is keyed by. For an MF it IS
 * `fundId`; for an ETF the page resolves it through `lib/fund/fund-identity`
 * and passes it, because `fundId` there is a trading symbol and
 * `mf_portfolio_holdings` has never been keyed by one.
 *
 * Order is DISCLOSURE, then recollection, at BOTH layers — cached disclosure,
 * disclosed rows, cached recollection, stored recollection. Reading the
 * recollection cache before looking for a disclosure would re-open the defect
 * `compositionCacheKey` closes, one layer down: a `/compare` visit would still
 * decide what the fund page serves for the next 24h.
 */
export async function getFundComposition(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
  schemeCode?: string,
): Promise<ServiceResult<FundCompositionData | null>> {
  try {
    // The scheme code is part of the ANSWER, not just of the lookup: the same
    // ETF read once without one and once with would otherwise serve the
    // recollection from cache after the disclosure became reachable.
    const resolvedSchemeCode =
      schemeCode ?? (fundType === "MF" ? fundId : undefined);
    const disclosureKey = compositionCacheKey(
      fundType,
      fundId,
      resolvedSchemeCode,
      "AMC_DISCLOSURE",
    );
    const recallKey = compositionCacheKey(
      fundType,
      fundId,
      resolvedSchemeCode,
      "GEMINI_RECALL",
    );

    if (resolvedSchemeCode) {
      const cachedDisclosure = await getCached<
        FundCompositionData | NoDisclosure
      >("fund-composition", "_global", disclosureKey);
      if (cachedDisclosure && !isNoDisclosure(cachedDisclosure)) {
        return { success: true, data: served(cachedDisclosure) };
      }
      if (!cachedDisclosure) {
        const disclosed = await compositionFromDisclosure(
          fundType,
          fundId,
          resolvedSchemeCode,
        );
        if (disclosed.status === "FOUND") {
          await setCached(
            "fund-composition",
            "_global",
            disclosureKey,
            disclosed.data,
          );
          return { success: true, data: disclosed.data };
        }
        if (disclosed.status === "NONE") {
          await setCached("fund-composition", "_global", disclosureKey, {
            none: true,
          } satisfies NoDisclosure);
        }
      }
    }

    const cachedRecall = await getCached<FundCompositionData>(
      "fund-composition",
      "_global",
      recallKey,
    );
    if (cachedRecall) return { success: true, data: served(cachedRecall) };

    const result = await getCompositionFromDb(fundType, fundId);
    if (!result) return { success: true, data: null };

    const data = toServiceData(result);
    await setCached("fund-composition", "_global", recallKey, data);
    return { success: true, data };
  } catch (error) {
    logger.error({ error }, "Fund composition service error");
    return { success: false, error: "Failed to load composition data" };
  }
}

/**
 * Re-normalize on read: a cache entry written by an older code version (or a
 * poisoned upstream row that was cached) is re-sanitized before it ever reaches
 * the UI. `normalizeComposition` is idempotent on already-finite data, so a
 * fresh entry round-trips unchanged.
 *
 * EXCEPT for an EMPTY breakdown, which it is not idempotent on: an empty one is
 * the signal to DERIVE from the holdings. That is right for a composition that
 * simply never carried a pre-aggregated breakdown, and wrong for one whose
 * breakdown `droppingAllZero` deliberately emptied — every holding weight is 0,
 * so the derived slices are 0 too, and `length > 0` is what the panel guards on.
 * The result is a cache MISS that correctly renders no donut and a HIT, for the
 * next 24h, that renders an empty circle with a `0.0%` legend under a footer
 * asserting the fund house filed it. So the same guard runs on the way out.
 */
function served(cached: FundCompositionData): FundCompositionData {
  const normalized = normalizeComposition(cached);
  return {
    ...normalized,
    sectorBreakdown: droppingAllZero(normalized.sectorBreakdown),
    capBreakdown: droppingAllZero(normalized.capBreakdown),
    assetBreakdown: droppingAllZero(normalized.assetBreakdown),
    source: cached.source,
  };
}

/**
 * Trigger composition extraction via Gemini AI.
 * Uses cached DB data if fresh, otherwise calls Gemini.
 *
 * This is the EXPLICIT path only — a button a signed-in user pressed. Nothing
 * auto-fires it any more (`shouldAutoExtractComposition` returns false for every
 * fund type), and what it produces is labelled `GEMINI_RECALL` wherever it is
 * rendered.
 */
export async function triggerCompositionExtraction(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
  schemeCode?: string,
): Promise<ServiceResult<FundCompositionData>> {
  try {
    const result = await getOrExtractComposition(fundType, fundId);
    if (!result) {
      return {
        success: false,
        error: "Failed to extract composition. The fund may not be available.",
      };
    }

    const data = toServiceData(result);
    const resolvedSchemeCode =
      schemeCode ?? (fundType === "MF" ? fundId : undefined);
    // The RECOLLECTION slot, always — never the disclosure's. See
    // `compositionCacheKey`.
    await setCached(
      "fund-composition",
      "_global",
      compositionCacheKey(
        fundType,
        fundId,
        resolvedSchemeCode,
        "GEMINI_RECALL",
      ),
      data,
    );
    return { success: true, data };
  } catch (error) {
    logger.error({ error }, "Fund composition extraction error");
    return { success: false, error: "Extraction failed. Please try again." };
  }
}
