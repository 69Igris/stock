/**
 * MONEY-1278 — a Cloud Run JOB that reports an outcome can actually emit it.
 *
 * ## The state this measures, and why it read as health
 *
 * Measured on the deployed estate 2026-09-05: ALL SEVENTEEN TypeScript Cloud
 * Run jobs carried no `DD_*` env at all. `packages/datadog/src/metrics.ts`
 * initialises `datadog-metrics` only when `DD_API_KEY` is set and no-ops
 * otherwise, so every `reportJobOutcome` call in `scripts/jobs/` wrote its log
 * line and reached nobody. `feed-parse` is in `MONITORED_JOBS` on BOTH
 * environments, so its monitor has been watching a series that has never
 * existed — NO DATA, which is indistinguishable from health the moment the
 * no-data notification is muted. That is MONEY-1238's finding (d) reproduced
 * one layer down, in the transport rather than the query.
 *
 * The Python half is the same defect through a different mechanism (no sidecar
 * for DogStatsD) and is guarded by
 * `services/us-fundamentals/tests/test_deploy_contract.py`.
 *
 * ## Two halves, both scanned as TEXT
 *
 *   1. THE PROVISIONER must hand the job `DD_API_KEY` (a secret), `DD_ENV`, and
 *      `DD_TRACE_ENABLED=false`. The last is not decoration: `workers/Dockerfile`
 *      bakes `ENV DD_TRACE_ENABLED=true`, and a JOB has no agent, so without the
 *      override every job boots dd-trace against a socket that is not there.
 *   2. THE JOB SCRIPT must `flushMetrics()` before it exits. `datadog-metrics`
 *      batches on a 15-second timer, so a job that finishes first takes its
 *      counters with it — the key would be present and the series still empty,
 *      which is the same NO DATA by a third route.
 *
 * ## The population is DERIVED, never listed
 *
 * A provisioner is in scope when it deploys a job whose entrypoint is NODE
 * (`--command="node,…"`). That is the property the rule actually depends on:
 * `setup-us-fundamentals-jobs.sh` says `python,-m,…` (its own contract test
 * covers it) and `setup-sync-job.sh` passes no `--command` at all because it
 * runs a `google/cloud-sdk` image with no Node in it. Neither can emit through
 * `@usemoney/datadog`, and neither should be dragged in by a name filter. A
 * NEW Node job provisioner is caught the day it lands; a new Python one is
 * correctly ignored, without anybody maintaining a list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setupScriptFor } from "../../src/ops/build-provenance";
import { deployJobCalls } from "./deploy-job-calls";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const OPS = join(ROOT, "scripts", "ops");
const JOBS = join(ROOT, "scripts", "jobs");

const readOps = (f: string) => readFileSync(join(OPS, f), "utf8");
const readJob = (f: string) => readFileSync(join(JOBS, f), "utf8");

/**
 * file -> dated reason. EMPTY, and the ratchet below keeps it that way: an
 * entry here is a job whose outcome does not reach Datadog, so it must cost
 * somebody a written reason rather than being dropped out of the scan quietly.
 * (One was expected when this landed — the doc-ingest lane held two files — and
 * PR #401 merged first, so there was nothing to defer.)
 */
const PROVISIONER_EXEMPT: ReadonlyMap<string, string> = new Map();
const JOB_EXEMPT: ReadonlyMap<string, string> = new Map();

/**
 * Provisioners that deploy a NODE Cloud Run job — see the header.
 *
 * Selected by WHAT THEY DO (`--command="node,`), over every `setup-*.sh`: the
 * file name used to be part of the filter (`setup-*-job(s).sh`), and
 * `setup-dataform.sh` — which deploys `lake-gold` since MONEY-1611 — would
 * have deployed a Node job outside this scan by being named for its tool.
 */
