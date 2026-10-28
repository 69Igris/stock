/**
 * Mutual Fund Sync Processor
 *
 * Fetches AMFI NAVAll.txt and syncs all mutual fund master data
 * into the MutualFundMaster table.
 *
 * ## This job had no liveness rule at all — MONEY-1403
 *
 * Every other job in the MF family throws on a zero write and reports an
 * outcome: `mf-nav-backfill` (`judgeMfNavBackfillHealth`), `mf-metadata-sync`
 * (`judgeMfMetadataHealth`), `mf-portfolio-sync` (`mfPortfolioRunOk`). This one
 * — the PRIMARY NAV feed, ~14,300 schemes a night — logged and returned.
 *
 * On 2026-08-19 AMFI moved two columns, the positional parser skipped every
 * row, and this printed `parsed=0, upserted=0, failed=0` for 26 consecutive
 * nights while the route answered 200 in ~150 ms and Pub/Sub ACKed. Nothing
 * alerted, because the job emitted no metric at all and was absent from
 * `apply-monitors.sh` — and NO DATA is also what a healthy idle job looks like
 * (MONEY-1214 / MONEY-1220 / MONEY-1238, now at five layers).
 *
 * Two things fixed that, and both are required: `syncAmfiMutualFunds` now
 * THROWS on zero (so the route 500s, so Pub/Sub retries and dead-letters), and
 * this processor emits `[job-outcome]` on every path — including the failing
 * one, because a monitor watching a series that stops being emitted sees the
 * same nothing as a monitor watching a series that was never emitted.
 */

