/**
 * Demo Session Management
 *
 * HMAC-signed cookie replaces client-controlled isDemo parameter.
 * HMAC secret comes from DEMO_SESSION_SECRET, or a domain-separated sub-key
 * derived from ENCRYPTION_KEY (MONEY-590) — never the raw ENCRYPTION_KEY.
 *
 * MONEY-240 E: switched from `node:crypto` (createHmac) to Web Crypto
 * (crypto.subtle.sign) so this module is safe to import from Edge
 * runtime contexts. The middleware previously imported a sibling
 * function from this file, which forced webpack to pull `node:crypto`
 * into the Edge bundle and triggered the build warning:
 *
 *   A Node.js module is loaded ('crypto' at line 7) which is not
 *   supported in the Edge Runtime.
 *
 * `crypto.subtle` is globally available in both Node 20+ and Edge -
 * no runtime branching needed. Token format is unchanged
 * (`ts.fingerprint.sig`) so existing cookies continue to verify.
 */

import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";

export const COOKIE_NAME = "sb_demo";
export const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEMO_SECRET_INFO = "usemoney-demo-session-v1";

/** The two env vars the demo secret can be sourced from. */
export interface DemoSecretEnv {
  DEMO_SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;
}

/**
 * MONEY-590 (SEC-2): the demo-cookie HMAC secret must NOT be the raw
 * ENCRYPTION_KEY (the AES-256-GCM broker-credential key) doing double duty.
 * Prefer an explicit DEMO_SESSION_SECRET; otherwise derive a domain-separated
 * sub-key from ENCRYPTION_KEY via HMAC-SHA256(key, info). The demo path then
 * never signs with the credential key directly, and the derived secret is
 * one-way (a leak does not reveal ENCRYPTION_KEY).
 *
 * Pure (env passed in, no `process.env` read, no cache) so the SEC-2 invariant
 * "the demo secret is NEVER the raw ENCRYPTION_KEY" is asserted against THIS
 * exact code in a unit test — `getDemoSecret()` below is the cached production
 * wrapper that calls it with `process.env`, so prod and test share one path.
 */
export async function deriveDemoSecret(env: DemoSecretEnv): Promise<string> {
  const explicit = env.DEMO_SESSION_SECRET;
  if (explicit) return explicit;

  const root = env.ENCRYPTION_KEY;
  if (!root) {
    throw new Error("Neither DEMO_SESSION_SECRET nor ENCRYPTION_KEY is set");
  }
  const encoder = new TextEncoder();
  const rootKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(root),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    rootKey,
    encoder.encode(DEMO_SECRET_INFO)
  );
  return Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Cached production resolver: derive once from `process.env`, then reuse.
 * Thin wrapper over the pure {@link deriveDemoSecret} so the cache never
 * shadows the derivation logic.
 */
let cachedDemoSecret: string | undefined;
async function getDemoSecret(): Promise<string> {
  if (cachedDemoSecret) return cachedDemoSecret;
  cachedDemoSecret = await deriveDemoSecret({
    DEMO_SESSION_SECRET: process.env.DEMO_SESSION_SECRET,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  });
  return cachedDemoSecret;
}

/**
 * HMAC-SHA-256 → first 32 hex chars. Equivalent to the old
 * `createHmac("sha256", secret).update(payload).digest("hex").slice(0, 32)`
 * but uses Web Crypto so it works on both Node + Edge.
 */
