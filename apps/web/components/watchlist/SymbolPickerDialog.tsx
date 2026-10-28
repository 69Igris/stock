"use client";

/**
 * SymbolPickerDialog - used when an action is per-stock but a watchlist
 * has multiple symbols (MONEY-207).
 *
 * Used by:
 *   - Analyze button on a multi-symbol watchlist (open dashboard with
 *     `prompt=Analyze SYMBOL`)
 *   - Paper-trade button on a multi-symbol watchlist (open paper-trading
 *     pre-filled with the chosen symbol)
 *
 * The "single-symbol" case (1-item watchlist) skips the dialog entirely
 * and dispatches the action directly - caller is responsible for that
 * fast path.
 */

import { useState } from "react";
import { X, ChevronRight } from "lucide-react";

export interface SymbolPickerItem {
  symbol: string;
  exchange: string;
  /** Optional friendly name shown next to the ticker. */
  name?: string;
}

interface SymbolPickerDialogProps {
  /** Modal title - usually action-oriented ("Pick a stock to analyze"). */
  title: string;
  /** Symbols pulled from the watchlist's items. Order is preserved. */
  items: readonly SymbolPickerItem[];
  /** Called with the picked item. Caller closes the dialog. */
  onPick: (item: SymbolPickerItem) => void;
  onClose: () => void;
}

export function SymbolPickerDialog({
  title,
  items,
  onPick,
  onClose,
}: SymbolPickerDialogProps) {
  const [filter, setFilter] = useState("");
  const trimmed = filter.trim().toLowerCase();
  const visible = trimmed
    ? items.filter(
        (i) =>
          i.symbol.toLowerCase().includes(trimmed) ||
          (i.name?.toLowerCase().includes(trimmed) ?? false)
      )
    : items;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[92vw] rounded-xl"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          boxShadow: "6px 6px 0 var(--ink)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--rule-soft)]">
          <div className="font-display text-[15px] font-semibold text-[var(--ink)]">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid place-items-center text-[var(--ink-3)] hover:text-[var(--ink)] transition-colors"
            style={{ width: 24, height: 24 }}
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {items.length > 6 && (
          <div className="px-4 pt-3">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
              placeholder="Filter…"
              className="w-full rounded-[7px] px-3 py-2 text-[13px] text-[var(--ink)] focus:outline-none focus:border-[var(--emerald)] transition-colors"
              style={{
                background: "var(--paper)",
                border: "1.5px solid var(--ink)",
              }}
            />
          </div>
        )}
        <div className="max-h-[360px] overflow-y-auto p-2">
          {visible.length === 0 ? (
            <div className="text-center text-[12px] text-[var(--ink-3)] py-8">
              No matches.
            </div>
          ) : (
            visible.map((item) => (
              <button
                key={`${item.symbol}|${item.exchange}`}
                type="button"
                onClick={() => onPick(item)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-emerald-400/[0.04] cursor-pointer text-left"
              >
                <span className="font-mono font-bold text-emerald-400 text-[13px]">
                  {item.symbol}
                </span>
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                    item.exchange === "BSE"
                      ? "border-violet-400/30 text-violet-300 bg-violet-400/10"
                      : "border-emerald-400/25 text-emerald-400 bg-emerald-400/10"
                  }`}
                >
                  {item.exchange}
                </span>
                {item.name && (
                  <span className="flex-1 truncate text-[12px] text-[var(--ink-3)]">
                    {item.name}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5 text-[var(--ink-3)] shrink-0" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
