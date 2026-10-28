/**
 * Broker Sync Service (MONEY-837 rich-unify)
 *
 * The single shared implementation of "fetch a broker connection's data and
 * persist it" — used by BOTH the web server action (in-app sync) and the Cloud
 * Run worker (scheduled sync), and available to apps/api. It fetches through the
 * RICH broker client layer (@usemoney/core/brokers → full Normalized* shapes:
 * sector / name / instrumentToken / MTF / position labels / MF metadata), so
 * both code paths now write the same complete rows. Previously the worker used
 * the leaner core ADAPTERS and silently dropped those fields.
 *
 * Scope boundary — what lives HERE (common): decrypt → rich client → per-type
 * fetch + persist → lastSync + syncLog, with the token-expiry skip, the
 * 403 → NEEDS_REAUTH short-circuit, and the ZERODHA_CONNECT skip. What stays in
 * the CALLER (glue): Clerk auth, cache invalidation, revalidatePath, emails,
 * notifications, trade pairing, RAG indexing, dashboard pre-compute, PostHog
 * telemetry. Per-type fetch errors are RETURNED (not logged-and-forgotten) so
 * each caller can run its own failure telemetry.
 *
 * Persistence semantics are ported verbatim from the old apps/web syncXxxToDb
 * helpers (the MONEY-582 hardening): holdings = skip-on-empty + atomic
 * delete+insert (no silent wipe); positions = atomic delete+insert (empty IS a
 * valid squared-off state); trades + mutual funds = batched upsert (never
 * delete — preserves IMPORTED / MANUAL rows).
 */

import { randomUUID } from "node:crypto";
import type { BrokerConnection } from "@prisma/client";
import { prisma } from "@usemoney/database";
import { createBrokerClient } from "@usemoney/core/brokers";
import type { BrokerCredentials } from "@usemoney/core/brokers/clients/base-client";
import { encryption } from "@usemoney/security/encryption";
import { dbLogger as logger } from "@usemoney/logger";
import type {
  BrokerType,
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedMutualFund,
} from "@usemoney/types";
import type { ServiceResult } from "./types";
import { mapWithConcurrency } from "./concurrency-logic";

// ── Types ──────────────────────────────────────────────────────────────

export type SyncDataType = "holdings" | "positions" | "trades" | "mutualFunds";

/** Default data types synced when a caller omits an explicit list. */
export const DEFAULT_SYNC_DATA_TYPES: readonly SyncDataType[] = [
  "holdings",
  "positions",
  "trades",
  // MONEY-837: include mutual funds so scheduled + default syncs refresh MFs
  // (previously MFs only synced at connect-time and went stale). Only Zerodha
  // exposes an MF API; every other adapter returns [] — harmless.
  "mutualFunds",
];

export interface SyncedCounts {
  holdings?: number;
  positions?: number;
  trades?: number;
  mutualFunds?: number;
}

export interface SyncConnectionResult {
  /** The connection's broker (for caller telemetry tags). */
  broker: BrokerType;
  /** Per-type record counts that were fetched + persisted. */
  synced: SyncedCounts;
  /** True when a 403/expired token aborted the remaining data types. */
  authFailed: boolean;
  /** True when the connection was skipped entirely (no creds / connect-only). */
  skipped: boolean;
  /** Machine-readable reason when skipped/authFailed. */
  skipReason?: "connect-token-only" | "no-credentials" | "token-expired";
  /** Per-type fetch error messages, for the caller's own telemetry. */
  errors: Partial<Record<SyncDataType, string>>;
  /**
   * MONEY-846: a CONNECTION-level failure (not a per-type fetch) — e.g. the
   * decrypt or createBrokerClient step threw before any data type could run.
   * The multi-connection loop catches it, records it here, and CONTINUES to the
   * next connection so one bad connection can never abort the whole batch
   * (catastrophic for the wildcard "*" scheduled sync). Distinct from `errors`
   * (per-endpoint) and from a benign `skipped`.
   */
  connectionError?: string;
}

// ── Pure guards ──────────────────────────────────────────────────────────

/** True when the connection's access token has expired (null = not expired). */
export function isConnectionTokenExpired(
  tokenExpiry: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!tokenExpiry) return false;
  return new Date(tokenExpiry) < now;
}

/** Classify a fetch error as an expired-token 403 (→ NEEDS_REAUTH). */
export function is403Error(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return msg.includes("403") || msg.includes("Forbidden");
}

/**
 * The brokers a sync may select when the caller does not name one.
 *
 * Founder decision 2026-09-11: broker sync works for **Zerodha only** today —
 * both of its connectors. The other six `BrokerType` members have adapters, but
 * no live sync, so a scheduled fan-out that selects them manufactures work that
 * can only fail. Widening this is a one-line edit HERE, visible in a diff, and
 * `broker-sync.test.ts` pins the exact membership so it cannot widen by
 * accident.
 *
 * It applies to a SCHEDULED SHARD and nothing else — a leaf of the cron's
 * fan-out, which is precisely the thing the rule is about. Not to every call
 * that happens to omit a broker: that wider reading also narrows a direct
 * service caller which is not the scheduler at all, and it would turn a user
 * whose only connection is an Upstox one into "Broker not connected", which is
 * a lie about something they can see on their own brokers page.
 *
 * The narrower rule loses nothing on the paths that exist. The fan-out TRIGGER
 * returns before it reaches this function, so a well-formed scheduled selection
 * arrives here as a shard leaf carrying a bucket.
 *
 * ONE shape is deliberately left uncovered, and it is worth naming rather than
 * implying it cannot happen: `isFanoutTrigger` is
 * `!!isScheduled && !Number.isInteger(syncBucket)`, so a message with
 * `userId:"*"` and NO `isScheduled` flag does not fan out — it falls through as
 * a leaf with no bucket and selects every connection on the platform, across
 * all six brokers. `processSync` already warns about exactly that message
 * ("wildcard userId without isScheduled flag") because it is malformed: nothing
 * in the scheduler produces it, and if one ever did, selecting the whole
 * platform in a single 600s invocation is a far larger problem than which
 * brokers it picked. Covering it here would also narrow the four LIVE
 * per-connection-isolation tests that use exactly that shape as a fixture.
 *
 * Widening this to all broker-less calls is a one-line change if the policy
 * ever means that too.
 *
 * ZERODHA_CONNECT is in the list because the rule names both connectors, and
 * including it is harmless: `classifyConnectionForSync` skips it one layer down
 * with the named reason `connect-token-only`. Filtering it out at the QUERY
 * instead would make that skip reason unreachable — a Connect token that exists
 * would become invisible rather than explained.
 */
