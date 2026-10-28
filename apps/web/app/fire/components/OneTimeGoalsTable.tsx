"use client";

import { Plus, X } from "lucide-react";
import { formatLakhs, type OneTimeExpense } from "../lib/types";
import { dueYear } from "../lib/calculations";

interface OneTimeGoalsTableProps {
  oneTimeExpenses: OneTimeExpense[];
  onUpdate: (id: string, patch: Partial<OneTimeExpense>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export function OneTimeGoalsTable({
  oneTimeExpenses,
  onUpdate,
  onRemove,
  onAdd,
}: OneTimeGoalsTableProps) {
  return (
    <>
      <div className="pf-sec-h" style={{ marginTop: 0 }}>
        <span className="n">06 · GOALS</span>
        <h3>
          One-time <span className="ser">goals.</span>
        </h3>
        <span className="rule hidden sm:block" />
        <button type="button" onClick={onAdd} className="pf-bf sm">
          <Plus className="h-3 w-3" /> Add goal
        </button>
      </div>

      <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl" style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th>GOAL</th>
                <th style={{ textAlign: "right" }}>TODAY&apos;S COST</th>
                <th style={{ textAlign: "right" }}>YEARS AWAY</th>
                <th style={{ textAlign: "right" }}>INFLATION</th>
                <th style={{ textAlign: "right" }}>FUTURE COST</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {oneTimeExpenses.map((o) => {
                // Inflate over the same whole-year horizon the projection
                // schedules the goal on, so this column can never disagree with
                // the plan it feeds (MONEY-1161).
                const future =
                  o.currentCost * Math.pow(1 + o.inflation / 100, dueYear(o));
                return (
                  <tr key={o.id}>
                    <td style={{ padding: "10px 14px" }}>
                      <input
                        value={o.name}
                        onChange={(ev) =>
                          onUpdate(o.id, { name: ev.target.value })
                        }
                        className="pf-fire-inline-input"
                      />
                    </td>
                    <td className="num" style={{ padding: "10px 14px" }}>
                      <input
                        type="number"
                        value={o.currentCost}
                        onChange={(ev) =>
                          onUpdate(o.id, {
                            currentCost: Number(ev.target.value),
                          })
                        }
                        className="pf-fire-inline-input"
                        style={{ textAlign: "right" }}
                      />
                    </td>
                    <td className="num" style={{ padding: "10px 14px" }}>
                      <input
                        type="number"
                        value={o.yearsAway}
                        min={0}
                        step={1}
                        onChange={(ev) =>
                          onUpdate(o.id, { yearsAway: Number(ev.target.value) })
                        }
                        className="pf-fire-inline-input"
                        style={{ textAlign: "right" }}
                      />
                    </td>
                    <td className="num" style={{ padding: "10px 14px" }}>
                      <input
                        type="number"
                        value={o.inflation}
                        step="0.5"
                        onChange={(ev) =>
                          onUpdate(o.id, { inflation: Number(ev.target.value) })
                        }
                        className="pf-fire-inline-input"
                        style={{ textAlign: "right" }}
                      />
                    </td>
                    <td
                      className="num"
                      style={{
                        padding: "10px 14px",
                        color: "var(--pop-5)",
                        fontWeight: 700,
                      }}
                    >
                      {formatLakhs(future)}
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      <button
                        type="button"
                        onClick={() => onRemove(o.id)}
                        style={{
                          padding: 4,
                          background: "transparent",
                          border: 0,
                          cursor: "pointer",
                          color: "var(--ink-3)",
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
