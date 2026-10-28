/**
 * Server-side resolution of "may THIS caller receive US market data".
 *
 * The rule itself is in `@usemoney/core/market-data/us-market-access` and is
 * pure; this is the I/O that feeds it — Clerk gives us a subject, the allowlist
 * wants an email, and nothing on the request carries one.
 *
 * ## Why the cache stores only DETERMINATE answers
 *
 * Caching a permission is how a gate quietly stops being a gate. The rule this
 * repo has paid for is: never cache a fail-open default — make "could not
 * determine" a distinct state and key the cache on DETERMINACY, not on the
 * value. So a successful lookup (email found, or user genuinely absent) is
 * cached; a lookup that THREW is not, and returns refusal for that request
 * only. A Mongo blip must cost one refused request, never a cached "no" that
 * outlives the outage — and must never cost a cached "yes".
 *
 * ## Why per-request lookup is acceptable at all
 *
 * `/api/market/quote` is polled every 5-10s per open tab, so an uncached
 * indexed read per request would be real load. The memo makes it one read per
 * user per TTL per warm instance. It is deliberately small and in-process: this
 * is a licence gate, and putting it in Redis would add a network hop that can
 * fail open on exactly the path that must not.
 */

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@usemoney/database";
import { isUsMarketAllowed } from "@usemoney/core/market-data/us-market-access";

/** Long enough to matter for a polling route, short enough that a revoked
 *  account loses access in minutes rather than for the life of the instance. */
const EMAIL_TTL_MS = 5 * 60_000;

/** clerkId -> resolved email (or null for "no such user"), with an expiry. */
const emailByClerkId = new Map<
  string,
  { email: string | null; expiresAtMs: number }
>();

/**
 * Resolve the email for a Clerk subject, or `undefined` when we could not tell.
 *
 * THREE outcomes, deliberately, because two of them are not the same:
 *   string     — this user's email
 *   null       — the lookup succeeded and there is no such user
 *   undefined  — the lookup FAILED; we do not know, and must not cache it
 */
async function resolveEmail(
  clerkId: string,
  nowMs: number
): Promise<string | null | undefined> {
  const hit = emailByClerkId.get(clerkId);
  if (hit && hit.expiresAtMs > nowMs) return hit.email;
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId },
      select: { email: true },
    });
    const email = user?.email ?? null;
    emailByClerkId.set(clerkId, { email, expiresAtMs: nowMs + EMAIL_TTL_MS });
    return email;
  } catch {
    // NOT cached. See the module note — an indeterminate answer that persists
    // is the failure mode this whole shape exists to avoid.
    return undefined;
  }
}

/**
 * May the current request receive US market data?
 *
 * FAIL-CLOSED at every branch: no session, a demo session, an unknown user, or
 * a failed lookup all resolve to `false`. A licence boundary is the one place
 * where "we could not tell" must mean no.
 */
export async function currentUserMaySeeUsMarket(
  nowMs: number = Date.now()
): Promise<boolean> {
  try {
    const { userId } = await auth();
    // Demo sessions have no `userId` and must never reach US data — they are
    // the one audience guaranteed not to be us.
    if (!userId) return false;
    const email = await resolveEmail(userId, nowMs);
    if (email === undefined || email === null) return false;
    return isUsMarketAllowed(email);
  } catch {
    return false;
  }
}

/** Test seam: drop the memo so a case cannot inherit another's decision. */
export function __clearUsAccessCacheForTests(): void {
  emailByClerkId.clear();
}
