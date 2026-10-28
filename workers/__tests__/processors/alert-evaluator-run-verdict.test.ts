/**
 * UNIT TEST — alert-evaluator must COUNT what it swallows, and must not call a
 * dead field a delivery channel. MONEY-1238, item 5.
 *
 * ## The defect
 *
 * `processAlertEvaluator` returned `void`, had NO failure counter of any kind,
 * and reached Prisma through EIGHT `.catch(() => null)` / `.catch(() => [])`
 * sites. Each makes a database error identical to an empty table:
 *
 *     resolveInstrumentId       .catch(() => null)
 *     latestQuote.findUnique    .catch(() => null)
 *     dailyPrice.findMany       .catch(() => [])
 *     upcomingEvent (earnings)  .catch(() => null)
 *     newsArticle.findMany      .catch(() => [])
 *     upcomingEvent (corp act)  .catch(() => null)
 *     stockFlag.groupBy         .catch(() => [])
 *     institutionalFlow.groupBy .catch(() => [])
 *
 * The last two are market-WIDE and cached per run, so `stockFlag.groupBy`
 * breaking silently stops every FLAG_TRANSITION alert for every user at once —
 * across 1,440 runs a day, each logging `fired 0` and returning 200. No number
 * anywhere moves. (The count was described as "seven" when the ticket was
 * filed; the audit found eight.)
 *
 * One layer down, `createNotification(...).catch(() => {})` followed by
 * `triggered = true` meant a notification that never landed was recorded as
 * delivered AND stamped `lastFiredAt`, so the cooldown then suppressed the
 * retry that could have healed it.
 *
 * ## `notifyChannels`: wired, not deleted — and here is the reasoning
 *
 * The field was declared on two of the processor's alert types and read by
 * nothing. That is worse than absent: a field named for a delivery channel
 * reads as coverage, and what it actually describes is a gap. This worker
 * writes a `Notification` row and nothing else, while BOTH creation surfaces
 * tick Email by default (`NewAlertDrawer.tsx:772` seeds `["app","email"]`;
 * `AlertConfigModal.tsx:103` seeds `new Set(["IN_APP","EMAIL"])`).
 *
 * Deleting it would hide a live product gap. Wiring real email needs
 * `@usemoney/email`, a template and a sender identity — a feature, not a bug
 * fix, and outside this change's file set. So it is wired to the one decider
 * reachable from here: the run's reported numbers. `silentFires` counts alerts
 * that fired asking for NO channel this worker can deliver — a user who unticks
 * In-app and keeps Email gets an in-app row they did not ask for, no email, and
 * a `lastFiredAt` claiming delivery. That is now a measured number instead of
 * an assumption.
 *
 * ## What is asserted
 *
 * BEHAVIOUR on the real `judgeAlertRun` / `undeliverableChannels` /
 * `isSilentDelivery`, plus WIRING: every swallow goes through the counting
 * helper, the notification outcome decides `triggered`, and the route splits
 * transient from deterministic the way `routes/xbrl-sync.ts` does.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  judgeAlertRun,
  undeliverableChannels,
  isSilentDelivery,
  DELIVERABLE_CHANNELS,
  type AlertRunTotals,
} from "../../src/processors/alert-evaluator-logic";

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

function blankComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

const PROC_RAW = readFileSync(
  join(repoRoot(), "workers", "src", "processors", "alert-evaluator.ts"),
  "utf8",
);
const PROC = blankComments(PROC_RAW);

const ROUTE_RAW = readFileSync(
  join(repoRoot(), "workers", "src", "routes", "alert-evaluator.ts"),
  "utf8",
);
const ROUTE = blankComments(ROUTE_RAW);

/** A run in which everything worked. */
const clean: AlertRunTotals = {
  marketWideDataErrors: 0,
  evaluated: 40,
  fired: 3,
  suppressedAsRepeat: 5,
  dataErrors: 0,
  notifyFailures: 0,
  alertErrors: 0,
};

