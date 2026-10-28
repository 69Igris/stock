"use client";

/**
 * Fundamentals card for the stock-detail Overview tab (MONEY-796).
 *
 * Surfaces the daily-synced `StockRatios` row (which the page previously
 * ignored — Key Metrics were quote-only). Grouped into Valuation /
 * Profitability / Growth / Leverage / Market as a clean playful grid.
 *
 * Null-safe: any missing field is omitted; an entirely-empty group is
 * dropped; the whole card hides when there's no ratios row at all. Purely
 * descriptive DATA — no buy/sell/hold language anywhere.
 */

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import {
  getStockRatiosAction,
  type StockRatiosData,
} from "@/lib/actions/stock-tabs";
import { formatMarketCapCrores } from "@/app/stock/[symbol]/stock-format";

interface Props {
  symbol: string;
  exchange: string;
}

type Fmt = "x" | "pct" | "ratio" | "mcap" | "raw";

interface MetricDef {
  key: keyof StockRatiosData;
  label: string;
  fmt: Fmt;
}

interface GroupDef {
  title: string;
  metrics: MetricDef[];
}

// Grouped exactly as the ticket asks. Market-cap / EV use the page's shared
// ₹-scaler; ratios/multiples render with an "x" suffix; margins & growth & yield
// are percentages already (source stores them as percents).
const GROUPS: GroupDef[] = [
  {
    title: "Valuation",
    metrics: [
      { key: "pe", label: "P/E", fmt: "x" },
      { key: "pb", label: "P/B", fmt: "x" },
      { key: "evToEbitda", label: "EV / EBITDA", fmt: "x" },
      { key: "pegRatio", label: "PEG", fmt: "ratio" },
    ],
  },
  {
    title: "Profitability",
    metrics: [
      { key: "roe", label: "ROE", fmt: "pct" },
      { key: "roce", label: "ROCE", fmt: "pct" },
      { key: "roa", label: "ROA", fmt: "pct" },
      { key: "grossMargin", label: "Gross margin", fmt: "pct" },
      { key: "operatingMargin", label: "Op. margin", fmt: "pct" },
      { key: "netMargin", label: "Net margin", fmt: "pct" },
    ],
  },
  {
    title: "Growth",
    metrics: [
      { key: "revenueGrowth", label: "Revenue (YoY)", fmt: "pct" },
      { key: "earningsGrowth", label: "Earnings (YoY)", fmt: "pct" },
      { key: "revenueGrowth3Y", label: "Revenue (3Y)", fmt: "pct" },
      { key: "revenueGrowth5Y", label: "Revenue (5Y)", fmt: "pct" },
    ],
  },
  {
    title: "Leverage",
    metrics: [
      { key: "debtToEquity", label: "Debt / Equity", fmt: "ratio" },
      { key: "currentRatio", label: "Current ratio", fmt: "ratio" },
      { key: "interestCoverage", label: "Int. coverage", fmt: "x" },
    ],
  },
  {
    title: "Market",
    metrics: [
      { key: "beta", label: "Beta", fmt: "ratio" },
      { key: "dividendYield", label: "Div. yield", fmt: "pct" },
      { key: "marketCap", label: "Market cap", fmt: "mcap" },
      { key: "enterpriseValue", label: "Enterprise val.", fmt: "mcap" },
    ],
  },
];

function fmtValue(v: number | null, fmt: Fmt): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  switch (fmt) {
    case "x":
      return `${v.toFixed(1)}x`;
    case "pct":
      return `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(1)}%`;
    case "ratio":
      return v.toFixed(2);
    case "mcap":
      // CRORES, not rupees — `StockRatios.marketCap` / `.enterpriseValue` are
      // stored in crores (MONEY-1144). Using the rupees formatter here divided
      // by 1e7 a second time and rendered every mid-cap as "₹0 Cr".
      return formatMarketCapCrores(v);
    case "raw":
    default:
      return v.toFixed(2);
  }
}

export function StockFundamentalsCard({ symbol, exchange }: Props) {
  const [data, setData] = useState<StockRatiosData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStockRatiosAction(symbol, exchange)
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

  // Resolve groups → only those with at least one present value.
  const renderGroups = data
    ? GROUPS.map((g) => ({
        title: g.title,
        items: g.metrics
          .map((m) => ({
            label: m.label,
            value: fmtValue(data[m.key] as number | null, m.fmt),
          }))
          .filter((it): it is { label: string; value: string } =>
            Boolean(it.value)
          ),
      })).filter((g) => g.items.length > 0)
    : [];

  // Whole card is suppressed when there's no data at all — keeps the Overview
  // tidy for instruments without a synced ratios row.
  if (!loading && renderGroups.length === 0) return null;

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
        <Gauge size={15} style={{ color: "var(--emerald)" }} aria-hidden />
        <h3
          style={{
            fontSize: 19,
            fontWeight: 800,
            letterSpacing: -0.5,
            color: "var(--ink)",
          }}
        >
          Fundamentals
        </h3>
        {/*
          MONEY-1144 — the upstream vendor name (TICKERTAPE) used to render as
          a pill here. We do not name our data vendors in the product surface.
          `data.source` is still returned by the action and still stored on the
          row: it is real provenance and is used for debugging and for deciding
          the delayed-data notice, so this is a presentation change only, not a
          data one. Do not re-add it by reaching for `data.source` again.
        */}
      </div>
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10,
          color: "var(--ink-3)",
          marginBottom: 14,
        }}
      >
        Daily-synced ratios · descriptive data only
      </div>

      {loading && renderGroups.length === 0 ? (
        <FundamentalsSkeleton />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
          }}
        >
          {renderGroups.map((g) => (
            <div key={g.title}>
              <div
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 10,
                  letterSpacing: 1,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                  marginBottom: 8,
                }}
              >
                {g.title}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {g.items.map((it) => (
                  <div
                    key={it.label}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "6px 8px",
                      background: "var(--rule-softer)",
                      borderRadius: 7,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12.5,
                        color: "var(--ink-3)",
                      }}
                    >
                      {it.label}
                    </span>
                    <span
                      style={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: "var(--ink)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {it.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FundamentalsSkeleton() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 14,
      }}
    >
      {[0, 1, 2].map((g) => (
        <div key={g}>
          <div
            className="animate-pulse"
            style={{
              height: 10,
              width: 80,
              background: "var(--rule-soft)",
              borderRadius: 4,
              marginBottom: 10,
            }}
          />
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
  );
}

export default StockFundamentalsCard;
