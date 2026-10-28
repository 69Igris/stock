"use client";

/**
 * Lightweight searchable dropdown for the screener filter sidebar
 * (MONEY-243). Native `<select>` becomes unusable past ~30 options
 * (MF categories, ~50 AMCs) - this component layers a typeahead input
 * on top so users can find an option by typing the first few letters.
 *
 * No external dependency - keeps the bundle small and matches the
 * existing emerald/mono styling.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface SearchableOption {
  value: string;
  label: string;
  /** Optional badge - e.g. category count "(50)". */
  count?: number;
}

interface SearchableSelectProps {
  value: string | null;
  onChange: (next: string | null) => void;
  options: ReadonlyArray<SearchableOption>;
  /** Label shown when no value is selected (e.g. "All categories"). */
  placeholder?: string;
  /** Label for the "no value" sentinel option in the menu. Defaults to
   *  the placeholder. */
  allLabel?: string;
  /** Aria-label for the open button. */
  ariaLabel?: string;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "All",
  allLabel,
  ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Focus the search input on open so the user can type immediately.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
    }
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selectedLabel = useMemo(() => {
    if (!value) return placeholder;
    return options.find((o) => o.value === value)?.label ?? placeholder;
  }, [value, options, placeholder]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel ?? placeholder}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[8px] text-[12px] mono text-[var(--ink)] focus:outline-none cursor-pointer"
        style={{ background: "var(--paper)", border: "1.5px solid var(--ink)" }}
      >
        <span className="truncate flex-1 text-left">
          {value ? selectedLabel : placeholder}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-[var(--ink-3)]" />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 w-full overflow-hidden"
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 12,
            boxShadow: "var(--shadow-soft)",
          }}
        >
          <div
            className="flex items-center gap-2 px-2.5 py-2"
            style={{ borderBottom: "1.5px solid var(--rule-soft)" }}
          >
            <Search className="h-3 w-3 text-[var(--ink-3)] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent text-[12px] mono text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:outline-none"
            />
          </div>
          <div className="max-h-[260px] overflow-y-auto py-1">
            {/* "All" sentinel - always at the top. */}
            <SelectRow
              label={allLabel ?? placeholder}
              selected={value == null}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            />
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-center text-[11px] mono text-[var(--ink-3)]">
                No matches
              </div>
            ) : (
              filtered.map((o) => (
                <SelectRow
                  key={o.value}
                  label={o.label}
                  count={o.count}
                  selected={value === o.value}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectRow({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 mx-1 px-2.5 py-1.5 rounded-[7px] text-[12px] mono cursor-pointer transition-colors"
      style={
        selected
          ? {
              background: "var(--emerald)",
              color: "var(--paper)",
              width: "calc(100% - 8px)",
            }
          : { color: "var(--ink-2)", width: "calc(100% - 8px)" }
      }
    >
      <Check
        className={`h-3 w-3 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`}
      />
      <span className="flex-1 text-left truncate">{label}</span>
      {count != null && count > 0 && (
        <span
          className="text-[10.5px] tabular-nums"
          style={{ opacity: selected ? 0.85 : 0.55 }}
        >
          {count.toLocaleString("en-IN")}
        </span>
      )}
    </button>
  );
}

export default SearchableSelect;
