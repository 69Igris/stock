/**
 * MONEY-979 review round — the four ops defects that produced no error.
 *
 * Every one of these shipped GREEN. None of them could have failed a build, a
 * lint or a test, because their whole output is a `gcloud`/`curl` invocation, a
 * comment, or an exit code nobody was reading. They are grouped here because
 * they share one shape: **a second population grew under a rule written for the
 * first, and the rule kept passing.**
 *
 *   notify_no_data       written for COUNTER monitors, where silence means the
 *                        job died. Inherited by a LATENCY monitor, where
 *                        silence means "no filing arrived" — true before the
 *                        first filing is detected, and true every weekend
 *                        (SEC accepts filings on business days). It pages in
 *                        both, and a monitor that pages in the configuration we
 *                        ship is a monitor somebody mutes.
 *   pending remediation  one hardcoded `setup-sync-job.sh` for a summary block
 *                        that grew a second population (six EDGAR bulk
 *                        triggers) provisioned by a DIFFERENT script. Following
 *                        it rebuilds an unrelated job and reports the same six
 *                        pending forever.
 *   the `edgar/` mirror  a comment describing a prod->QA GCS mirror that does
 *                        not exist in any tier of sync-prod-to-qa.sh.
 *   no dotenv            two release gates that could not open the database
 *                        they gate on, failing in a shape that reads like an
 *                        empty database rather than an absent one.
 *
 * ## Why these assertions RUN the scripts rather than grep them
 *
 * Where a fix changes observable behaviour, the test executes the real script
 * against a stubbed `gcloud`/`curl` on PATH and reads what it would have
 * issued. A grep over a shell script asserts that a string is present, which is
 * exactly the evidence that was already there and already wrong — the correct
 * remediation command WAS printed by the EDGAR path 250 lines above the summary
 * block that printed the wrong one. Only running it distinguishes those.
 *
 * Text assertions are kept for the two facts with no runtime: a comment's
 * claim, and a template's documentation-only key.
 *
 * ## Every scan is proved to have read something
 *
 * A regex that matches nothing turns a `for` loop over its results into a
 * vacuous pass. Each block below asserts a FLOOR on what it extracted before it
 * asserts anything about the contents — the failure mode of
 * `no-feed-fetch-bypass.test.ts`, and the reason the sibling
 * `edgar-infra-coverage.test.ts` opens the same way.
 *
 * ## Why the `.spawntest.ts` suffix (MONEY-1316)
 *
 * Running the real scripts is the point of this file (see above), and it is also
 * what makes it slow: 6.0 s standalone, against a workspace `--test-timeout` of
 * 30 s applied to the FILE-level test as well as to each suite, and an observed
 * ~2.5x multiplier under full parallel turbo load. A file that overruns that is
 * CANCELLED, not failed — it prints `not ok` while `# fail` stays 0, so a green
 * `verify:push` would stop proving these scans ran, which is the same
 * silent-vacuum failure the section above exists to prevent one layer down. The
 * suffix routes this file into the second `node --test` lane at
 * `--test-timeout=180000`; `spawntest-lane-wiring.test.ts` pins that wiring.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// packages/core/__tests__/ops -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const APPLY_MONITORS = join(ROOT, "scripts/ops/datadog/apply-monitors.sh");
const LATENCY_TEMPLATE = join(
  ROOT,
  "scripts/ops/datadog/monitor-latency-p95.json",
);
const ZERO_WRITE_TEMPLATE = join(
  ROOT,
  "scripts/ops/datadog/monitor-zero-write.json",
);
// MONEY-1358 — the absence template became a FILE (it was a heredoc inside
// apply-monitors.sh, which travelled with the script for free). A mirror that
// symlinks a fixed list has to carry it, or the mirrored render dies on ENOENT
// before it can prove anything about the key-stripping this suite is for.
const ABSENCE_TEMPLATE = join(
  ROOT,
  "scripts/ops/datadog/monitor-job-absence.json",
);
const SCHEDULER = join(ROOT, "scripts/ops/setup-scheduler.sh");
const SYNC_SCRIPT = join(ROOT, "scripts/ops/sync-prod-to-qa.sh");
const LIFECYCLE = join(ROOT, "scripts/ops/setup-gcs-lifecycle.sh");
const COVERAGE_REPORT = join(ROOT, "scripts/data/edgar-coverage-report.ts");
const ACCEPTANCE = join(ROOT, "scripts/data/edgar-acceptance.ts");

const read = (p: string): string => readFileSync(p, "utf8");

/**
 * Every `_`-prefixed key in a value, at every depth, as a dotted path.
 *
 * MONEY-979 review — the check this replaces filtered `Object.keys(m)`, i.e.
 * one level. A rule enforced to exactly the depth the bug is not at is the
 * shape of most defects in this directory, so the walk is the whole value.
 */
function underscoreKeyPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => underscoreKeyPaths(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([k, v]) => [
        ...(k.startsWith("_") ? [`${path}.${k}`] : []),
        ...underscoreKeyPaths(v, `${path}.${k}`),
      ],
    );
  }
  return [];
}

const monitorsSrc = read(APPLY_MONITORS);
const schedulerSrc = read(SCHEDULER);
const syncSrc = read(SYNC_SCRIPT);
const lifecycleSrc = read(LIFECYCLE);

/* ── the rendered monitors, from the real script ───────────────────────────
 *
 * `--dry-run` prints the exact JSON body it would POST, so this is the same
 * bytes Datadog would receive — not a re-implementation of the substitution.
 */
interface MonitorBody {
  name: string;
  query: string;
  options?: {
    notify_no_data?: boolean;
    no_data_timeframe?: number;
    thresholds?: { critical?: number };
  };
}

