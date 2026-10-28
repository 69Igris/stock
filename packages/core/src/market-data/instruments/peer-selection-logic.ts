/**
 * Peer selection (MONEY-1145) — PURE.
 *
 * ## Why this exists at all
 *
 * `stock_peers` had **0 rows platform-wide**. Nothing wrote it: the only writer
 * was `packages/research/src/data-sources/db-store.ts`, reachable solely when
 * someone happened to run a StockSage research pass on that symbol. So the Peers
 * tab was empty by construction for every stock, and had been since it shipped.
 *
 * ## Why derived rather than scraped
 *
 * The existing writer scrapes Tickertape. Deriving from our OWN data instead:
 *
 * - needs no upstream, so no rate limit, no `PROD_ONLY_JOBS` split, and it runs
 *   identically on QA and prod (same posture as `mf-nav-propagate`);
 * - covers every symbol we can classify, rather than the ones a research pass
 *   happened to touch;
 * - is deterministic, so it is unit-testable without a network;
 * - stops naming a third-party vendor in a product surface, which is the whole
 *   point of the sibling ticket MONEY-1144.
 *
 * ## Measured against the dev DB before designing
 *
 * - 22,153 active EQUITY instruments; 21,885 have a non-null `sector` — but
 *   **14,893 of those are the literal `SECTOR_SKIPPED` sentinel `"N/A"`**. Real
 *   sector coverage is 6,992 (31.6%), not 98.8%. `sector: { not: null }` is the
 *   naive test `holdings.service.ts:195` already warns about; we use
 *   `hasRealSector` instead.
 * - 2,123 instruments have BOTH a real sector and a `StockRatios` row — the set
 *   that can render pe/roe/marketCap rather than a row of blanks.
 * - Of the 130 (sector, industry) groups among those, 83 have >= 5 members and
 *   hold 2,020 instruments; only 103 sit in groups too small to rank within.
 *   That is what `MIN_INDUSTRY_GROUP` is calibrated to — not a guess.
 */

import { SECTOR_SKIPPED } from "./sector-enrichment-logic";

/** One row of the candidate universe, already joined with ratios + quote. */
export interface PeerCandidate {
  symbol: string;
  exchange: string;
  name: string;
  sector: string | null;
  industry: string | null;
  /** CRORES — `StockRatios.marketCap`'s unit. Never rupees (MONEY-1144). */
  marketCap: number | null;
  pe: number | null;
  roe: number | null;
  changePercent: number | null;
}

/** The persisted shape, matching what `getStockPeersAction` reads back. */
export interface SelectedPeer {
  symbol: string;
  name: string;
  marketCap: number | null;
  pe: number | null;
  roe: number | null;
  changePercent: number | null;
}

/**
 * Below this, an industry is too thin to rank within and we widen to the
 * sector. Calibrated on the measurement above: at 5, 83 groups covering 2,020
 * of 2,123 eligible instruments keep the tighter industry peer set, and only
 * 103 fall back.
 */
export const MIN_INDUSTRY_GROUP = 5;

/** Matches the reader's `peers.slice(0, 12)` in `getStockPeersAction`. */
export const MAX_PEERS = 12;

/**
 * `"N/A"` is `SECTOR_SKIPPED` — the sentinel the enrichment cron writes for a
 * permanently unresolvable symbol, precisely so it is never re-fetched. It is
 * NOT a sector, and 67% of the instrument table carries it.
 *
 * Treating it as one would bucket 14,893 unrelated instruments into a single
 * "sector" and hand every one of them peers drawn from that soup. Empty is the
 * correct output for these, and the tab now distinguishes empty from failed.
 */
export function hasRealSector(
  sector: string | null | undefined,
): sector is string {
  return (
    typeof sector === "string" && sector.length > 0 && sector !== SECTOR_SKIPPED
  );
}

/**
 * The same rule as a Prisma `where` fragment (MONEY-1152).
 *
 * `sector: { not: null }` is the naive filter this codebase has warned about in
 * a comment since MONEY-846 and used anyway in six places. Measured on QA, that
 * is not a rounding error:
 *
 * - the `/discover` sector-performance list rendered **"N/A" as its 3rd-largest
 *   sector** — 1,296 instruments, 15.8% of the aggregate — because
 *   `normalizeToNseSector("N/A")` passes the sentinel through unchanged;
 * - the NSE heatmap's universe was **7,822 N/A against 2,289 real**, so the
 *   uncategorised tile outweighed every genuine sector combined.
 *
 * ## Why BOTH clauses
 *
 * `not: null` and `notIn` are not redundant, and neither alone is right:
 *
 * - `not: null` alone keeps the sentinel — the bug above.
 * - `notIn: [SECTOR_SKIPPED]` alone would newly INCLUDE documents where the
 *   field is ABSENT rather than null, because in MongoDB a missing field
 *   satisfies `$nin`. That is the same Prisma-on-Mongo trap as MONEY-1050's
 *   `{not: false}`, and it would silently widen every one of these queries.
 *
 * Together they are strictly narrower than today's filter, which is what makes
 * this a safe swap at six call sites at once.
 *
 * This is an OPTIMISATION, not the guarantee. `hasRealSector` in JS stays the
 * authoritative check — it also catches the empty string, which no `where`
 * fragment here excludes.
 *
 * Typed explicitly rather than `as const`: that would make `notIn` a `readonly`
 * tuple, and Prisma's `StringNullableFilter` declares `notIn` as a mutable
 * `string[]`, so the const assertion fails to type-check at every call site.
 */
