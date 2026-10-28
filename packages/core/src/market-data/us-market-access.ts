/**
 * WHO MAY SEE US MARKET DATA — a founder gate, not a product feature flag.
 *
 * ## Why this exists, and why it is a hard gate rather than a PostHog flag
 *
 * We are on Tiingo COMMERCIAL, whose licence is INTERNAL USE ONLY. Ingesting
 * and storing US prices is fine under it; SHOWING them to a user is a
 * redistribution act and needs the $250/mo "EOD + IEX Redistribution" plan
 * (MONEY-1262). So the ingest side of MONEY-1309 may run freely and the read
 * side may not — for anyone but us.
 *
 * That is a LICENCE boundary, so it is enforced in code with a default that is
 * safe when every external system is unavailable. A PostHog flag is the wrong
 * instrument on its own: it is remote configuration, it fails open or closed
 * depending on transport, and it can be flipped from a dashboard by someone who
 * does not know what it is load-bearing for. The `us-stocks-listing` flag stays
 * where it is and gates the PAGE; this gates the DATA, and both must pass.
 *
 * ## The gap this closes
 *
 * The US stock page was already behind `us-stocks-listing` (default false).
 * The three routes that actually SERVE the prices were behind nothing:
 * `/api/market/quote`, `/api/market/stream`, and `/v1/market/us/quotes` — the
 * last of which is the MOBILE endpoint, open to any authenticated client. A
 * dark page in front of open data is not a gate; it is a link nobody has been
 * given yet.
 *
 * ## Refusal shape
 *
 * A refused symbol is ABSENT from the response, never an error. That is the
 * contract the US read path already uses for symbols past the EOD fan-out cap,
 * and callers already surface it (`unresolved` / `missing`). An error would
 * tell an unauthorised caller that the data exists and they are not allowed it;
 * absence tells them nothing and keeps one code path instead of two.
 */

/** The allowlist when nothing overrides it. */
const DEFAULT_US_MARKET_EMAILS = ["deepshaswat@gmail.com"];

/**
 * Emails permitted to receive US market data.
 *
 * `US_MARKET_ALLOWED_EMAILS` is an optional CSV extension, the same shape as
 * `CONNECT_FOUNDER_EMAILS` and deliberately SEPARATE from it and from
 * `CLAUDE_ALLOWED_EMAILS` — three gates that grant different things must never
 * bleed into each other, or widening one silently widens the others.
 *
 * An empty or unparseable value falls back to the default rather than to an
 * empty list. Both directions are safe here: the fallback is the NARROWEST
 * list, so a malformed env cannot open the gate.
 */
export function getUsMarketAllowedEmails(): string[] {
  const parsed = (process.env.US_MARKET_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_US_MARKET_EMAILS;
}

/**
 * May this email receive US market data?
 *
 * Anything that is not a non-empty string is REFUSED — null, undefined, a
 * number that arrived through an untyped boundary. The absence of an identity
 * is not a permission.
 */
export function isUsMarketAllowed(email: string | null | undefined): boolean {
  if (typeof email !== "string" || email.length === 0) return false;
  return getUsMarketAllowedEmails().includes(email.trim().toLowerCase());
}

/**
 * Split a requested symbol set into what this caller may and may not receive.
 *
 * Callers pass the whole set and act on `allowed`; `refused` exists so the
 * refusal can be COUNTED and logged rather than inferred from a short response.
 * A gate whose effect is invisible is one nobody notices has broken.
 */
export function partitionUsSymbolsByAccess(
  symbols: readonly string[],
  email: string | null | undefined,
): { allowed: string[]; refused: string[] } {
  if (isUsMarketAllowed(email)) return { allowed: [...symbols], refused: [] };
  return { allowed: [], refused: [...symbols] };
}
