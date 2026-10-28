/**
 * `setup-infra.sh`'s discovery list must name every provisioner — MONEY-1373.
 *
 * The script provisions five things and then PRINTS what it does not cover, so
 * an operator knows what still has to be run by hand. That list named three of
 * ten scripts for seven tickets. Every provisioner added after EDGAR — the
 * three Tiingo backfills, three XBRL jobs, BSE, doc-ingest, feed-backfill, the
 * prod->QA mirror and both Databento jobs — was invisible to anyone reading it.
 *
 * WHY THAT IS EXPENSIVE RATHER THAN UNTIDY. A Cloud Run JOB pins its image at
 * PROVISION time, and deploying the workers SERVICE does not move it. So a
 * script missing from this list is a job nobody re-pins after a deploy: it goes
 * on running whatever it was created with, indefinitely, while the logs look
 * perfectly healthy. MONEY-1189's fix sat un-executed on the nightly jobs after
 * release for exactly this reason.
 *
 * A list nobody can check rots. This is the check.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const OPS = join(ROOT, "scripts", "ops");
const INFRA = readFileSync(join(OPS, "setup-infra.sh"), "utf8");

/**
 * Scripts `setup-infra.sh` RUNS rather than delegates.
 *
 * `setup-scheduler.sh` is step 3 of the script's own sequence, so naming it in
 * a "not covered" list would be a lie in the other direction.
 */
const RUN_BY_INFRA = new Set(["setup-scheduler.sh", "setup-infra.sh"]);

const provisioners = readdirSync(OPS)
  .filter((f) => f.startsWith("setup-") && f.endsWith(".sh"))
  .filter((f) => !RUN_BY_INFRA.has(f))
  .sort();

