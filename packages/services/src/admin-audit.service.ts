import { prisma, Prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import {
  buildAdminAuditEntry,
  type AdminActionInput,
} from "./admin-audit-logic";

/**
 * Append an entry to the admin audit ledger (AdminAuditLog) — MONEY-867.
 *
 * Call this AFTER the underlying admin mutation succeeds (coupon create/
 * deactivate, plan switch/extend, manual payment-complete, soft-delete, …).
 *
 * Best-effort by design: auditing must NEVER break the write it records, so a
 * persistence failure is swallowed (and logged) rather than thrown.
 */
export async function recordAdminAction(
  input: AdminActionInput,
): Promise<void> {
  try {
    const entry = buildAdminAuditEntry(input);
    await prisma.adminAuditLog.create({
      data: {
        actorEmail: entry.actorEmail,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        diff: entry.diff as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (error) {
    logger.error(
      { error, action: input.action, targetType: input.targetType },
      "recordAdminAction failed (audit entry not written)",
    );
  }
}

export type { AdminActionInput } from "./admin-audit-logic";
