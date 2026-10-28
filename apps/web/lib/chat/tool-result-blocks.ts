/**
 * Shared list/data tool -> ContentBlock rendering (MONEY-587).
 *
 * Why: the narration short-circuit ("show the data, don't call the LLM") is only
 * safe if the rendered blocks actually contain the data. Many read tools have NO
 * typed block AND return wrapper shapes ({ scans: [...] }, { builtIn, custom },
 * { documents, total }) that the route's generic table formatter — which gates on
 * `Array.isArray(data)` — renders empty/garbled. This module unwraps the primary
 * rows from any common shape and renders a typed block / stock-list / table, so a
 * skipped-narration answer never claims "list below" with no list.
 *
 * Used by BOTH chat lanes (/api/chat free-text + /api/chat/execute-tool chips)
 * so rendering can't diverge. Server-side; imports the pure block builders.
 */

import type { ContentBlock, TableColumn } from "@usemoney/types";
import { buildScreenerBlocks } from "./screener-blocks";
import {
  buildTypedBlockFromTool,
  buildSecondaryBlocksFromTool,
} from "../chat-tools/typed-blocks";

/** Keys we never surface as table columns. */
const HIDDEN_COLS = new Set([
  "id",
  "_id",
  "userId",
  "user_id",
  "clerkId",
  "createdAt",
  "updatedAt",
  "__v",
]);

/** Wrapper keys, in priority order, whose value is the primary row array. */
const ROW_WRAPPER_KEYS = [
  "data",
  "results",
  "rows",
  "items",
  "scans",
  "documents",
  "positions",
  "holdings",
  "mutualFunds",
  "funds",
  "trades",
  "articles",
  "scenarios",
  "stocks",
];

/**
 * Unwrap the primary row array from any common tool payload: a bare array,
 * `{ data|results|scans|documents|... : [...] }`, `{ builtIn, custom }` (merge),
 * or — as a last resort — the first array-valued property. Returns null when no
 * array is present (e.g. a single-object payload like get_financial_data).
 */
export function extractPrimaryRows(
  data: unknown
): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // list_strategies: { builtIn: [...], custom: [...], categories: [...] }
  if (Array.isArray(obj.builtIn) || Array.isArray(obj.custom)) {
    return [
      ...((obj.builtIn as Record<string, unknown>[]) || []),
      ...((obj.custom as Record<string, unknown>[]) || []),
    ];
  }
  for (const k of ROW_WRAPPER_KEYS) {
    if (Array.isArray(obj[k])) return obj[k] as Record<string, unknown>[];
  }
  // Last resort: the first array-valued property.
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return null;
}

/** Humanize a camelCase / snake_case key into a column label. */
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Infer a TableColumn format from the key name + a sample value. */
function inferFormat(key: string, value: unknown): TableColumn["format"] {
  const k = key.toLowerCase();
  if (/(pnl|profit|gain|loss)/.test(k)) return "pnl";
  if (/(percent|pct|return|yield|change|ratio|growth|cagr|xirr)/.test(k))
    return "percentage";
  if (/(price|value|nav|amount|invested|corpus|cap|aum|cost|ltp|avg)/.test(k))
    return "currency";
  if (/(date|at$|time|executed|expiry)/.test(k)) return "date";
  if (typeof value === "number") return "number";
  return "text";
}

/** Whether a value can be shown in a table cell. */
function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

/** Do these rows look like instruments (have a symbol)? -> stock-list, not table. */
function looksLikeStocks(rows: Record<string, unknown>[]): boolean {
  const r = rows[0] || {};
  return typeof (r.symbol ?? r.tradingsymbol) === "string";
}

/**
 * Build a generic TableBlock from row objects: pick up to 6 scalar columns
 * (preferring a name/symbol-ish first column), humanized labels + inferred
 * formats, capped to a sensible row count. Returns null if no scalar columns.
 */
export function buildTableBlock(
  rows: Record<string, unknown>[],
  title?: string
): ContentBlock | null {
  if (!rows.length) return null;
  // Union of scalar keys across the first few rows (rows can be sparse).
  const keys: string[] = [];
  for (const row of rows.slice(0, 5)) {
    for (const [k, v] of Object.entries(row)) {
      if (HIDDEN_COLS.has(k)) continue;
      if (isScalar(v) && !keys.includes(k)) keys.push(k);
    }
  }
  if (keys.length === 0) return null;

  // Put a name/label-ish column first, then cap to 6 columns.
  keys.sort((a, b) => {
    const score = (k: string) =>
      /^(name|scheme|symbol|tradingsymbol|company|scanname|title)$/i.test(k)
        ? 0
        : 1;
    return score(a) - score(b);
  });
  const chosen = keys.slice(0, 6);
  const sample = rows[0]!;
  const columns: TableColumn[] = chosen.map((key) => ({
    key,
    label: humanizeKey(key),
    format: inferFormat(key, sample[key]),
  }));

  return {
    type: "table",
    title,
    columns,
    rows: rows.slice(0, 25) as Record<string, unknown>[],
    maxRows: 15,
  } as ContentBlock;
}

/**
 * Render a list/data tool's result into blocks, choosing the best representation:
 *   - screener / scan results -> stock-list (via buildScreenerBlocks)
 *   - tools with a typed block (holdings / portfolio / news / risk) -> that block
 *   - any other list shape -> a generic table
 * Returns [] when nothing renderable is found (caller can fall back / keep prose).
 */
export function buildListToolBlocks(
  tool: string,
  data: unknown,
  query?: string
): ContentBlock[] {
  if (tool === "run_screener") {
    return buildScreenerBlocks(data, query);
  }

  if (tool === "get_scan_result") {
    const rows = extractPrimaryRows(data);
    if (rows && rows.length && looksLikeStocks(rows)) {
      const title = (data as Record<string, unknown>)?.scanName as
        | string
        | undefined;
      return buildScreenerBlocks({ data: rows, message: title }, query);
    }
    if (rows && rows.length) {
      const t = buildTableBlock(
        rows,
        ((data as Record<string, unknown>)?.scanName as string) ||
          "Scan results"
      );
      return t ? [t] : [];
    }
  }

  // Tools with a dedicated rich typed block render through it, plus any
  // secondary blocks the same result can produce (e.g. risk → sector donut).
  const typed = buildTypedBlockFromTool(tool, data);
  if (typed) return [typed, ...buildSecondaryBlocksFromTool(tool, data)];

  // Everything else: unwrap the primary rows and render a generic table.
  const rows = extractPrimaryRows(data);
  if (rows && rows.length) {
    if (looksLikeStocks(rows)) {
      return buildScreenerBlocks({ data: rows }, query);
    }
    const t = buildTableBlock(rows);
    return t ? [t] : [];
  }
  return [];
}
