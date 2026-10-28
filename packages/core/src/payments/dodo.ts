/**
 * Dodo Payments Integration
 *
 * This module provides the Dodo Payments client for payment processing.
 * Uses lazy initialization to avoid throwing at module load time.
 */

import DodoPayments from "dodopayments";

/**
 * Get the current Dodo mode based on environment variable
 */
export function getDodoMode(): "test_mode" | "live_mode" {
  return process.env.NEXT_PUBLIC_DODO_MODE === "live"
    ? "live_mode"
    : "test_mode";
}

/**
 * Get the SDK mode for frontend usage
 */
export function getDodoSdkMode(): "test" | "live" {
  return process.env.NEXT_PUBLIC_DODO_MODE === "live" ? "live" : "test";
}

// Lazy initialization to avoid throwing at module load time
let _dodoClient: DodoPayments | null = null;

/**
 * Get the Dodo Payments client
 *
 * Uses lazy initialization and singleton pattern.
 * Throws an error if DODO_PAYMENTS_API_KEY is not set.
 *
 * @returns Dodo Payments client instance
 * @throws Error if API key is not configured
 */
export function getDodoClient(): DodoPayments {
  if (_dodoClient) {
    return _dodoClient;
  }

  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DODO_PAYMENTS_API_KEY environment variable is missing or empty. Please add it to your .env file.",
    );
  }

  _dodoClient = new DodoPayments({
    bearerToken: apiKey,
    environment: getDodoMode(),
  });

  return _dodoClient;
}

/**
 * Reset the Dodo client (useful for testing)
 */
export function resetDodoClient(): void {
  _dodoClient = null;
}

/**
 * Check if Dodo Payments is configured
 *
 * @returns true if DODO_PAYMENTS_API_KEY is set
 */
export function isDodoConfigured(): boolean {
  return !!process.env.DODO_PAYMENTS_API_KEY;
}

/**
 * Check if we're in live mode
 *
 * @returns true if NEXT_PUBLIC_DODO_MODE is "live"
 */
export function isLiveMode(): boolean {
  return process.env.NEXT_PUBLIC_DODO_MODE === "live";
}

// Export mode for frontend SDK usage (accessible on client-side)
export const DODO_SDK_MODE: "test" | "live" = getDodoSdkMode();

// For backward compatibility - will throw error if API key is missing when accessed
export const dodoClient = new Proxy({} as DodoPayments, {
  get(_, prop: string | symbol) {
    if (typeof prop === "symbol") {
      return undefined;
    }
    return (getDodoClient() as unknown as Record<string, unknown>)[prop];
  },
});
