"use client";

/**
 * Roast Scope Picker - design pages/Roast.jsx hero card.
 *
 * Two sections stacked vertically:
 *   1. WHAT TO ROAST - 4 options: All synced / Specific broker /
 *      Tradebook subset / Watchlist
 *   2. TIME RANGE - 5 options: All-time / Last 30 days / FY 2026 /
 *      FY 2025 / Custom range
 *
 * State is owned by the parent so the big "Roast me on this scope"
 * CTA below the picker can translate the choices into RoastParams.
 */

import {
  Globe,
  Link2,
  BookOpen,
  Eye,
  Calendar as CalendarIcon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  BrokerLogo,
  toBrokerSlug,
} from "@/components/terminal-luxe/primitives";

type ScopeSource = "all-synced" | "broker" | "tradebook" | "watchlist";
type TimeRange = "all-time" | "last-30d" | "fy-2026" | "fy-2025" | "custom";

interface BrokerOption {
  value: string;
  label: string;
}

type AssetType = "stocks" | "mf" | "all";

interface Props {
  scopeSource: ScopeSource;
  setScopeSource: (v: ScopeSource) => void;
  timeRange: TimeRange;
  setTimeRange: (v: TimeRange) => void;
  /** Single-broker selection (revert from multi). RoastParams.broker is singular. */
  selectedBroker: string;
  setSelectedBroker: (v: string) => void;
  brokerOptions: BrokerOption[];
  assetType: AssetType;
  setAssetType: (v: AssetType) => void;
  isFreeUser: boolean;
  /** Real holdings count from /api - no dummy fallback. */
  totalHoldings: number;
  /** Total portfolio value (₹). When > 0, shows alongside the holding count. */
  totalValue: number;
  /** MONEY-837: tradebook-subset inputs (shown for the "Tradebook subset" scope). */
  tradeSymbols: string;
  setTradeSymbols: (v: string) => void;
  customFrom: string;
  setCustomFrom: (v: string) => void;
  customTo: string;
  setCustomTo: (v: string) => void;
}

const SCOPE_OPTIONS: Array<{
  id: ScopeSource;
  Icon: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  label: string;
  sub: string;
  comingSoon?: boolean;
}> = [
  {
    id: "all-synced",
    Icon: Globe,
    label: "All synced",
    sub: "every broker + manual",
  },
  {
    id: "broker",
    Icon: Link2,
    label: "Specific broker",
    sub: "Zerodha · Upstox · …",
  },
  {
    id: "tradebook",
    Icon: BookOpen,
    label: "Tradebook subset",
    sub: "date range OR symbols",
  },
  {
    id: "watchlist",
    Icon: Eye,
    label: "Watchlist",
    sub: "any saved list",
    comingSoon: true,
  },
];

const TIME_OPTIONS: Array<{ id: TimeRange; label: string }> = [
  { id: "all-time", label: "All-time" },
  { id: "last-30d", label: "Last 30 days" },
  { id: "fy-2026", label: "FY 2026" },
  { id: "fy-2025", label: "FY 2025" },
  { id: "custom", label: "Custom range" },
];

const ASSET_OPTIONS: Array<{ id: AssetType; label: string }> = [
  { id: "all", label: "All assets" },
  { id: "stocks", label: "Stocks" },
  { id: "mf", label: "Mutual funds" },
];

function fmtPortfolioValue(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1_00_00_000) return `· ₹${(v / 1_00_00_000).toFixed(2)} Cr`;
  if (v >= 1_00_000) return `· ₹${(v / 1_00_000).toFixed(2)} L`;
  return `· ₹${Math.round(v).toLocaleString("en-IN")}`;
}

