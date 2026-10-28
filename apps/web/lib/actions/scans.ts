"use server";

/**
 * Scans Library Server Actions (MONEY-795 · C2).
 *
 * Surfaces the unified `SCAN_CATALOG` (99 Chartink + research builtin +
 * core screener strategies) to the `/discover/scans` page and runs the
 * inline-runnable scans through the EXISTING screener engine
 * (`screenStocksAction`) — already wired, Redis-cached, and demo-safe.
 *
 * SEBI: a scan SURFACES the stocks matching a technical/fundamental
 * condition. It is descriptive data, not a buy/sell recommendation; this
 * action returns rows only, never an action/score-to-act.
 *
 * ── What runs inline here ────────────────────────────────────────────
 *   • CORE screener strategies whose filters map onto the fundamental
 *     bands the engine applies (P/E, ROE, rev-growth, D/E, div-yield,
 *     market cap). Mapped via `mapFiltersToScreenFilters`.
 *
 * ── DEFERRED (documented follow-ups, NOT built — each its own ticket) ─
 *   • Chartink-DSL scans: full inline execution via the existing async
 *     `strategy-scan` Pub/Sub worker (`runStrategyAction` → ScanResult
 *     polling) or a server-side `run_chartink_scan`. Today these render
 *     as browse cards (`runnable: false`) that deep-link to the screener
 *     / chat `run_screener` flow.
 *   • Builtin (Tickertape-metric) scans: a metric-code → engine-field
 *     translator so they too can run inline.
 *   • Chartink rate-limit queue + nightly pre-warm worker.
 *   • Real trade-by-trade backtests (the /api/backtest simulator move).
 *   • Chartink URL → clause import; "scan my watchlist" allow-list.
 */

import type { ServiceResult } from "@usemoney/services";
import {
  SCAN_CATALOG,
  getScan,
  listScanCategories,
  type ScanDef,
  type ScanCategoryInfo,
} from "@/lib/scans/catalog";
import { mapFiltersToScreenFilters } from "@/lib/scans/scan-filters";
import { screenStocksAction, type ScreenResult } from "@/lib/actions/screener";

// ── Catalog (no auth needed — static, public-safe metadata) ──────────

export interface ScanCatalogPayload {
  scans: ScanDef[];
  categories: ScanCategoryInfo[];
}

export async function getScanCatalogAction(): Promise<
  ServiceResult<ScanCatalogPayload>
> {
  return {
    success: true,
    data: { scans: SCAN_CATALOG, categories: listScanCategories() },
  };
}

// ── Run a scan inline via the screener engine ────────────────────────

export interface RunScanResult {
  scanId: string;
  scanName: string;
  /** Rows that matched — same shape the screener page renders. */
  rows: ScreenResult[];
  total: number;
  /** Engine fields that couldn't be applied (partial-coverage note). */
  unmapped: string[];
  /** True when only a subset of the scan's filters were applied. */
  partial: boolean;
}

/**
 * Run an inline-runnable scan and return the matching rows.
 *
 * Resolution:
 *   1. Look the scan up in the catalog.
 *   2. If it isn't inline-runnable (Chartink DSL / unmappable builtin),
 *      return a clear error so the UI routes the user to the screener /
 *      chat flow instead (DEFERRED inline path).
 *   3. Otherwise map its engine filters → `ScreenFilters` and delegate to
 *      `screenStocksAction` (cached, paginated, demo-safe).
 */
export async function runScanAction(
  scanId: string,
  options?: { limit?: number }
): Promise<ServiceResult<RunScanResult>> {
  const scan = getScan(scanId);
  if (!scan) {
    return { success: false, error: "Scan not found" };
  }

  if (!scan.runnable || !scan.filters || scan.filters.length === 0) {
    return {
      success: false,
      error:
        "This scan isn't available for one-click run yet. Open it in the screener or ask StockSage to run it.",
    };
  }

  const {
    filters: screenFilters,
    unmapped,
    mappedCount,
  } = mapFiltersToScreenFilters(scan.filters);

  // Fail CLOSED when nothing maps at runtime. `runnable` is computed at
  // catalog-build time; if the mapper ever disagrees (or every value is
  // non-finite), `screenFilters` would be `{}` — and an empty filter set
  // makes `screenStocksAction` dump the FULL ~7000-stock universe (every
  // row scored 100). That is a market dump masquerading as a scan result,
  // not a useful (or cheap) response. Re-route to the screener instead.
  if (mappedCount === 0) {
    return {
      success: false,
      error:
        "This scan isn't available for one-click run yet. Open it in the screener or ask StockSage to run it.",
    };
  }

  // Default to NSE (most-used) so the engine takes the indexed path; the
  // user can refine in the screener afterwards. pageSize bounded — a scan
  // result list is a preview, not a full export.
  const pageSize = Math.min(Math.max(1, options?.limit ?? 50), 100);

  const result = await screenStocksAction(screenFilters, "", {
    page: 0,
    pageSize,
    sort: "match",
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    data: {
      scanId: scan.id,
      scanName: scan.name,
      rows: result.data.rows,
      total: result.data.total,
      unmapped,
      partial: unmapped.length > 0,
    },
  };
}
