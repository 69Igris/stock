/**
 * MONEY-1250 — `selected` must be work that was OWED A WRITE.
 *
 * ## What the sibling guard cannot see
 *
 * `packages/datadog/__tests__/job-outcome-coverage.test.ts` asks one question:
 * does this processor CALL `reportJobOutcome`? That is the right question for
 * the silence it was built to catch, and it is blind to the defect this file
 * exists for — a call that is present, wired, monitored, and reports a number
 * that means the wrong thing.
 *
 * Nine jobs sat in that file's `WRONG_SIGNAL` map on the stated grounds that "a
 * zero-write run is the NORMAL, HEALTHY outcome here". For eight of the nine
 * that was true of the number somebody had in mind, not of the job:
 *
 *     news-rss-sync       every item in the RSS channels (~200 a tick), when
 *                         the answer is the items that survived dedupe
 *     alert-evaluator     every ACTIVE alert row, when the answer is the alerts
 *                         whose condition actually fired
 *     resend-contact-sync every user, when the answer is the CHANGED users
 *     intraday-sync       bars fetched, when the answer is bars MISSING
 *     price-sync          instruments scanned, when the answer is bars owed
 *     market-movers-sync  rows parsed, when the answer is rows parsed on a leg
 *                         whose snapshot ADVANCED
 *     intent-learning     signals found, when the answer is writes DECIDED
 *
 * Each of those pairs would put the monitor into permanent alarm on a healthy
 * run, and a monitor in permanent alarm is muted inside a week — which removes
 * the only alert on the job that is actually broken. So the repair is not "add
 * a call"; it is "count the right population", and only the second half is
 * fragile. Reverting `toInsert.length` to `fresh.length` is a one-token edit
 * that keeps every other test in the repository green.
 *
 * ## Why this asserts on SOURCE TEXT
 *
 * These counts are computed inline in processors that cannot be imported
 * without booting Prisma and a network client, and extracting each of them into
 * a pure helper purely to test it would add nine indirections to production
 * code for the benefit of the test — the compensating machinery this repo has a
 * standing rule against. Reading the file is the same technique
 * `alert-evaluator-run-verdict.test.ts` and `intraday-sync-verdict.test.ts`
 * already use for wiring facts, and the assertions are two-sided: each job must
 * bind `selected` to the owed-work expression AND must not bind it to the naive
 * population that was rejected. A one-sided "contains" check would pass on a
 * file that contained both.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PROCESSOR_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "src",
  "processors",
);

/**
 * Blank comment BODIES so a `selected` named in PROSE cannot satisfy — or
 * violate — an assertion about CODE. Every rejected expression below is
 * discussed by name in the comment that explains why it was rejected, so
 * without this every `mustNotBind` entry would fail on its own rationale.
 *
 * Line comments before block comments (MONEY-1143): a `//` containing a slash
 * star otherwise opens a phantom block that swallows the code being checked.
 */
