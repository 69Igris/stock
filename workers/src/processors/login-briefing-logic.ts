/**
 * Login-briefing processor — PURE computation logic (no Prisma / Gemini / I/O).
 *
 * Side-effect-free helpers extracted out of `login-briefing.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies) without booting a
 * Prisma client, `getGeminiModel`, or `createNotification` at module load.
 * `login-briefing.ts` imports and CALLS these exports, so the production code
 * path and the tests execute the SAME code. Mirrors the worker precedent
 * `sync-logic.ts` / `import-logic.ts` / `pairing-logic.ts`.
 *
 * The old inline `login-briefing.test.ts` re-implemented `detectSignificantMovers`
 * and the portfolio-section builder and asserted the COPY — a textbook shadow.
 * Worse, its copy DROPPED the null-guards the production code has
 * (`h.currentValue ?? 0`, `h.pnlPercentage != null`), so it could never have
 * caught a regression in them.
 *
 * @see workers/src/processors/login-briefing.ts (caller)
 * @see apps/web/__tests__/workers/login-briefing.test.ts (tests the real exports)
 */

// The ONE stored-value decoder and the ONE kind-shape table, both from the
// writer's own module (`@usemoney/core/market-data/stock-flags`). MONEY-1205:
// three surfaces were each formatting `StockFlag.value` by hand and two of them
// were wrong in the same way.
import {
  formatStockFlagValue,
  stockFlagShape,
} from "@usemoney/core/market-data";

/**
 * The subset of Holding fields the briefing reads. `currentValue`,
 * `investedValue`, `pnlPercentage` and `currentPrice` are nullable because the
 * Prisma select returns `number | null` for those columns — the production code
 * coalesces them, so the pure helpers must too.
 */
export interface BriefingHolding {
  symbol: string;
  currentPrice: number | null;
  investedValue: number | null;
  currentValue: number | null;
  pnlPercentage: number | null;
}

/** A single `{ label, value, change? }` line in a briefing section. */
export interface BriefingItem {
  label: string;
  value: string;
  change?: number;
}

/** A titled group of briefing items. */
export interface BriefingSection {
  type: string;
  title: string;
  items: BriefingItem[];
}

/** Aggregate portfolio numbers derived from the holdings list. */
export interface PortfolioSummary {
  totalValue: number;
  totalInvested: number;
  totalPnl: number;
  totalPnlPercent: number;
}

/** Default absolute-% threshold above which a holding is a "significant mover". */
export const SIGNIFICANT_MOVE_THRESHOLD = 5;

/** Max number of significant movers / top holdings surfaced in the briefing. */
export const MAX_BRIEFING_ROWS = 5;

/** Sum a nullable numeric column over the holdings (null → 0). */
function sumBy(
  holdings: readonly BriefingHolding[],
  pick: (h: BriefingHolding) => number | null,
): number {
  return holdings.reduce((sum, h) => sum + (pick(h) ?? 0), 0);
}

/**
 * Compute the portfolio aggregate numbers.
 *
 * `totalValue` / `totalInvested` coalesce null columns to 0. `totalPnl =
 * totalValue - totalInvested`. `totalPnlPercent = (totalPnl / totalInvested) *
 * 100`, GUARDED against divide-by-zero: a zero (or negative) invested total
 * yields 0 instead of NaN/±Infinity — which would otherwise poison the briefing
 * summary and the stored `dayChange`/percent fields.
 */
export function computePortfolioSummary(
  holdings: readonly BriefingHolding[],
): PortfolioSummary {
  const totalValue = sumBy(holdings, (h) => h.currentValue);
  const totalInvested = sumBy(holdings, (h) => h.investedValue);
  const totalPnl = totalValue - totalInvested;
  const totalPnlPercent =
    totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  return { totalValue, totalInvested, totalPnl, totalPnlPercent };
}

