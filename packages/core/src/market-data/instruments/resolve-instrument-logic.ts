/**
 * Cross-market instrument resolution — the PURE half (MONEY-980).
 *
 * ## What this replaces
 *
 * Three places resolved a bare symbol with a HAND-TYPED venue list against
 * `instrument_mappings`:
 *
 *   packages/research/src/data-sources/symbol-resolver.ts
 *   packages/research/src/agent.ts
 *   apps/web/app/api/chat/route.ts   (no venue clause at all)
 *
 * The first two spelled `exchange: { in: ["NSE","BSE","NASDAQ","NYSE","AMEX"] }`.
 * That list was correct for exactly as long as the US master wrote into
 * `instrument_mappings`. Once US securities moved to `us_instruments`, three of
 * those five terms match ZERO ROWS BY CONSTRUCTION — no error, no empty-result
 * warning, just a US ticker that has stopped being resolvable while the code
 * still reads as though it handles US. The third site did the opposite damage:
 * `findFirst({ symbol, isActive })` with no venue clause and no ordering picks
 * by Mongo's natural order, and there are 214 measured India/US ticker
 * collisions (ACC, BABA, AUTO, BBOX…), so "which company answered" was a
 * function of insertion order.
 *
 * A hand-typed venue list is the wrong shape for this question in the first
 * place: it encodes BOTH "which markets exist" and "which market wins" at every
 * call site, so a schema change has to be found in N places and a preference
 * change is unstateable. This module states each exactly once.
 *
 * ## The preference order, stated rather than implied
 *
 * **India wins a bare-symbol tie.** UseMoney is an India-first product — every
 * broker it integrates is Indian, every portfolio it holds is Indian, and the
 * India-first ordering (`NSE > BSE > …`) was already the de-facto behaviour of
 * all three call sites. What was missing was anyone SAYING so: two sites got
 * India-first by listing NSE and BSE first in a literal, and the third got an
 * arbitrary answer. This is now a named constant with a reason attached, so
 * flipping it is a decision someone makes rather than a literal someone
 * reorders.
 *
 * A caller that means the other thing says `market: "US"`, and a caller that
 * knows the venue says `exchange`. Neither has to know which collection holds
 * the answer — that is the whole point of the seam.
 *
 * ### "India wins a TIE" is NOT "India is consulted first"
 *
 * `decideResolution` expresses a preference between two ANSWERS. It cannot
 * express a preference between two STRATEGIES, and that difference is the whole
 * of MONEY-980's first regression: when India returns zero rows the US row wins
 * OUTRIGHT, and for a token lifted out of free text or out of an LLM planner's
 * output, "India returned zero rows" is the ORDINARY case, not a tie.
 *
 * The three call sites this module replaced all run an India ladder — exact
 * symbol, then company-name `startsWith`, then `contains` — and the exact-symbol
 * rung RETURNS EARLY. Route that rung through an unscoped `resolveInstrument`
 * and a bare token that is an active US ticker but not an India `symbol` is
 * answered from `us_instruments` before the name rungs it was written for ever
 * run: "INFOSYS" stops becoming INFY, and an English word the planner mistook
 * for a ticker becomes a NYSE company.
 *
 * So those paths pass `market: "IN"` EXPLICITLY. The rule is not "India is
 * better", it is that a bare token with no venue, no market and no user intent
 * behind it is an India question on an India-first product, and the US
 * collection may only answer one that says so. `resolve-instrument.test.ts`
 * pins the call sites by source; `market: "IN" skips the US read entirely`
 * pins what the flag does.
 *
 * The India-side venue order is `NSE > BSE > NFO > BFO > MCX`. NSE over BSE is
 * the long-standing behaviour and is a VENUE choice, not a COMPANY choice: an
 * NSE row and a BSE row for one symbol are one issuer dual-listed. That is why
 * India never refuses on multiplicity and the US side does — see below.
 *
 * ## Ambiguity: the US side REFUSES, the India side PICKS
 *
 * `UsInstrument` is `@@unique([listingId])` and `@@index([symbol, exchange])`
 * NOT unique, deliberately: a recycled ticker is two rows on one venue. NYSE
 * carries two `DOW` rows — Dow Chemical 1972-2017 and Dow Inc. 2019- —
 * identical in exchange, assetType and currency. So on the US side, two
 * surviving rows are TWO DIFFERENT COMPANIES, and picking one is picking a
 * company. This returns `AMBIGUOUS` instead.
 *
 * That is the same call `CandleRepository.resolveCurrentListingId` already
 * makes, for the same reason spelled out there: a wrong listing hint silently
 * drops the other company's bars out of the series, and half a chart is not
 * visibly wrong. Consistency between the two matters more than either choice on
 * its own — a resolver that picks while the candle reader refuses would hand a
 * caller a confident symbol whose price series then comes back empty.
 *
 * `InstrumentMapping` is `@@unique([symbol, exchange])`, so the India side can
 * hold at most one row per venue and multiplicity there means dual listing, not
 * ambiguity. Ranking by venue is therefore complete, and `AMBIGUOUS` is
 * unreachable from the India side. (Residual: two genuinely different issuers
 * sharing a ticker across NSE and BSE would be mis-ranked rather than refused.
 * No such pair is known; the venue rank is what would need revisiting.)
 *
 * ## Delisted / inactive rows
 *
 * The two collections retire rows differently — `UsInstrument.listingStatus =
 * "DELISTED"` (the row stays, it is the delisted tail the US backbone exists to
 * hold) versus `InstrumentMapping.isActive = false`. Callers should not have to
 * know that either.
 *
 * `includeInactive` defaults FALSE, so the default answer is a live security.
 * Set it and BOTH collections widen, with liveness as the FIRST rank key — so a
 * delisted row comes back only when nothing live matched, and a live BSE row
 * still beats a dead NSE one.
 *
 * Liveness is matched POSITIVELY in the query (`listingStatus: { in: [...] }`,
 * `isActive: true`) and never as a negation. On Mongo an attribute added by a
 * `db push` is ABSENT rather than null on pre-existing rows, so
 * `{ listingStatus: { not: "DELISTED" } }` and `{ isActive: { not: false } }`
 * both match ZERO. That class has caused MONEY-1050, MONEY-1205, MONEY-1234 and
 * MONEY-1235; it is not hypothetical.
 *
 * ## Pure
 *
 * No Prisma, no clock, no environment. `resolve-instrument.ts` owns the two
 * queries and hands the rows here.
 */

