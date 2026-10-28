/**
 * Broker Sync Processor
 *
 * Syncs data from connected brokers (holdings, positions, trades, mutual funds).
 *
 * MONEY-837 (rich-unify): the decrypt → fetch → persist orchestration now lives
 * in the SHARED @usemoney/services `syncBrokerConnections`, which fetches through
 * the RICH @usemoney/core broker CLIENT layer (full Normalized* shapes). This
 * fixes the worker's prior field-loss — it used the leaner core ADAPTERS and
 * silently dropped holding sector/name/MTF, position labels/m2m, MF metadata.
 * The web in-app sync runs the exact same shared path. This processor is now a
 * thin wrapper: job lifecycle + Datadog metrics + cache invalidation +
 * notification. (`./sync-logic` retains the BackgroundJob status helper; its
 * legacy per-row builders are no longer on the live path.)
 */

import {
  type SyncJobMessage,
  getTopicName,
  PUBSUB_TOPICS,
} from "@usemoney/types";
import { prisma } from "@usemoney/database";
import {
  clearBrokerSyncCache,
  clearBrokerConnectionCache,
} from "@usemoney/core";
import { randomUUID } from "node:crypto";
import { getPubSubClient } from "@usemoney/pubsub/client";
import {
  syncBrokerConnections,
  syncHistoricalTradebook,
  buildSyncEmailCounts,
  historicalConnectionsWithErrors,
  isScheduledShard,
  type SyncEmailCounts,
} from "@usemoney/services";
import { metrics } from "@usemoney/datadog";
import {
  sendEmail,
  getEffectivePreferences,
  shouldSendEmail,
  buildUnsubscribeUrl,
} from "@usemoney/email";
import {
  HistoricalSyncCompleteEmail,
  SyncCompleteEmail,
} from "@usemoney/email/templates";
import { createElement } from "react";
import { createNotification } from "../lib/notifications";
import { processPairing } from "./pairing";
import {
  buildSyncJobStatusUpdate,
  DEFAULT_SYNC_DATA_TYPES,
  startOfTodayIST,
  shouldSendSyncEmail,
  shouldSendHistoricalEmail,
  isFanoutTrigger,
  buildShardFanoutMessages,
  isSyncInFlight,
  inFlightSyncCutoff,
} from "./sync-logic";

