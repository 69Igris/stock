"use client";

import { CheckCircle2, AlertTriangle, ChevronUp, Clock } from "lucide-react";
import { formatLakhs } from "../lib/types";

interface StatusBannerProps {
  statusOk: boolean;
  fireAchieved: boolean;
  surplus: number;
  corpusLastsTill: number;
  currentAge: number;
  yearsToFire: number;
  retirementAge: number;
  /** First retirement age where spending exceeds the withdrawal cap
      (unfunded from there) — null when every year is fully funded. */
  firstShortfallAge: number | null;
  onBumpSip: () => void;
  onDeferRetire: () => void;
}

export function StatusBanner({
  statusOk,
  fireAchieved,
  surplus,
  corpusLastsTill,
  currentAge,
  yearsToFire,
  retirementAge,
  firstShortfallAge,
  onBumpSip,
  onDeferRetire,
}: StatusBannerProps) {
  return (
    <div
      className="pf-card"
      style={{
        padding: "14px 18px",
        background: statusOk ? "var(--emerald-bg)" : "rgba(255,107,53,0.09)",
        border: `2px solid ${statusOk ? "var(--emerald)" : "var(--pop-1)"}`,
        marginBottom: 20,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        flexWrap: "wrap",
        boxShadow: "none",
      }}
    >
      {statusOk ? (
        <CheckCircle2
          style={{
            width: 18,
            height: 18,
            color: "var(--emerald)",
            flexShrink: 0,
            marginTop: 1,
          }}
        />
      ) : (
        <AlertTriangle
          style={{
            width: 18,
            height: 18,
            color: "var(--pop-1)",
            flexShrink: 0,
            marginTop: 1,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.5,
            color: statusOk ? "var(--emerald)" : "var(--pop-1)",
            marginBottom: 2,
          }}
        >
          {statusOk ? "ON TRACK" : !fireAchieved ? "BEHIND" : "OVERDRAWN"}
        </div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {statusOk
            ? `FIRE corpus reached at age ${currentAge + (yearsToFire >= 999 ? 0 : yearsToFire)} · money lasts till ${corpusLastsTill}.`
            : !fireAchieved
              ? `${formatLakhs(Math.abs(surplus))} short at age ${retirementAge}.`
              : `Spending outruns the withdrawal cap from age ${firstShortfallAge} — those years are unfunded. Save more, retire later, or trim expenses.`}
        </div>
      </div>
      {!statusOk && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" onClick={onBumpSip} className="pf-bs sm">
            <ChevronUp className="h-3 w-3" /> SIP +25%
          </button>
          <button type="button" onClick={onDeferRetire} className="pf-bf sm">
            <Clock className="h-3 w-3" /> +3 yrs
          </button>
        </div>
      )}
    </div>
  );
}
