/**
 * Broker Connection Service
 *
 * CRUD operations for broker connections (read/delete only).
 * Sync orchestration stays in apps/web due to broker client dependencies.
 * Source: apps/web/lib/actions/broker-connection.ts
 */

import { prisma } from "@usemoney/database";
import {
  clearBrokerConnectionCache,
  clearBrokerSyncCache,
  clearTradeCache,
  clearPositionCache,
} from "@usemoney/core";
import { encryption } from "@usemoney/security/encryption";
import { syncBucketFor } from "@usemoney/types/pubsub";
import type { BrokerConnection, BrokerType, Prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  toBrokerConnectionInfo,
  toBrokerSyncStatus,
  safeISOStringOrNull,
  type BrokerConnectionInfo,
  type BrokerSyncStatus,
} from "./broker-connection-logic";

// ── Types ──────────────────────────────────────────────────────────
// BrokerConnectionInfo / BrokerSyncStatus are defined in (and re-exported
// from) ./broker-connection-logic so the LIVE mapping helpers and their
// regression tests share one source of truth.
export type { BrokerConnectionInfo, BrokerSyncStatus };

// ── Service Functions ──────────────────────────────────────────────

/**
 * List all broker connections for a user.
 * Returns connection metadata only (no decrypted tokens).
 */
export async function getBrokerConnections(
  userId: string,
): Promise<ServiceResult<BrokerConnectionInfo[]>> {
  try {
    const connections = await prisma.brokerConnection.findMany({
      where: { userId },
      select: {
        id: true,
        broker: true,
        brokerUserId: true,
        accountName: true,
        status: true,
        connectedAt: true,
        lastSync: true,
        tokenExpiry: true,
      },
      orderBy: [{ broker: "asc" }, { connectedAt: "desc" }],
    });

    // Invalid-Date-safe, credential-leak-guarded mapping. A corrupt
    // lastSync/tokenExpiry/connectedAt used to throw RangeError on
    // .toISOString() here and 500 the whole brokers page.
    const now = new Date();
    const data: BrokerConnectionInfo[] = connections.map((conn) =>
      toBrokerConnectionInfo(conn, now),
    );

    return { success: true, data };
  } catch (error: unknown) {
    logger.error(
      { error, userId, fn: "getBrokerConnections" },
      "Error fetching broker connections",
    );
    return { success: false, error: "Failed to fetch broker connections" };
  }
}

/**
 * Get a single broker connection by ID.
 * Verifies ownership via userId.
 */
export async function getBrokerConnection(
  userId: string,
  connectionId: string,
): Promise<ServiceResult<BrokerConnectionInfo>> {
  try {
    const conn = await prisma.brokerConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        userId: true,
        broker: true,
        brokerUserId: true,
        accountName: true,
        status: true,
        connectedAt: true,
        lastSync: true,
        tokenExpiry: true,
      },
    });

    // IDOR guard: findUnique is by bare id, so the row may belong to ANY user;
    // the ownership check below is the access-control boundary. (A null
    // userId — unauthenticated/missing — must NOT match a row whose userId is
    // also nullish: a defensive `== null` here would let an unauthenticated
    // caller read a corrupt row. Strict !== keeps that closed.)
    if (!conn || conn.userId !== userId) {
      return {
        success: false,
        error: "Connection not found",
        code: "NOT_FOUND",
      };
    }

    // Invalid-Date-safe, credential-leak-guarded mapping. The mapper copies a
    // fixed whitelist of non-secret fields, so the internal `userId` selected
    // above (and any future widened/secret field) never reaches the caller.
    const data: BrokerConnectionInfo = toBrokerConnectionInfo(conn, new Date());

    return { success: true, data };
  } catch (error: unknown) {
    logger.error(
      { error, userId, connectionId, fn: "getBrokerConnection" },
      "Error fetching broker connection",
    );
    return {
      success: false,
      error: "Failed to fetch broker connection",
      code: "INTERNAL",
    };
  }
}

/**
 * Delete a broker connection and all associated data (holdings, positions, trades, MFs).
 * Clears relevant caches after deletion.
 */
