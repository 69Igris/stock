/**
 * The RUM application creator is idempotent, and the credentials it prints are
 * paired with the environment they belong to — MONEY-1229.
 *
 * ## Why this needs a guard at all
 *
 * It runs ONCE, by hand, on a cutover, and its output is copied into another
 * system. Both properties make it exactly the kind of script that is never
 * exercised again and is wrong in a way nobody notices:
 *
 *   - A second run without an existence check mints a SECOND application under
 *     the same name with a different id. The browser then reports into one
 *     while the credentials this script printed last time point at the other.
 *     Matching on the name ALONE is the same bug wearing the other face:
 *     Datadog does not enforce unique RUM names, so a mobile `stockbook-web`
 *     would be "found" and its credentials printed for the browser app.
 *   - The id/token/env TRIPLE is the pairing nothing downstream can check.
 *     `rum-init.ts` hardcodes `service: "stockbook-web"` for both
 *     environments, so RUM events join on `service` + `env` and the
 *     application NAME is in no query — which means prod credentials pasted
 *     into the qa Vercel project produce qa sessions in the prod application
 *     while every monitor and dashboard keeps working. (This file previously
 *     claimed the opposite: that the names were the join. They never were.)
 *   - A response missing `client_token` printed as an empty variable produces a
 *     Vercel setting that disables RUM without failing: the SDK simply never
 *     sends.
 *
 * ## The success status is 200
 *
 * Datadog answers a RUM application create with **200**, not the 201 a create
 * usually returns. A `[[ "$status" == 201 ]]` would refuse every successful
 * creation, so `dd_request`'s 2xx handling is what makes this work and the case
 * below pins it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(ROOT, "scripts/ops/datadog");
const SCRIPT = join(DIR, "create-rum-apps.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

/** A RUM application as the v2 API returns it. */
const app = (name: string, id: string, type = "browser") => ({
  id,
  attributes: { name, type, application_id: id, client_token: `pub${id}` },
});

/**
 * Run the REAL script against a stubbed curl.
 *
 * The stub answers the LIST and the per-application reads/creates differently,
 * because a single body cannot be both a collection and a member — and a stub
 * that returns the collection to a create would let "it created something" pass
 * while the script parsed the wrong shape.
 *
 * `qaMemberBody` answers the read of `id-qa` specifically. One member body for
 * both applications is what the reuse case used to have, and it made the whole
 * point of that case unobservable: a script that printed the PROD token under
 * the qa heading — the one mistake nothing downstream can detect — passed it.
 */
