/**
 * Resolve which origin the quote poller talks to. MONEY-1469 (A4).
 *
 * SERVER-ONLY: it reads `PlatformConfig`. The decision itself is pure and lives
 * in `@usemoney/core/market-data/quotes/quotes-target` so the tests exercise
 * the same bytes. Mirrors `./udf-target.ts` exactly, including the cache TTL
 * and the reason for it.
 */
import "server-only";
import { getConfig } from "@usemoney/services/platform-config";
import { noteFlagPresence } from "./flag-presence";
import {
  LEGACY_QUOTE_URL,
  MARKET_DATA_QUOTES_FLAG,
  resolveQuotesBaseUrl,
} from "@usemoney/core/market-data/quotes/quotes-target";

export { LEGACY_QUOTE_URL };

/**
 * A short in-process cache, because this runs in the ROOT layout.
 *
 * 30 seconds — the same number and the same argument as `udf-target.ts`: a flip
 * still reaches production within half a minute with no deploy, and this value
 * is also the ROLLBACK, so a longer TTL is that many more seconds of a broken
 * watchlist after the decision to stop it.
 *
 * A FAILURE IS NOT CACHED. Caching "we could not determine it" would turn one
 * Mongo blip into 30 seconds of the legacy route for every request — and, worse,
 * make the flag look inert to whoever just flipped it.
 */
const CACHE_TTL_MS = 30_000;
let cached: { value: string; at: number } | null = null;

export async function getQuotesBaseUrl(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const flag = await getConfig(MARKET_DATA_QUOTES_FLAG);
    // `getConfig` RETURNS `{success:false}` rather than throwing, so this
    // branch — not the catch — is where a Mongo blip arrives. Caching it would
    // pin the poller to the legacy route for 30 seconds AND make the flag look
    // inert to whoever just flipped it. `getUdfBaseUrl` already returns early
    // here; this file's own docblock claimed "A FAILURE IS NOT CACHED" while
    // falling straight through to the cache write below.
    if (!flag.success) {
      console.error("[quotes-target] flag read failed; using the legacy route");
      return LEGACY_QUOTE_URL;
    }
    noteFlagPresence(MARKET_DATA_QUOTES_FLAG, flag.data == null);
    const value = resolveQuotesBaseUrl({
      flagValue: flag.data?.value,
      marketDataUrl: process.env.NEXT_PUBLIC_MARKET_DATA_URL,
    });
    cached = { value, at: now };
    return value;
  } catch (error) {
    // Fail SAFE and do NOT cache it — see above.
    console.error(
      "[quotes-target] flag read failed; using the legacy route",
      error
    );
    return LEGACY_QUOTE_URL;
  }
}

/** Reset the cache. Tests only. */
export function __resetQuotesTargetCache(): void {
  cached = null;
}
