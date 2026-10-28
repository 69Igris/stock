/**
 * Cross-market instrument resolution — the I/O half (MONEY-980).
 *
 * ONE function, `resolveInstrument`, and ONE place a market preference is
 * spelled. Every ranking, tie-break, ambiguity and normalisation rule — and the
 * reasoning behind each — lives in `resolve-instrument-logic.ts`; this file is
 * the two queries and nothing else.
 *
 * ## TWO queries, never N
 *
 * `us_instruments` holds eight venues and `instrument_mappings` five. A resolver
 * that asked per venue would issue thirteen round trips to answer "what is
 * ACC?", inside a loop the research agent runs once per planned symbol. The
 * shape here is fixed: at most one `instrument_mappings` read and one
 * `us_instruments` read, issued CONCURRENTLY, and fewer when the caller has
 * already narrowed the market:
 *
 *   market: "IN"            -> 1 query   (India only)
 *   market: "US"            -> 1 query   (US only)
 *   exchange: "NASDAQ"      -> 1 query   (the venue names its market)
 *   market "IN" + NASDAQ    -> 0 queries (contradiction; NOT_FOUND)
 *   unparseable symbol      -> 0 queries
 *
 * `resolve-instrument.test.ts` counts the reads through the injected reader, so
 * a future fan-out fails a test rather than quietly costing twelve round trips
 * per symbol.
 *
 * ## Why a reader seam rather than calling Prisma inline
 *
 * There is no database in CI. Without the seam the only testable surface would
 * be the pure ranking, and the two things this file actually decides — WHICH
 * queries run, and with WHAT where-clause — would be untested. Those are
 * precisely where the bug being fixed lived: the old call sites' ranking logic
 * was fine, it was the venue list in the `where` that had gone stale.
 *
 * `defaultInstrumentReader` is the production path and is used whenever no
 * reader is passed.
 */

import { prisma } from "@usemoney/database";

import {
  decideResolution,
  marketForExchange,
  normalizeResolveSymbol,
  RESOLVE_ROW_LIMIT,
  type IndiaInstrumentRow,
  type InstrumentMarket,
  type ResolveInstrumentResult,
  type UsInstrumentRow,
} from "./resolve-instrument-logic";
import { SUPPORTED_EXCHANGES } from "./types";

export type {
  InstrumentMarket,
  ResolvedInstrument,
  ResolveInstrumentResult,
} from "./resolve-instrument-logic";
export {
  normalizeResolveSymbol,
  marketForExchange,
  // Re-exported so a caller that must write its OWN India query (a name search,
  // say) ranks venues the same way this resolver does, instead of typing a
  // fourth list. One list, one place.
  INDIA_VENUE_ORDER,
  // The venues on which `name` is a COMPANY name — the SCOPE a name search
  // queries, as distinct from the RANK above. See the constant's own doc.
  INDIA_CASH_VENUES,
} from "./resolve-instrument-logic";

export interface ResolveInstrumentInput {
  /** Bare ticker. `.NS` / `.BO` suffixes and surrounding whitespace are stripped. */
  symbol: string;
  /**
   * Venue hint. Narrows within a market AND selects the market — `"NASDAQ"`
   * means the India read is skipped entirely, not merely filtered to nothing.
   * An unrecognised venue resolves NOT_FOUND rather than being ignored: a
   * caller that named a venue we do not carry asked a question neither
   * collection can answer, and silently widening back to "any venue" would
   * answer a different one.
   */
  exchange?: string;
  /** Restrict to one market. Absent means "consult both, India wins a tie". */
  market?: InstrumentMarket;
  /**
   * Include retired securities — `isActive: false` on India,
   * `listingStatus: "DELISTED"` on US. Default false. Liveness stays the first
   * rank key either way, so setting this can only ADD answers where there were
   * none; it can never replace a live row with a dead one.
   */
  includeInactive?: boolean;
}

/** Arguments the India read needs. Resolved from the input, never from env. */
export interface IndiaReadArgs {
  symbol: string;
  /** Venues to accept. Always non-empty. */
  exchanges: readonly string[];
  liveOnly: boolean;
}

/** Arguments the US read needs. */
export interface UsReadArgs {
  symbol: string;
  /** A single venue, or undefined for "any US venue". */
  exchange?: string;
  liveOnly: boolean;
}

/**
 * The two reads, as a seam.
 *
 * Two methods and not one generic `find`: the collections have different
 * liveness columns and different multiplicity rules, and a single method would
 * have to take a discriminated argument that is just this interface inlined.
 */
export interface InstrumentReader {
  readIndia(args: IndiaReadArgs): Promise<IndiaInstrumentRow[]>;
  readUs(args: UsReadArgs): Promise<UsInstrumentRow[]>;
}

