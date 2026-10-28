/**
 * Pure response-shaping for the cron product-sync route.
 *
 * Extracted from `./route.ts` so the success-payload shape can be unit-tested
 * against the REAL exported symbol instead of an inline copy. Auth lives in the
 * shared, already-tested `@usemoney/security/cron-auth` (`verifyCronAuth`).
 *
 * @see apps/web/__tests__/api/cron-sync-products.test.ts
 */

/** Success body returned by GET /api/cron/sync-products. */
export function formatCronSyncResponse(
  synced: number,
  errors: string[]
): { success: true; synced: number; errors: string[]; timestamp: string } {
  return {
    success: true,
    synced,
    errors,
    timestamp: new Date().toISOString(),
  };
}