export const SYNC_ENABLED_BROKERS = [
  "ZERODHA",
  "ZERODHA_CONNECT",
] as const satisfies readonly BrokerType[];

/**
 * The "nothing matched" answer, spelled ONCE.
 *
 * `apps/web/lib/actions/broker-connection.ts` compares against this exact text
 * to turn it into "Broker not connected" for a user. That comparison was a
 * string literal in two files; one rule with two spellings is this repo's most
 * expensive recurring defect, so the web action imports the constant now.
 */
export const NO_CONNECTIONS_ERROR = "No broker connections found";

/**
 * Is this call one leaf of the scheduled shard fan-out, rather than a person
 * asking for their own data?
 *
 * The distinction decides what an EMPTY selection means. For a user, no
 * connection is a real answer they need to see. For a shard it is the ordinary
 * case — measured on prod 2026-09-11: 9 connections occupy 6 of 64 buckets, so
 * 58 leaves of every fan-out match nothing. Treating those as failures cost
 * 3,733 5xx and 928 dead-letters a day, each one an in-app notification about
 * work that did not need doing.
 *
 * `Number.isInteger`, never truthiness: bucket **0** is a real shard, and
 * `if (syncBucket)` would classify it as a user sync and resurrect the error
 * for 1/64th of the fan-out — the rarest and least reproducible version of the
 * bug this function exists to remove.
 */
export function isScheduledShard(syncBucket?: number): boolean {
  return Number.isInteger(syncBucket);
}

/**
 * Build the BrokerConnection findMany where-clause. A wildcard `userId === "*"`
 * (scheduled bulk sync) matches ALL users; any other value scopes to that user.
 * `connectionId` / `broker` narrow it further.
 *
 * This is the ONLY copy. `workers/src/processors/sync-logic.ts` carried a second
 * one for three tickets; it had no importer, so the two could have disagreed
 * silently about a cross-user data hazard.
 *
 * MONEY-841: `syncBucket` narrows a wildcard scheduled sync to ONE shard
 * (`where.syncBucket = N`), so the daily cron's per-bucket fan-out messages each
 * sync ~1/SYNC_BUCKET_COUNT of the connections in parallel instead of one worker
 * serial-looping every connection. There is intentionally NO `take` cap on the
 * findMany — a shard is already a bounded slice, and a cap would silently drop
 * connections beyond it (the ~5k scaling cliff this ticket removes).
 */
export function buildConnectionWhere(
  userId: string,
  connectionId?: string,
  broker?: string,
  syncBucket?: number,
): Record<string, unknown> {
  const where: Record<string, unknown> = userId === "*" ? {} : { userId };
  if (connectionId) where.id = connectionId;
  // An explicit broker always wins — a user syncing one named connection is
  // answered about THAT connection, whatever the default set says. Otherwise a
  // SCHEDULED SHARD, and only a scheduled shard, narrows to the syncable set.
  if (broker) where.broker = broker;
  else if (isScheduledShard(syncBucket))
    where.broker = { in: [...SYNC_ENABLED_BROKERS] };
  if (Number.isInteger(syncBucket)) where.syncBucket = syncBucket;
  return where;
}

/** What a sync pass should do with a connection. */
export type ConnectionSyncDecision =
  | { action: "sync" }
  | {
      action: "skip";
      reason: "connect-token-only" | "no-credentials" | "token-expired";
      /** Flip a CONNECTED connection to NEEDS_REAUTH (the caller does the write). */
      markReauth: boolean;
    };

/** The connection fields the skip decision reads (a structural subset). */
export interface ClassifiableConnection {
  broker: string;
  encryptedCreds: string | null;
  iv: string | null;
  authTag: string | null;
  tokenExpiry: Date | string | null;
  status: string;
}

/**
 * MONEY-838: the single skip-or-sync decision shared by the day's-data sync
 * (syncBrokerConnectionRow) and the historical backfill (syncHistoricalTradebook)
 * — previously duplicated inline in both. Pure: it never writes; the caller
 * performs the markNeedsReauth update when `markReauth` is true. The cron relies
 * on expired-token connections being skipped here CHEAPLY (no decrypt, no API).
 *   - ZERODHA_CONNECT      → skip (token-capture only, never synced)
 *   - missing creds        → skip (nothing to decrypt)
 *   - expired token        → skip; markReauth iff currently CONNECTED
 *   - otherwise            → sync
 */
export function classifyConnectionForSync(
  connection: ClassifiableConnection,
  now: Date = new Date(),
): ConnectionSyncDecision {
  if (connection.broker === "ZERODHA_CONNECT") {
    return { action: "skip", reason: "connect-token-only", markReauth: false };
  }
  if (!connection.encryptedCreds || !connection.iv || !connection.authTag) {
    return { action: "skip", reason: "no-credentials", markReauth: false };
  }
  if (isConnectionTokenExpired(connection.tokenExpiry, now)) {
    return {
      action: "skip",
      reason: "token-expired",
      markReauth: connection.status === "CONNECTED",
    };
  }
  return { action: "sync" };
}

// ── Caller summary helpers (pure — for emails / telemetry) ───────────────

/** Per-type counts for the "Sync Complete" email body (MONEY-848). */
export interface SyncEmailCounts {
  holdings: number;
  positions: number;
  trades: number;
  mutualFunds: number;
  /**
   * True when AT LEAST ONE connection's mutual-fund fetch ERRORED (vs genuinely
   * empty). Lets the email say "not synced — re-authorise" instead of a
   * misleading "Mutual Funds: 0" (same distinction the connect email draws).
   */
  mutualFundsError: boolean;
}

/**
 * MONEY-848: fold the per-connection day-sync results into one per-type count
 * bag for the "Sync Complete" email. Pure: the worker calls this with
 * `result.data.perConnection`. A type that ERRORED on a connection is simply
 * never folded in (it stays at 0) — except MF, where we ALSO flag the error so
 * the email can distinguish "no funds" from "couldn't read funds".
 */
