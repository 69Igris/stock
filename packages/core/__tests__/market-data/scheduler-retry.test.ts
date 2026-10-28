/**
 * ONLY named jobs retry a failed publish; everything else retries zero times —
 * MONEY-1379.
 *
 * Two prod schedulers — `news-rss-sync-market-hours-prod` (*_/5 9-15 * * 1-5)
 * and `alert-evaluator-market-hours-prod` (* 9-15 * * 1-5) — each hit
 * DEADLINE_EXCEEDED twice in 30 days (0.02-0.12% of attempts). Both are
 * pubsubTarget jobs, so the thing that timed out is Cloud Scheduler's own
 * Publish RPC, not our handler, and `retryConfig.retryCount` being ABSENT means
 * 0: each failure was one skipped tick with nothing to notice it.
 *
 * A retry is not free, which is why it is an ALLOW-LIST of exact names rather
 * than a rule about frequency. Scheduler re-PUBLISHES on retry — a NEW
 * messageId the dedupe middleware cannot pair with the first — so in the
 * ambiguous case (the publish landed, only the response timed out) the retry is
 * a genuine second run, CONCURRENT with the first.
 *
 * The first version of this was "sub-hourly schedules retry once", and it is
 * wrong in both directions: frequency says nothing about what a second run
 * COSTS. That set includes `us-filing-insight-sweep` (a PAID Gemini call per
 * owed document, still owed when the retry sweeps), `tiingo-news-poll` (a
 * metered vendor), `edgar-detect-minutely` (one shared per-IP SEC budget whose
 * penalty is a silent block) and `newsletter-publish-check` (sends EMAIL).
 *
 * ONLY `news-rss-sync` is on the list. `alert-evaluator` was REMOVED on review
 * despite being one of the two jobs that actually failed: its cooldown is a
 * read-then-write — `lastFiredAt` read from a findMany, stamped only AFTER
 * notifying — so two OVERLAPPING runs both pass it and both notify a user. And
 * it fires every minute, so the tick a retry saves is worth about sixty seconds
 * against a duplicate alert. `news-rss-sync` survives the same test: it handles
 * the concurrent duplicate per item with a P2002 fallback.
 *
 * THE RULE IS EVALUATED IN A REAL SHELL, never re-implemented here. A
 * TypeScript port of the case statement would happily agree with itself while
 * the shipped script was broken — the defect class this repo keeps hitting. So
 * case 2 lifts the derivation VERBATIM out of `setup-scheduler.sh` and runs it
 * under `bash -c`, which means a mutation to the file turns this test red.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "ops", "setup-scheduler.sh");
const TEXT = readFileSync(SCRIPT, "utf8");

const RETRY_FLAG = '--max-retry-attempts="$RETRY"';

/**
 * The `upsert_scheduler` body, from its opening line to the next top-level
 * close brace. The flags must be inside THIS function: the file also upserts
 * http-target jobs (the Cloud Run bulk/EDGAR ones), whose retry semantics are a
 * different question and are deliberately untouched.
 */
function upsertSchedulerBody(): string {
  const start = TEXT.indexOf("upsert_scheduler() {");
  assert.notEqual(start, -1, "upsert_scheduler() not found in the script");
  const end = TEXT.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "no top-level close brace after upsert_scheduler()");
  return TEXT.slice(start, end);
}

/**
 * The derivation itself, lifted verbatim — the `local MINUTE=...` line through
 * `esac`. Captured rather than retyped so that anything the file says here is
 * what gets executed below.
 */
function derivationLines(): string {
  const match = TEXT.match(/^\s*local RETRY=0\n[\s\S]*?esac\s*$/m);
  assert.ok(match, "the RETRY allow-list was not found in the script");
  return match[0];
}

/**
 * Run the file's own derivation against one schedule and read back $RETRY.
 *
 * Wrapped in a shell function because the extracted text uses `local`, which
 * bash refuses outside a function — wrapping keeps the lines byte-identical to
 * the file instead of editing them to fit the harness.
 */
