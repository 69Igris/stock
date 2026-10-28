// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

/**
 * Mutual Fund Detail Page - Server Component
 *
 * Fetches MF data from MutualFundMaster and renders the client component.
 * Triggers on-demand metadata enrichment if data is stale.
 * URL: /mf/119551
 *
 * ## MONEY-1205 — this route is not canonical for every scheme
 *
 * An exchange-traded fund has an AMFI scheme code AND a listed ticker, so
 * `SBIETFQLTY` rendered here as `/mf/145648` (NAV, no chart, no premium) and at
 * `/etf/SBIETFQLTY` (LTP, iNAV, TradingView) with neither page linking to the
 * other. When the scheme's ISIN belongs to a listed ETF instrument this page
 * now redirects to `/etf/[symbol]`, which is a strict superset: it carries the
 * market data AND, since this ticket, the same master-resolved fund identity.
 *
 * The NAV derivation is also no longer a `useMemo` in the client — see the
 * `navStats` prop and `getFundNavDerivatives`.
 */

import { prisma } from "@usemoney/database";
import {
  enrichMfMetadata,
  resolveIsinToSchemeCode,
} from "@usemoney/core/market-data";
import { getFundNavDerivatives } from "@usemoney/services";
import { notFound, redirect } from "next/navigation";
import MfDetailClient from "./client";
import { resolveFundIdentity } from "@/lib/fund/fund-identity";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";

interface MfPageProps {
  params: Promise<{ schemeCode: string }>;
}

const STALE_DAYS = 7;

const MF_SELECT = {
  id: true,
  schemeCode: true,
  schemeName: true,
  amcName: true,
  category: true,
  subCategory: true,
  plan: true,
  nav: true,
  navDate: true,
  aum: true,
  returns1Y: true,
  returns3Y: true,
  returns5Y: true,
  expenseRatio: true,
  riskLevel: true,
  fundManager: true,
  crisilRating: true,
  volatility: true,
  returnsInception: true,
  fundType: true,
  description: true,
  // MONEY-1205 — the column exists now; null on every row until a provider
  // fills it, and rendered only where a null is harmless.
  launchDate: true,
  metadataSyncedAt: true,
} as const;

