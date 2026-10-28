"use client";

/**
 * Fund Composition Section
 *
 * Shared component for displaying AI-extracted portfolio holdings.
 * Used on MF detail page and ETF detail page.
 *
 * Shows:
 * - Holdings table (with "Analyze Holdings" trigger)
 * - Sector allocation donut chart
 * - Market cap breakdown donut chart
 * - A provenance notice
 *
 * ## MONEY-1205 — what this panel actually is
 *
 * It is a MODEL ESTIMATE. Nothing here reads a filed SEBI portfolio
 * disclosure: `getOrExtractComposition` asks Gemini what it believes a fund
 * holds, and the `dataAsOf` / `confidence` it returns are the model's claims
 * about its own answer. The footer used to print both as provenance —
 * "StockSage-extracted from public disclosures. Data as of 2024-05.
 * Confidence: 95%." — which is three assertions of fact built out of one
 * guess. Measured on prod 2026-08-18: all 111 stored rows claim a 2024-04/05/06
 * period at 0.95-0.99 confidence while having been (re-)extracted between
 * 2026-02 and 2026-08.
 *
 * So: `confidence` is not rendered at all, and the period is rendered only as
 * an explicitly model-reported, unverified value. See the footer at the bottom
 * of this file.
 *
 * The panel is still worth keeping — it owns the sector/market-cap donuts the
 * AMC disclosure does not provide, and it is the only writer of `FundHolding`,
 * which `getMfPortfolioSection` falls back to when an AMC publishes nothing
 * machine-readable.
 */

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { useUser } from "@clerk/nextjs";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Button } from "@usemoney/ui/button";
import type { FundCompositionDonutCanvasProps } from "@/components/FundCompositionDonutCanvas";
import {
  FlaskConical,
  ChevronDown,
  ChevronUp,
  Table2,
  PieChart,
  BarChart2,
} from "lucide-react";
import {
  getFundCompositionAction,
  triggerCompositionExtractionAction,
  type FundCompositionData,
} from "@/lib/actions/fund-composition";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import { SECTION_EMPTY_BODY } from "@/components/stock/SectionShell";
import {
  shouldAutoExtractComposition,
  shouldServeComposition,
} from "@usemoney/core/market-data/instruments/fund-composition-logic";

/**
 * MONEY-290 — recharts loads only once a composition has actually been
 * extracted and a donut is about to paint. This component is mounted on the
 * MF, ETF and stock detail pages, and on most visits the composition is
 * missing / still extracting, so the charts never render at all.
 *
 * `ssr: false` because <ResponsiveContainer> measures the DOM and renders
 * nothing server-side. The fallback fills the slot, which already carries a
 * fixed `h-[200px]`, so nothing shifts when the chart lands.
 */
const FundCompositionDonutCanvas = dynamic<FundCompositionDonutCanvasProps>(
  () => import("@/components/FundCompositionDonutCanvas"),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden="true"
        className="w-full h-full flex items-center justify-center"
      >
        <div
          className="rounded-full"
          style={{
            width: 160,
            height: 160,
            border: "30px solid hsl(var(--muted))",
            opacity: 0.6,
          }}
        />
      </div>
    ),
  }
);

// ============== TYPES ==============

interface FundCompositionSectionProps {
  fundType: "MF" | "ETF" | "INDEX";
  fundId: string;
  /**
   * MONEY-1205 — set by the page when an official AMC/exchange portfolio
   * disclosure is already on screen. Optional so existing mounts compile
   * unchanged; when true it suppresses the on-mount extraction entirely (the
   * "Analyze Holdings" button still works). The ETF/INDEX ban in
   * `shouldAutoExtractComposition` does not depend on this prop, so an
   * un-updated ETF mount is still protected.
   */
  hasOfficialDisclosure?: boolean;
  /**
   * MONEY-1405 D4/D5 — the AMFI scheme code the AMC's own disclosure is keyed
   * by. For an MF it equals `fundId`; for an ETF `fundId` is a trading symbol
   * and `mf_portfolio_holdings` has never been keyed by one, so the ETF page
   * passes the code it already resolved via `lib/fund/fund-identity`.
   *
   * Optional: without it the panel simply falls back to the stored model
   * recollection, which is what every mount did before this existed.
   */
  schemeCode?: string;
}

// ============== COLORS ==============