export async function processSync(data: SyncJobMessage): Promise<void> {
  const {
    userId,
    brokerConnectionId,
    broker,
    dataTypes = [...DEFAULT_SYNC_DATA_TYPES],
    historicalDays,
    historicalEmail,
    syncEmail,
  } = data;
  // Cron-triggered bulk syncs don't pre-create a BackgroundJob, so jobId may be
  // absent — generate one for status/logging rather than rejecting the message.
  const jobId = data.jobId || randomUUID();

  if (!userId) {
    throw new Error("Missing required field: userId");
  }

  console.log(
    `Processing sync job ${jobId} for user ${userId} (types: ${dataTypes.join(", ")}${broker ? `, broker: ${broker}` : ""})`,
  );

  // userId "*" means "all users" — only scheduled jobs use the wildcard.
  if (userId === "*" && !data.isScheduled) {
    console.warn(
      `Sync job ${jobId}: wildcard userId without isScheduled flag - treating as scheduled`,
    );
  }

  // MONEY-841 STAGE 1 — cron fan-out. The daily scheduler publishes ONE
  // un-sharded wildcard message (isScheduled, no syncBucket). Instead of this
  // single worker serial-looping EVERY connection (the ~1-2k scaling cliff at
  // 580+ free users), fan it out into one message per shard and return — each
  // shard message comes back through this same processor as a STAGE-2 leaf
  // ({ syncBucket: N }) and syncs only that bucket, in parallel across workers.
  if (isFanoutTrigger(data)) {
    await fanOutScheduledSync(data, jobId);
    return;
  }

  // MONEY-841 — idempotency guard. Pub/Sub is at-least-once, and the
  // market-hours + evening crons can overlap a slow run, so a redelivered /
  // overlapping message for a scope already syncing would double-sync (wasted
  // broker API calls + churn). Skip when another non-terminal BROKER_SYNC job
  // for THIS user is already in flight (within the 15-min self-healing window).
  // The wildcard fan-out trigger already returned above; only concrete-user
  // leaves (per-user sync, manual Sync, connect, per-shard fan-out child) reach
  // here. A per-shard child's userId is "*", so the guard is scoped per-user and
  // naturally skips the shard case (each shard is its own bounded slice).
  if (userId !== "*") {
    const active = await prisma.backgroundJob.count({
      where: {
        userId,
        jobType: "BROKER_SYNC",
        status: { in: ["PENDING", "PROCESSING"] },
        queuedAt: { gte: inFlightSyncCutoff() },
        jobId: { not: jobId },
      },
    });
    if (isSyncInFlight(active)) {
      console.log(
        `Sync job ${jobId}: skipped — a BROKER_SYNC for user ${userId} is already in flight`,
      );
      await prisma.backgroundJob.updateMany({
        where: { jobId },
        data: buildSyncJobStatusUpdate("COMPLETED", {
          result: { success: true, synced: {}, total: 0 },
        }),
      });
      return;
    }
  }

  await prisma.backgroundJob.updateMany({
    where: { jobId },
    data: buildSyncJobStatusUpdate("PROCESSING"),
  });

  try {
    // Shared orchestration: resolve connections → decrypt → rich client fetch →
    // persist → lastSync + syncLog (per connection), with the ZERODHA_CONNECT
    // skip, token-expiry skip, and 403 → NEEDS_REAUTH short-circuit built in.
    const result = await syncBrokerConnections({
      userId,
      broker: broker as Parameters<typeof syncBrokerConnections>[0]["broker"],
      connectionId: brokerConnectionId,
      dataTypes: dataTypes as Parameters<
        typeof syncBrokerConnections
      >[0]["dataTypes"],
      // MONEY-841: a STAGE-2 shard leaf carries the bucket; the service narrows
      // the connection query to `where.syncBucket = N`.
      syncBucket: data.syncBucket,
    });

    if (!result.success) {
      throw new Error(result.error);
    }

    const { synced, total, connectionCount, perConnection } = result.data;

    // MONEY-1379: a shard that matched NO connection is now a SUCCESS rather
    // than a throw. 58 of every 64 leaves are in that state (prod, 2026-09-11:
    // 9 connections across 6 buckets), and each one used to throw "No broker
    // connections found" → 500 → five Pub/Sub redeliveries → dead letter → an
    // in-app notification to the founder, for work that did not need doing.
    //
    // There is deliberately NO early return here, and that is a correction
    // rather than an omission. An earlier version of this fix returned as soon
    // as `connectionCount === 0`, which read as a harmless optimisation — it
    // skipped a metrics loop over an empty array and two cheap queries. But it
    // also skipped the per-bucket RE-PAIRING below, which is not about broker
    // connections at all: it re-pairs every user in the shard whose trades are
    // flagged `needsRepairing`, INCLUDING trades that arrived by CSV import.
    // A user with no syncable connection still has trades to pair, and they
    // would simply have stopped being paired, silently. The few queries saved
    // were not worth coupling pairing to broker-connection selection.
    if (connectionCount === 0) {
      console.log(
        `Sync job ${jobId}: ${
          isScheduledShard(data.syncBucket)
            ? `shard ${data.syncBucket}`
            : `user ${userId}`
        } matched no syncable connections — nothing to sync (pairing still runs)`,
      );
    }

    // Datadog metrics, derived from the per-connection results.
    for (const conn of perConnection) {
      for (const [dataType, count] of Object.entries(conn.synced)) {
        if (typeof count === "number") {
          metrics.increment("broker.sync.records", count, {
            broker: conn.broker,
            dataType,
          });
        }
      }
      for (const dataType of Object.keys(conn.errors)) {
        metrics.increment("broker.sync.failure", 1, {
          broker: conn.broker,
          dataType,
        });
      }
    }

    // MONEY-837: optional historical tradebook backfill (slow async polling).
    // Connect-time job = full backfill; weekly catch-up = recent window. A
    // failure here must NOT fail the day's-data sync that already succeeded.
    //
    // MONEY-880: the backfill uses Zerodha's Console /backoffice tradebook
    // endpoint, which the free Personal app used in qa/preview/local CANNOT
    // access (403) — and that 403 is then misread as an expired token, looping
    // the connection into NEEDS_REAUTH. The PAID prod app has the entitlement.
    // So run historical in PRODUCTION ONLY by default: the qa worker
    // (NODE_ENV=qa, which also serves preview deploys) and local
    // (NODE_ENV=development) skip it automatically — no per-env/per-preview
    // config. `HISTORICAL_TRADEBOOK_SYNC=on|off` is an explicit override (e.g.
    // force-on once QA has a backoffice-capable app, or force-off in prod).
    const histOverride = (
      process.env.HISTORICAL_TRADEBOOK_SYNC || ""
    ).toLowerCase();
    const historicalSyncEnabled =
      histOverride === "on"
        ? true
        : histOverride === "off"
          ? false
          : process.env.NODE_ENV === "production";
    if (!historicalSyncEnabled && historicalDays && historicalDays > 0) {
      console.log(
        `Sync job ${jobId}: historical backfill SKIPPED (env=${process.env.NODE_ENV || "development"}, override=${histOverride || "none"})`,
      );
    }
    if (historicalSyncEnabled && historicalDays && historicalDays > 0) {
      try {
        // MONEY-846: cap the backfill window's END to the START OF TODAY (IST),
        // so historical covers only up-to-YESTERDAY. Today's fills already arrive
        // via the day `/trades` sync above (real broker trade_id); if the
        // historical backoffice pull ALSO covered today it could re-emit the same
        // fill with a SYNTHESIZED `bo:` id (different unique key) → the trade
        // double-counts into two Trade rows on every connect-day the user traded.
        const toDate = startOfTodayIST();
        const fromDate = new Date(
          Date.now() - historicalDays * 24 * 60 * 60 * 1000,
        );
        const hist = await syncHistoricalTradebook({
          userId,
          broker: broker as Parameters<
            typeof syncHistoricalTradebook
          >[0]["broker"],
          connectionId: brokerConnectionId,
          fromDate,
          toDate,
          // MONEY-1379: a shard leaf must backfill ITS OWN bucket. Without this
          // the wildcard userId selected every connection on the platform, so
          // the weekly catch-up did connectionCount x 64 backfills instead of
          // connectionCount. See SyncHistoricalTradesParams.syncBucket.
          syncBucket: data.syncBucket,
        });
        if (hist.success) {
          console.log(
            `Sync job ${jobId}: historical backfill synced ${hist.data.synced} trades (${historicalDays}d)`,
          );
          for (const conn of hist.data.perConnection) {
            if (conn.synced > 0) {
              metrics.increment("broker.sync.records", conn.synced, {
                broker: conn.broker,
                dataType: "historicalTrades",
              });
            }
          }
          // MONEY-839/848: syncHistoricalTradebook SWALLOWS per-connection
          // failures (returns success:true, synced:0), so a backfill that
          // ERRORED — e.g. a ZERODHA persist throw or a token-expired 2nd
          // account — otherwise logs identically to "no history found". Surface
          // the real reason (errors only, not benign skips) so the count problem
          // is visible, AND mark the affected connection NEEDS_REAUTH + notify
          // the user so a silently-dead 2nd account becomes actionable.
          const histErrors = historicalConnectionsWithErrors(
            hist.data.perConnection,
          );
          if (histErrors.length > 0) {
            console.warn(
              `Sync job ${jobId}: historical backfill errored on ${histErrors.length} connection(s): ${histErrors
                .map((c) => `${c.broker}=${c.error}`)
                .join("; ")}`,
            );
            for (const c of histErrors) {
              metrics.increment("broker.sync.failure", 1, {
                broker: c.broker,
                dataType: "historicalTrades",
              });
            }
            if (userId !== "*") {
              await surfaceHistoricalErrors(userId, jobId, histErrors).catch(
                (err) =>
                  console.warn(
                    `Sync job ${jobId}: surfacing historical errors failed:`,
                    err,
                  ),
              );
            }
          }
          // MONEY-839/848: tell the user the connect-time historical import is
          // done (the connect email promised it). Only the connect-time job sets
          // historicalEmail; the weekly catch-up cron does not, so it stays
          // quiet. MONEY-848: even synced===0 gets a GRACEFUL email — but only
          // when nothing errored (an all-error backfill already notified above).
          // The template now words 0 as "connected & synced", never a confusing
          // "0 trades".
          if (
            shouldSendHistoricalEmail({
              historicalEmail,
              userId,
              hasErrors: histErrors.length > 0,
            })
          ) {
            await sendHistoricalEmail(userId, broker, hist.data.synced).catch(
              (err) =>
                console.warn(
                  `Sync job ${jobId}: historical email failed:`,
                  err,
                ),
            );
          }
        }
      } catch (histErr) {
        console.warn(`Sync job ${jobId}: historical backfill failed:`, histErr);
        metrics.increment("broker.sync.failure", 1, {
          broker: broker || "ALL",
          dataType: "historicalTrades",
        });
      }
    }

    // MONEY-840: re-trigger FIFO trade pairing IN-PROCESS now that BOTH the
    // day-data sync and the (optional) historical backfill have finished, so the
    // tradebook reads CLOSED/OPEN/PARTIAL + realised P&L from the persisted
    // PairedTradeView (not the stored Trade.status, which sync never sets). The
    // worker's processPairing does a full FIFO re-pair over the user's complete
    // history, so a freshly-synced sell pairs against older buys. Wrapped in its
    // OWN try/catch — mirroring the historical-backfill error boundary — because
    // the data sync has ALREADY succeeded: a pairing failure must NOT fail the
    // job (it would otherwise re-deliver the whole sync and re-write rows). The
    // wildcard "all-users" sync skips pairing — each user is paired by their own
    // user-scoped sync. processPairing is called with ONLY { jobId, userId };
    // it self-enriches internally (corp-actions) — do not pass extra fields.
    if (userId !== "*") {
      try {
        await processPairing({ jobId: randomUUID(), userId });
      } catch (pairErr) {
        console.warn(`Sync job ${jobId}: post-sync pairing failed:`, pairErr);
        metrics.increment("trade.pairing.failure", 1, {
          broker: broker || "ALL",
          trigger: "sync",
        });
      }
    } else if (data.syncBucket != null) {
      // MONEY-841: a sharded scheduled sync covers MANY users, so the per-user
      // trigger above is skipped (userId "*"). Re-pair each user in this bucket
      // whose trades actually changed this run (persist stamps
      // needsRepairing=true), so passive users who only get the daily cron still
      // get fresh pairing. Bounded by bucket size; each pair is best-effort.
      try {
        const bucketUsers = await prisma.brokerConnection.findMany({
          where: { syncBucket: data.syncBucket },
          select: { userId: true },
          distinct: ["userId"],
        });
        const ids = bucketUsers.map((c) => c.userId);
        const due = ids.length
          ? await prisma.trade.findMany({
              where: { userId: { in: ids }, needsRepairing: true },
              select: { userId: true },
              distinct: ["userId"],
            })
          : [];
        for (const { userId: uid } of due) {
          await processPairing({ jobId: randomUUID(), userId: uid }).catch(
            (e) =>
              console.warn(
                `Sync job ${jobId}: bucket pairing failed for ${uid}:`,
                e,
              ),
          );
        }
        if (due.length > 0) {
          console.log(
            `Sync job ${jobId}: bucket ${data.syncBucket} re-paired ${due.length} user(s)`,
          );
        }
      } catch (pairErr) {
        console.warn(
          `Sync job ${jobId}: bucket ${data.syncBucket} pairing query failed:`,
          pairErr,
        );
      }
    }

    console.log(`Sync job ${jobId} completed: ${total} records synced`);

    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: buildSyncJobStatusUpdate("COMPLETED", {
        result: { success: true, synced, total },
      }),
    });

    // Invalidate cache + notify (skip system-level wildcard syncs).
    if (userId && userId !== "*") {
      // MONEY-846: clearBrokerSyncCache busts the DATA reads (dashboard,
      // positions, holdings, trades, mutual-funds) — a superset of the per-type
      // clears. But a successful sync ALSO mutates the connection row itself
      // (lastSync stamp, status→CONNECTED, errorMessage cleared), so the
      // brokers-page connection list (the `brokers` cache module) must be busted
      // too — clearBrokerSyncCache does NOT cover it. Mirror the disconnect path,
      // which clears brokers via clearBrokerConnectionCache.
      await Promise.all([
        clearBrokerSyncCache(userId),
        clearBrokerConnectionCache(userId),
      ]).catch((err) =>
        console.warn(`Cache invalidation failed for user ${userId}:`, err),
      );
      await createNotification({
        userId,
        type: "SYNC_COMPLETE",
        title: "Broker Sync Complete",
        message: `Synced ${total} records${broker ? ` from ${broker}` : ""}.`,
        metadata: { jobId, totalSynced: total },
      });

      // MONEY-848: the brokers-page manual Sync sets syncEmail → send a "Sync
      // Complete" summary with per-type counts. Gated under the "sync-complete"
      // email preference. Best-effort: a failure must NOT fail the (succeeded)
      // sync job. Omitted by the silent refresh + scheduled-cron paths (they
      // never set syncEmail). When a historical backfill also ran on the SAME
      // job (connect-time), historicalEmail already covers it, so suppress the
      // day-summary email to avoid double-emailing on a fresh connect.
      if (shouldSendSyncEmail({ syncEmail, historicalEmail, userId })) {
        await sendSyncCompleteEmail(
          userId,
          broker,
          buildSyncEmailCounts(perConnection),
        ).catch((err) =>
          console.warn(`Sync job ${jobId}: sync-complete email failed:`, err),
        );
      }
    }
  } catch (error) {
    console.error(`Sync job ${jobId} failed:`, error);

    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: buildSyncJobStatusUpdate("FAILED", {
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      }),
    });

    throw error;
  }
}

