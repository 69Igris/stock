/* =====================================================================
   Screener chat — filter vocabulary + sanitizer  (MONEY-1078)
   ---------------------------------------------------------------------
   ONE source of truth for what the chat may write into screener filter
   state. Everything model-supplied flows through `sanitizeFilters`,
   which allowlists keys, coerces + clamps numbers, and canonicalises
   enums — so a hallucinated key or absurd value can never poison the
   screener (the same defensive posture as the FIRE executor's clamps
   and the AI filter builder's Zod `.strip()` allowlists).

   The vocab mirrors the REAL filter interfaces in
   lib/screener/match-score.ts (wider than the AI builder's subset:
   includes dividend yield, explicit market-cap bounds, and index
   membership). `limit` and `amcAny` are deliberately excluded — the
   first is a paging internal, the second is an array the chat can
   approximate with `amcName`.

   Pure module (no React, no server imports) so it is unit-testable and
   shared between the tool schema (descriptions) and the executor
   (validation).
   ===================================================================== */

import type { ScreenerMode } from "@/components/screener/ModeTabs";
import { INDEX_OPTIONS } from "@/lib/screener/index-constituents";

export type FieldSpec =
  | { kind: "number"; min: number; max: number; unit: string }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string"; maxLen: number };

const pct = (min: number, max: number): FieldSpec => ({
  kind: "number",
  min,
  max,
  unit: "percent",
});
const crore = (max: number): FieldSpec => ({
  kind: "number",
  min: 0,
  max,
  unit: "₹ crore",
});

/**
 * Index membership vocab — DERIVED from the screener's own index list, never
 * hand-maintained.
 *
 * A parallel hand-written list drifted and shipped a silent no-op: it offered
 * "midcap150" / "smallcap250", but the resolver only knows
 * "niftymidcap150" / "niftysmallcap250". An unrecognised id falls through
 * `resolveIndexFilter` to `{ kind: "all" }`, so the chat happily reported
 * "Applied index=midcap150" while the query filtered nothing and the sidebar
 * showed "All listed". Deriving from INDEX_OPTIONS makes that class of drift
 * impossible and exposes ALL the indexes (sectoral, midcap/smallcap tiers)
 * instead of the seven that were hardcoded.
 *
 * "all" is dropped: it is the no-filter sentinel, and the chat clears the
 * index with `null` (see sanitizeFilters) rather than by naming it.
 */
export const STOCK_INDEXES: readonly string[] = INDEX_OPTIONS.map(
  (o) => o.value
).filter((v) => v !== "all");

export const STOCK_FIELDS: Record<string, FieldSpec> = {
  exchange: { kind: "enum", values: ["NSE", "BSE"] },
  sector: { kind: "string", maxLen: 40 },
  marketCapBucket: { kind: "enum", values: ["LARGE", "MID", "SMALL"] },
  minMarketCap: crore(10_000_000),
  maxMarketCap: crore(10_000_000),
  minPe: { kind: "number", min: 0, max: 10_000, unit: "ratio" },
  maxPe: { kind: "number", min: 0, max: 10_000, unit: "ratio" },
  minRoe: pct(-1000, 1000),
  maxRoe: pct(-1000, 1000),
  minRevenueGrowth: pct(-1000, 10_000),
  maxRevenueGrowth: pct(-1000, 10_000),
  minDebtToEquity: { kind: "number", min: 0, max: 1000, unit: "ratio" },
  maxDebtToEquity: { kind: "number", min: 0, max: 1000, unit: "ratio" },
  minDividendYield: pct(0, 100),
  maxDividendYield: pct(0, 100),
  index: { kind: "enum", values: STOCK_INDEXES },
};

