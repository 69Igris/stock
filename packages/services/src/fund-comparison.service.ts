/**
 * Fund Comparison Service
 *
 * Compare 2-4 funds (MF/ETF/INDEX) with NAV history and compositions.
 * Source: apps/web/lib/actions/fund-comparison.ts
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import {
  getMfNavHistory,
  type CompositionResult,
} from "@usemoney/core/market-data";
import type { ComparableFund } from "@usemoney/types";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import { getFundComposition } from "./fund-composition.service";
import {
  buildNormalizedComparison,
  type NamedSeries,
  type NormalizedRow,
} from "./comparison-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface ComparisonData {
  funds: ComparableFund[];
  navHistory: Record<string, Array<{ date: string; value: number }>>;
  compositions: Record<string, CompositionResult | null>;
  /**
   * NAV histories rebased to base 100 at each fund's first usable point, on the
   * union of dates — the overlay-chart series the /compare page renders. Derived
   * (server-side, finite-/div-by-zero-guarded) from `navHistory` via
   * `comparison-logic#buildNormalizedComparison` so the LIVE path and the
   * regression tests run the SAME normalization math. Column keys are
   * `fund0`, `fund1`, … aligned to `funds[i]`.
   */
  normalizedSeries: NormalizedRow[];
}

/**
 * Build the base-100 normalized overlay series for the comparison, aligned to
 * `funds` order. Pure wrapper over `buildNormalizedComparison` that maps each
 * fund to its `navHistory` entry by `${fundType}:${id}` key. Exported (and
 * called from `getComparisonData`) so the normalization the chart depends on is
 * exercised by the live service path, not just the UI.
 */
export function buildNavComparisonSeries(
  funds: ComparableFund[],
  navHistory: Record<string, Array<{ date: string; value: number }>>,
): NormalizedRow[] {
  const series: NamedSeries[] = funds.map((f) => {
    const key = `${f.fundType}:${f.id}`;
    return { key, points: navHistory[key] ?? [] };
  });
  return buildNormalizedComparison(series, "fund");
}

// ── Service Functions ──────────────────────────────────────────────

export async function getComparisonData(
  funds: Array<{ type: string; id: string }>,
): Promise<ServiceResult<ComparisonData>> {
  try {
    if (funds.length < 2 || funds.length > 5) {
      return { success: false, error: "Please select 2-5 items to compare" };
    }

    const sortedKey = funds
      .map((f) => `${f.type}:${f.id}`)
      .sort()
      .join("|");
    const cached = await getCached<ComparisonData>(
      "fund-comparison",
      "_global",
      sortedKey,
    );
    if (cached) return { success: true, data: cached };

    // Fetch all fund data in parallel
    const [fundData, navHistories, compositions] = await Promise.all([
      Promise.all(funds.map((f) => fetchComparableFund(f.type, f.id))),
      Promise.all(funds.map((f) => fetchNavHistory(f.type, f.id))),
      Promise.all(
        funds.map((f) =>
          // STOCK has no fund composition (holdings) — skip it; MF/ETF/INDEX
          // resolve their holdings as before.
          f.type === "STOCK"
            ? Promise.resolve(null)
            : fetchComposition(f.type as "ETF" | "MF" | "INDEX", f.id),
        ),
      ),
    ]);

    const navHistoryMap: Record<
      string,
      Array<{ date: string; value: number }>
    > = {};
    const compositionMap: Record<string, CompositionResult | null> = {};
    const validFunds: ComparableFund[] = [];

    for (let i = 0; i < funds.length; i++) {
      const key = `${funds[i]!.type}:${funds[i]!.id}`;
      if (fundData[i]) {
        validFunds.push(fundData[i]!);
        navHistoryMap[key] = navHistories[i] || [];
        compositionMap[key] = compositions[i] || null;
      }
    }

    const result: ComparisonData = {
      funds: validFunds,
      navHistory: navHistoryMap,
      compositions: compositionMap,
      // Pre-compute the base-100 overlay series (finite-/div-by-zero-guarded)
      // so the live path runs the same normalization the chart renders.
      normalizedSeries: buildNavComparisonSeries(validFunds, navHistoryMap),
    };

    await setCached("fund-comparison", "_global", sortedKey, result);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Fund comparison service error");
    return { success: false, error: "Failed to fetch comparison data" };
  }
}

