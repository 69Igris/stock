/**
 * Client Trust helpers for the custom Clerk sign-in flows (MONEY-766).
 *
 * Clerk's Client Trust feature adds a `needs_client_trust` sign-in status:
 * a password sign-in WITHOUT MFA from a new device must verify a code sent
 * to the account's email/phone (`supportedSecondFactors` carries
 * `email_code` / `phone_code`), via the regular
 * prepareSecondFactor/attemptSecondFactor pair.
 *
 * Pure module — both the routing and the factor pick are unit-tested, so
 * the "unknown status dead-ends the form" class of bug can't silently
 * return when Clerk adds statuses.
 */

export type SignInNextStep =
  | "complete"
  | "second_factor"
  | "client_trust"
  | "unsupported";

/** Route a Clerk sign-in `status` to the next UI step. */
export function resolveSignInNextStep(
  status: string | null | undefined
): SignInNextStep {
  switch (status) {
    case "complete":
      return "complete";
    case "needs_second_factor":
      return "second_factor";
    case "needs_client_trust":
      return "client_trust";
    default:
      return "unsupported";
  }
}

export interface ClientTrustFactor {
  strategy: "email_code" | "phone_code";
  emailAddressId?: string;
  phoneNumberId?: string;
  /** Masked destination for display, e.g. "s•••@gmail.com". */
  safeIdentifier?: string;
}

/**
 * Pick the verification factor for a client-trust challenge from
 * `signIn.supportedSecondFactors`. Prefers email_code over phone_code;
 * returns null when neither is offered (caller surfaces a support message).
 * Defensive about shape — the array comes from the SDK at runtime.
 */
export function pickClientTrustFactor(
  supportedSecondFactors: unknown
): ClientTrustFactor | null {
  if (!Array.isArray(supportedSecondFactors)) return null;

  const factors = supportedSecondFactors.filter(
    (f): f is Record<string, unknown> => !!f && typeof f === "object"
  );

  const toFactor = (
    f: Record<string, unknown>,
    strategy: "email_code" | "phone_code"
  ): ClientTrustFactor => ({
    strategy,
    emailAddressId:
      typeof f.emailAddressId === "string" ? f.emailAddressId : undefined,
    phoneNumberId:
      typeof f.phoneNumberId === "string" ? f.phoneNumberId : undefined,
    safeIdentifier:
      typeof f.safeIdentifier === "string" ? f.safeIdentifier : undefined,
  });

  const email = factors.find((f) => f.strategy === "email_code");
  if (email) return toFactor(email, "email_code");

  const phone = factors.find((f) => f.strategy === "phone_code");
  if (phone) return toFactor(phone, "phone_code");

  return null;
}
