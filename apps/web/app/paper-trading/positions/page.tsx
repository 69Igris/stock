"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@usemoney/ui/input";
import { Skeleton } from "@usemoney/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@usemoney/ui/dialog";
import { toast } from "sonner";
import { TrendingUp, X, Target, Shield } from "lucide-react";
import {
  getPaperPositionsAction,
  closePaperPositionAction,
} from "@/lib/actions/paper";

interface Position {
  id: string;
  symbol: string;
  name: string | null;
  assetType: string;
  side: string;
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  dayPnl: number;
  stopLoss: number | null;
  target: number | null;
  strategy: string | null;
  entryDate: Date;
}

function formatINR(n: number): string {
  if (!Number.isFinite(n)) return "₹0";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function heldFor(entryDate: Date): string {
  const start = new Date(entryDate).getTime();
  if (!Number.isFinite(start)) return "—";
  const days = Math.max(
    0,
    Math.round((Date.now() - start) / (1000 * 60 * 60 * 24))
  );
  return days === 0 ? "today" : `${days}d`;
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closePrice, setClosePrice] = useState("");
  const [showCloseDialog, setShowCloseDialog] = useState(false);

  const loadPositions = useCallback(async () => {
    try {
      const result = await getPaperPositionsAction({ status: "OPEN" });
      if (result?.success && result?.data) {
        setPositions(result?.data.positions as unknown as Position[]);
      }
    } catch {
      toast.error("Failed to load positions");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  const handleClose = useCallback(
    async (positionId: string) => {
      const position = positions.find((p) => p.id === positionId);
      if (!position) return;
      setClosingId(positionId);
      setClosePrice(position.currentPrice.toString());
      setShowCloseDialog(true);
    },
    [positions]
  );

  const confirmClose = useCallback(async () => {
    if (!closingId || !closePrice) return;

    try {
      const result = await closePaperPositionAction(
        closingId,
        parseFloat(closePrice)
      );
      if (result?.success) {
        toast.success(result.message || "Position closed");
        setShowCloseDialog(false);
        loadPositions();
      } else {
        toast.error(result?.error || "Failed to close position");
      }
    } catch {
      toast.error("Failed to close position");
    }
  }, [closingId, closePrice, loadPositions]);

  if (isLoading) {
    return (
      <div className="pf-app">
        <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="pf-tbl">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>SYM</th>
                  <th>SIDE</th>
                  <th>STRAT</th>
                  <th style={{ textAlign: "right" }}>QTY</th>
                  <th style={{ textAlign: "right" }}>ENTRY</th>
                  <th style={{ textAlign: "right" }}>LTP</th>
                  <th style={{ textAlign: "right" }}>P&amp;L</th>
                  <th>HELD</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4].map((i) => (
                  <tr key={i}>
                    <td style={{ paddingLeft: 18 }}>
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
                      <Skeleton className="h-3 w-14 bg-muted ml-auto" />
                    </td>
                    <td>
                      <Skeleton className="h-3 w-14 bg-muted ml-auto" />
                    </td>
                    <td>
                      <Skeleton className="h-3 w-16 bg-muted ml-auto" />
                    </td>
                    <td>
                      <Skeleton className="h-3 w-8 bg-muted" />
                    </td>
                    <td>
                      <Skeleton className="h-7 w-16 rounded-md bg-muted" />
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
          data-walkthrough="paper-positions-table"
        >
          <TrendingUp
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
            No open positions
          </h3>
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
            Place your first paper trade to see positions here.
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
        data-walkthrough="paper-positions-table"
      >
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>SYM</th>
                <th>SIDE</th>
                <th>STRAT</th>
                <th style={{ textAlign: "right" }}>QTY</th>
                <th style={{ textAlign: "right" }}>ENTRY</th>
                <th style={{ textAlign: "right" }}>LTP</th>
                <th style={{ textAlign: "right" }}>P&amp;L</th>
                <th>HELD</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => {
                const isLong = pos.side === "LONG" || pos.side === "BUY";
                const up = pos.unrealizedPnL >= 0;
                return (
                  <tr key={pos.id}>
                    <td style={{ paddingLeft: 18 }}>
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
                      className="num"
                      style={{ textAlign: "right", color: "var(--ink-3)" }}
                    >
                      {formatINR(pos.averagePrice)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatINR(pos.currentPrice)}
                    </td>
                    <td
                      className={`num ${up ? "pos" : "neg"}`}
                      style={{ textAlign: "right", fontWeight: 700 }}
                    >
                      {up ? "+" : ""}
                      {formatINR(pos.unrealizedPnL)}
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--ink-3)",
                          fontWeight: 400,
                          marginTop: 2,
                        }}
                      >
                        {pos.pnlPercentage >= 0 ? "+" : ""}
                        {pos.pnlPercentage.toFixed(2)}%
                      </div>
                      {(pos.stopLoss || pos.target) && (
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            justifyContent: "flex-end",
                            marginTop: 3,
                          }}
                        >
                          {pos.stopLoss && (
                            <span
                              style={{
                                fontSize: 9.5,
                                color: "#b91c1c",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              <Shield className="h-3 w-3" />
                              {formatINR(pos.stopLoss)}
                            </span>
                          )}
                          {pos.target && (
                            <span
                              style={{
                                fontSize: 9.5,
                                color: "var(--emerald-text)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              <Target className="h-3 w-3" />
                              {formatINR(pos.target)}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ color: "var(--ink-3)" }}>
                      {heldFor(pos.entryDate)}
                    </td>
                    <td style={{ textAlign: "right", paddingRight: 18 }}>
                      <button
                        onClick={() => handleClose(pos.id)}
                        data-walkthrough="paper-positions-square-off"
                        className="pf-bf sm danger"
                        style={{ padding: "4px 10px", fontSize: 11 }}
                      >
                        <X className="h-3 w-3" style={{ marginRight: 4 }} />
                        Close
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Close Position Dialog */}
      <Dialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
        <DialogContent
          className="max-w-sm"
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "var(--shadow-hard)",
            color: "var(--ink)",
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "-0.4px",
                color: "var(--ink)",
              }}
            >
              Close Position
            </DialogTitle>
            <DialogDescription
              className="ser"
              style={{ fontSize: 16, color: "var(--ink-2)", lineHeight: 1.4 }}
            >
              Enter the exit price to close this position.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Exit Price
              </label>
              <Input
                type="number"
                value={closePrice}
                onChange={(e) => setClosePrice(e.target.value)}
                className="pf-input"
                step="0.05"
              />
            </div>
          </div>
          <DialogFooter className="sm:justify-end">
            <button
              type="button"
              className="pf-bf sm"
              onClick={() => setShowCloseDialog(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pf-bf sm danger"
              onClick={confirmClose}
            >
              Close Position
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
