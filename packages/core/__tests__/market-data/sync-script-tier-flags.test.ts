/**
 * `scripts/ops/sync-prod-to-qa.sh` — argument handling and skip-reason
 * attribution (MONEY-1157).
 *
 * The repo has no shell test harness (no bats, no shellcheck in CI), and adding
 * one for two defects would be a bigger change than the fix. This is a static
 * scan in the style of `ops-script-db-target.test.ts`, which guards the sibling
 * ops scripts the same way — the point is that the defect can be reintroduced
 * by editing one line, and nothing would notice.
 *
 * ## The two defects
 *
 * 1. `--tier) TIER="$2"; shift 2 ;;` under `set -eo pipefail`. Invoked as
 *    `--tier` with NO value, `shift 2` FAILS, `set -e` kills the script, and it
 *    exits 1 having printed ZERO bytes — so the `*)` validation that would have
 *    said "expected '<tiers>'" never runs. Verified by execution
 *    before the fix.
 *
 * 2. The real run printed a hard-coded `MongoDB sync SKIPPED (--gcs-only).`
 *    while the DRY RUN was already tier-aware. The `sync-prod-to-qa-feeds`
 *    Cloud Run job runs `--yes --tier=feeds` (setup-sync-job.sh), so every real
 *    log line for that scheduled job cited a flag it was never passed — and a
 *    scheduled job's log is the ONLY operator-visible output it has.
 *
 * Both branches now go through ONE `mongo_skip_notice` helper, because they had
 * already drifted once: two copies of the same message is the stale-copy class,
 * and the copy that drifted was the one nobody reads interactively.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolved from THIS FILE, not from cwd — a cwd-relative path that throws
 * inside a describe callback is reported by node as a dropped suite with
 * `fail 0` and exit 0, i.e. the guard would silently disappear.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const SYNC_SCRIPT = "scripts/ops/sync-prod-to-qa.sh";
const SETUP_SCRIPT = "scripts/ops/setup-sync-job.sh";

function read(rel: string): string {
  const full = join(REPO_ROOT, rel);
  assert.ok(existsSync(full), `${rel} not found — did it move or get renamed?`);
  return readFileSync(full, "utf8");
}

/**
 * Drop `#` comment lines.
 *
 * Needed for the ordering check below: the branch's own comment explains the
 * bug by quoting `shift 2`, so a naive `indexOf` finds the prose before the
 * code and reports the guard as misplaced.
 */
function stripShellComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

describe("sync-prod-to-qa.sh --tier parsing (MONEY-1157)", () => {
  it("still runs under `set -e`, which is what made the bug silent", () => {
    // Without -e the failing `shift 2` would merely have been ignored. The
    // premise matters: if this is ever relaxed, re-derive the guard below
    // rather than assuming it still describes the failure.
    assert.match(
      read(SYNC_SCRIPT),
      /^set -eo pipefail$/m,
      "sync-prod-to-qa.sh no longer sets -e; re-check whether a missing " +
        "--tier value can still kill the script silently",
    );
  });

  it("the space-form --tier checks for its value before shifting", () => {
    const src = stripShellComments(read(SYNC_SCRIPT));
    const branch = /--tier\)([\s\S]*?);;/.exec(src);
    assert.ok(branch, "the `--tier)` (space-form) branch is gone");
    const body = branch[1]!;

    assert.match(
      body,
      /\$#\s*-lt\s*2/,
      "`--tier)` must check `[ $# -lt 2 ]` BEFORE `shift 2`. Without it, " +
        "`--tier` with no value makes `shift 2` fail, `set -e` kills the " +
        "script, and it exits 1 with no output at all — the operator gets " +
        "nothing to act on.",
    );

    // The guard has to come first; a check placed after the shift never runs.
    const guardAt = body.indexOf("$#");
    const shiftAt = body.indexOf("shift 2");
    assert.ok(guardAt >= 0 && shiftAt >= 0);
    assert.ok(
      guardAt < shiftAt,
      "the `$# -lt 2` check must precede `shift 2` — after it, set -e has " +
        "already killed the script",
    );
  });

  it("a missing value reports in the same shape as an invalid one", () => {
    const src = read(SYNC_SCRIPT);

    // Asserts the INVARIANT, not the literal. This used to hardcode
    // "expected 'reference' or 'feeds'" and went red the moment a third tier
    // (`sample`) was added — even though the property it exists to protect,
    // that both paths speak ONE vocabulary, still held. A test that fails on a
    // correct change teaches people to edit tests reflexively, which is how a
    // real regression gets waved through next time.
    const invalid = /Unknown --tier: [^\n]*\(expected ([^)]+)\)/.exec(src);
    const missing = /Missing value for --tier \(expected ([^)]+)\)/.exec(src);
    assert.ok(
      invalid,
      "the invalid-value path no longer names the valid tiers",
    );
    assert.ok(
      missing,
      "the missing-value path no longer names the valid tiers",
    );
    assert.equal(
      missing[1],
      invalid[1],
      "the two --tier error paths must offer the SAME list of valid tiers, or the operator sees two dialects",
    );

    // …and that list must be the tiers the `case` actually accepts. Derived
    // from the script so a tier can never be advertised but unhandled, or
    // handled but undocumented.
    const block = /case "\$TIER" in([\s\S]*?)\nesac/.exec(src);
    assert.ok(block, "the --tier case block is gone");
    const handled = [...block[1].matchAll(/^\s{4}([a-z]+)\)/gm)].map(
      (m) => m[1],
    );
    for (const tier of handled) {
      assert.ok(
        invalid[1].includes(`'${tier}'`),
        `the case block handles '${tier}' but the error message never offers it`,
      );
    }
  });

  it("the `=` form is untouched and still falls through to validation", () => {
    // `--tier=` yields an empty TIER, which the `*)` case rejects. Both forms
    // must reach the SAME validation; only the space form needed a guard.
    const src = read(SYNC_SCRIPT);
    assert.match(src, /--tier=\*\)\s*TIER="\$\{1#\*=\}";\s*shift\s*;;/);
    assert.match(
      src,
      /\*\)\s*echo "Unknown --tier: \$TIER \(expected [^)]+\)";\s*exit 1\s*;;/,
    );
  });
});