export async function deleteBrokerConnection(
  userId: string,
  connectionId: string,
): Promise<ServiceResult<void>> {
  try {
    // Verify ownership and get brokerUserId for cascading deletes
    const connection = await prisma.brokerConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        userId: true,
        broker: true,
        brokerUserId: true,
      },
    });

    if (!connection || connection.userId !== userId) {
      return {
        success: false,
        error: "Connection not found",
        code: "NOT_FOUND",
      };
    }

    const broker = connection.broker;
    const brokerUserId = connection.brokerUserId;

    // Build where clause scoped to this specific connection's data.
    // MONEY-848: the sync layer persists rows with
    // `effectiveBrokerUserId = brokerUserId || ""` (broker-sync.service.ts), so a
    // connection whose brokerUserId is NULL has its data rows keyed by the EMPTY
    // STRING, not null. A bare `{ brokerUserId: null }` cascade would then miss
    // every one of those rows and orphan them. Coalesce null↔"" so both the
    // null-connection case and any "" sentinel rows are swept (Prisma's `in`
    // can't hold null, so use an OR over the two sentinels). When the connection
    // has a real brokerUserId, rows carry that exact value — match it precisely.
    const whereClause =
      brokerUserId == null || brokerUserId === ""
        ? { userId, broker, OR: [{ brokerUserId: null }, { brokerUserId: "" }] }
        : { userId, broker, brokerUserId };

    // Delete all broker-related data in a transaction
    await prisma.$transaction([
      prisma.pairedTradeView.deleteMany({ where: whereClause }),
      prisma.mutualFund.deleteMany({ where: whereClause }),
      prisma.holding.deleteMany({ where: whereClause }),
      prisma.position.deleteMany({ where: whereClause }),
      prisma.order.deleteMany({ where: whereClause }),
      prisma.trade.deleteMany({ where: whereClause }),
      prisma.brokerConnection.delete({ where: { id: connectionId } }),
    ]);

    // Clear all relevant caches
    await Promise.all([
      clearBrokerConnectionCache(userId),
      clearBrokerSyncCache(userId),
      clearPositionCache(userId),
      clearTradeCache(userId),
    ]);

    logger.info(
      { userId, connectionId, broker },
      "Broker connection deleted with associated data",
    );

    return { success: true, data: undefined };
  } catch (error: unknown) {
    logger.error(
      { error, userId, connectionId, fn: "deleteBrokerConnection" },
      "Error deleting broker connection",
    );
    return {
      success: false,
      error: "Failed to delete broker connection",
      code: "INTERNAL",
    };
  }
}

/**
 * Get sync status for all broker connections.
 * Returns connection list with lastSync and isActive flags.
 */
export async function getBrokerSyncStatus(
  userId: string,
): Promise<ServiceResult<BrokerSyncStatus[]>> {
  try {
    const connections = await prisma.brokerConnection.findMany({
      where: { userId },
      select: {
        id: true,
        broker: true,
        brokerUserId: true,
        accountName: true,
        status: true,
        lastSync: true,
        tokenExpiry: true,
      },
      orderBy: [{ broker: "asc" }, { connectedAt: "desc" }],
    });

    // Invalid-Date-safe mapping (see getBrokerConnections). `isActive` requires
    // an exact CONNECTED status + a non-expired token; an unknown/corrupt
    // status never defaults to active.
    const now = new Date();
    const data: BrokerSyncStatus[] = connections.map((conn) =>
      toBrokerSyncStatus(conn, now),
    );

    return { success: true, data };
  } catch (error: unknown) {
    logger.error(
      { error, userId, fn: "getBrokerSyncStatus" },
      "Error fetching broker sync status",
    );
    return { success: false, error: "Failed to fetch broker sync status" };
  }
}

/**
 * Get the most recent lastSync timestamp across all broker connections.
 * Returns null if no connections have been synced.
 */