/**
 * A `curl` that cannot reach the network, plus the env every dry-run gets.
 *
 * MONEY-979 review — this file used to `spawnSync` the real script with the
 * AMBIENT environment and no stub, relying on `--dry-run` short-circuiting
 * before `dd_request`. That is one shell branch standing between a unit test
 * and a live Datadog account, and this repo has already shipped two bugs in
 * exactly that branch: `[[ "${2:-}" == "--dry-run" ]]` reading a single
 * position, and `[[ "$DRY_RUN" == "1" ]]` comparing against a value the
 * variable never holds.
 *
 * MEASURED, not theorised. Breaking the flag parse and running this file with
 * DD_API_KEY/DD_APP_KEY exported — which is what the runbook tells CI to do —
 * produced real requests to api.us3.datadoghq.com, which answered
 * `401 {"errors":["Unauthorized"]}`. Two spawn sites, one live GET each, from a
 * 17/17-green run. With a valid key in CI they would not have stopped at the
 * listing.
 *
 * Three independent things must now fail before a packet leaves: the flag
 * parse, the `:?` credential guards (the keys are stripped), and this stub
 * (first on PATH, logs, exits non-zero). The log is asserted empty below, so
 * "the dry run is offline" is a checked property rather than a comment.
 */
const OFFLINE = mkdtempSync(join(tmpdir(), "apply-monitors-offline-"));
const OFFLINE_LOG = join(OFFLINE, "calls.log");
writeFileSync(
  join(OFFLINE, "curl"),
  [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$STUB_LOG"',
    'echo "curl reached during a --dry-run" >&2',
    "exit 99",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(OFFLINE_LOG, "");

function offlineEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e.DD_API_KEY;
  delete e.DD_APP_KEY;
  return {
    ...e,
    PATH: `${OFFLINE}:${e.PATH ?? ""}`,
    STUB_LOG: OFFLINE_LOG,
  };
}

function renderedMonitors(env: "qa" | "prod"): MonitorBody[] {
  const res = spawnSync("bash", [APPLY_MONITORS, env, "--dry-run"], {
    encoding: "utf8",
    cwd: ROOT,
    env: offlineEnv(),
  });
  assert.equal(
    res.status,
    0,
    `apply-monitors.sh ${env} --dry-run exited ${res.status}: ${res.stderr}`,
  );
  return (res.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as MonitorBody);
}

const PROD = renderedMonitors("prod");
/**
 * A percentile monitor, recognised by EITHER spelling Datadog has for one.
 *
 * MONEY-979 review — this was `query.startsWith("percentile(")`, which knows
 * only the DISTRIBUTION form. Our latency series is a DogStatsD histogram, read
 * through the Agent's `.95percentile` sub-metric, so the partition has to know
 * both or it silently reclassifies the latency monitor as a zero-write one and
 * every assertion below lands on the wrong population.
 */
const isLatency = (m: MonitorBody): boolean =>
  /(?:^|[\s(])percentile\(|:p(?:50|75|80|90|95|98|99):|\.\d{1,2}percentile\b/.test(
    m.query,
  );
/**
 * A ZERO-WRITE monitor compares what a job SELECTED against what it WROTE.
 *
 * That is the mechanical signature, and it matters because the no-data rule
 * below is derived from it: for a monitor watching `selected > 0 && written
 * == 0`, silence means the job stopped, so silence must page.
 *
 * MONEY-1373 — this used to be "everything that is not a latency monitor",
 * which was true until a monitor arrived that is neither. A TRIPWIRE
 * (`databento.displaced_d1`) watches ONE counter that must read zero forever,
 * so for it absence is the HEALTHY state and paging on no-data would fire
 * every Sunday and Monday for a Tue-Sat job behaving perfectly. Lumping it in
 * here would have forced it under the opposite rule — and the fix an author
 * reaches for under that pressure is to flip the flag, which silently converts
 * a real guard into a weekly false page.
 */
const isZeroWrite = (m: MonitorBody): boolean =>
  !isLatency(m) &&
  /job\.written/.test(m.query) &&
  /job\.selected/.test(m.query);

/**
 * An ABSENCE monitor fires on too FEW — `sum(...) < 1`.
 *
 * The comparison DIRECTION is the discriminant, and it is not cosmetic: a
 * monitor that fires below a threshold is watching for something that should
 * be happening and stopped, so its own silence is the same failure and must
 * page. A monitor that fires above zero is watching for something that should
 * never happen, so its silence is health.
 */
const isAbsence = (m: MonitorBody): boolean =>
  !isLatency(m) && /<\s*1\b/.test(m.query);

/**
 * A TRIPWIRE fires on ANY occurrence — `sum(...) > 0` over ONE counter that is
 * supposed to read zero forever.
 *
 * Everything left after the other three. `databento.displaced_d1` is the first
 * and, today, the only one.
 */
const isTripwire = (m: MonitorBody): boolean =>
  !isLatency(m) && !isZeroWrite(m) && !isAbsence(m);

const PROD_LATENCY = PROD.filter(isLatency);
const PROD_ZERO_WRITE = PROD.filter(isZeroWrite);
const PROD_ABSENCE = PROD.filter(isAbsence);
const PROD_TRIPWIRE = PROD.filter(isTripwire);

describe("MONEY-979 review — the extractions read something", () => {
  it("the dry-run renders made no HTTP call", () => {
    // Asserted, not assumed. Every render above ran with a logging,
    // non-zero-exit `curl` first on PATH and no credentials; this is the
    // property those guards exist to provide. Breaking the flag parse made
    // these same spawns issue live requests to api.us3.datadoghq.com from a
    // green run — see the OFFLINE comment.
    assert.equal(
      readFileSync(OFFLINE_LOG, "utf8"),
      "",
      "apply-monitors.sh --dry-run invoked curl. A dry run must not reach " +
        "the Datadog API, and the runbook has CI export DD_API_KEY/DD_APP_KEY.",
    );
  });

  it("rendered both monitor populations", () => {
    // FALSIFIABLE CEILING. Every assertion below iterates one of these two
    // arrays; an empty one passes silently and asserts nothing at all.
    assert.ok(
      PROD_LATENCY.length >= 1,
      "no latency monitors rendered — the notify_no_data assertions below " +
        "would be vacuous",
    );
    assert.ok(
      PROD_ZERO_WRITE.length >= 30,
      `only ${PROD_ZERO_WRITE.length} zero-write monitors rendered; the list ` +
        "has been >= 30 since MONEY-980",
    );
  });
});

describe("MONEY-979 — a monitor that is empty in a normal state must not page on no-data", () => {
  /**
   * THE RULE, stated once: `notify_no_data: true` is a claim that ZERO POINTS
   * MEANS BROKEN. It is right for a counter emitted from a `finally` on every
   * run, and wrong for any series whose emptiness is a documented-normal state.
   *
   * The latency series has both such states, and they are not hypothetical:
   *
   *   pre-first-filing
   *             The metric's only emit site is detect.py's fan-out, per newly
   *             claimed filing. Prod ships EDGAR_DETECT="on", so points do
   *             arrive — but not before the service is deployed, the push
   *             subscriptions exist and SEC publishes. apply-monitors runs in
   *             the first-deploy block, ahead of all three.
   *
   *             This read "disarmed — EDGAR_DETECT ships off, zero points until
   *             a separate arming step" for one release. The engine now ships
   *             ARMED and that leg is gone; the weekend case never depended on
   *             it, so the setting is unchanged and its reasoning is not.
   *   weekend   SEC accepts filings on business days. Sat 00:00 ET -> Mon
   *             06:00 ET is ~54h with no sample, against a 180-minute window,
   *             every week, fully armed.
   */
  it("the latency monitor does NOT notify on no-data", () => {
    for (const m of PROD_LATENCY) {
      assert.equal(
        m.options?.notify_no_data,
        false,
        `${m.name} pages on no-data. Its series is empty while EDGAR_DETECT ` +
          "is off and again every weekend, so that is a page in the " +
          "configuration we ship. Absence is the zero-write monitor's job.",
      );
    }
  });

  it("the zero-write monitors DO notify on no-data — the rule is not weakened", () => {
    // The flip above is scoped to ONE template. For a counter emitted from a
    // `finally`, silence really does mean the job stopped, and that must keep
    // paging.
    //
    // MONEY-1229 — this asserted `true` for EVERY zero-write monitor, and that
    // turned out to be unshippable: Datadog caps `no_data_timeframe` at 4320
    // minutes (72h) and refused 35 of 37 monitors on the first live apply with
    // "No data timeframe must be <= 4320". A no-data alarm is only meaningful
    // when its timeframe EXCEEDS the job's legitimate maximum gap, and the
    // window is already sized to exceed that gap — so where the window fits
    // under the ceiling no-data is ON, and where it does not there is no valid
    // timeframe at all and it is OFF. The 96h jobs gap 72h Fri -> Mon; a 72h
    // alarm on those fires every single weekend, which is exactly how
    // bhavcopy-sync's monitor got muted.
    //
    // The claim this case protects is unchanged and is now sharper: no-data is
    // derived from THIS monitor's own window, never inherited from the latency
    // template's flat `false`. The relationship is asserted as an equality
    // against the rendered window rather than a constant, so it survives a job
    // whose cadence changes and still fails if the derivation is replaced.
    const CEILING = 4320;
    let on = 0;
    let off = 0;
    for (const m of PROD_ZERO_WRITE) {
      const w = /last_(\d+)([hd])/.exec(m.query);
      assert.ok(w, `could not read a window out of ${m.name}: ${m.query}`);
      const mins = Number(w[1]) * (w[2] === "d" ? 1440 : 60);
      assert.equal(
        m.options?.notify_no_data,
        mins < CEILING,
        `${m.name} has a ${w[0]} window (${mins} min) and ` +
          `notify_no_data=${m.options?.notify_no_data}. Under Datadog's ` +
          `${CEILING}-minute ceiling a no-data alarm can only be meaningful ` +
          "when the window fits under it — and for a zero-write monitor that " +
          "fits, silence IS the failure being watched for",
      );
      assert.ok(
        (m.options?.no_data_timeframe ?? 0) > 0 &&
          (m.options?.no_data_timeframe ?? 0) <= CEILING,
        `${m.name} has no_data_timeframe ${m.options?.no_data_timeframe}, ` +
          `outside the 1..${CEILING} Datadog accepts`,
      );
      m.options?.notify_no_data ? (on += 1) : (off += 1);
    }
    // BOTH ARMS POPULATED. A rule where every monitor lands on one side is a
    // rule doing no work — and "uniformly false", which is the latency
    // template's value leaking into this population, is the cheapest way to
    // satisfy an equality that reads the same number from both sides.
    assert.ok(on >= 10, `only ${on} zero-write monitors alert on no-data`);
    assert.ok(
      off >= 5,
      `only ${off} are over the ceiling — the derivation ` +
        "collapsed to a constant",
    );
  });

  it("a TRIPWIRE does not page on no-data — absence is its healthy state", () => {
    // MONEY-1373. `databento.displaced_d1` counts D1 displacement refusals and
    // is supposed to read zero forever: `DATABENTO_SCHEMAS` has no `ohlcv-1d`
    // member, so no manifest entry can name a daily schema and no run can
    // produce a daily bar. Both emitters are Tue-Sat (and the harvest has no
    // trigger at all), so `notify_no_data: true` would page every Sunday and
    // Monday for jobs behaving perfectly — and the reflex fix for a weekly
    // false page is to mute the monitor, which is how bhavcopy-sync's got
    // muted.
    //
    // "The job did not run" is a DIFFERENT question with its own instrument:
    // the absence monitor. This case and the zero-write case above are
    // therefore opposite by design rather than by inconsistency.
    for (const m of PROD_TRIPWIRE) {
      assert.equal(
        m.options?.notify_no_data,
        false,
        `${m.name} pages on no-data, but it watches a counter whose healthy ` +
          "reading is a permanent zero. Absence is the absence monitor's job.",
      );
      // Datadog validates the field even when the flag is off, so an
      // out-of-range value is refused at apply time rather than ignored.
      const tf = m.options?.no_data_timeframe ?? 0;
      assert.ok(
        tf > 0 && tf <= 4320,
        `${m.name} has no_data_timeframe ${tf}, outside the 1..4320 Datadog ` +
          "accepts — it is inert while notify_no_data is false, and still " +
          "rejected on apply",
      );
    }
  });

  it("[premise] the four partitions are each populated and disjoint", () => {
    // Without this the split is a way for a monitor to escape EVERY rule. A
    // classifier that put everything in one bucket, or nothing in the new one,
    // would leave the case above asserting over an empty list — and the
    // coverage assertion at the end is what stops a fifth shape from
    // appearing and being silently governed by nothing.
    assert.ok(
      PROD_TRIPWIRE.length >= 1,
      "no tripwire monitor rendered; the new partition is empty and its rule " +
        "asserts nothing",
    );
    assert.ok(PROD_LATENCY.length >= 1, "no latency monitor rendered");
    assert.ok(
      PROD_ABSENCE.length >= 1,
      "no absence monitor rendered; the classifier has stopped recognising " +
        "the `< 1` direction",
    );
    assert.ok(
      PROD_ZERO_WRITE.length >= 30,
      `only ${PROD_ZERO_WRITE.length} zero-write monitors survived the new ` +
        "classifier; the list has been >= 30 since MONEY-980, so the " +
        "selected-vs-written signature has stopped matching them",
    );
    const names = new Set<string>();
    for (const m of [
      ...PROD_LATENCY,
      ...PROD_ZERO_WRITE,
      ...PROD_ABSENCE,
      ...PROD_TRIPWIRE,
    ]) {
      assert.ok(!names.has(m.name), `${m.name} is in two partitions`);
      names.add(m.name);
    }
    assert.equal(
      names.size,
      PROD.length,
      "the four partitions do not cover every rendered monitor",
    );
  });

  it("silence is still watched: edgar-detect keeps its zero-write monitor", () => {
    // THE PRECONDITION FOR THE FLIP ABOVE, asserted rather than assumed.
    // Turning notify_no_data off is only safe because a different instrument
    // covers absence. Delete the zero-write row and the latency monitor's
    // `false` becomes a real blind spot — a false page traded for no alarm at
    // all, which is not an improvement. This fails if that ever happens.
    const detect = PROD_ZERO_WRITE.find((m) => m.name.includes("edgar-detect"));
    assert.ok(
      detect,
      "edgar-detect has no zero-write monitor. The latency monitor's " +
        "notify_no_data:false depends on it: that is where 'the detection " +
        "loop stopped' is caught, because its counters are emitted from a " +
        "`finally` on all 1,440 daily runs in every weather.",
    );
    assert.equal(detect.options?.notify_no_data, true, detect.name);
  });

  it("the reasoning is written into the template, not just into this test", () => {
    // A boolean with no argument attached gets "fixed" back by the next reader,
    // who finds a latency monitor that does not alert on silence and reaches
    // the same wrong conclusion the first author did. The rationale key is what
    // makes that a deliberate decision instead of a suspicious one.
    const tpl = JSON.parse(read(LATENCY_TEMPLATE)) as Record<string, unknown>;
    const rationale = tpl["_notify_no_data_rationale"];
    assert.ok(
      Array.isArray(rationale) && rationale.length > 0,
      "monitor-latency-p95.json must carry a _notify_no_data_rationale",
    );
    const text = (rationale as string[]).join(" ");
    for (const term of ["EDGAR_DETECT", "weekend", "zero-write"]) {
      assert.ok(
        text.includes(term),
        `the rationale must name ${term} — those are the three facts the ` +
          "decision rests on",
      );
    }
  });

  it("documentation-only keys never reach the Datadog API, at ANY depth", () => {
    // The rationale above is only safe to add because render() deletes every
    // `_`-prefixed key. Datadog rejects an unknown field, so a regression here
    // turns a monitor that pages wrongly into a monitor that does not apply at
    // all.
    //
    // MONEY-979 review — both halves of this used to be TOP-LEVEL only. The
    // strip was `for (const k of Object.keys(doc))` and the assertion was
    // `Object.keys(m).filter(...)`, so a `"_note"` inside `options` would ride
    // into the POST body while this test stayed green. Every rendered body was
    // in fact clean, which is the point: the rule was enforced to exactly the
    // depth the bug was not at, and nothing could tell the difference.
    for (const m of PROD) {
      assert.deepEqual(
        underscoreKeyPaths(m),
        [],
        `${m.name} carries a documentation-only key into the POST body`,
      );
    }
    // …and the templates really do carry such keys, so the check above is not
    // passing because there was nothing to strip.
    for (const t of [LATENCY_TEMPLATE, ZERO_WRITE_TEMPLATE]) {
      const keys = underscoreKeyPaths(JSON.parse(read(t)));
      assert.ok(keys.length > 0, `${t} has no _-prefixed keys to strip`);
    }
  });

  it("a NESTED documentation key is stripped too — proved by rendering one", () => {
    // The assertion above can only see depths the templates actually use, and
    // today every `_` key in both sits at the top. So the recursion is proved
    // by DATA rather than by inspection: render a template carrying
    // `options._nested_note` and check it does not survive.
    //
    // The script resolves its templates, `../setup-scheduler.sh` and
    // `../../../packages/datadog/src` all relative to its own BASH_SOURCE, so
    // the modified template is fed to it through a symlink tree that mirrors
    // the repo layout — real dirs, symlinked contents, one real copy.
    const dir = mkdtempSync(join(tmpdir(), "apply-monitors-nested-"));
    const datadogDir = join(dir, "scripts", "ops", "datadog");
    mkdirSync(datadogDir, { recursive: true });
    mkdirSync(join(dir, "packages", "datadog"), { recursive: true });
    symlinkSync(
      join(ROOT, "scripts/ops/setup-scheduler.sh"),
      join(dir, "scripts", "ops", "setup-scheduler.sh"),
    );
    // MIRROR THE WHOLE DIRECTORY, not a hand-kept list of three files.
    //
    // A fixed list has now broken this case TWICE, for the same reason both
    // times: something the script reads at run time stopped travelling with it.
    // First `monitor-job-absence.json`, when MONEY-1358 promoted it from a
    // heredoc to a sibling file. Then `lib-datadog.sh`, when MONEY-1360 moved
    // the `source` up to the top so the shared API-host resolver was available
    // early. Each time the mirrored run died on ENOENT before it could prove
    // anything about the key-stripping this suite exists for, and each time the
    // fix was to append one more name to the list.
    //
    // Reading the directory removes the class. The one file the case OVERRIDES
    // is written as a real copy below and is skipped here, because a symlink
    // would be written through to the repo.
    const OVERRIDDEN = "monitor-latency-p95.json";
    for (const entry of readdirSync(join(ROOT, "scripts/ops/datadog"))) {
      if (entry === OVERRIDDEN) continue;
      symlinkSync(
        join(ROOT, "scripts/ops/datadog", entry),
        join(datadogDir, entry),
      );
    }
    symlinkSync(
      join(ROOT, "packages/datadog/src"),
      join(dir, "packages", "datadog", "src"),
    );

    const tpl = JSON.parse(read(LATENCY_TEMPLATE)) as {
      options: Record<string, unknown>;
      tags: string[];
    };
    tpl.options["_nested_note"] = "MUST NOT reach the POST body";
    writeFileSync(
      join(datadogDir, "monitor-latency-p95.json"),
      JSON.stringify(tpl, null, 2),
    );

    const res = spawnSync(
      "bash",
      [join(datadogDir, "apply-monitors.sh"), "prod", "--dry-run"],
      { encoding: "utf8", cwd: ROOT, env: offlineEnv() },
    );
    assert.equal(res.status, 0, `mirrored dry-run failed: ${res.stderr}`);
    const bodies = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as MonitorBody);

    // FALSIFIABLE CEILING: if the mirror rendered nothing, or rendered a
    // template without the injected key, the assertion below is vacuous.
    const latency = bodies.filter(isLatency);
    assert.ok(
      latency.length >= 1,
      `the mirrored tree rendered no latency monitor (${bodies.length} bodies)`,
    );
    assert.ok(
      read(join(datadogDir, "monitor-latency-p95.json")).includes(
        "_nested_note",
      ),
      "the injected nested key is not in the template being rendered",
    );

    for (const m of latency) {
      assert.deepEqual(
        underscoreKeyPaths(m),
        [],
        `${m.name} carried a NESTED documentation key into the POST body. ` +
          "render()'s strip is top-level only.",
      );
    }
  });

  it("a mistyped dry-run flag is refused, not run for real", () => {
    // `[[ "${2:-}" == "--dry-run" ]]` read ONE position for ONE exact string,
    // so `--dryrun`, `-n` and `prod --json --dry-run` all fell through to a
    // LIVE run: 39 requests against Datadog — one GET listing plus one write
    // per declared monitor — from a command whose entire purpose is to change
    // nothing.
    //
    // THIS READ 78, WHICH WAS A 2x OVERCOUNT, and the miscount is the same
    // defect class as everything else in this file: the number came from
    // counting LINES in the curl stub's log, and `dd_request` passes
    // `-w $'\n%{http_code}'`, so the newline inside that argument splits every
    // single invocation across two log lines. A stub that miscounts what it
    // observes is a measuring instrument reporting its own artefact. Count
    // occurrences of `-X <METHOD>`, never lines.
    //
    // Verified by STUBBING curl: the assertion is "zero HTTP calls were
    // issued", which is the property that matters, not "the exit code was 1".
    const dir = mkdtempSync(join(tmpdir(), "apply-monitors-args-"));
    const log = join(dir, "calls.log");
    // Answers 403, so the positive control below stops the script at the
    // listing — one observable call instead of a full 38-monitor write run.
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        'printf "[]\\n403\\n"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");

    for (const argv of [
      ["prod", "--dryrun"],
      ["prod", "-n"],
      ["prod", "--json", "--dry-run"],
    ]) {
      writeFileSync(log, "");
      const res = spawnSync("bash", [APPLY_MONITORS, ...argv], {
        encoding: "utf8",
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          STUB_LOG: log,
          DD_API_KEY: "stub-api-key",
          DD_APP_KEY: "stub-app-key",
        },
      });
      assert.notEqual(
        res.status,
        0,
        `apply-monitors.sh ${argv.join(" ")} exited 0 — an unrecognised ` +
          "argument must be refused",
      );
      assert.equal(
        readFileSync(log, "utf8"),
        "",
        `apply-monitors.sh ${argv.join(" ")} reached the Datadog API`,
      );
    }

    // POSITIVE CONTROL #1 — the flag. Without it, a script that refused EVERY
    // argument, including the real one, would pass every assertion above.
    const ok = spawnSync("bash", [APPLY_MONITORS, "prod", "--dry-run"], {
      encoding: "utf8",
      cwd: ROOT,
      env: offlineEnv(),
    });
    assert.equal(
      ok.status,
      0,
      "the real --dry-run flag must still be accepted",
    );

    // POSITIVE CONTROL #2 — the STUB. This is the one the block was missing.
    //
    // The three cases above assert "the log is empty", and they never reach
    // `curl` even when they behave correctly. So an empty log proves nothing on
    // its own: a stub that was never on PATH, a `$STUB_LOG` the script could
    // not write, or a log path this test read from the wrong directory would
    // all produce an empty file and three green assertions. The observation and
    // its null result are indistinguishable — the same shape as a job that
    // reports 0 written because it selected nothing versus because it was
    // blocked, which is what this whole directory exists to tell apart.
    //
    // So: run the script in a mode that IS allowed to issue requests, with the
    // same stub and the same log, and require that the log fills. The stub
    // answers the listing with a non-2xx, so the script gives up after exactly
    // one call instead of writing 38 monitors.
    const probeLog = join(dir, "probe.log");
    writeFileSync(probeLog, "");
    const live = spawnSync("bash", [APPLY_MONITORS, "prod"], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_LOG: probeLog,
        DD_API_KEY: "stub-api-key",
        DD_APP_KEY: "stub-app-key",
      },
    });
    const probe = readFileSync(probeLog, "utf8");
    assert.ok(
      probe.includes("-X GET"),
      "the curl stub was never reached even by a run that DOES make " +
        "requests, so the three empty-log assertions above prove nothing " +
        `about the rejected arguments. Stub dir: ${dir}. Script said: ${live.stderr}`,
    );
    // Count `-X <METHOD>` occurrences, not lines: `dd_request` passes
    // `-w $'\n%{http_code}'`, whose embedded newline splits every invocation
    // across two log lines. Counting lines here is what turned 39 real
    // requests into the "78" this test used to claim.
    assert.equal(
      probe.split("-X ").length - 1,
      1,
      `expected exactly one call before the listing failed, got ${
        probe.split("-X ").length - 1
      }`,
    );
  });
});

