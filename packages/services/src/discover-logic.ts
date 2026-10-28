/**
 * Discover pure-logic helpers (service layer).
 *
 * Side-effect-free ranking / sorting / percent-change math used by the stock
 * discovery surface (`./discover.service.ts`):
 *
 *   - top-gainers / top-losers derivation (rank by %change, circuit-bounded),
 *   - sector-browse sort comparators (changePercent by |abs|, marketCap desc),
 *   - raw percent-change compute (price vs previousClose, div-by-zero aware),
 *   - %change formatting for the rendered chip.
 *
 * They are isolated here (away from the Prisma-importing service) so they can
 * be unit-tested without pulling the Prisma client in at import time, and —
 * critically — so the LIVE Discover path runs the SAME non-finite-guarded math
 * the regression tests assert (no shadow). `discover.service.ts` now CALLS
 * these helpers for its gainers/losers ranking and its sector sorts.
 *
 * Behaviour here is identical, for FINITE inputs, to the ranking/sort logic
 * that previously lived inline in `getAllStocksData` / `fetchStocksBySector`.
 * The only intentional behavioural differences are defensive:
 *
 *   - a `NaN`/`±Infinity` `changePercent` (a corrupt sync row, or a `÷0` on a
 *     zero `previousClose` upstream) can no longer land at the TOP of the
 *     gainers list nor flip the order-unstable `Array.sort` comparator into
 *     crowning a corrupt row (the exact "comparison wrong-winner" failure in
 *     `./comparison-logic.ts` — `Math.abs(NaN) - x === NaN` makes raw `sort`
 *     non-deterministic). Non-finite scores are ranked LAST / excluded, never
 *     first.
 *
 * Mirrors the `finite()` precedent in `./dashboard-logic.ts` and the NaN-safe
 * ranking precedent in `./comparison-logic.ts`.
 */

// Narrow subpath, never the `@usemoney/core` root barrel: this module is
// imported by pure unit tests precisely BECAUSE it drags no Prisma client in at
// module load, and the root barrel would.
import {
  getAllSectorNames,
  resolveCanonicalSector,
  UNCATEGORISED_SECTOR_FACET,
} from "@usemoney/core/sector-taxonomy";