export async function getLastSyncTime(
  userId: string,
): Promise<ServiceResult<string | null>> {
  try {
    const latest = await prisma.brokerConnection.findFirst({
      where: { userId, lastSync: { not: null } },
      select: { lastSync: true },
      orderBy: { lastSync: "desc" },
    });

    // Invalid-Date-safe: a corrupt stored lastSync must not throw on
    // .toISOString() (would turn "no recent sync" into a 500).
    return {
      success: true,
      data: safeISOStringOrNull(latest?.lastSync),
    };
  } catch (error: unknown) {
    logger.error(
      { error, userId, fn: "getLastSyncTime" },
      "Error fetching last sync time",
    );
    return { success: false, error: "Failed to fetch last sync time" };
  }
}

// ── persistBrokerConnection (MONEY-1062 W2-B) ───────────────────────────────
// The encrypt → findFirst → update-or-create upsert was duplicated (near
// identically) across connectWithApiKeyAction (Dhan) and the Groww / Angel-One
// connect routes. It is unified here. The per-broker credential SHAPE and token
// expiry are the ONLY intentional differences and are supplied by the caller
// (which keeps its own broker-specific token exchange); the boilerplate — CONNECTED
// status, timestamps, sync flags, the syncBucket shard, and clearing any legacy
// plaintext columns on reconnect — is now consistent for every API-key broker.

/**
 * The prisma surface persistBrokerConnection needs. Injected so the Next server
 * action / API-key routes pass their own client instance (and tests a fake),
 * while defaulting to the shared @usemoney/database client.
 */
type PersistPrisma = {
  brokerConnection: Pick<
    typeof prisma.brokerConnection,
    "findFirst" | "update" | "create"
  >;
};

/** The encrypt surface persistBrokerConnection needs. */
export interface PersistEncryption {
  encrypt(data: object): { encrypted: string; iv: string; authTag: string };
}

export interface PersistBrokerConnectionDeps {
  prisma?: PersistPrisma;
  encryption?: PersistEncryption;
}

export interface PersistBrokerConnectionInput {
  /** Internal (Mongo _id) user id. */
  userId: string;
  broker: BrokerType;
  /** The ALREADY-computed per-broker credential object — encrypted here. */
  credentials: object;
  /** The ALREADY-computed per-broker token expiry. */
  tokenExpiry: Date;
  brokerUserId?: string | null;
  accountName?: string | null;
  /** brokerMetadata JSON (per broker: {userId} / {clientCode} / {sessionName}). */
  metadata?: Prisma.InputJsonValue;
  /**
   * How to find an existing row to update. Default `true` → match by
   * { userId, broker, brokerUserId } (multi-account brokers: Dhan / Angel One).
   * `false` → match by { userId, broker } only (single-account Groww, whose
   * session-derived brokerUserId is not stable across logins, so keying on it
   * would spawn a duplicate connection on every reconnect).
   */
  matchByBrokerUserId?: boolean;
  /**
   * Whether to stamp the MONEY-841 `syncBucket` shard on CREATE so the daily
   * fan-out cron targets this connection. Default `true` — matches the OAuth
   * brokers and Dhan (`connectWithApiKeyAction`). Groww/Angel pass `false` to
   * PRESERVE their pre-MONEY-1062 behavior (they never set a bucket, so were
   * excluded from the scheduled fan-out). That exclusion is a latent gap tracked
   * separately (MONEY-1066) — do NOT flip it silently inside a refactor.
   */
  assignSyncBucket?: boolean;
}

export interface PersistedBrokerConnection {
  connection: BrokerConnection;
  /** True when an existing row was updated (a reconnect / re-auth). */
  wasReconnect: boolean;
  /** The pre-update accountName (for the reconnect email), else null. */
  previousAccountName: string | null;
}

/**
 * Encrypt the supplied credentials and upsert the broker connection.
 * The caller owns the broker-specific token exchange + credential shape + expiry;
 * this owns the persistence. Returns the row plus whether it was a reconnect.
 */
