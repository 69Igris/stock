/**
 * Peers Sync Processor (MONEY-1145)
 *
 * Derives `stock_peers` from our own instrument + ratio + quote data. Delegates
 * all logic to `syncStockPeers` (@usemoney/services), which is backed by the
 * pure `peer-selection-logic` decisions. System-level (no userId).
 *
 * Reads NO rate-limited upstream, so — like `mf-nav-propagate` — it runs on both
 * environments and is deliberately not in the scheduler's `PROD_ONLY_JOBS`.
 */

import type { PeersSyncMessage } from "@usemoney/types";
import { syncStockPeers } from "@usemoney/services";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";

/**
 * Share of the equity universe that may lack a real sector before the run says
 * so out loud — MONEY-1238.
 *
 * `skippedNoSector` was computed, printed, and read by nothing. It is not this
 * job's own failure (sector-enrichment owns it), which is exactly why it needs a
 * threshold rather than a retry: peers CANNOT be derived for a sectorless
 * instrument, so a collapse in sector coverage silently shrinks the peers
 * universe while `success` stays true and `written` stays plausible.
 *
 * 0.75 because the sentinel is already the majority — 14,893 of 22,153
 * instruments carry SECTOR_SKIPPED "N/A" (MONEY-1145, ~67%) — so a threshold
 * under that fires every single night and stops being read.
 */
const NO_SECTOR_ALARM_RATIO = 0.75;

/**
 * The one I/O call, injectable — MONEY-1238. The default IS the production
 * path, so a test that overrides it drives the real threshold, the real
 * job-outcome emission and the real throw.
 */
export interface PeersSyncDeps {
  sync?: typeof syncStockPeers;
}

export async function processPeersSync(
  _data: PeersSyncMessage,
  deps: PeersSyncDeps = {},
): Promise<void> {
  const result = await (deps.sync ?? syncStockPeers)();

  if (!result.success) {
    reportJobOutcome({
      job: "peers-sync",
      selected: 0,
      written: 0,
      failed: 1,
      skippedReason: result.error || "syncStockPeers returned success: false",
    });
    // Throw so the route returns 500 and Pub/Sub retries with backoff.
    throw new Error(result.error || "Peers sync failed");
  }

  const { scanned, written, withPeers, skippedNoSector } = result.data;
  const universe = scanned + skippedNoSector;
  const noSectorRatio = universe > 0 ? skippedNoSector / universe : 0;

  const measurements =
    `scanned=${scanned} written=${written} withPeers=${withPeers} ` +
    `skippedNoSector=${skippedNoSector} of universe=${universe} ` +
    `(${(noSectorRatio * 100).toFixed(1)}%)`;

  console.log(`Peers sync completed: ${measurements}`);

  if (universe > 0 && noSectorRatio >= NO_SECTOR_ALARM_RATIO) {
    console.error(
      `[peers-sync] ${measurements} — over ${NO_SECTOR_ALARM_RATIO * 100}% of the ` +
        `equity universe has NO sector, so peers cannot be derived for them. ` +
        `This is a sector-enrichment failure surfacing here; retrying peers-sync ` +
        `cannot fix it.`,
    );
  }

  reportJobOutcome({
    job: "peers-sync",
    selected: scanned,
    // Every scanned candidate should produce a row (empties included — a
    // `peerCount: 0` row is the deliberate "computed, genuinely none" signal),
    // so anything short of `scanned` is a broken mapping and the throw below
    // turns it into a real failure rather than a quietly short run.
    written,
    failed: Math.max(0, scanned - written),
    skippedReason: measurements,
  });

  // THE INVARIANT IS `written === scanned`, NOT `written > 0` — MONEY-1236.
  //
  // The previous test (`scanned > 0 && written === 0`) was UNREACHABLE, and so
  // was the `failed` count above it. In `peers-sync.service.ts`,
  // `rows = candidates.map(...)` makes exactly one row per candidate, and
  // `idBySymbolExchange` is populated in the SAME loop that builds
  // `candidates` — so the only `return false` path (`!instrumentId`) cannot
  // fire, `mapWithConcurrency` does not catch (an upsert throw propagates to
  // `syncStockPeers`' own catch and returns `success: false`, handled above),
  // and `written === scanned` on every successful run. A guard that cannot fire
  // is not protection, it is the appearance of protection — the defect this
  // whole ticket family is about, in the code that was added to fix it.
  //
  // Asserting the real invariant instead makes it LIVE: it fires the moment a
  // future change filters `rows`, adds a skip path, or reintroduces an
  // unresolvable id — exactly the regressions the dead check was imagined to
  // catch. Worth a retry because the upsert is keyed on (symbol, exchange).
  if (written !== scanned) {
    throw new Error(
      `Peers sync wrote ${written} row(s) for ${scanned} scanned candidate(s) — ` +
        `every candidate must produce a row, empties included: ${measurements}`,
    );
  }
}
