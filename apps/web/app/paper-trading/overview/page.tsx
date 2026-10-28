"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Eye, X } from "lucide-react";
import {
  getPaperDashboardStatsAction,
  getPaperPositionsAction,
  closePaperPositionAction,
} from "@/lib/actions/paper";
import { getWatchlistsAction } from "@/lib/actions/watchlist";
import type { WatchlistData } from "@usemoney/services";

type DashboardStats = {
  portfolio: { id: string; initialCapital: number; cash: number };
  positions: {
    open: number;
    closed: number;
    totalInvested: number;
    totalCurrentValue: number;
    totalPnl: number;
    totalPnlPercentage: number;
    dayPnl: number;
  };
  performance: {
    winRate: number;
    totalTrades: number;
    winners: number;
    losers: number;
    avgWin: number;
    avgLoss: number;
    bestTrade: number;
    worstTrade: number;
  };
};

interface OpenPosition {
  id: string;
  symbol: string;
  name: string | null;
  assetType: string;
  side: string;
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  dayPnl: number;
  entryDate: Date;
}

interface ClosedPosition {
  id: string;
  realizedPnL: number | null;
  exitDate: Date | null;
}

function formatINR(n: number): string {
  if (!Number.isFinite(n)) return "₹0";
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)} Cr`;
  if (abs >= 100_000) return `₹${(n / 100_000).toFixed(2)} L`;
  if (abs >= 1_000) return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

function formatExact(n: number): string {
  if (!Number.isFinite(n)) return "₹0.00";
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Build SVG area + line paths from a numeric series, normalised to 0..600 x
// 20..180 y (inverted, since SVG y grows downward). Mirrors the dashboard
// equity-curve idiom — no fake data, returns empty when < 2 points.
function buildAreaPath(series: number[]): { line: string; area: string } {
  if (series.length < 2) return { line: "", area: "" };
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const stepX = 600 / (series.length - 1);
  const pts = series.map((v, i) => {
    const x = Math.round(i * stepX);
    const y = Math.round(180 - ((v - min) / range) * 160);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`)
    .join(" ");
  const area = `${line} L600,200 L0,200 Z`;
  return { line, area };
}

