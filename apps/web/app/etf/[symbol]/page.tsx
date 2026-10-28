// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

/**
 * ETF Detail Page — Server Component (MONEY-457, canonical since MONEY-1205)
 *
 * `/etf/[symbol]` is THE page for an `instrumentType === "ETF"` instrument.
 * `/stock/[symbol]` redirects here and `/mf/[schemeCode]` redirects here when
 * the scheme's ISIN belongs to a listed ETF, because one fund rendering at
 * three URLs with three different sets of numbers is worse than any one of
 * them.
 *
 * ## What changed in MONEY-1205
 *
 * This page ALREADY joined `mutual_fund_masters` by ISIN — it selected returns
 * and AUM from the row and threw the identity columns away. So it held
 * `"SBI Mutual Fund"` / category `"ETF"` / scheme code `145648` and rendered
 * `titleCase("SBI")` → **"Sbi"**, the name-keyword fallthrough **"Other"** as
 * the category, and "Other" a SECOND time as the fund's benchmark. Identity
 * now comes from `lib/fund/fund-identity`, which resolves it once and persists
 * `InstrumentMapping.amfiSchemeCode` so the join is a lookup next time.
 *
 * `lib/screener/etf-derive` stays, demoted to what it always was: a parse of
 * the ticker's own name, used only when no master row joins.
 *
 * Data path:
 *   1. resolveFundIdentity — instrument + master identity, one seam
 *   2. latestQuote — live price + day change
 *   3. getFundNavDerivatives — returns + WHY a return is null (scheme code only)
 *   4. dailyPrice — 52-week traded range (an ETF has a real OHLC series;
 *      a price high is NOT a NAV high and is labelled as such downstream)
 *
 * URL: /etf/SBIETFQLTY?exchange=NSE
 */

import { prisma } from "@usemoney/database";
import { notFound } from "next/navigation";
import { getFundNavDerivatives } from "@usemoney/services";
import EtfDetailClient from "./client";
import ChartPreloadLinks from "@/components/charts/ChartPreloadLinks";
import { resolveFundIdentity } from "@/lib/fund/fund-identity";
import {
  extractEtfFundHouse,
  deriveEtfCategory,
  deriveEtfAssetClass,
} from "@/lib/screener/etf-derive";

interface EtfPageProps {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ exchange?: string }>;
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** 52-week traded range from our own daily closes. Null when there is none. */
async function priceRange52W(
  instrumentId: string
): Promise<{ high: number | null; low: number | null }> {
  try {
    const agg = await prisma.dailyPrice.aggregate({
      where: {
        instrumentId,
        date: { gte: new Date(Date.now() - ONE_YEAR_MS) },
      },
      _max: { high: true },
      _min: { low: true },
      _count: { _all: true },
    });
    // One bar is a point, not a range — same rule `computeNavDerivatives`
    // applies to the NAV window.
    if ((agg._count?._all ?? 0) < 2) return { high: null, low: null };
    return { high: agg._max.high ?? null, low: agg._min.low ?? null };
  } catch {
    return { high: null, low: null };
  }
}