const provisioners = readdirSync(OPS)
  .filter((f) => /^setup-.*\.sh$/.test(f))
  .filter((f) => /--command="node,/.test(readOps(f)))
  .sort();

/** Job entry points that report an outcome. */
const reportingJobs = readdirSync(JOBS)
  .filter((f) => /\.(ts|mts)$/.test(f))
  .filter((f) => /reportJobOutcome\(/.test(readJob(f)))
  .sort();

describe("MONEY-1278 — every TypeScript Cloud Run job can emit its outcome", () => {
  // A scan that resolved nothing passes every assertion below it. These two
  // are the falsifiable ceiling: the counts are what was measured when the
  // rule was written, and a drop means the derivation broke, not that the
  // estate shrank.
  it("PREMISE: the provisioner scan resolved the Node job provisioners", () => {
    assert.deepEqual(provisioners, [
      "setup-bse-backfill-job.sh",
      "setup-databento-jobs.sh",
      "setup-dataform.sh",
      "setup-doc-ingest-backfill-job.sh",
      // MONEY-1499 (B8) — the v1 -> v2 embedding migration job.
      "setup-embeddings-v2-job.sh",
      "setup-feed-backfill-job.sh",
      // MONEY-1518 / MONEY-1521 — lake-release + event-lake-sink, as lake-writer.
      "setup-lake-jobs.sh",
      "setup-tiingo-backfill-job.sh",
      // MONEY-1467 — the two D1 tile builders, one provisioner.
      "setup-tile-build-job.sh",
      "setup-xbrl-backfill-job.sh",
      "setup-xbrl-projection-drain-job.sh",
      "setup-xbrl-reparse-job.sh",
    ]);
  });

  it("PREMISE: the job scan resolved the reporting entry points", () => {
    assert.ok(
      reportingJobs.length >= 3,
      `expected at least 3 reporting job scripts, found ${reportingJobs.join(", ")}`,
    );
  });

  it("PREMISE: the two out-of-scope provisioners are excluded for the RIGHT reason", () => {
    // Named here so the exclusion is a measured property rather than a name
    // filter nobody re-checks. If either ever grows a Node job, the derivation
    // pulls it in and this test says why it changed.
    assert.match(
      readOps("setup-us-fundamentals-jobs.sh"),
      /--command="python,-m,/,
    );
    assert.doesNotMatch(readOps("setup-sync-job.sh"), /--command=/);
  });

  for (const file of provisioners) {
    describe(file, () => {
      it("passes DD_API_KEY as a secret, per environment", () => {
        if (PROVISIONER_EXEMPT.has(file)) return;
        const src = readOps(file);
        // `--set-secrets="$job_secrets"` is RESOLVED to its assignment, as the
        // env-var check below does — and every per-job DEPLOY_SECRETS override
        // (setup-databento-jobs.sh's lake-load runs as lake-writer@ with its own
        // list) must carry the key too, or that one job reports to nobody.
        const secrets = [...src.matchAll(/--set-secrets="([^"]+)"/g)].map(
          (m) => {
            const ref = /^\$\{?(\w+)\}?$/.exec(m[1].trim());
            if (!ref) return m[1];
            const assignment = new RegExp(
              `(?:local\\s+)?${ref[1]}="([^"]+)"`,
            ).exec(src);
            assert.ok(assignment, `--set-secrets names $${ref[1]}, unassigned`);
            return assignment[1];
          },
        );
        const overrides = [...src.matchAll(/DEPLOY_SECRETS="([^"]+)"/g)].map(
          (m) => m[1],
        );
        assert.ok(secrets.length >= 1, "no --set-secrets found");
        for (const value of [...secrets, ...overrides]) {
          assert.match(
            value,
            /DD_API_KEY=\$\{DD_SECRET\}:latest/,
            "the job gets no Datadog API key, so datadog-metrics no-ops and the outcome reaches nobody",
          );
        }
        assert.match(src, /DD_SECRET="DD_API_KEY_PROD"/, "no prod key mapping");
        assert.match(src, /DD_SECRET="DD_API_KEY_QA"/, "no qa key mapping");
      });

      it("passes DD_ENV and overrides the image's DD_TRACE_ENABLED", () => {
        if (PROVISIONER_EXEMPT.has(file)) return;
        const src = readOps(file);

        // `setup-feed-backfill-job.sh` builds its env string into a local and
        // passes `--set-env-vars="$env_vars"`. Reading the flag's literal text
        // there proves nothing, so an indirection is RESOLVED to the assignment
        // it names rather than skipped — skipping it would have let that one
        // provisioner (which deploys feed-parse, the job whose monitor is
        // already live) pass with no key at all.
        const resolve = (value: string): string => {
          const ref = /^\$\{?(\w+)\}?$/.exec(value.trim());
          if (!ref) return value;
          const assignment = new RegExp(
            `(?:local\\s+)?${ref[1]}="([^"]+)"`,
          ).exec(src);
          assert.ok(
            assignment,
            `--set-env-vars names $${ref[1]}, and nothing in the file assigns it`,
          );
          return assignment[1];
        };

        const envValues = [...src.matchAll(/--set-env-vars="([^"]+)"/g)].map(
          (m) => resolve(m[1]),
        );
        assert.ok(envValues.length >= 1, "no env-var string found");
        for (const value of envValues) {
          assert.match(
            value,
            /DD_ENV=\$\{ENV\}/,
            "no DD_ENV — the monitor's env tag would never match",
          );
          assert.match(
            value,
            /DD_TRACE_ENABLED=false/,
            "workers/Dockerfile bakes DD_TRACE_ENABLED=true and a JOB has no agent",
          );
        }
      });

      it("carries exactly one --set-env-vars and one --set-secrets", () => {
        // Both flags REPLACE rather than merge, and gcloud takes the LAST one:
        // a second flag silently drops everything the first supplied. Every
        // provisioner header in this repo warns about it in prose; this is the
        // assertion of it.
        const src = readOps(file);
        assert.equal(
          (src.match(/--set-env-vars=/g) ?? []).length,
          1,
          "more than one --set-env-vars",
        );
        assert.equal(
          (src.match(/--set-secrets=/g) ?? []).length,
          1,
          "more than one --set-secrets",
        );
      });
    });
  }

  for (const file of reportingJobs) {
    it(`${file} flushes its metrics before the process exits`, () => {
      if (JOB_EXEMPT.has(file)) return;
      assert.match(
        readJob(file),
        /flushMetrics\(/,
        "reports an outcome and never flushes — datadog-metrics batches on a 15s timer, so the counters die with the process",
      );
    });
  }

  // The ratchet, both arms. A permit that is no longer needed is worse than no
  // permit: it is a file nobody is checking, wearing a reason that has expired.
  it("no exemption names a file that already complies", () => {
    for (const [file, reason] of PROVISIONER_EXEMPT) {
      assert.doesNotMatch(
        readOps(file),
        /DD_API_KEY=\$\{DD_SECRET\}:latest/,
        `${file} now passes the key — delete its exemption (${reason})`,
      );
    }
    for (const [file, reason] of JOB_EXEMPT) {
      assert.doesNotMatch(
        readJob(file),
        /flushMetrics\(/,
        `${file} now flushes — delete its exemption (${reason})`,
      );
    }
  });

  it("every exemption names a file that exists and is in the scanned population", () => {
    for (const file of PROVISIONER_EXEMPT.keys()) {
      assert.ok(
        provisioners.includes(file),
        `${file} is exempt from a scan it is not in`,
      );
    }
    for (const file of JOB_EXEMPT.keys()) {
      assert.ok(
        reportingJobs.includes(file),
        `${file} is exempt from a scan it is not in`,
      );
    }
  });
});

/**
 * MONEY-1609 — the same rule, PER JOB, for the one provisioner that deploys
 * seven of them through a helper.
 *
 * The file-level cases above read `setup-lake-jobs.sh`'s helper TEXT, which
 * says `"${secrets_extra}DD_API_KEY=${DD_SECRET}:latest"` whatever each call
 * site passes. A call site that drops its trailing comma fuses two secrets
 * into one malformed pair, and one that brings its own `DD_API_KEY` or
 * `DD_ENV` is a duplicate key gcloud refuses — both invisible to a text scan
 * of the helper. So each call is expanded into what it actually deploys.
 */
describe("MONEY-1609 — every job setup-lake-jobs.sh deploys can emit", () => {
  const calls = deployJobCalls(readOps("setup-lake-jobs.sh"));
  const items = (s: string) => s.split(",").filter((x) => x !== "");
  const keys = (s: string) => items(s).map((x) => x.split("=")[0]);

  it("PREMISE: it resolved every entry point mapped to it, from the MAP", () => {
    // The expectation comes from SETUP_SCRIPT_BY_ENTRYPOINT, not from the
    // script, so a deploy deleted from the script is a missing name here.
    const tsup = readFileSync(join(ROOT, "workers", "tsup.config.ts"), "utf8");
    const mapped = [...tsup.matchAll(/"([\w-]+)":\s*"\.\.\/scripts\/jobs\//g)]
      .map((m) => m[1]!)
      .filter((e) => setupScriptFor(e) === "scripts/ops/setup-lake-jobs.sh")
      .sort();
    assert.ok(mapped.length >= 7, `only ${mapped.length} mapped entry points`);
    assert.deepEqual(calls.map((c) => c.entry).sort(), mapped);
  });

  for (const call of calls) {
    it(`${call.entry}: exactly one DD_API_KEY, and every secret well-formed`, () => {
      const pairs = items(call.secrets);
      assert.equal(
        pairs.filter((p) => p === "DD_API_KEY=${DD_SECRET}:latest").length,
        1,
        `effective --set-secrets is "${call.secrets}"`,
      );
      for (const p of pairs) {
        assert.match(
          p,
          /^[A-Z_]+=\$\{[A-Z_]+\}:latest$/,
          `"${p}" is not NAME=\${SECRET}:latest — a call site's extra secrets must END in a comma`,
        );
      }
      assert.equal(
        new Set(keys(call.secrets)).size,
        pairs.length,
        "duplicate secret key",
      );
    });

    it(`${call.entry}: DD_ENV and DD_TRACE_ENABLED=false, once each`, () => {
      const vars = items(call.envVars);
      for (const want of ["DD_ENV=${ENV}", "DD_TRACE_ENABLED=false"]) {
        assert.equal(
          vars.filter((v) => v === want).length,
          1,
          `effective --set-env-vars is "${call.envVars}"`,
        );
      }
      for (const v of vars)
        assert.match(v, /^[A-Z_]+=[^=]+$/, `malformed "${v}"`);
      assert.equal(
        new Set(keys(call.envVars)).size,
        vars.length,
        "duplicate env key",
      );
    });
  }
});
