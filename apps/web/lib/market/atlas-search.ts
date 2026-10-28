/**
 * Atlas Search utilities for MongoDB Atlas full-text search.
 *
 * Uses $search aggregation stage via Prisma $runCommandRaw.
 * Requires Atlas Search indexes created in the Atlas UI:
 *   - "instrument_search" on instrument_mappings collection
 *   - "mf_search" on mutual_fund_masters collection
 *
 * Falls back gracefully when indexes are unavailable (e.g. DigitalOcean dev DB).
 * See /docs/setup/atlas-search-setup.md for index definitions.
 *
 * MONEY-1128: the availability decision, the 5-minute latch and the error
 * classifier are NO LONGER local to this file — they live in
 * `@usemoney/core/search/atlas-gate`, shared with content-search.ts,
 * apps/content's user search and packages/services' discover service. See that
 * module for why a timeout must not latch and how transitions are reported.
 */

import { prisma, Prisma } from "@usemoney/database";
import {
  SEARCH_INDEX,
  isAtlasSearchEnabled,
  reportSearchFailure,
} from "@usemoney/core/search/atlas-gate";

/** Subsystem tags for gate logs/metrics. */
const SUBSYSTEM = {
  INSTRUMENTS: "web.market.instruments",
  MUTUAL_FUNDS: "web.market.mutual-funds",
  AUTOCOMPLETE: "web.market.autocomplete",
} as const;

// ============== TYPES ==============

export interface AtlasInstrumentResult {
  _id: { $oid: string };
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  instrumentType: string;
  sector?: string | null;
  score: number;
}

export interface AtlasMfResult {
  _id: { $oid: string };
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string;
  nav: number;
  score: number;
}

interface RawCommandResult {
  cursor?: {
    firstBatch?: Record<string, unknown>[];
  };
  ok?: number;
}

// ============== INSTRUMENT SEARCH ==============

export interface InstrumentSearchOptions {
  types?: string[];
  /** A single venue. Kept for callers that pin one exchange. */
  exchange?: string;
  /**
   * Venue ALLOW-LIST — MONEY-1263.
   *
   * The ORIGINAL reason is dead and the filter is not: `instrument_mappings`
   * was briefly shared with the US master, so an unfiltered search returned US
   * securities to an Indian user. US listings now live in `us_instruments`, and
   * this index does not cover them at all.
   *
   * It stays because it independently excludes what that table DOES still hold
   * beyond cash equities: Kite's dump writes NFO / BFO / MCX rows, so an
   * unscoped search puts F&O and commodity contracts on a cash-equity surface.
   * It is also the guard that makes a future re-sharing a non-event. Unlike the
   * `exchange` singular above, this expresses "any of these", which is what
   * every India surface actually wants.
   *
   * This risk is PROD-ONLY and therefore invisible in QA: QA has no Atlas
   * Search index and falls back to the regex path, which already scopes to
   * NSE/BSE. Testing the feature in QA would show nothing wrong.
   */
  exchanges?: string[];
  limit?: number;
  fuzzy?: boolean;
}

/**
 * Build the `$search` pipeline for instrument search. Pure (no I/O) so the
 * operator/field pairing can be unit-tested — see the `exchange` note below.
 */
