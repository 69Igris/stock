"use client";

/**
 * Markets Overview - MONEY-195 (base) + MONEY-242 (treemap + market-hours)
 *
 * Composition:
 *   1. Header row: "Markets" title + market-status badge (LIVE / Closed)
 *   2. 6-card grid of market indices with sparklines (live during session)
 *   3. One mosaic canvas with a Sectors | Stocks toggle (MONEY-1092):
 *      - Sectors: tile heatmap + RANKED m-cap table + drill-down panel,
 *        deep-linked via `?sector=`. Absorbed from /discover/sectors,
 *        which is now a redirect here.
 *      - Stocks: squarified treemap sized by mcap, coloured by % change,
 *        grouped by sector. Scope toggle: All NSE / Nifty 500 / Nifty 50.
 *   4. 2-column grid: Top Gainers | Top Losers. (Was 3 columns - the
 *      text-bar sector list was deleted; it read from a different,
 *      volume-weighted source than the grid above it and could disagree
 *      with it by up to 24h.)
 *
 * Data flow (all real, no mocks):
 *   - Indices       → getIndicesAction (SSR) + useMarketData (client polling
 *                     gated on isLive)
 *   - Movers        → getDiscoverDataAction (SSR) → topGainers / topLosers
 *   - Sectors       → getSectorHeatmapAction (SSR) → SectorsHeatmap tiles
 *                     (MONEY-1092: replaced the volume-weighted text-bar list)
 *   - Sparklines    → useSparklines 1D window (CSR cache-first)
 *   - Treemap       → getHeatmapDataAction (SSR scope=nifty50) +
 *                     useHeatmapData (polling gated on isLive AND on the
 *                     Stocks canvas being the visible one)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { useSparklines } from "@/hooks/useSparklines";
import { useMarketData } from "@/hooks/useMarketData";
import { useMarketStatus } from "@/hooks/useMarketStatus";
import { useHeatmapData } from "@/hooks/useHeatmapData";
import {
  ResponsiveTreemap,
  HeatmapColorLegend,
} from "@/components/markets/Treemap";
import {
  IndexCardsSkeleton,
  HeatmapSkeleton,
} from "@/components/markets/Skeletons";
import { IndexCard } from "./components/IndexCard";
import { MoversColumn, type MoverRow } from "./components/MoversColumn";
import Link from "next/link";
// MONEY-1204 / 14d.2 + 14d.6 — three data-engine tables that had no reader, and
// the link into the new index-detail route.
import { InstitutionalFlowsWidget } from "@/components/discover/InstitutionalFlowsWidget";
import { ParticipantPositioningWidget } from "@/components/discover/ParticipantPositioningWidget";
import { MacroStripWidget } from "@/components/discover/MacroStripWidget";
import { indexDetailHref } from "@/components/discover/indexRouteLink";
import type { IndexData } from "@/lib/actions/discover-indices";
import type { DiscoverStock } from "@usemoney/services";
import type { SectorHeatmapBucket } from "@/lib/actions/sector-heatmap";
import { useSearchParams } from "next/navigation";
import SectorsHeatmap from "@/app/discover/sectors/SectorsHeatmap";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";
import { normalizeSectorSlug } from "@/lib/sectors/slug";
import type {
  HeatmapData,
  HeatmapScope,
  HeatmapTimeframe,
} from "@/lib/actions/discover-heatmap";

interface MarketsClientProps {
  initialIndices: IndexData[];
  initialGainers: DiscoverStock[];
  initialLosers: DiscoverStock[];
  /** MONEY-1092 - SSR-primed sector buckets for the tile heatmap. Replaces
   *  the text-bar list's `initialSectors`, which came from a different
   *  (volume-weighted) source and disagreed with the grid beside it. */
  initialSectorBuckets: SectorHeatmapBucket[];
  /** Epoch ms when the SSR sector buckets were computed, if that response
   *  was itself a stale-fallback serve. Null when freshly computed. */
  initialSectorStaleSince?: number | null;
  initialHeatmap: HeatmapData | null;
}

const MOVERS_LIMIT = 8;

const SCOPE_OPTIONS: Array<{ id: HeatmapScope; label: string }> = [
  { id: "all", label: "All NSE" },
  { id: "nifty500", label: "Nifty 500" },
  { id: "nifty50", label: "Nifty 50" },
];

