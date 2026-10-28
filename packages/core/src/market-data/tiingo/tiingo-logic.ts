/**
 * Pure, side-effect-free helpers for the Tiingo US price backbone (MONEY-980).
 *
 * Extracted so the exact code production runs can be unit-tested with no
 * network and no Prisma. `tiingo-client.ts` imports and calls these — there are
 * no parallel copies.
 *
 * Everything here was written against RESPONSES MEASURED FROM THE LIVE API on
 * 2026-08-28, not against the documentation. Three of the rules below contradict
 * what the docs say, and each contradiction is called out where it applies.
 */

import { splitCsvLine } from "../csv-line";

/**
 * Rate limits, keyed by plan — the ONE switch between what we hold today and
 * what we are contracted to move to.
 *
 * Published in no doc page and returned in no response header (checked: a
 * successful EOD call carries only `x-frame-options`), so these come from the
 * account's own pricing table and cannot be discovered at runtime. A 429 is the
 * only feedback channel, which is why the client throttles PROACTIVELY.
 */
export const TIINGO_PLAN_LIMITS = {
  /** $50/mo "Commercial". Business entity, license is INTERNAL USE ONLY. */
  COMMERCIAL: {
    perHour: 20_000,
    perDay: 150_000,
    bandwidthBytesPerMonth: 100 * 1024 ** 3, // 100 GB
  },
  /** $250/mo "EOD + IEX Redistribution", startup tier. Grants DISPLAY rights. */
  REDISTRIBUTION: {
    perHour: 80_000,
    perDay: 1_200_000,
    bandwidthBytesPerMonth: 1024 ** 4, // 1 TB
  },
} as const;

export type TiingoPlan = keyof typeof TIINGO_PLAN_LIMITS;
export type TiingoLimits = (typeof TIINGO_PLAN_LIMITS)[TiingoPlan];

/**
 * Which plan's ceilings to obey, from `TIINGO_PLAN`.
 *
 * DEFAULTS TO `COMMERCIAL`, the LOWER pair, and that direction is the whole
 * point. Guessing too high walks the backfill into a 429 wall mid-universe and
 * leaves a partially-filled table; guessing too low only makes it slower. An
 * unset or misspelled value must therefore land on the conservative plan, never
 * the generous one — the same reasoning as XBRL_PROJECTION_APPLY comparing
 * against a literal string rather than `Boolean()`, where `Boolean("false")` is
 * `true` and arms the one configuration meant to stay off.
 *
 * Read PER CALL rather than captured in a module `const`: a module-scope read
 * freezes the value at import, so a test (or a worker that loads config after
 * boot) setting the env afterwards silently gets the default. That exact bug is
 * documented on `bse-client.ts`'s retry config.
 */
export function resolveTiingoPlan(
  raw: string | undefined = process.env.TIINGO_PLAN,
): TiingoPlan {
  const v = raw?.trim().toUpperCase();
  return v === "REDISTRIBUTION" ? "REDISTRIBUTION" : "COMMERCIAL";
}

/** The active plan's ceilings. */
export function tiingoLimits(
  plan: TiingoPlan = resolveTiingoPlan(),
): TiingoLimits {
  return TIINGO_PLAN_LIMITS[plan];
}

/**
 * Backfill sizing, measured — it fits inside EITHER plan, which is why the
 * switch is a throttle setting and not a blocker.
 *
 * The full US universe is ~74,200 securities at ONE request each, because a
 * single call returns a symbol's entire history (AAPL: 11,517 bars, 1980-2026,
 * 820,616 bytes, 2.4s with `format=csv&columns=`). 24,328 of those are equities
 * and ETFs; the rest are mutual funds, whose series are far shorter.
 *
 *   COMMERCIAL      20,000/hr -> ~3.7 hours of requests; ~10 GB of 100 GB
 *   REDISTRIBUTION  80,000/hr -> ~1 hour;                ~10 GB of 1 TB
 *
 * Both are comfortable. What is NOT comfortable is JSON: the same pull is
 * ~15 GB and 7.5x slower, which is a real fraction of the Commercial monthly
 * allowance — hence `columns` + `format=csv` in the client.
 */
export const TIINGO_US_UNIVERSE_ESTIMATE = 74_200;

