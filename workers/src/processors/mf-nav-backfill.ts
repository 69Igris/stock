/**
 * MF NAV Backfill Processor (MONEY-1205)
 *
 * Pulls full NAV history from MFAPI.in into `MfNavHistory`. This is the job that
 * the 55-83 s inline backfill inside `getMfNavHistory` became: reads now return
 * whatever the database holds and publish here instead of fetching.
 *
 * ## Why the nightly universe sweep, not just first-click
 *
 * Measured on prod 2026-08-18: `mf_nav_history` held 22,446 rows across **16 of
 * 14,223** schemes. On-demand backfill had been the only writer since the
 * feature shipped and had covered 0.1% of the platform, because it only ever
 * fired when somebody opened a fund page and then blew up that same request.
 * The scheduled sweep is what actually closes the gap; the on-demand path is an
 * optimisation for the fund somebody is looking at right now.
 *
 * ## Two modes
 *
 *  - `{ schemeCodes: [...] }` — exactly those schemes. Published by a cold read.
 *  - `{ universe: true }` — schemes with NO stored history, `aum desc` (the
 *    funds users are most likely to open), capped at `batchSize`. Published by
 *    Cloud Scheduler `mf-nav-backfill-daily` at 23:00 IST, after
 *    `mf-sync-daily` (22:30) has refreshed the scheme master.
 *
 * ## Budget
 *
 * The loop stops on a wall clock (`DEFAULT_BUDGET_MS`, 420 s) rather than
 * trusting a per-scheme cost estimate against Pub/Sub's 600 s maximum ack
 * deadline. Whatever finished is committed; the next run re-selects what is
 * still missing. `backfillSchemeNav` inserts only dates it does not already
 * have, so a redelivery or an overlapping run is a no-op rather than a conflict.
 *
 * ## The write lives HERE, on purpose
 *
 * `prod-only-sync-coverage.test.ts` (MONEY-1196) scans these processor files to
 * answer "what advances this table tomorrow?" for every job in `PROD_ONLY_JOBS`.
 * A processor that writes only by delegating into `@usemoney/core` yields no
 * recognisable Prisma write and passes that guard VACUOUSLY — the precise shape
 * that let five collections go stale on QA while every comment insisted they
 * were fed. So the `createMany` is a plain `prisma.mfNavHistory.*` call in this
 * file; core keeps the network fetch and the pure diff.
 *
 * `mf_nav_history` is already in `REFERENCE_COLLECTIONS`
 * (`scripts/ops/sync-prod-to-qa.sh`), so QA RECEIVES these rows from prod and
 * must not fetch them a second time — which is why the job is PROD_ONLY. The
 * copy is safe because `MfNavHistory` keys on `(schemeCode, date)`, a natural
 * key with no `instrumentId` FK into QA's own ObjectIds (the reason
 * `daily_prices` cannot be mirrored the same way).
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { incrementCounter } from "@usemoney/datadog/metrics";
import type { MfNavBackfillMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import {
  fetchMfNavPoints,
  selectMissingNavPoints,
  MF_NAV_INSERT_CHUNK,
} from "@usemoney/core/market-data";
import {
  resolveMfNavBackfillParams,
  shouldSleepAfterIndex,
  shouldLogProgress,
  isBudgetExhausted,
  judgeMfNavBackfillHealth,
  reconcileSchemeNav,
  rotatingSlice,
  dayIndex,
  MF_NAV_RECONCILE_SAMPLE,
  MF_NAV_DISAGREEMENT_TOLERANCE,
  type MfNavBackfillTally,
  type MfNavReconcileResult,
} from "./mf-nav-backfill-logic";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scheme codes that have NO stored NAV history, most-valuable-first.
 *
 * `groupBy` rather than `$runCommandRaw({ aggregate: ... })` on purpose: a raw
 * command returns only `cursor.firstBatch` (101 documents / 16 MB), and reading
 * that as the full result is precisely the truncation that manufactured phantom
 * gaps in MONEY-1189. Prisma drives the cursor to exhaustion. With ~14 k
 * schemes the grouped set is small enough to hold in memory.
 */
