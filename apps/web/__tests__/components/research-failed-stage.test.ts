/**
 * MONEY-1274 — a failed research run says WHERE it failed.
 *
 * ## How this was found
 *
 * A QA deep-research run showed "RESEARCH FAILED" with the stepper highlighting
 * SYNTHESIZING — the last stage before COMPLETED. That points whoever is
 * debugging at the model and the synthesis step.
 *
 * The database said otherwise. All three recent QA sessions were sitting at:
 *
 *     status PLANNING   progress 0   steps 0   tokens 0
 *     plan NULL   scratchpad 0 entries   updatedAt == createdAt
 *
 * `updatedAt == createdAt` is decisive: the row was written once and never
 * touched again, so no worker ever picked the job up.
 *
 * WHY it was never picked up is UNEXPLAINED, and an earlier version of this
 * header asserted otherwise. It blamed a 404 at the QA push endpoint, read off
 * an unauthenticated GET of `/health` — a probe that returns the identical 404
 * for the PRODUCTION endpoint while production serves normally, so it was never
 * evidence. Measured 2026-09-05: `stock-research-qa-push` undelivered backlog
 * ZERO (a failing push subscription accumulates), and a research run completed
 * normally on 2026-09-03. Not reproducing; cause unknown.
 *
 * None of that touches the defect under test, which is why the correction is
 * recorded rather than the header quietly rewritten.
 *
 * The stepper hard-coded the failed stage:
 *
 *     const curIdx = RUN_STAGE_ORDER.indexOf(isFailed ? "SYNTHESIZING" : stage);
 *
 * So EVERY failure was drawn as "four of five stages done", whatever actually
 * happened. A dead queue looked like a late-stage model hiccup, which is a
 * large part of why this went unnoticed from 2026-08-21 (last successful run:
 * 2026-08-08).
 *
 * Source under test: apps/web/components/stocksage/research-run.ts(x)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  stageForProgress,
  RUN_STAGE_ORDER,
} from "../../components/stocksage/research-run";

describe("stageForProgress — how far a run actually got", () => {
  it("[regression] a run at 0% never left the queue", () => {
    // THE CASE FROM QA. Three sessions sat here for weeks while the UI called
    // each one a synthesis failure — whatever stalled them, the stepper's
    // answer was wrong about WHERE, which is the part this pins.
    assert.equal(stageForProgress(0), "QUEUED");
  });

  it("maps each band to its stage", () => {
    assert.equal(stageForProgress(3), "QUEUED");
    assert.equal(stageForProgress(4), "PLANNING");
    assert.equal(stageForProgress(11), "PLANNING");
    assert.equal(stageForProgress(12), "RESEARCHING");
    assert.equal(stageForProgress(67), "RESEARCHING");
    assert.equal(stageForProgress(68), "ANALYZING");
    assert.equal(stageForProgress(91), "ANALYZING");
    assert.equal(stageForProgress(92), "SYNTHESIZING");
    assert.equal(stageForProgress(100), "SYNTHESIZING");
  });

  it("only ever returns a stage the stepper can render", () => {
    // The stepper does RUN_STAGE_ORDER.indexOf(...); a value outside that list
    // yields -1, which would silently light up NO node and read as "nothing
    // happened" — a different wrong answer, not a fix.
    for (let p = 0; p <= 100; p++) {
      assert.ok(
        RUN_STAGE_ORDER.includes(stageForProgress(p)),
        `progress ${p} produced a stage the stepper cannot place`
      );
    }
  });

  it("is monotonic — more progress never means an earlier stage", () => {
    let last = -1;
    for (let p = 0; p <= 100; p++) {
      const idx = RUN_STAGE_ORDER.indexOf(stageForProgress(p));
      assert.ok(idx >= last, `progress ${p} went BACKWARDS to ${idx}`);
      last = idx;
    }
  });
});

describe("the stepper no longer hard-codes the failed stage", () => {
  const SRC = readFileSync(
    join(process.cwd(), "components/stocksage/research-run.tsx"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it('[regression] no `isFailed ? "SYNTHESIZING"` remains', () => {
    // Comments stripped first: the file now EXPLAINS the old constant in prose,
    // and matching the explanation would fail a corrected file — the same trap
    // that has bitten three scans in this ticket.
    assert.doesNotMatch(
      SRC,
      /isFailed\s*\?\s*"SYNTHESIZING"/,
      "a failed run is being drawn as a synthesis failure again"
    );
  });

  it("derives the failed stage from progress instead", () => {
    assert.match(SRC, /stageForProgress\(progress\)/);
  });

  it("deriveStage still collapses a failure to FAILED for the banner", () => {
    // The two are different questions: WHAT state is this run in (FAILED) vs
    // HOW FAR did it get (from progress). Collapsing them is what lost the
    // information in the first place.
    const block = readFileSync(
      join(process.cwd(), "components/stocksage/ResearchRunBlock.tsx"),
      "utf8"
    );
    assert.match(block, /if \(data\.status === "failed"\) return "FAILED";/);
    assert.match(block, /return stageForProgress\(data\.progress\);/);
  });
});