function run(
  listBody: string,
  memberBody: string,
  status = "200",
  qaMemberBody = memberBody,
): { code: number; stdout: string; stderr: string; curlLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "rum-apps-"));
  const log = join(dir, "calls.log");
  try {
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        "cat > /dev/null", // drain the -K - credential config
        'case "$*" in',
        '  *"/api/v2/rum/applications/id-qa"*) body="$STUB_MEMBER_QA" ;;',
        '  *"/api/v2/rum/applications/"*)     body="$STUB_MEMBER" ;;',
        '  *"-X POST"*)                       body="$STUB_MEMBER" ;;',
        '  *)                                 body="$STUB_LIST" ;;',
        "esac",
        'printf "%s\\n%s\\n" "$body" "$STUB_STATUS"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    const res = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_LOG: log,
        STUB_LIST: listBody,
        STUB_MEMBER: memberBody,
        STUB_MEMBER_QA: qaMemberBody,
        STUB_STATUS: status,
        DD_API_KEY: "stub-api-key",
        DD_APP_KEY: "stub-app-key",
      },
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      curlLog: readFileSync(log, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const countCalls = (log: string, method: string): number =>
  log.split(`-X ${method} `).length - 1;

/**
 * The printed Vercel table, as BLOCKS.
 *
 * The whole risk this script exists to remove is a credential landing under the
 * wrong heading, so the assertion has to be about a block — a grep for
 * `NEXT_PUBLIC_DD_CLIENT_TOKEN=pubid-prod` is satisfied by the prod token
 * printed under the qa heading, which is the exact defect.
 */
function vercelBlocks(
  stdout: string,
): { target: string; appId?: string; token?: string; env?: string }[] {
  return stdout
    .split(/^# (?=web )/m)
    .slice(1)
    .map((chunk) => ({
      target: chunk.split("\n")[0]!.trim(),
      appId: /NEXT_PUBLIC_DD_APPLICATION_ID=(.*)/.exec(chunk)?.[1],
      token: /NEXT_PUBLIC_DD_CLIENT_TOKEN=(.*)/.exec(chunk)?.[1],
      env: /NEXT_PUBLIC_DD_ENV=(.*)/.exec(chunk)?.[1],
    }));
}

const EMPTY = JSON.stringify({ data: [] });
const BOTH = JSON.stringify({
  data: [app("stockbook-web", "id-prod"), app("stockbook-web-qa", "id-qa")],
});

describe("MONEY-1229 — the RUM creator is idempotent and pairs its output", () => {
  it("PREMISE: the dry run makes no network call", () => {
    const noNet = mkdtempSync(join(tmpdir(), "rum-offline-"));
    const log = join(noNet, "calls.log");
    writeFileSync(
      join(noNet, "curl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        // DRAIN `-K -`. A stub that never reads stdin makes the credential
        // writer die of SIGPIPE; `pipefail` then surfaces 141 and `dd_request`
        // misreports it as "curl exited 141". Invisible on macOS, fatal on
        // Linux — which is how CI caught it and a local run did not.
        "cat > /dev/null",
        "exit 99",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    // Built in two steps on purpose. Spreading `process.env` straight into a
    // literal narrows the type to that literal's keys, and the deletes below
    // then fail to compile — `yarn build` does not typecheck this, but
    // `verify:push` runs type-check first and does.
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.PATH = `${noNet}:${process.env.PATH ?? ""}`;
    env.STUB_LOG = log;
    delete env.DD_API_KEY;
    delete env.DD_APP_KEY;
    const out = execFileSync("bash", [SCRIPT, "--dry-run"], {
      encoding: "utf8",
      cwd: ROOT,
      env,
    });
    assert.equal(readFileSync(log, "utf8"), "", "the dry run reached curl");
    assert.match(out, /stockbook-web-qa/);
    rmSync(noNet, { recursive: true, force: true });
  });

  it("LISTS before it creates anything", () => {
    // Without this, a second run mints a duplicate application under the same
    // name and everything downstream keeps querying the first one.
    const r = run(EMPTY, JSON.stringify({ data: app("stockbook-web", "new") }));
    assert.equal(r.code, 0, r.stderr);
    const firstCall = r.curlLog.split("\n")[0] ?? "";
    assert.match(
      firstCall,
      /-X GET/,
      `the first request was not a listing: ${firstCall}`,
    );
  });

  it("creates BOTH applications when the org has none", () => {
    const r = run(EMPTY, JSON.stringify({ data: app("stockbook-web", "new") }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(countCalls(r.curlLog, "POST"), 2, "expected one create each");
    assert.match(r.stdout, /created 2, reused 0 of 2/);
  });

  it("creates NOTHING when both already exist, and prints EACH ONE's own token", () => {
    // The re-read is the point: the LIST endpoint omits `client_token`, so an
    // existing application would otherwise print a blank one.
    //
    // TWO member bodies, and that is the case rather than a detail. Both
    // applications were stubbed with the SAME body here, so `stockbook-web-qa`
    // read back as `id-prod`/`pubid-prod` and the assertion — a grep for the
    // prod token anywhere in the output — was satisfied by the output being
    // WRONG in exactly the way the script header warns about. Prod credentials
    // in the qa project produce sessions that report `service:stockbook-web,
    // env:qa` into the prod application: the monitors keep matching, the
    // dashboards keep drawing, and nothing downstream can tell.
    const r = run(
      BOTH,
      JSON.stringify({ data: app("stockbook-web", "id-prod") }),
      "200",
      JSON.stringify({ data: app("stockbook-web-qa", "id-qa") }),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(countCalls(r.curlLog, "POST"), 0, "it created a duplicate");
    assert.match(r.stdout, /created 0, reused 2 of 2/);

    const blocks = vercelBlocks(r.stdout);
    assert.equal(blocks.length, 2, `printed ${blocks.length} blocks`);
    const prod = blocks.find((b) => b.env === "production");
    const qa = blocks.find((b) => b.env === "qa");
    assert.ok(prod && qa, `env lines missing: ${JSON.stringify(blocks)}`);
    assert.deepEqual(
      { id: prod.appId, token: prod.token },
      { id: "id-prod", token: "pubid-prod" },
    );
    assert.deepEqual(
      { id: qa.appId, token: qa.token },
      { id: "id-qa", token: "pubid-qa" },
    );
    assert.match(prod.target, /^web prod\b/);
    assert.match(qa.target, /^web qa\b/);
  });

  it("does NOT reuse an application of a DIFFERENT type with the same name", () => {
    // Datadog does not enforce unique RUM application names, and browser / ios
    // / android are separate kinds. Matching on `attributes.name` alone would
    // find a mobile `stockbook-web`, "reuse" it, and print ITS credentials into
    // the Vercel table for the web app — the browser SDK would then send into
    // an application that is not a browser application.
    const mobile = JSON.stringify({
      data: [
        app("stockbook-web", "id-ios", "ios"),
        app("stockbook-web-qa", "id-qa"),
      ],
    });
    const r = run(
      mobile,
      JSON.stringify({ data: app("stockbook-web", "id-new") }),
      "200",
      JSON.stringify({ data: app("stockbook-web-qa", "id-qa") }),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      countCalls(r.curlLog, "POST"),
      1,
      "the ios application was reused as the browser one",
    );
    assert.match(r.stdout, /created 1, reused 1 of 2/);
    const prod = vercelBlocks(r.stdout).find((b) => b.env === "production");
    assert.equal(
      prod?.appId,
      "id-new",
      "the mobile application id was printed",
    );
  });

  it("REFUSES a response with no client_token rather than printing an empty one", () => {
    // A blank NEXT_PUBLIC_DD_CLIENT_TOKEN disables RUM without failing — the
    // SDK simply never sends — so this must be an error, not a gap in a table.
    const r = run(
      EMPTY,
      JSON.stringify({
        data: {
          id: "x",
          attributes: { name: "stockbook-web", application_id: "x" },
        },
      }),
    );
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no application_id\/client_token/);
    assert.doesNotMatch(r.stdout, /NEXT_PUBLIC_DD_CLIENT_TOKEN=\s*$/m);
  });

  it("aborts when the listing cannot be read, without creating anything", () => {
    const r = run("not json at all", "{}", "200");
    assert.notEqual(r.code, 0);
    assert.equal(countCalls(r.curlLog, "POST"), 0);
  });

  it("aborts on a non-2xx listing", () => {
    const r = run(EMPTY, "{}", "403");
    assert.notEqual(r.code, 0);
    assert.equal(countCalls(r.curlLog, "POST"), 0);
  });

  it("the RUM monitors join on service + env, NOT on these application names", () => {
    // MONEY-1229 — this case read "the application NAMES are the ones the
    // service monitors query", and the script header said a rename here
    // detaches the monitors. Both were false, and the false version is the more
    // dangerous belief: it points at the harmless mistake and away from the one
    // nothing can detect.
    //
    // `rum-init.ts` hardcodes `service: "stockbook-web"` for BOTH environments
    // and takes `env` from `NEXT_PUBLIC_DD_ENV`. So the monitors match on
    // service + env, the application name appears in no query, and the pairing
    // that actually decides which application a session lands in is the
    // id/token/env TRIPLE this script prints — covered by the reuse case above.
    const rumInit = readFileSync(
      join(ROOT, "apps/web/lib/datadog/rum-init.ts"),
      "utf8",
    );
    assert.match(
      rumInit,
      /service:\s*"stockbook-web"/,
      "the browser no longer reports a hardcoded service — re-check what the " +
        "RUM monitors join on before trusting the header of create-rum-apps.sh",
    );
    assert.match(rumInit, /NEXT_PUBLIC_DD_ENV/);

    const rendered = execFileSync(
      "bash",
      [join(DIR, "apply-service-monitors.sh"), "prod", "--dry-run"],
      { encoding: "utf8", cwd: ROOT },
    );
    const rum = rendered
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { query: string; tags: string[] })
      .filter((m) => m.query.includes("rum("));
    assert.ok(rum.length >= 2, `only ${rum.length} RUM monitors rendered`);
    for (const m of rum) {
      // What they DO join on — the service the browser stamps, not a name from
      // the APPS table below.
      assert.match(
        m.query,
        /service:stockbook-web\b/,
        `a RUM monitor queries a service the browser never reports: ${m.query}`,
      );
      assert.ok(
        !/stockbook-web-qa/.test(m.query),
        `a RUM monitor queries an application NAME, which is not a RUM ` +
          `attribute: ${m.query}`,
      );
    }
    // The names are still asserted — this script has to recognise what it
    // created last time — but as ITS OWN idempotency key, not as a join.
    assert.match(SCRIPT_SRC, /"stockbook-web\|production"/);
    assert.match(SCRIPT_SRC, /"stockbook-web-qa\|qa"/);
  });

  it("takes no environment argument and REFUSES one", () => {
    // Both applications live in one us5 org; which is which is the NAME. An
    // argument silently accepted and ignored is how a mistyped dry run made 78
    // live requests through the sibling script.
    for (const arg of ["prod", "qa", "--dryrun"]) {
      const res = spawnSync("bash", [SCRIPT, arg], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.equal(res.status, 2, `"${arg}" was not refused`);
      assert.match(res.stderr, /unknown argument/);
    }
  });

  it("never puts a credential on curl's command line", () => {
    const r = run(
      BOTH,
      JSON.stringify({ data: app("stockbook-web", "id-prod") }),
    );
    assert.doesNotMatch(
      r.curlLog,
      /DD-API-KEY|DD-APPLICATION-KEY|stub-api-key|stub-app-key/,
      "a credential reached argv, where `ps` can read it",
    );
    assert.ok(
      r.curlLog.includes("-K -"),
      "the config-on-stdin transport is gone",
    );
  });
});
