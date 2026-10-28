/**
 * "Someone is looking at this US symbol" — MONEY-1309.
 *
 * The always-on socket holder subscribes to the union of a DURABLE set
 * (`rt:us:base` — watchlists, holdings, the S&P baseline) and an EPHEMERAL one
 * (`rt:us:eph`). This module writes the ephemeral half: opening a US symbol page
 * scores that ticker to `now + TTL` in the sorted set, so the next subscription
 * pass picks it up and a viewer gets a live quote instead of yesterday's close.
 *
 * ## Why it may NEVER throw into a render
 *
 * This is called from a server component. A subscription HINT is worth exactly
 * nothing next to the page it hints about, so every failure — Redis down, a
 * wedged node, the module failing to load at all — has to end as a no-op rather
 * than as a 500. `pingUsSymbolInterest` already swallows its own errors; this
 * wrapper additionally catches a rejected dynamic `import()`, which the inner
 * function cannot, and never surfaces a promise the caller could accidentally
 * await into the critical path.
 *
 * ## Why `after()` and not a bare floating promise
 *
 * A floating promise started during a render is not guaranteed to run: on Vercel
 * the function can be frozen the moment the response is sent, so post-response
 * work is SUSPENDED rather than completed (the same hazard `CandleRepository`
 * documents for its background hot-load lane). `after()` from `next/server` is
 * the platform's own answer — it keeps the invocation alive for the callback and
 * runs it off the render's critical path — so the ping actually lands AND costs
 * the reader no latency.
 *
 * `after()` throws outside a request scope, so the call itself is guarded: a
 * unit test or a script importing this must not blow up on a missing context.
 */

import { after } from "next/server";

import { normalizeUsExchange } from "@/lib/market/quote-exchange";

/**
 * Register page interest in one US symbol. Returns nothing and never throws.
 *
 * A non-US venue is silently ignored rather than an error: the caller is a page
 * that renders both markets, and making it branch before calling would put the
 * "is this US" decision in two places.
 */
export function noteUsSymbolInterest(
  symbol: string,
  exchange: string | null | undefined
): void {
  try {
    if (normalizeUsExchange(exchange) === null) return;
    const ticker = typeof symbol === "string" ? symbol.trim() : "";
    if (ticker === "") return;

    after(async () => {
      try {
        const { pingUsSymbolInterest } =
          await import("@usemoney/core/market-data/tiingo/tiingo-rt-read");
        await pingUsSymbolInterest([ticker]);
      } catch {
        // Swallowed on purpose — see the module note. A missed subscription
        // hint costs one page view its live quote, and nothing else.
      }
    });
  } catch {
    // `after()` itself throws when there is no request scope (a test, a script).
    // That is not a reason to fail whatever called us.
  }
}