export function buildInstrumentSearchPipeline(
  query: string,
  options: InstrumentSearchOptions = {}
): Record<string, unknown>[] {
  const { types, exchange, exchanges, limit = 15, fuzzy = true } = options;

  // Use should with multiple match strategies for best results:
  // 1. Autocomplete prefix match (handles "reli" → "RELIANCE") - requires autocomplete index type
  // 2. Fuzzy text match (handles typos like "relianse")
  // 3. Sector search (handles "IT" → IT sector stocks)
  const mustClause: Record<string, unknown>[] = [
    {
      compound: {
        should: [
          {
            autocomplete: {
              query,
              path: "symbol",
              fuzzy: { maxEdits: 1, prefixLength: 1 },
            },
          },
          {
            autocomplete: {
              query,
              path: "name",
              fuzzy: { maxEdits: 1, prefixLength: 2 },
            },
          },
          {
            text: {
              query,
              path: ["symbol", "name"],
              ...(fuzzy ? { fuzzy: { maxEdits: 1, prefixLength: 2 } } : {}),
            },
          },
          {
            text: {
              query,
              path: "sector",
            },
          },
          // MONEY-1177 — former tickers, so ZOMATO still finds ETERNAL on the
          // Atlas path too (the regex fallback already handles it).
          //
          // SAFE TO SHIP AHEAD OF THE INDEX: this sits inside a `should` with
          // minimumShouldMatch: 1, and Atlas Search does not error on a path
          // the index does not map — the clause simply matches nothing until
          // `previousSymbols` is added to the INSTRUMENTS index definition,
          // then starts working with no code change. That definition is
          // managed in the Atlas UI, not in this repo; see scripts/README.md.
          {
            text: {
              query,
              path: "previousSymbols",
            },
          },
        ],
        minimumShouldMatch: 1,
      },
    },
  ];

  const filterClauses: Record<string, unknown>[] = [
    { equals: { path: "isActive", value: true } },
  ];

  if (types && types.length > 0) {
    filterClauses.push({
      in: { path: "instrumentType", value: types },
    });
  }

  // The allow-list form, checked FIRST so a caller passing both gets the
  // narrower single-exchange pin below rather than silently widening.
  if (exchanges && exchanges.length > 0) {
    // `in` on a token-mapped field — the same operator/field pairing the
    // `instrumentType` filter above uses. `text` cannot match a token field
    // (MONEY-1128), and the failure is silent: the filter matches nothing and
    // the caller receives zero rows.
    filterClauses.push({
      in: {
        path: "exchange",
        value: exchanges.map((e) => e.toUpperCase()),
      },
    });
  }

  if (exchange) {
    // MONEY-1128: this used to be `text: { query: exchange, path: "exchange" }`.
    // `exchange` is mapped `type: "token"` in the instrument_search index
    // (docs/setup/atlas-search-setup.md), and the `text` operator cannot match
    // a token-mapped field — it needs an analyzed `string` mapping. So the
    // filter matched NOTHING and any caller that passed `exchange` would have
    // silently received zero rows. `equals` is the operator token fields take
    // (same family as the `in` used for `instrumentType` just above).
    //
    // Values are stored uppercase ("NSE"/"BSE") and token matching is exact,
    // so normalise rather than trust the caller's casing.
    filterClauses.push({
      equals: { path: "exchange", value: exchange.toUpperCase() },
    });
  }

  return [
    {
      $search: {
        index: SEARCH_INDEX.INSTRUMENTS,
        compound: {
          must: mustClause,
          filter: filterClauses,
        },
      },
    },
    { $limit: limit },
    {
      $project: {
        symbol: 1,
        name: 1,
        exchange: 1,
        yahooSymbol: 1,
        instrumentType: 1,
        sector: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];
}

/**
 * Search instruments using Atlas Search with fuzzy matching and relevance scoring.
 * Returns null if Atlas Search is unavailable (index not found / non-Atlas DB /
 * a transient failure on this request), signalling the caller to fall back.
 */
export async function searchInstrumentsAtlas(
  query: string,
  options: InstrumentSearchOptions = {}
): Promise<AtlasInstrumentResult[] | null> {
  if (!isAtlasSearchEnabled(SEARCH_INDEX.INSTRUMENTS, SUBSYSTEM.INSTRUMENTS)) {
    return null;
  }

  const pipeline = buildInstrumentSearchPipeline(query, options);

  try {
    const result = (await prisma.$runCommandRaw({
      aggregate: "instrument_mappings",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawCommandResult;

    const docs = result?.cursor?.firstBatch ?? [];
    return docs as unknown as AtlasInstrumentResult[];
  } catch (error) {
    const action = reportSearchFailure({
      index: SEARCH_INDEX.INSTRUMENTS,
      subsystem: SUBSYSTEM.INSTRUMENTS,
      error,
    });
    if (action === "fallback") return null;
    throw error;
  }
}

// ============== MUTUAL FUND SEARCH ==============

export interface MfSearchOptions {
  limit?: number;
  fuzzy?: boolean;
}

/** Build the `$search` pipeline for mutual-fund search. Pure (no I/O). */
export function buildMfSearchPipeline(
  query: string,
  options: MfSearchOptions = {}
): Record<string, unknown>[] {
  const { limit = 10, fuzzy = true } = options;

  return [
    {
      $search: {
        index: SEARCH_INDEX.MUTUAL_FUNDS,
        compound: {
          must: [
            {
              compound: {
                should: [
                  // Autocomplete on scheme name (prefix: "hdfc fle" → "HDFC Flexi Cap Fund")
                  {
                    autocomplete: {
                      query,
                      path: "schemeName",
                      fuzzy: { maxEdits: 1, prefixLength: 2 },
                    },
                  },
                  // Autocomplete on AMC name (prefix: "hdfc" → "HDFC AMC")
                  {
                    autocomplete: {
                      query,
                      path: "amcName",
                      fuzzy: { maxEdits: 1, prefixLength: 2 },
                    },
                  },
                  // Full-text on scheme name, AMC, scheme code, category
                  {
                    text: {
                      query,
                      path: ["schemeName", "amcName", "schemeCode", "category"],
                      ...(fuzzy
                        ? { fuzzy: { maxEdits: 1, prefixLength: 2 } }
                        : {}),
                    },
                  },
                ],
                minimumShouldMatch: 1,
              },
            },
          ],
          filter: [{ equals: { path: "isActive", value: true } }],
        },
      },
    },
    { $limit: limit },
    {
      $project: {
        schemeCode: 1,
        schemeName: 1,
        amcName: 1,
        category: 1,
        nav: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];
}

/**
 * Search mutual funds using Atlas Search.
 * Returns null if Atlas Search is unavailable.
 */
export async function searchMutualFundsAtlas(
  query: string,
  options: MfSearchOptions = {}
): Promise<AtlasMfResult[] | null> {
  if (
    !isAtlasSearchEnabled(SEARCH_INDEX.MUTUAL_FUNDS, SUBSYSTEM.MUTUAL_FUNDS)
  ) {
    return null;
  }

  const pipeline = buildMfSearchPipeline(query, options);

  try {
    const result = (await prisma.$runCommandRaw({
      aggregate: "mutual_fund_masters",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawCommandResult;

    const docs = result?.cursor?.firstBatch ?? [];
    return docs as unknown as AtlasMfResult[];
  } catch (error) {
    const action = reportSearchFailure({
      index: SEARCH_INDEX.MUTUAL_FUNDS,
      subsystem: SUBSYSTEM.MUTUAL_FUNDS,
      error,
    });
    if (action === "fallback") return null;
    throw error;
  }
}

// ============== AUTOCOMPLETE ==============

export interface AutocompleteOptions {
  limit?: number;
  types?: string[];
}

/** Build the `$search` pipeline for instrument autocomplete. Pure (no I/O). */
export function buildAutocompletePipeline(
  query: string,
  options: AutocompleteOptions = {}
): Record<string, unknown>[] {
  const { limit = 8, types } = options;

  const filterClauses: Record<string, unknown>[] = [
    { equals: { path: "isActive", value: true } },
  ];

  if (types && types.length > 0) {
    filterClauses.push({
      in: { path: "instrumentType", value: types },
    });
  }

  return [
    {
      $search: {
        index: SEARCH_INDEX.INSTRUMENTS,
        compound: {
          should: [
            {
              autocomplete: {
                query,
                path: "symbol",
                tokenOrder: "sequential",
              },
            },
            {
              autocomplete: {
                query,
                path: "name",
                tokenOrder: "sequential",
              },
            },
            // MONEY-1205 — the two `autocomplete` legs above are edge-gram
            // PHRASE matches (`tokenOrder: "sequential"`), and measured against
            // prod they die at four tokens: "SBI NIFTY 200" → 1 hit,
            // "SBI NIFTY 200 QUALITY" → 0; "Reliance Industries Limited" → 1,
            // "Tata Consultancy Services Limited" → 0 — for names that are in
            // the collection verbatim. Consistently 3 tokens fine, 4 dead, so
            // EVERY `PfSymbolPicker` and both news-alert drawers returned an
            // empty dropdown for anyone who pasted or typed a full company
            // name, and the route could not tell (it only fell back to Prisma
            // on a null, i.e. Atlas being unavailable, never on an empty hit
            // list — see ../../app/api/market/autocomplete/route.ts).
            //
            // The same shape `buildInstrumentSearchPipeline` uses: `text` is a
            // per-token OR under the enclosing `minimumShouldMatch: 1`, so a
            // long query degrades to "the rows sharing the most tokens, best
            // first" instead of nothing at all. It cannot make a SHORT query
            // noisier — an analyzed token match will not turn "rel" into
            // RELIANCE (that is exactly what the edge-gram legs are for), so
            // for prefix typing this leg contributes no rows.
            {
              text: {
                query,
                path: ["symbol", "name"],
                fuzzy: { maxEdits: 1, prefixLength: 2 },
              },
            },
          ],
          minimumShouldMatch: 1,
          filter: filterClauses,
        },
      },
    },
    { $limit: limit },
    {
      $project: {
        symbol: 1,
        name: 1,
        exchange: 1,
        instrumentType: 1,
        _id: 0,
      },
    },
  ];
}

/**
 * Autocomplete search using Atlas Search edgeGram tokenization.
 * Returns null if Atlas Search is unavailable.
 */
export async function autocompleteInstruments(
  query: string,
  options: AutocompleteOptions = {}
): Promise<Array<{
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}> | null> {
  if (!isAtlasSearchEnabled(SEARCH_INDEX.INSTRUMENTS, SUBSYSTEM.AUTOCOMPLETE)) {
    return null;
  }

  const pipeline = buildAutocompletePipeline(query, options);

  try {
    const result = (await prisma.$runCommandRaw({
      aggregate: "instrument_mappings",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawCommandResult;

    const docs = (result?.cursor?.firstBatch ?? []) as Array<{
      symbol: string;
      name: string;
      exchange: string;
      instrumentType: string;
    }>;

    return docs.map((d) => ({
      symbol: d.symbol,
      name: d.name,
      type: d.instrumentType,
      exchange: d.exchange,
    }));
  } catch (error) {
    const action = reportSearchFailure({
      index: SEARCH_INDEX.INSTRUMENTS,
      subsystem: SUBSYSTEM.AUTOCOMPLETE,
      error,
    });
    if (action === "fallback") return null;
    throw error;
  }
}
