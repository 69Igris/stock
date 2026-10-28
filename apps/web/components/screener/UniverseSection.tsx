"use client";

/**
 * UNIVERSE block at the top of the Screener filter sidebar (MONEY-243,
 * design Image #42). Three controls:
 *
 *   1. Exchange - segmented (NSE / BSE / Both) - drives the `exchange`
 *      filter on the active filter set. "Both" is encoded as undefined.
 *   2. Index (broad-market) - dropdown for the seven everyday Nifty
 *      benchmarks (50 / Next 50 / 100 / 500 / Midcap / Midcap-50 /
 *      Smallcap 250). Most users only ever touch this one.
 *   3. Index (sectoral & thematic) - dropdown for everything else
 *      (Bank / IT / Pharma / FMCG / sectoral · thematic · strategy).
 *
 * Both dropdowns write into the same `index` filter - picking a value
 * in one clears the other (its current filter is no longer in that
 * dropdown's bucket so it falls back to "All listed"). Splitting the
 * surface keeps the common case (broad-market) one click away while
 * still exposing the full ~30-index catalogue.
 *
 * Generic - both stocks-mode and (future) funds-mode can render this
 * block; the consumer wires `value` + `onChange` for exchange.
 */

import { useEffect, useMemo, useState } from "react";
import { INDEX_OPTIONS } from "@/lib/screener/index-constituents";

export type ExchangeChoice = "NSE" | "BSE" | "BOTH";

interface UniverseSectionProps {
  /** Active exchange. Defaults to "NSE" - NSE has the deepest coverage
   *  and matches the design copy in Image #75. */
  exchange: ExchangeChoice;
  onExchangeChange: (next: ExchangeChoice) => void;
  /** Active index id (controlled mode). When provided, the dropdown
   *  reflects the parent's value and pushes changes via `onIndexChange`.
   *  When omitted the legacy localStorage-only behaviour kicks in. */
  index?: string;
  onIndexChange?: (next: string) => void;
  /** localStorage key under which the index choice lives. */
  indexStorageKey?: string;
  /** Default index when nothing stored. */
  defaultIndex?: string;
}

/** Subset that lives in the FIRST dropdown - the everyday benchmarks
 *  most retail users care about. Order = display order. */
const BROAD_MARKET_VALUES: readonly string[] = [
  "nifty50",
  "niftynext50",
  "nifty100",
  "nifty500",
  "niftymidcap100",
  "niftymidcap150",
  "niftymidsmall400",
  "niftysmallcap250",
];

interface IndexBucketOption {
  value: string;
  label: string;
  group?: string;
}

