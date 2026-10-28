"use client";

import { Check, AlertTriangle } from "lucide-react";
import { formatLakhs, type ProjectionData } from "../lib/types";

interface SnapshotCardsProps {
  fireNumber: number;
  swrFireNumber: number;
  withdrawalRate: number;
  firstShortfallAge: number | null;
  projection: ProjectionData[];
  retirementAge: number;
  corpusAtRetire: number;
  surplus: number;
  yearsToFire: number;
  currentAge: number;
  sustainableMonthly: number;
  weightedReturn: number;
  taxRate: number;
  statusOk: boolean;
  fireAchieved: boolean;
}

/**
 * Tiny real corpus-trajectory sparkline for the Years-to-FIRE card (replaces the
 * old design placeholder). Stretches to fill width; a non-scaling stroke keeps
 * the line crisp despite the non-uniform scale.
 */
function MiniCorpusSparkline({ data }: { data: ProjectionData[] }) {
  if (data.length < 2) return null;
  const W = 120;
  const H = 40;
  const P = 3;
  const corpuses = data.map((d) => d.corpus);
  const min = Math.min(...corpuses);
  const span = Math.max(...corpuses) - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * W;
  const y = (v: number) => P + (H - 2 * P) * (1 - (v - min) / span);
  const line = data
    .map(
      (d, i) =>
        `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.corpus).toFixed(1)}`
    )
    .join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: "100%", display: "block", minHeight: 40 }}
      aria-hidden="true"
    >
      <path d={area} fill="var(--emerald)" opacity={0.12} />
      <path
        d={line}
        fill="none"
        stroke="var(--emerald)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function SnapshotCards({
  fireNumber,
  swrFireNumber,
  withdrawalRate,
  firstShortfallAge,
  projection,
  retirementAge,
  corpusAtRetire,
  surplus,
  yearsToFire,
  currentAge,
  sustainableMonthly,
  weightedReturn,
  taxRate,
  statusOk,
  fireAchieved,
}: SnapshotCardsProps) {
  return (
    <>
      {/* ── 01 · SNAPSHOT — hero stat row ── */}
      <div className="pf-sec-h" style={{ marginTop: 0 }}>
        <span className="n">01 · SNAPSHOT</span>
        <h3>
          Your FIRE <span className="ser">number.</span>
        </h3>
        <span className="rule hidden sm:block" />
        <span className="meta">live calc</span>
      </div>

      {/* ── FIRE number card + 3 stat tiles ── */}
      <div className="pf-fire-stat-grid" style={{ marginBottom: 18 }}>
        {/* Main FIRE card */}
        {/* Pinned dark in BOTH themes (var(--ink) flips cream in dark
                mode, which drowned the gold number and made the cream serif
                line below invisible). */}
        <div
          className="pf-card"
          style={{
            background: "var(--code-bg)",
            color: "var(--code-fg)",
            padding: 22,
            gridColumn: "span 1",
          }}
        >
          <div
            className="ttl"
            style={{ color: "var(--code-dim)", marginBottom: 8 }}
          >
            YOUR FIRE NUMBER
          </div>
          <div
            className="mono"
            style={{
              fontSize: 48,
              fontWeight: 800,
              letterSpacing: -2,
              lineHeight: 0.9,
              color: "var(--pop-2)",
            }}
          >
            {formatLakhs(fireNumber)}
          </div>
          <div
            className="ser"
            style={{
              fontSize: 14,
              color: "rgba(244,237,224,.7)",
              marginTop: 8,
            }}
          >
            at{" "}
            <strong
              style={{
                fontFamily: "Inter, sans-serif",
                fontStyle: "normal",
                fontWeight: 700,
                color: "var(--pop-2)",
              }}
            >
              {retirementAge} years
            </strong>{" "}
            retirement
          </div>
          {/* Perpetual (safe-withdrawal-rate) comparison number */}
          <div
            className="mono"
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1.5px solid var(--rule-soft)",
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              fontSize: 12,
              color: "var(--code-dim)",
            }}
          >
            <span>Perpetual · {withdrawalRate}% rule</span>
            <strong style={{ color: "rgba(244,237,224,.85)", fontWeight: 700 }}>
              {formatLakhs(swrFireNumber)}
            </strong>
          </div>
          {firstShortfallAge != null && (
            <div
              className="mono"
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "var(--pop-2)",
              }}
            >
              <AlertTriangle className="h-3 w-3" />
              Spending exceeds {withdrawalRate}% draw at age {firstShortfallAge}
            </div>
          )}
          {/* Progress bar */}
          <div
            style={{
              marginTop: 14,
              height: 7,
              background: "rgba(244,237,224,.1)",
              borderRadius: 999,
              overflow: "hidden",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <div
              style={{
                width: `${Math.min((corpusAtRetire / (fireNumber || 1)) * 100, 100)}%`,
                height: "100%",
                background: "var(--emerald)",
              }}
            />
          </div>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              className="pf-pill"
              style={{
                background: statusOk ? "var(--emerald)" : "var(--pop-2)",
                color: statusOk ? "var(--paper)" : "#1d1d1b",
                borderColor: "transparent",
              }}
            >
              {statusOk ? (
                <Check className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {statusOk ? "ON TRACK" : !fireAchieved ? "BEHIND" : "OVERDRAWN"}
            </span>
          </div>
        </div>

        {/* Years to FIRE */}
        <div
          className="pf-card"
          style={{ padding: 18, display: "flex", flexDirection: "column" }}
        >
          <div className="ttl" style={{ marginBottom: 8 }}>
            YEARS TO FIRE
          </div>
          <div
            className="mono"
            style={{
              fontSize: 40,
              fontWeight: 800,
              letterSpacing: -2,
              lineHeight: 1,
            }}
          >
            {yearsToFire >= 999 || !Number.isFinite(yearsToFire)
              ? "∞"
              : `${yearsToFire}y`}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
            {yearsToFire >= 999
              ? "Adjust inputs"
              : `Target age ${currentAge + yearsToFire}`}
          </div>
          {/* Sparkline grows to fill the card; caption labels its start → end. */}
          <div style={{ flex: 1, minHeight: 44, marginTop: 12 }}>
            <MiniCorpusSparkline data={projection} />
          </div>
          {projection.length > 1 && (
            <div
              className="mono"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                fontSize: 11,
                color: "var(--ink-3)",
                marginTop: 8,
                paddingTop: 8,
                borderTop: "1px solid var(--rule-soft)",
              }}
            >
              <span>{formatLakhs(projection[0].corpus)} now</span>
              <span>
                <strong style={{ color: "var(--emerald)" }}>
                  {formatLakhs(corpusAtRetire)}
                </strong>{" "}
                at {retirementAge}
              </span>
            </div>
          )}
        </div>

        {/* Corpus at retire */}
        <div className="pf-card" style={{ padding: 18 }}>
          <div className="ttl" style={{ marginBottom: 8 }}>
            CORPUS @ RETIRE
          </div>
          <div
            className="mono"
            style={{
              fontSize: 32,
              fontWeight: 800,
              letterSpacing: -1.4,
              lineHeight: 1,
              color: fireAchieved ? "var(--emerald)" : "var(--pop-1)",
            }}
          >
            {formatLakhs(corpusAtRetire)}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              marginTop: 4,
              color: fireAchieved ? "var(--emerald)" : "var(--pop-1)",
            }}
          >
            {fireAchieved ? "+" : "−"}
            {formatLakhs(Math.abs(surplus))} vs FIRE number
          </div>
        </div>

        {/* Sustainable income */}
        <div className="pf-card" style={{ padding: 18 }}>
          <div className="ttl" style={{ marginBottom: 8 }}>
            SUSTAINABLE INCOME
          </div>
          <div
            className="mono"
            style={{
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: -1.2,
              lineHeight: 1,
            }}
          >
            {formatLakhs(sustainableMonthly)}/mo
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
            Weighted {weightedReturn.toFixed(1)}% · {taxRate}% tax
          </div>
        </div>
      </div>
    </>
  );
}
