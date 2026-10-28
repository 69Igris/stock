/**
 * The three copies of the Pub/Sub topic list must agree — MONEY-1314.
 *
 * ## The three
 *
 *   1. `packages/types/src/pubsub.ts` — `PUBSUB_TOPICS`. What publishers
 *      actually resolve through `getTopicName`.
 *   2. `workers/scripts/setup-pubsub.sh` — `BASE_TOPICS` creates the topic,
 *      `BASE_WORKER_TOPICS` creates the PUSH SUBSCRIPTION, `EDGAR_TOPICS`
 *      covers the Python service. This is the authoritative script.
 *   3. `workers/scripts/gcp-setup.sh` — its OWN copy, used for fresh-project
 *      bootstrap before setup-pubsub.sh has ever run.
 *
 * ## What was actually wrong, measured 2026-09-01
 *
 * Copy 3 carried 26 entries against copy 2's 64. It was missing the ENTIRE
 * document pipeline (`stock-document-extract`, `-parse`, `-embed`,
 * `document-financials-projection`), every XBRL topic, every EDGAR topic and 30
 * others — while still carrying `financial-data-sync`, retired in MONEY-1220
 * and asserted GONE from copy 2 by `tickertape-retired.test.ts`. That assertion
 * named one file, so the retired topic simply survived in the other.
 *
 * A fresh-project bootstrap therefore produced a broken doc pipeline plus a
 * topic nothing has published to since March, and nothing could fail on it.
 *
 * ## The two failure shapes this pins
 *
 *   - A topic in `BASE_TOPICS` but NOT `BASE_WORKER_TOPICS`: the topic exists,
 *     Cloud Scheduler publishes into it happily, and NOTHING CONSUMES IT. No
 *     error anywhere — messages accumulate to the retention limit and expire.
 *   - A topic declared in TS but created by neither script: every publish
 *     fails at the API, inside Cloud Scheduler, where nobody is looking.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PUBSUB_TOPICS } from "@usemoney/types/pubsub";

/**
 * Walk up to the monorepo root, then ASSERT we found it — an anchor that
 * silently resolved elsewhere would make every scan read nothing and pass.
 * (Same idiom as topic-publisher-coverage.test.ts, in this directory.)
 */
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

const REPO_ROOT = findRepoRoot();
const read = (...p: string[]): string =>
  readFileSync(join(REPO_ROOT, ...p), "utf8");

const SETUP_PUBSUB = read("workers", "scripts", "setup-pubsub.sh");
const GCP_SETUP = read("workers", "scripts", "gcp-setup.sh");

/**
 * Entries of a `declare -a NAME=( ... )` bash array.
 *
 * Comments are stripped per line BEFORE the quoted values are read. These
 * blocks are heavily commented and the comments quote topic names
 * ("fund-composition-sync", "stock-document-extract"), so counting those as
 * entries would let a genuinely missing topic pass — the exact way a
 * comment-blind matcher made an earlier guard vacuous (MONEY-1143).
 */
function stripBashComments(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s#.*$/, "")))
    .join("\n");
}

function parseBashArray(src: string, name: string): string[] {
  const marker = `declare -a ${name}=(`;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `${name} not found — the parser is stale`);
  const end = src.indexOf("\n)", start);
  assert.ok(end > start, `unterminated ${name} array`);
  const block = src.slice(start + marker.length, end);
  const out: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    const m = /"([a-z0-9-]+)"/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

const TS_TOPICS = Object.values(PUBSUB_TOPICS) as string[];
const BASE_TOPICS = parseBashArray(SETUP_PUBSUB, "BASE_TOPICS");
const WORKER_TOPICS = parseBashArray(SETUP_PUBSUB, "BASE_WORKER_TOPICS");
const EDGAR_TOPICS = parseBashArray(SETUP_PUBSUB, "EDGAR_TOPICS");
const GCP_TOPICS = parseBashArray(GCP_SETUP, "BASE_TOPICS");

