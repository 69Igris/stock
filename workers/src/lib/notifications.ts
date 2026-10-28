/**
 * Notification helper for workers.
 * Creates notifications directly via Prisma after job completion.
 */

import { prisma } from "@usemoney/database";
import type { NotificationType, Prisma } from "@prisma/client";

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * The set of NotificationType enum values accepted by createNotification.
 * Kept in sync with the Prisma `NotificationType` enum.
 */
export const VALID_NOTIFICATION_TYPES: NotificationType[] = [
  "RESEARCH_COMPLETE",
  "SYNC_COMPLETE",
  "IMPORT_COMPLETE",
  "PAIRING_COMPLETE",
  "SYSTEM",
];

/**
 * Type guard: true when `type` is one of the VALID_NOTIFICATION_TYPES.
 */
export function isValidNotificationType(
  type: string,
): type is NotificationType {
  return VALID_NOTIFICATION_TYPES.includes(type as NotificationType);
}

/**
 * Validates the required fields for a notification before it is persisted.
 * Mirrors the implicit contract of `createNotification`: userId, type, title
 * and message must all be present and non-blank.
 */
export function validateNotificationInput(data: Partial<NotificationInput>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!data.userId || data.userId.trim() === "") {
    errors.push("userId is required");
  }
  if (!data.type) {
    errors.push("type is required");
  }
  if (!data.title || data.title.trim() === "") {
    errors.push("title is required");
  }
  if (!data.message || data.message.trim() === "") {
    errors.push("message is required");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Casts optional notification metadata to a Prisma-compatible JSON value.
 * `undefined` (no metadata) is preserved as `undefined` so Prisma omits the
 * column rather than writing JSON `null`.
 */
export function castMetadata(
  metadata: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  return (metadata ?? undefined) as Prisma.InputJsonValue | undefined;
}

/**
 * Write one notification and REPORT whether the row was actually created
 * (MONEY-1238).
 *
 * `createNotification` below returns `Promise<void>` and swallows its own write
 * failure, which is the right default for the ~20 job processors that call it:
 * a notification is a courtesy and must never fail the job it is reporting on.
 * But a caller that then records "notified" from the mere ABSENCE of a throw is
 * recording a fiction — the write can fail and the caller cannot tell. The
 * dead-letter consumer did exactly that, and its failure mode is the expensive
 * one: it committed the Pub/Sub dedupe marker COMPLETED on the strength of a
 * notification that never landed, so the redelivery that could have healed it
 * was skipped as a duplicate.
 *
 * This is ADDITIVE on purpose. Every existing caller keeps the exact
 * fire-and-forget contract it was written against; only a caller that needs the
 * outcome opts in here. Same swallow-and-log behaviour — the difference is that
 * the swallow is now VISIBLE in the return value.
 *
 * @returns `true` when the row was created, `false` when the write failed.
 */
export async function tryCreateNotification(
  data: NotificationInput,
): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: {
        userId: data.userId,
        type: data.type,
        title: data.title,
        message: data.message,
        metadata: castMetadata(data.metadata),
      },
    });
    return true;
  } catch (error) {
    // Log but don't throw - notification failure shouldn't fail the job
    console.error("[notifications] Failed to create notification:", error);
    return false;
  }
}

/**
 * Write one notification, best-effort.
 *
 * Contract deliberately UNCHANGED (`Promise<void>`, never throws): every job
 * processor in `workers/src/processors/` calls this and none of them can act on
 * a failure. Use {@link tryCreateNotification} when the outcome is load-bearing.
 */
export async function createNotification(
  data: NotificationInput,
): Promise<void> {
  await tryCreateNotification(data);
}
