/**
 * The SHA a Cloud Run JOB reports must stay REAL — MONEY-1205 T5.
 *
 * `build-provenance.test.ts` proves the comparison logic. This file proves the
 * thing the logic depends on and cannot check for itself: that the commit SHA
 * actually reaches the running container, and that every job entry point
 * actually says it out loud.
 *
 * Both halves rot silently, and one of them already had:
 *
 *   workers/cloudbuild.prod.yaml   -t …:prod-$COMMIT_SHA   --build-arg DD_VERSION=$COMMIT_SHA  OK
 *   workers/cloudbuild.qa.yaml     -t …:qa-$COMMIT_SHA     --build-arg DD_VERSION=$COMMIT_SHA  OK
 *   workers/cloudbuild.yaml        -t …:${_ENV}-$COMMIT_SHA   (no --build-arg)                 ROTTED
 *
 * One missing line, and every image built through that config bakes the literal
 * string "unknown" from `workers/Dockerfile`'s `ARG DD_VERSION=unknown`. A job
 * pinned to such an image reports "I don't know what I am" forever, which is the
 * failure mode the runtime guard exists to surface and would itself be caused by
 * a config file nobody looks at. Fixed on this branch; pinned here so it stays
 * fixed.
 *
 * The rule these assertions encode: **the image TAG and the baked DD_VERSION
 * must come from the same substitution.** That is what makes
 * `process.env.DD_VERSION` a property of the image rather than of the job spec —
 * and therefore something a stale job cannot forge, because
 * `gcloud run jobs deploy --set-env-vars` rewrites only the job's own env list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { setupScriptFor } from "../../src/ops/build-provenance";

/** CWD is packages/core when this suite runs. */
const ROOT = join(process.cwd(), "..", "..");
const WORKERS = join(ROOT, "workers");
const JOBS_DIR = join(ROOT, "scripts", "jobs");
const DOCKERFILE = join(WORKERS, "Dockerfile");
const TSUP = join(WORKERS, "tsup.config.ts");
const FEED_SETUP = join(ROOT, "scripts", "ops", "setup-feed-backfill-job.sh");

const dockerfileSrc = readFileSync(DOCKERFILE, "utf8");
const tsupSrc = readFileSync(TSUP, "utf8");
const feedSetupSrc = readFileSync(FEED_SETUP, "utf8");

const cloudbuildFiles = readdirSync(WORKERS)
  .filter((f) => /^cloudbuild.*\.ya?ml$/.test(f))
  .sort();

/**
 * Drop whole-line YAML comments, keeping line numbering intact.
 *
 * Only leading-`#` lines: a `#` inside a quoted value or after config on the
 * same line is not worth the quote-tracking, and dropping the trailing half of
 * a config line would make this guard blind to a real setting.
 */
function stripYamlComments(src: string): string {
  return src
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");
}

/**
 * Entry points tsup bundles into `workers/dist/`.
 *
 * Derived from the config rather than listed, because the set is exactly "what
 * can be handed to `gcloud run jobs deploy --command=node,dist/X.js`". A job
 * entry point added to tsup and not to this guard is the next instance of the
 * bug, so the guard has to learn about it automatically.
 */
const tsupJobEntries = (() => {
  const start = tsupSrc.indexOf("entry: {");
  // The block's own closing brace, at two-space indent — NOT the first `}`.
  // A comment inside the block (`trade_bar_{m1,h1}`) carries one, and cutting
  // there silently dropped `lake-load-databento` and every entry after it from
  // this guard (found 2026-09-23, MONEY-1518). Same marker as the sibling
  // parser further down.
  const end = tsupSrc.indexOf("\n  }", start);
  const block = tsupSrc.slice(start, end);
  const out = new Map<string, string>();
  for (const m of block.matchAll(
    /"?([\w-]+)"?\s*:\s*"\.\.\/scripts\/jobs\/([\w-]+)\.ts"/g,
  )) {
    out.set(m[1]!, m[2]!);
  }
  return out;
})();

/**
 * Entry points that do NOT yet call `reportBuildProvenance`.
 *
 * Written as an exact-match assertion below, not a skip list, so it is
 * SELF-CLOSING in both directions: adding the call without deleting the
 * exemption fails, and adding a new job without the call fails.
 *
 * EMPTY, and meant to stay that way. It briefly held `feed-parse` — the entry
 * point the MONEY-1205 incident actually happened on — while that file was
 * being rewritten concurrently for bond-family parsing; the call and this
 * exemption were removed together, which is exactly the paired move the
 * exact-match assertion forces. The mechanism stays for the next such overlap:
 * an exemption is a stopgap with a ticket, never a policy.
 */
const AWAITING_WIRE_UP: Record<string, string> = {};

