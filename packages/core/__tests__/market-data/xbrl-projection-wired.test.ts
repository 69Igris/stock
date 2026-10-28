/**
 * MONEY-1220 — the wiring, not the logic.
 *
 * MONEY-1115 shipped `processXbrlProjectionWrite`, its tests, its units fix and
 * its authority guard, and then **no route, no topic, no scheduler and no Cloud
 * Run job**. The engine sat on `release` for a release writing nothing, while
 * `stock_financials` stayed frozen on a March Tickertape snapshot and the
 * Quarterly tab was empty for every symbol on the platform.
 *
 * Nothing failed. There was simply no path from a clock to the code. A unit
 * test of the writer cannot see that, because the writer was perfect.
 *
 * This file tests the PATH: clock → scheduler → topic → subscription → route →
 * processor, plus the env var that arms the write. Each assertion pins one link
 * that, missing, reproduces the same silent nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bashArrayBody } from "./_bash-array";

// `import.meta.dirname`, not `__dirname`: packages/core tests run as ESM. The
// inverse holds in apps/web, which runs them as CJS — a copied harness fails
// silently there, and a suite that throws at describe-time still prints
// "# fail 0", so the counts alone would not have caught it.
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

const INDEX = read("workers/src/index.ts");
const PUBSUB = read("workers/scripts/setup-pubsub.sh");
const SCHED = read("scripts/ops/setup-scheduler.sh");
const CB_PROD = read("workers/cloudbuild.prod.yaml");
const CB_QA = read("workers/cloudbuild.qa.yaml");

describe("xbrl-projection — the clock reaches the code", () => {
  it("the route is mounted", () => {
    assert.match(INDEX, /app\.route\("\/jobs\/xbrl-projection"/);
    assert.match(INDEX, /from "\.\/routes\/xbrl-projection"/);
  });

  it("the topic is in BOTH pubsub lists — topic AND push subscription", () => {
    // setup-pubsub keeps two arrays: BASE_TOPICS (what gets created) and
    // BASE_WORKER_TOPICS (what gets a push subscription to /jobs/<name>).
    // A name in only the first creates a topic nothing is listening on, so
    // Cloud Scheduler publishes successfully into a void — the failure looks
    // exactly like a healthy run. An earlier version of this test asserted the
    // string appeared "somewhere" and passed with one of the two removed.
    const listAfter = (decl: string): string => {
      const at = PUBSUB.indexOf(decl);
      assert.ok(at > 0, `${decl} not found`);
      return PUBSUB.slice(at, PUBSUB.indexOf("\n)", at));
    };
    for (const decl of [
      "declare -a BASE_TOPICS=(",
      "declare -a BASE_WORKER_TOPICS=(",
    ]) {
      assert.match(
        listAfter(decl),
        /"xbrl-projection"/,
        `xbrl-projection missing from ${decl}`,
      );
    }
  });

  it("a scheduler definition targets that exact topic", () => {
    // The def is `name|cron|TOPIC|payload|description`. A scheduler pointing at
    // a topic nobody created delivers to nothing, silently.
    const def = SCHED.split("\n").find((l) =>
      l.includes('"xbrl-projection-daily|'),
    );
    assert.ok(def, "no xbrl-projection-daily definition");
    const [, cron, topic] = def.split("|");
    assert.equal(topic, "xbrl-projection", "scheduler points at a wrong topic");
    assert.match(cron, /^\d+ \d+ /, `unexpected cron: ${cron}`);
  });

  it("the nightly payload is scoped to ANNUAL — and is still valid JSON", () => {
    // MONEY-1235, and this is TEMPORARY: it reverts to `{}` once the quarterly
    // drain completes (docs/reference/xbrl-switchover-runbook.md step 5). It is
    // pinned here anyway, because the payload is the only place the scoping
    // exists — there is no code default that would restore it if the line were
    // edited back by hand, and no run would fail if it were.
    //
    // WHY IT IS SCOPED. The companion fix stops the writer stamping
    // `projectedAt` on CREATE-suppressed filings, so unstamped QUARTERLY rows
    // re-enter every nightly page. Prod holds 71,450 QUARTERLY against 18,381
    // ANNUAL and the read is symbol-major, so the two INTERLEAVE: an unscoped
    // 500-row page is ~80% rows that cannot be written, and the ANNUAL work the
    // switchover gates on advances at a fifth of its rate, nightly, forever.
    //
    // The def format is `name|cron|TOPIC|payload|description`, so the payload
    // must contain no `|` — one would shift the description into the message
    // field and Cloud Scheduler would publish a body no processor can parse.
    // Parsing it here proves both the escaping and the shape.
    const def = SCHED.split("\n").find((l) =>
      l.includes('"xbrl-projection-daily|'),
    );
    assert.ok(def, "no xbrl-projection-daily definition");
    const parts = def.split("|");
    assert.equal(
      parts.length >= 5,
      true,
      `payload split a description: ${def}`,
    );

    // The file is SHELL. `\"` in the source is the bash escape for a literal
    // quote inside the double-quoted array element, so undo it the way bash
    // would before parsing.
    const payload = parts[3]!.replace(/\\"/g, '"');
    const parsed = JSON.parse(payload) as {
      periodTypes?: string[];
      apply?: boolean;
    };
    assert.deepEqual(
      parsed.periodTypes,
      ["ANNUAL"],
      "the nightly payload must scope the projection to ANNUAL",
    );

    // A payload can NARROW the arm and must never carry `apply:true` — the env
    // var is the interlock, and a payload that appeared to arm would move the
    // one-way door out of the one place it is guarded.
    assert.notEqual(parsed.apply, true, "a payload must never arm the write");
  });

  it("runs AFTER xbrl-sync — projecting filings that have not landed is a no-op", () => {
    const cronOf = (name: string): [number, number] => {
      const def = SCHED.split("\n").find((l) => l.includes(`"${name}|`));
      assert.ok(def, `${name} not found`);
      const [min, hour] = def.split("|")[1]!.split(" ");
      return [Number(hour), Number(min)];
    };
    const [syncH, syncM] = cronOf("xbrl-sync-daily");
    const [projH, projM] = cronOf("xbrl-projection-daily");
    assert.ok(
      projH * 60 + projM > syncH * 60 + syncM,
      `projection ${projH}:${projM} must run after sync ${syncH}:${syncM}`,
    );
  });

  it("is PROD_ONLY — a QA write would be dropped by the next restore", () => {
    // Not because it scrapes (it reads our own filings) but because QA receives
    // stock_financials and xbrl_filings through sync-prod-to-qa, whose
    // `mongorestore --drop` replaces whatever QA computed for itself.
    const block = bashArrayBody(SCHED, "PROD_ONLY_JOBS");
    assert.match(block, /"xbrl-projection-daily"/);
  });
});

describe("xbrl-projection — the arm", () => {
  it("ships PRESENT and OFF in BOTH cloudbuild specs", () => {
    // Present-but-false, never absent. An absent var and a "false" var must not
    // be the same state: "absent" is exactly how MF_METADATA_PROVIDER disabled
    // its job silently for months (MONEY-1214).
    for (const [name, spec] of [
      ["prod", CB_PROD],
      ["qa", CB_QA],
    ] as const) {
      assert.match(
        spec,
        /- name: XBRL_PROJECTION_APPLY/,
        `${name} spec does not declare the var`,
      );
      const at = spec.indexOf("- name: XBRL_PROJECTION_APPLY");
      const val = spec.slice(at, at + 200);
      assert.match(val, /value: "false"/, `${name} ships ARMED`);
    }
  });

  it("the processor compares against the literal string, never truthiness", () => {
    // `Boolean("false")` is true. A truthiness check would arm the job in
    // exactly the configuration that is meant to keep it off.
    const src = read("workers/src/processors/xbrl-projection.ts");
    assert.match(src, /XBRL_PROJECTION_APPLY === "true"/);
    assert.doesNotMatch(src, /Boolean\(\s*\w*\.XBRL_PROJECTION_APPLY/);
  });
});

describe("the release re-pins the Cloud Run JOBS", () => {
  // MONEY-1235. Not strictly about the projection — but it is the same failure
  // shape this whole file exists for, one layer down. Cloud Run JOBS pin their
  // image at PROVISION time and `gcloud run services replace` does not move
  // them, so a merged, released, deployed fix can sit un-executed on the
  // nightly jobs indefinitely. All four jobs drifted across all four releases
  // of this cycle and were re-pinned by hand every time; `feed-parse-prod` was
  // four days stale on 2026-08-18, exited 0 nightly, and silently skipped four
  // bond feed families (`bond_master` / `bond_eod` at 0 rows — MONEY-1210).
  //
  // A drifted job does not fail. It succeeds at running last release's code.
  const REPIN_MARKER = "RE-PIN THE CLOUD RUN JOBS";
  const stepOf = (spec: string): string => {
    const at = spec.indexOf(REPIN_MARKER);
    assert.ok(at > 0, "no re-pin step in the cloudbuild spec");
    return spec.slice(at);
  };

  // The commentary above the step NAMES the flags it must not use ("`gcloud run
  // jobs update --set-env-vars` REPLACES..."), so a text search over the whole
  // block matches the warning as readily as a violation. Assert against the
  // SHELL only. `set -uo pipefail` is the script's first line and is unique to
  // it in these files.
  //
  // It is also bounded at the top-level `images:` key that follows. Slicing to
  // end-of-file leaks that block into the haystack, and it lists the very tag
  // this step is supposed to pin — so a step pinning the WRONG tag still passed
  // (mutation-checked: swapping prod's tag for qa's did not go red until this
  // bound was added).
  const scriptOf = (spec: string): string => {
    const step = stepOf(spec);
    const at = step.indexOf("set -uo pipefail");
    assert.ok(at > 0, "the re-pin step has no shell script");
    const end = step.indexOf("\nimages:", at);
    return end === -1 ? step.slice(at) : step.slice(at, end);
  };

  it("both cloudbuild specs update every per-env job's image", () => {
    for (const [name, spec, env] of [
      ["prod", CB_PROD, "prod"],
      ["qa", CB_QA, "qa"],
    ] as const) {
      const step = scriptOf(spec);
      assert.match(
        step,
        /gcloud run jobs update/,
        `${name} never re-pins the jobs`,
      );
      // Read the LOOP LIST, not the whole script. `step.includes("xbrl-backfill")`
      // passes on a script that dropped the job from the loop and only mentions
      // it in the "provision it with setup-xbrl-backfill-job.sh" warning —
      // mutation-checked, and it did pass. A guard that cannot go red is worse
      // than no guard, because it reads as coverage.
      const loop = /for BASE in ([^\n;]+);/.exec(step);
      assert.ok(loop, `${name} re-pin step has no job list`);
      const bases = loop[1]!.trim().split(/\s+/);

      // THIS FILE'S SUBJECT IS THE XBRL JOBS, so it asserts those three and
      // stops. It used to hold a hardcoded EIGHT-name copy of the whole loop,
      // and that was the defect MONEY-1317 found from the other side: a
      // hand-maintained second list DOES go red when a name is deleted from
      // the loop, but two hand-maintained lists can be JOINTLY INCOMPLETE, and
      // these two were — `bse-backfill`, `tiingo-us-backfill`,
      // `tiingo-us-corp-actions-backfill` and `tiingo-us-news-seed` are real
      // Cloud Run jobs on this image and were in neither. A closed list of
      // seven compared against a loop of seven passes.
      //
      // COMPLETENESS NOW LIVES IN ONE PLACE, derived rather than restated:
      // packages/core/__tests__/ops/job-build-provenance.test.ts requires
      // every entry point in workers/tsup.config.ts that bundles a script to
      // appear in BOTH loops or in a reason-carrying exemption map. Do not
      // re-add a full copy of the list here.
      for (const base of [
        "xbrl-backfill",
        // MONEY-1235 — the projection DRAIN is the same staleness class: a
        // Cloud Run JOB pins its image at provision time, so a SERVICE deploy
        // leaves it running whatever code it was created with. Omitting it is
        // how it silently drains the quarterly backlog using a stale writer.
        "xbrl-projection-drain",
        // MONEY-1252 — the re-parse job, and the STARKEST case anywhere in
        // this loop. Every other job fails visibly on a stale image (a missing
        // feed family, a stale writer). This one does not fail at all: its
        // entire purpose is the PARSER VERSION it runs, so an image built
        // before MONEY-1250 re-reads all 96,056 archived documents with the
        // old concept table, produces byte-identical facts, clears no
        // `projectedAt`, and reports `selected 96056, stored 96056, changed 0`
        // — a clean, complete, and completely useless run.
        "xbrl-reparse",
      ]) {
        assert.ok(
          bases.includes(base),
          `${name} does not re-pin ${base} — it would keep its old image, run ` +
            "last release's projection code and exit 0",
        );
      }
      // The suffix comes from a substitution so the two specs cannot drift
      // apart, and the tag stays written out literally so it is character-
      // identical to the one the build step pushes.
      // Quote-style agnostic ON PURPOSE. This originally pinned SINGLE quotes
      // and went red the moment the spec was run through Prettier, which
      // normalises YAML scalars to the DOUBLE quotes the rest of this file
      // already uses (`_REGION: "asia-south1"` predates this ticket). What is
      // under test is that the substitution EXISTS and carries the right
      // value; the quoting is incidental, and a guard that fails on a
      // formatter is a guard that gets silenced rather than read.
      assert.match(
        spec,
        new RegExp(`_ENV:\\s*["']?${env}["']?\\s*$`, "m"),
        `${name} has no _ENV substitution set to ${env}`,
      );
      assert.ok(
        step.includes(`stockbook-workers:${env}-$COMMIT_SHA`),
        `${name} re-pins to a tag this build does not push`,
      );
    }
  });

  it("touches ONLY --image — never the env block", () => {
    // `gcloud run jobs update --set-env-vars` REPLACES a job's env list; it
    // does not merge into it. The env/secret block is owned by
    // scripts/ops/setup-{feed-backfill,xbrl-backfill}-job.sh — FEED_ARCHIVE_MODE
    // above all, which is `archive` on prod and `replay` on QA. Two writers
    // over one job's env is the "whichever ran last wins, silently" bug those
    // two scripts were split apart to prevent; doing it on every release would
    // make QA scrape NSE/BSE again with nothing in the logs to say so.
    //
    // DD_VERSION is the same argument from the other end: it is baked into the
    // image layer, and passing it here would let a stale-pinned job report a
    // fresh SHA — forging the one signal that can catch this class.
    for (const [name, spec] of [
      ["prod", CB_PROD],
      ["qa", CB_QA],
    ] as const) {
      const step = scriptOf(spec);
      assert.doesNotMatch(
        step,
        /--set-env-vars/,
        `${name} re-pin step rewrites the job env — it would clobber FEED_ARCHIVE_MODE`,
      );
      assert.doesNotMatch(
        step,
        /--set-secrets/,
        `${name} re-pin step rewrites the job secrets`,
      );
      assert.doesNotMatch(
        step,
        /DD_VERSION=/,
        `${name} re-pin step forges DD_VERSION onto the job spec`,
      );
    }
  });

  it("warns loudly rather than failing, and never skips silently", () => {
    // First provisioning still belongs to the setup scripts, and `jobs update`
    // fails on a job that does not exist — QA has no `xbrl-backfill-qa` as of
    // 2026-08-21. That must not block a release, but it must not be invisible
    // either: a silent skip is indistinguishable from the drift the step
    // exists to end.
    for (const [name, spec] of [
      ["prod", CB_PROD],
      ["qa", CB_QA],
    ] as const) {
      const step = scriptOf(spec);
      assert.match(step, /WARNING/, `${name} skips a missing job silently`);
      // EVERY job in the re-pin loop must have its OWN provisioning script
      // named — MONEY-1250. This asserted only `setup-xbrl-backfill-job.sh`,
      // and the warning listed that plus `setup-feed-backfill-job.sh`. Neither
      // can create `xbrl-projection-drain-*`, which is the job that actually
      // triggered the warning on the 2026-08-22 release: the operator was told
      // to run two scripts that would not have helped, for the one job the
      // switchover runbook's `createMissing` pilot depends on.
      for (const [job, script] of [
        ["feed-backfill", "setup-feed-backfill-job.sh"],
        ["xbrl-backfill", "setup-xbrl-backfill-job.sh"],
        ["xbrl-projection-drain", "setup-xbrl-projection-drain-job.sh"],
        // MONEY-1317. `setup-doc-ingest-backfill-job.sh` appears nowhere else
        // in this step, so this pair is the one that would actually go red;
        // the three above are already named by each other's lines.
        ["doc-ingest-backfill", "setup-doc-ingest-backfill-job.sh"],
      ] as const) {
        assert.match(
          step,
          new RegExp(script.replace(/\./g, "\\.")),
          `${name} does not name the script that provisions ${job}`,
        );
      }

      // MONEY-1317 — no job in this loop may be described as un-provisionable.
      //
      // The `feed-repair` line read "provisioned BY HAND — no setup script
      // exists" while build-provenance.ts:336 had been mapping that entry point
      // to `setup-feed-backfill-job.sh` for a release, and that script deployed
      // three jobs, none of them this one. Three sources, three different
      // stories, and the operator following any one of them got a different
      // wrong answer. The remediation is now real (a `deploy_job` call in that
      // script, asserted for real in job-build-provenance.test.ts) — this pins
      // the WARNING side so the prose cannot drift back to a shrug.
      assert.doesNotMatch(
        step,
        /no setup script exists|provisioned BY HAND/,
        `${name} tells the operator a job in the re-pin loop cannot be ` +
          `provisioned. Every base in this loop has an owner in ` +
          `SETUP_SCRIPT_BY_ENTRYPOINT; name it instead.`,
      );
    }
  });
});

describe("xbrl-projection — the cursor", () => {
  it("selects only filings it has not decided about", () => {
    // Without this the nightly run re-reads the same first `limit` filings
    // forever: selection is `orderBy [symbol asc, periodEnd desc] take limit`,
    // a constant ordering over an append-only table. That is MONEY-1211's
    // constant sort, which cost 681 of 781 symbols their sync.
    const proc = read("workers/src/processors/xbrl-projection.ts");
    assert.match(proc, /unprojectedOnly:\s*true/);

    // UPDATED in MONEY-1234. This used to pin the literal
    // `unprojectedOnly === true ? { projectedAt: null }`, and that filter
    // SELECTS NOTHING on MongoDB.
    //
    // `projectedAt` is a nullable column added by `db push`, and a push on Mongo
    // creates INDEXES, never fields — so the field is ABSENT on every row until
    // something writes it, and Prisma's Mongo connector does not treat absent as
    // null. Measured on prod 2026-08-21:
    //
    //     prisma.count()                                90,188
    //     prisma.count({ projectedAt: null })                0
    //     prisma.count({ projectedAt: { not: null } })       0
    //     prisma.count({ projectedAt: { isSet: false } })  90,188
    //
    // A filter AND its inverse both returning zero is the signature — the rows
    // are in neither set. Raw Mongo DOES match absent with `null`, which is why
    // a mongosh check said 90,188 while the job selected 0 and reported success.
    //
    // The test's INTENT was right and is unchanged; what it pinned was an
    // implementation that could not do the thing the intent describes. Now it
    // pins the behaviour instead: exclude decided rows, INCLUDE never-stamped
    // ones. Same shape as MONEY-1050's `{ not: false }`.
    const writer = read("workers/src/processors/xbrl-projection-writer.ts");
    assert.match(writer, /isSet:\s*false/);
    assert.doesNotMatch(
      writer,
      /unprojectedOnly === true \? \{ projectedAt: null \}/,
      "a bare `projectedAt: null` filter matches no rows on MongoDB",
    );
  });

  it("stamps only DECIDED filings, and only when applying", () => {
    const writer = read("workers/src/processors/xbrl-projection-writer.ts");
    // A dry run must leave no trace, or the first armed run skips everything a
    // rehearsal already "decided".
    assert.match(writer, /if \(apply && decided\.length > 0\)/);
    // A failure is the one outcome that might succeed next time.
    assert.match(writer, /failedIds\.add\(winner\.id\)/);
    assert.match(writer, /decidedIds\]\.filter\(/);
    // MONEY-1235 — the exclusion set GREW, and this is the assertion that has
    // to grow with it. `decidedIds` is populated for a WHOLE GROUP before any
    // statement is written, and the CREATE branch returned without touching
    // `failedIds`, so a create-suppressed (or no-instrument) filing was stamped
    // as decided having produced nothing at all. Neither is a property of the
    // filing: `createMissing` is a switch on the message and a missing
    // `instrument_mappings` row is a gap another job fills, so both flip with
    // nothing new arriving from NSE.
    //
    // Armed with an unscoped nightly payload that burns a 500-filing page per
    // night into stamped-never-created, and the deliberate `createMissing`
    // pilot then selects none of them — MONEY-1235's "Quarterly can never fill"
    // rebuilt one level up, recoverable only by a hand `$unset`. Prod holds
    // 71,450 QUARTERLY filings against ZERO quarterly `stock_financials` rows,
    // so EVERY quarterly write is a create and every one of them was exposed.
    assert.match(
      writer,
      /!failedIds\.has\(id\)\s*&&\s*!notDecidedIds\.has\(id\)/,
      "create-suppressed filings must not be stamped as decided",
    );
  });
});