/** Everything setup-pubsub.sh creates a topic for. */
const PUBSUB_SH_ALL = [...BASE_TOPICS, ...EDGAR_TOPICS];

/**
 * Topics the shell scripts create that have NO `PUBSUB_TOPICS` entry, with the
 * reason. Ratcheted below: an entry that stops being a real divergence fails BY
 * NAME rather than sitting here as a comment nobody rereads.
 */
const INFRA_ONLY_TOPICS = new Map<string, string>([
  [
    "dead-letter",
    "MONEY-841 transport infrastructure, not a job. Nothing in TS publishes " +
      "to it — Pub/Sub itself forwards here after MAX_DELIVERY_ATTEMPTS — so it " +
      "has no PUBSUB_TOPICS entry, and setup-pubsub.sh creates it outside " +
      "BASE_TOPICS with its own subscription and deliberately no DLQ of its own.",
  ],
]);

/**
 * Topics with a topic but NO push subscription in setup-pubsub.sh.
 *
 * EMPTY, and that is the point: a topic nothing consumes is silent — Cloud
 * Scheduler publishes, the messages sit until retention expires, and no counter
 * anywhere moves. Anything added here needs a consumer named in its reason.
 * Ratcheted below.
 */
const NO_PUSH_SUBSCRIPTION = new Map<string, string>();

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

