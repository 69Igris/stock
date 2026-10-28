/**
 * Broker-sync processor — PURE orchestration logic (no Prisma / crypto / I/O).
 *
 * Side-effect-free helpers extracted out of `sync.ts` so they can be unit-tested
 * by importing the REAL symbol (no shadow copies) without booting a Prisma
 * client, the `@usemoney/security` decryptor, the broker adapters, Datadog, or
 * `createNotification` at module load. `sync.ts` imports and CALLS every export
 * here, so the production code path and the tests execute the SAME code. Mirrors
 * the worker precedent `import-logic.ts` / `pairing-logic.ts`.
 *
 * The old inline `processor-sync.test.ts` re-implemented the ENTIRE ~340-line
 * `processSync` (connection filter, credential guard, per-type payload building,
 * computed-field math, status stamping) and asserted the COPY — a textbook shadow.
 * Every payload/stat/where-clause it checked now flows through these exports.
 *
 * What lives here (all side-effect-free):
 *   - `hasCompleteCreds`           — the encryptedCreds/iv/authTag presence gate.
 *   - `isTokenExpired`             — connection.tokenExpiry < now.
 *   - `is403Error`                 — 403 / Forbidden classification (→ NEEDS_REAUTH).
 *   - `startOfTodayIST`            — UTC instant of today 00:00 Asia/Kolkata
 *                                    (caps the historical-backfill toDate so it
 *                                    excludes today → no day-sync/backfill dup).
 *   - `shouldSendSyncEmail` /
 *     `shouldSendHistoricalEmail`  — the two best-effort email-gate decisions.
 *   - `resolveEffectiveUserId` / `resolveEffectiveBrokerUserId`.
 *   - `buildHoldingCreateData`     — Holding row (investedValue / currentValue math,
 *                                    qty defaults).
 *   - `computePositionDerived` / `buildPositionCreateData` — Position row
 *                                    (buyValue / sellValue / netValue / totalPnl /
 *                                    div-by-zero-guarded pnlPercentage, DAY|NET).
 *   - `buildTradeUpsertArgs`       — Trade upsert `{ where, update, create }`.
 *   - `buildMutualFundUpsertArgs`  — MutualFund upsert `{ where, update, create }`.
 *   - `buildSyncJobStatusUpdate`   — BackgroundJob PROCESSING / COMPLETED / FAILED
 *                                    patch (the `{ success, synced, total }` result).
 *   - `accumulateSynced`           — fold a per-type count into the running stats.
 *
 * @see workers/src/processors/sync.ts (caller)
 * @see apps/web/__tests__/workers/processor-sync.test.ts (tests the real exports)
 */

import type { BrokerType, Prisma } from "@prisma/client";
import type {
  HoldingData,
  PositionData,
  TradeData,
  MutualFundData,
  SyncJobMessage,
} from "@usemoney/types";
import { getSyncBucketCount } from "@usemoney/types/pubsub";

/**
 * The per-row write context shared by every payload builder. `broker` is the
 * Prisma `BrokerType` enum (the value `sync.ts` reads off the connection), so the
 * built payloads slot straight into Prisma create/upsert args without a cast.
 */
export interface SyncWriteContext {
  userId: string;
  broker: BrokerType;
  brokerUserId: string;
}

/** Data types a sync job can pull; default is holdings+positions+trades. */
export type SyncDataType = "holdings" | "positions" | "trades" | "mutualFunds";

/** Default data types synced when the job omits an explicit list. */
export const DEFAULT_SYNC_DATA_TYPES: readonly SyncDataType[] = [
  "holdings",
  "positions",
  "trades",
  // MONEY-837: scheduled syncs must refresh mutual funds too (Zerodha-only;
  // other adapters return []).
  "mutualFunds",
];

// ── Connection selection / credential / token guards ──────────────────

// MONEY-1379: `buildConnectionWhere` USED to live here as well as in
// `packages/services/src/broker-sync.service.ts`, with a docblock on each
// calling itself "the single source". Nothing imported this copy — both real
// call sites are in the service — so the two could have drifted apart silently
// on a rule whose wildcard branch is a cross-user data hazard. Deleted; the
// service's copy is the only one, and it is where the Zerodha-only default set
// (`SYNC_ENABLED_BROKERS`) now lives.