/**
 * Liveness values a US read accepts.
 *
 * A POSITIVE `in` list, never `{ not: "DELISTED" }`. `listingStatus` is a
 * column added by a Mongo `db push`, which creates indexes and not fields, so on
 * any row predating it the attribute is ABSENT — and both `{ not: "DELISTED" }`
 * and `{ equals: null }` match ZERO against an absent attribute. This repo has
 * shipped that bug four times (MONEY-1050, -1205, -1234, -1235).
 */
const US_LIVE_STATUSES = ["ACTIVE"] as const;
const US_ALL_STATUSES = ["ACTIVE", "DELISTED"] as const;

/** Production reader. Two Prisma calls, both bounded and both index-served. */
export const defaultInstrumentReader: InstrumentReader = {
  async readIndia({ symbol, exchanges, liveOnly }) {
    const rows = await prisma.instrumentMapping.findMany({
      where: {
        symbol,
        exchange: { in: [...exchanges] },
        // Same positive-match rule as the US side: `isActive` is a real column
        // with a default here, but `{ not: false }` would still be the wrong
        // habit to spread and reads as though it included absent rows.
        ...(liveOnly ? { isActive: true } : {}),
      },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        name: true,
        yahooSymbol: true,
        instrumentType: true,
        isin: true,
        isActive: true,
      },
      take: RESOLVE_ROW_LIMIT,
    });
    return rows;
  },

  async readUs({ symbol, exchange, liveOnly }) {
    const rows = await prisma.usInstrument.findMany({
      where: {
        symbol,
        listingStatus: {
          in: [...(liveOnly ? US_LIVE_STATUSES : US_ALL_STATUSES)],
        },
        ...(exchange === undefined ? {} : { exchange }),
      },
      select: {
        id: true,
        listingId: true,
        symbol: true,
        exchange: true,
        name: true,
        assetType: true,
        listingStatus: true,
        listingStartDate: true,
      },
      // Newest occupant first, so the bound truncates the OLDEST windows of a
      // pathological ticker rather than an arbitrary set. Ranking still happens
      // in memory — this order is which rows we SEE, not which one wins.
      orderBy: { listingStartDate: "desc" },
      take: RESOLVE_ROW_LIMIT,
    });
    return rows;
  },
};

/**
 * Resolve a bare symbol across both markets.
 *
 * Callers do not learn which collection answered — they learn which MARKET did,
 * via `instrument.market`, which is the fact they actually need (India's price
 * path is Yahoo/`DailyPrice`, the US's is `CandleRepository` by `listingId`).
 *
 * Never throws for a missing or malformed symbol; that is `NOT_FOUND`. It does
 * propagate a database error, because a resolver that swallowed one would
 * report "this ticker does not exist" for an outage — the fail-open shape this
 * repo has a standing rule against.
 */
export async function resolveInstrument(
  input: ResolveInstrumentInput,
  reader: InstrumentReader = defaultInstrumentReader,
): Promise<ResolveInstrumentResult> {
  const symbol = normalizeResolveSymbol(input.symbol);
  if (symbol === "") return { status: "NOT_FOUND" };

  const liveOnly = input.includeInactive !== true;

  // A venue hint names its own market. An unknown venue names none, and that is
  // NOT_FOUND rather than "search everywhere".
  let venue: string | undefined;
  let venueMarket: InstrumentMarket | null = null;
  if (input.exchange !== undefined && input.exchange !== null) {
    venueMarket = marketForExchange(input.exchange);
    if (venueMarket === null) return { status: "NOT_FOUND" };
    venue = input.exchange.trim().toUpperCase();
  }

  // An explicit market that disagrees with the venue is a contradiction, not a
  // preference to reconcile. Answering it from either side would silently
  // ignore half of what the caller said.
  if (
    input.market !== undefined &&
    venueMarket !== null &&
    input.market !== venueMarket
  ) {
    return { status: "NOT_FOUND" };
  }

  const wanted: InstrumentMarket | null = input.market ?? venueMarket;
  const wantIndia = wanted === null || wanted === "IN";
  const wantUs = wanted === null || wanted === "US";

  const [india, us] = await Promise.all([
    wantIndia
      ? reader.readIndia({
          symbol,
          // Scoped by EXCHANGE and not by `market`, for the reason already
          // written on `INDIA_DISCOVER_EXCHANGES`: `market` is ABSENT on every
          // pre-existing India row, so `{market: "IN"}` matches zero. Exchange
          // is populated on every row that has ever existed. The clause is a
          // market GUARD — `instrument_mappings` is India-only by construction
          // now, and this keeps a stray US row left over from the pre-split
          // state from leaking into an India answer.
          exchanges:
            venueMarket === "IN" && venue !== undefined
              ? [venue]
              : SUPPORTED_EXCHANGES,
          liveOnly,
        })
      : Promise.resolve<IndiaInstrumentRow[]>([]),
    wantUs
      ? reader.readUs({
          symbol,
          exchange: venueMarket === "US" ? venue : undefined,
          liveOnly,
        })
      : Promise.resolve<UsInstrumentRow[]>([]),
  ]);

  return decideResolution({ india, us });
}
