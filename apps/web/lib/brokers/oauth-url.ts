/**
 * Pure, per-broker OAuth login-URL builder.
 *
 * Extracted from `getOAuthUrlAction` (broker-connection.ts) so the per-broker
 * CSRF-state wire contract is unit-testable WITHOUT Clerk / Prisma / Redis.
 * Each broker round-trips the `state` differently, and getting it wrong fails
 * silently:
 *   - ZERODHA (Kite): ignores arbitrary login-URL params. The state MUST ride
 *     on `redirect_params` (url-encoded `state=<value>`), which Kite echoes
 *     back as `&state=<value>`. A bare `&state=` is dropped → the callback has
 *     no state → MONEY-592's mandatory CSRF check rejects every connect
 *     ("Authentication failed (security state missing)").
 *   - UPSTOX / ICICI / HDFC / INTERACTIVE_BROKERS / ANGEL_ONE: standard OAuth
 *     `&state=<value>` query param, echoed back verbatim.
 *   - FYERS: state is passed into the client helper and embedded in the URL.
 *   - GROWW / DHAN: API-key / TOTP auth, no OAuth redirect (returns an error).
 *
 * @see apps/web/__tests__/brokers/oauth-url-state-contract.test.ts
 */
import type { BrokerType } from "@usemoney/types";
import {
  ZerodhaClient,
  UpstoxClient,
  FyersClient,
  IciciClient,
  HdfcClient,
  InteractiveBrokersClient,
} from "@/lib/brokers/clients";

export type BrokerOAuthUrlResult =
  | { success: true; url: string }
  | { success: false; error: string };

export interface BuildBrokerOAuthUrlOptions {
  /** Broker API key (already validated non-empty by the caller). */
  apiKey: string;
  /** Registered OAuth redirect URI. */
  redirectUri: string;
  /** CSRF state minted by generateOAuthState(), or null when Redis is down. */
  csrfState: string | null;
  /** Fallback state for Fyers when csrfState is null (the internal user id). */
  fallbackState: string;
  /** Angel One uses a dedicated publisher key (ANGEL_API_KEY) when present. */
  angelApiKey?: string;
}

/**
 * Build the broker authorization URL, carrying the CSRF `state` in the exact
 * form that broker echoes back. Pure: no I/O, no auth, no env reads beyond the
 * values passed in — so it can be asserted directly in a contract test.
 */
export function buildBrokerOAuthUrl(
  broker: BrokerType,
  opts: BuildBrokerOAuthUrlOptions
): BrokerOAuthUrlResult {
  const { apiKey, redirectUri, csrfState, fallbackState } = opts;

  // Standard OAuth: append `state` as a query param the broker echoes back.
  const appendState = (u: string): string => {
    if (!csrfState) return u;
    return u.includes("?")
      ? `${u}&state=${encodeURIComponent(csrfState)}`
      : `${u}?state=${encodeURIComponent(csrfState)}`;
  };

  switch (broker) {
    // MONEY-837: ZERODHA_CONNECT (paid Connect app) shares Kite's OAuth — same
    // login-URL contract; only the api_key + redirect_uri differ (resolved by
    // the caller from ZERODHA_CONNECT_* env).
    case "ZERODHA":
    case "ZERODHA_CONNECT": {
      // Kite drops arbitrary login params — ride the state on redirect_params,
      // which it echoes back onto the callback as `&state=<value>`.
      const zUrl = ZerodhaClient.getLoginUrl(apiKey, redirectUri);
      return {
        success: true,
        url: csrfState
          ? `${zUrl}&redirect_params=${encodeURIComponent(`state=${csrfState}`)}`
          : zUrl,
      };
    }
    case "UPSTOX":
      return {
        success: true,
        url: appendState(UpstoxClient.getLoginUrl(apiKey, redirectUri)),
      };
    case "FYERS":
      // Fyers' helper embeds the state and round-trips it in the callback query.
      return {
        success: true,
        url: FyersClient.getLoginUrl(
          apiKey,
          redirectUri,
          csrfState ?? fallbackState
        ),
      };
    case "ICICI":
      return {
        success: true,
        url: appendState(IciciClient.getLoginUrl(apiKey, redirectUri)),
      };
    case "HDFC":
      return {
        success: true,
        url: appendState(HdfcClient.getLoginUrl(apiKey, redirectUri)),
      };
    case "INTERACTIVE_BROKERS":
      return {
        success: true,
        url: appendState(
          InteractiveBrokersClient.getLoginUrl(apiKey, redirectUri)
        ),
      };
    case "ANGEL_ONE": {
      // Publisher-login redirect flow (mobile + OTP + PIN → auth_token).
      const angelApiKey = opts.angelApiKey || apiKey;
      if (!angelApiKey) {
        return {
          success: false,
          error: "This broker is not available yet. Please try again later.",
        };
      }
      return {
        success: true,
        url: appendState(
          `https://smartapi.angelone.in/publisher-login?api_key=${encodeURIComponent(angelApiKey)}`
        ),
      };
    }
    case "GROWW":
      // API key + SHA256 checksum / TOTP (not OAuth2) — no redirect URL.
      return {
        success: false,
        error:
          "Groww uses API key + TOTP authentication. Please enter your credentials on the connection page.",
      };
    case "DHAN":
      // API key auth — no OAuth redirect.
      return {
        success: false,
        error:
          "Dhan uses API key authentication. Please enter your credentials directly.",
      };
    default:
      return {
        success: false,
        error:
          "This connection method is not available for the selected broker.",
      };
  }
}
