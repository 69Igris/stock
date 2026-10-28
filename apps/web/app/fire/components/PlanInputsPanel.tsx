"use client";

import { SlidersHorizontal, RotateCcw } from "lucide-react";
import { PfFireSlider } from "./shared/PfFireSlider";
import { PfFireNumInput } from "./shared/PfFireNumInput";
import { formatLakhs } from "../lib/types";
import { FIRE_BOUNDS } from "../lib/bounds";

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 1.5,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  marginBottom: 10,
};

interface PlanInputsPanelProps {
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  savingsIncrement: number;
  withdrawalRate: number;
  taxRate: number;
  salaryIncrement: number;
  monthlyExpToday: number;
  weightedReturn: number;
  setCurrentAge: (v: number) => void;
  setRetirementAge: (v: number) => void;
  setLifeExpectancy: (v: number) => void;
  setCurrentCorpus: (v: number) => void;
  setMonthlySavings: (v: number) => void;
  setSavingsIncrement: (v: number) => void;
  setWithdrawalRate: (v: number) => void;
  setTaxRate: (v: number) => void;
  setSalaryIncrement: (v: number) => void;
  onReset: () => void;
}

export function PlanInputsPanel({
  currentAge,
  retirementAge,
  lifeExpectancy,
  currentCorpus,
  monthlySavings,
  savingsIncrement,
  withdrawalRate,
  taxRate,
  salaryIncrement,
  monthlyExpToday,
  weightedReturn,
  setCurrentAge,
  setRetirementAge,
  setLifeExpectancy,
  setCurrentCorpus,
  setMonthlySavings,
  setSavingsIncrement,
  setWithdrawalRate,
  setTaxRate,
  setSalaryIncrement,
  onReset,
}: PlanInputsPanelProps) {
  return (
    <div
      className="pf-card pf-fire-inputs-panel"
      style={{
        padding: 0,
        position: "sticky",
        top: 100,
        alignSelf: "flex-start",
      }}
      data-walkthrough="fire-life-inputs"
    >
      <div
        style={{
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderBottom: "1.5px solid var(--rule-soft)",
        }}
      >
        <SlidersHorizontal
          style={{ width: 14, height: 14, color: "var(--emerald)" }}
        />
        <span style={{ fontWeight: 700, fontSize: 14 }}>Plan inputs</span>
        <button
          type="button"
          onClick={onReset}
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: 0,
            cursor: "pointer",
            color: "var(--ink-3)",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
          className="mono"
        >
          <RotateCcw style={{ width: 11, height: 11 }} />
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8 }}>
            RESET
          </span>
        </button>
      </div>

      <div
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* You */}
        <div>
          <div className="mono" style={SECTION_LABEL}>
            YOU
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginBottom: 12,
            }}
            data-walkthrough="fire-life-inputs"
          >
            <PfFireNumInput
              label="Current age"
              value={currentAge}
              onChange={setCurrentAge}
              suffix="yrs"
            />
            <PfFireNumInput
              label="Retire by"
              value={retirementAge}
              onChange={setRetirementAge}
              suffix="yrs"
            />
          </div>
          <PfFireSlider
            label="Life expectancy"
            value={lifeExpectancy}
            onChange={setLifeExpectancy}
            min={FIRE_BOUNDS.lifeExpectancy.min}
            max={FIRE_BOUNDS.lifeExpectancy.max}
            suffix="y"
          />
        </div>

        {/* Money */}
        <div
          style={{ paddingTop: 14, borderTop: "1.5px solid var(--rule-soft)" }}
          data-walkthrough="fire-money-inputs"
        >
          <div className="mono" style={SECTION_LABEL}>
            MONEY
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <PfFireNumInput
              label="Current corpus"
              value={currentCorpus}
              onChange={setCurrentCorpus}
              prefix="₹"
              hint={`${formatLakhs(currentCorpus)} · across all investments`}
            />
            <PfFireNumInput
              label="Monthly savings"
              value={monthlySavings}
              onChange={setMonthlySavings}
              prefix="₹"
              hint={
                monthlyExpToday > 0
                  ? `SIP rate ${((monthlySavings / monthlyExpToday) * 100).toFixed(0)}% of spend`
                  : undefined
              }
            />
          </div>
        </div>

        {/* Assumptions */}
        <div
          style={{ paddingTop: 14, borderTop: "1.5px solid var(--rule-soft)" }}
        >
          <div className="mono" style={SECTION_LABEL}>
            ASSUMPTIONS
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <PfFireSlider
              label="SIP step-up / yr"
              value={savingsIncrement}
              onChange={setSavingsIncrement}
              min={FIRE_BOUNDS.savingsIncrement.min}
              max={FIRE_BOUNDS.savingsIncrement.max}
              suffix="%"
              accentColor="var(--pop-5)"
            />
            <PfFireSlider
              label="Effective tax rate"
              value={taxRate}
              onChange={setTaxRate}
              min={FIRE_BOUNDS.taxRate.min}
              max={FIRE_BOUNDS.taxRate.max}
              step={1}
              suffix="%"
              accentColor="var(--pop-2)"
            />
            <PfFireSlider
              label="Withdrawal rate (4% rule)"
              value={withdrawalRate}
              onChange={setWithdrawalRate}
              min={FIRE_BOUNDS.withdrawalRate.min}
              max={FIRE_BOUNDS.withdrawalRate.max}
              step={0.5}
              suffix="%"
              accentColor="var(--pop-4)"
            />
            <PfFireSlider
              label="Salary increment / yr"
              value={salaryIncrement}
              onChange={setSalaryIncrement}
              min={FIRE_BOUNDS.salaryIncrement.min}
              max={FIRE_BOUNDS.salaryIncrement.max}
              suffix="%"
              accentColor="var(--pop-3)"
            />
          </div>
        </div>

        {/* Footer note */}
        <p
          style={{
            paddingTop: 12,
            borderTop: "1px dashed var(--rule-soft)",
            fontSize: 11,
            color: "var(--ink-3)",
            lineHeight: 1.55,
            margin: 0,
          }}
        >
          <span
            className="mono"
            style={{ fontWeight: 700, color: "var(--ink-2)" }}
          >
            Weighted return
          </span>{" "}
          from asset mix:{" "}
          <span
            className="mono"
            style={{ color: "var(--emerald)", fontWeight: 700 }}
          >
            {weightedReturn.toFixed(1)}%
          </span>
          . Inflation comes from each expense category.
        </p>
      </div>
    </div>
  );
}