describe("alert-evaluator run verdict (MONEY-1238)", () => {
  it("a clean run is ok with no reason", () => {
    assert.deepEqual(judgeAlertRun(clean), {
      ok: true,
      retriable: false,
      reason: null,
    });
  });

  it("REGRESSION: firing ZERO is not itself a failure", () => {
    // Most minutes nothing crosses a threshold. A verdict that treated
    // `fired === 0` as broken would fire on almost every one of the 1,440 daily
    // runs and be switched off — which is how the real signal gets lost.
    assert.equal(judgeAlertRun({ ...clean, fired: 0 }).ok, true);
  });

  it("REGRESSION: a swallowed MARKET-WIDE read is NOT ok, and RETRIABLE", () => {
    // The market-wide `stockFlag.groupBy` case: one rejection, every
    // FLAG_TRANSITION alert on the platform evaluated against an empty list,
    // and the old code logged `fired 0` and returned 200.
    const v = judgeAlertRun({
      ...clean,
      dataErrors: 1,
      marketWideDataErrors: 1,
    });
    assert.equal(v.ok, false);
    assert.equal(v.retriable, true);
    assert.match(v.reason ?? "", /MARKET-WIDE database read/);
    assert.match(v.reason ?? "", /not absent, only unreadable/);
  });

  it("REGRESSION: a PER-SYMBOL read failure is not ok, and NOT retriable", () => {
    // MONEY-1236. `retriable: true` on ANY dataErrors meant one transient
    // `latestQuote` lookup for ONE user's alert NACKed the whole run — of a
    // cron that fires EVERY 60 SECONDS, so the redelivery lands concurrently
    // with the next scheduled tick. `isWithinCooldown` returns false for
    // `cooldownMinutes: 0`, so a user with no cooldown is re-notified on the
    // redelivery. A per-symbol read is isolated by design: report it, never
    // replay the run for it.
    const v = judgeAlertRun({
      ...clean,
      dataErrors: 3,
      marketWideDataErrors: 0,
    });
    assert.equal(v.ok, false);
    assert.equal(
      v.retriable,
      false,
      "a 60s cron must not replay for one symbol",
    );
    assert.match(v.reason ?? "", /per-symbol database read/);
  });

  it("a failed NOTIFICATION is not ok, and is RETRIABLE", () => {
    // The condition fired and the user was not told. A redelivery genuinely
    // helps now, because `lastFiredAt` is no longer stamped for a write that
    // did not land.
    const v = judgeAlertRun({ ...clean, notifyFailures: 2 });
    assert.equal(v.ok, false);
    assert.equal(v.retriable, true);
    assert.match(v.reason ?? "", /the user was not told/);
  });

  it("an alert that THREW is not ok, and is NOT retriable", () => {
    // A malformed `conditions` payload throws identically on every attempt and
    // the loop already steps over it. Five redeliveries of a cron that fires
    // again in sixty seconds would buy nothing and cost a dead-letter alert.
    const v = judgeAlertRun({ ...clean, alertErrors: 1 });
    assert.equal(v.ok, false);
    assert.equal(v.retriable, false);
    assert.match(v.reason ?? "", /acked rather than redelivered/);
  });

  it("TRANSPORT outranks deterministic — the recoverable failure is named", () => {
    // Both present. Reporting the deterministic one would ack a run whose
    // MARKET-WIDE reads failed, discarding the retry that could have fixed it.
    const v = judgeAlertRun({
      ...clean,
      dataErrors: 1,
      marketWideDataErrors: 1,
      alertErrors: 9,
    });
    assert.equal(v.retriable, true);
    assert.match(v.reason ?? "", /MARKET-WIDE database read/);
  });

  it("a market-wide failure outranks a per-symbol one in the reason", () => {
    // Both scopes present: the reason must name the one that decided the
    // retry, or an operator reads the wrong blast radius.
    const v = judgeAlertRun({
      ...clean,
      dataErrors: 7,
      marketWideDataErrors: 1,
    });
    assert.equal(v.retriable, true);
    assert.match(v.reason ?? "", /1 MARKET-WIDE/);
  });

  it("a notify failure still outranks a deterministic alert error", () => {
    const v = judgeAlertRun({ ...clean, notifyFailures: 1, alertErrors: 9 });
    assert.equal(v.retriable, true);
    assert.match(v.reason ?? "", /the user was not told/);
  });
});

