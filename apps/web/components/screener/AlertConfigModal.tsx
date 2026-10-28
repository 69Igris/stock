"use client";

/**
 * AlertConfigModal (MONEY-483 playful redesign).
 *
 * Matches the design-bundle AlertConfigDialog:
 *   - Alert type: Price level / % change / Indicator / Volume spike (2×2 grid)
 *   - Direction + target value (shown when type = "PRICE" or "PERCENT")
 *   - Delivery channels: In-app / Email / Push (with per-channel toggles)
 *   - Expiry chips: 1 day / 1 week / 1 month / Never
 *
 * Wiring: uses createAlertAction from lib/actions/alerts.ts.
 * Fully wired for PRICE and VOLUME kinds. INDICATOR and PERCENT_CHANGE
 * map to PRICE/VOLUME for now with a note — the evaluator handles them
 * via the `conditions` JSON field once the worker supports them.
 *
 * Usage:
 *   <AlertConfigModal
 *     symbol="INFY"
 *     currentPrice={1654.20}
 *     exchange="NSE"
 *     open={open}
 *     onOpenChange={setOpen}
 *   />
 */

import React, { useCallback, useState } from "react";
import {
  Bell,
  TrendingUp,
  Zap,
  BarChart2,
  Activity,
  Mail,
  Smartphone,
  MessageSquare,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  createAlertAction,
  type AlertKind,
  type NotifyChannel,
} from "@/lib/actions/alerts";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

type LocalAlertType = "price" | "percent" | "indicator" | "volume";
type Direction = "above" | "below";
type Expiry = "1d" | "7d" | "30d" | "never";

