/**
 * MF NAV Propagation Processor (MONEY-1074)
 *
 * Copies fresh MutualFundMaster NAVs into user MutualFund rows so the dashboard's
 * MF value/return reflect current NAV. Delegates all logic to the shared service
 * `propagateMfNavToUserFunds` (@usemoney/services), which the pure
 * `buildMfNavPatch` decision backs. System-level (no userId).
 */

import type { MfNavPropagateMessage } from "@usemoney/types";
import { propagateMfNavToUserFunds } from "@usemoney/services";

export async function processMfNavPropagate(
  data: MfNavPropagateMessage,
): Promise<void> {
  const result = await propagateMfNavToUserFunds(data.batchSize);

  if (result.success) {
    const { scanned, updated, skipped } = result.data;
    console.log(
      `MF NAV propagation completed: scanned=${scanned}, updated=${updated}, skipped=${skipped}`,
    );
  } else {
    // Throw so the route returns 500 and Pub/Sub retries with backoff.
    throw new Error(result.error || "MF NAV propagation failed");
  }
}