describe("alert-evaluator delivery channels (MONEY-1238)", () => {
  it("this worker delivers IN_APP and nothing else", () => {
    // The honest statement of scope. If EMAIL or PUSH ever ships, this constant
    // is the one line to change and every count below follows.
    assert.deepEqual([...DELIVERABLE_CHANNELS], ["IN_APP"]);
  });

  it("an in-app-only alert has no gap", () => {
    assert.deepEqual(undeliverableChannels(["IN_APP"]), []);
    assert.equal(isSilentDelivery(["IN_APP"]), false);
  });

  it("the DEFAULT both UIs write is partially undeliverable", () => {
    // `["IN_APP","EMAIL"]` — the user is told in-app and never emailed. Not
    // silent, but not what they asked for either.
    assert.deepEqual(undeliverableChannels(["IN_APP", "EMAIL"]), ["EMAIL"]);
    assert.equal(isSilentDelivery(["IN_APP", "EMAIL"]), false);
  });

  it("REGRESSION: EMAIL-only means the user is notified on NOTHING", () => {
    // The expensive case, and the one the dead field concealed: an in-app row
    // they did not ask for, no email, and a `lastFiredAt` recording success.
    assert.deepEqual(undeliverableChannels(["EMAIL"]), ["EMAIL"]);
    assert.equal(isSilentDelivery(["EMAIL"]), true);
    assert.equal(isSilentDelivery(["EMAIL", "PUSH"]), true);
    assert.equal(isSilentDelivery(["PUSH"]), true);
  });

  it("an EMPTY list means IN_APP, matching sanitizeChannels", () => {
    // `sanitizeChannels` (packages/services) defaults an empty or all-invalid
    // list to ["IN_APP"], but rows written before that guard can still be
    // empty. The two must not disagree about what empty means, or a legacy row
    // would be counted as a silent fire forever.
    assert.deepEqual(undeliverableChannels([]), []);
    assert.equal(isSilentDelivery([]), false);
  });

  it("an unknown channel counts as undeliverable, not as ignorable", () => {
    // A value we do not recognise is certainly not one we deliver. Treating it
    // as harmless is the fail-open shape this repo has a standing rule against.
    assert.deepEqual(undeliverableChannels(["SMS"]), ["SMS"]);
    assert.equal(isSilentDelivery(["SMS"]), true);
  });
});

