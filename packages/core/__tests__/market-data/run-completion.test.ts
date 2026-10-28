/**
 * UNIT TEST — did the run actually finish? (MONEY-1189)
 *
 * The load-bearing case is `abandoned when control flow never reached the end`.
 * `feed-parse` processed 11 of 21 files, exited 0, and printed neither an error
 * nor its own summary line — indistinguishable from success to every caller.
 *
 * The second load-bearing case is the inverse: a run that DID reach its end
 * having processed fewer units than planned is NOT abandoned. feed-parse counts
 * unreadable files as skips by design, and failing those runs would turn this
 * signal into noise everyone learns to ignore.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  judgeRunCompletion,
  withHardTimeout,
} from "../../src/market-data/run-completion";

describe("judgeRunCompletion", () => {
  it("REGRESSION: abandoned when the end was never reached", () => {
    const v = judgeRunCompletion({
      reachedEnd: false,
      planned: 21,
      finished: 11,
      outstanding: ["a.zip", "b.zip"],
    });
    assert.equal(v.abandoned, true);
    assert.match(v.message!, /11\/21/);
    assert.match(v.message!, /must NOT be treated as successful/);
  });

  it("names the outstanding units so an operator can act", () => {
    const v = judgeRunCompletion({
      reachedEnd: false,
      planned: 3,
      finished: 1,
      outstanding: ["x.zip", "y.zip"],
    });
    assert.match(v.message!, /x\.zip, y\.zip/);
  });

  it("caps the outstanding list but says how many it dropped", () => {
    const v = judgeRunCompletion({
      reachedEnd: false,
      planned: 20,
      finished: 0,
      outstanding: Array.from({ length: 9 }, (_, i) => `f${i}.zip`),
    });
    assert.match(v.message!, /\(\+4 more\)/);
  });

  it("is NOT abandoned when the run reached its end", () => {
    const v = judgeRunCompletion({
      reachedEnd: true,
      planned: 21,
      finished: 21,
      outstanding: [],
    });
    assert.equal(v.abandoned, false);
    assert.equal(v.message, null);
  });

  it("is NOT abandoned when it reached the end having SKIPPED some units", () => {
    // feed-parse counts unreadable files as skips and still completes. Failing
    // here would make the signal worthless.
    const v = judgeRunCompletion({
      reachedEnd: true,
      planned: 21,
      finished: 18,
      outstanding: ["corrupt.zip"],
    });
    assert.equal(v.abandoned, false);
    assert.equal(v.message, null);
  });

  it("treats a nothing-to-do run as complete", () => {
    // The nightly hits this on any day the archive gained nothing.
    const v = judgeRunCompletion({
      reachedEnd: true,
      planned: 0,
      finished: 0,
      outstanding: [],
    });
    assert.equal(v.abandoned, false);
  });

  it("still reports abandonment when nothing was outstanding", () => {
    // Dying somewhere control flow cannot legitimately end is worth saying even
    // if the work happened to be done.
    const v = judgeRunCompletion({
      reachedEnd: false,
      planned: 5,
      finished: 5,
      outstanding: [],
    });
    assert.equal(v.abandoned, true);
    assert.match(v.message!, /no error was raised/);
  });
});

describe("withHardTimeout", () => {
  it("returns the value when the op settles in time", async () => {
    const out = await withHardTimeout(async () => "ok", 1_000, "fast");
    assert.equal(out, "ok");
  });

  it("REJECTS a hang instead of letting it stall the run forever", async () => {
    // The distinction from @usemoney/utils/with-soft-timeout, which only fires
    // telemetry and lets the operation continue. Here the point is to convert a
    // hang into a catchable error so the loop counts it and moves on.
    await assert.rejects(
      () => withHardTimeout(() => new Promise(() => {}), 20, "never settles"),
      /timed out after 20ms: never settles/,
    );
  });

  it("propagates the underlying rejection unchanged", async () => {
    await assert.rejects(
      () =>
        withHardTimeout(
          async () => {
            throw new Error("gcs exploded");
          },
          1_000,
          "boom",
        ),
      /gcs exploded/,
    );
  });

  it("clears its timer on the fast path", async () => {
    // A 120s timer left armed by every successful download would keep the
    // process alive long past its work — and in a test file, past the
    // assertions ("tests must never orphan").
    const before = process.getActiveResourcesInfo?.().length ?? 0;
    await withHardTimeout(async () => "ok", 120_000, "fast");
    const after = process.getActiveResourcesInfo?.().length ?? 0;
    assert.ok(
      after <= before,
      `timer leaked: ${before} active resources before, ${after} after`,
    );
  });
});