export const MF_FIELDS: Record<string, FieldSpec> = {
  category: { kind: "string", maxLen: 40 },
  amcName: { kind: "string", maxLen: 80 },
  plan: { kind: "enum", values: ["DIRECT", "REGULAR"] },
  riskLevel: { kind: "enum", values: ["Low", "Moderate", "High", "Very High"] },
  fundType: {
    kind: "enum",
    values: ["equity", "debt", "hybrid", "solution", "other"],
  },
  minAum: crore(10_000_000),
  maxAum: crore(10_000_000),
  minReturns1Y: pct(-100, 1000),
  maxReturns1Y: pct(-100, 1000),
  minReturns3Y: pct(-100, 1000),
  maxReturns3Y: pct(-100, 1000),
  minReturns5Y: pct(-100, 1000),
  maxReturns5Y: pct(-100, 1000),
  minExpenseRatio: pct(0, 10),
  maxExpenseRatio: pct(0, 10),
};

export const ETF_FIELDS: Record<string, FieldSpec> = {
  exchange: { kind: "enum", values: ["NSE", "BSE"] },
  assetClass: {
    kind: "enum",
    values: ["equity", "debt", "hybrid", "solution", "other"],
  },
  theme: { kind: "string", maxLen: 60 },
  amcName: { kind: "string", maxLen: 80 },
  category: { kind: "string", maxLen: 40 },
  minAum: crore(10_000_000),
  maxAum: crore(10_000_000),
  minReturns1Y: pct(-100, 1000),
  maxReturns1Y: pct(-100, 1000),
  minExpenseRatio: pct(0, 10),
  maxExpenseRatio: pct(0, 10),
};

export const FIELDS_BY_MODE: Record<ScreenerMode, Record<string, FieldSpec>> = {
  stocks: STOCK_FIELDS,
  mf: MF_FIELDS,
  etf: ETF_FIELDS,
};

/* ── Sort vocab (mirrors StockSortKey / FundSortKey in lib/actions) ─── */

export const STOCK_SORTS = [
  "match",
  "mcap-desc",
  "mcap-asc",
  "change-desc",
  "change-asc",
  "name-asc",
  "name-desc",
] as const;

export const FUND_SORTS = [
  "match",
  "nav-desc",
  "nav-asc",
  "aum-desc",
  "ret1y-desc",
  "ret3y-desc",
  "ret5y-desc",
] as const;

export const SORTS_BY_MODE: Record<ScreenerMode, readonly string[]> = {
  stocks: STOCK_SORTS,
  mf: FUND_SORTS,
  etf: FUND_SORTS,
};

/* ── Sanitizer ───────────────────────────────────────────────────────── */

export interface SanitizedFilters {
  /** Keys accepted (coerced/clamped/canonicalised), ready to merge. */
  applied: Record<string, string | number>;
  /** Keys the model asked to UNSET (explicit null). */
  cleared: string[];
  /** Keys dropped: unknown, wrong type, empty, or unmatched enum. */
  dropped: string[];
  /** Human notes for values that were corrected (clamps, enum casing). */
  notes: string[];
}

function coerceNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Validate a model-supplied bag of filter args against a mode's vocab.
 * - unknown key → dropped
 * - null value → cleared (explicit unset request)
 * - number: coerce ("25" → 25), require finite, clamp into [min,max]
 * - enum: case-insensitive match to the canonical value, else dropped
 * - string: trimmed + length-capped, empty → cleared
 */