/**
 * Pick the significant movers: holdings whose `pnlPercentage` is non-null and
 * exceeds ±`threshold`, sorted by absolute move (largest first), capped at
 * `MAX_BRIEFING_ROWS`. Holdings with a null percentage are excluded outright
 * (the source uses `!= null`), so a missing value can never sort to the top.
 */
export function detectSignificantMovers(
  holdings: readonly BriefingHolding[],
  threshold: number = SIGNIFICANT_MOVE_THRESHOLD,
): BriefingHolding[] {
  return holdings
    .filter((h) => h.pnlPercentage != null && Math.abs(h.pnlPercentage) > threshold)
    .sort(
      (a, b) => Math.abs(b.pnlPercentage ?? 0) - Math.abs(a.pnlPercentage ?? 0),
    )
    .slice(0, MAX_BRIEFING_ROWS);
}

/** Format a rupee amount with Indian grouping and no fractional digits. */
function inr(value: number): string {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/**
 * Build the "Portfolio Overview" section: Total Value, Total P&L (carrying the
 * percent as `change`), and the holdings count. Amounts use Indian grouping
 * with no decimals (matches the production `{ maximumFractionDigits: 0 }`).
 */
export function buildPortfolioSection(
  holdings: readonly BriefingHolding[],
  summary: PortfolioSummary = computePortfolioSummary(holdings),
): BriefingSection {
  return {
    type: "portfolio_change",
    title: "Portfolio Overview",
    items: [
      { label: "Total Value", value: inr(summary.totalValue) },
      {
        label: "Total P&L",
        value: inr(summary.totalPnl),
        change: summary.totalPnlPercent,
      },
      { label: "Holdings", value: `${holdings.length} stocks` },
    ],
  };
}

/** Build the "Big Moves" section from the already-selected significant movers. */
export function buildMoversSection(
  movers: readonly BriefingHolding[],
): BriefingSection {
  return {
    type: "significant_movers",
    title: "Big Moves",
    items: movers.map((h) => ({
      label: h.symbol,
      value: `₹${(h.currentPrice ?? 0).toLocaleString("en-IN")}`,
      change: h.pnlPercentage ?? 0,
    })),
  };
}

/**
 * Build the "Largest Positions" section from the top-N holdings (the caller
 * passes them already ordered by `currentValue` desc). `change` is left
 * `undefined` when the holding has no percentage (vs `0` in the movers section).
 */
export function buildTopHoldingsSection(
  topHoldings: readonly BriefingHolding[],
): BriefingSection {
  return {
    type: "top_holdings",
    title: "Largest Positions",
    items: topHoldings.map((h) => ({
      label: h.symbol,
      value: inr(h.currentValue ?? 0),
      change: h.pnlPercentage ?? undefined,
    })),
  };
}

// ─── MONEY-1204 (14e.4) market-context sections ──────────────────────────────
//
// Three CHEAP aggregates added to the login briefing, each one a read of a table
// the data engine already writes — no scraping, no live fetch, no per-symbol
// fan-out. All three are PURE builders here; `login-briefing.ts` does the reads.
//
// `BriefingItem.change` is rendered by the UI as a PERCENT
// (`{change.toFixed(1)}%` in `LoginBriefingCard.tsx`), so it is set ONLY where
// the number genuinely is one. A ₹-crore net flow goes in `value`, never in
// `change` — a ₹1,234 Cr net would otherwise render as "+1234.0%".

/** One `InstitutionalFlow` reading for the day. */
export interface InstitutionalFlowReading {
  date: Date;
  /** "FII" | "DII". */
  category: string;
  /**
   * Net (buy − sell) in ₹ CRORE — NSE's own unit, stored UNCONVERTED.
   * DO NOT rescale: multiplying by 1e7 to "get rupees" is how ₹1,234 Cr becomes
   * an unreadable 12,340,000,000 in a two-line briefing card.
   */
  netValue: number;
}

/** `IndexClose` columns the volatility line reads. */
export interface IndexCloseLite {
  date: Date;
  close: number;
  /**
   * NSE's own previous close when it published one. Null is common and is NOT
   * zero — a zero prevClose would render as a −100% move.
   */
  prevClose: number | null;
}

/** A `StockFlag` row that landed on one of the user's holdings. */
export interface HoldingFlagRow {
  symbol: string;
  date: Date;
  kind: string;
  /** Compact JSON or a bare code; encoding fixed per kind (stock-flags.ts). */
  value: string;
}

/** One collapsed flag line: this symbol has carried this flag since this date. */
export interface HoldingFlagSummary {
  symbol: string;
  kind: string;
  value: string;
  /** EARLIEST date this (symbol, kind, value) appeared in the window. */
  since: Date;
}

/**
 * Flag kinds worth putting in a briefing.
 *
 * `WK52_HIGH_LOW`, `PRICE_BAND` and `SHORT_SELLING` are excluded: NSE publishes
 * them for essentially the whole universe every session, so including them
 * means every holding is "flagged" every single day and the section carries no
 * information at all.
 */
export const BRIEFING_FLAG_KINDS: readonly string[] = [
  "SURVEILLANCE",
  "FO_BAN",
  "BAND_CHANGE",
  "SERIES_CHANGE",
];

/** `₹1,234 Cr`, signed, no decimals. The value is ALREADY in crore. */
function crore(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}

/** `14 Aug 2026`, in UTC (the stored dates are UTC midnight of the IST day). */
function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * "Institutional Flows" — the day's FII and DII net, in ₹ crore.
 *
 * Returns null when there is nothing for the latest day, so the caller can omit
 * the section rather than print a zero. A missing flow row means NOT CAPTURED
 * (the endpoint is unbackfillable and serves only the current reading), which
 * is emphatically not "the institutions did nothing".
 *
 * Only the LATEST date present in `readings` is used; the caller may pass a few
 * days and let this pick.
 */
export function buildMarketFlowSection(
  readings: readonly InstitutionalFlowReading[],
): BriefingSection | null {
  const usable = readings.filter((r) => Number.isFinite(r.netValue));
  if (usable.length === 0) return null;

  const latest = usable.reduce(
    (max, r) => (r.date.getTime() > max ? r.date.getTime() : max),
    -Infinity,
  );
  const today = usable.filter((r) => r.date.getTime() === latest);
  if (today.length === 0) return null;

  // FII first, DII second, anything else after — stable and readable.
  const order = ["FII", "DII"];
  const sorted = [...today].sort((a, b) => {
    const ai = order.indexOf(a.category.toUpperCase());
    const bi = order.indexOf(b.category.toUpperCase());
    return (
      (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi) ||
      a.category.localeCompare(b.category)
    );
  });

  return {
    type: "institutional_flows",
    title: "Institutional Flows",
    items: [
      ...sorted.map((r) => ({
        label: r.category.toUpperCase(),
        value: crore(r.netValue),
      })),
      { label: "As of", value: shortDate(new Date(latest)) },
    ],
  };
}

/**
 * "Volatility" — the India VIX level and its percent change.
 *
 * `rows` are `IndexClose` rows for `indexSlug = "india-vix"`, NEWEST FIRST. The
 * previous level comes from the row's own `prevClose` when NSE published one,
 * else from the next row's close. A null/zero/non-finite previous yields a
 * level with NO `change` rather than a fabricated 0% or a −100%.
 *
 * India VIX's `volume`, `turnoverCr`, `pe`, `pb` and `divYield` are all NULL in
 * the feed — a volatility index has no basket to value — so nothing else here
 * is derivable from that row and nothing else is attempted.
 */
export function buildVolatilitySection(
  rows: readonly IndexCloseLite[],
): BriefingSection | null {
  const latest = rows[0];
  if (!latest || !Number.isFinite(latest.close)) return null;

  const priorRaw =
    latest.prevClose != null && Number.isFinite(latest.prevClose)
      ? latest.prevClose
      : (rows[1]?.close ?? null);
  const prior =
    priorRaw != null && Number.isFinite(priorRaw) && priorRaw > 0
      ? priorRaw
      : null;

  const item: BriefingItem = {
    label: "India VIX",
    value: latest.close.toFixed(2),
  };
  if (prior !== null) {
    item.change = ((latest.close - prior) / prior) * 100;
  }

  return {
    type: "volatility",
    title: "Volatility",
    items: [item, { label: "As of", value: shortDate(latest.date) }],
  };
}

/**
 * Collapse the raw flag rows to ONE line per (symbol, kind, value), dated to the
 * EARLIEST occurrence in the window.
 *
 * `StockFlag` is append-only with one row per day for as long as a flag holds, so
 * a name that has been under GSM for a fortnight is fourteen rows. Listing them
 * raw would fill the briefing with the same fact repeated; keeping the earliest
 * date turns it into "under GSM Stage I since 4 Aug", which is the sentence a
 * user wants.
 *
 * This is deliberately NOT the alert evaluator's transition detection: a
 * briefing summarises what is currently true over a window and needs no
 * market-wide publication calendar, whereas an alert must distinguish "the flag
 * cleared" from "the file did not arrive". Different questions, different cost.
 */
export function summarizeNewFlags(
  rows: readonly HoldingFlagRow[],
  kinds: readonly string[] = BRIEFING_FLAG_KINDS,
): HoldingFlagSummary[] {
  const allowed = new Set(kinds.map((k) => k.toUpperCase()));
  const byKey = new Map<string, HoldingFlagSummary>();

  for (const row of rows) {
    const kind = String(row.kind ?? "").toUpperCase();
    if (!allowed.has(kind)) continue;
    const key = `${row.symbol}|${kind}|${row.value}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { symbol: row.symbol, kind, value: row.value, since: row.date });
    } else if (row.date.getTime() < existing.since.getTime()) {
      existing.since = row.date;
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) =>
      b.since.getTime() - a.since.getTime() || a.symbol.localeCompare(b.symbol),
  );
}

/**
 * A one-line, human description of a flag. Never throws on a malformed value.
 *
 * The VALUE is decoded by `formatStockFlagValue` — the same decoder the stock
 * page, `/v1/stocks/:symbol/flags`, the research tool and the alert writer use.
 * This function's own job is only the TENSE, which is shape-dependent:
 *
 *   STATE  "… since 12 Aug 2026"  — a standing condition with a start date.
 *   POINT  "… on 21 May 2024"     — a one-day event. It never "ends" and it was
 *                                   never "since" anything.
 *
 * It used to build the band-change sentence itself, and appended `%` to BOTH
 * sides unconditionally: NSE publishes `No Band` for F&O names, so the email
 * read "Price band 5% → No Band%" (MONEY-1205). The decoder owns that rule now,
 * in one place, for all four products.
 */
export function describeHoldingFlag(summary: HoldingFlagSummary): string {
  const when = shortDate(summary.since);
  // SURVEILLANCE decodes byte-identically to `value` ("GSM STAGE - I") — the
  // verbatim-storage rule, preserved deliberately through the shared decoder.
  const what = formatStockFlagValue(summary.kind, summary.value);
  return stockFlagShape(summary.kind) === "POINT"
    ? `${what} on ${when}`
    : `${what} since ${when}`;
}

/**
 * "Flags On Your Holdings" — new surveillance / ban / band-change flags on the
 * user's own symbols since their last briefing.
 *
 * Returns null when nothing landed, so the section is omitted rather than
 * printing a reassuring "none" that a fetch failure would produce identically.
 */
export function buildHoldingFlagsSection(
  rows: readonly HoldingFlagRow[],
  kinds: readonly string[] = BRIEFING_FLAG_KINDS,
): BriefingSection | null {
  const summaries = summarizeNewFlags(rows, kinds).slice(0, MAX_BRIEFING_ROWS);
  if (summaries.length === 0) return null;
  return {
    type: "holding_flags",
    title: "Flags On Your Holdings",
    items: summaries.map((s) => ({
      label: s.symbol,
      value: describeHoldingFlag(s),
    })),
  };
}
