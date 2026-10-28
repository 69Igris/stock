"use client";

/**
 * InstrumentAutocomplete — playful (cream/ink) debounced typeahead for the
 * manual-entry modals. Reuses the existing `/api/market/search` endpoint
 * (the same one powering the global InstrumentSearch), but renders in the
 * playful design system and PORTALS its result list so it overlays outside
 * the modal's scroll container instead of being clipped.
 *
 * The field still accepts free text (a ticker/scheme not in our DB can be
 * typed manually) — `onChange` fires on every keystroke; `onSelect` fires
 * only when a result row is picked (so callers can also capture the
 * exchange / schemeCode).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePopoverAnchor } from "@/lib/hooks/usePopoverAnchor";
import { TerminalInput } from "./primitives";

export interface AutocompleteItem {
  /** equity ticker OR mutual-fund schemeCode */
  symbol: string;
  /** company / scheme name */
  name: string;
  /** exchange (NSE/BSE) for stocks, AMC name for funds */
  exchange: string;
  type: string;
}

interface Props {
  label?: string;
  value: string;
  /** free-text edits (every keystroke) */
  onChange: (value: string) => void;
  /** a result row was chosen */
  onSelect: (item: AutocompleteItem) => void;
  kind?: "stock" | "fund";
  placeholder?: string;
  mono?: boolean;
  required?: boolean;
}

export function InstrumentAutocomplete({
  label,
  value,
  onChange,
  onSelect,
  kind = "stock",
  placeholder,
  mono = true,
  required,
}: Props) {
  const [results, setResults] = useState<AutocompleteItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(-1);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const anchor = usePopoverAnchor(wrapRef, open);

  const isFund = kind === "fund";

  const fetchResults = useCallback(
    async (q: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: "8",
          includeIndices: "false",
          types: isFund ? "MF" : "EQUITY",
        });
        if (q.trim()) params.set("q", q.trim());
        const res = await fetch(`/api/market/search?${params.toString()}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error("search failed");
        const data = await res.json();
        const list: Record<string, unknown>[] = Array.isArray(data?.results)
          ? data.results
          : [];
        setResults(
          list.map((r) => ({
            symbol: String(r.symbol ?? ""),
            name: String(r.name ?? ""),
            exchange: String(r.exchange ?? ""),
            type: String(r.type ?? r.instrumentType ?? ""),
          }))
        );
      } catch (e) {
        if (e instanceof Error && e.name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [isFund]
  );

  const onInput = (v: string) => {
    onChange(v);
    setHi(-1);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchResults(v), 250);
  };

  const choose = useCallback(
    (item: AutocompleteItem) => {
      onSelect(item);
      setOpen(false);
      setResults([]);
    },
    [onSelect]
  );

  // Close on outside click — the result list is portaled to <body>, outside
  // wrapRef, so it's excluded explicitly (otherwise the row's onClick would
  // never fire).
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    },
    []
  );

  return (
    <div
      ref={wrapRef}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        flex: 1,
        position: "relative",
      }}
    >
      <TerminalInput
        ref={inputRef}
        label={label}
        mono={mono}
        value={value}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onInput(e.target.value)}
        onFocus={() => {
          setOpen(true);
          if (results.length === 0) void fetchResults(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHi((p) => Math.min(p + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((p) => Math.max(p - 1, 0));
          } else if (e.key === "Enter") {
            if (open && hi >= 0 && hi < results.length) {
              e.preventDefault();
              choose(results[hi]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open &&
        anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: anchor.top + 5,
              left: anchor.left,
              width: anchor.width,
              zIndex: 1000,
              background: "var(--paper)",
              border: "1.5px solid var(--ink)",
              borderRadius: 10,
              boxShadow: "4px 4px 0 var(--ink)",
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            {loading && results.length === 0 && (
              <div
                style={{
                  padding: "11px 12px",
                  fontSize: 12,
                  color: "var(--ink-3)",
                }}
              >
                Searching…
              </div>
            )}
            {!loading && results.length === 0 && (
              <div
                style={{
                  padding: "11px 12px",
                  fontSize: 12,
                  color: "var(--ink-3)",
                }}
              >
                {value.trim()
                  ? "No matches — you can still type it in manually."
                  : "Start typing to search."}
              </div>
            )}
            {results.map((r, i) => (
              <div
                key={`${r.symbol}-${r.exchange}-${i}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r)}
                onMouseEnter={() => setHi(i)}
                style={{
                  padding: "9px 12px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: hi === i ? "var(--rule-softer)" : "transparent",
                  borderBottom: "1px solid var(--rule-softer)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span
                      style={{
                        fontFamily:
                          "var(--font-jetbrains), ui-monospace, monospace",
                        fontWeight: 700,
                        fontSize: 12.5,
                        color: "var(--ink)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: 0,
                      }}
                    >
                      {isFund ? r.name : r.symbol}
                    </span>
                    {!isFund && r.exchange && (
                      <span
                        className="pf-pill"
                        style={{
                          fontSize: 9,
                          padding: "0 5px",
                          borderRadius: 4,
                          flexShrink: 0,
                        }}
                      >
                        {r.exchange}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      marginTop: 1,
                    }}
                  >
                    {isFund ? r.exchange : r.name}
                  </div>
                </div>
              </div>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

export default InstrumentAutocomplete;