export function buildSyncEmailCounts(
  perConnection: SyncConnectionResult[],
): SyncEmailCounts {
  const counts: SyncEmailCounts = {
    holdings: 0,
    positions: 0,
    trades: 0,
    mutualFunds: 0,
    mutualFundsError: false,
  };
  for (const c of perConnection) {
    counts.holdings += c.synced.holdings || 0;
    counts.positions += c.synced.positions || 0;
    counts.trades += c.synced.trades || 0;
    counts.mutualFunds += c.synced.mutualFunds || 0;
    if (c.errors.mutualFunds) counts.mutualFundsError = true;
  }
  return counts;
}

/**
 * MONEY-848: the historical-backfill connections that genuinely ERRORED (a real
 * fetch/persist failure), EXCLUDING benign skips (connect-only / no-creds /
 * token-expired — those carry a `skipped` flag and are not errors to surface).
 * The worker uses this to flip the affected connection to NEEDS_REAUTH + notify
 * the user, so a token-expired 2nd account no longer fails silently.
 */
export function historicalConnectionsWithErrors(
  perConnection: HistoricalTradesPerConnection[],
): HistoricalTradesPerConnection[] {
  return perConnection.filter((c) => c.error && !c.skipped);
}

// ── Persistence (rich Normalized* → Prisma) ──────────────────────────────

/**
 * MONEY-582a: skip-on-empty + atomic delete+insert. An empty holdings array
 * from a malformed-but-2xx response would otherwise SILENTLY WIPE the user's
 * real holdings while still logging SUCCESS, so empty = "no update". A genuine
 * full exit reconciles on the next non-empty sync.
 */
/**
 * MONEY-712 — how many broker connections sync concurrently.
 *
 * Deliberately small. Each task is a chain of authenticated broker API calls
 * plus DB writes, and the wildcard "*" scheduled batch can carry thousands of
 * connections, so the ceiling protects the brokers' rate limits and our own
 * Mongo pool as much as it protects latency. Four covers essentially every
 * interactive case (a user's whole broker list at once) and keeps the
 * scheduled batch from behaving like a stampede.
 *
 * Raise it only with a measurement — the failure mode of guessing high is a
 * rate-limited or banned API key, which is far more expensive than a slow sync.
 */
export const SYNC_CONNECTION_CONCURRENCY = 4;

export async function persistHoldings(
  userId: string,
  broker: BrokerType,
  brokerUserId: string | null | undefined,
  holdings: NormalizedHolding[],
): Promise<void> {
  const effectiveBrokerUserId = brokerUserId || "";
  if (holdings.length === 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.holding.deleteMany({
      where: { userId, broker, brokerUserId: effectiveBrokerUserId },
    });
    await tx.holding.createMany({
      data: holdings.map((h) => ({
        userId,
        broker,
        brokerUserId: effectiveBrokerUserId,
        symbol: h.symbol,
        tradingSymbol: h.tradingSymbol,
        name: h.name,
        isin: h.isin,
        instrumentToken: h.instrumentToken,
        exchange: h.exchange,
        quantity: h.quantity,
        averagePrice: h.averagePrice,
        currentPrice: h.currentPrice,
        closePrice: h.closePrice,
        investedValue: h.investedValue,
        currentValue: h.currentValue,
        unrealizedPnL: h.pnl,
        pnlPercentage: h.pnlPercentage,
        dayChange: h.dayChange,
        dayChangePerc: h.dayChangePercentage,
        t1Quantity: h.t1Quantity || 0,
        pledgedQuantity: h.pledgedQuantity || 0,
        collateralQty: h.collateralQuantity || 0,
        sector: h.sector,
        mtfQuantity: h.mtf?.quantity,
        mtfUsedQuantity: h.mtf?.usedQuantity,
        mtfAveragePrice: h.mtf?.averagePrice,
        mtfValue: h.mtf?.value,
        mtfInitialMargin: h.mtf?.initialMargin,
      })),
    });
  });
}

/**
 * MONEY-582a: positions DIFFER from holdings — an empty array is a legitimate
 * "all squared off / expired" state, so clear-on-empty is intended. The fix is
 * atomicity only: delete+insert in one transaction.
 */
export async function persistPositions(
  userId: string,
  broker: BrokerType,
  brokerUserId: string | null | undefined,
  positions: NormalizedPosition[],
): Promise<void> {
  const effectiveBrokerUserId = brokerUserId || "";
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.position.deleteMany({
      where: { userId, broker, brokerUserId: effectiveBrokerUserId },
    });
    if (positions.length > 0) {
      await tx.position.createMany({
        data: positions.map((p) => ({
          userId,
          broker,
          brokerUserId: effectiveBrokerUserId,
          symbol: p.symbol,
          tradingSymbol: p.tradingSymbol,
          instrumentToken: p.instrumentToken,
          exchange: p.exchange,
          segment: p.segment,
          positionType: p.positionType,
          productType: p.productType,
          segmentLabel: p.segmentLabel,
          productTypeLabel: p.productTypeLabel,
          positionTypeLabel: p.positionTypeLabel,
          buyQuantity: p.buyQuantity,
          sellQuantity: p.sellQuantity,
          netQuantity: p.quantity,
          overnightQuantity: p.overnightQuantity || 0,
          buyPrice: p.buyPrice,
          sellPrice: p.sellPrice,
          averagePrice: p.averagePrice,
          lastPrice: p.lastPrice,
          closePrice: p.closePrice,
          dayBuyQuantity: p.dayBuyQuantity || 0,
          dayBuyPrice: p.dayBuyPrice || 0,
          dayBuyValue: p.dayBuyValue || 0,
          daySellQuantity: p.daySellQuantity || 0,
          daySellPrice: p.daySellPrice || 0,
          daySellValue: p.daySellValue || 0,
          buyValue: p.buyValue ?? p.buyQuantity * p.buyPrice,
          sellValue: p.sellValue ?? p.sellQuantity * p.sellPrice,
          netValue: p.value ?? Math.abs(p.quantity) * p.lastPrice,
          realizedPnl: p.realizedPnl ?? 0,
          unrealizedPnl: p.unrealizedPnl ?? p.pnl,
          totalPnl: p.pnl,
          pnlPercentage: p.pnlPercentage,
          m2m: p.m2m,
          multiplier: p.multiplier,
          tradeDate: now,
        })),
      });
    }
  });
}