/**
 * The exchanges a US equity backbone ingests.
 *
 * Deliberately EXCLUDES the OTC groups (PINK, OTCMKTS, OTCGREY, OTCBB, OTCQB,
 * OTCQX, OTCCE, OTCD, EXPM — 26,813 rows), the Chinese A-share venues (SHE,
 * SHG, SHEB, SHGB) and LSE. Tiingo covers all of them; this integration does
 * not, and an unlisted venue must be added here deliberately rather than arrive
 * by accident through a widened filter.
 */
export const TIINGO_US_EXCHANGES: ReadonlySet<string> = new Set([
  "NASDAQ",
  "NYSE",
  "AMEX",
  "NYSE ARCA",
  "NYSE MKT",
  "NYSE NAT",
  "BATS",
  // MONEY-980 — the mutual-fund venue. NOT an exchange: NMFQS is where Tiingo
  // files the 49,876 funds whose "price" is a daily NAV, and it is the single
  // venue for all of them, so it never competes for a ticker the way the equity
  // boards do. Funds are in scope because the nightly job has a NAV leg, and a
  // leg whose population is empty by construction reads as healthy forever —
  // which is the failure this whole module is written against.
  "NMFQS",
]);

/** Asset types this backbone stores. Funds are a separate nightly leg. */
export const TIINGO_US_ASSET_TYPES: ReadonlySet<string> = new Set([
  "Stock",
  "ETF",
  // A fund's OHLC fields carry its NAV rather than a traded price, and Tiingo
  // publishes them after 12:00 AM ET — a separate, later pass from the 5:30 PM
  // ET equity close. Same shape, different clock.
  "Mutual Fund",
]);

/** A row of Tiingo's daily `supported_tickers.zip`. */
export interface TiingoMasterRow {
  ticker: string;
  exchange: string;
  assetType: string;
  priceCurrency: string;
  /** ISO `YYYY-MM-DD`, or null when the file leaves it blank. */
  startDate: string | null;
  endDate: string | null;
}

/** One raw EOD bar as Tiingo prints it. Prices are UNADJUSTED. */
export interface TiingoEodBar {
  date: string; // ISO YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  divCash: number;
  splitFactor: number;
}

/** A bar with the back-adjusted series computed alongside the raw one. */
export interface AdjustedBar extends TiingoEodBar {
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjClose: number;
  adjVolume: number;
}

const MASTER_HEADER = [
  "ticker",
  "exchange",
  "assetType",
  "priceCurrency",
  "startDate",
  "endDate",
] as const;

/**
 * Parse `supported_tickers.csv`.
 *
 * Columns are resolved BY HEADER NAME, never by position — see
 * `parseTiingoEodCsv` for the measured reason that rule exists.
 *
 * Tolerant per row: a malformed line is dropped, never thrown, because one bad
 * row in a 108,489-row file must not cost the whole instrument master.
 */
export function parseTiingoMasterCsv(text: string): TiingoMasterRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  const idx = new Map(header.map((h, i) => [h, i]));
  for (const col of MASTER_HEADER) {
    if (!idx.has(col)) return [];
  }

  const out: TiingoMasterRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const at = (col: string): string => (cells[idx.get(col)!] ?? "").trim();

    const ticker = at("ticker");
    // 132 rows in the live file carry an EMPTY exchange. They are dropped by
    // `isUsCoreSecurity` rather than here, so the count stays visible.
    if (ticker === "") continue;

    out.push({
      ticker,
      exchange: at("exchange"),
      assetType: at("assetType"),
      priceCurrency: at("priceCurrency"),
      startDate: at("startDate") || null,
      endDate: at("endDate") || null,
    });
  }
  return out;
}

/**
 * Is this master row in scope for the US equity backbone?
 *
 * `priceCurrency` is checked because the file is NOT US-only: 7,182 rows are
 * CNY, 52 HKD, 5 AUD. Filtering on exchange alone would let Shanghai listings
 * into a table whose prices are assumed to be dollars.
 */
export function isUsCoreSecurity(row: TiingoMasterRow): boolean {
  return (
    row.priceCurrency === "USD" &&
    TIINGO_US_EXCHANGES.has(row.exchange) &&
    TIINGO_US_ASSET_TYPES.has(row.assetType)
  );
}

