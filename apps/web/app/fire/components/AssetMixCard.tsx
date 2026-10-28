"use client";

import { AlertTriangle } from "lucide-react";
import { AllocationDonut } from "./AllocationDonut";
import type { AssetClass } from "../lib/types";

interface AssetMixCardProps {
  assetClasses: AssetClass[];
  weightedReturn: number;
  allocOff: boolean;
  allocSum: number;
  onUpdateAsset: (id: string, patch: Partial<AssetClass>) => void;
}

export function AssetMixCard({
  assetClasses,
  weightedReturn,
  allocOff,
  allocSum,
  onUpdateAsset,
}: AssetMixCardProps) {
  return (
    <>
      <div className="pf-sec-h" style={{ marginTop: 0 }}>
        <span className="n">04 · ALLOCATION</span>
        <h3>
          Asset <span className="ser">mix.</span>
        </h3>
        <span className="rule hidden sm:block" />
        {allocOff && (
          <span className="pf-pill coral">
            <AlertTriangle className="h-3 w-3" /> {allocSum.toFixed(0)}% ≠ 100
          </span>
        )}
      </div>

      <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          className="pf-fire-asset-grid"
          style={{ padding: 18, alignItems: "flex-start" }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}
          >
            <AllocationDonut
              classes={assetClasses}
              weightedReturn={weightedReturn}
            />
            <div
              className="mono"
              style={{
                fontSize: 9.5,
                color: "var(--ink-3)",
                letterSpacing: 0.8,
                textTransform: "uppercase",
              }}
            >
              Weighted Return
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              minWidth: 0,
            }}
          >
            {assetClasses.map((a) => (
              <div
                key={a.id}
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "14px minmax(0,1.4fr) minmax(0,1fr) 58px 68px",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: a.color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--ink-2)",
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.name}
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={a.allocation}
                  onChange={(e) =>
                    onUpdateAsset(a.id, { allocation: Number(e.target.value) })
                  }
                  className="pf-fire-slider"
                  style={{ accentColor: a.color }}
                />
                <span
                  className="mono"
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: a.color,
                    textAlign: "right",
                  }}
                >
                  {a.allocation}%
                </span>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    padding: "4px 6px",
                    background: "var(--rule-softer)",
                    border: "1.5px solid var(--rule-soft)",
                    borderRadius: 7,
                  }}
                >
                  <input
                    type="number"
                    value={a.expectedReturn}
                    step="0.5"
                    onChange={(e) =>
                      onUpdateAsset(a.id, {
                        expectedReturn: Number(e.target.value),
                      })
                    }
                    style={{
                      width: "100%",
                      background: "transparent",
                      border: 0,
                      color: "var(--ink)",
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 12,
                      fontWeight: 700,
                      outline: "none",
                      textAlign: "right",
                    }}
                  />
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--ink-3)" }}
                  >
                    %
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
