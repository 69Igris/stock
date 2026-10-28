/**
 * MONEY-979 — the EDGAR deploy LADDER: can a cold environment be built, and
 * does the operator end up with the seven push subscriptions?
 *
 * `edgar-infra-coverage.test.ts` next door asks whether the provisioning files
 * AGREE with each other. This file asks a different question: whether the
 * ORDER they must be run in is achievable, and whether the failures along the
 * way are distinguishable. Four defects motivated it, all found by stubbing
 * gcloud and watching what the scripts would issue:
 *
 *   1. `setup-pubsub.sh` exited 1 when `us-fundamentals-{env}` did not exist.
 *      `setup-infra.sh` runs it as step 2 under `set -e`, and step 4 is the
 *      only thing that BUILDS that service — so `./scripts/ops/setup-infra.sh
 *      prod`, the file's own documented "Full setup for Production", aborted
 *      before the deploy that would have made step 2 succeed. Measured on a
 *      cold environment: EXIT=1, zero `builds submit`, steps 3 and 4 never
 *      reached, ~65 Scheduler entries and both service deploys skipped.
 *
 *   2. Nothing re-ran the EDGAR subscription step after the deploy, so the
 *      seven `edgar-*-{env}-push` subscriptions were never created at all. A
 *      topic with NO subscription DROPS messages silently — no DLQ, no error,
 *      no metric — while `edgar-detect-minutely-{env}` publishes 1,440x/day.
 *
 *   3. `GCP_SERVICE_ACCOUNT_KEY_BASE64` was mounted into the Python service and
 *      all five Cloud Run jobs and read by NOTHING (`app/sec/archive.py` builds
 *      a plain `storage.Client()`, i.e. ADC). The comment beside it told the
 *      operator to grant the bucket to the principal that key names, which is
 *      true of the TypeScript `googleCredentials()` helper and false here — so
 *      following it 403s `archive.write_bytes` AFTER the SEC GET is spent.
 *
 *   4. The QA cloudbuild's re-pin loop named five jobs that QA does not
 *      provision, so every QA build emitted five permanent "NOT re-pinned"
 *      warnings. A warning that is always present makes a REAL prod drift
 *      warning indistinguishable from the baseline.
 *
 * ## Why the assertions read shell and YAML as TEXT
 *
 * Same reason as the sibling file: these scripts' entire output is a `gcloud`
 * invocation, and `gcloud` is what a test must not run. Reading the source is
 * the honest version of the question; a mocked gcloud would only assert that
 * the mock was written correctly.
 *
 * ## Every extraction is proved to have read something
 *
 * A regex that matches nothing turns an assertion into a tautology. The first
 * `describe` asserts floors on every block this file extracts, so a rename that
 * empties one of them fails HERE rather than quietly passing everywhere else.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// packages/core/__tests__/ops -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const PUBSUB_SCRIPT = join(ROOT, "workers/scripts/setup-pubsub.sh");
const INFRA_SCRIPT = join(ROOT, "scripts/ops/setup-infra.sh");
const JOBS_SCRIPT = join(ROOT, "scripts/ops/setup-us-fundamentals-jobs.sh");
const CLOUDBUILD_QA = join(ROOT, "services/us-fundamentals/cloudbuild.qa.yaml");
const CLOUDBUILD_PROD = join(
  ROOT,
  "services/us-fundamentals/cloudbuild.prod.yaml",
);
const RUNBOOK = join(ROOT, "docs/reference/edgar-engine.md");
const SERVICE_README = join(ROOT, "services/us-fundamentals/README.md");

const read = (p: string): string => readFileSync(p, "utf8");

const pubsubSrc = read(PUBSUB_SCRIPT);
const infraSrc = read(INFRA_SCRIPT);
const jobsSrc = read(JOBS_SCRIPT);
const qaSrc = read(CLOUDBUILD_QA);
const prodSrc = read(CLOUDBUILD_PROD);
const runbookSrc = read(RUNBOOK);
const readmeSrc = read(SERVICE_README);

/**
 * Drop whole-line `#` comments.
 *
 * Load-bearing rather than tidy: bash and YAML both honour `#` and a regex does
 * not, so a claim made in prose would otherwise satisfy an assertion about
 * CONFIGURATION. Every "the key is not mounted" check below runs on this.
 */
const stripComments = (s: string): string =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/**
 * Prose as a reader sees it: comment markers gone, wrapping collapsed.
 *
 * Every doc assertion below runs on this. Matching raw text would make each one
 * a hostage to where a line happens to wrap — an assertion that goes red on a
 * reflow and green on a rewrite is worse than none.
 */
