"use client";

import "./bits.css";

/**
 * RefreshChip — a compact, clickable refresh control with 3 visual states.
 *
 * state="idle"       → shows "Refresh" (or lastSyncedLabel) + static icon
 * state="refreshing" → spinning icon + "Refreshing…" label
 * state="done"       → check / refresh icon in emerald-bg + "Updated X ago"
 *
 * Theme-aware (light / dark) via CSS vars — no hardcoded colours.
 */

export interface PfRefreshChipProps {
  /** Visual state of the chip */
  state: "idle" | "refreshing" | "done";
  /** Label shown in "done" state, e.g. "Updated 2s ago" */
  lastSyncedLabel?: string;
  /** Click handler (usually triggers a refresh action) */
  onClick?: () => void;
}

/* Inline SVG icons — stroke only, no fill, lucide-style */
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

export function PfRefreshChip({
  state,
  lastSyncedLabel = "just now",
  onClick,
}: PfRefreshChipProps) {
  const iconClass =
    state === "refreshing"
      ? "bits-refresh-icon is-refreshing"
      : state === "done"
        ? "bits-refresh-icon is-done"
        : "bits-refresh-icon is-idle";

  return (
    <button
      type="button"
      className="bits-refresh"
      onClick={onClick}
      aria-label={
        state === "refreshing"
          ? "Refreshing…"
          : state === "done"
            ? `Updated ${lastSyncedLabel}`
            : "Refresh"
      }
    >
      <span className={iconClass} aria-hidden>
        <IconRefresh size={11} />
      </span>

      <span className="bits-refresh-label">
        {state === "refreshing" ? (
          <>Refreshing…</>
        ) : state === "done" ? (
          <>
            Updated <strong>{lastSyncedLabel}</strong>
          </>
        ) : (
          <>Refresh</>
        )}
      </span>
    </button>
  );
}

export default PfRefreshChip;
