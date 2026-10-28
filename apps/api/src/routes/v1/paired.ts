/**
 * Paired Trades Routes (MONEY-729)
 *
 * The entry/exit-matched (FIFO paired) tradebook view, backed by the persisted
 * `PairedTradeView` the Cloud Run worker writes on every sync/import. All three
 * handlers are thin: parse query → resolved userId → @usemoney/services → envelope.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  paginatedCursor,
  encodeCursor,
  decodeCursor,
} from "../../lib/response";
import {
  getPairedTrades,
  getPairedTradeStats,
  triggerTradePairing,
} from "@usemoney/services";
import { parseLimit } from "./pagination";
import {
  isValidBrokerFilter,
  isValidPairedStatusFilter,
  isParseableDate,
} from "./filters";

/** Hard ceiling on a decoded cursor `skip`; guards the Prisma 32-bit Int for
 *  `skip` from a forged `{ skip: 1e300 }` cursor (overflow → 500). */
const MAX_PAIRED_SKIP = 1_000_000;

const pairedRoutes = new Hono<AppContext>();

/**
 * GET /v1/paired
 * Paginated paired-trade view (offset bridged to an opaque `{ skip }` cursor).
 * Strictly userId-scoped by the service (IDOR-safe).
 */
pairedRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const limit = parseLimit(c.req.query("limit"));
  const cursor = decodeCursor<{ skip: number }>(c.req.query("cursor"));
  // Cap the decoded skip: a forged `{ skip: 1e300 }` cursor passes the finite
  // check yet overflows Prisma's 32-bit `Int` for `skip` → a 500. Lower-bound
  // behaviour (>0 else 0) is unchanged.
  const skip =
    cursor && Number.isFinite(cursor.skip) && cursor.skip > 0
      ? Math.min(Math.trunc(cursor.skip), MAX_PAIRED_SKIP)
      : 0;

  // Validate the enum/date filters BEFORE they reach the Prisma enum/DateTime
  // columns (a garbage value would throw a Prisma validation error → 500).
  const broker = c.req.query("broker");
  const status = c.req.query("status");
  const fromDate = c.req.query("fromDate");
  const toDate = c.req.query("toDate");
  if (!isValidBrokerFilter(broker)) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid broker filter"),
      400,
    );
  }
  if (!isValidPairedStatusFilter(status)) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid status filter (expected OPEN, CLOSED, PARTIAL, or all)",
      ),
      400,
    );
  }
  if (!isParseableDate(fromDate) || !isParseableDate(toDate)) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid date filter (fromDate/toDate must be a parseable date)",
      ),
      400,
    );
  }

  try {
    const result = await getPairedTrades(userId, {
      symbol: c.req.query("symbol"),
      broker,
      segment: c.req.query("segment"),
      status,
      fromDate,
      toDate,
      limit,
      skip,
    });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    const { trades, total } = result.data;
    const nextSkip = skip + trades.length;
    const nextCursor =
      nextSkip < total ? encodeCursor({ skip: nextSkip }) : null;
    return c.json(paginatedCursor(trades, nextCursor));
  } catch (err) {
    console.error("Paired trades fetch error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch paired trades"),
      500,
    );
  }
});

/**
 * GET /v1/paired/stats
 * Aggregate stats (realised P&L, win rate, counts, averages) over the user's
 * PairedTradeView, honouring the same symbol/broker/segment/date filters.
 */
pairedRoutes.get("/stats", async (c) => {
  const userId = c.get("userId");

  // Same enum/date guards as GET /v1/paired — the stats query runs the identical
  // broker/date where-clause, so garbage here would 500 just the same. (Stats
  // does not filter by status, so only broker + dates are validated.)
  const broker = c.req.query("broker");
  const fromDate = c.req.query("fromDate");
  const toDate = c.req.query("toDate");
  if (!isValidBrokerFilter(broker)) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid broker filter"),
      400,
    );
  }
  if (!isParseableDate(fromDate) || !isParseableDate(toDate)) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid date filter (fromDate/toDate must be a parseable date)",
      ),
      400,
    );
  }

  try {
    const result = await getPairedTradeStats(userId, {
      symbol: c.req.query("symbol"),
      broker,
      segment: c.req.query("segment"),
      fromDate,
      toDate,
    });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Paired stats error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch paired stats"),
      500,
    );
  }
});

/**
 * POST /v1/paired/repair
 * Trigger a full FIFO re-pair (worker-only, MONEY-840). Publishes a pairing job
 * to Cloud Run and pre-creates a pollable BackgroundJob; the caller polls
 * `/v1/jobs/:jobId` for completion. Returns 202 (accepted, async).
 */
pairedRoutes.post("/repair", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await triggerTradePairing(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data), 202);
  } catch (err) {
    console.error("Trade pairing error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to trigger trade pairing"),
      500,
    );
  }
});

export default pairedRoutes;
