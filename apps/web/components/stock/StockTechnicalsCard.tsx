"use client";

/**
 * Technicals card for the stock-detail Overview tab (MONEY-796 item 4).
 *
 * Renders the in-memory technical snapshot computed from `DailyPrice` via the
 * shared `computeIndicators` library: RSI(14) with a descriptive zone label,
 * SMA20/50/200 with price-vs-SMA position, MACD, and 52-week distance.
 *
 * SEBI-safe: every value is descriptive DATA. RSI "overbought/oversold" and
 * "golden/death cross" are textbook indicator labels describing the maths, not
 * advice — no buy/sell/hold language. Self-suppresses when there isn't enough
 * price history to compute anything.
 */

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import {
  getStockTechnicalsAction,
  type StockTechnicalsData,
} from "@/lib/actions/stock-tabs";
import {
  smaPosition,
  pctFromSma,
  rsiZone,
} from "@/lib/actions/stock-detail-logic";
import { formatNumber } from "@/app/stock/[symbol]/stock-format";

interface Props {
  symbol: string;
  exchange: string;
}

function fmtPx(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `₹${formatNumber(v)}`;
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}

const ZONE_LABEL: Record<string, string> = {
  overbought: "Overbought",
  oversold: "Oversold",
  neutral: "Neutral",
};

export function StockTechnicalsCard({ symbol, exchange }: Props) {
  const [data, setData] = useState<StockTechnicalsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStockTechnicalsAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) setData(r.data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  if (loading) return <TechnicalsSkeleton />;
  if (!data) return null;

  const price = data.price;
  const zone = rsiZone(data.rsi14);

  // SMA rows — descriptive position + % distance. Skip ones with no SMA.
  const smaRows: Array<{ label: string; sma: number | null }> = [
    { label: "SMA 20", sma: data.sma20 },
    { label: "SMA 50", sma: data.sma50 },
    { label: "SMA 200", sma: data.sma200 },
  ].filter((r) => r.sma != null);

  return (
    <div className="pf-card" style={{ padding: 18, marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Activity size={15} style={{ color: "var(--emerald)" }} aria-hidden />
        <h3
          style={{
            fontSize: 19,
            fontWeight: 800,
            letterSpacing: -0.5,
            color: "var(--ink)",
          }}
        >
          Technicals
        </h3>
        <span
          className="pf-pill outline"
          style={{ fontSize: 9.5, marginLeft: "auto" }}
        >
          {data.sampleSize}d
        </span>
      </div>
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10,
          color: "var(--ink-3)",
          marginBottom: 14,
        }}
      >
        Computed from daily closes · descriptive indicators only
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
        }}
      >
        {/* RSI */}
        {data.rsi14 != null && (
          <div>
            <div className="um-tech-grp">MOMENTUM</div>
            <div className="um-tech-row">
              <span className="um-tech-k">RSI (14)</span>
              <span className="um-tech-v">
                {data.rsi14.toFixed(1)}
                {zone && (
                  <span
                    className="pf-pill outline"
                    style={{ fontSize: 9, marginLeft: 6 }}
                  >
                    {ZONE_LABEL[zone]}
                  </span>
                )}
              </span>
            </div>
            {data.macd != null && (
              <div className="um-tech-row">
                <span className="um-tech-k">MACD</span>
                <span className="um-tech-v">{data.macd.toFixed(2)}</span>
              </div>
            )}
            {data.macdHistogram != null && (
              <div className="um-tech-row">
                <span className="um-tech-k">MACD hist.</span>
                <span className="um-tech-v">
                  {data.macdHistogram.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Moving averages */}
        {smaRows.length > 0 && (
          <div>
            <div className="um-tech-grp">MOVING AVERAGES</div>
            {smaRows.map((r) => {
              const pos = smaPosition(price, r.sma);
              const dist = pctFromSma(price, r.sma);
              return (
                <div key={r.label} className="um-tech-row">
                  <span className="um-tech-k">{r.label}</span>
                  <span className="um-tech-v">
                    {fmtPx(r.sma)}
                    {pos && pos !== "at" && dist != null && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 11,
                          fontWeight: 700,
                          color:
                            pos === "above" ? "var(--emerald)" : "var(--pop-1)",
                        }}
                      >
                        {pos === "above" ? "↑" : "↓"} {fmtPct(dist)}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            {(data.goldenCross || data.deathCross) && (
              <div className="um-tech-row">
                <span className="um-tech-k">50 vs 200</span>
                <span className="um-tech-v">
                  <span
                    className="pf-pill outline"
                    style={{ fontSize: 9 }}
                    title="SMA50 relative to SMA200 — a descriptive crossover label."
                  >
                    {data.goldenCross ? "Golden cross" : "Death cross"}
                  </span>
                </span>
              </div>
            )}
          </div>
        )}

        {/* 52-week context */}
        {(data.distanceFrom52WeekHigh != null ||
          data.distanceFrom52WeekLow != null) && (
          <div>
            <div className="um-tech-grp">52-WEEK RANGE</div>
            {data.price52WeekHigh != null && (
              <div className="um-tech-row">
                <span className="um-tech-k">52W high</span>
                <span className="um-tech-v">
                  {fmtPx(data.price52WeekHigh)}
                  {data.distanceFrom52WeekHigh != null && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--pop-1)",
                      }}
                    >
                      −{data.distanceFrom52WeekHigh.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            )}
            {data.price52WeekLow != null && (
              <div className="um-tech-row">
                <span className="um-tech-k">52W low</span>
                <span className="um-tech-v">
                  {fmtPx(data.price52WeekLow)}
                  {data.distanceFrom52WeekLow != null && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--emerald)",
                      }}
                    >
                      +{data.distanceFrom52WeekLow.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        .um-tech-grp {
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          letter-spacing: 1px;
          font-weight: 700;
          text-transform: uppercase;
          color: var(--ink-3);
          margin-bottom: 8px;
        }
        .um-tech-row {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 10px;
          padding: 6px 8px;
          background: var(--rule-softer);
          border-radius: 7px;
          margin-bottom: 6px;
        }
        .um-tech-k { font-size: 12.5px; color: var(--ink-3); }
        .um-tech-v {
          font-family: 'JetBrains Mono', monospace;
          font-size: 13.5px;
          font-weight: 700;
          color: var(--ink);
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
        }
      `}</style>
    </div>
  );
}

function TechnicalsSkeleton() {
  return (
    <div className="pf-card" style={{ padding: 18, marginBottom: 24 }}>
      <div
        className="animate-pulse"
        style={{
          height: 14,
          width: 120,
          background: "var(--rule-soft)",
          borderRadius: 4,
          marginBottom: 14,
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
        }}
      >
        {[0, 1, 2].map((g) => (
          <div key={g}>
            {[0, 1, 2].map((r) => (
              <div
                key={r}
                className="animate-pulse"
                style={{
                  height: 28,
                  background: "var(--rule-softer)",
                  borderRadius: 7,
                  marginBottom: 6,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default StockTechnicalsCard;
