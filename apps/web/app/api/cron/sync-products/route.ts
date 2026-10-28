import { NextRequest, NextResponse } from "next/server";
import { syncDodoProducts } from "@usemoney/services/product-sync";
import { paymentsLogger as logger } from "@usemoney/logger";
import { verifyCronAuth } from "@usemoney/security/cron-auth";
import { formatCronSyncResponse } from "./route-logic";

// Cloud Scheduler hits this at runtime with a Bearer token. Skip Next.js's
// static-detection pass so the GET handler isn't evaluated at build (which
// would `console.error("CRON_SECRET not configured")` on the build console).
// Mirrors the existing declaration on /api/cron/apply-scheduled-plan-changes.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // MONEY-592: constant-time CRON_SECRET verification (was a timing-unsafe `!==`).
  const auth = verifyCronAuth(request.headers.get("authorization"));
  if (!auth.ok) {
    if (auth.status === 503) {
      console.error("CRON_SECRET not configured");
      return NextResponse.json({ error: "Not configured" }, { status: 503 });
    }
    logger.warn("Unauthorized cron sync attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  logger.info("Cron product sync started");

  const result = await syncDodoProducts();

  logger.info(
    `Cron product sync completed: ${result.synced} synced, ${result.errors.length} errors`
  );

  return NextResponse.json(
    formatCronSyncResponse(result.synced, result.errors)
  );
}
