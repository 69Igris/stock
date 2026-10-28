"use client";

/**
 * "Advanced filters" toggle button for the Screener toolbar (MONEY-243,
 * design Image #42). When ON, the FilterSidebar is visible. When OFF,
 * the cards span the full width.
 *
 * State persists per-mode in localStorage so users who prefer the dense
 * card grid don't have to dismiss the sidebar every visit.
 */

import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";

export function useAdvancedFilters(storageKey: string, initiallyOpen = true) {
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "open" || stored === "closed") {
      setOpen(stored === "open");
    }
  }, [storageKey]);
  const update = (next: boolean) => {
    setOpen(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, next ? "open" : "closed");
    }
  };
  return [open, update] as const;
}

interface AdvancedFiltersToggleProps {
  open: boolean;
  onChange: (open: boolean) => void;
  /** Number of currently-active filters - shown as a badge when > 0. */
  activeCount?: number;
}

export function AdvancedFiltersToggle({
  open,
  onChange,
  activeCount = 0,
}: AdvancedFiltersToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!open)}
      aria-pressed={open}
      title={open ? "Hide filters" : "Show filters"}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] mono font-bold whitespace-nowrap transition-colors cursor-pointer"
      style={
        open
          ? {
              background: "var(--emerald)",
              color: "var(--paper)",
              border: "1.5px solid var(--emerald)",
            }
          : {
              background: "var(--paper)",
              color: "var(--ink)",
              border: "1.5px solid var(--ink)",
            }
      }
    >
      <SlidersHorizontal className="h-3.5 w-3.5" />
      {/* Three-tier label: icon-only on mobile (image #27 pattern so
          Cards/Table + Filters + Sort fit one row), short label on sm+,
          full "Advanced filters" only on lg+. */}
      <span className="hidden lg:inline">Advanced filters</span>
      <span className="hidden sm:inline lg:hidden">Filters</span>
      {activeCount > 0 && (
        <span
          className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-bold tabular-nums px-1"
          style={
            open
              ? { background: "var(--paper)", color: "var(--emerald-text)" }
              : { background: "var(--emerald)", color: "var(--paper)" }
          }
        >
          {activeCount}
        </span>
      )}
    </button>
  );
}

export default AdvancedFiltersToggle;