describe("sync-prod-to-qa.sh skip-reason attribution (MONEY-1157)", () => {
  it("the real run no longer hard-codes --gcs-only", () => {
    const src = read(SYNC_SCRIPT);
    assert.doesNotMatch(
      src,
      /Part 1: MongoDB sync SKIPPED \(--gcs-only\)/,
      "the real run must not attribute the skip to --gcs-only unconditionally " +
        "— the sync-prod-to-qa-feeds Cloud Run job runs `--yes --tier=feeds` " +
        "and never passes that flag, so every one of its log lines was false",
    );
  });

  it("ONE helper serves both the dry-run and the real-run branch", () => {
    // The two messages drifted apart once already. A single definition is the
    // fix for the stale-copy class, not a tidy-up.
    const src = read(SYNC_SCRIPT);
    assert.match(src, /^mongo_skip_notice\(\)/m, "expected a shared helper");

    // `mongo_skip_notice() {` is the DEFINITION, not a call — exclude it.
    const calls = src.match(/^\s*mongo_skip_notice(?!\s*\(\)).*$/gm) ?? [];
    assert.equal(
      calls.length,
      2,
      `expected exactly 2 call sites (dry run + real run); found ${calls.length}`,
    );
    // The real run labels its sections; the dry run does not.
    assert.ok(calls.some((c) => c.includes('"Part 1: "')));
    assert.ok(calls.some((c) => /mongo_skip_notice\s*$/.test(c.trim())));
  });

  it("the helper branches on the tier, and only the reference tier says --gcs-only", () => {
    const src = read(SYNC_SCRIPT);
    const body = /^mongo_skip_notice\(\) \{([\s\S]*?)^\}/m.exec(src);
    assert.ok(body, "could not read the mongo_skip_notice body");

    assert.match(body[1]!, /\$TIER.*==.*"feeds"/);
    assert.match(body[1]!, /the feeds tier never touches collections/);
    assert.match(body[1]!, /MongoDB sync SKIPPED \(--gcs-only\)/);
  });

  it("the GCS section header names EVERY prefix it actually syncs", () => {
    // Same defect, same block: the header said "stocks/" while the feeds tier
    // rsyncs "feeds/". The label is derived where the buckets are chosen.
    const src = read(SYNC_SCRIPT);
    assert.doesNotMatch(src, /Part 2: GCS stocks\/ bucket/);
    assert.match(src, /GCS_PREFIX_LABEL="feeds\/"/);
    assert.match(src, /GCS_PREFIX_LABEL="stocks\/"/);

    // MONEY-1373 — the feeds tier now mirrors TWO prefixes, `feeds/` and
    // `candles/`, so the header interpolates a second label. This used to
    // assert the exact string `Part 2: GCS ${GCS_PREFIX_LABEL} bucket`, which
    // is stale rather than wrong: the property it protects is that the header
    // is DERIVED from the labels rather than hardcoded, and a hardcoded second
    // prefix is the same defect one prefix along. So both labels must appear,
    // and neither may be spelled out as a literal.
    const header = /^\s*echo -e .*Part 2: GCS .*$/m.exec(src)?.[0];
    assert.ok(header, "the Part 2 header line is gone");
    assert.match(header, /\$\{GCS_PREFIX_LABEL\}/);
    assert.match(header, /\$\{CANDLES_GCS_PREFIX_LABEL[^}]*\}/);
    assert.doesNotMatch(
      header,
      /(feeds|stocks|candles)\//,
      `the Part 2 header hardcodes a prefix: ${header}`,
    );
    // And the second label really is set where the buckets are chosen, not
    // beside the echo — the MONEY-1157 rule this whole suite exists for.
    assert.match(src, /CANDLES_GCS_PREFIX_LABEL="candles\/"/);
  });
});

describe("the premise: the feeds job really does pass --tier=feeds", () => {
  it("setup-sync-job.sh deploys the feeds job with `--yes,--tier=feeds`", () => {
    // If this ever changes, the FIX C reasoning above stops applying and the
    // messages should be re-derived rather than trusted.
    const src = read(SETUP_SCRIPT);
    assert.match(
      src,
      /--args="--yes,--tier=feeds"/,
      "the feeds Cloud Run job no longer passes --tier=feeds; re-check which " +
        "flags its logs should cite",
    );
  });

  it("that job is a DESIGN, not a deployed fact (nothing asserts otherwise)", () => {
    // Verified live 2026-08-08: `gcloud run jobs describe sync-prod-to-qa-feeds`
    // → "Cannot find job", `gcloud scheduler jobs describe
    // sync-prod-to-qa-feeds-daily` → NOT_FOUND, and both buckets' `feeds/`
    // prefixes are empty. The script defines it; nobody has run the script.
    // This test only pins the definition, deliberately — a test cannot and
    // should not assert live GCP state.
    const src = read(SETUP_SCRIPT);
    assert.match(src, /FEEDS_JOB_NAME="sync-prod-to-qa-feeds"/);
    assert.match(src, /FEEDS_SCHED_NAME="sync-prod-to-qa-feeds-daily"/);
  });
});
