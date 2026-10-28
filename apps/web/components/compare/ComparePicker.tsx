"use client";

/**
 * ComparePicker - single-item entry point for /compare.
 *
 * When the user lands on /compare with ?items= containing a single item
 * (from a detail-page "Compare" button) or with no params at all, this
 * component lets them search for and add more items inline before navigating
 * to the populated comparison.
 *
 * MONEY-553: searches stocks too (and supports cross-asset sets — e.g. a stock
 * vs a fund). A full AI stock deep-dive still lives on /analysis.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GitCompare, X, Search } from "lucide-react";
import {
  buildCompareUrl,
  MAX_COMPARE_ITEMS,
  type CompareItem,
  type CompareItemType,
} from "@/lib/compare/schema";

interface AutocompleteResult {
  symbol: string;
  name: string;
  type?: string;
  exchange?: string;
  schemeCode?: string;
}

interface ComparePickerProps {
  /** Pre-loaded item from a single-entry URL - rendered as chip 1. */
  seedItems: CompareItem[];
}

const MAX_ITEMS = MAX_COMPARE_ITEMS;

function inferTypeFromAutocomplete(
  result: AutocompleteResult
): CompareItemType {
  const t = (result.type ?? "").toUpperCase();
  if (t === "MF" || result.schemeCode) return "MF";
  if (t === "ETF") return "ETF";
  if (t === "INDEX") return "INDEX";
  // InstrumentMapping.instrumentType for a stock is "EQUITY".
  if (t === "EQUITY" || t === "STOCK") return "STOCK";
  // Fallback: assume MF (the most common picker entry - unique schemeCode)
  return "MF";
}

export function ComparePicker({ seedItems }: ComparePickerProps) {
  const router = useRouter();
  const [items, setItems] = useState<CompareItem[]>(seedItems);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AutocompleteResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query || query.length < 2) {
      setResults([]);
      setError(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/market/autocomplete?q=${encodeURIComponent(
          query
        )}&limit=8&types=MF,ETF,INDEX,EQUITY`;
        const resp = await fetch(url);
        const json = (await resp.json()) as {
          success?: boolean;
          results?: AutocompleteResult[];
          error?: string;
        };
        if (!resp.ok || !json.success) {
          setError(json.error ?? "Search failed");
          setResults([]);
        } else {
          setResults(json.results ?? []);
        }
      } catch {
        setError("Search failed");
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function addResult(r: AutocompleteResult) {
    if (items.length >= MAX_ITEMS) return;
    const fundType = inferTypeFromAutocomplete(r);
    const fundId = fundType === "MF" ? (r.schemeCode ?? r.symbol) : r.symbol;
    if (items.some((it) => it.fundId === fundId && it.fundType === fundType)) {
      return;
    }
    setItems((prev) => [...prev, { fundType, fundId }]);
    setQuery("");
    setResults([]);
  }

  function removeAt(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function go() {
    if (items.length < 2) return;
    router.push(buildCompareUrl(items));
  }

  return (
    <div className="mx-auto max-w-2xl rounded-xl p-6 sm:p-8 pf-card">
      <div className="flex items-center gap-2 mb-2">
        <GitCompare className="h-5 w-5 text-emerald-400" />
        <h2 className="text-lg font-bold">Compare investments</h2>
      </div>
      <p className="text-sm text-[var(--ink-2)] mb-5">
        {seedItems.length === 1
          ? "Pick another stock, fund, or ETF to compare with."
          : "Pick 2–5 stocks, mutual funds, ETFs, or indices to compare side by side."}
      </p>

      {items.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {items.map((it, i) => (
            <span
              key={`${it.fundType}:${it.fundId}`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 text-emerald-400 text-xs font-mono"
            >
              <span className="opacity-70">{it.fundType}</span>
              <span className="font-bold">{it.fundId}</span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${it.fundId}`}
                className="opacity-70 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-[8px]"
          style={{
            background: "var(--paper)",
            border: "1.5px solid var(--ink)",
          }}
        >
          <Search className="h-4 w-4 text-[var(--ink-3)]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stocks, funds, ETFs, indices…"
            className="flex-1 bg-transparent outline-none text-sm font-mono text-[var(--ink)] placeholder:text-[var(--ink-3)]"
            disabled={items.length >= MAX_ITEMS}
          />
          {loading && (
            <span className="text-[10px] font-mono text-[var(--ink-3)]">…</span>
          )}
        </div>
        {results.length > 0 && (
          <ul
            className="absolute left-0 right-0 mt-1 z-10 max-h-72 overflow-auto rounded-[12px] py-1"
            style={{
              background: "var(--paper)",
              border: "2px solid var(--ink)",
              boxShadow: "4px 4px 0 var(--ink)",
            }}
          >
            {results.map((r) => (
              <li key={`${r.type ?? ""}:${r.symbol}:${r.exchange ?? ""}`}>
                <button
                  type="button"
                  onClick={() => addResult(r)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-emerald-400/10 transition-colors"
                >
                  <span className="font-mono font-bold text-emerald-400">
                    {r.symbol}
                  </span>
                  {r.exchange && (
                    <span className="ml-1 text-[10px] font-mono text-[var(--ink-3)]">
                      {r.exchange}
                    </span>
                  )}
                  <span className="ml-2 text-xs text-[var(--ink-2)]">
                    {r.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-5 flex items-center justify-between gap-3">
        <span className="text-xs text-[var(--ink-3)] font-mono">
          {items.length} / {MAX_ITEMS} selected
        </span>
        <button
          type="button"
          onClick={go}
          disabled={items.length < 2}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[8px] bg-emerald-400 text-black text-sm font-bold hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <GitCompare className="h-4 w-4" />
          Compare →
        </button>
      </div>
    </div>
  );
}
