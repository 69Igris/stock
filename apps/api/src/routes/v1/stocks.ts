/**
 * Stock Detail Routes (MONEY-1062 P4a — mobile parity)
 *
 * Thin Hono handlers over the @usemoney/services stock-tabs surface: the
 * stock-detail tabs the web renders (Financials / Peers / News / Returns /
 * Shareholding / Ratios / Technicals) plus Corporate Actions. Gives a mobile
 * client the SAME global stock-detail data the web page fetches per-tab.
 *
 * SCOPING: this is GLOBAL market/reference data — every endpoint requires a
 * Bearer token (the /v1 auth middleware) but passes NO userId to the services
 * (mirrors market.ts / discover.ts). The data is not per-user.
 *
 * SEMANTICS (faithful to apps/web/lib/actions/stock-tabs.ts — the source of
 * truth): a missing instrument / DB row is NOT a 404 — the services return
 * `success:true` with empty (`[]` / `{}` / `{ shareholding: [] }`) or `null`
 * data, and this route passes that through as 200 so the client renders its own
 * empty state (exactly like the web tab). A genuine service failure → 500.
 *
 * CORPORATE ACTIONS reuses the EXISTING corporate-actions.service
 * (getCorporateActions) — NOT a port of the stock-tabs corporate-actions action
 * (which live-scrapes NSE). That service is DB-first, orders ex-date ASC, and
 * uppercases the symbol internally.
 *
 * BOUNDING: `:symbol` is a bounded string, `?exchange=` is NSE|BSE (default
 * NSE), `?periodType=` is ANNUAL|QUARTERLY, `?limit=` (news) is an int the
 * service clamps to [1, 50]. Bad params → 400 BEFORE any service call.
 *
 * Source actions (read-only): apps/web/lib/actions/stock-tabs.ts
 *   :112 financials · :184 peers · :239 news · :293 returns · :363 shareholding
 *   :458 ratios · :581 technicals. Corporate actions:
 *   packages/services/src/corporate-actions.service.ts:367 getCorporateActions.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes, zodParse } from "../../lib/response";
import {
  getStockFinancials,
  getStockPeers,
  getStockTabNews,
  getStockReturns,
  getShareholding,
  getStockRatios,
  getStockTechnicals,
  getCorporateActions,
  // MONEY-1204 / P14 — data-engine sections. All mounted through
  // `mountStockSection` below; each returns the shared `withProvenance`
  // envelope so the web action and this route cannot describe the same data
  // differently.
  getStockFlagsAndIndexes,
  getStockDeliveryTrend,
  getStockDerivatives,
  getStockShareholdingSection,
  getStockOwnershipBreakdownSection,
  getStockInsiderSection,
  getStockDealsSection,
  getStockFilingsTimeline,
  getStockFinancialsSource,
  getStockFundsHolding,
  // MONEY-1204 / P14 (14d.5) — the symbol-scoped circulars strip. Lives on
  // /v1/stocks rather than /v1/discover; see the handler below for why.
  getCircularsForSymbol,
} from "@usemoney/services";

const stocksRoutes = new Hono<AppContext>();

// ── Input bounds ─────────────────────────────────────────────────────────────
const MAX_SYMBOL_LEN = 24;
// MONEY-1204 (14d.5) — bounds for the symbol-scoped circulars strip below.
const MAX_DEPARTMENT_LEN = 64;
const MAX_SYMBOL_DEPARTMENTS = 12;

// A bounded stock symbol (e.g. RELIANCE, TCS, M&M). Trimmed; the web actions
// query the symbol VERBATIM (no uppercasing), so the caller passes the canonical
// symbol exactly as the web stock-detail route param does. getCorporateActions is
// the one exception — it uppercases the symbol itself.
const SymbolSchema = z.string().trim().min(1).max(MAX_SYMBOL_LEN);

// `?exchange=` → NSE|BSE, default NSE. The web actions take a free-form required
// `exchange`, but only NSE/BSE stock-detail data exists; bounding it here keeps a
// mobile client from probing arbitrary exchanges (matches market.ts's NSE/BSE
// duality). Default NSE mirrors market.ts#resolveExchange.
const ExchangeSchema = z.enum(["NSE", "BSE"]).default("NSE");

// Optional on purpose — the DEFAULT lives in one place, `getStockFinancials`
// in packages/services, so web and mobile cannot drift. That default moved
// QUARTERLY -> ANNUAL in MONEY-1207: QUARTERLY has 0 rows platform-wide (the
// quarterly fetcher mapped five keys Tickertape does not send), so every
// unqualified mobile request was answered with an empty payload.
const PeriodTypeSchema = z.enum(["ANNUAL", "QUARTERLY"]).optional();

// News limit: optional int. The service clamps to [1, 50] (stock-tabs.ts:244),
// so we only reject a non-integer here (e.g. `?limit=abc` / `1.5`), never clamp.
const NewsLimitSchema = z.coerce.number().int().optional();

const SymbolExchangeSchema = z.object({
  symbol: SymbolSchema,
  exchange: ExchangeSchema,
});

/**
 * Mount a `(symbol, exchange)` stock section — MONEY-1204 (P14 / 14c.0).
 *
 * Lane 14c adds nine sections that are byte-for-byte identical at this layer:
 * parse `(symbol, exchange)`, 400 on bad input BEFORE touching a service, call
 * the service, 500 on a service failure, 200 with `success(data)` otherwise. The
 * handlers above are written out longhand because they predate the pattern and
 * each has a hand-written message; nine more copies would be nine more chances
 * to drop the `parsed.ok` guard or leak a raw error string.
 *
 * Deliberately NOT applied retroactively to the eight existing routes: their
 * shapes differ in small ways (the corporate-actions one re-wraps the payload,
 * financials and news take extra query params) and rewriting working, tested
 * routes to fit a helper is how a refactor turns into a regression. New sections
 * use this; old ones stay as they are.
 *
 * The service must return `ServiceResult<T>`. Empty is NOT an error here — the
 * house contract is that a missing row yields `success: true` with an empty
 * payload and the client renders its own empty state, so this never 404s.
 */
