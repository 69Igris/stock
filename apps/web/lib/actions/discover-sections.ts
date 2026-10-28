"use server";

/**
 * Discover data-engine section actions — MONEY-1204 (P14 / 14d.2 · 14d.3 ·
 * 14d.5 · 14d.6).
 *
 * Thin wrappers over `@usemoney/services`' `discover-sections.service`. The
 * logic, the query shapes, the cache keys and the TTLs all live there so the
 * `apps/api` mirror is the SAME code rather than a second copy that drifts —
 * the standing "keep apps/api in sync with the server actions" rule satisfied
 * by construction rather than by review. Precedent:
 * `discover-indices.ts`'s `getIndicesAction` over `getIndices`.
 *
 * ## Why there is no cache-first block in these actions
 *
 * The house action pattern reads the cache before the `try`. That belongs on
 * actions that own their query. These do not: the service already does
 * cache-first on `("discover", "_global", …)` with a market-clocked TTL, and it
 * is the only layer that knows the right key (the IPO key carries the IST day;
 * the positioning key carries participant AND metric). A second cache here
 * would be a second TTL for one datum, invalidated by neither side, and would
 * serve a stale IPO bucketing across the IST midnight the service key exists to
 * roll over. One owner, one key.
 *
 * ## GLOBAL data
 *
 * Market/reference facts, no user scope — so no `auth()`, no demo branch and no
 * `revalidatePath`, exactly like `getIndicesAction`. Route access is enforced by
 * `proxy.ts`: every path these feed sits under `/discover(.*)`, which is already
 * in `APP_ROUTE_PATTERNS` (auth OR demo cookie).
 *
 * Every action returns `ServiceResult<WithProvenance<T>>`. Missing data is
 * `success: true` with `empty: true` — never a 404, never an error.
 */

import {
  getCircularFeed,
  getCircularsForSymbol,
  getIndexDetail,
  getInstitutionalFlows,
  getIpoDashboardCard,
  getIpoSections,
  getMacroStrip,
  getMarketPositioning,
  type CircularFeedData,
  type IndexDetailData,
  type InstitutionalFlowsData,
  type IpoDashboardData,
  type IpoSectionsData,
  type MacroStripData,
  type MarketPositioningData,
  type SymbolCircularsData,
  type ServiceResult,
  type WithProvenance,
} from "@usemoney/services";

// Re-exported so components import their prop types from the action they call,
// not from the service package directly — the same seam every other discover
// action uses.
export type {
  CircularFeedData,
  IndexDetailData,
  InstitutionalFlowsData,
  IpoDashboardData,
  IpoSectionsData,
  MacroStripData,
  MarketPositioningData,
  SymbolCircularsData,
};

// ── 14d.2 — markets widgets ──────────────────────────────────────────────────

/** FII/DII cash flows: daily net + trailing cumulative + sparkline, ₹ crore. */
export async function getInstitutionalFlowsAction(args?: {
  windowSessions?: number;
  segment?: string;
}): Promise<ServiceResult<WithProvenance<InstitutionalFlowsData>>> {
  return getInstitutionalFlows(args ?? {});
}

/**
 * Participant positioning for ONE participant at ONE metric.
 *
 * `metric` is not optional in the service's query and must not become optional
 * here: `market_positioning` also holds `nse-fii-stats` rows for the same
 * participant on the same days at a different grain, and an unfiltered read
 * mixes contract counts with rupees and totals with their breakdowns.
 */
export async function getMarketPositioningAction(args?: {
  participant?: string;
  metric?: "OI" | "VOLUME";
}): Promise<ServiceResult<WithProvenance<MarketPositioningData>>> {
  return getMarketPositioning(args ?? {});
}

/** Repo rate, CPI YoY, WPI YoY, forex reserves — each with its OWN as-on date. */
export async function getMacroStripAction(): Promise<
  ServiceResult<WithProvenance<MacroStripData>>
> {
  return getMacroStrip({});
}

// ── 14d.3 — IPO ──────────────────────────────────────────────────────────────

/** Upcoming / currently bidding / recently listed, bucketed on the IST day. */
export async function getIpoSectionsAction(args?: {
  recentDays?: number;
}): Promise<ServiceResult<WithProvenance<IpoSectionsData>>> {
  return getIpoSections(args ?? {});
}

/**
 * The dashboard card payload.
 *
 * `data.empty === true` means nothing is open and nothing is forthcoming — the
 * dashboard should render NOTHING rather than a permanent "no IPOs" tile.
 */
export async function getIpoDashboardCardAction(args?: {
  limit?: number;
}): Promise<ServiceResult<WithProvenance<IpoDashboardData>>> {
  return getIpoDashboardCard(args ?? {});
}

// ── 14d.5 — circulars ────────────────────────────────────────────────────────

/** Exchange circular feed, optionally filtered by department or topic. */
export async function getCircularFeedAction(args?: {
  department?: string;
  topic?: string;
  limit?: number;
  skip?: number;
}): Promise<ServiceResult<WithProvenance<CircularFeedData>>> {
  return getCircularFeed(args ?? {});
}

/**
 * Circulars that MENTION a symbol — a heuristic strip, never a fact.
 *
 * The payload carries its own `disclaimer`; the component must render it. This
 * is a token match on the ticker in NSE's `company` column or in the free-text
 * subject, not an exchange-provided link, and it has real false positives.
 */
export async function getCircularsForSymbolAction(args: {
  symbol: string;
  departments?: string[];
  limit?: number;
  days?: number;
}): Promise<ServiceResult<WithProvenance<SymbolCircularsData>>> {
  return getCircularsForSymbol(args);
}

// ── 14d.6 — index detail ─────────────────────────────────────────────────────

/**
 * Everything `/discover/indices/[slug]` renders.
 *
 * An index with no constituent list is NOT an error — ~90 of the indices NSE
 * publishes closes for have no list, and the route serves the price and
 * valuation blocks with the constituents section in its empty state.
 */
export async function getIndexDetailAction(args: {
  slug: string;
  sessions?: number;
}): Promise<ServiceResult<WithProvenance<IndexDetailData>>> {
  return getIndexDetail(args);
}