export default function RoastScopePicker({
  scopeSource,
  setScopeSource,
  timeRange,
  setTimeRange,
  selectedBroker,
  setSelectedBroker,
  brokerOptions,
  assetType,
  setAssetType,
  isFreeUser,
  totalHoldings,
  totalValue,
  tradeSymbols,
  setTradeSymbols,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
}: Props) {
  // Free users are locked to "all synced" - match the existing free
  // restriction. Show all options but disable the others.

  return (
    <div className="pf-card mb-5">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <CalendarIcon
          className="h-3.5 w-3.5"
          style={{ color: "var(--pop-1)" }}
        />
        <span
          className="font-mono text-[11px] uppercase tracking-[1.5px] font-bold"
          style={{ color: "var(--pop-1)" }}
        >
          Roast Scope
        </span>
        <div className="flex-1" />
        {totalHoldings > 0 && (
          <span className="font-mono text-[11px] text-[var(--ink-3)]">
            {totalHoldings} holding{totalHoldings === 1 ? "" : "s"}{" "}
            {fmtPortfolioValue(totalValue)}
          </span>
        )}
      </div>

      {/* Section 1 - WHAT TO ROAST */}
      <div className="font-mono text-[10.5px] tracking-[1.3px] text-[var(--ink-3)] font-semibold mb-2.5">
        <span style={{ color: "var(--pop-1)" }}>1</span> · WHAT TO ROAST
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-5">
        {SCOPE_OPTIONS.map((opt) => {
          const isActive = scopeSource === opt.id;
          const disabled =
            (isFreeUser && opt.id !== "all-synced") || opt.comingSoon === true;
          const reason = opt.comingSoon
            ? "Watchlist scope launches with the next roast worker"
            : disabled
              ? "Upgrade to Pro to roast a custom scope"
              : "";
          return (
            <button
              key={opt.id}
              onClick={() => !disabled && setScopeSource(opt.id)}
              disabled={disabled}
              className="text-left p-3.5 rounded-lg border-[1.5px] transition-colors relative"
              style={{
                background: isActive
                  ? "color-mix(in srgb, var(--pop-1) 12%, transparent)"
                  : "var(--rule-softer)",
                borderColor: isActive ? "var(--pop-1)" : "var(--rule-soft)",
                opacity: disabled && !isActive ? 0.6 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
              title={reason}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <opt.Icon
                  className="h-3.5 w-3.5"
                  style={{
                    color: isActive ? "var(--pop-1)" : "var(--ink-3)",
                  }}
                />
                <span
                  className="text-[13px] font-semibold"
                  style={{ color: isActive ? "var(--pop-1)" : "var(--ink)" }}
                >
                  {opt.label}
                </span>
                {opt.comingSoon && (
                  <span
                    className="ml-auto font-mono text-[8.5px] tracking-[1px] font-bold px-1.5 py-[1px] rounded border-[1.5px]"
                    style={{
                      background:
                        "color-mix(in srgb, var(--pop-2) 18%, transparent)",
                      color: "var(--pop-2)",
                      borderColor:
                        "color-mix(in srgb, var(--pop-2) 35%, transparent)",
                    }}
                  >
                    SOON
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-[var(--ink-3)] leading-snug">
                {opt.sub}
              </div>
            </button>
          );
        })}
      </div>

      {/* Broker dropdown - visible only when "Specific broker" scope (Image #45) */}
      {scopeSource === "broker" && brokerOptions.length > 0 && (
        <div className="mb-5 flex items-center gap-3 flex-wrap">
          <span className="font-mono text-[10.5px] uppercase tracking-[1.2px] text-[var(--ink-3)] font-semibold">
            Brokers
          </span>
          <Select
            value={selectedBroker || brokerOptions[0]?.value}
            onValueChange={setSelectedBroker}
          >
            <SelectTrigger
              className="w-auto min-w-[200px] h-8 px-2.5 font-mono text-[12px] font-semibold border-[1.5px]"
              style={{
                background: "color-mix(in srgb, var(--pop-1) 12%, transparent)",
                borderColor:
                  "color-mix(in srgb, var(--pop-1) 35%, transparent)",
                color: "var(--pop-1)",
              }}
            >
              <span className="inline-flex items-center gap-2">
                <BrokerLogo
                  slug={toBrokerSlug(
                    (selectedBroker || brokerOptions[0]?.value || "").split(
                      ":"
                    )[0]
                  )}
                  size={16}
                />
                <SelectValue placeholder="Pick a broker" />
              </span>
            </SelectTrigger>
            <SelectContent>
              {brokerOptions.map((b) => (
                <SelectItem
                  key={b.value}
                  value={b.value}
                  className="font-mono text-[12px]"
                >
                  <span className="inline-flex items-center gap-2">
                    <BrokerLogo
                      slug={toBrokerSlug(b.value.split(":")[0])}
                      size={14}
                    />
                    {b.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!selectedBroker && (
            <span
              className="font-mono text-[10.5px]"
              style={{ color: "var(--pop-2)" }}
            >
              Pick a broker
            </span>
          )}
        </div>
      )}

      {/* MONEY-837: tradebook-subset symbols input (the "specific trade" scope) */}
      {scopeSource === "tradebook" && (
        <div className="mb-5 flex items-center gap-3 flex-wrap">
          <span className="font-mono text-[10.5px] uppercase tracking-[1.2px] text-[var(--ink-3)] font-semibold">
            Symbols
          </span>
          <input
            type="text"
            value={tradeSymbols}
            onChange={(e) => setTradeSymbols(e.target.value)}
            placeholder="e.g. RELIANCE, INFY (blank = all)"
            className="font-mono text-[12px] px-2.5 py-1.5 rounded-md border-[1.5px] min-w-[240px]"
            style={{
              background: "var(--rule-softer)",
              borderColor: "var(--rule-soft)",
              color: "var(--ink)",
            }}
          />
        </div>
      )}

      {/* Asset type chip-select - applies to all scopes except watchlist */}
      {scopeSource !== "watchlist" && (
        <div className="mb-5 flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10.5px] uppercase tracking-[1.2px] text-[var(--ink-3)] font-semibold">
            Asset
          </span>
          {ASSET_OPTIONS.map((a) => {
            const active = assetType === a.id;
            return (
              <button
                key={a.id}
                onClick={() => setAssetType(a.id)}
                className="px-2.5 py-1 rounded-md text-[12px] font-medium border-[1.5px] transition-colors"
                style={{
                  background: active
                    ? "color-mix(in srgb, var(--pop-1) 12%, transparent)"
                    : "var(--rule-softer)",
                  borderColor: active
                    ? "color-mix(in srgb, var(--pop-1) 30%, transparent)"
                    : "var(--rule-soft)",
                  color: active ? "var(--pop-1)" : "var(--ink-3)",
                }}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Section 2 - TIME RANGE */}
      <div className="font-mono text-[10.5px] tracking-[1.3px] text-[var(--ink-3)] font-semibold mb-2.5">
        <span style={{ color: "var(--pop-1)" }}>2</span> · TIME RANGE
      </div>
      <div className="flex flex-wrap gap-2">
        {TIME_OPTIONS.map((opt) => {
          const isActive = timeRange === opt.id;
          return (
            <button
              key={opt.id}
              onClick={() => setTimeRange(opt.id)}
              className="px-3.5 py-2 rounded-lg text-[12.5px] font-medium border-[1.5px] transition-colors"
              style={{
                background: isActive
                  ? "var(--emerald-bg)"
                  : "var(--rule-softer)",
                borderColor: isActive
                  ? "color-mix(in srgb, var(--emerald) 35%, transparent)"
                  : "var(--rule-soft)",
                color: isActive ? "var(--emerald)" : "var(--ink-3)",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* MONEY-837: custom date-range inputs for the tradebook subset */}
      {timeRange === "custom" && (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            aria-label="From date"
            className="font-mono text-[12px] px-2.5 py-1.5 rounded-md border-[1.5px]"
            style={{
              background: "var(--rule-softer)",
              borderColor: "var(--rule-soft)",
              color: "var(--ink)",
            }}
          />
          <span className="font-mono text-[11px] text-[var(--ink-3)]">to</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            aria-label="To date"
            className="font-mono text-[12px] px-2.5 py-1.5 rounded-md border-[1.5px]"
            style={{
              background: "var(--rule-softer)",
              borderColor: "var(--rule-soft)",
              color: "var(--ink)",
            }}
          />
        </div>
      )}
    </div>
  );
}
