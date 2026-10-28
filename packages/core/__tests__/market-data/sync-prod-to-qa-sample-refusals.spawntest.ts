/**
 * `sync-prod-to-qa --tier=sample` — WHAT THE SCRIPT REFUSES TO DO.
 *
 * Split out of `sync-prod-to-qa-sample-tier.test.ts` by MONEY-1316: that file
 * did ~45 s of `spawnSync` work against a 30 s FILE-level timeout, and a
 * timed-out file is cancelled rather than failed — so it reported a file-level
 * `not ok` with `# fail 0`, and a green `verify:push` did not prove it had run.
 * The split halved the cost and did not clear the wall (9.1 s standalone, ~2.5x
 * that under parallel load), so the `.spawntest.ts` suffix now routes this file
 * into a second `node --test` lane at `--test-timeout=180000`. The suffix is the
 * whole wiring — see `sync-prod-to-qa-sample-harness.ts` for why a lane and not
 * a raised default, and `ops/spawntest-lane-wiring.test.ts` for what pins it.
 *
 * These are the cases where the correct behaviour is to STOP: an empty sample
 * that would turn a copy into a deletion, a collection the plan does not
 * cover, a plan that cannot be built at all, an incompatible flag pair, and an
 * interrupt. Every one of them guards the single path that can DELETE a QA
 * collection, which is why they drive the real script rather than asserting on
 * its prose.
 *
 * Its sibling `sync-prod-to-qa-sample-plan.spawntest.ts` covers what the script
 * BUILDS and FORWARDS. A new case belongs here if the expected outcome is a
 * refusal, and there if it is a plan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  SPAWNING_SUITE,
  STUBS,
  runSync,
  dumps,
  restores,
  REF,
  PLAN,
  PLAN_FILE,
  planLines,
  planFileWithout,
} from "./sync-prod-to-qa-sample-harness";

describe(
  "--tier=sample: the sampled empty-guard (a 0-row query would DELETE the table)",
  SPAWNING_SUITE,
  () => {
    it("copies every collection when the sample matches rows (the control)", () => {
      const r = runSync({ STUB_PLAN_FILE: PLAN_FILE });
      assert.equal(r.status, 0, r.out.slice(-2000));
      assert.match(r.out, /Reference-Data Sync Complete!/);

      const d = dumps(r.log);
      assert.equal(
        d.length,
        REF.length,
        "every collection should have been dumped",
      );
      assert.equal(restores(r.log).length, REF.length);
      // The whole point of the tier: not one of them was a full-collection dump.
      assert.deepEqual(
        d.filter((x) => x.query === "<NONE>"),
        [],
        "a collection was dumped with NO --query — that is a full copy under a tier that promised a sample",
      );
      assert.match(r.log, /RELINK_RAN/);
    });

    it("SKIPS a collection whose sample matched 0 rows — no dump, no restore, QA untouched", () => {
      const r = runSync({
        STUB_PLAN_FILE: PLAN_FILE,
        STUB_ZERO_SAMPLE: "stock_flags",
      });

      // The premise: prod is NOT empty for it, so the ordinary empty-guard did
      // not fire. Only the SAMPLED count was zero.
      assert.match(
        r.log,
        /^COUNT stock_flags$/m,
        "the empty-guard count never ran for it",
      );
      assert.match(
        r.log,
        /^SCOUNT stock_flags$/m,
        "the sampled count never ran for it",
      );

      const d = dumps(r.log);
      assert.deepEqual(
        d.filter((x) => x.collection === "stock_flags"),
        [],
        "stock_flags was dumped despite a 0-row sample — mongorestore --drop would have emptied QA's table",
      );
      assert.ok(!restores(r.log).includes("stock_flags"));

      // Targeted, not a global bail: every OTHER collection still copied.
      assert.equal(d.length, REF.length - 1);
      assert.match(r.out, /stock_flags.*sample matched 0 of 9 rows/);
      assert.match(r.out, /Sample matched 0 rows in 1 NON-EMPTY collection/);
      assert.equal(r.status, 0, r.out.slice(-2000));
    });

    it("a 0-row sample is NOT counted as 'empty in prod' — the two facts need different actions", () => {
      const r = runSync({
        STUB_PLAN_FILE: PLAN_FILE,
        STUB_ZERO_SAMPLE: "stock_flags",
      });
      // Prod having no rows is a healthy no-op; prod being FULL while the sample
      // matches none of it means the manifest is stale or a field name is wrong.
      // One shared counter printed "Skipped 39 empty-in-prod collection(s)" and
      // exited 0 over exactly that.
      assert.doesNotMatch(r.out, /Skipped \d+ empty-in-prod collection/);
      assert.match(
        r.out,
        /Sample matched 0 rows in 1 NON-EMPTY collection\(s\).*stock_flags/,
      );
    });

    it("FAILS the run when the sample matched nothing anywhere and prod is not empty", () => {
      const r = runSync({ STUB_PLAN_FILE: PLAN_FILE, STUB_ZERO_SAMPLE: "ALL" });
      assert.equal(r.status, 1, r.out.slice(-2000));
      // Nothing was dropped — the guard fired for all 39 before any dump.
      assert.deepEqual(dumps(r.log), []);
      assert.deepEqual(restores(r.log), []);
      assert.match(r.out, /NO collection was restored and prod is NOT empty/);
      assert.match(r.out, /sample-matched-nothing/);
      assert.doesNotMatch(r.out, /Reference-Data Sync Complete!/);
    });
  },
);

describe(
  "--tier=sample: a collection missing from the plan is REFUSED, never copied whole",
  SPAWNING_SUITE,
  () => {
    it("marks it failed and issues no dump for it", () => {
      const r = runSync({ STUB_PLAN_FILE: planFileWithout("stock_news") });

      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.match(r.out, /stock_news.*no entry in the sample plan/);
      assert.match(r.out, /1 step\(s\) failed: stock_news/);
      assert.doesNotMatch(r.out, /Reference-Data Sync Complete!/);

      const d = dumps(r.log);
      assert.deepEqual(
        d.filter((x) => x.collection === "stock_news"),
        [],
        "an unplanned collection reached mongodump — a fall-back to a full copy is how a sample becomes a full sync",
      );
      assert.deepEqual(
        d.filter((x) => x.query === "<NONE>"),
        [],
      );
      assert.equal(
        d.length,
        REF.length - 1,
        "the other collections must still copy",
      );
      assert.ok(!restores(r.log).includes("stock_news"));
    });

    it("refuses a query carrying a single quote rather than interpolating it", () => {
      // The sampled count interpolates the query into a single-quoted JS string
      // (`EJSON.parse('…')`), so an apostrophe would break out of it and change
      // what runs.
      const doctored = join(STUBS, "plan-quote.tsv");
      writeFileSync(
        doctored,
        planLines()
          .map(([c, q]) =>
            c === "stock_news"
              ? `${c}\t{"symbol":{"$in":["O'NEIL"]}}`
              : `${c}\t${q}`,
          )
          .join("\n") + "\n",
      );
      const r = runSync({ STUB_PLAN_FILE: doctored });
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.match(r.out, /stock_news.*sample query contains a single quote/);
      assert.deepEqual(
        dumps(r.log).filter((x) => x.collection === "stock_news"),
        [],
      );
    });
  },
);

describe(
  "--tier=sample: a plan that cannot be built stops the run before anything is dropped",
  SPAWNING_SUITE,
  () => {
    it("exits non-zero and drops nothing when the generator fails", () => {
      const r = runSync({ STUB_PLAN_EXIT: "1" });
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.match(r.out, /Sample plan generation FAILED/);
      assert.match(r.out, /Nothing has been dropped; QA is untouched/);
      assert.deepEqual(dumps(r.log), []);
      assert.deepEqual(restores(r.log), []);
      assert.doesNotMatch(r.log, /RELINK_RAN/);
      // Stronger than "nothing was dropped": it never even reached the loop, so
      // prod was not counted and QA was not opened. `build_sample_plan` runs
      // before the first collection precisely so a broken plan cannot drop one
      // table at a time.
      assert.doesNotMatch(r.log, /^COUNT /m, "the loop started anyway");
    });

    it("the REAL generator's missing-manifest refusal reaches the shell (not simulated)", () => {
      // End to end: the CLI's own fail-loud path, through the shell's `if !`.
      // A missing manifest must never degrade to "sample everything" (12.75M
      // rows) or to an empty plan (39 dropped QA tables); both look like success.
      const r = runSync({ STUB_MANIFEST: join(STUBS, "does-not-exist.json") });
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.match(r.out, /FATAL: cannot read the sample manifest/);
      assert.match(r.out, /Sample plan generation FAILED/);
      assert.deepEqual(dumps(r.log), []);
      assert.deepEqual(restores(r.log), []);
      assert.doesNotMatch(r.log, /^COUNT /m, "the loop started anyway");
    });
  },
);

describe(
  "--gcs-only cannot be combined with --tier=sample",
  SPAWNING_SUITE,
  () => {
    for (const args of [
      ["--yes", "--gcs-only", "--tier=sample"],
      ["--yes", "--tier=sample", "--gcs-only"],
    ]) {
      it(`refuses \`${args.slice(1).join(" ")}\` outright`, () => {
        // Measured before the fix: it issued 39 drop+restore pairs while the
        // banner printed "MongoDB reference collections only" — the exact
        // opposite of what was asked, on the one tier that drops QA collections.
        const r = runSync({ STUB_PLAN_FILE: PLAN_FILE }, args);
        assert.equal(r.status, 1, r.out.slice(-2000));
        assert.match(r.out, /--gcs-only cannot be combined with --tier=sample/);
        assert.deepEqual(dumps(r.log), [], "it dropped and restored anyway");
        assert.deepEqual(restores(r.log), []);
        // It refuses BEFORE the banner, so no operator ever reads a mode line
        // that contradicts the flags they passed.
        assert.doesNotMatch(r.out, /Mode: /);
      });
    }

    it("still refuses under --dry-run (the preview must not disagree with the run)", () => {
      const r = runSync({ STUB_PLAN_FILE: PLAN_FILE }, [
        "--gcs-only",
        "--tier=sample",
        "--dry-run",
      ]);
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.match(r.out, /--gcs-only cannot be combined with --tier=sample/);
    });
  },
);

describe(
  "SIGINT stops the run — it does not merely tidy up and carry on",
  SPAWNING_SUITE,
  () => {
    it("exits 130 mid-loop and copies nothing further", () => {
      // The trap was `trap '…' EXIT INT TERM` with a body that neither exited nor
      // re-raised, so Ctrl-C HANDLED the signal: it deleted the plan file and let
      // the loop continue, the next awk died under `set -e` reading a file that
      // was gone, the MANDATORY post-restore re-link never ran, and it exited 2 —
      // outside the documented {0,1} contract the Cloud Run job reads.
      const r = runSync(
        { STUB_PLAN_FILE: PLAN_FILE, STUB_SIGINT_AFTER: "1" },
        ["--yes", "--tier=sample"],
        { ownProcessGroup: true },
      );

      assert.match(
        r.log,
        /SIGINT group=/,
        "the signal was not delivered to the process group — the run did not get its own group, so this test proved nothing",
      );
      assert.equal(
        r.status,
        130,
        `expected 130, got ${r.status}\n${r.out.slice(-2000)}`,
      );
      assert.match(r.out, /Interrupted — QA may be partially restored/);

      const d = dumps(r.log);
      assert.equal(
        d.length,
        1,
        `the loop continued past the interrupt: ${d.length} collections were dumped`,
      );
      assert.ok(d.length < REF.length);
      assert.doesNotMatch(r.out, /Reference-Data Sync Complete!/);
      assert.doesNotMatch(r.out, /Reference-Data Sync FAILED/);
    });
  },
);
