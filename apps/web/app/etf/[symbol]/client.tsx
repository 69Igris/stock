"use client";

/**
 * ETF Detail Client Component — Playful re-skin (MONEY-457 / MONEY-485)
 *
 * Renders ETFs in the same fund-shaped layout as `/mf/[schemeCode]`:
 *   - Playful pills header (ETF / Category / Asset class / Exchange)
 *   - Price block (iNAV primary when present, else LTP; premium/discount
 *     badge vs EOD iNAV) — ETFs trade like stocks
 *   - TradingView chart card
 *   - 8-cell key stats grid (FundKeyStatsGrid)
 *   - SIP / STP calculator (shared SipCalculator in ETF mode)
 *   - About card (FundAboutCard)
 *   - Holdings: the AMC's own monthly disclosure (MfPortfolioTab) with the
 *     model-estimated reading + sector/cap donuts (FundCompositionSection)
 *     shown only when no such disclosure exists
 *
 * ## MONEY-1205
 *
 * Every identity value on this page now arrives resolved from
 * `mutual_fund_masters` (see the page's own header) instead of being parsed
 * out of the ticker's name at render time, and `benchmarkName` is null unless
 * the scheme states one — it used to be handed the CATEGORY, twice, which is
 * how "Benchmark: Other" reached production.
 *
 * The holdings block is the other half. `FundCompositionSection` was mounted
 * unconditionally and is a MODEL ESTIMATE of what an ETF holds; the AMC's own
 * SEBI-mandated disclosure sat one ISIN join away and was never rendered here
 * at all. 52 ETF scheme codes have that disclosure on prod today.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { DemoBanner } from "@/components/DemoBanner";
import { PageGuard } from "@/components/PageGuard";
import { StockDetailSkeleton } from "@/components/skeletons";
import { GitCompare } from "lucide-react";
import FundCompositionSection from "@/components/FundCompositionSection";
import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import { TradingViewAdvancedChart } from "@/components/charts";
import {
  FundKeyStatsGrid,
  type FundStatsHistory,
} from "@/components/mf/FundKeyStatsGrid";
import { FundAboutCard } from "@/components/mf/FundAboutCard";
// MONEY-1211 — the ETF fork of this calculator was deleted; the shared
// component takes `ltp` + `assetClass` and grows the ETF affordances itself.
import { SipCalculator } from "@/components/mf/SipCalculator";
import { MfPortfolioTab } from "@/components/mf/MfPortfolioTab";
import { getMfPortfolioSectionAction } from "@/lib/actions/mf-portfolio-section";
import BrokerReauthBanner from "@/components/BrokerReauthBanner";
import { useBrokerStatus } from "@/hooks/useBrokerStatus";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

interface EtfDetailClientProps {
  symbol: string;
  name: string;
  exchange: string;
  isin: string | null;
  ltp: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  /**
   * MONEY-457: iNAV (Indicative NAV). End-of-day NAV from
   * MutualFundMaster joined via ISIN — 1-day-old by design until the
   * live ETF iNAV feed is wired up. Use this for fund-shaped framing
   * (the same slot MF detail uses for NAV); `ltp` is the live trade
   * price and used as secondary context + premium/discount basis.
   */
  inav: number | null;
  /** ISO date string of the iNAV reading (null when no NAV row). */
  inavDate: string | null;
  returns3Y: number | null;
  returns5Y: number | null;
  returnsInception: number | null;
  aum: number | null;
  expenseRatio: number | null;
  /** Real AMC name when a master row joined; the name-parse otherwise. */
  fundHouse: string;
  category: string;
  assetClass: string;
  subCategory: string | null;
  /** AMFI scheme code. Null when no master row joins this ISIN. */
  schemeCode: string | null;
  /** Where the identity above came from — `"instrument"` means name-parsed. */
  identitySource: "master" | "instrument";
  description: string;
  fundManager: string | null;
  /** ISO date string. */
  launchDate: string | null;
  exitLoad: string | null;
  /** The scheme's OWN stated benchmark, or null. Never the category. */
  benchmarkName: string | null;
  /** 52-week TRADED range from `daily_prices` — not a NAV range. */
  priceHigh52: number | null;
  priceLow52: number | null;
  /** Why a NAV-derived number is missing. Null when there is no scheme code. */
  navStats: FundStatsHistory | null;
}

