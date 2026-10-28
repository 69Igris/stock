"use client";

import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon, X as XIcon } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Debounce in ms. Defaults to 250. */
  debounceMs?: number;
}

/**
 * Debounced search input for the Screener. Controlled component - parent
 * holds the canonical value; local state handles debouncing so we don't
 * fire a request on every keystroke.
 *
 * X button appears when there's input and clears it.
 */
export function SearchBar({
  value,
  onChange,
  placeholder = "Search…",
  debounceMs = 250,
}: SearchBarProps) {
  const [localValue, setLocalValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync from parent when prop changes (e.g. URL-driven reset)
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (next: string) => {
    setLocalValue(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange(next);
    }, debounceMs);
  };

  const handleClear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setLocalValue("");
    onChange("");
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ink-3)] pointer-events-none z-10" />
      <input
        type="text"
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="pf-input mono"
        style={{ paddingLeft: 38, paddingRight: 38 }}
      />
      {localValue && (
        <button
          onClick={handleClear}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--ink-3)] hover:text-[var(--ink)] transition-colors cursor-pointer z-10"
          aria-label="Clear search"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export default SearchBar;
