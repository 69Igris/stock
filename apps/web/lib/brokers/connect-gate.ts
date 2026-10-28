/**
 * Founder gate for the ZERODHA_CONNECT (paid Kite Connect) connector — MONEY-837.
 *
 * The Connect app is founder-only: only these emails may initiate the OAuth or
 * complete the callback. Hardcoded per the requirement; an optional
 * CONNECT_FOUNDER_EMAILS env CSV can extend it. Kept SEPARATE from
 * CLAUDE_ALLOWED_EMAILS so the two gates never bleed into each other.
 */

const DEFAULT_FOUNDER_EMAILS = ["deepshaswat@gmail.com"];

export function getConnectFounderEmails(): string[] {
  const parsed = (process.env.CONNECT_FOUNDER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_FOUNDER_EMAILS;
}

export function isConnectFounder(email: string | null | undefined): boolean {
  if (typeof email !== "string" || !email) return false;
  return getConnectFounderEmails().includes(email.trim().toLowerCase());
}