export function UniverseSection({
  exchange,
  onExchangeChange,
  index: indexProp,
  onIndexChange,
  indexStorageKey = "screener.index.stocks",
  defaultIndex = "all",
}: UniverseSectionProps) {
  const isControlled = indexProp !== undefined && onIndexChange !== undefined;
  const [internalIndex, setInternalIndex] = useState<string>(defaultIndex);
  const activeIndex = isControlled ? indexProp : internalIndex;

  // Hydrate localStorage once on mount; only matters in uncontrolled mode.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isControlled) return;
    const stored = window.localStorage.getItem(indexStorageKey);
    if (stored) setInternalIndex(stored);
  }, [indexStorageKey, isControlled]);

  function commit(next: string) {
    if (isControlled) {
      onIndexChange!(next);
      return;
    }
    setInternalIndex(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(indexStorageKey, next);
    }
  }

  // Split INDEX_OPTIONS into the two buckets. Recompute only if the
  // catalogue changes (it's static at module level so this is cheap).
  const { broadOptions, otherOptions } = useMemo(() => {
    const broadSet = new Set(BROAD_MARKET_VALUES);
    const broad: IndexBucketOption[] = [{ value: "all", label: "All listed" }];
    const other: IndexBucketOption[] = [{ value: "all", label: "All listed" }];
    // Preserve user-requested ordering inside the broad bucket.
    for (const v of BROAD_MARKET_VALUES) {
      const opt = INDEX_OPTIONS.find((o) => o.value === v);
      if (opt) broad.push(opt);
    }
    // Everything else falls into the second dropdown, preserving the
    // section grouping from INDEX_OPTIONS.
    for (const opt of INDEX_OPTIONS) {
      if (opt.value === "all") continue;
      if (broadSet.has(opt.value)) continue;
      other.push(opt);
    }
    return { broadOptions: broad, otherOptions: other };
  }, []);

  // Pre-expansion localStorage may carry orphaned ids (e.g. legacy
  // "midcap150" before this file moved to "niftymidcap150"). Treat any
  // id we don't recognise as "all" so the dropdown doesn't silently
  // ghost a value that has no matching <option> - React would warn
  // and the user couldn't see what's filtered.
  const knownValues = useMemo(
    () => new Set(INDEX_OPTIONS.map((o) => o.value)),
    []
  );
  const safeIndex = knownValues.has(activeIndex) ? activeIndex : "all";
  const isBroadActive =
    safeIndex !== "all" && BROAD_MARKET_VALUES.includes(safeIndex);
  const broadValue = isBroadActive ? safeIndex : "all";
  const otherValue = isBroadActive ? "all" : safeIndex;

  return (
    <div
      className="rounded-[10px] p-3 space-y-3"
      style={{
        border: "1.5px solid var(--ink)",
        background: "var(--paper-2)",
      }}
    >
      <div>
        <div className="mono text-[9.5px] tracking-[1.4px] uppercase font-bold text-[var(--ink-3)] mb-1.5">
          Universe
        </div>
        <div className="mono text-[10px] tracking-[0.5px] uppercase text-[var(--ink-3)] mb-1">
          Exchange
        </div>
        <div
          className="inline-flex w-full items-center gap-[2px] rounded-[7px] p-[2px]"
          style={{
            border: "1.5px solid var(--ink)",
            background: "var(--paper)",
          }}
        >
          {(["NSE", "BSE", "BOTH"] as ExchangeChoice[]).map((opt) => {
            const active = exchange === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onExchangeChange(opt)}
                className="flex-1 px-2 py-1 rounded-[5px] text-[11px] mono font-bold cursor-pointer transition-colors"
                style={
                  active
                    ? { background: "var(--ink)", color: "var(--paper)" }
                    : { background: "transparent", color: "var(--ink-3)" }
                }
              >
                {opt === "BOTH" ? "Both" : opt}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mono text-[10px] tracking-[0.5px] uppercase text-[var(--ink-3)] mb-1">
          Index - Broad market
        </div>
        <select
          value={broadValue}
          onChange={(e) => commit(e.target.value)}
          className="pf-input mono"
          style={{ padding: "8px 10px", fontSize: 12 }}
        >
          {broadOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="mono text-[10px] tracking-[0.5px] uppercase text-[var(--ink-3)] mb-1">
          Index - Sectoral & thematic
        </div>
        <select
          value={otherValue}
          onChange={(e) => commit(e.target.value)}
          className="pf-input mono"
          style={{ padding: "8px 10px", fontSize: 12 }}
        >
          {otherOptions.flatMap((o, i, arr) => {
            // For options that carry a `group`, surface the heading as
            // a disabled separator above the first option of that
            // section. Keeps users oriented in a 25-item dropdown
            // without needing optgroup nesting (which doesn't render
            // in some Linux browsers and clashes with our custom
            // typography).
            const prev = i > 0 ? arr[i - 1] : undefined;
            const showHeader = o.group && prev?.group !== o.group;
            const items = [];
            if (showHeader) {
              items.push(
                <option key={`hdr-${o.group}-${o.value}`} disabled>
                  ── {o.group} ──
                </option>
              );
            }
            items.push(
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            );
            return items;
          })}
        </select>
      </div>
    </div>
  );
}

export default UniverseSection;
