/**
 * Market Stream (SSE) — pure logic (no server-only deps).
 *
 * Extracted from `app/api/market/stream/route.ts` so the symbol parsing +
 * validation, the exchange default, the per-user connection-limit / tracking
 * math, and the SSE message shapers can be unit-tested against the REAL
 * exported symbols instead of inline copies. The route handler owns auth +
 * the ReadableStream + the per-market polling loop and imports everything here.
 *
 * `QuoteExchange` comes from `lib/market/quote-exchange`, which is pure (it
 * re-exports a core guard over the one runtime list of US venues), so this
 * module still carries no runtime dependency on Prisma / network clients.
 *
 * MONEY-1309 — the route serves US venues too. It is the SAME route, the same
 * connection cap and the same frame format: only the poll body differs, because
 * a US symbol is answered from our own Redis quote keys rather than from Yahoo.
 * Writing a second SSE route would have duplicated the auth, the per-user
 * counter, the abort wiring and the frame grammar — four things that must not
 * be allowed to drift apart, in a file that had 27 tests and zero consumers.
 *
 * @see apps/web/__tests__/api/market-stream.test.ts
 */

import type { QuoteExchange } from "@/lib/market/quote-exchange";
import { resolveQuoteExchange } from "@/lib/market/quote-exchange";

/**
 * Poll interval in milliseconds, for BOTH markets.
 *
 * Unchanged at 5s for US on purpose. It is not a rate limit against anything
 * external — a US tick is one `mget` on a Redis connection the process already
 * holds, and the vendor is never contacted on this path — so the cadence is a
 * UI question, and 5s is what every other live surface in this app already
 * uses. Going faster would mean N more Redis round trips per open tab for a
 * refresh nobody asked for.
 */
export const POLL_INTERVAL = 5000; // 5 seconds

/** SSE connection limit per user. */
export const MAX_CONNECTIONS_PER_USER = 5;

/**
 * Parse and validate the comma-separated `symbols` param: missing → invalid;
 * split / trim / drop empties; empty result or > 50 → invalid with the route's
 * exact error messages.
 */
export function parseSymbols(symbolsParam: string | null): {
  valid: boolean;
  symbols: string[];
  error?: string;
} {
  if (!symbolsParam) {
    return { valid: false, symbols: [], error: "symbols parameter required" };
  }

  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (symbols.length === 0) {
    return { valid: false, symbols: [], error: "No valid symbols provided" };
  }

  if (symbols.length > 50) {
    return { valid: false, symbols: [], error: "Maximum 50 symbols allowed" };
  }

  return { valid: true, symbols };
}

/**
 * Resolve the exchange param, defaulting to NSE.
 *
 * DELEGATES to `resolveQuoteExchange` rather than restating it. The two were
 * "deliberately the same function shape … so the stream and the quote route
 * cannot disagree about what `?exchange=nasdaq` means" — two copies held in
 * agreement by a comment, which lasted exactly until one of them was fixed:
 * the route's stopped casting an unrecognised string into `Exchange` and this
 * one would have kept doing it. Same shape is not the same function.
 */
export function parseExchange(exchangeParam: string | null): QuoteExchange {
  return resolveQuoteExchange(exchangeParam);
}

/**
 * Whether `userId` may open another SSE connection: blocked once they already
 * hold `MAX_CONNECTIONS_PER_USER`. Returns the current count too.
 */
export function checkConnectionLimit(
  activeConnections: Map<string, number>,
  userId: string
): { allowed: boolean; currentCount: number } {
  const currentCount = activeConnections.get(userId) || 0;
  if (currentCount >= MAX_CONNECTIONS_PER_USER) {
    return { allowed: false, currentCount };
  }
  return { allowed: true, currentCount };
}

/** Record one more open connection for `userId`. */
export function incrementConnection(
  activeConnections: Map<string, number>,
  userId: string
): void {
  const current = activeConnections.get(userId) || 0;
  activeConnections.set(userId, current + 1);
}

/** Release one connection for `userId`, deleting the entry at zero. */
export function decrementConnection(
  activeConnections: Map<string, number>,
  userId: string
): void {
  const count = activeConnections.get(userId) || 1;
  if (count <= 1) {
    activeConnections.delete(userId);
  } else {
    activeConnections.set(userId, count - 1);
  }
}

/** Serialize the initial SSE "connected" frame payload. */
export function formatConnectMessage(
  symbols: string[],
  exchange: QuoteExchange
): string {
  return JSON.stringify({
    type: "connected",
    symbols,
    exchange,
    timestamp: new Date().toISOString(),
  });
}

/** Serialize an SSE "error" frame payload. */
export function formatErrorMessage(message: string): string {
  return JSON.stringify({
    type: "error",
    message,
    timestamp: new Date().toISOString(),
  });
}