describe("the commit SHA reaches the container (MONEY-1205 T5)", () => {
  it("resolves the inputs it reasons over — a silent zero here proves nothing", () => {
    // This suite's own failure mode is parsing nothing and passing, which would
    // restore the exact blind spot it closes.
    assert.ok(
      cloudbuildFiles.length >= 3,
      `found only ${cloudbuildFiles.length} cloudbuild files in workers/`,
    );
    assert.ok(
      tsupJobEntries.size >= 4,
      `parsed only ${tsupJobEntries.size} scripts/jobs entry points from tsup.config.ts`,
    );
    assert.ok(dockerfileSrc.length > 500, "workers/Dockerfile did not read");
  });

  it("workers/Dockerfile still declares the ARG and promotes it to ENV", () => {
    // Both lines are load-bearing and they are 6 lines apart, so it is easy to
    // delete one. ARG alone is build-time only and never reaches the runtime;
    // ENV alone has nothing to receive.
    assert.match(
      dockerfileSrc,
      /^ARG DD_VERSION=/m,
      "workers/Dockerfile must keep `ARG DD_VERSION=...` — it is what --build-arg targets",
    );
    assert.match(
      dockerfileSrc,
      /^ENV DD_VERSION=\$\{DD_VERSION\}/m,
      "workers/Dockerfile must keep `ENV DD_VERSION=${DD_VERSION}` — without it the " +
        "build arg never becomes a runtime env var and every job reports 'unidentified'",
    );
  });

  it("every cloudbuild that tags with $COMMIT_SHA also bakes it as DD_VERSION", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const file of cloudbuildFiles) {
      const src = readFileSync(join(WORKERS, file), "utf8");
      // Only build steps that stamp the SHA into the image tag are in scope.
      if (!/stockbook-workers:[^'"\n]*\$COMMIT_SHA/.test(src)) continue;
      checked++;
      if (!/--build-arg[\s\S]{0,80}?DD_VERSION=\$COMMIT_SHA/.test(src)) {
        offenders.push(file);
      }
    }

    assert.ok(
      checked >= 3,
      `only ${checked} cloudbuild files tag with $COMMIT_SHA`,
    );
    assert.deepEqual(
      offenders,
      [],
      "These cloudbuild configs tag the image with $COMMIT_SHA but never pass " +
        "`--build-arg DD_VERSION=$COMMIT_SHA`, so workers/Dockerfile's " +
        "`ARG DD_VERSION=unknown` default wins and the image cannot say which " +
        "commit built it. A Cloud Run JOB pinned to such an image is " +
        "indistinguishable from a fresh one — which is the MONEY-1205 bug with " +
        "the evidence removed.\n  " +
        offenders.join("\n  "),
    );
  });

  it("DD_VERSION is never a hardcoded literal in a cloudbuild build-arg", () => {
    // The cheap "fix" for a red version check is to pin a constant. That would
    // pass every check in this file while making the reported SHA a lie, so the
    // literal form is rejected outright.
    //
    // Comment lines are stripped first, and that is not incidental tidying:
    // this assertion tripped on its own documentation the first time it ran,
    // because the comment explaining `ARG DD_VERSION=unknown` reads exactly like
    // a hardcoded build-arg. A guard that fails on prose it cannot distinguish
    // from config gets its regex loosened by the next person, and loosening is
    // how it stops covering the real thing.
    for (const file of cloudbuildFiles) {
      const src = stripYamlComments(readFileSync(join(WORKERS, file), "utf8"));
      for (const m of src.matchAll(/DD_VERSION=([^\s'"\n]+)/g)) {
        const value = m[1]!;
        assert.ok(
          value.includes("$COMMIT_SHA") || value.includes("${DD_VERSION}"),
          `${file} sets DD_VERSION=${value} — it must be derived from $COMMIT_SHA, ` +
            "not hardcoded, or the guard reports a constant instead of the truth",
        );
      }
    }
  });
});

describe("every Cloud Run JOB entry point reports its build (MONEY-1205 T5)", () => {
  it("the job entry points tsup bundles are the ones the setup script deploys", () => {
    // Ties the derived set to reality: if setup-feed-backfill-job.sh ever runs
    // a `dist/X.js` tsup does not build, the set this suite scans is fiction.
    const deployed = [
      ...feedSetupSrc.matchAll(/deploy_job\s+"\$\w+"\s+"dist\/([\w-]+)\.js"/g),
    ].map((m) => m[1]!);

    assert.ok(
      deployed.length >= 3,
      `parsed only ${deployed.length} deploy_job calls`,
    );
    const missing = deployed.filter((d) => !tsupJobEntries.has(d)).sort();
    assert.deepEqual(
      missing,
      [],
      "setup-feed-backfill-job.sh deploys a dist/*.js that workers/tsup.config.ts " +
        "does not build. The job would fail at startup, and this suite would be " +
        "reasoning about an entry point set that does not match production.\n  " +
        missing.join("\n  "),
    );
  });

  it("reports build provenance, or is explicitly and temporarily exempt", () => {
    const silent: string[] = [];

    for (const [outName, sourceName] of tsupJobEntries) {
      // Comment lines stripped: a commented-out `reportBuildProvenance(...)`
      // used to satisfy both regexes below while logging nothing.
      const src = readFileSync(join(JOBS_DIR, `${sourceName}.ts`), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n");
      const imports =
        /reportBuildProvenance\s*\}?\s*from\s*"@usemoney\/core\/ops\/build-provenance"/.test(
          src,
        );
      // The call has to be in main(), not merely imported — an unused import
      // type-checks fine and logs nothing.
      // Either the literal name, or a `JOB` constant bound to exactly that
      // literal — the spelling most lake jobs use for their other log lines.
      const calls =
        new RegExp(
          `reportBuildProvenance\\(\\s*log\\s*,\\s*"${sourceName}"\\s*\\)`,
        ).test(src) ||
        (/reportBuildProvenance\(\s*log\s*,\s*JOB\s*\)/.test(src) &&
          new RegExp(`const JOB\\s*=\\s*"${sourceName}"`).test(src));
      if (!imports || !calls) silent.push(outName);
    }

    assert.deepEqual(
      silent.sort(),
      Object.keys(AWAITING_WIRE_UP).sort(),
      "A Cloud Run JOB entry point does not report the commit it is running.\n\n" +
        "Cloud Run JOBS pin their image at provision time and a deploy of the " +
        "SERVICE does not move them, so a job can run weeks-old code, exit 0 and " +
        "report SUCCEEDED_COUNT 1 while silently skipping work it has never heard " +
        "of. That is MONEY-1205 (bond_master/bond_eod at 0 rows) and, before it, " +
        "MONEY-1189. The only place the drift is observable is the job's own " +
        "startup output.\n\n" +
        'Fix: `import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";` ' +
        'and call `reportBuildProvenance(log, "<entrypoint>")` as the first ' +
        "statement of main().\n\n" +
        "If an entry point genuinely cannot have it yet, add it to " +
        "AWAITING_WIRE_UP in this file WITH a reason — and remove it in the same " +
        "change that adds the call.",
    );
  });

  it("every AWAITING_WIRE_UP exemption carries a real reason and a ticket", () => {
    // An exemption without a reason is indistinguishable from an oversight,
    // which is the state this suite exists to make impossible.
    for (const [entry, why] of Object.entries(AWAITING_WIRE_UP)) {
      assert.ok(
        why.trim().length > 40,
        `AWAITING_WIRE_UP["${entry}"] needs a real reason, not a placeholder`,
      );
      assert.match(
        why,
        /MONEY-\d+/,
        `AWAITING_WIRE_UP["${entry}"] must cite the ticket that closes it`,
      );
    }
  });

  it("the exemption list stays SMALL — it is a stopgap, not a policy", () => {
    // If this ever needs raising, the honest move is to wire the jobs instead.
    assert.ok(
      Object.keys(AWAITING_WIRE_UP).length <= 1,
      `${Object.keys(AWAITING_WIRE_UP).length} entry points are exempt from build ` +
        "provenance. At that point the guard covers less than it excuses.",
    );
  });
});

/**
 * EVERY tsup entry that bundles a script — `scripts/jobs/` AND `scripts/data/`.
 *
 * `tsupJobEntries` above matches only `../scripts/jobs/`, which excludes
 * `bse-backfill` — the one Cloud Run job entry point that deliberately lives in
 * `scripts/data/`, because the same script is also the operator's interactive
 * tool. A mutation proved the narrower set could not see it: removing
 * `bse-backfill` from the setup-script map changed nothing.
 */
const allScriptEntryPoints = (() => {
  const start = tsupSrc.indexOf("entry: {");
  const end = tsupSrc.indexOf("\n  }", start);
  const block = tsupSrc.slice(start, end);
  const out = new Set<string>();
  for (const m of block.matchAll(
    /"?([\w-]+)"?\s*:\s*\n?\s*"\.\.\/scripts\/[\w-]+\/[\w-]+\.ts"/g,
  )) {
    out.add(m[1]!);
  }
  return out;
})();

describe("MONEY-1314 — the remediation path in a provenance alert is REAL", () => {
  // Both alert lines used to hardcode `setup-feed-backfill-job.sh` for every
  // entry point — right for exactly one of eleven. Deriving the name from the
  // entry point instead is right for six and names a NON-EXISTENT file for the
  // other five, which is worse: it sends whoever is reading the alert at 07:00
  // on a hunt rather than to a wrong-but-real script.
  //
  // So it is a map, and this is what keeps the map honest.
  it("every mapped setup script exists on disk", () => {
    const missing: string[] = [];
    for (const ep of allScriptEntryPoints) {
      const path = setupScriptFor(ep);
      if (!path.startsWith("scripts/ops/")) continue; // the unmapped fallback
      if (!existsSync(join(ROOT, path))) {
        missing.push(`${ep} -> ${path}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      "a provenance alert would name a script that does not exist:\n  " +
        missing.join("\n  "),
    );
  });

  it("[control] an UNMAPPED entry point gets an honest instruction, not a guess", () => {
    const r = setupScriptFor("a-job-nobody-has-mapped");
    assert.ok(!r.startsWith("scripts/ops/setup-a-job"));
    assert.match(r, /unmapped entry point/);
  });

  it("[premise] the enumeration covers scripts/data too, not just scripts/jobs", () => {
    // `bse-backfill` is the one entry point outside scripts/jobs/. Without it
    // in the set, dropping it from the map is undetectable — which a mutation
    // demonstrated.
    assert.ok(
      allScriptEntryPoints.has("bse-backfill"),
      "bse-backfill is missing from the enumeration — the scripts/data entry " +
        "is not being matched, and every assertion below is narrower than it reads",
    );
    assert.ok(
      allScriptEntryPoints.size >= 10,
      `only ${allScriptEntryPoints.size} entry points parsed`,
    );
  });

  it("every Cloud Run JOB entry point is mapped", () => {
    // A new job whose remediation line says "unmapped" is a new job whose
    // alert cannot be acted on. Fails by name so the map moves with the
    // tsup entry list.
    const unmapped = [...allScriptEntryPoints].filter(
      (e) => !setupScriptFor(e).startsWith("scripts/ops/"),
    );
    assert.deepEqual(
      unmapped,
      [],
      `these entry points have no setup script in SETUP_SCRIPT_BY_ENTRYPOINT: ${unmapped.join(", ")}`,
    );
  });
});
/**
 * MONEY-1317 — EXISTENCE IS NOT DEPLOYMENT, AND A DEPLOY IS NOT THE RIGHT NAME.
 *
 * The suite above asserts every mapped setup script EXISTS on disk. That guard
 * was written for exactly this class and the class walked straight through it:
 *
 *   build-provenance.ts:336        "feed-repair": "setup-feed-backfill-job.sh"
 *   the file                       exists — the guard is satisfied
 *   what the file deployed         feed-backfill, feed-parse, fo-summary
 *   feed-repair                    nowhere in it
 *   workers/cloudbuild.*.yaml      "feed-repair  provisioned BY HAND —
 *                                   no setup script exists"
 *
 * Three sources, three different stories, none of them detectable by a check
 * that stops at `existsSync`. And the failure it produced is the expensive
 * shape rather than the loud one: a stale `feed-repair-prod` prints a
 * provenance alert naming a REAL script the operator can run, which completes
 * successfully and re-points three other jobs — so the remediation looks like
 * it worked while the job that raised the alert is untouched.
 *
 * So the property is the STRONGER one: the mapped script must contain a real
 * job-deploy invocation for that entry point, UNDER THE NAME THE RE-PIN LOOP
 * WILL ASK FOR. Two idioms exist in scripts/ops/ and both are recognised; a
 * bare mention in a comment, a `--help` blurb or a PREFLIGHT `echo` is NOT one,
 * which is what keeps this mutation-sensitive (`setup-feed-backfill-job.sh`
 * names `dist/feed-repair.js` in its header and its preflight echo as well as
 * in its deploy call — a substring test would pass with the deploy call
 * deleted).
 *
 * THE NAME HALF IS NOT DECORATION. This block previously matched
 * `deploy_job\s+"[^"]+"\s+"dist/<entry>.js"` — a WILDCARD in the job-name
 * argument — while the re-pin loop keys on `"$${BASE}-${_ENV}"`. Nothing tied
 * BASE to what the script actually creates. Mutation-verified: renaming
 * `REPAIR_JOB="feed-repair-${ENV}"` in setup-feed-backfill-job.sh left every
 * assertion GREEN while the loop would 404 on `feed-repair-{env}` on every
 * build forever — and the provenance WARNING would then point at a script that
 * creates a differently-named job. That is the three-sources-disagree shape
 * this ticket set out to end, reachable without going red.
 *
 * And it is not hypothetical: ONE of the twelve entry points really does
 * deploy under a different name. `tiingo-us-backfill` is provisioned as
 * `tiingo-us-eod-backfill-{env}` (setup-tiingo-backfill-job.sh:366), which is
 * why the loop carries JOB BASE names and this file carries the map between
 * the two vocabularies rather than assuming they are one string.
 */
describe("MONEY-1317 — a mapped setup script actually DEPLOYS the job", () => {
  /**
   * tsup entry point -> the Cloud Run job BASE name it is provisioned under.
   *
   * Identity for eleven of twelve, and DELIBERATELY NOT for the twelfth.
   * `setup-tiingo-backfill-job.sh:366` deploys `dist/tiingo-us-backfill.js` as
   * `tiingo-us-eod-backfill-${ENV}` — the "eod" is in the job name and not in
   * the bundle name. Confirmed against the deployed state on 2026-09-02:
   * `tiingo-us-eod-backfill-prod` exists, `tiingo-us-backfill-prod` does not.
   *
   * Two vocabularies overlapping in one string is how a guard pins the wrong
   * artifact, so the mapping is written down and CHECKED (`deploysJob` below
   * asserts the script really creates `<base>-${ENV}`) rather than assumed.
   */
  const JOB_BASE_BY_ENTRYPOINT: Readonly<Record<string, string>> = {
    "tiingo-us-backfill": "tiingo-us-eod-backfill",
  };
  const jobBaseFor = (entry: string): string =>
    JOB_BASE_BY_ENTRYPOINT[entry] ?? entry;

  /** The inverse, for the tests that start from the loop and work backwards. */
  const entryForJobBase = new Map(
    [...allScriptEntryPoints].map((e) => [jobBaseFor(e), e] as const),
  );

  /**
   * Entry points DELIBERATELY absent from the release re-pin loops.
   *
   * EMPTY, and the emptiness is the finding. This exclusion used to exist only
   * as a comment in this file reading "24h+ one-shots provisioned per
   * campaign", covering `bse-backfill` and the three Tiingo entries — four real
   * Cloud Run jobs on this image that no release has ever re-pointed
   * (`bse-backfill-prod`, `tiingo-us-eod-backfill-prod`,
   * `tiingo-us-corp-actions-backfill-prod`, `tiingo-us-news-seed-prod`, all
   * present in the deployed state on 2026-09-02).
   *
   * That reason does not survive contact with the list it excludes from:
   * `feed-backfill` and `feed-repair` are ALSO `--task-timeout=86400`, ALSO
   * one-shots, ALSO hand-provisioned per campaign, and have been IN the loop
   * since MONEY-1250. A reason that does not separate the two groups is not a
   * reason, it is a description of the group that happened to be omitted.
   *
   * Nor does re-pinning cost anything mid-campaign: a Cloud Run execution is
   * created from the job spec at execute time and keeps its own image, so
   * `jobs update` lands on the NEXT execution. A 24h shard finishes on the
   * image it started with.
   *
   * The mechanism stays for the case that genuinely arises — an entry point
   * that is not a Cloud Run job at all, say. Like AWAITING_WIRE_UP above, an
   * exemption is a stopgap with a ticket, never a policy.
   */
  const REPIN_EXEMPT: Record<string, string> = {};

  /**
   * Simple `VAR="value"` assignments — the only form these scripts use for the
   * two things this suite reads (job names and entrypoints).
   *
   * UPPERCASE only, on purpose. `deploy_job`'s own `local name="$1"` /
   * `local job_name="${suffix}-${ENV}"` are lowercase, so the helper's
   * parameters can never be mistaken for the caller's constants.
   */
  const shellVars = (src: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const m of src.matchAll(/^\s*([A-Z_][A-Z0-9_]*)="([^"]*)"\s*$/gm)) {
      out.set(m[1]!, m[2]!);
    }
    return out;
  };

  /**
   * Resolve one shell token to its literal value, or null if it cannot be.
   *
   * NULL IS THE IMPORTANT RETURN. A token this cannot resolve — a renamed
   * variable, an interpolation this parser does not model — must drop the
   * deploy site rather than be waved through, because "I could not read it" and
   * "it is correct" are the two answers a guard must never conflate.
   */
  const deref = (token: string, vars: Map<string, string>): string | null => {
    const m = /^\$\{?([A-Z_][A-Z0-9_]*)\}?$/.exec(token);
    if (m) return vars.get(m[1]!) ?? null;
    return token.includes("$") ? null : token;
  };

  interface DeploySite {
    /** The job name the script creates, with `${ENV}` left unexpanded. */
    jobName: string;
    /** The `dist/*.js` handed to `--command=node,...`. */
    entrypoint: string;
    idiom: string;
  }

  /**
   * Every (job name, entrypoint) PAIR a setup script actually deploys.
   *
   * Pairs, not two independent lists: a script that names the right job and the
   * right bundle in two unrelated places is exactly the state this replaces.
   *
   * Idiom 1 — a `deploy_job` helper. TWO contracts exist in scripts/ops/ and
   * they differ in the FIRST argument, which is why the helper is detected
   * rather than assumed:
   *   setup-feed-backfill-job.sh   deploy_job "$REPAIR_JOB" "dist/feed-repair.js" …
   *                                -> arg 1 is the FULL job name
   *   setup-tiingo-backfill-job.sh deploy_job "tiingo-us-eod-backfill" "dist/…" …
   *                                -> arg 1 is a SUFFIX; the helper appends
   *                                   `-${ENV}` itself
   *
   * Idiom 2 — a single-job script: `run jobs <verb> "$JOB_NAME"` together with
   * `--command="node,$ENTRYPOINT"`. The verb is deploy/create/update or a
   * variable holding one (setup-doc-ingest-backfill-job.sh picks between
   * create and update so its output says which it did). Read-only verbs —
   * describe, list, execute, add-iam-policy-binding — are not deploy sites and
   * are excluded by the whitelist.
   */
  const deploySites = (src: string): DeploySite[] => {
    const vars = shellVars(src);
    const sites: DeploySite[] = [];

    const helperAppendsEnv = /job_name="\$\{[a-z_]+\}-\$\{ENV\}"/.test(src);
    for (const m of src.matchAll(
      /deploy_job\s+"([^"]+)"\s+"(dist\/[\w-]+\.js)"/g,
    )) {
      const first = deref(m[1]!, vars);
      if (first === null) continue;
      sites.push({
        jobName: helperAppendsEnv ? `${first}-\${ENV}` : first,
        entrypoint: m[2]!,
        idiom: "deploy_job",
      });
    }

    const nameTok =
      /run jobs\s+(?:deploy|create|update|"\$\{?[A-Z_][A-Z0-9_]*\}?")\s+"(\$\{?[A-Z_][A-Z0-9_]*\}?)"/.exec(
        src,
      );
    const cmdTok = /--command="node,(\$\{?[A-Z_][A-Z0-9_]*\}?)"/.exec(src);
    if (nameTok && cmdTok) {
      const jobName = deref(nameTok[1]!, vars);
      const entrypoint = deref(cmdTok[1]!, vars);
      if (jobName !== null && entrypoint !== null) {
        sites.push({ jobName, entrypoint, idiom: "JOB_NAME + --command" });
      }
    }
    return sites;
  };

  /**
   * Does `src` deploy `dist/<entry>.js` AS `<jobBase>-${ENV}`?
   *
   * Returns the idiom it matched, or null. A comment, an echo or a usage line
   * mentioning the same path matches NEITHER idiom — and a real deploy of the
   * right bundle under the WRONG name matches neither either, which is the
   * half this guard was missing.
   */
  const deploysJob = (
    src: string,
    entry: string,
    jobBase: string,
  ): string | null => {
    const want = `dist/${entry}.js`;
    for (const site of deploySites(src)) {
      if (site.entrypoint !== want) continue;
      if (site.jobName !== `${jobBase}-\${ENV}`) continue;
      return site.idiom;
    }
    return null;
  };

  /**
   * The `for BASE in …` list from the release's job re-pin step.
   *
   * Read from the SPEC because the spec is the SUBJECT here, never the
   * expectation. Deriving the expected set from the same file is how the old
   * version of this block passed while `doc-ingest-backfill` was missing from
   * both loops: every assertion iterated a set it had just read out of the
   * thing it was checking, so deleting an entry deleted the assertion too
   * (mutation-verified — removing `doc-ingest-backfill` from both loops left
   * the cases green, the `>= 7` floors sitting one below the then-current 8).
   * The expectation now comes from workers/tsup.config.ts.
   */
  const repinBases = (spec: string): string[] => {
    const src = readFileSync(join(WORKERS, spec), "utf8");
    const m = /for BASE in ([^\n;]+);/.exec(src);
    assert.ok(m, `${spec} has no re-pin loop`);
    return m[1]!.trim().split(/\s+/);
  };

  it("[premise] the re-pin loops parse, and the two specs agree", () => {
    // A silent zero here would pass every assertion below while checking
    // nothing — the failure mode this whole file's header names.
    const prod = repinBases("cloudbuild.prod.yaml");
    const qa = repinBases("cloudbuild.qa.yaml");
    // The floor is DERIVED, never a literal. The version of this test that
    // MONEY-1317 replaced asserted `>= 7` against a loop of 8 — one below the
    // truth, so a deletion could not reach it. Subtracting the exemptions keeps
    // it exact without restating the deepEqual below.
    const floor = allScriptEntryPoints.size - Object.keys(REPIN_EXEMPT).length;
    assert.ok(
      prod.length >= floor,
      `parsed only ${prod.length} re-pin bases against ${floor} expected ` +
        `(${allScriptEntryPoints.size} tsup script entry points, ` +
        `${Object.keys(REPIN_EXEMPT).length} exempt)`,
    );
    assert.deepEqual(
      prod.slice().sort(),
      qa.slice().sort(),
      "prod and qa re-pin different job sets — one env would keep a stale image",
    );
  });

  it("EVERY tsup script entry point is in BOTH re-pin loops, or exempt", () => {
    // THE INDEPENDENT DERIVATION. `allScriptEntryPoints` is parsed from
    // workers/tsup.config.ts — "what can be handed to
    // `--command=node,dist/X.js`" — and has nothing to do with the cloudbuild
    // specs. So this goes red in BOTH directions a self-derived list could not:
    // deleting a base from the loops, and adding a tsup entry without touching
    // them.
    //
    // It is the guard that was missing. `xbrl-projection-wired.test.ts` held a
    // hardcoded EIGHT-name list which did go red on a deletion, but a
    // hand-maintained second copy can be JOINTLY incomplete with the loop it
    // describes — and was, four times over: bse-backfill and the three Tiingo
    // jobs were in neither.
    const expected = [...allScriptEntryPoints]
      .filter((e) => !(e in REPIN_EXEMPT))
      .map(jobBaseFor)
      .sort();

    for (const spec of ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"]) {
      assert.deepEqual(
        repinBases(spec).slice().sort(),
        expected,
        `${spec}'s re-pin loop is not the set of Cloud Run job entry points ` +
          "workers/tsup.config.ts builds.\n\n" +
          "A tsup entry missing from the loop is a JOB NOTHING WILL EVER " +
          "RE-PIN: it keeps the image it was provisioned with, runs last " +
          "release's code, and exits 0 (MONEY-1205, MONEY-1250, MONEY-1314, " +
          "MONEY-1317 — four times, one ticket each).\n\n" +
          "A base in the loop that is NOT a tsup entry is the other failure: " +
          "`jobs update` 404s on it every build forever, and the warning it " +
          "prints names a provisioning script for a job that does not exist.\n\n" +
          "Fix: add it to BOTH loops (under the JOB base name — see " +
          "JOB_BASE_BY_ENTRYPOINT if the job is not named after its bundle), " +
          "or add the entry point to REPIN_EXEMPT in this file WITH a reason " +
          "that distinguishes it from feed-backfill and feed-repair.",
      );
    }
  });

  it("every REPIN_EXEMPT exemption carries a real reason and a ticket", () => {
    // Same discipline as AWAITING_WIRE_UP above: an exemption without a reason
    // is indistinguishable from an oversight, which is the state this suite
    // exists to make impossible. The previous exclusion was a test COMMENT,
    // which no build could fail on and which four jobs hid behind.
    for (const [entry, why] of Object.entries(REPIN_EXEMPT)) {
      assert.ok(
        why.trim().length > 40,
        `REPIN_EXEMPT["${entry}"] needs a real reason, not a placeholder`,
      );
      assert.match(
        why,
        /MONEY-\d+/,
        `REPIN_EXEMPT["${entry}"] must cite the ticket that closes it`,
      );
    }
    assert.ok(
      Object.keys(REPIN_EXEMPT).length <= 2,
      `${Object.keys(REPIN_EXEMPT).length} entry points are exempt from re-pinning. ` +
        "At that point the loop covers less than it excuses.",
    );
  });

  it("[control] a mere MENTION of the entrypoint does not count", () => {
    // Without this the helper could degrade to `src.includes(dist)` and report
    // every script clean, which is the weaker check this test replaces.
    const mentionOnly = [
      "#   feed-repair   scripts/jobs/feed-repair.ts -> dist/feed-repair.js",
      'echo -e "   dist/feed-repair.js (workers/tsup.config.ts entry point)"',
      'ENTRYPOINT="dist/feed-repair.js"', // assigned, never handed to --command
    ].join("\n");
    assert.equal(deploysJob(mentionOnly, "feed-repair", "feed-repair"), null);
    assert.ok(
      deploysJob(
        [
          'REPAIR_JOB="feed-repair-${ENV}"',
          'deploy_job "$REPAIR_JOB" "dist/feed-repair.js" "2Gi" "86400"',
        ].join("\n"),
        "feed-repair",
        "feed-repair",
      ),
      "the helper must still recognise a real deploy_job call",
    );
  });

  it("[control] the right bundle under the WRONG job name does not count", () => {
    // The defect this case exists for. Both scripts below really do deploy
    // dist/feed-repair.js; only one of them creates the job the re-pin loop
    // will ask for. A wildcard in the name argument cannot tell them apart,
    // and that is how a renamed job stays green while the loop 404s forever.
    const renamedVar = [
      'REPAIR_JOB="feed-fixup-${ENV}"',
      'deploy_job "$REPAIR_JOB" "dist/feed-repair.js" "2Gi" "86400"',
    ].join("\n");
    assert.equal(deploysJob(renamedVar, "feed-repair", "feed-repair"), null);

    // An UNRESOLVABLE name is a miss too, never a pass: the variable the call
    // site reads was renamed out from under it.
    const danglingVar =
      'deploy_job "$REPAIR_JOB" "dist/feed-repair.js" "2Gi" "86400"';
    assert.equal(deploysJob(danglingVar, "feed-repair", "feed-repair"), null);

    // And the suffixing helper is recognised for what it is: arg 1 is a
    // SUFFIX, so this creates `tiingo-us-eod-backfill-${ENV}` and not
    // `tiingo-us-backfill-${ENV}`.
    const suffixing = [
      "deploy_job() {",
      '    local suffix="$1" entrypoint="$2"',
      '    local job_name="${suffix}-${ENV}"',
      "}",
      'deploy_job "tiingo-us-eod-backfill" "dist/tiingo-us-backfill.js" "86400" "2Gi"',
    ].join("\n");
    assert.ok(
      deploysJob(suffixing, "tiingo-us-backfill", "tiingo-us-eod-backfill"),
      "the suffixing deploy_job contract must be recognised",
    );
    assert.equal(
      deploysJob(suffixing, "tiingo-us-backfill", "tiingo-us-backfill"),
      null,
      "the entry-point name is NOT the job name here — that is the whole point",
    );
  });

  it("every job in the release re-pin loop has a script that deploys it", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const base of repinBases("cloudbuild.prod.yaml")) {
      // The loop speaks JOB BASE; SETUP_SCRIPT_BY_ENTRYPOINT speaks TSUP ENTRY
      // POINT. Translating explicitly keeps the two vocabularies apart instead
      // of adding a job name to a map keyed on entry points, which is how a
      // tripwire ends up pinned to the wrong artifact.
      const entry = entryForJobBase.get(base);
      if (entry === undefined) {
        offenders.push(`${base} -> no tsup entry point builds this job`);
        continue;
      }
      const path = setupScriptFor(entry);
      if (!path.startsWith("scripts/ops/")) {
        offenders.push(`${base} -> UNMAPPED in SETUP_SCRIPT_BY_ENTRYPOINT`);
        continue;
      }
      const file = join(ROOT, path);
      if (!existsSync(file)) {
        offenders.push(`${base} -> ${path} does not exist`);
        continue;
      }
      checked++;
      if (!deploysJob(readFileSync(file, "utf8"), entry, base)) {
        offenders.push(
          `${base} -> ${path} never deploys dist/${entry}.js as ${base}-\${ENV}`,
        );
      }
    }

    assert.equal(
      checked,
      repinBases("cloudbuild.prod.yaml").length,
      `only ${checked} of the re-pin loop's jobs reached the deploy check`,
    );
    assert.deepEqual(
      offenders,
      [],
      "A job the release re-pins names a provisioning script that will not " +
        "create it UNDER THAT NAME. `jobs update` fails on a job that does " +
        "not exist, so the release warns and points the operator at this " +
        "script — which then succeeds while provisioning something else " +
        "entirely.\n  " +
        offenders.join("\n  "),
    );
  });

  it("and so does every OTHER mapped Cloud Run job entry point", () => {
    // The loop is where the gap was found; the map is where the same gap can
    // next appear. Today the two sets are identical (REPIN_EXEMPT is empty),
    // so this is a belt-and-braces pass over the map — and it stays here
    // because an exemption added later would land in exactly this gap.
    const offenders: string[] = [];
    for (const ep of allScriptEntryPoints) {
      const path = setupScriptFor(ep);
      if (!path.startsWith("scripts/ops/")) continue;
      const file = join(ROOT, path);
      if (!existsSync(file)) continue; // covered by the existence test above
      if (!deploysJob(readFileSync(file, "utf8"), ep, jobBaseFor(ep))) {
        offenders.push(`${ep} -> ${path} (expected ${jobBaseFor(ep)}-\${ENV})`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these entry points are mapped to a script that does not deploy them " +
        "under the expected job name. Either add the `deploy_job` / " +
        "`ENTRYPOINT=… --command=node,$ENTRYPOINT` call, re-map the entry " +
        "point to the script that really owns it, or record the real job " +
        "name in JOB_BASE_BY_ENTRYPOINT:\n  " +
        offenders.join("\n  "),
    );
  });

  /**
   * MONEY-1609 — the release's OWN remediation line names the same script.
   *
   * When `jobs update` fails, the re-pin step prints one line per job from a
   * bash `case` over the job base — a SECOND copy of SETUP_SCRIPT_BY_ENTRYPOINT
   * that nothing compared with the first. Found drifted on 2026-09-23:
   * `lake-load-databento`, `lake-release` and `event-lake-sink` all fell to `*`
   * and printed "UNMAPPED: add it to SETUP_SCRIPT_BY_ENTRYPOINT" while already
   * in it — the message the MONEY-1499 comment above that `case` says is wrong
   * in both directions at the one moment it fires.
   *
   * Evaluated the way bash does: arms in order, `|` alternatives, `*` globs,
   * first match wins.
   */
  const caseArms = (spec: string): Array<{ re: RegExp; setup: string }> => {
    const src = readFileSync(join(WORKERS, spec), "utf8");
    const start = src.indexOf('case "$${BASE}" in');
    assert.ok(start > 0, `${spec} has no remediation case`);
    const block = stripYamlComments(
      src.slice(start, src.indexOf("esac", start)),
    );
    const arms: Array<{ re: RegExp; setup: string }> = [];
    for (const m of block.matchAll(
      /^\s*([^\s)][^)\n]*)\)\s*\n?\s*SETUP="([^"]*)"\s*;;/gm,
    )) {
      const alts = m[1]!.split("|").map((p) =>
        p
          .trim()
          .replace(/[.+?^${}()[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*"),
      );
      arms.push({ re: new RegExp(`^(?:${alts.join("|")})$`), setup: m[2]! });
    }
    return arms;
  };

  it("[control] the case parser reads bash's first-match-wins order", () => {
    const arms = caseArms("cloudbuild.prod.yaml");
    assert.ok(arms.length >= 10, `parsed only ${arms.length} case arms`);
    assert.equal(
      arms.at(-1)!.setup,
      "",
      "the last arm must be the `*` fallback",
    );
    assert.ok(arms.at(-1)!.re.test("a-job-nobody-has-mapped"));
  });

  it("the re-pin step's remediation case names the mapped script, per job", () => {
    for (const spec of ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"]) {
      const arms = caseArms(spec);
      const offenders: string[] = [];
      for (const base of repinBases(spec)) {
        const entry = entryForJobBase.get(base);
        if (entry === undefined) continue; // the loop-vs-tsup test above names it
        const printed = arms.find((a) => a.re.test(base))?.setup ?? "";
        const mapped = setupScriptFor(entry).replace(/^scripts\/ops\//, "");
        if (printed !== mapped) {
          offenders.push(
            `${base}: case prints "${printed || "UNMAPPED"}", map says ${mapped}`,
          );
        }
      }
      assert.deepEqual(
        offenders,
        [],
        `${spec}: a job that fails to re-pin would be sent to the wrong script ` +
          "(or told it is unmapped while it is mapped). Add it to the `case` " +
          "in the re-pin step:\n  " +
          offenders.join("\n  "),
      );
    }
  });
});