import { SUPPORTED_EXCHANGES, US_EXCHANGES, YAHOO_SUFFIX_MAP } from "./types";

/** Which collection an instrument lives in. Not a display label. */
export type InstrumentMarket = "IN" | "US";

/**
 * India venue preference, most-preferred first.
 *
 * Spelled here rather than read off `SUPPORTED_EXCHANGES`'s array order,
 * even though the two lists happen to agree today. That constant answers
 * "which rows of Kite's dump do we keep" and is edited for ingest reasons; a
 * reorder there must not silently move BSE ahead of NSE for every reader in the
 * product. `resolve-instrument-logic.test.ts` asserts this list COVERS
 * `SUPPORTED_EXCHANGES`, so adding a venue there without ranking it here is a
 * failing test rather than a rank of 99.
 */
export const INDIA_VENUE_ORDER = ["NSE", "BSE", "NFO", "BFO", "MCX"] as const;

const INDIA_VENUE_RANK: ReadonlyMap<string, number> = new Map(
  INDIA_VENUE_ORDER.map((venue, index) => [venue, index]),
);

/**
 * The venues on which `InstrumentMapping.name` is a COMPANY name.
 *
 * A different question from `INDIA_VENUE_ORDER`, which ranks the venues a
 * SYMBOL may be found on. NFO / BFO / MCX rows carry contract names
 * (`NIFTY25SEP25000CE`, `CRUDEOIL25SEPFUT`), not issuer names, so a
 * company-name search that included them would match a derivative contract and
 * hand the caller a symbol every downstream company tool then fails on.
 *
 * Exported because both name-search call sites — `apps/web/app/api/chat/route.ts`
 * and `packages/research/src/agent.ts` — need it, and a hand-typed
 * `["NSE","BSE"]` in each is the fourth and fifth copy of exactly the list this
 * module exists to state once. `resolve-instrument-logic.test.ts` asserts it is
 * a SUBSET of `INDIA_VENUE_ORDER`, so a venue that is ranked but not nameable
 * cannot drift in here unnoticed.
 */
export const INDIA_CASH_VENUES = ["NSE", "BSE"] as const;

/** Rank for a venue this list does not name — always LAST, never negative. */
const UNRANKED_VENUE = Number.MAX_SAFE_INTEGER;

