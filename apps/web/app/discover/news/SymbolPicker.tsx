"use client";

/**
 * Shared symbol autocomplete combo box wired to
 * /api/market/autocomplete (Atlas Search edgeGram with Prisma
 * fallback).
 *
 * Single-select only — committing a symbol calls `onChange(symbol)`.
 * Parents that need a list of symbols should keep their own state and
 * use this picker as the input for adding one at a time (clear `value`
 * after onChange to reset, see NewFeedDrawer).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Search } from "lucide-react";

export interface PickerHit {
  symbol: string;
  name: string;
  type?: string;
  exchange?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Called when a hit is committed (Enter / click). For "add to list"
   *  flows the parent typically clears `value` from inside this. */
  onCommit?: (hit: PickerHit) => void;
  placeholder?: string;
}

export default function SymbolPicker({
  value,
  onChange,
  onCommit,
  placeholder = "Symbol / index",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [hits, setHits] = useState<PickerHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) setQuery(value);
  }, [value, open]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const fetchHits = useCallback(async (q: string) => {
    if (!q || q.trim().length < 1) {
      setHits([]);
      return;
    }
    setLoading(true);
    try {
      const url = `/api/market/autocomplete?q=${encodeURIComponent(q)}&limit=8`;
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) {
        setHits([]);
        return;
      }
      const json = (await r.json()) as {
        success?: boolean;
        results?: PickerHit[];
      };
      setHits(json.results ?? []);
    } catch {
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (open) void fetchHits(query);
    }, 180);
    return () => clearTimeout(handle);
  }, [query, open, fetchHits]);

  const commit = (hit: PickerHit) => {
    onChange(hit.symbol.toUpperCase());
    onCommit?.(hit);
    setQuery(hit.symbol.toUpperCase());
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hits[highlight]) commit(hits[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.toUpperCase();
    setQuery(v);
    onChange(v);
    setOpen(true);
    setHighlight(0);
  };

  return (
    <div className="relative" ref={containerRef}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
      <input
        ref={inputRef}
        value={query}
        onChange={onInput}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder}
        className="w-full pl-7 pr-3 py-2.5 rounded-[8px] border-[1.5px] border-[var(--ink)] text-[var(--ink)] font-mono text-[13px] uppercase tracking-[0.4px] focus:outline-none focus:border-[var(--emerald)]"
        style={{ background: "var(--paper)" }}
      />
      {open && (query.trim().length > 0 || loading) && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-[100] max-h-[260px] overflow-auto rounded-[12px] border-2 border-[var(--ink)] shadow-[4px_4px_0_var(--ink)]"
          style={{ background: "var(--paper)" }}
        >
          {loading && hits.length === 0 ? (
            <div className="px-3 py-2.5 text-[11.5px] text-muted-foreground font-mono">
              Searching…
            </div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-2.5 text-[11.5px] text-muted-foreground font-mono">
              No matches — type to search NSE/BSE
            </div>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.symbol}-${h.exchange ?? "x"}-${i}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(h);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`block w-full text-left px-3 py-2 rounded-[7px] transition-colors ${
                  i === highlight
                    ? "bg-[var(--emerald-bg)]"
                    : "hover:bg-[var(--rule-softer)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] font-bold text-[var(--emerald-text)]">
                    {h.symbol}
                  </span>
                  {h.exchange && (
                    <span
                      className="font-mono text-[9.5px] text-[var(--ink-3)] px-1 py-[1px] rounded-[4px] border border-[var(--rule-soft)]"
                      style={{ background: "var(--paper-2)" }}
                    >
                      {h.exchange}
                    </span>
                  )}
                  {h.type && (
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.5px] text-muted-foreground">
                      {h.type}
                    </span>
                  )}
                </div>
                <div className="text-[11.5px] text-[var(--ink-2)] truncate mt-0.5">
                  {h.name}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