describe("setup-infra.sh names every provisioner it does not run", () => {
  it("[premise] the ops directory really holds provisioning scripts", () => {
    // A scan whose directory resolves to nothing passes forever and reads as
    // coverage. Ten is the count at the time of writing; the floor is what
    // matters, not the exact number.
    assert.ok(
      provisioners.length >= 10,
      `found ${provisioners.length} setup-*.sh under scripts/ops`,
    );
    assert.ok(
      provisioners.includes("setup-databento-jobs.sh"),
      "the Databento provisioner is not on disk",
    );
  });

  it("[premise] the script still HAS both lists", () => {
    // If either block is renamed away, every assertion below would pass over a
    // string that is simply absent.
    assert.match(INFRA, /^# NOT covered here/m);
    assert.match(INFRA, /Not covered by this script:/);
  });

  it("every provisioner is named", () => {
    const missing = provisioners.filter((f) => !INFRA.includes(f));
    assert.deepEqual(
      missing,
      [],
      "these provisioning scripts exist but setup-infra.sh never names them, " +
        "so an operator following its output does not know to run them. A " +
        "Cloud Run JOB pins its image at provision time, so an unnamed job " +
        "script is a job that silently keeps running a stale image:\n  " +
        missing.join("\n  "),
    );
  });

  it("it does not name a script that no longer exists", () => {
    // The other direction. A list that outlives its scripts sends an operator
    // to a command that fails, which teaches them to ignore the list.
    const named = [...INFRA.matchAll(/(setup-[a-z0-9-]+\.sh)/g)].map(
      (m) => m[1]!,
    );
    // BOTH homes. `setup-pubsub.sh` lives under `workers/scripts/`, not
    // `scripts/ops/`, and resolving only the latter reported a script that has
    // been there since the workers existed as "absent" — the check failing on
    // its own blind spot rather than on the file it guards.
    const onDisk = new Set([
      ...readdirSync(OPS),
      ...readdirSync(join(ROOT, "workers", "scripts")),
    ]);
    const dangling = [...new Set(named)].filter((f) => !onDisk.has(f)).sort();
    assert.deepEqual(dangling, [], `named but absent: ${dangling.join(", ")}`);
  });

  it("the lifecycle line names the prefixes the policy actually carries", () => {
    // It read "the edgar/ bucket lifecycle rules" while the policy covered
    // four prefixes across three tickets. A description that is wrong is worse
    // than none: it tells an operator the rule does not apply to them.
    const policy = JSON.parse(
      readFileSync(join(OPS, "gcs-lifecycle.json"), "utf8"),
    ) as { rule: Array<{ condition: { matchesPrefix?: string[] } }> };
    const prefixes = [
      ...new Set(policy.rule.flatMap((r) => r.condition.matchesPrefix ?? [])),
    ].sort();
    assert.ok(
      prefixes.length >= 3,
      `policy carries ${prefixes.length} prefixes`,
    );
    for (const prefix of prefixes) {
      assert.ok(
        INFRA.includes(prefix),
        `setup-infra.sh does not mention the ${prefix} lifecycle prefix`,
      );
    }
  });

  it("the env-less scripts are not printed with an ${ENV}", () => {
    // `setup-sync-job.sh` provisions the prod->QA mirror and takes no
    // environment argument — it is inherently cross-env. Printing
    // `setup-sync-job.sh qa` would have an operator pass an argument the
    // script silently ignores.
    assert.doesNotMatch(INFRA, /setup-sync-job\.sh \$\{ENV\}/);
    assert.match(INFRA, /setup-sync-job\.sh\s+\(no env arg\)/);
  });
});

/**
 * A deploy target's spec may only use substitutions the deploy path SUPPLIES.
 *
 * MONEY-1466. `apps/market-data/cloudbuild.{qa,prod}.yaml` tagged its image
 * `usemoney-market-data:qa-$SHORT_SHA`, and nothing in this repo ever sets
 * `SHORT_SHA`. It is a TRIGGER-only built-in, `setup-infra.sh` passes
 * `--substitutions=COMMIT_SHA=...` and nothing else, and this service has no
 * trigger at all — `setup-cloudbuild-triggers.sh` manages only
 * `us-fundamentals`. So the tag resolved to `usemoney-market-data:qa-`, which
 * is not a valid tag, and the ONLY way to find that out was to spend a build.
 *
 * Every other spec in the repo already used `$COMMIT_SHA`. Nothing compared
 * them, so being the odd one out cost nothing until deploy time.
 */
describe("a deploy target's cloudbuild spec uses only supplied substitutions", () => {
  // Trigger-only built-ins. `COMMIT_SHA` is absent from this list because
  // `setup-infra.sh` passes it EXPLICITLY — it is the one this repo supplies.
  const TRIGGER_ONLY = [
    "SHORT_SHA",
    "REVISION_ID",
    "REPO_NAME",
    "BRANCH_NAME",
    "TAG_NAME",
    "REF_NAME",
  ];

  const targets = [...INFRA.matchAll(/^\s*"([a-z-]+)\|([^"]+)"\s*$/gm)].map(
    (m) => ({ name: m[1]!, prefix: m[2]! }),
  );

  it("[premise] the DEPLOY_TARGETS table was actually parsed", () => {
    // A regex that matches nothing turns every assertion below into a loop
    // over an empty array, which passes forever and reads as coverage.
    assert.ok(targets.length >= 3, `parsed ${targets.length} deploy targets`);
    assert.ok(targets.some((t) => t.name === "market-data"));
    assert.ok(targets.some((t) => t.name === "workers"));
  });

  it("every declared substitution is actually READ by its template", () => {
    // Cloud Build REFUSES a build whose `substitutions:` block declares a key
    // the template never reads: `INVALID_ARGUMENT: key "_ENV" in the
    // substitution data is not matched in the template`. It is not a warning
    // and there is no partial build — the upload completes, 778 MB of context
    // is pushed, and THEN it fails.
    //
    // Both market-data specs shipped `_ENV`, which nothing read because the env
    // is expressed by WHICH FILE you run (the sed block writes DATABASE_URL_QA
    // literally) and `DD_ENV` is a literal too. The sibling rule above catches
    // a substitution nothing SETS; this one catches a substitution nothing
    // USES. They are opposite halves and neither implies the other.
    const offences: string[] = [];
    for (const { prefix } of targets) {
      for (const env of ["qa", "prod"]) {
        const path = `${prefix}.${env}.yaml`;
        const src = readFileSync(join(ROOT, path), "utf8");
        const block = /^substitutions:\n((?:[ \t]+.*\n|\n)*)/m.exec(src);
        if (!block) continue;
        const declared = [...block[1]!.matchAll(/^\s+(_[A-Z0-9_]+):/gm)].map(
          (m) => m[1]!,
        );
        // The body is everything AFTER the block, so a key's own declaration
        // never counts as a use of itself.
        const body = src.slice(block.index! + block[0].length);
        for (const key of declared) {
          if (
            !body.includes(`\${${key}}`) &&
            !new RegExp(`\\$${key}\\b`).test(body)
          ) {
            offences.push(`${path} declares ${key} and never reads it`);
          }
        }
      }
    }
    assert.deepEqual(
      offences,
      [],
      "Cloud Build refuses these outright — the build uploads its whole source " +
        "context and only then returns INVALID_ARGUMENT:\n  " +
        offences.join("\n  "),
    );
  });

  it("no spec reads a substitution only a TRIGGER would set", () => {
    const offences: string[] = [];
    for (const { prefix } of targets) {
      for (const env of ["qa", "prod"]) {
        const path = `${prefix}.${env}.yaml`;
        const src = readFileSync(join(ROOT, path), "utf8");
        for (const key of TRIGGER_ONLY) {
          // Both spellings: `$SHORT_SHA` and `${SHORT_SHA}`.
          if (new RegExp(`\\$\\{?${key}\\b`).test(src)) {
            offences.push(`${path} reads $${key}`);
          }
        }
      }
    }
    assert.deepEqual(
      offences,
      [],
      "these specs read a substitution that is populated by a Cloud Build " +
        "TRIGGER, but they are deployed by `setup-infra.sh`, which passes only " +
        "COMMIT_SHA. It resolves EMPTY — an image tag ending in `-` is not a " +
        "valid tag, and the build is the first thing that says so:\n  " +
        offences.join("\n  "),
    );
  });
});
