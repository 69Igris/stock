/**
 * Trade Import Routes (MONEY-1062, mobile parity)
 *
 * Async CSV/XLSX text import + import-history management for the mobile client.
 * Mirrors apps/web/lib/actions/{import-job.ts,trade-import.ts}:
 *   POST   /v1/imports              → enqueue an async import → 202 { jobId }
 *   GET    /v1/imports              → import history (limit-capped)
 *   GET    /v1/imports/:batchId     → single import log detail
 *   POST   /v1/imports/:batchId/retry  → retry the failed rows of a batch
 *   DELETE /v1/imports/:batchId     → delete an import batch (+ its trades)
 *
 * SCOPE: text/base64 body only (`csvText`). Multipart file upload + large-file
 * GCS staging are OUT of scope — the ImportJobMessage carries the CSV inline, so
 * the body is capped at ~5MB (the worker path for small files). Ownership is the
 * resolved Mongo `_id` from authMiddleware; the service scopes every query to it.
 *
 * ENCODING (per fileType — the worker branches on it, workers/src/processors/
 * import.ts:109):
 *   - fileType "csv" (default): `csvText` is the RAW CSV TEXT, passed to
 *     parseCSVContent verbatim (after formula-injection sanitisation).
 *   - fileType "xlsx": `csvText` MUST be the BASE64-ENCODED .xlsx file bytes —
 *     the worker's parseXLSXContent (packages/core/src/import/xlsx-parser.ts:18)
 *     decodes base64. Sending raw binary/text as "xlsx" fails the parse.
 *
 * The verify + pollable job-row bookkeeping lives in @usemoney/services
 * (startTradeImport / retryImport / getImportHistory / getImportById /
 * deleteImport); the route owns the `publishImportJob` seam so the published
 * message is asserted at the route contract layer (parity-p2a-contract.test.ts).
 *
 * Orchestrator mount line (apps/api/src/routes/v1/index.ts):
 *   import importsRoutes from "./imports";
 *   v1Routes.route("/imports", importsRoutes);
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
  startTradeImport,
  retryImport,
  getImportHistory,
  getImportById,
  deleteImport,
} from "@usemoney/services";
import { publishImportJob } from "@usemoney/pubsub/publish";
import type { ImportJobMessage } from "@usemoney/types";
import { parseLimit } from "./pagination";

const importsRoutes = new Hono<AppContext>();

// ImportJobMessage carries the CSV inline for the worker; cap the body so a
// giant paste can't blow past the Pub/Sub message limit. ~5MB of text.
const MAX_CSV_BYTES = 5_000_000;

const StartImportSchema = z.object({
  // File content, encoding keyed to `fileType`: RAW CSV TEXT for "csv" (the
  // default), BASE64-encoded .xlsx bytes for "xlsx" (the worker's
  // parseXLSXContent expects base64 — see the file header).
  csvText: z.string().min(1).max(MAX_CSV_BYTES),
  // BrokerFormat hint (zerodha | upstox | groww | angel | dhan | fyers | generic).
  // Kept a lax string so a new format never fails validation; defaults to "generic".
  broker: z.string().min(1).max(40).optional(),
  fileName: z.string().min(1).max(255).optional(),
  // Selects the worker parser AND the required `csvText` encoding (see above).
  fileType: z.enum(["csv", "xlsx"]).optional(),
  brokerConnectionId: z.string().min(1).optional(),
  linkToManual: z.boolean().optional(),
});

/**
 * POST /v1/imports
 * Enqueue an async trade import from inline CSV/XLSX text. Creates the pollable
 * job row, then publishes the ImportJobMessage. Returns 202 { jobId }. G3: the
 * job-row ServiceResult is checked BEFORE publishing — a row-create failure
 * (500) never publishes an untrackable import.
 */
importsRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const parsed = await safeJson(c);
  if (!parsed.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const v = zodParse(StartImportSchema, parsed.data);
  if (!v.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid import body", v.issues),
      400,
    );
  }

  const body = v.data;
  const brokerFormat = body.broker ?? "generic";
  const fileType = body.fileType ?? "csv";

  try {
    const result = await startTradeImport(userId, {
      brokerFormat,
      fileType,
      fileName: body.fileName,
      contentLength: body.csvText.length,
      brokerConnectionId: body.brokerConnectionId,
      linkToManual: body.linkToManual,
    });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    const message: ImportJobMessage = {
      jobId: result.data.jobId,
      userId,
      content: body.csvText,
      brokerFormat,
      fileType,
      ...(body.fileName ? { fileName: body.fileName } : {}),
      ...(body.brokerConnectionId
        ? { brokerConnectionId: body.brokerConnectionId }
        : {}),
      ...(body.linkToManual ? { linkToManual: true } : {}),
    };
    await publishImportJob(message);

    // batchId is minted by the worker during processing, so it is not available
    // at enqueue time — the client polls /v1/jobs/:jobId, whose result carries it.
    return c.json(success({ jobId: result.data.jobId }), 202);
  } catch (err) {
    console.error("Start import error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to start import"),
      500,
    );
  }
});

/**
 * GET /v1/imports
 * Import history for the caller, newest first. `?limit` clamps to [1, 100]
 * (default 50) — the reused getImportHistory service is limit-capped (no deep
 * offset paging), so this returns the most-recent slice.
 */
importsRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const limit = parseLimit(c.req.query("limit"));

  try {
    const result = await getImportHistory(userId, { limit });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Import history error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch import history"),
      500,
    );
  }
});

/**
 * GET /v1/imports/:batchId
 * Full detail for a single import log (ownership-scoped in the service).
 */
importsRoutes.get("/:batchId", async (c) => {
  const userId = c.get("userId");
  const batchId = c.req.param("batchId");

  try {
    const result = await getImportById(userId, batchId);
    if (!result.success) {
      // getImportById has no `code`; its failure is a missing/foreign log (404).
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Import detail error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch import detail"),
      500,
    );
  }
});

/**
 * POST /v1/imports/:batchId/retry
 * Retry the failed rows of a batch (synchronous recreate; mirrors
 * retryFailedImportAction). NOT_FOUND → 404, INTERNAL → 500, "nothing to
 * retry" → 400.
 */
importsRoutes.post("/:batchId/retry", async (c) => {
  const userId = c.get("userId");
  const batchId = c.req.param("batchId");

  try {
    const result = await retryImport(userId, batchId);
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Import retry error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to retry import"),
      500,
    );
  }
});

/**
 * DELETE /v1/imports/:batchId
 * Delete an import batch and its imported trades (blocked if any trade is
 * broker-synced). deleteImport emits no `code`, so its failure — the synced-block
 * refusal — maps to 400 (a rare DB error also surfaces as 400).
 */
importsRoutes.delete("/:batchId", async (c) => {
  const userId = c.get("userId");
  const batchId = c.req.param("batchId");

  try {
    const result = await deleteImport(userId, batchId);
    if (!result.success) {
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Import delete error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to delete import"),
      500,
    );
  }
});

export default importsRoutes;
