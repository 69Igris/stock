"use client";

import { Sparkline, autoTone } from "@/components/charts";

interface IndexCardProps {
  name: string;
  value: number;
  change: number;
  changePercent: number;
  sparklineData: number[];
}

/** Format a big number like "24,687.55" - Indian locale uses lakh/crore
 *  groupings which look weird for index values, so we use en-US here.
 *  Exported for unit tests (the visual-regression surface). */
export function formatIndexValue(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Signed delta like "+201.2" / "−116.3" - uses the Unicode minus for alignment. */
export function formatSignedChange(v: number): string {
  if (!Number.isFinite(v)) return "-";
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return v >= 0 ? `+${abs}` : `−${abs}`;
}

/** Signed percent like "+0.82%" / "−0.14%". */
export function formatPctChange(pct: number): string {
  if (!Number.isFinite(pct)) return "-";
  const abs = Math.abs(pct).toFixed(2);
  return pct >= 0 ? `+${abs}%` : `−${abs}%`;
}

export function IndexCard({
  name,
  value,
  change,
  changePercent,
  sparklineData,
}: IndexCardProps) {
  const isPos = changePercent >= 0;
  const hasSpark = sparklineData.length >= 2;
  // Playful skin (MONEY-485): paper card with a 1.5px ink rule, mono caps
  // label, big JetBrains value, emerald/coral signed change. Sparkline kept
  // (a real feature) but recolored to the playful emerald/coral tone.
  return (
    <div
      style={{
        padding: 14,
        background: "var(--paper)",
        border: "1.5px solid var(--ink)",
        borderRadius: 12,
      }}
    >
      {/* Label - small uppercase mono caps, dim. */}
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.2,
          fontWeight: 700,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          marginBottom: 6,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </div>
      {/* Big value */}
      <div
        className="mono"
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: "var(--ink)",
          lineHeight: 1.05,
        }}
      >
        {formatIndexValue(value)}
      </div>
      {/* Single-line change row: ▲/▼ + signed % + · + signed delta. */}
      <div
        className="mono"
        style={{
          fontSize: 12,
          fontWeight: 600,
          marginTop: 6,
          marginBottom: 10,
          color: isPos ? "var(--emerald-text)" : "#b91c1c",
        }}
      >
        {isPos ? "▲" : "▼"} {formatPctChange(changePercent)}
        <span style={{ color: "var(--ink-3)", margin: "0 6px" }}>·</span>
        {formatSignedChange(change)}
      </div>
      {hasSpark ? (
        <Sparkline
          data={sparklineData}
          tone={
            Number.isFinite(changePercent)
              ? isPos
                ? "pos"
                : "neg"
              : autoTone(sparklineData)
          }
          width={140}
          height={28}
          ariaLabel={`${name} 1-day trend`}
        />
      ) : (
        <div style={{ height: 28, display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: "100%",
              height: 1,
              background: "var(--rule-soft)",
            }}
          />
        </div>
      )}
    </div>
  );
}

export default IndexCard;
