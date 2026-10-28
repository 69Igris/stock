"use client";

import type { RoastSummaryBlock } from "@usemoney/types";
import Link from "next/link";
import { Flame, ChevronRight, TrendingUp, TrendingDown } from "lucide-react";
import RoastScoreGauge from "@/components/roast/RoastScoreGauge";
import "./chat-blocks.css";

interface RoastSummaryBlockRendererProps {
  block: RoastSummaryBlock;
}

function pnlLabel(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * MONEY-581: compact in-chat Portfolio Roast card. Replaces the old wall of
 * roast narrative text. Shows the score gauge + verdict headline + a couple of
 * highlights, with a "View full roast" link out to the rich /roast/[id] report.
 * All colours come from the playful (pf-*) token set so it stays theme-aware.
 */
export default function RoastSummaryBlockRenderer({
  block,
}: RoastSummaryBlockRendererProps) {
  const highlights = (block.highlights || []).slice(0, 3);
  const hasPerformers = !!(block.topPerformer || block.worstPerformer);

  return (
    <div
      className="cb-card"
      style={{
        padding: 14,
        margin: "6px 0",
        // Subtle coral (roast identity) wash + accent border-left.
        background: "color-mix(in srgb, var(--pop-1) 5%, var(--paper))",
        borderLeft: "3px solid var(--pop-1)",
      }}
    >
      {/* Header: score gauge + eyebrow/headline */}
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <div style={{ flexShrink: 0 }}>
          <RoastScoreGauge score={block.score} size="sm" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: "var(--pop-1-text)",
              marginBottom: 4,
            }}
          >
            <Flame style={{ width: 12, height: 12 }} />
            Portfolio Roast
          </div>
          <div
            style={{
              fontWeight: 800,
              fontSize: 14.5,
              lineHeight: 1.3,
              letterSpacing: "-0.2px",
              color: "var(--ink)",
            }}
          >
            {block.headline}
          </div>
        </div>
      </div>

      {/* Highlights — emoji + short title, coloured by praise/burn */}
      {highlights.length > 0 && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 7,
          }}
        >
          {highlights.map((h, i) => (
            <div
              key={i}
              style={{ display: "flex", gap: 7, alignItems: "flex-start" }}
            >
              <span style={{ fontSize: 13, lineHeight: "18px", flexShrink: 0 }}>
                {h.emoji}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  lineHeight: "18px",
                  fontWeight: 600,
                  color:
                    h.type === "praise"
                      ? "var(--emerald-text)"
                      : "var(--pop-1-text)",
                }}
              >
                {h.title}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Top / worst performer — compact one-liner */}
      {hasPerformers && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--rule-softer)",
          }}
        >
          {block.topPerformer && (
            <div
              style={{ display: "flex", alignItems: "center", gap: 5 }}
              title="Best performer"
            >
              <TrendingUp
                style={{ width: 13, height: 13, color: "var(--emerald-text)" }}
              />
              <span
                className="mono"
                style={{ fontSize: 11.5, fontWeight: 700 }}
              >
                {block.topPerformer.symbol}
              </span>
              <span
                className="mono"
                style={{ fontSize: 11.5, color: "var(--emerald-text)" }}
              >
                {pnlLabel(block.topPerformer.pnlPercent)}
              </span>
            </div>
          )}
          {block.worstPerformer && (
            <div
              style={{ display: "flex", alignItems: "center", gap: 5 }}
              title="Worst performer"
            >
              <TrendingDown
                style={{ width: 13, height: 13, color: "var(--pop-1-text)" }}
              />
              <span
                className="mono"
                style={{ fontSize: 11.5, fontWeight: 700 }}
              >
                {block.worstPerformer.symbol}
              </span>
              <span
                className="mono"
                style={{ fontSize: 11.5, color: "var(--pop-1-text)" }}
              >
                {pnlLabel(block.worstPerformer.pnlPercent)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* View full roast → /roast/[sessionId] */}
      <div style={{ marginTop: 12 }}>
        <Link
          href={`/roast/${block.sessionId}`}
          className="cb-nav-link primary"
        >
          <Flame style={{ width: 13, height: 13 }} />
          View full roast
          <ChevronRight style={{ width: 12, height: 12, opacity: 0.7 }} />
        </Link>
      </div>
    </div>
  );
}