// ── MONEY-841: scheduled-sync shard fan-out + idempotency ──────────────

/**
 * Is THIS message the cron's fan-out trigger? True only for a scheduled bulk
 * sync that has NOT yet been sharded — i.e. `isScheduled` and no `syncBucket`.
 * Such a message must FAN OUT (publish one message per bucket) instead of
 * serial-looping every connection in a single worker invocation. A scheduled
 * message that already carries a `syncBucket` is a per-shard leaf (do the sync);
 * a user-scoped message (concrete userId, no isScheduled) is also a leaf.
 */
export function isFanoutTrigger(data: {
  isScheduled?: boolean;
  syncBucket?: number;
}): boolean {
  return !!data.isScheduled && !Number.isInteger(data.syncBucket);
}

/**
 * Build the per-bucket fan-out messages for the scheduled sync. One message per
 * shard `[0, count)`, each a copy of the trigger's job fields (broker /
 * dataTypes / historicalDays etc. are preserved so the weekly historical cron
 * still backfills) PLUS `{ syncBucket: N }`. The trigger's own `jobId` /
 * `syncBucket` are dropped — each leaf gets a fresh jobId so their BackgroundJob
 * rows don't collide. `count` defaults to {@link getSyncBucketCount}.
 *
 * Pure (no Pub/Sub I/O): `processSync` maps the result onto `publishSyncJob`,
 * which keeps this unit-testable without booting the Pub/Sub client.
 */
export function buildShardFanoutMessages(
  trigger: SyncJobMessage,
  newJobId: (bucket: number) => string,
  count: number = getSyncBucketCount(),
): SyncJobMessage[] {
  // Strip the fields that must NOT carry into a leaf: the trigger's jobId
  // (each leaf gets its own) and any stray syncBucket (we set it per message).
  const { jobId: _jobId, syncBucket: _syncBucket, ...rest } = trigger;
  const messages: SyncJobMessage[] = [];
  for (let bucket = 0; bucket < count; bucket++) {
    messages.push({ ...rest, jobId: newJobId(bucket), syncBucket: bucket });
  }
  return messages;
}

/**
 * MONEY-841 idempotency window: a BROKER_SYNC job that started this recently is
 * considered "in flight"; a new sync for the same scope is skipped so a Pub/Sub
 * redelivery (at-least-once) or an overlapping cron tick can't double-sync the
 * same user. 15 min comfortably covers a slow historical backfill yet self-heals
 * a job that died without reaching a terminal status.
 */
export const SYNC_IN_FLIGHT_WINDOW_MS = 15 * 60 * 1000;

/** The `queuedAt >= cutoff` boundary for the in-flight BROKER_SYNC lookup. */
export function inFlightSyncCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - SYNC_IN_FLIGHT_WINDOW_MS);
}

/**
 * Pure predicate: given the count of NON-terminal (PENDING/PROCESSING)
 * BROKER_SYNC BackgroundJob rows for a user — EXCLUDING the current job's own
 * row — is a sync already in flight? `> 0` ⇒ skip. Kept pure (the caller runs the
 * Prisma count with the {@link inFlightSyncCutoff} window) so the skip rule is
 * unit-testable without a DB.
 */
export function isSyncInFlight(otherActiveJobCount: number): boolean {
  return otherActiveJobCount > 0;
}

/** A broker connection whose credential triple is fully present (non-null). */
export type ConnectionWithCreds<T> = T & {
  encryptedCreds: string;
  iv: string;
  authTag: string;
};

/**
 * True only when all three credential fields are present (else the connection is
 * skipped). A type predicate so callers that branch on it get the cred fields
 * NARROWED to non-null `string` — preserving the narrowing the old inline
 * `if (!encryptedCreds || !iv || !authTag) continue;` provided before extraction.
 */
export function hasCompleteCreds<
  T extends {
    encryptedCreds: string | null;
    iv: string | null;
    authTag: string | null;
  },
>(connection: T): connection is ConnectionWithCreds<T> {
  return !!(connection.encryptedCreds && connection.iv && connection.authTag);
}

