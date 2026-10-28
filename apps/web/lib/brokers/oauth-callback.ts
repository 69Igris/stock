/**
 * Shared OAuth-callback logic for the broker connect routes.
 *
 * Extracted from the per-broker `app/api/brokers/<x>/callback/route.ts` handlers
 * so the callback wire contract — which query param carries the auth code, how
 * cancellation is signalled, and the exact success/error redirect URLs — is
 * tested against the REAL exported symbols instead of an inline copy. The
 * brokers genuinely differ:
 *
 *   broker                code param(s)                  cancel signal     slug
 *   ZERODHA               request_token                  status=cancelled  zerodha
 *   ZERODHA_CONNECT       request_token                  status=cancelled  zerodha-connect
 *   UPSTOX                code                           error             upstox
 *   FYERS                 auth_code                      error             fyers
 *   ANGEL_ONE             auth_token                     error             angel-one
 *   ICICI                 apiSession|session_token|code  error             icici
 *   HDFC                  request_token|code             error             hdfc
 *   INTERACTIVE_BROKERS   code                           error             interactive-brokers
 *
 * @see apps/web/__tests__/api/broker-oauth-callbacks.test.ts
 */
import type { BrokerType } from "@usemoney/types";

export interface BrokerCallbackConfig {
  /** Query params the auth code may arrive in, in priority order. */
  codeParams: string[];
  /** URL slug used in the success redirect (`?broker=<slug>`). */
  slug: string;
  /** Fallback error text when the connect action fails without a message. */
  errorFallback: string;
  /**
   * On cancellation, surface the broker's own `error` query param (Angel /
   * ICICI / HDFC) instead of the generic "auth_cancelled" (Zerodha / Upstox /
   * Fyers / IBKR).
   */
  surfaceErrorOnCancel: boolean;
}

export const BROKER_CALLBACK_CONFIG: Record<string, BrokerCallbackConfig> = {
  ZERODHA: {
    codeParams: ["request_token"],
    slug: "zerodha",
    errorFallback: "auth_failed",
    surfaceErrorOnCancel: false,
  },
  // MONEY-837: founder-only paid Connect app — same Kite OAuth wire contract.
  ZERODHA_CONNECT: {
    codeParams: ["request_token"],
    slug: "zerodha-connect",
    errorFallback: "auth_failed",
    surfaceErrorOnCancel: false,
  },
  UPSTOX: {
    codeParams: ["code"],
    slug: "upstox",
    errorFallback: "auth_failed",
    surfaceErrorOnCancel: false,
  },
  FYERS: {
    codeParams: ["auth_code"],
    slug: "fyers",
    errorFallback: "auth_failed",
    surfaceErrorOnCancel: false,
  },
  ANGEL_ONE: {
    codeParams: ["auth_token"],
    slug: "angel-one",
    errorFallback: "Failed to connect Angel One. Please try again.",
    surfaceErrorOnCancel: true,
  },
  ICICI: {
    codeParams: ["apiSession", "session_token", "code"],
    slug: "icici",
    errorFallback: "Failed to connect ICICI Direct. Please try again.",
    surfaceErrorOnCancel: true,
  },
  HDFC: {
    codeParams: ["request_token", "code"],
    slug: "hdfc",
    errorFallback: "Failed to connect HDFC Securities. Please try again.",
    surfaceErrorOnCancel: true,
  },
  INTERACTIVE_BROKERS: {
    codeParams: ["code"],
    slug: "interactive-brokers",
    errorFallback: "auth_failed",
    surfaceErrorOnCancel: false,
  },
};

export interface ParsedBrokerCallback {
  /** First non-empty value among the broker's code params, else null. */
  code: string | null;
  /** CSRF state to round-trip to the action layer (MONEY-287). */
  state: string | undefined;
  /** True when the user cancelled or no auth code was returned. */
  cancelled: boolean;
  /** The broker's `error` query param when present (used by surfaceErrorOnCancel). */
  cancelReason: string | null;
}

/** Read the auth code from the first matching query param for this broker. */
export function getBrokerCallbackCode(
  broker: BrokerType,
  searchParams: URLSearchParams
): string | null {
  const cfg = BROKER_CALLBACK_CONFIG[broker];
  if (!cfg) return null;
  for (const param of cfg.codeParams) {
    const value = searchParams.get(param);
    if (value) return value;
  }
  return null;
}

/** Parse a broker callback's query string into a normalized result. */
export function parseBrokerCallback(
  broker: BrokerType,
  searchParams: URLSearchParams
): ParsedBrokerCallback {
  const code = getBrokerCallbackCode(broker, searchParams);
  const state = searchParams.get("state") ?? undefined;

  // Zerodha signals cancellation via `status=cancelled`; everyone else via an
  // explicit `error` param. A missing code is always treated as cancellation.
  // ZERODHA_CONNECT is the same Kite OAuth, so it shares the convention.
  if (broker === "ZERODHA" || broker === "ZERODHA_CONNECT") {
    const cancelled = searchParams.get("status") === "cancelled" || !code;
    return { code, state, cancelled, cancelReason: null };
  }
  const error = searchParams.get("error");
  return { code, state, cancelled: !!error || !code, cancelReason: error };
}

/**
 * Self-referential callback base (origin first) so a stale / missing
 * NEXT_PUBLIC_BASE_URL can't bounce the user to a dead host after auth
 * (MONEY-142). The callback must return to the same deployment.
 */
export function resolveCallbackBaseUrl(origin?: string | null): string {
  return origin || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
}

/** Redirect URL for a cancelled / no-code callback. */
export function brokerCancelRedirect(
  broker: BrokerType,
  baseUrl: string,
  cancelReason: string | null
): string {
  const cfg = BROKER_CALLBACK_CONFIG[broker];
  const value =
    cfg?.surfaceErrorOnCancel && cancelReason ? cancelReason : "auth_cancelled";
  return `${baseUrl}/brokers?error=${encodeURIComponent(value)}`;
}

/** Redirect URL after a successful connect. */
export function brokerSuccessRedirect(
  broker: BrokerType,
  baseUrl: string
): string {
  const slug = BROKER_CALLBACK_CONFIG[broker]?.slug ?? broker.toLowerCase();
  return `${baseUrl}/brokers?success=connected&broker=${slug}`;
}

/** Redirect URL after the connect action returns failure. */
export function brokerFailureRedirect(
  broker: BrokerType,
  baseUrl: string,
  actionError: string | null | undefined
): string {
  const fallback =
    BROKER_CALLBACK_CONFIG[broker]?.errorFallback ?? "auth_failed";
  return `${baseUrl}/brokers?error=${encodeURIComponent(actionError || fallback)}`;
}
