"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from "react";
import "./bits.css";

/**
 * PfSymbolPicker — reusable symbol selector for Feed & Alert creators.
 *
 * Features:
 *  - Single OR multi-select (mode prop)
 *  - Search input with pluggable data layer (fetchSymbols or static options)
 *  - NSE / BSE exchange chips with playful colour coding
 *  - EQUITY kind tag
 *  - Selected chips with remove button (multi) or inline clear (single)
 *  - Keyboard hint footer ("↑↓ navigate · Enter to add · N chosen")
 *  - Dropdown closes on outside click
 *  - Keyboard navigation (↑ ↓ Enter Escape)
 *  - Theme-aware via CSS vars — no hardcoded hex
 *  - No buy/sell/hold signals — informational only
 */

/* ── Symbol shape ───────────────────────────────────────────────────── */
export interface SymbolOption {
  /** Ticker symbol, e.g. "RELIANCE" */
  sym: string;
  /** Exchange, e.g. "NSE" | "BSE" */
  exch: string;
  /** Instrument kind, e.g. "EQUITY" */
  kind: string;
  /** Full company name */
  name?: string;
}

/* ── Props ──────────────────────────────────────────────────────────── */
export interface PfSymbolPickerProps {
  /** "single" = only one symbol at a time; "multi" = chip list */
  mode: "single" | "multi";

  /**
   * Currently selected symbol(s).
   * In single mode: [] means empty, [sym] means selected.
   * In multi mode: list of selected symbols.
   */
  value: SymbolOption[];

  /** Called with the new list of selected symbols on every change */
  onChange: (symbols: SymbolOption[]) => void;

  /**
   * Async search function that receives the search query and returns
   * matching SymbolOptions. If omitted, falls back to `options`.
   */
  fetchSymbols?: (query: string) => Promise<SymbolOption[]>;

  /**
   * Static list of options (used when fetchSymbols is not provided).
   * Defaults to the built-in sample list.
   */
  options?: SymbolOption[];

  /** Input placeholder text */
  placeholder?: string;

  /** Maximum dropdown results to show */
  maxResults?: number;
}

/* ── Default sample options ─────────────────────────────────────────── */
export const SAMPLE_SYMBOL_OPTIONS: SymbolOption[] = [
  { sym: "RELIANCE", exch: "NSE", kind: "EQUITY", name: "Reliance Industries" },
  { sym: "RELIANCE", exch: "BSE", kind: "EQUITY", name: "Reliance Industries" },
  { sym: "INFY", exch: "NSE", kind: "EQUITY", name: "Infosys Ltd" },
  {
    sym: "TCS",
    exch: "NSE",
    kind: "EQUITY",
    name: "Tata Consultancy Services",
  },
  { sym: "HDFCBANK", exch: "NSE", kind: "EQUITY", name: "HDFC Bank Ltd" },
  { sym: "ITC", exch: "NSE", kind: "EQUITY", name: "ITC Limited" },
  { sym: "BAJFIN", exch: "NSE", kind: "EQUITY", name: "Bajaj Finance" },
  { sym: "NCAPBUILAD", exch: "BSE", kind: "EQUITY", name: "Nippon India MF" },
];