function mountStockSection<T>(
  path: string,
  label: string,
  service: (args: {
    symbol: string;
    exchange: "NSE" | "BSE";
  }) => Promise<
    | { success: true; data: T; message?: string }
    | { success: false; error: string }
  >,
): void {
  stocksRoutes.get(path, async (c) => {
    try {
      const parsed = zodParse(SymbolExchangeSchema, {
        symbol: c.req.param("symbol"),
        exchange: c.req.query("exchange") ?? undefined,
      });
      if (!parsed.ok) {
        return c.json(
          error(
            ErrorCodes.VALIDATION_ERROR,
            `Invalid ${label} query`,
            parsed.issues,
          ),
          400,
        );
      }
      const result = await service(parsed.data);
      if (!result.success) {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(success(result.data));
    } catch (err) {
      // The caught error is logged, never returned: a raw DB message is exactly
      // the kind of internal detail the sanitisation rule exists to keep out of
      // a response body.
      console.error(`Stock ${label} error:`, err);
      return c.json(
        error(ErrorCodes.INTERNAL_ERROR, `Failed to load ${label}`),
        500,
      );
    }
  });
}

/**
 * GET /v1/stocks/:symbol/financials?exchange=&periodType=
 * Quarterly/annual income + balance + cashflow (split by statement). Global.
 */
stocksRoutes.get("/:symbol/financials", async (c) => {
  try {
    const parsed = zodParse(
      SymbolExchangeSchema.extend({ periodType: PeriodTypeSchema }),
      {
        symbol: c.req.param("symbol"),
        exchange: c.req.query("exchange") ?? undefined,
        periodType: c.req.query("periodType") ?? undefined,
      },
    );
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid financials query",
          parsed.issues,
        ),
        400,
      );
    }
    const { symbol, exchange, periodType } = parsed.data;
    const result = await getStockFinancials({ symbol, exchange, periodType });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock financials error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load financials"),
      500,
    );
  }
});

