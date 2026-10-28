/**
 * Alerts Service (MONEY-402 / MONEY-408 mobile-parity)
 *
 * User-scoped CRUD for the `Alert` model, extracted from
 * `apps/web/lib/actions/alerts.ts` (which had raw Prisma in the action). The
 * evaluator that FIRES alerts is a separate worker — this covers the
 * user-facing CRUD surface only.
 *
 * STRIPPED (web/next glue): `getAuthenticatedUser` (route owns auth) and the
 * `isDemoSession` short-circuits (demo is a web-cookie concern — the API is
 * always a real authenticated caller).
 *
 * SECURITY:
 *   - IDOR: every read/write is scoped to the caller's `userId`. Update first
 *     confirms ownership (`findFirst { id, userId }`, since a Prisma `update`
 *     would otherwise no-op silently); delete uses `deleteMany { id, userId }`
 *     so a foreign id affects ZERO rows (→ not-found, no cross-user oracle).
 *   - Allow-lists: an invalid `kind` is rejected before the write; channels are
 *     sanitised; cooldown defaults to 60m.
 *
 * @see packages/services/src/alerts-logic.ts (validation + patch pure seams)
 * @see packages/services/__tests__/alerts-service.test.ts
 */

import { prisma } from "@usemoney/database";
import type { Prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  buildAlertUpdatePatch,
  isValidKind,
  normalizeCooldown,
  sanitizeChannels,
  type AlertKind,
  type AlertStatus,
  type AlertUpdateInput,
  type NotifyChannel,
} from "./alerts-logic";

/** An alert row as returned to the client. */
export interface AlertItem {
  id: string;
  kind: AlertKind;
  symbol: string | null;
  conditions: Record<string, unknown>;
  notifyChannels: NotifyChannel[];
  status: AlertStatus;
  lastFiredAt: Date | null;
  cooldownMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAlertInput {
  kind: AlertKind;
  symbol?: string | null;
  conditions: Record<string, unknown>;
  notifyChannels?: NotifyChannel[];
  cooldownMinutes?: number;
}

export type UpdateAlertInput = AlertUpdateInput;

/**
 * Injectable IO seam. `@usemoney/services` runs its suite as ESM, so tests pass
 * a fake prisma via `deps` rather than module-mocking.
 */
export interface AlertsServiceDeps {
  prisma?: typeof prisma;
}

function toAlertItem(row: Record<string, unknown>): AlertItem {
  return {
    id: row.id as string,
    kind: row.kind as AlertKind,
    symbol: (row.symbol as string | null) ?? null,
    conditions: (row.conditions as Record<string, unknown>) ?? {},
    notifyChannels: (row.notifyChannels as NotifyChannel[]) ?? [],
    status: row.status as AlertStatus,
    lastFiredAt: (row.lastFiredAt as Date | null) ?? null,
    cooldownMinutes: (row.cooldownMinutes as number) ?? 0,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

/** List the caller's alerts (active first, newest first). */
export async function listAlerts(
  userId: string,
  deps: AlertsServiceDeps = {},
): Promise<ServiceResult<AlertItem[]>> {
  const db = deps.prisma ?? prisma;
  try {
    const rows = await db.alert.findMany({
      where: { userId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    return { success: true, data: rows.map(toAlertItem) };
  } catch (error) {
    logger.error({ error, userId }, "List alerts service error");
    return { success: false, error: "Failed to fetch alerts" };
  }
}

/** Create an alert for the caller (kind allow-listed, channels sanitised). */
export async function createAlert(
  userId: string,
  input: CreateAlertInput,
  deps: AlertsServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
  if (!isValidKind(input.kind)) {
    return { success: false, error: "Invalid alert kind" };
  }
  const db = deps.prisma ?? prisma;
  try {
    const row = await db.alert.create({
      data: {
        userId,
        kind: input.kind,
        symbol: input.symbol ?? null,
        conditions: input.conditions as Prisma.InputJsonValue,
        notifyChannels: sanitizeChannels(input.notifyChannels),
        cooldownMinutes: normalizeCooldown(input.cooldownMinutes),
      },
      select: { id: true },
    });
    return { success: true, data: { id: row.id } };
  } catch (error) {
    logger.error({ error, userId }, "Create alert service error");
    return { success: false, error: "Failed to create alert" };
  }
}

/** Update the caller's own alert (ownership confirmed before the write). */
export async function updateAlert(
  userId: string,
  alertId: string,
  input: UpdateAlertInput,
  deps: AlertsServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const owned = await db.alert.findFirst({
      where: { id: alertId, userId },
      select: { id: true },
    });
    if (!owned)
      return {
        success: false,
        error: "Alert not found",
        code: "NOT_FOUND",
      };

    const patch = buildAlertUpdatePatch(input);
    await db.alert.update({
      where: { id: alertId },
      data: patch as Prisma.AlertUpdateInput,
    });
    return { success: true, data: { id: alertId } };
  } catch (error) {
    logger.error({ error, userId, alertId }, "Update alert service error");
    return {
      success: false,
      error: "Failed to update alert",
      code: "INTERNAL",
    };
  }
}

/** Delete the caller's own alert (scoped delete → foreign id is a no-op 404). */
export async function deleteAlert(
  userId: string,
  alertId: string,
  deps: AlertsServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const result = await db.alert.deleteMany({
      where: { id: alertId, userId },
    });
    if (result.count === 0) {
      return { success: false, error: "Alert not found", code: "NOT_FOUND" };
    }
    return { success: true, data: { id: alertId } };
  } catch (error) {
    logger.error({ error, userId, alertId }, "Delete alert service error");
    return {
      success: false,
      error: "Failed to delete alert",
      code: "INTERNAL",
    };
  }
}
