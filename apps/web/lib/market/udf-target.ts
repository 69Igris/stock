/**
 * Resolve which `/udf` origin the chart talks to. MONEY-1468 (A3).
 *
 * SERVER-ONLY: it reads `PlatformConfig`, which is a Mongo row. The decision
 * itself is pure and lives in `@usemoney/core/market-data/udf/datafeed-target`
 * so the tests exercise the same bytes.
 *
 * ## WHY A PlatformConfig ROW AND NOT AN ENV VAR
 *
 * `MARKET_DATA_TILES` has to be flippable on PROD WITHOUT A DEPLOY — both
 * directions. An env var needs a Vercel redeploy to change, which is minutes
 * during which a bad chart stays bad; a row is one write. That is the whole
 * point of gating a data-path cutover rather than shipping it.
 *
 * ## IT FAILS SAFE, INCLUDING WHEN THE DATABASE IS DOWN
 *
 * Every failure — unset, unreadable, malformed, Mongo unavailable — resolves to
 * `apps/web`'s existing `/api/market/udf`. The two directions are not
 * symmetric: falling back to the old route costs latency nobody notices, while
 * falling FORWARD to a service whose tiles are missing answers `no_data` for
 * every symbol and renders a BLANK CHART with no error.
 */
import "server-only";
import { getConfig } from "@usemoney/services/platform-config";
import { noteFlagPresence } from "./flag-presence";
import {
  LEGACY_UDF_BASE_URL,
  MARKET_DATA_TILES_FLAG,
  resolveUdfBaseUrl,
} from "@usemoney/core/market-data/udf/datafeed-target";

export { LEGACY_UDF_BASE_URL };

/**
 * The base URL to hand the chart. Never throws.
 *
 * Call it from a SERVER component and pass the result down: the chart is a
 * client component, so it cannot read this itself.
 */
/**
 * A short in-process cache, because this runs in the ROOT layout.
 *
 * Every DYNAMIC page render calls it — not only the chart pages — so an
 * uncached read adds a Mongo round-trip to each one. 30 seconds bounds that to
 * roughly two reads a minute per instance while keeping the flag's whole point
 * intact: a flip still reaches production within half a minute, with no deploy
 * and no cache to bust by hand.
 *
 * Deliberately NOT longer. This value is also the ROLLBACK — if the tile path
 * misbehaves, turning the row off has to take effect quickly, and a five-minute
 * TTL would be five minutes of a broken chart after the decision to stop it.
 *
 * NOTE what is NOT cached: a FAILURE. A Mongo blip returns the legacy route
 * without poisoning the cache, so the next call retries rather than pinning the
 * platform to the fallback for the whole TTL.
 */
const FLAG_TTL_MS = 30_000;
let cached: { value: string; at: number } | null = null;

export async function getUdfBaseUrl(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.at < FLAG_TTL_MS) return cached.value;

  try {
    const res = await getConfig(MARKET_DATA_TILES_FLAG);
    if (!res.success) return LEGACY_UDF_BASE_URL;
    noteFlagPresence(MARKET_DATA_TILES_FLAG, res.data == null);
    const value = resolveUdfBaseUrl({
      flagValue: res.data?.value,
      marketDataUrl: process.env.NEXT_PUBLIC_MARKET_DATA_URL,
    });
    cached = { value, at: now };
    return value;
  } catch {
    // Mongo down must not blank every chart on the platform — and must not be
    // CACHED either, or one blip pins everyone to the fallback for the TTL.
    return LEGACY_UDF_BASE_URL;
  }
}

/** Exported for tests: drop the memo so a case starts from a known state. */
export function __resetUdfTargetCache(): void {
  cached = null;
}
