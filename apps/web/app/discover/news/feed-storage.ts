/**
 * Feed definition + localStorage persistence.
 *
 * Only USER-CREATED feeds are persisted. The "My portfolio" feed is
 * virtual — derived from the user's actual holdings each load. Sample
 * feeds were removed; if the user has no holdings AND no custom feeds,
 * the UI renders an empty state.
 */

export interface FeedDef {
  id: string;
  name: string;
  symbols: string[];
  keywords?: string[];
  sentiment?: "any" | "positive" | "negative";
  createdAt: string;
  /** "portfolio" = virtual, derived from holdings each render; never
   *  written to storage. "custom" = user-created, persisted. */
  source?: "portfolio" | "custom";
}

const STORAGE_KEY = "usemoney.feeds.v2";
const PORTFOLIO_FEED_ID = "virtual_portfolio";

export function makePortfolioFeed(holdingSymbols: string[]): FeedDef {
  return {
    id: PORTFOLIO_FEED_ID,
    name: "My portfolio",
    symbols: holdingSymbols,
    sentiment: "any",
    createdAt: new Date(0).toISOString(),
    source: "portfolio",
  };
}

export function isPortfolioFeed(f: FeedDef): boolean {
  return f.id === PORTFOLIO_FEED_ID;
}

export function loadCustomFeeds(): FeedDef[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FeedDef[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => f && f.id !== PORTFOLIO_FEED_ID);
  } catch {
    return [];
  }
}

export function saveCustomFeeds(feeds: FeedDef[]): void {
  if (typeof window === "undefined") return;
  try {
    const toSave = feeds.filter((f) => f.id !== PORTFOLIO_FEED_ID);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    // localStorage full / private mode — silently drop.
  }
}
