/**
 * Who may read intraday bars. MONEY-1470 (A5).
 *
 * Pure, and separate from both the minter and the verifier, because this is the
 * decision they must agree on. It is expressed as ONE function so widening
 * access is one edit that a test fails first.
 *
 * ## THE DEFAULT IS THE NARROW ONE, ALWAYS
 *
 * Every ambiguous input — flag unset, unreadable, malformed, a plan we do not
 * recognise — resolves to NOT ENTITLED. The two directions are not symmetric:
 * refusing someone who should have access is a visible, reported, reversible
 * annoyance; granting someone who should not is an entitlement leak nobody
 * observes. That is the same polarity `resolveUdfBaseUrl` (A3) uses, for the
 * same reason.
 *
 * ## WHY A PlatformConfig ROW, NOT AN ENV VAR
 *
 * Both directions have to work without a deploy. A tier added to the list is a
 * one-row write; a tier removed — which is the ROLLBACK — must be just as fast.
 */

export const MARKET_DATA_INTRADAY_FLAG = "MARKET_DATA_INTRADAY";

/**
 * Tiers that get intraday when the flag carries no explicit list.
 *
 * EMPTY. An absent list means nobody, not everybody: a flag row created by hand
 * with `{"enabled":true}` and no `tiers` must not silently hand intraday to the
 * whole free tier. Naming the tiers is the act of granting them.
 */
export const DEFAULT_INTRADAY_TIERS: readonly string[] = [];

export interface IntradayEntitlementInput {
  /** The `PlatformConfig` value, whatever shape it came back as. */
  flagValue?: unknown;
  /** The user's plan id — FREE / PRO / PREMIUM / ULTIMATE. */
  plan?: string | null;
}

/**
 * Read the tier list out of an arbitrary `PlatformConfig` value.
 *
 * The column is `Json`, so the value may be a boolean, a string, an array or an
 * object someone set by hand in a console. Anything unrecognisable yields an
 * EMPTY list — see the header.
 *
 * `true` on its own is REFUSED rather than read as "everyone". A bare boolean
 * cannot express which tiers, and guessing "all of them" from it is exactly the
 * silent widening this module exists to prevent.
 */
export function intradayTiers(flagValue: unknown): string[] {
  const norm = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean)
      : [];

  if (Array.isArray(flagValue)) return norm(flagValue);
  if (typeof flagValue === "string") {
    return norm(flagValue.split(","));
  }
  if (flagValue && typeof flagValue === "object") {
    const o = flagValue as { tiers?: unknown; enabled?: unknown };
    // `enabled:false` REVOKES regardless of the list — that is the rollback,
    // and it must not need the list edited as well.
    if (o.enabled === false || o.enabled === "false") return [];
    if (Array.isArray(o.tiers)) return norm(o.tiers);
    if (typeof o.tiers === "string") return norm(o.tiers.split(","));
    return [];
  }
  return [...DEFAULT_INTRADAY_TIERS];
}

/** May this plan read intraday bars? */
export function mayReadIntraday(input: IntradayEntitlementInput): boolean {
  const plan = (input.plan ?? "").trim().toUpperCase();
  if (!plan) return false;
  return intradayTiers(input.flagValue).includes(plan);
}
