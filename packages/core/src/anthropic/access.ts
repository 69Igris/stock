/**
 * Claude access gate (MONEY-626 router).
 *
 * Policy: Gemini is the default for EVERY user; Claude is opt-in and
 * restricted to an allowlist (the founder today, extendable to the interns
 * later via env). This module is the single source of truth for "may this
 * person use Claude at all" and is SERVER-AUTHORITATIVE — the model
 * resolvers and the chat route consult it so a non-allowed user can never
 * resolve a Claude model id, no matter what their composer sends. The
 * picker UI also calls it to hide Claude, but that is cosmetic; the
 * resolver gate is the load-bearing one.
 *
 * Pure except for reading env — NO SDK import, no network, safe to import
 * from the CLIENT bundle (the model registry + pickers pull this; importing
 * `@anthropic-ai/sdk` here would drag node:fs/node:path into webpack). The
 * SDK-touching client lives in `./client` and re-exports `isClaudeConfigured`
 * from here for back-compat.
 */

/**
 * Whether the Claude integration can run at all: key present + kill switch
 * off. Env-only (no SDK) so it's safe in the browser bundle. Mirrored by
 * `client.ts` (re-export).
 */
export function isClaudeConfigured(): boolean {
  return (
    typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.length > 0 &&
    process.env.CLAUDE_PORTFOLIO_AGENT !== "off"
  );
}

/** Hardcoded default allowlist — the founder. */
const DEFAULT_ALLOWED_EMAILS = ["deepshaswat@gmail.com"];

/**
 * The effective allowlist: `CLAUDE_ALLOWED_EMAILS` (comma-separated) when
 * set to a non-empty list, else the founder default. The founder default is
 * the floor — an empty/whitespace env value never opens Claude to everyone
 * and never locks the founder out.
 */
export function getClaudeAllowedEmails(): string[] {
  const raw = process.env.CLAUDE_ALLOWED_EMAILS;
  const parsed = (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_EMAILS;
}

/** Is this email on the Claude allowlist? (Case-insensitive.) */
export function isClaudeAllowedForEmail(
  email: string | null | undefined,
): boolean {
  if (typeof email !== "string" || !email) return false;
  return getClaudeAllowedEmails().includes(email.trim().toLowerCase());
}

/**
 * The real entitlement check the app should use: the user is allowlisted
 * AND Claude is actually configured (key present, kill switch off). Both
 * must hold for a Claude model to be offered or resolved.
 */
export function isClaudeAvailableForEmail(
  email: string | null | undefined,
): boolean {
  return isClaudeConfigured() && isClaudeAllowedForEmail(email);
}
