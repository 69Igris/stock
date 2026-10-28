"use client";

import { X as XIcon } from "lucide-react";
import type { ActiveFilterChip } from "./suggested-filters-logic";

/**
 * The filters currently narrowing the screen, each removable (MONEY-1251).
 *
 * Exists because the sidebar's controls and the chat's reach were wildly out
 * of step: Ask Screener can set 17 MF fields against 3 rendered controls (11
 * ETF fields against 5). A chat-applied `minReturns5Y` or `plan` narrowed the
 * results while appearing NOWHERE in the UI — the user could see that
 * something was filtering, could not tell what, and could only undo it with
 * "Reset all".
 *
 * The chips are derived from the filter STATE rather than from which controls
 * exist, so nothing the chat can set is able to hide. That includes fields
 * whose sliders MONEY-367 pulled for sparse data: showing one is not reviving
 * the slider, it is admitting the filter is on.
 */
interface ActiveFilterChipsProps {
  chips: readonly ActiveFilterChip[];
  /** Clear the given filter keys. A range chip passes both bounds at once. */
  onRemove: (keys: string[]) => void;
  /** Heading text — "Active" reads better than "Applied" beside SUGGESTED. */
  label?: string;
}

export function ActiveFilterChips({
  chips,
  onRemove,
  label = "Active",
}: ActiveFilterChipsProps) {
  // Nothing filtering: render nothing rather than a bare heading, which reads
  // as a broken section.
  if (chips.length === 0) return null;

  return (
    <div className="pt-1">
      <div className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)] mb-2">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span
            key={c.keys.join("+")}
            className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1 py-[3px]"
            style={{
              border: "1.5px solid var(--emerald)",
              background: "var(--emerald-bg)",
              fontSize: 10.5,
              color: "var(--emerald-text)",
            }}
          >
            {c.label}
            <button
              type="button"
              onClick={() => onRemove(c.keys)}
              // A range chip clears BOTH bounds together — removing one half
              // would leave a filter still narrowing results with no chip.
              aria-label={`Remove filter ${c.label}`}
              title={`Remove ${c.label}`}
              className="grid place-items-center rounded-full"
              style={{ width: 14, height: 14, color: "var(--emerald-text)" }}
            >
              <XIcon className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export default ActiveFilterChips;
