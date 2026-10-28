"use client";

/**
 * Fund Comparison Client Component — Playful re-skin (MONEY-485)
 *
 * Renders side-by-side comparison of 2-5 funds:
 * - Coloured fund chips (add/remove via ComparePicker)
 * - Key metrics table (pf-tbl, best-in-row highlight)
 * - NAV performance overlay chart (recharts, normalized to base 100)
 * - Common & unique holdings analysis
 * - Sector overlap chart (recharts)
 * - Sage take
 *
 * The recharts charts and all comparison/Analyse data logic are untouched;
 * only the surrounding chrome is re-skinned to the playful `pf-*` system.
 */

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";

import { PageGuard } from "@/components/PageGuard";
import { DiscoverSkeleton } from "@/components/skeletons";
import { DemoBanner } from "@/components/DemoBanner";
import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import type {
  NavOverlayChartProps,
  SectorOverlapChartProps,
} from "./CompareChartsCanvas";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  FlaskConical,
  GitCompareArrows,
} from "lucide-react";
import type { ComparableFund } from "@usemoney/types";
import type { CompositionResult } from "@usemoney/core/market-data";
import { triggerCompositionExtractionAction } from "@/lib/actions/fund-composition";
import {
  startComparisonAction,
  type ComparisonKind,
  type ComparisonDepth,
} from "@/lib/actions/comparison";
import { ComparePicker } from "@/components/compare/ComparePicker";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

// ============== TYPES ==============

interface CompareClientProps {
  funds: ComparableFund[];
  navHistory: Record<string, Array<{ date: string; value: number }>>;
  compositions: Record<string, CompositionResult | null>;
  error?: string;
  /**
   * Pre-loaded item when /compare is opened with a single entry from the
   * `/mf/[schemeCode]` "Compare" button. Renders a chip in the picker so
   * the user can add the second/Nth fund without leaving the page.
   */
  seedItems?: Array<{
    fundType: "MF" | "ETF" | "INDEX" | "STOCK";
    fundId: string;
  }>;
}

// ============== CONSTANTS ==============

// Playful pop palette — emerald / blue / gold / coral / violet, in the same
// order the design lines its compare columns up.
/**
 * MONEY-290 — both recharts charts are behind a `next/dynamic` boundary, so
 * recharts is fetched only when a comparison actually has a NAV series or an
 * extracted sector breakdown to plot. Both charts sit far below the fold
 * (under the metrics table / holdings analysis), so this moves ~400 KB off the
 * /compare critical path.
 *
 * `ssr: false` because <ResponsiveContainer> measures the DOM and renders
 * nothing server-side. Each fallback fills its parent, and both parents carry
 * a fixed pixel height (360 / 330), so the swap-in is CLS-free.
 */
function ChartCanvasFallback() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 10,
        background: "var(--rule-softer)",
        opacity: 0.55,
      }}
    />
  );
}

const NavOverlayChart = dynamic<NavOverlayChartProps>(
  () => import("./CompareChartsCanvas").then((m) => m.NavOverlayChart),
  { ssr: false, loading: ChartCanvasFallback }
);

const SectorOverlapChart = dynamic<SectorOverlapChartProps>(
  () => import("./CompareChartsCanvas").then((m) => m.SectorOverlapChart),
  { ssr: false, loading: ChartCanvasFallback }
);

const FUND_COLORS = ["#16a34a", "#3b82f6", "#fbbf24", "#ff6b35", "#a78bfa"];

const PERIOD_OPTIONS = [
  { label: "1M", months: 1 },
  { label: "3M", months: 3 },
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
  { label: "3Y", months: 36 },
] as const;

// ============== HELPERS ==============