/**
 * MONEY-841 STAGE 1 — fan a scheduled bulk sync out into one Pub/Sub message per
 * shard. Each leaf preserves the trigger's job fields (broker / dataTypes /
 * historicalDays so the weekly historical cron still backfills) and adds
 * `{ syncBucket: N }`; each gets a fresh jobId so their BackgroundJob rows don't
 * collide. Published to the SAME broker-sync topic, so the leaves come back
 * through this processor as STAGE-2 per-shard syncs (handled by the
 * isFanoutTrigger=false branch). Publishes are best-effort per message: one
 * bucket failing to enqueue must not abort the rest of the fan-out.
 *
 * `buildShardFanoutMessages` (pure) builds the payloads; this wrapper just maps
 * them onto the worker Pub/Sub client.
 */
async function fanOutScheduledSync(
  data: SyncJobMessage,
  jobId: string,
): Promise<void> {
  const messages = buildShardFanoutMessages(data, () => randomUUID());
  const pubsub = getPubSubClient();
  const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.BROKER_SYNC));
  let published = 0;
  await Promise.all(
    messages.map((msg) =>
      topic
        .publishMessage({ json: msg })
        .then(() => {
          published++;
        })
        .catch((err) =>
          console.warn(
            `Sync fan-out ${jobId}: bucket ${msg.syncBucket} publish failed:`,
            err,
          ),
        ),
    ),
  );
  console.log(
    `Sync fan-out ${jobId}: published ${published}/${messages.length} shard messages`,
  );
}