export default async function EtfPage({ params, searchParams }: EtfPageProps) {
  const { symbol } = await params;
  const { exchange: exchangeParam } = await searchParams;

  const identity = await resolveFundIdentity({
    symbol,
    exchange: exchangeParam,
    instrumentTypes: ["ETF"],
  });

  // No listed ETF under this symbol. A master row alone is not enough to render
  // an ETF page — there would be no exchange, no ticker and no chart.
  if (!identity?.instrumentId || !identity.symbol) {
    notFound();
  }

  const instrumentId = identity.instrumentId;
  const etfSymbol = identity.symbol;
  const exchange = identity.exchange ?? "NSE";

  // Latest quote for live price
  let quote: {
    price: number | null;
    change: number | null;
    changePercent: number | null;
    previousClose: number | null;
  } = {
    price: null,
    change: null,
    changePercent: null,
    previousClose: null,
  };
  try {
    const q = await prisma.latestQuote.findFirst({
      where: { instrumentId },
      select: {
        price: true,
        change: true,
        changePercent: true,
        previousClose: true,
      },
    });
    if (q) {
      quote = {
        price: q.price ?? null,
        change: q.change ?? null,
        changePercent: q.changePercent ?? null,
        previousClose: q.previousClose ?? null,
      };
    }
  } catch {
    // Quote absent — leave null
  }

  const master = identity.master;

  // TODO(MONEY-457 followup): iNAV here is end-of-day NAV from
  // MutualFundMaster, refreshed by the existing MF NAV sync once per day. It's
  // intentionally 1-day-old for now. Live (intra-day) iNAV requires a separate
  // ETF iNAV feed ingestion path. Until that ships, users can read iNAV as
  // "yesterday's official NAV" and use LTP as the live market reference.
  const inav = master?.nav ?? null;
  const inavDate = master?.navDate ?? null;

  const [navStats, range] = await Promise.all([
    identity.schemeCode
      ? getFundNavDerivatives({ schemeCode: identity.schemeCode })
      : Promise.resolve(null),
    priceRange52W(instrumentId),
  ]);
  const nav = navStats?.success ? navStats.data : null;

  // ── Identity: master first, name-parse only as the fallback ──────────────
  //
  // 541 of 541 active ETF rows in prod carry an ISIN and every one of them
  // joins a master row today, but the fallback is not dead code: a newly
  // listed ETF is in `instrument_mappings` before AMFI publishes it, and that
  // is exactly the window in which the page must still render.
  const derivedHouse = extractEtfFundHouse(identity.schemeName ?? etfSymbol);
  const derivedCategory = deriveEtfCategory(identity.schemeName ?? etfSymbol);
  const assetClass = deriveEtfAssetClass(identity.schemeName ?? etfSymbol);

  const fundHouse = master?.amcName ?? derivedHouse;
  const category = master?.category ?? derivedCategory;
  const subCategory = master?.subCategory ?? assetClass;

  // The master's own description when it has one (2 of 307 do today); a
  // sentence assembled from RESOLVED identity otherwise. Every clause below is
  // a fact off the joined row or the exchange listing — the version this
  // replaces asserted the derived AMC and the fallthrough category as if they
  // were filed.
  const description =
    master?.description ??
    `${identity.schemeName ?? etfSymbol} is a ${assetClass.toLowerCase()} ETF in the ${category} category, managed by ${fundHouse}. ETFs trade like stocks on ${exchange} during market hours.`;

  return (
    <>
      {/* MONEY-1383 (L2): rendered OUTSIDE <PageGuard>, so the 2.5 MB
          charting library starts downloading with the document instead of
          after the ~0.6s /api/subscription/access round-trip the guard
          blocks on before mounting the chart. */}
      <ChartPreloadLinks />
      <EtfDetailClient
        symbol={etfSymbol}
        name={identity.schemeName ?? etfSymbol}
        exchange={exchange}
        isin={identity.isin}
        schemeCode={identity.schemeCode}
        identitySource={identity.source}
        ltp={quote.price}
        previousClose={quote.previousClose}
        change={quote.change}
        changePercent={quote.changePercent}
        inav={inav}
        inavDate={inavDate ? inavDate.toISOString() : null}
        // NAV-derived returns fill in where the master has none — which is every
        // ETF in prod: `returns1Y/3Y/5Y` are null on all 307 joined scheme rows.
        returns3Y={master?.returns3Y ?? nav?.derivatives.r3Y ?? null}
        returns5Y={master?.returns5Y ?? nav?.derivatives.r5Y ?? null}
        returnsInception={
          master?.returnsInception ?? nav?.derivatives.rInception ?? null
        }
        aum={master?.aum ?? null}
        expenseRatio={master?.expenseRatio ?? null}
        fundHouse={fundHouse}
        category={category}
        assetClass={assetClass}
        subCategory={subCategory}
        description={description}
        fundManager={master?.fundManager ?? null}
        launchDate={master?.launchDate ? master.launchDate.toISOString() : null}
        exitLoad={master?.exitLoad ?? null}
        // Never the category. `benchmarkName` is null on all 14,223 master rows
        // until a provider fills it, and MONEY-610 already removed one fabricated
        // benchmark from this product.
        benchmarkName={master?.benchmarkName ?? null}
        priceHigh52={range.high}
        priceLow52={range.low}
        navStats={
          nav
            ? {
                dataPoints: nav.derivatives.dataPoints,
                coverageYears: nav.derivatives.coverageYears,
                firstDate: nav.firstNavDate,
                launchDate: master?.launchDate
                  ? master.launchDate.toISOString()
                  : null,
              }
            : null
        }
      />
    </>
  );
}

export async function generateMetadata({ params }: EtfPageProps) {
  const { symbol } = await params;
  let displayName = symbol.toUpperCase();
  try {
    // No write-through here: metadata runs alongside the page render, which
    // already resolves and persists the same identity.
    const identity = await resolveFundIdentity(
      { symbol, instrumentTypes: ["ETF"] },
      { persist: false }
    );
    if (identity?.schemeName) displayName = identity.schemeName;
  } catch {
    // ignore
  }
  return {
    title: displayName,
    description: `Price, NAV, holdings, and sector mix for ${displayName} ETF.`,
  };
}