const SECTOR_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#84cc16",
  "#6366f1",
  "#14b8a6",
  "#e11d48",
];

const CAP_COLORS: Record<string, string> = {
  LARGE: "#3b82f6",
  MID: "#10b981",
  SMALL: "#f59e0b",
  MICRO: "#ef4444",
};

const CAP_LABELS: Record<string, string> = {
  LARGE: "Large Cap",
  MID: "Mid Cap",
  SMALL: "Small Cap",
  MICRO: "Micro Cap",
};

// ============== DEMO DATA ==============

/**
 * MONEY-1205 — the demo period is computed, not hard-coded.
 *
 * It used to be the literal `"2025-12"`, which silently aged past the content
 * gate: a fixed month drifts one month further behind reality every month, so
 * demo data would eventually claim a period the live path now refuses to
 * render. Last month is always a plausible SEBI disclosure period.
 */
function demoDataAsOf(now: Date = new Date()): string {
  const previous = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const month = String(previous.getUTCMonth() + 1).padStart(2, "0");
  return `${previous.getUTCFullYear()}-${month}`;
}

function getDemoComposition(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string
): FundCompositionData {
  return {
    fundType,
    fundId,
    holdings: [
      {
        holdingName: "HDFC Bank Ltd",
        holdingSymbol: "HDFCBANK",
        isin: "INE040A01034",
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "Banking",
        marketCap: "LARGE",
        weightPercent: 9.8,
      },
      {
        holdingName: "ICICI Bank Ltd",
        holdingSymbol: "ICICIBANK",
        isin: "INE090A01021",
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "Banking",
        marketCap: "LARGE",
        weightPercent: 8.2,
      },
      {
        holdingName: "Reliance Industries",
        holdingSymbol: "RELIANCE",
        isin: "INE002A01018",
        holdingType: "EQUITY",
        sector: "Energy",
        industry: "Oil & Gas",
        marketCap: "LARGE",
        weightPercent: 7.5,
      },
      {
        holdingName: "Infosys Ltd",
        holdingSymbol: "INFY",
        isin: "INE009A01021",
        holdingType: "EQUITY",
        sector: "Information Technology",
        industry: "IT Services",
        marketCap: "LARGE",
        weightPercent: 6.3,
      },
      {
        holdingName: "TCS Ltd",
        holdingSymbol: "TCS",
        isin: "INE467B01029",
        holdingType: "EQUITY",
        sector: "Information Technology",
        industry: "IT Services",
        marketCap: "LARGE",
        weightPercent: 5.8,
      },
      {
        holdingName: "Bharti Airtel",
        holdingSymbol: "BHARTIARTL",
        isin: "INE397D01024",
        holdingType: "EQUITY",
        sector: "Telecom",
        industry: "Telecom Services",
        marketCap: "LARGE",
        weightPercent: 4.5,
      },
      {
        holdingName: "ITC Ltd",
        holdingSymbol: "ITC",
        isin: "INE154A01025",
        holdingType: "EQUITY",
        sector: "FMCG",
        industry: "Tobacco & FMCG",
        marketCap: "LARGE",
        weightPercent: 4.2,
      },
      {
        holdingName: "Larsen & Toubro",
        holdingSymbol: "LT",
        isin: "INE018A01030",
        holdingType: "EQUITY",
        sector: "Capital Goods",
        industry: "Construction & Engineering",
        marketCap: "LARGE",
        weightPercent: 3.9,
      },
      {
        holdingName: "Kotak Mahindra Bank",
        holdingSymbol: "KOTAKBANK",
        isin: "INE237A01028",
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "Banking",
        marketCap: "LARGE",
        weightPercent: 3.5,
      },
      {
        holdingName: "Axis Bank Ltd",
        holdingSymbol: "AXISBANK",
        isin: "INE238A01034",
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "Banking",
        marketCap: "LARGE",
        weightPercent: 3.1,
      },
      {
        holdingName: "SBI Ltd",
        holdingSymbol: "SBIN",
        isin: "INE062A01020",
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "Banking",
        marketCap: "LARGE",
        weightPercent: 2.8,
      },
      {
        holdingName: "HUL Ltd",
        holdingSymbol: "HINDUNILVR",
        isin: "INE030A01027",
        holdingType: "EQUITY",
        sector: "FMCG",
        industry: "Personal Care",
        marketCap: "LARGE",
        weightPercent: 2.5,
      },
      {
        holdingName: "Bajaj Finance",
        holdingSymbol: "BAJFINANCE",
        isin: "INE296A01024",
        holdingType: "EQUITY",
        sector: "Financial Services",
        industry: "NBFC",
        marketCap: "LARGE",
        weightPercent: 2.3,
      },
      {
        holdingName: "Maruti Suzuki",
        holdingSymbol: "MARUTI",
        isin: "INE585B01010",
        holdingType: "EQUITY",
        sector: "Automobile",
        industry: "Passenger Cars",
        marketCap: "LARGE",
        weightPercent: 2.1,
      },
      {
        holdingName: "Sun Pharma",
        holdingSymbol: "SUNPHARMA",
        isin: "INE044A01036",
        holdingType: "EQUITY",
        sector: "Healthcare",
        industry: "Pharmaceuticals",
        marketCap: "LARGE",
        weightPercent: 1.9,
      },
    ],
    sectorBreakdown: [
      { sector: "Financial Services", weight: 29.7 },
      { sector: "Information Technology", weight: 12.1 },
      { sector: "Energy", weight: 7.5 },
      { sector: "FMCG", weight: 6.7 },
      { sector: "Telecom", weight: 4.5 },
      { sector: "Capital Goods", weight: 3.9 },
      { sector: "Automobile", weight: 2.1 },
      { sector: "Healthcare", weight: 1.9 },
    ],
    capBreakdown: [
      { cap: "LARGE", weight: 78.5 },
      { cap: "MID", weight: 15.3 },
      { cap: "SMALL", weight: 6.2 },
    ],
    assetBreakdown: [
      { type: "Equity", weight: 97.8 },
      { type: "Cash", weight: 2.2 },
    ],
    totalHoldings: 15,
    confidence: 0.92,
    dataAsOf: demoDataAsOf(),
  };
}

