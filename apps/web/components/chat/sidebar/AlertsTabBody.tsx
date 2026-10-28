"use client";

/**
 * Alerts tab body — playful redesign (MONEY-483).
 *
 * Empty state: tilted coral sticker with AlertTriangle icon (matching
 * chat-sidebar.jsx AlertsBody), "Build from this chat" dashed-emerald
 * promo card, and a pf-bs CTA.
 * Loaded state: compact playful alert rows.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Plus,
  TrendingDown,
  BarChart3,
  Type,
  Calendar as CalendarIcon,
  Loader2,
  Sparkles,
  AlertTriangle,
  ShieldAlert,
  PackageCheck,
  Lock,
  UsersRound,
  Activity,
  ArrowLeftRight,
} from "lucide-react";
import {
  listAlertsAction,
  type AlertItem,
  type AlertKind,
} from "@/lib/actions/alerts";
import NewAlertDrawer from "@/app/discover/news/NewAlertDrawer";

interface Props {
  /** Tickers parsed out of the current chat. Drives "Build from this chat". */
  detectedSymbols?: string[];
}

const KIND_ICON: Record<
  AlertKind,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  PRICE: TrendingDown,
  VOLUME: BarChart3,
  NEWS: Type,
  EARNINGS_DATE: CalendarIcon,
  CORPORATE_ACTION: CalendarIcon,
  CUSTOM: BarChart3,
  // MONEY-1204 / 14e.3 — data-engine kinds. This Record is deliberately
  // EXHAUSTIVE over AlertKind, so extending that union without adding an icon
  // here is a compile error two packages away rather than a blank cell at
  // runtime. That is the behaviour to keep, not to work around.
  FLAG_TRANSITION: ShieldAlert,
  DELIVERY_SPIKE: PackageCheck,
  PLEDGE_INCREASE: Lock,
  INSIDER_CLUSTER: UsersRound,
  MWPL_HIGH: Activity,
  FII_FLOW_STREAK: ArrowLeftRight,
};

