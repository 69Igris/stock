/**
 * Broker Routes (MONEY-837)
 *
 * Read + management endpoints for a user's broker connections, for the mobile
 * client. Thin wrappers over @usemoney/services — no broker client logic, no
 * decrypted tokens ever leave the service layer (the service maps rows through
 * a credential-leak-guarded whitelist).
 *
 * Sync *trigger* endpoints (MONEY-1062, mobile parity) publish a broker-sync
 * Pub/Sub job and return a { jobId } the client polls via GET /v1/jobs/:jobId:
 *   POST /:id/sync             → day-data sync of one connection (syncBrokerDataAction)
 *   POST /sync-all             → fan-out day-data sync of all connections (syncAllBrokersAction)
 *   POST /:id/sync-historical  → async historical tradebook backfill (historicalDays)
 * The shared verify + job-row bookkeeping lives in @usemoney/services
 * (startBrokerSync / startAllBrokerSyncs / startHistoricalSync); the route owns
 * the `publishSyncJob` seam (like me.ts owns publishAccountDeletionJob) so the
 * published message is asserted at the route contract layer.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
} from "../../lib/response";
import {
  getBrokerConnections,
  getBrokerConnection,
  deleteBrokerConnection,
  getBrokerSyncStatus,
  getLastSyncTime,
  startBrokerSync,
  startAllBrokerSyncs,
  startHistoricalSync,
  DEFAULT_SYNC_DATA_TYPES,
  updateBrokerAccountName,
  getBrokerDataCounts,
  getActiveBrokerJobs,
} from "@usemoney/services";
import { publishSyncJob } from "@usemoney/pubsub/publish";
import type { SyncJobMessage } from "@usemoney/types";

const brokersRoutes = new Hono<AppContext>();

/**
 * GET /v1/brokers
 * List all broker connections (metadata only) for the authenticated user.
 */
brokersRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getBrokerConnections(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Broker connections fetch error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch broker connections"),
      500,
    );
  }
});

/**
 * GET /v1/brokers/sync-status
 * Sync-eligibility + token state for each active connection.
 * (Registered before /:id so the literal path is not captured as an id.)
 */
brokersRoutes.get("/sync-status", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getBrokerSyncStatus(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Broker sync-status error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch sync status"),
      500,
    );
  }
});

/**
 * GET /v1/brokers/last-sync
 * Most-recent successful sync timestamp across the user's connections (or null).
 */
brokersRoutes.get("/last-sync", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getLastSyncTime(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success({ lastSync: result.data }));
  } catch (err) {
    console.error("Broker last-sync error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch last sync time"),
      500,
    );
  }
});

/**
 * GET /v1/brokers/jobs
 * Whether an in-flight (non-stale, ≤15 min) broker-sync job exists for the user
 * — the "syncing…" indicator poll. Mirrors getActiveBrokerJobsAction (apps/web
 * lib/actions/broker-connection.ts:1331) via the extracted getActiveBrokerJobs
 * service; errors degrade to { active:false, phase:null } (never a poller
 * dead-end). (Registered before /:id so the literal path is not captured.)
 */
brokersRoutes.get("/jobs", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getActiveBrokerJobs(userId);
    if (!result.success) {
      // Defensive — the service maps its own failures to an inactive shape.
      return c.json(success({ active: false, phase: null }));
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Broker jobs error:", err);
    return c.json(success({ active: false, phase: null }));
  }
});

/**
 * GET /v1/brokers/:id
 * A single broker connection (ownership-checked inside the service).
 */
brokersRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");

  try {
    const result = await getBrokerConnection(userId, connectionId);
    if (!result.success) {
      // MONEY-1183 — a DB failure is a 500, not a 404. Both outcomes shared
      // this branch and answered 404, telling the client the row is gone so
      // it stopped retrying a blip that would have succeeded.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Broker connection fetch error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch broker connection"),
      500,
    );
  }
});

/**
 * GET /v1/brokers/:id/counts
 * Per-data-type row counts for one owned connection (holdings/positions/trades/
 * imported/manual/MFs/paired/orders) — the disconnect-confirm dialog's numbers.
 * Mirrors getBrokerDataCountsAction (apps/web lib/actions/broker-connection.ts:1113)
 * via the extracted getBrokerDataCounts service (broker + brokerUserId derived
 * from the owned connection; scoping byte-faithful). Foreign/missing → 404.
 */
brokersRoutes.get("/:id/counts", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");

  try {
    const result = await getBrokerDataCounts(userId, connectionId);
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Broker counts error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch data counts"),
      500,
    );
  }
});

// Body for PATCH /:id — the rename payload. Trim/empty/length rules live in the
// service (mirroring the web action); the zod bound only rejects a non-string
// or an absurd payload before it reaches the service.
const RenameBodySchema = z.object({
  accountName: z.string().max(200),
});

/**
 * PATCH /v1/brokers/:id
 * Rename a broker connection's account label. Body { accountName }. Mirrors
 * updateBrokerAccountNameAction (apps/web lib/actions/broker-connection.ts:777)
 * via the extracted updateBrokerAccountName service — trimmed; empty or >50
 * chars → 400; foreign/missing connection → 404. Returns the stored name.
 */
