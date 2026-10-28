/**
 * News & Events Routes (MONEY-1062 P4b)
 *
 * News feed, per-symbol news, market pulse, upcoming events, and the AI daily
 * brief. Thin wrappers over news.service — faithful ports of the web-local
 * Prisma + cache reads (apps/web/lib/actions/news.ts).
 *
 * Auth: every route requires a Bearer token (auth middleware). Per-symbol news
 * (`/stock/:symbol`) is global (no userId, matching the action); pulse / feed /
 * events / daily-brief are scoped to the caller's holdings + watchlists.
 *
 * The news reads degrade gracefully in the service (a failed RSS fetch / DB read
 * returns empty data, not an error), so these routes are almost always 200; a
 * `success:false` is treated defensively as a 500.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes, zodParse } from "../../lib/response";
import {
  getNewsFeed,
  getStockNews,
  getMarketPulseNews,
  getUpcomingEvents,
  getDailyBrief,
} from "@usemoney/services";

const newsRoutes = new Hono<AppContext>();

const NEWS_FEED_FILTERS = [
  "all",
  "holdings",
  "watchlists",
  "market",
  "earnings",
  "corp_action",
] as const;

/**
 * GET /v1/news/feed?filter=&limit=
 * Filter-aware feed (holdings / watchlists / market / earnings / corp_action /
 * all). `limit` is passed through (the service clamps it to 50, matching the
 * web action's `Math.min(limit ?? 20, 50)`); an invalid filter/limit → 400.
 */
const FeedQuerySchema = z.object({
  filter: z.enum(NEWS_FEED_FILTERS).optional(),
  // Type + lower-bound harden only; the service applies the 50 upper clamp.
  limit: z.coerce.number().int().min(1).optional(),
});

newsRoutes.get("/feed", async (c) => {
  const parsed = zodParse(FeedQuerySchema, {
    filter: c.req.query("filter"),
    limit: c.req.query("limit"),
  });
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid news feed query",
        parsed.issues,
      ),
      400,
    );
  }

  const userId = c.get("userId");
  const result = await getNewsFeed(userId, {
    filter: parsed.data.filter,
    limit: parsed.data.limit,
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/news/pulse?symbols=RELIANCE,TCS
 * Market pulse across symbols. With no `?symbols` it uses the caller's top
 * holdings (falling back to popular large-caps). Blends the market-wide RSS
 * table in; capped to 10.
 */
const PulseQuerySchema = z.object({
  symbols: z.array(z.string().min(1).max(32)).max(50).optional(),
});

newsRoutes.get("/pulse", async (c) => {
  const raw = c.req.query("symbols");
  const symbols = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const parsed = zodParse(PulseQuerySchema, { symbols });
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid symbols", parsed.issues),
      400,
    );
  }

  const userId = c.get("userId");
  const result = await getMarketPulseNews(userId, parsed.data.symbols);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/news/events
 * Upcoming events (next 7 days) scoped to the caller's held + watch-listed
 * symbols plus macro (symbol-less) events. Oldest-first.
 */
newsRoutes.get("/events", async (c) => {
  const userId = c.get("userId");
  const result = await getUpcomingEvents(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/news/daily-brief
 * Gemini-generated overnight brief for the caller's holdings (cached 1h).
 * `brief` is null when the caller has no holdings or no recent news.
 */
newsRoutes.get("/daily-brief", async (c) => {
  const userId = c.get("userId");
  const result = await getDailyBrief(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/news/stock/:symbol?limit=
 * Per-symbol news (DB-first, <30-min freshness, else Google-News RSS). Global
 * (not user-scoped), matching the web action. `limit` bounded to [1, 50] at the
 * route (getStockNews has no internal clamp); default 8.
 *
 * Registered LAST so the static `/feed`, `/pulse`, `/events`, `/daily-brief`
 * segments can never be captured as a `:symbol`.
 */
const StockQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

newsRoutes.get("/stock/:symbol", async (c) => {
  const symbol = c.req.param("symbol");
  if (!symbol) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "symbol is required"),
      400,
    );
  }

  const parsed = zodParse(StockQuerySchema, { limit: c.req.query("limit") });
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid limit", parsed.issues),
      400,
    );
  }

  const result = await getStockNews(symbol, parsed.data.limit ?? 8);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

export default newsRoutes;