// ---------------------------------------------------------------------------
// Non-finite guard
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * The Discover ranking is a SORT surface and the %change chip is a
 * `.toFixed()` surface: a single `NaN`/`Infinity` `changePercent` either flips
 * the comparator (raw `Array.sort` with a `NaN` result is order-unstable → a
 * corrupt row can surface as the top gainer) or renders the literal string
 * "NaN%". Stored quote values (`changePercent`, `marketCap`) are occasionally
 * `NaN`/`Infinity` (a divide that went wrong upstream on a `0` previousClose,
 * a corrupt sync row), so every value that enters a sort key or a format is
 * funnelled through this guard first. `null`/`undefined`/`NaN`/`±Infinity` all
 * collapse to `fallback` (default 0). Mirrors `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Structural input types (subset of the DiscoverStock shape used for ranking)
// ---------------------------------------------------------------------------

/** The minimum a row needs to be ranked as a gainer/loser. */
export interface RankableStock {
  changePercent: number;
  change: number;
}

// ---------------------------------------------------------------------------
// Circuit bounds (the legacy ±50% spike/crash filter)
// ---------------------------------------------------------------------------

/** Upper circuit cap — a %change above this is treated as bogus data. */
export const MAX_ABS_CHANGE_PERCENT = 50;

/**
 * Whether a %change is within the believable circuit band, EXCLUSIVE of ±50
 * (`-50 < x < 50`).
 *
 * Ports the legacy `changePercent > -50 && changePercent < 50` guard from the
 * discover sort path. A non-finite `changePercent` (`NaN`/`±Infinity`) is NOT
 * within limits — it must never be admitted. (`NaN < 50` and `Infinity < 50`
 * are both `false`, so the legacy inline form excluded these by accident; this
 * makes the intent explicit and total.)
 *
 * NOTE: the top-gainers/losers ranking (`getAllStocksData`) uses an INCLUSIVE
 * `±50` cap (`<= 50` / `>= -50`) — a subtly different legacy bound preserved by
 * `isWithinGainerLoserBand` below. Both are kept to stay behaviour-identical to
 * the two distinct gates that shipped.
 */
export function isWithinCircuitLimits(changePercent: number): boolean {
  if (!Number.isFinite(changePercent)) return false;
  return (
    changePercent > -MAX_ABS_CHANGE_PERCENT &&
    changePercent < MAX_ABS_CHANGE_PERCENT
  );
}

/**
 * Whether a %change is within the gainers/losers circuit band, INCLUSIVE of
 * ±50 (`-50 <= x <= 50`).
 *
 * Ports the legacy `getAllStocksData` bounds EXACTLY (`changePercent <= 50` for
 * gainers, `>= -50` for losers) so a row at precisely ±50 is still listed —
 * behaviour-preserving. A non-finite `changePercent` is excluded (it can never
 * be a top gainer/loser). The sign split is applied by the caller; this only
 * caps the magnitude.
 */
export function isWithinGainerLoserBand(changePercent: number): boolean {
  if (!Number.isFinite(changePercent)) return false;
  return (
    changePercent >= -MAX_ABS_CHANGE_PERCENT &&
    changePercent <= MAX_ABS_CHANGE_PERCENT
  );
}

// ---------------------------------------------------------------------------
// Raw percent change from price + previousClose (the div-by-zero surface)
// ---------------------------------------------------------------------------

/**
 * Percent change between a current `price` and its `previousClose`:
 * `(price - previousClose) / previousClose * 100`.
 *
 * Returns `null` (an honest "—", never `NaN`/`Infinity` into a `.toFixed()`)
 * when `previousClose` is non-finite or zero (the `÷0` that produces
 * `Infinity`/`NaN` and then sorts unpredictably), or `price` is non-finite.
 * This is the guard for deriving %change ourselves when a quote ships a raw
 * price + previousClose but a missing/garbage `changePercent`.
 */
export function changePercentFromCloses(
  price: number | null | undefined,
  previousClose: number | null | undefined,
): number | null {
  if (
    previousClose == null ||
    !Number.isFinite(previousClose) ||
    previousClose === 0
  )
    return null;
  if (price == null || !Number.isFinite(price)) return null;
  const pct = ((price - previousClose) / previousClose) * 100;
  return Number.isFinite(pct) ? pct : null;
}

// ---------------------------------------------------------------------------
// %change formatting (the rendered chip)
// ---------------------------------------------------------------------------

/**
 * Format a %change for display: signed, fixed-`dp`, with a trailing `%`.
 * A non-finite value renders as the dash placeholder `"—%"`-free `"—"` rather
 * than the literal "NaN%"/"Infinity%". `0` renders as `"+0.00%"` (the chip is
 * always signed so up/down styling reads consistently).
 */
export function formatChangePercent(
  value: number | null | undefined,
  dp = 2,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(dp)}%`;
}

// ---------------------------------------------------------------------------
// Sector-browse sort comparators (NaN-safe — the wrong-winner fix)
// ---------------------------------------------------------------------------

/**
 * Comparator: by ABSOLUTE %change, largest mover first.
 *
 * Ports `fetchStocksBySector`'s `Math.abs(b.changePercent) - Math.abs(a.changePercent)`
 * but neutralises each side through `finite()` FIRST. Raw `Array.sort` with a
 * `NaN` comparator result is order-unstable (V8 may leave a corrupt row
 * anywhere, including the top) — funnelling both magnitudes through `finite()`
 * keeps the order total and deterministic, with a non-finite `changePercent`
 * sorting to magnitude `0` (last, never the headline mover). Ties break by no
 * inner key here (callers pass a stable input order); use `sortStocksBySector`
 * for the full deterministic sort with a symbol tiebreak.
 */