describe("the three Pub/Sub topic lists agree (MONEY-1314)", () => {
  it("parsed all four arrays — a parser that finds nothing would pass everything", () => {
    // Hard floors. Measured 2026-09-01: 71 TS / 64 base / 64 worker / 7 edgar
    // / 72 gcp. `> 0` would be satisfied by a stale regex matching one line.
    assert.ok(TS_TOPICS.length >= 70, `only ${TS_TOPICS.length} PUBSUB_TOPICS`);
    assert.ok(
      BASE_TOPICS.length >= 60,
      `only ${BASE_TOPICS.length} BASE_TOPICS`,
    );
    assert.ok(
      WORKER_TOPICS.length >= 60,
      `only ${WORKER_TOPICS.length} BASE_WORKER_TOPICS`,
    );
    assert.ok(
      EDGAR_TOPICS.length >= 7,
      `only ${EDGAR_TOPICS.length} EDGAR_TOPICS`,
    );
    assert.ok(
      GCP_TOPICS.length >= 70,
      `only ${GCP_TOPICS.length} gcp BASE_TOPICS`,
    );
  });

  it("no array declares a topic twice", () => {
    for (const [name, list] of [
      ["PUBSUB_TOPICS", TS_TOPICS],
      ["BASE_TOPICS", BASE_TOPICS],
      ["BASE_WORKER_TOPICS", WORKER_TOPICS],
      ["EDGAR_TOPICS", EDGAR_TOPICS],
      ["gcp-setup BASE_TOPICS", GCP_TOPICS],
    ] as const) {
      const seen = new Map<string, number>();
      for (const t of list) seen.set(t, (seen.get(t) ?? 0) + 1);
      assert.deepEqual(
        [...seen.entries()]
          .filter(([, c]) => c > 1)
          .map(([t, c]) => `${t} x${c}`),
        [],
        `${name} declares a topic more than once`,
      );
    }
  });

  it("REGRESSION: setup-pubsub.sh creates exactly the declared topics", () => {
    assert.deepEqual(
      sorted(PUBSUB_SH_ALL),
      sorted(TS_TOPICS),
      "setup-pubsub.sh (BASE_TOPICS + EDGAR_TOPICS) disagrees with " +
        "PUBSUB_TOPICS. A topic declared in TS but never created makes every " +
        "publish fail at the API — inside Cloud Scheduler, where nobody is " +
        "looking. A topic created but not declared is one nothing can address.",
    );
  });

  it("REGRESSION: every created topic also gets a PUSH SUBSCRIPTION", () => {
    const unconsumed = sorted(BASE_TOPICS).filter(
      (t) => !WORKER_TOPICS.includes(t) && !NO_PUSH_SUBSCRIPTION.has(t),
    );
    assert.deepEqual(
      unconsumed,
      [],
      "These are in BASE_TOPICS but not BASE_WORKER_TOPICS, so the topic is " +
        "created and NOTHING CONSUMES IT. Cloud Scheduler publishes happily, " +
        "the messages sit until retention expires, and no counter anywhere " +
        "moves. Add them to BASE_WORKER_TOPICS, or to NO_PUSH_SUBSCRIPTION " +
        "with the consumer named.\n" +
        unconsumed.join("\n"),
    );

    // The other direction: a subscription for a topic this script never creates
    // would fail at provision time.
    const orphanSubs = sorted(WORKER_TOPICS).filter(
      (t) => !BASE_TOPICS.includes(t),
    );
    assert.deepEqual(
      orphanSubs,
      [],
      "push subscription for an uncreated topic",
    );
  });

  it("REGRESSION: gcp-setup.sh bootstraps every topic too", () => {
    const expected = sorted([...TS_TOPICS, ...INFRA_ONLY_TOPICS.keys()]);
    assert.deepEqual(
      sorted(GCP_TOPICS),
      expected,
      "gcp-setup.sh's own BASE_TOPICS disagrees with PUBSUB_TOPICS. It is the " +
        "FRESH-PROJECT bootstrap and runs before setup-pubsub.sh has ever been " +
        "used, so a topic missing here is a topic a brand-new environment does " +
        "not have. Before MONEY-1314 it held 26 of 64 and still carried the " +
        "retired `financial-data-sync`.",
    );
  });

  it("REGRESSION: the retired financial-data-sync is in NONE of the three", () => {
    // MONEY-1220 retired it. `tickertape-retired.test.ts` asserts its absence
    // from setup-pubsub.sh ONLY, which is exactly how it survived in
    // gcp-setup.sh for five months.
    assert.ok(!TS_TOPICS.includes("financial-data-sync"));
    assert.ok(!PUBSUB_SH_ALL.includes("financial-data-sync"));
    assert.ok(
      !GCP_TOPICS.includes("financial-data-sync"),
      "gcp-setup.sh would recreate the retired Tickertape topic on a fresh project",
    );
  });

  it("MONEY-1314: stock-document-ingest is declared, created AND consumed", () => {
    const t = PUBSUB_TOPICS.STOCK_DOCUMENT_INGEST;
    assert.equal(t, "stock-document-ingest");
    assert.ok(BASE_TOPICS.includes(t), "no topic in setup-pubsub.sh");
    assert.ok(
      WORKER_TOPICS.includes(t),
      "no PUSH SUBSCRIPTION — the topic would exist and nothing would consume it",
    );
    assert.ok(
      GCP_TOPICS.includes(t),
      "absent from the fresh-project bootstrap",
    );
  });

  it("no subscription anywhere carries a --message-filter", () => {
    // Pub/Sub filters read `attributes.*` ONLY. Every publisher in this repo
    // calls `publishMessage({ json })` or `({ data })`, neither of which sets an
    // attribute — so a filtered subscription would match zero messages and DROP
    // them, indistinguishably from a quiet queue.
    //
    // COMMENTS STRIPPED FIRST, and this test earned that the hard way: the
    // topic comments in setup-pubsub.sh spell `--message-filter` out loud while
    // explaining why there isn't one, so a raw substring check failed on a
    // correct file — matching its own warning. Same class as MONEY-1143.
    for (const [name, src] of [
      ["setup-pubsub.sh", SETUP_PUBSUB],
      ["gcp-setup.sh", GCP_SETUP],
    ] as const) {
      assert.ok(
        !stripBashComments(src).includes("--message-filter"),
        `${name} creates a filtered subscription; publishers set no attributes, ` +
          "so it would match nothing",
      );
    }

    // And the check must still be able to see a real one.
    assert.ok(
      stripBashComments(
        '  gcloud pubsub subscriptions create x \\\n    --message-filter="a=1"',
      ).includes("--message-filter"),
      "stripBashComments removed a live flag, not just a comment",
    );
  });

  it("[ratchet] every INFRA_ONLY_TOPICS entry is still a real divergence", () => {
    const stale: string[] = [];
    for (const [topic, reason] of INFRA_ONLY_TOPICS) {
      if (TS_TOPICS.includes(topic)) {
        stale.push(`${topic} — now HAS a PUBSUB_TOPICS entry — ${reason}`);
        continue;
      }
      if (!GCP_TOPICS.includes(topic)) {
        stale.push(`${topic} — no longer in gcp-setup.sh — ${reason}`);
      }
    }
    assert.deepEqual(
      stale,
      [],
      "These are permitted to be shell-only but no longer are. Delete their " +
        "lines — the list must only ever shrink, otherwise an exemption " +
        "outlives its reason and hides drift at the spot we already know is " +
        "dangerous.\n" +
        stale.join("\n"),
    );
  });

  it("[ratchet] every NO_PUSH_SUBSCRIPTION entry is still a real divergence", () => {
    const stale: string[] = [];
    for (const [topic, reason] of NO_PUSH_SUBSCRIPTION) {
      if (!BASE_TOPICS.includes(topic)) {
        stale.push(`${topic} — no longer created at all — ${reason}`);
      } else if (WORKER_TOPICS.includes(topic)) {
        stale.push(`${topic} — now HAS a push subscription — ${reason}`);
      }
    }
    assert.deepEqual(
      stale,
      [],
      "stale NO_PUSH_SUBSCRIPTION entries\n" + stale.join("\n"),
    );
  });

  it("[control] the comparisons can FAIL", () => {
    // Every assertion above is a deepEqual over parsed input. Prove the parse
    // and the comparison actually discriminate, so a silently-empty scan cannot
    // read as agreement.
    // The victim is chosen POSITIONALLY, not by name: naming a topic here
    // would make this control fail the day that topic is legitimately retired,
    // on top of the real failures, for a reason that has nothing to do with it.
    const victim = BASE_TOPICS[0]!;
    const withoutOne = BASE_TOPICS.filter((t) => t !== victim);
    assert.notDeepEqual(
      sorted([...withoutOne, ...EDGAR_TOPICS]),
      sorted(TS_TOPICS),
      "dropping a topic from BASE_TOPICS did not change the verdict",
    );

    const unconsumed = sorted(BASE_TOPICS).filter(
      (t) => !withoutOne.includes(t) && !NO_PUSH_SUBSCRIPTION.has(t),
    );
    assert.deepEqual(
      unconsumed,
      [victim],
      "the missing-push-subscription check does not discriminate",
    );

    // A comment-blind parser would pick topic names out of the prose — these
    // blocks are heavily commented and the comments DO quote topic names. Drive
    // the real parser with a synthetic array holding both shapes.
    const synthetic = [
      "declare -a BASE_TOPICS=(",
      '  "real-topic"',
      '  # "commented-out-topic" was deleted in MONEY-1205',
      '  # see also "another-ghost"',
      '  "second-real" # trailing note about "third-ghost"',
      ")",
    ].join("\n");
    assert.deepEqual(
      parseBashArray(synthetic, "BASE_TOPICS"),
      ["real-topic", "second-real"],
      "the parser reads topic names out of comments — a deleted topic would " +
        "count as present and a genuinely missing one would pass",
    );
  });

  it("[control] the scripts were actually read", () => {
    assert.ok(SETUP_PUBSUB.length > 10_000);
    assert.ok(GCP_SETUP.length > 5_000);
    assert.ok(BASE_TOPICS.includes("trade-pairing"));
    assert.ok(EDGAR_TOPICS.includes("edgar-detect"));
    assert.ok(GCP_TOPICS.includes("dead-letter"));
  });
});
