/**
 * Maps an OAuth-callback error string to a known-error descriptor for
 * tailored UX. The matchers run on the raw error message that flows
 * through `?error=` on the brokers page redirect.
 *
 * Add a new entry here when an error pattern recurs and deserves more
 * than a generic toast — typically auth/whitelist/quota issues with a
 * clear user remedy.
 */

export type KnownBrokerError = {
  /** Short identifier for telemetry / tests. */
  code: string;
  /** Dialog title. */
  title: string;
  /** Body copy. */
  description: string;
  /** Primary CTA label, e.g. "Try another broker". */
  primaryCta?: string;
  /** Optional action hint the UI can route on. */
  primaryAction?: "switch_tab_available" | "contact_support";
};

export function mapKnownBrokerError(raw: string): KnownBrokerError | null {
  const msg = raw.toLowerCase();

  if (
    msg.includes("not enabled for the app") ||
    msg.includes("zerodha: the user is not enabled")
  ) {
    return {
      code: "ZERODHA_USER_NOT_ENABLED",
      title: "Your Zerodha account isn't authorized yet",
      description:
        "Zerodha restricts new Kite Connect apps to a single user ID by " +
        "default. We're upgrading UseMoney to multi-user access — this " +
        "usually takes 5–10 business days. In the meantime, you can " +
        "connect Upstox, Angel One, Fyers or Dhan, or email " +
        "support@usemoney.ai to be added to the early-access list.",
      primaryCta: "Try another broker",
      primaryAction: "switch_tab_available",
    };
  }

  return null;
}