/**
 * Stable identity for one occupancy window of a ticker — and THE listing id, in
 * every market.
 *
 * `DOW:NYSE:1972-06-01` and `DOW:NYSE:2019-03-20` are two different companies
 * that held the same ticker on the same exchange. The listing start date is the
 * only field in the master that separates them.
 *
 * ## ONE BUILDER, ONE ARITY, BOTH MARKETS — MONEY-1522
 *
 * India holds no listing start date, so an India id is
 * `{symbol}:{exchange}:unknown` — the `null` branch. The lake's India bar
 * writer used to spell its own `{symbol}:{exchange}` while `silver.listing` was
 * built here, and measured on prod 2026-09-22 the two id sets (16,898 and
 * 23,907) intersected in NOTHING: every identity-to-bars join returned zero and
 * every writer reported success. Founder decision 2026-09-23: three segments
 * everywhere, this function, the other deleted. A key whose SHAPE depends on
 * the market is itself the defect — a reader splitting on `:` must not need to
 * know where a row came from — and `unknown` says something true that dropping
 * the segment would discard.
 *
 * `packages/lake` cannot import this (no dependency edge in either direction),
 * so its mappers take it as an ARGUMENT from the shell rather than keeping a
 * copy — a copy is how the second spelling happened.
 *
 * ## A BLANK HALF THROWS
 *
 * Moved here from the deleted `indiaListingId`, so it covers every writer
 * rather than one. An empty symbol or exchange does not fail by itself: it
 * merges every such row onto one id (`:NSE:unknown`) and nothing about the
 * result looks wrong. No current caller reaches it on real data — the Tiingo
 * paths filter to a known exchange and a non-empty ticker first, and prod's
 * `listing` holds 0 of 98,249 rows with a blank half (measured 2026-09-23) —
 * which is why it throws rather than absorbs: the day it fires is a new defect
 * upstream.
 */
export function buildListingId(
  symbol: string,
  exchange: string,
  startDate: string | null,
): string {
  if (!symbol.trim() || !exchange.trim()) {
    throw new Error(
      `cannot build a listing id from symbol=${JSON.stringify(symbol)} ` +
        `exchange=${JSON.stringify(exchange)} — an empty half silently merges ` +
        `every such row onto one id`,
    );
  }
  return `${symbol}:${exchange}:${startDate ?? "unknown"}`;
}

/**
 * ACTIVE or DELISTED, derived from `endDate` — the master has NO status column,
 * and both date fields are always populated, so nullness carries no signal.
 *
 * The file's own `endDate` values are bimodal because equities and mutual-fund
 * NAVs land a day apart (measured: 38,480 rows at 2026-08-27, 27,303 at
 * 2026-08-26). So "active" is defined RELATIVE to the newest date present in
 * the file rather than against today's clock — a file fetched on a Monday, or
 * on a holiday, or replayed from the archive a day late, must not mark the
 * entire market delisted.
 *
 * The tolerance absorbs weekends and exchange holidays. A security that stopped
 * trading inside the window reads ACTIVE for a few more days and then corrects
 * itself on the next run; the opposite error — flipping a live security to
 * DELISTED — would drop it out of the nightly sync entirely.
 */
