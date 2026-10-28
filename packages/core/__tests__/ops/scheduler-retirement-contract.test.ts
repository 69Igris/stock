/**
 * A retired scheduler must be listed for DELETION, not merely deleted — MONEY-1314.
 *
 * ## The invariant, and why an array cannot hold it
 *
 * `scripts/ops/setup-scheduler.sh` CREATES Cloud Scheduler jobs from
 * `SCHEDULER_DEFS`. Removing a line from that array stops the script creating
 * the job and does NOTHING WHATSOEVER to the one already live in Cloud
 * Scheduler — which keeps firing on its old cadence, forever, against a route
 * that may no longer exist. `OLD_SCHEDULER_PREFIXES` is the only thing that
 * takes it down: `delete_old_schedulers` builds `${PREFIX}-${ENV}` and deletes
 * that exact job before the create pass runs.
 *
 * The script states this invariant as a COMMENT, four lines above the array
 * that cannot enforce it. Nothing checked it. The existing parser in
 * `prod-only-sync-coverage.test.ts` asserts only `names.length > 30` against 77
 * definitions, so 47 entries could vanish and every check would still pass.
 *
 * ## The shape: a ratchet, not a count
 *
 * `SCHEDULER_DEFS_SNAPSHOT` below is every job name that has EVER appeared in
 * `SCHEDULER_DEFS`, derived from the file's full git history (81 distinct
 * names). It is checked in, so it moves only when a human moves it:
 *
 *   - a name in the snapshot but absent from the array MUST be in
 *     `OLD_SCHEDULER_PREFIXES` — otherwise it is a live job nobody is taking
 *     down;
 *   - the snapshot must be a SUPERSET of the array — so adding a job forces a
 *     snapshot bump, which is the ratchet advancing rather than a wall.
 *
 * All four names retired so far (`financial-data-sync-weekly`,
 * `ratios-sync-daily`, `corporate-actions-sync-weekly`, `ownership-sync-daily`)
 * are correctly listed. This test freezes that, so the fifth cannot be dropped
 * silently.
 *
 * NOTE the snapshot covers `SCHEDULER_DEFS` only. `stockbook-daily-sync-${ENV}`
 * is upserted by a hardcoded call outside the array and is not in scope here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Walk up to the monorepo root, then ASSERT we found it. `packages/core` is ESM
 * and its test script sets CWD to the package dir; an anchor that silently
 * resolved to the wrong directory would make every scan below read nothing and
 * pass. (Same idiom as topic-publisher-coverage.test.ts.)
 */
