/**
 * Unit tests for the Cloud-Run-job build-provenance guard — MONEY-1205 T5.
 *
 * The guard's whole value is that "I could not determine the version" never
 * reads as "the version is fine". Most of what is asserted here is therefore
 * about the NEGATIVE space: placeholders, empty strings, and one-sided
 * comparisons must each land on their own outcome, at their own severity.
 *
 * Every input string below is a shape that actually occurs in this repo — see
 * the module header for which script produces which.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseBuildSha,
  compareDeployedVersion,
  buildProvenanceReport,
  shouldBlockStartup,
  reportBuildProvenance,
  MIN_SHA_CHARS,
  type ProvenanceEnv,
  type ProvenanceLogger,
} from "../../src/ops/build-provenance";

/** The measured MONEY-1205 pair: the job's stale image vs the live service. */
const STALE = "fbdc29e2";
const FRESH = "d7eefba7";
const FRESH_FULL = "d7eefba7c19a4b5e6f70123456789abcdef01234";

describe("parseBuildSha", () => {
  it("accepts a short SHA, a full SHA, and everything between", () => {
    for (const raw of [
      "fbdc29e2",
      "d7eefba7c19a4b5e6f70123456789abcdef01234",
      "abcdef1", // exactly the 7-char floor
      "0123456789abcdef0123456789abcdef01234567", // exactly 40
    ]) {
      const got = parseBuildSha(raw);
      assert.equal(got.kind, "sha", `${raw} should parse as a SHA`);
      if (got.kind === "sha") assert.equal(got.sha, raw);
    }
  });

  it("uppercases and surrounding whitespace do not defeat it", () => {
    // Cloud Build substitutions and shell `$(...)` capture both leak these.
    const got = parseBuildSha("  D7EEFBA7  ");
    assert.equal(got.kind, "sha");
    if (got.kind === "sha") {
      assert.equal(got.sha, "d7eefba7");
      assert.equal(got.raw, "D7EEFBA7", "raw keeps what the env actually said");
    }
  });

  it("parses setup-infra.sh's `<short-sha>-<timestamp>` form and keeps the SHA", () => {
    // scripts/ops/setup-infra.sh:221
    //   DEPLOY_SHA="$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)"
    // If this fell through to `absent`, every setup-infra-built image would be
    // reported as unidentifiable and the guard would be crying wolf on the
    // most common manual deploy path.
    const got = parseBuildSha("a1b2c3d-20260818173000");
    assert.equal(got.kind, "sha");
    if (got.kind === "sha") {
      assert.equal(got.sha, "a1b2c3d");
      assert.equal(got.suffix, "20260818173000");
    }
  });

  it("treats the Dockerfile ARG default as ABSENT, not as a version", () => {
    // workers/Dockerfile: `ARG DD_VERSION=unknown`. An image built without
    // --build-arg carries this literal. Reporting it as a version would make an
    // unversioned image indistinguishable from a versioned one.
    const got = parseBuildSha("unknown");
    assert.equal(got.kind, "absent");
    if (got.kind === "absent") {
      assert.match(got.reason, /placeholder/);
      assert.match(got.reason, /--build-arg/);
    }
  });

  it("treats the datadog 1.0.0 fallback and other placeholders as ABSENT", () => {
    // packages/datadog/src/tracer.ts falls back to "1.0.0"; it can be copied
    // into config and then looks like a real version to a naive check.
    for (const raw of ["1.0.0", "latest", "manual", "dev", "local", "none"]) {
      assert.equal(
        parseBuildSha(raw).kind,
        "absent",
        `"${raw}" must not be accepted as a build SHA`,
      );
    }
  });

  it("treats undefined and empty string as ABSENT, with different reasons", () => {
    // Empty is not hypothetical: update-prod-analysis-engine.sh computes
    // COMMIT_SHA and then omits it from the prod `gcloud builds submit`, so the
    // image tag is literally `prod-` and DD_VERSION is "".
    const undef = parseBuildSha(undefined);
    const empty = parseBuildSha("   ");
    assert.equal(undef.kind, "absent");
    assert.equal(empty.kind, "absent");
    if (undef.kind === "absent" && empty.kind === "absent") {
      assert.match(undef.reason, /not set/);
      assert.match(empty.reason, /empty/);
      assert.notEqual(
        undef.reason,
        empty.reason,
        "the two causes are diagnosed differently on purpose — one means the " +
          "image was not built by cloudbuild, the other that the build passed no SHA",
      );
    }
  });

  it("rejects things that merely look versionish", () => {
    for (const raw of [
      "v1.2.3",
      "prod-fbdc29e2", // the TAG, not the SHA — a whole tag is not a version
      "abcdef", // 6 chars, below the floor
      "zzzzzzz", // right length, not hex
      "release/2026-08-18",
      "fbdc29e2-notatimestamp",
    ]) {
      assert.equal(
        parseBuildSha(raw).kind,
        "absent",
        `"${raw}" must not parse as a SHA`,
      );
    }
  });
});