/**
 * GET /v1/stocks/:symbol/peers?exchange=
 * Sector peers (defensively coerced, capped at 12). Global.
 *
 * WIRE UNIT: `marketCap` is in CRORES, passed through un-scaled from
 * `StockRatios.marketCap`. It is NOT the rupees unit that `LatestQuote.marketCap`
 * (and therefore `/v1/stocks/:symbol/quote`) uses — the two differ by 1e7 and
 * carry the same field name, so a mobile client that reuses its quote formatter
 * here renders every peer as "₹0 Cr". That is exactly what the web peers table
 * did until MONEY-1255. `pe` is a multiple and `roe` is a PERCENT.
 */
stocksRoutes.get("/:symbol/peers", async (c) => {
  try {
    const parsed = zodParse(SymbolExchangeSchema, {
      symbol: c.req.param("symbol"),
      exchange: c.req.query("exchange") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid peers query",
          parsed.issues,
        ),
        400,
      );
    }
    const { symbol, exchange } = parsed.data;
    const result = await getStockPeers({ symbol, exchange });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock peers error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load peers"),
      500,
    );
  }
});

/**
 * GET /v1/stocks/:symbol/news?limit=
 * Per-symbol news (read-only, sentiment-tagged). No `?exchange=` — the web
 * action keys news by symbol only. `?limit=` is clamped to [1, 50] by the
 * service. Global.
 */
stocksRoutes.get("/:symbol/news", async (c) => {
  try {
    const parsed = zodParse(
      z.object({ symbol: SymbolSchema, limit: NewsLimitSchema }),
      {
        symbol: c.req.param("symbol"),
        limit: c.req.query("limit") || undefined,
      },
    );
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid news query", parsed.issues),
        400,
      );
    }
    const { symbol, limit } = parsed.data;
    const result = await getStockTabNews({ symbol, limit });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock news error:", err);
    return c.json(error(ErrorCodes.INTERNAL_ERROR, "Failed to load news"), 500);
  }
});

/**
 * GET /v1/stocks/:symbol/returns?exchange=
 * 1D/1W/1M/3M/6M/1Y/3Y/5Y % returns from DailyPrice deltas. Global.
 */
stocksRoutes.get("/:symbol/returns", async (c) => {
  try {
    const parsed = zodParse(SymbolExchangeSchema, {
      symbol: c.req.param("symbol"),
      exchange: c.req.query("exchange") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid returns query",
          parsed.issues,
        ),
        400,
      );
    }
    const { symbol, exchange } = parsed.data;
    const result = await getStockReturns({ symbol, exchange });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock returns error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to compute returns"),
      500,
    );
  }
});

/**
 * GET /v1/stocks/:symbol/shareholding?exchange=
 * Quarterly promoter/FII/DII/public pattern (live Tickertape→Screener chain,
 * cached). Global. NOTE: the service swallows fetch errors → empty + success.
 */
stocksRoutes.get("/:symbol/shareholding", async (c) => {
  try {
    const parsed = zodParse(SymbolExchangeSchema, {
      symbol: c.req.param("symbol"),
      exchange: c.req.query("exchange") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid shareholding query",
          parsed.issues,
        ),
        400,
      );
    }
    const { symbol, exchange } = parsed.data;
    const result = await getShareholding({ symbol, exchange });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock shareholding error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load shareholding"),
      500,
    );
  }
});

/**
 * GET /v1/stocks/:symbol/ratios?exchange=
 * Fundamental ratios snapshot (StockRatios row, 1:1 with the instrument).
 * `data:null` (200) when no row — matches the web card's empty state. Global.
 */