/**
 * Upsert synced trades in batches; never touch IMPORTED / MANUAL trades.
 * Keyed on the (userId, broker, brokerUserId, brokerTradeId) compound unique.
 */
export async function persistTrades(
  userId: string,
  broker: BrokerType,
  brokerUserId: string | null | undefined,
  trades: NormalizedTrade[],
): Promise<void> {
  const effectiveBrokerUserId = brokerUserId || "";
  const TRADE_BATCH_SIZE = 25;
  for (let i = 0; i < trades.length; i += TRADE_BATCH_SIZE) {
    const batch = trades.slice(i, i + TRADE_BATCH_SIZE);
    await Promise.all(
      batch.map((t) =>
        prisma.trade.upsert({
          where: {
            userId_broker_brokerUserId_brokerTradeId: {
              userId,
              broker,
              brokerUserId: effectiveBrokerUserId,
              brokerTradeId: t.tradeId,
            },
          },
          update: {
            symbol: t.symbol,
            tradingSymbol: t.tradingSymbol,
            isin: t.isin || null,
            exchange: t.exchange,
            segment: t.segment,
            tradeType: t.transactionType,
            orderType: t.orderType || "MARKET",
            productType: t.productType,
            quantity: t.quantity,
            price:
              t.price || (t.value && t.quantity ? t.value / t.quantity : 0),
            tradeValue: isNaN(t.value) ? undefined : t.value,
            tradeDate: t.tradeTime,
            tradeTime: t.tradeTime,
            sourceType: "SYNCED",
            isEditable: false,
            needsRepairing: true,
          },
          create: {
            userId,
            broker,
            brokerUserId: effectiveBrokerUserId,
            brokerName: broker.toLowerCase(),
            brokerTradeId: t.tradeId,
            brokerOrderId: t.orderId,
            symbol: t.symbol,
            tradingSymbol: t.tradingSymbol,
            isin: t.isin || null,
            exchange: t.exchange,
            segment: t.segment,
            tradeType: t.transactionType,
            orderType: t.orderType || "MARKET",
            productType: t.productType,
            quantity: t.quantity,
            price:
              t.price || (t.value && t.quantity ? t.value / t.quantity : 0),
            tradeValue: isNaN(t.value) ? undefined : t.value,
            tradeDate: t.tradeTime,
            tradeTime: t.tradeTime,
            sourceType: "SYNCED",
            isEditable: false,
            needsRepairing: true,
          },
        }),
      ),
    );
  }
}

/**
 * Upsert mutual funds in batches. Keyed on the
 * (userId, broker, brokerUserId, folioNumber, tradingSymbol) compound unique.
 */
export async function persistMutualFunds(
  userId: string,
  broker: BrokerType,
  brokerUserId: string | null | undefined,
  mfs: NormalizedMutualFund[],
): Promise<void> {
  const effectiveBrokerUserId = brokerUserId || "";
  const MF_BATCH_SIZE = 25;
  for (let i = 0; i < mfs.length; i += MF_BATCH_SIZE) {
    const batch = mfs.slice(i, i + MF_BATCH_SIZE);
    await Promise.all(
      batch.map((mf) =>
        prisma.mutualFund.upsert({
          where: {
            userId_broker_brokerUserId_folioNumber_tradingSymbol: {
              userId,
              broker,
              brokerUserId: effectiveBrokerUserId,
              folioNumber: mf.folioNumber,
              tradingSymbol: mf.tradingSymbol || mf.schemeCode || mf.schemeName,
            },
          },
          update: {
            schemeName: mf.schemeName,
            schemeCode: mf.schemeCode,
            tradingSymbol: mf.tradingSymbol,
            isin: mf.isin,
            amcName: mf.amcName,
            category: mf.category,
            units: mf.units,
            averageNav: mf.averageNav,
            currentNav: mf.currentNav,
            investedAmount: mf.investedValue,
            investedValue: mf.investedValue,
            currentValue: mf.currentValue,
            unrealizedGain: mf.pnl,
            pnl: mf.pnl,
            pnlPercentage: mf.pnlPercentage,
            xirr: mf.xirr || 0,
            pledgedQuantity: mf.pledgedQuantity,
            lasQuantity: mf.lasQuantity,
            lastUpdated: new Date(),
          },
          create: {
            userId,
            broker,
            brokerUserId: effectiveBrokerUserId,
            schemeName: mf.schemeName,
            schemeCode: mf.schemeCode,
            tradingSymbol: mf.tradingSymbol || mf.schemeCode || mf.schemeName,
            isin: mf.isin,
            folioNumber: mf.folioNumber,
            folio: mf.folioNumber,
            amcName: mf.amcName,
            category: mf.category,
            units: mf.units,
            averageNav: mf.averageNav,
            currentNav: mf.currentNav,
            investedAmount: mf.investedValue,
            investedValue: mf.investedValue,
            currentValue: mf.currentValue,
            unrealizedGain: mf.pnl,
            pnl: mf.pnl,
            pnlPercentage: mf.pnlPercentage,
            xirr: mf.xirr || 0,
            pledgedQuantity: mf.pledgedQuantity,
            lasQuantity: mf.lasQuantity,
          },
        }),
      ),
    );
  }
}

// ── Per-connection orchestrator ──────────────────────────────────────────

async function markNeedsReauth(connectionId: string): Promise<void> {
  await prisma.brokerConnection
    .update({ where: { id: connectionId }, data: { status: "NEEDS_REAUTH" } })
    .catch(() => {});
}

/**
 * Sync ONE broker connection: decrypt → rich client → per-type fetch+persist →
 * lastSync + syncLog. Token-expiry and 403 mark the connection NEEDS_REAUTH and
 * short-circuit the remaining types. Never throws on a per-type fetch failure —
 * the error is captured in `result.errors[type]` for the caller's telemetry.
 *
 * Uses `connection.userId` (not a job-level userId) so wildcard/scheduled syncs
 * write to each connection's own owner.
 */
