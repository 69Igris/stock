"use client";

/**
 * Floating bulk-action toolbar - appears at the bottom of the screener
 * results pane when the user has multi-selected ≥ 1 row from the cards
 * or table view.
 *
 * Stocks-mode only (BulkActionToolbar isn't mounted on MF / ETF modes;
 * those use FundsBulkActionToolbar).
 *
 * MONEY-394 K - Compare now opens the same `ResearchModal` the + icon
 * on a single stock-card uses, with `compareEntities` populated. Users
 * pick research style + model + extras (FREE-tier locks apply) before
 * the comparison fires.
 *
 * Actions:
 *   - Compare      → opens ResearchModal (compare mode) → /analysis/[id]
 *   - Watchlist    → bulk WatchlistPopover
 *   - Export CSV   → client-side CSV of selected rows
 *   - Clear        → resets selection
 */

import { useMemo, useState } from "react";
import { GitCompare, Download, X } from "lucide-react";
import type { ScreenResult } from "@/lib/actions/screener";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import ResearchModal, {
  type ResearchEntity,
} from "@/components/analysis/ResearchModal";
import { toast } from "sonner";

interface BulkActionToolbarProps {
  selectedSymbols: Set<string>;
  results: readonly ScreenResult[];
  onClear: () => void;
}

/** Build a CSV of the currently-selected rows. */
function buildCsv(rows: readonly ScreenResult[]): string {
  const header = [
    "symbol",
    "exchange",
    "name",
    "sector",
    "ltp",
    "changePercent",
    "marketCap",
    "pe",
    "roe",
    "revenueGrowth",
    "debtToEquity",
    "matchScore",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.symbol,
        r.exchange,
        `"${(r.name ?? "").replace(/"/g, '""')}"`,
        `"${(r.sector ?? "").replace(/"/g, '""')}"`,
        r.ltp ?? "",
        r.changePercent ?? "",
        r.marketCap ?? "",
        r.pe ?? "",
        r.roe ?? "",
        r.revenueGrowth ?? "",
        r.debtToEquity ?? "",
        r.matchScore,
      ].join(",")
    );
  }
  return lines.join("\n");
}

export function BulkActionToolbar({
  selectedSymbols,
  results,
  onClear,
}: BulkActionToolbarProps) {
  const [compareOpen, setCompareOpen] = useState(false);
  const selectedRows = useMemo(
    () => results.filter((r) => selectedSymbols.has(r.symbol)),
    [results, selectedSymbols]
  );

  if (selectedRows.length === 0) return null;

  // MONEY-394 K - open ResearchModal in compare mode. The modal owns
  // the research-style + model + extras picker (with FREE-tier locks
  // applied) and fires startResearchAction on its own submit.
  const compareEntities: readonly ResearchEntity[] = selectedRows.map((r) => ({
    symbol: r.symbol,
    name: r.name ?? r.symbol,
    type: "stock",
    exchange: r.exchange,
  }));

  function openCompareModal() {
    if (selectedRows.length < 2) {
      toast.error("Select at least 2 stocks to compare");
      return;
    }
    setCompareOpen(true);
  }

  function downloadCsv() {
    const csv = buildCsv(selectedRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
    a.href = url;
    a.download = `screener-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
          {selectedRows.length}{" "}
          <span className="hidden sm:inline">selected</span>
        </span>
        <button
          type="button"
          onClick={openCompareModal}
          disabled={selectedRows.length < 2}
          aria-label="Compare selected"
          title="Compare selected"
          className="pf-bf sm disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          style={{ fontSize: 11.5 }}
        >
          <GitCompare className="h-3 w-3" />
          <span className="hidden sm:inline">Compare</span>
        </button>
        <WatchlistPopover
          targets={selectedRows.map((r) => ({
            symbol: r.symbol,
            exchange: r.exchange,
            kind: "STOCK" as const,
          }))}
          onBulkApplied={onClear}
        />
        <button
          type="button"
          onClick={downloadCsv}
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

      {/* MONEY-394 K - Compare opens ResearchModal in multi-entity mode.
          The modal owns the style + model + extras picker (FREE-tier
          locks applied) and fires startResearchAction on submit. */}
      <ResearchModal
        open={compareOpen}
        onOpenChange={(next) => {
          setCompareOpen(next);
          // Clear selection after the user dismisses or starts research,
          // matching the previous direct-submit UX.
          if (!next) onClear();
        }}
        entity={null}
        compareEntities={compareEntities}
      />
    </div>
  );
}

export default BulkActionToolbar;