/** A stored condition value, or null when the key is absent or unusable. */
function num(c: Record<string, unknown>, k: string): number | null {
  const v = c[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function count(c: Record<string, unknown>, k: string): number | null {
  const v = c[k];
  return Array.isArray(v) && v.length > 0 ? v.length : null;
}
function str(c: Record<string, unknown>, k: string): string | null {
  const v = c[k];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Row title per kind. EXHAUSTIVE over `AlertKind`, for the same reason
 * `KIND_ICON` above is: adding a kind without a title is then a compile error
 * rather than a wrong label at runtime.
 *
 * This replaced a five-branch ternary that fell through to
 * `${symbol ?? "Custom"} alert`, so all six MONEY-1204 kinds listed as
 * "TCS alert" — and a correctly symbol-less FII_FLOW_STREAK as "Custom alert".
 * The icon map two lines up was exhaustive and correct the whole time; the
 * ternary beside it was not. That is the shape of nearly every defect this
 * feature had: what the compiler checked was right, what it did not was wrong.
 *
 * A missing condition value omits its clause rather than printing a default.
 * The drawer always writes these keys now, so an absent one means an alert made
 * before that fix or by another client — and the evaluator's fallback lives in
 * `alert-evaluator-logic.ts`, where it can change without this file knowing.
 * Showing a number we did not read would be a guess presented as a setting.
 */
export const KIND_TITLE: Record<
  AlertKind,
  (a: AlertItem, c: Record<string, unknown>) => string
> = {
  PRICE: (a, c) => {
    const t = num(c, "threshold");
    if (t === null) return `${a.symbol ?? "Price"} price alert`;
    return `${a.symbol} ${c.direction === "above" ? ">" : "<"} ₹${t}`;
  },
  VOLUME: (a, c) => {
    const m = num(c, "multiplier");
    return m === null
      ? `${a.symbol} volume spike`
      : `${a.symbol} > ${m}× avg-30d`;
  },
  NEWS: (a, c) => {
    const kw = str(c, "value");
    return `News: ${a.symbol ?? "any"}${kw ? ` + '${kw}'` : ""}`;
  },
  EARNINGS_DATE: (a, c) => {
    const d = num(c, "daysBefore");
    return d === null
      ? `${a.symbol} earnings`
      : `${a.symbol} earnings · T-${d}`;
  },
  CORPORATE_ACTION: (a) => `${a.symbol ?? "Any"} corporate action`,
  CUSTOM: (a) => `${a.symbol ?? "Custom"} rule`,
  // MONEY-1204 / 14e.3 — the six data-engine kinds.
  FLAG_TRANSITION: (a, c) => {
    const n = count(c, "kinds");
    return `${a.symbol} · exchange flag${n === null ? "" : ` (${n})`}`;
  },
  DELIVERY_SPIKE: (a, c) => {
    const m = num(c, "multiplier");
    return m === null
      ? `${a.symbol} delivery spike`
      : `${a.symbol} delivery > ${m}× avg`;
  },
  PLEDGE_INCREASE: (a, c) => {
    const d = num(c, "minDeltaPp");
    return d === null
      ? `${a.symbol} pledge increase`
      : `${a.symbol} pledge +${d}pp`;
  },
  INSIDER_CLUSTER: (a, c) => {
    const e = num(c, "minEvents");
    const w = num(c, "windowDays");
    if (e === null) return `${a.symbol} insider cluster`;
    return `${a.symbol} · ${e}+ insider${w === null ? "" : ` / ${w}d`}`;
  },
  MWPL_HIGH: (a, c) => {
    const t = num(c, "threshold");
    return t === null ? `${a.symbol} MWPL high` : `${a.symbol} MWPL > ${t}%`;
  },
  // Market-wide by design — it has no symbol, and inventing one was the old
  // fall-through's "Custom alert".
  FII_FLOW_STREAK: (_a, c) => {
    const cat = str(c, "category");
    const d = num(c, "minDays");
    return `${cat ?? "FII/DII"} flow${d === null ? " streak" : ` · ${d}d streak`}`;
  },
};

function relTime(d: Date): string {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

export default function AlertsTabBody({ detectedSymbols = [] }: Props) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPrefill, setDrawerPrefill] = useState<string | undefined>(
    undefined
  );

  const openDrawer = (prefill?: string) => {
    setDrawerPrefill(prefill);
    setDrawerOpen(true);
  };

  const refresh = () => {
    setLoading(true);
    listAlertsAction()
      .then((r) => {
        if (r?.success && r.data) setAlerts(r.data);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <>
      <div
        className="pf-noscrollbar"
        style={{ flex: 1, overflowY: "auto", padding: "14px 12px 18px" }}
      >
        {/* Section header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
            padding: "0 2px",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}
          >
            Active alerts
          </span>
          <button
            type="button"
            onClick={() => openDrawer()}
            aria-label="New alert"
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              border: "1.25px solid var(--ink)",
              background: "var(--paper)",
              color: "var(--ink)",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
              boxShadow: "1.5px 1.5px 0 var(--ink)",
            }}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        {/* Build-from-chat promo — dashed emerald card (per design) */}
        <button
          type="button"
          onClick={() =>
            openDrawer(
              detectedSymbols.length > 0 ? detectedSymbols[0] : undefined
            )
          }
          className="pf-card"
          style={{
            width: "100%",
            padding: 12,
            background: "var(--emerald-bg)",
            borderColor: "var(--emerald)",
            borderStyle: "dashed",
            borderWidth: 1.5,
            boxShadow: "none",
            marginBottom: 14,
            textAlign: "left",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginBottom: 4,
            }}
          >
            <Sparkles
              className="h-3 w-3 shrink-0"
              style={{ color: "var(--emerald-text)" }}
            />
            <span
              style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}
            >
              Build from this chat
            </span>
          </div>
          <div
            className="ser"
            style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.35 }}
          >
            {detectedSymbols.length > 0
              ? `Detected: ${detectedSymbols.slice(0, 6).join(", ")}`
              : "Mention a ticker in chat to auto-fill."}
          </div>
        </button>

        {loading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "24px 0",
              color: "var(--ink-3)",
              fontSize: 12,
            }}
          >
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : alerts.length === 0 ? (
          /* Empty state — tilted coral sticker matching chat-sidebar.jsx AlertsBody */
          <div
            className="pf-card"
            style={{
              padding: "20px 14px",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              boxShadow: "3px 3px 0 var(--ink)",
            }}
          >
            {/* Tilted coral icon tile */}
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: "var(--pop-1)",
                border: "1.5px solid var(--ink)",
                display: "grid",
                placeItems: "center",
                transform: "rotate(-5deg)",
                boxShadow: "2.5px 2.5px 0 var(--ink)",
                color: "var(--paper)",
                flexShrink: 0,
              }}
            >
              <AlertTriangle className="h-[18px] w-[18px]" strokeWidth={2.25} />
            </div>

            <p
              className="ser"
              style={{
                fontSize: 14,
                color: "var(--ink-2)",
                lineHeight: 1.35,
                margin: "0 4px",
              }}
            >
              No alerts yet. Set one and we&apos;ll ping you.
            </p>

            <button
              type="button"
              onClick={() => openDrawer()}
              className="pf-bs sm"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 12px",
                fontSize: 12,
              }}
            >
              <Plus className="h-3 w-3" />
              Create first alert
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {alerts.slice(0, 6).map((a) => {
                const Icon = KIND_ICON[a.kind] ?? BarChart3;
                const conditions = a.conditions as Record<string, unknown>;
                const title = (KIND_TITLE[a.kind] ?? KIND_TITLE.CUSTOM)(
                  a,
                  conditions
                );
                return (
                  <Link
                    key={a.id}
                    href="/notifications?filter=alerts"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "8px 8px",
                      borderRadius: 7,
                      border: "1.5px solid transparent",
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--rule-softer)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <Icon
                      className="h-3.5 w-3.5 shrink-0 mt-0.5"
                      style={{ color: "var(--ink-3)" }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontWeight: 600,
                        }}
                      >
                        {title}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 9.5,
                          color: "var(--ink-4)",
                          marginTop: 2,
                          letterSpacing: 0.5,
                        }}
                      >
                        {relTime(a.lastFiredAt ?? a.createdAt)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
            <div style={{ padding: "8px 4px 0" }}>
              <Link
                href="/notifications?filter=alerts"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--emerald-text)",
                  textDecoration: "none",
                }}
              >
                View all alerts →
              </Link>
            </div>
          </>
        )}
      </div>

      <NewAlertDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setDrawerPrefill(undefined);
        }}
        onCreated={refresh}
        prefilledSymbol={drawerPrefill}
      />
    </>
  );
}