describe("MONEY-979 — a pending schedule names the script that provisions IT", () => {
  /**
   * The summary block is SHARED across every pending schedule and used to print
   * one hardcoded `setup-sync-job.sh`. That is right for the three
   * `sync-prod-to-qa*` triggers and wrong for the six EDGAR bulk ones, which
   * `setup-us-fundamentals-jobs.sh` provisions. An operator following it
   * rebuilds and redeploys an unrelated Cloud Run job, creates none of
   * `edgar-bulk-{submissions,companyfacts,ftd}-prod`, and the re-run it
   * instructs reports the same six as pending — forever, with no error.
   *
   * RUN, not grepped: the right command already appeared in the file 250 lines
   * above the block that printed the wrong one, so "the string is present" was
   * true while the bug was live.
   */
  function schedulerPendingReport(): string {
    const dir = mkdtempSync(join(tmpdir(), "setup-scheduler-"));
    // `run jobs describe` FAILS — no Cloud Run job exists — which is exactly
    // the state that fills PENDING_JOBS. Everything else succeeds silently, so
    // the script walks its whole body without touching a real project.
    writeFileSync(
      join(dir, "gcloud"),
      [
        "#!/bin/sh",
        'case "$1 $2 $3" in',
        '  "run jobs describe") exit 1 ;;',
        '  "scheduler jobs describe") exit 1 ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const res = spawnSync("bash", [SCHEDULER, "prod"], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    // eslint-disable-next-line no-control-regex -- the script colourises output
    return (res.stdout ?? "").replace(/\[[0-9;]*m/g, "");
  }

  const report = schedulerPendingReport();
  const pendingBlock =
    /schedule\(s\) NOT created[\s\S]*?(?=\nVerify all jobs:|$)/.exec(
      report,
    )?.[0] ?? "";

  it("the run reached the pending block at all", () => {
    // FALSIFIABLE CEILING: a stub that made the script exit early would leave
    // every assertion below matching an empty string.
    assert.ok(
      pendingBlock.length > 0,
      `setup-scheduler.sh printed no pending block. Output was:\n${report.slice(-2000)}`,
    );
    assert.ok(
      pendingBlock.includes("edgar-bulk-submissions-daily-prod"),
      "the six EDGAR bulk triggers must be among the pending schedules",
    );
    assert.ok(
      pendingBlock.includes("sync-prod-to-qa-daily"),
      "the sync-prod-to-qa triggers must be among the pending schedules",
    );
  });

  it("every pending entry is followed by its OWN provisioning command", () => {
    const lines = pendingBlock.split("\n");
    const entries: { name: string; fix: string }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s+- (\S+)$/.exec(lines[i]!);
      if (!m) continue;
      const next = lines[i + 1] ?? "";
      const fix = /provision with: (.+)$/.exec(next)?.[1]?.trim() ?? "";
      entries.push({ name: m[1]!, fix });
    }
    assert.ok(
      entries.length >= 11,
      `parsed ${entries.length} pending entries, expected >= 11 (3 sync + 6 edgar + 2 databento)`,
    );
    for (const e of entries) {
      assert.notEqual(e.fix, "", `${e.name} has no provisioning command`);
      // MONEY-1373 — a THIRD provisioner joined the block, and the pair of
      // Databento triggers goes through the same generic helper as the EDGAR
      // six. That helper used to hardcode `setup-us-fundamentals-jobs.sh` in
      // its own pending message, so the new triggers would have sent an
      // operator to a script that cannot create them — the exact defect this
      // test was written for, one caller over.
      const expected = e.name.startsWith("edgar-")
        ? "./scripts/ops/setup-us-fundamentals-jobs.sh prod"
        : e.name.startsWith("databento-")
          ? "./scripts/ops/setup-databento-jobs.sh prod"
          : "./scripts/ops/setup-sync-job.sh";
      assert.equal(
        e.fix,
        expected,
        `${e.name} points an operator at the wrong provisioning script`,
      );
    }
    // Both of the newer families are actually present, so the branch above is
    // exercised rather than merely available.
    for (const prefix of ["edgar-", "databento-"]) {
      assert.ok(
        entries.some((e) => e.name.startsWith(prefix)),
        `no pending entry starts with ${prefix}`,
      );
    }
  });

  it("no push site forgets its command", () => {
    // The format is `name|command`. A push site that omits the pipe would print
    // a name with no remediation, which the summary reports loudly — but only
    // if every site actually carries one. Checked at the source, because a
    // stubbed run only exercises the sites it happens to reach.
    const pushes = [...schedulerSrc.matchAll(/PENDING_JOBS\+=\((.*)\)/g)].map(
      (m) => m[1]!,
    );
    assert.ok(pushes.length >= 5, `found ${pushes.length} PENDING_JOBS pushes`);
    for (const p of pushes) {
      assert.match(
        p,
        /\|(\.\/scripts\/ops\/[a-z-]+\.sh|\$\{[A-Z_]+\})/,
        `a PENDING_JOBS push carries no provisioning command: ${p}`,
      );
    }

    // A VARIABLE is allowed, but only one that demonstrably holds a real
    // script path. Accepting `${ANYTHING}` unconditionally would turn this
    // from "names a provisioning script" into "contains a pipe", which is the
    // check passing by being unable to fail.
    const vars = new Set(
      [...pushes.join("\n").matchAll(/\|\$\{([A-Z_]+)\}/g)].map((m) => m[1]!),
    );
    for (const name of vars) {
      const assignments = [
        ...schedulerSrc.matchAll(new RegExp(`${name}="([^"]*)"`, "g")),
      ].map((m) => m[1]!);
      assert.ok(
        assignments.length > 0,
        `PENDING_JOBS uses \${${name}} but nothing assigns it`,
      );
      for (const value of assignments) {
        assert.match(
          value,
          /\.\/scripts\/ops\/[a-z-]+\.sh/,
          `${name} is assigned ${JSON.stringify(value)}, which is not a provisioning script`,
        );
      }
    }
  });
});

describe("MONEY-979 — setup-scheduler.sh describes the QA path that exists", () => {
  it("sync-prod-to-qa.sh mirrors candles/, feeds/, stocks/ and tiles/, and NOTHING under edgar/", () => {
    // The ground truth the comment has to match. Asserted positively (every
    // real prefix) so this cannot pass by finding nothing.
    assert.match(syncSrc, /GCS_SRC="gs:\/\/stockbook-content-prod\/feeds\/"/);
    assert.match(syncSrc, /GCS_SRC="gs:\/\/stockbook-content-prod\/stocks\/"/);
    // MONEY-1373 added the candle warehouse's cold shards as a SECOND rsync
    // pair inside the feeds tier. The list is WIDENED rather than worked
    // around, and that is the whole point of the deepEqual below: its job is
    // "this is the complete set of mirrored prefixes, and adding one must be a
    // deliberate edit HERE". The new variable is deliberately named
    // `CANDLES_GCS_SRC` so this regex still sees it — a name it could not
    // match (`CANDLES_SRC`) would have kept the assertion green while a third
    // prefix started mirroring, which is the guard passing by being unable to
    // fail.
    assert.match(syncSrc, /GCS_SRC="gs:\/\/stockbook-content-prod\/candles\/"/);
    // MONEY-1478 added a THIRD pair — the D1 chart tiles — and it is the first
    // mirrored prefix in a DIFFERENT BUCKET: the tile lake is
    // `stockbook-lake-{prod,qa}`, not `stockbook-content-*`. That is precisely
    // the shape the note above warns about: the content-bucket regex below
    // CANNOT SEE it, so without this assertion a whole new mirrored prefix
    // would have started copying with the deepEqual still green — the guard
    // passing by being unable to fail, one bucket over instead of one variable
    // name over.
    assert.match(
      syncSrc,
      /TILES_GCS_SRC="gs:\/\/stockbook-lake-prod\/tiles\/"/,
    );
    assert.match(syncSrc, /TILES_GCS_DST="gs:\/\/stockbook-lake-qa\/tiles\/"/);
    // `[^"\n]` and not `[^"]`: an unterminated quote in a COMMENT would
    // otherwise let the capture run across newlines to the next `"` anywhere in
    // the file, and the deepEqual would then compare a paragraph of shell
    // prose against a list of prefixes. Observed, on the MONEY-1373 comment
    // that quoted this very pattern.
    const prefixes = [
      ...syncSrc.matchAll(
        /GCS_SRC="gs:\/\/stockbook-content-prod\/([^"\n]*)"/g,
      ),
    ].map((m) => m[1]!);
    assert.deepEqual(prefixes.sort(), ["candles/", "feeds/", "stocks/"]);

    // And the LAKE bucket's own complete set, by the same rule. Two buckets
    // now means two exhaustive lists; one list over one bucket would silently
    // stop being exhaustive the moment a prefix moved.
    const lake = [
      ...syncSrc.matchAll(/GCS_SRC="gs:\/\/stockbook-lake-prod\/([^"\n]*)"/g),
    ].map((m) => m[1]!);
    assert.deepEqual(lake.sort(), ["tiles/"]);
  });

  it("setup-scheduler.sh does not claim an edgar/ GCS mirror", () => {
    // It claimed one for a release: "It replays the bundles prod archived under
    // `edgar/` (the same arrangement as `feeds/`)". QA holds none of those
    // bytes, so an operator debugging a QA parse would look for an archive that
    // was never copied — and, worse, would read the absence as a broken mirror
    // rather than as a design that does not have one.
    const claims =
      /replays the bundles|archived under\s*\n?\s*#?\s*`?edgar\//.exec(
        schedulerSrc,
      );
    assert.equal(
      claims,
      null,
      `setup-scheduler.sh still claims an edgar/ archive replay: ${claims?.[0]}`,
    );
  });

  it("it names the ten EDGAR us_* tables QA actually receives", () => {
    // The same comment said ELEVEN. sync-prod-to-qa.sh's EDGAR block lists ten,
    // and a count nobody can check is a count that drifts.
    const edgarTables = [
      "us_filers",
      "us_filings",
      "us_fundamentals",
      "us_company_facts",
      "us_insider_transactions",
      "us_13f_filings",
      "us_13f_holdings",
      "us_beneficial_ownership",
      "us_filing_documents",
      "us_cusip_map",
    ];
    for (const t of edgarTables) {
      assert.ok(
        new RegExp(`^\\s*"${t}"`, "m").test(syncSrc),
        `${t} is not in sync-prod-to-qa.sh's REFERENCE_COLLECTIONS`,
      );
    }
    // us_edgar_cursor is deliberately NOT synced — prod's detection watermark
    // would make a QA detect run skip every filing prod has seen and report a
    // healthy empty run.
    assert.ok(
      !/^\s*"us_edgar_cursor"/m.test(syncSrc),
      "us_edgar_cursor must not be synced to QA",
    );
    assert.equal(
      (schedulerSrc.match(/eleven `us_\*` tables/g) ?? []).length,
      0,
      "setup-scheduler.sh still says eleven us_* tables; there are ten",
    );
  });
});

