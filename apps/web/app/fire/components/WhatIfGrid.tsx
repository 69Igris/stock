"use client";

import type { Dispatch, SetStateAction } from "react";
import {
  TrendingUp,
  Scissors,
  Rocket,
  ChevronUp,
  Flame,
  Clock,
} from "lucide-react";
import type { AssetClass, MonthlyExpense } from "../lib/types";

interface WhatIfGridProps {
  monthlySavings: number;
  retirementAge: number;
  setMonthlySavings: (v: number) => void;
  setRetirementAge: (v: number) => void;
  setSavingsIncrement: (v: number) => void;
  setMonthlyExpenses: Dispatch<SetStateAction<MonthlyExpense[]>>;
  setAssetClasses: Dispatch<SetStateAction<AssetClass[]>>;
}

export function WhatIfGrid({
  monthlySavings,
  retirementAge,
  setMonthlySavings,
  setRetirementAge,
  setSavingsIncrement,
  setMonthlyExpenses,
  setAssetClasses,
}: WhatIfGridProps) {
  return (
    <>
      <div className="pf-sec-h" style={{ marginTop: 0 }}>
        <span className="n">07 · WHAT-IF</span>
        <h3>
          <span className="ser">Tap to apply.</span>
        </h3>
        <span className="rule hidden sm:block" />
      </div>

      <div className="pf-fire-whatif-grid" data-walkthrough="fire-whatif">
        {(
          [
            {
              Icon: TrendingUp,
              lbl: "Bump SIP +₹15K/mo",
              apply: () => setMonthlySavings(monthlySavings + 15_000),
            },
            {
              Icon: Scissors,
              lbl: "Cut expenses −10%",
              apply: () =>
                setMonthlyExpenses((prev) =>
                  prev.map((e) => ({
                    ...e,
                    amount: Math.round(e.amount * 0.9),
                  }))
                ),
            },
            {
              Icon: Rocket,
              lbl: "Equity +15% alloc",
              apply: () =>
                setAssetClasses((prev) =>
                  prev.map((a) =>
                    a.name.toLowerCase().includes("equity")
                      ? { ...a, allocation: Math.min(100, a.allocation + 15) }
                      : a.name.toLowerCase().includes("fixed")
                        ? { ...a, allocation: Math.max(0, a.allocation - 15) }
                        : a
                  )
                ),
            },
            {
              Icon: ChevronUp,
              lbl: "Step-up SIP +12%/yr",
              apply: () => setSavingsIncrement(12),
            },
            {
              Icon: Flame,
              lbl: "Inflation spike to 8%",
              apply: () =>
                setMonthlyExpenses((prev) =>
                  prev.map((e) => ({ ...e, inflation: 8 }))
                ),
            },
            {
              Icon: Clock,
              lbl: "Defer retirement +3 yrs",
              apply: () => setRetirementAge(retirementAge + 3),
            },
          ] as const
        ).map(({ Icon, lbl, apply }) => (
          <button
            key={lbl}
            type="button"
            onClick={apply}
            className="pf-card"
            style={{
              padding: 14,
              textAlign: "left",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              transition: "transform .12s, box-shadow .12s",
              boxShadow: "none",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translate(-1px,-1px)";
              e.currentTarget.style.boxShadow = "3px 3px 0 var(--ink)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translate(0,0)";
              e.currentTarget.style.boxShadow = "var(--shadow-soft)";
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon
                style={{
                  width: 14,
                  height: 14,
                  color: "var(--emerald)",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontWeight: 700, fontSize: 12.5 }}>{lbl}</span>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
