/**
 * Market Stream API (Server-Sent Events)
 *
 * GET /api/market/stream?symbols=RELIANCE,TCS,INFY&exchange=NSE
 * GET /api/market/stream?symbols=AAPL,MSFT&exchange=NASDAQ
 *
 * Streams market data updates via SSE.
 *
 * India polls Yahoo (exchange-delayed). US polls OUR OWN Redis realtime quote
 * keys with the `candles` EOD close behind them — MONEY-1309.
 *
 * ## Why POLL Redis and not SUBSCRIBE to it
 *
 * `RT_QUOTE_CHANNEL` exists and the socket holder publishes to it, so a pub/sub
 * consumer is the obvious shape and it is the wrong one HERE. ioredis puts a
 * subscribed client into a mode where it can issue nothing else, so a SUBSCRIBE
 * needs its OWN connection — one per web instance, held for the life of the
 * stream. `cache/redis.ts` documents exactly one connection per process against
 * a managed node with a ~50-connection ceiling, and MONEY-1127 is the record of
 * what three independent singletons already cost us. A 5s `mget` on the
 * connection the process is already holding costs zero new sockets, and the
 * cadence is indistinguishable to a reader.
 *
 * The connection cap, the frame grammar and the abort wiring are unchanged and
 * shared by both markets — only the poll body differs.
 *
 * ## One poll at a time, and none of them unbounded
 *
 * `setInterval` does not wait for an async callback, so a tick that overruns the
 * 5s cadence starts a SECOND one beside it, and a third, indefinitely. The US
 * body is a Redis `mget` plus up to a dozen bounded Mongo queries and neither
 * `getCandles` nor an in-flight ioredis command carries a client-side deadline,
 * so a wedged store does not slow the stream down — it multiplies it. At the
 * per-user connection cap that is five streams x N stacked polls, all issuing
 * Mongo queries nobody is waiting for any more.
 *
 * The cached quote path already wraps the identical call in `withBudget` for
 * exactly this reason and says so; this one called it bare. So: an in-flight
 * latch (a tick that finds one running SKIPS rather than queues — the next tick
 * is 5s away and a skipped frame is invisible, while a queued one is permanent
 * back-pressure) plus the same `withBudget` ceiling, so a hung store costs one
 * empty frame instead of an unbounded pile of live queries.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getQuotes } from "@/lib/market/yahoo-client";
import { apiLogger as logger } from "@usemoney/logger";
import { toYahooSymbol } from "@/lib/market/symbol-mapper";
import { isUsExchange, normalizeUsExchange } from "@/lib/market/quote-exchange";
import { currentUserMaySeeUsMarket } from "@/lib/market/us-access";
import {
  QUOTE_REQUEST_BUDGET_MS,
  withBudget,
} from "@/lib/market/quote-cache-logic";
import {
  POLL_INTERVAL,
  parseSymbols,
  parseExchange,
  checkConnectionLimit,
  incrementConnection,
  decrementConnection,
  formatConnectMessage,
  formatErrorMessage,
} from "./stream-logic";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Per-user SSE connection counter (process-local). The limit + tracking math
// lives in stream-logic.ts; this Map is the state it operates on.
const activeConnections = new Map<string, number>();

export async function GET(request: NextRequest) {
  // Authenticate user
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Enforce per-user connection limit
  const { allowed } = checkConnectionLimit(activeConnections, userId);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: "Too many active connections" }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }
  incrementConnection(activeConnections, userId);

  const searchParams = request.nextUrl.searchParams;
  const exchange = parseExchange(searchParams.get("exchange"));

  const parsed = parseSymbols(searchParams.get("symbols"));
  if (!parsed.valid) {
    return new Response(JSON.stringify({ error: parsed.error }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const symbols = parsed.symbols;

  // Create SSE stream
  const encoder = new TextEncoder();
  let isConnected = true;

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection message
      const connectMessage = formatConnectMessage(symbols, exchange);
      controller.enqueue(encoder.encode(`data: ${connectMessage}\n\n`));

      const usVenue = normalizeUsExchange(exchange);

      // India only. Computed once, outside the loop, exactly as before — and
      // NOT computed at all for US, because `toYahooSymbol` would suffix `DOW`
      // into `DOW.NS`, a real NSE symbol for a different company.
      const yahooSymbols = isUsExchange(exchange)
        ? []
        : symbols.map((s) => toYahooSymbol(s, exchange));

      /**
       * One US tick: ONE `mget` over the realtime keys, plus the EOD close for
       * whatever the feed has not quoted. Same `{symbol: quote}` shape Yahoo
       * produces, so the frame format is identical for both markets and a
       * consumer needs no branch.
       *
       * Imported lazily so the India path never pulls Prisma or the Redis
       * singleton into a request that has no use for either.
       */
      const pollUs = async (
        venue: string
      ): Promise<Record<string, unknown>> => {
        // LICENCE GATE — see the quote route. An SSE stream is the same
        // redistribution act as a poll, only continuous, so it carries the
        // same check. Refusal is an EMPTY frame, which the client already
        // handles (it is what a quiet market looks like), not an error frame.
        if (!(await currentUserMaySeeUsMarket())) return {};
        const { resolveUsQuotes } =
          await import("@usemoney/core/market-data/tiingo/tiingo-rt-read");
        const { quotes } = await resolveUsQuotes(symbols, venue);
        const out: Record<string, unknown> = {};
        for (const [key, quote] of quotes) out[key] = quote;
        return out;
      };

      const pollIndia = async (): Promise<Record<string, unknown>> => {
        const quotesMap = await getQuotes(yahooSymbols);
        const out: Record<string, unknown> = {};
        quotesMap.forEach((quoteData, key) => {
          out[key] = quoteData;
        });
        return out;
      };

      // Polling function. `inFlight` is the latch described in the module note:
      // `setInterval` fires on a clock, not on completion, so without it a slow
      // tick is joined by the next one rather than replacing it.
      let inFlight = false;
      const poll = async () => {
        if (!isConnected || inFlight) return;
        inFlight = true;

        try {
          const raced = await withBudget(
            usVenue === null ? pollIndia() : pollUs(usVenue),
            QUOTE_REQUEST_BUDGET_MS,
            {} as Record<string, unknown>
          );
          // A timed-out poll emits an EMPTY frame rather than an error one: the
          // stream is still healthy and the next tick is 5s away, so `count: 0`
          // is the honest report. `withBudget` pre-catches the rejection, so a
          // throwing poll lands here as the same empty value instead of as an
          // unhandled rejection.
          const quotes = raced.value;

          const message = JSON.stringify({
            type: "quotes",
            data: quotes,
            count: Object.keys(quotes).length,
            timestamp: new Date().toISOString(),
          });

          controller.enqueue(encoder.encode(`data: ${message}\n\n`));
        } catch (error) {
          logger.error({ error }, "Stream polling error");

          const errorMessage = formatErrorMessage("Failed to fetch quotes");

          controller.enqueue(encoder.encode(`data: ${errorMessage}\n\n`));
        } finally {
          inFlight = false;
        }
      };

      // Initial poll
      await poll();

      // Set up polling interval
      const intervalId = setInterval(poll, POLL_INTERVAL);

      // Handle client disconnect
      request.signal.addEventListener("abort", () => {
        isConnected = false;
        clearInterval(intervalId);
        decrementConnection(activeConnections, userId);
        controller.close();
      });
    },

    cancel() {
      isConnected = false;
      decrementConnection(activeConnections, userId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
