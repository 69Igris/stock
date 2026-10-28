"use client";

/**
 * NAV growth chart for the Fund detail page (MONEY-245, design Image #35).
 *
 * Visual:
 *   - Solid emerald fund line with subtle area-fill underneath
 *   - End-of-line price pill ("●₹90.08") on the right edge of the fund line
 *   - Right-aligned y-axis, no left axis
 *   - Hidden / very subtle grid
 *   - Period tabs: 1M / 3M / 6M / 1Y / 3Y / 5Y / ALL
 *   - Footer: "NAV updated {date} · Source AMFI"
 *
 * Data source: existing `/api/market/mf-historical?schemeCode=...&period=max`
 * endpoint that the old NAV chart already used. (MONEY-610: the synthesized
 * "benchmark" overlay was removed — it was a placeholder anchored to the fund's
 * own CAGR, NOT a real Nifty series. Re-add a benchmark line only when a real
 * TRI NAV-history feed is wired.)
 *
 * Playful re-skin: MONEY-489. All props / data-fetch / calculations preserved.
 * Theme-aware: CSS vars used for all colours. No single-theme hex values.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { PfLinePlaceholder } from "@/components/playful/placeholders";
import { SECTION_EMPTY_BODY } from "@/components/stock/SectionShell";
import type { NavGrowthChartCanvasProps } from "./NavGrowthChartCanvas";
import "./detail-playful.css";

/**
 * MONEY-290 — recharts is fetched only once a NAV series is on screen.
 *
 * The card chrome (price, delta, period tabs, AMFI footer) is plain DOM and
 * renders immediately; only the plotted canvas is behind the boundary.
 * `ssr: false` because <ResponsiveContainer> measures the DOM and renders
 * nothing server-side. The fallback fills its parent, and the parent
 * (.nav-chart-wrap) already carries the caller's fixed `height`, so the chart
 * swapping in causes no layout shift.
 */
const NavGrowthChartCanvas = dynamic<NavGrowthChartCanvasProps>(
  () => import("./NavGrowthChartCanvas"),
  {
    ssr: false,
    loading: () => (
      <div aria-hidden="true" style={{ width: "100%", height: "100%" }} />
    ),
  }
);

export type NavPeriod = "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y" | "ALL";

const PERIODS: ReadonlyArray<{ id: NavPeriod; months: number }> = [
  { id: "1M", months: 1 },
  { id: "3M", months: 3 },
  { id: "6M", months: 6 },
  { id: "1Y", months: 12 },
  { id: "3Y", months: 36 },
  { id: "5Y", months: 60 },
  { id: "ALL", months: 0 },
];

interface NavGrowthChartProps {
  schemeCode: string;
  /** Display name of the benchmark in the legend ("Nifty 50 TRI", "Nifty 500 TRI"). */
  benchmarkName?: string;
  /** Initial period to display. Defaults to "3Y" matching design. */
  initialPeriod?: NavPeriod;
  /** Height of the chart canvas (excluding period tabs + footer). */
  height?: number;
}

