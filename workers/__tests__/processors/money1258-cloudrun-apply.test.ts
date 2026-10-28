/**
 * `--apply` on Cloud Run: no TTY, and the execution IS the confirmation —
 * MONEY-1258.
 *
 * ## Why the guard had to change at all
 *
 * The full BSE historical walk is ~30.6h (61,800 filings x 1.5s of PDF pacing
 * plus 4.8h of index pacing, extrapolated from the live 2025 run). That cannot
 * run on a laptop — this repo already lost two runs to machine sleep, which is
 * why `xbrl-backfill` became a Cloud Run job. But a container has no TTY, and
 * `--apply` refused without one, so the job would have exited on line one.
 *
 * ## Why loosening it is not weakening it
 *
 * The prompt defends against a write NOBODY CHOSE — an unattended wrapper
 * applying by accident. Its comment is explicit that the danger is a hung
 * prompt exiting 0, which a wrapper's `&&` reads as success.
 *
 * `gcloud run jobs execute bse-backfill-prod --args=--apply,...` is a human
 * choosing, exactly as much as typing "yes". `xbrl-reparse` is the standing
 * precedent: it takes `--apply` on Cloud Run with no prompt at all.
 *
 * ## Why an ENV VAR and not a flag
 *
 * `CLOUD_RUN_JOB` is set by Cloud Run in the job container and by nothing else.
 * A flag (`--yes`) is precisely what a wrapper would learn to pass — the repo
 * already has a rule that `reclassify`/`resector` must never grow one. An
 * operator who exports `CLOUD_RUN_JOB` by hand has gone out of their way to
 * defeat a guard, which is not the failure mode this defends against and which
 * no mechanism can prevent.
 *
 * The local path is UNCHANGED, and that is half of what these cases pin: a
 * non-TTY local run must still refuse.
 *
 * ## Why the helper lives in the worker logic module
 *
 * `backfill-bse-results.ts` calls `main()` at module load, so importing it for
 * a pure helper RUNS THE BACKFILL and kills the test process mid-import. The
 * decision has four input combinations and a silent fourth outcome would apply
 * without confirmation, so it is worth testing behaviourally rather than by
 * grepping the source — which means it belongs beside the other shared BSE
 * logic, not in the executable script.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// MONEY-1326 — every path below is anchored to THIS FILE, never to
// `process.cwd()`. The reads used to be bare relative strings, so they resolved
// correctly only when the runner's cwd happened to be `workers/` (which is what
// `yarn test` does, per-workspace) and threw ENOENT from the repo root. Same
// class as the MONEY-1314 coverage test that resolved its roots from the cwd
// and silently scanned ZERO files.
const WORKERS = join(import.meta.dirname, "..", "..");
const ROOT = join(WORKERS, "..");

import {
  BSE_EQUALS_FORM,
  BSE_SHARD_PLAN,
  buildShardArgs,
  resolveApplyConfirmation,
  shouldChainShard,
} from "../../src/processors/bse-announcements-sync-logic";

const TSUP = readFileSync(join(WORKERS, "tsup.config.ts"), "utf8");
const SETUP = readFileSync(
  join(ROOT, "scripts", "ops", "setup-bse-backfill-job.sh"),
  "utf8",
);

describe("apply confirmation resolves by execution context (MONEY-1258)", () => {
  it("refuses a NON-TTY local run — the guard is intact", () => {
    assert.equal(
      resolveApplyConfirmation({ isTTY: false, cloudRunJob: undefined }),
      "refuse",
      "a piped/CI local run must still refuse; this is the anti-wrapper guard",
    );
    assert.equal(
      resolveApplyConfirmation({ isTTY: false, cloudRunJob: "" }),
      "refuse",
      "an EMPTY CLOUD_RUN_JOB is not Cloud Run — it is an unset variable that " +
        "happens to be exported, and must not open the door",
    );
  });

  it("prompts on an interactive local run", () => {
    assert.equal(
      resolveApplyConfirmation({ isTTY: true, cloudRunJob: undefined }),
      "prompt",
    );
  });

  it("skips the prompt ONLY inside a real Cloud Run job", () => {
    assert.equal(
      resolveApplyConfirmation({ isTTY: false, cloudRunJob: "bse-backfill-prod" }),
      "cloud-run-job",
      "a container has no TTY; the job execution is the confirmation",
    );
    // A TTY inside a job is not a thing, but the context must still win — the
    // decision is about WHO invoked, never about terminal shape.
    assert.equal(
      resolveApplyConfirmation({ isTTY: true, cloudRunJob: "bse-backfill-prod" }),
      "cloud-run-job",
    );
  });

  it("has exactly three outcomes and no fourth silent one", () => {
    // A fall-through returning undefined would be read as falsy by a caller
    // testing `=== "refuse"` and would apply without confirmation.
    const seen = new Set(
      [
        [false, undefined],
        [true, undefined],
        [false, "j"],
        [true, "j"],
      ].map(([t, j]) =>
        resolveApplyConfirmation({
          isTTY: t as boolean,
          cloudRunJob: j as string | undefined,
        }),
      ),
    );
    assert.deepStrictEqual(
      [...seen].sort(),
      ["cloud-run-job", "prompt", "refuse"],
      "every input must map to a named outcome",
    );
  });
});

describe("the Cloud Run job is actually buildable and provisioned (MONEY-1258)", () => {
  it("[meta] both files are readable", () => {
    // Ceiling: the checks below are substring tests that a failed read would
    // satisfy vacuously.
    assert.ok(TSUP.length > 500, `tsup config read as ${TSUP.length} chars`);
    assert.ok(SETUP.length > 2000, `setup script read as ${SETUP.length} chars`);
  });

  it("tsup emits the entrypoint the job runs", () => {
    // Without this entry the container dies instantly with
    // "Cannot find module /app/dist/bse-backfill.js" — the failure mode every
    // sibling setup script warns about in its preflight.
    assert.match(
      TSUP,
      /"bse-backfill":\s*"\.\.\/scripts\/data\/backfill-bse-results\.ts"/,
      "workers/tsup.config.ts has no bse-backfill entry",
    );
    assert.match(
      SETUP,
      /ENTRYPOINT="dist\/bse-backfill\.js"/,
      "the setup script names an entrypoint tsup does not emit",
    );
  });

  it("supplies the GCS env the upload requires", () => {
    // A job spec does NOT inherit the service's env block. Without these,
    // uploadFile throws into a best-effort catch and the whole multi-hour shard
    // writes gcsPath "" while reporting success — measured, 59 rows.
    assert.match(SETUP, /GCP_STORAGE_BUCKET=/);
    assert.match(SETUP, /GCP_PROJECT_ID=/);
    assert.match(SETUP, /GCP_SERVICE_ACCOUNT_KEY_BASE64/);
  });

  it("never retries — a killed shard must not restart into a throttling host", () => {
    assert.match(
      SETUP,
      /--max-retries=0/,
      "a retry re-walks the shard into the host that just cut us off",
    );
  });

  it("puts the entrypoint in --command, not --args", () => {
    // `jobs execute --args=…` REPLACES the arg list. With the entrypoint in
    // --args, every parameterised execution drops it and runs
    // `node --from-year=2015`.
    assert.match(SETUP, /--command="node,\$ENTRYPOINT"/);
    assert.match(SETUP, /--args=""/);
  });

  it("triggers only the HEAD of the plan — the rest chain", () => {
    // One command now, not three: each shard chains the next. What the script
    // must get right is that it STARTS at the plan head; ordering itself is a
    // property of BSE_SHARD_PLAN and is asserted against the plan.
    //
    // Built via buildShardArgs rather than a literal, so this cannot go stale
    // against the arg FORMAT the way it did when the equals form was fixed.
    const head = BSE_SHARD_PLAN[0];
    assert.ok(
      SETUP.includes(`--args=${buildShardArgs(head).join(",")}`),
      `the setup script must trigger the plan head (${head.fromYear}), or the ` +
        `operator starts mid-sequence and the earlier years never run`,
    );
    // And it must NOT hand over a multi-year window: those measured ~38h
    // against a 24h cap, and a killed task cannot chain.
    const spans = [...SETUP.matchAll(/--from-year,(\d{4}),--to-year,(\d{4})/g)];
    assert.ok(spans.length > 0, "ceiling: no shard command found");
    for (const m of spans) {
      assert.equal(
        m[1],
        m[2],
        `shard ${m[1]}..${m[2]} spans multiple years; measured 9.5s/filing ` +
          `puts that over the 24h task cap`,
      );
    }
  });

  it("documents that the full walk EXCEEDS the task cap", () => {
    // The one number an operator must not have to rediscover: a single
    // --from-year=2015 execution cannot finish inside 24h.
    assert.match(
      SETUP,
      /EXCEEDS Cloud Run's maximum task timeout/,
      "the setup script must say the full range does not fit in one execution",
    );
    // The consequence, not just the fact: a killed task cannot publish its
    // follow-up, so an oversized shard stalls the chain SILENTLY.
    assert.match(
      SETUP,
      /KILLED TASK CANNOT CHAIN/,
      "the script must state why overrunning is worse than slow",
    );
    // And the sizing must be the MEASURED figure, not the pacing constant.
    assert.match(SETUP, /9\.5 s per filing/);
  });
});

describe("shard chaining is guarded and terminates (MONEY-1258)", () => {
  // Derived from the PLAN, never hardcoded. The first version pinned
  // { 2022, 2024 } and went red the moment the plan was resized from 3-year to
  // 1-year shards — the fixture, not the behaviour, was what broke.
  const OK = {
    current: { ...BSE_SHARD_PLAN[0] },
    inCloudRunJob: true,
    rateLimited: false,
    breakerTripped: false,
    attachmentsOffered: 100,
    attachmentsStored: 98,
  };

  it("[meta] the plan has more than one shard, newest first", () => {
    // Ceiling: a single-shard plan would make every chaining assertion below
    // vacuously true, since nothing could ever follow.
    assert.ok(BSE_SHARD_PLAN.length >= 3, `plan has ${BSE_SHARD_PLAN.length}`);
    for (let i = 1; i < BSE_SHARD_PLAN.length; i++) {
      assert.ok(
        BSE_SHARD_PLAN[i].toYear < BSE_SHARD_PLAN[i - 1].fromYear,
        "the plan must run newest-first with no overlap",
      );
    }
  });

  it("chains on the happy path", () => {
    const r = shouldChainShard(OK);
    assert.equal(r.decision, "chain");
    assert.deepStrictEqual(
      r.next,
      { ...BSE_SHARD_PLAN[1] },
      "the head of the plan must chain to the second entry",
    );
  });

  it("REFUSES after a 429 — the next shard meets the same block", () => {
    // stock-document-sync's rule: limiter state is PER RUN, so a fresh link
    // re-arms the breaker straight back into the tarpit (MONEY-853).
    assert.equal(
      shouldChainShard({ ...OK, rateLimited: true }).decision,
      "rate-limited",
    );
  });

  it("REFUSES after the consecutive-failure breaker", () => {
    assert.equal(
      shouldChainShard({ ...OK, breakerTripped: true }).decision,
      "breaker-tripped",
    );
  });

  it("REFUSES when filings were offered and NONE stored", () => {
    // The MONEY-1258 signature — missing GCS config, or an attachment
    // directory rotation we do not handle. Chaining repeats it for ~20h.
    assert.equal(
      shouldChainShard({ ...OK, attachmentsOffered: 100, attachmentsStored: 0 })
        .decision,
      "no-attachments",
    );
    // ...but a shard where BSE offered nothing is IDLE, not broken.
    assert.equal(
      shouldChainShard({ ...OK, attachmentsOffered: 0, attachmentsStored: 0 })
        .decision,
      "chain",
    );
  });

  it("NEVER chains from an interactive run", () => {
    // A laptop shard is a deliberate short action; turning it into a 30-hour
    // sequence is exactly what the operator did not ask for.
    assert.equal(
      shouldChainShard({ ...OK, inCloudRunJob: false }).decision,
      "not-a-job",
    );
  });

  it("stops at the end of the plan rather than wrapping", () => {
    const last = BSE_SHARD_PLAN[BSE_SHARD_PLAN.length - 1];
    const r = shouldChainShard({ ...OK, current: { ...last } });
    assert.equal(r.decision, "plan-complete");
    assert.equal(r.next, null, "wrapping to the head would loop forever");
  });

  it("an AD-HOC window never chains", () => {
    // A one-off probe must not adopt the plan's successor and walk years
    // nobody asked for.
    // Windows that CANNOT be in the plan: a span wider than any entry, and
    // years outside the covered range entirely.
    for (const current of [
      { fromYear: 2015, toYear: 2024 },
      { fromYear: 2021, toYear: 2023 },
      { fromYear: 1999, toYear: 2000 },
    ]) {
      const r = shouldChainShard({ ...OK, current });
      assert.equal(r.next, null, `${JSON.stringify(current)} matched the plan`);
      assert.equal(r.decision, "plan-complete");
    }
  });

  it("terminates: following the chain exhausts the plan", () => {
    // Structural proof, not a claim. Walk it and count.
    let cur = BSE_SHARD_PLAN[0];
    let links = 0;
    for (;;) {
      const r = shouldChainShard({ ...OK, current: cur });
      if (r.decision !== "chain" || !r.next) break;
      cur = r.next;
      links++;
      assert.ok(links <= BSE_SHARD_PLAN.length, "chain did not terminate");
    }
    assert.equal(
      links,
      BSE_SHARD_PLAN.length - 1,
      "the chain must visit every shard exactly once",
    );
  });
});

describe("shard args match the PARSER's rule, not each other (MONEY-1261)", () => {
  const SCRIPT = readFileSync(
    join(ROOT, "scripts", "data", "backfill-bse-results.ts"),
    "utf8",
  );

  it("[meta] the parser really does reject the equals form", () => {
    // Ceiling. Every assertion below is "our args do not match the rejected
    // shape". If the parser stopped rejecting it, they would pass while
    // protecting nothing — and the guard is load-bearing: an unparsed --env
    // leaves an APPLY run pointed at the ambient DATABASE_URL.
    assert.match(
      SCRIPT,
      /The equals form is not parsed/,
      "the script no longer rejects --flag=value; re-derive this whole suite",
    );
    assert.match(
      SCRIPT,
      /\/\^--\[a-z-\]\+=\//,
      "the parser's rejection regex has changed shape",
    );
  });

  it("BSE_EQUALS_FORM is the SAME rule the script applies", () => {
    // Duplicated only because backfill-bse-results.ts calls main() at load and
    // cannot be imported. If the two drift, this test is testing nothing.
    assert.equal(
      BSE_EQUALS_FORM.source,
      "^--[a-z-]+=",
      "the mirrored regex drifted from the script's own",
    );
  });

  it("the chain trigger emits args the parser ACCEPTS", () => {
    // This is what failed in Cloud Run: `--from-year=2024` exits 1 in seconds,
    // so every chain link would have died and the sequence stalled at shard 1.
    for (const shard of BSE_SHARD_PLAN) {
      const args = buildShardArgs(shard);
      for (const a of args) {
        assert.doesNotMatch(
          a,
          BSE_EQUALS_FORM,
          `"${a}" uses the equals form the parser rejects`,
        );
      }
      // …and it must still be a parseable flag/value sequence.
      assert.deepStrictEqual(args, [
        "--apply",
        "--from-year",
        String(shard.fromYear),
        "--to-year",
        String(shard.toYear),
      ]);
    }
  });

  it("the setup script's printed command uses the same form", () => {
    // Two producers of these args; they agreed with EACH OTHER and disagreed
    // with the parser, which is why nothing caught it.
    const args = [...SETUP.matchAll(/--args=([^\s\\]+)/g)].map((m) => m[1]);
    assert.ok(args.length > 0, "ceiling: no --args= found in the setup script");
    for (const list of args) {
      for (const tok of list.split(",")) {
        assert.doesNotMatch(
          tok,
          BSE_EQUALS_FORM,
          `setup script hands over "${tok}", which the parser rejects`,
        );
      }
    }
  });

  it("the printed command is exactly what the plan head needs", () => {
    const expected = buildShardArgs(BSE_SHARD_PLAN[0]).join(",");
    assert.ok(
      SETUP.includes(`--args=${expected}`),
      `setup script must print --args=${expected}`,
    );
  });
});