async function selectSchemesMissingHistory(limit: number): Promise<string[]> {
  const covered = await prisma.mfNavHistory.groupBy({ by: ["schemeCode"] });
  const coveredCodes = new Set(covered.map((r) => r.schemeCode));

  const selected: string[] = [];
  const PAGE = 2_000;
  let skip = 0;

  // Page through active schemes by AUM until we have `limit` uncovered ones.
  // Bounded: stops as soon as the quota is met or the collection is exhausted.
  for (;;) {
    const page = await prisma.mutualFundMaster.findMany({
      where: { isActive: true },
      select: { schemeCode: true },
      orderBy: [{ aum: "desc" }, { schemeCode: "asc" }],
      take: PAGE,
      skip,
    });
    if (page.length === 0) break;

    for (const row of page) {
      if (coveredCodes.has(row.schemeCode)) continue;
      selected.push(row.schemeCode);
      if (selected.length >= limit) return selected;
    }

    skip += page.length;
    if (page.length < PAGE) break;
  }

  return selected;
}

/**
 * The STANDING reconcile — MONEY-1405.
 *
 * ## Why the one inside the backfill loop is not enough
 *
 * That reconcile rides `selectSchemesMissingHistory`, whose population is
 * schemes with NO `mf_nav_history` rows. That set DRAINS as this job succeeds:
 * once the backfill has done its work nothing is selected, nothing is compared,
 * and `navCompared` reads 0 for ever while `judgeMfNavBackfillHealth` reports
 * `ok: true, "nothing-to-do"`. The comment beside the counters already says
 * "a reconcile that compares nothing agrees with everything" — this is the half
 * that stops that being true of our own reconcile.
 *
 * ## It needs no upstream call
 *
 * Both quantities are already stored: AMFI's is `MutualFundMaster.nav`, MFAPI's
 * is `MfNavHistory.nav`. The in-loop version compares FRESHLY FETCHED points
 * because that is where they happen to be; comparing the STORED rows is
 * cheaper and closer to the question a reader cares about, which is whether the
 * two numbers we SERVE agree. Two indexed reads, no MFAPI request, no budget.
 *
 * ## It rotates
 *
 * A fixed sample re-checks one head for ever (MONEY-1211). `rotatingSlice`
 * walks the sorted population a page per day. There is no marker column to
 * stamp — the population is a query result, not a table this job owns — so the
 * rotation is derived from the day rather than from stored state.
 */
async function reconcileStoredNavs(
  now: Date,
): Promise<{ compared: number; disagreements: number; sample: string[] }> {
  const covered = await prisma.mfNavHistory.groupBy({ by: ["schemeCode"] });
  const codes = covered.map((r) => r.schemeCode).sort();
  const slice = rotatingSlice(codes, MF_NAV_RECONCILE_SAMPLE, dayIndex(now));
  if (slice.length === 0) return { compared: 0, disagreements: 0, sample: [] };

  const masters = await prisma.mutualFundMaster.findMany({
    where: { schemeCode: { in: slice } },
    select: { schemeCode: true, nav: true, navDate: true },
  });

  // One windowed query for the whole slice rather than 400 per-scheme reads.
  const oldest = masters.reduce<Date | null>(
    (min, m) => (m.navDate && (!min || m.navDate < min) ? m.navDate : min),
    null,
  );
  if (oldest === null) return { compared: 0, disagreements: 0, sample: [] };

  const history = await prisma.mfNavHistory.findMany({
    where: { schemeCode: { in: slice }, date: { gte: oldest } },
    select: { schemeCode: true, date: true, nav: true },
  });
  const byScheme = new Map<string, Array<{ date: Date; nav: number }>>();
  for (const h of history) {
    const list = byScheme.get(h.schemeCode) ?? [];
    list.push({ date: h.date, nav: h.nav });
    byScheme.set(h.schemeCode, list);
  }

  let compared = 0;
  let disagreements = 0;
  const sample: string[] = [];
  for (const m of masters) {
    const verdict = reconcileSchemeNav(
      { nav: m.nav, navDate: m.navDate },
      byScheme.get(m.schemeCode) ?? [],
    );
    if (verdict.drift === null) continue;
    compared++;
    if (verdict.verdict === "disagree") {
      disagreements++;
      if (sample.length < 10) {
        sample.push(
          `${m.schemeCode}(amfi=${m.nav ?? "?"}, drift=${(verdict.drift * 100).toFixed(2)}%)`,
        );
      }
    }
  }
  return { compared, disagreements, sample };
}