interface NavPoint {
  /** ISO date YYYY-MM-DD. */
  time: string;
  /** Fund NAV on this day. */
  nav: number;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function NavGrowthChart({
  schemeCode,
  initialPeriod = "3Y",
  height = 380,
}: NavGrowthChartProps) {
  const [period, setPeriod] = useState<NavPeriod>(initialPeriod);
  const [allPoints, setAllPoints] = useState<NavPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // Fetch full series once, slice client-side per period.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/market/mf-historical?schemeCode=${schemeCode}&period=max`)
      .then((r) => {
        if (!r.ok) throw new Error("NAV history unavailable");
        return r.json();
      })
      .then((res) => {
        if (cancelled) return;
        const raw: Array<{ date: string; nav: number }> = Array.isArray(
          res?.data
        )
          ? res.data
          : [];
        const points = raw
          .filter((p) => p && p.date && Number.isFinite(p.nav))
          .map((p) => ({ time: p.date, nav: p.nav }));
        if (points.length === 0) {
          // MONEY-1255 — a 200 with zero rows is EMPTY, not an error, and the
          // difference is visible: `error` wins the placeholder label outright
          // (so a reader saw bespoke copy where every other section shows the
          // shared body) and it suppresses the coverage tooltip below. Found
          // by `empty-state-copy.test.ts`'s retired-prose sweep, which is the
          // point of sweeping for the SENTENCE and not just for the markup.
          setAllPoints([]);
          return;
        }
        setAllPoints(points);
        setUpdatedAt(points[points.length - 1]!.time);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "NAV fetch failed");
        setAllPoints([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [schemeCode]);

  const visible = useMemo(() => {
    if (allPoints.length === 0) return [] as NavPoint[];
    if (period === "ALL") return allPoints;
    const months = PERIODS.find((p) => p.id === period)?.months ?? 36;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return allPoints.filter((p) => p.time >= cutoffStr);
  }, [allPoints, period]);

  const stats = useMemo(() => {
    if (visible.length === 0) return null;
    const start = visible[0]!.nav;
    const end = visible[visible.length - 1]!.nav;
    const totalPct = ((end - start) / start) * 100;
    return {
      current: end,
      totalPct,
      lastTime: visible[visible.length - 1]!.time,
    };
  }, [visible]);

  const yMin = useMemo(() => {
    if (visible.length === 0) return 0;
    const lo = Math.min(...visible.map((p) => p.nav));
    return Math.max(0, Math.floor(lo * 0.95));
  }, [visible]);

  const yMax = useMemo(() => {
    if (visible.length === 0) return 100;
    const hi = Math.max(...visible.map((p) => p.nav));
    return Math.ceil(hi * 1.04);
  }, [visible]);

  const isPositive = (stats?.totalPct ?? 0) >= 0;

  return (
    <div className="nav-card">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="nav-header">
        <div className="nav-title-block">
          <div className="nav-eyebrow">NAV GROWTH</div>
          <div className="nav-current-row">
            {stats && (
              <>
                <span className="nav-current-price">
                  ₹{stats.current.toFixed(2)}
                </span>
                <span
                  className={`nav-delta${isPositive ? " pos" : " neg"}`}
                  aria-label={`${isPositive ? "Up" : "Down"} ${Math.abs(stats.totalPct).toFixed(1)}%`}
                >
                  {isPositive ? "▲" : "▼"} {Math.abs(stats.totalPct).toFixed(1)}
                  %
                </span>
              </>
            )}
          </div>
        </div>

        {/* Period tabs — aligned right of header */}
        <div
          className="det-tab-strip nav-period-strip"
          role="tablist"
          aria-label="NAV period"
        >
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === period}
              className={`det-tab-btn${p.id === period ? " is-active" : ""}`}
              onClick={() => setPeriod(p.id)}
            >
              {p.id}
            </button>
          ))}
        </div>
      </div>

      {/* ── Chart region ─────────────────────────────────────────── */}
      <div className="nav-chart-wrap" style={{ height }}>
        {loading && visible.length === 0 ? (
          <PfLinePlaceholder
            height={height}
            loading
            label="NAV GROWTH · loading…"
          />
        ) : error || visible.length === 0 ? (
          // MONEY-1255 — one body for every empty section. `note` was a
          // VISIBLE second line, so the coverage caveat it carried moves to
          // `title`, which is the placeholder's tooltip. An ERROR still wins
          // the label outright: "No data available" would hide a failed read
          // behind a normal-looking empty state.
          <PfLinePlaceholder
            height={height}
            label={error ?? SECTION_EMPTY_BODY}
            title={
              error
                ? undefined
                : "NAV history appears here once the fund has a series we can read."
            }
          />
        ) : (
          <NavGrowthChartCanvas
            data={visible}
            yMin={yMin}
            yMax={yMax}
            marker={stats ? { time: stats.lastTime, nav: stats.current } : null}
          />
        )}
      </div>

      {/* ── Legend + AMFI footer ──────────────────────────────────── */}
      <div className="nav-footer-row">
        <div className="nav-legend">
          <span className="nav-legend-item">
            <span
              className="nav-legend-line"
              style={{ background: "var(--emerald)" }}
              aria-hidden="true"
            />
            This fund
          </span>
        </div>
        {updatedAt && (
          <span className="nav-amfi-note">
            NAV updated {formatDate(updatedAt)} · Source AMFI
          </span>
        )}
      </div>
    </div>
  );
}

export default NavGrowthChart;
