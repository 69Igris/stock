/**
 * Reconnect backoff and the heartbeat window.
 *
 * Retry timing is arithmetic that is easy to get subtly wrong and impossible to
 * observe once it is buried in a private method, so it is exported and tested
 * directly. The property that matters is the JITTER: every instance of this
 * service watches the same upstream, so a fixed ladder makes them all retry in
 * lockstep after a Tiingo blip and turns one outage into a thundering herd
 * against a metered API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backoffDelayMs,
  HEARTBEAT_TIMEOUT_MS,
} from "../../src/realtime/tiingo-socket";

describe("the backoff ceiling doubles, then caps", () => {
  it("doubles per attempt when the ceiling is taken", () => {
    // A random() near 1 returns the ceiling itself, which makes the shape
    // visible without depending on real randomness.
    const at = (n: number) => backoffDelayMs(n, () => 0.999999);
    assert.ok(at(1) < 1_000);
    assert.ok(at(2) >= 1_000 && at(2) < 2_000);
    assert.ok(at(3) >= 2_000 && at(3) < 4_000);
    assert.ok(at(4) >= 4_000 && at(4) < 8_000);
  });

  it("never exceeds the 60s cap however many attempts have failed", () => {
    for (const n of [10, 20, 100, 1000]) {
      assert.ok(
        backoffDelayMs(n, () => 0.999999) <= 60_000,
        `attempt ${n} exceeded the cap`,
      );
    }
  });

  it("is never negative and never NaN, including at attempt 0", () => {
    for (const n of [0, -5, 1]) {
      const d = backoffDelayMs(n, () => 0.5);
      assert.ok(Number.isFinite(d) && d >= 0, `attempt ${n} produced ${d}`);
    }
  });
});

describe("FULL JITTER — the property that stops a thundering herd", () => {
  it("two instances retrying at the same attempt get different delays", () => {
    // With a fixed ladder these would be identical, and every pod would hit
    // Tiingo in the same millisecond after a blip.
    const a = backoffDelayMs(5, () => 0.1);
    const b = backoffDelayMs(5, () => 0.9);
    assert.notEqual(a, b);
  });

  it("spans the whole range from zero to the ceiling, not a band around it", () => {
    // A common HALF-jitter implementation returns ceiling/2 + rand*ceiling/2,
    // which still clusters every instance into the upper half. Full jitter must
    // be able to return near-zero.
    assert.equal(backoffDelayMs(6, () => 0), 0);
    assert.ok(
      backoffDelayMs(6, () => 0.999999) > 30_000,
      "the ceiling collapsed — this is not full jitter",
    );
  });
});

describe("the heartbeat watchdog window", () => {
  it("is long enough to survive a quiet minute, short enough to matter", () => {
    // A socket delivering nothing is indistinguishable from a quiet market
    // until something checks the clock. Too short and a thin symbol set
    // reconnects constantly; too long and the service reports itself healthy
    // while writing nothing — the failure that looks most like "the market is
    // quiet".
    assert.ok(
      HEARTBEAT_TIMEOUT_MS >= 30_000,
      "too eager — ordinary quiet would trigger a reconnect",
    );
    assert.ok(
      HEARTBEAT_TIMEOUT_MS <= 120_000,
      "too patient — a dead feed would go unnoticed for minutes",
    );
  });
});