export function compareByChangePercentAbsDesc(
  a: { changePercent: number },
  b: { changePercent: number },
): number {
  return Math.abs(finite(b.changePercent)) - Math.abs(finite(a.changePercent));
}

/**
 * Comparator: by market cap, largest first.
 *
 * Ports `fetchStocksBySector`'s `(b.marketCap ?? 0) - (a.marketCap ?? 0)` and
 * additionally collapses a `NaN`/`Infinity` marketCap to `0` (the `?? 0` only
 * caught `null`/`undefined`, leaving a non-finite cap to flip the comparator).
 */
export function compareByMarketCapDesc(
  a: { marketCap: number | null },
  b: { marketCap: number | null },
): number {
  return finite(b.marketCap) - finite(a.marketCap);
}

/**
 * Deterministic sector-browse sort (non-mutating).
 *
 *   - `"changePercent"`: by |abs| %change desc, NaN-safe, symbol asc tiebreak;
 *   - `"marketCap"`: by marketCap desc, NaN-safe, symbol asc tiebreak;
 *   - `"name"` (or anything else): input order preserved (the service already
 *     orders by `symbol asc` in the DB query for the name sort).
 *
 * The symbol tiebreak makes the result stable regardless of input order — two
 * equal-|change| rows always come out in the same place, so a corrupt row can
 * never non-deterministically jump the headline slot.
 */
export function sortStocksBySector<
  T extends { changePercent: number; marketCap: number | null; symbol: string },