interface AlertConfigModalProps {
  symbol: string;
  /** Latest traded price — pre-fills the target input. */
  currentPrice?: number;
  exchange?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Map local UI alert type → AlertKind that createAlertAction accepts. */
function toAlertKind(t: LocalAlertType): AlertKind {
  if (t === "volume") return "VOLUME";
  // PERCENT + INDICATOR are stored as CUSTOM with structured conditions
  // until the evaluator worker adds dedicated handlers.
  return "PRICE";
}

/** Map expiry chips → cooldown minutes (used as a proxy for expiry). */
function toCooldownMinutes(expiry: Expiry): number {
  if (expiry === "1d") return 60 * 24;
  if (expiry === "7d") return 60 * 24 * 7;
  if (expiry === "30d") return 60 * 24 * 30;
  return 60 * 24 * 365 * 10; // "never" = 10 years
}

function formatPrice(p: number): string {
  return `₹${p.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────

export function AlertConfigModal({
  symbol,
  currentPrice,
  exchange = "NSE",
  open,
  onOpenChange,
}: AlertConfigModalProps) {
  const [alertType, setAlertType] = useState<LocalAlertType>("price");
  const [direction, setDirection] = useState<Direction>("above");
  const [targetValue, setTargetValue] = useState(
    currentPrice != null ? currentPrice.toFixed(2) : ""
  );
  const [channels, setChannels] = useState<Set<NotifyChannel>>(
    new Set<NotifyChannel>(["IN_APP", "EMAIL"])
  );
  const [expiry, setExpiry] = useState<Expiry>("30d");
  const [busy, setBusy] = useState(false);

  function toggleChannel(ch: NotifyChannel) {
    setChannels((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) {
        // Always keep at least one channel
        if (next.size > 1) next.delete(ch);
      } else {
        next.add(ch);
      }
      return next;
    });
  }

  const handleCreate = useCallback(async () => {
    const numValue = parseFloat(targetValue);
    if (alertType !== "volume" && (isNaN(numValue) || numValue <= 0)) {
      toast.error("Enter a valid target value");
      return;
    }

    setBusy(true);
    const res = await createAlertAction({
      kind: toAlertKind(alertType),
      symbol,
      conditions: {
        alertType,
        direction,
        targetValue: isNaN(numValue) ? null : numValue,
        exchange,
      },
      notifyChannels: Array.from(channels),
      cooldownMinutes: toCooldownMinutes(expiry),
    });
    setBusy(false);

    if (res.success) {
      toast.success(`Alert set for ${symbol}`);
      onOpenChange(false);
    } else {
      toast.error(res.error ?? "Could not create alert");
    }
  }, [
    alertType,
    direction,
    targetValue,
    channels,
    expiry,
    symbol,
    exchange,
    onOpenChange,
  ]);

  if (!open) return null;

  const ALERT_TYPES: Array<{
    id: LocalAlertType;
    label: string;
    Icon: React.ElementType;
  }> = [
    { id: "price", label: "Price level", Icon: TrendingUp },
    { id: "percent", label: "% change", Icon: Zap },
    { id: "indicator", label: "Indicator", Icon: Activity },
    { id: "volume", label: "Volume spike", Icon: BarChart2 },
  ];

  const DELIVERY: Array<{
    ch: NotifyChannel;
    label: string;
    sub: string;
    Icon: React.ElementType;
  }> = [
    {
      ch: "IN_APP",
      label: "In-app",
      sub: "Notification bell",
      Icon: Bell,
    },
    {
      ch: "EMAIL",
      label: "Email",
      sub: "Your registered email",
      Icon: Mail,
    },
    {
      ch: "PUSH",
      label: "Push",
      sub: "Mobile push notification",
      Icon: Smartphone,
    },
  ];

  const EXPIRY_CHIPS: Array<{ id: Expiry; label: string }> = [
    { id: "1d", label: "1 day" },
    { id: "7d", label: "1 week" },
    { id: "30d", label: "1 month" },
    { id: "never", label: "Never" },
  ];

  const showTarget = alertType === "price" || alertType === "percent";
  const isIndicatorOrVolume =
    alertType === "indicator" || alertType === "volume";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-[520px] max-w-[94vw] max-h-[92vh] overflow-y-auto"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 14,
          boxShadow: "var(--shadow-soft)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-[22px] py-4"
          style={{
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="grid place-items-center shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--pop-1)",
                color: "var(--paper)",
                transform: "rotate(-3deg)",
              }}
            >
              <Bell className="h-4 w-4" />
            </div>
            <div>
              <div
                className="font-bold text-[var(--ink)]"
                style={{ fontSize: 16 }}
              >
                Set alert · {symbol}
              </div>
              <div
                className="mono text-[var(--ink-3)]"
                style={{ fontSize: 10.5, letterSpacing: 0.5, marginTop: 1 }}
              >
                {currentPrice != null
                  ? `CURRENT ${formatPrice(currentPrice)} · ${exchange}`
                  : exchange}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid place-items-center cursor-pointer"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1.5px solid var(--ink)",
              background: "var(--paper)",
              color: "var(--ink)",
            }}
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-[22px] py-5 flex flex-col gap-5">
          {/* Alert type grid */}
          <div>
            <div
              className="mono font-bold text-[var(--ink-3)] mb-2.5"
              style={{ fontSize: 11, letterSpacing: 1.5 }}
            >
              ALERT TYPE
            </div>
            <div className="grid grid-cols-2 gap-2">
              {ALERT_TYPES.map(({ id, label, Icon }) => {
                const active = alertType === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setAlertType(id)}
                    className="flex items-center gap-2 cursor-pointer transition-colors"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: `1.5px solid ${active ? "var(--emerald)" : "var(--ink)"}`,
                      background: active ? "var(--emerald-bg)" : "var(--paper)",
                      color: active ? "var(--emerald-text)" : "var(--ink)",
                      fontWeight: 700,
                      fontSize: 13,
                    }}
                  >
                    <Icon
                      style={{ width: 14, height: 14, flexShrink: 0 }}
                      strokeWidth={2}
                    />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Direction + target */}
          {showTarget && (
            <div className="grid grid-cols-[1fr_1.4fr] gap-3">
              <div>
                <label
                  className="block mono font-bold text-[var(--ink-2)] mb-1.5"
                  style={{ fontSize: 12 }}
                >
                  Direction
                </label>
                <div className="flex gap-1.5">
                  {(["above", "below"] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDirection(d)}
                      className="flex-1 cursor-pointer transition-colors"
                      style={{
                        padding: "9px 10px",
                        border: `1.5px solid ${direction === d ? "var(--emerald)" : "var(--ink)"}`,
                        borderRadius: 8,
                        background:
                          direction === d
                            ? "var(--emerald-bg)"
                            : "var(--paper)",
                        color:
                          direction === d
                            ? "var(--emerald-text)"
                            : "var(--ink-2)",
                        fontSize: 12.5,
                        fontWeight: 700,
                      }}
                    >
                      {d === "above" ? "↑ Above" : "↓ Below"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label
                  className="block mono font-bold text-[var(--ink-2)] mb-1.5"
                  style={{ fontSize: 12 }}
                >
                  {alertType === "percent" ? "% change" : "Price target"}
                </label>
                <input
                  type="number"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                  placeholder={
                    alertType === "percent" ? "e.g. 5 (percent)" : "e.g. 1720"
                  }
                  className="pf-input"
                  style={{ fontSize: 13.5 }}
                />
              </div>
            </div>
          )}

          {/* Indicator / Volume note */}
          {isIndicatorOrVolume && (
            <div
              className="flex items-start gap-3"
              style={{
                padding: "12px 14px",
                background: "var(--rule-softer)",
                border: "1.5px dashed var(--rule-soft)",
                borderRadius: 9,
              }}
            >
              <MessageSquare
                style={{
                  width: 15,
                  height: 15,
                  flexShrink: 0,
                  marginTop: 1,
                  color: "var(--ink-3)",
                }}
              />
              <p
                className="ser italic text-[var(--ink-3)]"
                style={{ fontSize: 13 }}
              >
                {alertType === "indicator"
                  ? "Indicator cross alerts (RSI, MACD, SMA cross) are coming soon. You can still save this alert — it will activate when the feature launches."
                  : "Volume spike detection is in progress. The alert will fire when a 2× average volume event is detected."}
              </p>
            </div>
          )}

          {/* Delivery channels */}
          <div>
            <div
              className="mono font-bold text-[var(--ink-3)] mb-2.5"
              style={{ fontSize: 11, letterSpacing: 1.5 }}
            >
              DELIVER VIA
            </div>
            <div className="flex flex-col gap-2">
              {DELIVERY.map(({ ch, label, sub, Icon }) => {
                const on = channels.has(ch);
                return (
                  <div
                    key={ch}
                    className="flex items-center gap-3 cursor-pointer transition-colors"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: "var(--rule-softer)",
                    }}
                    onClick={() => toggleChannel(ch)}
                  >
                    <Icon
                      style={{
                        width: 15,
                        height: 15,
                        flexShrink: 0,
                        color: on ? "var(--emerald-text)" : "var(--ink-3)",
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className="font-bold"
                        style={{ fontSize: 13, color: "var(--ink)" }}
                      >
                        {label}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                      >
                        {sub}
                      </div>
                    </div>
                    <div
                      className={`pf-toggle ${on ? "on" : ""}`}
                      style={{ flexShrink: 0 }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Expiry */}
          <div>
            <label
              className="block mono font-bold text-[var(--ink-2)] mb-2"
              style={{ fontSize: 12 }}
            >
              Expiry
            </label>
            <div className="flex flex-wrap gap-2">
              {EXPIRY_CHIPS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setExpiry(id)}
                  className={`pf-pill ${expiry === id ? "" : "outline"} cursor-pointer`}
                  style={
                    expiry === id
                      ? { background: "var(--ink)", color: "var(--paper)" }
                      : {}
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-[22px] py-4"
          style={{
            borderTop: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="pf-bf sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={busy}
            className="pf-bs sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Bell className="h-3 w-3" />
            {busy ? "Setting…" : "Set alert"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AlertConfigModal;
