/**
 * Instrument Sync Processor
 *
 * Handles the instrument-sync Pub/Sub job.
 * Fetches instrument master data from broker APIs and syncs
 * into the central InstrumentMapping table.
 */

import type { InstrumentSyncMessage } from "@usemoney/types";
import {
  syncInstruments,
  hasRecentSync,
  ZerodhaInstrumentProvider,
  NseMasterInstrumentProvider,
  enrichBseInstrumentsFromMaster,
} from "@usemoney/core/market-data";
import {
  resolveInstrumentSyncOptions,
  shouldSkipRecentSync,
  capErrorsForLog,
  RECENT_SYNC_WINDOW_HOURS,
} from "./instrument-sync-logic";

export async function processInstrumentSync(
  data: InstrumentSyncMessage,
): Promise<void> {
  const { exchanges, forceFullSync } = resolveInstrumentSyncOptions(data);

  console.log(
    `Processing instrument sync (exchanges: ${exchanges.join(", ")}, force: ${forceFullSync})`,
  );

  // Check if we already synced recently (skip if not forced).
  //
  // This used to `return` outright, which also skipped the BSE enricher below —
  // so the day after any manual forced sync the 22:00 job did nothing at all,
  // and the repair runbook REQUIRES a manual forced sync. The enricher needs
  // nothing from the providers, so it now runs regardless.
  let skipProviders = false;
  if (!forceFullSync) {
    const recent = await hasRecentSync("ZERODHA", RECENT_SYNC_WINDOW_HOURS);
    if (shouldSkipRecentSync(recent, forceFullSync)) {
      console.log(
        `Skipping provider sync - already synced within ${RECENT_SYNC_WINDOW_HOURS} hours ` +
          `(BSE master enrichment still runs)`,
      );
      skipProviders = true;
    }
  }

  // Phase 1: Only Zerodha provider
  // Future: Add UpstoxInstrumentProvider, AngelOneInstrumentProvider, etc.
  // MONEY-1085: the NSE master provider supplies the SME/book-entry series and
  // the ISIN column that Kite's dump omits. Additive — syncInstruments unions
  // every provider's symbols before deactivating stale rows.
  const providers = [
    new ZerodhaInstrumentProvider(),
    new NseMasterInstrumentProvider(),
  ];

  // Providers can throw (nse-master throws on 0 rows), and an NSE outage must
  // not also cost BSE enrichment — so their failure is contained here.
  let results: Awaited<ReturnType<typeof syncInstruments>> = [];
  if (!skipProviders) {
    try {
      results = await syncInstruments(providers, { exchanges, forceFullSync });
    } catch (error) {
      console.error("Provider sync failed (BSE enrichment still runs):", error);
    }
  }

  for (const result of results) {
    console.log(
      `[${result.provider}] Fetched: ${result.totalFetched}, Upserted: ${result.upserted}, Failed: ${result.failed}, Deactivated: ${result.deactivated}`,
    );

    if (result.errors.length > 0) {
      const logged = capErrorsForLog(result.errors);
      console.warn(`[${result.provider}] Errors (first ${logged.length}):`);
      logged.forEach((e) => console.warn(`  - ${e}`));
    }
  }

  // MONEY-1093: fill the BSE group letter + ISIN for the WHOLE active BSE
  // universe from BSE's scrip master. The daily bhavcopy only carries what
  // traded (~4,845 of ~12,600 rows), so without this the classifier's coverage
  // creeps up over ~10 trading days and the repair script has to be re-run
  // until it settles.
  //
  // Runs AFTER the providers on purpose: they own row creation, this only
  // enriches rows that already exist. It cannot throw — a metadata gap costs a
  // day, a thrown error costs the whole sync.
  // Gated on the job's own exchange filter: an {exchanges:["NSE"]} run should
  // not pull 4.5MB from BSE and write BSE rows.
  const bse = exchanges.includes("BSE")
    ? await enrichBseInstrumentsFromMaster()
    : { error: undefined as string | undefined };
  if (bse.error) {
    console.warn(`[BSE_MASTER] enrichment issue: ${bse.error}`);
  }

  console.log("Instrument sync completed");
}