describe("compareDeployedVersion", () => {
  it("reports DRIFT for the measured MONEY-1205 pair", () => {
    const v = compareDeployedVersion(STALE, FRESH);
    assert.equal(v.status, "drift");
    if (v.status === "drift") {
      assert.equal(v.jobSha, STALE);
      assert.equal(v.expectedSha, FRESH);
    }
  });

  it("MATCHES a short SHA against the full SHA of the same commit", () => {
    // Cloud Build TRIGGERS substitute the full 40-char $COMMIT_SHA;
    // setup-infra.sh and workers/scripts/deploy.sh use `git rev-parse --short`.
    // Demanding equality would report permanent drift between two names for one
    // commit, and a guard that cries wolf gets muted.
    const v = compareDeployedVersion(FRESH, FRESH_FULL);
    assert.equal(v.status, "match");
    if (v.status === "match") assert.equal(v.comparedChars, FRESH.length);

    const flipped = compareDeployedVersion(FRESH_FULL, FRESH);
    assert.equal(flipped.status, "match", "prefix matching is symmetric");
  });

  it("does NOT match two different commits that share fewer than the full prefix", () => {
    const v = compareDeployedVersion("abcdef12", "abcdef99");
    assert.equal(v.status, "drift");
  });

  it("an unidentifiable RUNNING build is indeterminate, never a match", () => {
    // This is the single most important assertion in the file. If "unknown"
    // ever compared equal to anything, a job built without --build-arg would
    // report a clean bill of health forever.
    for (const raw of [undefined, "", "unknown", "1.0.0"]) {
      const v = compareDeployedVersion(raw, FRESH);
      assert.equal(
        v.status,
        "indeterminate",
        `running=${JSON.stringify(raw)} must be indeterminate`,
      );
      if (v.status === "indeterminate") {
        assert.match(v.reason, /cannot identify the running build/);
      }
    }
  });

  it("a missing EXPECTED side is indeterminate, never a match", () => {
    // The normal case today: nothing injects an expected SHA. It must not read
    // as "verified" — that is the fail-open default this whole module refuses.
    const v = compareDeployedVersion(FRESH, undefined);
    assert.equal(v.status, "indeterminate");
    if (v.status === "indeterminate") {
      assert.match(v.reason, /nothing to compare against/);
    }
  });

  it("REGRESSION: the reason blames the variable that is ACTUALLY missing", () => {
    // Found by running the built job binary, not by a test: `parseBuildSha`
    // hardcoded "DD_VERSION" in its reasons and is used for BOTH sides, so a
    // missing EXPECTED_BUILD_SHA reported "DD_VERSION is not set" — sending the
    // reader to inspect the one variable that was fine. A diagnostic that names
    // the wrong cause is worse than no diagnostic, because it is trusted.
    const missingExpected = compareDeployedVersion(FRESH, undefined);
    assert.equal(missingExpected.status, "indeterminate");
    if (missingExpected.status === "indeterminate") {
      assert.match(missingExpected.reason, /EXPECTED_BUILD_SHA is not set/);
      assert.doesNotMatch(
        missingExpected.reason,
        /DD_VERSION is not set/,
        "DD_VERSION was set — saying otherwise misdirects the person debugging",
      );
      // Same defect one clause later: the remedy text was about the image
      // build, which has nothing to do with a missing expected version.
      assert.doesNotMatch(
        missingExpected.reason,
        /this image was not built by/,
        "a missing EXPECTED_BUILD_SHA is not a build defect and must not be described as one",
      );
    }

    const missingJob = compareDeployedVersion(undefined, FRESH);
    assert.equal(missingJob.status, "indeterminate");
    if (missingJob.status === "indeterminate") {
      assert.match(missingJob.reason, /DD_VERSION is not set/);
      assert.doesNotMatch(missingJob.reason, /EXPECTED_BUILD_SHA is not set/);
    }
  });

  it("both sides missing names both causes", () => {
    const v = compareDeployedVersion(undefined, "unknown");
    assert.equal(v.status, "indeterminate");
    if (v.status === "indeterminate") {
      assert.match(v.reason, /running:/);
      assert.match(v.reason, /expected:/);
    }
  });

  it("never returns match without at least MIN_SHA_CHARS of agreement", () => {
    assert.equal(MIN_SHA_CHARS, 7);
    // Anything shorter than the floor fails to parse in the first place, so the
    // floor can never be reached with a 4-char "SHA".
    assert.equal(
      compareDeployedVersion("abcd", "abcd").status,
      "indeterminate",
    );
  });
});

