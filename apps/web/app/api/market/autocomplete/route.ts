/**
 * Market Autocomplete API
 *
 * GET /api/market/autocomplete?q=rel&limit=5
 *
 * Fast autocomplete using Atlas Search edgeGram tokenization.
 * Returns lightweight results: { symbol, name, type, exchange }
 * Designed for as-you-type suggestions (< 50ms on Atlas).
 *
 * Falls back to Prisma contains search when Atlas Search is unavailable.
 *
 * ## INDIA ONLY — a deliberate decision, not an oversight (MONEY-980)
 *
 * `/api/market/search` gained a US leg over `us_instruments`. This route
 * deliberately did NOT, for three reasons that are about its CONSUMERS rather
 * than about the data:
 *
 *   1. Every caller writes the chosen symbol into a record that only
 *      India-facing machinery can resolve — `SymbolPicker` in the news alert
 *      and feed drawers (`app/discover/news/*`), `AddTradeDialog`'s manual
 *      trade entry, and `ComparePicker`. All of them resolve the symbol back
 *      through `instrument_mappings`, so a US ticker stored there is a row
 *      that silently matches nothing later — or, for `INFY` (an NSE symbol AND
 *      a NYSE ADR ticker), matches the WRONG thing.
 *   2. The payload is four fields — `{ symbol, name, type, exchange }` — with
 *      no room for `listingStatus`. A delisted US listing would appear in a
 *      picker indistinguishable from a live one, in a UI whose entire job is
 *      "choose a thing to keep tracking". Widening the payload is the real
 *      work, and it belongs with the surface that needs it.
 *   3. `us_instruments` has no `isActive`, so the `equals: { path: "isActive" }`
 *      filter this route's pipeline always applies has no counterpart there —
 *      the two collections do not share an index or a filter shape.
 *
 * Nothing else is needed to keep it India-only: it queries
 * `instrument_mappings`, which holds no US rows since they moved to their own
 * collection. Revisit when a US-aware picker exists to consume the extra
 * fields, not before.
 *
 * ## The same reasoning now governs `/api/market/search` (MONEY-980 review)
 *
 * Reasons 1 and 2 above were TRUE OF THE OTHER ROUTE TOO, and were not applied
 * there. `InstrumentSearch` — which feeds `AddTradeDialog`,
 * `AddMutualFundDialog` and the watchlist — and `CommandPalette` both call
 * `/api/market/search`, not this route. So the careful India-only argument
 * protected the endpoint the pickers do not use while US rows flowed into the
 * one they do.
 *
 * `/api/market/search` therefore now requires an explicit `includeUs=true`
 * (`parseIncludeUs`, default OFF) on top of the PostHog flag, and no shipped
 * surface sends it. This route needs no such parameter: its query cannot
 * produce a US row in the first place, which is a stronger guarantee than a
 * default.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiLogger as logger } from "@usemoney/logger";
import { getCached, setCached } from "@usemoney/core";
import { autocompleteInstruments } from "@/lib/market/atlas-search";
import { searchInstruments } from "@/lib/market/symbol-mapper";
import {
  parseQuery,
  parseLimit,
  parseTypes,
  isQueryEmpty,
  formatEmptyResponse,
  formatAtlasResponse,
  formatContainsResponse,
  formatErrorResponse,
  mapContainsResults,
  shouldFallbackToContains,
  type AutocompleteResponse,
} from "./autocomplete-logic";

export const dynamic = "force-dynamic";

/**
 * MONEY-1123: this route is hit on EVERY 180ms-debounced keystroke of the news
 * SymbolPicker and used to reach Atlas/Prisma every time. Results are purely a
 * function of (query, limit, types) — the payload carries no user-scoped data
 * (`{ success, results:[{symbol,name,type,exchange}], count, source }`) — so a
 * single `_global` entry is shared by all users. Mirrors the identical
 * `"market" / "_global"` caching in `../search/route.ts` (5 min default TTL).
 *
 * NOTE: deliberately NO `Cache-Control: public` header. This route is
 * auth-gated (`auth()` below), and a shared-cache directive on an
 * authenticated response risks the CDN serving one user's response to another.
 * The Redis/memory layer captures the win with none of that risk.
 */
const CACHE_MODULE = "market" as const;
const CACHE_SCOPE = "_global";
const CACHE_KIND = "autocomplete";

