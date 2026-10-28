/**
 * Pending-payment poll decision logic (MONEY-1074).
 *
 * Pure termination proof for the settings-page pending-payment poll — no React,
 * no timers, no I/O. Mirrors compare-poll-logic.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decidePendingPaymentPoll,
  MAX_PENDING_PAYMENT_POLL_ATTEMPTS,
  MAX_CONSECUTIVE_PENDING_POLL_FAILURES,
  type PendingPollResponse,
} from "@/lib/subscription/pending-payment-poll-logic";

describe("decidePendingPaymentPoll (MONEY-1074)", () => {
  it("stops immediately on COMPLETED", () => {
    const d = decidePendingPaymentPoll(
      { ok: true, status: "COMPLETED" },
      { attempt: 1, consecutiveFailures: 0 }
    );
    assert.equal(d.action, "stop-completed");
    assert.equal(d.consecutiveFailures, 0);
  });

  it("stops immediately on FAILED", () => {
    const d = decidePendingPaymentPoll(
      { ok: true, status: "FAILED" },
      { attempt: 2, consecutiveFailures: 0 }
    );
    assert.equal(d.action, "stop-failed");
  });

  it("continues on a non-terminal status and resets the failure streak", () => {
    const d = decidePendingPaymentPoll(
      { ok: true, status: "PENDING" },
      { attempt: 1, consecutiveFailures: 2 }
    );
    assert.equal(d.action, "continue");
    assert.equal(d.consecutiveFailures, 0);
  });

  it("tolerates a transient failed poll (below the streak cap)", () => {
    const d = decidePendingPaymentPoll(
      { ok: false },
      { attempt: 1, consecutiveFailures: 0 }
    );
    assert.equal(d.action, "continue");
    assert.equal(d.consecutiveFailures, 1);
  });

  it("stops with stop-error after MAX consecutive failures", () => {
    const d = decidePendingPaymentPoll(
      { ok: false },
      {
        attempt: 3,
        consecutiveFailures: MAX_CONSECUTIVE_PENDING_POLL_FAILURES - 1,
      }
    );
    assert.equal(d.action, "stop-error");
    assert.equal(d.consecutiveFailures, MAX_CONSECUTIVE_PENDING_POLL_FAILURES);
  });

  it("a missing/null status counts as a failed poll", () => {
    assert.equal(
      decidePendingPaymentPoll(
        { ok: true, status: null },
        { attempt: 1, consecutiveFailures: 0 }
      ).action,
      "continue"
    );
    assert.equal(
      decidePendingPaymentPoll(
        { ok: true },
        { attempt: 1, consecutiveFailures: 0 }
      ).consecutiveFailures,
      1
    );
  });

  it("the attempt cap dominates even a would-be terminal status at the boundary", () => {
    const d = decidePendingPaymentPoll(
      { ok: true, status: "COMPLETED" },
      { attempt: MAX_PENDING_PAYMENT_POLL_ATTEMPTS, consecutiveFailures: 0 }
    );
    assert.equal(d.action, "stop-exhausted");
  });

  it("PROVABLY TERMINATES: an always-pending payment stops at exactly MAX attempts", () => {
    // Simulate the caller loop: attempt increments each round, decision drives it.
    const alwaysPending: PendingPollResponse = { ok: true, status: "PENDING" };
    let attempt = 0;
    let consecutiveFailures = 0;
    let rounds = 0;
    // Hard ceiling so a bug can't hang the test.
    while (rounds < 1000) {
      rounds += 1;
      attempt += 1;
      const d = decidePendingPaymentPoll(alwaysPending, {
        attempt,
        consecutiveFailures,
      });
      consecutiveFailures = d.consecutiveFailures;
      if (d.action !== "continue") break;
    }
    assert.equal(rounds, MAX_PENDING_PAYMENT_POLL_ATTEMPTS);
  });

  it("PROVABLY TERMINATES: an always-failing poll stops within the streak cap", () => {
    const alwaysFail: PendingPollResponse = { ok: false };
    let attempt = 0;
    let consecutiveFailures = 0;
    let rounds = 0;
    let finalAction = "continue";
    while (rounds < 1000) {
      rounds += 1;
      attempt += 1;
      const d = decidePendingPaymentPoll(alwaysFail, {
        attempt,
        consecutiveFailures,
      });
      consecutiveFailures = d.consecutiveFailures;
      finalAction = d.action;
      if (d.action !== "continue") break;
    }
    assert.equal(finalAction, "stop-error");
    assert.equal(rounds, MAX_CONSECUTIVE_PENDING_POLL_FAILURES);
  });
});