// ── Internal Helpers ───────────────────────────────────────────────

/**
 * One fund's composition, through the SAME door the fund page uses.
 *
 * This called `getCompositionFromDb` directly, which reads only `fund_holdings`
 * — `gemini-2.5-pro`'s recollection of a portfolio it was never shown. So
 * `/compare` never looked at `mf_portfolio_holdings` at all: a fund with a
 * complete filed SEBI disclosure read as "no composition", and the client's
 * "Analyse all holdings" button then spent 2 credits and a `gemini-2.5-pro`
 * call (up to 5 per click) recalling what the AMC had already published.
 *
 * `getFundComposition` is the ordering the fund page already applies —
 * disclosure first, recollection only when there is none — and it runs
 * `normalizeComposition`, which the direct read skipped, so the finite guards
 * now cover this surface too. Its recall fallback IS `getCompositionFromDb`, so
 * a fund with no disclosure is unchanged.
 *
 * For an MF the AMFI scheme code IS `fundId`, which the service derives itself;
 * an ETF/INDEX `fundId` is a trading symbol and `/compare` has resolved no
 * scheme code, so those skip the disclosure lookup and behave exactly as before.
 *
 * The cast is the seam between two spellings of one shape: `CompositionResult`
 * narrows `holdingType`/`marketCap` to string-literal unions while the
 * disclosure path carries them as open strings (the AMC vocabulary is mapped,
 * not enumerated). Nothing on `/compare` switches on either field — it reads
 * `holdingName`/`holdingSymbol`/`sector`/`weightPercent` and `sectorBreakdown`,
 * so the cast is runtime-SAFE. It is not type-HONEST, in two ways worth naming
 * rather than leaving for the next reader to rediscover (MONEY-1401 M5):
 *
 *   1. THE VOCABULARIES DISAGREE. `ExtractedHolding.holdingType` is
 *      `EQUITY|DEBT|CASH|REIT|GOLD|OTHER`; the SEBI disclosure vocabulary
 *      (`MfPortfolioRow.holdingType`) also carries `DERIVATIVE` and
 *      `REIT_INVIT`. Those values flow through this cast and are assertions the
 *      declared type says cannot occur. Harmless only for as long as nobody
 *      switches on the field — the moment someone does, the default branch is
 *      where a fund's derivative book lands.
 *   2. `source` IS DROPPED AT THE TYPE SEAM AND CARRIED AT RUNTIME. An AMC
 *      filing and a `gemini-2.5-pro` recollection therefore render on `/compare`
 *      identically and unlabelled, while the fund page labels them — the
 *      provenance rule this repo applies everywhere else.
 *
 * Widening `ComparisonData["compositions"]` to `FundCompositionData` is the real
 * fix and it is three lines in `apps/web/app/compare/client.tsx`: the type-only
 * import at :40, the prop at :55, and the `useState` at :176 (the
 * `as unknown as CompositionResult` at :458 goes away with them). It also gets
 * the surface a `source` to render a provenance chip off.
 */
async function fetchComposition(
  fundType: "ETF" | "MF" | "INDEX",
  fundId: string,
): Promise<CompositionResult | null> {
  try {
    const result = await getFundComposition(fundType, fundId);
    if (!result.success || !result.data) return null;
    return result.data as CompositionResult;
  } catch {
    return null;
  }
}

