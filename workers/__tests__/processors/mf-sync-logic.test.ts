/**
 * MF sync — COMPLETENESS judgement — REAL exports (MONEY-1404 C1).
 *
 * Source: workers/src/processors/mf-sync-logic.ts (imported and CALLED by
 * workers/src/processors/mf-sync.ts).
 *
 * ## What this is guarding
 *
 * `syncAmfiMutualFunds` throws when the feed parses to ZERO — the MONEY-1403
 * shape. Nothing had an opinion about the PARTIAL, and a partial is the shape a
 * grammar change usually takes first: AMFI's 2026-08-19 column move broke every
 * row, but a move inside ONE section, or a truncated download, breaks a slice
 * and reports `parsed=7000, upserted=7000, failed=0` — a clean success line
 * over half the platform's NAVs.
 *
 * The numbers below are MEASURED on prod (2026-09-13), not invented, because
 * the threshold is only meaningful against the real floor: the last healthy run
 * (2026-08-18 22:31 IST) left 191 of 14,225 active schemes un-priced = 1.343%.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  judgeMfSyncCompleteness,
  MF_SYNC_MAX_MISSING_PCT,
  MF_SYNC_MISSING_SAMPLE_CAP,
} from "../../src/processors/mf-sync-logic";

/** `n` synthetic scheme codes, shaped like AMFI's (six digits). */
const codes = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => String(100_000 + i));

describe("judgeMfSyncCompleteness (real export)", () => {
  it("PROD FLOOR: 191 of 14,225 missing is 1.343% and stays OK", () => {
    // The calibration case. If this ever flips to `ok: false` the job throws
    // EVERY night on a healthy feed, which is how a real alarm gets muted.
    //
    // MUTATION: MF_SYNC_MAX_MISSING_PCT 2 -> 1 -> RED here.
    const v = judgeMfSyncCompleteness({
      activeSchemes: 14_225,
      missingSchemeCodes: codes(191),
    });
    assert.equal(v.ok, true);
    assert.equal(v.missingCount, 191);
    assert.equal(v.missingPct.toFixed(3), "1.343");
  });

  it("a whole AMC vanishing is NOT ok — 4% of the universe", () => {
    // The case the rule exists for. NIPPON is ~4% of the master, so one AMC's
    // block failing to parse lands here and nowhere else: the feed is
    // structurally fine, nothing throws, `failed` is 0.
    //
    // MUTATION: `missingPct <= MAX` -> `missingPct <= 100` -> RED.
    const v = judgeMfSyncCompleteness({
      activeSchemes: 14_225,
      missingSchemeCodes: codes(569),
    });
    assert.equal(v.ok, false);
    assert.ok(
      v.missingPct > MF_SYNC_MAX_MISSING_PCT,
      `${v.missingPct}% should exceed the ${MF_SYNC_MAX_MISSING_PCT}% threshold`,
    );
  });

  it("the threshold is a CEILING, not a floor — exactly 2% is still ok", () => {
    // Pins the comparison direction. `<` and `<=` differ by one run a year and
    // by nothing a reader can see.
    //
    // MUTATION: `<=` -> `<` -> RED (200/10,000 is exactly 2%).
    const at = judgeMfSyncCompleteness({
      activeSchemes: 10_000,
      missingSchemeCodes: codes(200),
    });
    assert.equal(at.missingPct, 2);
    assert.equal(at.ok, true);

    const justOver = judgeMfSyncCompleteness({
      activeSchemes: 10_000,
      missingSchemeCodes: codes(201),
    });
    assert.equal(justOver.ok, false);
  });

  it("the sample is capped at 20 and is a PREFIX of the missing codes", () => {
    // A failure message carrying 6,000 scheme codes is a failure message nobody
    // reads, and Datadog truncates it anyway.
    //
    // MUTATION: `.slice(0, CAP)` -> `.slice(0)` -> RED on the length.
    const missing = codes(6_000);
    const v = judgeMfSyncCompleteness({
      activeSchemes: 14_225,
      missingSchemeCodes: missing,
    });
    assert.equal(v.sample.length, MF_SYNC_MISSING_SAMPLE_CAP);
    assert.equal(MF_SYNC_MISSING_SAMPLE_CAP, 20);
    assert.deepEqual(v.sample, missing.slice(0, 20));
    // The COUNT is not the sample — reporting 20 missing out of 6,000 would be
    // the same under-report as a capped error list standing in for the errors.
    assert.equal(v.missingCount, 6_000);
  });

  it("a shortfall SMALLER than the cap reports every code it has", () => {
    const v = judgeMfSyncCompleteness({
      activeSchemes: 100,
      missingSchemeCodes: ["100001", "100002", "100003"],
    });
    assert.deepEqual(v.sample, ["100001", "100002", "100003"]);
    assert.equal(v.missingCount, 3);
    assert.equal(v.missingPct, 3);
    assert.equal(v.ok, false);
  });

  it("a PERFECT run is ok, and reports 0 rather than nothing", () => {
    const v = judgeMfSyncCompleteness({
      activeSchemes: 14_225,
      missingSchemeCodes: [],
    });
    assert.deepEqual(v, {
      ok: true,
      missingCount: 0,
      missingPct: 0,
      sample: [],
    });
  });

  it("an EMPTY master yields 0%, never NaN", () => {
    // `0/0` is NaN, and `NaN > 2` is false — so an un-guarded division would
    // silently return `ok: true` AND put `NaN%` in the log line, which no
    // Datadog filter can match. An empty master is a different failure
    // (nothing has ever populated it) and belongs to whatever populates it.
    //
    // MUTATION: dropped the `activeSchemes > 0` guard -> RED (missingPct is
    // NaN, so both assertions below fail).
    const v = judgeMfSyncCompleteness({
      activeSchemes: 0,
      missingSchemeCodes: [],
    });
    assert.equal(Number.isNaN(v.missingPct), false);
    assert.equal(v.missingPct, 0);
    assert.equal(v.ok, true);
  });
});

