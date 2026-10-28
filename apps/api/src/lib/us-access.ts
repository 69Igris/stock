import { prisma } from "@usemoney/database";
import { isUsMarketAllowed } from "@usemoney/core/market-data/us-market-access";

/**
 * Server-side licence gate for US market data on `/v1` (MONEY-1309).
 *
 * ## Why this exists
 *
 * We are on Tiingo COMMERCIAL, whose licence is INTERNAL USE ONLY. Ingesting
 * and storing US prices is permitted; SERVING them to a client is a
 * redistribution act and needs the $250/mo plan (MONEY-1262).
 *
 * The web stock page was already behind the `us-stocks-listing` flag. The three
 * routes that actually serve the prices were behind NOTHING, and this was the
 * widest of them: `/v1/market/us/quotes` is the MOBILE endpoint, reachable by
 * any client holding a valid Bearer token, with no page in the way at all.
 *
 * That is the same shape as MONEY-1142, which `premium-gate.ts` above documents
 * — a gate that covered `apps/web` and not `apps/api`, so the hole was one
 * surface over and reachable without any client. Read the two side by side; the
 * lesson repeating is why this file quotes it.
 *
 * ## Mirrors the web gate deliberately
 *
 * `apps/web/lib/market/us-access.ts` resolves the same rule from a Clerk
 * subject; this resolves it from our own user id, because `authMiddleware` puts
 * the Mongo `_id` on the context and the allowlist wants an email. Both fail
 * CLOSED on any error. Divergence between two surfaces is how the original gap
 * survived.
 *
 * ## Not cached here
 *
 * `premium-gate.ts` caches nothing and neither does this. The web side memoises
 * because `/api/market/quote` is polled every few seconds per open tab; a
 * mobile client calling `/v1/market/us/quotes` is not on that cadence, so the
 * indexed read is noise and a cache would only add a way for the gate to be
 * wrong.
 */
/**
 * Test seam for the user lookup.
 *
 * The `/v1/market/us/quotes` contract test stubs modules through the CJS
 * `require.cache` and does not have a database, so an unstubbed lookup throws,
 * returns null, and the gate refuses — which would make every quote assertion
 * in that file fail for a reason that has nothing to do with what it tests.
 * With the seam the suite can exercise BOTH sides: the allowed path (where the
 * existing contract assertions live) and the refusal.
 */
type EmailResolver = (userId: string) => Promise<string | null>;
let emailResolver: EmailResolver | null = null;

export function __setUsAccessEmailResolverForTests(
  fn: EmailResolver | null,
): void {
  emailResolver = fn;
}

export async function userEmailForUsAccess(
  userId: string | undefined,
): Promise<string | null> {
  if (!userId) return null;
  if (emailResolver) {
    try {
      return await emailResolver(userId);
    } catch {
      return null;
    }
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? null;
  } catch {
    // FAIL CLOSED. `isUsMarketAllowed(null)` is false, so a database blip
    // refuses rather than serves — the right direction for a licence boundary.
    return null;
  }
}

/** Convenience: resolve and decide in one call. */
export async function mayServeUsMarket(
  userId: string | undefined,
): Promise<boolean> {
  return isUsMarketAllowed(await userEmailForUsAccess(userId));
}