/* ── Inline icons ───────────────────────────────────────────────────── */
function IconSearch({ size = 13 }: { size?: number }) {
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
      style={{ display: "block", flexShrink: 0, color: "var(--ink-3)" }}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconX({ size = 9 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/* Exchange chip colour class */
function exchClass(exch: string): string {
  if (exch === "NSE") return "nse";
  if (exch === "BSE") return "bse";
  return "other";
}

/* Symbol dedup key */
function symKey(s: SymbolOption): string {
  return `${s.sym}:${s.exch}`;
}

/* ── Component ──────────────────────────────────────────────────────── */
export function PfSymbolPicker({
  mode,
  value,
  onChange,
  fetchSymbols,
  options = SAMPLE_SYMBOL_OPTIONS,
  placeholder = "Search NSE / BSE — pick symbols to add",
  maxResults = 5,
}: PfSymbolPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SymbolOption[]>([]);
  const [highlighted, setHighlighted] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Close on outside click */
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  /* Search */
  const search = useCallback(
    async (q: string) => {
      let found: SymbolOption[];
      if (fetchSymbols) {
        found = await fetchSymbols(q);
      } else {
        const lower = q.toLowerCase();
        found = q
          ? options.filter(
              (s) =>
                s.sym.toLowerCase().includes(lower) ||
                (s.name ?? "").toLowerCase().includes(lower)
            )
          : options;
      }
      setResults(found.slice(0, maxResults));
      setHighlighted(0);
    },
    [fetchSymbols, options, maxResults]
  );

  useEffect(() => {
    search(query);
  }, [query, search]);

  /* Add a symbol to selection */
  function add(sym: SymbolOption) {
    if (mode === "single") {
      onChange([sym]);
    } else {
      const key = symKey(sym);
      if (!value.find((s) => symKey(s) === key)) {
        onChange([...value, sym]);
      }
    }
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  }

  /* Remove a symbol from selection */
  function remove(sym: SymbolOption) {
    const key = symKey(sym);
    onChange(value.filter((s) => symKey(s) !== key));
  }

  /* Keyboard nav */
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[highlighted]) add(results[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  /* Single-mode: show selected ticker in input */
  const singleSelected = mode === "single" ? value[0] : undefined;
  const inputValue = singleSelected ? singleSelected.sym : query;

  return (
    <div ref={containerRef} className="bits-sym-picker">
      {/* Selected chips (multi mode only) */}
      {mode === "multi" && value.length > 0 && (
        <div className="bits-sym-chips" role="list">
          {value.map((s) => (
            <span key={symKey(s)} className="bits-sym-chip" role="listitem">
              {s.sym}
              <button
                type="button"
                className="bits-sym-chip-remove"
                onClick={() => remove(s)}
                aria-label={`Remove ${s.sym}`}
              >
                <IconX size={9} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input row */}
      <div className={`bits-sym-input-wrap${open ? " is-open" : ""}`}>
        <IconSearch size={13} />
        <input
          ref={inputRef}
          type="text"
          className={`bits-sym-input${singleSelected ? " is-single-selected" : ""}`}
          value={inputValue}
          placeholder={singleSelected ? "" : placeholder}
          onChange={(e) => {
            if (singleSelected) {
              // Clear single selection when user starts typing
              onChange([]);
            }
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-label="Search symbols"
          aria-expanded={open}
          aria-controls="pf-symbol-listbox"
          aria-autocomplete="list"
          autoComplete="off"
        />
        {/* Clear button for single mode */}
        {mode === "single" && singleSelected && (
          <button
            type="button"
            className="bits-sym-clear"
            onClick={() => {
              onChange([]);
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear selected symbol"
          >
            <IconX size={13} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && results.length > 0 && (
        <div
          className="bits-sym-dropdown"
          role="listbox"
          aria-label="Symbol search results"
        >
          {results.map((s, i) => (
            <button
              key={symKey(s)}
              type="button"
              className={`bits-sym-result${i === highlighted ? " is-highlighted" : ""}`}
              style={{
                background:
                  i === highlighted ? "var(--rule-softer)" : "transparent",
              }}
              onClick={() => add(s)}
              role="option"
              aria-selected={value.some((v) => symKey(v) === symKey(s))}
            >
              <span className="bits-sym-result-ticker">{s.sym}</span>
              <span className={`bits-sym-exch ${exchClass(s.exch)}`}>
                {s.exch}
              </span>
              <span className="bits-sym-kind">{s.kind}</span>
              {s.name && <span className="bits-sym-name-col">{s.name}</span>}
            </button>
          ))}

          {/* Keyboard hint footer */}
          <div className="bits-sym-footer" aria-hidden>
            <span>↑↓ navigate</span>
            <span>Enter to add</span>
            {mode === "multi" && value.length > 0 && (
              <span className="bits-sym-footer-count">
                {value.length} chosen
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default PfSymbolPicker;