export async function syncBrokerConnectionRow(
  connection: BrokerConnection,
  dataTypes: readonly SyncDataType[] = DEFAULT_SYNC_DATA_TYPES,
  opts: { refreshProfile?: boolean } = {},
): Promise<SyncConnectionResult> {
  const synced: SyncedCounts = {};
  const errors: Partial<Record<SyncDataType, string>> = {};
  const broker = connection.broker as BrokerType;
  const userId = connection.userId;
  const brokerUserId = connection.brokerUserId || undefined;

  // MONEY-838: single shared skip decision (was three duplicated inline guards).
  const decision = classifyConnectionForSync(connection);
  if (decision.action === "skip") {
    if (decision.markReauth) await markNeedsReauth(connection.id);
    return {
      broker,
      synced,
      // Only an expired token is an auth failure; connect-only / no-creds are
      // benign skips that must not churn the connection into re-auth.
      authFailed: decision.reason === "token-expired",
      skipped: true,
      skipReason: decision.reason,
      errors,
    };
  }

  // `!`: classifyConnectionForSync returned action "sync" only when all three
  // credential fields are present, but that narrowing happens inside the helper
  // so TS can't see it here.
  const credentials = encryption.decrypt<BrokerCredentials>(
    connection.encryptedCreds!,
    connection.iv!,
    connection.authTag!,
  );
  const client = createBrokerClient(broker, credentials);

  // MONEY-837 (Scope B): opt-in profile refresh into brokerMetadata. The
  // multi-user Personal Kite app exposes /user/profile. Best-effort — a profile
  // failure must NEVER block the data sync.
  if (opts.refreshProfile) {
    try {
      const profile = await client.getProfile();
      const existingMeta =
        connection.brokerMetadata &&
        typeof connection.brokerMetadata === "object" &&
        !Array.isArray(connection.brokerMetadata)
          ? (connection.brokerMetadata as Record<string, unknown>)
          : {};
      await prisma.brokerConnection.update({
        where: { id: connection.id },
        data: {
          brokerMetadata: {
            ...existingMeta,
            profile: {
              userId: profile.userId,
              userName: profile.userName,
              email: profile.email,
              broker: profile.broker,
              exchanges: profile.exchanges,
              products: profile.products,
            },
            profileSyncedAt: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      logger.warn({ broker, err }, "broker profile sync failed (non-fatal)");
    }
  }

  let authFailed = false;
  // A type that fetches+persists without throwing PROVES the session token is
  // live. We use that to tell a dead session apart from a per-endpoint scope gap.
  let anyTypeSucceeded = false;

  const runType = async (
    type: SyncDataType,
    fetchAndPersist: () => Promise<number>,
  ) => {
    if (!dataTypes.includes(type) || authFailed) return;
    try {
      synced[type] = await fetchAndPersist();
      anyTypeSucceeded = true;
    } catch (error) {
      errors[type] = error instanceof Error ? error.message : String(error);
      // MONEY-837: a 403 BEFORE any type has succeeded = a genuinely expired
      // session → mark NEEDS_REAUTH and short-circuit. A 403 AFTER a type has
      // already succeeded = a per-endpoint scope/entitlement gap (e.g. Kite "MF
      // holdings" not yet enabled on the app, or no Coin holdings) — NOT a dead
      // token. Record it as a per-type error but keep the connection healthy so
      // a working account isn't churned into re-auth by one un-entitled endpoint.
      if (is403Error(error) && !anyTypeSucceeded) {
        authFailed = true;
        await markNeedsReauth(connection.id);
      } else {
        logger.error(
          { error, broker, type },
          `Failed to sync ${broker} ${type}`,
        );
      }
    }
  };

  await runType("holdings", async () => {
    const holdings = await client.getHoldings();
    await persistHoldings(userId, broker, brokerUserId, holdings);
    return holdings.length;
  });
  await runType("positions", async () => {
    const positions = await client.getPositions();
    await persistPositions(userId, broker, brokerUserId, positions);
    return positions.length;
  });
  await runType("trades", async () => {
    const trades = await client.getTrades();
    await persistTrades(userId, broker, brokerUserId, trades);
    return trades.length;
  });
  await runType("mutualFunds", async () => {
    const mfs = await client.getMutualFunds();
    await persistMutualFunds(userId, broker, brokerUserId, mfs);
    return mfs.length;
  });

  const total =
    (synced.holdings || 0) +
    (synced.positions || 0) +
    (synced.trades || 0) +
    (synced.mutualFunds || 0);

  if (authFailed) {
    await prisma.syncLog.create({
      data: {
        userId,
        broker,
        syncType: "ALL",
        status: "FAILED",
        recordsFetched: 0,
        errorMessage: "Token expired (403 Forbidden). Please re-authenticate.",
      },
    });
    return { broker, synced, authFailed, skipped: false, errors };
  }

  // MONEY-837: a successful fetch+persist is definitive proof the token works,
  // so clear any sticky NEEDS_REAUTH/errorMessage left by a prior failed sync.
  // Without this, a connection that ever hit a 403/expiry stayed "re-auth
  // needed" forever — even right after the user re-authed and synced today.
  await prisma.brokerConnection.update({
    where: { id: connection.id },
    data: { lastSync: new Date(), status: "CONNECTED", errorMessage: null },
  });
  await prisma.syncLog.create({
    data: {
      userId,
      broker,
      syncType: "ALL",
      status: "SUCCESS",
      recordsFetched: total,
    },
  });

  return { broker, synced, authFailed, skipped: false, errors };
}

// ── Multi-connection orchestrator ────────────────────────────────────────

export interface SyncBrokerConnectionsParams {
  /** Internal user id, or "*" for a scheduled all-users bulk sync. */
  userId: string;
  broker?: BrokerType;
  connectionId?: string;
  dataTypes?: readonly SyncDataType[];
  refreshProfile?: boolean;
  /**
   * MONEY-841: shard scope for a wildcard scheduled sync. When set, only
   * connections whose `syncBucket` matches are synced (the daily cron fans out
   * one job per bucket). Omit for a user-scoped sync.
   */
  syncBucket?: number;
}

export interface SyncBrokerConnectionsData {
  synced: SyncedCounts;
  total: number;
  connectionCount: number;
  perConnection: SyncConnectionResult[];
}

/**
 * Resolve the matching broker connections and sync each. Aggregates per-type
 * counts across connections. Returns an error result (not a throw) when no
 * connection matches, so callers map it straight to their response shape.
 */
export async function syncBrokerConnections(
  params: SyncBrokerConnectionsParams,
): Promise<ServiceResult<SyncBrokerConnectionsData>> {
  const where = buildConnectionWhere(
    params.userId,
    params.connectionId,
    params.broker,
    params.syncBucket,
  );
  // No `take` cap: a per-shard scheduled sync is already bounded, and capping
  // would silently drop connections (MONEY-841 removes the ~5k scaling cliff).
  const connections = await prisma.brokerConnection.findMany({ where });
  if (connections.length === 0) {
    // An empty SHARD is the ordinary case, not a failure — see isScheduledShard.
    if (isScheduledShard(params.syncBucket)) {
      return {
        success: true,
        data: { synced: {}, total: 0, connectionCount: 0, perConnection: [] },
      };
    }
    return { success: false, error: NO_CONNECTIONS_ERROR };
  }

  const dataTypes = params.dataTypes ?? DEFAULT_SYNC_DATA_TYPES;
  const perConnection: SyncConnectionResult[] = [];
  const synced: SyncedCounts = {};

  // MONEY-712 — connections sync with BOUNDED concurrency, not one at a time.
  //
  // This was a strictly sequential loop, so a user with four brokers waited for
  // the sum of four round-trip-heavy syncs, and the wildcard "*" scheduled
  // batch walked every connection on the platform in series.
  //
  // Bounded, NOT `Promise.all`. The "*" batch can carry thousands of
  // connections (MONEY-841 removed the ~5k cliff), and firing them all at once
  // would stampede both the brokers' APIs and our own Mongo pool — trading a
  // slow sync for a rate-limited and possibly banned one. A small window is
  // where nearly all the wall-clock win is anyway: a user has a handful of
  // connections, and the scheduled batch is throughput-bound rather than
  // latency-bound.
  //
  // Distinct brokers rate-limit independently, so the window is per-batch
  // rather than per-broker; a per-broker limiter is the refinement to make if a
  // single broker ever proves to be the constraint.
  // MONEY-712 — bounded concurrency via the pure `mapWithConcurrency` helper.
  //
  // Inline windowing here was guarded only by a source-text regex, and a review
  // proved that vacuous: mutating the bound to `connections.length` (full
  // unbounded fan-out) left every test green. A regex cannot observe
  // concurrency; the extracted helper can be tested behaviourally, by watching
  // peak in-flight count.
  //
  // Bounded, NOT `Promise.all` over every connection. The wildcard "*" batch can
  // carry thousands (MONEY-841 removed the ~5k cliff), and unbounded fan-out
  // trades a slow sync for a rate-limited — or banned — broker API key.
  //
  // MONEY-846's per-connection error boundary is INSIDE the task, and that is
  // load-bearing: each task resolves to a result and never rejects, so one bad
  // connection cannot take its in-flight siblings down with it. Sequentially an
  // uncaught throw aborted the remaining loop; concurrently it would abort the
  // siblings too. `mapWithConcurrency` deliberately does not catch, so this
  // stays the caller's explicit choice rather than a silent swallow.
  const results = await mapWithConcurrency(
    connections,
    SYNC_CONNECTION_CONCURRENCY,
    async (connection): Promise<SyncConnectionResult> => {
      try {
        return await syncBrokerConnectionRow(connection, dataTypes, {
          refreshProfile: params.refreshProfile,
        });
      } catch (error) {
        logger.error(
          { error, broker: connection.broker, connectionId: connection.id },
          "broker connection sync failed (connection-level)",
        );
        return {
          broker: connection.broker as BrokerType,
          synced: {},
          authFailed: false,
          skipped: false,
          errors: {},
          connectionError:
            error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // `mapWithConcurrency` returns in INPUT order, so `perConnection` matches the
  // order of `connections` — it is surfaced per-broker in the UI, so a
  // completion-order result would be a visible reordering.
  for (const result of results) {
    perConnection.push(result);
    for (const key of [
      "holdings",
      "positions",
      "trades",
      "mutualFunds",
    ] as const) {
      const n = result.synced[key];
      if (n != null) synced[key] = (synced[key] || 0) + n;
    }
  }

  const total =
    (synced.holdings || 0) +
    (synced.positions || 0) +
    (synced.trades || 0) +
    (synced.mutualFunds || 0);

  return {
    success: true,
    data: { synced, total, connectionCount: connections.length, perConnection },
  };
}

// ── Historical tradebook backfill (Console/backoffice) ───────────────────────

export interface SyncHistoricalTradesParams {
  userId: string;
  broker?: BrokerType;
  connectionId?: string;
  fromDate: Date;
  toDate: Date;
  segments?: string[];
  /**
   * Shard scope, exactly as {@link SyncBrokerConnectionsParams.syncBucket}.
   *
   * This field was MISSING, and its absence was a 64x amplification waiting for
   * scale. The weekly catch-up cron (`broker-sync-historical-weekly`, Sun 01:00
   * IST, `historicalDays: 30`) fans out to all 64 shards, and each leaf reached
   * this function with `userId: "*"` and no bucket — so every populated leaf
   * backfilled the tradebook of EVERY connection on the platform, not its own
   * shard's. At 9 connections that is 54 backfills instead of 9 and nobody
   * notices; at 5,000 it is 320,000 slow, rate-limited Console calls.
   *
   * It was invisible because the day-sync's own "no connections" throw aborted
   * the leaf before reaching here on the 58 EMPTY shards — so fixing that throw
   * without also passing this would have turned a 6x amplification into 64x.
   */
  syncBucket?: number;
}

export interface HistoricalTradesPerConnection {
  broker: string;
  brokerUserId: string | null;
  synced: number;
  skipped?: boolean;
  error?: string;
}

export interface SyncHistoricalTradesData {
  synced: number;
  connectionCount: number;
  perConnection: HistoricalTradesPerConnection[];
}

/**
 * MONEY-837: backfill the multi-day historical tradebook for the matching
 * connection(s) via the broker client's getHistoricalTrades (Zerodha = Console
 * backoffice API; other brokers return []). Upserts through persistTrades (keyed
 * by brokerTradeId), so it coexists with the day's /trades sync without wiping
 * it. SLOW (async polling) — run from the worker, not a sync web request.
 */
export async function syncHistoricalTradebook(
  params: SyncHistoricalTradesParams,
): Promise<ServiceResult<SyncHistoricalTradesData>> {
  const where = buildConnectionWhere(
    params.userId,
    params.connectionId,
    params.broker,
    params.syncBucket,
  );
  const connections = await prisma.brokerConnection.findMany({ where });
  if (connections.length === 0) {
    if (isScheduledShard(params.syncBucket)) {
      return {
        success: true,
        data: { synced: 0, connectionCount: 0, perConnection: [] },
      };
    }
    return { success: false, error: NO_CONNECTIONS_ERROR };
  }

  let syncedTotal = 0;
  const perConnection: HistoricalTradesPerConnection[] = [];

  for (const connection of connections) {
    const broker = connection.broker as BrokerType;
    const brokerUserId = connection.brokerUserId;
    // MONEY-838: same shared skip decision as the day's-data sync.
    const decision = classifyConnectionForSync(connection);
    if (decision.action === "skip") {
      if (decision.markReauth) await markNeedsReauth(connection.id);
      perConnection.push({
        broker,
        brokerUserId,
        synced: 0,
        skipped: true,
        // connect-token-only is an expected healthy skip (no error); the others
        // surface their reason for the caller's telemetry.
        ...(decision.reason === "connect-token-only"
          ? {}
          : { error: decision.reason }),
      });
      continue;
    }

    try {
      // `!`: classifyConnectionForSync guaranteed creds are present on the
      // sync path (narrowing happens inside the helper, invisible to TS here).
      const credentials = encryption.decrypt<BrokerCredentials>(
        connection.encryptedCreds!,
        connection.iv!,
        connection.authTag!,
      );
      const client = createBrokerClient(broker, credentials);
      // MONEY-846: walk the window 1 YEAR at a time, newest→oldest, persisting
      // each year before continuing ("fetch 1y, ingest, continue"). Keeps memory
      // bounded + makes progress durable across a worker restart. We walk ALL the
      // way to the params.fromDate floor (now − HISTORICAL_SYNC_DAYS, ≈10y by
      // default) UNCONDITIONALLY — the floor is what bounds runtime, not an
      // empty-year early-stop. The old `consecutiveEmptyYears < 2` stop was a
      // CORRECTNESS BUG: a user with a ≥2-year complete trading GAP mid-history
      // (e.g. active 2018, idle 2019-2020, active 2017) was falsely terminated at
      // the gap, permanently missing every trade older than it. A one-time connect
      // backfill can afford a few extra empty-window fetches in exchange for never
      // losing pre-gap trades. (The worker only marks the sync job COMPLETED after
      // this whole loop finishes, so the tradebook populates once.)
      const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
      const DAY_MS = 24 * 60 * 60 * 1000;
      let connSynced = 0;
      let windowEnd = params.toDate;
      while (windowEnd > params.fromDate) {
        const windowStart = new Date(
          Math.max(params.fromDate.getTime(), windowEnd.getTime() - YEAR_MS),
        );
        const yearTrades = await client.getHistoricalTrades(
          windowStart,
          windowEnd,
          params.segments,
        );
        if (yearTrades.length > 0) {
          await persistTrades(
            connection.userId,
            broker,
            brokerUserId || undefined,
            yearTrades,
          );
          connSynced += yearTrades.length;
        }
        windowEnd = new Date(windowStart.getTime() - DAY_MS);
      }
      syncedTotal += connSynced;
      perConnection.push({ broker, brokerUserId, synced: connSynced });
    } catch (error) {
      logger.error({ error, broker }, "historical tradebook backfill failed");
      perConnection.push({
        broker,
        brokerUserId,
        synced: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    success: true,
    data: {
      synced: syncedTotal,
      connectionCount: connections.length,
      perConnection,
    },
  };
}

// ── Async sync-job triggers (apps/api mobile parity, MONEY-1062) ──────────────
//
// The web server actions (apps/web/lib/actions/broker-connection.ts:
// syncBrokerDataAction / syncAllBrokersAction) publish a broker-sync Pub/Sub job
// and pre-create a POLLABLE BackgroundJob row so the client can poll
// GET /v1/jobs/:jobId. These ADDITIVE helpers port the SHARED, Prisma-bound half
// of that flow — verify the target connection is a syncable, owned, ACTIVE one +
// create the tracking row — and RETURN the resolved facts (jobId + broker) for
// the caller to build + publish the SyncJobMessage.
//
// The PUBLISH stays with the caller: the apps/api route imports
// `publishSyncJob` from @usemoney/pubsub/publish and calls it, mirroring how the
// web action owns its publishSyncJob call and how apps/api's me.ts owns
// publishAccountDeletionJob. That keeps the publish an explicit, testable seam at
// the route boundary (parity-p2a-contract.test.ts) and the route thin.
//
// G3 (MONEY-1062 hardening — check every ServiceResult before the next side
// effect): a failed verify (missing / foreign / ZERODHA_CONNECT / inactive)
// returns { success:false } and NO tracking row is created, so the caller must
// check the result BEFORE publishing and thus never publishes a job for a
// connection that failed the gate.

/** Default historical-backfill window (days): ~10y (full retail history). */
export const DEFAULT_HISTORICAL_SYNC_DAYS = 3650;

/**
 * Resolve the historical-backfill window: an explicit request value (or the
 * `BROKER_HISTORICAL_SYNC_DAYS` env override) into a SANE positive window, else
 * {@link DEFAULT_HISTORICAL_SYNC_DAYS}. Ported 1:1 from the web
 * `parseHistoricalSyncDays` (MONEY-846): a plain `Number(raw) || 3650` let a
 * NEGATIVE value through (`Number("-5") === -5`, truthy) → a `fromDate` in the
 * FUTURE that silently disabled the backfill. Reject anything not finite and > 0.
 */
export function resolveHistoricalSyncDays(
  raw: string | number | undefined = process.env.BROKER_HISTORICAL_SYNC_DAYS,
  fallback: number = DEFAULT_HISTORICAL_SYNC_DAYS,
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Injectable IO seam (mirrors getJobStatus's `deps`). `@usemoney/services` runs
 * its suite as ESM (no `require.cache` prisma injection), so tests pass a fake
 * prisma via `deps`. Production omits it → the shared client is used.
 */
export interface StartSyncDeps {
  prisma?: typeof prisma;
}

/** The resolved facts the caller needs to build + publish a SyncJobMessage. */
export interface StartedSyncJob {
  jobId: string;
  broker: BrokerType;
}

/**
 * Best-effort BROKER_SYNC tracking row (mirrors the web `trackBrokerJob`): a
 * failed insert must NEVER block the publish — the worker updates the row by
 * jobId via updateMany (a no-op without a pre-existing row) and the 15-min
 * stale-job cutoff reaps any orphan left if the subsequent publish throws.
 */
async function trackSyncJob(
  db: typeof prisma,
  userId: string,
  jobId: string,
): Promise<void> {
  try {
    await db.backgroundJob.create({
      data: {
        jobId,
        userId,
        jobType: "BROKER_SYNC",
        status: "PENDING",
        progress: 0,
        queuedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn(
      { err, jobId, userId },
      "trackSyncJob: row create failed (continuing)",
    );
  }
}

/**
 * Verify ONE connection is a syncable target for `userId`, then create its
 * tracking row. Gate (mirrors + tightens syncBrokerDataAction):
 *   - missing / not owned          → NOT_FOUND (404)
 *   - ZERODHA_CONNECT (token-only) → code-less failure (400) — the paid Connect
 *                                    app never syncs data (Personal app owns it).
 *   - status ≠ CONNECTED           → code-less failure (400) — the API declines to
 *                                    enqueue a doomed sync. NOTE: the web action
 *                                    publishes regardless and the worker skips a
 *                                    dead connection (same net effect); the API
 *                                    gates earlier per the "verify … is ACTIVE"
 *                                    contract.
 */
async function verifyAndTrackConnection(
  db: typeof prisma,
  userId: string,
  connectionId: string,
): Promise<ServiceResult<StartedSyncJob>> {
  const conn = await db.brokerConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, userId: true, broker: true, status: true },
  });
  // IDOR guard: findUnique is by bare id (the row may belong to ANY user).
  // Strict !== so a nullish caller id never matches a nullish row id.
  if (!conn || conn.userId !== userId) {
    return {
      success: false,
      error: "Broker connection not found",
      code: "NOT_FOUND",
    };
  }
  if (conn.broker === "ZERODHA_CONNECT") {
    return { success: false, error: "Connect app does not sync data." };
  }
  if (conn.status !== "CONNECTED") {
    return {
      success: false,
      error: "Broker connection is not active. Please re-authenticate.",
    };
  }
  const jobId = randomUUID();
  await trackSyncJob(db, userId, jobId);
  return { success: true, data: { jobId, broker: conn.broker as BrokerType } };
}

/**
 * Start a day-data broker sync for ONE owned connection. Mirrors
 * syncBrokerDataAction's publish path: verify + track a BROKER_SYNC job. The
 * caller builds the SyncJobMessage ({ jobId, userId, broker, brokerConnectionId,
 * dataTypes }) and publishes it, then returns { jobId } for /v1/jobs/:jobId.
 */
export async function startBrokerSync(
  userId: string,
  connectionId: string,
  deps: StartSyncDeps = {},
): Promise<ServiceResult<StartedSyncJob>> {
  const db = deps.prisma ?? prisma;
  try {
    return await verifyAndTrackConnection(db, userId, connectionId);
  } catch (error) {
    logger.error(
      { error, userId, connectionId },
      "startBrokerSync service error",
    );
    return {
      success: false,
      error: "Failed to start broker sync",
      code: "INTERNAL",
    };
  }
}

export interface StartedHistoricalSyncJob extends StartedSyncJob {
  historicalDays: number;
}

/**
 * Start a HISTORICAL tradebook backfill for ONE owned connection. Same verify +
 * track as startBrokerSync, plus it resolves the `historicalDays` window
 * (explicit request `days` clamped by {@link resolveHistoricalSyncDays}, else the
 * env / default). The caller publishes a SyncJobMessage carrying `historicalDays`
 * — the async WORKER backfill path, mirroring `syncBrokerDataAction({
 * historicalPending })`, NOT the inline `syncHistoricalTradebook` the web
 * `syncHistoricalTradesAction` runs synchronously (a large inline backfill would
 * risk the serverless request timeout — the reason sync went worker-only).
 */
export async function startHistoricalSync(
  userId: string,
  connectionId: string,
  opts: { days?: number } = {},
  deps: StartSyncDeps = {},
): Promise<ServiceResult<StartedHistoricalSyncJob>> {
  const db = deps.prisma ?? prisma;
  try {
    const verified = await verifyAndTrackConnection(db, userId, connectionId);
    if (!verified.success) return verified;
    const historicalDays = resolveHistoricalSyncDays(opts.days);
    return { success: true, data: { ...verified.data, historicalDays } };
  } catch (error) {
    logger.error(
      { error, userId, connectionId },
      "startHistoricalSync service error",
    );
    return {
      success: false,
      error: "Failed to start historical sync",
      code: "INTERNAL",
    };
  }
}

export interface StartedAllSyncJob extends StartedSyncJob {
  connectionId: string;
}

/**
 * Fan out a day-data sync across ALL of the user's syncable connections
 * (mirrors syncAllBrokersAction). ZERODHA_CONNECT (token-only) and non-CONNECTED
 * connections are filtered in the query — the API declines to enqueue a doomed
 * sync (the web action publishes for every connection and the worker skips the
 * dead ones; same net effect). Zero connections → an empty `jobs` list (the
 * caller returns 200, mirroring the web `results: []`), NOT an error. Each entry
 * carries its pre-created jobId + connectionId so the caller publishes one
 * SyncJobMessage per connection.
 */
export async function startAllBrokerSyncs(
  userId: string,
  deps: StartSyncDeps = {},
): Promise<ServiceResult<{ jobs: StartedAllSyncJob[] }>> {
  const db = deps.prisma ?? prisma;
  try {
    const connections = await db.brokerConnection.findMany({
      where: {
        userId,
        broker: { not: "ZERODHA_CONNECT" },
        status: "CONNECTED",
      },
      select: { id: true, broker: true },
    });
    const jobs: StartedAllSyncJob[] = [];
    for (const conn of connections) {
      const jobId = randomUUID();
      await trackSyncJob(db, userId, jobId);
      jobs.push({
        jobId,
        broker: conn.broker as BrokerType,
        connectionId: conn.id,
      });
    }
    return { success: true, data: { jobs } };
  } catch (error) {
    logger.error({ error, userId }, "startAllBrokerSyncs service error");
    return {
      success: false,
      error: "Failed to start broker syncs",
      code: "INTERNAL",
    };
  }
}