/**
 * True when the connection's access token has expired (`tokenExpiry` in the
 * past). Zerodha resets daily at midnight, so an expired connection must be
 * skipped + flagged NEEDS_REAUTH rather than hammered with 403s. A null/absent
 * expiry is treated as "not known to be expired".
 */
export function isTokenExpired(
  connection: { tokenExpiry?: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (!connection.tokenExpiry) return false;
  return new Date(connection.tokenExpiry) < now;
}

/**
 * Classify a fetch error as an expired-token 403. The adapter surfaces auth
 * failures as a `403` / `Forbidden` message; on match the processor stops the
 * remaining data types for that connection and marks it NEEDS_REAUTH.
 */
export function is403Error(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return msg.includes("403") || msg.includes("Forbidden");
}

// ── Historical-backfill window ─────────────────────────────────────────

/** India Standard Time offset from UTC, in minutes (UTC+5:30, no DST). */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * MONEY-846: the UTC instant of "today 00:00 in Asia/Kolkata" — i.e. the start
 * of the current IST trading day, expressed as a UTC `Date`.
 *
 * Used to CAP the historical-backfill `toDate` so the backfill covers only
 * up-to-yesterday: today's fills already arrive via the day `/trades` sync
 * (carrying the REAL broker `trade_id`), whereas the backoffice/historical
 * endpoint can omit `trade_id` and forces a SYNTHESIZED `bo:` id — the same fill
 * would otherwise land twice (two different unique keys → two Trade rows) on any
 * connect-day the user traded today.
 *
 * Timezone-independent: derived purely from the UTC epoch + the fixed IST offset
 * (never the host's local time), so the result is identical on a UTC server, an
 * IST laptop, or a US CI runner.
 */
export function startOfTodayIST(now: Date = new Date()): Date {
  const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
  // Shift the absolute instant into "IST wall-clock space", floor to the IST
  // day boundary, then shift back to the real UTC instant of that midnight.
  const istWallClock = now.getTime() + offsetMs;
  const istMidnight = Math.floor(istWallClock / 86_400_000) * 86_400_000;
  return new Date(istMidnight - offsetMs);
}

/** Wildcard syncs use each connection's own userId; otherwise the job's userId. */
export function resolveEffectiveUserId(
  jobUserId: string,
  connectionUserId: string | null | undefined,
): string {
  return jobUserId === "*" ? connectionUserId || jobUserId : jobUserId;
}

/** A connection's brokerUserId, or the empty-string sentinel when absent. */
export function resolveEffectiveBrokerUserId(
  brokerUserId: string | null | undefined,
): string {
  return brokerUserId || "";
}

// ── Holdings ──────────────────────────────────────────────────────────

/** The Holding row the worker writes per synced holding. */
export type HoldingCreateData = Prisma.HoldingUncheckedCreateInput;

/**
 * Build the Holding-create payload. `investedValue = totalQuantity * averagePrice`
 * and `currentValue = totalQuantity * lastPrice`; the optional t1/pledged/
 * collateral quantities default to 0. (Mirrors the production mapping exactly.)
 */
export function buildHoldingCreateData(
  h: HoldingData,
  ctx: SyncWriteContext,
  now: Date = new Date(),
): HoldingCreateData {
  return {
    userId: ctx.userId,
    broker: ctx.broker,
    brokerUserId: ctx.brokerUserId,
    symbol: h.symbol,
    tradingSymbol: h.tradingSymbol,
    isin: h.isin,
    exchange: h.exchange,
    quantity: h.totalQuantity,
    averagePrice: h.averagePrice,
    currentPrice: h.lastPrice,
    closePrice: h.closePrice,
    investedValue: h.totalQuantity * h.averagePrice,
    currentValue: h.totalQuantity * h.lastPrice,
    unrealizedPnL: h.pnl,
    pnlPercentage: h.pnlPercentage,
    dayChange: h.dayChange,
    dayChangePerc: h.dayChangePerc,
    t1Quantity: h.t1Quantity || 0,
    pledgedQuantity: h.pledgedQuantity || 0,
    collateralQty: h.collateralQty || 0,
    lastUpdated: now,
  };
}

// ── Positions ─────────────────────────────────────────────────────────

/** Derived position values the worker stores alongside the raw fields. */
export interface PositionDerived {
  buyValue: number;
  sellValue: number;
  netValue: number;
  totalPnl: number;
  pnlPercentage: number;
  positionType: "DAY" | "NET";
}

/**
 * Compute a position's derived values.
 *
 * `buyValue = buyQuantity * buyPrice`, `sellValue = sellQuantity * sellPrice`,
 * `netValue = |netQuantity| * lastPrice`, `totalPnl = realizedPnl + unrealizedPnl`.
 * `pnlPercentage = (totalPnl / buyValue) * 100`, GUARDED against divide-by-zero:
 * a zero (or non-positive) buyValue yields 0 instead of NaN/±Infinity — which
 * would otherwise poison portfolio P&L aggregates. `positionType` collapses to
 * the `"DAY" | "NET"` enum (anything other than `"DAY"` → `"NET"`).
 */
export function computePositionDerived(p: PositionData): PositionDerived {
  const buyValue = p.buyQuantity * p.buyPrice;
  const sellValue = p.sellQuantity * p.sellPrice;
  const netValue = Math.abs(p.netQuantity) * p.lastPrice;
  const totalPnl = p.realizedPnl + p.unrealizedPnl;
  const pnlPercentage = buyValue > 0 ? (totalPnl / buyValue) * 100 : 0;
  return {
    buyValue,
    sellValue,
    netValue,
    totalPnl,
    pnlPercentage,
    positionType: p.positionType === "DAY" ? "DAY" : "NET",
  };
}

/** The Position row the worker writes per synced position. */
export type PositionCreateData = Prisma.PositionUncheckedCreateInput;

/** Build the Position-create payload (raw fields + `computePositionDerived`). */
export function buildPositionCreateData(
  p: PositionData,
  ctx: SyncWriteContext,
  now: Date = new Date(),
): PositionCreateData {
  const d = computePositionDerived(p);
  return {
    userId: ctx.userId,
    broker: ctx.broker,
    brokerUserId: ctx.brokerUserId,
    symbol: p.symbol,
    tradingSymbol: p.tradingSymbol,
    exchange: p.exchange,
    segment: p.segment,
    positionType: d.positionType,
    productType: p.productType,
    buyQuantity: p.buyQuantity,
    sellQuantity: p.sellQuantity,
    netQuantity: p.netQuantity,
    buyPrice: p.buyPrice,
    sellPrice: p.sellPrice,
    averagePrice: p.averagePrice,
    lastPrice: p.lastPrice,
    buyValue: d.buyValue,
    sellValue: d.sellValue,
    netValue: d.netValue,
    realizedPnl: p.realizedPnl,
    unrealizedPnl: p.unrealizedPnl,
    totalPnl: d.totalPnl,
    pnlPercentage: d.pnlPercentage,
    multiplier: p.multiplier,
    tradeDate: now,
    lastUpdated: now,
  };
}

// ── Trades (upsert) ───────────────────────────────────────────────────

/** The synced-trade fields shared by the upsert's create + update branches. */
export interface TradeSyncCommon {
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  tradeType: string;
  productType: string;
  quantity: number;
  price: number;
  tradeValue: number;
  tradeDate: Date;
  tradeTime: Date;
  sourceType: "SYNCED";
  isEditable: false;
  needsRepairing: true;
}

/**
 * The `{ where, update, create }` arg bag for a synced-trade upsert, typed with
 * Prisma's own input types so it slots straight into `prisma.trade.upsert(args)`.
 */
export interface TradeUpsertArgs {
  where: Prisma.TradeWhereUniqueInput;
  update: Prisma.TradeUncheckedUpdateInput;
  create: Prisma.TradeUncheckedCreateInput;
}

/**
 * Build the idempotent Trade upsert args. Keyed on the
 * `(userId, broker, brokerUserId, brokerTradeId)` compound unique so a re-sync of
 * the same broker trade converges to one row. Both branches stamp
 * `sourceType: "SYNCED"`, `isEditable: false`, `needsRepairing: true`; the create
 * branch additionally carries `brokerName` (lowercased broker), `brokerOrderId`
 * and `brokerTradeId`.
 */
export function buildTradeUpsertArgs(
  t: TradeData,
  ctx: SyncWriteContext,
): TradeUpsertArgs {
  const common: TradeSyncCommon = {
    symbol: t.symbol,
    tradingSymbol: t.tradingSymbol,
    exchange: t.exchange,
    segment: t.segment,
    tradeType: t.transactionType,
    productType: t.productType,
    quantity: t.quantity,
    price: t.price,
    tradeValue: t.tradeValue,
    tradeDate: t.tradeTime,
    tradeTime: t.tradeTime,
    sourceType: "SYNCED",
    isEditable: false,
    needsRepairing: true,
  };
  return {
    where: {
      userId_broker_brokerUserId_brokerTradeId: {
        userId: ctx.userId,
        broker: ctx.broker,
        brokerUserId: ctx.brokerUserId,
        brokerTradeId: t.tradeId,
      },
    },
    update: common,
    create: {
      ...common,
      userId: ctx.userId,
      broker: ctx.broker,
      brokerUserId: ctx.brokerUserId,
      brokerName: ctx.broker.toLowerCase(),
      brokerTradeId: t.tradeId,
      brokerOrderId: t.orderId,
    },
  };
}

// ── Mutual funds (upsert) ─────────────────────────────────────────────

/** The synced-MF fields shared by the upsert's create + update branches. */
export interface MutualFundSyncCommon {
  schemeName: string;
  isin: string;
  units: number;
  averageNav: number;
  currentNav: number;
  investedAmount: number;
  investedValue: number;
  currentValue: number;
  unrealizedGain: number;
  pnl: number;
  pnlPercentage: number;
}

/**
 * The `{ where, update, create }` arg bag for a synced-MF upsert, typed with
 * Prisma's own input types so it slots straight into `prisma.mutualFund.upsert(args)`.
 */
export interface MutualFundUpsertArgs {
  where: Prisma.MutualFundWhereUniqueInput;
  update: Prisma.MutualFundUncheckedUpdateInput;
  create: Prisma.MutualFundUncheckedCreateInput;
}

/**
 * Build the idempotent MutualFund upsert args. Keyed on the
 * `(userId, broker, brokerUserId, folioNumber, tradingSymbol)` compound unique.
 * `tradingSymbol` falls back to `schemeName` when the broker gives no ISIN, and
 * `folio`/`folioNumber` default to the empty string — getting the dedup key
 * stable here prevents the same holding splitting into duplicate rows on re-sync.
 */
export function buildMutualFundUpsertArgs(
  mf: MutualFundData,
  ctx: SyncWriteContext,
  now: Date = new Date(),
): MutualFundUpsertArgs {
  const tradingSymbol = mf.isin || mf.schemeName;
  const folio = mf.folio || "";
  const common: MutualFundSyncCommon = {
    schemeName: mf.schemeName,
    isin: mf.isin,
    units: mf.units,
    averageNav: mf.averageNav,
    currentNav: mf.currentNav,
    investedAmount: mf.investedValue,
    investedValue: mf.investedValue,
    currentValue: mf.currentValue,
    unrealizedGain: mf.pnl,
    pnl: mf.pnl,
    pnlPercentage: mf.pnlPercentage,
  };
  return {
    where: {
      userId_broker_brokerUserId_folioNumber_tradingSymbol: {
        userId: ctx.userId,
        broker: ctx.broker,
        brokerUserId: ctx.brokerUserId,
        folioNumber: folio,
        tradingSymbol,
      },
    },
    update: { ...common, lastUpdated: now },
    create: {
      ...common,
      userId: ctx.userId,
      broker: ctx.broker,
      brokerUserId: ctx.brokerUserId,
      tradingSymbol,
      folioNumber: folio,
      folio,
    },
  };
}

// ── Stats + job lifecycle ─────────────────────────────────────────────

/**
 * Fold a per-data-type count into the running `{ stats, total }` accumulator.
 * Pure: returns a NEW stats object + the bumped total (the caller owns the
 * mutable variables). A data type whose fetch FAILED is simply never folded in,
 * so it stays absent from `syncStats` (the per-type error-isolation contract).
 */
export function accumulateSynced(
  stats: Record<string, number>,
  total: number,
  dataType: string,
  count: number,
): { stats: Record<string, number>; total: number } {
  return {
    stats: { ...stats, [dataType]: count },
    total: total + count,
  };
}

/** The `result` payload stamped onto a COMPLETED broker-sync BackgroundJob. */
export interface SyncJobResult {
  success: boolean;
  /**
   * Per-data-type record counts.
   *
   * MONEY-1157: declared `Record<string, number>`, but the value `sync.ts`
   * actually passes is `SyncedCounts` from `@usemoney/services`
   * (`{ holdings?: number; positions?: number; trades?: number; mutualFunds?: number }`).
   * That is an INTERFACE, so it gets no implicit index signature and was never
   * assignable to a `Record<string, …>` — `tsc` reported it (TS2322) while
   * `tsup`/esbuild, which does not type-check, shipped the correct runtime.
   *
   * WIDENED, not narrowed: the union still accepts everything the old
   * declaration accepted (`accumulateSynced` returns `Record<string, number>`,
   * and the no-connections path passes `{}`), so no existing caller or test can
   * stop compiling. Described structurally rather than importing `SyncedCounts`
   * to keep this module free of `@usemoney/services`.
   */
  synced: Partial<Record<SyncDataType, number>> | Record<string, number>;
  total: number;
}

/** Terminal/working states a broker-sync BackgroundJob moves through. */
export type SyncJobStatus = "PROCESSING" | "COMPLETED" | "FAILED";

/**
 * Build the BackgroundJob status patch for a broker sync.
 *
 * PROCESSING stamps `startedAt`; COMPLETED stamps `completedAt`, pins
 * `progress = 100` and carries the `{ success, synced, total }` result; FAILED
 * stamps `completedAt` and the `errorMessage`. Centralized so the three call
 * sites in `sync.ts` cannot drift (mirrors `import-logic.buildJobStatusUpdate`,
 * but with the sync-shaped result instead of the import result).
 */
export function buildSyncJobStatusUpdate(
  status: SyncJobStatus,
  extra?: { result?: SyncJobResult; errorMessage?: string },
): Record<string, unknown> {
  if (status === "PROCESSING") {
    return { status, startedAt: new Date() };
  }
  if (status === "COMPLETED") {
    return {
      status,
      completedAt: new Date(),
      progress: 100,
      ...(extra?.result ? { result: extra.result } : {}),
    };
  }
  // FAILED
  return {
    status,
    completedAt: new Date(),
    ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
  };
}

// ── Email-gate decisions ───────────────────────────────────────────────

/**
 * MONEY-846: decide whether to send the day's "Sync Complete" summary email.
 *
 * Inputs are the flags `processSync` already has on the job message. The rules
 * (extracted verbatim from the inline `if (syncEmail && !historicalEmail …)`):
 *   - `syncEmail` must be set — only the brokers-page manual Sync requests it;
 *     the silent refresh + scheduled-cron paths leave it unset and stay quiet.
 *   - `historicalEmail` must NOT be set — on a fresh connect the historical-import
 *     email already covers that run, so the day-summary is suppressed to avoid
 *     double-emailing.
 *   - the wildcard (`userId === "*"`) bulk/system sync never emails an individual.
 */
export function shouldSendSyncEmail(input: {
  syncEmail?: boolean;
  historicalEmail?: boolean;
  userId: string;
}): boolean {
  return !!input.syncEmail && !input.historicalEmail && input.userId !== "*";
}

/**
 * MONEY-846: decide whether to send the "historical import complete" email.
 *
 * Only the connect-time job sets `historicalEmail` (the weekly catch-up cron does
 * not, so it stays quiet). The wildcard system sync never emails an individual.
 * `hasErrors` gates out an all-error backfill — that path already notified the
 * user via `surfaceHistoricalErrors` (NEEDS_REAUTH + an in-app alert), so a
 * cheerful "import complete" on top would be contradictory.
 */
export function shouldSendHistoricalEmail(input: {
  historicalEmail?: boolean;
  userId: string;
  hasErrors: boolean;
}): boolean {
  return !!input.historicalEmail && input.userId !== "*" && !input.hasErrors;
}
