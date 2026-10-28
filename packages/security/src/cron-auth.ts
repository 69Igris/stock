/**
 * Cron endpoint authentication — MONEY-592 (security audit).
 *
 * Cron routes (Vercel Cron / Cloud Scheduler) authenticate with a static
 * `Authorization: Bearer <CRON_SECRET>` header. The previous inline check used
 * `authHeader !== \`Bearer ${secret}\``, a non-constant-time string compare that
 * short-circuits on the first differing byte — a (theoretical) timing
 * side-channel for recovering the secret. This helper does a length-checked
 * constant-time comparison (crypto.timingSafeEqual), matching the timing-safe
 * pattern already used elsewhere (demo-session HMAC, oauth-state).
 */

import { timingSafeEqual } from "crypto";

/**
 * Constant-time compare of two strings. Returns false on length mismatch
 * WITHOUT leaking timing about the contents (timingSafeEqual requires equal
 * lengths; the length check itself is unavoidable but reveals only length).
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a cron request's Authorization header against CRON_SECRET in
 * constant time. Returns a discriminated result so the caller emits the right
 * HTTP status:
 *   - { ok: false, status: 503 } — CRON_SECRET not configured (fail closed)
 *   - { ok: false, status: 401 } — missing/invalid bearer token
 *   - { ok: true }               — authorized
 */
export function verifyCronAuth(
  authHeader: string | null,
): { ok: true } | { ok: false; status: 401 | 503 } {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return { ok: false, status: 503 };
  }
  if (!authHeader || !safeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return { ok: false, status: 401 };
  }
  return { ok: true };
}
