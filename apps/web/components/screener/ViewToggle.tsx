"use client";

/**
 * Cards / Table view toggle - used by the Screener stocks-mode pane.
 * Persists per-tab in localStorage so refresh returns to the user's
 * last preference.
 */

import { useEffect, useState } from "react";
import { LayoutGrid, List } from "lucide-react";

export type ScreenerView = "cards" | "table";

interface ViewToggleProps {
  /** Storage key - used in uncontrolled mode (the toggle owns state). */
  storageKey?: string;
  /** Default view if nothing is stored yet. Tickertape pattern → cards. */
  defaultView?: ScreenerView;
  /** Controlled mode - when both `value` and `onChange` are provided,
   *  the parent owns the state and the toggle just renders + dispatches.
   *  This is the path stocks/mf/etf modes use so clicking the toggle
   *  re-renders the results pane immediately (no localStorage round
   *  trip + no second `useScreenerView` instance to drift apart). */
  value?: ScreenerView;
  onChange?: (next: ScreenerView) => void;
}

export function useScreenerView(
  storageKey: string,
  defaultView: ScreenerView = "cards"
) {
  // Hydration-safe: start with `defaultView` on the server and read storage in
  // a useEffect so the initial render matches between server and client.
  const [view, setView] = useState<ScreenerView>(defaultView);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "cards" || stored === "table") setView(stored);
  }, [storageKey]);

  const update = (next: ScreenerView) => {
    setView(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, next);
    }
  };

  return [view, update] as const;
}

export function ViewToggle({
  storageKey,
  defaultView = "cards",
  value,
  onChange,
}: ViewToggleProps) {
  // Controlled mode: parent owns the state. Uncontrolled mode falls
  // back to the localStorage hook so callers that don't care about
  // tight coupling still work.
  const isControlled = value !== undefined && onChange !== undefined;
  const [internalView, setInternalView] = useScreenerView(
    storageKey ?? "screener.view._default",
    defaultView
  );
  const view = isControlled ? value : internalView;
  const setView = (next: ScreenerView) => {
    if (isControlled) {
      onChange!(next);
    } else {
      setInternalView(next);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Results view"
      className="inline-flex items-center gap-[2px] rounded-[8px] p-[2px]"
      style={{ border: "1.5px solid var(--ink)", background: "var(--paper-2)" }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === "cards"}
        aria-label="Cards view"
        onClick={() => setView("cards")}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] mono font-bold cursor-pointer transition-colors"
        style={
          view === "cards"
            ? { background: "var(--ink)", color: "var(--paper)" }
            : { background: "transparent", color: "var(--ink-3)" }
        }
      >
        <LayoutGrid className="h-3 w-3" />
        {/* Hide label on small screens so the toolbar fits the same row
            as Filters + Sort. Tooltip-equivalent stays via aria-label. */}
        <span className="hidden sm:inline">Cards</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "table"}
        aria-label="Table view"
        onClick={() => setView("table")}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] mono font-bold cursor-pointer transition-colors"
        style={
          view === "table"
            ? { background: "var(--ink)", color: "var(--paper)" }
            : { background: "transparent", color: "var(--ink-3)" }
        }
      >
        <List className="h-3 w-3" />
        <span className="hidden sm:inline">Table</span>
      </button>
    </div>
  );
}

export default ViewToggle;