stocksRoutes.get("/:symbol/ratios", async (c) => {
  try {
    const parsed = zodParse(SymbolExchangeSchema, {
      symbol: c.req.param("symbol"),
      exchange: c.req.query("exchange") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid ratios query",
          parsed.issues,
        ),
        400,
      );
    }
    const { symbol, exchange } = parsed.data;
    const result = await getStockRatios({ symbol, exchange });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock ratios error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load fundamentals"),
      500,
    );
  }
});

/**
 * GET /v1/stocks/:symbol/technicals?exchange=
 * Computed technical snapshot (RSI/SMA/MACD/52w/crosses) over DailyPrice.
 * `data:null` (200) when there isn't enough history. Global.
 */
stocksRoutes.get("/:symbol/technicals", async (c) => {
  try {
    const parsed = zodParse(SymbolExchangeSchema, {
      symbol: c.req.param("symbol"),
      exchange: c.req.query("exchange") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid technicals query",
          parsed.issues,
        ),
        400,
      );
    }
    const { symbol, exchange } = parsed.data;
    const result = await getStockTechnicals({ symbol, exchange });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock technicals error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to compute technicals"),
      500,
    );
  }
});

/**
 * GET /v1/stocks/:symbol/corporate-actions?exchange=
 * Persisted corporate actions (dividends/splits/bonuses/rights), ex-date ASC,
 * via the EXISTING corporate-actions.service#getCorporateActions (DB-first;
 * uppercases the symbol itself). Wrapped as `{ actions }` to match the web
 * corporate-actions shape. Empty array (200) when none. Global.
 */
stocksRoutes.get("/:symbol/corporate-actions", async (c) => {
  try {
    const parsed = zodParse(SymbolExchangeSchema, {
      symbol: c.req.param("symbol"),
      exchange: c.req.query("exchange") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid corporate-actions query",
          parsed.issues,
        ),
        400,
      );
    }
    const { symbol, exchange } = parsed.data;
    const result = await getCorporateActions({ symbol, exchange });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success({ actions: result.data }));
  } catch (err) {
    console.error("Stock corporate-actions error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load corporate actions"),
      500,
    );
  }
});

// ── MONEY-1204 / P14 data-engine sections ───────────────────────────────────
//
// Six new sections, all identical at this layer, so they go through the helper
// rather than six longhand copies of the same parse/guard/call/500 shape.
//
// `/:symbol/shareholding-pattern` and NOT `/:symbol/shareholding`: the latter is
// already taken by the legacy Tickertape-backed handler above. The two read
// DIFFERENT tables whose `quarter` strings do not even join
// (`shareholding_patterns` uses a canonical YYYY-MM of quarter END;
// `stock_shareholding` uses free-form "Q3-2024"), so they are genuinely two
// endpoints, not one endpoint with a flag.
mountStockSection("/:symbol/flags", "exchange flags", getStockFlagsAndIndexes);
mountStockSection("/:symbol/delivery", "delivery", getStockDeliveryTrend);
mountStockSection("/:symbol/derivatives", "derivatives", getStockDerivatives);
mountStockSection(
  "/:symbol/shareholding-pattern",
  "shareholding pattern",
  getStockShareholdingSection,
);
// MONEY-1255 — the institutional split from `shareholding_breakdown`, which is
// a DIFFERENT table from the one above and carries columns it does not have
// (mutual funds, insurance, banks, government, retail). Mounted separately for
// the same reason `shareholding-pattern` is separate from the legacy
// `shareholding`: two tables, two fetch cadences, two provenance stories — not
// one endpoint with a flag.
mountStockSection(
  "/:symbol/ownership-breakdown",
  "ownership breakdown",
  getStockOwnershipBreakdownSection,
);
mountStockSection(
  "/:symbol/insider-activity",
  "insider activity",
  getStockInsiderSection,
);
mountStockSection("/:symbol/deals", "bulk & block deals", getStockDealsSection);
mountStockSection("/:symbol/filings", "filings", getStockFilingsTimeline);
mountStockSection(
  "/:symbol/financials-source",
  "financials source",
  getStockFinancialsSource,
);
mountStockSection(
  "/:symbol/funds-holding",
  "funds holding",
  getStockFundsHolding,
);

