/**
 * MONEY-553 — deep-compare poll loop must be PROVABLY TERMINATING.
 *
 * Regression guard for the PostHog exception uptick: the /compare/[sessionId]
 * status poll used to clear its 4s interval only on COMPLETED/FAILED, so a
 * thrown action (stale-deploy UnrecognizedActionError) or a {success:false}
 * return (demo / IDOR / transient) spun the interval forever — manufacturing
 * hundreds of identical exceptions from one stale tab.
 *
 * These tests pin the termination contract of the pure `decideComparePoll`:
 *   - a sustained failure streak STOPS the loop (it does not poll forever);
 *   - a thrown action is treated identically to a returned-false response;
 *   - an intermittent blip does NOT stop it (the streak resets on success);
 *   - a hard wall-clock cap stops even an "always in-progress" (dead worker) job.
 * If a future change reintroduces a non-terminating path, one of these fails.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideComparePoll,
  MAX_CONSECUTIVE_POLL_FAILURES,
  MAX_POLL_DURATION_MS,
  COMPARE_TERMINAL_STATUSES,
} from "@/lib/compare/poll-logic";

describe("decideComparePoll — termination contract", () => {
  it("continues on an in-progress status and resets the failure streak", () => {
    const d = decideComparePoll(
      { ok: true, status: "RESEARCHING" },
      { consecutiveFailures: 2, elapsedMs: 1000 }
    );
    assert.equal(d.action, "continue");
    assert.equal(d.status, "RESEARCHING");
    assert.equal(d.consecutiveFailures, 0);
  });

  it("stops on each terminal status", () => {
    for (const s of ["COMPLETED", "FAILED"]) {
      const d = decideComparePoll(
        { ok: true, status: s },
        { consecutiveFailures: 0, elapsedMs: 1000 }
      );
      assert.equal(d.action, "stop");
      assert.equal(d.status, s);
      assert.ok(COMPARE_TERMINAL_STATUSES.has(s));
    }
  });

  it("tolerates a single transient failure — keeps polling, no status change", () => {
    const d = decideComparePoll(
      { ok: false },
      { consecutiveFailures: 0, elapsedMs: 1000 }
    );
    assert.equal(d.action, "continue");
    assert.equal(d.consecutiveFailures, 1);
    assert.equal(d.status, undefined);
  });

  it("STOPS with a reload error after a sustained failure streak (the bug guard)", () => {
    // Simulate a stale-deploy UnrecognizedActionError that keeps failing every poll.
    let failures = 0;
    let lastAction = "continue";
    let polls = 0;
    for (let i = 0; i < 50; i++) {
      polls++;
      const d = decideComparePoll(
        { ok: false },
        { consecutiveFailures: failures, elapsedMs: 1000 }
      );
      failures = d.consecutiveFailures;
      lastAction = d.action;
      if (d.action === "stop-error") break;
    }
    assert.equal(lastAction, "stop-error", "the loop must eventually stop");
    assert.equal(failures, MAX_CONSECUTIVE_POLL_FAILURES);
    assert.equal(
      polls,
      MAX_CONSECUTIVE_POLL_FAILURES,
      "must stop exactly at the failure cap — never poll forever"
    );
  });

  it("treats a thrown action (ok:false) identically to a returned-false response", () => {
    const thrown = decideComparePoll(
      { ok: false },
      {
        consecutiveFailures: MAX_CONSECUTIVE_POLL_FAILURES - 1,
        elapsedMs: 1000,
      }
    );
    assert.equal(thrown.action, "stop-error");
    assert.match(thrown.error ?? "", /reload/i);
  });

  it("resets the streak after a success — intermittent blips never accumulate to a stop", () => {
    let failures = 0;
    const seq = [
      { ok: false },
      { ok: false },
      { ok: true, status: "RESEARCHING" }, // success resets
      { ok: false },
      { ok: false },
    ];
    let sawStop = false;
    for (const res of seq) {
      const d = decideComparePoll(res, {
        consecutiveFailures: failures,
        elapsedMs: 1000,
      });
      failures = d.consecutiveFailures;
      if (d.action === "stop-error") sawStop = true;
    }
    assert.equal(sawStop, false);
  });

  it("stops at the hard wall-clock cap even when every poll succeeds in-progress (dead worker)", () => {
    const d = decideComparePoll(
      { ok: true, status: "RESEARCHING" },
      { consecutiveFailures: 0, elapsedMs: MAX_POLL_DURATION_MS }
    );
    assert.equal(d.action, "stop-error");
    assert.match(d.error ?? "", /reload/i);
  });
});