async function fetchComparableFund(
  fundType: string,
  fundId: string,
): Promise<ComparableFund | null> {
  try {
    if (fundType === "MF") {
      const fund = await prisma.mutualFundMaster.findFirst({
        where: { schemeCode: fundId },
      });
      if (!fund) return null;
      return {
        id: fundId,
        fundType: "MF" as const,
        name: fund.schemeName,
        issuer: fund.amcName || "",
        category: fund.category || "",
        riskLevel: fund.riskLevel || null,
        nav: fund.nav,
        navDate: fund.navDate || null,
        returns1Y: fund.returns1Y,
        returns3Y: fund.returns3Y,
        returns5Y: fund.returns5Y,
        aum: fund.aum,
        expenseRatio: fund.expenseRatio || null,
        plan: fund.plan || null,
        fundManager: fund.fundManager || null,
        crisilRating: null,
        volatility: null,
        exchange: null,
        changePercent: null,
      };
    }

    if (fundType === "STOCK") {
      // MONEY-553 — STOCK reuses the ComparableFund row: nav = last price,
      // category = sector, plus the optional peRatio/marketCap stock metrics.
      // Returns stay null (same as ETF/INDEX) — the base-100 NAV/price overlay
      // is the cross-asset return view. NAV history routes through the DailyPrice
      // path in fetchNavHistory (no special-casing needed there).
      const inst = await prisma.instrumentMapping.findFirst({
        where: {
          OR: [{ symbol: fundId }, { yahooSymbol: fundId }],
          instrumentType: "EQUITY",
        },
        select: { id: true, name: true, exchange: true, sector: true },
      });
      if (!inst) return null;

      const [quote, ratios] = await Promise.all([
        prisma.latestQuote.findFirst({ where: { instrumentId: inst.id } }),
        prisma.stockRatios
          .findFirst({ where: { instrumentId: inst.id } })
          .catch(() => null),
      ]);

      return {
        id: fundId,
        fundType: "STOCK" as const,
        name: inst.name,
        issuer: "",
        category: inst.sector || "",
        riskLevel: null,
        nav: quote?.price ?? 0,
        navDate: quote?.updatedAt || null,
        returns1Y: null,
        returns3Y: null,
        returns5Y: null,
        aum: null,
        expenseRatio: null,
        plan: null,
        fundManager: null,
        crisilRating: null,
        volatility: null,
        exchange: inst.exchange || null,
        changePercent: quote?.changePercent ?? null,
        peRatio: ratios?.pe ?? null,
        // StockRatios.marketCap is in ₹ cr (Tickertape) — the unit formatAum
        // expects. (LatestQuote.marketCap may be absolute, so don't mix units.)
        marketCap: ratios?.marketCap ?? null,
      };
    }

    // ETF or INDEX - look up in InstrumentMapping
    const inst = await prisma.instrumentMapping.findFirst({
      where: {
        OR: [
          { symbol: fundId },
          { yahooSymbol: fundId },
          { name: { contains: fundId, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        yahooSymbol: true,
      },
    });

    if (!inst) return null;

    const quote = await prisma.latestQuote.findFirst({
      where: { instrumentId: inst.id },
    });

    return {
      id: fundId,
      fundType: fundType as "ETF" | "INDEX",
      name: inst.name,
      issuer: "",
      category: "",
      riskLevel: null,
      nav: quote?.price ?? 0,
      navDate: quote?.updatedAt || null,
      returns1Y: null,
      returns3Y: null,
      returns5Y: null,
      aum: null,
      expenseRatio: null,
      plan: null,
      fundManager: null,
      crisilRating: null,
      volatility: null,
      exchange: inst.exchange || null,
      changePercent: null,
    };
  } catch (error) {
    logger.warn({ error, fundType, fundId }, "etf/fund fetch failed");
    return null;
  }
}

async function fetchNavHistory(
  fundType: string,
  fundId: string,
): Promise<Array<{ date: string; value: number }>> {
  try {
    if (fundType === "MF") {
      const history = await getMfNavHistory(fundId);
      return (history || []).map((h: { date: string; nav: number }) => ({
        date: h.date,
        value: h.nav,
      }));
    }

    // ETF/INDEX - use DailyPrice table
    const inst = await prisma.instrumentMapping.findFirst({
      where: {
        OR: [{ symbol: fundId }, { yahooSymbol: fundId }],
      },
    });

    if (!inst) return [];

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const prices = await prisma.dailyPrice.findMany({
      where: {
        instrumentId: inst.id,
        date: { gte: oneYearAgo },
      },
      orderBy: { date: "asc" },
      select: { date: true, close: true },
    });

    return prices
      .filter((p) => p.date)
      .map((p) => ({
        date: p.date!.toISOString().split("T")[0]!,
        value: p.close,
      }));
  } catch (error) {
    logger.warn({ error, fundType, fundId }, "nav fetch failed");
    return [];
  }
}
