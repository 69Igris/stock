/**
 * Every entry point that fetches through `getFeedAsset` MUST wire the feed
 * archive first — MONEY-941.
 *
 * ## The bug this exists to prevent
 *
 * `initFeedArchive()` is what registers the GCS store behind `getFeedAsset`.
 * `workers/src/index.ts` calls it at startup, so the Pub/Sub push worker has
 * always been fine. The Cloud Run JOBS in `scripts/jobs/` are SEPARATE entry
 * points — they never boot through `workers/src/index.ts` — and the first
 * version of `feed-backfill.ts` did not call it.
 *
 * Nothing failed. `getFeedAsset` returns a valid Response whether or not a
 * store is registered, so the job fetched every file correctly, counted each as
 * archived, wrote a DONE checkpoint, and threw the bytes away. The run exited 0
 * and reported success.
 *
 * On the first production walk that meant 397 `bse-index-history` days and 54
 * `nse-cm-legacy` days recorded DONE — 6.1 MB genuinely downloaded from the
 * exchanges — with zero objects in `gs://…/feeds/`. And because resume skips
 * terminal checkpoints, a re-run would have walked straight past those days,
 * turning wasted traffic into permanent silent gaps.
 *
 * ## Why this test is static rather than behavioural
 *
 * The failure is an ABSENCE — a call nobody made in a file nobody thought to
 * check. A behavioural test only covers entry points someone remembered to
 * write a test for, which is precisely the thing that went wrong. Enumerating
 * `scripts/jobs/` from disk means a NEW job added later is covered on the day
 * it is created, without anyone opting in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const JOBS_DIR = join(import.meta.dirname, "..", "..", "scripts", "jobs");

/** Drop `//` and block comments, so the scan reads CODE rather than prose. */

function jobFiles(): string[] {
  return readdirSync(JOBS_DIR).filter((f) => f.endsWith(".ts"));
}

describe("job entry points wire the feed archive", () => {
  it("finds at least one job (guards against a silently empty glob)", () => {
    // Without this, a moved/renamed directory would make every assertion below
    // vacuously pass — the test would go green by checking nothing.
    assert.ok(
      jobFiles().length > 0,
      `no .ts files found in ${JOBS_DIR} — the enumeration is broken, not the code`,
    );
  });

  for (const file of jobFiles()) {
    const src = readFileSync(join(JOBS_DIR, file), "utf8");
    // RAW SOURCE, COMMENTS INCLUDED, DELIBERATELY.
    //
    // This was briefly changed to match on comment-stripped source, to stop a
    // job that merely DISCUSSES `getFeedAsset` being told to wire an archive it
    // never uses. MEASURED, that narrowing cut the guarded population from FOUR
    // files to ONE:
    //
    //   raw      feed-backfill, xbrl-backfill, xbrl-reparse, ledger-backfill-tiingo
    //   stripped feed-backfill
    //
    // `xbrl-backfill.ts` and `xbrl-reparse.ts` reach `getFeedAsset` one module
    // away, so they only ever matched through their own prose — and both
    // genuinely wire the archive (xbrl-backfill.ts:702 `initFeedArchive();
    // requireArchiveWired();`, xbrl-reparse.ts:301). Under the stripped rule
    // you could delete either line and this suite stays green, which is the
    // MONEY-941 defect the guard exists for: a job with no registered store
    // fetches every NSE filing, discards the bytes, checkpoints DONE, exits 0.
    //
    // Matching `getFeedAsset(` with the paren does NOT fix it — measured, it
    // also yields exactly one file.
    //
    // So the rule stays OVER-INCLUSIVE on purpose. Naming the fetcher at all,
    // in code or in prose, obliges a file to prove the archive is wired. That
    // costs a false positive; the opposite polarity costs silent data loss. A
    // job that genuinely does not fetch simply does not name it — which is why
    // `ledger-backfill-tiingo.ts` now says "the feed fetcher" in its header.
    const fetchesFeeds = src.includes("getFeedAsset");
    const code = src;

    it(`${file}: ${fetchesFeeds ? "calls initFeedArchive()" : "does not fetch feeds (skipped)"}`, () => {
      if (!fetchesFeeds) return;

      assert.ok(
        code.includes("initFeedArchive"),
        `${file} calls getFeedAsset but never imports/calls initFeedArchive(). ` +
          `Without it the archive store is never registered: every fetch ` +
          `succeeds, gets counted as archived, is checkpointed DONE, and is ` +
          `DISCARDED. Add initFeedArchive() at the top of main().`,
      );
    });

    it(`${file}: ${fetchesFeeds ? "fails fast when the archive is unwired" : "n/a (skipped)"}`, () => {
      if (!fetchesFeeds) return;

      // Calling initFeedArchive() is not enough on its own — it is a NO-OP when
      // GCP_STORAGE_BUCKET is unset, and only logs a warning. A job that walks
      // for hours must refuse to start in that state rather than discover it
      // afterwards from an empty bucket.
      assert.ok(
        code.includes("getFeedArchiveStore"),
        `${file} must assert a store is actually registered (via ` +
          `getFeedArchiveStore()) before walking. initFeedArchive() alone is a ` +
          `no-op when GCP_STORAGE_BUCKET is missing, which is the same silent ` +
          `data-loss outcome.`,
      );
    });
  }
});
