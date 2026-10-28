"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, X as XIcon } from "lucide-react";

interface FilterCardProps {
  label: string;
  /** Short summary of the current filter value ("Large cap · ₹20k Cr+", "Any", "₹20–₹25"). */
  summary: string;
  /** True when the filter is narrowing results (emerald bg/border). */
  active: boolean;
  /** Optional reset handler - shows an "X" button when set AND active. */
  onClear?: () => void;
  /** Editor rendered inline beneath the summary when the card is open. */
  children: ReactNode;
  /** Start expanded. Useful when the user just added the filter. */
  defaultOpen?: boolean;
  /**
   * MONEY-1246 — optional CONTROLLED expand state.
   *
   * The card owned `open` internally, so nothing outside could expand a
   * specific filter. That is exactly what "+ Add filter" and the SUGGESTED
   * chips need to do, and it is why both shipped wired to empty callbacks.
   *
   * Controlled only when `open` is passed; omitted, the card keeps its own
   * state and every existing usage behaves identically.
   */
  open?: boolean;
  /** Required alongside `open` — the card cannot toggle itself when driven. */
  onOpenChange?: (next: boolean) => void;
  /**
   * Scroll target id, so a picker or chip can bring this card into view.
   * Rendered as the element's `id`.
   */
  id?: string;
}

/**
 * Generic filter card: mono-caps label + value summary on top, inline editor
 * beneath when expanded. Clicking the card header toggles the editor.
 *
 * Active filters (the ones narrowing results) get an emerald background +
 * border per Terminal Luxe design.
 */
export function FilterCard({
  label,
  summary,
  active,
  onClear,
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  id,
}: FilterCardProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  // MONEY-1246: controlled ONLY when a parent passes `open`. Undefined means
  // the card keeps its own state, so every pre-existing usage is untouched.
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    // Still tell the parent when controlled — otherwise clicking the header
    // of a driven card would appear to do nothing.
    if (isControlled) onOpenChange?.(next);
    else setUncontrolledOpen(next);
  };

  return (
    <div
      id={id}
      className="rounded-[10px] scroll-mt-4"
      style={{
        border: active
          ? "1.5px solid var(--emerald)"
          : "1.5px solid var(--ink)",
        background: active ? "var(--emerald-bg)" : "var(--paper)",
      }}
    >
      {/* Toggle and Clear are SIBLINGS, never nested: a <button> inside a
          <button> is invalid HTML and throws a React hydration error (the
          browser re-parses it as siblings, so server and client markup
          disagree). Keeping them side by side also gives the clear action
          its own tab stop instead of an unreachable nested control. */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex-1 min-w-0 px-3 py-2.5 text-left flex items-center gap-2 cursor-pointer"
        >
          <div className="flex-1 min-w-0">
            <div
              className="mono text-[10px] tracking-[1px] font-bold uppercase"
              style={{ color: active ? "var(--emerald-text)" : "var(--ink-3)" }}
            >
              {label}
            </div>
            <div
              className="text-[12.5px] font-semibold mt-0.5 truncate"
              style={{ color: active ? "var(--emerald-text)" : "var(--ink-2)" }}
            >
              {summary}
            </div>
          </div>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${
              open ? "rotate-180" : ""
            }`}
            style={{ color: active ? "var(--emerald-text)" : "var(--ink-3)" }}
          />
        </button>
        {active && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="p-0.5 mr-3 ml-1 shrink-0 transition-colors cursor-pointer"
            style={{ color: "var(--ink-3)" }}
            title="Clear filter"
            aria-label={`Clear ${label} filter`}
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div
          className="px-3 pb-3 pt-2.5 mt-0.5"
          style={{ borderTop: "1.5px dashed var(--rule-soft)" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default FilterCard;
