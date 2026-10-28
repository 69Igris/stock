"use client";

import type { ComparisonBlock } from "@usemoney/types";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import "./chat-blocks.css";

interface ComparisonBlockRendererProps {
  block: ComparisonBlock;
}

/** Determine if the value at `index` is the "best" per highlight rule. */
function isBestValue(
  metric: ComparisonBlock["metrics"][0],
  index: number
): boolean {
  if (!metric.highlight || metric.values.length < 2) return false;
  const nums = metric.values.map((v) => parseFloat(v.replace(/[^0-9.-]/g, "")));
  if (nums.some(isNaN)) return false;
  const target =
    metric.highlight === "higher" ? Math.max(...nums) : Math.min(...nums);
  return nums[index] === target;
}

export default function ComparisonBlockRenderer({
  block,
}: ComparisonBlockRendererProps) {
  const n = block.items.length;
  // Grid: [metric-label] + N value columns
  const colTemplate = `150px ${Array(n).fill("1fr").join(" ")}`;

  return (
    <div className="cb-card" style={{ padding: 16, margin: "6px 0" }}>
      {/* Block title */}
      {block.title && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <span className="cb-label" style={{ flex: "1 1 auto" }}>
            {block.title}
          </span>
        </div>
      )}

      {/* Responsive grid — wraps naturally, table only scrolls */}
      <div className="cb-table-scroll">
        {/* Header: blank label cell + name chips */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: colTemplate,
            gap: 8,
            marginBottom: 10,
            minWidth: `${150 + n * 120}px`,
          }}
        >
          {/* empty label column header */}
          <div />
          {block.items.map((item, i) => (
            <div key={i} className="cb-vs-name-chip">
              <div className="ticker">{item.name}</div>
              {item.subtitle && (
                <div className="sub">
                  {stripRecommendationLanguage(item.subtitle)}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Metric rows */}
        {block.metrics.map((metric, mIndex) => (
          <div
            key={mIndex}
            style={{
              display: "grid",
              gridTemplateColumns: colTemplate,
              gap: 8,
              padding: "6px 0",
              borderBottom:
                mIndex < block.metrics.length - 1
                  ? "1px dashed var(--rule-soft)"
                  : "none",
              alignItems: "center",
              minWidth: `${150 + n * 120}px`,
            }}
          >
            {/* Label */}
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.8,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                paddingRight: 8,
              }}
            >
              {metric.label}
            </div>
            {/* Values */}
            {metric.values.map((value, vIndex) => (
              <div
                key={vIndex}
                className={`cb-vs-metric-val${isBestValue(metric, vIndex) ? " best" : ""}`}
              >
                {value}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