const TIMEFRAME_OPTIONS: Array<{ id: HeatmapTimeframe; label: string }> = [
  { id: "1D", label: "1D" },
  { id: "1W", label: "1W" },
  { id: "1M", label: "1M" },
  { id: "YTD", label: "YTD" },
];

function stockToMover(s: DiscoverStock): MoverRow {
  return {
    symbol: s.symbol,
    exchange: s.exchange,
    name: s.name,
    price: s.price,
    changePercent: s.changePercent,
  };
}

export default function MarketsClient({
  initialIndices,
  initialGainers,
  initialLosers,
  initialSectorBuckets,
  initialSectorStaleSince = null,
  initialHeatmap,
}: MarketsClientProps) {
  const { status, closedReason } = useMarketStatus();
  const isLive = status.isLive;

  // CSR fallback for the indices array - the SSR server action can come
  // back empty on a cold cache (weekend / pre-open / DB warmup), and
  // when it does the IndexCardsSkeleton spins forever because there's
  // no symbol list for `useMarketData` to poll. We hit the same
  // `/api/market/indices` endpoint the global TopBar ticker uses, which
  // has its own short cache, so this is a one-shot recovery - not a
  // poll loop.
  const [indices, setIndices] = useState<IndexData[]>(initialIndices);
  useEffect(() => {
    if (indices.length > 0) return;
    let cancelled = false;
    fetch("/api/market/indices")
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (cancelled) return;
        if (res?.success && Array.isArray(res.data)) {
          setIndices(res.data as IndexData[]);
        }
      })
      .catch(() => {
        /* swallow - skeleton stays visible, next poll tick will retry */
      });
    return () => {
      cancelled = true;
    };
  }, [indices.length]);

  // ----- Sparklines for the index cards (cache-first, fetched once) -----
  const sparklineRequests = useMemo(
    () =>
      indices.map((i) => ({
        symbol: i.yahooSymbol,
        exchange: (i.exchange === "BSE" ? "BSE" : "NSE") as "NSE" | "BSE",
      })),
    [indices]
  );
  const { sparklines } = useSparklines(sparklineRequests, { window: "1D" });

  // ----- Live polling for index cards - gated on market-open. -----
  // useMarketData has `enablePolling`, so we just hand it `isLive`.
  // When the market closes mid-session, polling stops on the next
  // tick; the user keeps the most recent quote we received.
  const yahooSymbols = useMemo(
    () => indices.map((i) => i.yahooSymbol),
    [indices]
  );
  const { quotes: liveQuotes } = useMarketData(yahooSymbols, {
    interval: 30_000,
    enablePolling: isLive,
  });

  const liveIndices = useMemo(
    () =>
      indices.map((i) => {
        const live = liveQuotes.get(i.yahooSymbol);
        if (!live) return i;
        return {
          ...i,
          price: Number.isFinite(live.price) ? live.price : i.price,
          change: Number.isFinite(live.change) ? live.change : i.change,
          changePercent: Number.isFinite(live.changePercent)
            ? live.changePercent
            : i.changePercent,
        };
      }),
    [indices, liveQuotes]
  );

  // ----- Treemap heatmap with scope + timeframe toggles. -----
  // Default scope is Nifty 50 (matches the SSR snapshot the page is
  // primed with). Users can widen via the toggle.
  const [scope, setScope] = useState<HeatmapScope>("nifty50");
  const [timeframe, setTimeframe] = useState<HeatmapTimeframe>("1D");

  /* ---------------------------------------------------------------
     MONEY-1092 - one canvas, two views, one URL
     ---------------------------------------------------------------
     `/discover/sectors` used to be a separate page whose heatmap was
     never SSR-primed. It now lives here as the second mode of the
     existing mosaic. Because both modes share one component instance,
     the sector grid is ALWAYS above the drill-down panel and switching
     sectors from inside the drill-down costs zero refetches.

     `?sector=` is read ONCE at mount and written from click handlers.
     It must go through `useOwnedRoute.syncParams` - a raw
     `history.replaceState` drops Next's `__NA` marker and a
     `router.replace` inside an effect re-asserts a route the user has
     already left (MONEY-1082). Both are rejected by the
     `no-unguarded-url-writes` scan, so this is enforced, not just
     advised.

     `syncParams` is write-only: `useSearchParams()` does NOT observe
     it. That is exactly what we want here - React owns the selection,
     the URL is a bookmark for it - but it is why the param is read at
     mount only and never treated as the source of truth.
     -------------------------------------------------------------- */
  const searchParams = useSearchParams();
  const route = useOwnedRoute("/discover/markets");

  // STATE, not a ref. `SectorsHeatmap` is mounted behind the canvas ternary,
  // so toggling to Stocks unmounts it and toggling back remounts it fresh.
  // A ref frozen at first render would hand the remount the page-LOAD slug,
  // so a sector picked in-session vanished on the round trip while the URL
  // still advertised it — the same URL/UI divergence MONEY-1082 was about,
  // reached through unmount instead of a stray history write. Seeding from
  // `searchParams` once is still correct: `syncParams` is write-only, so
  // this is the only read of the URL and React owns the value thereafter.
  const [selectedSectorSlug, setSelectedSectorSlug] = useState<string | null>(
    () => searchParams?.get("sector") ?? null
  );
  // Stocks is the primary view: the thing people come to this page to read is
  // which NAMES moved, and the sector rollup is the summary of that. Sectors
  // stays one click away.
  //
  // The exception is a URL that names a sector. /discover/sectors and
  // /discover/sectors/[sector] both redirect here as `?sector=<slug>`
  // (MONEY-1092), so that param is an explicit request for the sector view —
  // and `SectorsHeatmap` is mounted behind the canvas ternary, so defaulting
  // those visits to Stocks would unmount the very drill-down they asked for
  // while the URL still advertised it. Seeded once, like `selectedSectorSlug`
  // above: React owns the value from then on.
  const [canvas, setCanvas] = useState<"sectors" | "stocks">(() =>
    searchParams?.get("sector") ? "sectors" : "stocks"
  );

  /* MONEY-1126 — how many sector buckets are ACTUALLY on screen.
     The caption below used to count `initialSectorBuckets`, which is the SSR
     prop — and page.tsx wraps that fetch in a 6s `withTimeout`, so it is `[]`
     on every slow render. The caption then read "0 sectors" over a grid of
     thirteen, indefinitely, because the prop never changes after mount.
     `SectorsHeatmap` reports the live count instead; `null` means it does not
     know yet (fetch in flight), and the caption omits the number rather than
     printing a misleading zero. Seeded from the SSR prop so a successful
     server render still labels the first paint. */
  const [liveSectorCount, setLiveSectorCount] = useState<number | null>(() =>
    initialSectorBuckets.length > 0 ? initialSectorBuckets.length : null
  );

  const handleSectorSelection = useCallback(
    (sector: string | null) => {
      const slug = sector ? normalizeSectorSlug(sector) : null;
      setSelectedSectorSlug(slug);
      route.syncParams({ sector: slug });
    },
    [route]
  );
  const { data: heatmap, isLoading: heatmapLoading } = useHeatmapData(scope, {
    initialData: initialHeatmap,
    interval: 60_000,
    timeframe,
    // Don't poll the stock treemap while the sector canvas is showing -
    // it is a full refetch a minute for a grid nobody is looking at.
    enabled: canvas === "stocks",
  });
  // Sector overlay for the STOCK treemap. Now sourced from the same
  // mcap-weighted buckets the sector grid renders, so the two views cannot
  // disagree about which way a sector moved (MONEY-1092).
  const sectorAggregates = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of initialSectorBuckets) {
      map.set(b.name, b.change);
    }
    return map;
  }, [initialSectorBuckets]);

  // ----- Movers + sector heatmap data - already SSR'd. -----
  const topGainers = useMemo(
    () => initialGainers.slice(0, MOVERS_LIMIT).map(stockToMover),
    [initialGainers]
  );
  const topLosers = useMemo(
    () => initialLosers.slice(0, MOVERS_LIMIT).map(stockToMover),
    [initialLosers]
  );

  // MONEY-392: chrome (Sidebar + max-w-[1480px] + title) lives OUTSIDE
  // PageGuard so the header stays visible across loading.tsx → guard
  // loading → hydrated. PageGuard `bare` gates only the inner content
  // so it doesn't render its own /discover-default chrome.
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />

      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1480px] mx-auto">
          {/* Header - ALWAYS visible (outside PageGuard) so the title
              stays through loading.tsx → guard loading → hydrated.
              Playful skin (MONEY-485): pf-ph eyebrow + serif headline +
              italic sub-line; live/closed status moves to the right slot. */}
          <div className="pf-ph">
            <div className="l">
              <div className="eyebrow">
                <span className="d" aria-hidden />
                NSE · BSE · LIVE
              </div>
              <h1>
                The market, <span className="ser">in one</span>{" "}
                <span className="hl">breath.</span>
              </h1>
              <div className="sub">
                Indices, sectors, gainers and losers — all NSE/BSE, ranked by
                relevance.
              </div>
            </div>
            <div className="r">
              {isLive ? (
                <span
                  className="pf-pill emerald"
                  title="Indices + heatmap auto-refresh during market hours"
                >
                  <span
                    className="d"
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "currentColor",
                    }}
                  />
                  LIVE · 09:15–15:30 IST
                </span>
              ) : (
                <span
                  className="pf-pill outline"
                  style={{ color: "var(--ink-3)" }}
                  title="Markets are closed - no auto-refresh"
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--ink-3)",
                    }}
                  />
                  {(closedReason ?? "Closed").toUpperCase()}
                </span>
              )}
            </div>
          </div>

          <PageGuard
            route="/discover"
            bare
            fallback={
              <div className="space-y-5 animate-pulse" aria-hidden="true">
                {/* 6 index cards row */}
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="rounded-xl border border-[var(--border-default)] bg-muted/30 p-3 space-y-1.5"
                    >
                      <div className="h-3 w-20 bg-muted/70 rounded" />
                      <div className="h-6 w-24 bg-muted/70 rounded" />
                      <div className="h-3 w-16 bg-muted/50 rounded" />
                    </div>
                  ))}
                </div>
                {/* Heatmap section header */}
                <div className="flex items-baseline gap-3 flex-wrap mt-6 mb-3">
                  <div className="h-5 w-24 bg-muted/70 rounded" />
                  <div className="h-3 w-40 bg-muted/50 rounded" />
                  <div className="ml-auto flex gap-2">
                    <div className="h-7 w-32 bg-muted/50 rounded-lg" />
                    <div className="h-7 w-24 bg-muted/50 rounded-lg" />
                  </div>
                </div>
                {/* Heatmap canvas */}
                <div className="h-[480px] w-full bg-muted/30 rounded-xl" />
                {/* 3-column movers */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 mt-6">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="rounded-xl border border-[var(--border-default)] bg-muted/30 p-4"
                    >
                      <div className="h-3 w-24 bg-muted/70 rounded mb-3" />
                      {Array.from({ length: 5 }).map((__, j) => (
                        <div
                          key={j}
                          className="flex items-center gap-2 py-2 border-b last:border-b-0 border-[var(--border-default)]"
                        >
                          <div className="h-4 w-16 bg-muted/50 rounded" />
                          <div className="h-4 w-24 bg-muted/40 rounded" />
                          <div className="h-4 w-12 bg-muted/50 rounded ml-auto" />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            }
          >
            {/* Page-level ticker strip lives in the global app shell -
                the markets page intentionally doesn't add a second one
                here. The existing top-of-app ticker already cycles
                through the same indices that the cards below render,
                so duplicating it would just stack two tickers (per QA
                feedback Image #48). */}

            {/* Index cards - 2×3 on sm, 3×2 on md, 6×1 on xl. When SSR
                fails we render a framer-motion shimmer skeleton instead of
                an empty-state, since the client-side polling will populate
                the cards as soon as the next quote tick lands. */}
            {liveIndices.length === 0 ? (
              <IndexCardsSkeleton />
            ) : (
              <div className="mb-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
                {liveIndices.map((idx) => {
                  const key = `${idx.yahooSymbol}|${idx.exchange === "BSE" ? "BSE" : "NSE"}`;
                  const spark = sparklines.get(key);
                  const card = (
                    <IndexCard
                      name={idx.name}
                      value={idx.price}
                      change={idx.change}
                      changePercent={idx.changePercent}
                      sparklineData={spark?.closes ?? []}
                    />
                  );
                  // MONEY-1204 / 14d.6. `indexDetailHref` returns null when the
                  // name yields no slug — an UNLINKED card beats a link to a
                  // route that cannot resolve. Note `IndexClose.indexSlug` and
                  // `IndexConstituent.indexId` are different vocabularies that
                  // nothing joined before this route, which is why resolution
                  // is centralised rather than inlined here.
                  const href = indexDetailHref(idx.name);
                  return href ? (
                    <Link
                      key={idx.symbol}
                      href={href}
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      {card}
                    </Link>
                  ) : (
                    <div key={idx.symbol}>{card}</div>
                  );
                })}
              </div>
            )}

            {/* Treemap heatmap section — playful pf-sec-h + toggle pills */}
            <section className="mb-6">
              <div className="pf-sec-h" style={{ flexWrap: "wrap" }}>
                <span className="n">SECTORS</span>
                <h3>
                  Where the <span className="ser">money&apos;s flowing.</span>
                </h3>
                <span className="rule" />
                <span className="meta">
                  {/* The caption has to follow the canvas — in sectors mode
                      the tiles ARE sectors, so quoting a stock count and
                      "grouped by sector" describes the other view.
                      MONEY-1126: the sector count comes from what rendered,
                      not from the SSR prop, and is dropped entirely while
                      unknown — same shape as the stocks branch below, which
                      already omits its count when `heatmap` is null. */}
                  {canvas === "sectors"
                    ? liveSectorCount !== null
                      ? `${liveSectorCount} sectors · sized by mcap · coloured by change`
                      : "sized by mcap · coloured by change"
                    : heatmap
                      ? `${heatmap.stocks.length.toLocaleString("en-IN")} stocks · grouped by sector · sized by mcap`
                      : "grouped by sector · sized by mcap"}
                </span>
                <div
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  {/* MONEY-1092 - Sectors | Stocks share ONE canvas rather
                      than stacking two large mcap mosaics that say
                      overlapping things. */}
                  <div
                    role="tablist"
                    aria-label="Heatmap view"
                    style={{
                      display: "flex",
                      border: "1.5px solid var(--ink)",
                      borderRadius: 8,
                      padding: 3,
                      background: "var(--paper)",
                    }}
                  >
                    {(["sectors", "stocks"] as const).map((id) => {
                      const active = canvas === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setCanvas(id)}
                          className="mono"
                          style={{
                            padding: "5px 10px",
                            borderRadius: 5,
                            border: 0,
                            cursor: "pointer",
                            fontSize: 11.5,
                            fontWeight: active ? 700 : 600,
                            letterSpacing: 0.3,
                            background: active ? "var(--ink)" : "transparent",
                            color: active ? "var(--paper)" : "var(--ink-3)",
                            transition: "background .12s, color .12s",
                          }}
                        >
                          {id === "sectors" ? "Sectors" : "Stocks"}
                        </button>
                      );
                    })}
                  </div>
                  {canvas === "stocks" && (
                    <>
                      <div
                        role="tablist"
                        aria-label="Heatmap scope"
                        style={{
                          display: "flex",
                          border: "1.5px solid var(--ink)",
                          borderRadius: 8,
                          padding: 3,
                          background: "var(--paper)",
                        }}
                      >
                        {SCOPE_OPTIONS.map((opt) => {
                          const active = scope === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="tab"
                              aria-selected={active}
                              onClick={() => setScope(opt.id)}
                              className="mono"
                              style={{
                                padding: "5px 10px",
                                borderRadius: 5,
                                border: 0,
                                cursor: "pointer",
                                fontSize: 11.5,
                                fontWeight: active ? 700 : 600,
                                letterSpacing: 0.3,
                                background: active
                                  ? "var(--ink)"
                                  : "transparent",
                                color: active ? "var(--paper)" : "var(--ink-3)",
                                transition: "background .12s, color .12s",
                              }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                      <div
                        role="tablist"
                        aria-label="Heatmap timeframe"
                        style={{
                          display: "flex",
                          border: "1.5px solid var(--ink)",
                          borderRadius: 8,
                          padding: 3,
                          background: "var(--paper)",
                        }}
                      >
                        {TIMEFRAME_OPTIONS.map((opt) => {
                          const active = timeframe === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="tab"
                              aria-selected={active}
                              onClick={() => setTimeframe(opt.id)}
                              className="mono"
                              style={{
                                padding: "5px 9px",
                                borderRadius: 5,
                                border: 0,
                                cursor: "pointer",
                                fontSize: 11,
                                fontWeight: active ? 700 : 600,
                                letterSpacing: 0.3,
                                background: active
                                  ? "var(--ink)"
                                  : "transparent",
                                color: active ? "var(--paper)" : "var(--ink-3)",
                                transition: "background .12s, color .12s",
                              }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {canvas === "sectors" ? (
                /* The sector grid, ranked table and drill-down panel, SSR
                   primed. Same component the standalone /discover/sectors
                   page used - it now lives on the canonical markets page
                   instead of behind a second route with no SSR priming. */
                <SectorsHeatmap
                  initialBuckets={initialSectorBuckets}
                  initialStaleSince={initialSectorStaleSince}
                  initialSectorSlug={selectedSectorSlug}
                  onSelectionChange={handleSectorSelection}
                  // The raw setter: a `useState` setter has a stable identity,
                  // so this needs no `useCallback` and the child's reporting
                  // effect never re-fires on a parent render.
                  onBucketCountChange={setLiveSectorCount}
                />
              ) : heatmap && heatmap.stocks.length > 0 ? (
                <div className="relative">
                  <ResponsiveTreemap
                    stocks={heatmap.stocks}
                    sectorAggregates={sectorAggregates}
                    aspect={1.9}
                    minHeight={scope === "nifty50" ? 420 : 540}
                    maxHeight={scope === "nifty50" ? 600 : 820}
                  />
                  {/* Transition loader - `heatmapLoading` flips true while
                      a scope/timeframe-driven refetch is in flight. We
                      keep the stale grid visible behind a soft veil + a
                      pulse pill so the eye anchors and the user gets
                      immediate feedback (per QA Image #57). */}
                  {heatmapLoading && (
                    <div
                      className="absolute inset-0 rounded-xl flex items-center justify-center backdrop-blur-[2px] pointer-events-none"
                      style={{ background: "rgba(0,0,0,0.18)" }}
                    >
                      <span className="pf-pill emerald">
                        <span
                          className="d"
                          aria-hidden
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: "currentColor",
                          }}
                        />
                        UPDATING HEATMAP…
                      </span>
                    </div>
                  )}
                  <HeatmapColorLegend />
                </div>
              ) : (
                <HeatmapSkeleton height={scope === "nifty50" ? 420 : 540} />
              )}
            </section>

            {/* 3-column movers + sector heatmap — playful section header */}
            <div className="pf-sec-h">
              <span className="n">MOVERS</span>
              <h3>
                Top movers <span className="ser">— today.</span>
              </h3>
              <span className="rule" />
              <span className="meta">NSE · BSE</span>
            </div>
            {/* MONEY-1092 - the text-bar "SECTOR HEATMAP" column is gone.
                It read from getSectorPerformanceAction (volume-weighted, a
                different universe, and on the discover namespace's 24h
                default TTL), so it could and did disagree with the
                mcap-weighted tile grid directly above it. Movers now get
                the full width. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {/* Loading flag = SSR returned an empty list AND we're in
                  market-open phase. In that state we know data is on its
                  way (cache cold or upstream slow); the skeleton beats
                  the previous "No data yet" empty-state which read as a
                  bug. After-close empty stays as the calm empty-state. */}
              <MoversColumn
                title="Top gainers"
                rows={topGainers}
                tone="gain"
                loading={topGainers.length === 0 && isLive}
              />
              <MoversColumn
                title="Top losers"
                rows={topLosers}
                tone="loss"
                loading={topLosers.length === 0 && isLive}
              />
            </div>

            {/* MONEY-1204 / 14d.2 — three data-engine tables that had no reader
                at all before this: FII/DII cash flows, participant F&O
                positioning, and the macro strip.

                Each widget owns its own fetch, provenance chip and empty state
                through SectionShell, so a cold or empty table degrades to an
                explained empty box rather than a hole in the page. That matters
                here more than usual: these tables are populated by prod-only
                nightly jobs, so on QA they can legitimately be empty for a day. */}
            <div className="pf-sec-h" style={{ marginTop: 26 }}>
              <span className="n">FLOWS</span>
              <h3>
                Who&apos;s <span className="ser">actually buying.</span>
              </h3>
              <span className="rule" />
              <span className="meta">NSE · EOD</span>
            </div>
            <div className="grid grid-cols-1 gap-5">
              <InstitutionalFlowsWidget windowSessions={20} />
              <ParticipantPositioningWidget
                defaultParticipant="FII"
                defaultMetric="OI"
              />
              <MacroStripWidget />
            </div>
          </PageGuard>
        </div>
      </main>
    </div>
  );
}
