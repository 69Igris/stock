/**
 * Corporate-action HISTORY backfill — MONEY-1176.
 *
 * ## What was actually wrong
 *
 * Nothing was missing from the code. `corporate-actions-sync` already fetches
 * the whole market from NSE + BSE, already chunks into `<=180`-day windows
 * (MONEY-1098), already parses ratios and face values, and already upserts
 * history-preservingly. It has simply never been RUN over more than a recent
 * window:
 *
 *     corporate_actions by year — 2007:2 2008:1 … 2024:2 2026:5878
 *
 * 5,878 of 5,898 rows sit in the current year and every earlier year has one or
 * two. The processor's own header even anticipates this job ("a wide
 * CORP_ACTIONS_SYNC_DAYS, e.g. 7300 for the 20-year backfill"). So this script
 * builds NOTHING new — it drives the existing, tested fetchers over history.
 *
 * Not done by setting `CORP_ACTIONS_SYNC_DAYS` on the Cloud Run worker because
 * that mutates a live service's config for a one-off, and the env var would
 * then be one forgotten rollback away from making the DAILY job re-pull twenty
 * years every night.
 *
 * ## Probe first, and what it found
 *
 * The sibling `historicalOR` deals endpoint hard-caps EVERY response at 70 rows
 * regardless of range (see `deals-backfill.ts`), which silently turns a
 * backfill into a biased sample. So this endpoint was measured the same way —
 * same end date, widening the start:
 *
 *     7d → 39 rows | 30d → 136 | 90d → 286 | 180d → 577 | 365d → 2,645
 *
 * Counts keep climbing, so there is NO cap here. (The 180→365 jump is
 * superlinear because Indian corporate actions cluster after annual results,
 * not because anything truncated.) The `<=180`-day chunking is therefore
 * conservative rather than load-bearing — but it is kept, because the windowed
 * wrapper is the tested path and a wide single request IS documented to come
 * back truncated rather than rejected.
 *
 * ## Shape
 *
 * Walks BACKWARD in chunks from today, so the most useful (recent) history
 * lands first and an interrupted run still leaves the DB better than it was.
 * Idempotent: `upsertCorporateActions` dedupes on
 * `(symbol, exchange, type, exDate)`, so re-running is free.
 *
 * Usage:
 *   node --import tsx scripts/jobs/corp-actions-backfill.ts --years=1
 *   node --import tsx scripts/jobs/corp-actions-backfill.ts --years=20 --apply
 *   node --import tsx scripts/jobs/corp-actions-backfill.ts --years=20 --apply --skip-bse
 */

import "dotenv/config";

import {
  fetchNSECorporateActionsBulkWindowed,
  describeWindows,
  type DateWindow,
} from "@usemoney/research/data-sources/corp-actions-window";
import { fetchBSECorporateActions } from "@usemoney/research/data-sources/bse-client";
import {
  upsertCorporateActionsBulk,
  nseActionToInput,
  bseActionToInput,
  type CorporateActionInput,
} from "@usemoney/services";
import { prisma } from "@usemoney/database";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const APPLY = argv.includes("--apply");
const SKIP_BSE = argv.includes("--skip-bse");
const SKIP_NSE = argv.includes("--skip-nse");
/**
 * Only walk windows whose START is at least this many years back — i.e. re-run
 * the OLD end of the range without redoing the recent chunks (MONEY-1189).
 *
 * The 20-year run left dividends reaching only 2008 because the 2006-2007 NSE
 * windows timed out. Re-running all 20 chunks to retry 2 of them is ~an hour of
 * upstream requests for data already stored, and every re-fetched row lands on
 * the slow row-by-row collision path. `--from-years=18 --years=20` retries just
 * the tail.
 */
const FROM_YEARS = Number(arg("from-years") ?? 0) || 0;
/**
 * Per-request window size for the NSE leg, in days (default: the shared 180).
 *
 * NSE cannot serve a 180-day window of DEEP history. Retrying the 2006-2008
 * windows three times at a growing 30/45/60s deadline still timed out on every
 * attempt — so this is not flakiness, it is the endpoint refusing a payload
 * that large that far back, and no retry policy fixes it. Halving the window
 * halves the rows NSE has to assemble per request.
 *
 * Left at 180 for the recent years, where it demonstrably works and where a
 * smaller window would just multiply requests against a rate-limited host.
 */
