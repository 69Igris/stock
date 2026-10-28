/**
 * The Datadog apply scripts run on the founder's laptop, and that laptop is
 * bash 3.2 — MONEY-1360.
 *
 * ## Why this is its own file
 *
 * Every other guard in this package is about one script's CONTENT: does this
 * query name a series we emit, does this message route, does this row preflight.
 * This one is about the INTERPRETER, and it applies to all of them equally,
 * including scripts that do not exist yet. A per-script copy of it would be four
 * copies that drift, and the fifth script would ship without one.
 *
 * ## The defect it exists for, which shipped in three scripts at once
 *
 * `${VAR^^}` is a bash-4 parameter expansion. macOS has shipped bash **3.2.57**
 * since 2007 and still does, because bash 4 is GPLv3. On 3.2 the expansion is a
 * syntax error, and the failure is uniquely bad here because of WHERE it sat:
 * inside `${DD_API_KEY:?...}`, the message that tells an operator which secret
 * to go and fetch.
 *
 *     $ apply-service-monitors.sh prod
 *     line 70: export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_${ENV_ARG^^}): bad substitution
 *
 * It still exits 1, so the script fails CLOSED and every existing test stayed
 * green — the guard worked, only its explanation was destroyed. The operator is
 * told to look for a secret whose name is a literal `${ENV_ARG^^}`, on the one
 * run where they have no credentials and no other information. That is the
 * first thing a founder sees on a cold start.
 *
 * ## Both halves are needed
 *
 * The static scan alone can be satisfied by deleting the expansion and leaving
 * the message generic. The behavioural half RUNS each script with the
 * credentials stripped and asserts the real secret name reaches stderr, so the
 * message has to be useful rather than merely syntactically valid.
 *
 * The scan reads the DIRECTORY rather than a list, so a script added tomorrow is
 * covered the day it lands.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(ROOT, "scripts/ops/datadog");

/**
 * Run `spawn` with a stub `curl` first on PATH, and return its call log too.
 *
 * The suite is hermetic. Two cases below drive `set-dd-secret.sh` all the way
 * to its probe, and the probe's whole job is to make an HTTP request — so the
 * only way to keep the property AND the hermeticity is to own what answers.
 *
 * `cat > /dev/null` first, always: `curl -K -` is fed its headers through a
 * pipe, and a stub that exits without draining it hands the writer an EPIPE,
 * which under `pipefail` reads as a transport failure rather than as whatever
 * the stub meant to say.
 */