/**
 * MONEY-839/848: send the "historical import complete" email after the
 * connect-time backfill finishes. Preference-gated under the same "sync-complete"
 * category as the day's sync; best-effort (the caller swallows + logs failures).
 * When `tradesCount === 0` the template renders a graceful "connected & synced"
 * variant (never a confusing "0 trades") — the connect promise is still kept.
 */
async function sendHistoricalEmail(
  userId: string,
  broker: string | undefined,
  tradesCount: number,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, emailPreferences: true },
  });
  if (!user?.email) return;
  const prefs = getEffectivePreferences(user.emailPreferences);
  if (!shouldSendEmail(prefs, "sync-complete")) return;
  await sendEmail({
    to: user.email,
    subject:
      tradesCount > 0
        ? `${broker ?? "Broker"} Historical Import Complete - UseMoney`
        : `${broker ?? "Broker"} Connected & Synced - UseMoney`,
    unsubscribeUrl: buildUnsubscribeUrl(user.email, "brokerNotifications"),
    react: createElement(HistoricalSyncCompleteEmail, {
      name: user.name || "there",
      brokerName: broker ?? "your broker",
      tradesCount,
      unsubscribeUrl: buildUnsubscribeUrl(user.email, "brokerNotifications"),
    }),
    template: "sync-complete",
  });
}