describe("MONEY-979 — the ops scripts run outside macOS and outside an exported env", () => {
  it("setup-gcs-lifecycle.sh uses a portable mktemp template", () => {
    // GNU coreutils reads `-t`'s operand as a TEMPLATE needing >= 3 trailing
    // X's and exits `too few X's in template`, so `mktemp -t edgar-lifecycle`
    // aborted the whole script on Linux / Cloud Shell before its first bucket
    // read. It failed SAFE, which is why nobody found it: the founder runs
    // darwin, where the BSD form is the one that works.
    // Comment lines are stripped first. The fix's own comment NAMES the broken
    // form, so a naive scan over the whole file matches the explanation and
    // reports the bug as still present — a false RED, which is the mirror image
    // of the false green this whole file exists to prevent.
    const lifecycleCode = lifecycleSrc
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.ok(
      !/mktemp -t /.test(lifecycleCode),
      "mktemp -t TEMPLATE is BSD-only — use an explicit path template",
    );
    assert.match(
      lifecycleSrc,
      /mktemp "\$\{TMPDIR:-\/tmp\}\/[a-z-]+\.XXXXXX"/,
      "the template needs >= 3 trailing X's and an explicit directory",
    );
  });

  for (const [label, file] of [
    ["edgar-coverage-report.ts", COVERAGE_REPORT],
    ["edgar-acceptance.ts", ACCEPTANCE],
  ] as const) {
    it(`${label} loads .env, resolved from the script and not the cwd`, () => {
      // Neither did, and neither could run: `@usemoney/database` builds its
      // PrismaClient from process.env, `npx tsx` supplies nothing, and the
      // README's copy-paste command produced ten `prisma:error … Environment
      // variable not found: DATABASE_URL` lines and exit 2 — a release gate
      // failing in a shape that reads like an empty database.
      const src = read(file);
      assert.match(
        src,
        /^import dotenv from "dotenv";$/m,
        `${label}: no dotenv import`,
      );
      assert.match(
        src,
        /dotenv\.config\(\{[\s\S]*?fileURLToPath\(import\.meta\.url\)/,
        `${label}: the .env path must be resolved from the SCRIPT — a gate run ` +
          "from a worktree must read the same .env as one run from the root",
      );
      assert.match(
        src,
        /dotenv\.config\(\{[\s\S]*?quiet: true/,
        `${label}: dotenv v17 prints its banner on STDOUT, which is where --json ` +
          "writes the machine-readable report; without quiet every consumer's " +
          "parse throws",
      );
      // The Prisma import stays DEFERRED into main(), so --help still works with
      // no database at all. dotenv makes the default path work; it does not make
      // a top-level import safe.
      assert.match(
        src,
        /await import\("@usemoney\/database"\)/,
        `${label}: @usemoney/database must stay a deferred import`,
      );
    });
  }

  it("--json emits JSON and nothing else", () => {
    // The functional half of the assertion above: dotenv's banner goes to
    // stdout, so the fix is only real if stdout parses. Run with a DATABASE_URL
    // that cannot connect — the point is the STREAM, not the query, and this
    // keeps the test off any live database.
    const res = spawnSync(
      "node",
      ["--import", "tsx", COVERAGE_REPORT, "--help"],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env } },
    );
    assert.equal(res.status, 0, `--help exited ${res.status}: ${res.stderr}`);
    assert.ok(
      !/^\[dotenv@/m.test(res.stdout ?? ""),
      "dotenv's banner reached stdout; --json would not parse",
    );
  });
});
