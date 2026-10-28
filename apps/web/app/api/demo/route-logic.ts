/**
 * Pure logic shared by the demo session routes (`start` / `end`).
 *
 * Extracted from the route handlers so the client-IP extraction and the demo
 * cookie attributes can be unit tested directly. The routes import & call
 * these — production runs the same code the tests assert.
 */

/** The session cookie's TTL in seconds (24 hours). */
export const DEMO_COOKIE_MAX_AGE = 86400;

export interface DemoCookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  maxAge: number;
  path: "/";
}

/**
 * Extract the caller's IP from the forwarding headers, mirroring the route's
 * precedence: first `x-forwarded-for` entry (trimmed) → `x-real-ip` →
 * `"unknown"`.
 */
export function extractDemoIp(
  getHeader: (name: string) => string | null | undefined
): string {
  return (
    getHeader("x-forwarded-for")?.split(",")[0]?.trim() ||
    getHeader("x-real-ip") ||
    "unknown"
  );
}

/**
 * Attributes for the HMAC `sb_demo` session cookie when minting a session.
 * `secure` is on only in production.
 */
export function demoSessionCookieAttributes(
  isProduction: boolean
): DemoCookieAttributes {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: DEMO_COOKIE_MAX_AGE,
    path: "/",
  };
}

/** Attributes that CLEAR the `sb_demo` cookie (maxAge 0) on session end. */
export function demoClearCookieAttributes(
  isProduction: boolean
): DemoCookieAttributes {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  };
}