export async function persistBrokerConnection(
  input: PersistBrokerConnectionInput,
  deps: PersistBrokerConnectionDeps = {},
): Promise<ServiceResult<PersistedBrokerConnection>> {
  const db: PersistPrisma = deps.prisma ?? prisma;
  const enc: PersistEncryption = deps.encryption ?? encryption;

  try {
    const brokerUserId = input.brokerUserId ?? null;
    const encrypted = enc.encrypt(input.credentials);

    const where: Prisma.BrokerConnectionWhereInput =
      input.matchByBrokerUserId === false
        ? { userId: input.userId, broker: input.broker }
        : { userId: input.userId, broker: input.broker, brokerUserId };

    const existing = await db.brokerConnection.findFirst({ where });

    // Fields written on BOTH create and update.
    const common = {
      brokerUserId,
      encryptedCreds: encrypted.encrypted,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      status: "CONNECTED" as const,
      tokenExpiry: input.tokenExpiry,
      connectedAt: new Date(),
      lastRefreshedAt: new Date(),
      ...(input.accountName != null ? { accountName: input.accountName } : {}),
      ...(input.metadata !== undefined
        ? { brokerMetadata: input.metadata }
        : {}),
    };

    if (existing) {
      const connection = await db.brokerConnection.update({
        where: { id: existing.id },
        data: {
          ...common,
          errorMessage: null,
          reconnectAttempts: 0,
          // Clear any legacy plaintext columns from the pre-encryption schema.
          accessToken: null,
          refreshToken: null,
        },
      });
      return {
        success: true,
        data: {
          connection,
          wasReconnect: true,
          previousAccountName: existing.accountName ?? null,
        },
      };
    }

    const connection = await db.brokerConnection.create({
      data: {
        userId: input.userId,
        broker: input.broker,
        ...common,
        syncHoldings: true,
        syncPositions: true,
        syncOrders: true,
        // MONEY-841: stamp the stable shard so the daily fan-out cron targets
        // it. Default on; Groww/Angel opt out to preserve prior behavior
        // (MONEY-1066 tracks bringing them into the fan-out deliberately).
        ...(input.assignSyncBucket === false
          ? {}
          : { syncBucket: syncBucketFor(input.userId) }),
      },
    });
    return {
      success: true,
      data: { connection, wasReconnect: false, previousAccountName: null },
    };
  } catch (error: unknown) {
    logger.error(
      {
        error,
        userId: input.userId,
        broker: input.broker,
        fn: "persistBrokerConnection",
      },
      "Error persisting broker connection",
    );
    return { success: false, error: "Failed to persist broker connection" };
  }
}

// ── Broker management reads/writes (MONEY-1062 P4d — apps/api parity) ───────

/**
 * Rename a broker connection's account label. Port of
 * updateBrokerAccountNameAction (apps/web/lib/actions/broker-connection.ts:775).
 * The demo gate + Next `revalidatePath` stay in the caller; the service owns the
 * ownership check + write. Name is trimmed; empty/over-50 → `code:"VALIDATION"`
 * (route 400), foreign/missing → `code:"NOT_FOUND"` (route 404).
 */
export async function updateBrokerAccountName(
  userId: string,
  connectionId: string,
  accountName: string,
): Promise<ServiceResult<{ accountName: string }>> {
  try {
    const trimmed = (accountName ?? "").trim();
    if (trimmed.length === 0) {
      return {
        success: false,
        error: "Account name cannot be empty",
        code: "VALIDATION",
      };
    }
    if (accountName.length > 50) {
      return {
        success: false,
        error: "Account name must be 50 characters or less",
        code: "VALIDATION",
      };
    }

    const connection = await prisma.brokerConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, userId: true },
    });
    if (!connection || connection.userId !== userId) {
      return {
        success: false,
        error: "Connection not found or unauthorized",
        code: "NOT_FOUND",
      };
    }

    await prisma.brokerConnection.update({
      where: { id: connectionId },
      data: { accountName: trimmed },
    });

    return { success: true, data: { accountName: trimmed } };
  } catch (error: unknown) {
    logger.error(
      { error, userId, connectionId, fn: "updateBrokerAccountName" },
      "Error updating account name",
    );
    return {
      success: false,
      error: "Failed to update account name",
      code: "INTERNAL",
    };
  }
}