// ============== COMPONENT ==============

export default function FundCompositionSection({
  fundType,
  fundId,
  hasOfficialDisclosure = false,
  schemeCode,
}: FundCompositionSectionProps) {
  // MONEY-1137: the worst case of the under-gated demo signal. `isDemoMode`
  // here short-circuits the real `getFundCompositionAction` call and renders
  // `getDemoComposition(...)` — fabricated holdings, weights and an
  // "as of" date. A stale `tradebook_demo_mode` flag therefore showed a
  // signed-in user invented fund composition with no banner anywhere near it.
  // Signed-out demo visitors are unaffected: `user` is null for them.
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });
  const [composition, setComposition] = useState<FundCompositionData | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);
  const [showAllHoldings, setShowAllHoldings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Trigger Gemini extraction
  const triggerExtraction = useCallback(async () => {
    setIsExtracting(true);
    setError(null);
    try {
      const result = await triggerCompositionExtractionAction(
        fundType,
        fundId,
        schemeCode
      );
      if (result?.success && result?.data) {
        setComposition(result?.data);
      } else {
        setError(result?.error ?? "Extraction failed");
      }
    } catch {
      setError("Extraction failed. Please try again.");
    } finally {
      setIsExtracting(false);
    }
  }, [fundType, fundId, schemeCode]);

  // Load existing composition on mount.
  //
  // MONEY-1205 — extraction on mount is now the EXCEPTION, not the default. The
  // old code called `triggerExtraction()` unconditionally whenever the cached
  // composition was missing, and the ETF page had no gate above it, so a single
  // page view of any of ~446 NSE ETFs without a composition spent a Gemini call
  // and wrote another 2024-05 row. The rule lives in
  // `shouldAutoExtractComposition` (packages/core, pure + unit-tested) so it is
  // one statement in one place rather than a condition spread over an effect.
  useEffect(() => {
    // Skip all API/Gemini calls in demo mode - use hardcoded data
    if (isDemoMode) {
      setComposition(getDemoComposition(fundType, fundId));
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      let loaded: FundCompositionData | null = null;
      try {
        const result = await getFundCompositionAction(
          fundType,
          fundId,
          schemeCode
        );
        if (cancelled) return;
        if (result?.success && result?.data) {
          // Belt-and-braces: the service caches composition data for 24h, so an
          // entry written before the content gate shipped can still be served.
          // A MODEL-REPORTED period that is not recent is not authority; a
          // filed disclosure's period is not a claim at all.
          //
          // MONEY-1401 F-vacuous — the rule itself is `shouldServeComposition`
          // in packages/core, so it is unit-testable in BOTH directions. Inline,
          // its polarity was unassertable: `if (!unverifiedAndStale)` and its
          // inverse both satisfy a source scan for `isCompositionContentStale`.
          if (shouldServeComposition(result.data)) {
            loaded = result.data;
            setComposition(result.data);
          }
        }
      } catch {
        // Silent - composition just not available yet
      }
      if (cancelled) return;
      setIsLoading(false);
      if (
        shouldAutoExtractComposition({
          fundType,
          hasOfficialDisclosure,
          isDemoMode,
          hasComposition: loaded !== null,
        })
      ) {
        triggerExtraction();
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [
    fundType,
    fundId,
    schemeCode,
    triggerExtraction,
    isDemoMode,
    hasOfficialDisclosure,
  ]);

  if (isLoading) {
    return (
      <Card className="mb-6">
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center gap-5">
            {/* Animated icon cluster */}
            <div className="relative w-20 h-20">
              <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping" />
              <div className="absolute inset-1.5 rounded-full border-2 border-primary/30 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-primary animate-pulse"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </div>
              <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 animate-bounce">
                <svg
                  className="w-4 h-4 text-emerald-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
                  <path d="M22 12A10 10 0 0 0 12 2v10z" />
                </svg>
              </div>
              <div
                className="absolute -bottom-0.5 -right-0.5"
                style={{ animation: "bounce 1.5s infinite 0.3s" }}
              >
                <svg
                  className="w-4 h-4 text-blue-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <rect x="3" y="12" width="4" height="9" rx="1" />
                  <rect x="10" y="7" width="4" height="14" rx="1" />
                  <rect x="17" y="3" width="4" height="18" rx="1" />
                </svg>
              </div>
              <div
                className="absolute -bottom-0.5 -left-0.5"
                style={{ animation: "bounce 1.5s infinite 0.6s" }}
              >
                <svg
                  className="w-4 h-4 text-amber-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
              </div>
            </div>

            {/* Text */}
            <div className="text-center space-y-1.5">
              <p className="text-sm font-medium text-foreground">
                Checking Portfolio Composition
              </p>
              <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
                <svg
                  className="w-3 h-3 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span className="text-xs">Loading holdings data</span>
              </div>
            </div>

            {/* Progress bar */}
            <div className="w-40 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full"
                style={{
                  animation: "compositionLoadingBar 2s ease-in-out infinite",
                }}
              />
            </div>

            {/* Steps */}
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                Holdings
              </div>
              <div className="flex items-center gap-1.5">
                <div
                  className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-pulse"
                  style={{ animationDelay: "0.5s" }}
                />
                Sectors
              </div>
              <div className="flex items-center gap-1.5">
                <div
                  className="w-1.5 h-1.5 rounded-full bg-primary/30 animate-pulse"
                  style={{ animationDelay: "1s" }}
                />
                Market cap
              </div>
            </div>
          </div>

          {/* CSS for animation */}
          <style
            dangerouslySetInnerHTML={{
              __html: `
                @keyframes compositionLoadingBar {
                  0% { width: 0%; margin-left: 0; }
                  50% { width: 70%; margin-left: 15%; }
                  100% { width: 0%; margin-left: 100%; }
                }
              `,
            }}
          />
        </CardContent>
      </Card>
    );
  }

  // Not yet extracted - idle (waiting for an explicit request), extracting, or
  // errored.
  //
  // MONEY-1205 — the idle branch is new and is the visible half of the
  // auto-trigger fix. Before, `!composition` could only mean "an extraction is
  // running", because one always was; now that an ETF page view does not start
  // one, the old markup would have shown a perpetual "Analyzing Portfolio with
  // StockSage" spinner for an extraction that was never going to happen.
  if (!composition) {
    return (
      <Card className="mb-6">
        <CardContent className="py-8">
          {error ? (
            <div className="text-center">
              <FlaskConical className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-destructive mb-3">{error}</p>
              <Button onClick={triggerExtraction} disabled={isExtracting}>
                <FlaskConical className="h-4 w-4 mr-2" />
                Retry Analysis
              </Button>
            </div>
          ) : !isExtracting ? (
            // MONEY-1255 — generic body, CTA kept. The button is load-bearing
            // in exactly the way the Financials period switch is: without it
            // this reads as a dead panel rather than one waiting to be asked.
            //
            // The AI-estimate caveat is demoted, not dropped — and it is not
            // the only place it is said. Once a breakdown exists the same
            // disclosure renders IN the result, twice: the "AI estimate ·
            // unverified" chip beside the heading and the full sentence under
            // the holdings table. Demoting the pre-run copy costs a reader
            // nothing they will not be told before they can act on a number.
            <div
              className="flex flex-col items-center gap-4 py-2 text-center cursor-help"
              title={
                "StockSage can produce an estimated holdings, sector and " +
                "market-cap breakdown for this fund. It is an AI estimate, " +
                "not a reading of the AMC's filed portfolio disclosure, so it " +
                "runs only when you ask for it."
              }
            >
              <div className="rounded-full bg-muted p-3">
                <FlaskConical className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {SECTION_EMPTY_BODY}
              </p>
              <Button onClick={triggerExtraction} disabled={isExtracting}>
                <FlaskConical className="h-4 w-4 mr-2" />
                Estimate holdings with AI
              </Button>
              {/*
                MONEY-1405 D6 — the caveat is now ON the control, not only in
                the `title` tooltip above it (which a touch device never shows)
                and not only in the result a reader has to run the thing to
                see. Nothing auto-fires this any more, so the only way a
                composition from this source exists is that somebody read this
                line and pressed the button anyway.
              */}
              <p className="text-xs text-muted-foreground max-w-sm">
                Third-party model estimate &mdash; a language model&rsquo;s
                recollection, not a reading of this fund&rsquo;s filed SEBI
                portfolio disclosure.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5 py-2">
              {/* Animated icon cluster */}
              <div className="relative w-24 h-24">
                <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping" />
                <div className="absolute inset-1.5 rounded-full border-2 border-primary/30 animate-pulse" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg
                    className="w-10 h-10 text-primary animate-pulse"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M9 3h6l3 7-6 11-6-11z" />
                    <circle cx="12" cy="10" r="2" />
                  </svg>
                </div>
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 animate-bounce">
                  <svg
                    className="w-4 h-4 text-emerald-500"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
                    <path d="M22 12A10 10 0 0 0 12 2v10z" />
                  </svg>
                </div>
                <div
                  className="absolute -bottom-1 -right-1"
                  style={{ animation: "bounce 1.5s infinite 0.3s" }}
                >
                  <svg
                    className="w-4 h-4 text-blue-500"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="3" y="12" width="4" height="9" rx="1" />
                    <rect x="10" y="7" width="4" height="14" rx="1" />
                    <rect x="17" y="3" width="4" height="18" rx="1" />
                  </svg>
                </div>
                <div
                  className="absolute -bottom-1 -left-1"
                  style={{ animation: "bounce 1.5s infinite 0.6s" }}
                >
                  <svg
                    className="w-4 h-4 text-amber-500"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                </div>
              </div>

              {/* Text */}
              <div className="text-center space-y-1.5">
                <p className="text-sm font-medium text-foreground">
                  Analyzing Portfolio with StockSage
                </p>
                <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
                  <svg
                    className="w-3 h-3 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span className="text-xs">
                    Extracting holdings, sectors & market cap data
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground/70">
                  This may take up to 60 seconds
                </p>
              </div>

              {/* Progress bar */}
              <div className="w-48 h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full"
                  style={{
                    animation: "compositionLoadingBar 2s ease-in-out infinite",
                  }}
                />
              </div>

              {/* Steps */}
              <div className="flex items-center gap-5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  Fetching disclosures
                </div>
                <div className="flex items-center gap-1.5">
                  <div
                    className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-pulse"
                    style={{ animationDelay: "0.5s" }}
                  />
                  StockSage extraction
                </div>
                <div className="flex items-center gap-1.5">
                  <div
                    className="w-1.5 h-1.5 rounded-full bg-primary/30 animate-pulse"
                    style={{ animationDelay: "1s" }}
                  />
                  Building charts
                </div>
              </div>

              {/* CSS for animation */}
              <style
                dangerouslySetInnerHTML={{
                  __html: `
                    @keyframes compositionLoadingBar {
                      0% { width: 0%; margin-left: 0; }
                      50% { width: 70%; margin-left: 15%; }
                      100% { width: 0%; margin-left: 100%; }
                    }
                  `,
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const displayedHoldings = showAllHoldings
    ? composition.holdings
    : composition.holdings.slice(0, 20);

  const totalWeight = composition.holdings.reduce(
    (sum, h) => sum + h.weightPercent,
    0
  );

  /**
   * MONEY-1405 D4 — is this the AMC's filed portfolio, or a model's
   * recollection of one? Every provenance string below reads off this, and so
   * does whether the holdings TABLE renders at all.
   *
   * The table is suppressed for the disclosure because `MfPortfolioTab` is
   * already rendering the same rows, from the same table, directly above this
   * panel on both fund pages — and it renders them better, with the
   * month-over-month entered/exited diff this snapshot cannot produce. What
   * this panel uniquely owns is the SECTOR and MARKET-CAP donuts, which the
   * disclosure does not carry and which are derived here from the ISIN join.
   *
   * MONEY-1401 — `fromDisclosure` alone was NOT the right condition, and the
   * note here used to say it was. It answers "is the data I hold the filing",
   * which is not the same question as "is this page already showing the
   * filing". The two come apart whenever the panel is serving a RECOLLECTION on
   * a page whose `MfPortfolioTab` resolved an official disclosure — which is
   * exactly what a displaced cache entry produced, and exactly the "two tables
   * of different numbers for one fund" this rule exists to prevent. The page
   * knows the answer and passes it as `hasOfficialDisclosure`; until now that
   * prop reached nothing but `shouldAutoExtractComposition`, whose body is
   * `return false`, so it had no behaviour at all behind it.
   *
   * `/stock/[symbol]` and `/compare` pass neither a scheme code nor the prop,
   * so they keep the full panel exactly as before.
   */
  const fromDisclosure = composition.source === "AMC_DISCLOSURE";
  const officialTableAbove = fromDisclosure || hasOfficialDisclosure;

  return (
    <div className="space-y-6 mb-6">
      {/* Holdings Table — see `officialTableAbove` above. */}
      {!officialTableAbove && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              <Table2 className="h-5 w-5" />
              Portfolio Holdings
              <Badge variant="secondary" className="ml-1">
                {composition.totalHoldings} holdings &middot;{" "}
                {totalWeight.toFixed(1)}%
              </Badge>
              {/*
              MONEY-1205 — the label a reader sees FIRST, next to the numbers
              rather than 900px below them in a footnote. "AI estimate" is the
              whole claim this panel is entitled to make. (This branch only
              renders for the recollection — see `fromDisclosure`.)
            */}
              <Badge
                variant="outline"
                className="ml-auto text-[11px] font-normal text-muted-foreground"
              >
                <FlaskConical className="h-3 w-3 mr-1" />
                AI estimate &middot; unverified
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-2 font-medium text-muted-foreground">
                      Name
                    </th>
                    <th className="pb-2 font-medium text-muted-foreground hidden sm:table-cell">
                      Sector
                    </th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">
                      Cap
                    </th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">
                      Weight
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayedHoldings.map((h, i) => (
                    <tr
                      key={`${h.holdingName}-${i}`}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{h.holdingName}</span>
                          {h.holdingSymbol && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1 py-0"
                            >
                              {h.holdingSymbol}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-2 text-muted-foreground hidden sm:table-cell">
                        {h.sector ?? "-"}
                      </td>
                      <td className="py-2 hidden md:table-cell">
                        {h.marketCap ? (
                          <Badge variant="outline" className="text-[10px]">
                            {CAP_LABELS[h.marketCap] ?? h.marketCap}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="py-2 text-right font-mono font-medium">
                        {h.weightPercent.toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {composition.holdings.length > 20 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-2"
                onClick={() => setShowAllHoldings(!showAllHoldings)}
              >
                {showAllHoldings ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-1" /> Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-1" /> Show all{" "}
                    {composition.holdings.length} holdings
                  </>
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sector Allocation */}
        {composition.sectorBreakdown.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <PieChart className="h-5 w-5" />
                Sector Allocation
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="w-full sm:w-1/2 h-[200px]">
                  <FundCompositionDonutCanvas
                    data={composition.sectorBreakdown.map((s, index) => ({
                      name: s.sector,
                      value: s.weight,
                      fill: SECTOR_COLORS[index % SECTOR_COLORS.length],
                    }))}
                  />
                </div>
                <div className="w-full sm:w-1/2">
                  <div className="space-y-1.5">
                    {composition.sectorBreakdown
                      .sort((a, b) => b.weight - a.weight)
                      .slice(0, 10)
                      .map((entry, index) => (
                        <div
                          key={entry.sector}
                          className="flex items-center justify-between text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="h-3 w-3 rounded-full shrink-0"
                              style={{
                                backgroundColor:
                                  SECTOR_COLORS[index % SECTOR_COLORS.length],
                              }}
                            />
                            <span className="text-muted-foreground truncate">
                              {entry.sector}
                            </span>
                          </div>
                          <span className="font-mono text-xs ml-2">
                            {entry.weight.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Market Cap Breakdown */}
        {composition.capBreakdown.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BarChart2 className="h-5 w-5" />
                Market Cap Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="w-full sm:w-1/2 h-[200px]">
                  <FundCompositionDonutCanvas
                    data={composition.capBreakdown.map((c, index) => ({
                      name: CAP_LABELS[c.cap] ?? c.cap,
                      value: c.weight,
                      fill:
                        CAP_COLORS[c.cap] ??
                        SECTOR_COLORS[index % SECTOR_COLORS.length],
                    }))}
                  />
                </div>
                <div className="w-full sm:w-1/2">
                  <div className="space-y-2">
                    {composition.capBreakdown
                      .sort((a, b) => b.weight - a.weight)
                      .map((entry, index) => (
                        <div
                          key={entry.cap}
                          className="flex items-center justify-between text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="h-3 w-3 rounded-full shrink-0"
                              style={{
                                backgroundColor:
                                  CAP_COLORS[entry.cap] ??
                                  SECTOR_COLORS[index % SECTOR_COLORS.length],
                              }}
                            />
                            <span className="text-muted-foreground">
                              {CAP_LABELS[entry.cap] ?? entry.cap}
                            </span>
                          </div>
                          <span className="font-mono text-xs">
                            {entry.weight.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Disclaimer.
          Only for the recollection: a disclosure that sums to 99.7% is not
          "top holdings shown", it is the complete filed portfolio rounding. */}
      {!officialTableAbove && totalWeight < 99.5 && (
        <p className="text-xs text-amber-500/80 text-center">
          Note: Top holdings shown, covering {totalWeight.toFixed(1)}% of the
          portfolio. Remaining {(100 - totalWeight).toFixed(1)}% includes
          smaller positions not listed.
        </p>
      )}
      {/*
        MONEY-1205 — provenance, not a provenance-shaped guess.

        This footer used to read:
          "StockSage-extracted from public disclosures. Data as of 2024-05.
           Confidence: 95%."
        Every clause was wrong in the same way: "extracted from public
        disclosures" describes a document read that never happens; the date and
        the percentage are the MODEL's claims about its own answer, written
        verbatim to the DB by `persistComposition` and printed here as fact
        about a specific security.

        `confidence` is gone outright. Across all 111 stored rows on prod it sat
        at 0.95-0.99 while every single one of them was reciting a 26-28 month
        old portfolio, so it has no discriminative power at all — its only
        effect on a reader is to manufacture trust. A self-report cannot be
        evidence about itself.

        The period survives because it is genuinely useful, but only as what it
        is: a model-reported, unverified claim. Anything the content gate would
        reject never reaches this render at all.
      */}
      <div className="text-xs text-muted-foreground text-center space-y-0.5">
        {fromDisclosure ? (
          <p>
            Sector and market-cap breakdowns derived from the fund house&rsquo;s
            own SEBI portfolio disclosure
            {composition.dataAsOf ? (
              <>
                {" "}
                for <span className="font-mono">{composition.dataAsOf}</span>
              </>
            ) : null}
            . Sectors come from our instrument master and cap bands from NSE
            index membership; the disclosure itself states neither.
          </p>
        ) : (
          <p>
            Estimated by StockSage (AI) &mdash; not read from the fund
            house&rsquo;s filed portfolio disclosure. Treat holdings and weights
            as approximate.
          </p>
        )}
        {!fromDisclosure && composition.dataAsOf ? (
          <p>
            Model-reported period:{" "}
            <span className="font-mono">{composition.dataAsOf}</span>{" "}
            (unverified).
          </p>
        ) : null}
      </div>
    </div>
  );
}