function retryFor(name: string): string {
  const script = [
    `NAME='${name}'`,
    "derive() {",
    derivationLines(),
    'printf %s "$RETRY"',
    "}",
    "derive",
  ].join("\n");
  return execFileSync("bash", ["-c", script], { encoding: "utf8" });
}

describe("setup-scheduler.sh pubsub retry policy (MONEY-1379)", () => {
  it("passes --max-retry-attempts on BOTH the update and create branches", () => {
    const body = upsertSchedulerBody();

    // Two branches, two flags. An upsert that sets the retry count only on
    // `create` would leave every already-existing job — which is all of prod —
    // at the absent/0 it has today, and the change would look applied.
    const inBody = body.split(RETRY_FLAG).length - 1;
    assert.equal(inBody, 2, `expected 2 ${RETRY_FLAG} in upsert_scheduler()`);

    const inFile = TEXT.split(RETRY_FLAG).length - 1;
    assert.equal(inFile, 2, "the flag must not leak into the http-target jobs");
  });

  it("retries ONLY the named jobs, evaluated in a real shell", () => {
    // An ALLOW-LIST, not a frequency heuristic. The first version of this rule
    // was "sub-hourly schedules retry once", which is wrong in both directions:
    // it hands a retry to us-filing-insight-sweep (*/10, PAID Gemini per owed
    // document), tiingo-news-poll (*/2, a metered vendor), edgar-detect-minutely
    // (a shared per-IP SEC budget) and newsletter-publish-check (*/5, sends
    // EMAIL). Frequency says nothing about what a second run costs.
    //
    // Every spelling of the ONE job on the list. `news-rss-sync` is there
    // because it handles a concurrent duplicate explicitly (P2002 per item),
    // which is what a retry actually requires — not because it is frequent.
    for (const name of [
      "news-rss-sync-market-hours-prod",
      "news-rss-sync-market-hours-qa",
      "news-rss-sync-off-hours-prod",
      "news-rss-sync-off-hours-qa",
    ])
      assert.equal(retryFor(name), "1", `${name} should retry once`);

    // Every one of these is sub-hourly, so the OLD heuristic would have granted
    // each a retry. That is the regression this case exists to hold.
    for (const name of [
      "us-filing-insight-sweep-prod", // */10 — a paid Gemini call per document
      "tiingo-news-poll-prod", // */2  — a metered vendor quota
      "edgar-detect-minutely-prod", // *    — one shared per-IP SEC budget
      "newsletter-publish-check-prod", // */5  — sends email
      "broker-sync-market-hours-prod", // */30 — 64 shard messages per publish
      "instrument-sync-daily-prod", // daily, for good measure

      // REMOVED from the allow-list on review, even though it is one of the
      // two jobs that actually failed. The retry's premise is the ambiguous
      // case — the publish landed, only the response timed out — so the second
      // run executes CONCURRENTLY. alert-evaluator's cooldown is a
      // read-then-write (`lastFiredAt` read from a findMany, stamped only
      // after notifying), so two overlapping runs both pass it and both
      // notify: a duplicate alert, to a user. And it runs every MINUTE, so the
      // tick a retry would save is worth about sixty seconds.
      "alert-evaluator-market-hours-prod",
      "alert-evaluator-off-hours-prod",

      // EXACT names, not a `news-rss-sync-*` glob: a future job in the family
      // must not inherit the retry silently.
      "news-rss-sync-backfill-prod",
    ])
      assert.equal(retryFor(name), "0", `${name} must NOT retry`);
  });

  it("leaves the script syntactically valid", () => {
    // The edit sits inside a function full of line continuations; a stray one
    // would break every scheduler in the repo and nothing else here would see
    // it, because the rest of this file only reads the text.
    assert.doesNotThrow(() => execFileSync("bash", ["-n", SCRIPT]));
  });
});
