/**
 * Consent Service (MONEY-402 mobile-parity / MONEY-505 / 501)
 *
 * The SEBI IA Reg 18(9) AI-advisory consent ledger, extracted from
 * `apps/web/lib/actions/consent.ts`. Three user-scoped operations:
 *   - {@link getBrokerConsentStatus} — has the caller accepted the CURRENT
 *     AI-advisory disclosure version? (gates the broker-connect flow),
 *   - {@link recordBrokerConsent} — version-stamped, idempotent-per-version
 *     accept, and
 *   - {@link getConsentRecords} — the full, exportable ledger (501).
 *
 * STRIPPED (web/next glue): `auth()` + `resolveUserId` (the route owns auth and
 * passes the resolved Mongo id) and the `isDemoSession` bypass (a web-cookie
 * concern — the API is always a real authenticated caller).
 *
 * IDOR: every read/write is scoped to the caller's `userId`.
 *
 * @see packages/services/src/consent-logic.ts (version + mapper pure seam)
 * @see packages/services/__tests__/consent-service.test.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  AI_ADVISORY_VERSION,
  normalizeConsentSource,
  toConsentRecordView,
  type ConsentRecordView,
} from "./consent-logic";

/**
 * Injectable IO seam. `@usemoney/services` runs its suite as ESM, so tests pass
 * a fake prisma via `deps` rather than module-mocking.
 */
export interface ConsentServiceDeps {
  prisma?: typeof prisma;
}

/**
 * Has the caller accepted the CURRENT AI-advisory disclosure version? Scoped to
 * `userId` + `kind: AI_ADVISORY` + the current version.
 */
export async function getBrokerConsentStatus(
  userId: string,
  deps: ConsentServiceDeps = {},
): Promise<ServiceResult<{ accepted: boolean; version: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const record = await db.consentRecord.findFirst({
      where: { userId, kind: "AI_ADVISORY", version: AI_ADVISORY_VERSION },
      select: { id: true },
    });
    return {
      success: true,
      data: { accepted: !!record, version: AI_ADVISORY_VERSION },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get broker consent status service error");
    return { success: false, error: "Failed to fetch consent status" };
  }
}

/**
 * Record AI-advisory consent for the caller (version-stamped, idempotent per
 * version — a second accept of the same version is a no-op success).
 */
export async function recordBrokerConsent(
  userId: string,
  source?: string,
  deps: ConsentServiceDeps = {},
): Promise<ServiceResult<{ accepted: true; version: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const existing = await db.consentRecord.findFirst({
      where: { userId, kind: "AI_ADVISORY", version: AI_ADVISORY_VERSION },
      select: { id: true },
    });
    if (!existing) {
      await db.consentRecord.create({
        data: {
          userId,
          kind: "AI_ADVISORY",
          version: AI_ADVISORY_VERSION,
          source: normalizeConsentSource(source),
        },
      });
    }
    return {
      success: true,
      data: { accepted: true, version: AI_ADVISORY_VERSION },
      message: "Consent recorded",
    };
  } catch (error) {
    logger.error({ error, userId }, "Record broker consent service error");
    return { success: false, error: "Failed to record consent" };
  }
}

/**
 * All consent records for the caller, newest first — the exportable audit trail
 * (Reg 18(9) / 501). IDOR: the WHERE is always scoped to `userId`.
 */
export async function getConsentRecords(
  userId: string,
  deps: ConsentServiceDeps = {},
): Promise<ServiceResult<ConsentRecordView[]>> {
  const db = deps.prisma ?? prisma;
  try {
    const records = await db.consentRecord.findMany({
      where: { userId },
      orderBy: { acceptedAt: "desc" },
      select: { kind: true, version: true, acceptedAt: true, source: true },
    });
    return { success: true, data: records.map(toConsentRecordView) };
  } catch (error) {
    logger.error({ error, userId }, "Get consent records service error");
    return { success: false, error: "Failed to fetch consent records" };
  }
}
