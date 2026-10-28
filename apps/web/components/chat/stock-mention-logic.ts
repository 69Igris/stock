/**
 * StockMentionPicker - pure logic (React-free)
 *
 * The localStorage-backed recents store + the Tab/Shift-Tab cycling helper live
 * here, split out of the `"use client"` `StockMentionPicker.tsx`, so they can be
 * unit-tested under `node:test`. The component imports and calls these (passing
 * the real `localStorage` / its dynamic visible-tab list), so production and the
 * tests run the SAME logic (no shadow).
 *
 * Storage is injectable (defaulting to `window.localStorage`) so the recents
 * helpers can be exercised against an in-memory shim without a DOM.
 */

export interface MentionedSymbol {
  symbol: string;
  name: string;
  exchange: string;
  type: "stock" | "mf" | "etf" | "broker";
  /** Only for type="broker" - connection ID so chat route can scope */
  brokerConnectionId?: string;
}

export type PickerTab = "recent" | "stocks" | "funds" | "brokers" | "commands";

export const RECENTS_KEY = "stocksage:mention-recents:v1";
export const RECENTS_CAP = 8;

/** The browser's localStorage, or null in a non-DOM context. */
function defaultStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/** Read + validate the recents list (capped, malformed entries dropped). */
export function loadRecents(
  storage: Storage | null = defaultStorage()
): MentionedSymbol[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is MentionedSymbol =>
          m &&
          typeof m === "object" &&
          typeof m.symbol === "string" &&
          typeof m.name === "string" &&
          typeof m.exchange === "string" &&
          (m.type === "stock" ||
            m.type === "mf" ||
            m.type === "etf" ||
            m.type === "broker")
      )
      .slice(0, RECENTS_CAP);
  } catch {
    return [];
  }
}

/** Prepend an item (dedup by symbol), cap the list, and persist. */
export function pushRecent(
  item: MentionedSymbol,
  storage: Storage | null = defaultStorage()
): void {
  if (!storage) return;
  const current = loadRecents(storage).filter((r) => r.symbol !== item.symbol);
  const next = [item, ...current].slice(0, RECENTS_CAP);
  try {
    storage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* quota - ignore */
  }
}

/**
 * Cycle to the next/previous visible tab. `tabs` is the dynamic visible-tab
 * list (the picker hides empty tabs), so cycling wraps within whatever is
 * shown. An unknown current tab snaps to the first.
 */
export function cycleTab(
  current: PickerTab,
  direction: "next" | "prev",
  tabs: PickerTab[]
): PickerTab {
  if (tabs.length === 0) return current;
  const idx = tabs.indexOf(current);
  if (idx === -1) return tabs[0]!;
  const nextIdx =
    direction === "next"
      ? (idx + 1) % tabs.length
      : (idx - 1 + tabs.length) % tabs.length;
  return tabs[nextIdx]!;
}
