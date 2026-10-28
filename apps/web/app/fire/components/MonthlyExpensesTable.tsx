"use client";

import { Plus, X } from "lucide-react";
import { formatLakhs, type MonthlyExpense } from "../lib/types";

interface MonthlyExpensesTableProps {
  monthlyExpenses: MonthlyExpense[];
  monthlyExpToday: number;
  currentAge: number;
  retirementAge: number;
  onUpdate: (id: string, patch: Partial<MonthlyExpense>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export function MonthlyExpensesTable({
  monthlyExpenses,
  monthlyExpToday,
  currentAge,
  retirementAge,
  onUpdate,
  onRemove,
  onAdd,
}: MonthlyExpensesTableProps) {
  // Total monthly spend at retirement, inflating EACH expense at its own rate
  // over the years to retirement (not a single blended rate on the total).
  const yearsToRetire = Math.max(0, retirementAge - currentAge);
  const monthlyExpAtRetire = monthlyExpenses.reduce(
    (sum, e) => sum + e.amount * Math.pow(1 + e.inflation / 100, yearsToRetire),
    0
  );

  return (
    <>
      <div className="pf-sec-h" style={{ marginTop: 0 }}>
        <span className="n">05 · EXPENSES</span>
        <h3>
          Monthly <span className="ser">outgo.</span>
        </h3>
        <span className="rule hidden sm:block" />
        <span
          className="meta"
          style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}
        >
          <span>Total {formatLakhs(monthlyExpToday)}/mo</span>
          <span style={{ color: "var(--pop-2)" }}>
            {formatLakhs(monthlyExpAtRetire)}/mo at age {retirementAge}
          </span>
        </span>
        <button type="button" onClick={onAdd} className="pf-bf sm">
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>

      <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl" style={{ minWidth: 580 }}>
            <thead>
              <tr>
                <th>CATEGORY</th>
                <th style={{ textAlign: "right" }}>MONTHLY</th>
                <th style={{ textAlign: "right" }}>INFLATION</th>
                <th style={{ textAlign: "right" }}>SHARE</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {monthlyExpenses.map((e) => {
                const share =
                  monthlyExpToday > 0 ? (e.amount / monthlyExpToday) * 100 : 0;
                return (
                  <tr key={e.id}>
                    <td style={{ padding: "10px 14px" }}>
                      <input
                        value={e.category}
                        onChange={(ev) =>
                          onUpdate(e.id, { category: ev.target.value })
                        }
                        className="pf-fire-inline-input"
                      />
                    </td>
                    <td className="num" style={{ padding: "10px 14px" }}>
                      <input
                        type="number"
                        value={e.amount}
                        onChange={(ev) =>
                          onUpdate(e.id, { amount: Number(ev.target.value) })
                        }
                        className="pf-fire-inline-input"
                        style={{ textAlign: "right" }}
                      />
                    </td>
                    <td className="num" style={{ padding: "10px 14px" }}>
                      <input
                        type="number"
                        value={e.inflation}
                        step="0.5"
                        onChange={(ev) =>
                          onUpdate(e.id, { inflation: Number(ev.target.value) })
                        }
                        className="pf-fire-inline-input"
                        style={{
                          textAlign: "right",
                          color:
                            e.inflation > 7 ? "var(--pop-2)" : "var(--ink)",
                        }}
                      />
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            width: 50,
                            height: 4,
                            borderRadius: 2,
                            background: "var(--rule-softer)",
                            border: "1px solid var(--rule-soft)",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${share}%`,
                              height: "100%",
                              background: "var(--emerald)",
                            }}
                          />
                        </div>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            color: "var(--ink-3)",
                            minWidth: 36,
                            textAlign: "right",
                          }}
                        >
                          {share.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      <button
                        type="button"
                        onClick={() => onRemove(e.id)}
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
