"use client";

import { CorpusChartRecharts } from "./CorpusChartRecharts";
import type { OneTimeExpense, ProjectionData } from "../lib/types";

interface ProjectionChartCardProps {
  projection: ProjectionData[];
  retirementAge: number;
  oneTimeExpenses: OneTimeExpense[];
  fireNumAtRetire: number;
  currentAge: number;
  lifeExpectancy: number;
  weightedReturn: number;
}

export function ProjectionChartCard({
  projection,
  retirementAge,
  oneTimeExpenses,
  fireNumAtRetire,
  currentAge,
  lifeExpectancy,
  weightedReturn,
}: ProjectionChartCardProps) {
  return (
    <>
      {/* 02 · TUNE — Corpus projection chart */}
      <div className="pf-sec-h" style={{ marginTop: 0 }}>
        <span className="n">02 · TUNE</span>
        <h3>Drag the knobs.</h3>
        <span className="rule hidden sm:block" />
        <span className="meta">changes apply live</span>
      </div>

      <div
        className="pf-card"
        style={{ padding: 0, overflow: "hidden" }}
        data-walkthrough="fire-projection-chart"
      >
        <div
          style={{
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1.5px solid var(--rule-soft)",
            flexWrap: "wrap",
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1.2,
              color: "var(--ink-3)",
              textTransform: "uppercase",
            }}
          >
            CORPUS PROJECTION
          </div>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            · Age {currentAge} → {lifeExpectancy}
          </span>
          <span className="pf-pill emerald" style={{ marginLeft: "auto" }}>
            {weightedReturn.toFixed(1)}% weighted return
          </span>
        </div>
        <div style={{ padding: 16, height: 280 }}>
          <CorpusChartRecharts
            data={projection}
            retireAge={retirementAge}
            oneTimes={oneTimeExpenses}
            fireNumberAtRetire={fireNumAtRetire}
          />
        </div>
      </div>
    </>
  );
}
