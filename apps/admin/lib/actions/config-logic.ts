/**
 * Pure logic for config actions (extracted from config.ts).
 *
 * The config server actions all share the same "unwrap a ServiceResult,
 * throwing the error on failure" handling. That logic is extracted here so it
 * can be unit tested without importing the action (which drags Clerk + the
 * services package). The actions in config.ts call these helpers.
 *
 * @see apps/admin/__tests__/actions/config.test.ts
 */

import type { ServiceResult } from "@usemoney/services";

/**
 * Processes the result from a getConfig service call.
 * Throws on failure, returns the data on success.
 */
export function processGetConfigResult<T>(result: ServiceResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/**
 * Processes the result from a setConfig service call.
 * Throws on failure.
 */
export function processSetConfigResult(result: ServiceResult<unknown>): void {
  if (!result.success) throw new Error(result.error);
}

/**
 * Processes the result from a setProPlanMode service call.
 * Throws on failure.
 */
export function processSetProPlanModeResult(
  result: ServiceResult<unknown>,
): void {
  if (!result.success) throw new Error(result.error);
}
