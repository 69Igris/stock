"use client";

/**
 * Floating bulk-action toolbar for MF + ETF screener modes.
 *
 * Mirrors the stocks `BulkActionToolbar` layout (image #54): Compare +
 * Watchlist + CSV + Clear, all in one strip. Funds Compare routes to the
 * `/compare` side-by-side page (not a research session - that pattern
 * is stocks-only).
 */

import Link from "next/link";
import { GitCompare, Download, X } from "lucide-react";
import { buildCompareUrl, type CompareItem } from "@/lib/compare/schema";
import {
  WatchlistPopover,
  type WatchlistTarget,
} from "@/components/watchlist/WatchlistPopover";

interface FundsBulkActionToolbarProps {
  /** Compare items in the canonical schema shape - emit-site builds these. */
  compareItems: ReadonlyArray<CompareItem>;
  /** Watchlist targets - kind="MF" with exchange="MF" for MF rows, or
   *  kind="STOCK" with the row's exchange for ETF rows. */
  watchlistTargets: ReadonlyArray<WatchlistTarget>;
  /** UI label for the watchlist popover heading. ETFs are stored under
   *  kind="STOCK" backend-side; this prop lets the surface render
   *  "ETF watchlists" without changing the backend filter. */
  displayKind?: "MF" | "ETF";
  /** Build + download CSV for the current selection. Parent owns the
   *  shape (MF columns differ from ETF columns); the toolbar just fires it. */
  onDownloadCsv: () => void;
  onClear: () => void;
}

export function FundsBulkActionToolbar({
  compareItems,
  watchlistTargets,
  displayKind,
  onDownloadCsv,
  onClear,
}: FundsBulkActionToolbarProps) {
  const count = compareItems.length;
  if (count === 0) return null;

  const compareHref = buildCompareUrl([...compareItems]);
  const canCompare = count >= 2;

  return (
    <div className="fixed bottom-[88px] xl:bottom-5 left-1/2 -translate-x-1/2 z-30 pointer-events-none flex justify-center w-[calc(100%-16px)] max-w-[640px]">
      <div
        className="pointer-events-auto inline-flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 12,
          boxShadow: "var(--shadow-soft)",
        }}
      >
        <span
          className="pf-pill emerald whitespace-nowrap"
          style={{ fontSize: 11 }}
        >
          {count} <span className="hidden sm:inline">selected</span>
        </span>
        {canCompare ? (
          <Link
            href={compareHref}
            aria-label="Compare selected"
            title="Compare selected"
            className="pf-bf sm whitespace-nowrap"
            style={{ fontSize: 11.5 }}
          >
            <GitCompare className="h-3 w-3" />
            <span className="hidden sm:inline">Compare</span>
          </Link>
        ) : (
          <span
            title="Pick at least 2 to compare"
            className="pf-bf sm opacity-60 cursor-not-allowed whitespace-nowrap"
            style={{ fontSize: 11.5, color: "var(--ink-3)" }}
          >
            <GitCompare className="h-3 w-3" />
            <span className="hidden sm:inline">Compare</span>
          </span>
        )}
        <WatchlistPopover
          targets={watchlistTargets}
          displayKind={displayKind}
          onBulkApplied={onClear}
        />
        <button
          type="button"
          onClick={onDownloadCsv}
          aria-label="Export to CSV"
          title="Export to CSV"
          className="pf-bf sm whitespace-nowrap"
          style={{ fontSize: 11.5 }}
        >
          <Download className="h-3 w-3" />
          <span className="hidden sm:inline">CSV</span>
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          title="Clear selection"
          className="inline-flex items-center gap-1 px-1.5 py-1.5 rounded-[7px] text-[var(--ink-3)] hover:text-[var(--ink)] cursor-pointer transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export default FundsBulkActionToolbar;
