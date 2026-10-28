/**
 * The `us-filing-insight` lane is WIRED, not merely written — MONEY-1324 (P17).
 *
 * The processor landed complete and connected to nothing: no topic, no route,
 * no schedule, no publisher. Every artefact in this file is one of the joins
 * that had to be made, and each one has a measured failure behind it:
 *
 *   TOPIC in three lists   a topic declared in TS but created by neither shell
 *                          script makes every publish fail inside Cloud
 *                          Scheduler, where nobody is looking; a topic created
 *                          with no PUSH SUBSCRIPTION accumulates messages until
 *                          retention expires with no counter moving
 *                          (MONEY-1314).
 *   ROUTE MOUNTED          `document-financials-projection` shipped with its
 *                          route file, processor, topic, subscription, enabled
 *                          scheduler entry and message type all correct and ONE
 *                          `app.route(...)` line missing. Every delivery 404'd
 *                          and dead-lettered after five attempts while the
 *                          scheduler fired on time (MONEY-1257).
 *   A PUBLISHER            `fund-composition-sync` had a topic, a processor and
 *                          a documented "Cloud Scheduler" trigger, and nothing
 *                          ever published to it (MONEY-1205).
 *   THE ARM FLAG           absent and explicitly-"false" must not be the same
 *                          state — that is exactly how `MF_METADATA_PROVIDER`
 *                          disabled its job silently for months (MONEY-1214).
 *
 * The generic guards (`topic-list-agreement`, `topic-publisher-coverage`,
 * `route-registration-coverage`) each cover one of these across the whole repo.
 * This file asserts them together FOR THIS LANE, because the failure that
 * matters is a half-wired set: every generic guard passes while the lane does
 * nothing, since each is checking a DIFFERENT artefact.
 *
 * Everything here is file parsing — no network, no GCP, no Prisma. CWD is
 * `packages/core`, so the repo root is found and then ASSERTED: an anchor that
 * silently resolved elsewhere would make every scan read nothing and pass.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PUBSUB_TOPICS } from "@usemoney/types/pubsub";

function findRepoRoot(from: string = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(join(dir, "turbo.json")) &&
      existsSync(join(dir, "packages"))
    ) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root from ${from}`);
}

const ROOT = findRepoRoot();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

const TOPIC = "us-filing-insight";
const JOB = "us-filing-insight-sweep";
const FLAG = "US_FILING_INSIGHT_APPLY";
const COLLECTION = "us_filing_insights";

const SETUP_PUBSUB = read("workers", "scripts", "setup-pubsub.sh");
const GCP_SETUP = read("workers", "scripts", "gcp-setup.sh");
const SCHEDULER = read("scripts", "ops", "setup-scheduler.sh");
const SYNC_TO_QA = read("scripts", "ops", "sync-prod-to-qa.sh");
const INDEX = read("workers", "src", "index.ts");
const ROUTE = read("workers", "src", "routes", "us-filing-insight.ts");
const SWEEP = read("workers", "src", "processors", "filing-insight-sweep.ts");
const CB_PROD = read("workers", "cloudbuild.prod.yaml");
const CB_QA = read("workers", "cloudbuild.qa.yaml");

/**
 * Bash with comment BODIES removed.
 *
 * Load-bearing rather than tidy: every block this file scans is heavily
 * commented and the comments quote the topic name, the job name and the flag
 * out loud. A comment-blind matcher would be satisfied by the prose explaining
 * the wiring instead of by the wiring — the exact way an earlier guard in this
 * repo went vacuous (MONEY-1143).
 */
function stripBashComments(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s#.*$/, "")))
    .join("\n");
}

/** TypeScript with comments removed. LINE comments FIRST — see MONEY-1143. */
function stripTsComments(src: string): string {
  return src
    .replace(/^[^\S\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ""));
}