const NSE_WINDOW_DAYS = Number(arg("nse-window-days") ?? 0) || 0;
const YEARS = Number(arg("years") ?? 20) || 20;
/** Days per outer chunk. The fetchers sub-chunk to <=180 internally. */
const CHUNK_DAYS = Number(arg("chunk-days") ?? 365) || 365;
const PACE_MS = Number(arg("pace-ms") ?? 3000) || 3000;
/**
 * Which action types to persist. Default is the STRUCTURAL set — the events
 * that move a price series and therefore need a chart mark or an adjustment
 * factor. `--types=ALL` keeps everything (including dividends).
 */
const TYPES = (arg("types") ?? "STRUCTURAL").toUpperCase();
const WANTED_TYPES = new Set([
  "SPLIT",
  "BONUS",
  "DEMERGER",
  "MERGER",
  "RIGHTS",
  "BUYBACK",
  // DIVIDEND was excluded here, and the reasoning was sound but scoped to the
  // WRONG consumer (MONEY-1189, founder-confirmed 2026-08-12). It is true that
  // dividends do not move a split-adjusted series, so they are irrelevant to
  // chart marks — which is what MONEY-1176 was about. But they ARE the datum
  // for cost-basis and tax math and for dividend-history surfaces, and P5.2's
  // own acceptance test is "RELIANCE dividends >= 20 rows back to 2005" against
  // a table that held 2.
  //
  // Marks and adjustment are unaffected by construction: MARKED_TYPES excludes
  // DIVIDEND, QTY_CHANGING_TYPES excludes DIVIDEND, and the corporate-action
  // adjustment fingerprint queries only qty-changing rows.
  //
  // The other half of the old reasoning — "row-by-row writes would turn a
  // ~20-minute job into hours" — was real, and is why this ships alongside
  // `upsertCorporateActionsBulk`.
  "DIVIDEND",
]);
/**
 * OTHER is EXCLUDED, and that was checked rather than assumed — dropping it
 * would have been the obvious way to silently discard the very actions this
 * ticket is chasing, since NSE/BSE subject lines are free text and an
 * unrecognised split lands in OTHER.
 *
 * Measured over Apr-Jun 2026: 5,561 OTHER rows, of which the top subjects are
 * "Payment of Interest" (4,487), "Redemption of NCD" (628), "Payment of
 * Interest for Bonds" (273), "Redemption of Mutual Fund" (57) — bond and fund
 * servicing, overwhelmingly from BSE's much larger debt universe. ZERO of the
 * 5,561 mentioned split, bonus, sub-division or face value.
 *
 * They are also ~81% of all volume, and `upsertCorporateActions` writes
 * row-by-row, so carrying them would turn a ~20-minute backfill into hours for
 * data no chart reads. `--types=ALL` opts back in if a debt feature ever wants
 * them.
 */

const log = (...a: unknown[]) => console.log("[corp-actions-backfill]", ...a);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function nseDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** Inclusive chunks, NEWEST first. */
function chunks(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  let end = new Date(to);
  while (end > from) {
    const start = new Date(
      Math.max(end.getTime() - (CHUNK_DAYS - 1) * 86_400_000, from.getTime()),
    );
    out.push({ from: start, to: new Date(end) });
    end = new Date(start.getTime() - 86_400_000);
  }
  return out;
}

interface Tally {
  nseFetched: number;
  bseFetched: number;
  mapped: number;
  created: number;
  updated: number;
  skipped: number;
  emptyChunks: number;
  filteredOut: number;
  byType: Map<string, number>;
  /**
   * Windows the feed was ASKED for and never answered.
   *
   * The counter this run did not have. `emptyChunks=0` was printed while 37 NSE
   * windows had silently failed, because a failed fetch and an empty window
   * both arrived as `[]` — so the summary line asserted a completeness nobody
   * had checked (MONEY-1189).
   */
  failedWindows: DateWindow[];
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  const to = new Date();
  const from = new Date(to.getTime() - YEARS * 365 * 86_400_000);
  const cutoff =
    FROM_YEARS > 0
      ? new Date(to.getTime() - FROM_YEARS * 365 * 86_400_000)
      : null;
  // `chunks` is newest-first; keep only windows that START at or before the
  // cutoff, so the filter selects the DEEP end of the range.
  const windows = chunks(from, to).filter((w) => !cutoff || w.from <= cutoff);