function findRepoRoot(from: string = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(join(dir, "turbo.json")) &&
      existsSync(join(dir, "packages"))
    ) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root from ${from}`);
}

const REPO_ROOT = findRepoRoot();
const SCHEDULER_PATH = join(REPO_ROOT, "scripts", "ops", "setup-scheduler.sh");
const SRC = readFileSync(SCHEDULER_PATH, "utf8");

/**
 * Every job name ever defined in `SCHEDULER_DEFS`, from the full git history of
 * setup-scheduler.sh as of 2026-09-01. Regenerate with:
 *
 *   for sha in $(git log --format=%H -- scripts/ops/setup-scheduler.sh); do
 *     git show "$sha:scripts/ops/setup-scheduler.sh" \
 *       | awk '/SCHEDULER_DEFS=\(/{f=1;next} f&&/^\)/{f=0} f' \
 *       | grep -oE '^ {4}"[a-z0-9-]+\|' | sed -E 's/^ +"//; s/\|$//'
 *   done | sort -u
 *
 * ONLY EVER ADD. Deleting a line here would let the very job it names be
 * dropped from `SCHEDULER_DEFS` without a retirement entry — which is the
 * defect this file exists to catch.
 */
const SCHEDULER_DEFS_SNAPSHOT: readonly string[] = [
  "alert-evaluator-market-hours",
  "alert-evaluator-off-hours",
  "annual-reports-sync-daily",
  "bhavcopy-sync-daily",
  "broker-sync-evening",
  "broker-sync-historical-weekly",
  "broker-sync-market-hours",
  "bse-announcements-sync-daily",
  "candle-evict-daily",
  "chartink-strategy-monthly",
  "circulars-sync-daily",
  "clerk-delete-sweep-hourly",
  "corporate-actions-sync-daily",
  "corporate-actions-sync-weekly",
  "credit-reservation-cleanup",
  "document-financials-projection-daily",
  "edgar-cusip-sweep-daily",
  "edgar-detect-minutely",
  "edgar-evict-daily",
  "edgar-full-index-weekly",
  "edgar-reconcile-hourly",
  "etf-expense-enrichment-weekly",
  "events-sync-daily",
  "filings-sync-weekly",
  "financial-data-sync-weekly",
  "index-constituent-sync-weekly",
  "institutional-flow-sync-daily",
  "instrument-sync-daily",
  "intent-learning-daily",
  "intraday-sync-daily",
  "investor-rollup-daily",
  "ipo-sync-daily",
  "macro-sync-midweek",
  "macro-sync-weekly",
  "market-movers-sync-intraday",
  "mf-metadata-weekly",
  "mf-nav-backfill-daily",
  "mf-nav-propagate-daily",
  "mf-portfolio-sync-monthly",
  "mf-portfolio-sync-retry",
  "mf-sync-daily",
  "news-rss-sync-market-hours",
  "news-rss-sync-off-hours",
  "news-sync-market-hours",
  "newsletter-publish-check",
  "nse-announcements-sync-daily",
  "ownership-sync-bse",
  "ownership-sync-daily",
  "ownership-sync-pit",
  "ownership-sync-pledge",
  "ownership-sync-sast",
  "ownership-sync-shp",
  "ownership-sync-shp-xbrl",
  "peers-sync-daily",
  "price-backfill-incremental-daily",
  "price-sync-daily",
  "ratios-sync-daily",
  "report-archive-drift-weekly",
  "report-archive-monthly",
  "report-archive-sync-evening",
  "report-archive-sync-night",
  "resend-contact-sync-weekly",
  "sector-enrichment-weekly",
  "sparkline-sync-market-hours",
  "sparkline-sync-post-close",
  "stock-document-extract-daily",
  "stock-document-parse-daily",
  "stock-document-parse-evening",
  "stock-document-parse-midday",
  "stock-document-parse-morning",
  "stock-document-sync-screener-daily",
  "stock-document-sync-tickertape-daily",
  "stock-document-sync-weekly",
  "strategy-stats-sync-weekly",
  "surveillance-sync-daily",
  "tiingo-news-poll",
  "us-eod-sync-daily",
  // MONEY-1324 (P17) — the 8-K/6-K exhibit insight sweep, */10 all seven days.
  "us-filing-insight-sweep",
  "us-instrument-master-sync-daily",
  "xbrl-projection-daily",
  "xbrl-ratios-daily",
  "xbrl-sync-daily",
];

/** The `SCHEDULER_DEFS=( ... )` block, verbatim. */
function defsBlock(src: string): string {
  const start = src.indexOf("SCHEDULER_DEFS=(");
  assert.notEqual(
    start,
    -1,
    "SCHEDULER_DEFS=( not found — the parser is stale",
  );
  const end = src.indexOf("\n)", start);
  assert.ok(end > start, "unterminated SCHEDULER_DEFS array");
  return src.slice(start, end);
}

/**
 * Job names from a defs block. Same 4-space-indent anchor as
 * prod-only-sync-coverage.test.ts — the only other place that parses all 77 in
 * one pass — so the two cannot disagree about what a definition looks like.
 */
function parseDefNames(block: string): string[] {
  return [...block.matchAll(/^ {4}"([a-z0-9-]+)\|/gm)].map((m) => m[1]!);
}

/** The `OLD_SCHEDULER_PREFIXES=( ... )` entries. */
function parseRetired(src: string): string[] {
  const start = src.indexOf("OLD_SCHEDULER_PREFIXES=(");
  assert.notEqual(start, -1, "OLD_SCHEDULER_PREFIXES=( not found");
  const end = src.indexOf("\n)", start);
  assert.ok(end > start, "unterminated OLD_SCHEDULER_PREFIXES array");
  const block = src.slice(start, end);
  // Strip comments first: the block's comment prose quotes job names
  // ("corporate-actions-sync-daily", "news-sync-market-hours"), and counting
  // those as entries would let a genuinely missing retirement pass.
  const code = block.replace(/#.*$/gm, "");
  return [...code.matchAll(/^\s{4}"([a-z0-9-]+)"\s*$/gm)].map((m) => m[1]!);
}

/**
 * THE CHECK, as a pure function so a control case can drive it with synthetic
 * input. A snapshot name that is neither still defined nor listed for deletion
 * is a job firing in production that nothing will ever take down.
 *
 * Retirement is EXACT-name, not prefix: `delete_old_schedulers` deletes
 * `${PREFIX}-${ENV}`, so "ownership-sync" would NOT retire
 * "ownership-sync-daily".
 */
function unretiredOrphans(
  snapshot: readonly string[],
  current: readonly string[],
  retired: readonly string[],
): string[] {
  const live = new Set(current);
  const listed = new Set(retired);
  return snapshot.filter((n) => !live.has(n) && !listed.has(n)).sort();
}

const BLOCK = defsBlock(SRC);
const CURRENT = parseDefNames(BLOCK);
const RETIRED = parseRetired(SRC);

describe("setup-scheduler.sh retirement contract (MONEY-1314)", () => {
  it("parsed both arrays — a parser that finds nothing would pass everything", () => {
    // Hard floors, not `> 30`. Measured 2026-09-01: 77 defs, 9 retirements.
    assert.ok(
      CURRENT.length >= 70,
      `parsed only ${CURRENT.length} SCHEDULER_DEFS entries — the parser is stale`,
    );
    assert.ok(
      RETIRED.length >= 9,
      `parsed only ${RETIRED.length} OLD_SCHEDULER_PREFIXES entries — the parser is stale`,
    );
    assert.ok(
      SCHEDULER_DEFS_SNAPSHOT.length >= CURRENT.length,
      "the snapshot is smaller than the live array",
    );
  });

  it("the snapshot has no duplicates", () => {
    const seen = new Map<string, number>();
    for (const n of SCHEDULER_DEFS_SNAPSHOT)
      seen.set(n, (seen.get(n) ?? 0) + 1);
    assert.deepEqual(
      [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n),
      [],
    );
  });

  it("REGRESSION: every dropped job is listed for DELETION", () => {
    assert.deepEqual(
      unretiredOrphans(SCHEDULER_DEFS_SNAPSHOT, CURRENT, RETIRED),
      [],
      "These job names were in SCHEDULER_DEFS and are not any more, and they " +
        "are NOT in OLD_SCHEDULER_PREFIXES. Removing the definition only stops " +
        "this script CREATING the job — the one already live in Cloud " +
        "Scheduler keeps firing on its old cadence forever, against a route " +
        "that may no longer exist. Fix: add the exact job base name to " +
        "OLD_SCHEDULER_PREFIXES (delete_old_schedulers deletes " +
        "`${PREFIX}-${ENV}`), then run setup-scheduler.sh in every env.",
    );
  });

  it("[ratchet] the snapshot is a superset of the live array", () => {
    const missing = CURRENT.filter(
      (n) => !SCHEDULER_DEFS_SNAPSHOT.includes(n),
    ).sort();
    assert.deepEqual(
      missing,
      [],
      "New jobs are defined but absent from SCHEDULER_DEFS_SNAPSHOT. Add them " +
        "— that bump is the ratchet moving forward, and it is what makes a " +
        "LATER removal of these names detectable.\n" +
        missing.join("\n"),
    );
  });

  it("[ratchet] no retirement entry names a job that is still defined", () => {
    // delete_old_schedulers runs BEFORE the create pass, so a collision would
    // delete-then-recreate the job on every run in every env. Harmless-looking
    // churn that masks a real retirement that never took effect.
    const collisions = RETIRED.filter((r) => CURRENT.includes(r)).sort();
    assert.deepEqual(
      collisions,
      [],
      "These names are in OLD_SCHEDULER_PREFIXES AND still in SCHEDULER_DEFS. " +
        "The script would delete each one and immediately recreate it.\n" +
        collisions.join("\n"),
    );
  });

  it("pins the four retirements that exist today", () => {
    // Named, so that dropping one from OLD_SCHEDULER_PREFIXES fails by NAME
    // rather than only through the snapshot arithmetic.
    for (const name of [
      "financial-data-sync-weekly",
      "ratios-sync-daily",
      "corporate-actions-sync-weekly",
      "ownership-sync-daily",
    ]) {
      assert.ok(
        SCHEDULER_DEFS_SNAPSHOT.includes(name),
        `${name} is missing from the snapshot`,
      );
      assert.ok(
        !CURRENT.includes(name),
        `${name} is defined again — if that is intended, drop it from OLD_SCHEDULER_PREFIXES too`,
      );
      assert.ok(
        RETIRED.includes(name),
        `${name} would keep firing — it is not in OLD_SCHEDULER_PREFIXES`,
      );
    }
  });

  it("[control] a dropped-and-unlisted job IS detected", () => {
    // The check must be able to FAIL. Three synthetic shapes.
    assert.deepEqual(
      unretiredOrphans(["a", "b", "ghost-daily"], ["a", "b"], []),
      ["ghost-daily"],
      "an orphan was not detected — the real assertion above is vacuous",
    );

    // Dropped BUT listed -> clean.
    assert.deepEqual(
      unretiredOrphans(["a", "b", "ghost-daily"], ["a", "b"], ["ghost-daily"]),
      [],
    );

    // Prefix-ish partial must NOT count as retired: the script deletes
    // `${PREFIX}-${ENV}` by exact name, so "ghost" does not retire "ghost-daily".
    assert.deepEqual(
      unretiredOrphans(["ghost-daily"], [], ["ghost"]),
      ["ghost-daily"],
      "a partial name was accepted as a retirement — it would delete nothing",
    );

    // And the real snapshot with one real name un-listed must fail.
    assert.deepEqual(
      unretiredOrphans(
        SCHEDULER_DEFS_SNAPSHOT,
        CURRENT,
        RETIRED.filter((r) => r !== "ratios-sync-daily"),
      ),
      ["ratios-sync-daily"],
    );
  });

  it("[control] the parsers read the real file, not an empty string", () => {
    assert.ok(
      SRC.length > 10_000,
      "setup-scheduler.sh read as suspiciously small",
    );
    assert.ok(CURRENT.includes("xbrl-projection-daily"));
    assert.ok(BLOCK.includes("SCHEDULER_DEFS=("));
    // parseRetired must reject comment prose. `corporate-actions-sync-daily`
    // (the REPLACEMENT) is quoted inside the block's comments and is a live job.
    assert.ok(!RETIRED.includes("corporate-actions-sync-daily"));
  });
});
