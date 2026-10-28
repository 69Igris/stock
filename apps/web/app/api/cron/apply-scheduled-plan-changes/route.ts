/**
 * MONEY-482 / MONEY-1062 (W1-B): apply scheduled plan changes — thin cron route.
 *
 * Runs hourly via Cloud Scheduler. Transport only: constant-time CRON_SECRET
 * auth then delegate to the `@usemoney/services` scheduled-plan-changes service,
 * which flips every subscription whose `scheduledEffectiveAt` has arrived to its
 * scheduled target (FREE cancel, or a Dodo `changePlan` tier/cycle downgrade).
 * The product-catalog lookup (`getDodoProductInfo`) is bound inside the service
 * (both live in `@usemoney/services` since W1).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` via the shared `verifyCronAuth`
 * (timing-safe; fails closed when CRON_SECRET is unset), mirroring
 * /api/cron/sync-products.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@usemoney/security/cron-auth";
import { applyScheduledChanges } from "@usemoney/services/scheduled-plan-changes";
import { paymentsLogger as logger } from "@usemoney/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request.headers.get("authorization"));
  if (!auth.ok) {
    if (auth.status === 503) {
      console.error("CRON_SECRET not configured");
      return NextResponse.json({ error: "Not configured" }, { status: 503 });
    }
    logger.warn("Unauthorized cron apply-scheduled-plan-changes attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  logger.info("Cron apply-scheduled-plan-changes started");

  const result = await applyScheduledChanges();

  logger.info(
    `Cron apply-scheduled-plan-changes completed: ${result.applied} applied, ${result.skipped} skipped, ${result.errors.length} errors`
  );

  return NextResponse.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString(),
  });
}