  const before = await prisma.corporateAction.count();
  const beforeQty = await prisma.corporateAction.count({
    where: { type: { in: ["SPLIT", "BONUS"] } },
  });
  log(
    `${windows.length} chunk(s) of <=${CHUNK_DAYS}d covering ${nseDate(from)}..${nseDate(to)} ` +
      `(newest first)${cutoff ? `, LIMITED to windows starting on/before ${nseDate(cutoff)}` : ""} — ` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  log(
    `corporate_actions before: ${before.toLocaleString()} total, ${beforeQty} qty-changing`,
  );

  const tally: Tally = {
    nseFetched: 0,
    bseFetched: 0,
    mapped: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    emptyChunks: 0,
    filteredOut: 0,
    byType: new Map(),
    failedWindows: [],
  };

  for (const [i, w] of windows.entries()) {
    const inputs: CorporateActionInput[] = [];
    // ONE entry per window, whichever leg(s) threw — MONEY-1236. See the NSE
    // catch below for why both legs pushing independently double-counted.
    let windowFailed = false;

    if (!SKIP_NSE) {
      try {
        const nse = await fetchNSECorporateActionsBulkWindowed(
          w.from,
          w.to,
          NSE_WINDOW_DAYS > 0 ? { maxDays: NSE_WINDOW_DAYS } : {},
        );
        tally.nseFetched += nse.rows.length;
        tally.failedWindows.push(...nse.failedWindows);
        for (const a of nse.rows) {
          const row = nseActionToInput(a);
          if (row) inputs.push(row);
        }
      } catch (err) {
        // Per-source isolation, mirroring the worker: a flaky leg must not
        // abort twenty years of backfill.
        log(
          `  NSE leg failed for ${nseDate(w.from)}..${nseDate(w.to)}: ${err}`,
        );
        // A THROWN leg is a failed window too — MONEY-1238. The push above
        // only records windows the FETCHER itself reported; when the fetcher
        // throws (a typed rate-limit error re-raises, and so does any transport
        // failure) control jumps straight here and the window was recorded
        // nowhere. A 20-year walk in which every leg threw printed twenty log
        // lines, zero failed windows, then "COMPLETE: every window was
        // fetched." and exit 0 — the completion verdict was computed over an
        // empty list. Recording one leg's throw as a whole-window failure
        // slightly OVER-reports when the other leg succeeded; that is the safe
        // direction, because the heal command re-runs the window and the
        // upsert makes a re-run idempotent.
        //
        // ONCE PER WINDOW — MONEY-1236. Both legs push into the same list, so a
        // window where NSE *and* BSE threw was recorded TWICE: the failure count
        // doubled and the heal list re-fetched the same range twice. Over-report
        // in the "one leg threw, the other worked" direction is deliberate and
        // safe; over-report by double-counting the same window is just a wrong
        // number in the run's headline figure.
        windowFailed = true;
      }
    }

    if (!SKIP_BSE) {
      try {
        const bse = await fetchBSECorporateActions({
          fromDate: w.from,
          toDate: w.to,
        });
        tally.bseFetched += bse.rows.length;
        tally.failedWindows.push(...bse.failedWindows);
        for (const a of bse.rows) {
          const row = bseActionToInput(a);
          if (row) inputs.push(row);
        }
      } catch (err) {
        log(
          `  BSE leg failed for ${nseDate(w.from)}..${nseDate(w.to)}: ${err}`,
        );
        // Same reasoning as the NSE leg above.
        windowFailed = true;
      }
    }

    if (windowFailed) tally.failedWindows.push({ from: w.from, to: w.to });

    for (const r of inputs)
      tally.byType.set(r.type, (tally.byType.get(r.type) ?? 0) + 1);

    // Keep only what this ticket is FOR — see WANTED_TYPES for why DIVIDEND is
    // now IN and OTHER is still out. `--types=ALL` opts back in to everything.
    const wanted =
      TYPES === "ALL" ? inputs : inputs.filter((r) => WANTED_TYPES.has(r.type));
    tally.filteredOut += inputs.length - wanted.length;
    tally.mapped += wanted.length;
    if (wanted.length === 0) tally.emptyChunks++;

    if (APPLY && wanted.length > 0) {
      const res = await upsertCorporateActionsBulk(wanted);
      tally.created += res.created;
      tally.updated += res.updated;
      tally.skipped += res.skipped;
    }

    log(
      `chunk ${i + 1}/${windows.length} ${nseDate(w.from)}..${nseDate(w.to)}: ` +
        `nse=${tally.nseFetched} bse=${tally.bseFetched} mapped=${tally.mapped} ` +
        `created=${tally.created} updated=${tally.updated}`,
    );
    await sleep(PACE_MS);
  }

  const after = await prisma.corporateAction.count();
  const afterQty = await prisma.corporateAction.count({
    where: { type: { in: ["SPLIT", "BONUS"] } },
  });
  log(
    `DONE: fetched nse=${tally.nseFetched} bse=${tally.bseFetched}, ` +
      `mapped=${tally.mapped}, created=${tally.created}, updated=${tally.updated}, ` +
      `skipped=${tally.skipped}, emptyChunks=${tally.emptyChunks}` +
      `${APPLY ? "" : " (dry-run, nothing written)"}`,
  );
  log(
    "types seen: " +
      [...tally.byType]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
  );
  log(`filtered out (not structural): ${tally.filteredOut.toLocaleString()}`);
  log(
    `corporate_actions after: ${after.toLocaleString()} total ` +
      `(+${after - before}), ${afterQty} qty-changing (+${afterQty - beforeQty})`,
  );

  // The completeness verdict, LAST and loud.
  //
  // Everything above this point is a count of what we got, and a count of what
  // you got can never tell you what you missed — which is exactly how the 20y
  // run ended on "DONE: … emptyChunks=0" while 37 NSE windows and 1 BSE window
  // had failed, leaving visible dips at 2013 and 2017 that read as macro.
  //
  // Non-zero exit so a wrapper, a CI step or a scheduled invocation cannot
  // treat a partial backfill as a successful one.
  if (tally.failedWindows.length > 0) {
    const from = tally.failedWindows.reduce(
      (a, w) => (w.from < a ? w.from : a),
      tally.failedWindows[0]!.from,
    );
    log(
      `INCOMPLETE: ${tally.failedWindows.length} window(s) were asked for and ` +
        `never answered — ${describeWindows(tally.failedWindows)}`,
    );
    // The heal command must COVER every failed window. The first version emitted
    // `--years=${YEARS} --from-years=${age of oldest failure}`, which covers
    // none of them: `--from-years=N` keeps only windows STARTING ON OR BEFORE N
    // years ago — the DEEP end — so pointing it at the oldest failure selects
    // everything OLDER than that failure and excludes the failure itself, plus
    // every more-recent one. Measured 2026-08-13: 7 failed windows spanning
    // 2008-2022 produced `--from-years=18`, and running it walked 2003-2008 and
    // re-fetched none of the seven. A remedy that reports success while covering
    // nothing is the exact defect class this verdict exists to prevent.
    //
    // `--years=N` walks the last N years, so sizing it from the OLDEST failure
    // spans every failure by construction. It redoes more recent chunks than
    // strictly necessary; that is the right trade — re-walking a complete chunk
    // costs one keyed read and writes nothing (`corporateActionNeedsMerge`),
    // while missing a window costs another silent gap.
    const healYears = Math.ceil(
      (Date.now() - from.getTime()) / (365 * 86_400_000),
    );
    log(
      `  heal with: ./scripts/ops/run-market-data-job.sh corp <env> --apply ` +
        `--years=${healYears} --nse-window-days=${NSE_WINDOW_DAYS || 90}`,
    );
    process.exitCode = 1;
  } else {
    log("COMPLETE: every window was fetched.");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[corp-actions-backfill] failed:", err);
  process.exitCode = 1;
});