function formatPrice(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatIso(date: string | null): string {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function EtfDetailClient({
  symbol,
  name,
  exchange,
  isin,
  ltp,
  previousClose,
  change,
  changePercent,
  inav,
  inavDate,
  returns3Y,
  returns5Y,
  returnsInception,
  aum,
  expenseRatio,
  fundHouse,
  category,
  assetClass,
  subCategory,
  schemeCode,
  identitySource,
  description,
  fundManager,
  launchDate,
  exitLoad,
  benchmarkName,
  priceHigh52,
  priceLow52,
  navStats,
}: EtfDetailClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromPage = searchParams?.get("from");
  // MONEY-1137: demo state must not survive a real sign-in. Signed-out
  // visitors keep demo state (`user` is null for them).
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });

  const { brokerStatus: brokerInfo } = useBrokerStatus();

  // ── MONEY-1205 — which holdings panel(s) this page shows ─────────────────
  //
  // The identical tri-state rule `/mf/[schemeCode]` applies, for the identical
  // reason: `MfPortfolioTab` reads the AMC's own filed disclosure and is
  // authoritative, `FundCompositionSection` is a model estimate, and showing
  // both means two tables of different numbers for one fund. It is DEMOTED,
  // not deleted — it owns the sector/cap donuts and is the only writer of
  // `FundHolding`.
  //
  // UNKNOWN hides the estimate: an appearing panel is an ordinary progressive
  // load, a disappearing one moves the page under a reader already in it.
  // A failed read resolves to "no-official", which shows MORE — never letting
  // "couldn't determine" masquerade as "the AMC published one".
  const [disclosure, setDisclosure] = useState<
    "unknown" | "official" | "no-official"
  >("unknown");

  useEffect(() => {
    // No scheme code means no disclosure to look up — not a pending answer.
    if (!schemeCode) {
      setDisclosure("no-official");
      return;
    }
    let cancelled = false;
    setDisclosure("unknown");
    getMfPortfolioSectionAction({ schemeCode })
      .then((r) => {
        if (cancelled) return;
        if (!r.success) {
          setDisclosure("no-official");
          return;
        }
        setDisclosure(
          r.data.empty || r.data.fallback ? "no-official" : "official"
        );
      })
      .catch(() => {
        if (!cancelled) setDisclosure("no-official");
      });
    return () => {
      cancelled = true;
    };
  }, [schemeCode]);

  const isPositive = (change ?? 0) >= 0;

  const handleBack = () => {
    if (fromPage) {
      router.push(fromPage);
    } else {
      router.back();
    }
  };

  const initials = symbol.slice(0, 2).toUpperCase();
  const changeColor = isPositive ? "var(--emerald)" : "var(--pop-1)";

  return (
    <PageGuard
      route="/discover"
      fallback={<StockDetailSkeleton />}
      containerClassName="p-6 pb-44"
    >
      <TerminalLuxeShell
        active="markets"
        title={name.length > 42 ? `${name.slice(0, 42)}…` : name}
        breadcrumb={`DISCOVER · ETF · ${symbol}`}
        onBack={handleBack}
      >
        {isDemoMode && <DemoBanner />}

        {brokerInfo.status === "needs_reauth" &&
          brokerInfo.reauthUrl &&
          brokerInfo.brokerDisplayName && (
            <BrokerReauthBanner
              brokerName={brokerInfo.brokerDisplayName}
              reauthUrl={brokerInfo.reauthUrl}
              className="mb-4"
            />
          )}

        {/* ── Hero header (playful, ETF-tuned) ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 20,
            alignItems: "center",
            paddingBottom: 16,
            borderBottom: "2px solid var(--ink)",
            marginBottom: 22,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              minWidth: 0,
            }}
          >
            <div
              className="pf-av-sq"
              style={{
                background: "var(--pop-2)",
                color: "#1d1d1b",
                width: 52,
                height: 52,
                fontSize: 16,
                borderRadius: 12,
                boxShadow: "var(--shadow-soft)",
                flexShrink: 0,
              }}
            >
              {initials}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  className="pf-pill"
                  style={{
                    background: "var(--pop-2)",
                    color: "#1d1d1b",
                    borderColor: "var(--pop-2)",
                    fontSize: 10,
                  }}
                >
                  ETF
                </span>
                {category && (
                  <span className="pf-pill emerald" style={{ fontSize: 10 }}>
                    {category}
                  </span>
                )}
                {assetClass && assetClass !== "Other" && (
                  <span
                    className="pf-pill"
                    style={{
                      background: "var(--pop-5)",
                      color: "var(--paper)",
                      borderColor: "var(--pop-5)",
                      fontSize: 10,
                    }}
                  >
                    {assetClass}
                  </span>
                )}
                <span className="pf-pill outline" style={{ fontSize: 10 }}>
                  {exchange}
                </span>
              </div>
              <h1
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  letterSpacing: -1.2,
                  lineHeight: 1.05,
                  color: "var(--ink)",
                }}
              >
                {name}
              </h1>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                }}
              >
                {fundHouse}
                {identitySource === "instrument"
                  ? " (from listing name)"
                  : ""}{" "}
                · Ticker {symbol}
                {isin ? ` · ISIN ${isin}` : ""}
                {schemeCode ? ` · AMFI ${schemeCode}` : ""}
              </div>
            </div>
          </div>

          {/* Price block — iNAV primary when present, else LTP; never blank. */}
          <div style={{ textAlign: "right" }}>
            {inav != null ? (
              <>
                <div
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 10,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: "var(--ink-3)",
                  }}
                >
                  iNAV{inavDate ? ` · ${formatIso(inavDate)}` : ""}
                </div>
                <div
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 32,
                    fontWeight: 800,
                    color: "var(--ink)",
                    letterSpacing: -1,
                    marginTop: 2,
                  }}
                >
                  ₹{formatPrice(inav)}
                </div>
              </>
            ) : ltp != null ? (
              <>
                <div
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 10,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: "var(--ink-3)",
                  }}
                >
                  LTP · {exchange}
                </div>
                <div
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 32,
                    fontWeight: 800,
                    color: "var(--ink)",
                    letterSpacing: -1,
                    marginTop: 2,
                  }}
                >
                  ₹{formatPrice(ltp)}
                </div>
                {change != null && changePercent != null && (
                  <div
                    style={{
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 12,
                      color: changeColor,
                      fontWeight: 700,
                      marginTop: 4,
                    }}
                  >
                    {isPositive ? "+" : ""}
                    {change.toFixed(2)} ({isPositive ? "+" : ""}
                    {changePercent.toFixed(2)}%) today
                  </div>
                )}
              </>
            ) : (
              <div
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  color: "var(--ink-3)",
                  fontStyle: "italic",
                }}
              >
                Pricing data unavailable for this ETF
              </div>
            )}

            {/* LTP secondary line — only when iNAV is the primary metric. */}
            {inav != null && ltp != null && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 6,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: "var(--ink-3)",
                  }}
                >
                  LTP
                </span>
                <span
                  style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}
                >
                  ₹{formatPrice(ltp)}
                </span>
                {change != null && changePercent != null && (
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      color: changeColor,
                    }}
                  >
                    {isPositive ? "+" : ""}
                    {changePercent.toFixed(2)}%
                  </span>
                )}
              </div>
            )}

            {/* Premium / discount vs EOD iNAV. */}
            {ltp != null &&
              inav != null &&
              inav > 0 &&
              (() => {
                const premium = ((ltp - inav) / inav) * 100;
                const isPrem = premium >= 0;
                const tone =
                  Math.abs(premium) < 0.25
                    ? "var(--emerald)"
                    : isPrem
                      ? "var(--pop-2)"
                      : "var(--pop-5)";
                return (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginTop: 8,
                    }}
                  >
                    <span
                      className="pf-pill outline"
                      style={{ fontSize: 10, color: tone, borderColor: tone }}
                      title="Premium/discount of LTP vs end-of-day iNAV"
                    >
                      {isPrem ? "+" : ""}
                      {premium.toFixed(2)}% vs iNAV
                    </span>
                  </div>
                );
              })()}

            {previousClose != null && (inav != null || ltp != null) && (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  color: "var(--ink-3)",
                }}
              >
                Prev close ₹{formatPrice(previousClose)}
              </div>
            )}

            {/* Action bar */}
            <div
              style={{
                marginTop: 10,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <WatchlistPopover
                target={{ symbol, exchange, kind: "STOCK" }}
                displayKind="ETF"
              />
              <Link
                href={`/compare?items=${encodeURIComponent(`ETF:${symbol}`)}`}
              >
                <button type="button" className="pf-bf sm">
                  <GitCompare size={11} /> Compare
                </button>
              </Link>
            </div>
          </div>
        </div>

        {/* ── Price chart — TradingView (ETF OHLC is live on the exchange) ── */}
        <div id="chart" className="mb-6">
          <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
            <TradingViewAdvancedChart
              symbol={symbol}
              exchange={exchange === "BSE" ? "BSE" : "NSE"}
              height={480}
            />
          </div>
        </div>

        {/* ── Key stats grid ── */}
        <div className="pf-sec-h">
          <span className="n">METRICS</span>
          <h3>
            Key <span className="ser">numbers.</span>
          </h3>
          <span className="rule" />
        </div>
        <div className="mb-6">
          <FundKeyStatsGrid
            aum={aum}
            expenseRatio={expenseRatio}
            returns3Y={returns3Y}
            returns5Y={returns5Y}
            returnsInception={returnsInception}
            // The 52-week range is the TRADED range from our own daily closes.
            // An ETF has a full OHLC series and a once-daily NAV, so the honest
            // number here is the price one — `rangeBasis` is what stops it
            // being read as a NAV range.
            navHigh={priceHigh52}
            navLow={priceLow52}
            rangeBasis="PRICE"
            history={navStats}
            benchmarkName={benchmarkName}
          />
        </div>

        {/* ── SIP / STP calculator ── */}
        <div id="sip-calculator" className="scroll-mt-24 mb-6">
          <SipCalculator
            ltp={ltp}
            assetClass={assetClass}
            defaultAnnualReturn={returns5Y ?? returns3Y ?? null}
          />
        </div>

        {/* ── About the ETF ── */}
        <div className="pf-sec-h">
          <span className="n">ABOUT</span>
          <h3>
            About this <span className="ser">ETF.</span>
          </h3>
          <span className="rule" />
        </div>
        <div className="mb-6">
          <FundAboutCard
            description={description}
            descriptionLoading={false}
            subCategory={subCategory}
            fundManager={fundManager}
            amcName={fundHouse}
            launchDate={launchDate ? formatIso(launchDate) : null}
            exitLoad={exitLoad}
            // Null unless the scheme states one. MONEY-610 removed a fabricated
            // benchmark from this product once; passing the CATEGORY here put
            // one straight back.
            benchmarkName={benchmarkName}
          />
        </div>

        {/* ── Holdings + sector + cap mix ── */}
        <div className="pf-sec-h">
          <span className="n">HOLDINGS</span>
          <h3>
            Top <span className="ser">holdings.</span>
          </h3>
          <span className="rule" />
          <span className="meta">portfolio composition</span>
        </div>

        {/* The AMC's own monthly disclosure. Mounted unconditionally whenever
            there is a scheme code to look up: it owns its empty state and its
            provenance chip, so a fund whose AMC has published nothing says so
            rather than rendering silence. */}
        {schemeCode && (
          <div className="mb-6">
            <MfPortfolioTab schemeCode={schemeCode} schemeName={name} />
          </div>
        )}

        {/* Sector + market-cap donuts — MONEY-1405 D4/D5.
            Mounted for BOTH disclosure states now, and the reason the old
            `no-official` gate existed is preserved one layer down rather than
            abandoned: `FundCompositionSection` suppresses its OWN holdings
            table when the composition it got came from the disclosure, so
            "two tables of different numbers for one fund" still cannot happen.
            With `schemeCode` in hand it serves the AMC's own filed portfolio —
            ETFs are schemes and appear in the SAME monthly AMC file — and the
            model recollection only when there is no filing to read. Still
            hidden while UNKNOWN: an appearing panel is an ordinary progressive
            load, a disappearing one moves the page under a reader in it. */}
        {disclosure !== "unknown" && (
          <FundCompositionSection
            fundType="ETF"
            fundId={symbol}
            schemeCode={schemeCode ?? undefined}
            hasOfficialDisclosure={disclosure === "official"}
          />
        )}
      </TerminalLuxeShell>
    </PageGuard>
  );
}