brokersRoutes.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(RenameBodySchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid rename body",
          validated.issues,
        ),
        400,
      );
    }

    const result = await updateBrokerAccountName(
      userId,
      connectionId,
      validated.data.accountName,
    );
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "VALIDATION") {
        return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Broker rename error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to update account name"),
      500,
    );
  }
});

/**
 * DELETE /v1/brokers/:id
 * Disconnect a broker connection (cascades portfolio rows; ownership-checked).
 */
brokersRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");

  try {
    const result = await deleteBrokerConnection(userId, connectionId);
    if (!result.success) {
      // Missing/foreign connection → 404; a DB error → 500; anything else → 400.
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success({ message: "Broker disconnected" }));
  } catch (err) {
    console.error("Broker disconnect error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to disconnect broker"),
      500,
    );
  }
});

// ── Async sync triggers (MONEY-1062) ────────────────────────────────────────
//
// Each handler: verify + create the pollable job row via @usemoney/services,
// then build + publish a SyncJobMessage (mirroring the web action's publishSyncJob
// call) and return 202 { jobId }. G3: the ServiceResult is checked BEFORE the
// publish, so a failed gate (missing / foreign / ZERODHA_CONNECT / inactive)
// never publishes. Codes: NOT_FOUND → 404, INTERNAL → 500, code-less → 400.

/**
 * Default day-data types (mirrors syncBrokerDataAction's default arg). Built
 * per-request (NOT at module top level) so importing DEFAULT_SYNC_DATA_TYPES
 * never has to be spread at load time — a fresh copy each call keeps the
 * SyncJobMessage.dataTypes mutable.
 */
const dayDataTypes = (): SyncJobMessage["dataTypes"] => [
  ...DEFAULT_SYNC_DATA_TYPES,
];

// Optional { days? } body for /sync-historical (positive int; absent → env/default).
const HistoricalBodySchema = z.object({
  days: z.number().int().min(1).max(3650).optional(),
});

/**
 * POST /v1/brokers/sync-all
 * Fan-out a day-data sync across every syncable connection. Publishes one job per
 * connection (per-connection publish result reported, mirroring the web
 * Promise.allSettled). Zero connections → an empty jobs list (still 202).
 * (Registered before /:id/… so "sync-all" is never captured as an :id.)
 */
brokersRoutes.post("/sync-all", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await startAllBrokerSyncs(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    const jobs: Array<{
      broker: string;
      connectionId: string;
      jobId: string;
      success: boolean;
      error?: string;
    }> = [];
    for (const job of result.data.jobs) {
      const message: SyncJobMessage = {
        jobId: job.jobId,
        userId,
        broker: job.broker,
        brokerConnectionId: job.connectionId,
        dataTypes: dayDataTypes(),
      };
      try {
        await publishSyncJob(message);
        jobs.push({
          broker: job.broker,
          connectionId: job.connectionId,
          jobId: job.jobId,
          success: true,
        });
      } catch (pubErr) {
        // One connection's publish failure must not sink the whole fan-out — its
        // tracking row is reaped as stale; report it per-connection.
        console.error("sync-all publish error:", pubErr);
        jobs.push({
          broker: job.broker,
          connectionId: job.connectionId,
          jobId: job.jobId,
          success: false,
          error: "Failed to publish sync job",
        });
      }
    }

    return c.json(success({ jobs }), 202);
  } catch (err) {
    console.error("Broker sync-all error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to sync brokers"),
      500,
    );
  }
});

/**
 * POST /v1/brokers/:id/sync
 * Trigger a day-data sync of one owned, ACTIVE connection. Returns 202 { jobId }.
 */
brokersRoutes.post("/:id/sync", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");

  try {
    const result = await startBrokerSync(userId, connectionId);
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    const message: SyncJobMessage = {
      jobId: result.data.jobId,
      userId,
      broker: result.data.broker,
      brokerConnectionId: connectionId,
      dataTypes: dayDataTypes(),
    };
    await publishSyncJob(message);

    return c.json(success({ jobId: result.data.jobId }), 202);
  } catch (err) {
    console.error("Broker sync error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to sync broker"),
      500,
    );
  }
});

/**
 * POST /v1/brokers/:id/sync-historical
 * Trigger an async historical tradebook backfill (worker path). Body { days? }
 * clamps the window (absent → BROKER_HISTORICAL_SYNC_DAYS / default). Returns
 * 202 { jobId }. An empty/absent body is allowed; a PRESENT-but-invalid body 400s.
 */
brokersRoutes.post("/:id/sync-historical", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("id");

  // Empty body → default window; a present body must be a valid { days? }.
  let days: number | undefined;
  const parsed = await safeJson(c);
  if (parsed.ok) {
    const v = zodParse(HistoricalBodySchema, parsed.data ?? {});
    if (!v.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid request body", v.issues),
        400,
      );
    }
    days = v.data.days;
  }

  try {
    const result = await startHistoricalSync(userId, connectionId, { days });
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    const message: SyncJobMessage = {
      jobId: result.data.jobId,
      userId,
      broker: result.data.broker,
      brokerConnectionId: connectionId,
      dataTypes: dayDataTypes(),
      historicalDays: result.data.historicalDays,
    };
    await publishSyncJob(message);

    return c.json(success({ jobId: result.data.jobId }), 202);
  } catch (err) {
    console.error("Broker historical sync error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to sync historical trades"),
      500,
    );
  }
});

export default brokersRoutes;
