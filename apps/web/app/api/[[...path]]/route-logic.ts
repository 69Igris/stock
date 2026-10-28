/**
 * Pure logic for the catch-all API route (`./route.ts`).
 *
 * The route imports Clerk + Prisma + the demo-session cookie reader, so it
 * can't be imported by a unit test. These side-effect-free helpers — path
 * parsing, the demo trade filter, POST trade-input validation, win-rate,
 * tag parsing, and the PATCH mass-assignment allowlists — are extracted here so
 * the route calls the REAL exported symbols and a test can assert them without
 * pulling server-only deps.
 *
 * Realized-P&L math is NOT duplicated: the route reuses
 * `calculateTradeRealizedPnL` / `calculateClosePositionPnL` from
 * `@/lib/db/trades-logic` (the single FIFO/realized-P&L source of truth).
 *
 * @see apps/web/__tests__/api/catch-all.test.ts
 */

/** Trade shape consumed by the demo `filterTrades` query helper. */
export interface FilterableTrade {
  symbol: string;
  segment: string;
  tradeType: string;
  brokerName: string;
  tradeDate: Date | string;
}

/** Filters the catch-all GET reads from the query string. */
export interface TradeQueryFilters {
  symbol?: string;
  broker?: string;
  segment?: string;
  tradeType?: string;
  fromDate?: string;
  toDate?: string;
}

/** Strip the `/api/` prefix to get the resource path (e.g. "trades"). */
export function parseApiPath(pathname: string): string {
  return pathname.replace("/api/", "");
}

/**
 * Split a pathname into segments: "/api/trades/123" → ["","api","trades","123"].
 * The route's PATCH/DELETE handlers key off `pathParts[2]` (resource) and
 * `pathParts[3]` (resource id).
 */
export function splitPathParts(pathname: string): string[] {
  return pathname.split("/");
}

/** GET `skip` query param, defaulting to 0. */
export function parseSkip(value: string | null): number {
  return parseInt(value || "0");
}

/** GET `limit` query param, defaulting to 20. */
export function parseLimit(value: string | null): number {
  return parseInt(value || "20");
}

/**
 * Filter demo trades by symbol (case-insensitive substring), broker, segment,
 * tradeType, and an inclusive (end-of-day) date range. `"all"` disables the
 * broker/segment/tradeType filters.
 */
export function filterTrades<T extends FilterableTrade>(
  trades: T[],
  filters: TradeQueryFilters
): T[] {
  return trades.filter((trade) => {
    if (
      filters.symbol &&
      !trade.symbol.toLowerCase().includes(filters.symbol.toLowerCase())
    )
      return false;
    if (
      filters.broker &&
      filters.broker !== "all" &&
      trade.brokerName !== filters.broker
    )
      return false;
    if (
      filters.segment &&
      filters.segment !== "all" &&
      trade.segment !== filters.segment
    )
      return false;
    if (
      filters.tradeType &&
      filters.tradeType !== "all" &&
      trade.tradeType !== filters.tradeType
    )
      return false;
    if (filters.fromDate) {
      const tradeDate = new Date(trade.tradeDate);
      const fromDate = new Date(filters.fromDate);
      if (tradeDate < fromDate) return false;
    }
    if (filters.toDate) {
      const tradeDate = new Date(trade.tradeDate);
      const toDate = new Date(filters.toDate);
      toDate.setHours(23, 59, 59, 999);
      if (tradeDate > toDate) return false;
    }
    return true;
  });
}

/**
 * Validate the POST body for trade creation: a string `symbol`, and positive
 * numeric `quantity` and `price` (string numbers accepted).
 */
export function validateTradeInput(body: Record<string, unknown>): {
  valid: boolean;
  error?: string;
} {
  if (!body.symbol || typeof body.symbol !== "string") {
    return { valid: false, error: "symbol is required" };
  }
  if (
    !body.quantity ||
    isNaN(Number(body.quantity)) ||
    Number(body.quantity) <= 0
  ) {
    return { valid: false, error: "valid quantity is required" };
  }
  if (!body.price || isNaN(Number(body.price)) || Number(body.price) <= 0) {
    return { valid: false, error: "valid price is required" };
  }
  return { valid: true };
}

/** Rounded winner-percentage over closed trades; 0 when none are closed. */
export function calculateWinRate(winners: number, totalClosed: number): number {
  if (totalClosed === 0) return 0;
  return Math.round((winners / totalClosed) * 100);
}

/** Split a comma-separated tags string, trimming and dropping empties. */
export function parseTags(tagsString: string | undefined): string[] {
  if (!tagsString) return [];
  return tagsString
    .split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);
}

// PATCH field allowlists — defend against mass assignment by only letting these
// keys through to `prisma.*.updateMany`.
export const TRADE_UPDATABLE_FIELDS = [
  "symbol",
  "exchange",
  "tradeType",
  "quantity",
  "price",
  "exitPrice",
  "tags",
  "notes",
  "brokerage",
  "taxes",
  "status",
  "tradeDate",
];

export const HOLDING_UPDATABLE_FIELDS = [
  "quantity",
  "averagePrice",
  "notes",
  "tags",
];

export const MF_UPDATABLE_FIELDS = ["notes", "tags"];

/** Keep only allowlisted keys from a PATCH body. */
export function sanitizeUpdateBody(
  body: Record<string, unknown>,
  allowedFields: string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => allowedFields.includes(key))
  );
}