export async function signHmac32(
  secret: string,
  payload: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Constant-time comparison of two signatures (MONEY-594, A07).
 *
 * Replaces the previous `sig !== expected`, whose early-exit made the demo
 * path the lone HMAC check that leaked timing — asymmetric with the
 * constant-time cron/credential paths. We fail closed on unequal length
 * FIRST (Node's `crypto.timingSafeEqual` throws on a length mismatch, and a
 * length check is not itself a secret-dependent branch here), then accumulate
 * the per-character XOR over the whole string so the loop runs in time
 * independent of where the first differing byte is.
 *
 * Both inputs are 32-char lowercase-hex strings from `signHmac32`. We compare
 * char codes directly rather than via `node:crypto` / `Buffer` because this
 * module must stay importable from the Edge runtime (see file header,
 * MONEY-240 E) where those Node APIs are unavailable.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Create a signed demo token.
 * Payload: `ts.fingerprint` signed with HMAC-SHA256.
 *
 * `now` is injectable purely so tests can mint a token at a fixed epoch and
 * assert TTL boundaries without sleeping; production callers omit it and get
 * `Date.now()`.
 */
export async function createDemoToken(
  fingerprint: string,
  now: number = Date.now()
): Promise<string> {
  const ts = now.toString(36);
  // Replace dots in fingerprint (e.g. IPv4 "49.36.128.57") so the token
  // can be safely split on "." into exactly 3 parts: ts.fp.sig
  const fp = fingerprint.replace(/\./g, "_").slice(0, 32);
  const payload = `${ts}.${fp}`;
  const sig = await signHmac32(await getDemoSecret(), payload);
  return `${payload}.${sig}`;
}

/**
 * Verify a demo token. Checks HMAC signature + 24h TTL.
 *
 * `now` is injectable (defaults to `Date.now()`) so TTL-boundary and expiry
 * tests freeze the clock instead of sleeping; production callers omit it.
 */
export async function verifyDemoToken(
  token: string,
  now: number = Date.now()
): Promise<{
  valid: boolean;
  expired: boolean;
}> {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, expired: false };

  const [ts, fp, sig] = parts as [string, string, string];
  const payload = `${ts}.${fp}`;
  const expected = await signHmac32(await getDemoSecret(), payload);

  if (!timingSafeEqualHex(sig, expected)) {
    return { valid: false, expired: false };
  }

  // MONEY-620: guard a non-finite / out-of-range timestamp. parseInt on
  // garbage (e.g. "!!!", "") yields NaN; `Date.now() - NaN` is NaN and
  // `NaN > TTL_MS` is false, which would BYPASS the TTL check and treat the
  // token as live. A negative parse would push expiry arbitrarily far. Any
  // non-finite or negative timestamp is structurally invalid → reject.
  const timestamp = parseInt(ts, 36);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    return { valid: false, expired: false };
  }
  const age = now - timestamp;
  if (age > TTL_MS) return { valid: false, expired: true };

  return { valid: true, expired: false };
}

/**
 * Check if the current request is a demo session.
 *
 * MONEY-439: Clerk auth wins over a stale demo cookie. When the Try Demo
 * flow races a Google One-Tap sign-in, both `sb_demo` and a Clerk session
 * cookie can land in the same browser. Middleware already prefers Clerk
 * for routing, but server components used to keep returning `isDemo=true`
 * because this helper only looked at the cookie. The short-circuit here
 * is the single server-side source of truth — `DemoSessionGuard` clears
 * the stale cookie + localStorage in the background.
 */
/**
 * Pure demo-state decision (MONEY-595 A01): demo iff there is NO Clerk session
 * AND a *valid* sb_demo cookie was verified. A signed-in user is NEVER demo.
 * The forgeable `x-demo-mode` request header is intentionally absent from the
 * inputs — it is structurally impossible for it to grant demo. `isDemoSession`
 * CALLS this with its resolved inputs so the security contract is unit-testable
 * without next/headers or Clerk (and the test runs the real decision).
 */
export function resolveDemoState(inputs: {
  clerkUserId: string | null;
  validDemoCookie: boolean;
}): boolean {
  if (inputs.clerkUserId) return false; // Clerk session wins
  return inputs.validDemoCookie; // a valid cookie is the only demo source
}

export async function isDemoSession(
  /** See `getBrokerMarketDataStatus` — `undefined` looks it up, a value reuses it. */
  knownUserId?: string | null
): Promise<boolean> {
  try {
    const userId =
      knownUserId !== undefined ? knownUserId : (await auth()).userId;
    if (userId)
      return resolveDemoState({ clerkUserId: userId, validDemoCookie: false });

    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return false;
    const result = await verifyDemoToken(token);
    return resolveDemoState({
      clerkUserId: null,
      validDemoCookie: result.valid,
    });
  } catch {
    return false;
  }
}

/**
 * Edge-compatible verification - kept as a separate export for the
 * existing middleware import path. Internally identical to
 * `verifyDemoToken` post-MONEY-240, but the explicit name signals
 * intent at the import site.
 */
export async function verifyDemoCookieEdge(token: string): Promise<boolean> {
  const result = await verifyDemoToken(token);
  return result.valid;
}
