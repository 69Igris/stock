/**
 * Platform Config Service
 *
 * Key-value store for platform-wide configuration backed by the PlatformConfig model.
 * Used for feature toggles, billing mode switches, and other runtime config.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";

// ── Types ──────────────────────────────────────────────────────────

export type ProPlanMode = "lifetime" | "annual";

interface PlatformConfigEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Read a config entry by key.
 */
export async function getConfig(
  key: string,
): Promise<ServiceResult<PlatformConfigEntry | null>> {
  try {
    const entry = await prisma.platformConfig.findUnique({ where: { key } });
    if (!entry) {
      return { success: true, data: null };
    }
    return {
      success: true,
      data: {
        key: entry.key,
        value: entry.value,
        updatedAt: entry.updatedAt.toISOString(),
      },
    };
  } catch (error) {
    logger.error({ error, key, action: "getConfig" }, "Get config error");
    return { success: false, error: "Failed to read config" };
  }
}

/**
 * Upsert a config entry.
 */
export async function setConfig(
  key: string,
  value: unknown,
): Promise<ServiceResult<void>> {
  try {
    await prisma.platformConfig.upsert({
      where: { key },
      update: { value: value as any },
      create: { key, value: value as any },
    });
    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, key, action: "setConfig" }, "Set config error");
    return { success: false, error: "Failed to write config" };
  }
}

/**
 * Get the current Pro plan billing mode.
 * @deprecated Use PostHog billing flags (getBillingFlagsAction) instead.
 * Kept for backwards compatibility with existing callers.
 * Defaults to "lifetime".
 */
export async function getProPlanMode(): Promise<ProPlanMode> {
  try {
    const result = await getConfig("pro_plan_mode");
    if (result.success && result.data) {
      const val = result.data.value as { mode?: string } | null;
      if (val?.mode === "annual") return "annual";
    }
    return "lifetime";
  } catch {
    return "lifetime";
  }
}

/**
 * Set the Pro plan billing mode.
 */
export async function setProPlanMode(
  mode: ProPlanMode,
): Promise<ServiceResult<void>> {
  return setConfig("pro_plan_mode", { mode });
}
