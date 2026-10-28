"use client";

/**
 * InstrumentSearch Component
 *
 * Reusable, debounced typeahead search for stocks, indices, ETFs, and mutual funds.
 * Calls /api/market/search with 300ms debounce.
 * Shows symbol, name, exchange badge, sector badge, instrument type icon.
 * On select: navigates to detail page or calls onSelect callback.
 *
 * Usage:
 *   <InstrumentSearch onSelect={(item) => handleSelect(item)} />
 *   <InstrumentSearch navigateOnSelect />
 *
 * ## INDIA ONLY — this is a WRITE-SIDE picker (MONEY-980 review)
 *
 * It is not a browse surface. `AddTradeDialog` writes the picked
 * `{symbol, exchange}` into a manual Trade row, `AddMutualFundDialog` into a
 * holding, and `app/watchlist/client.tsx` into a watchlist item — and every one
 * of those is resolved later through `instrument_mappings`, which holds no US
 * listings since they moved to `us_instruments`. A US pick is therefore not a
 * cosmetic mismatch: it is a row that silently matches nothing afterwards, or —
 * for `INFY`, an NSE symbol AND a NYSE ADR ticker — matches the WRONG company.
 *
 * `InstrumentSearchItem` has nowhere to put `market`, `listingStatus` or
 * `listingEndDate` either, so a DELISTED 2008 listing would appear in a picker
 * whose entire job is "choose a thing to keep tracking", indistinguishable from
 * a live one.
 *
 * The enforcement is the ABSENCE of `includeUs` from the query below:
 * `/api/market/search` defaults US rows OFF and requires the literal
 * `includeUs=true` (`parseIncludeUs`). Widening the item type and the row
 * rendering is the real work, and it belongs with the surface that needs it —
 * not with a dialog that is about to persist the answer.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import { Input } from "@usemoney/ui/input";
import { Button } from "@usemoney/ui/button";
import { Badge } from "@usemoney/ui/badge";
import {
  Search,
  TrendingUp,
  Landmark,
  BarChart2,
  X,
  Loader2,
  Check,
} from "lucide-react";
import { cn } from "@usemoney/ui";

// ============== TYPES ==============

export interface InstrumentSearchItem {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  yahooSymbol: string;
  instrumentId?: string;
  sector?: string | null;
  instrumentType?: string;
}

export interface InstrumentSearchProps {
  /** Called when an instrument is selected */
  onSelect?: (item: InstrumentSearchItem) => void;
  /** Navigate to detail page on select (default: false) */
  navigateOnSelect?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Include indices in results */
  includeIndices?: boolean;
  /** Filter results to specific instrument types (e.g. ["EQUITY"], ["MF"], ["INDEX", "ETF"]) */
  filterTypes?: string[];
  /** Max results to show */
  limit?: number;
  /** Debounce delay in ms */
  debounceMs?: number;
  /** Additional CSS classes for the wrapper */
  className?: string;
  /** Auto-focus the input */
  autoFocus?: boolean;
  /** Called when user explicitly searches (Enter or Search button). Receives current results + query. */
  onSearch?: (results: InstrumentSearchItem[], query: string) => void;
  /** Show the search button at the end of the input */
  showSearchButton?: boolean;
  /** Enable multi-select mode with checkboxes (dropdown stays open on selection) */
  multiSelect?: boolean;
  /** Set of `symbol:exchange` keys that appear as selected (used with multiSelect) */
  selectedKeys?: Set<string>;
}

// ============== INSTRUMENT TYPE ICONS ==============

function InstrumentTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "INDEX":
      return <BarChart2 className="h-4 w-4 text-blue-500" />;
    case "ETF":
      return <Landmark className="h-4 w-4 text-purple-500" />;
    case "MF":
      return <Landmark className="h-4 w-4 text-green-500" />;
    default:
      return <TrendingUp className="h-4 w-4 text-muted-foreground" />;
  }
}

// ============== COMPONENT ==============