/**
 * GET /v1/stocks/:symbol/circulars?departments=&limit=&days=
 *
 * Exchange circulars that MENTION this symbol. Mirrors
 * getCircularsForSymbolAction (apps/web lib/actions/discover-sections.ts:143).
 *
 * ON /v1/stocks, NOT /v1/discover. The web consumer is `SymbolCircularsStrip`,
 * rendered inside the stock-detail page (apps/web/app/stock/[symbol]/
 * client.tsx:933) alongside every other `/v1/stocks/:symbol/*` section. A mobile
 * stock screen should assemble itself from ONE family; splitting one panel of it
 * onto `/v1/discover` would mean two base paths for one screen and a symbol
 * param that means something different on each. The feed-wide sibling
 * (`getCircularFeed`) is genuinely a discover surface and is mounted there —
 * they are keyed differently (this one takes a symbol; that one does not), which
 * is exactly the seam.
 *
 * NOT via `mountStockSection`: that helper's service signature is
 * `(symbol, exchange)`, and this service takes no exchange (a circular is a
 * corporate notice, not an exchange-listed price) but does take `departments` /
 * `limit` / `days`. Longhand for the same reason the financials and news
 * handlers are longhand.
 *
 * HEURISTIC, NOT A FACT: the payload carries its own `disclaimer` and the client
 * MUST render it — this is a token match on the ticker in NSE's `company` column
 * or a free-text subject, and it has real false positives. The field travels in
 * the body precisely so a client cannot forget it.
 *
 * An empty/whitespace symbol never reaches here (zod 400s it); the service's own
 * empty-symbol leg returns `empty: true`, not an error, so this never 404s.
 */
const SymbolCircularsSchema = z.object({
  symbol: SymbolSchema,
  // Bounded list — it is joined into the service's cache key
  // (`…:${departments.join("|")}`), so an unbounded list is a cache-key sink.
  // Omitted entirely when empty so the service applies its OWN default
  // (["Surveillance"]) rather than being handed `[]`, which would widen the
  // `department: { in: [] }` filter to match nothing.
  departments: z
    .array(z.string().trim().min(1).max(MAX_DEPARTMENT_LEN))
    .max(MAX_SYMBOL_DEPARTMENTS)
    .optional(),
  // Service-clamped to [1,50] / [1,365] before either value reaches a query or
  // the cache key, so only a non-integer is rejected here (same rule as
  // NewsLimitSchema above).
  limit: z.coerce.number().int().optional(),
  days: z.coerce.number().int().optional(),
});

stocksRoutes.get("/:symbol/circulars", async (c) => {
  try {
    const departments = (c.req.query("departments") ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const parsed = zodParse(SymbolCircularsSchema, {
      symbol: c.req.param("symbol"),
      departments: departments.length > 0 ? departments : undefined,
      limit: c.req.query("limit") ?? undefined,
      days: c.req.query("days") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid circulars query",
          parsed.issues,
        ),
        400,
      );
    }
    // `undefined` optionals stripped so the service receives EXACTLY the
    // object getCircularsForSymbolAction passes it — notably an ABSENT
    // `departments`, which is what makes the service apply its own
    // ["Surveillance"] default instead of an empty `in` filter.
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined) args[k] = v;
    }
    const result = await getCircularsForSymbol(
      args as {
        symbol: string;
        departments?: string[];
        limit?: number;
        days?: number;
      },
    );
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Stock circulars error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load circulars"),
      500,
    );
  }
});

export default stocksRoutes;
