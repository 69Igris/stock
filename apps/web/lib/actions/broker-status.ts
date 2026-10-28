/**
 * Broker Market-Data Status Server Action
 *
 * Reports whether the current user has an active broker connection (currently
 * Zerodha). Used by API routes and the client-side `useBrokerStatus` hook to
 * render the delayed-data disclaimer / reconnect affordances.
 *
 * MONEY-837: this no longer hands out decrypted broker credentials for market
 * data — the web app's runtime quotes/charts are Yahoo-only. The old
 * `getBrokerCredentials()` helper (which decrypted the Zerodha access token for
 * the live-quote path) was removed with that cutover; live market data now
 * lives in the standalone Connect service.
 *
 * MONEY-1124: `/api/market/quote` calls this on a path the UI polls every 5s,
 * so the two Prisma queries behind it ran 24×/minute per open tab to decide a
 * disclaimer string. Both are now read through a 60s user-scoped cache. The
 * resolution, the freshness boundary and the "which way does staleness err"
 * reasoning live in `./broker-status-logic.ts`; this file is only the ports.
 */
"use server";

import { auth } from "@clerk/nextjs/server";
import { getCached, setCached } from "@usemoney/core";
import { prisma } from "@/lib/prisma";
import {
  BROKER_CONNECTIONS_CACHE_IDENTIFIER,
  BROKER_STATUS_CACHE_TTL_SECONDS,
  BROKER_USER_CACHE_IDENTIFIER,
  resolveBrokerMarketDataStatus,
  type BrokerConnectionSnapshot,
  type BrokerMarketDataStatus,
  type BrokerStatusPorts,
} from "./broker-status-logic";

// ============== TYPES ==============

export type { BrokerMarketDataStatus };

// ============== PORTS ==============

const CACHE_CONFIG = { ttl: BROKER_STATUS_CACHE_TTL_SECONDS } as const;

/**
 * Production ports.
 *
 * Every cache call is individually guarded: a Redis blip must degrade to "read
 * the DB", never to an error page on a market-data surface.
 */
function buildPorts(): BrokerStatusPorts {
  return {
    readUserIdCache: async (clerkUserId) => {
      try {
        return await getCached<{ id: string | null }>(
          "user",
          clerkUserId,
          BROKER_USER_CACHE_IDENTIFIER,
          undefined,
          CACHE_CONFIG
        );
      } catch {
        return null;
      }
    },
    writeUserIdCache: async (clerkUserId, value) => {
      try {
        await setCached(
          "user",
          clerkUserId,
          BROKER_USER_CACHE_IDENTIFIER,
          value,
          undefined,
          CACHE_CONFIG
        );
      } catch {
        // Best-effort — a failed write only costs the next call a DB read.
      }
    },
    findUserId: async (clerkUserId) => {
      const user = await prisma.user.findFirst({
        where: {
          OR: [{ clerkId: clerkUserId }, { email: clerkUserId }],
        },
        select: { id: true },
      });
      return user?.id ?? null;
    },

    readConnectionsCache: async (userId) => {
      try {
        return await getCached<BrokerConnectionSnapshot[]>(
          "brokers",
          userId,
          BROKER_CONNECTIONS_CACHE_IDENTIFIER,
          undefined,
          CACHE_CONFIG
        );
      } catch {
        return null;
      }
    },
    writeConnectionsCache: async (userId, snapshots) => {
      try {
        await setCached(
          "brokers",
          userId,
          BROKER_CONNECTIONS_CACHE_IDENTIFIER,
          snapshots,
          undefined,
          CACHE_CONFIG
        );
      } catch {
        // Best-effort.
      }
    },
    findConnections: async (userId) =>
      prisma.brokerConnection.findMany({
        where: {
          userId,
          broker: "ZERODHA",
        },
        select: {
          status: true,
          tokenExpiry: true,
        },
      }),

    reauthUrl: () => {
      const apiKey = process.env.ZERODHA_API_KEY || "";
      return apiKey
        ? `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`
        : null;
    },
    now: () => Date.now(),
  };
}

// ============== SERVER ACTION ==============

/**
 * Get the user's broker connection status for market data.
 * Currently supports Zerodha; can be extended for other brokers.
 */
export async function getBrokerMarketDataStatus(
  /**
   * The caller's already-resolved Clerk user id, if it has one.
   *
   * `undefined` means "look it up here" — the original behaviour, and what
   * every existing call site gets. Passing the value (INCLUDING `null` for a
   * signed-out request) skips a second `auth()` on a path that has already
   * done one. The UDF history route was evaluating `auth()` three times per
   * request — the handler, `isDemoSession`, and this — each a cross-region
   * round trip while the Vercel region is unpinned (MONEY-1122).
   *
   * `null` and `undefined` are deliberately NOT the same state here: collapsing
   * them would make a signed-out caller silently re-authenticate instead of
   * being told it is signed out.
   */
  knownUserId?: string | null
): Promise<BrokerMarketDataStatus> {
  if (knownUserId !== undefined) {
    return resolveBrokerMarketDataStatus(knownUserId, buildPorts());
  }
  let clerkUserId: string | null = null;
  try {
    ({ userId: clerkUserId } = await auth());
  } catch (error) {
    // Same degrade-to-"none" contract the original had: a market-data surface
    // must never 500 because the auth lookup hiccuped, and "none" is the
    // direction that SHOWS the exchange-delayed disclaimer.
    console.error("getBrokerMarketDataStatus auth error:", error);
    return resolveBrokerMarketDataStatus(null, buildPorts());
  }
  return resolveBrokerMarketDataStatus(clerkUserId, buildPorts());
}
