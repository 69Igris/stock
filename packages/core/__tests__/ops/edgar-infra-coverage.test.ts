/**
 * MONEY-979 T14 — the EDGAR engine's infrastructure agrees with itself.
 *
 * `services/us-fundamentals` is provisioned by six files that nothing compiles
 * together: a Pub/Sub script, a Scheduler script, a Cloud Run jobs script, two
 * Cloud Build specs, an infra wrapper and a GCS lifecycle policy. Each one is
 * correct on its own and none of them can fail because another moved.
 *
 * Every check below is a pair of files that must agree, and every one of them
 * has a REAL failure mode that produces no error at run time:
 *
 *   topic without a route      Pub/Sub push 404s, retries five times, dead
 *                              letters. Reads as a failing job, not a missing
 *                              route.
 *   route without a topic      the handler exists and is never called. Silent.
 *   scheduler -> absent topic  `gcloud pubsub topics publish` on a topic that
 *                              does not exist fails inside Scheduler, where
 *                              nobody is looking.
 *   job not re-pinned          MONEY-1235 verbatim: a Cloud Run JOB keeps the
 *                              image it was PROVISIONED with, so a release
 *                              moves the service and leaves the job running
 *                              last month's code — exiting 0 the whole time.
 *                              This test found `edgar-bulk-ftd` in exactly that
 *                              state: deployed by the setup script, named in
 *                              neither cloudbuild spec's re-pin loop.
 *   service never deployed     `setup-infra.sh` provisions the topics and the
 *                              schedulers for a service it does not build.
 *   lifecycle outside edgar/   a lifecycle policy is set on a BUCKET; a rule
 *                              whose prefix slipped would age out `feeds/` or
 *                              `candles/` on the same shared bucket.
 *
 * ## Why the assertions read shell and Python as TEXT
 *
 * There is no other observable. These scripts' entire output is a `gcloud`
 * invocation, and `gcloud` is exactly what a test must not run. Reading the
 * source is the honest version of "did the two lists stay equal"; a mocked
 * gcloud would only assert that the mock was written correctly. Same reasoning
 * as `xbrl-backfill-job-setup.test.ts` next door.
 *
 * ## Every scan is proved to have read something
 *
 * A regex that silently matches nothing turns each `deepEqual` below into
 * `[] === []`. That is not hypothetical — it is the documented failure of
 * `no-feed-fetch-bypass.test.ts`, and it is why the first `describe` here does
 * nothing but assert floors on every extraction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// packages/core/__tests__/ops -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const PUBSUB_SCRIPT = join(ROOT, "workers/scripts/setup-pubsub.sh");
const SCHEDULER_SCRIPT = join(ROOT, "scripts/ops/setup-scheduler.sh");
const JOBS_SCRIPT = join(ROOT, "scripts/ops/setup-us-fundamentals-jobs.sh");
const INFRA_SCRIPT = join(ROOT, "scripts/ops/setup-infra.sh");
const TRIGGERS_SCRIPT = join(ROOT, "scripts/ops/setup-cloudbuild-triggers.sh");
const LIFECYCLE_SCRIPT = join(ROOT, "scripts/ops/setup-gcs-lifecycle.sh");
// RENAMED by MONEY-1309 (was `gcs-lifecycle-edgar.json`). The policy stopped
// being edgar-only when the raw-tick retention rule moved in, and a file whose
// NAME asserts a scope its CONTENTS violate is the defect the guard below is
// for, one layer up. The edgar-specific assertions stay here — this suite is
// still the thing that knows what the SEC archive needs — while the allow-list
// itself and its agreement with the prod->QA mirror are pinned by
// packages/core/__tests__/ops/tiingo-realtime-infra.test.ts.
const LIFECYCLE_POLICY = join(ROOT, "scripts/ops/gcs-lifecycle.json");
const APPLY_MONITORS = join(ROOT, "scripts/ops/datadog/apply-monitors.sh");
const LATENCY_TEMPLATE = join(
  ROOT,
  "scripts/ops/datadog/monitor-latency-p95.json",
);
const MAIN_PY = join(ROOT, "services/us-fundamentals/app/main.py");
const CLOUDBUILD_PROD = join(
  ROOT,
  "services/us-fundamentals/cloudbuild.prod.yaml",
);
const CLOUDBUILD_QA = join(ROOT, "services/us-fundamentals/cloudbuild.qa.yaml");

const read = (p: string): string => readFileSync(p, "utf8");

const pubsubSrc = read(PUBSUB_SCRIPT);
const schedulerSrc = read(SCHEDULER_SCRIPT);
const jobsSrc = read(JOBS_SCRIPT);
const infraSrc = read(INFRA_SCRIPT);
const triggersSrc = read(TRIGGERS_SCRIPT);
const lifecycleSrc = read(LIFECYCLE_SCRIPT);
const monitorsSrc = read(APPLY_MONITORS);
const mainPySrc = read(MAIN_PY);
const cloudbuildProd = read(CLOUDBUILD_PROD);
const cloudbuildQa = read(CLOUDBUILD_QA);

/** Pull one `declare -a NAME=( … )` block out of a bash script. */
function bashArray(src: string, name: string): string {
  const block = new RegExp(`declare -a ${name}=\\(([\\s\\S]*?)\\n\\)`).exec(
    src,
  );
  assert.ok(block, `could not find ${name}`);
  return block[1]!;
}