/**
 * Rows fetched per collection per call.
 *
 * A bound, not a page: everything below ranks in memory over whatever it is
 * given. India cannot exceed 5 by construction (`@@unique([symbol, exchange])`
 * across `SUPPORTED_EXCHANGES`). The US side is the one that can repeat —
 * Tiingo's master repeats 2,196 tickers, 928 of them across venues — and the
 * query orders `listingStartDate desc`, so a pathological ticker with more than
 * this many windows loses its OLDEST rows, which are the least likely answer
 * and the most likely to be already DELISTED.
 */
export const RESOLVE_ROW_LIMIT = 12;

/**
 * One `instrument_mappings` row, as a shape rather than a Prisma type.
 *
 * Structural on purpose: the tests build these by hand, and this file must not
 * import `@usemoney/database` (it is the pure half).
 */
export interface IndiaInstrumentRow {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  yahooSymbol: string;
  instrumentType: string;
  isin: string | null;
  isActive: boolean;
}

/** One `us_instruments` row. */
export interface UsInstrumentRow {
  id: string;
  listingId: string;
  symbol: string;
  exchange: string;
  name: string | null;
  assetType: string;
  listingStatus: string;
  listingStartDate: Date | null;
}

/**
 * One resolved security, with the market it came from ATTACHED.
 *
 * Callers must not need to know which collection answered — but they do need to
 * know which MARKET did, because the downstream price path differs: India reads
 * `DailyPrice`/`LatestQuote` via Yahoo symbols, US reads `CandleRepository` by
 * `listingId`. `market` is the one field that lets a caller branch correctly
 * without querying either table again.
 */
export interface ResolvedInstrument {
  market: InstrumentMarket;
  /** `InstrumentMapping.id` or `UsInstrument.id`. */
  id: string;
  symbol: string;
  exchange: string;
  /** `UsInstrument.name` is null until the paced name leg reaches the row. */
  name: string | null;
  /** See `yahooSymbolFor` — exact for India, best-effort for US. */
  yahooSymbol: string;
  /** US only: the listing identity `Candle.listingId` points at. Null for India. */
  listingId: string | null;
  /** India only today; `us_instruments` carries no ISIN. */
  isin: string | null;
  /** US only: Stock | ETF | Mutual Fund. */
  assetType: string | null;
  /** India only: EQUITY | INDEX | ETF | … */
  instrumentType: string | null;
  /** Live on its venue. `isActive` for India, `listingStatus === "ACTIVE"` for US. */
  active: boolean;
}

export type ResolveInstrumentResult =
  | {
      status: "RESOLVED";
      instrument: ResolvedInstrument;
      /**
       * Every other candidate considered, in rank order. Carries the OTHER
       * market's match when a bare symbol collides — the 214 India/US
       * collisions become visible to a caller that wants to disclose them
       * instead of being silently discarded.
       */
      alternatives: readonly ResolvedInstrument[];
    }
  | {
      status: "AMBIGUOUS";
      /** Which market could not be narrowed. Always "US" today — see the header. */
      market: InstrumentMarket;
      candidates: readonly ResolvedInstrument[];
      /** Operator/user-facing sentence. Never contains a chosen answer. */
      reason: string;
    }
  | { status: "NOT_FOUND" };

/**
 * Strip a symbol down to the form both collections store.
 *
 * TRIM FIRST. The suffix strip is `$`-anchored, so trailing whitespace stops it
 * matching and `"RELIANCE.NS "` came back as `"RELIANCE.NS"` — a wrong symbol,
 * and non-empty, so every caller's `if (!symbol)` guard sailed past it. That is
 * the bug already documented on `toNseSymbol`; it is repeated here because this
 * function is reachable from LLM planner output too.
 *
 * Returns `""` for anything that cannot be a ticker, so callers get a falsy
 * value to guard on rather than an exception.
 */
export function normalizeResolveSymbol(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/\.(NS|BO)$/i, "")
    .trim()
    .toUpperCase();
}

/**
 * Which market a venue belongs to, or `null` when the venue is unknown to
 * either list.
 *
 * `null` is NOT "both" and must not be treated as such: an unrecognised venue
 * hint means the caller is asking about something neither collection is scoped
 * to hold, and widening to both markets would answer a question that was not
 * asked. `resolveInstrument` turns it into NOT_FOUND with zero queries.
 */
