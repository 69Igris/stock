"use server";

import { requireAdmin } from "@/lib/auth";
import {
  getConfig,
  setConfig,
  getProPlanMode,
  setProPlanMode,
} from "@usemoney/services";
import type { ProPlanMode } from "@usemoney/services";
import {
  processGetConfigResult,
  processSetConfigResult,
  processSetProPlanModeResult,
} from "./config-logic";

export async function getConfigAction(key: string) {
  await requireAdmin();
  const result = await getConfig(key);
  return processGetConfigResult(result);
}

export async function setConfigAction(key: string, value: unknown) {
  await requireAdmin();
  const result = await setConfig(key, value);
  processSetConfigResult(result);
}

export async function getProPlanModeAction(): Promise<ProPlanMode> {
  await requireAdmin();
  return getProPlanMode();
}

export async function setProPlanModeAction(mode: ProPlanMode) {
  await requireAdmin();
  const result = await setProPlanMode(mode);
  processSetProPlanModeResult(result);
}
