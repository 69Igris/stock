"use client";

import Link from "next/link";
import { formatCurrency } from "@usemoney/utils";

export interface MoverRow {
  symbol: string;
  exchange: string;
  name?: string;
  price: number;
  changePercent: number;
}

interface MoversColumnProps {
  title: string;
  rows: MoverRow[];
  /** "gain" tints the header + all change% values emerald; "loss" tints red. */
  tone: "gain" | "loss";
  /** When true, render a shimmer skeleton instead of the empty-state. We
   *  use this for the SSR-cold-cache case where rows is `[]` but data is
   *  still on its way. */
  loading?: boolean;
}

// Playful skin (MONEY-485): emerald for gainers, coral (#b91c1c light) for
// losers — matching the design's TopMovers widget header + rows.
const TONE_COLOR: Record<MoversColumnProps["tone"], string> = {
  gain: "var(--emerald-text)",
  loss: "#b91c1c",
};

export function MoversColumn({
  title,
  rows,
  tone,
  loading,
}: MoversColumnProps) {
  const toneColor = TONE_COLOR[tone];

  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div
        className="mono"
        style={{
          fontSize: 10.5,
          letterSpacing: 1.5,
          fontWeight: 700,
          textTransform: "uppercase",
          marginBottom: 10,
          color: toneColor,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span aria-hidden>●</span>
        {title}
      </div>
      {rows.length === 0 ? (
        loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 0",
                  borderBottom:
                    i < 7 ? "1px dashed var(--rule-soft)" : undefined,
                }}
              >
                <div
                  style={{
                    height: 10,
                    borderRadius: 4,
                    width: `${56 + ((i * 7) % 28)}px`,
                    background: "var(--rule-softer)",
                  }}
                  className="animate-pulse"
                />
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    height: 10,
                    width: 48,
                    borderRadius: 4,
                    background: "var(--rule-softer)",
                  }}
                  className="animate-pulse"
                />
                <div
                  style={{
                    height: 10,
                    width: 36,
                    borderRadius: 4,
                    background: "var(--rule-softer)",
                  }}
                  className="animate-pulse"
                />
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              fontSize: 13,
              color: "var(--ink-3)",
              padding: "24px 0",
              textAlign: "center",
            }}
          >
            No data yet
          </div>
        )
      ) : (
        rows.map((r, i) => (
          <Link
            key={`${r.symbol}:${r.exchange}`}
            href={`/stock/${r.symbol}?exchange=${r.exchange}`}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "8px 0",
              borderBottom:
                i < rows.length - 1 ? "1px dashed var(--rule-soft)" : undefined,
              textDecoration: "none",
            }}
            className="hover:opacity-90 transition-opacity"
          >
            <div
              className="mono"
              style={{
                fontWeight: 700,
                color: "var(--ink)",
                fontSize: 12.5,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.symbol}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 11.5,
                color: "var(--ink-3)",
                marginRight: 12,
              }}
            >
              {formatCurrency(r.price)}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12,
                fontWeight: 700,
                minWidth: 60,
                textAlign: "right",
                color: toneColor,
              }}
            >
              {r.changePercent >= 0 ? "+" : ""}
              {r.changePercent.toFixed(2)}%
            </div>
          </Link>
        ))
      )}
    </div>
  );
}

export default MoversColumn;