export function marketForExchange(
  exchange: string | null | undefined,
): InstrumentMarket | null {
  if (typeof exchange !== "string") return null;
  const venue = exchange.trim().toUpperCase();
  if (venue === "") return null;
  if ((SUPPORTED_EXCHANGES as readonly string[]).includes(venue)) return "IN";
  if (US_EXCHANGES.has(venue)) return "US";
  return null;
}

/**
 * Yahoo symbol for a resolved row.
 *
 * India: the stored column, which the sync writes and `@@unique([yahooSymbol])`
 * guarantees is one per ticker. Falls back to `symbol + suffix` only if the
 * stored value is blank, and to `.NS` for a venue with no mapping — matching
 * `YAHOO_SUFFIX_MAP`'s documented `??` semantics.
 *
 * US: the BARE ticker. `us_instruments` has no `yahooSymbol` column and US
 * Yahoo symbols carry no suffix, so this is a derivation, not a lookup — with
 * one known limit written down rather than discovered later: Tiingo spells
 * multi-part tickers with DASHES (`BRK-A`, `SPG-P-J`) and Yahoo does not always
 * agree for preferred/unit lines (`SPG-PJ`). Plain equities and ETFs — the
 * overwhelming majority, and everything a chat or research query names — match
 * exactly.
 *
 * Note also that Yahoo is NOT the US price path in this product: US prices come
 * from the `candles` warehouse, keyed by `listingId`, which is why that field is
 * on `ResolvedInstrument`. This value exists so the three existing call sites,
 * all of which feed a Yahoo-shaped symbol downstream, keep working.
 */
export function yahooSymbolFor(
  market: InstrumentMarket,
  symbol: string,
  exchange: string,
  stored?: string | null,
): string {
  if (market === "US") return symbol;
  const trimmed = typeof stored === "string" ? stored.trim() : "";
  if (trimmed !== "") return trimmed;
  const suffix = YAHOO_SUFFIX_MAP[exchange] ?? ".NS";
  return `${symbol}${suffix}`;
}

/** Project an `instrument_mappings` row into the market-agnostic shape. */
export function toResolvedIndia(row: IndiaInstrumentRow): ResolvedInstrument {
  return {
    market: "IN",
    id: row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    name: row.name,
    yahooSymbol: yahooSymbolFor(
      "IN",
      row.symbol,
      row.exchange,
      row.yahooSymbol,
    ),
    listingId: null,
    isin: row.isin,
    assetType: null,
    instrumentType: row.instrumentType,
    active: row.isActive === true,
  };
}

/** Project a `us_instruments` row into the market-agnostic shape. */
export function toResolvedUs(row: UsInstrumentRow): ResolvedInstrument {
  return {
    market: "US",
    id: row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    name: row.name,
    yahooSymbol: yahooSymbolFor("US", row.symbol, row.exchange),
    listingId: row.listingId,
    isin: null,
    assetType: row.assetType,
    instrumentType: null,
    // POSITIVE match. Absent-vs-null on Mongo means a negation matches nothing;
    // and a row whose status is some future third value must read as NOT live
    // rather than as live-by-default.
    active: row.listingStatus === "ACTIVE",
  };
}

function venueRank(exchange: string): number {
  return INDIA_VENUE_RANK.get(exchange) ?? UNRANKED_VENUE;
}

