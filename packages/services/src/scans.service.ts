/**
 * Scans Service (MONEY-1062 P4c — discovery-power parity).
 *
 * Faithful extraction of the scans-library server actions for apps/api:
 *   - apps/web/lib/actions/scans.ts:51 `getScanCatalogAction` → getScanCatalog
 *   - apps/web/lib/actions/scans.ts:85 `runScanAction`        → runScan
 *
 * The web action pulls its catalog + filter-mapper from two web-local modules
 * (`@/lib/scans/catalog`, `@/lib/scans/scan-filters`) that `@usemoney/services`
 * cannot import. Both are PURE (data merge + band translation) and are ported
 * VERBATIM below; the three source registries are imported via the same pure
 * subpaths the web copy uses (never root barrels).
 *
 * SEBI: a scan SURFACES the stocks matching a technical/fundamental condition.
 * Descriptive data only — rows, never an action/score-to-act.
 *
 * FAIL-CLOSED (preserved from the web action): a scan that isn't inline-
 * runnable, or whose filters map to ZERO screener bands at runtime, returns an
 * error instead of dumping the full ~7000-stock universe.
 *
 * ADDITIVE `code` fields ("NOT_FOUND" / "NOT_RUNNABLE") let the HTTP route map
 * statuses without string-matching; messages are byte-identical to the web.
 *
 * Runs delegate to `screenStocks` (this package's port of the web screener
 * engine — cached, paginated); the engine fn is injectable for tests.
 *
 * @see packages/services/__tests__/parity-p4c-discovery.service.test.ts
 */

import {
  CHARTINK_SCAN_LIBRARY,
  type ChartinkScanDef,
} from "@usemoney/research/data-sources/chartink-scans";
import {
  BUILTIN_STRATEGIES,
  type BuiltInStrategy,
} from "@usemoney/research/strategies/builtin-strategies";
import { ALL_STRATEGIES } from "@usemoney/core/screener/strategies";
import type {
  ScreenerStrategy,
  ScreenerFilter,
} from "@usemoney/core/screener/engine";
import type { ServiceResult } from "./types";
import {
  screenStocks,
  type ScreenFilters,
  type ScreenResult,
} from "./screener.service";

// ════════════════════════════════════════════════════════════════════════════
// Ported pure catalog — apps/web/lib/scans/catalog.ts
// ════════════════════════════════════════════════════════════════════════════

export type ScanSource = "chartink" | "builtin" | "core";

export type ScanCategory =
  | "price"
  | "moving_average"
  | "momentum"
  | "macd"
  | "bollinger"
  | "volume"
  | "candlestick"
  | "chart_pattern"
  | "supertrend"
  | "ichimoku"
  | "value"
  | "growth"
  | "quality"
  | "income"
  | "combined"
  | "other";

export interface ScanDef {
  /** Stable, namespaced id (e.g. "chartink:ma_golden_cross"). */
  id: string;
  name: string;
  description: string;
  category: ScanCategory;
  source: ScanSource;
  tags: string[];
  /** Raw Chartink scan_clause — present for source "chartink" only. */
  chartinkQuery?: string;
  /** Engine-native filter set — present for inline-runnable scans only. */
  filters?: ScreenerFilter[];
  /** True when runScan can execute this inline via the screener engine. */
  runnable: boolean;
}

export interface ScanCategoryInfo {
  category: ScanCategory | "all";
  count: number;
  label: string;
}

const CATEGORY_LABELS: Record<ScanCategory, string> = {
  price: "Price Action",
  moving_average: "Moving Averages",
  momentum: "Momentum",
  macd: "MACD",
  bollinger: "Bollinger Bands",
  volume: "Volume & Delivery",
  candlestick: "Candlestick Patterns",
  chart_pattern: "Chart Patterns",
  supertrend: "SuperTrend",
  ichimoku: "Ichimoku Cloud",
  value: "Value",
  growth: "Growth",
  quality: "Quality",
  income: "Income & Dividends",
  combined: "Multi-Factor",
  other: "Other",
};