/** Outcome of one scheme's backfill. */
interface SchemeBackfillResult {
  schemeCode: string;
  /** Rows newly written. */
  inserted: number;
  /** Usable points the upstream returned. */
  total: number;
  /** Points already present (skipped, not an error). */
  existing: number;
  error?: string;
  /** AMFI-vs-MFAPI verdict for this scheme — MONEY-1404 C2. */
  navCheck?: MfNavReconcileResult;
}

/** AMFI's master NAV for one scheme, as `mf-sync` last wrote it. */
type MasterNav = { nav: number | null; navDate: Date | null };

/**
 * Fetch a scheme's full NAV history and write the rows we do not already hold.
 *
 * Round trips: 1 fetch + 1 `findMany` + ceil(new / 1,000) `createMany`. For a
 * typical 609-point fund that is 2 database calls, down from the 609 sequential
 * upserts this replaced.
 */
async function backfillSchemeNav(
  schemeCode: string,
  master?: MasterNav,
): Promise<SchemeBackfillResult> {
  try {
    const points = await fetchMfNavPoints(schemeCode);
    if (points.length === 0) {
      return { schemeCode, inserted: 0, total: 0, existing: 0 };
    }

    // ── AMFI vs MFAPI — MONEY-1404 C2 ──
    //
    // Done HERE because this is the only place the fetched points exist. The
    // alternative — re-reading `mf_nav_history` after the write — would compare
    // our own row against our own row and agree by construction.
    const navCheck = reconcileSchemeNav(master, points);

    const stored = await prisma.mfNavHistory.findMany({
      where: {
        schemeCode,
        date: { gte: points[0]!.date, lte: points[points.length - 1]!.date },
      },
      select: { date: true },
    });

    const missing = selectMissingNavPoints(
      points,
      stored.map((r) => r.date),
    );
    const existing = points.length - missing.length;

    let inserted = 0;
    for (let i = 0; i < missing.length; i += MF_NAV_INSERT_CHUNK) {
      const chunk = missing.slice(i, i + MF_NAV_INSERT_CHUNK);
      try {
        const res = await prisma.mfNavHistory.createMany({
          data: chunk.map((p) => ({ schemeCode, date: p.date, nav: p.nav })),
        });
        inserted += res.count;
      } catch (error) {
        // A concurrent backfill of the same scheme can land a row between our
        // diff and our write; the (schemeCode, date) unique throws the WHOLE
        // createMany (Prisma-Mongo has no usable skipDuplicates — see
        // yahoo-price-service.ts:172). Fall back to per-row inserts for this
        // chunk only, so one collision costs a chunk and not the run.
        console.warn(
          `[mf-nav-backfill] bulk insert collided for ${schemeCode} ` +
            `(chunk ${Math.floor(i / MF_NAV_INSERT_CHUNK)}), falling back to per-row: ` +
            `${error instanceof Error ? error.message : error}`,
        );
        for (const p of chunk) {
          try {
            await prisma.mfNavHistory.create({
              data: { schemeCode, date: p.date, nav: p.nav },
            });
            inserted++;
          } catch {
            // Already there — a no-op, not a failure.
          }
        }
      }
    }

    return { schemeCode, inserted, total: points.length, existing, navCheck };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[mf-nav-backfill] ${schemeCode} failed: ${msg}`);
    return { schemeCode, inserted: 0, total: 0, existing: 0, error: msg };
  }
}

export async function processMfNavBackfill(
  data: MfNavBackfillMessage,
): Promise<void> {
  const params = resolveMfNavBackfillParams(data);
  const startedAt = Date.now();

  const schemes = params.universe
    ? await selectSchemesMissingHistory(params.batchSize)
    : params.schemeCodes.slice(0, params.batchSize);

  console.log(
    `[mf-nav-backfill] Starting (mode=${params.universe ? "universe" : "explicit"}, ` +
      `reason=${params.reason}, selected=${schemes.length}, ` +
      `batch=${params.batchSize}, delay=${params.delayMs}ms, budget=${params.budgetMs}ms)`,
  );

  const tally: MfNavBackfillTally = {
    selected: schemes.length,
    succeeded: 0,
    empty: 0,
    failed: 0,
    alreadyComplete: 0,
    inserted: 0,
    budgetExhausted: false,
    navCompared: 0,
    navDisagreements: 0,
  };

  // AMFI's side of the reconcile, for exactly the schemes this run will touch —
  // ONE query for the whole batch (<= batchSize rows), not one per scheme.
  const masterNavs = new Map<string, MasterNav>(
    (
      await prisma.mutualFundMaster.findMany({
        where: { schemeCode: { in: schemes } },
        select: { schemeCode: true, nav: true, navDate: true },
      })
    ).map((r) => [r.schemeCode, { nav: r.nav, navDate: r.navDate }]),
  );
  const navDisagreementSample: string[] = [];

  for (let i = 0; i < schemes.length; i++) {
    if (isBudgetExhausted(startedAt, Date.now(), params.budgetMs)) {
      tally.budgetExhausted = true;
      // Everything already written stays written; re-select next run.
      tally.selected = i;
      console.warn(
        `[mf-nav-backfill] Wall-clock budget (${params.budgetMs}ms) reached after ` +
          `${i}/${schemes.length} schemes — committing and stopping so the run ` +
          `finishes inside the Pub/Sub ack deadline.`,
      );
      break;
    }

    const schemeCode = schemes[i]!;
    const result = await backfillSchemeNav(
      schemeCode,
      masterNavs.get(schemeCode),
    );

    if (result.navCheck && result.navCheck.drift !== null) {
      tally.navCompared++;
      if (result.navCheck.verdict === "disagree") {
        tally.navDisagreements++;
        if (navDisagreementSample.length < 10) {
          const master = masterNavs.get(schemeCode);
          navDisagreementSample.push(
            `${schemeCode}(amfi=${master?.nav ?? "?"}, ` +
              `drift=${(result.navCheck.drift * 100).toFixed(2)}%)`,
          );
        }
      }
    }

    if (result.error) {
      tally.failed++;
    } else if (result.inserted > 0) {
      tally.succeeded++;
      tally.inserted += result.inserted;
    } else if (result.total === 0) {
      // The upstream answered and has no history for this scheme. A real
      // answer, not a failure — and NOT the same as a fetch error.
      tally.empty++;
    } else {
      tally.alreadyComplete++;
    }

    if (shouldLogProgress(i)) {
      console.log(
        `[mf-nav-backfill] Progress: ${i + 1}/${schemes.length} ` +
          `(succeeded=${tally.succeeded}, rows=${tally.inserted}, failed=${tally.failed})`,
      );
    }

    if (shouldSleepAfterIndex(i, schemes.length) && params.delayMs > 0) {
      await sleep(params.delayMs);
    }
  }

  const health = judgeMfNavBackfillHealth(tally);

  // ── The reconcile's finding — MONEY-1404 C2 ────────────────────────────────
  //
  // A disagreement does NOT fail the run: both rows are written, both vendors
  // answered, and which one is wrong is a question for a person. It rides
  // `skippedReason` into the `[job-outcome]` line (the only free-text channel
  // there), the summary below, and — since MONEY-1408 — two counters of its
  // own.
  // THE STANDING PASS, run whatever the backfill selected — MONEY-1405.
  // Best-effort: it is a CHECK, and a check that fails must not fail the run
  // that was only being checked. Its failure is named rather than swallowed,
  // because "the reconcile did not run" and "the reconcile found nothing to
  // compare" are different facts and only one of them is reassuring.
  //
  // AND ITS FAILURE IS A COUNTED STATE, not just a warn — MONEY-1401 review
  // finding 5(c). Swallowed, a thrown reconcile leaves `navCompared` at the
  // in-loop count, which on a fully-backfilled universe is ZERO — identical to
  // a standing pass that ran and honestly found nothing to compare. The one
  // number that separates them is `job.unhealthy`.
  let reconcileFailed: string | null = null;
  try {
    const standing = await reconcileStoredNavs(new Date());
    tally.navCompared += standing.compared;
    tally.navDisagreements += standing.disagreements;
    navDisagreementSample.push(
      ...standing.sample.slice(
        0,
        Math.max(0, 10 - navDisagreementSample.length),
      ),
    );
  } catch (error) {
    reconcileFailed = error instanceof Error ? error.message : String(error);
    console.warn(
      `[mf-nav-backfill] the standing NAV reconcile did not run: ` +
        `${reconcileFailed}`,
    );
  }

  // Built HERE, not beside `health` above, because the standing pass adds to
  // `tally.navCompared` and a template literal is evaluated where it is
  // written. Above, this line reported the IN-LOOP count only — which on a
  // fully-backfilled universe is 0 while the standing pass compared 400, so
  // the one number a human reads and the one Datadog receives disagreed by
  // the whole reconcile. `health` stays above: it reads none of these fields.
  const summary =
    `[mf-nav-backfill] Done: selected=${tally.selected} succeeded=${tally.succeeded} ` +
    `rows=${tally.inserted} alreadyComplete=${tally.alreadyComplete} ` +
    `empty=${tally.empty} failed=${tally.failed} ` +
    `navCompared=${tally.navCompared} navDisagreements=${tally.navDisagreements} ` +
    `budgetExhausted=${tally.budgetExhausted} elapsed=${Date.now() - startedAt}ms`;

  // ── The series — MONEY-1408 ──────────────────────────────────────────────
  //
  // `stockbook.mf.nav_compared` / `stockbook.mf.nav_disagreements` — the
  // prefix is `METRIC_PREFIX`, prepended by `datadog-metrics`. NOT
  // `JobOutcome` fields: that contract carries four metrics for EVERY job in
  // the repo and this is one job's concern.
  //
  // BOTH, and `nav_compared` unconditionally — zero included. It is the
  // LIVENESS half: a disagreement series alone cannot separate "0
  // disagreements" from "compared nothing", and comparing nothing is exactly
  // the failure this reconcile exists to prevent in the data it watches. The
  // eventual monitor's `default_zero()` also needs the series to exist.
  //
  // OUTSIDE the try above on purpose: a standing pass that threw still leaves
  // an honest in-loop count, and a night with NO series at all is a different
  // fact from a night that compared nothing.
  //
  // Wrapped for the reason `reportJobOutcome` wraps its own four: a metrics
  // backend that is down must not fail the run it was reporting on.
  // `incrementCounter` no-ops when DD_API_KEY is unset (tests, local dev), but
  // `datadogMetrics.init()` throws on a malformed config — that is the throw
  // this catches, not the emit.
  try {
    incrementCounter("mf.nav_compared", tally.navCompared, {
      job: "mf-nav-backfill",
    });
    incrementCounter("mf.nav_disagreements", tally.navDisagreements, {
      job: "mf-nav-backfill",
    });
  } catch {
    // Reporting is never worth failing a run for.
  }

  const navNote =
    tally.navDisagreements > 0
      ? `nav-disagreements: ${tally.navDisagreements}/${tally.navCompared} schemes ` +
        `differ from MutualFundMaster by >` +
        `${(MF_NAV_DISAGREEMENT_TOLERANCE * 100).toFixed(1)}% ` +
        `[${navDisagreementSample.join(" ")}]`
      : null;

  if (navNote) console.warn(`[mf-nav-backfill] ${navNote}`);

  // `selected` EXCLUDES the already-complete funds — MONEY-1238. Those had no
  // write coming, so counting them would alarm on a fully-backfilled universe,
  // which is the SUCCESS state this job is working toward.
  // A health failure is the louder of the two, so it leads; the nav note rides
  // along rather than replacing it, because losing the reconcile's finding
  // exactly when the run is also unhealthy is the wrong trade.
  const notes =
    [
      reconcileFailed ? `reconcile-unmeasured: ${reconcileFailed}` : null,
      navNote,
    ]
      .filter((n): n is string => n !== null)
      .join(" :: ") || null;
  const skippedReason = health.ok
    ? notes
    : `${health.reason}: ${health.message}` + (notes ? ` :: ${notes}` : "");

  reportJobOutcome({
    job: "mf-nav-backfill",
    selected: tally.selected - tally.alreadyComplete,
    written: tally.inserted,
    failed: tally.failed,
    // BOTH arms. `!health.ok` also throws below, so Pub/Sub retries it — that
    // is right for an MFAPI outage and wrong for a check that broke, which is
    // why `reconcileFailed` marks the run unhealthy WITHOUT failing it.
    unhealthy: !health.ok || reconcileFailed !== null,
    ...(skippedReason ? { skippedReason } : {}),
  });

  if (!health.ok) {
    console.error(`${summary} :: ${health.reason} — ${health.message}`);
    throw new Error(`[mf-nav-backfill] ${health.reason}: ${health.message}`);
  }

  console.log(summary);
}
