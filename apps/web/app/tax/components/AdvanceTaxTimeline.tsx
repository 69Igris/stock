"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AdvanceTaxResult } from "@usemoney/research";

interface AdvanceTaxTimelineProps {
  advanceTax: AdvanceTaxResult;
}

function formatINR(value: number): string {
  return value.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

// Per-quarter accent color (pop tokens), theme-aware.
function getQuarterColor(index: number): string {
  const colors = [
    "var(--pop-3)",
    "var(--emerald)",
    "var(--pop-2)",
    "var(--pop-5)",
  ];
  return colors[index] || "var(--ink-3)";
}

export default function AdvanceTaxTimeline({
  advanceTax,
}: AdvanceTaxTimelineProps) {
  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="ttl">ADVANCE TAX SCHEDULE</div>
        <span
          className={`pf-pill ${advanceTax.isApplicable ? "coral" : "outline"}`}
        >
          {advanceTax.isApplicable ? "Applicable" : "Not Applicable"}
        </span>
      </div>

      {/* Applicability Notice */}
      <div
        className="mb-4 p-3 rounded-lg text-xs text-[var(--ink-2)]"
        style={{
          background: "var(--rule-softer)",
          border: `1.5px solid ${advanceTax.isApplicable ? "var(--pop-2)" : "var(--emerald)"}`,
        }}
      >
        {advanceTax.isApplicable ? (
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="h-4 w-4 shrink-0 mt-0.5"
              style={{ color: "var(--pop-2-text)" }}
            />
            <span>
              Your estimated tax liability of{" "}
              {formatINR(advanceTax.totalEstimatedTax)} exceeds the advance tax
              threshold. You are required to pay advance tax in quarterly
              installments.
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <CheckCircle2
              className="h-4 w-4 shrink-0 mt-0.5"
              style={{ color: "var(--emerald-text)" }}
            />
            <span>
              Your estimated tax liability of{" "}
              {formatINR(advanceTax.totalEstimatedTax)} is below the advance tax
              threshold. No advance tax payments required.
            </span>
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="relative">
        {advanceTax.installments.map((installment, index) => {
          const isLast = index === advanceTax.installments.length - 1;
          const hasShortfall =
            installment.shortfall !== undefined && installment.shortfall > 0;
          const qColor = getQuarterColor(index);

          return (
            <div key={installment.quarter} className="flex gap-4 mb-0">
              {/* Timeline dot and line */}
              <div className="flex flex-col items-center">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mono"
                  style={{
                    background: qColor,
                    color: "var(--paper)",
                    border: "1.5px solid var(--ink)",
                  }}
                >
                  Q{index + 1}
                </div>
                {!isLast && (
                  <div
                    className="w-0.5 h-full min-h-[48px]"
                    style={{ background: qColor, opacity: 0.35 }}
                  />
                )}
              </div>

              {/* Content */}
              <div
                className="flex-1 pb-4"
                style={
                  !isLast
                    ? {
                        borderBottom: "1px dashed var(--rule-soft)",
                        marginBottom: 16,
                      }
                    : undefined
                }
              >
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <span className="font-semibold text-sm text-[var(--ink)]">
                      {installment.quarter}
                    </span>
                    <span className="mono text-[11px] text-[var(--ink-3)] ml-2">
                      Due: {installment.dueDate}
                    </span>
                  </div>
                  <span className="mono text-sm font-bold text-[var(--ink)]">
                    {formatINR(installment.amount)}
                  </span>
                </div>

                {/* Progress bar */}
                <div
                  className="w-full rounded-full h-2 mb-2 overflow-hidden"
                  style={{
                    background: "var(--rule-softer)",
                    border: "1.5px solid var(--ink)",
                  }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${installment.cumulativePercent}%`,
                      background: qColor,
                    }}
                  />
                </div>

                <div className="flex items-center justify-between mono text-[11px] text-[var(--ink-3)]">
                  <span>
                    Cumulative: {installment.cumulativePercent}% of total tax
                  </span>
                  {installment.paid !== undefined && (
                    <span style={{ color: "var(--emerald-text)" }}>
                      Paid: {formatINR(installment.paid)}
                    </span>
                  )}
                </div>

                {hasShortfall && (
                  <div
                    className="mt-1 flex items-center gap-1 mono text-[11px]"
                    style={{ color: "var(--pop-1-text)" }}
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Shortfall: {formatINR(installment.shortfall!)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Interest Penalty */}
      {advanceTax.interestU234C > 0 && (
        <div
          className="mt-4 p-3 rounded-lg"
          style={{
            background: "var(--rule-softer)",
            border: "1.5px solid var(--pop-1)",
          }}
        >
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle
              className="h-4 w-4"
              style={{ color: "var(--pop-1-text)" }}
            />
            <span
              className="font-semibold"
              style={{ color: "var(--pop-1-text)" }}
            >
              Interest u/s 234C: {formatINR(advanceTax.interestU234C)}
            </span>
          </div>
          <p className="text-xs text-[var(--ink-3)] mt-1">
            Interest is charged at 1% per month for deferment or short payment
            of advance tax installments.
          </p>
        </div>
      )}
    </div>
  );
}