export function deriveListingStatus(
  row: TiingoMasterRow,
  fileMaxEndDate: string,
  toleranceDays = 7,
): "ACTIVE" | "DELISTED" {
  if (!row.endDate) return "DELISTED";
  const end = Date.parse(`${row.endDate}T00:00:00Z`);
  const newest = Date.parse(`${fileMaxEndDate}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(newest)) return "DELISTED";
  const ageDays = (newest - end) / 86_400_000;
  return ageDays <= toleranceDays ? "ACTIVE" : "DELISTED";
}

/** The newest `endDate` in the file — the reference point for the above. */
export function maxEndDate(rows: readonly TiingoMasterRow[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    if (r.endDate && (max === null || r.endDate > max)) max = r.endDate;
  }
  return max;
}

/**
 * Parse an EOD price response fetched with `format=csv`.
 *
 * ## Columns are read BY NAME because the live order is not the documented one
 *
 * The documentation lists the fields as open/high/low/close. The API actually
 * emits, measured 2026-08-28:
 *
 *     date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,adjVolume,divCash,splitFactor
 *
 * `close` is SECOND and `open` is FIFTH. A positional parser written from the
 * docs would silently swap every open and close — producing plausible bars,
 * correct row counts, no error, and a wrong candle for every US security we
 * hold. Reading by header name makes the column order irrelevant and a RENAMED
 * column a loud failure instead of a quiet one.
 *
 * The `adj*` columns are ignored on purpose: we store raw prices plus
 * `divCash`/`splitFactor` and recompute the adjusted series at read time. They
 * are still useful as an ORACLE — `computeAdjustedSeries` is tested against
 * them on real fixtures.
 */
export function parseTiingoEodCsv(text: string): TiingoEodBar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  const idx = new Map(header.map((h, i) => [h, i]));
  for (const col of ["date", "open", "high", "low", "close", "volume"]) {
    if (!idx.has(col)) return [];
  }

  const out: TiingoEodBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const num = (col: string, fallback: number): number => {
      const raw = cells[idx.get(col) ?? -1];
      if (raw === undefined || raw.trim() === "") return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    };

    const date = (cells[idx.get("date")!] ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const close = num("close", NaN);
    const open = num("open", NaN);
    const high = num("high", NaN);
    const low = num("low", NaN);
    // A bar with a non-finite price is not a bar. Dropped rather than stored as
    // NaN, which would poison every downstream average and render as "₹NaN".
    if (![close, open, high, low].every(Number.isFinite)) continue;

    out.push({
      date,
      open,
      high,
      low,
      close,
      volume: num("volume", 0),
      divCash: num("divCash", 0),
      // A zero split factor would divide by zero in the adjustment; treat any
      // non-positive value as "no split".
      splitFactor: (() => {
        const s = num("splitFactor", 1);
        return s > 0 ? s : 1;
      })(),
    });
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * Did this response describe a DIFFERENT security than the one we asked for?
 *
 * Tiingo serves only the CURRENT occupant of a recycled ticker: asked for `DOW`
 * over 1962-2026, it returned bars starting 2019-03-20 — Dow Inc., while the
 * master row we were filling was Dow Chemical's 1972-2017 window. Tiingo's own
 * docs bound this ("delisted data for tickers that have NOT YET been
 * recycled"), so the successor's history is all that exists to fetch.
 *
 * The test is cheap because both dates are already in hand: if the first bar
 * returned postdates the listing we asked about, the response cannot belong to
 * it. Writing it anyway would file one company's prices under another's
 * identity — silently, and indistinguishably from correct data.
 *
 * 834 delisted US rows share a ticker with a live one, so this is not a corner
 * case; it is ~8% of the delisted universe.
 */
export function isRecycledResponse(args: {
  listingEndDate: string | null;
  firstBarDate: string | null;
}): boolean {
  const { listingEndDate, firstBarDate } = args;
  if (!listingEndDate || !firstBarDate) return false;
  return firstBarDate > listingEndDate;
}

/**
 * Back-adjust a raw series for splits and cash dividends (CRSP methodology).
 *
 * Computed here rather than stored so a newly-announced corporate action
 * invalidates a cache instead of restating history — AAPL alone is 11,517 rows
 * that would otherwise be rewritten per event.
 *
 * Walks BACKWARD from the most recent bar, which is the only direction that
 * makes the latest bar equal its raw price. The factor contributed by bar `i`
 * applies to every bar before it:
 *
 *     f_i = (1 - divCash_i / close_{i-1}) / splitFactor_i
 *
 * Prices are multiplied by the cumulative factor; volume is scaled by the
 * cumulative SPLIT only (a 2:1 split doubles historical share counts and halves
 * historical prices — a dividend touches neither).
 *
 * `bars` must be ascending by date; `parseTiingoEodCsv` guarantees that.
 */
export function computeAdjustedSeries(
  bars: readonly TiingoEodBar[],
): AdjustedBar[] {
  const n = bars.length;
  if (n === 0) return [];

  const priceFactor = new Array<number>(n).fill(1);
  const splitCum = new Array<number>(n).fill(1);

  let cumPrice = 1;
  let cumSplit = 1;
  for (let i = n - 1; i >= 1; i--) {
    const cur = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    const split = cur.splitFactor > 0 ? cur.splitFactor : 1;
    const divRatio =
      prevClose > 0 && cur.divCash > 0 ? 1 - cur.divCash / prevClose : 1;

    cumPrice = (cumPrice * divRatio) / split;
    cumSplit = cumSplit / split;

    priceFactor[i - 1] = cumPrice;
    splitCum[i - 1] = cumSplit;
  }

  return bars.map((b, i) => {
    const f = priceFactor[i]!;
    const s = splitCum[i]!;
    return {
      ...b,
      adjOpen: b.open * f,
      adjHigh: b.high * f,
      adjLow: b.low * f,
      adjClose: b.close * f,
      // Inverse of the split factor: fewer/more shares in the adjusted world.
      adjVolume: s > 0 ? Math.round(b.volume / s) : b.volume,
    };
  });
}
