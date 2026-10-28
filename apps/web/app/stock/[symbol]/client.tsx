"use client";

/**
 * Stock Detail Client Component — Playful re-skin (MONEY-485)
 *
 * Renders the stock detail page with:
 * - Live price ticker (useQuote)
 * - TradingViewAdvancedChart (Advanced Charts library, UDF backend)
 * - Key stats from quote data
 * - About section with sector, industry, ISIN
 *
 * Chrome is the playful (`pf-*`) design system from playful-app.css; the
 * chart component + data wiring are untouched. Real values only — every
 * metric falls back to "—" when the quote doesn't carry it.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { DemoBanner } from "@/components/DemoBanner";

import { PageGuard } from "@/components/PageGuard";
import { StockDetailSkeleton } from "@/components/skeletons";
import BrokerReauthBanner from "@/components/BrokerReauthBanner";
import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { TradingViewAdvancedChart } from "@/components/charts";
import { useQuote } from "@/hooks/useMarketData";
import { useBrokerStatus } from "@/hooks/useBrokerStatus";
import { getOrGenerateDescriptionAction } from "@/lib/actions/stock-description";
import { getOrEnrichSectorAction } from "@/lib/actions/stock-sector";
import { startResearchAction } from "@/lib/actions/research";
import { toast } from "sonner";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";
import { formatNumber, formatVolume, formatMarketCap } from "./stock-format";
import {
  Brain,
  TrendingUp,
  BarChart2,
  GitCompare,
  Sparkles,
  Newspaper,
  CalendarClock,
  Users,
  PieChart,
  Activity,
  ArrowLeftRight,
} from "lucide-react";
import FundCompositionSection from "@/components/FundCompositionSection";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import { DayRangeBar } from "@/components/stock/DayRangeBar";
import {
  parseStockTab,
  tabAfterFnoHidden,
  visibleStockTabs,
  type FnoTabState,
  type StockTab,
} from "@/components/stock/StockSectionTabs";
import { StockReturnsBars } from "@/components/stock/StockReturnsBars";
import { StockFundamentalsCard } from "@/components/stock/StockFundamentalsCard";
import { StockAnalystSnapshot } from "@/components/stock/StockAnalystSnapshot";
import { StockTechnicalsCard } from "@/components/stock/StockTechnicalsCard";
import { StockFinancialsTab } from "@/components/stock/StockFinancialsTab";
import { StockPeersTab } from "@/components/stock/StockPeersTab";
// MONEY-1204 / 14c.4 — the NSE-primary shareholding section REPLACES the
// legacy Tickertape-only `StockShareholdingTab` here. Two panels reading two
// providers, only one of them labelled, is exactly the silent downgrade the
// provenance envelope was built to prevent (packages/services/src/provenance.ts).
// The legacy live-fetch chain is not deleted — `getShareholdingAction` still
// backs the chat tool in lib/chat-tools/registry.ts.
import { StockShareholdingSection } from "@/components/stock/StockShareholdingSection";
import { StockCorpActionsHistoryCard } from "@/components/stock/StockCorpActionsHistoryCard";
import { StockNewsTab } from "@/components/stock/StockNewsTab";
// MONEY-1204 / P14 — data-engine sections.
import { StockFlagsBadges } from "@/components/stock/StockFlagsBadges";
import { SECTION_EMPTY_BODY } from "@/components/stock/SectionShell";
import { StockDerivativesTab } from "@/components/stock/StockDerivativesTab";
import { StockInsiderTimeline } from "@/components/stock/StockInsiderTimeline";
import { StockDealsTab } from "@/components/stock/StockDealsTab";
import { StockFilingsTimeline } from "@/components/stock/StockFilingsTimeline";
import { StockFundsHolding } from "@/components/stock/StockFundsHolding";
import ResearchModal from "@/components/analysis/ResearchModal";

// ============== TYPES ==============

interface StockDetailClientProps {
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  instrumentId: string | null;
  isin: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
  instrumentType: string;
}

// Period selection now lives in the TradingView resolution toolbar - no
// app-level period state needed. The UDF backend computes per-symbol
// supported_resolutions based on broker creds (Zerodha-only intervals are
// excluded for users without an active broker).

// ============== DEMO DATA ==============

const DEMO_QUOTE = {
  symbol: "NIFTY50",
  exchange: "NSE",
  name: "Nifty 50",
  price: 22456.8,
  change: 156.35,
  changePercent: 0.7,
  open: 22310.15,
  high: 22512.4,
  low: 22285.6,
  previousClose: 22300.45,
  volume: 245000000,
  timestamp: new Date(),
  marketCap: 19500000000000,
  pe: 21.5,
  eps: 1044.5,
  week52High: 23338.7,
  week52Low: 18837.85,
};

// Demo mode no longer renders a chart - the TradingView UDF backend requires
// Clerk auth, but demo sessions are HMAC-cookie based. Demo users see a
// placeholder card with a sign-up CTA below.

// ============== HELPERS ==============
// Pure formatters live in ./stock-format so they can be unit-tested
// directly (no client-component module graph in the test).

// Tab defs reuse the existing StockTab union — the four real sections the
// page actually renders. The design's longer tab strip is fronted by these
// (no fabricated tabs).
const PF_STOCK_TABS: Array<{
  id: StockTab;
  label: string;
  Icon: typeof Sparkles;
}> = [
  { id: "summary", label: "Overview", Icon: Sparkles },
  { id: "financials", label: "Financials", Icon: BarChart2 },
  { id: "peers", label: "Peers", Icon: Users },
  { id: "ownership", label: "Ownership", Icon: PieChart },
  // MONEY-1205 — Events, split out of Ownership. See StockSectionTabs.tsx for
  // the reasoning; this registry is DUPLICATED, not derived from that one, so
  // the entry has to be made twice or the section exists and is unreachable.
  { id: "events", label: "Events", Icon: ArrowLeftRight },
  // MONEY-1204 / 14c.3 — see the note in StockSectionTabs.tsx for why this is
  // the only new TAB while eight other sections land inside existing ones.
  { id: "derivatives", label: "F&O", Icon: Activity },
  // MONEY-1147 — split out of the old combined "News & events" tab.
  { id: "actions", label: "Corporate actions", Icon: CalendarClock },
  { id: "news", label: "News", Icon: Newspaper },
];

// ============== COMPONENT ==============

export default function StockDetailClient({
  symbol,
  name,
  exchange,
  instrumentType,
  isin,
  sector,
  industry,
  description,
}: StockDetailClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Dynamic route — no literal owner path; the hook captures /stock/{symbol}
  // as it stands at mount, which is the route this component belongs to.
  const ownedRoute = useOwnedRoute();
  const fromPage = searchParams?.get("from");
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  // MONEY-1137: this page's `isDemoMode` does more than hide a banner — the
  // effect below substitutes a hard-coded "Financial Services / Diversified"
  // sector when it is true. Ungated, a stale localStorage flag showed that
  // fabricated sector to a signed-in user. `user` is null for signed-out demo
  // visitors, so demo browsing is unchanged.
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });
  // Sector state - auto-enrich from Yahoo Finance if missing
  const [liveSector, setLiveSector] = useState<string | null>(sector);
  const [liveIndustry, setLiveIndustry] = useState<string | null>(industry);

  useEffect(() => {
    if (liveSector !== null) return;
    if (isDemoMode) {
      setLiveSector("Financial Services");
      setLiveIndustry("Diversified");
      return;
    }
    let cancelled = false;
    getOrEnrichSectorAction(symbol, exchange).then((res) => {
      if (cancelled) return;
      if (res?.success && res.sector) {
        setLiveSector(res.sector);
        if (res.industry) setLiveIndustry(res.industry);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [liveSector, symbol, exchange, isDemoMode]);

  // Description state - auto-generate if missing
  const [desc, setDesc] = useState<string | null>(description);
  const [descLoading, setDescLoading] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);

  useEffect(() => {
    if (desc !== null) return;
    if (isDemoMode) {
      setDesc(
        "A leading company listed on the Indian stock exchange with diversified business interests and strong market presence."
      );
      return;
    }
    let cancelled = false;
    setDescLoading(true);
    getOrGenerateDescriptionAction(symbol, exchange).then((res) => {
      if (cancelled) return;
      if (res?.success && res.description) {
        setDesc(res.description);
      }
      setDescLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [desc, symbol, exchange, isDemoMode]);

  // Broker status for banner and chart source label
  const { brokerStatus: brokerInfo } = useBrokerStatus();

  // Live quote data - skip API calls in demo mode
  const { quote: hookQuote } = useQuote(isDemoMode ? "" : symbol, {
    exchange: exchange as "NSE" | "BSE",
    interval: 30_000,
    enablePolling: !isDemoMode,
    // THE KEY METRICS CARD BELOW RENDERS pe / eps / marketCap / week52High /
    // week52Low, and the market-data service carries none of them. Without
    // this, flipping `MARKET_DATA_QUOTES` on blanks five of the eight tiles
    // while the other three keep ticking. See `UseMarketDataOptions`.
    needsFundamentals: true,
  });

  const quote = isDemoMode ? DEMO_QUOTE : hookQuote;

  // Chart source label - derived from broker creds since the TradingView
  // datafeed picks the source per-bar internally; "Zerodha" badge is shown
  // whenever the user has an active broker connection (intraday will go
  // through Zerodha; daily/weekly fall back to Yahoo).
  const chartSourceLabel: "zerodha" | "yahoo" =
    brokerInfo.status === "active" ? "zerodha" : "yahoo";

  const price = quote?.price ?? 0;
  const change = quote?.change ?? 0;
  const changePercent = quote?.changePercent ?? 0;
  const isPositive = change >= 0;

  const handleBack = () => {
    if (fromPage) {
      router.push(fromPage);
    } else {
      router.back();
    }
  };

  // URL-synced section tab. Default: summary.
  const [tab, setTab] = useState<StockTab>(
    parseStockTab(searchParams?.get("tab"))
  );
  // Sync local state to URL when user clicks a tab.
  //
  // MONEY-1082: this used to call `history.replaceState({}, …)`. Without
  // Next's `__NA` marker on the state object the patched replaceState falls
  // through to ACTION_RESTORE — a real navigation, not a URL-bar touch-up —
  // so a late call could re-assert /stock/{symbol} after the user had left.
  // useOwnedRoute forwards `window.history.state` and gates on the live path.
  function handleTabChange(next: StockTab) {
    setTab(next);
    ownedRoute.syncParams({ tab: next === "summary" ? null : next });
  }

  // ── MONEY-1204 / 14c.3 — the F&O tab is TRI-state, not boolean ───────────
  //
  // `StockDerivativesTab` self-gates (it renders null for a cash-only name),
  // but until it has answered, "is this an F&O name?" is UNKNOWN — which is a
  // third state, not a synonym for "no". Collapsing it to a boolean is what
  // produced the shipped bug: a live "F&O" tab on every stock, a derivatives
  // skeleton, then an empty panel.
  //
  // The rule itself — which state renders during UNKNOWN, and the deep-link
  // exception — lives in `isFnoTabVisible` / `tabAfterFnoHidden` beside the
  // other tab registry, where it is unit-tested and where the two registries
  // cannot drift apart.
  const [fnoState, setFnoState] = useState<FnoTabState>("unknown");
  // The answer belongs to a symbol. Without this reset, a client-side hop from
  // an F&O name to a cash-only one would keep showing the previous stock's tab
  // until the new fetch lands.
  useEffect(() => {
    setFnoState("unknown");
  }, [symbol, exchange]);

  // `onFnoResolved` fires from the child's fetch continuation, and the child
  // deliberately keeps it OUT of its effect deps — so the callback identity is
  // frozen at mount and a `tab` read from its closure would be the value from
  // page load, not the current one. A ref is the read that stays honest.
  const tabRef = useRef<StockTab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  const handleFnoResolved = useCallback(
    (isFno: boolean) => {
      setFnoState(isFno ? "yes" : "no");
      if (isFno) return;
      const next = tabAfterFnoHidden(tabRef.current);
      if (!next) return;
      // The tab the user is standing on is about to disappear (deep link to
      // ?tab=derivatives on a cash-only name). Move them somewhere real rather
      // than leaving a selected tab that is not in the strip.
      //
      // MONEY-1082: this is a late write from an async continuation — exactly
      // the shape that used to yank a user back to a page they had left. It
      // goes through `ownedRoute`, which checks the LIVE window.location and
      // forwards `window.history.state` (the `__NA` marker), so it no-ops if
      // the user has already navigated away.
      setTab(next);
      ownedRoute.syncParams({ tab: next === "summary" ? null : next });
    },
    [ownedRoute]
  );

  const visibleTabs = useMemo(
    () => visibleStockTabs(PF_STOCK_TABS, fnoState, tab),
    [fnoState, tab]
  );

  // About-card meta pills - derived from sector/industry.
  const aboutTags = useMemo(() => {
    const out: string[] = [];
    if (liveSector) out.push(liveSector);
    if (liveIndustry && liveIndustry !== liveSector) out.push(liveIndustry);
    return out;
  }, [liveSector, liveIndustry]);

  // 8-metric grid wired to the live quote. Each tuple: [label, value, sub].
  // Real values only — "—" whenever the quote doesn't carry the field.
  const keyMetrics: Array<[string, string, string]> = [
    [
      "P/E",
      quote?.pe != null ? `${formatNumber(quote.pe)}x` : "—",
      liveIndustry ? "trailing" : "trailing",
    ],
    [
      "EPS",
      quote?.eps != null ? `₹${formatNumber(quote.eps)}` : "—",
      "per share",
    ],
    ["MARKET CAP", formatMarketCap(quote?.marketCap), exchange],
    ["VOLUME", formatVolume(quote?.volume), "today"],
    [
      "52W HIGH",
      quote?.week52High != null ? `₹${formatNumber(quote.week52High)}` : "—",
      "high",
    ],
    [
      "52W LOW",
      quote?.week52Low != null ? `₹${formatNumber(quote.week52Low)}` : "—",
      "low",
    ],
    [
      "OPEN",
      quote?.open != null ? `₹${formatNumber(quote.open)}` : "—",
      "today",
    ],
    [
      "PREV CLOSE",
      quote?.previousClose != null
        ? `₹${formatNumber(quote.previousClose)}`
        : "—",
      "yesterday",
    ],
  ];

  const initials = symbol.slice(0, 2).toUpperCase();
  const crumb = `DISCOVER · ${instrumentType === "ETF" ? "ETF" : "STOCK"} · ${symbol}`;

  return (
    <PageGuard
      route="/discover"
      fallback={<StockDetailSkeleton />}
      containerClassName="p-6 pb-44"
    >
      <TerminalLuxeShell
        active="markets"
        // SYMBOL ONLY. The hero h1 immediately below renders `symbol` + the
        // full company name, so repeating the name here printed it twice on
        // every screen size — and on a phone the pair consumed roughly a third
        // of the viewport before any data appeared. The crumb underneath
        // already carries the section context.
        title={symbol}
        breadcrumb={crumb}
        onBack={handleBack}
      >
        {isDemoMode && <DemoBanner />}

        {/* Broker Reauth Banner — data-source notice up top. */}
        {brokerInfo.status === "needs_reauth" &&
          brokerInfo.reauthUrl &&
          brokerInfo.brokerDisplayName && (
            <BrokerReauthBanner
              brokerName={brokerInfo.brokerDisplayName}
              reauthUrl={brokerInfo.reauthUrl}
              className="mb-4"
            />
          )}

        {/* ── Hero header (design: StockDetailScreen pf-ph) ── */}
        <div
          style={{
            // A wrapping FLEX row, not a grid. It carried `flexWrap: "wrap"`
            // while being `display: grid`, where that property does nothing —
            // so `gridTemplateColumns: "1fr auto"` pinned the price beside the
            // title at every width and the `1fr` column collapsed to ~100px on
            // a phone, which is what stacked the badges one per line. The dead
            // `flexWrap` is the tell that a wrapping row was the intent.
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: 20,
            // Top-aligned. `center` balanced the price block against the FULL
            // height of the identity stack (title + two badge rows + ISIN),
            // which floated it into the middle of nowhere once the stack grew.
            alignItems: "flex-start",
            paddingBottom: 18,
            borderBottom: "2px solid var(--ink)",
            marginBottom: 22,
          }}
        >
          <div
            style={{
              display: "flex",
              // The avatar aligns to the TITLE, not to the centre of the whole
              // identity stack — with `center` it drifted down beside the badge
              // rows as the stack grew taller, reading as unrelated to the name.
              alignItems: "flex-start",
              gap: 14,
              // `min(100%, 300px)` is the whole responsive rule, and it needs
              // no media query: on a wide viewport 300px is a floor the block
              // grows past, and on a phone it resolves to 100% — so the price
              // block can no longer fit beside it and WRAPS to its own line
              // instead of squeezing the title to a few characters. A plain
              // `minWidth: 0` (what was here) permits exactly that squeeze.
              minWidth: "min(100%, 300px)",
              flex: "1 1 auto",
            }}
          >
            <div
              className="pf-av-sq"
              style={{
                background: "var(--emerald)",
                color: "var(--paper)",
                // Fluid, not fixed: at 56px this square plus an 18px gap ate
                // ~19% of a 390px viewport before the title had drawn a glyph.
                width: "clamp(40px, 11vw, 56px)",
                height: "clamp(40px, 11vw, 56px)",
                fontSize: "clamp(13px, 3.6vw, 18px)",
                borderRadius: 12,
                boxShadow: "var(--shadow-soft)",
                flexShrink: 0,
              }}
            >
              {initials}
            </div>
            <div style={{ minWidth: 0 }}>
              {/* The h1 sits OUTSIDE the badge row. It used to be the first
                  flex item in it, so on a wide viewport the title and all six
                  pills ran together on one line, and on a narrow one the
                  pills each took a row of their own. Title on its own line,
                  badges flowing beneath, reads the same at every width. */}
              <h1
                style={{
                  // 38px is ~10 glyphs at 390px wide, so "AARTIIND Aarti
                  // Industries Limited" wrapped into a four-line tower and
                  // pushed every badge onto its own row. Fluid type keeps the
                  // desktop size (the clamp maxes at the original 38/30) and
                  // lets the same markup fit a phone.
                  fontSize: "clamp(24px, 6.5vw, 38px)",
                  fontWeight: 800,
                  letterSpacing: "-0.04em",
                  lineHeight: 1.05,
                  color: "var(--ink)",
                  // `break-word`, NOT `anywhere`. Both break a word too long
                  // for its line, but `anywhere` also drops the element's
                  // min-content contribution to one CHARACTER — which let
                  // this h1 collapse to ~60px so the price block could share
                  // the row, splitting "AARTIIND" into "AAR/TIIN/D".
                  overflowWrap: "break-word",
                }}
              >
                {symbol}
                {name && name !== symbol ? (
                  <span
                    className="ser"
                    style={{
                      fontSize: "clamp(16px, 4.4vw, 30px)",
                      marginLeft: 10,
                    }}
                  >
                    {name}
                  </span>
                ) : null}
              </h1>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 10,
                }}
              >
                <span className="pf-pill emerald" style={{ fontSize: 10.5 }}>
                  {exchange} · {symbol}
                </span>
                <span className="pf-pill outline" style={{ fontSize: 10.5 }}>
                  {instrumentType === "ETF" ? "ETF" : "EQ"}
                </span>
                {/* MONEY-1204 / 14c.1 — exchange flags (ASM/GSM stage, price
                    band, F&O ban, series change) and index-membership chips.
                    Renders nothing at all when the stock carries none, which is
                    the common case; a flag is an exception by definition and an
                    empty state here would be noise on every clean stock. */}
                <StockFlagsBadges symbol={symbol} exchange={exchange} />
                {liveSector && (
                  <span
                    className="pf-pill"
                    style={{
                      background: "var(--pop-5)",
                      color: "var(--paper)",
                      borderColor: "var(--pop-5)",
                      fontSize: 10.5,
                    }}
                  >
                    {liveSector}
                  </span>
                )}
              </div>
              {(liveIndustry || isin) && (
                <div
                  style={{
                    marginTop: 8,
                    fontFamily: "Instrument Serif, serif",
                    fontStyle: "italic",
                    fontSize: 16,
                    color: "var(--ink-3)",
                  }}
                >
                  {liveIndustry}
                  {liveIndustry && isin ? " · " : ""}
                  {isin && (
                    <span
                      style={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontStyle: "normal",
                        fontSize: 12,
                      }}
                    >
                      ISIN {isin}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* `marginLeft: auto` keeps it hard right while it shares the row
              with the title, and `minWidth: 0` lets it shrink instead of
              forcing the flex line wider than the viewport. */}
          <div style={{ textAlign: "right", marginLeft: "auto", minWidth: 0 }}>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10.5,
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
                fontSize: "clamp(26px, 7.5vw, 40px)",
                fontWeight: 800,
                color: "var(--ink)",
                letterSpacing: -1.5,
                lineHeight: 1,
                marginTop: 4,
              }}
            >
              ₹{formatNumber(price)}
            </div>
            <div
              style={{
                marginTop: 6,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 14,
                color: isPositive ? "var(--emerald)" : "var(--pop-1)",
                fontWeight: 700,
              }}
            >
              {isPositive ? "+" : ""}
              {formatNumber(change)} · {isPositive ? "+" : ""}
              {formatNumber(changePercent)}% today
            </div>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <WatchlistPopover target={{ symbol, exchange, kind: "STOCK" }} />
              {paperTradingEnabled && (
                <Link href={`/paper-trading?symbol=${symbol}`}>
                  <button type="button" className="pf-bf sm">
                    <TrendingUp size={11} /> Paper trade
                  </button>
                </Link>
              )}
              {instrumentType !== "ETF" && (
                <button
                  type="button"
                  className="pf-bs sm"
                  onClick={() => setResearchOpen(true)}
                >
                  <Sparkles size={11} /> StockSage
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Chart + metrics + Sage take grid ── */}
        <div
          className="um-stock-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "1.5fr 1fr",
            gap: 18,
          }}
        >
          {/* Chart card — wraps the live TradingView chart; only the chrome
              around it is restyled, the component itself is untouched. */}
          <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "12px 16px",
                borderBottom: "1.5px solid var(--rule-soft)",
              }}
            >
              <div className="ttl" style={{ color: "var(--ink-3)" }}>
                PRICE CHART
              </div>
              {/*
                MONEY-1144 — the pill renders ONLY for a connected broker.
                "Zerodha" is meaningful to the user: it means this chart is
                live rather than exchange-delayed, and it is the user's own
                connection being named, not a vendor of ours. The fallback used
                to read "Yahoo", which named our upstream data vendor for no
                user benefit — and duplicated the delayed-data notice already
                printed under the chart, which is the compliance-relevant
                statement. Absence of the pill now carries that same meaning.
              */}
              {chartSourceLabel === "zerodha" && (
                <span
                  className="pf-pill outline"
                  style={{
                    fontSize: 10,
                    color: "var(--pop-3)",
                    borderColor: "var(--pop-3)",
                  }}
                >
                  Zerodha
                </span>
              )}
            </div>
            {isDemoMode ? (
              <div
                className="flex items-center justify-center text-center"
                style={{ height: 500 }}
              >
                <div style={{ maxWidth: 360, padding: "0 24px" }}>
                  <BarChart2
                    style={{
                      width: 40,
                      height: 40,
                      color: "var(--ink-4)",
                      margin: "0 auto 12px",
                    }}
                  />
                  <h3
                    style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color: "var(--ink-2)",
                      marginBottom: 4,
                    }}
                  >
                    Charts disabled in demo mode
                  </h3>
                  <p
                    style={{
                      fontSize: 13.5,
                      color: "var(--ink-3)",
                      marginBottom: 16,
                    }}
                  >
                    Sign up to view live TradingView charts with real-time data,
                    technical indicators, and drawing tools.
                  </p>
                  <Link href="/sign-up">
                    <button type="button" className="pf-bs sm">
                      Create free account
                    </button>
                  </Link>
                </div>
              </div>
            ) : (
              <div id="chart">
                <TradingViewAdvancedChart
                  symbol={symbol}
                  exchange={exchange as "NSE" | "BSE"}
                  height={500}
                />
              </div>
            )}
          </div>

          {/* Right column: 8-metric grid + Sage take */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="pf-card" style={{ padding: 18 }}>
              <div className="ttl">KEY METRICS</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                  marginTop: 10,
                }}
              >
                {keyMetrics.map(([l, v, d]) => (
                  <div
                    key={l}
                    style={{
                      padding: 8,
                      background: "var(--rule-softer)",
                      borderRadius: 7,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 9.5,
                        color: "var(--ink-3)",
                        letterSpacing: 1,
                        fontWeight: 700,
                      }}
                    >
                      {l}
                    </div>
                    <div
                      style={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 16,
                        fontWeight: 700,
                        marginTop: 2,
                        color: "var(--ink)",
                      }}
                    >
                      {v}
                    </div>
                    <div
                      style={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 10,
                        color: "var(--ink-3)",
                        marginTop: 1,
                      }}
                    >
                      {d}
                    </div>
                  </div>
                ))}
              </div>
              <div
                style={{
                  marginTop: 10,
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 10,
                  color: "var(--ink-4)",
                }}
              >
                As of today
              </div>
            </div>

            {/* Sage take — wired to the same ResearchModal as the header
                button. Hidden for ETFs (research flow reworked separately,
                matching the prior page's guard). Day range lives here too. */}
            {instrumentType !== "ETF" ? (
              <div
                className="pf-card tilt-r"
                style={{ padding: 16, background: "var(--paper-2)" }}
              >
                <div className="ttl">SAGE TAKE</div>
                <div
                  style={{
                    marginTop: 8,
                    fontFamily: "Instrument Serif, serif",
                    fontStyle: "italic",
                    fontSize: 15,
                    color: "var(--ink-2)",
                    lineHeight: 1.4,
                  }}
                >
                  Run a full StockSage research session on {symbol} — thesis,
                  valuation, peers and earnings, in one pass.
                </div>
                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    className="pf-bs sm"
                    onClick={() => setResearchOpen(true)}
                  >
                    <Brain size={11} /> Run research
                  </button>
                  <button
                    type="button"
                    className="pf-bf sm"
                    disabled={isComparing}
                    onClick={async () => {
                      setIsComparing(true);
                      try {
                        const result = await startResearchAction(
                          `Peer comparison for ${symbol}`,
                          "peer-comparison",
                          [symbol],
                          "advanced"
                        );
                        if (result?.success && result.sessionId) {
                          router.push(`/analysis/${result.sessionId}`);
                        } else {
                          toast.error(
                            result?.error ?? "Could not start comparison"
                          );
                          setIsComparing(false);
                        }
                      } catch {
                        toast.error("Could not start comparison");
                        setIsComparing(false);
                      }
                    }}
                  >
                    <GitCompare size={11} />
                    {isComparing ? "Starting…" : "Compare peers"}
                  </button>
                </div>
              </div>
            ) : null}

            {/* Day-range slider — preserved (visualizes LTP between L/H).

                MONEY-1205 adds the 52-WEEK band underneath it. That is where
                the 52-week high/low FLAG went when the header strip stopped
                rendering it: `WK52_HIGH_LOW` publishes for the entire cash
                universe every session (3,325 rows on 2026-08-17), so it was
                never an exception and never belonged in a strip whose contract
                is "a flag is an exception by definition". It is not deleted —
                the numbers already sit in the 52W HIGH / 52W LOW metrics in the
                grid above, this bar puts the CURRENT price between them, and
                the raw published rows stay in the flags payload's `history`.
                `DayRangeBar`'s `label` prop is documented for exactly this. */}
            <div className="pf-card" style={{ padding: 18 }}>
              <div className="ttl" style={{ marginBottom: 10 }}>
                DAY RANGE
              </div>
              <DayRangeBar
                low={quote?.low}
                high={quote?.high}
                current={price}
              />
              <div style={{ marginTop: 14 }}>
                <DayRangeBar
                  label="52W range"
                  low={quote?.week52Low}
                  high={quote?.week52High}
                  current={price}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ── Tabs row (playful segmented, design StockDetailScreen) ── */}
        <div
          role="tablist"
          aria-label="Stock detail sections"
          style={{
            display: "flex",
            gap: 4,
            marginTop: 22,
            marginBottom: 14,
            borderBottom: "2px solid var(--ink)",
            overflowX: "auto",
            // Both axes are set on purpose. Per CSS Overflow, when one axis is
            // not `visible` the other's `visible` COMPUTES TO `auto` — a box
            // cannot scroll one way and overflow the other. So declaring only
            // `overflowX` silently made `overflow-y: auto` too, and the strip
            // grew a vertical scrollbar as soon as its content was a fraction
            // of a pixel taller than the box (the lifted active tab is enough).
            // It showed at every viewport width because it was never a
            // breakpoint bug — it is the default resolution rule.
            overflowY: "hidden",
          }}
        >
          {/* `visibleTabs`, not PF_STOCK_TABS: the F&O entry is dropped once
              the section reports the stock has no derivatives. */}
          {visibleTabs.map((t) => {
            const selected = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => handleTabChange(t.id)}
                style={{
                  padding: "9px 14px",
                  marginBottom: -2,
                  borderRadius: "9px 9px 0 0",
                  background: selected ? "var(--ink)" : "transparent",
                  color: selected ? "var(--paper)" : "var(--ink-3)",
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  whiteSpace: "nowrap",
                  border: selected ? "2px solid var(--ink)" : "none",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <t.Icon size={13} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Financials tab — quarterly/annual income, balance, cashflow.

            MONEY-1204 / 14c.8 had stacked a "Financials provenance" section
            above this table: a STATEMENT SOURCE / LAST REFRESHED card, a
            standalone-vs-consolidated toggle, per-filing coverage rows and a
            "Where these numbers come from." explainer. MONEY-1211 removes it
            outright — the founder does not want the section. The statements
            themselves are what the tab is for.

            The SERVICE behind it is deliberately still alive:
            `getStockFinancialsSource` remains mounted on
            `GET /v1/stocks/:symbol/financials-source` for mobile (see
            apps/api/src/routes/v1/stocks.ts and its parity contract test), so
            this is a web-surface removal, not a data-layer one. */}
        {tab === "financials" && (
          <div className="mb-6">
            <StockFinancialsTab symbol={symbol} exchange={exchange} />
          </div>
        )}

        {/* Peers tab — sector comparison from StockPeers. */}
        {tab === "peers" && (
          <div className="mb-6">
            <StockPeersTab symbol={symbol} exchange={exchange} />
          </div>
        )}

        {/* Ownership tab — WHO OWNS THIS, and how much.
            MONEY-1204 stacked all four data-engine ownership sections here on
            the theory that "who owns this and what did they just do" is one
            subject. MONEY-1205 split the second half out: what remains is two
            views of the same standing position — the quarterly shareholding
            pattern (NSE primary / Tickertape fallback) and, from the other
            direction, the schemes that hold it. Both are answers to "how much",
            restated each quarter, and neither is an event. */}
        {tab === "ownership" && (
          <div className="mb-6 space-y-8">
            <StockShareholdingSection symbol={symbol} exchange={exchange} />
            {/* 14c.9 — the MfPortfolioHolding INVERSE lookup: which schemes
                hold this stock. Ownership, from the other direction. */}
            <StockFundsHolding
              symbol={symbol}
              exchange={exchange}
              marketCap={quote?.marketCap ?? null}
            />
          </div>
        )}

        {/* Events tab — MONEY-1205. WHAT SIGNIFICANT HOLDERS JUST DID.
            Dated, backward-looking disclosures about other people's trades, as
            opposed to the standing positions in Ownership and the scheduled,
            forward-looking dates in Corporate actions.

            Both sections self-fetch on `[symbol, exchange]` and receive nothing
            from this page, so moving them between tabs carries no data-plumbing
            consequence — the only contract that moved is which `tab` value
            mounts them, and the URL half of it lives in `parseStockTab`. */}
        {tab === "events" && (
          <div className="mb-6 space-y-8">
            <StockInsiderTimeline symbol={symbol} exchange={exchange} />
            <StockDealsTab symbol={symbol} exchange={exchange} />
          </div>
        )}

        {/* F&O tab — 14c.3.
            MOUNTED ON EVERY TAB, hidden unless selected. That is deliberate and
            it is the whole mechanism: `isFno` is knowable only from this
            component's own fetch, so gating the mount on `tab === "derivatives"`
            would mean the answer never arrives for the user who never opens the
            tab — and the tab could therefore never be hidden. One mount, one
            fetch (its effect keys on [symbol, exchange]), the answer on page
            load, `onFnoResolved` drops the tab.
            The component still self-gates and renders null for a cash-only
            name, so the hidden wrapper stays empty rather than holding a panel
            nobody can see. */}
        <div className="mb-6" hidden={tab !== "derivatives"}>
          <StockDerivativesTab
            symbol={symbol}
            exchange={exchange}
            onFnoResolved={handleFnoResolved}
          />
        </div>

        {/* MONEY-1147 — Corporate actions is its own section.
            These were always two sibling cards stacked in one tab, never a
            merged list, so this is an IA change: dated, structured, actionable
            facts (dividends / splits / bonuses) do not belong behind the same
            label as third-party commentary. */}
        {tab === "actions" && (
          <div className="mb-6 space-y-8">
            <StockCorpActionsHistoryCard symbol={symbol} exchange={exchange} />
            {/* 14c.7 — exchange filings + the next scheduled event, pinned.
                Beside corporate actions because both are dated, structured,
                actionable facts from the exchange, as opposed to the
                third-party commentary that lives under News. */}
            <StockFilingsTimeline symbol={symbol} exchange={exchange} />
          </div>
        )}

        {/* News tab — third-party coverage only. */}
        {tab === "news" && (
          <div className="mb-6">
            <StockNewsTab symbol={symbol} />
          </div>
        )}

        {/* MONEY-1213 — the Delivery and Exchange-circulars strips were REMOVED
            from this page. Both surfaced pipeline internals to a reader who has
            no use for them: Delivery led with "EXCHANGE BHAVCOPY / 20/20
            SESSIONS REPORTED / GAPS = NOT REPORTED", and the circulars strip
            was labelled "HEURISTIC MATCH" and rendered its own empty state
            ("No recent surveillance circular mentions X") on the overwhelming
            majority of symbols, which is most of them most of the time.

            The `/v1/stocks` endpoints behind both stay mounted for mobile —
            removing a web section is not a reason to break an API contract. */}

        {/* ── About card (Summary tab only) ── */}
        {tab === "summary" && (
          <div className="pf-card" style={{ padding: 18, marginBottom: 24 }}>
            <h3
              style={{
                fontSize: 19,
                fontWeight: 800,
                letterSpacing: -0.5,
                marginBottom: 8,
                color: "var(--ink)",
              }}
            >
              About{" "}
              <span className="ser">
                {name && name !== symbol ? name : symbol}
              </span>
            </h3>
            {descLoading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div
                  className="animate-pulse"
                  style={{
                    height: 12,
                    background: "var(--rule-soft)",
                    borderRadius: 4,
                    width: "100%",
                  }}
                />
                <div
                  className="animate-pulse"
                  style={{
                    height: 12,
                    background: "var(--rule-soft)",
                    borderRadius: 4,
                    width: "92%",
                  }}
                />
                <div
                  className="animate-pulse"
                  style={{
                    height: 12,
                    background: "var(--rule-soft)",
                    borderRadius: 4,
                    width: "75%",
                  }}
                />
              </div>
            ) : desc ? (
              <p
                style={{
                  fontSize: 14.5,
                  color: "var(--ink-2)",
                  lineHeight: 1.65,
                }}
              >
                {desc}
              </p>
            ) : (
              // MONEY-1255 — one body for every empty section on this page.
              // Nothing is demoted: "No description available yet" carried no
              // provenance, so there is no note to keep.
              <p style={{ fontSize: 14, color: "var(--ink-3)" }}>
                {SECTION_EMPTY_BODY}
              </p>
            )}
            <div
              style={{
                marginTop: 16,
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 14,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 12,
              }}
            >
              {(
                [
                  ["SYMBOL", symbol],
                  ["EXCHANGE", exchange],
                  ["SERIES", instrumentType === "ETF" ? "ETF" : "EQ"],
                  ["ISIN", isin ?? "—"],
                  ...(liveSector
                    ? ([["SECTOR", liveSector]] as Array<[string, string]>)
                    : []),
                  ...(liveIndustry
                    ? ([["INDUSTRY", liveIndustry]] as Array<[string, string]>)
                    : []),
                ] as Array<[string, string]>
              ).map(([k, v]) => (
                <div key={k} style={{ minWidth: 0 }}>
                  <div
                    style={{
                      color: "var(--ink-3)",
                      letterSpacing: 1,
                      fontWeight: 700,
                      fontSize: 10,
                    }}
                  >
                    {k}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      fontWeight: 700,
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {v}
                  </div>
                </div>
              ))}
            </div>
            {aboutTags.length > 0 && (
              <div
                style={{
                  marginTop: 16,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                {aboutTags.map((t) => (
                  <span
                    key={t}
                    className="pf-pill outline"
                    style={{ fontSize: 10.5 }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Fundamentals + Analyst + Technicals (MONEY-796) — Summary tab,
            equities only (these don't apply to indices/ETFs). Each card is
            data-gated and self-suppresses when its source row is missing. */}
        {tab === "summary" &&
          instrumentType !== "INDEX" &&
          instrumentType !== "ETF" && (
            <>
              <StockFundamentalsCard symbol={symbol} exchange={exchange} />
              <StockAnalystSnapshot
                symbol={symbol}
                exchange={exchange}
                currentPrice={price > 0 ? price : null}
              />
              <StockTechnicalsCard symbol={symbol} exchange={exchange} />
            </>
          )}

        {/* Returns bar chart — Summary tab only. */}
        {tab === "summary" && (
          <div className="mb-6">
            <StockReturnsBars symbol={symbol} exchange={exchange} />
          </div>
        )}

        {/* ETF Portfolio Composition */}
        {instrumentType === "ETF" && (
          <FundCompositionSection fundType="ETF" fundId={symbol} />
        )}
      </TerminalLuxeShell>

      {/* Research picker — lazy-mounted so internal preference loaders
          don't fire on every stock-detail page view. */}
      {researchOpen && (
        <ResearchModal
          open={researchOpen}
          onOpenChange={setResearchOpen}
          entity={{
            symbol,
            name,
            type: instrumentType === "ETF" ? "etf" : "stock",
            exchange,
          }}
        />
      )}

      {/* Responsive: stack the chart + metrics columns on narrow viewports. */}
      <style>{`
        @media (max-width: 900px) {
          .um-stock-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </PageGuard>
  );
}
