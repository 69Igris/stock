/**
 * Unified Scan Catalog (MONEY-795 · C2 — Scans library).
 *
 * One browseable catalog of pre-built market scans, merged from three
 * previously-disconnected registries:
 *
 *   1. `CHARTINK_SCAN_LIBRARY`  — 99 technical scans in Chartink DSL
 *      (`@usemoney/research/data-sources/chartink-scans`). Was DEAD CODE
 *      with zero consumers before this catalog.
 *   2. `BUILTIN_STRATEGIES`     — research fundamental/technical strategies
 *      (`@usemoney/research/strategies/builtin-strategies`), Tickertape-
 *      metric based.
 *   3. core `ALL_STRATEGIES`    — the in-house screener-engine strategies
 *      (`@usemoney/core/screener/strategies`), expressed directly in the
 *      engine's `ScreenerFilter[]` vocabulary.
 *
 * SEBI note: a scan SURFACES data (stocks matching a technical/fundamental
 * condition). It is NOT a buy/sell recommendation. Catalog copy, card
 * labels, and result rendering must stay descriptive — never advisory.
 *
 * This module is PURE (no server-only imports) so it can be imported by
 * the client, by the `runScanAction` server action, and unit-tested under
 * node:test. We import only the three pure data modules via dedicated
 * subpaths — never the package root barrels (which drag server deps).
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
import { isScreenerRunnable } from "@/lib/scans/scan-filters";

// ── Public types ─────────────────────────────────────────────────────

export type ScanSource = "chartink" | "builtin" | "core";

/**
 * The canonical scan category buckets. These collapse the three source
 * registries' overlapping taxonomies (e.g. research "value" + core
 * "value") into one set of human-facing groups.
 */
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
  /**
   * Engine-native filter set — present for scans we can run INLINE via
   * the screener engine (`@usemoney/core/screener` runScreener). Absent
   * for Chartink-DSL scans and Tickertape-metric builtin scans we can't
   * yet translate (those are browse-only; see DEFERRED in scan-filters.ts).
   */
  filters?: ScreenerFilter[];
  /**
   * True when this scan can be executed inline by `runScanAction` (i.e.
   * `filters` is populated with engine-recognised fields). Chartink-DSL
   * and unmappable builtin scans are `false` — the UI shows them as
   * browse cards with an "Open in screener / chat" affordance.
   */
  runnable: boolean;
}

export interface ScanCategoryInfo {
  category: ScanCategory | "all";
  count: number;
  label: string;
}

// ── Category labels ──────────────────────────────────────────────────

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

// ── Category normalisation ───────────────────────────────────────────

/** Map a Chartink category onto the unified `ScanCategory` set. */
function normalizeChartinkCategory(
  c: ChartinkScanDef["category"]
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

/** Map a research builtin-strategy category onto the unified set. */
function normalizeBuiltinCategory(
  c: BuiltInStrategy["category"]
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

/** Map a core screener-strategy category (free-form string) onto the set. */
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

// ── id / name normalisation for dedupe ───────────────────────────────

/** Lowercase, strip non-alphanumerics — used to dedupe equivalent scans
 *  that exist in more than one registry (e.g. "Golden Cross"). */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ── Catalog assembly ─────────────────────────────────────────────────

/**
 * Build the catalog once at module load. Merge order matters for dedupe:
 * CORE first (engine-native, inline-runnable), then BUILTIN, then
 * CHARTINK — so when two registries describe the same scan (by normalised
 * name) we keep the more-executable one. Each `id` is namespaced by source
 * so ids never collide across sources; the dedupe is on normalised NAME.
 */
function buildCatalog(): ScanDef[] {
  const out: ScanDef[] = [];
  const seenNames = new Set<string>();

  // 1. Core screener strategies — engine-native, run inline.
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
      // Runnable inline only when ≥1 filter maps onto a fundamental band the
      // screener engine can apply (P/E, ROE, rev-growth, D/E, div-yield,
      // mcap). Pure-technical core scans (golden_cross, rsi_14, …) are
      // browse-only until the async DSL path lands — see DEFERRED below.
      runnable: isScreenerRunnable(s.filters),
    });
  }

  // 2. Research builtin strategies — Tickertape-metric based; browse-only
  //    inline today (filters carry Tickertape codes the engine doesn't
  //    recognise). DEFERRED: a metric-code → engine-field translator.
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

  // 3. Chartink DSL scans — browse-only inline today (raw scan_clause
  //    needs the async strategy-scan worker path). DEFERRED follow-up.
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

/** Derive lightweight tags for a core strategy (it has no `tags` field). */
function deriveCoreTags(s: ScreenerStrategy): string[] {
  const tags = new Set<string>([s.category.toLowerCase()]);
  for (const f of s.filters) tags.add(f.field);
  return Array.from(tags);
}

/** The complete, deduped scan catalog. */
export const SCAN_CATALOG: ScanDef[] = buildCatalog();

// ── Helpers ──────────────────────────────────────────────────────────

/** All scans, optionally filtered by category. */
export function listScans(category?: ScanCategory): ScanDef[] {
  if (!category) return SCAN_CATALOG;
  return SCAN_CATALOG.filter((s) => s.category === category);
}

/** Scans for a given category (empty array when none). */
export function scansByCategory(category: ScanCategory): ScanDef[] {
  return SCAN_CATALOG.filter((s) => s.category === category);
}

/** Look up a single scan by its namespaced id. */
export function getScan(id: string): ScanDef | undefined {
  return SCAN_CATALOG.find((s) => s.id === id);
}

/**
 * Category buckets with counts, sorted by count desc, prefixed with an
 * "All" pseudo-category. Empty categories are omitted.
 */
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

/** Free-text search across name, description, tags, category, source. */
export function searchScans(query: string): ScanDef[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return SCAN_CATALOG;

  return SCAN_CATALOG.filter((s) => {
    const haystack = [s.name, s.description, s.category, s.source, ...s.tags]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