function formatCurrency(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatReturn(ret: number | null): string {
  if (ret === null || ret === undefined) return "—";
  return `${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`;
}

function formatAum(aum: number | null): string {
  if (!aum) return "—";
  if (aum >= 10000) return `₹${(aum / 10000).toFixed(1)}L Cr`;
  if (aum >= 100) return `₹${aum.toFixed(0)} Cr`;
  return `₹${aum.toFixed(2)} Cr`;
}

function fundLabel(f: ComparableFund, max = 22): string {
  if (f.fundType !== "MF") return f.id;
  return f.name.length > max ? `${f.name.slice(0, max)}…` : f.name;
}

function isBest(
  values: (number | null)[],
  index: number,
  higher = true
): boolean {
  const val = values[index];
  if (val === null || val === undefined) return false;
  const others = values.filter(
    (v, i) => i !== index && v !== null && v !== undefined
  ) as number[];
  if (others.length === 0) return false;
  return higher ? val >= Math.max(...others) : val <= Math.min(...others);
}

// ============== COMPONENT ==============

export default function CompareClient({
  funds,
  navHistory,
  compositions: initialCompositions,
  error,
  seedItems: _seedItems,
}: CompareClientProps) {
  const router = useRouter();
  const { user } = useUser();

  const isDemoMode = useIsDemoMode({ user });

  const [selectedPeriod, setSelectedPeriod] = useState<
    (typeof PERIOD_OPTIONS)[number]
  >(PERIOD_OPTIONS[3]); // Default: 1Y

  // Analyse state - tracks composition extraction
  const [compositions, setCompositions] =
    useState<Record<string, CompositionResult | null>>(initialCompositions);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [analyseProgress, setAnalyseProgress] = useState<
    Record<string, "pending" | "loading" | "done" | "error">
  >({});
  const [analyseError, setAnalyseError] = useState<string | null>(null);

  // ── Deep compare (async worker job) state ──
  const [deepDepth, setDeepDepth] = useState<ComparisonDepth>("comprehensive");
  const [isStartingDeep, setIsStartingDeep] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);

  // Resolve the deep-comparison worker skill from the selected items
  // (MONEY-553): all funds (MF/ETF/INDEX) → "mf" (per-fund holdings + overlap),
  // all stocks → "stock" (multi-comparison). A MIXED stock+fund set has no
  // single worker skill, so the deep CTA is disabled — the quick side-by-side
  // above still renders for mixed sets.
  const deepKind: ComparisonKind | null = useMemo(() => {
    if (funds.length < 2) return null;
    const allFunds = funds.every(
      (f) =>
        f.fundType === "MF" || f.fundType === "ETF" || f.fundType === "INDEX"
    );
    if (allFunds) return "mf";
    const allStocks = funds.every((f) => f.fundType === "STOCK");
    if (allStocks) return "stock";
    return null; // mixed → quick compare only
  }, [funds]);

  const deepDisabledReason: string | null = useMemo(() => {
    if (funds.length < 2) return "Select at least 2 items for a deep compare.";
    if (funds.length > 5) return "Deep compare supports up to 5 items.";
    if (!deepKind)
      return "Deep AI compare needs all items to be the same type (all stocks or all funds). The side-by-side above still works for mixed sets.";
    if (isDemoMode)
      return "Deep compare is available after you sign up for a free account.";
    return null;
  }, [funds.length, deepKind, isDemoMode]);

  const startDeepCompare = useCallback(async () => {
    if (!deepKind || isStartingDeep) return;
    setIsStartingDeep(true);
    setDeepError(null);
    // For MF/ETF/INDEX the worker's mf-comparison skill resolves each fund by
    // its scheme code / symbol — exactly ComparableFund.id.
    const symbols = funds.map((f) => f.id);
    const res = await startComparisonAction(deepKind, symbols, deepDepth);
    if (res.success && res.sessionId) {
      router.push(`/compare/${res.sessionId}`);
      return;
    }
    setIsStartingDeep(false);
    setDeepError(
      res.error || "Couldn't start the deep compare. Please try again."
    );
  }, [deepKind, deepDepth, funds, isStartingDeep, router]);

  // NAV chart data - normalized to base 100
  const chartData = useMemo(() => {
    if (funds.length === 0) return [];

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - selectedPeriod.months);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    // Collect all unique dates from all funds
    const allDates = new Set<string>();
    for (const fund of funds) {
      const key = `${fund.fundType}:${fund.id}`;
      const history = navHistory[key] ?? [];
      for (const point of history) {
        if (point.date >= cutoffStr) {
          allDates.add(point.date);
        }
      }
    }

    const sortedDates = Array.from(allDates).sort();
    if (sortedDates.length === 0) return [];

    // For each fund, create a map of date → value and find first value for normalization
    const fundMaps: Array<{ map: Map<string, number>; firstValue: number }> =
      funds.map((fund) => {
        const key = `${fund.fundType}:${fund.id}`;
        const history = (navHistory[key] ?? []).filter(
          (p) => p.date >= cutoffStr
        );
        const map = new Map<string, number>();
        for (const p of history) {
          map.set(p.date, p.value);
        }
        const firstValue = history[0]?.value ?? 1;
        return { map, firstValue };
      });

    // Build chart data points
    return sortedDates.map((date) => {
      const point: Record<string, string | number> = {
        date,
        displayDate: new Date(date).toLocaleDateString("en-IN", {
          month: "short",
          day: "numeric",
        }),
      };

      for (let i = 0; i < funds.length; i++) {
        const { map, firstValue } = fundMaps[i];
        const value = map.get(date);
        if (value !== undefined) {
          // Normalize to base 100
          point[`fund${i}`] = Math.round((value / firstValue) * 10000) / 100;
        }
      }

      return point;
    });
  }, [funds, navHistory, selectedPeriod]);

  // Common holdings analysis
  const holdingsAnalysis = useMemo(() => {
    const fundCompositions = funds.map((f) => {
      const key = `${f.fundType}:${f.id}`;
      return compositions[key];
    });

    // Build symbol → fund indices map
    const symbolToFunds = new Map<
      string,
      Array<{
        fundIndex: number;
        holdingName: string;
        sector: string | null;
        weight: number;
      }>
    >();

    fundCompositions.forEach((comp, fundIdx) => {
      if (!comp) return;
      for (const h of comp.holdings) {
        const sym = (h.holdingSymbol ?? h.holdingName).toUpperCase();
        if (!symbolToFunds.has(sym)) {
          symbolToFunds.set(sym, []);
        }
        symbolToFunds.get(sym)!.push({
          fundIndex: fundIdx,
          holdingName: h.holdingName,
          sector: h.sector,
          weight: h.weightPercent,
        });
      }
    });

    // Common: appears in 2+ funds
    const common: Array<{
      symbol: string;
      holdingName: string;
      sector: string | null;
      weights: (number | null)[];
    }> = [];

    // Unique: appears in only 1 fund
    const unique: Array<
      Array<{
        symbol: string;
        holdingName: string;
        sector: string | null;
        weight: number;
      }>
    > = funds.map(() => []);

    symbolToFunds.forEach((entries, sym) => {
      if (entries.length >= 2) {
        const weights: (number | null)[] = funds.map(() => null);
        entries.forEach((e) => {
          weights[e.fundIndex] = e.weight;
        });
        common.push({
          symbol: sym,
          holdingName: entries[0].holdingName,
          sector: entries[0].sector,
          weights,
        });
      } else {
        const entry = entries[0];
        unique[entry.fundIndex].push({
          symbol: sym,
          holdingName: entry.holdingName,
          sector: entry.sector,
          weight: entry.weight,
        });
      }
    });

    // Sort common by total weight
    common.sort(
      (a, b) =>
        b.weights.reduce((s: number, w: number | null) => s + (w ?? 0), 0) -
        a.weights.reduce((s: number, w: number | null) => s + (w ?? 0), 0)
    );

    return { common, unique, hasData: symbolToFunds.size > 0 };
  }, [funds, compositions]);

  // Sector overlap data for grouped bar chart
  const sectorOverlapData = useMemo(() => {
    const sectorMap = new Map<string, number[]>();

    funds.forEach((f, i) => {
      const key = `${f.fundType}:${f.id}`;
      const comp = compositions[key];
      if (!comp) return;
      for (const s of comp.sectorBreakdown) {
        if (!sectorMap.has(s.sector)) {
          sectorMap.set(
            s.sector,
            funds.map(() => 0)
          );
        }
        sectorMap.get(s.sector)![i] = s.weight;
      }
    });

    return Array.from(sectorMap.entries())
      .map(([sector, weights]: [string, number[]]) => {
        const row: Record<string, string | number> = { sector };
        weights.forEach((w: number, i: number) => {
          row[`fund${i}`] = w;
        });
        return row;
      })
      .sort(
        (a, b) =>
          funds.reduce((s, _, i) => s + ((b[`fund${i}`] as number) ?? 0), 0) -
          funds.reduce((s, _, i) => s + ((a[`fund${i}`] as number) ?? 0), 0)
      )
      .slice(0, 12);
  }, [funds, compositions]);

  // Has any compositions loaded
  const hasCompositions = funds.some((f) => {
    const key = `${f.fundType}:${f.id}`;
    return compositions[key] !== null && compositions[key] !== undefined;
  });

  // Explicit, user-initiated only — see the deleted auto-fire effect below.
  const runAnalyse = useCallback(async () => {
    // Defence in depth for the button path: demo renders fabricated data, so
    // an extraction there spends a paid Gemini call for nothing. The server
    // action refuses demo too — this just avoids the round trip.
    if (isDemoMode) return;
    if (funds.length === 0) return;
    setIsAnalysing(true);
    setAnalyseError(null);
    const progress: Record<string, "pending" | "loading" | "done" | "error"> =
      {};
    for (const f of funds) {
      progress[`${f.fundType}:${f.id}`] = "pending";
    }
    setAnalyseProgress({ ...progress });

    const newCompositions = { ...compositions };
    let anySuccess = false;

    for (const f of funds) {
      // STOCK has no fund composition (holdings) to extract — skip it. This
      // also narrows fundType to the MF/ETF/INDEX the extraction action accepts.
      if (f.fundType === "STOCK") continue;
      const key = `${f.fundType}:${f.id}`;
      if (newCompositions[key]) {
        progress[key] = "done";
        setAnalyseProgress({ ...progress });
        anySuccess = true;
        continue;
      }
      progress[key] = "loading";
      setAnalyseProgress({ ...progress });
      try {
        const result = await triggerCompositionExtractionAction(
          f.fundType,
          f.id
        );
        if (result?.success && result?.data) {
          newCompositions[key] = result?.data as unknown as CompositionResult;
          progress[key] = "done";
          anySuccess = true;
        } else {
          progress[key] = "error";
        }
      } catch {
        progress[key] = "error";
      }
      setAnalyseProgress({ ...progress });
    }

    setCompositions({ ...newCompositions });
    setIsAnalysing(false);
    if (!anySuccess) {
      setAnalyseError(
        "Could not extract holdings for any fund. Try again later."
      );
    }
  }, [funds, compositions, isDemoMode]);

  // NO AUTO-FIRE — MONEY-1405 A1. This used to run `runAnalyse()` on mount,
  // which spent up to five `gemini-2.5-pro` thinking calls per page load, for
  // ETFs, in demo mode. /compare has no per-fund disclosure lookup, so it
  // cannot supply `hasOfficialDisclosure` to `shouldAutoExtractComposition`
  // honestly — an auto-trigger that cannot evaluate the gate must not run at
  // all. The "Analyse all holdings" button below is the only entry point.

  // ── Empty state: render the picker ──
  if (funds.length === 0) {
    return (
      <PageGuard
        route="/discover"
        fallback={<DiscoverSkeleton />}
        containerClassName="p-4 sm:p-6 pb-44"
      >
        <TerminalLuxeShell
          active="markets"
          title={
            <>
              Side-by-side, <span className="ser">no spreadsheet.</span>
            </>
          }
          breadcrumb="DISCOVER · COMPARE"
          onBack={() => router.back()}
        >
          {isDemoMode && <DemoBanner />}
          {error && (
            <div
              className="pf-card"
              style={{
                maxWidth: 640,
                margin: "0 auto 16px",
                padding: "10px 16px",
                background: "var(--paper-2)",
                borderColor: "var(--pop-1)",
                color: "var(--pop-1)",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          <ComparePicker seedItems={_seedItems ?? []} />
        </TerminalLuxeShell>
      </PageGuard>
    );
  }

  return (
    <PageGuard route="/discover" fallback={<DiscoverSkeleton />}>
      <TerminalLuxeShell
        active="markets"
        title={
          <>
            Side-by-side, <span className="ser">no spreadsheet.</span>
          </>
        }
        breadcrumb="DISCOVER · COMPARE"
        onBack={() => router.back()}
        topbarRight={
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              color: "var(--ink-3)",
              fontWeight: 700,
              letterSpacing: 0.5,
            }}
          >
            {funds.length} SELECTED
          </span>
        }
      >
        {isDemoMode && <DemoBanner />}

        {/* ── Eyebrow + sub-line ── */}
        <div
          className="pf-ph"
          style={{ borderBottom: "none", marginBottom: 14, paddingBottom: 0 }}
        >
          <div className="l">
            <div className="eyebrow">
              <span className="d" aria-hidden />
              UP TO 5 · LIVE · FUNDAMENTALS · HOLDINGS
            </div>
            <div className="sub">
              Pick up to 5 funds. We line up NAV, returns, holdings and the
              rest.
            </div>
          </div>
        </div>

        {/* ── Fund chips (coloured, design CompareScreen) ── */}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 18,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {funds.map((f, i) => (
            <span
              key={f.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 11px",
                borderRadius: 9,
                border: `2px solid ${FUND_COLORS[i]}`,
                background: "var(--paper)",
                fontFamily: "JetBrains Mono, monospace",
                fontWeight: 700,
                fontSize: 13,
                color: "var(--ink)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 99,
                  background: FUND_COLORS[i],
                }}
              />
              {fundLabel(f, 22)}
            </span>
          ))}
          {funds.length < 5 && (
            <button
              type="button"
              onClick={() => {
                const items = funds
                  .map((f) => `${f.fundType}:${f.id}`)
                  .join(",");
                router.push(
                  `/compare?items=${encodeURIComponent(items)}&add=1`
                );
              }}
              className="pf-pill outline"
              style={{
                fontSize: 12,
                padding: "5px 11px",
                borderStyle: "dashed",
                cursor: "pointer",
              }}
            >
              + Add · {5 - funds.length} slot{5 - funds.length === 1 ? "" : "s"}{" "}
              left
            </button>
          )}
        </div>

        {/* ── Deep compare (async worker job) ── */}
        <div
          className="pf-card"
          style={{
            padding: 16,
            marginBottom: 18,
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            background: "var(--paper-2)",
          }}
        >
          <div
            className="h-10 w-10 rounded-[11px] grid place-items-center border-[1.5px] border-[var(--ink)] shrink-0"
            style={{ background: "var(--paper)", color: "var(--emerald-text)" }}
          >
            <GitCompareArrows className="h-5 w-5" />
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--ink)",
                marginBottom: 2,
              }}
            >
              Deep compare with AI
            </div>
            <p
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                lineHeight: 1.45,
                margin: 0,
              }}
            >
              A worker-backed run: per-fund analysis, cross-fund holdings
              overlap, and a side-by-side write-up. Takes a few minutes.
            </p>
          </div>

          {/* Depth selector */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["deep", "comprehensive", "advanced"] as const).map((d) => {
              const active = deepDepth === d;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDeepDepth(d)}
                  className={`pf-pill ${active ? "" : "outline"}`}
                  style={
                    active
                      ? {
                          background: "var(--ink)",
                          color: "var(--paper)",
                          cursor: "pointer",
                          textTransform: "capitalize",
                        }
                      : { cursor: "pointer", textTransform: "capitalize" }
                  }
                >
                  {d}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="pf-bs"
            onClick={() => void startDeepCompare()}
            disabled={!!deepDisabledReason || isStartingDeep}
            title={deepDisabledReason ?? undefined}
            style={{
              opacity: deepDisabledReason || isStartingDeep ? 0.6 : 1,
              cursor:
                deepDisabledReason || isStartingDeep
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {isStartingDeep ? (
              <>
                <Loader2
                  className="h-3.5 w-3.5"
                  style={{ animation: "um-spin .9s linear infinite" }}
                />
                Starting…
              </>
            ) : (
              <>
                <GitCompareArrows size={13} /> Deep compare
              </>
            )}
          </button>

          {(deepDisabledReason || deepError) && (
            <p
              style={{
                width: "100%",
                margin: 0,
                fontSize: 12,
                color: deepError ? "var(--pop-1-text)" : "var(--ink-3)",
              }}
            >
              {deepError || deepDisabledReason}
            </p>
          )}
        </div>

        {/* ── Key Metrics Table (pf-tbl) ── */}
        <div className="pf-sec-h" style={{ marginTop: 8 }}>
          <span className="n">METRICS</span>
          <h3>
            Side-by-<span className="ser">side.</span>
          </h3>
          <span className="rule" />
        </div>
        <div
          className="pf-card"
          style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}
        >
          <div style={{ overflowX: "auto" }}>
            <table className="pf-tbl">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>METRIC</th>
                  {funds.map((f, i) => (
                    <th
                      key={f.id}
                      style={{ color: FUND_COLORS[i], textAlign: "right" }}
                    >
                      {fundLabel(f, 16)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <MetricRow label="Type" values={funds.map((f) => f.fundType)} />
                <MetricRow
                  label="NAV / Price"
                  values={funds.map((f) => formatCurrency(f.nav))}
                />
                <MetricRow
                  label="1Y Return"
                  values={funds.map((f) => formatReturn(f.returns1Y))}
                  rawValues={funds.map((f) => f.returns1Y)}
                  highlightBest
                />
                <MetricRow
                  label="3Y Return"
                  values={funds.map((f) => formatReturn(f.returns3Y))}
                  rawValues={funds.map((f) => f.returns3Y)}
                  highlightBest
                />
                <MetricRow
                  label="5Y Return"
                  values={funds.map((f) => formatReturn(f.returns5Y))}
                  rawValues={funds.map((f) => f.returns5Y)}
                  highlightBest
                />
                {/* MONEY-553 — stock-only valuation rows. Rendered only when the
                    set includes a STOCK so fund-only comparisons are unchanged.
                    P/E is shown WITHOUT a best-highlight (a "cheaper" P/E is not
                    a buy signal — SEBI: no recommendation). */}
                {funds.some((f) => f.fundType === "STOCK") && (
                  <>
                    <MetricRow
                      label="P/E"
                      values={funds.map((f) =>
                        f.peRatio != null ? f.peRatio.toFixed(2) : "—"
                      )}
                    />
                    <MetricRow
                      label="Market Cap"
                      values={funds.map((f) => formatAum(f.marketCap ?? null))}
                    />
                  </>
                )}
                <MetricRow
                  label="Risk"
                  values={funds.map((f) => f.riskLevel ?? "—")}
                />
                <MetricRow
                  label="Expense Ratio"
                  values={funds.map((f) =>
                    f.expenseRatio !== null
                      ? `${f.expenseRatio.toFixed(2)}%`
                      : "—"
                  )}
                  rawValues={funds.map((f) => f.expenseRatio)}
                  highlightBest
                  lowerIsBetter
                />
                <MetricRow
                  label="AUM"
                  values={funds.map((f) => formatAum(f.aum))}
                />
                <MetricRow
                  label="Category"
                  values={funds.map((f) => f.category)}
                />
                <MetricRow
                  label="CRISIL"
                  values={funds.map((f) => f.crisilRating ?? "—")}
                />
                <MetricRow
                  label="Fund Manager"
                  values={funds.map((f) => f.fundManager ?? "—")}
                />
              </tbody>
            </table>
          </div>
        </div>

        {/* ── NAV Performance Chart (recharts, untouched) ── */}
        {chartData.length > 0 && (
          <>
            <div className="pf-sec-h">
              <span className="n">NAV</span>
              <h3>
                Performance · <span className="ser">base 100.</span>
              </h3>
              <span className="rule" />
              <div style={{ display: "flex", gap: 6 }}>
                {PERIOD_OPTIONS.map((p) => {
                  const active = selectedPeriod.label === p.label;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setSelectedPeriod(p)}
                      className={`pf-pill ${active ? "" : "outline"}`}
                      style={
                        active
                          ? {
                              background: "var(--ink)",
                              color: "var(--paper)",
                              cursor: "pointer",
                            }
                          : { cursor: "pointer" }
                      }
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="pf-card" style={{ padding: 16, marginBottom: 18 }}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "4px 16px",
                  marginBottom: 12,
                }}
              >
                {funds.map((f, i) => (
                  <div
                    key={f.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 99,
                        background: FUND_COLORS[i],
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: "var(--ink-3)" }}>
                      {fundLabel(f, 22)}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ height: 360 }}>
                <NavOverlayChart
                  data={chartData}
                  series={funds.map((f, i) => ({
                    key: `fund${i}`,
                    name: fundLabel(f, 18),
                    color: FUND_COLORS[i],
                  }))}
                />
              </div>
            </div>
          </>
        )}

        {/* ── Common Holdings (pf-tbl) ── */}
        {hasCompositions && holdingsAnalysis.common.length > 0 && (
          <>
            <div className="pf-sec-h">
              <span className="n">OVERLAP</span>
              <h3>
                Common <span className="ser">holdings.</span>
              </h3>
              <span className="rule" />
              <span className="meta">
                {holdingsAnalysis.common.length} shared
              </span>
            </div>
            <div
              className="pf-card"
              style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}
            >
              <div style={{ overflowX: "auto" }}>
                <table className="pf-tbl">
                  <thead>
                    <tr>
                      <th style={{ paddingLeft: 18 }}>HOLDING</th>
                      <th>SECTOR</th>
                      {funds.map((f, i) => (
                        <th
                          key={f.id}
                          style={{ color: FUND_COLORS[i], textAlign: "right" }}
                        >
                          {fundLabel(f, 14)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {holdingsAnalysis.common.slice(0, 20).map((h) => (
                      <tr key={h.symbol}>
                        <td style={{ paddingLeft: 18 }}>
                          <span className="tk">{h.holdingName}</span>
                        </td>
                        <td>
                          <span
                            className="pf-pill outline"
                            style={{ fontSize: 9.5 }}
                          >
                            {h.sector ?? "—"}
                          </span>
                        </td>
                        {h.weights.map((w, i) => (
                          <td
                            key={`${h.symbol}-${i}`}
                            className="num"
                            style={{ textAlign: "right" }}
                          >
                            {w !== null ? `${w.toFixed(2)}%` : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ── Unique Holdings ── */}
        {hasCompositions &&
          holdingsAnalysis.unique.some((u) => u.length > 0) && (
            <>
              <div className="pf-sec-h">
                <span className="n">UNIQUE</span>
                <h3>
                  Only in <span className="ser">one.</span>
                </h3>
                <span className="rule" />
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: 14,
                  marginBottom: 18,
                }}
              >
                {funds.map((f, i) => {
                  const uniqueList = holdingsAnalysis.unique[i];
                  if (uniqueList.length === 0) return null;
                  return (
                    <div key={f.id} className="pf-card" style={{ padding: 16 }}>
                      <h4
                        style={{
                          fontWeight: 700,
                          fontSize: 13,
                          marginBottom: 10,
                          color: FUND_COLORS[i],
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 99,
                            background: FUND_COLORS[i],
                          }}
                        />
                        {fundLabel(f, 28)} ({uniqueList.length})
                      </h4>
                      <div>
                        {uniqueList.slice(0, 10).map((h) => (
                          <div
                            key={h.symbol}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "6px 0",
                              borderBottom: "1px dashed var(--rule-soft)",
                              fontSize: 13,
                            }}
                          >
                            <span
                              style={{
                                color: "var(--ink-2)",
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {h.holdingName}
                            </span>
                            <span
                              className="num"
                              style={{
                                fontFamily: "JetBrains Mono, monospace",
                                color: "var(--ink-3)",
                                flexShrink: 0,
                                marginLeft: 8,
                              }}
                            >
                              {h.weight.toFixed(2)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

        {/* ── Sector Overlap Chart (recharts, untouched) ── */}
        {sectorOverlapData.length > 0 && (
          <>
            <div className="pf-sec-h">
              <span className="n">SECTORS</span>
              <h3>
                Sector <span className="ser">overlap.</span>
              </h3>
              <span className="rule" />
            </div>
            <div className="pf-card" style={{ padding: 16, marginBottom: 18 }}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "4px 16px",
                  marginBottom: 12,
                }}
              >
                {funds.map((f, i) => (
                  <div
                    key={f.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 99,
                        background: FUND_COLORS[i],
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: "var(--ink-3)" }}>
                      {fundLabel(f, 22)}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ height: 330 }}>
                <SectorOverlapChart
                  data={sectorOverlapData}
                  series={funds.map((f, i) => ({
                    key: `fund${i}`,
                    name: fundLabel(f, 22),
                    color: FUND_COLORS[i],
                  }))}
                />
              </div>
            </div>
          </>
        )}

        {/* ── Sage take (design CompareScreen tilt card) ── */}
        {hasCompositions && (
          <div
            className="pf-card tilt-r"
            style={{
              padding: 18,
              marginBottom: 18,
              background: "var(--paper-2)",
            }}
          >
            <div className="ttl">
              <Sparkles
                size={11}
                style={{ display: "inline", marginRight: 6, verticalAlign: -1 }}
              />
              SAGE TAKE · /peer
            </div>
            <div
              style={{
                marginTop: 8,
                fontFamily: "Instrument Serif, serif",
                fontStyle: "italic",
                fontSize: 16,
                color: "var(--ink-2)",
                lineHeight: 1.4,
              }}
            >
              {funds.length} funds lined up. Common holdings, unique positions
              and sector tilts are tabled above — compare returns net of expense
              ratio before you decide.
            </div>
          </div>
        )}

        {/* ── Analyse Holdings Button ── */}
        {!hasCompositions && funds.length > 0 && !isAnalysing && (
          <div
            className="pf-card"
            style={{
              padding: "28px 18px",
              textAlign: "center",
              marginBottom: 18,
            }}
          >
            <FlaskConical
              style={{
                width: 36,
                height: 36,
                color: "var(--ink-3)",
                margin: "0 auto 12px",
              }}
            />
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--ink)",
                marginBottom: 4,
              }}
            >
              Unlock deeper comparison insights
            </div>
            <p
              style={{
                fontSize: 13,
                color: "var(--ink-3)",
                maxWidth: 420,
                margin: "0 auto 16px",
              }}
            >
              AI will extract portfolio holdings for each fund to find common
              stocks, unique positions, and sector overlap.
            </p>
            <button
              type="button"
              className="pf-bs"
              onClick={() => void runAnalyse()}
            >
              <FlaskConical size={13} /> Analyse all holdings
            </button>
          </div>
        )}

        {/* ── Analysing Progress ── */}
        {isAnalysing && (
          <div
            className="pf-card"
            style={{ padding: "28px 18px", marginBottom: 18 }}
          >
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <Loader2
                style={{
                  width: 28,
                  height: 28,
                  color: "var(--emerald)",
                  margin: "0 auto 12px",
                  animation: "um-spin .9s linear infinite",
                }}
              />
              <div
                style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}
              >
                Analysing fund portfolios with AI…
              </div>
              <div
                style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}
              >
                This may take up to 60 seconds per fund
              </div>
            </div>
            <div
              style={{
                maxWidth: 440,
                margin: "0 auto",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {funds.map((f, i) => {
                const key = `${f.fundType}:${f.id}`;
                const status = analyseProgress[key] ?? "pending";
                return (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontSize: 13,
                    }}
                  >
                    {status === "pending" && (
                      <div
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 99,
                          border: "2px solid var(--rule-soft)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {status === "loading" && (
                      <Loader2
                        style={{
                          width: 16,
                          height: 16,
                          color: "var(--emerald)",
                          flexShrink: 0,
                          animation: "um-spin .9s linear infinite",
                        }}
                      />
                    )}
                    {status === "done" && (
                      <CheckCircle2
                        style={{
                          width: 16,
                          height: 16,
                          color: "var(--emerald)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {status === "error" && (
                      <AlertCircle
                        style={{
                          width: 16,
                          height: 16,
                          color: "var(--pop-1)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        background: FUND_COLORS[i],
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        color:
                          status === "done" ? "var(--ink)" : "var(--ink-3)",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fundLabel(f, 30)}
                    </span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 11,
                        color: "var(--ink-3)",
                        flexShrink: 0,
                      }}
                    >
                      {status === "loading"
                        ? "Extracting…"
                        : status === "done"
                          ? "Done"
                          : status === "error"
                            ? "Failed"
                            : "Waiting"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Analyse Error ── */}
        {analyseError && !isAnalysing && (
          <div
            className="pf-card"
            style={{
              padding: "14px 18px",
              textAlign: "center",
              marginBottom: 18,
              borderColor: "var(--pop-1)",
            }}
          >
            <p style={{ fontSize: 13, color: "var(--pop-1)" }}>
              {analyseError}
            </p>
          </div>
        )}

        {/* Spinner keyframes (shared util in Terminal Luxe CSS, declared here
            defensively so the Analyse loader animates regardless of mount). */}
        <style>{`@keyframes um-spin { to { transform: rotate(360deg); } }`}</style>
      </TerminalLuxeShell>
    </PageGuard>
  );
}

// ============== SUBCOMPONENTS ==============

function MetricRow({
  label,
  values,
  rawValues,
  highlightBest = false,
  lowerIsBetter = false,
}: {
  label: string;
  values: string[];
  rawValues?: (number | null)[];
  highlightBest?: boolean;
  lowerIsBetter?: boolean;
}) {
  return (
    <tr>
      <td style={{ paddingLeft: 18, fontWeight: 700 }}>{label}</td>
      {values.map((v, i) => {
        const best =
          highlightBest && rawValues && isBest(rawValues, i, !lowerIsBetter);
        return (
          <td
            key={`${label}-${i}`}
            className={`num ${best ? "pos" : ""}`}
            style={{
              textAlign: "right",
              fontWeight: best ? 700 : undefined,
            }}
          >
            {v}
          </td>
        );
      })}
    </tr>
  );
}