export default function PaperTradingOverviewPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [positions, setPositions] = useState<OpenPosition[]>([]);
  const [closed, setClosed] = useState<ClosedPosition[]>([]);
  const [watchlists, setWatchlists] = useState<WatchlistData[]>([]);
  const [activeWatchlistId, setActiveWatchlistId] = useState<string | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [closingId, setClosingId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [statsRes, posRes, closedRes, wlRes] = await Promise.all([
        getPaperDashboardStatsAction(),
        getPaperPositionsAction({ status: "OPEN" }),
        getPaperPositionsAction({ status: "CLOSED" }),
        getWatchlistsAction(),
      ]);
      if (statsRes?.success && statsRes?.data) setStats(statsRes.data);
      if (posRes?.success && posRes?.data)
        setPositions(posRes.data.positions as unknown as OpenPosition[]);
      if (closedRes?.success && closedRes?.data)
        setClosed(closedRes.data.positions as unknown as ClosedPosition[]);
      if (wlRes?.success && wlRes?.data) {
        setWatchlists(wlRes.data);
        if (wlRes.data.length > 0 && !activeWatchlistId) {
          setActiveWatchlistId(wlRes.data[0].id);
        }
      }
    } catch {
      toast.error("Failed to load dashboard");
    } finally {
      setIsLoading(false);
    }
  }, [activeWatchlistId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleClosePosition = async (p: OpenPosition) => {
    setClosingId(p.id);
    try {
      const result = await closePaperPositionAction(p.id, p.currentPrice);
      if (result?.success) {
        toast.success("Position closed");
        loadAll();
      } else {
        toast.error(result?.error || "Failed to close position");
      }
    } catch {
      toast.error("Failed to close position");
    } finally {
      setClosingId(null);
    }
  };

  const portfolio = stats?.portfolio;
  const pos = stats?.positions;
  const perf = stats?.performance;

  const virtualBalance = portfolio
    ? portfolio.cash + (pos?.totalCurrentValue ?? 0)
    : 0;
  const totalPnlPct = pos?.totalPnlPercentage ?? 0;
  const dayPnl = pos?.dayPnl ?? 0;
  const dayPnlPct =
    pos?.totalInvested && pos.totalInvested > 0
      ? (dayPnl / pos.totalInvested) * 100
      : 0;
  const winRate = perf?.winRate ?? 0;

  // Win/loss distribution counts (real, from performance aggregates).
  const winners = perf?.winners ?? 0;
  const losers = perf?.losers ?? 0;
  const totalTrades = perf?.totalTrades ?? 0;
  const breakeven = Math.max(totalTrades - winners - losers, 0);
  const maxDist = Math.max(winners, losers, breakeven, 1);
  const avgWin = perf?.avgWin ?? 0;
  const avgLoss = perf?.avgLoss ?? 0;

  // Equity curve from cumulative realised P&L of closed trades (chronological).
  // Seeded with initial capital so the curve reads as an account value.
  const equitySeries = useMemo(() => {
    if (!portfolio) return [] as number[];
    const ordered = [...closed]
      .filter((c) => c.exitDate != null)
      .sort(
        (a, b) =>
          new Date(a.exitDate as Date).getTime() -
          new Date(b.exitDate as Date).getTime()
      );
    let running = portfolio.initialCapital;
    const series = [running];
    for (const c of ordered) {
      running += c.realizedPnL ?? 0;
      series.push(running);
    }
    return series;
  }, [closed, portfolio]);

  const equityPath = useMemo(() => buildAreaPath(equitySeries), [equitySeries]);

  const activeWatchlist = watchlists.find((w) => w.id === activeWatchlistId);

  return (
    <div className="pf-app">
      {/* Stat strip — virtual balance / open positions / day P&L / win rate */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 18,
        }}
        data-walkthrough="paper-overview-kpis"
      >
        <div
          className="pf-card pf-stat flat"
          style={{
            background: "var(--emerald-bg)",
            borderColor: "var(--emerald)",
          }}
        >
          <div className="l">VIRTUAL BALANCE</div>
          <div className="v" style={{ fontSize: 22 }}>
            {isLoading ? "—" : formatINR(virtualBalance)}
          </div>
          {!isLoading && (
            <div className={`d ${totalPnlPct >= 0 ? "pos" : "neg"}`}>
              {(totalPnlPct >= 0 ? "+" : "") + totalPnlPct.toFixed(2)}%
            </div>
          )}
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">OPEN POSITIONS</div>
          <div className="v" style={{ fontSize: 22 }}>
            {isLoading ? "—" : String(pos?.open ?? 0)}
          </div>
          {!isLoading && (
            <div className="d" style={{ color: "var(--ink-3)" }}>
              {formatINR(pos?.totalInvested ?? 0)} invested
            </div>
          )}
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">DAY&apos;S P/L</div>
          <div
            className="v"
            style={{
              fontSize: 22,
              color: isLoading
                ? "var(--ink)"
                : dayPnl >= 0
                  ? "var(--emerald-text)"
                  : "#b91c1c",
            }}
          >
            {isLoading ? "—" : `${dayPnl >= 0 ? "+" : ""}${formatINR(dayPnl)}`}
          </div>
          {!isLoading && (
            <div className={`d ${dayPnl >= 0 ? "pos" : "neg"}`}>
              {(dayPnlPct >= 0 ? "+" : "") + dayPnlPct.toFixed(2)}%
            </div>
          )}
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">WIN RATE</div>
          <div className="v" style={{ fontSize: 22 }}>
            {isLoading ? "—" : `${winRate.toFixed(1)}%`}
          </div>
          {!isLoading && (
            <div className="d" style={{ color: "var(--ink-3)" }}>
              {winners}W / {losers}L
            </div>
          )}
        </div>
      </div>

      {/* Equity curve + win/loss distribution */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 18,
          marginBottom: 18,
        }}
        className="pf-overview-charts"
      >
        <div className="pf-card" style={{ padding: 20 }}>
          <div className="ttl">EQUITY CURVE · REALISED</div>
          {equityPath.line ? (
            <svg
              viewBox="0 0 600 200"
              width="100%"
              preserveAspectRatio="none"
              style={{ height: 220, display: "block", marginTop: 10 }}
            >
              <defs>
                <linearGradient id="poec" x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--emerald)"
                    stopOpacity="0.35"
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--emerald)"
                    stopOpacity="0"
                  />
                </linearGradient>
              </defs>
              {[40, 80, 120, 160].map((y) => (
                <line
                  key={y}
                  x1="0"
                  y1={y}
                  x2="600"
                  y2={y}
                  stroke="var(--rule-soft)"
                  strokeWidth="1"
                  strokeDasharray="3 4"
                />
              ))}
              <path d={equityPath.area} fill="url(#poec)" />
              <path
                d={equityPath.line}
                fill="none"
                stroke="var(--emerald)"
                strokeWidth="2"
              />
            </svg>
          ) : (
            <div
              style={{
                height: 220,
                marginTop: 10,
                display: "grid",
                placeItems: "center",
                color: "var(--ink-3)",
                fontSize: 13,
                textAlign: "center",
              }}
            >
              {isLoading
                ? "Loading equity curve…"
                : "Close a few trades to plot your realised equity curve."}
            </div>
          )}
        </div>
        <div className="pf-card" style={{ padding: 0 }}>
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1.5px dashed var(--rule-soft)",
            }}
          >
            <div className="ttl">WIN / LOSS DISTRIBUTION</div>
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 800 }}>
              {isLoading
                ? "—"
                : totalTrades > 0
                  ? `${winRate.toFixed(1)}% wins · ${totalTrades} ${totalTrades === 1 ? "trade" : "trades"}`
                  : "No closed trades yet"}
            </div>
          </div>
          <div style={{ padding: 18 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(
                [
                  ["Wins", winners, "var(--emerald)"],
                  ["Losses", losers, "#b91c1c"],
                  ["Breakeven", breakeven, "var(--ink-3)"],
                ] as Array<[string, number, string]>
              ).map(([n, c, col]) => (
                <div
                  key={n}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                    {n}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 14,
                      background: "var(--rule-softer)",
                      border: "1.5px solid var(--ink)",
                      borderRadius: 99,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${(c / maxDist) * 100}%`,
                        height: "100%",
                        background: col,
                      }}
                    />
                  </div>
                  <span
                    className="num"
                    style={{ width: 30, textAlign: "right", fontWeight: 800 }}
                  >
                    {c}
                  </span>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: 18,
                paddingTop: 14,
                borderTop: "1px dashed var(--rule-soft)",
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <div>
                <div className="ttl">AVG WIN</div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 18,
                    fontWeight: 800,
                    color: "var(--emerald-text)",
                    fontFamily: "JetBrains Mono, monospace",
                  }}
                >
                  {avgWin > 0 ? `+${formatINR(avgWin)}` : "—"}
                </div>
              </div>
              <div>
                <div className="ttl">AVG LOSS</div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 18,
                    fontWeight: 800,
                    color: "#b91c1c",
                    fontFamily: "JetBrains Mono, monospace",
                  }}
                >
                  {avgLoss > 0 ? `-${formatINR(avgLoss)}` : "—"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Open positions + watchlist rail */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 360px",
          gap: 18,
        }}
        className="pf-overview-grid"
      >
        {/* Open positions table */}
        <div
          className="pf-card"
          data-walkthrough="paper-overview-positions"
          style={{ padding: 0, overflow: "hidden", minWidth: 0 }}
        >
          <div
            className="pf-sec-h"
            style={{ margin: "14px 18px 4px", flexWrap: "wrap" }}
          >
            <span className="n">OPEN POSITIONS</span>
            <h3>
              Live <span className="ser">P&amp;L.</span>
            </h3>
            <span className="rule" />
            <Link href="/paper-trading/terminal" className="pf-bs sm">
              + New trade
            </Link>
          </div>
          {isLoading ? (
            <div
              style={{
                padding: 36,
                textAlign: "center",
                color: "var(--ink-3)",
              }}
            >
              <Loader2
                className="h-4 w-4 animate-spin"
                style={{ display: "inline", marginRight: 8 }}
              />
              Loading positions…
            </div>
          ) : positions.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center" }}>
              <p
                style={{ fontSize: 14, color: "var(--ink-2)", marginBottom: 4 }}
              >
                No open positions
              </p>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--ink-3)",
                  marginBottom: 14,
                }}
              >
                Place your first virtual trade from the Terminal.
              </p>
              <Link
                href="/paper-trading/terminal"
                className="pf-bs sm"
                style={{ display: "inline-flex" }}
              >
                Go to Terminal →
              </Link>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="pf-tbl">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: 18 }}>SYM</th>
                    <th style={{ textAlign: "right" }}>QTY</th>
                    <th style={{ textAlign: "right" }}>AVG</th>
                    <th style={{ textAlign: "right" }}>LTP</th>
                    <th style={{ textAlign: "right" }}>P&amp;L</th>
                    <th style={{ textAlign: "right" }}>DAY P/L</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const isLong = p.side === "LONG" || p.side === "BUY";
                    return (
                      <tr key={p.id}>
                        <td style={{ paddingLeft: 18 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              flexWrap: "wrap",
                            }}
                          >
                            <span className="tk">{p.symbol}</span>
                            <span
                              className={`pf-pill ${isLong ? "emerald" : "coral"}`}
                              style={{ fontSize: 9 }}
                            >
                              {isLong ? "LONG" : "SHORT"}
                            </span>
                            <span
                              className="pf-pill outline"
                              style={{ fontSize: 9 }}
                            >
                              {p.assetType}
                            </span>
                          </div>
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {p.quantity}
                        </td>
                        <td
                          className="num"
                          style={{ textAlign: "right", color: "var(--ink-3)" }}
                        >
                          {formatExact(p.averagePrice)}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {formatExact(p.currentPrice)}
                        </td>
                        <td
                          className={`num ${p.unrealizedPnL >= 0 ? "pos" : "neg"}`}
                          style={{ textAlign: "right", fontWeight: 700 }}
                        >
                          {p.unrealizedPnL >= 0 ? "+" : ""}
                          {formatINR(p.unrealizedPnL)}
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--ink-3)",
                              fontWeight: 400,
                              marginTop: 2,
                            }}
                          >
                            {p.pnlPercentage >= 0 ? "+" : ""}
                            {p.pnlPercentage.toFixed(2)}%
                          </div>
                        </td>
                        <td
                          className={`num ${p.dayPnl >= 0 ? "pos" : "neg"}`}
                          style={{ textAlign: "right" }}
                        >
                          {p.dayPnl >= 0 ? "+" : ""}
                          {formatINR(p.dayPnl)}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <Link
                              href={`/${p.assetType.toLowerCase() === "mf" ? "mf" : "stocks"}/${p.symbol}`}
                              className="pf-bf sm"
                              style={{ padding: "4px 8px" }}
                              title="View instrument"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Link>
                            <button
                              onClick={() => handleClosePosition(p)}
                              disabled={closingId === p.id}
                              className="pf-bf sm danger"
                              style={{ padding: "4px 8px" }}
                              title="Close at LTP"
                            >
                              {closingId === p.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <X className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right rail — watchlists + live feeds */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
            minWidth: 0,
          }}
          data-walkthrough="paper-overview-watchlists"
        >
          <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1.5px dashed var(--rule-soft)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: watchlists.length > 0 ? 10 : 0,
                }}
              >
                <div className="ttl">WATCHLISTS</div>
                <Link
                  href="/watchlist"
                  className="hl-gold"
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    padding: "1px 6px",
                  }}
                >
                  MANAGE
                </Link>
              </div>
              {watchlists.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    overflowX: "auto",
                    paddingBottom: 2,
                  }}
                >
                  {watchlists.map((w) => {
                    const active = w.id === activeWatchlistId;
                    return (
                      <button
                        key={w.id}
                        onClick={() => setActiveWatchlistId(w.id)}
                        className={`pf-pill ${active ? "emerald" : "outline"}`}
                        style={{
                          whiteSpace: "nowrap",
                          fontSize: 10,
                          cursor: "pointer",
                        }}
                      >
                        {w.name}
                        {w.itemCount > 0 && (
                          <span style={{ opacity: 0.6 }}>{w.itemCount}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {isLoading ? (
              <div
                style={{
                  padding: 24,
                  textAlign: "center",
                  color: "var(--ink-3)",
                  fontSize: 12,
                }}
              >
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  style={{ display: "inline", marginRight: 8 }}
                />
                Loading…
              </div>
            ) : watchlists.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center" }}>
                <p
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-2)",
                    marginBottom: 4,
                  }}
                >
                  No watchlists yet
                </p>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    marginBottom: 12,
                  }}
                >
                  Create a watchlist to track your favourite symbols.
                </p>
                <Link
                  href="/watchlist"
                  className="pf-bs sm"
                  style={{ display: "inline-flex" }}
                >
                  + Create
                </Link>
              </div>
            ) : !activeWatchlist || activeWatchlist.items.length === 0 ? (
              <div
                style={{
                  padding: 28,
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--ink-3)",
                }}
              >
                This watchlist is empty.
              </div>
            ) : (
              <div>
                {activeWatchlist.items.slice(0, 12).map((it) => (
                  <Link
                    key={it.id}
                    href={`/${activeWatchlist.type === "MF" ? "mf" : "stocks"}/${it.symbol}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 18px",
                      borderBottom: "1px dashed var(--rule-soft)",
                      color: "var(--ink)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="tk" style={{ fontSize: 12.5 }}>
                        {it.symbol}
                      </div>
                      <div
                        style={{
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: 0.8,
                          color: "var(--ink-3)",
                          marginTop: 2,
                        }}
                      >
                        {it.exchange}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Live feeds card */}
          <div
            className="pf-card tilt-r"
            style={{ background: "var(--emerald-bg)" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--emerald)",
                  boxShadow: "0 0 6px #34d399",
                  animation: "um-pulse 1.6s infinite",
                }}
              />
              <span className="ttl" style={{ color: "var(--emerald-text)" }}>
                LIVE FEEDS
              </span>
            </div>
            <p
              style={{
                fontSize: 12,
                color: "var(--ink-2)",
                lineHeight: 1.55,
              }}
            >
              NSE &amp; BSE quotes update every 1s during market hours.
              Watchlist cards reflect last traded price; positions revalue every
              tick.
            </p>
            <Link
              href="/paper-trading/terminal"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: 12,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.4,
                color: "var(--emerald-text)",
              }}
            >
              Open terminal →
            </Link>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 1023px) {
          .pf-overview-charts,
          .pf-overview-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