/** Per-data-type row counts for one broker connection. */
export interface BrokerDataCounts {
  holdings: number;
  positions: number;
  trades: number;
  importedTrades: number;
  manualTrades: number;
  mutualFunds: number;
  pairedTrades: number;
  orders: number;
}

/**
 * Row counts for a single owned connection (holdings / positions / trades /
 * imported / manual / MFs / paired / orders). Port of getBrokerDataCountsAction
 * (apps/web/lib/actions/broker-connection.ts:1111) — the connectionId branch (the
 * only one apps/api exposes: `GET /v1/brokers/:id/counts`). `broker` +
 * `brokerUserId` are derived from the owned connection (not passed in), so the
 * scoping `{ userId, broker, brokerUserId }` is byte-faithful to the web action.
 */
export async function getBrokerDataCounts(
  userId: string,
  connectionId: string,
): Promise<ServiceResult<BrokerDataCounts>> {
  try {
    const connection = await prisma.brokerConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, userId: true, broker: true, brokerUserId: true },
    });
    if (!connection || connection.userId !== userId) {
      return {
        success: false,
        error: "Connection not found",
        code: "NOT_FOUND",
      };
    }

    const whereClause = {
      userId,
      broker: connection.broker,
      brokerUserId: connection.brokerUserId,
    };

    const [
      holdings,
      positions,
      trades,
      importedTrades,
      manualTrades,
      mutualFunds,
      pairedTrades,
      orders,
    ] = await Promise.all([
      prisma.holding.count({ where: whereClause }),
      prisma.position.count({ where: whereClause }),
      prisma.trade.count({ where: whereClause }),
      prisma.trade.count({ where: { ...whereClause, sourceType: "IMPORTED" } }),
      prisma.trade.count({ where: { ...whereClause, sourceType: "MANUAL" } }),
      prisma.mutualFund.count({ where: whereClause }),
      prisma.pairedTradeView.count({ where: whereClause }),
      prisma.order.count({ where: whereClause }),
    ]);

    return {
      success: true,
      data: {
        holdings,
        positions,
        trades,
        importedTrades,
        manualTrades,
        mutualFunds,
        pairedTrades,
        orders,
      },
    };
  } catch (error: unknown) {
    logger.error(
      { error, userId, connectionId, fn: "getBrokerDataCounts" },
      "Error fetching data counts",
    );
    return {
      success: false,
      error: "Failed to fetch data counts",
      code: "INTERNAL",
    };
  }
}

// MONEY-846: a broker-sync job that hasn't reached a terminal status within this
// window is treated as STALE — so a job that died without reporting completion
// can't wedge the "syncing…" indicator. Port of
// apps/web/lib/actions/broker-connection-logic.ts#STALE_BROKER_JOB_MS.
const STALE_BROKER_JOB_MS = 15 * 60 * 1000; // 15 minutes

/** `queuedAt >= cutoff` boundary for the in-flight-job query (pure). */
function staleBrokerJobCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - STALE_BROKER_JOB_MS);
}

/**
 * Whether the user has an in-flight (non-stale) broker sync job. Port of
 * getActiveBrokerJobsAction (apps/web/lib/actions/broker-connection.ts:1329).
 * Never a hard failure: any error resolves to `{ active:false, phase:null }`
 * (the web action swallows the error into the same shape), so the poller never
 * dead-ends on a transient DB hiccup.
 */
export async function getActiveBrokerJobs(
  userId: string,
): Promise<ServiceResult<{ active: boolean; phase: "syncing" | null }>> {
  try {
    const since = staleBrokerJobCutoff();
    const jobs = await prisma.backgroundJob.findMany({
      where: {
        userId,
        jobType: "BROKER_SYNC",
        status: { in: ["PENDING", "PROCESSING"] },
        queuedAt: { gte: since },
      },
      select: { id: true },
      take: 1,
    });
    return {
      success: true,
      data:
        jobs.length === 0
          ? { active: false, phase: null }
          : { active: true, phase: "syncing" },
    };
  } catch (error: unknown) {
    logger.error(
      { error, userId, fn: "getActiveBrokerJobs" },
      "Error fetching active broker jobs",
    );
    return { success: true, data: { active: false, phase: null } };
  }
}