/**
 * Drop whole-line `#` comments before extracting rows.
 *
 * Load-bearing, and the reason is a live divergence rather than tidiness: bash
 * honours `#` and a regex does not. A commented-out array row would be an
 * ACTIVE entry to every test that scrapes these blocks and a dead one to the
 * script — so a monitored job could exist in CI and nowhere else. See the
 * dedicated assertion further down.
 */
const stripBashComments = (s: string): string =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

// ── The EDGAR Pub/Sub topics ────────────────────────────────────────────────
const edgarTopics = [
  ...stripBashComments(bashArray(pubsubSrc, "EDGAR_TOPICS")).matchAll(
    /"([a-z0-9-]+)"/g,
  ),
].map((m) => m[1]!);

// ── The service's routes ────────────────────────────────────────────────────
function pythonDictKeys(src: string, name: string): string[] {
  const block = new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
  assert.ok(block, `could not find ${name} in app/main.py`);
  return [...block[1]!.matchAll(/"([a-z0-9-]+)"\s*:/g)].map((m) => m[1]!);
}
const jobHandlers = pythonDictKeys(mainPySrc, "JOB_HANDLERS");

function pythonTupleValues(src: string, name: string): string[] {
  const block = new RegExp(`${name}[^=]*=\\s*\\(([\\s\\S]*?)\\n\\)`).exec(src);
  assert.ok(block, `could not find ${name} in app/main.py`);
  return [...block[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
}
const jobRoutes = pythonTupleValues(mainPySrc, "JOB_ROUTES");

// ── Scheduler rows targeting an EDGAR topic ─────────────────────────────────
// "NAME|SCHEDULE|TOPIC_BASE|MESSAGE|DESCRIPTION"
const schedulerRows = [
  ...schedulerSrc.matchAll(/^\s*"([a-z0-9-]+)\|[^|]+\|([a-z0-9-]+)\|/gm),
].map((m) => ({ entry: m[1]!, topic: m[2]! }));
const edgarSchedulerRows = schedulerRows.filter((r) =>
  r.topic.startsWith("edgar-"),
);

// ── Cloud Run jobs ──────────────────────────────────────────────────────────
const cloudRunJobs = [
  ...stripBashComments(jobsSrc).matchAll(/deploy_job\s+"([a-z0-9-]+)"/g),
].map((m) => m[1]!);

function repinnedJobs(spec: string): string[] {
  const m = /for BASE in ([a-z0-9 -]+); do/.exec(spec);
  assert.ok(m, "could not find the job re-pin loop in the cloudbuild spec");
  return m[1]!.trim().split(/\s+/);
}
const repinProd = repinnedJobs(cloudbuildProd);
const repinQa = repinnedJobs(cloudbuildQa);

// ── setup-infra.sh deploy targets ───────────────────────────────────────────
const deployTargets = [
  ...stripBashComments(bashArray(infraSrc, "DEPLOY_TARGETS")).matchAll(
    /"([a-z0-9-]+)\|([^"]+)"/g,
  ),
].map((m) => ({ name: m[1]!, configPrefix: m[2]! }));

// ── The lifecycle policy ────────────────────────────────────────────────────
interface LifecycleRule {
  action?: { type?: string; storageClass?: string };
  condition?: { age?: number; matchesPrefix?: string[] };
}
const lifecyclePolicy = JSON.parse(read(LIFECYCLE_POLICY)) as {
  rule: LifecycleRule[];
};

/**
 * The prefixes setup-gcs-lifecycle.sh declares it may own — MONEY-1309.
 *
 * READ OUT OF THE SCRIPT, never re-typed here. A copy in the test is a second
 * source of truth that agrees with the first exactly until somebody edits one
 * of them, and the direction that fails is the dangerous one: widen the script
 * to `feeds/` and a test holding its own `["edgar/", "feeds/TIINGO/ws/"]` goes
 * on asserting the policy it wishes were true.
 */
function bashArrayValues(src: string, name: string): string[] {
  const block = new RegExp(
    `\\n(?:declare -a )?${name}=\\(([\\s\\S]*?)\\n\\)`,
  ).exec(src);
  assert.ok(block, `could not find ${name}= in setup-gcs-lifecycle.sh`);
  return [...stripBashComments(block[1]!).matchAll(/"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
}
const allowPrefixes = bashArrayValues(lifecycleSrc, "ALLOW_PREFIXES");
const protectedRoots = bashArrayValues(lifecycleSrc, "PROTECTED_ROOTS");

describe("MONEY-979 — the EDGAR infra scans reach real content", () => {
  it("[meta] every source file this suite compares actually exists", () => {
    for (const p of [
      PUBSUB_SCRIPT,
      SCHEDULER_SCRIPT,
      JOBS_SCRIPT,
      INFRA_SCRIPT,
      TRIGGERS_SCRIPT,
      LIFECYCLE_SCRIPT,
      LIFECYCLE_POLICY,
      APPLY_MONITORS,
      LATENCY_TEMPLATE,
      MAIN_PY,
      CLOUDBUILD_PROD,
      CLOUDBUILD_QA,
    ]) {
      assert.ok(existsSync(p), `missing: ${p}`);
    }
    // The path arithmetic itself, asserted. Four `..` from
    // packages/core/__tests__/ops is easy to get wrong by one, and every
    // readFileSync above would then throw with a path rather than a reason.
    assert.ok(
      existsSync(join(ROOT, "package.json")),
      `ROOT resolved to ${ROOT}, which is not the repo root`,
    );
  });

  it("[meta] every extraction found something", () => {
    // Floors, not exact counts: an exact count here would fail on every
    // legitimate addition and teach people to edit the test instead of reading
    // it. What must never happen is a scan returning ZERO, which makes each
    // set-comparison below trivially true.
    assert.ok(edgarTopics.length >= 7, `EDGAR_TOPICS: ${edgarTopics.length}`);
    assert.ok(jobHandlers.length >= 7, `JOB_HANDLERS: ${jobHandlers.length}`);
    assert.ok(jobRoutes.length >= 7, `JOB_ROUTES: ${jobRoutes.length}`);
    assert.ok(
      edgarSchedulerRows.length >= 3,
      `EDGAR scheduler rows: ${edgarSchedulerRows.length}`,
    );
    // …and the scheduler scan must be reading the WHOLE file, not just the
    // EDGAR block, or "every EDGAR row points at a real topic" would be
    // satisfied by a scan that found three rows out of a hundred by accident.
    assert.ok(
      schedulerRows.length >= 50,
      `scheduler rows overall: ${schedulerRows.length}`,
    );
    assert.ok(
      cloudRunJobs.length >= 5,
      `deploy_job calls: ${cloudRunJobs.length}`,
    );
    assert.ok(repinProd.length >= 5, `prod re-pin list: ${repinProd.length}`);
    assert.ok(repinQa.length >= 5, `qa re-pin list: ${repinQa.length}`);
    assert.ok(
      deployTargets.length >= 2,
      `DEPLOY_TARGETS: ${deployTargets.length}`,
    );
    assert.ok(
      lifecyclePolicy.rule.length >= 3,
      `lifecycle rules: ${lifecyclePolicy.rule.length}`,
    );
    // The allow-list is now scraped out of the script rather than hard-coded
    // here, so it gets the same floor as every other extraction: a regex that
    // silently matches nothing would turn "every prefix is allow-listed" into
    // an assertion over an empty set, which is vacuously true and would pass
    // over a rule pointed at `feeds/`.
    assert.ok(
      allowPrefixes.length >= 2,
      `ALLOW_PREFIXES parsed from setup-gcs-lifecycle.sh: ${allowPrefixes.length}`,
    );
  });
});

describe("MONEY-979 — every EDGAR topic has a route, and vice versa", () => {
  it("[regression] the topics created and the routes registered are the same set", () => {
    // A topic with no route dead-letters every delivery; a route with no topic
    // is a handler nothing can ever reach. Both are silent, so the check is an
    // exact set equality in both directions rather than a subset either way.
    assert.deepEqual(
      [...edgarTopics].sort(),
      [...jobHandlers].sort(),
      "setup-pubsub.sh EDGAR_TOPICS and app/main.py JOB_HANDLERS disagree.\n" +
        `  topics only:  ${edgarTopics.filter((t) => !jobHandlers.includes(t)).join(", ") || "(none)"}\n` +
        `  handlers only: ${jobHandlers.filter((h) => !edgarTopics.includes(h)).join(", ") || "(none)"}`,
    );
  });

  it("[regression] JOB_ROUTES and JOB_HANDLERS cover each other", () => {
    // The route path IS the topic base name — setup-pubsub.sh builds the push
    // endpoint as ${URL}/jobs/${BASE_TOPIC} — so a route registered without a
    // handler entry throws a KeyError at dispatch time, on a live message.
    assert.deepEqual([...jobRoutes].sort(), [...jobHandlers].sort());
  });
});

describe("MONEY-979 — every EDGAR scheduler row targets a created topic", () => {
  it("[regression] no scheduler entry publishes into a topic nothing creates", () => {
    const orphans = edgarSchedulerRows.filter(
      (r) => !edgarTopics.includes(r.topic),
    );
    assert.deepEqual(
      orphans.map((r) => `${r.entry} -> ${r.topic}`),
      [],
      "These Cloud Scheduler entries publish to a topic that " +
        "workers/scripts/setup-pubsub.sh never creates, so the publish fails " +
        "inside Scheduler where nobody is watching. Add the topic to " +
        "EDGAR_TOPICS (and a route to JOB_HANDLERS), or remove the entry.",
    );
  });

  it("[regression] every EDGAR scheduler entry is PROD_ONLY", () => {
    // QA ships SEC_EGRESS=off, so a QA detect job cannot reach sec.gov by
    // design and would fail on every invocation — 1,440 failures a day for
    // edgar-detect-minutely alone, and a permanently-red job is a job whose
    // alerts get muted. Derived from the script rather than restated.
    const block = /^PROD_ONLY_JOBS=\(([\s\S]*?)\n\)/m.exec(schedulerSrc);
    assert.ok(block, "could not find PROD_ONLY_JOBS in setup-scheduler.sh");
    const prodOnly = new Set(
      [...block[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!),
    );
    assert.ok(prodOnly.size >= 10, `PROD_ONLY_JOBS: ${prodOnly.size}`);
    const unrestricted = edgarSchedulerRows
      .map((r) => r.entry)
      .filter((e) => !prodOnly.has(e));
    assert.deepEqual(
      unrestricted,
      [],
      "These EDGAR scheduler entries would be created on QA too, where " +
        "SEC_EGRESS=off makes every run fail:\n  " +
        unrestricted.join("\n  "),
    );
  });
});

describe("MONEY-979 — every EDGAR Cloud Run JOB is re-pinned on release", () => {
  /**
   * The MONEY-1235 image-drift class, asserted rather than commented.
   *
   * A Cloud Run JOB pins its image at PROVISION time. `gcloud run services
   * replace` moves the SERVICE and nothing else, so a job created once by
   * `setup-us-fundamentals-jobs.sh` keeps executing that image until somebody
   * re-runs a setup script — and nobody re-runs a setup script on a Tuesday.
   * `feed-parse-prod` spent ten days that way, running nightly, exiting 0, and
   * skipping four feed families it had never heard of.
   *
   * The cloudbuild specs close it by re-pinning each job after the deploy. That
   * only works while the two lists agree, and they had ALREADY drifted when
   * this test was written: `edgar-bulk-ftd` was the fifth `deploy_job` call and
   * appeared in neither spec's loop.
   */
  it("[regression] the prod spec re-pins every job the setup script deploys", () => {
    const missing = cloudRunJobs.filter((j) => !repinProd.includes(j));
    assert.deepEqual(
      missing,
      [],
      "These jobs are provisioned by setup-us-fundamentals-jobs.sh but are " +
        "NOT in the re-pin loop of services/us-fundamentals/cloudbuild.prod." +
        "yaml, so every release leaves them on the image they were created " +
        "with. They will not fail — they will succeed at running an older " +
        "release's code:\n  " +
        missing.join("\n  "),
    );
  });

  it("[regression] the qa spec re-pins every job the setup script deploys", () => {
    const missing = cloudRunJobs.filter((j) => !repinQa.includes(j));
    assert.deepEqual(missing, []);
  });

  it("[regression] neither spec re-pins a job nothing provisions", () => {
    // The other direction. `gcloud run jobs update` on a non-existent job fails,
    // and the step deliberately WARNS and continues so a first release is not
    // blocked — which means a typo here is a permanent warning nobody reads.
    for (const [label, list] of [
      ["prod", repinProd],
      ["qa", repinQa],
    ] as const) {
      const unknown = list.filter((j) => !cloudRunJobs.includes(j));
      assert.deepEqual(unknown, [], `${label} re-pins unknown job(s)`);
    }
  });
});

describe("MONEY-979 — setup-infra.sh deploys every deployable", () => {
  it("[regression] step 4 builds the workers AND us-fundamentals specs", () => {
    const names = deployTargets.map((t) => t.name).sort();
    // Pinned BY VALUE, so adding a deployable has to be a deliberate edit that
    // fails this first — `market-data` joined in MONEY-1466. A `includes()`
    // floor would let a target be dropped as long as something was added.
    assert.deepEqual(
      names,
      ["market-data", "us-fundamentals", "workers"],
      "setup-infra.sh's deploy step must cover every Cloud Run deployable. " +
        "Steps 2 and 3 create seven Pub/Sub topics and three Scheduler " +
        "entries that all target us-fundamentals-{env}; a run that provisions " +
        "those and never builds the service leaves every one of them firing " +
        "at a 404.",
    );
  });

  it("[regression] each target's config prefix resolves to real qa+prod specs", () => {
    // The rows carry a PREFIX and the step appends `.${ENV}.yaml`. A prefix
    // that does not resolve is a deploy that dies mid-run on a `gcloud builds
    // submit` for a file that is not there.
    for (const t of deployTargets) {
      for (const env of ["qa", "prod"]) {
        const spec = join(ROOT, `${t.configPrefix}.${env}.yaml`);
        assert.ok(existsSync(spec), `${t.name}: missing ${spec}`);
      }
    }
  });

  it("[regression] the deploy passes one unique COMMIT_SHA to every target", () => {
    // MONEY-839. With an empty default the image tag is just "qa-", the Cloud
    // Run service spec is byte-identical and `services replace` NO-OPS — the
    // freshly built image is never served. The substitution must be there, and
    // the SHA must be computed ONCE so both services carry the same version.
    assert.match(
      infraSrc,
      /--substitutions=COMMIT_SHA="\$DEPLOY_SHA"/,
      "the build must be given a unique COMMIT_SHA",
    );
    const assignments = [...infraSrc.matchAll(/^\s*DEPLOY_SHA=/gm)];
    assert.equal(
      assignments.length,
      1,
      "DEPLOY_SHA must be computed once, above the target loop — a per-target " +
        "timestamp would give one release two version strings",
    );
  });
});

describe("MONEY-979 — the GCS lifecycle policy cannot escape its allow-list", () => {
  /**
   * A lifecycle policy is set on a BUCKET, and
   * `gcloud storage buckets update --lifecycle-file` REPLACES the whole thing.
   * `stockbook-content-{env}` also holds `feeds/` (the prod->QA mirror),
   * `candles/` (every cold price shard), the learning content and the RAG
   * corpus. A Delete rule that lost its prefix would take all of them, over the
   * following 30 days, with nothing erroring.
   *
   * MONEY-1309 widened the scope from the single literal `edgar/` to an
   * explicit allow-list, because a second prefix moved in. The assertions here
   * are the EDGAR half — the allow-list mechanism itself, and its agreement
   * with the prod->QA mirror exclusion, live in tiingo-realtime-infra.test.ts.
   */
  it("[regression] every rule is scoped, and scoped inside the allow-list", () => {
    const unscoped: string[] = [];
    for (const rule of lifecyclePolicy.rule) {
      const prefixes = rule.condition?.matchesPrefix;
      if (!Array.isArray(prefixes) || prefixes.length === 0) {
        unscoped.push(`${rule.action?.type}: no condition.matchesPrefix`);
        continue;
      }
      for (const p of prefixes) {
        if (!allowPrefixes.some((a) => p.startsWith(a))) {
          unscoped.push(`${rule.action?.type}: prefix ${p}`);
        }
      }
    }
    assert.deepEqual(
      unscoped,
      [],
      "A rule in gcs-lifecycle.json is outside the allow-list " +
        `[${allowPrefixes.join(", ")}] that setup-gcs-lifecycle.sh declares. ` +
        "The policy is applied to the WHOLE shared bucket:\n  " +
        unscoped.join("\n  "),
    );
  });

  it("[regression] no Delete rule can sweep a protected root", () => {
    // The SECOND lock, asserted against the policy file rather than against the
    // applier's source. It is not a restatement of the case above: a rule with
    // prefix `edgar/` PASSES the allow-list — `"edgar/".startsWith("edgar/")` —
    // and would delete `edgar/filings/`, the permanent SEC archive that makes a
    // mapping fix cost zero sec.gov requests. That hole existed for two
    // releases; the old "edgar/filings must never be deleted" case below could
    // not see it, because it looked for a prefix STARTING WITH `edgar/filings/`
    // and `edgar/` does not.
    //
    // `root.startsWith(prefix)` is the test: true when the prefix IS the root
    // or is SHORTER than it. Same expression the applier uses, deliberately —
    // this asserts the SHIPPED policy obeys it, and the executable proof that
    // the applier REFUSES a violating one is in tiingo-realtime-infra.test.ts.
    const sweeps: string[] = [];
    for (const rule of lifecyclePolicy.rule) {
      if (rule.action?.type !== "Delete") continue;
      for (const p of rule.condition?.matchesPrefix ?? []) {
        for (const root of protectedRoots) {
          if (root.startsWith(p)) {
            sweeps.push(`Delete prefix "${p}" sweeps protected root "${root}"`);
          }
        }
      }
    }
    assert.deepEqual(
      sweeps,
      [],
      "A Delete rule reaches a protected root. Lifecycle deletion is " +
        "asynchronous: nothing errors, the objects are simply gone 30 days " +
        "later:\n  " +
        sweeps.join("\n  "),
    );
    // …and the roots themselves must actually be there. Without this, deleting
    // PROTECTED_ROOTS from the script empties `protectedRoots`, the loop above
    // iterates nothing, and the case passes while the guard it describes no
    // longer exists.
    for (const required of ["feeds/", "edgar/filings/"]) {
      assert.ok(
        protectedRoots.includes(required),
        `PROTECTED_ROOTS in setup-gcs-lifecycle.sh must name ${required}`,
      );
    }
  });

  it("[regression] the two rules the runbook declares are both present", () => {
    // docs/reference/edgar-engine.md §5: edgar/bulk deleted at 30 days,
    // edgar/filings to Nearline at 30 days. Asserted by SHAPE so the doc and
    // the policy cannot drift apart silently.
    const del = lifecyclePolicy.rule.find(
      (r) =>
        r.action?.type === "Delete" &&
        r.condition?.matchesPrefix?.some((p) => p.startsWith("edgar/bulk/")),
    );
    assert.ok(del, "no Delete rule for edgar/bulk/");
    assert.equal(del.condition?.age, 30);

    const tier = lifecyclePolicy.rule.find(
      (r) =>
        r.action?.type === "SetStorageClass" &&
        r.condition?.matchesPrefix?.some((p) => p.startsWith("edgar/filings/")),
    );
    assert.ok(tier, "no SetStorageClass rule for edgar/filings/");
    assert.equal(tier.action?.storageClass, "NEARLINE");
    assert.equal(tier.condition?.age, 30);

    // NOTHING deletes edgar/filings. That archive is what makes a mapping fix
    // or a library upgrade cost zero SEC requests; deleting it would turn a
    // reparse into a re-fetch of ~330 GB/yr over a shared 9 req/s budget.
    const deletesFilings = lifecyclePolicy.rule.some(
      (r) =>
        r.action?.type === "Delete" &&
        r.condition?.matchesPrefix?.some((p) => p.startsWith("edgar/filings/")),
    );
    assert.equal(deletesFilings, false, "edgar/filings must never be deleted");
  });

  it("[regression] the applier MERGES and refuses a failed read", () => {
    // The script reads the live policy and carries every UNOWNED rule through.
    // Both halves are load-bearing and neither is observable from the policy
    // file, so they are asserted against the script's source.
    assert.match(
      lifecycleSrc,
      /--format=json/,
      'the live policy must be read as JSON — `--format="value(lifecycle)"` ' +
        "prints an empty line for BOTH 'no policy' and 'wrong field name', " +
        "which is a fail-open read that always clobbers",
    );
    assert.match(
      lifecycleSrc,
      /FATAL: could not describe/,
      "a failed read must abort, never fall back to an empty baseline",
    );
    assert.match(
      lifecycleSrc,
      /const kept = liveRules\.filter\(\(r\) => !isOwned\(r\)\);/,
      "rules outside the allow-list must be preserved into the merged policy",
    );
    assert.match(
      lifecycleSrc,
      /REFUSE: .*declared rule\(s\) are not scoped/,
      "the applier must refuse a policy file with an unscoped rule",
    );
  });
});

describe("MONEY-979 — the Cloud Build triggers", () => {
  it("[regression] both new triggers are declared, filtered to the service", () => {
    // A trigger with no includedFiles rebuilds on EVERY push to its branch. For
    // this service that means a one-line change in apps/web rolling a new Cloud
    // Run revision and re-pinning five jobs for a service that did not change.
    //
    // MONEY-1478 — the script owns MORE THAN ONE SERVICE now. The filter moved
    // from a single `INCLUDED_FILES=` constant into a `SERVICES` table, so this
    // asserts the ROW rather than the constant, and it asserts the property
    // that matters: every row declares a filter, and the filter is passed to
    // gcloud.
    const rows = [...triggersSrc.matchAll(/^\s*"([a-z-]+)\|([^"]+)"$/gm)].map(
      (m) => `${m[1]}|${m[2]}`,
    );
    assert.ok(
      rows.length >= 2,
      `expected the SERVICES table rows, found ${rows.length}: ${rows.join(" ; ")}`,
    );
    for (const row of rows) {
      const included = row.split("|")[3] ?? "";
      assert.ok(
        included.includes("**"),
        `${row.split("|")[0]} declares no glob filter — a trigger without ` +
          `includedFiles rebuilds on EVERY push to its branch`,
      );
    }
    assert.ok(
      rows.some((r) => r.startsWith("us-fundamentals|")),
      "us-fundamentals must still be managed here",
    );
    assert.ok(
      rows.some((r) => r.startsWith("market-data|")),
      "market-data had NO trigger at all until MONEY-1478 — every deploy was a " +
        "hand-run `gcloud builds submit`, and QA drifted three commits behind",
    );
    // market-data imports @usemoney/core, so a core-only change alters what it
    // serves while leaving apps/market-data/** untouched. That is exactly the
    // drift measured on 2026-09-18, so the filter must reach packages/.
    const md = rows.find((r) => r.startsWith("market-data|"))!;
    assert.match(md, /packages\/\*\*/);
    assert.match(triggersSrc, /--included-files="\$INCLUDED_FILES"/);
    assert.match(triggersSrc, /us-fundamentals/);
    // The branch patterns must match the two existing worker triggers, so one
    // merge builds both deployables of an environment.
    assert.match(triggersSrc, /\^release\$/);
    assert.match(triggersSrc, /\^main\$/);
  });

  it("[regression] the two EXISTING worker triggers are never written to", () => {
    // Adding a filter to an existing trigger CHANGES WHEN IT FIRES, which is a
    // behaviour change to the release path. The script reports them and prints
    // the command; it must not run one.
    const unmanaged = ["stockbook-worker-prod", "stockbook-workers-qa"];
    for (const name of unmanaged) {
      assert.ok(
        triggersSrc.includes(name),
        `${name} must be named, so the script can report it`,
      );
      // No line may both invoke gcloud and name one of them. The printed
      // suggestion lives inside an `echo`, which this correctly permits.
      const offending = triggersSrc
        .split("\n")
        .filter(
          (l) =>
            l.includes(name) &&
            /\bgcloud\b/.test(l) &&
            !/^\s*(#|echo\b)/.test(l),
        );
      assert.deepEqual(
        offending,
        [],
        `setup-cloudbuild-triggers.sh must never write to ${name}`,
      );
    }
    assert.match(
      triggersSrc,
      /declare -a UNMANAGED_TRIGGERS=/,
      "the unmanaged set must be declared, not implied",
    );
  });

  it("[regression] a listing it cannot read is FATAL on a live run", () => {
    // apply-monitors.sh's fault (e), one product over: read as "nothing
    // exists", every trigger is CREATED a second time and every push builds
    // twice.
    assert.match(triggersSrc, /expected an array of triggers/);
    assert.match(triggersSrc, /FATAL: could not list Cloud Build triggers/);
  });
});

describe("MONEY-979 — the Datadog wiring for the EDGAR jobs", () => {
  it("[regression] MONITORED_JOBS carries no COMMENTED-OUT row", () => {
    /**
     * Two parsers, one list, and they disagree.
     *
     * bash honours `#`, so a commented row is not in the array. The regexes in
     * `monitor-agreement.test.ts` and `job-outcome-coverage.test.ts` scrape the
     * block as text and do NOT strip comments, so the same row IS a monitored
     * job to them. A job parked as a comment would therefore be asserted about
     * in CI and monitored nowhere — the shape of MONEY-1255's "one rule, stated
     * twice, disagreeing".
     *
     * This matters right now: the EDGAR block above deliberately names ten job
     * ids that are not yet monitored, and it names them BARE for exactly this
     * reason.
     */
    const block = bashArray(monitorsSrc, "MONITORED_JOBS");
    const commentedRows = block
      .split("\n")
      .filter((l) => /^\s*#/.test(l) && /"[a-z0-9-]+\|/.test(l));
    assert.deepEqual(
      commentedRows.map((l) => l.trim()),
      [],
      "A commented-out row inside MONITORED_JOBS is invisible to bash and " +
        "VISIBLE to every test that scrapes this block. Name a pending job " +
        "bare (no quotes, no pipes) instead:\n  " +
        commentedRows.join("\n  "),
    );
  });

  it("[regression] edgar-detect is monitored, on a window shorter than a day", () => {
    const rows = [
      ...stripBashComments(bashArray(monitorsSrc, "MONITORED_JOBS")).matchAll(
        /"([^|"]+)\|([^|"]+)\|/g,
      ),
    ].map((m) => ({ job: m[1]!, window: m[2]! }));
    assert.ok(rows.length >= 8, `MONITORED_JOBS rows: ${rows.length}`);
    const detect = rows.find((r) => r.job === "edgar-detect");
    assert.ok(detect, "edgar-detect must have a zero-write monitor");
    // The window sizes SENSITIVITY here, not tolerance of a gap: the job runs
    // every minute in all weather and reports 0/0 when the feed is quiet, so a
    // 36h window would hide a broken claim path for a day and a half behind the
    // one good claim it is nearly certain to contain.
    const hours = /^(\d+)h$/.exec(detect.window);
    assert.ok(
      hours,
      `edgar-detect window must be in hours, got ${detect.window}`,
    );
    assert.ok(
      Number(hours[1]) < 24,
      `a minutely job needs a sub-daily window, got ${detect.window}`,
    );
  });

  it("[regression] the latency template is idempotently updatable", () => {
    // apply-monitors.sh finds the monitor it is about to update with ONE
    // listing filtered by `managed-by:apply-monitors`, then matches on the
    // rendered name. A template without that tag is never in the listing, so
    // every run POSTs a NEW monitor and the set duplicates — MONEY-1238's
    // fault (e), in the template added by the ticket that cites it.
    const tpl = JSON.parse(read(LATENCY_TEMPLATE)) as { tags: string[] };
    assert.ok(
      tpl.tags.includes("managed-by:apply-monitors"),
      "monitor-latency-p95.json must carry managed-by:apply-monitors or " +
        "apply-monitors.sh will duplicate it on every run",
    );
    // The listing must still be narrowed by THAT tag — but since MONEY-1379 it
    // is narrowed by that tag AND the environment (`monitor_tags` ANDs
    // comma-separated tags). Without the env term a qa run's listing contains
    // the production monitors, which is how a pruning script deletes the other
    // environment's estate. So the property is checked in two steps: the
    // listing uses LIST_TAG, and LIST_TAG is DERIVED from MANAGED_TAG rather
    // than being some unrelated string.
    assert.match(
      monitorsSrc,
      /monitor_tags=\$\(printf %s "\$LIST_TAG"/,
      "the listing must be narrowed by a tag filter",
    );
    assert.match(
      monitorsSrc,
      /LIST_TAG="\$\{MANAGED_TAG\},env:\$\{DD_ENV_TAG\}"/,
      "LIST_TAG must be MANAGED_TAG plus the environment — if it stops " +
        "containing MANAGED_TAG the template is no longer in its own listing " +
        "and every run POSTs a duplicate",
    );
  });

  it("[regression] the LATENCY loop skips prod-only jobs on qa too", () => {
    // The skip lived in the zero-write loop and the script grew a second list.
    // `edgar-detect` is PROD_ONLY (QA ships SEC_EGRESS=off), so a QA latency
    // monitor for it watches a job that environment never runs.
    //
    // The original reason given here was that the template sets
    // `notify_no_data`, making the QA monitor red from birth. That is no longer
    // true — the latency template now sets `notify_no_data: false`, because a
    // latency monitor watches SLOW and absence is the zero-write monitor's job.
    // The SKIP is still right for the reason above; only the rationale moved.
    const latencyBlock = bashArray(monitorsSrc, "LATENCY_MONITORS");
    const latencyJobs = [
      ...stripBashComments(latencyBlock).matchAll(/"([^|"]+)\|/g),
    ].map((m) => m[1]!);
    assert.ok(latencyJobs.length >= 1, "no LATENCY_MONITORS rows found");
    assert.deepEqual(latencyJobs, ["edgar-detect"]);

    const loop = monitorsSrc.slice(
      monitorsSrc.indexOf('for ROW in "${LATENCY_MONITORS[@]}"'),
    );
    assert.match(
      loop,
      /if \[\[ "\$DD_ENV_TAG" == "qa" \]\] && job_is_prod_only "\$L_JOB"; then/,
      "the latency loop must skip prod-only jobs when targeting qa",
    );
    // …and a skip must not read as a lost monitor, or every qa run goes FATAL.
    assert.match(
      monitorsSrc,
      /if \(\(L_APPLIED \+ L_SKIPPED != \$\{#LATENCY_MONITORS\[@\]\}\)\); then/,
      "the latency accounting must count skips as well as applies",
    );
  });
});

describe("the Cloud Build source upload excludes Python virtualenvs", () => {
  // A `.gcloudignore` REPLACES `.gitignore` for the source upload rather than
  // adding to it. The repo has one, so every gitignored path that is not also
  // listed there is uploaded on every `gcloud builds submit .` —
  // `setup-infra.sh` submits `.` from the repo root.
  //
  // Measured 2026-08-29: `services/us-fundamentals/.venv` is 578 MiB. The
  // sibling build artefacts (`.next/`, `.turbo/`, `coverage/`, `dist/`) were
  // already covered; the venv arrived with the Python service and was not.
  const ignore = readFileSync(join(ROOT, ".gcloudignore"), "utf8");

  it("PREMISE: the file exists and already excludes the known-large artefacts", () => {
    for (const known of ["node_modules/", ".next/", ".turbo/", "coverage/"]) {
      assert.ok(
        ignore.includes(known),
        `premise failed — ${known} is not excluded, so this file is not what it seems`,
      );
    }
  });

  it("excludes .venv at the root and at any depth", () => {
    assert.ok(
      ignore.includes(".venv/"),
      "a 578 MiB virtualenv is uploaded on every deploy",
    );
    assert.ok(
      ignore.includes("**/.venv/"),
      "the service's venv is NESTED — a root-only pattern does not reach it",
    );
  });

  it("excludes the other Python build artefacts", () => {
    for (const pat of ["__pycache__", ".pytest_cache", ".egg-info"]) {
      assert.ok(ignore.includes(pat), `${pat} is uploaded`);
    }
  });
});