export default async function MfPage({ params }: MfPageProps) {
  const { schemeCode } = await params;

  // Fetch MF from DB by schemeCode
  let mfData = null;
  // MONEY-1401 — "the master does not carry this code" and "we could not look"
  // are different answers and only one of them is a 404. A thrown read leaves
  // `mfData` null too, so keying the 404 on the VALUE would turn a Mongo blip
  // into a dead link for a real fund.
  let lookupFailed = false;
  try {
    mfData = await prisma.mutualFundMaster.findUnique({
      where: { schemeCode },
      select: MF_SELECT,
    });

    // If not found by schemeCode, try lookup by ISIN (holdings use ISINs)
    if (!mfData) {
      const byIsin = await prisma.mutualFundMaster.findFirst({
        where: {
          OR: [{ isinGrowth: schemeCode }, { isinDividend: schemeCode }],
        },
        select: MF_SELECT,
      });
      if (byIsin) {
        redirect(
          instrumentDetailHref({
            symbol: byIsin.schemeCode,
            instrumentType: "MF",
          })
        );
      }

      // Final fallback: resolve ISIN via AMFI feed (handles case where
      // ISINs haven't been synced to MutualFundMaster yet)
      if (/^INF\w+$/.test(schemeCode)) {
        const resolved = await resolveIsinToSchemeCode(schemeCode);
        if (resolved) {
          redirect(
            instrumentDetailHref({
              symbol: resolved.schemeCode,
              instrumentType: "MF",
            })
          );
        }
      }
    }
  } catch (e) {
    // redirect() throws a special Next.js error - re-throw it
    if (e && typeof e === "object" && "digest" in e) throw e;
    // DB unavailable - continue with fallback data
    lookupFailed = true;
  }

  // ── MONEY-1401 — an unknown scheme code is a 404, not a page ──────────────
  //
  // This used to fall through to the synthesised `Mutual Fund (<code>)` /
  // "Unknown AMC" row below and render. That bought nothing — every figure on
  // it is null and the NAV is 0 — and it cost something real. The client calls
  // `getMfPortfolioSectionAction({ schemeCode })` with the RAW path segment,
  // and `workers/src/processors/mf-portfolio-sync.ts` records that 5 of 414
  // multi-code families also carry a wound-up SEGREGATED PORTFOLIO's codes
  // (410 rows), with the stated mitigation "no fund page exists to ask for them
  // by code". Those codes carry `nav <= 0`, which `amfi-mf-provider` drops, so
  // they never enter `mutual_fund_masters` — i.e. they land in exactly this
  // branch. `GET /mf/147691` rendered the PARENT fund's full equity portfolio
  // under a SEBI-disclosure label. Before MONEY-1294 filled `amfiSchemeCodes`
  // the same request returned nothing; the join is what made the path real.
  //
  // The degraded render survives for the case it was written for: a read that
  // THREW still gets the fallback row rather than a 404.
  if (!mfData && !lookupFailed) notFound();

  // ── Canonical route check ────────────────────────────────────────────────
  //
  // Resolved through the SAME seam the ETF page uses, so the two routes cannot
  // disagree about whether a scheme is a listed ETF. It also fills
  // `InstrumentMapping.amfiSchemeCode` on the way past, which is what makes the
  // next visit a single indexed lookup instead of an ISIN join.
  let identity: Awaited<ReturnType<typeof resolveFundIdentity>> = null;
  if (mfData) {
    try {
      identity = await resolveFundIdentity({ schemeCode: mfData.schemeCode });
    } catch {
      // Identity is an optimisation here; the MF page renders without it.
    }
    if (identity?.instrumentType === "ETF" && identity.symbol) {
      redirect(
        instrumentDetailHref({
          symbol: identity.symbol,
          exchange: identity.exchange,
          instrumentType: "ETF",
        })
      );
    }
  }

  // Trigger on-demand enrichment if metadata is stale (fire-and-forget)
  if (mfData) {
    const isStale =
      !mfData.metadataSyncedAt ||
      Date.now() - mfData.metadataSyncedAt.getTime() >
        STALE_DAYS * 24 * 60 * 60 * 1000;
    if (isStale) {
      Promise.resolve().then(() =>
        enrichMfMetadata(schemeCode).catch(() => {})
      );
    }
  }

  const description = mfData?.description ?? null;

  // If not found, construct minimal data
  const data = mfData ?? {
    id: null,
    schemeCode,
    schemeName: `Mutual Fund (${schemeCode})`,
    amcName: "Unknown AMC",
    category: "Unknown",
    subCategory: null,
    plan: null,
    nav: 0,
    navDate: new Date(),
    aum: null,
    returns1Y: null,
    returns3Y: null,
    returns5Y: null,
    expenseRatio: null,
    riskLevel: null,
    fundManager: null,
    crisilRating: null,
    volatility: null,
    returnsInception: null,
    fundType: null,
    description: null,
    launchDate: null,
    metadataSyncedAt: null,
  };

  // Returns + 52-week NAV range, derived ONCE on the server. This replaces two
  // `useMemo`s in the client that re-derived them from the chart's own fetch
  // with no minimum-observation floor, so two stray NAV points could print a
  // confident 5-year CAGR — and with no way to distinguish "history not loaded"
  // from "fund is younger than the window", which both rendered a bare "-".
  const navResult = await getFundNavDerivatives({
    schemeCode: data.schemeCode,
  });
  const nav = navResult.success ? navResult.data : null;

  return (
    <MfDetailClient
      schemeCode={data.schemeCode}
      schemeName={data.schemeName}
      amcName={data.amcName}
      category={data.category}
      subCategory={data.subCategory}
      plan={data.plan}
      nav={data.nav}
      navDate={data.navDate}
      aum={data.aum}
      returns1Y={data.returns1Y}
      returns3Y={data.returns3Y}
      returns5Y={data.returns5Y}
      expenseRatio={data.expenseRatio}
      riskLevel={data.riskLevel}
      fundManager={data.fundManager}
      crisilRating={data.crisilRating}
      volatility={data.volatility}
      returnsInception={
        data.returnsInception ?? nav?.derivatives.rInception ?? null
      }
      fundType={data.fundType}
      description={description}
      navHigh={nav?.derivatives.high52 ?? null}
      navLow={nav?.derivatives.low52 ?? null}
      navReturns3Y={nav?.derivatives.r3Y ?? null}
      navReturns5Y={nav?.derivatives.r5Y ?? null}
      navStats={
        nav
          ? {
              dataPoints: nav.derivatives.dataPoints,
              coverageYears: nav.derivatives.coverageYears,
              firstDate: nav.firstNavDate,
              launchDate: data.launchDate
                ? data.launchDate.toISOString()
                : null,
            }
          : null
      }
    />
  );
}

export async function generateMetadata({ params }: MfPageProps) {
  const { schemeCode } = await params;

  let schemeName = `Mutual Fund (${schemeCode})`;
  try {
    let mf = await prisma.mutualFundMaster.findUnique({
      where: { schemeCode },
      select: { schemeName: true },
    });
    // Fallback: try ISIN lookup
    if (!mf) {
      mf = await prisma.mutualFundMaster.findFirst({
        where: {
          OR: [{ isinGrowth: schemeCode }, { isinDividend: schemeCode }],
        },
        select: { schemeName: true },
      });
    }
    if (mf) schemeName = mf.schemeName;
  } catch {
    // ignore
  }

  return {
    // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
    title: schemeName,
    description: `View NAV history, returns, and analysis for ${schemeName}`,
  };
}
