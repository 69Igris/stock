/**
 * The cutover runner's ORDER and its gates — MONEY-1229.
 *
 * ## What is worth testing here, and what is not
 *
 * `setup-datadog.sh` reimplements nothing. Every stage is one line calling a
 * script that has its own suite, its own dry run and its own fail-closed
 * behaviour, so re-asserting what those scripts do would be a second copy of
 * their tests that drifts.
 *
 * The two things this file adds are the two things a runbook states and a tired
 * operator skips:
 *
 *   1. THE INGEST GATE. Monitors are created only after the estate is PROVEN to
 *      be emitting. Applying a set to an org receiving nothing puts every
 *      monitor into NO DATA on day one, and NO DATA is indistinguishable from
 *      health — so the set is muted in week one and never looked at again. That
 *      is MONEY-1238, the defect this whole epic exists to close, and shipping a
 *      runner that reintroduces it would be a particularly bleak way to finish.
 *   2. THE STAGE ORDER. The SLOs resolve monitor ids BY NAME, so the monitors
 *      must exist first. An SLO that resolves nothing is refused by
 *      `apply-slos.sh` — correctly — which turns a mis-ordered runner into a
 *      failed run rather than a wrong one, but a failed run at 2am is still a
 *      thing worth not shipping.
 *
 * ## The source-order half is not enough, and that is why the runs are here
 *
 * "ingest precedes apply in the SOURCE" is true of a runner that skips the gate
 * entirely on `--from=apply`, because a stage BODY is skipped by definition when
 * you resume past it. So the gate, the qa reversal and the offline dry run are
 * EXECUTED, against stub `curl` and `gcloud` binaries first on PATH.
 *
 * ## Every case in this file is hermetic
 *
 * No network, no cloud. A case here used to spawn the real `--dry-run`, which
 * made four `gcloud secrets describe` calls against the production project
 * (~14.5s per `yarn test`) and — worse — chose WHICH BRANCH of its assertion to
 * run based on what Secret Manager currently held. An assertion whose meaning
 * changes when someone stores a secret is not a test of the code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(ROOT, "scripts/ops/datadog");
const SCRIPT = join(DIR, "setup-datadog.sh");
const SRC = readFileSync(SCRIPT, "utf8");

/** The `stage <name>` calls, in the order the file makes them. */
const STAGE_CALLS = [...SRC.matchAll(/^if stage (\w+) /gm)].map((m) => m[1]!);

/** The declared list, which drives `--from=` validation. */
const DECLARED = (/^STAGES=\(([^)]*)\)/m.exec(SRC)?.[1] ?? "")
  .split(/\s+/)
  .filter(Boolean);

/**
 * Run the runner with stub `curl` and `gcloud` first on PATH.
 *
 * `curl` ALWAYS exits 99 and never answers: a dry run must reach no network at
 * all, and a stub that answered would let a real call slip through looking
 * healthy. `gcloud` is parameterised because its exit code is what decides
 * whether `secrets describe` reports the four secrets as PRESENT — which is the
 * difference between traversing every stage and stopping dead at preflight.
 *
 * `cat > /dev/null` is not decoration: `curl -K -` is fed its headers through a
 * pipe, and a stub that exits without draining it hands the writer an EPIPE,
 * which under `pipefail` looks like a transport failure rather than the status
 * the stub meant to return.
 *
 * MEMOISED on the arguments, because a dry run is deterministic and a `--from=
 * apply` pass is ~18 SECONDS: every apply script renders every row through its
 * own `node -e`. Two cases below want the identical resume run and would
 * otherwise each buy one. The key preserves `undefined` — `JSON.stringify`
 * drops it, which would make "delete DD_QA_MONITORING" and "leave the ambient
 * value alone" the same cache entry and quietly answer one case with the
 * other's run.
 */
type SetupRun = { status: number | null; out: string; calls: string };
const RUNS = new Map<string, SetupRun>();