const collapse = (s: string): string =>
  s
    .replace(/^[ \t]*#[ \t]?/gm, "")
    .replace(/\s+/g, " ")
    .trim();

/** The 4b EDGAR subscription loop, isolated from the worker loop above it. */
const edgarSubSection = (() => {
  const from = pubsubSrc.indexOf("4b. Creating EDGAR push subscriptions");
  const to = pubsubSrc.indexOf("MONEY-1204: the DEAD-LETTER topic", from);
  assert.ok(from > 0 && to > from, "could not isolate the 4b EDGAR loop");
  return pubsubSrc.slice(from, to);
})();

const pubsubCode = stripComments(pubsubSrc);
const infraCode = stripComments(infraSrc);
const jobsCode = stripComments(jobsSrc);
const qaCode = stripComments(qaSrc);
const prodCode = stripComments(prodSrc);

/** The `Re-pinning …` Cloud Build step body, as executed text. */
function repinStep(spec: string, env: string): string {
  const m = new RegExp(
    `set -uo pipefail\\n\\s*IMAGE=[\\s\\S]*?\\n\\s*exit 0`,
  ).exec(spec);
  assert.ok(m, `${env}: could not locate the re-pin step`);
  return m[0];
}

const repinQa = repinStep(qaSrc, "qa");
const repinProd = repinStep(prodSrc, "prod");

/** The runbook's "### First deploy" section, up to the next `###`. */
const firstDeploySection = (() => {
  const m = /### First deploy\n([\s\S]*?)\n### /.exec(runbookSrc);
  assert.ok(m, "could not locate the runbook's First deploy section");
  return m[1]!;
})();

// ────────────────────────────────────────────────────────────────────────────
// BEHAVIOURAL HARNESS — run the real scripts, observe what they DO
// ────────────────────────────────────────────────────────────────────────────
/**
 * The text assertions above are shape-matchers, and a round-2 review measured
 * exactly what that buys: three realistic regressions kept the whole file
 * GREEN.
 *
 *   1. `elif should_run "edgar-push" 5; then EDGAR_PUSH_TARGETED=true` — the
 *      self-blocking ladder RESTORED. The guard for it greps for one exact
 *      single-line spelling and any reformulation walks past.
 *   2. `… setup-pubsub.sh "$ENV" || true` on step 5 — a failed re-run becomes
 *      invisible and "Infrastructure Setup Complete!" prints.
 *   3. `EDGAR_PUSH_READY=0` -> `=1` on the not-found branch — seven
 *      subscriptions created with an EMPTY `--push-auth-token-audience=`, which
 *      is worse than the placeholder the tests above explicitly guard against.
 *
 * All three are one token wide, none of them changes a string any regex here
 * looks for, and all three are only visible in the EXIT CODE and the gcloud
 * calls the run issues. So these cases execute the real scripts.
 *
 * ## Why the gcloud stub is a BASH FUNCTION sourced through BASH_ENV
 *
 * A PATH-only stub was tried first and every case reported a false PASS. The
 * function is defined by a prelude that bash SOURCES for each non-interactive
 * shell — including the child `bash workers/scripts/setup-pubsub.sh` that
 * setup-infra spawns, since BASH_ENV is inherited. It is NOT an EXPORTED
 * function: bash 3.2 (what macOS ships) CLEARS `BASH_SOURCE` when a shell calls
 * a function imported from the environment, so a script reading
 * `${BASH_SOURCE[0]}` after its first stubbed call dies — a false CRITICAL that
 * cost a review round.
 *
 * ## PATH is REPLACED anyway, and points at a deny-shim
 *
 * Belt and braces on a test that shells out: if BASH_ENV ever fails to load,
 * the `gcloud` these scripts resolve must not be the real CLI. `PATH` is
 * rebuilt as `<denyDir>:/usr/bin:/bin:/usr/sbin:/sbin`, and `<denyDir>/gcloud`
 * writes `PATH-STUB-REACHED` into the call log and exits 127. So the failure
 * mode of a broken harness is a loud red test, never a call to real
 * infrastructure.
 *
 * ## Every case proves the stub ANSWERED before it grades anything
 *
 * `runLadder` asserts the call log is non-empty (and free of
 * `PATH-STUB-REACHED`) before returning. A stub that was silently bypassed
 * would otherwise make "exit 0" mean nothing at all.
 */
const STUB_PRELUDE = `# gcloud stub. Sourced via BASH_ENV, so the function is NATIVE to each shell.
gcloud() {
  printf '%s\\n' "$*" >> "$GCLOUD_LOG"
  case "$*" in
    "run services describe us-fundamentals-"*)
      case "\${STUB_USF_DESCRIBE:-warm}" in
        warm)
          echo "https://us-fundamentals-\${STUB_ENV}-abcdef-el.a.run.app"; return 0 ;;
        coldthenwarm)
          # The REAL ladder: absent at step 2, present at step 5 because the
          # deploy in between minted it.
          if [ -f "\${STUB_STATE_DIR}/deployed" ]; then
            echo "https://us-fundamentals-\${STUB_ENV}-abcdef-el.a.run.app"; return 0
          fi
          echo "ERROR: (gcloud.run.services.describe) Cannot find service [us-fundamentals-\${STUB_ENV}]." >&2
          return 1 ;;
        notfound)
          echo "ERROR: (gcloud.run.services.describe) Cannot find service [us-fundamentals-\${STUB_ENV}]." >&2
          return 1 ;;
        notfound_v2)
          echo "ERROR: (gcloud.run.services.describe) NOT_FOUND: Resource 'namespaces/p/services/us-fundamentals-\${STUB_ENV}' was not found." >&2
          return 1 ;;
        authfail)
          echo "ERROR: (gcloud.run.services.describe) There was a problem refreshing your current auth tokens: invalid_grant: Bad Request" >&2
          echo "Please run: \\$ gcloud auth login" >&2
          return 1 ;;
        apidisabled)
          echo "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: Cloud Run Admin API has not been used in project stock-book-483718 before or it is disabled." >&2
          return 1 ;;
        denied)
          echo "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: Permission 'run.services.get' denied on resource." >&2
          return 1 ;;
        emptyok)
          # Exits 0 and prints NOTHING: a service with no ready revision.
          return 0 ;;
      esac ;;
    "run services describe stockbook-workers-"*)
      echo "https://stockbook-workers-\${STUB_ENV}-abcdef-el.a.run.app"; return 0 ;;
    "builds submit"*)
      case "$*" in
        *us-fundamentals*) : > "\${STUB_STATE_DIR}/deployed" ;;
      esac
      [ "\${STUB_BUILDS_SUBMIT:-ok}" = "ok" ] && return 0
      echo "ERROR: build failed" >&2; return 1 ;;
    "pubsub topics create edgar-"*)
      case "\${STUB_EDGAR_TOPIC_CREATE:-exists}" in
        ok) return 0 ;;
        exists)
          echo "ERROR: Failed to create topic [x]: Resource already exists in the project." >&2
          return 1 ;;
        fail)
          echo "ERROR: (gcloud.pubsub.topics.create) PERMISSION_DENIED: User not authorized." >&2
          return 1 ;;
      esac ;;
    "pubsub subscriptions describe edgar-"*)
      [ "\${STUB_EDGAR_SUB_DESCRIBE:-absent}" = "present" ] && return 0 || return 1 ;;
    "pubsub subscriptions create edgar-"*)
      [ "\${STUB_EDGAR_SUB_CREATE:-ok}" = "ok" ] && return 0
      echo "ERROR: create failed" >&2; return 1 ;;
    "pubsub subscriptions update edgar-"*)
      [ "\${STUB_EDGAR_SUB_UPDATE:-ok}" = "ok" ] && return 0
      echo "ERROR: update failed" >&2; return 1 ;;
    "pubsub subscriptions add-iam-policy-binding edgar-"*)
      [ "\${STUB_EDGAR_ACK_GRANT:-ok}" = "ok" ] && return 0
      echo "ERROR: grant failed" >&2; return 1 ;;
    "run services add-iam-policy-binding us-fundamentals-"*)
      [ "\${STUB_USF_INVOKER:-ok}" = "ok" ] && return 0
      echo "ERROR: invoker grant failed" >&2; return 1 ;;
    "projects describe"*) echo "123456789012"; return 0 ;;
    *) return 0 ;;
  esac
}
`;

const HARNESS_DIR = mkdtempSync(join(tmpdir(), "edgar-ladder-"));
const PRELUDE_PATH = join(HARNESS_DIR, "gcloud-stub.sh");
writeFileSync(PRELUDE_PATH, STUB_PRELUDE);

const DENY_DIR = join(HARNESS_DIR, "deny-bin");
mkdirSync(DENY_DIR, { recursive: true });
const DENY_GCLOUD = join(DENY_DIR, "gcloud");
writeFileSync(
  DENY_GCLOUD,
  `#!/bin/sh
printf 'PATH-STUB-REACHED %s\\n' "$*" >> "$GCLOUD_LOG"
echo "the BASH_ENV gcloud function was not loaded; refusing to run real gcloud" >&2
exit 127
`,
);
chmodSync(DENY_GCLOUD, 0o755);

after(() => rmSync(HARNESS_DIR, { recursive: true, force: true }));

interface LadderRun {
  status: number;
  out: string;
  /** Every `gcloud …` invocation, argv joined by a space, in order. */
  calls: string[];
  /** setup-pubsub's own verdict: COMPLETE | NOT_BUILT | BROKEN | "". */
  edgarStatus: string;
}

let runSeq = 0;

/**
 * Execute one of the two real scripts with `gcloud` stubbed.
 *
 * `expectCalls: false` is only for cases that must issue ZERO gcloud calls —
 * argument validation. Everywhere else the non-empty log is the proof that the
 * stub answered, and grading an exit code without it is grading nothing.
 */
function runLadder(
  script: "infra" | "pubsub",
  args: string[],
  stub: Record<string, string> = {},
  opts: { expectCalls?: boolean } = {},
): LadderRun {
  const id = `run-${++runSeq}`;
  const logPath = join(HARNESS_DIR, `${id}.calls`);
  const statusPath = join(HARNESS_DIR, `${id}.status`);
  const stateDir = join(HARNESS_DIR, id);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(logPath, "");
  writeFileSync(statusPath, "");

  const scriptPath =
    script === "infra"
      ? join(ROOT, "scripts/ops/setup-infra.sh")
      : join(ROOT, "workers/scripts/setup-pubsub.sh");

  const r = spawnSync("bash", [scriptPath, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      HOME: process.env.HOME ?? HARNESS_DIR,
      TMPDIR: HARNESS_DIR,
      // PATH is REPLACED, not prepended: the deny-shim must be the only
      // `gcloud` reachable if BASH_ENV ever fails to load.
      PATH: `${DENY_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
      BASH_ENV: PRELUDE_PATH,
      GCLOUD_LOG: logPath,
      STUB_STATE_DIR: stateDir,
      STUB_ENV: args[0] ?? "prod",
      EDGAR_PUSH_STATUS_FILE: statusPath,
      ...stub,
    },
  });

  const calls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  assert.ok(
    !calls.some((c) => c.startsWith("PATH-STUB-REACHED")),
    `the BASH_ENV gcloud function did not load — the deny-shim answered instead. ` +
      `Every verdict below would be about a broken harness:\n${out}`,
  );
  if (opts.expectCalls !== false) {
    assert.ok(
      calls.length > 0,
      `the stub was never called, so nothing was exercised (exit ${r.status}):\n${out}`,
    );
  }

  return {
    status: r.status ?? -1,
    out,
    calls,
    edgarStatus: readFileSync(statusPath, "utf8").trim(),
  };
}

/** The seven `edgar-*-{env}-push` subscription CREATE calls a run issued. */
const edgarSubCreates = (r: LadderRun): string[] =>
  r.calls.filter((c) => c.startsWith("pubsub subscriptions create edgar-"));

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 ladder — the extractions are not empty", () => {
  it("read every file it asserts on", () => {
    for (const [name, src] of [
      ["setup-pubsub.sh", pubsubSrc],
      ["setup-infra.sh", infraSrc],
      ["setup-us-fundamentals-jobs.sh", jobsSrc],
      ["cloudbuild.qa.yaml", qaSrc],
      ["cloudbuild.prod.yaml", prodSrc],
      ["edgar-engine.md", runbookSrc],
      ["services/us-fundamentals/README.md", readmeSrc],
    ] as const) {
      assert.ok(src.length > 500, `${name} looks empty or truncated`);
    }
  });

  it("stripComments removes prose without eating configuration", () => {
    assert.ok(
      pubsubSrc.length - pubsubCode.length > 2000,
      "setup-pubsub.sh has comments; stripComments removed almost nothing",
    );
    assert.ok(
      pubsubCode.includes("EDGAR_TOPICS"),
      "stripComments ate the EDGAR_TOPICS declaration",
    );
  });

  it("located both re-pin steps and the runbook ladder", () => {
    assert.ok(repinQa.includes("edgar-bulk-submissions"), "qa re-pin step");
    assert.ok(repinProd.includes("edgar-bulk-submissions"), "prod re-pin step");
    assert.ok(
      firstDeploySection.includes("setup-infra.sh"),
      "First deploy section does not mention setup-infra.sh",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 #1 — setup-pubsub DEGRADES on a cold environment", () => {
  /**
   * The whole fix is that "the service is not built yet" and "the service is
   * up and something failed" stop sharing one exit code. Both halves are
   * asserted, because dropping either one recreates a known defect: without the
   * gate the bootstrap self-blocks (the original bug), and without the failure
   * counter a genuinely broken run reports success (the bug the original
   * `|| true` had).
   */
  it("declares the required-flag and the failure counter", () => {
    assert.match(
      pubsubCode,
      /EDGAR_PUSH_REQUIRED="\$\{EDGAR_PUSH_REQUIRED:-0\}"/,
      "EDGAR_PUSH_REQUIRED must default to 0 — a cold bootstrap is the DEFAULT case",
    );
    assert.match(
      pubsubCode,
      /^EDGAR_PUSH_FAILURES=0$/m,
      "EDGAR_PUSH_FAILURES must be initialised; `[ -gt ]` on an unset value is an error under set -u",
    );
  });

  it("never increments the counter with (( )), which set -e turns into an exit", () => {
    // `((n++))` returns 1 when n was 0. Under `set -e` that kills the script on
    // the FIRST failure it counts — the counter would work exactly once and
    // never be read.
    assert.ok(
      !/EDGAR_PUSH_FAILURES\+\+/.test(pubsubCode),
      "increment EDGAR_PUSH_FAILURES by assignment, not ((n++))",
    );
    const increments = [
      ...pubsubCode.matchAll(
        /EDGAR_PUSH_FAILURES=\$\(\(EDGAR_PUSH_FAILURES \+ 1\)\)/g,
      ),
    ];
    // This assertion read `3` with the message "three call sites can fail
    // against a service that EXISTS" for one release, and the claim was FALSE
    // when it was written: FIVE EDGAR-specific gcloud call classes exist, and
    // two of them threw their failure away. The DLQ-ack grant loop ended
    // `--quiet 2>/dev/null || true` with an UNCONDITIONAL green "Granted
    // pubsub.subscriber on EDGAR subscriptions" underneath it — the exact
    // reporting shape the update branch above says this ticket removed — and
    // the EDGAR topic-create loop printed a GREEN "Topic … already exists" for
    // a PERMISSION_DENIED. Worse than merely wrong: at `3` this assertion FAILS
    // when somebody counts the fourth, so it actively defended the bug.
    assert.equal(
      increments.length,
      5,
      "five EDGAR call sites can fail while their OWN precondition holds: the " +
        "topic create (needs no service URL at all), the subscription create, " +
        "the subscription update, the per-subscription DLQ-ack grant, and the " +
        `run.invoker grant. Found ${increments.length}.`,
    );
  });

  it("counts the DLQ-ack grant, and claims it only when every grant succeeded", () => {
    // The two halves are separate defects. `|| true` loses the failure; the
    // unconditional echo ASSERTS success over it. Removing one and keeping the
    // other still ships a lie.
    // stripComments FIRST and deliberately: the block's own comment QUOTES the
    // `--quiet 2>/dev/null || true` it replaced, and a prose mention must never
    // satisfy — or here, fail — an assertion about configuration.
    const ackBlock = (() => {
      const from = pubsubCode.indexOf('if [ "$EDGAR_PUSH_READY" = "1" ]; then');
      const to = pubsubCode.indexOf(
        "gcloud run services add-iam-policy-binding stockbook-workers-",
        from,
      );
      assert.ok(from > 0 && to > from, "could not isolate the DLQ-ack block");
      return pubsubCode.slice(from, to);
    })();
    assert.ok(
      /add-iam-policy-binding/.test(ackBlock),
      "the DLQ-ack loop no longer grants anything; this check would be vacuous",
    );
    assert.ok(
      !/--quiet 2>\/dev\/null \|\| true/.test(ackBlock),
      "`|| true` on the EDGAR DLQ-ack grant discards the only signal that the " +
        "dead-letter policy is INERT — messages redeliver forever instead of parking",
    );
    assert.match(
      ackBlock,
      /EDGAR_PUSH_FAILURES=\$\(\(EDGAR_PUSH_FAILURES \+ 1\)\)/,
      "a failed DLQ-ack grant must reach the failure counter",
    );
    assert.match(
      ackBlock,
      /if \[ "\$EDGAR_ACK_GRANT_FAILURES" -eq 0 \]; then\n\s*echo -e "\s*\$\{GREEN\}Granted pubsub\.subscriber on EDGAR/,
      "the green 'Granted pubsub.subscriber on EDGAR subscriptions' line must be " +
        "conditional on every grant having succeeded",
    );
  });

  it("tells an EDGAR topic that ALREADY EXISTS from one that could not be created", () => {
    // `create 2>/dev/null && echo Created || echo "already exists"` makes exit
    // status the classifier, and `topics create` exits 1 for BOTH. So a
    // PERMISSION_DENIED printed GREEN and the run ended "Complete!" with seven
    // EDGAR topics that do not exist — and a publish to a missing topic fails,
    // which is how `edgar-detect-minutely` stops.
    const topicBlock = (() => {
      const from = pubsubSrc.indexOf("EDGAR topics exist in EVERY env");
      const to = pubsubSrc.indexOf("Dead letter topic", from);
      assert.ok(
        from > 0 && to > from,
        "could not isolate the EDGAR topic loop",
      );
      return pubsubSrc.slice(from, to);
    })();
    assert.match(
      topicBlock,
      /gcloud pubsub topics create/,
      "the EDGAR topic loop creates nothing; this check would be vacuous",
    );
    assert.match(
      topicBlock,
      /already exists\|ALREADY_EXISTS/,
      "the loop must classify on gcloud's own message, not on the exit status",
    );
    assert.match(
      topicBlock,
      /EDGAR_PUSH_FAILURES=\$\(\(EDGAR_PUSH_FAILURES \+ 1\)\)/,
      "a topic-create failure that is NOT 'already exists' must be counted",
    );
  });

  it("does not swallow a failed subscription update", () => {
    // The update branch used to end `--quiet 2>/dev/null || true` and then echo
    // "Updated endpoint -> …" unconditionally, so a failed update PRINTED
    // success while the OIDC audience stayed stale and every delivery kept
    // 401ing.
    assert.ok(
      /gcloud pubsub subscriptions update/.test(edgarSubSection),
      "the EDGAR loop no longer updates anything; this check would be vacuous",
    );
    assert.ok(
      !/--quiet 2>\/dev\/null \|\| true/.test(edgarSubSection),
      "a `|| true` on the EDGAR subscription update hides the failure it exists " +
        "to report. (The WORKER loop above still has one — that is a separate " +
        "call site and out of scope here, which is why this check is SCOPED.)",
    );
  });

  it("exits 0 for NOT-BUILT and 1 for BROKEN", () => {
    // The final not-yet-built block, isolated by its own first statement — the
    // status write. Anchoring on `then\n  echo` (as this used to) now matches
    // block 4b's identical opening line instead, and slicing from there would
    // swallow both `exit 1`s and hide whichever guard was missing.
    const notReady = pubsubCode.slice(
      pubsubCode.indexOf(
        'if [ "$EDGAR_PUSH_READY" != "1" ]; then\n  edgar_status_write "NOT_BUILT"',
      ),
    );
    assert.ok(notReady.length > 0, "could not find the final not-ready block");

    // BROKEN: something whose precondition held failed -> exit 1.
    //
    // NOT gated on EDGAR_PUSH_READY any more, and that is the fix rather than a
    // loosening: the EDGAR topic-create loop needs no service URL, so its
    // failures are real on a COLD environment too — and under `READY = 1 &&`
    // they were counted and then discarded.
    assert.match(
      pubsubCode,
      /if \[ "\$EDGAR_PUSH_FAILURES" -gt 0 \]; then[\s\S]{0,1200}?\n  exit 1\n/,
      "a counted EDGAR provisioning failure must exit 1",
    );
    assert.ok(
      !/if \[ "\$EDGAR_PUSH_READY" = "1" \] && \[ "\$EDGAR_PUSH_FAILURES" -gt 0 \]/.test(
        pubsubCode,
      ),
      "gating the BROKEN exit on READY=1 discards every counted failure that " +
        "does not need the service URL — the topic creates, on exactly the cold " +
        "environment where they are hardest to notice",
    );

    // NOT BUILT: exit 1 only under EDGAR_PUSH_REQUIRED.
    const exitsInNotReady = [...notReady.matchAll(/^\s*exit 1$/gm)];
    assert.equal(
      exitsInNotReady.length,
      1,
      "the not-yet-built block must contain exactly one `exit 1`, the guarded one",
    );
    assert.match(
      notReady,
      /if \[ "\$EDGAR_PUSH_REQUIRED" = "1" \]; then[\s\S]{0,400}?exit 1/,
      "the only `exit 1` for an absent service must be gated on EDGAR_PUSH_REQUIRED",
    );
  });

  it("classifies the describe on gcloud's WORDS, never on an empty string", () => {
    // THE REGRESSION THIS REPLACES. `... 2>/dev/null) || true` discarded the
    // stderr and the exit code, so EMPTY STRING was the sole classifier and
    // expired auth, the wrong project, a disabled run.googleapis.com, a missing
    // run.services.get, a network blip and genuine absence became ONE state:
    // "not found", exit 0. Before the NOT-BUILT state existed this same input
    // exited 1, so the degrade converted every non-absence cause from a hard
    // failure into a silent success.
    const section2 = (() => {
      const from = pubsubSrc.indexOf("US_FUNDAMENTALS_RC=0");
      const to = pubsubSrc.indexOf("Create topics (idempotent", from);
      assert.ok(from > 0 && to > from, "could not isolate the describe block");
      return pubsubSrc.slice(from, to);
    })();
    assert.ok(
      !/describe us-fundamentals-\$\{ENV\}[\s\S]{0,200}?2>\/dev\/null\) \|\| true/.test(
        pubsubCode,
      ),
      "the us-fundamentals describe must not discard stderr and the exit code",
    );
    assert.match(
      section2,
      /NOT_FOUND\|\[Cc\]annot find service/,
      "only gcloud's own not-found wording may mean NOT-YET-BUILT",
    );
    assert.match(
      section2,
      /EDGAR_DESCRIBE_BROKEN=1/,
      "every other describe failure must set the UNKNOWN state",
    );
    assert.match(
      section2,
      /\[ "\$US_FUNDAMENTALS_RC" -eq 0 \] && \[ -n "\$US_FUNDAMENTALS_URL" \]/,
      "READY needs BOTH a zero exit and a non-empty URL — a service with no " +
        "ready revision exits 0 with no status.url, and treating that as READY " +
        "creates seven subscriptions with an EMPTY audience",
    );
  });

  it("still refuses to invent an audience", () => {
    // Degrading must not mean guessing. A placeholder audience 401s every
    // delivery for the life of the subscription and looks healthy from every
    // angle, which is strictly worse than having no subscription.
    assert.ok(
      !/us-fundamentals-\$\{ENV\}-placeholder/.test(pubsubCode),
      "the placeholder URL must stay gone",
    );
    assert.match(
      pubsubCode,
      /\[ "\$EDGAR_PUSH_READY" = "1" \] \|\| continue/,
      "the EDGAR subscription loop must be a no-op when the URL is unknown",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 #2 — setup-infra completes the ladder in ONE command", () => {
  it("knows a fifth step named edgar-push", () => {
    assert.match(
      infraCode,
      /STEP_NAMES=\("" "db" "pubsub" "scheduler" "deploy" "edgar-push"\)/,
      "step 5 must be selectable by name and number",
    );
  });

  it("re-runs the EDGAR step AFTER the deploy, not before", () => {
    const deployLoop = infraCode.indexOf("gcloud builds submit --config=");
    const step5 = infraCode.indexOf("EDGAR_PUSH_REQUIRED=1");
    assert.ok(deployLoop > 0, "could not find the deploy loop");
    assert.ok(step5 > 0, "step 5 must invoke setup-pubsub.sh again");
    assert.match(
      infraCode.slice(step5, step5 + 250),
      /bash workers\/scripts\/setup-pubsub\.sh "\$ENV"/,
      "EDGAR_PUSH_REQUIRED=1 must be set ON the setup-pubsub re-run",
    );
    assert.ok(
      !/setup-pubsub\.sh "\$ENV" \|\| true/.test(infraCode),
      "`|| true` on either setup-pubsub call makes its failure invisible and " +
        "lets the closing banner print 'Complete!' over it",
    );
    assert.ok(
      step5 > deployLoop,
      "the EDGAR push step must run AFTER the deploy — the deploy is what MINTS " +
        "the URL that is both the push endpoint and the OIDC audience",
    );
  });

  it("demands the service only when something in this run should have built it", () => {
    // The re-run passes EDGAR_PUSH_REQUIRED=1, which turns absence into a hard
    // failure. That is right after a deploy and WRONG on a plain `--from 2
    // --skip-deploy`, where nothing was built — which would re-create the
    // self-blocking ladder one step further down.
    assert.match(
      infraCode,
      /\[ "\$TARGET_NAME" == "us-fundamentals" \] && US_FUNDAMENTALS_DEPLOYED=true/,
      "step 5 must key off the us-fundamentals target actually being built",
    );
    assert.match(
      infraCode,
      /^US_FUNDAMENTALS_DEPLOYED=false$/m,
      "the tracker must be initialised outside step 4, which may be skipped",
    );
    assert.ok(
      !/if should_run "edgar-push" 5; then EDGAR_PUSH_SELECTED=true; fi/.test(
        infraCode,
      ),
      "`should_run` alone selects step 5 for any range containing it, including " +
        "`--from 2 --skip-deploy` on a cold environment",
    );
    for (const trigger of [
      '[ "$ONLY" == "edgar-push" ]',
      '[ "$STEP_FLAG" == "step" ] && [ "$STEP_VALUE" == "5" ]',
      '[ "$STEP_FLAG" == "from" ] && [ "$STEP_VALUE" == "5" ]',
    ]) {
      assert.ok(
        infraCode.includes(trigger),
        `step 5 must also run when targeted directly: ${trigger}`,
      );
    }
  });

  it("counts five steps everywhere it counts steps", () => {
    const outOfFour = [...infraSrc.matchAll(/Step [0-9]\/4:/g)];
    assert.equal(
      outOfFour.length,
      0,
      `${outOfFour.length} banner(s) still say "/4" — an operator counting ` +
        "progress would think the run finished a step early",
    );
    const outOfFive = [...infraSrc.matchAll(/Step [0-9]\/5:/g)];
    assert.ok(
      outOfFive.length >= 10,
      `expected the /5 banners for all five steps, found ${outOfFive.length}`,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 round-2 — BEHAVIOUR: a describe failure is not an absence", () => {
  /**
   * Measured before the fix, on a WARM prod with a stubbed auth failure
   * (`setup-infra.sh prod --skip-deploy`): exit 0, "Infrastructure Setup
   * Complete!", the run.invoker re-grant silently skipped, and seven LIVE
   * subscriptions reported as "NOT CREATED (us-fundamentals-prod has no URL)" —
   * a false statement about production, from a run that reported success.
   */
  for (const mode of [
    "authfail",
    "apidisabled",
    "denied",
    "emptyok",
  ] as const) {
    it(`setup-pubsub EXITS 1 and does not claim absence: ${mode}`, () => {
      const r = runLadder("pubsub", ["prod"], { STUB_USF_DESCRIBE: mode });
      assert.equal(
        r.status,
        1,
        `a describe failure that is not NOT_FOUND must exit 1\n${r.out}`,
      );
      assert.equal(r.edgarStatus, "BROKEN");
      assert.doesNotMatch(
        r.out,
        /Pub\/Sub Setup Complete!/,
        "a run that could not look must not print the success banner",
      );
      assert.doesNotMatch(
        r.out,
        /us-fundamentals-prod not found/,
        "we did not establish that it is absent — saying so is the defect",
      );
      assert.doesNotMatch(
        r.out,
        /NOT CREATED \(us-fundamentals-prod has no URL\)/,
        "these subscriptions may exist and be healthy; this run did not touch them",
      );
      assert.equal(
        edgarSubCreates(r).length,
        0,
        "an UNKNOWN state must not provision anything",
      );
    });
  }

  for (const mode of ["notfound", "notfound_v2"] as const) {
    it(`a GENUINE absence is still the loud, exit-0 ladder state: ${mode}`, () => {
      // The control. Without it, the four cases above would also pass if the
      // classifier had been broken to call EVERYTHING broken — which would
      // restore the original self-blocking bootstrap.
      const r = runLadder("pubsub", ["prod"], { STUB_USF_DESCRIBE: mode });
      assert.equal(r.status, 0, `a cold environment must bootstrap\n${r.out}`);
      assert.equal(r.edgarStatus, "NOT_BUILT");
      assert.match(r.out, /us-fundamentals-prod not found/);
      assert.match(r.out, /INCOMPLETE: the 7 EDGAR push subscriptions/);
      assert.equal(edgarSubCreates(r).length, 0);
    });
  }

  it("EDGAR_PUSH_REQUIRED=1 turns a genuine absence back into a failure", () => {
    const r = runLadder("pubsub", ["prod"], {
      STUB_USF_DESCRIBE: "notfound",
      EDGAR_PUSH_REQUIRED: "1",
    });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /EDGAR_PUSH_REQUIRED=1/);
  });

  it("a warm service provisions all seven, with a REAL audience", () => {
    // The other control, and the one that kills `EDGAR_PUSH_READY=0` -> `=1` on
    // the not-found branch: it proves the creates carry a non-empty audience
    // when they happen, so the cold-run assertion below is about the GATE and
    // not about the loop being broken everywhere.
    const r = runLadder("pubsub", ["prod"], { STUB_USF_DESCRIBE: "warm" });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.edgarStatus, "COMPLETE");
    const creates = edgarSubCreates(r);
    assert.equal(
      creates.length,
      7,
      `expected 7 creates, got ${creates.length}`,
    );
    for (const c of creates) {
      assert.match(
        c,
        /--push-auth-token-audience=https:\/\/us-fundamentals-prod-\S+/,
        `a subscription was created with no real audience: ${c}`,
      );
    }
  });

  it("a COLD run creates nothing at all — no empty audience, no placeholder", () => {
    // MUTATION TARGET: `EDGAR_PUSH_READY=0` -> `=1` on the not-found branch.
    // The text guards above only forbid the literal string
    // `us-fundamentals-${ENV}-placeholder`; an EMPTY audience is worse and they
    // say nothing about it.
    const r = runLadder("pubsub", ["prod"], { STUB_USF_DESCRIBE: "notfound" });
    assert.equal(edgarSubCreates(r).length, 0);
    for (const c of r.calls) {
      assert.doesNotMatch(
        c,
        /--push-auth-token-audience=(\s|$)/,
        `a gcloud call carried an EMPTY OIDC audience: ${c}`,
      );
      assert.doesNotMatch(c, /placeholder/, `a guessed URL was used: ${c}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 round-2 — BEHAVIOUR: no EDGAR failure prints green", () => {
  /**
   * Five EDGAR call classes can fail. Three were counted; two were not, and one
   * of THOSE printed its success line unconditionally. Each case here fails one
   * class and asserts the run stops — the shape a single `|| true` restores.
   */
  const failureCases = [
    {
      what: "all seven DLQ-ack grants",
      stub: { STUB_EDGAR_ACK_GRANT: "fail" },
      mustNotSay: /Granted pubsub\.subscriber on EDGAR subscriptions/,
    },
    {
      what: "the EDGAR topic creates",
      stub: { STUB_EDGAR_TOPIC_CREATE: "fail" },
      mustNotSay: /Topic edgar-detect-prod already exists/,
    },
    {
      what: "the subscription creates",
      stub: { STUB_EDGAR_SUB_CREATE: "fail" },
      mustNotSay: /Pub\/Sub Setup Complete!/,
    },
    {
      what: "the subscription updates",
      stub: {
        STUB_EDGAR_SUB_DESCRIBE: "present",
        STUB_EDGAR_SUB_UPDATE: "fail",
      },
      // Scoped to us-fundamentals: the dead-letter subscription prints its own
      // "Updated endpoint ->" line, and that call site is out of scope here.
      mustNotSay: /Updated endpoint -> https:\/\/us-fundamentals-/,
    },
    {
      what: "the run.invoker grant",
      stub: { STUB_USF_INVOKER: "fail" },
      mustNotSay: /Granted run\.invoker on us-fundamentals-prod/,
    },
  ] as const;

  for (const c of failureCases) {
    it(`exits 1 when ${c.what} fail, and never claims them`, () => {
      const r = runLadder("pubsub", ["prod"], {
        STUB_USF_DESCRIBE: "warm",
        ...c.stub,
      });
      assert.equal(r.status, 1, `expected exit 1\n${r.out}`);
      assert.equal(r.edgarStatus, "BROKEN");
      assert.doesNotMatch(r.out, /Pub\/Sub Setup Complete!/);
      assert.doesNotMatch(
        r.out,
        c.mustNotSay,
        "the run printed the success line for the operation that failed",
      );
    });
  }

  it("a topic-create failure is fatal on a COLD environment too", () => {
    // The topic loop needs no service URL, so `READY = 1 && FAILURES > 0`
    // counted this and then threw it away — on exactly the environment where a
    // missing topic is hardest to notice.
    const r = runLadder("pubsub", ["prod"], {
      STUB_USF_DESCRIBE: "notfound",
      STUB_EDGAR_TOPIC_CREATE: "fail",
    });
    assert.equal(r.status, 1, `expected exit 1\n${r.out}`);
    assert.equal(r.edgarStatus, "BROKEN");
  });

  it("'already exists' is still GREEN, and still exit 0", () => {
    // The ceiling for the case above: without it, "a topic create fails -> exit
    // 1" would also pass if EVERY create were treated as a failure, which is
    // every re-run of an idempotent script.
    const r = runLadder("pubsub", ["prod"], {
      STUB_USF_DESCRIBE: "warm",
      STUB_EDGAR_TOPIC_CREATE: "exists",
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Topic edgar-detect-prod already exists/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 round-2 — BEHAVIOUR: setup-infra's ladder and its banner", () => {
  it("--step 2 on a cold env does NOT print 'Complete!'", () => {
    // MUTATION TARGET: the closing banner was unconditional. One screen apart,
    // a cold run printed "Pub/Sub Setup INCOMPLETE", then a GREEN "Pub/Sub
    // complete", then "Infrastructure Setup Complete!" — with `[ ] 5.` as the
    // only honest line in the run.
    const r = runLadder("infra", ["prod", "--step", "2"], {
      STUB_USF_DESCRIBE: "notfound",
    });
    assert.equal(r.status, 0, `a cold bootstrap must still exit 0\n${r.out}`);
    assert.doesNotMatch(r.out, /Infrastructure Setup Complete!/);
    assert.match(r.out, /Infrastructure Setup INCOMPLETE/);
    assert.doesNotMatch(
      r.out,
      /Pub\/Sub complete/,
      "the green step-2 line must not claim a step that did not finish",
    );
    assert.match(r.out, /\[ \] 5\. EDGAR push subscriptions/);
  });

  it("--from 2 --skip-deploy on a cold env: exit 0, banner INCOMPLETE, step 5 not run", () => {
    // MUTATION TARGET: `elif should_run "edgar-push" 5; then
    // EDGAR_PUSH_TARGETED=true`. `5 >= 2` is true, so step 5 would run with
    // EDGAR_PUSH_REQUIRED=1 against a service nothing built — exit 1, no
    // banner, the self-blocking ladder restored one step further down.
    const r = runLadder("infra", ["prod", "--from", "2", "--skip-deploy"], {
      STUB_USF_DESCRIBE: "notfound",
    });
    assert.equal(
      r.status,
      0,
      `a range that merely CONTAINS step 5 must not demand a service nobody ` +
        `deployed\n${r.out}`,
    );
    assert.match(r.out, /Infrastructure Setup INCOMPLETE/);
    assert.doesNotMatch(r.out, /Infrastructure Setup Complete!/);
    assert.doesNotMatch(
      r.out,
      /Step 5\/5: EDGAR push subscriptions \(post-deploy\)/,
      "step 5 must not run when nothing in this invocation built the service",
    );
    assert.equal(
      r.calls.filter((c) =>
        c.startsWith("run services describe us-fundamentals-"),
      ).length,
      1,
      "setup-pubsub must have run exactly ONCE — a second describe means step 5 ran",
    );
  });

  it("--from 4 --skip-deploy does not select step 5 either", () => {
    // Same mutation, reached without running the scheduler: `should_run
    // "edgar-push" 5` is true for `--from 4` as well.
    const r = runLadder(
      "infra",
      ["prod", "--from", "4", "--skip-deploy"],
      { STUB_USF_DESCRIBE: "notfound" },
      // Steps 1-3 are out of range and step 4 is skipped, so a CORRECT run
      // issues no gcloud call at all. The mutation makes it issue several.
      { expectCalls: false },
    );
    assert.equal(r.status, 0, r.out);
    assert.equal(
      r.calls.filter((c) =>
        c.startsWith("run services describe us-fundamentals-"),
      ).length,
      0,
      "nothing in `--from 4 --skip-deploy` should ask about us-fundamentals",
    );
    assert.match(r.out, /Infrastructure Setup Complete!/);
  });

  it("a FAILING step 5 fails the whole run — no `|| true`", () => {
    // MUTATION TARGET: `EDGAR_PUSH_REQUIRED=1 bash … || true`. That is invisible
    // to every text assertion in this file and makes "Complete!" print over the
    // one state step 5 exists to detect.
    const r = runLadder("infra", ["prod", "--only", "edgar-push"], {
      STUB_USF_DESCRIBE: "warm",
      STUB_EDGAR_SUB_CREATE: "fail",
    });
    assert.notEqual(r.status, 0, `expected a non-zero exit\n${r.out}`);
    assert.doesNotMatch(r.out, /Infrastructure Setup Complete!/);
  });

  it("--only edgar-push against a service that is NOT up fails loudly", () => {
    const r = runLadder("infra", ["prod", "--only", "edgar-push"], {
      STUB_USF_DESCRIBE: "notfound",
    });
    assert.notEqual(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Infrastructure Setup Complete!/);
  });

  it("the full cold ladder works: step 2 defers, the deploy mints, step 5 attaches", () => {
    // The whole reason step 5 exists, end to end. The stub answers NOT_FOUND
    // until it sees `builds submit …us-fundamentals…`, then answers with a URL
    // — which is what a real cold environment does.
    const r = runLadder("infra", ["prod", "--from", "2"], {
      STUB_USF_DESCRIBE: "coldthenwarm",
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Infrastructure Setup Complete!/);
    assert.match(r.out, /\[x\] 5\. EDGAR push subscriptions/);
    assert.equal(
      edgarSubCreates(r).length,
      7,
      "step 5 must create all seven once the deploy has minted the URL",
    );
    for (const c of edgarSubCreates(r)) {
      assert.match(
        c,
        /--push-auth-token-audience=https:\/\/us-fundamentals-prod-\S+/,
      );
    }
    // …and step 2's own INCOMPLETE verdict must not survive as the banner.
    assert.doesNotMatch(r.out, /Infrastructure Setup INCOMPLETE/);
  });

  it("a describe failure composed through setup-infra stops the ladder", () => {
    const r = runLadder("infra", ["prod", "--from", "2", "--skip-deploy"], {
      STUB_USF_DESCRIBE: "authfail",
    });
    assert.notEqual(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Infrastructure Setup Complete!/);
    assert.doesNotMatch(r.out, /Infrastructure Setup INCOMPLETE/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 round-2 — an out-of-range step is a typo, not a run", () => {
  /**
   * `--only` has been validated since MONEY-979 precisely because "a typo that
   * reads as a successful run" is this repo's most expensive bug shape.
   * `--step` and `--from` were not, and the range only got wider when step 5
   * was added: `--step 6` issued ZERO gcloud calls, printed every checklist row
   * `[ ]`, exited 0 and said "Infrastructure Setup Complete!".
   */
  for (const args of [
    ["prod", "--step", "6"],
    ["prod", "--step", "0"],
    ["prod", "--from", "6"],
    ["prod", "--from", "0"],
    ["prod", "--step", "abc"],
  ]) {
    it(`rejects ${args.slice(1).join(" ")}`, () => {
      const r = runLadder("infra", args, {}, { expectCalls: false });
      assert.equal(r.status, 1, `expected exit 1\n${r.out}`);
      assert.doesNotMatch(r.out, /Infrastructure Setup Complete!/);
      assert.match(r.out, /must be 1-5/);
      assert.equal(
        r.calls.length,
        0,
        "a rejected run must issue no gcloud call",
      );
    });
  }

  for (const args of [
    ["prod", "--step", "2"],
    ["prod", "--from", "5"],
  ]) {
    it(`still accepts ${args.slice(1).join(" ")}`, () => {
      // The ceiling: without it, "6 is rejected" would also pass if the
      // validator rejected everything.
      const r = runLadder("infra", args, { STUB_USF_DESCRIBE: "warm" });
      assert.equal(r.status, 0, r.out);
      assert.doesNotMatch(r.out, /must be 1-5/);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 #2 — the runbook cannot strand the operator", () => {
  it("does not run setup-pubsub before the service is built", () => {
    // The old ladder ran `workers/scripts/setup-pubsub.sh qa` at step 2, before
    // the merge that builds the service at step 5, and never went back — so
    // seven push subscriptions were created ZERO times and the doc asserted the
    // order was fine.
    const bareCall =
      /^\s*workers\/scripts\/setup-pubsub\.sh (qa|prod)\s*(#|$)/m;
    assert.ok(
      !bareCall.test(firstDeploySection),
      "the First deploy ladder must not call setup-pubsub.sh on its own before " +
        "the deploy — it creates none of the EDGAR subscriptions there",
    );
  });

  it("no longer claims order matters in only two places", () => {
    assert.ok(
      !/Order matters in two places and nowhere else/.test(runbookSrc),
      "the deploy -> EDGAR-subscription ordering is a THIRD place, and omitting " +
        "it is what left seven topics without a subscriber",
    );
  });

  it("names the silent failure mode, so the step is not read as optional", () => {
    for (const [label, src] of [
      ["runbook", runbookSrc],
      ["service README", readmeSrc],
    ] as const) {
      assert.match(
        collapse(src),
        /topic with no subscription drops messages silently/i,
        `${label} must say what happens when the subscriptions are missing: ` +
          "nothing does. No DLQ, no error, no metric.",
      );
    }
  });

  it("the README no longer promises a placeholder URL that was removed", () => {
    assert.ok(
      !/writes a placeholder if the service is not up yet/.test(
        collapse(readmeSrc),
      ),
      "the placeholder audience was deleted in T15; a doc that still promises " +
        "it tells the operator the first run succeeded",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 #3 — the Python service mounts no service-account key", () => {
  /**
   * `services/us-fundamentals` authenticates as its RUNTIME service account via
   * ADC. A mounted key is dead weight AND a live hazard: it is a long-lived,
   * prod-capable credential on the QA service that `redact()` cannot mask (no
   * entry in REDACTED_KEYS matches the name), and the comment that shipped
   * beside it pointed the bucket IAM grant at the wrong principal.
   */
  for (const [env, code] of [
    ["qa", qaCode],
    ["prod", prodCode],
  ] as const) {
    it(`cloudbuild.${env}.yaml mounts no GCP_SERVICE_ACCOUNT_KEY_BASE64`, () => {
      assert.ok(
        !code.includes("GCP_SERVICE_ACCOUNT_KEY_BASE64"),
        `cloudbuild.${env}.yaml still mounts a service-account key. This service ` +
          "reads it nowhere — app/sec/archive.py builds a plain storage.Client().",
      );
    });
  }

  it("the five Cloud Run jobs mount no service-account key either", () => {
    const setSecrets = [...jobsCode.matchAll(/--set-secrets="([^"]*)"/g)].map(
      (m) => m[1]!,
    );
    assert.ok(
      setSecrets.length > 0,
      "could not find the jobs script's --set-secrets (the check would be vacuous)",
    );
    for (const s of setSecrets) {
      assert.ok(
        !s.includes("GCP_SERVICE_ACCOUNT_KEY_BASE64"),
        `setup-us-fundamentals-jobs.sh still mounts the key: ${s}`,
      );
    }
  });

  it("no spec repeats the OUTRANKS rule, which belongs to the TS helper", () => {
    // True of packages/core/src/gemini/credentials.ts, false of this Python
    // service. An operator following it grants the bucket to the wrong
    // principal and archive.write_bytes 403s AFTER the SEC GET is spent.
    for (const [name, src] of [
      ["cloudbuild.qa.yaml", qaSrc],
      ["cloudbuild.prod.yaml", prodSrc],
      ["setup-us-fundamentals-jobs.sh", jobsSrc],
    ] as const) {
      assert.ok(
        !/OUTRANKS (the runtime service account|--service-account)[^\n]*\n(?![^\n]*used to)/.test(
          src,
        ) || /used to sit here|used to say/.test(src),
        `${name} still asserts the mounted key outranks the runtime SA as if it were true`,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 #4 — a re-pin warning means DRIFT, not 'absent by design'", () => {
  it("both specs DESCRIBE a job before they try to update it", () => {
    for (const [env, step] of [
      ["qa", repinQa],
      ["prod", repinProd],
    ] as const) {
      const describeAt = step.indexOf("run jobs describe");
      const updateAt = step.indexOf("run jobs update");
      assert.ok(
        describeAt > 0,
        `cloudbuild.${env}.yaml must probe existence before updating; ` +
          "`jobs update` fails identically for 'absent' and 'broken'",
      );
      assert.ok(
        describeAt < updateAt,
        `cloudbuild.${env}.yaml describes after it updates, which decides nothing`,
      );
    }
  });

  it("QA reports an absent job WITHOUT a warning", () => {
    // Isolate the ABSENT ARM, not "everything between `describe` and
    // `continue`". The QA spec now classifies a describe FAILURE the way
    // setup-pubsub does — genuine NOT_FOUND is `absent`, anything else is a
    // real WARNING — and in that shape the `continue` sits after the whole
    // `esac`, so the old span swallowed the warning branch and this assertion
    // went red on a fix. Anchoring on the ABSENT accumulator and stopping at
    // the first `;;` or `continue` grades the same claim under both shapes.
    const absentBranch = (() => {
      const at = repinQa.indexOf('ABSENT="$${ABSENT} $${JOB}"');
      assert.ok(at > 0, "qa: could not find the absent accumulator");
      const rest = repinQa.slice(at);
      const ends = [rest.indexOf(";;"), rest.indexOf("continue")].filter(
        (i) => i >= 0,
      );
      assert.ok(ends.length > 0, "qa: the absent arm has no terminator");
      return [rest.slice(0, Math.min(...ends))];
    })();
    assert.ok(
      !/WARNING/.test(absentBranch[0]),
      "these five jobs are not provisioned on QA, so a warning fires on EVERY " +
        "QA build and makes a real prod drift warning indistinguishable from " +
        "the baseline. Measured before the fix: 17 WARNING lines per build.",
    );
    assert.match(
      absentBranch[0],
      /absent/,
      "the absent case must still be VISIBLE, just not a warning",
    );
  });

  it("QA still warns when a job EXISTS and the re-pin fails", () => {
    // The drift this step exists to catch: a Cloud Run JOB pins its image at
    // provision time and keeps running last release's code, exiting 0.
    assert.match(
      repinQa,
      /EXISTS but was NOT re-pinned/,
      "qa: the genuine-drift branch must warn",
    );
    assert.match(repinQa, /NOT_PINNED/, "qa: drift must reach the summary");
  });

  it("PROD warns for BOTH absent and drifted", () => {
    assert.match(
      repinProd,
      /DOES NOT EXIST on \$\{_ENV\} and was not re-pinned/,
      "prod: an unprovisioned backfill job is a real gap, not a design choice",
    );
    assert.match(
      repinProd,
      /EXISTS but was NOT re-pinned/,
      "prod: drift must stay a warning",
    );
    assert.match(
      repinProd,
      /setup-us-fundamentals-jobs\.sh \$\{_ENV\}/,
      "prod: the absent case must name the provisioning command",
    );
  });

  it("neither re-pin step touches env or secrets", () => {
    // `gcloud run jobs update --set-env-vars` REPLACES the job's env list, and
    // that block is owned by setup-us-fundamentals-jobs.sh. Two writers over one
    // job's env is "whichever ran last wins, silently", with a whole
    // environment's SEC_EGRESS mode as the loser.
    for (const [env, step] of [
      ["qa", repinQa],
      ["prod", repinProd],
    ] as const) {
      for (const forbidden of [
        "--set-env-vars",
        "--update-env-vars",
        "--set-secrets",
        "DD_VERSION=",
      ]) {
        assert.ok(
          !step.includes(forbidden),
          `cloudbuild.${env}.yaml re-pin step must only touch --image; found ${forbidden}`,
        );
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("MONEY-979 #5/#6 — the QA spec's prose matches the QA spec", () => {
  it("does not tell a reader that QA's secrets carry the _PROD suffix", () => {
    // The CODE was always right. A comment saying `_PROD` invites someone to
    // "fix" the code to match it, which points QA at prod's database, prod's
    // Redis and prod's OpenFIGI quota.
    const block = /── SECRETS ─+\n([\s\S]*?)\n  # ── /.exec(qaSrc);
    assert.ok(block, "could not find the qa SECRETS comment block");
    const prose = collapse(block[1]!);
    assert.ok(
      prose.length > 80,
      `the SECRETS block collapsed to ${prose.length} chars; the extraction moved`,
    );
    assert.ok(
      !/DD_API_KEY all carry the _PROD suffix/.test(prose),
      "cloudbuild.qa.yaml's SECRETS comment still claims the _PROD suffix",
    );
    assert.match(
      prose,
      /all carry the _QA suffix/,
      "the QA spec should say _QA where it describes its own secrets",
    );
  });

  it("every secret the QA spec actually mounts carries _QA", () => {
    // The assertion above is about prose; this one is the ceiling that makes it
    // meaningful. Without it, "the comment says _QA" could sit above a spec
    // that mounts _PROD.
    const refs = [...qaCode.matchAll(/secretKeyRef:\s*\n\s*name: (\S+)/g)].map(
      (m) => m[1]!,
    );
    assert.ok(
      refs.length >= 4,
      `expected at least 4 secret mounts in cloudbuild.qa.yaml, found ${refs.length}`,
    );
    for (const r of refs) {
      assert.ok(
        r.endsWith("_QA"),
        `cloudbuild.qa.yaml mounts ${r}; a QA service reading a _PROD secret is ` +
          "a cross-environment read with no error",
      );
    }
  });

  it("does not claim a prod->QA `edgar/` mirror that does not exist", () => {
    // `sync-prod-to-qa.sh` hard-codes `feeds/` and `stocks/`; `edgar/` is
    // outside both ON PURPOSE (raw filings grow ~330 GB/yr and that mirror
    // rsyncs twice daily). With SEC_EGRESS=off an archive miss RAISES, so the
    // old comment described five QA jobs that cannot function.
    assert.ok(
      !/mirrored by the same prod->QA `feeds\/`-style job/.test(qaSrc),
      "cloudbuild.qa.yaml still claims an edgar/ mirror",
    );
    assert.match(
      qaSrc,
      /edgar-qa-synthetic-filing\.sh/,
      "the QA spec should name QA's ACTUAL byte path instead",
    );
  });

  it("the sync script really does exclude edgar/ — the ceiling for the claim above", () => {
    const syncSrc = read(join(ROOT, "scripts/ops/sync-prod-to-qa.sh"));
    const tiers = [...syncSrc.matchAll(/GCS_SRC="gs:\/\/[^/]+\/([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    assert.ok(
      tiers.length >= 2,
      `expected the sync script's GCS tiers, found ${tiers.length}`,
    );
    assert.ok(
      !tiers.some((t) => t.startsWith("edgar/")),
      `sync-prod-to-qa.sh now mirrors edgar/ (${tiers.join(", ")}) — the specs ` +
        "and the runbook say it does not, and one of them must change",
    );
  });
});
