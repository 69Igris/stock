"use server";

/**
 * Alerts - MONEY-408. CRUD + listing for the Alert model.
 *
 * The actual evaluator that fires alerts runs as a worker
 * (`workers/src/processors/alert-evaluator.ts` - follow-up).
 * This action set covers the user-facing CRUD surface that
 * /notifications and per-symbol pages need.
 */

import prisma, { Prisma } from "@usemoney/database";
import { getAuthenticatedUser } from "@/lib/auth";
import { isDemoSession } from "@/lib/demo/session";
import type { ActionResponse } from "@usemoney/validation";

export type AlertKind =
  | "PRICE"
  | "VOLUME"
  | "NEWS"
  | "EARNINGS_DATE"
  | "CORPORATE_ACTION"
  | "CUSTOM"
  | "FLAG_TRANSITION"
  | "DELIVERY_SPIKE"
  | "PLEDGE_INCREASE"
  | "INSIDER_CLUSTER"
  | "MWPL_HIGH"
  | "FII_FLOW_STREAK";

export type AlertStatus = "ACTIVE" | "PAUSED" | "TRIGGERED" | "EXPIRED";

export type NotifyChannel = "IN_APP" | "EMAIL" | "PUSH";

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
  symbol?: string;
  conditions: Record<string, unknown>;
  notifyChannels?: NotifyChannel[];
  cooldownMinutes?: number;
}

export interface UpdateAlertInput {
  alertId: string;
  status?: AlertStatus;
  conditions?: Record<string, unknown>;
  notifyChannels?: NotifyChannel[];
  cooldownMinutes?: number;
}

const VALID_KINDS = new Set<AlertKind>([
  "PRICE",
  "VOLUME",
  "NEWS",
  "EARNINGS_DATE",
  "CORPORATE_ACTION",
  "CUSTOM",
  // MONEY-1204 / 14e.3 — data-engine alert kinds. These read PRECOMPUTED
  // tables only (StockFlag, DailyPrice, ShareholdingPattern, InsiderEvent,
  // MwplDaily, InstitutionalFlow); nothing here scrapes.
  //
  // NOTE: this list is duplicated in three places that do not import each
  // other -- here, apps/web/lib/actions/alerts.ts, and the zod enum in
  // apps/api/src/routes/v1/alerts.ts. Adding a kind to one and not the
  // others makes it creatable on one surface and rejected on another.
  "FLAG_TRANSITION",
  "DELIVERY_SPIKE",
  "PLEDGE_INCREASE",
  "INSIDER_CLUSTER",
  "MWPL_HIGH",
  "FII_FLOW_STREAK",
]);

const VALID_CHANNELS = new Set<NotifyChannel>(["IN_APP", "EMAIL", "PUSH"]);

function sanitizeChannels(c?: NotifyChannel[]): NotifyChannel[] {
  if (!c || c.length === 0) return ["IN_APP"];
  return c.filter((x) => VALID_CHANNELS.has(x));
}

export async function listAlertsAction(): Promise<ActionResponse<AlertItem[]>> {
  if (await isDemoSession()) {
    return { success: true, data: [] };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };
  try {
    const rows = await prisma.alert.findMany({
      where: { userId: user.userId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind as AlertKind,
        symbol: r.symbol,
        conditions: r.conditions as Record<string, unknown>,
        notifyChannels: r.notifyChannels as NotifyChannel[],
        status: r.status as AlertStatus,
        lastFiredAt: r.lastFiredAt,
        cooldownMinutes: r.cooldownMinutes,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function createAlertAction(
  input: CreateAlertInput
): Promise<ActionResponse<{ id: string }>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up to create alerts.",
    };
  }
  if (!VALID_KINDS.has(input.kind)) {
    return { success: false, error: "Invalid alert kind" };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };
  try {
    const row = await prisma.alert.create({
      data: {
        userId: user.userId,
        kind: input.kind,
        symbol: input.symbol ?? null,
        conditions: input.conditions as Prisma.InputJsonValue,
        notifyChannels: sanitizeChannels(input.notifyChannels),
        cooldownMinutes:
          input.cooldownMinutes && input.cooldownMinutes > 0
            ? input.cooldownMinutes
            : 60,
      },
      select: { id: true },
    });
    return { success: true, data: { id: row.id } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function updateAlertAction(
  input: UpdateAlertInput
): Promise<ActionResponse<{ id: string }>> {
  if (await isDemoSession()) {
    return { success: false, error: "Demo mode" };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };
  try {
    // Confirm ownership (Prisma update would silently no-op otherwise)
    const own = await prisma.alert.findFirst({
      where: { id: input.alertId, userId: user.userId },
      select: { id: true },
    });
    if (!own) return { success: false, error: "Alert not found" };

    const updateData: Prisma.AlertUpdateInput = {};
    if (input.status) updateData.status = input.status;
    if (input.conditions) {
      updateData.conditions = input.conditions as Prisma.InputJsonValue;
    }
    if (input.notifyChannels) {
      updateData.notifyChannels = sanitizeChannels(input.notifyChannels);
    }
    if (typeof input.cooldownMinutes === "number") {
      updateData.cooldownMinutes = input.cooldownMinutes;
    }
    await prisma.alert.update({
      where: { id: input.alertId },
      data: updateData,
    });
    return { success: true, data: { id: input.alertId } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function deleteAlertAction(
  alertId: string
): Promise<ActionResponse<{ id: string }>> {
  if (await isDemoSession()) {
    return { success: false, error: "Demo mode" };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };
  try {
    const result = await prisma.alert.deleteMany({
      where: { id: alertId, userId: user.userId },
    });
    if (result.count === 0) {
      return { success: false, error: "Alert not found" };
    }
    return { success: true, data: { id: alertId } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