export function sanitizeFilters(
  mode: ScreenerMode,
  args: Record<string, unknown>
): SanitizedFilters {
  const fields = FIELDS_BY_MODE[mode];
  const out: SanitizedFilters = {
    applied: {},
    cleared: [],
    dropped: [],
    notes: [],
  };

  for (const [key, raw] of Object.entries(args)) {
    // `Object.hasOwn`, never `fields[key]` alone: inherited names like
    // "constructor" / "toString" / "valueOf" resolve truthy off the
    // prototype chain, and the resulting non-FieldSpec would fall through
    // to the string branch with `maxLen` undefined — merging an unbounded,
    // unvalidated value into filter state instead of dropping it.
    const spec = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!spec) {
      out.dropped.push(key);
      continue;
    }
    if (raw === null) {
      out.cleared.push(key);
      continue;
    }
    if (raw === undefined) continue;

    if (spec.kind === "number") {
      // An empty / whitespace-only string means "unset this", NOT zero.
      // `Number("")` is 0 and passes Number.isFinite, so without this guard
      // `{ minPe: "" }` would silently apply a real `minPe: 0` bound and
      // narrow the screen. Mirrors how the string branch treats "" below.
      if (typeof raw === "string" && raw.trim() === "") {
        out.cleared.push(key);
        continue;
      }
      const n = coerceNumber(raw);
      if (n === null) {
        out.dropped.push(key);
        continue;
      }
      const clamped = Math.min(spec.max, Math.max(spec.min, n));
      if (clamped !== n) {
        out.notes.push(
          `${key} clamped to the allowed ${spec.min}–${spec.max} range`
        );
      }
      out.applied[key] = clamped;
    } else if (spec.kind === "enum") {
      const s = String(raw).trim();
      const match = spec.values.find(
        (v) => v.toLowerCase() === s.toLowerCase()
      );
      if (!match) {
        out.dropped.push(key);
        continue;
      }
      out.applied[key] = match;
    } else {
      const s = String(raw).trim().slice(0, spec.maxLen);
      if (!s) {
        out.cleared.push(key);
        continue;
      }
      out.applied[key] = s;
    }
  }

  // Cross-field sanity: an inverted range (min > max) can never match a
  // single row, so the screen goes empty with nothing explaining why. The
  // intent of "PE between 100 and 10" is unambiguous, so swap the bounds
  // and record a note — the note reaches the model in the tool result, so
  // it sees the correction instead of silently getting an empty screen.
  // Only pairs supplied in THIS call are checked; the sanitizer never sees
  // the already-active filters it is being merged into.
  for (const minKey of Object.keys(out.applied)) {
    if (!minKey.startsWith("min")) continue;
    const maxKey = `max${minKey.slice(3)}`;
    if (!Object.hasOwn(out.applied, maxKey)) continue;
    const lo = out.applied[minKey];
    const hi = out.applied[maxKey];
    if (typeof lo === "number" && typeof hi === "number" && lo > hi) {
      out.applied[minKey] = hi;
      out.applied[maxKey] = lo;
      out.notes.push(
        `${minKey}/${maxKey} range was inverted (${lo} > ${hi}) — swapped to ${hi}–${lo}`
      );
    }
  }

  // Market cap has TWO representations — the LARGE/MID/SMALL bucket and an
  // explicit ₹-crore band — and `resolveMarketCapRange` merges them per
  // FIELD, not per group: it takes the bucket's bound where it has one and
  // silently falls back to the explicit value where it doesn't. LARGE has no
  // max, so an active `marketCapBucket: "LARGE"` plus a chat-set
  // `maxMarketCap: 8000` resolves to min 20000 / max 8000 — impossible, zero
  // rows, while the executor reports the band as applied.
  //
  // Whichever representation this call sets therefore CLEARS the other. The
  // clear is emitted even when the other form isn't currently active (an
  // unset of an absent key is a no-op), because the sanitizer cannot see the
  // filters it is being merged into.
  if (mode === "stocks") {
    const setsBand =
      Object.hasOwn(out.applied, "minMarketCap") ||
      Object.hasOwn(out.applied, "maxMarketCap");
    const setsBucket = Object.hasOwn(out.applied, "marketCapBucket");

    if (setsBand && setsBucket) {
      // Both in one call: keep the explicit band (more precise) and say so.
      delete out.applied.marketCapBucket;
      out.notes.push(
        "marketCapBucket dropped — an explicit market-cap band was given in the same call, and the two cannot both apply"
      );
    }
    const conflicting = setsBand
      ? ["marketCapBucket"]
      : setsBucket
        ? ["minMarketCap", "maxMarketCap"]
        : [];
    for (const k of conflicting) {
      if (!out.cleared.includes(k)) out.cleared.push(k);
    }
  }

  return out;
}

/** Validate a sort key for a mode; returns the key or null. */
export function sanitizeSort(mode: ScreenerMode, raw: unknown): string | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  return SORTS_BY_MODE[mode].includes(s) ? s : null;
}