import type { MfSyncMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import { syncAmfiMutualFunds } from "@usemoney/core/market-data";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import {
  resolveForceFullSync,
  capMfErrorsForLog,
  judgeMfSyncCompleteness,
  MF_SYNC_MAX_MISSING_PCT,
} from "./mf-sync-logic";

export async function processMfSync(data: MfSyncMessage): Promise<void> {
  console.log(`Processing MF sync (force: ${resolveForceFullSync(data)})`);

  // Stamped BEFORE the sync so it can be compared against the `lastSyncedAt`
  // the upsert writes. Same process, same clock, so there is no skew to reason
  // about — and it must not be re-read after the sync, or every row looks
  // un-touched.
  const runStartedAt = new Date();

  let result;
  try {
    result = await syncAmfiMutualFunds();
  } catch (error) {
    // Report BEFORE rethrowing. The throw is what makes Pub/Sub retry, but a
    // thrown job that emitted no counter is invisible to Datadog in exactly the
    // way this ticket is about.
    const message = error instanceof Error ? error.message : String(error);
    reportJobOutcome({
      job: "mf-sync",
      selected: 0,
      written: 0,
      failed: 1,
      unhealthy: true,
      skippedReason: `feed-unreadable: ${message}`,
    });
    throw error;
  }

  // ── COMPLETENESS — MONEY-1404 C1 ───────────────────────────────────────────
  //
  // The zero-guard inside `syncAmfiMutualFunds` catches a feed that yielded
  // NOTHING. This catches the PARTIAL, which has no other detector: one AMC's
  // block failing to parse, a truncated download, a fan-out that stops half
  // way. `parsed=7000, upserted=7000, failed=0` is a clean-looking success and
  // half the platform's NAVs.
  //
  // The denominator is the master itself. `lastSyncedAt` is stamped by the
  // upsert on every write, so an ACTIVE scheme that this run did not touch is
  // one the feed did not price tonight — which also covers the rows whose
  // upsert FAILED, correctly: a scheme whose write threw did not produce a NAV
  // either.
  //
  // THREE ARMS, NOT TWO. `lt` alone drops every row without a value, and
  // `{ lastSyncedAt: null }` does NOT pick them all back up: on Prisma +
  // MongoDB a bare null matches only documents that CARRY the key, so a master
  // row whose `lastSyncedAt` was never written — every row created before that
  // column existed — is invisible to both. `{ isSet: false }` is the arm that
  // sees them.
  //
  // The direction of that bug is the reason it matters here. A never-synced
  // scheme is the MOST missing row there is, and dropping it makes `missing`
  // UNDER-count: the gate passes, the run reports healthy, and the schemes it
  // cannot see are exactly the ones nothing has ever priced. A completeness
  // check that fails OPEN is worse than none, because it is believed.
  //
  // This is the MONEY-1050 / 1205 / 1234 / 1236 class, and the comment that
  // stood here NAMED that class while the query below it committed the bug —
  // caught by `apps/web/__tests__/meta/prisma-null-vs-isset.test.ts`, which
  // scans for exactly this shape.
  // MEASURED INSIDE A TRY, and the report happens either way — MONEY-1405.
  //
  // Two Prisma round trips sit between a SUCCESSFUL ~14,300-row write and the
  // only success report: a `count` and a `findMany` over the whole active
  // universe. Unwrapped, a blip on either one means the NAVs are in the table
  // and NOTHING is emitted — and `apply-monitors.sh` now carries
  // `mf-sync|36h|standing`, whose query is `default_zero(sum:selected) < 1`,
  // so that silence pages the founder 36 hours later about a run that worked.
  // MONEY-1255 spelled this out as a PREREQUISITE for adding a freshness
  // monitor, not as tidying.
  //
  // "COULD NOT MEASURE" IS NOT "MEASURED ZERO MISSING". A completeness check
  // that failed to run must not read as a pass — that is the fail-open shape
  // this gate exists to prevent — and it must not THROW either, because the
  // sync itself succeeded and a throw would redeliver a good 14,300-row run.
  // So it reports the real write counts with the failure NAMED in
  // `skippedReason`, and the gate declines to judge rather than judging wrong.
  let completeness: ReturnType<typeof judgeMfSyncCompleteness> | null = null;
  let coverage: string;
  try {
    const activeSchemes = await prisma.mutualFundMaster.count({
      where: { isActive: true },
    });
    const missingRows = await prisma.mutualFundMaster.findMany({
      where: {
        isActive: true,
        OR: [
          { lastSyncedAt: { lt: runStartedAt } },
          { lastSyncedAt: null },
          { lastSyncedAt: { isSet: false } },
        ],
      },
      select: { schemeCode: true },
      orderBy: { schemeCode: "asc" },
    });

    completeness = judgeMfSyncCompleteness({
      activeSchemes,
      missingSchemeCodes: missingRows.map((r) => r.schemeCode),
    });

    coverage =
      `${activeSchemes - completeness.missingCount}/${activeSchemes} active ` +
      `schemes priced, ${completeness.missingCount} missing ` +
      `(${completeness.missingPct.toFixed(2)}%, threshold ` +
      `${MF_SYNC_MAX_MISSING_PCT}%)`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    coverage = `completeness UNMEASURED (${message})`;
    console.warn(
      `[mf-sync] the completeness query failed — the sync itself SUCCEEDED ` +
        `(${result.upserted} upserted). Reporting the write and declining to ` +
        `judge coverage: ${message}`,
    );
  }

  // ONE report, on every path out of the completeness block. `skippedReason` is
  // set for the two states that are not a clean pass, and its prefixes are
  // deliberately distinct — `feed-unreadable:` (the catch above), `incomplete:`
  // and `completeness-unmeasured:` need three different responses, and whoever
  // opens the log line can only tell them apart if they are spelled differently.
  //
  // `unhealthy` RIDES WITH IT, and that is the half that alerts — MONEY-1401
  // review finding 5. `skippedReason` reaches a log line and NOTHING QUERIES A
  // LOG LINE, so `completeness-unmeasured` used to emit
  // `selected=14300 written=14300 failed=0` at INFO: byte-identical to a pass
  // in every Datadog surface, while this file's own comment claimed a failed
  // check must not read as one. `stockbook.job.unhealthy` is the series that
  // makes the claim true.
  const shortfall =
    completeness !== null && !completeness.ok
      ? `incomplete: ${coverage}; sample=${completeness.sample.join(",")}`
      : completeness === null
        ? `completeness-unmeasured: ${coverage}`
        : null;

  reportJobOutcome({
    job: "mf-sync",
    selected: result.totalParsed,
    written: result.upserted,
    failed: result.failed,
    ...(shortfall ? { skippedReason: shortfall, unhealthy: true } : {}),
  });

  // A SHORTFALL THROWS, AND `unhealthy: true` RIDES ALONGSIDE IT.
  //
  // The throw was removed once, on the stated grounds that `unhealthy: true`
  // above emits `stockbook.job.unhealthy` — "a real series a monitor CAN alert
  // on". It can; NOTHING DOES. `grep -rn unhealthy scripts/ops/` finds no
  // monitor, and the two `mf-sync` rows in `apply-monitors.sh` cannot fire on
  // this condition: a short night still reports `selected=14300 written=14300
  // failed=0`, so the `|36h|standing` absence row (`default_zero(sum:selected)
  // < 1`) and the zero-write row both stay green. Removing the throw made a
  // partial AMFI night silent in EVERY alerting surface.
  //
  // AND THE ANSWER IS NOT "CREATE THE MONITOR". `job.unhealthy` has never been
  // emitted on prod — the field landed with this branch — so a monitor over it
  // would sit in NO DATA from birth, indistinguishable from health the moment
  // anyone mutes it. That is MONEY-1238, the exact class this ticket exists to
  // close. The order is instrument -> OBSERVE -> monitor.
  //
  // SO THE THROW COMES OUT ONLY WHEN BOTH HOLD:
  //   1. `stockbook.job.unhealthy` has been OBSERVED on prod for >= 3 nights
  //      (it must be arriving, with tag `job:mf-sync`, on healthy nights too —
  //      the counter is emitted with a zero, so the series exists either way);
  //   2. a monitor row over it exists in `apply-monitors.sh` and has been
  //      applied.
  // Until then this throw is the only channel that reaches a person, and the
  // price is paid DELIBERATELY: a 500 is a nack, Pub/Sub redelivers up to
  // `MAX_DELIVERY_ATTEMPTS=5`, each redelivery re-runs the AMFI fetch plus
  // ~14,300 upserts to reach the same answer, and the fifth dead-letters and
  // notifies the founder. Four wasted syncs is the cost of not being silent.
  //
  // GENUINE failures throw for a different reason — the AMFI fetch, the parse,
  // a database error are TRANSIENT and a redelivery can fix them. This branch
  // is reached only when the parse SUCCEEDED and the file was short, which a
  // retry cannot fix; it throws to be SEEN, not to be retried.
  if (completeness !== null && !completeness.ok) {
    throw new Error(
      `[mf-sync] AMFI priced only ${coverage}. That is not a quiet day: AMFI ` +
        `publishes ~14,300 schemes daily and the parse succeeded, so a gap ` +
        `this size means part of the file did not survive it. First ` +
        `${completeness.sample.length} missing scheme codes: ` +
        `${completeness.sample.join(", ")} — see MONEY-1404. Also reported as ` +
        `stockbook.job.unhealthy; the throw stays until that series has been ` +
        `observed on prod AND a monitor row exists for it.`,
    );
  }

  console.log(
    `MF sync completed: parsed=${result.totalParsed}, upserted=${result.upserted}, ` +
      `failed=${result.failed}, ${coverage}`,
  );

  if (result.errors.length > 0) {
    const logged = capMfErrorsForLog(result.errors);
    console.warn(`MF sync errors (first ${logged.length}):`);
    logged.forEach((e) => console.warn(`  - ${e}`));
  }
}
