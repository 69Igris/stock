/**
 * Consent Routes (MONEY-402 mobile-parity / MONEY-505 / 501)
 *
 * The SEBI IA Reg 18(9) AI-advisory consent ledger. Thin wrappers over
 * consent.service — every read/write is IDOR-scoped to the caller. GET composes
 * the current-version acceptance status + the full exportable ledger (mirrors
 * the /v1/me two-read composition); POST records a version-stamped, idempotent
 * accept. Demo-session bypass is a web-cookie concern (stripped — the API is
 * always a real authenticated caller).
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
  getBrokerConsentStatus,
  getConsentRecords,
  recordBrokerConsent,
} from "@usemoney/services";

const consentRoutes = new Hono<AppContext>();

const RecordSchema = z.object({ source: z.string().max(64).optional() });

/**
 * GET /v1/consent
 * Current AI-advisory acceptance status + the caller's full consent ledger
 * (newest first). The status is best-effort; the ledger is authoritative.
 */
consentRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  const status = await getBrokerConsentStatus(userId);
  const records = await getConsentRecords(userId);
  if (!records.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, records.error), 500);
  }

  return c.json(
    success({
      accepted: status.success ? status.data.accepted : false,
      version: status.success ? status.data.version : null,
      records: records.data,
    }),
  );
});

/**
 * POST /v1/consent
 * Record AI-advisory consent (version-stamped, idempotent per version).
 * Optional `{ source }` marks where it was captured.
 */
consentRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(RecordSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid consent payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await recordBrokerConsent(userId, parsed.data.source);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

export default consentRoutes;