/**
 * MONEY-848: send the "Sync Complete" summary email for a brokers-page manual
 * Sync (job carried `syncEmail`). Per-type counts come from
 * `buildSyncEmailCounts(perConnection)`. Preference-gated under "sync-complete";
 * best-effort (the caller swallows + logs failures).
 */
async function sendSyncCompleteEmail(
  userId: string,
  broker: string | undefined,
  counts: SyncEmailCounts,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, emailPreferences: true },
  });
  if (!user?.email) return;
  const prefs = getEffectivePreferences(user.emailPreferences);
  if (!shouldSendEmail(prefs, "sync-complete")) return;
  await sendEmail({
    to: user.email,
    subject: `${broker ?? "Broker"} Sync Complete - UseMoney`,
    unsubscribeUrl: buildUnsubscribeUrl(user.email, "brokerNotifications"),
    react: createElement(SyncCompleteEmail, {
      name: user.name || "there",
      brokerName: broker ?? "your broker",
      holdingsCount: counts.holdings,
      positionsCount: counts.positions,
      tradesCount: counts.trades,
      mutualFundsCount: counts.mutualFunds,
      mutualFundsError: counts.mutualFundsError,
      unsubscribeUrl: buildUnsubscribeUrl(user.email, "brokerNotifications"),
    }),
    template: "sync-complete",
  });
}