describe("mf-sync wires the completeness rule (MONEY-1404 C1)", () => {
  // The judgement above is pure and provable. What it cannot prove is that the
  // processor CALLS it — the `judgeMfNavBackfillHealth` precedent is that a
  // computed-but-unread verdict is exactly the bug (`budgetExhausted` was
  // computed, logged, and judged by nothing until MONEY-1238). A source scan is
  // the cheap half of that; the expensive half would need a Prisma double.
  const SRC = new URL("../../src/processors/mf-sync.ts", import.meta.url)
    .pathname;

  it("every path out of the sync reports, and the report precedes the throw", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(SRC, "utf8");

    assert.match(src, /judgeMfSyncCompleteness\(/);

    // TWO reports and no more: one in the feed-unreadable catch, one on the
    // single path out of the completeness block. A third would mean a branch
    // reports twice; a first-and-only would mean a branch reports never.
    const reports = src.match(/reportJobOutcome\(\{/g) ?? [];
    assert.equal(
      reports.length,
      2,
      "expected exactly two reportJobOutcome call sites (catch + the one on " +
        "every success path); a new branch must not get its own",
    );

    // A SHORTFALL THROWS, and `unhealthy: true` rides alongside it.
    //
    // This assertion was INVERTED for one commit — it required the throw to be
    // ABSENT, on the grounds that `stockbook.job.unhealthy` was "a real series
    // a monitor can alert on". It can; nothing does. No monitor in
    // `scripts/ops/` queries it, and neither `mf-sync` row in
    // `apply-monitors.sh` can fire on a short night (`selected=14300
    // written=14300 failed=0` is green in both). So the removal made a partial
    // AMFI file silent everywhere, and the fix is NOT a new monitor over a
    // series prod has never emitted — that is MONEY-1238.
    //
    // The throw comes out when the series has been observed on prod for >= 3
    // nights AND a monitor row exists. Until then the 5-redelivery cost is
    // being paid deliberately, and this test is what makes removing it a
    // decision rather than an edit.
    // MUTATION: drop the throw (or downgrade it to console.error) -> RED.
    assert.match(
      src,
      /throw new Error\(\s*`\[mf-sync\] AMFI priced/,
      "a completeness shortfall must THROW while nothing alerts on " +
        "stockbook.job.unhealthy — see the comment on that branch",
    );

    // ORDER still matters: the counter must be emitted BEFORE the throw, or a
    // shortfall leaves the failing path with no counter at all — the
    // MONEY-1403 invisibility, one branch over.
    // MUTATION: move the reportJobOutcome below the throw -> RED.
    const lastReport = src.lastIndexOf("reportJobOutcome({");
    const narrated = src.indexOf("`[mf-sync] AMFI priced only ${coverage}");
    assert.ok(
      lastReport > 0 && narrated > 0,
      "the failing path moved — retarget",
    );
    assert.ok(
      lastReport < narrated,
      "reportJobOutcome must be emitted before the shortfall is narrated",
    );

    // GENUINE failures must still throw, or removing the shortfall throw would
    // have quietly disarmed retry for the transient cases too — a fetch that
    // 500s IS worth redelivering, which is the distinction the old code
    // collapsed into one exit.
    // MUTATION: delete the feed-unreadable rethrow -> RED.
    assert.match(
      src,
      /feed-unreadable: \$\{message\}[\s\S]{0,400}?throw error;/,
      "the feed-unreadable path must still rethrow — that failure IS " +
        "transient and a redelivery can fix it",
    );

    // THE COMPLETENESS QUERY IS INSIDE A TRY. Two Prisma round trips sit
    // between a successful ~14,300-row write and the report; unwrapped, a blip
    // on either means the rows are stored and nothing is emitted, and the new
    // `mf-sync|36h|standing` monitor then pages about a run that worked.
    // MUTATION: unwrap the try -> RED.
    const queryAt = src.indexOf("prisma.mutualFundMaster.count({");
    const tryAt = src.lastIndexOf("try {", queryAt);
    const catchAt = src.indexOf("} catch (error) {", queryAt);
    assert.ok(
      tryAt > 0 && catchAt > queryAt,
      "the completeness query must sit inside a try/catch — an unreported " +
        "success is indistinguishable from a dead job",
    );

    // THREE distinct reason prefixes. "AMFI changed the file", "AMFI served us
    // most of it" and "we could not tell" need three different responses, and
    // a Datadog reader can only separate them if they are spelled differently.
    assert.match(src, /feed-unreadable: \$\{message\}/);
    assert.match(src, /incomplete: \$\{coverage\}/);
    assert.match(src, /completeness-unmeasured: \$\{coverage\}/);
  });

  it("an UNMEASURABLE completeness never reads as a pass, and never throws", async () => {
    // The fail-open this gate exists to prevent, from the other side: a check
    // that could not run must not report a clean pass — and must not throw
    // either, because the sync itself succeeded and a throw would redeliver a
    // good 14,300-row run.
    // MUTATION: make the catch rethrow -> RED. MUTATION: drop the null arm
    // from `shortfall` so an unmeasured run reports clean -> RED.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(SRC, "utf8");

    assert.match(
      src,
      /completeness === null\s*\?\s*`completeness-unmeasured/,
      "an unmeasured completeness must produce its own skippedReason",
    );

    // SCOPED TO THE `if`, not to the file. The same expression also appears in
    // the `shortfall` ternary above, so a bare `assert.match` on the source
    // matches that one and says nothing about the guard on the throw — my own
    // first cut of this assertion did exactly that and survived the mutation
    // `if (completeness !== null && !completeness.ok)` -> `if (!completeness?.ok)`,
    // which makes an UNMEASURED run throw.
    assert.match(
      src,
      /if \(completeness !== null && !completeness\.ok\) \{/,
      "the throw must require a completeness that ACTUALLY RAN and failed",
    );

    // THE CATCH MUST NOT RETHROW. Scoped to the catch body for the same reason:
    // the sync succeeded, and a throw here redelivers a good 14,300-row run
    // five times before dead-lettering it.
    const catchAt = src.indexOf(
      "} catch (error) {",
      src.indexOf("prisma.mutualFundMaster.count({"),
    );
    const catchBody = src.slice(catchAt, src.indexOf("\n  }", catchAt));
    assert.ok(catchAt > 0, "the completeness catch moved — retarget this scan");
    assert.doesNotMatch(
      catchBody,
      /\bthrow\b/,
      "the completeness catch must not rethrow — the WRITE succeeded",
    );
  });

  it("every non-green state is also emitted as a METRIC, not just prose", async () => {
    // MONEY-1401 review finding 5(a). `skippedReason` reaches a LOG LINE and
    // nothing queries a log line, so `completeness-unmeasured` emitted
    // `selected=14300, written=14300, failed=0` at INFO — byte-identical to a
    // pass in every Datadog surface, while the comment above it claimed a
    // check that failed to run must not read as a pass. `unhealthy` is the
    // queryable half (`stockbook.job.unhealthy`).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(SRC, "utf8");

    // (1) THE FEED-UNREADABLE CATCH. It rethrows, so Pub/Sub retries — but the
    //     counter must not wait 25 minutes for a dead letter to say so.
    //     MUTATION: drop `unhealthy: true` from the catch report -> RED.
    const catchReport = src.slice(
      src.indexOf("reportJobOutcome({"),
      src.indexOf("throw error;"),
    );
    assert.ok(catchReport.length > 0, "the catch report moved — retarget");
    assert.match(catchReport, /unhealthy: true/);
    assert.match(catchReport, /feed-unreadable/);

    // (2) THE SUCCESS PATH. `unhealthy` must ride the SAME ternary as
    //     `skippedReason`, which is what ties it to the two non-green states
    //     and only those.
    //
    //     MUTATION: drop `unhealthy: true` from the spread -> RED (the check
    //     is invisible again). MUTATION: hoist it out of the ternary to a bare
    //     `unhealthy: true,` -> RED (every healthy night marked unhealthy,
    //     which is how a real alarm gets muted).
    // Sliced to the CALL, not to the next statement: prose between the two
    // mentions the field and would satisfy the scan for free.
    const successAt = src.lastIndexOf("reportJobOutcome({");
    const successReport = src.slice(
      successAt,
      src.indexOf("});", successAt) + 3,
    );
    assert.ok(successReport.length > 0, "the success report moved — retarget");
    assert.match(
      successReport,
      /\.\.\.\(shortfall \? \{ skippedReason: shortfall, unhealthy: true \} : \{\}\)/,
    );
    assert.doesNotMatch(
      successReport.replace(/\.\.\.\(shortfall \?[^)]*\)/, ""),
      /unhealthy/,
      "a healthy run must not be reported unhealthy — the field belongs to " +
        "the shortfall ternary and nowhere else on this call",
    );
  });

  it("the missing query carries ALL THREE arms, isSet included", async () => {
    // `lastSyncedAt` is `DateTime?` and the missing set needs three arms,
    // because two of them each miss a different population:
    //
    //   { lt: runStartedAt }        drops every row with no value at all
    //   { lastSyncedAt: null }      on Prisma + MongoDB matches ONLY documents
    //                               that CARRY the key — so a row whose field
    //                               was never written is still invisible
    //   { lastSyncedAt: isSet:false }   the arm that sees those rows
    //
    // This assertion used to pin the exact two-arm SPELLING, and its own
    // comment described the property the third arm provides — "a scheme that
    // has NEVER been synced counts as priced" — while the regex did nothing to
    // prevent it. `apps/web/__tests__/meta/prisma-null-vs-isset.test.ts` caught
    // the real query; this one should have. MONEY-1050 / 1205 / 1234 / 1236.
    //
    // The direction is why it is worth three assertions: dropping the unset
    // rows makes `missing` UNDER-count, so the gate passes and the run reports
    // healthy while the schemes it cannot see are exactly the ones nothing has
    // ever priced. A completeness check that fails OPEN is worse than none.
    //
    // Matched per-arm against whitespace-collapsed source rather than as one
    // literal, so reformatting the query cannot break the test and dropping an
    // arm cannot pass it. MUTATION: delete any one arm -> RED.
    const { readFileSync } = await import("node:fs");
    const flat = readFileSync(SRC, "utf8").replace(/\s+/g, " ");

    const where = flat.slice(
      flat.indexOf(
        "const missingRows = await prisma.mutualFundMaster.findMany",
      ),
    );
    assert.ok(where.length > 0, "the missing query moved — retarget this scan");
    const clause = where.slice(0, where.indexOf("select:"));

    assert.match(clause, /\{ lastSyncedAt: \{ lt: runStartedAt \} \}/);
    assert.match(clause, /\{ lastSyncedAt: null \}/);
    assert.match(
      clause,
      /\{ lastSyncedAt: \{ isSet: false \} \}/,
      "without the isSet arm a never-synced scheme counts as priced",
    );
  });
});