const blankComments = (src: string): string =>
  src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? "" : p1,
    )
    .replace(/\/\*[\s\S]*?\*\//g, "");

interface Case {
  file: string;
  /** Why this population is the one that was owed a write. */
  why: string;
  /** Exact source fragments that must all be present. */
  mustBind: string[];
  /**
   * `selected` bindings that must NOT appear. Each is a population that is
   * non-zero on a run the job is supposed to write nothing on.
   */
  mustNotBind: string[];
}

const CASES: Case[] = [
  {
    file: "alert-evaluator.ts",
    why: "alerts whose CONDITION was met, not every ACTIVE alert row — ~624 runs/day evaluate thousands and are meant to fire none",
    mustBind: [
      "const conditionsMet = fired + tally.notifyFailures;",
      "selected: conditionsMet,",
      "written: fired,",
    ],
    mustNotBind: [
      "selected: alerts.length",
      "selected: totals.evaluated",
      "selected: evaluated",
      "selected: fired + suppressedAsRepeat",
    ],
  },
  {
    file: "intent-learning.ts",
    why: "writes DECIDED, not signals found — the flash_failure / rephrase / low_confidence clusters carry no correction and owe no write at all",
    mustBind: ["selected: decided,", "written,", "decided++;", "written++;"],
    mustNotBind: [
      "selected: totalSignals",
      "selected: clusters.length",
      "selected: flashFailures.length",
    ],
  },
  {
    file: "intraday-sync.ts",
    why: "bars MISSING from the window, not bars fetched — the job runs with a deliberate 5-day overlap, so most of what it fetches is already stored",
    mustBind: [
      // `fetchFailures` is NOT in the row counters — MONEY-1250 review. It
      // counts CALLS, not bars, and has its own `transportFailures` metric and
      // warn branch. Pinning the ABSENCE is the point: folding it back in is a
      // one-token edit no other suite would see.
      "selected: totals.inserted + totals.failed,",
      "written: totals.inserted,",
      "transportFailures: tally.fetchFailures,",
    ],
    mustNotBind: [
      "selected: totals.fetched",
      "selected: instrumentIds.length",
      "selected: calls",
      "selected: totals.symbolsProcessed",
      // The revert this guards: calls back inside the row counters.
      "totals.inserted + totals.failed + tally.fetchFailures",
      "failed: totals.failed + tally.fetchFailures,",
    ],
  },
  {
    file: "investor-rollup.ts",
    why: "active users, against snapshots that are 1:1 with them — the snapshot write is unconditional, so there is no healthy zero-write run while users > 0",
    mustBind: ["selected: result.users,", "written: result.snapshots,"],
    mustNotBind: ["selected: result.insights", "written: result.insights"],
  },
  {
    file: "market-movers-sync.ts",
    why: "rows parsed on a leg whose snapshot ADVANCED — a no-change poll is the majority outcome and owes nothing",
    mustBind: [
      "if (leg.noChange) continue;",
      "selected += leg.parsed;",
      "written += leg.written;",
    ],
    mustNotBind: ["selected: result.movers", "written += leg.pruned"],
  },
  {
    file: "news-rss-sync.ts",
    why: "articles that survived BOTH dedupe gates, not every item in the feed",
    mustBind: ["selected: toInsert.length,", "written: inserted,"],
    mustNotBind: [
      "selected: fresh.length",
      "selected: dedupped.length",
      "selected: parsedBatches.length",
    ],
  },
  {
    file: "newsletter-publish.ts",
    why: "newsletters whose publishDate has ARRIVED — a post scheduled for tomorrow is not selected, and an overdue one is re-selected every 5 minutes until it publishes",
    mustBind: ["selected: duePosts.length,", "written: published,"],
    mustNotBind: ["selected: 1", "selected: published"],
  },
  {
    file: "price-sync.ts",
    why: "bars owed a write on the backfill branch, instruments selected on the quote branch — and two job ids, because the two branches have two definitions of health",
    mustBind: [
      // `fetchFailures` is NOT in `selected` — MONEY-1250 review. It counts
      // CALLS, not rows, and now has its own `transportFailures` counter with
      // its own metric and warn branch. Pinning its ABSENCE here is the point:
      // folding it back in is a one-token edit that no other suite would see.
      "selected: totals.inserted + totals.errors,",
      "written: totals.inserted,",
      "transportFailures: totals.fetchFailures,",
      "selected: result.selected,",
      "written: result.refreshed,",
      "transportFailures: tally.fetchFailures,",
      // Literals, not a computed id: the emit-site extractor in
      // job-outcome-coverage.test.ts matches only a quoted `job:` value.
      'job: "price-backfill"',
      'job: "price-sync"',
    ],
    // Named in terms of the PROCESSOR's own locals. `selected: instruments.length`
    // also appears in this file and is CORRECT there — it is
    // `BackfillTotals.selected`, a different object in a different scope, whose
    // job is to say how many instruments the selection chose. Forbidding the
    // bare text would fail on a line that is not the binding under test, which
    // is how a source assertion stops describing what it claims to.
    mustNotBind: [
      // The revert this guards: calls back inside the row counters.
      "totals.inserted + totals.errors + totals.fetchFailures",
      "failed: totals.errors + totals.fetchFailures,",
      "failed: result.failed + tally.fetchFailures,","selected: totals.selected", "selected: totals.attempted"],
  },
  {
    file: "resend-contact-sync.ts",
    why: "users whose watermark moved, not every user — the differential sync exists so an unchanged user costs nothing, and a quiet week is the feature",
    mustBind: [
      "const candidates = stats.total - stats.skippedUnchanged;",
      "selected: candidates,",
      "written: stats.synced,",
    ],
    mustNotBind: ["selected: stats.total", "selected: users.length"],
  },
];

const sources = new Map<string, Promise<string>>();
const load = (file: string): Promise<string> => {
  let p = sources.get(file);
  if (!p) {
    p = readFile(join(PROCESSOR_DIR, file), "utf8").then(blankComments);
    sources.set(file, p);
  }
  return p;
};

describe("MONEY-1250 — `selected` counts work that was owed a write", () => {
  it("[meta] every case names a file that exists and still reports", async () => {
    // A case pointing at a renamed or deleted file asserts nothing, and a
    // `mustBind` list that has quietly stopped being checked is worse than no
    // test — it is a green tick over an unguarded spot (MONEY-1093).
    assert.equal(CASES.length, 9, "nine jobs came out of WRONG_SIGNAL");
    for (const c of CASES) {
      const src = await load(c.file);
      assert.ok(src.length > 500, `${c.file} did not load`);
      assert.match(
        src,
        /reportJobOutcome\(/,
        `${c.file} no longer reports an outcome at all — the sibling coverage ` +
          `ratchet should have caught this first`,
      );
      assert.ok(c.mustBind.length > 0 && c.mustNotBind.length > 0, c.file);
    }
  });

  for (const c of CASES) {
    it(`${c.file} binds selected to ${c.why}`, async () => {
      const src = await load(c.file);
      const missing = c.mustBind.filter((frag) => !src.includes(frag));
      assert.deepEqual(
        missing,
        [],
        `${c.file} no longer contains the owed-work wiring. ` +
          `selected must be ${c.why}.\nmissing:\n${missing.join("\n")}`,
      );
    });

    it(`${c.file} does not bind selected to the population it scans`, async () => {
      const src = await load(c.file);
      const found = c.mustNotBind.filter((frag) => src.includes(frag));
      assert.deepEqual(
        found,
        [],
        `${c.file} binds \`selected\` to a population that is non-zero on a ` +
          `run this job is SUPPOSED to write nothing on. The zero-write ` +
          `monitor is \`selected > 0 AND written < 1\`, so this makes it fire ` +
          `on healthy runs until somebody mutes it — and a muted monitor is ` +
          `how the six MONEY-1220 incidents stayed invisible.\n` +
          `selected must be ${c.why}.\nfound:\n${found.join("\n")}`,
      );
    });
  }
});