/** Entries of a `declare -a NAME=( ... )` array, comments stripped first. */
function bashArray(src: string, name: string): string[] {
  const marker = `declare -a ${name}=(`;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `${name} not found — the parser is stale`);
  const end = src.indexOf("\n)", start);
  assert.ok(end > start, `unterminated ${name}`);
  const out: string[] = [];
  for (const raw of src.slice(start + marker.length, end).split("\n")) {
    const m = /"([a-z0-9_-]+)"/.exec(raw.replace(/#.*$/, ""));
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Entries of a plain `NAME=( ... )` array (the ops scripts' style). */
function plainBashArray(src: string, name: string): string[] {
  const marker = `${name}=(`;
  const start = src.indexOf(`\n${marker}`);
  assert.notEqual(start, -1, `${name} not found — the parser is stale`);
  const end = src.indexOf("\n)", start);
  assert.ok(end > start, `unterminated ${name}`);
  const out: string[] = [];
  for (const raw of src.slice(start + marker.length + 1, end).split("\n")) {
    const m = /"([a-z0-9_|*/ -]+)"/.exec(raw.replace(/#.*$/, ""));
    if (m) out.push(m[1]!);
  }
  return out;
}

const BASE_TOPICS = bashArray(SETUP_PUBSUB, "BASE_TOPICS");
const WORKER_TOPICS = bashArray(SETUP_PUBSUB, "BASE_WORKER_TOPICS");
const GCP_TOPICS = bashArray(GCP_SETUP, "BASE_TOPICS");
const PROD_ONLY = plainBashArray(SCHEDULER, "PROD_ONLY_JOBS");
const REFERENCE_COLLECTIONS = plainBashArray(
  SYNC_TO_QA,
  "REFERENCE_COLLECTIONS",
);

/** The `NAME|SCHEDULE|TOPIC|MESSAGE|DESCRIPTION` row for a scheduler job. */
function schedulerRow(name: string): string | null {
  for (const line of stripBashComments(SCHEDULER).split("\n")) {
    const m = /^\s*"([a-z0-9-]+)\|(.*)"\s*$/.exec(line);
    if (m && m[1] === name) return `${m[1]}|${m[2]}`;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════ */

describe("MONEY-1324 — the us-filing-insight lane is wired end to end", () => {
  it("[premise] every file was read and every array parsed", () => {
    // A guard that silently scans nothing is worse than no guard, because it
    // gets cited as proof. Each floor is well under the measured count and well
    // over "one line matched".
    for (const [name, src] of [
      ["setup-pubsub.sh", SETUP_PUBSUB],
      ["gcp-setup.sh", GCP_SETUP],
      ["setup-scheduler.sh", SCHEDULER],
      ["sync-prod-to-qa.sh", SYNC_TO_QA],
      ["workers/src/index.ts", INDEX],
    ] as const) {
      assert.ok(src.length > 5_000, `${name} read as ${src.length} chars`);
    }
    assert.ok(ROUTE.length > 1_000, "the route file is suspiciously small");
    assert.ok(
      SWEEP.length > 2_000,
      "the sweep processor is suspiciously small",
    );
    assert.ok(BASE_TOPICS.length >= 60, `BASE_TOPICS ${BASE_TOPICS.length}`);
    assert.ok(WORKER_TOPICS.length >= 60, `worker ${WORKER_TOPICS.length}`);
    assert.ok(GCP_TOPICS.length >= 70, `gcp ${GCP_TOPICS.length}`);
    assert.ok(PROD_ONLY.length >= 20, `PROD_ONLY_JOBS ${PROD_ONLY.length}`);
    assert.ok(
      REFERENCE_COLLECTIONS.length >= 30,
      `REFERENCE_COLLECTIONS ${REFERENCE_COLLECTIONS.length}`,
    );
    // And the parsers discriminate: a known-present neighbour is found, a
    // known-absent name is not.
    assert.ok(BASE_TOPICS.includes("tiingo-news-poll"));
    assert.ok(!BASE_TOPICS.includes("financial-data-sync"));
    assert.ok(PROD_ONLY.includes("tiingo-news-poll"));
    assert.ok(REFERENCE_COLLECTIONS.includes("us_filing_documents"));
  });

  it("the topic constant exists and is the base name", () => {
    assert.equal(PUBSUB_TOPICS.US_FILING_INSIGHT, TOPIC);
  });

  it("setup-pubsub.sh CREATES the topic and gives it a PUSH SUBSCRIPTION", () => {
    assert.ok(
      BASE_TOPICS.includes(TOPIC),
      "no topic — every publish would fail at the API, inside Cloud Scheduler",
    );
    assert.ok(
      WORKER_TOPICS.includes(TOPIC),
      "no push subscription — the topic would exist, the scheduler would " +
        "publish happily, and NOTHING would consume it. Worse here than for a " +
        "one-way job: the sweep publishes its fan-out onto this same topic, so " +
        "the leaves would have nowhere to land either.",
    );
  });

  it("gcp-setup.sh bootstraps it too — a fresh project must not miss it", () => {
    assert.ok(
      GCP_TOPICS.includes(TOPIC),
      "absent from the FRESH-PROJECT bootstrap, which runs before " +
        "setup-pubsub.sh has ever been used",
    );
  });

  it("there IS a code publisher, and it is the sweep", () => {
    // Comments stripped: `getTopicName(PUBSUB_TOPICS.US_FILING_INSIGHT)` appears
    // in prose in this repo, and a raw text match would credit a topic nothing
    // publishes to.
    const code = stripTsComments(SWEEP);
    assert.match(
      code,
      /getTopicName\(\s*PUBSUB_TOPICS\.US_FILING_INSIGHT\s*[,)]/,
      "filing-insight-sweep.ts does not resolve the topic name",
    );
    assert.match(
      code,
      /\.publishMessage\(/,
      "it resolves the topic and never publishes to it",
    );
    assert.match(
      code,
      /json:\s*\{\s*documentId\s*\}/,
      "the fan-out must carry a documentId — a message without one is ignored " +
        "by the route, and a whole tick would ACK into nothing",
    );
  });

  it("the route is MOUNTED, at the path the push endpoint targets", () => {
    // setup-pubsub.sh builds `${SERVICE_URL}/jobs/${BASE_TOPIC}`, so the path
    // segment must equal the topic base EXACTLY. Anything else 404s every
    // delivery and dead-letters after five attempts, which reads as a failing
    // job rather than a misrouted topic.
    const code = stripTsComments(INDEX);
    assert.match(
      code,
      /import \{ usFilingInsightRoute \} from "\.\/routes\/us-filing-insight"/,
      "not imported",
    );
    assert.match(
      code,
      new RegExp(
        `app\\.route\\(\\s*"/jobs/${TOPIC}"\\s*,\\s*usFilingInsightRoute\\s*\\)`,
      ),
      "not mounted at /jobs/us-filing-insight",
    );
  });

  it("the route ACKs 200 on EVERY path, including its own throw", () => {
    const code = stripTsComments(ROUTE);
    assert.ok(
      !/,\s*5\d\d\s*\)/.test(code),
      "the route returns a 5xx somewhere. Pub/Sub ACKs only on 2xx, so a NACK " +
        "here redelivers a message whose model call has already been paid for.",
    );
    assert.match(
      code,
      /catch\s*\([\s\S]{0,400}?\{\s*success:\s*true[\s\S]{0,120}?\}\s*,\s*200\s*\)/,
      "the catch block does not ACK",
    );
    // Every branch returns 200 — count them rather than trusting the two above.
    const statuses = [...code.matchAll(/\}\s*,\s*(\d{3})\s*\)/g)].map(
      (m) => m[1]!,
    );
    assert.ok(statuses.length >= 4, `only ${statuses.length} responses found`);
    assert.deepEqual(
      [...new Set(statuses)],
      ["200"],
      "a non-200 response would make Pub/Sub the retry channel, and this lane " +
        "deliberately makes the insightStatus COLUMN the retry channel instead",
    );
  });

  it("the route dispatches BOTH message shapes on the one topic", () => {
    const code = stripTsComments(ROUTE);
    assert.match(code, /classifyFilingInsightMessage\(/);
    assert.match(code, /processFilingInsightSweep\(/, "no sweep dispatch");
    assert.match(code, /processUsFilingInsight\(/, "no per-document dispatch");
  });

  it("the REAL analyser is injected — the default is a stub that throws", () => {
    // `processUsFilingInsight` defaults its FilingTextAnalyser to
    // `notImplementedFilingAnalyser`, which throws on purpose so an unwired
    // deployment fails loudly instead of stamping READY across the cohort. This
    // route is the only place that resolves it, so an omitted injection is not
    // a loud failure anywhere else — it is a lane that writes FAILED forever.
    const code = stripTsComments(ROUTE);
    assert.match(
      code,
      /import \{ createFilingInsightAnalyser \} from "\.\.\/processors\/us-filing-insight-analyser"/,
      "the adapter is not imported",
    );
    assert.match(
      code,
      /processUsFilingInsight\(\s*message\s*,\s*\{[\s\S]{0,200}?analyser:\s*createFilingInsightAnalyser\(\)/,
      "the leaf is called WITHOUT an analyser, so it would resolve to the " +
        "throwing stub and write FAILED for every document in the cohort",
    );
  });

  it("a LEAF is refused while the lane is disarmed", () => {
    // The sweep is not the only way a leaf can arrive — a hand-published
    // message, or one already in flight when the flag was turned off — and
    // every leaf spends a model call.
    const code = stripTsComments(ROUTE);
    assert.match(code, /if\s*\(\s*!isFilingInsightArmed\(\)\s*\)/);
  });

  it("Cloud Scheduler publishes to it, every 10 minutes, all seven days", () => {
    const row = schedulerRow(JOB);
    assert.ok(row, `no SCHEDULER_DEFS entry named ${JOB}`);
    const [name, schedule, topic, message] = row.split("|");
    assert.equal(name, JOB);
    assert.equal(
      schedule,
      "*/10 * * * *",
      "the founder decision for the live lane is a 10-minute sweep",
    );
    assert.equal(
      topic,
      TOPIC,
      "the scheduler publishes to a topic other than the one the route consumes",
    );
    assert.match(
      message!,
      /\\"mode\\":\\"sweep\\"/,
      'the payload must name mode:"sweep" EXPLICITLY. The route refuses to ' +
        "infer a sweep from an absent field, so `{}` would be ACKed and " +
        "ignored — a cron that fires on time and does nothing, forever.",
    );
    // The seven-day field, stated rather than implied: this job reads our own
    // Mongo and GCS, so it inherits no exchange calendar.
    assert.equal(schedule!.split(" ")[4], "*");
  });

  it("the sweep job is PROD_ONLY, and its table reaches QA", () => {
    assert.ok(
      PROD_ONLY.includes(JOB),
      "not prod-only: QA's inputs are prod's by copy (us_filing_documents is " +
        "already a REFERENCE_COLLECTION), so a QA sweep would buy a second " +
        "PAID reading of identical bytes",
    );
    assert.ok(
      REFERENCE_COLLECTIONS.includes(COLLECTION),
      `${COLLECTION} must be synced prod->QA, or the prod-only decision leaves ` +
        "QA with no insights at all",
    );
  });

  it('the arm flag ships PRESENT and "false" in BOTH cloudbuild specs', () => {
    // Absent and explicitly-false must not be the same state. An absent var is
    // how MF_METADATA_PROVIDER disabled its job silently for months, and a
    // present "false" is a diff a reviewer can see change.
    const entry = new RegExp(`- name: ${FLAG}\\s*\\n\\s*value: "false"`);
    for (const [name, src] of [
      ["cloudbuild.prod.yaml", CB_PROD],
      ["cloudbuild.qa.yaml", CB_QA],
    ] as const) {
      assert.match(src, entry, `${name} does not ship ${FLAG}="false"`);
    }
  });

  it("[control] every detector above can FAIL", () => {
    // Each assertion is a match against parsed input, and a parser that finds
    // nothing would pass everything. Drive each matcher with input that must
    // NOT satisfy it.
    assert.ok(
      !bashArray(SETUP_PUBSUB, "BASE_TOPICS").includes("no-such-topic"),
    );
    assert.equal(schedulerRow("no-such-job"), null);
    assert.ok(!PROD_ONLY.includes("no-such-job"));
    assert.ok(!REFERENCE_COLLECTIONS.includes("no_such_collection"));

    // A comment naming the topic must not count as a declaration.
    const commented = [
      "declare -a BASE_TOPICS=(",
      '  "real-topic"',
      `  # "${TOPIC}" was removed in a later ticket`,
      ")",
    ].join("\n");
    assert.deepEqual(bashArray(commented, "BASE_TOPICS"), ["real-topic"]);

    // A 500 hiding inside a comment must not fail the ACK check, and a REAL
    // one must.
    assert.ok(
      !/,\s*5\d\d\s*\)/.test(stripTsComments("// return c.json(x, 500)")),
    );
    assert.ok(/,\s*5\d\d\s*\)/.test(stripTsComments("return c.json(x, 500)")));

    // The flag matcher must reject a spec that ships the flag ARMED, and one
    // that omits it entirely.
    const entry = new RegExp(`- name: ${FLAG}\\s*\\n\\s*value: "false"`);
    assert.ok(!entry.test(`- name: ${FLAG}\n  value: "true"`));
    assert.ok(!entry.test(`- name: SOMETHING_ELSE\n  value: "false"`));
    assert.ok(entry.test(`- name: ${FLAG}\n  value: "false"`));
  });
});