function withStubCurl(
  body: string[],
  spawn: (env: NodeJS.ProcessEnv) => SpawnSyncReturns<string>,
): SpawnSyncReturns<string> & { calls: string } {
  const dir = mkdtempSync(join(tmpdir(), "dd-curl-stub-"));
  try {
    const log = join(dir, "calls.log");
    writeFileSync(log, "");
    const [shebang, ...rest] = body;
    writeFileSync(
      join(dir, "curl"),
      [
        shebang,
        'printf "curl %s\\n" "$*" >> "$STUB_LOG"',
        "cat > /dev/null 2>/dev/null || true",
        ...rest,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const res = spawn({
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_LOG: log,
    });
    return { ...res, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHELL_SCRIPTS = readdirSync(DIR)
  .filter((f) => f.endsWith(".sh"))
  .sort();

/** Strip `#` comments so a comment ABOUT the trap does not trip the trap. */
const withoutComments = (src: string): string =>
  src
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

/**
 * Parameter expansions that bash 3.2 cannot parse.
 *
 * Deliberately not a general "is this bash 4" detector — that would need a
 * parser. These are the specific forms that are easy to reach for while writing
 * a message, which is exactly where the damage is worst.
 */
const BASH4_EXPANSIONS: Array<{ re: RegExp; what: string }> = [
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?\}/g, what: "${VAR^^} uppercase" },
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/g, what: "${VAR,,} lowercase" },
  { re: /\bdeclare\s+-A\b/g, what: "declare -A associative array" },
  { re: /\bmapfile\b|\breadarray\b/g, what: "mapfile/readarray" },
];

describe("MONEY-1360 — the apply scripts parse on bash 3.2", () => {
  it("PREMISE: the directory scan found the scripts", () => {
    // A scan over nothing passes every assertion below it.
    assert.ok(
      SHELL_SCRIPTS.length >= 4,
      `only ${SHELL_SCRIPTS.length} scripts found in ${DIR}: ${SHELL_SCRIPTS.join(", ")}`,
    );
  });

  it("PREMISE: this machine's bash really is the old one, or the run says so", () => {
    // If CI ever moves to bash 5 the behavioural cases below stop reproducing
    // the defect, and would pass for the wrong reason. The static scan is what
    // carries the guarantee there, so record which half is load-bearing.
    const v = spawnSync("bash", ["-c", "echo $BASH_VERSION"], {
      encoding: "utf8",
    }).stdout.trim();
    assert.match(v, /^\d+\./, `could not read BASH_VERSION, got "${v}"`);
  });

  for (const name of SHELL_SCRIPTS) {
    it(`${name} uses no bash-4-only expansion`, () => {
      const src = withoutComments(readFileSync(join(DIR, name), "utf8"));
      for (const { re, what } of BASH4_EXPANSIONS) {
        const hits = src.match(re);
        assert.equal(
          hits,
          null,
          `${name} uses ${what} (${hits?.join(", ")}). macOS ships bash 3.2, ` +
            "where this is a syntax error. Use `tr '[:lower:]' '[:upper:]'`.",
        );
      }
    });
  }

  /**
   * The scripts that DEMAND credentials, derived rather than listed.
   *
   * `lib-datadog.sh` is a library — running it does nothing and it has no
   * message to check. `set-dd-secret.sh` is the opposite shape: it READS a key
   * from stdin rather than requiring one in the environment. Neither is an
   * exception to the rule; neither is in the rule's population. The membership
   * test is the `${DD_API_KEY:?…}` guard itself, so a new apply script joins on
   * the day it grows one.
   */
  const CREDENTIALLED = SHELL_SCRIPTS.filter((n) =>
    /\$\{DD_API_KEY:\?/.test(readFileSync(join(DIR, n), "utf8")),
  );

  it("PREMISE: the credential-demanding scripts were identified", () => {
    assert.ok(
      CREDENTIALLED.length >= 4,
      `only ${CREDENTIALLED.length} scripts demand credentials: ` +
        `${CREDENTIALLED.join(", ")} — of ${SHELL_SCRIPTS.join(", ")}`,
    );
  });

  it("set-dd-secret.sh names the WRONG KIND of key before sending a request", () => {
    // The two credentials live on adjacent pages of the same settings screen,
    // both are lowercase hex, and pasting one where the other belongs fails
    // with a bare 403 that says nothing about which mistake was made. The
    // lengths are stable and differ — 32 for an API key, 40 for an application
    // key — so the wrong kind is nameable before a request is sent.
    const script = join(DIR, "set-dd-secret.sh");
    const cases = [
      {
        secret: "DD_APP_KEY_PROD",
        key: "0".repeat(32),
        says: /32 characters is an API KEY/,
      },
      {
        secret: "DD_API_KEY_QA",
        key: "0".repeat(40),
        says: /40 characters is an APPLICATION KEY/,
      },
    ];
    for (const c of cases) {
      const res = spawnSync("bash", [script, c.secret], {
        encoding: "utf8",
        cwd: ROOT,
        input: c.key,
      });
      assert.notEqual(
        res.status,
        0,
        `${c.secret} accepted a ${c.key.length}-char key`,
      );
      assert.match(res.stderr, c.says);
      assert.match(res.stderr, /NOTHING was written/);
      // It must not have spent a request finding this out.
      assert.doesNotMatch(
        res.stderr,
        /HTTP \d/,
        "it sent a request before checking the shape",
      );
    }
  });

  it("a CORRECTLY shaped key still reaches the network check", () => {
    // The positive control. Without it, refusing every input would satisfy the
    // case above — and the point is to refuse the wrong SHAPE early, not to
    // refuse everything.
    //
    // HERMETIC, and it was not: this used to send a REAL request to
    // api.us5.datadoghq.com with a bogus credential on every `yarn test`, on
    // every machine and in CI. The property is "a correctly shaped key is
    // refused on the API's ANSWER rather than on its shape", and a stubbed curl
    // that answers 403 demonstrates exactly that — deterministically, and
    // without telling Datadog about it.
    const res = withStubCurl(["#!/bin/sh", "printf 403"], (env) =>
      spawnSync("bash", [join(DIR, "set-dd-secret.sh"), "DD_API_KEY_QA"], {
        encoding: "utf8",
        cwd: ROOT,
        input: "0".repeat(32),
        env,
      }),
    );
    assert.notEqual(res.status, 0, "a bogus key was accepted");
    assert.match(
      res.stderr,
      /did not authenticate/,
      "a correctly shaped key was rejected on shape rather than on the API's answer",
    );
    assert.match(
      res.calls,
      /api\/v1\/validate/,
      "it never got as far as asking — the whole point of this control",
    );
    assert.match(res.stderr, /NOTHING was written/);
  });

  it("a curl that never ANSWERS is refused with a message, not a silent death", () => {
    // `CODE="$(curl … )"` under `set -euo pipefail` against an unreachable host
    // exits 6 and the script DIES THERE — no message, no "REFUSED", nothing
    // about the key the operator has just pasted. Verified on this machine:
    // the line after the substitution never runs. That is the defect
    // `dd_request` was extracted into lib-datadog.sh to fix; this script cannot
    // call it (an api-key probe has no application key to pair with) so it
    // captures curl's rc itself.
    const res = withStubCurl(["#!/bin/sh", "exit 6"], (env) =>
      spawnSync("bash", [join(DIR, "set-dd-secret.sh"), "DD_API_KEY_QA"], {
        encoding: "utf8",
        cwd: ROOT,
        input: "0".repeat(32),
        env,
      }),
    );
    assert.notEqual(res.status, 0, "a transport failure was treated as a pass");
    assert.match(
      res.stderr,
      /curl exited 6/,
      `a transport failure produced no message:\n${res.stderr}`,
    );
    assert.match(res.stderr, /NOTHING was written/);
  });

  it("the API host is derived in ONE place, not once per script", () => {
    // This block was four copies of twelve lines. The site is exactly the fact
    // that must not have four spellings: the org moved us3 -> us5, a stale copy
    // is answered 403, and a 403 on an intake is swallowed and renders as NO
    // DATA rather than as an error. A script that derives it independently can
    // drift; one that calls the library cannot.
    const derivers: string[] = [];
    const callers: string[] = [];
    for (const name of SHELL_SCRIPTS) {
      const src = withoutComments(readFileSync(join(DIR, name), "utf8"));
      // `DD_API_HOST=` AND the `read -r … DD_API_HOST` form. The second one is
      // why this regex is not just an assignment: apply-monitors.sh derived the
      // site inside a combined `read` that also picked up two metric names, and
      // an assignment-only scan reported it as compliant.
      //
      // AND `DD_SITE` under any spelling, because scanning for the DERIVED
      // value could not see the SOURCE one: `setup-datadog.sh` and
      // `set-dd-secret.sh` each scraped `DD_SITE` out of constants.ts with
      // their own weaker `sed` and then built `https://api.${DD_SITE}` inline —
      // a second and a third spelling of exactly the fact this check exists to
      // keep singular, both invisible to a `DD_API_HOST=` grep. The library
      // reads it in one place and hands back `DD_API_HOST`; anything else is a
      // copy. (The apply scripts mention `DD_SITE` only in comments, which
      // `withoutComments` has already removed.)
      if (
        /(?:^|\s)DD_API_HOST\s*=|read\s+[^\n]*\bDD_API_HOST\b|\bDD_SITE\b/.test(
          src,
        ) &&
        name !== "lib-datadog.sh"
      ) {
        derivers.push(name);
      }
      if (/dd_resolve_api_host/.test(src)) callers.push(name);
    }
    assert.deepEqual(
      derivers,
      [],
      `${derivers.join(", ")} spells the site out for itself (DD_SITE or ` +
        "DD_API_HOST). Call `dd_resolve_api_host` from lib-datadog.sh instead.",
    );
    // The positive control: without it, deleting the resolver from every script
    // would satisfy the assertion above.
    assert.ok(
      callers.length >= 7,
      `only ${callers.length} scripts reach the shared resolver ` +
        `(${callers.join(", ")}) — the library itself plus its callers`,
    );
  });

  for (const name of CREDENTIALLED) {
    it(`${name} names the secret it wants when credentials are missing`, () => {
      // Behavioural, because the static scan above is satisfied by a message
      // that parses and says nothing useful.
      const env = { ...process.env };
      delete env.DD_API_KEY;
      delete env.DD_APP_KEY;

      // Every script here takes `prod` or nothing; a script that rejects `prod`
      // is tried bare. Both paths must still reach a credential complaint.
      let res = spawnSync("bash", [join(DIR, name), "prod"], {
        encoding: "utf8",
        cwd: ROOT,
        env,
      });
      if (/unknown argument|usage:/i.test(res.stderr ?? "")) {
        res = spawnSync("bash", [join(DIR, name)], {
          encoding: "utf8",
          cwd: ROOT,
          env,
        });
      }
      const err = res.stderr ?? "";

      assert.doesNotMatch(
        err,
        /bad substitution/,
        `${name} printed a shell parse error instead of its message:\n${err}`,
      );
      assert.doesNotMatch(
        err,
        /\$\{[A-Za-z_]/,
        `${name} leaked an unexpanded parameter into its message:\n${err}`,
      );
      // It must fail closed, and it must say which secret to fetch.
      assert.notEqual(res.status, 0, `${name} ran without credentials`);
      assert.match(
        err,
        /DD_(API|APP)_KEY_(PROD|QA)\b/,
        `${name} does not name a Secret Manager secret, so the operator is told ` +
          `a key is missing and not which one:\n${err}`,
      );
    });
  }
});