/**
 * Redis only — deliberately NOT the L1 memory tier.
 *
 * The key space here is user-controlled and unbounded (any authenticated caller
 * can type anything), while L1 is a single 1000-entry LRU shared by every module
 * and every user in the process. Letting autocomplete populate it means a burst
 * of typing evicts other users' cached dashboard / holdings / positions entries
 * — a self-inflicted cache flush costing far more than the lookup it saves.
 * Redis is bounded by its own eviction policy and has no such coupling.
 */
const AUTOCOMPLETE_CACHE_CONFIG = {
  ttl: 5 * 60,
  enableMemory: false,
  enableRedis: true,
} as const;

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(formatErrorResponse("Authentication required"), {
        status: 401,
      });
    }

    const searchParams = request.nextUrl.searchParams;
    const query = parseQuery(searchParams.get("q"));
    const limit = parseLimit(searchParams.get("limit"));
    const types = parseTypes(searchParams.get("types"));

    if (isQueryEmpty(query)) {
      return NextResponse.json(formatEmptyResponse());
    }

    // MONEY-1205 — the key uppercases, so the QUERY must uppercase too.
    //
    // The claim this comment used to make ("both backends are case-insensitive,
    // so `rel` and `REL` share one entry safely") is false for Atlas. In the
    // `instrument_search` index `symbol` is mapped BOTH as an edgeGram
    // autocomplete field AND as a `string` with `lucene.keyword`
    // (docs/setup/atlas-search-setup.md) — and `lucene.keyword` emits the whole
    // field as one unmodified token, so it only matches an exactly-cased
    // symbol. Measured on prod: "sbin" ranked SBIN 5th behind SBINMID150 /
    // SBINEQWETF, "SBIN" ranked it 1st; "tcs" vs "TCS" likewise reorder. So
    // the two casings did NOT return the same rows and the shared cache entry
    // was a first-writer-wins collision.
    //
    // `searchInstruments` (the Prisma fallback) genuinely is case-insensitive —
    // it uppercases the symbol itself and uses `mode: "insensitive"` on the
    // name — so it keeps the raw query, which `withFormerlyHint` also needs.
    // Same normalisation as ../search/route.ts.
    const upperQuery = query.toUpperCase();
    const cacheFilters = {
      query: upperQuery,
      limit,
      types: types?.join(",") ?? "",
    };

    // Same config as the write below — the read must consult the same tiers, or
    // it would look in an L1 the writer never populates.
    const cached = await getCached<AutocompleteResponse>(
      CACHE_MODULE,
      CACHE_SCOPE,
      CACHE_KIND,
      cacheFilters,
      AUTOCOMPLETE_CACHE_CONFIG
    );
    if (cached) {
      return NextResponse.json(cached);
    }

    // Try Atlas Search autocomplete first (upper-cased — see cacheFilters above)
    const atlasResults = await autocompleteInstruments(upperQuery, {
      limit,
      types,
    });

    // MONEY-1205: fall back on an EMPTY Atlas result as well as on `null`.
    // `null` = Atlas unavailable, `[]` = Atlas had no answer; both are reasons
    // to ask Prisma, and only the first used to be handled — which is why a
    // 4+-token query returned an empty dropdown platform-wide. `?? []` is
    // unreachable: a false `shouldFallbackToContains` implies non-null.
    const payload: AutocompleteResponse = shouldFallbackToContains(atlasResults)
      ? formatContainsResponse(
          mapContainsResults(await searchInstruments(query, { limit }), query)
        )
      : formatAtlasResponse(atlasResults ?? []);

    // Redis only, and only for queries that actually matched something.
    //
    // The key space here is user-controlled and unbounded (any authenticated
    // caller can type anything), while the L1 memory cache is a single
    // 1000-entry LRU shared by every module and every user in the process. Let
    // autocomplete populate it and a burst of typing evicts other users' cached
    // dashboard / holdings / positions entries — a self-inflicted cache flush
    // that costs far more than the lookup it saves. Redis is bounded by its own
    // eviction policy and has no such cross-tenant coupling.
    //
    // Skipping empty results keeps a walk through nonsense strings from minting
    // an entry per keystroke; a genuinely empty query is cheap to re-answer.
    if (payload.results.length > 0) {
      await setCached(
        CACHE_MODULE,
        CACHE_SCOPE,
        CACHE_KIND,
        payload,
        cacheFilters,
        AUTOCOMPLETE_CACHE_CONFIG
      );
    }

    return NextResponse.json(payload);
  } catch (error) {
    logger.error({ error }, "Autocomplete API error");
    return NextResponse.json(formatErrorResponse("Failed to autocomplete"), {
      status: 500,
    });
  }
}