>(
  stocks: ReadonlyArray<T>,
  sortBy: "name" | "changePercent" | "marketCap",
): T[] {
  const out = [...stocks];
  if (sortBy === "changePercent") {
    out.sort(
      (a, b) =>
        compareByChangePercentAbsDesc(a, b) || a.symbol.localeCompare(b.symbol),
    );
  } else if (sortBy === "marketCap") {
    out.sort(
      (a, b) =>
        compareByMarketCapDesc(a, b) || a.symbol.localeCompare(b.symbol),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Movers freshness + dual-listing collapse (MONEY-1198)
// ---------------------------------------------------------------------------

/** IST is UTC+05:30, with no DST. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The UTC instant at which `now`'s IST CALENDAR day begins.
 *
 * The trading day is an IST calendar day, and every stored quote timestamp is a
 * UTC instant, so "is this quote from today's session?" is only answerable by
 * shifting into IST first. Doing it in the server's local zone would silently
 * give a different answer on a UTC host than on the founder's laptop.
 */
export function istDayStart(now: Date): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const midnightIst = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(midnightIst - IST_OFFSET_MS);
}

/** `YYYY-MM-DD` of an instant's IST calendar day. Used to label the panel. */
export function istDayKey(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Which movers source should serve this request — MONEY-1204 (P14 / 14d.4, D1).
 *
 * `MarketMover` is the PRIMARY. It is written every 3 minutes during market
 * hours by `market-movers-sync` straight from NSE's own
 * `/api/live-analysis-variations`, already ISIN-deduped and already ranked, and
 * until now it had exactly ONE reader in the entire repo — the writer's own
 * dedupe `findFirst`. The panel meanwhile ranked `latest_quotes` itself, which
 * is a table nothing bulk-refreshes intraday.
 *
 * That is the whole point of the switch. MONEY-1198 shipped a +36.48% "gainer"
 * that was actually DOWN 5.00% on the day, because `latest_quotes` still held
 * the previous session's close at 11:47 IST and every number in the row was
 * internally consistent with itself. Reading the precomputed snapshot makes the
 * panel show what NSE published rather than what we could infer.
 *
 * The fallback is kept — deleting it would trade one silent-staleness failure
 * for a total-blank one — but it is now the EXCEPTION and it is judged on the
 * SNAPSHOT'S OWN timestamp, not on the clock:
 *
 *   - `snapshot` (use MarketMover)  when rows exist and their session is the
 *     same IST day as the freshest thing we know about;
 *   - `fallback` (rank LatestQuote) when there are no rows at all, or the
 *     newest row is from an EARLIER session than the reference.
 *
 * Judging on the clock instead would need a trading-calendar lookup to be right
 * on holidays and before the open, and would call the snapshot "stale" on every
 * Sunday — flapping to the fallback on precisely the days when neither source
 * has anything newer. Comparing two data-derived days has no such failure.
 *
 * `reference` is normally the newest `LatestQuote` timestamp, i.e. the other
 * source's own session. When it is null (nothing to compare against) a
 * non-empty snapshot WINS: "we cannot tell how fresh the alternative is" is not
 * a reason to prefer the alternative.
 */
export type MoversSource = "snapshot" | "fallback";

export interface MoversSourceDecision {
  source: MoversSource;
  /** Session the snapshot describes, `YYYY-MM-DD` IST, or null when empty. */
  snapshotDay: string | null;
  /** Session used as the freshness yardstick, or null when unknown. */
  referenceDay: string | null;
  /** Why — logged so a support question is answerable from one line. */
  reason:
    | "snapshot-current"
    | "snapshot-empty"
    | "snapshot-stale"
    | "no-reference";
}

export function decideMoversSource(args: {
  /** Newest `snapshotAt`/`date` across the MarketMover rows read, or null. */
  snapshotAt: Date | null;
  /** Newest LatestQuote timestamp, or null when that side is unknown/empty. */
  referenceAt: Date | null;
}): MoversSourceDecision {
  const snapshotDay = args.snapshotAt ? istDayKey(args.snapshotAt) : null;
  const referenceDay = args.referenceAt ? istDayKey(args.referenceAt) : null;

  if (snapshotDay === null) {
    return {
      source: "fallback",
      snapshotDay,
      referenceDay,
      reason: "snapshot-empty",
    };
  }
  if (referenceDay === null) {
    // Nothing to compare against. A populated snapshot is still the better
    // answer than ranking a table we know nothing about.
    return {
      source: "snapshot",
      snapshotDay,
      referenceDay,
      reason: "no-reference",
    };
  }
  // String compare is safe and intentional: both are `YYYY-MM-DD`, so
  // lexicographic order IS chronological order, with no timezone arithmetic.
  if (snapshotDay < referenceDay) {
    return {
      source: "fallback",
      snapshotDay,
      referenceDay,
      reason: "snapshot-stale",
    };
  }
  return {
    source: "snapshot",
    snapshotDay,
    referenceDay,
    reason: "snapshot-current",
  };
}

/**
 * Collapse a company's NSE and BSE listings into ONE row.
 *
 * A dual-listed company has two `InstrumentMapping` rows and therefore two
 * `LatestQuote` rows, and both used to reach the panel. Live example
 * (2026-08-14): `JUBLCPL` appeared at Rs 2,322.60 AND Rs 2,327.25, `OMAXE` at
 * Rs 98.37 AND Rs 98.26, `ATAM` at Rs 53.35 AND Rs 54.35. Four of the eight
 * visible gainer slots were second copies, so a list that claims the market's
 * ten biggest movers was showing about five companies.
 *
 * IDENTITY IS ISIN, NOT SYMBOL. ISIN is the durable identity on
 * InstrumentMapping and is what actually says "same company"; a symbol string
 * is reassignable and is not guaranteed equal across exchanges. Symbol is the
 * fallback ONLY when ISIN is absent, and the fallback is keyed on symbol alone
 * (not symbol+exchange) because collapsing dual listings is the entire job.
 *
 * WHICH LEG WINS: the one with more traded volume, i.e. the exchange where the
 * price is actually being set. Volume is nullable, and a null must not beat a
 * real number — an unknown volume is treated as lower than any known one, never
 * as zero-that-might-tie. Ties break on exchange then instrumentId so the
 * choice is deterministic across runs; an unstable pick here would make the
 * panel flicker between two near-identical prices on every refresh.
 */
export function dedupeDualListings<
  T extends {
    symbol: string;
    exchange: string;
    instrumentId: string;
    isin?: string | null;
    volume?: number | null;
  },
>(rows: ReadonlyArray<T>): T[] {
  const best = new Map<string, T>();

  for (const row of rows) {
    const isin = row.isin?.trim();
    const key = isin ? `isin:${isin}` : `sym:${row.symbol.toUpperCase()}`;
    const incumbent = best.get(key);
    if (!incumbent || outranksListing(row, incumbent)) best.set(key, row);
  }

  // Preserve the caller's ordering (already ranked by %change) rather than the
  // Map's insertion order, so this can be applied before OR after ranking.
  const kept = new Set([...best.values()].map((r) => r.instrumentId));
  return rows.filter((r) => kept.has(r.instrumentId));
}

/** True when `a` is the better listing to keep. See `dedupeDualListings`. */
function outranksListing(
  a: { exchange: string; instrumentId: string; volume?: number | null },
  b: { exchange: string; instrumentId: string; volume?: number | null },
): boolean {
  // -1 rather than 0: an ABSENT volume must lose to a real 0-volume row, and
  // `finite()` would map null to 0 and make them tie.
  const av =
    typeof a.volume === "number" && Number.isFinite(a.volume) ? a.volume : -1;
  const bv =
    typeof b.volume === "number" && Number.isFinite(b.volume) ? b.volume : -1;
  if (av !== bv) return av > bv;
  if (a.exchange !== b.exchange) return a.exchange < b.exchange;
  return a.instrumentId < b.instrumentId;
}

// ---------------------------------------------------------------------------
// Top gainers / losers derivation
// ---------------------------------------------------------------------------

/**
 * Derive the top-N gainers from `allStocks`.
 *
 * Ports `getAllStocksData`'s gainers chain exactly for finite inputs:
 *   - keep rows with `changePercent > 0`, within the upper circuit cap, and a
 *     non-zero raw `change` (drops `change: 0` placeholder/halted rows);
 *   - sort by `changePercent` DESC (biggest gain first);
 *   - take `limit` (default 10).
 *
 * Hardening over the inline form: `isWithinCircuitLimits` makes the non-finite
 * exclusion explicit (a `NaN`/`Infinity` `changePercent` is NOT a gainer — it
 * can never top the list), and the sort runs through `finite()` so a corrupt
 * row that somehow survived can't flip the order. Ties (equal `changePercent`)
 * break by `symbol` asc for a deterministic list.
 */
export function rankGainers<
  T extends { changePercent: number; change: number; symbol: string },
>(allStocks: ReadonlyArray<T>, limit = 10): T[] {
  return [...allStocks]
    .filter(
      (s) =>
        s.changePercent > 0 &&
        isWithinGainerLoserBand(s.changePercent) &&
        s.change !== 0,
    )
    .sort(
      (a, b) =>
        finite(b.changePercent) - finite(a.changePercent) ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, Math.max(0, finite(limit)));
}

/**
 * Derive the top-N losers from `allStocks`.
 *
 * Ports `getAllStocksData`'s losers chain exactly for finite inputs:
 *   - keep rows with `changePercent < 0`, within the lower circuit cap, and a
 *     non-zero raw `change`;
 *   - sort by `changePercent` ASC (biggest loss — most negative — first);
 *   - take `limit` (default 10).
 *
 * Same non-finite hardening + `symbol` tiebreak as `rankGainers`. A non-finite
 * `changePercent` is excluded (never crowned the worst loser).
 */
export function rankLosers<
  T extends { changePercent: number; change: number; symbol: string },
>(allStocks: ReadonlyArray<T>, limit = 10): T[] {
  return [...allStocks]
    .filter(
      (s) =>
        s.changePercent < 0 &&
        isWithinGainerLoserBand(s.changePercent) &&
        s.change !== 0,
    )
    .sort(
      (a, b) =>
        finite(a.changePercent) - finite(b.changePercent) ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, Math.max(0, finite(limit)));
}

// ---------------------------------------------------------------------------
// Sector facet counts (MONEY-1157)
// ---------------------------------------------------------------------------

/** The enrichment pipeline's "Yahoo could not resolve this symbol" sentinel.
 *  Deliberately non-null upstream so a dead symbol is never re-fetched. */
export const SECTOR_SKIPPED = "N/A";

/** The DISPLAY label for the catch-all facet. The STORED value is the sentinel
 *  above (or null / absent / any non-canonical string) — the two are not
 *  interchangeable.
 *
 *  Re-exported from the taxonomy rather than re-declared: the screener's sector
 *  FILTER has to recognise the same literal, and a second copy of the string is
 *  how the counts and the filter drift apart again (MONEY-1157). */
export const UNCATEGORISED_FACET = UNCATEGORISED_SECTOR_FACET;

/**
 * Sector facet counts for the screener's chip strip + sector dropdown.
 *
 * ## The bug this exists to close
 *
 * The counts used to be keyed on the RAW `InstrumentMapping.sector` while the
 * emitted array was built only from `getAllSectorNames()` plus a
 * "Not Categorised" bucket fed EXCLUSIVELY by `sector === "N/A" || !sector`.
 * Every other value was counted and then never read back. Measured on prod:
 * `Other` 228, `Construction` 40, `Media & Entertainment` 9, `Textiles` 8 —
 * ~285 stocks that appeared in NO chip and NOT in "Not Categorised", so the
 * facet counts silently failed to sum to the universe.
 *
 * Now every row lands in exactly one facet:
 *   - no sector / the `"N/A"` sentinel → "Not Categorised";
 *   - a value `normalizeToNseSector` folds onto a canonical NSE sector →
 *     that sector (`Construction` → Industrials, `Textiles` → Consumer
 *     Discretionary);
 *   - anything still non-canonical after normalisation (`Other`,
 *     `Agriculture`, `Media & Entertainment` — only bare `Media` is mapped)
 *     → "Not Categorised", rather than vanishing.
 *
 * The bucketing is `resolveCanonicalSector` from the taxonomy — the SAME
 * function the screener's sector filter runs (`matchesSectorFacet`). That is
 * the whole point: the counts emitted here and the rows a chip returns are two
 * views of one partition, so they cannot disagree. When they were two
 * expressions of "the same" rule, they did: the fold shipped here in
 * `buildSectorFacets` and the filter kept comparing the RAW string, so
 * Industrials over-reported by ~40, Consumer Discretionary by ~8 and
 * "Not Categorised" by ~242.
 *
 * `resolveCanonicalSector` is TOTAL and case-insensitive; it cannot throw and
 * cannot invent a name outside `NSE_SECTORS`.
 *
 * ## Deliberate asymmetry with `apps/web/lib/sectors/buckets.ts`
 *
 * `normalizeBucketName` there does the OPPOSITE on purpose: it rewrites only
 * the sentinel and lets non-canonical values through so the heatmap keeps
 * SHOWING the data-quality problem (and so folding cannot silently shift the
 * ranked table's m-cap weights). Do NOT "harmonise" the two — the heatmap is a
 * diagnostic surface, this is a FILTER facet, and a filter offering a bucket
 * that reaches nothing is the defect. Both behaviours are pinned by tests.
 */
export function buildSectorFacets(
  stocks: ReadonlyArray<{ sector: string | null }>,
): Array<{ name: string; count: number }> {
  const canonicalNames = getAllSectorNames();
  const canonical = new Set(canonicalNames);

  const counts = new Map<string, number>();
  let uncategorised = 0;

  for (const stock of stocks) {
    // `null`, `""` and the `SECTOR_SKIPPED` sentinel all resolve to `null` here
    // — the sentinel is not in the taxonomy, so it needs no special case.
    const name = resolveCanonicalSector(stock.sector);
    if (name !== null && canonical.has(name)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    } else {
      uncategorised += 1;
    }
  }

  return [
    ...canonicalNames.map((name) => ({ name, count: counts.get(name) ?? 0 })),
    { name: UNCATEGORISED_FACET, count: uncategorised },
  ];
}
