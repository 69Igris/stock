/**
 * Which `/udf` origin does the chart talk to? MONEY-1468 (data-platform A3).
 *
 * The decision is pure and lives here so both the server (which reads the flag
 * from `PlatformConfig`) and the tests exercise the SAME bytes. The component
 * only renders what it is handed.
 *
 * ## IT FAILS SAFE TO THE ROUTE THAT ALREADY WORKS
 *
 * Every ambiguous input — flag unset, flag unreadable, URL missing or
 * malformed — resolves to `apps/web`'s existing `/api/market/udf`, which has
 * been serving this chart for months. That direction matters because the two
 * failure modes are not symmetric:
 *
 *   fail to the OLD route   a slower chart, correct data, nobody notices
 *   fail to the NEW route   before its tiles exist, every symbol answers
 *                           `no_data` and the chart is BLANK with no error
 *
 * So "we could not determine the flag" must never resolve to the new origin.
 * `MARKET_DATA_TILES` defaults ON in QA and OFF in prod — but as of 2026-09-18
 * the prod ROW EXISTS and is `true`, so the default no longer describes prod.
 * The default is what applies when no row exists; read the row, never this
 * comment. And it is
 * a `PlatformConfig` row rather than an env var precisely so prod can be
 * flipped without a deploy — and flipped BACK just as fast.
 */

export const MARKET_DATA_TILES_FLAG = "MARKET_DATA_TILES";

/** The route that has served this chart all along. */
export const LEGACY_UDF_BASE_URL = "/api/market/udf";

export interface UdfTargetInput {
  /** The `PlatformConfig` value, whatever shape it came back as. */
  flagValue?: unknown;
  /** `NEXT_PUBLIC_MARKET_DATA_URL`. */
  marketDataUrl?: string | null;
}

/**
 * Read the flag out of an arbitrary `PlatformConfig` value.
 *
 * The column is `Json`, so the value may be a boolean, a string, or an object
 * someone set by hand in a console. Anything that is not an explicit,
 * recognisable TRUE is false — the same literal-comparison discipline the
 * `*_APPLY` env flags use, and for the same reason: `Boolean("false")` is
 * `true`, which would arm the one configuration meant to keep it off.
 */
export function isTilesFlagEnabled(flagValue: unknown): boolean {
  if (flagValue === true) return true;
  if (typeof flagValue === "string") return flagValue.toLowerCase() === "true";
  if (flagValue && typeof flagValue === "object") {
    const v = (flagValue as { enabled?: unknown }).enabled;
    return v === true || (typeof v === "string" && v.toLowerCase() === "true");
  }
  return false;
}

/**
 * The base URL the TradingView datafeed should use.
 *
 * Returns the LEGACY route unless the flag is explicitly on AND the service URL
 * is a usable absolute origin. A relative or malformed value would produce
 * requests to a path that does not exist on the web origin — 404s that the
 * widget renders as an empty chart.
 */
export function resolveUdfBaseUrl(input: UdfTargetInput): string {
  if (!isTilesFlagEnabled(input.flagValue)) return LEGACY_UDF_BASE_URL;

  const raw = (input.marketDataUrl ?? "").trim();
  if (!raw) return LEGACY_UDF_BASE_URL;

  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return LEGACY_UDF_BASE_URL;
  }
  // https only: the token this will carry from A5 must not cross plaintext,
  // and a CDN-fronted origin has no reason to be anything else.
  if (origin.protocol !== "https:") return LEGACY_UDF_BASE_URL;

  return `${origin.origin}/udf`;
}
