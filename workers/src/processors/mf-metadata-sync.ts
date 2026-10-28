/**
 * MF Metadata Sync Processor
 *
 * Batch-enriches `MutualFundMaster` rows from the configured
 * `MfMetadataProvider`. Processes funds that were never enriched (the field is
 * ABSENT or null) or are stale (> STALE_DAYS).
 *
 * MONEY-1205 changed three things about how this job fails:
 *  1. The cursor can now reach every fund (`isSet:false`, see the WHERE builder).
 *  2. Deterministic per-fund failures stamp an attempt marker, so the cursor
 *     advances instead of re-picking the same oldest 500 rows every Sunday.
 *  3. A batch that extracts zero fields THROWS. It used to log `enriched=0` and
 *     return normally, which acked the message and recorded a successful run.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import type { MfMetadataSyncMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import {
  enrichMfMetadata,
  getMfMetadataProvider,
  registerMfMetadataProvider,
  type MfEnrichReason,
} from "@usemoney/core/market-data";
import {
  amfiFundMetadataProvider,
  isAmfiFundMetadataEnabled,
} from "@usemoney/core/market-data/instruments/amfi-fund-metadata-provider";

// Registered at MODULE load, before any message is handled, so the refusal
// below can only mean "no provider is configured" and never "the provider had
// not been registered yet" (MONEY-1207).
//
// This is now the ONLY registration in the repo (MONEY-1409 deleted the dead
// captnemo/Kuvera provider), so `getMfMetadataProvider()` is null whenever
// MF_METADATA_PROVIDER is not "amfi". AMFI supplies AUM, TER, launch date and
// fund type — NOT fund manager, exit load, benchmark, riskometer or trailing
// returns: none of those appear in any AMFI file (they live in per-AMC SID
// documents and, for returns, behind a CRISIL-hosted API), so they stay null
// rather than being inferred. MONEY-610 removed a fabricated benchmark once
// already.
if (isAmfiFundMetadataEnabled()) {
  registerMfMetadataProvider(amfiFundMetadataProvider);
}
import {
  resolveMfMetadataParams,
  buildMfMetadataWhere,
  computeStaleDate,
  shouldSleepAfterIndex,
  shouldLogProgress,
  judgeMfMetadataHealth,
  type MfMetadataRunTally,
} from "./mf-metadata-sync-logic";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processMfMetadataSync(
  data: MfMetadataSyncMessage,
): Promise<void> {
  const { batchSize, delayMs, forceReEnrich } = resolveMfMetadataParams(data);

  // Refuse to run without a provider. This is deliberately BEFORE the query:
  // selecting 500 funds and "failing" each one would burn a batch of attempt
  // markers and read as a data problem, when the truth is that no source is
  // configured at all. Since MONEY-1409 there is exactly one implementation —
  // AMFI's AUM/TER feeds, registered above behind the `MfMetadataProvider`
  // seam — so this refusal is the whole safety net: nothing else can supply a
  // provider by accident.
  const provider = getMfMetadataProvider();
  if (!provider) {
    const message =
      "[mf-metadata-sync] No MF metadata provider is configured. " +
      "Set MF_METADATA_PROVIDER, or register a provider via " +
      "registerMfMetadataProvider(). Refusing to run — a no-op run that exits 0 " +
      "is what hid a dead upstream for three months.";
    console.error(message);
    throw new Error(message);
  }

  console.log(
    `[mf-metadata-sync] Starting (provider=${provider.id}, batch=${batchSize}, ` +
      `delay=${delayMs}ms, force=${forceReEnrich})`,
  );

  // Un-enriched (absent OR null) or stale funds.
  const whereClause = buildMfMetadataWhere(forceReEnrich, computeStaleDate());

  const funds = await prisma.mutualFundMaster.findMany({
    where: whereClause,
    select: { schemeCode: true },
    take: batchSize,
    // MongoDB sorts a MISSING field before any date ascending, so the funds that
    // were never touched are served first — which, after the `isSet:false` fix,
    // is exactly the 6,960-row backlog the old cursor could not see.
    orderBy: { metadataSyncedAt: "asc" },
  });

  console.log(`[mf-metadata-sync] Selected ${funds.length} funds to enrich`);

  const tally: MfMetadataRunTally = {
    selected: funds.length,
    enriched: 0,
    attempted: 0,
    stamped: 0,
    fieldsExtracted: 0,
  };
  const reasons = new Map<MfEnrichReason, number>();
  let failed = 0;

  for (let i = 0; i < funds.length; i++) {
    const fund = funds[i]!;

    const result = await enrichMfMetadata(fund.schemeCode);

    reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
    if (result.attempted) tally.attempted++;
    if (result.marked) tally.stamped++;
    if (result.enriched) {
      tally.enriched++;
      tally.fieldsExtracted += result.fieldsExtracted;
    } else {
      failed++;
    }

    if (shouldLogProgress(i)) {
      console.log(
        `[mf-metadata-sync] Progress: ${i + 1}/${funds.length} ` +
          `(enriched=${tally.enriched}, failed=${failed})`,
      );
    }

    if (shouldSleepAfterIndex(i, funds.length)) {
      await sleep(delayMs);
    }
  }

  const breakdown = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}=${n}`)
    .join(" ");

  const health = judgeMfMetadataHealth(tally);
  const summary =
    `[mf-metadata-sync] Done: provider=${provider.id} ` +
    `selected=${tally.selected} enriched=${tally.enriched} failed=${failed} ` +
    `attempted=${tally.attempted} stamped=${tally.stamped} ` +
    `fields=${tally.fieldsExtracted} [${breakdown}]`;

  if (!health.ok) {
    // Error level, not a normal line — and a throw, so the route 500s, Pub/Sub
    // retries, and after --max-delivery-attempts the dead-letter consumer
    // (MONEY-1204) notifies the founder. That chain is the whole point: the
    // failure has to reach a human.
    console.error(`${summary} :: ${health.reason} — ${health.message}`);
    throw new Error(`[mf-metadata-sync] ${health.reason}: ${health.message}`);
  }

  console.log(summary);

  // MONEY-1220 — the machine-readable half. This job ran ENABLED and wrote
  // nothing for months because MF_METADATA_PROVIDER was unset: the summary line
  // above said so, and nobody was reading it. `selected > 0 && written === 0`
  // is the condition a monitor can actually alert on.
  reportJobOutcome({
    job: "mf-metadata-sync",
    selected: tally.selected,
    written: tally.enriched,
    failed,
    skippedReason:
      tally.selected > 0 && tally.enriched === 0
        ? `no fund enriched: [${breakdown}]`
        : undefined,
  });
}
