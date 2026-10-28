"use server";

/**
 * Mint a short-lived token for `usemoney-market-data`.
 *
 * Public daily bars need no auth. Intraday and US-realtime will (A5), and this
 * is the minting half of that — the verifier already lives in
 * `apps/market-data/src/middleware/market-token.ts` and is tested there.
 * Both sides read `MARKET_DATA_TOKEN_SECRET`, and neither has a default.
 *
 * ## WHY A SEPARATE TOKEN RATHER THAN THE CLERK SESSION
 *
 * The Cloud Run service would otherwise need Clerk's SDK, Clerk's network calls
 * and Clerk's keys on every chart request — which is most of the latency this
 * service exists to remove. A 5-minute HS256 token is verified with one HMAC
 * and no I/O.
 *
 * ## WHY 5 MINUTES
 *
 * Long enough that a chart session does not re-mint on every pan, short enough
 * that a leaked token in a browser history or a proxy log is worthless before
 * anyone reads it. The verifier REFUSES a token whose own `exp - iat` exceeds
 * the policy, so lengthening it here alone does not widen the window — both
 * sides have to agree, deliberately.
 */
import { createHmac, randomUUID } from "node:crypto";
import { getAuthenticatedUser } from "@/lib/auth";
import { getSubscriptionAccessForUser } from "@usemoney/services";
import { currentUserMaySeeUsMarket } from "@/lib/market/us-access";
import { getConfig } from "@usemoney/services/platform-config";
import { noteFlagPresence } from "../market/flag-presence";
import {
  MARKET_DATA_INTRADAY_FLAG,
  mayReadIntraday,
} from "@usemoney/core/market-data/intraday/intraday-entitlement";

const TOKEN_TTL_SECONDS = 300;
const TOKEN_AUDIENCE = "usemoney-market-data";

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface MintResult {
  token: string;
  /** Seconds since epoch, so the caller can re-mint before it lapses. */
  expiresAt: number;
  /** Whether this token may read intraday bars. MONEY-1470 (A5). */
  intraday: boolean;
  /** Whether this token may read US market data at all. MONEY-1469 licence. */
  us: boolean;
}

/**
 * May this user receive US market data? NEVER THROWS, always fails CLOSED.
 *
 * A LICENCE boundary, not a product flag, and deliberately NOT derived from the
 * plan: Tiingo Commercial is internal-use-only, so `currentUserMaySeeUsMarket`
 * defaults to the FOUNDER ALONE and is the same function `/api/market/quote`
 * and `/v1/market/us/quotes` already use. Folding it into a plan tier would
 * mean one PlatformConfig write meant for India shipped US data to every PRO
 * subscriber at once, with no deploy and no diff.
 */
async function resolveUsEntitlement(): Promise<boolean> {
  try {
    return await currentUserMaySeeUsMarket();
  } catch (error) {
    console.error("[market-data-token] US licence read failed", error);
    return false;
  }
}

/**
 * May this user read intraday bars? NEVER THROWS, and always fails CLOSED.
 *
 * Both reads are best-effort: a Mongo blip must not stop a chart rendering its
 * DAILY bars, which need no token at all. And a failure here has to resolve to
 * "no intraday" rather than to a default, because the opposite polarity is an
 * entitlement leak nobody observes — the same argument `resolveUdfBaseUrl` (A3)
 * makes for failing back to the old route.
 */
async function resolveIntradayEntitlement(userId: string): Promise<boolean> {
  try {
    const [access, flag] = await Promise.all([
      // The ACCESS VIEW, not the raw row. `getSubscription().data.planId` is
      // whatever the last write left there — an EXPIRED, CANCELLED or PAST_DUE
      // PRO row still reads "PRO" — so minting from it granted intraday to a
      // lapsed subscriber, in a function documented as always failing closed.
      // `buildSubscriptionAccess` collapses any non-active status to FREE, and
      // that is precisely why it exists.
      getSubscriptionAccessForUser(userId),
      getConfig(MARKET_DATA_INTRADAY_FLAG),
    ]);
    // Only a SUCCESSFUL read can say a row is absent. A failed read already
    // logs in the catch below, and reporting a Mongo blip as "never seeded"
    // would send an operator to seed a row that is already there.
    noteFlagPresence(
      MARKET_DATA_INTRADAY_FLAG,
      flag.success && flag.data == null
    );
    return mayReadIntraday({
      // `planId` off the ACCESS VIEW — already collapsed to FREE by
      // `buildSubscriptionAccess` for any non-active status. `isActive` is
      // asserted too rather than trusted: two conditions that must agree are
      // cheaper to state than to re-derive later.
      plan: access.success && access.data.isActive ? access.data.planId : null,
      flagValue: flag.success ? flag.data?.value : undefined,
    });
  } catch (error) {
    console.error(
      "[market-data-token] intraday entitlement read failed",
      error
    );
    return false;
  }
}

export async function mintMarketDataToken(): Promise<MintResult | null> {
  const user = await getAuthenticatedUser();
  // NULL, not a throw: an unauthenticated visitor is an ordinary state on a
  // public chart page, and the daily-bar endpoints need no token at all.
  //
  // `userId` is the INTERNAL Mongo id, not the Clerk subject —
  // `getAuthenticatedUser` resolves one to the other. The service stores it as
  // `sub`, so a token minted here identifies the same user every other
  // server-side read does.
  if (!user?.userId) return null;

  const secret = process.env.MARKET_DATA_TOKEN_SECRET;
  if (!secret) {
    // REFUSE rather than mint an unsigned or empty-key token. An empty HMAC key
    // is a valid HMAC key, so a missing secret would produce tokens that verify
    // against any other instance with the same missing secret.
    console.error(
      "[market-data-token] MARKET_DATA_TOKEN_SECRET is not set; refusing to mint"
    );
    return null;
  }

  const [intraday, us] = await Promise.all([
    resolveIntradayEntitlement(user.userId),
    resolveUsEntitlement(),
  ]);

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: user.userId,
      aud: TOKEN_AUDIENCE,
      iat,
      exp,
      // The claim the service reads. It is INSIDE the signature, so a browser
      // cannot flip it — which is why the decision is made here once rather
      // than re-derived per request on a service with no database.
      intraday,
      // The LICENCE claim. Inside the signature, so a browser cannot flip it.
      us,
      jti: randomUUID(),
    })
  );
  const signature = b64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest()
  );

  return {
    token: `${header}.${payload}.${signature}`,
    expiresAt: exp,
    intraday,
    us,
  };
}