export function InstrumentSearch({
  onSelect,
  navigateOnSelect = false,
  placeholder = "Search stocks, mutual funds, ETFs...",
  includeIndices = true,
  filterTypes,
  limit = 15,
  debounceMs = 300,
  className,
  autoFocus = false,
  onSearch,
  showSearchButton = false,
  multiSelect = false,
  selectedKeys,
}: InstrumentSearchProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSearchItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Fetch search results
  const fetchResults = useCallback(
    async (searchQuery: string) => {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();

      setIsLoading(true);

      try {
        // NO `includeUs` — see the INDIA ONLY note in the file header. The
        // route fails closed on its absence; adding it here would put US
        // listings into `AddTradeDialog` / `AddMutualFundDialog` / the
        // watchlist, all of which persist the pick into an India-resolved
        // record and none of which can even represent `listingStatus`.
        const params = new URLSearchParams({
          limit: limit.toString(),
          includeIndices: includeIndices.toString(),
        });

        if (searchQuery.trim()) {
          params.set("q", searchQuery.trim());
        }

        if (filterTypes?.length) {
          params.set("types", filterTypes.join(","));
        }

        const response = await fetch(`/api/market/search?${params}`, {
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error("Search failed");
        }

        const data = await response.json();

        if (data.success && data.results) {
          setResults(data.results);
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("Search error:", err);
          setResults([]);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [limit, includeIndices, filterTypes]
  );

  // Debounced search
  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value);
      setHighlightedIndex(-1);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        fetchResults(value);
      }, debounceMs);
    },
    [fetchResults, debounceMs]
  );

  // Handle item selection
  const handleSelect = useCallback(
    (item: InstrumentSearchItem) => {
      if (!multiSelect) {
        setIsOpen(false);
        setQuery("");
      }

      if (onSelect) {
        onSelect(item);
      }

      if (navigateOnSelect && !multiSelect) {
        // MONEY-1205 — one helper decides the route. `instrumentType` wins over
        // the search payload's looser `type` when both are present.
        router.push(
          instrumentDetailHref({
            symbol: item.symbol,
            exchange: item.exchange,
            instrumentType: item.instrumentType,
            type: item.type,
          })
        );
      }
    },
    [onSelect, navigateOnSelect, router, multiSelect]
  );

  // Explicit search - triggered by Enter key or Search button
  const handleExplicitSearch = useCallback(() => {
    if (onSearch && query.trim()) {
      setIsOpen(false);
      onSearch(results, query.trim());
    }
  }, [onSearch, query, results]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // If a dropdown item is highlighted, select it
        if (
          isOpen &&
          highlightedIndex >= 0 &&
          highlightedIndex < results.length
        ) {
          handleSelect(results[highlightedIndex]);
        } else {
          // Otherwise trigger explicit search
          handleExplicitSearch();
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setIsOpen(false);
        inputRef.current?.blur();
        return;
      }

      if (!isOpen || results.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < results.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : results.length - 1
          );
          break;
      }
    },
    [isOpen, results, highlightedIndex, handleSelect, handleExplicitSearch]
  );

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Reset results when filterTypes changes so fresh popular results load
  useEffect(() => {
    setResults([]);
    setQuery("");
  }, [filterTypes]);

  // Fetch popular stocks on open
  const handleFocus = useCallback(() => {
    setIsOpen(true);
    if (results.length === 0) {
      fetchResults("");
    }
  }, [results.length, fetchResults]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && dropdownRef.current) {
      const item = dropdownRef.current.querySelector(
        `[data-index="${highlightedIndex}"]`
      );
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  return (
    <div className={cn("relative", className)}>
      {/* Search Input */}
      <div className="relative flex">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="text"
            placeholder={placeholder}
            className={cn(
              "pl-10",
              showSearchButton ? "pr-10 rounded-r-none" : "pr-8"
            )}
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            autoFocus={autoFocus}
          />
          {query && (
            <button
              className={cn(
                "absolute top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground",
                showSearchButton ? "right-12" : "right-3"
              )}
              onClick={() => {
                setQuery("");
                fetchResults("");
                if (onSearch) onSearch([], "");
                inputRef.current?.focus();
              }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {isLoading && (
            <Loader2
              className={cn(
                "absolute top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground",
                showSearchButton ? "right-12" : "right-3"
              )}
            />
          )}
        </div>
        {showSearchButton && (
          <Button
            variant="default"
            size="icon"
            className="rounded-l-none h-9 w-10 shrink-0"
            onClick={handleExplicitSearch}
            disabled={!query.trim()}
          >
            <Search className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Dropdown Results */}
      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg max-h-80 overflow-y-auto"
        >
          {/* Section Header */}
          {!query && results.length > 0 && (
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
              Popular
            </div>
          )}

          {results.length === 0 && !isLoading && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query ? "No results found" : "Start typing to search..."}
            </div>
          )}

          {results.map((item, index) => {
            const itemKey = `${item.symbol}:${item.exchange}`;
            const isSelected = multiSelect && selectedKeys?.has(itemKey);

            return (
              <button
                key={`${item.yahooSymbol || item.symbol}-${index}`}
                data-index={index}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-accent transition-colors",
                  highlightedIndex === index && "bg-accent",
                  isSelected && "bg-primary/5"
                )}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                {/* Checkbox for multi-select */}
                {multiSelect && (
                  <div
                    className={cn(
                      "h-4 w-4 rounded border flex items-center justify-center shrink-0",
                      isSelected
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-muted-foreground/30"
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </div>
                )}

                {/* Type Icon */}
                <InstrumentTypeIcon
                  type={item.type || item.instrumentType || "EQUITY"}
                />

                {/* Symbol & Name */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{item.symbol}</span>
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1 py-0 h-4"
                    >
                      {item.exchange}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {item.name}
                  </p>
                </div>

                {/* Sector Badge */}
                {item.sector && (
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                  >
                    {item.sector}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default InstrumentSearch;