/** Milliseconds, or -Infinity for a row with no start date (sorts last on desc). */
function startedAt(row: UsInstrumentRow): number {
  const value = row.listingStartDate;
  if (!(value instanceof Date)) return Number.NEGATIVE_INFINITY;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Rank India rows: live first, then venue, then id for a total order.
 *
 * The final `id` tiebreak is not decoration — without it the order of two rows
 * that tie on both keys is whatever Mongo returned, which is the exact
 * non-determinism this module exists to remove. `@@unique([symbol, exchange])`
 * makes a venue tie impossible today, so the tiebreak is unreachable and stays
 * anyway: it costs nothing and it is what makes "deterministic" true rather
 * than merely likely.
 */
export function rankIndiaRows(
  rows: readonly IndiaInstrumentRow[],
): ResolvedInstrument[] {
  return [...rows].map(toResolvedIndia).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const venueDiff = venueRank(a.exchange) - venueRank(b.exchange);
    if (venueDiff !== 0) return venueDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Rank US rows: live first, then most recently listed, then listingId.
 *
 * `listingStartDate desc` inside the live tier is presentation only — two live
 * rows are refused, not ordered — but it is what makes the DELISTED tail read
 * newest-first when `includeInactive` is set, which is the order a "did you
 * mean" list wants.
 */
export function rankUsRows(
  rows: readonly UsInstrumentRow[],
): ResolvedInstrument[] {
  const withOrder = rows.map((row) => ({
    resolved: toResolvedUs(row),
    startedAt: startedAt(row),
  }));
  withOrder.sort((a, b) => {
    if (a.resolved.active !== b.resolved.active)
      return a.resolved.active ? -1 : 1;
    if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
    const aKey = a.resolved.listingId ?? a.resolved.id;
    const bKey = b.resolved.listingId ?? b.resolved.id;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return withOrder.map((entry) => entry.resolved);
}

/** The rows tied at the top liveness tier — the set ambiguity is judged over. */
function topLivenessTier(
  ranked: readonly ResolvedInstrument[],
): ResolvedInstrument[] {
  const head = ranked[0];
  if (head === undefined) return [];
  return ranked.filter((row) => row.active === head.active);
}

export interface ResolutionInputs {
  india: readonly IndiaInstrumentRow[];
  us: readonly UsInstrumentRow[];
}

/**
 * Turn the two row sets into one answer.
 *
 * Order of operations, and why:
 *
 *   1. Rank each market independently. Cross-market ranking would need a
 *      comparator between an NSE row and a NASDAQ row, and there is no such
 *      thing — they are different securities, not two prices for one.
 *   2. India wins if it produced anything. See the header: India-first, stated.
 *      That deliberately means a US AMBIGUITY does not block an India answer —
 *      the India row is not made less correct by the US collision, and refusing
 *      would break every India ticker that happens to collide (ACC, AUTO, …).
 *      The unnarrowed US candidates ride along in `alternatives` so nothing is
 *      hidden.
 *   3. Only with no India row does US ambiguity become the answer.
 *
 * Step 2 is a preference between two ANSWERS and cannot substitute for a
 * caller's scope: with no India row the US row wins OUTRIGHT, which is right
 * for a caller that named a security and wrong for one holding a token it
 * scraped out of a sentence. Those callers pass `market: "IN"` — see the
 * header's "India wins a TIE is NOT India is consulted first".
 */
export function decideResolution(
  inputs: ResolutionInputs,
): ResolveInstrumentResult {
  const india = rankIndiaRows(inputs.india);
  const us = rankUsRows(inputs.us);

  const usTop = topLivenessTier(us);
  const usAmbiguous = usTop.length > 1;
  const usWinner = usAmbiguous ? null : (usTop[0] ?? null);

  const indiaWinner = india[0] ?? null;

  if (indiaWinner !== null) {
    const alternatives = [
      ...india.slice(1),
      // Ambiguous or not, every US candidate is disclosed, in rank order.
      // Dropping them on the ambiguous path would make a collision LESS visible
      // the more confusing it is.
      //
      // This was written as a three-arm ternary — `usAmbiguous ? us :
      // usWinner === null ? [] : [usWinner, ...us.slice(1)]` — whose arms were
      // all `us`, provably and on every input. `topLivenessTier` FILTERS `us`
      // in place, so `usTop[0]` is `us[0]` whenever it exists, which collapses
      // arm 3 to `[us[0], ...us.slice(1)]`; and `usWinner` is null with
      // `usAmbiguous` false only when `us` is itself empty, which collapses
      // arm 2 to `[]`. Three spellings of one value read as three behaviours
      // and invite a reader to "fix" one of them into a real difference.
      ...us,
    ];
    return { status: "RESOLVED", instrument: indiaWinner, alternatives };
  }

  if (usAmbiguous) {
    return {
      status: "AMBIGUOUS",
      market: "US",
      candidates: usTop,
      reason:
        `"${usTop[0]?.symbol ?? ""}" matches ${usTop.length} US listings ` +
        `(${usTop.map((c) => `${c.exchange}:${c.listingId ?? c.id}`).join(", ")}). ` +
        "A US ticker can be reused by a different company, so naming one here " +
        "would silently answer about the wrong security — pass an exchange or a " +
        "listingId.",
    };
  }

  if (usWinner !== null) {
    return {
      status: "RESOLVED",
      instrument: usWinner,
      alternatives: us.slice(1),
    };
  }

  return { status: "NOT_FOUND" };
}
