"use client";

import type { ReactNode } from "react";
import "./bits.css";

/**
 * PfLiveMtmBanner — the LIVE M2M banner used on Holdings / Positions pages.
 *
 * Layout (mobile-first, two rows):
 *  ROW 1 — LIVE pill │ amount + delta (nowrap, never split) │ timestamp │ refresh
 *  ROW 2 — responsive stats grid: repeat(auto-fit, minmax(130px,1fr))
 *
 * No buy/sell/hold signals. Informational only.
 * Theme-aware via CSS vars — no hardcoded colours.
 */

export interface MtmStatItem {
  label: string;
  value: ReactNode;
  /** Optional tone for coloured value text */
  tone?: "pos" | "neg" | "neutral";
}

export interface PfLiveMtmBannerProps {
  /** Big M2M figure, e.g. "+₹24,820" — include sign */
  amount: string;
  /** Delta change amount, e.g. "+₹1,240" or "-₹820" */
  delta?: string;
  /** Delta as a percent string, e.g. "0.94%" — sign inferred from deltaPct sign */
  deltaPct?: number;
  /** Footer timestamp string, e.g. "today · since 09:15" */
  lastUpdated?: string;
  /** Stats grid items shown in row 2 */
  stats?: MtmStatItem[];
  /** Callback for the refresh chip click */
  onRefresh?: () => void;
  /** Current refresh state */
  refreshState?: "idle" | "refreshing" | "done";
  /** Label shown on refresh chip when done */
  refreshLabel?: string;
}

/* Inline icons — stroke only */
function IconRefresh({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </svg>
  );
}

/* Inline RefreshChip (avoids a circular dep if bits.css is already loaded) */
function MiniRefreshChip({
  state,
  label,
  onClick,
}: {
  state: "idle" | "refreshing" | "done";
  label: string;
  onClick?: () => void;
}) {
  const iconClass =
    state === "refreshing"
      ? "bits-refresh-icon is-refreshing"
      : "bits-refresh-icon is-done";

  return (
    <button
      type="button"
      className="bits-refresh"
      onClick={onClick}
      aria-label={state === "refreshing" ? "Refreshing…" : `Updated ${label}`}
    >
      <span className={iconClass} aria-hidden>
        <IconRefresh size={11} />
      </span>
      <span className="bits-refresh-label">
        {state === "refreshing" ? (
          <>Refreshing…</>
        ) : (
          <>
            Updated <strong>{label}</strong>
          </>
        )}
      </span>
    </button>
  );
}

export function PfLiveMtmBanner({
  amount,
  delta,
  deltaPct,
  lastUpdated = "today · since 09:15",
  stats = [],
  onRefresh,
  refreshState = "done",
  refreshLabel = "just now",
}: PfLiveMtmBannerProps) {
  const isPositive = deltaPct == null ? !amount.startsWith("-") : deltaPct >= 0;
  const absDeltaPct =
    deltaPct != null ? Math.abs(deltaPct).toFixed(2) : undefined;

  return (
    <div className="pf-card bits-mtm-inner" style={{ boxShadow: "none" }}>
      {/* ── Row 1: LIVE pill + amount block + refresh ── */}
      <div className="bits-mtm-row1">
        {/* LIVE pill */}
        <div className="bits-live-pill" aria-label="Live mark-to-market">
          <span className="bits-live-dot" aria-hidden />
          LIVE MTM
        </div>

        {/* Amount + delta — whiteSpace:nowrap keeps + and number on one line */}
        <div className="bits-mtm-amount-block">
          <span className="bits-mtm-amount">{amount}</span>

          {absDeltaPct != null && (
            <span className={`bits-mtm-delta ${isPositive ? "pos" : "neg"}`}>
              {isPositive ? "▲" : "▼"} {absDeltaPct}%
            </span>
          )}

          {delta && !absDeltaPct && (
            <span className={`bits-mtm-delta ${isPositive ? "pos" : "neg"}`}>
              {isPositive ? "▲" : "▼"} {delta}
            </span>
          )}
        </div>

        {/* Timestamp */}
        {lastUpdated && (
          <span className="bits-mtm-timestamp">{lastUpdated}</span>
        )}

        {/* Refresh chip — pushed to right via margin-left: auto */}
        <div className="bits-mtm-refresh">
          <MiniRefreshChip
            state={refreshState}
            label={refreshLabel}
            onClick={onRefresh}
          />
        </div>
      </div>

      {/* ── Row 2: stats grid ── */}
      {stats.length > 0 && (
        <div className="bits-mtm-stats">
          {stats.map((stat, i) => (
            <div key={i}>
              <div className="bits-stat-label">{stat.label}</div>
              <div
                className={`bits-stat-value${stat.tone === "pos" ? " pos" : stat.tone === "neg" ? " neg" : ""}`}
              >
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default PfLiveMtmBanner;
