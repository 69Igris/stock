"use client";

import { formatLakhs, type ProjectionData } from "../lib/types";

interface IndianContextCardProps {
  annualExpToday: number;
  projection: ProjectionData[];
  currentAge: number;
}

const FIRE_TIERS = [
  {
    name: "Coast FIRE",
    mult: 12.5,
    desc: "Stop investing — corpus grows itself.",
    tone: "var(--pop-3)",
  },
  {
    name: "Lean FIRE",
    mult: 20,
    desc: "Tight retirement, controlled expenses.",
    tone: "var(--emerald)",
  },
  {
    name: "Regular FIRE",
    mult: 25,
    desc: "Standard 4% rule, comfortable.",
    tone: "var(--pop-5)",
  },
  {
    name: "Fat FIRE",
    mult: 35,
    desc: "Premium lifestyle, healthcare buffer.",
    tone: "var(--pop-2)",
  },
] as const;

export function IndianContextCard({
  annualExpToday,
  projection,
  currentAge,
}: IndianContextCardProps) {
  return (
    <>
      <div className="pf-sec-h" style={{ marginTop: 0 }}>
        <span className="n">03 · MILESTONES</span>
        <h3>
          <span className="ser">Indian retail</span> context.
        </h3>
        <span className="rule hidden sm:block" />
      </div>

      <div
        className="pf-fire-milestones-grid"
        data-walkthrough="fire-milestones"
      >
        {FIRE_TIERS.map((m) => {
          const target = annualExpToday * m.mult;
          const idx = projection.findIndex((p) => p.corpus >= target);
          const hitAge = idx < 0 ? null : projection[idx].age;
          return (
            <div
              key={m.name}
              className="pf-card"
              style={{ padding: 14, borderLeft: `3px solid ${m.tone}` }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  marginBottom: 4,
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 13 }}>{m.name}</span>
                <span
                  className="mono"
                  style={{ fontSize: 10, color: m.tone, fontWeight: 700 }}
                >
                  {m.mult}×
                </span>
              </div>
              <div
                className="mono"
                style={{ fontSize: 16, fontWeight: 700, color: m.tone }}
              >
                {formatLakhs(target)}
              </div>
              <div
                className="mono"
                style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 4 }}
              >
                {hitAge !== null
                  ? `Hit at age ${hitAge} · in ${hitAge - currentAge}y`
                  : "Out of timeline"}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginTop: 6,
                  lineHeight: 1.45,
                }}
              >
                {m.desc}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
