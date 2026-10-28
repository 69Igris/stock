/**
 * The HS256 market-data token verifier. LIVE as of A5 (MONEY-1470).
 *
 * Public daily bars need no auth; INTRADAY DOES, and `/udf/history` is the one
 * route that serves both — so the gate runs inside the handler, after the
 * resolution is parsed, through `checkMarketToken` rather than through the
 * middleware. One verifier, two callers.
 *
 * The signing secret is shared with `apps/web`'s `mintMarketDataToken()`.
 * Absent secret = every token refused, never every token accepted: a
 * fail-open auth check is indistinguishable from a working one until it is
 * exercised by someone who should not have got through.
 */
import type { MiddlewareHandler } from "hono";
import { createHmac } from "node:crypto";
import { verifyMarketToken, type MarketTokenClaims } from "../app-logic";

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/**
 * Verify the `Authorization` header. USED BY TWO CALLERS, and that is the point.
 *
 * `/udf/history` cannot use the middleware: the SAME route serves public daily
 * bars and gated intraday ones, so the gate has to run after the resolution is
 * parsed. Two copies of a verifier is how one of them ends up fail-open, so
 * there is one, and both the middleware and the route call it.
 */
export function checkMarketToken(
  authorization: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
):
  | { ok: true; userId: string; claims: MarketTokenClaims }
  | { ok: false; reason: string } {
  const header = authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { ok: false, reason: "missing token" };

  const verdict = verifyMarketToken(
    token,
    process.env.MARKET_DATA_TOKEN_SECRET ?? "",
    nowSeconds,
    hmac,
  );
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  // The CLAIMS, not pre-resolved booleans. Each route calls the named
  // predicate at its own decision site — `tokenMayReadUs(auth.claims)` — so the
  // licence check is visible to `us-market-access-wired.test.ts`'s marker scan
  // AND is the thing actually being evaluated. Returning `us: boolean` made the
  // route read `!auth.us`, which a scan cannot tell from any other boolean:
  // "a source scan cannot assert a POLICY", so the policy moves to the call.
  return { ok: true, userId: verdict.claims.sub, claims: verdict.claims };
}

export const marketTokenMiddleware: MiddlewareHandler = async (c, next) => {
  const verdict = checkMarketToken(c.req.header("Authorization"));
  if (!verdict.ok) {
    // The reason is logged, never returned: "expired" vs "bad signature" tells
    // a caller which half of a forgery attempt worked.
    console.warn(`[market-data] token rejected: ${verdict.reason}`);
    return c.json(
      {
        s: "error",
        errmsg:
          verdict.reason === "missing token" ? "missing token" : "unauthorized",
      },
      401,
    );
  }

  c.set("userId", verdict.userId);
  await next();
};