export function scanCategoryLabel(category: ScanCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

function normalizeChartinkCategory(
  c: ChartinkScanDef["category"],
): ScanCategory {
  switch (c) {
    case "price":
      return "price";
    case "volume_delivery":
      return "volume";
    case "moving_average":
      return "moving_average";
    case "momentum":
      return "momentum";
    case "macd":
      return "macd";
    case "bollinger":
      return "bollinger";
    case "candlestick":
      return "candlestick";
    case "chart_pattern":
      return "chart_pattern";
    case "supertrend":
      return "supertrend";
    case "ichimoku":
      return "ichimoku";
    case "combined":
      return "combined";
    default:
      return "other";
  }
}

function normalizeBuiltinCategory(
  c: BuiltInStrategy["category"],
): ScanCategory {
  switch (c) {
    case "value":
    case "solvency":
      return "value";
    case "growth":
      return "growth";
    case "momentum":
      return "momentum";
    case "income":
      return "income";
    case "quality":
    case "cashflow":
      return "quality";
    case "technical":
      return "price";
    case "combined":
      return "combined";
    case "candlestick":
      return "candlestick";
    case "chart_pattern":
      return "chart_pattern";
    case "shareholding":
    case "corporate":
    case "timeframe":
      return "other";
    default:
      return "other";
  }
}

function normalizeCoreCategory(c: string): ScanCategory {
  const k = c.toLowerCase();
  if (k === "dividend") return "income";
  if (k === "value") return "value";
  if (k === "growth") return "growth";
  if (k === "quality") return "quality";
  if (k === "momentum") return "momentum";
  if (k === "bullish" || k === "bearish" || k === "reversal") return "price";
  if (k === "volume") return "volume";
  if (k === "volatility") return "bollinger";
  if (k === "combined") return "combined";
  return "other";
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function deriveCoreTags(s: ScreenerStrategy): string[] {
  const tags = new Set<string>([s.category.toLowerCase()]);
  for (const f of s.filters) tags.add(f.field);
  return Array.from(tags);
}

/**
 * Build the catalog once at module load. Merge order matters for dedupe:
 * CORE (engine-native) → BUILTIN → CHARTINK, deduped on normalised NAME.
 */
function buildCatalog(): ScanDef[] {
  const out: ScanDef[] = [];
  const seenNames = new Set<string>();

  for (const s of ALL_STRATEGIES as ScreenerStrategy[]) {
    const key = normalizeName(s.name);
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push({
      id: `core:${s.id}`,
      name: s.name,
      description: s.description,
      category: normalizeCoreCategory(s.category),
      source: "core",
      tags: deriveCoreTags(s),
      filters: s.filters,
      runnable: isScreenerRunnable(s.filters),
    });
  }

  for (const s of BUILTIN_STRATEGIES) {
    const key = normalizeName(s.name);
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push({
      id: `builtin:${s.id}`,
      name: s.name,
      description: s.description,
      category: normalizeBuiltinCategory(s.category),
      source: "builtin",
      tags: s.tags,
      chartinkQuery: s.chartinkQuery,
      runnable: false,
    });
  }

  for (const s of CHARTINK_SCAN_LIBRARY) {
    const key = normalizeName(s.name);
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    out.push({
      id: `chartink:${s.id}`,
      name: s.name,
      description: s.description,
      category: normalizeChartinkCategory(s.category),
      source: "chartink",
      tags: s.tags,
      chartinkQuery: s.query,
      runnable: false,
    });
  }

  return out;
}

// Declared BEFORE the module-level `buildCatalog()` call below: the catalog's
// `runnable` computation reaches this const via isScreenerRunnable →
// mapFiltersToScreenFilters → applyFilter. Function declarations hoist; a
// `const` does not — leaving this after the initializer was a module-load TDZ
// ReferenceError that killed every importer of the @usemoney/services barrel.
const FIELD_TO_BAND: Record<
  string,
  { min: keyof ScreenFilters; max: keyof ScreenFilters }
> = {
  pe: { min: "minPe", max: "maxPe" },
  roe: { min: "minRoe", max: "maxRoe" },
  revenueGrowth: { min: "minRevenueGrowth", max: "maxRevenueGrowth" },
  debtToEquity: { min: "minDebtToEquity", max: "maxDebtToEquity" },
  dividendYield: { min: "minDividendYield", max: "maxDividendYield" },
  marketCap: { min: "minMarketCap", max: "maxMarketCap" },
};

/** The complete, deduped scan catalog. */
export const SCAN_CATALOG: ScanDef[] = buildCatalog();

/** Look up a single scan by its namespaced id. */
export function getScan(id: string): ScanDef | undefined {
  return SCAN_CATALOG.find((s) => s.id === id);
}

/** Category buckets with counts, "All" first, sorted by count desc. */
export function listScanCategories(): ScanCategoryInfo[] {
  const counts = new Map<ScanCategory, number>();
  for (const s of SCAN_CATALOG) {
    counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  }
  const cats: ScanCategoryInfo[] = Array.from(counts.entries())
    .map(([category, count]) => ({
      category,
      count,
      label: scanCategoryLabel(category),
    }))
    .sort((a, b) => b.count - a.count);

  return [
    { category: "all", count: SCAN_CATALOG.length, label: "All" },
    ...cats,
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// Ported pure filter mapper — apps/web/lib/scans/scan-filters.ts
// (FIELD_TO_BAND itself is declared ABOVE the SCAN_CATALOG initializer — see
// the TDZ note there.)
// ════════════════════════════════════════════════════════════════════════════

export interface ScanFilterMapping {
  filters: ScreenFilters;
  mappedCount: number;
  unmapped: string[];
}

/** Finite-number guard — a poisoned catalog value must never reach the engine. */
function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function applyFilter(out: ScreenFilters, f: ScreenerFilter): boolean {
  const band = FIELD_TO_BAND[f.field];
  if (!band) return false;

  const setMin = (v: number) => {
    const cur = out[band.min] as number | undefined;
    (out[band.min] as number) = cur == null ? v : Math.max(cur, v);
  };
  const setMax = (v: number) => {
    const cur = out[band.max] as number | undefined;
    (out[band.max] as number) = cur == null ? v : Math.min(cur, v);
  };

  switch (f.operator) {
    case "gt":
    case "gte":
      if (!finite(f.value)) return false;
      setMin(f.value);
      return true;
    case "lt":
    case "lte":
      if (!finite(f.value)) return false;
      setMax(f.value);
      return true;
    case "between":
      if (!Array.isArray(f.value) || f.value.length !== 2) return false;
      if (!finite(f.value[0]) || !finite(f.value[1])) return false;
      setMin(f.value[0]);
      setMax(f.value[1]);
      return true;
    case "eq":
      if (!finite(f.value)) return false;
      setMin(f.value);
      setMax(f.value);
      return true;
    default:
      return false;
  }
}

/** Translate an engine `ScreenerFilter[]` into `ScreenFilters` bands. */
export function mapFiltersToScreenFilters(
  filters: readonly ScreenerFilter[],
): ScanFilterMapping {
  const out: ScreenFilters = {};
  let mappedCount = 0;
  const unmapped: string[] = [];

  for (const f of filters) {
    if (applyFilter(out, f)) mappedCount += 1;
    else unmapped.push(f.field);
  }

  return { filters: out, mappedCount, unmapped };
}

/** A scan is screener-runnable when ≥1 filter maps to a fundamental band. */
export function isScreenerRunnable(
  filters: readonly ScreenerFilter[] | undefined,
): boolean {
  if (!filters || filters.length === 0) return false;
  return mapFiltersToScreenFilters(filters).mappedCount > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Service surface
// ════════════════════════════════════════════════════════════════════════════

export interface ScanCatalogPayload {
  scans: ScanDef[];
  categories: ScanCategoryInfo[];
}

export interface RunScanResult {
  scanId: string;
  scanName: string;
  /** Rows that matched — same shape the screener renders. */
  rows: ScreenResult[];
  total: number;
  /** Engine fields that couldn't be applied (partial-coverage note). */
  unmapped: string[];
  /** True when only a subset of the scan's filters were applied. */
  partial: boolean;
}

/** Injectable seam — the screener engine call is stubbed in tests. */
export interface ScansServiceDeps {
  screenStocks?: typeof screenStocks;
}

/** The unified scan catalog (static, public-safe metadata; no auth). */
export async function getScanCatalog(): Promise<
  ServiceResult<ScanCatalogPayload>
> {
  return {
    success: true,
    data: { scans: SCAN_CATALOG, categories: listScanCategories() },
  };
}

const NOT_RUNNABLE_MSG =
  "This scan isn't available for one-click run yet. Open it in the screener or ask StockSage to run it.";

/**
 * Run an inline-runnable scan via the screener engine. Fail CLOSED when the
 * scan is missing, browse-only, or maps to zero bands at runtime (an empty
 * filter set would dump the full universe).
 */
export async function runScan(
  scanId: string,
  options?: { limit?: number },
  deps: ScansServiceDeps = {},
): Promise<ServiceResult<RunScanResult>> {
  const screen = deps.screenStocks ?? screenStocks;

  const scan = getScan(scanId);
  if (!scan) {
    return { success: false, error: "Scan not found", code: "NOT_FOUND" };
  }

  if (!scan.runnable || !scan.filters || scan.filters.length === 0) {
    return { success: false, error: NOT_RUNNABLE_MSG, code: "NOT_RUNNABLE" };
  }

  const {
    filters: screenFilters,
    unmapped,
    mappedCount,
  } = mapFiltersToScreenFilters(scan.filters);

  if (mappedCount === 0) {
    return { success: false, error: NOT_RUNNABLE_MSG, code: "NOT_RUNNABLE" };
  }

  // Preview-bounded page size (mirrors the web action's 1..100 clamp).
  const pageSize = Math.min(Math.max(1, options?.limit ?? 50), 100);

  const result = await screen(screenFilters, "", {
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