const baseEnv = (over: Partial<ProvenanceEnv> = {}): ProvenanceEnv => ({
  CLOUD_RUN_JOB: "feed-parse-prod",
  CLOUD_RUN_EXECUTION: "feed-parse-prod-abc12",
  DD_ENV: "production",
  ...over,
});

describe("buildProvenanceReport", () => {
  it("ERROR + unidentified when the image carries no usable SHA", () => {
    const r = buildProvenanceReport(
      baseEnv({ DD_VERSION: "unknown" }),
      "feed-parse",
    );
    assert.equal(r.severity, "error");
    assert.equal(r.build.kind, "absent");
    assert.equal(r.fields.buildSha, "unidentified");
    assert.match(r.message, /ERROR/);
    assert.match(r.message, /cannot identify the commit/);
    // The remediation must be in the line itself — the person reading this at
    // 07:00 should not have to find a runbook.
    assert.match(r.message, /setup-feed-backfill-job\.sh/);
  });

  it("ERROR naming BOTH SHAs when the pinned job image has drifted", () => {
    const r = buildProvenanceReport(
      baseEnv({ DD_VERSION: STALE, EXPECTED_BUILD_SHA: FRESH }),
      "feed-parse",
    );
    assert.equal(r.severity, "error");
    assert.equal(r.verdict.status, "drift");
    assert.equal(r.fields.buildSha, STALE);
    assert.equal(r.fields.expectedSha, FRESH);
    assert.match(r.message, new RegExp(STALE));
    assert.match(r.message, new RegExp(FRESH));
  });

  it("WARN — not info — when there is nothing to compare against", () => {
    // The line still carries the SHA, because the SHA alone is what was missing
    // from the incident logs. But it must not claim verification it did not do.
    const r = buildProvenanceReport(
      baseEnv({ DD_VERSION: STALE }),
      "feed-parse",
    );
    assert.equal(r.severity, "warn");
    assert.equal(r.verdict.status, "indeterminate");
    assert.match(r.message, /WARN/);
    assert.match(r.message, /NOT VERIFIED/);
    assert.match(r.message, new RegExp(STALE));
    assert.doesNotMatch(
      r.message,
      /\bok\b/,
      "an unverified build must not use the success token",
    );
  });

  it("info only when the two SHAs positively agree", () => {
    const r = buildProvenanceReport(
      baseEnv({ DD_VERSION: FRESH, EXPECTED_BUILD_SHA: FRESH_FULL }),
      "feed-parse",
    );
    assert.equal(r.severity, "info");
    assert.equal(r.verdict.status, "match");
    assert.match(r.message, /\[build-provenance\] ok/);
  });

  it("every message is greppable on one stable prefix", () => {
    for (const env of [
      baseEnv({ DD_VERSION: undefined }),
      baseEnv({ DD_VERSION: STALE }),
      baseEnv({ DD_VERSION: STALE, EXPECTED_BUILD_SHA: FRESH }),
      baseEnv({ DD_VERSION: FRESH, EXPECTED_BUILD_SHA: FRESH }),
    ]) {
      const r = buildProvenanceReport(env, "feed-parse");
      assert.match(
        r.message,
        /^\[build-provenance\] /,
        "a log alert has to key on something that never moves",
      );
      assert.equal(r.fields.entrypoint, "feed-parse");
      assert.equal(r.fields.job, "feed-parse-prod");
      assert.equal(r.fields.verdict, r.verdict.status);
    }
  });

  it("identifies a non-Cloud-Run invocation instead of pretending", () => {
    const r = buildProvenanceReport(
      { DD_VERSION: FRESH, NODE_ENV: "development" },
      "feed-repair",
    );
    assert.equal(r.jobName, "not-a-cloud-run-job");
    assert.equal(r.fields.env, "development");
    assert.equal(r.fields.execution, undefined);
  });
});

