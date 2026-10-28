"use client";

import { useState, useEffect } from "react";
import { Skeleton } from "@usemoney/ui/skeleton";
import { History } from "lucide-react";
import { getPaperPositionsAction } from "@/lib/actions/paper";

interface ClosedPosition {
  id: string;
  symbol: string;
  name: string | null;
  side: string;
  quantity: number;
  averagePrice: number;
  exitPrice: number | null;
  investedValue: number;
  realizedPnL: number | null;
  pnlPercentage: number;
  strategy: string | null;
  entryDate: Date;
  exitDate: Date | null;
}

function formatINR(n: number): string {
  if (!Number.isFinite(n)) return "₹0";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function shortDate(d: Date | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

export default function HistoryPage() {
  const [positions, setPositions] = useState<ClosedPosition[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadHistory() {
      try {
        const result = await getPaperPositionsAction({ status: "CLOSED" });
        if (result?.success && result?.data) {
          setPositions(result?.data.positions as unknown as ClosedPosition[]);
        }
      } catch {
        // handled
      } finally {
        setIsLoading(false);
      }
    }
    loadHistory();
  }, []);

  if (isLoading) {
    return (
      <div className="pf-app">
        <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="pf-tbl">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>OPENED</th>
                  <th>CLOSED</th>
                  <th>SYM</th>
                  <th>SIDE</th>
                  <th>STRAT</th>
                  <th style={{ textAlign: "right" }}>QTY</th>
                  <th style={{ textAlign: "right" }}>P&amp;L</th>
                  <th style={{ textAlign: "right" }}>%</th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5].map((i) => (
                  <tr key={i}>
                    <td style={{ paddingLeft: 18 }}>
                      <Skeleton className="h-3 w-14 bg-muted" />
                    </td>
                    <td>
                      <Skeleton className="h-3 w-14 bg-muted" />
                    </td>
                    <td>
                      <Skeleton className="h-4 w-20 bg-muted" />
                    </td>
                    <td>
                      <Skeleton className="h-5 w-14 rounded-full bg-muted" />
                    </td>
                    <td>
                      <Skeleton className="h-5 w-16 rounded-full bg-muted" />
                    </td>
                    <td>
                      <Skeleton className="h-3 w-8 bg-muted ml-auto" />
                    </td>
                    <td>
                      <Skeleton className="h-3 w-20 bg-muted ml-auto" />
                    </td>
                    <td>
                      <Skeleton className="h-3 w-12 bg-muted ml-auto" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="pf-app">
        <div
          className="pf-card"
          style={{ padding: 40, textAlign: "center" }}
          data-walkthrough="paper-history-table"
        >
          <History
            className="h-8 w-8"
            style={{ margin: "0 auto 12px", color: "var(--ink-3)" }}
          />
          <h3
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: "var(--ink)",
              marginBottom: 6,
            }}
          >
            No closed trades
          </h3>
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
            Your closed trades will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pf-app">
      <div
        className="pf-card"
        style={{ padding: 0, overflow: "hidden" }}
        data-walkthrough="paper-history-table"
      >
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>OPENED</th>
                <th>CLOSED</th>
                <th>SYM</th>
                <th>SIDE</th>
                <th>STRAT</th>
                <th style={{ textAlign: "right" }}>QTY</th>
                <th style={{ textAlign: "right" }}>P&amp;L</th>
                <th style={{ textAlign: "right" }}>%</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const pnl = pos.realizedPnL ?? 0;
                const isProfit = pnl >= 0;
                const isLong = pos.side === "LONG" || pos.side === "BUY";
                return (
                  <tr key={pos.id}>
                    <td className="num" style={{ paddingLeft: 18 }}>
                      {shortDate(pos.entryDate)}
                    </td>
                    <td className="num">{shortDate(pos.exitDate)}</td>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <span className="tk">{pos.symbol}</span>
                        {pos.name && <span className="nm">{pos.name}</span>}
                      </div>
                    </td>
                    <td>
                      <span
                        className={`pf-pill ${isLong ? "emerald" : "coral"}`}
                        style={{ fontSize: 9.5 }}
                      >
                        {pos.side}
                      </span>
                    </td>
                    <td>
                      {pos.strategy ? (
                        <span
                          className="pf-pill outline"
                          style={{ fontSize: 9.5 }}
                        >
                          {pos.strategy}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-3)" }}>—</span>
                      )}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {pos.quantity}
                    </td>
                    <td
                      className={`num ${isProfit ? "pos" : "neg"}`}
                      style={{ textAlign: "right", fontWeight: 700 }}
                    >
                      {isProfit ? "+" : ""}
                      {formatINR(pnl)}
                    </td>
                    <td
                      className={`num ${isProfit ? "pos" : "neg"}`}
                      style={{ textAlign: "right", paddingRight: 18 }}
                    >
                      {pos.pnlPercentage >= 0 ? "+" : ""}
                      {pos.pnlPercentage.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