/**
 * MONEY-848: a historical backfill that ERRORED on a connection (a real
 * fetch/persist failure — NOT a benign skip) used to be invisible: the day's
 * sync had already succeeded, so the only trace was a console.warn. Mark each
 * affected connection NEEDS_REAUTH and drop an in-app notification so the user
 * sees a clear "re-authorise" action (e.g. a token-expired 2nd account). The
 * connection match is scoped by (userId, broker) — best-effort + idempotent.
 */
async function surfaceHistoricalErrors(
  userId: string,
  jobId: string,
  histErrors: { broker: string; brokerUserId: string | null }[],
): Promise<void> {
  for (const c of histErrors) {
    // Scope to the SPECIFIC errored account when its brokerUserId is known, so a
    // healthy 2nd account on the same broker isn't churned into re-auth. Only
    // flip a currently-CONNECTED row (don't overwrite an already-flagged state).
    await prisma.brokerConnection
      .updateMany({
        where: {
          userId,
          broker: c.broker as never,
          status: "CONNECTED",
          ...(c.brokerUserId ? { brokerUserId: c.brokerUserId } : {}),
        },
        data: {
          status: "NEEDS_REAUTH",
          errorMessage:
            "Historical trade import failed — please re-authorise this connection.",
        },
      })
      .catch(() => {});
  }
  const brokers = Array.from(new Set(histErrors.map((c) => c.broker)));
  await createNotification({
    userId,
    // No SYNC_FAILED in the NotificationType enum; SYSTEM is the worker's
    // accepted catch-all for an actionable operational alert.
    type: "SYSTEM",
    title: "Action needed: re-authorise your broker",
    message: `We couldn't import full trade history for ${brokers.join(", ")}. Please re-authorise the connection from the Brokers page.`,
    metadata: { jobId, brokers, event: "historical_sync_error" },
  });
}