describe("shouldBlockStartup", () => {
  it("does NOT block by default, even on drift", () => {
    // Argued in the module header: aborting a nightly job because it is one
    // commit behind turns a partial run into no run, unattended. During the
    // real incident the stale job was still parsing every non-bond family.
    const env = baseEnv({ DD_VERSION: STALE, EXPECTED_BUILD_SHA: FRESH });
    const r = buildProvenanceReport(env, "feed-parse");
    assert.equal(r.severity, "error");
    assert.equal(shouldBlockStartup(r, env), false);
  });

  it("does not block when the version is merely unidentified", () => {
    const env = baseEnv({ DD_VERSION: "unknown" });
    assert.equal(
      shouldBlockStartup(buildProvenanceReport(env, "x"), env),
      false,
    );
  });

  it("blocks on drift when BUILD_PROVENANCE_STRICT is opted in", () => {
    for (const flag of ["1", "true", "TRUE", "yes", "on"]) {
      const env = baseEnv({
        DD_VERSION: STALE,
        EXPECTED_BUILD_SHA: FRESH,
        BUILD_PROVENANCE_STRICT: flag,
      });
      assert.equal(
        shouldBlockStartup(buildProvenanceReport(env, "x"), env),
        true,
        `BUILD_PROVENANCE_STRICT=${flag} should arm the block`,
      );
    }
  });

  it("blocks an UNVERIFIED build under strict mode too", () => {
    // Strict means "a run I cannot vouch for is worse than no run". An
    // indeterminate verdict is exactly such a run, so it must not slip through
    // the one gate that exists to stop them.
    const env = baseEnv({
      DD_VERSION: STALE,
      BUILD_PROVENANCE_STRICT: "1",
    });
    assert.equal(
      shouldBlockStartup(buildProvenanceReport(env, "x"), env),
      true,
    );
  });

  it("never blocks a match, strict or not", () => {
    const env = baseEnv({
      DD_VERSION: FRESH,
      EXPECTED_BUILD_SHA: FRESH_FULL,
      BUILD_PROVENANCE_STRICT: "1",
    });
    assert.equal(
      shouldBlockStartup(buildProvenanceReport(env, "x"), env),
      false,
    );
  });

  it("an unrecognised strict value is OFF, not on", () => {
    const env = baseEnv({
      DD_VERSION: STALE,
      EXPECTED_BUILD_SHA: FRESH,
      BUILD_PROVENANCE_STRICT: "maybe",
    });
    assert.equal(
      shouldBlockStartup(buildProvenanceReport(env, "x"), env),
      false,
    );
  });
});

describe("reportBuildProvenance", () => {
  const spyLogger = (): {
    logger: ProvenanceLogger;
    info: string[];
    warn: string[];
    error: string[];
  } => {
    const info: string[] = [];
    const warn: string[] = [];
    const error: string[] = [];
    return {
      info,
      warn,
      error,
      logger: {
        info: (...a) => info.push(a.join(" ")),
        warn: (...a) => warn.push(a.join(" ")),
        error: (...a) => error.push(a.join(" ")),
      },
    };
  };

  it("routes each severity to its own channel, exactly once", () => {
    const cases: Array<[Partial<ProvenanceEnv>, "info" | "warn" | "error"]> = [
      [{ DD_VERSION: FRESH, EXPECTED_BUILD_SHA: FRESH }, "info"],
      [{ DD_VERSION: FRESH }, "warn"],
      [{ DD_VERSION: STALE, EXPECTED_BUILD_SHA: FRESH }, "error"],
      [{ DD_VERSION: "unknown" }, "error"],
    ];
    for (const [over, channel] of cases) {
      const s = spyLogger();
      reportBuildProvenance(s.logger, "feed-parse", baseEnv(over));
      const counts = {
        info: s.info.length,
        warn: s.warn.length,
        error: s.error.length,
      };
      assert.deepEqual(
        counts,
        { info: 0, warn: 0, error: 0, [channel]: 1 },
        `expected exactly one ${channel} line for ${JSON.stringify(over)}`,
      );
    }
  });

  it("degrades to warn when the logger has no error channel", () => {
    // scripts/jobs/*.ts each define a two-method `{info, warn}` console shim.
    // The line must survive that, which is why the message carries its own
    // uppercase severity token rather than relying on the channel.
    const info: string[] = [];
    const warn: string[] = [];
    const shim: ProvenanceLogger = {
      info: (...a) => info.push(a.join(" ")),
      warn: (...a) => warn.push(a.join(" ")),
    };
    reportBuildProvenance(
      shim,
      "feed-parse",
      baseEnv({ DD_VERSION: "unknown" }),
    );
    assert.equal(info.length, 0);
    assert.equal(warn.length, 1);
    assert.match(warn[0]!, /ERROR/);
  });

  it("returns the report so a caller can act on the verdict", () => {
    const s = spyLogger();
    const r = reportBuildProvenance(
      s.logger,
      "fo-summary",
      baseEnv({ DD_VERSION: STALE, EXPECTED_BUILD_SHA: FRESH }),
    );
    assert.equal(r.verdict.status, "drift");
    assert.equal(r.entrypoint, "fo-summary");
  });

  it("does not throw on a hostile env — a guard must not become the outage", () => {
    const s = spyLogger();
    assert.doesNotThrow(() =>
      reportBuildProvenance(s.logger, "feed-parse", {
        DD_VERSION: "\u0000\u0000",
        EXPECTED_BUILD_SHA: "x".repeat(10_000),
        CLOUD_RUN_JOB: "",
      }),
    );
  });
});