describe("alert-evaluator: the counters are WIRED (MONEY-1238)", () => {
  it("[meta] both sources this file reasons over actually loaded", () => {
    assert.ok(
      PROC_RAW.length > 8000,
      `alert-evaluator.ts did not load (${PROC_RAW.length}B)`,
    );
    assert.ok(ROUTE_RAW.length > 500, "the route did not load");
    assert.ok(PROC.includes("processAlertEvaluator"));
  });

  it("[meta] the stripper strips LINE before BLOCK", () => {
    const src = [
      "// a line comment mentioning /* an unterminated block",
      "const verdict = judgeAlertRun(totals);",
      "/* a block mentioning .catch(() => null) inside */",
    ].join("\n");
    const out = blankComments(src);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.ok(out.includes("judgeAlertRun(totals)"));
    assert.ok(!/\.catch\(\(\) => null\)/.test(out));
  });

  it("REGRESSION: not one bare read-swallow survives", () => {
    // The whole defect, as a shape. `readOr` keeps the identical fallback
    // behaviour — one unreadable table must not abort the other eleven alert
    // kinds — and makes the swallow visible in a counter.
    assert.doesNotMatch(PROC, /\.catch\(\(\) => null\)/);
    assert.doesNotMatch(PROC, /\.catch\(\s*\(\) =>\s*\[\]/);
  });

  it("REGRESSION: not one fire-and-forget notification survives", () => {
    assert.doesNotMatch(
      PROC,
      /\.catch\(\(\) => \{\}\)/,
      "a notification whose failure is discarded lets `triggered` record a " +
        "delivery that never happened",
    );
    assert.doesNotMatch(
      PROC,
      /\bcreateNotification\b/,
      "the never-throw, never-report variant must not be used here — " +
        "tryCreateNotification returns the outcome",
    );
  });

  it("every swallowed read goes through the counting helper", () => {
    // Eight reads were swallowed. Each must be a `readOr` call site, or the
    // count it feeds is a lie by omission.
    const sites = PROC.match(/await readOr\(/g) ?? [];
    assert.equal(
      sites.length,
      8,
      `expected all 8 swallowed reads to be counted, found ${sites.length}`,
    );
    assert.match(
      PROC,
      /tally\.dataErrors\+\+;/,
      "the helper must actually increment",
    );
  });

  it("the notification OUTCOME is what sets `triggered`", () => {
    assert.match(
      PROC,
      /const written = await tryCreateNotification\(data\);/,
      "the write outcome must be observed",
    );
    assert.match(PROC, /if \(!written\) tally\.notifyFailures\+\+;/);
    assert.match(
      PROC,
      /triggered = await notify\(tally, \{/,
      "the data-engine branch must take `triggered` from the write, not " +
        "assume it",
    );
  });

  it("an alert that throws is counted, not merely logged past", () => {
    assert.match(PROC, /tally\.alertErrors\+\+;\n\s*console\.warn\(/);
  });

  it("`notifyChannels` is READ — the field is no longer dead", () => {
    // The instruction was wire it or delete it. This is the wiring: it decides
    // two reported numbers. If both call sites vanish, the field is decorative
    // again and this fails.
    assert.match(
      PROC,
      /undeliverableChannels\(alert\.notifyChannels \?\? \[\]\)/,
    );
    assert.match(PROC, /isSilentDelivery\(alert\.notifyChannels \?\? \[\]\)/);
    assert.match(PROC, /tally\.silentFires\+\+;/);
    assert.match(PROC, /tally\.channelGap\+\+;/);
  });

  it("REGRESSION: no evaluator DECLARES notifyChannels without reading it", () => {
    // `evaluatePrice` took `notifyChannels: string[]` and never touched it —
    // the shape that reads as coverage. Exactly one declaration may remain: the
    // loop's row cast, which is the one place that now reads it.
    const declarations = PROC.match(/notifyChannels: string\[\];/g) ?? [];
    assert.equal(
      declarations.length,
      1,
      `expected the field to be declared only where it is read; found ` +
        `${declarations.length} declaration(s)`,
    );
  });

  it("the run RETURNS its outcome instead of dropping it", () => {
    assert.match(PROC, /\): Promise<AlertEvaluatorResult> \{/);
    assert.match(PROC, /const verdict = judgeAlertRun\(totals\);/);
  });

  it("the run tally is per-RUN, never module scope", () => {
    assert.match(PROC, /const tally: RunTally = \{\n\s*dataErrors: 0,/);
  });
});

describe("alert-evaluator route: failure CLASS picks the code (MONEY-1238)", () => {
  it("a TRANSIENT failure 500s so Pub/Sub redelivers", () => {
    assert.match(
      ROUTE,
      /if \(result\.retriable\) \{\s*\n\s*return c\.json\(\{ success: false, \.\.\.result \}, 500\);/,
    );
  });

  it("a DETERMINISTIC failure ACKs — no retry storm on a per-minute cron", () => {
    // The house idiom from routes/xbrl-sync.ts. Blanket-500ing a cron that
    // fires every 60s turns one bad alert row into a dead-letter flood.
    assert.match(
      ROUTE,
      /return c\.json\(\{ success: false, retried: false, \.\.\.result \}, 200\);/,
    );
    assert.match(ROUTE, /console\.error\(/);
  });

  it("REGRESSION: the route no longer 200s unconditionally", () => {
    assert.match(
      ROUTE,
      /const result = await processAlertEvaluator\(data\);/,
      "the route must observe the run's outcome to be able to act on it",
    );
    assert.doesNotMatch(
      ROUTE,
      /await processAlertEvaluator\(data\);\s*\n\s*\n?\s*return c\.json\(\{ success: true \}, 200\);/,
    );
  });
});