export const REAL_SECTOR_WHERE: { not: null; notIn: string[] } = {
  not: null,
  notIn: [SECTOR_SKIPPED],
};

/**
 * Distance between two market caps on a LOG scale.
 *
 * Linear distance is wrong here and not subtly: caps span from ~₹100 Cr to
 * ~₹20,00,000 Cr, so for any large-cap the absolute-nearest names are simply
 * the other giants, and every mid-cap's peer set collapses onto whichever
 * neighbour happens to sit closest in rupees. Log distance asks "within what
 * MULTIPLE?" — a ₹5,000 Cr and a ₹10,000 Cr company are as comparable as a
 * ₹50,000 Cr and a ₹1,00,000 Cr one, which is how the comparison is actually
 * used.
 *
 * Returns `null` when either side is unusable, so the caller can rank those
 * last rather than treat a missing cap as distance zero.
 */
export function marketCapDistance(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // A non-positive cap is bad data, not a small company; excluding it beats
  // letting Math.log return -Infinity/NaN and poison the sort.
  if (a <= 0 || b <= 0) return null;
  return Math.abs(Math.log(a) - Math.log(b));
}

/**
 * Separator for the composite `(exchange, sector, industry)` group key.
 *
 * A NUL, because it cannot occur in any of the three fields — but written as
 * the ESCAPE `\u0000`, never as a literal byte. git classifies a blob as BINARY
 * on finding a NUL in its first 8000 bytes and then shows NO diff at all, so a
 * literal one makes the whole module invisible to `git diff`, `gh pr diff` and
 * every review tool. Pinned by the package-wide scan in
 * `packages/core/__tests__/screener/market-fields-reader.test.ts`.
 */
const KEY_SEP = "\u0000";

/**
 * Group key. Same exchange is part of the identity, deliberately — see
 * `selectPeers`.
 */
function groupKey(
  sector: string,
  industry: string | null,
  exchange: string,
): string {
  return `${exchange}${KEY_SEP}${sector}${KEY_SEP}${industry ?? ""}`;
}

/**
 * Index the universe once, so selecting for N instruments is O(N * groupSize)
 * rather than O(N^2) over the whole table.
 */
export function indexUniverse(universe: readonly PeerCandidate[]): {
  byIndustry: Map<string, PeerCandidate[]>;
  bySector: Map<string, PeerCandidate[]>;
} {
  const byIndustry = new Map<string, PeerCandidate[]>();
  const bySector = new Map<string, PeerCandidate[]>();

  for (const c of universe) {
    if (!hasRealSector(c.sector)) continue;

    const sk = groupKey(c.sector, null, c.exchange);
    let s = bySector.get(sk);
    if (!s) {
      s = [];
      bySector.set(sk, s);
    }
    s.push(c);

    if (c.industry) {
      const ik = groupKey(c.sector, c.industry, c.exchange);
      let i = byIndustry.get(ik);
      if (!i) {
        i = [];
        byIndustry.set(ik, i);
      }
      i.push(c);
    }
  }

  return { byIndustry, bySector };
}

/**
 * Peers for one instrument, nearest-market-cap-first within the tightest group
 * that is big enough to be meaningful.
 *
 * ## Same exchange only — this one is a trap, not a preference
 *
 * NSE and BSE list many of the same companies. Ranking across exchanges would
 * hand `RELIANCE` on NSE its own BSE listing as the closest possible peer: an
 * IDENTICAL market cap, so a perfect score, so rank 1. Every dual-listed
 * company's peer list would open with itself. The exchange is therefore part of
 * the group identity rather than a filter applied afterwards.
 *
 * ## Ties break on symbol
 *
 * Not cosmetic: this job re-runs daily and upserts. A non-deterministic order
 * would rewrite every row on every run, churning `updatedAt` across the whole
 * collection and making "did peers actually change?" unanswerable.
 */
export function selectPeers(
  target: PeerCandidate,
  index: {
    byIndustry: Map<string, PeerCandidate[]>;
    bySector: Map<string, PeerCandidate[]>;
  },
  limit: number = MAX_PEERS,
): SelectedPeer[] {
  if (!hasRealSector(target.sector)) return [];

  const industryGroup = target.industry
    ? (index.byIndustry.get(
        groupKey(target.sector, target.industry, target.exchange),
      ) ?? [])
    : [];

  // Widen to the sector when the industry is too thin to rank within. Note the
  // threshold counts the group INCLUDING the target, which is why the
  // comparison is against MIN_INDUSTRY_GROUP rather than MIN_INDUSTRY_GROUP + 1.
  const pool =
    industryGroup.length >= MIN_INDUSTRY_GROUP
      ? industryGroup
      : (index.bySector.get(groupKey(target.sector, null, target.exchange)) ??
        []);

  const ranked = pool
    .filter((c) => c.symbol !== target.symbol)
    .map((c) => ({ c, d: marketCapDistance(target.marketCap, c.marketCap) }))
    .sort((x, y) => {
      // Unrankable (missing/bad cap) sorts after everything rankable, rather
      // than being treated as distance 0 and jumping to the front.
      if (x.d === null && y.d === null) return x.c.symbol < y.c.symbol ? -1 : 1;
      if (x.d === null) return 1;
      if (y.d === null) return -1;
      if (x.d !== y.d) return x.d - y.d;
      return x.c.symbol < y.c.symbol ? -1 : 1;
    })
    .slice(0, limit);

  return ranked.map(({ c }) => ({
    symbol: c.symbol,
    name: c.name,
    marketCap: c.marketCap,
    pe: c.pe,
    roe: c.roe,
    changePercent: c.changePercent,
  }));
}