function runSetup(
  args: string[],
  opts: { gcloudExit: number; env?: Record<string, string | undefined> } = {
    gcloudExit: 0,
  },
): SetupRun {
  const key = JSON.stringify([args, opts], (_k, v) =>
    // `\u0000`, written as the ESCAPE and never as the literal byte. A raw NUL
    // in a .ts file makes it BINARY to git, so `git diff` reports zero changes
    // and a reviewer, human or agent, is shown nothing at all for this file.
    // `market-fields-reader.test.ts` forbids it repo-wide for exactly that.
    v === undefined ? "\u0000undefined" : v,
  );
  const hit = RUNS.get(key);
  if (hit) return hit;
  const dir = mkdtempSync(join(tmpdir(), "setup-stub-"));
  try {
    const log = join(dir, "calls.log");
    for (const [bin, code] of [
      ["curl", 99],
      ["gcloud", opts.gcloudExit],
    ] as const) {
      writeFileSync(
        join(dir, bin),
        [
          "#!/bin/sh",
          `printf "${bin} %s\\n" "$*" >> "$STUB_LOG"`,
          "cat > /dev/null 2>/dev/null || true",
          `exit ${code}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    }
    writeFileSync(log, "");
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_LOG: log,
    };
    // A key set to undefined is REMOVED, not stringified to "undefined" — the
    // qa case below needs a genuinely absent DD_QA_MONITORING.
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const res = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: env as NodeJS.ProcessEnv,
    });
    const run: SetupRun = {
      status: res.status,
      out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
      calls: readFileSync(log, "utf8"),
    };
    RUNS.set(key, run);
    return run;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MONEY-1229 — the cutover runner's order and gates", () => {
  it("PREMISE: the stage list parsed", () => {
    assert.ok(
      STAGE_CALLS.length >= 6,
      `parsed ${STAGE_CALLS.length} stage calls`,
    );
    assert.ok(
      DECLARED.length >= 6,
      `parsed ${DECLARED.length} declared stages`,
    );
  });

  it("the declared stages and the stages it actually runs are the SAME list", () => {
    // A stage declared but never run is a `--from=` target that silently skips
    // everything; a stage run but not declared cannot be resumed from.
    assert.deepEqual(
      STAGE_CALLS,
      DECLARED,
      "the STAGES array and the `stage` calls disagree",
    );
  });

  it("INGEST IS PROVEN BEFORE ANY MONITOR IS CREATED", () => {
    // The whole reason this runner exists rather than a numbered list in a doc.
    //
    // This is the ORDER half only. It is true of a runner that skips the gate
    // completely on `--from=apply`, so the resume case below is the one that
    // carries the guarantee.
    const ingest = STAGE_CALLS.indexOf("ingest");
    const apply = STAGE_CALLS.indexOf("apply");
    assert.notEqual(ingest, -1, "there is no ingest stage");
    assert.notEqual(apply, -1, "there is no apply stage");
    assert.ok(
      ingest < apply,
      `apply (${apply}) runs before ingest (${ingest}) — every monitor would ` +
        "be created into an org that may be receiving nothing",
    );
  });

  it("A RESUME cannot reach apply without proving ingest IN THAT RUN", () => {
    // `--from=apply` and `--from=verify` are validated, documented resume
    // targets, and a stage BODY is skipped by definition when you resume past
    // it — so the gate this file's own header calls "the one that matters" was
    // reachable only on the run that did not need resuming.
    //
    // Not hypothetical: the first real cutover produced exactly the state that
    // demands a resume, and `--from=apply` is what you type once rum/roll/vercel
    // are done. If the roll silently failed, or the stored key is the wrong
    // org's, every monitor lands in NO DATA on day one — MONEY-1238, brought
    // back by the runner built to prevent it.
    // The same run the qa case's OFF half wants, spelled identically so the
    // memo serves both: neither case should depend on the ambient
    // DD_QA_MONITORING either way.
    const res = runSetup(["--dry-run", "--from=apply"], {
      gcloudExit: 0,
      env: { DD_QA_MONITORING: undefined },
    });
    assert.equal(res.status, 0, `the resume did not complete:\n${res.out}`);
    assert.match(
      res.out,
      /\(skipping ingest\)/,
      "PREMISE: the ingest STAGE should have been skipped by this resume",
    );
    const applyAt = res.out.indexOf("═══ apply");
    const gateAt = res.out.indexOf("would query sum:stockbook.job.selected");
    assert.ok(applyAt !== -1, `apply did not run:\n${res.out}`);
    assert.ok(
      gateAt > applyAt,
      "apply ran without the ingest gate — a resume would create every " +
        `monitor into an org that may be receiving nothing:\n${res.out}`,
    );
  });

  it("EVERY request goes through dd_request — no bare curl survives", () => {
    // A bare `curl` inside a command substitution under `set -euo pipefail`
    // does not fail loudly. Verified on this machine: `code="$(curl …
    // https://unreachable)"` exits 6 and the NEXT LINE NEVER RUNS — no
    // message, no stage name, nothing. This file ran three of them, and the
    // worst sat in the ingest gate, immediately AFTER `roll` has restarted six
    // production services: a DNS blip halts the cutover mid-way with the last
    // visible output being `rolling: tiingo-realtime-qa`. The friendly "STOP.
    // The metric query did not answer" handler can only print for a server that
    // actually answered.
    const src = SRC.split("\n")
      .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
      .join("\n");
    const bare = [...src.matchAll(/(?:^|[|;&(]\s*)curl\b/gm)].map((m) =>
      m[0].trim(),
    );
    assert.deepEqual(
      bare,
      [],
      `${bare.length} bare curl invocation(s) left. Use dd_request, which ` +
        "captures curl's rc, spells 'no HTTP response' as 000 and refuses a " +
        "non-2xx.",
    );
    // The positive control: without it, a runner that makes no requests at all
    // would satisfy the assertion above.
    assert.match(SRC, /dd_request GET/, "it issues no requests at all");
  });

  it("the verify counter FAILS CLOSED, and the stage acts on what it counts", () => {
    // Extracted from the source and run for real, because this is arithmetic
    // over a response body and the defect is invisible in a dry run.
    //
    // It read `Array.isArray(d) ? d : (d?.data ?? [])` over a body fetched by a
    // raw curl with no status check — and an error body is a perfectly valid
    // JSON object with no `data`, so it fell open to `[]` and printed 0. A
    // narrow app key or one 429 made the closing report of a SUCCESSFUL cutover
    // read "monitors now in the org: 0" immediately after creating 47.
    const snippet =
      /c="\$\(BODY="\$RESPONSE_BODY" node -e '([\s\S]*?)'\)"/.exec(SRC)?.[1];
    assert.ok(snippet, "could not locate the verify counter");
    const count = (body: string): string =>
      spawnSync("node", ["-e", snippet], {
        encoding: "utf8",
        env: { ...process.env, BODY: body },
      }).stdout.trim();

    assert.notEqual(
      count('{"errors":["Forbidden"]}'),
      "0",
      "an error body counted as an empty list — a refused read reads as a " +
        "clean org, which is MONEY-1238's shape one surface over",
    );
    assert.equal(count('{"errors":["Forbidden"]}'), "-1");
    assert.equal(count("not json at all"), "-1");
    // The positive controls, in both shapes Datadog actually returns: v1
    // /monitor answers a bare array, v1 /slo answers `{data:[…]}`.
    assert.equal(count('[{"id":1},{"id":2}]'), "2");
    assert.equal(count('{"data":[{"id":1}]}'), "1");

    // And the stage must ACT on it. It asserted nothing: any count, 0 included,
    // exited 0 — so "47 monitors" and "the apply created nothing" closed the
    // run identically.
    const verify = /^if stage verify [\s\S]*?^fi$/m.exec(SRC)?.[0];
    assert.ok(verify, "could not locate the verify stage body");
    assert.match(verify, /VERIFY FAILED/, "a zero is reported as success");
    assert.match(
      verify,
      /HAD_FAILURES=true/,
      "verify names a failure and then exits 0 anyway",
    );
  });

  it("a zero-series ingest result is a HARD STOP, not a warning", () => {
    // Reading the gate's body: it must exit, and it must say why in terms an
    // operator can act on. A gate that prints a warning and continues is not a
    // gate.
    const gate = /series returned[\s\S]*?fi\n\s*fi/.exec(SRC)?.[0] ?? "";
    assert.ok(gate.length > 0, "could not locate the ingest gate body");
    assert.match(gate, /-eq 0 \]\]; then/, "no zero-series branch");
    assert.match(gate, /exit 1/, "the zero-series branch does not exit");
    assert.match(
      gate,
      /MONEY-1238/,
      "the stop does not name the defect it is preventing, so the next reader " +
        "will delete it as over-cautious",
    );
  });

  it("the services are rolled BEFORE ingest is measured", () => {
    // A Cloud Run service reads its secret at instance start, so measuring
    // ingest before rolling measures the OLD key and reports a false zero.
    const roll = STAGE_CALLS.indexOf("roll");
    assert.ok(
      roll !== -1 && roll < STAGE_CALLS.indexOf("ingest"),
      "ingest is measured before the services pick up the new key",
    );
  });

  it("the monitors are applied BEFORE the SLOs that resolve them by name", () => {
    // The locator was `/═══ apply…/`, which never matched: the heading is
    // printed by `stage()` from `"═══ ${1} — ${2}"`, so the literal string is
    // not in the source at all. `?? SRC` then fell back to the WHOLE FILE and
    // the assertion below compared two positions anywhere in it. Anchor on the
    // stage call, which is real text.
    const apply = /^if stage apply [\s\S]*?^fi$/m.exec(SRC)?.[0];
    assert.ok(apply, "could not locate the apply stage body");
    const monitors = apply.indexOf("apply-monitors.sh");
    const slos = apply.indexOf("apply-slos.sh");
    assert.ok(
      monitors !== -1 && slos !== -1,
      "a stage-5 script call is missing",
    );
    assert.ok(
      monitors < slos,
      "the SLOs would resolve zero monitors and be refused",
    );
  });

  it("every script it calls actually exists", () => {
    // A runner that calls a renamed script fails at 2am, part way through.
    const called = [...SRC.matchAll(/\$HERE\/([a-z0-9-]+\.sh)/g)].map(
      (m) => m[1]!,
    );
    assert.ok(
      called.length >= 5,
      `only ${called.length} sibling scripts called`,
    );
    for (const name of new Set(called)) {
      assert.ok(
        existsSync(join(DIR, name)),
        `calls ${name}, which does not exist`,
      );
    }
  });

  it("--dry-run TRAVERSES EVERY STAGE and reaches no network", () => {
    // THE STAGE TRAVERSAL IS THE POINT, and it is what this case did not have.
    //
    // It stubbed `gcloud` to `exit 99`. `setup-datadog.sh` runs `secrets
    // describe` for all four secrets BEFORE any stage, so with the stub failing
    // they all read as MISSING and the run exits 1 at preflight — and NONE of
    // the five stages the assertions are about ever ran. `doesNotMatch(/^curl
    // /m)`, `doesNotMatch(/versions access/)` and `doesNotMatch(/run services
    // update/)` were all satisfied by a script that stopped before it could do
    // any of them. Adding a live `curl` to the rum, ingest, apply or verify
    // dry-run branch would not have turned this red.
    //
    // The proof is one line: `assert.equal(res.status, 0)`, which fails against
    // the old stub.
    const res = runSetup(["--dry-run"], { gcloudExit: 0 });
    assert.equal(res.status, 0, `the dry run did not complete:\n${res.out}`);
    for (const s of DECLARED) {
      assert.match(
        res.out,
        new RegExp(`═══ ${s} `),
        `stage "${s}" did not run, so nothing below can speak for it:\n${res.out}`,
      );
    }
    assert.match(res.out, /dry run complete/);

    assert.doesNotMatch(
      res.calls,
      /^curl /m,
      `the dry run called curl:\n${res.calls}`,
    );
    // gcloud IS called in preflight, but only `secrets describe`, which reads
    // no value. Anything that mutates or reads a secret VALUE is a failure.
    assert.doesNotMatch(
      res.calls,
      /versions access/,
      "the dry run read a secret value",
    );
    assert.doesNotMatch(
      res.calls,
      /run services update/,
      "the dry run rolled a service",
    );
    assert.match(res.out, /would roll: /, "PREMISE: the roll stage ran at all");
  });

  it("refuses an unknown stage rather than starting from the beginning", () => {
    // `--from=aply` silently running every stage from preflight, including the
    // live applies, is the worst available failure for a typo.
    for (const arg of ["--from=nope", "--from=", "--dryrun", "prod"]) {
      const res = spawnSync("bash", [SCRIPT, arg], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.equal(res.status, 2, `"${arg}" was not refused`);
    }
  });

  it("names the UI step for the one credential no API can mint", () => {
    // Verified against Datadog's OpenAPI: POST /api/v2/application_keys does not
    // exist, and every endpoint that does create one needs an application key
    // already. A runner that just says "missing secret" sends the operator
    // looking for a script that cannot exist.
    assert.match(SRC, /organization-settings\/application-keys/);
    assert.match(SRC, /set-dd-secret\.sh/);
    assert.match(
      SRC,
      /One-Time Read|OTR/i,
      "does not warn that the value may be unreadable after the tab closes",
    );
  });

  it("says plainly that it never touches Vercel", () => {
    assert.match(SRC, /Nothing in this repo touches Vercel/);
    // An INVOCATION, not the word. The first version of this matched "Vercel
    // variables" and "Vercel has none" in the very prose that says it does not
    // touch Vercel — a check that fires on the promise instead of the breach.
    // A command is at the start of a line, or after a pipe, `;`, `&&`, `$(`,
    // or `npx`.
    const calls = [...SRC.matchAll(/(?:^|[|;&(]\s*|\bnpx\s+)vercel\b/gim)].map(
      (m) => m[0].trim(),
    );
    assert.deepEqual(
      calls,
      [],
      `it appears to invoke the Vercel CLI: ${calls.join(", ")}`,
    );
  });

  it("a MISSING secret stops the run at preflight and names the UI step", () => {
    // HERMETIC, and it did not used to be. This spawned the real `--dry-run`,
    // whose four `gcloud secrets describe` calls hit the production project on
    // every `yarn test` (~14.5s) — and then branched on what Secret Manager
    // happened to contain, so storing a key silently changed which assertion
    // ran. A test whose meaning is chosen by production state is not a test of
    // the code. A `gcloud` that fails `secrets describe` reproduces "the secret
    // is missing" exactly, and reproduces it the same way every time.
    const res = runSetup(["--dry-run"], { gcloudExit: 1 });
    assert.notEqual(
      res.status,
      0,
      "it reported a missing secret and continued",
    );
    assert.match(res.out, /MISSING: DD_APP_KEY_PROD/);
    assert.match(res.out, /STOP\./);
    assert.match(
      res.out,
      /set-dd-secret\.sh DD_APP_KEY_PROD/,
      "it does not say how to store the secret it is refusing over",
    );
    assert.doesNotMatch(
      res.out,
      /═══ rum/,
      "it continued past preflight with a secret missing",
    );
    assert.doesNotMatch(res.calls, /^curl /m, "it authenticated anyway");
  });

  it("DD_QA_MONITORING=on really is the reversal it is documented to be", () => {
    // `lib-datadog.sh` says "Reversal is this one variable." It was not: all
    // four env-taking children were invoked with a hardcoded `prod`, so setting
    // the variable and re-running produced zero qa monitors and no message
    // saying why — the operator concludes the feature is broken rather than off.
    const off = runSetup(["--dry-run", "--from=apply"], {
      gcloudExit: 0,
      env: { DD_QA_MONITORING: undefined },
    });
    assert.equal(off.status, 0, off.out);
    assert.match(
      off.out,
      /qa monitoring is OFF/,
      "it applied no qa rows and did not say why",
    );
    assert.doesNotMatch(
      off.out,
      /\[qa\]/,
      "qa rows were applied with the switch off",
    );

    const on = runSetup(["--dry-run", "--from=apply"], {
      gcloudExit: 0,
      env: { DD_QA_MONITORING: "on" },
    });
    assert.equal(on.status, 0, on.out);
    assert.match(
      on.out,
      /\[qa\]/,
      "the documented reversal produced no qa monitors",
    );

    // And the closing instructions have to be HONEST about it. The negative
    // test is the only end-to-end proof that monitor -> trigger -> notify ->
    // email works, and the recipe fires at a QA monitor: with qa off it
    // produces nothing, and "qa has no monitors" is indistinguishable from "the
    // notification channel is dead" — the same unreadable silence as MONEY-1238.
    assert.match(
      off.out,
      /YOU CANNOT RUN IT AS WRITTEN/,
      "it told the operator to run a qa negative test that cannot fire",
    );
    assert.match(on.out, /datadog-monitoring-appendix\.md A13/);
    assert.doesNotMatch(on.out, /YOU CANNOT RUN IT AS WRITTEN/);
  });
});
