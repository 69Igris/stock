/**
 * Service-layer analytics helper tests (MONEY-295 / de-shadowed MONEY-620).
 *
 * `packages/services/src/analytics.ts` exposes a single fire-and-forget
 * telemetry helper, `captureServiceEvent(distinctId, event, properties)`,
 * which pushes a PostHog event from inside a service function. It computes
 * NOTHING that reaches a user or a stored value (no aggregates / rates /
 * percentages); its entire contract is:
 *
 *   1. Env-gate  - no-op (and construct NO client) when
 *      NEXT_PUBLIC_POSTHOG_KEY is unset/empty (workers / CI / tests).
 *   2. Fail-open - any error thrown inside the PostHog path
 *      (constructor / capture / shutdown) is swallowed; telemetry must
 *      NEVER break service logic. The function always returns `void`.
 *
 * ── Why this file was rewritten ──────────────────────────────────────────
 * The previous version was a SHADOW (writing-tests Prime Directive): it
 * re-declared the env-gate inline (`function shouldFire(env) { return
 * !!env.NEXT_PUBLIC_POSTHOG_KEY; }`), re-declared a `safeCall()` try/catch,
 * and asserted plain object literals against themselves - it never imported
 * or executed `captureServiceEvent`. A green shadow proves nothing if the
 * real swallow/gate regresses. Every test below now imports and runs the
 * REAL exported symbol.
 *
 * ── Test hygiene (NO ORPHANS) ────────────────────────────────────────────
 * A real PostHog client with a key set performs an ASYNC network flush
 * (verified: ~9s + noisy stderr + real failed I/O). So the env-SET path is
 * only ever exercised through an input that makes the client throw
 * SYNCHRONOUSLY *before* any flush (a property with a throwing getter): the
 * real constructor + real `capture()` run, the throw lands in the real
 * `catch {}`, and no socket is ever opened. The env-UNSET / EMPTY paths
 * construct no client at all. Nothing here touches the network; the file
 * exits clean in well under a second.
 *
 * Imported by RELATIVE source path: the @usemoney/services export map only
 * exposes ".", "./gst", "./preferences" (not "./src/analytics"), and the
 * barrel does not re-export it - but it must still be the real symbol, so we
 * reach the source file directly (tsx resolves the .ts).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { captureServiceEvent } from "../../../../packages/services/src/analytics";

// Snapshot + restore the only env vars these tests touch, so we never leak
// state into sibling test files in the same process.
const SAVED_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const SAVED_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;

function restoreEnv(): void {
  if (SAVED_KEY === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  else process.env.NEXT_PUBLIC_POSTHOG_KEY = SAVED_KEY;
  if (SAVED_HOST === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  else process.env.NEXT_PUBLIC_POSTHOG_HOST = SAVED_HOST;
}

afterEach(restoreEnv);

/**
 * Build a properties object whose `boom` key throws when read. PostHog's
 * `capture()` enumerates `properties` synchronously, so reading `boom` throws
 * inside the helper's `try` - the ONLY way to drive the real client path to
 * completion without an async network flush. Bonus: the getter can only fire
 * if `properties` is actually forwarded to the client, which doubles as proof
 * that the third argument reaches `capture()`.
 */
function propertiesWithThrowingGetter(
  onRead: () => void
): Record<string, unknown> {
  const props: Record<string, unknown> = { planId: "FREE" };
  Object.defineProperty(props, "boom", {
    enumerable: true,
    get() {
      onRead();
      throw new Error("hostile property getter blew up");
    },
  });
  return props;
}

// ── Env-gate: no key → no-op, no client, returns void ────────────────────

describe("captureServiceEvent - env gating (real export)", () => {
  it("returns void and constructs no client when NEXT_PUBLIC_POSTHOG_KEY is unset", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    // If a client were constructed here it would attempt an async flush;
    // a clean, instant, throw-free return is the observable no-op.
    const result = captureServiceEvent(
      "anonymous",
      "subscription_self_healed",
      {
        planId: "FREE",
      }
    );
    assert.equal(result, undefined, "must return void (fire-and-forget)");
  });

  it("returns void when NEXT_PUBLIC_POSTHOG_KEY is the empty string", () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "";
    const result = captureServiceEvent("anonymous", "event_name", { ok: true });
    assert.equal(result, undefined, "empty key is falsy → no-op");
  });

  it("does not throw on the no-op path even with a hostile (throwing-getter) property", () => {
    // The env-gate short-circuits BEFORE properties are ever read, so the
    // getter must NOT fire - proves the early `return` precedes client use.
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    let getterFired = false;
    const props = propertiesWithThrowingGetter(() => {
      getterFired = true;
    });
    const result = captureServiceEvent("anon", "evt", props);
    assert.equal(result, undefined);
    assert.equal(
      getterFired,
      false,
      "no-key path must not touch properties (no client constructed)"
    );
  });
});

// ── Fail-open: real client throws synchronously → swallowed ───────────────

describe("captureServiceEvent - fail-open contract (real client path)", () => {
  it("swallows a synchronous throw from the real PostHog capture() path", () => {
    // Key set → the real PostHog constructor + capture() run. The throwing
    // getter makes capture() throw INSIDE the helper's try, before shutdown/
    // flush. The catch must swallow it and the function must return void.
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_failopen_test";
    let getterFired = false;
    const props = propertiesWithThrowingGetter(() => {
      getterFired = true;
    });

    let threw = false;
    let result: void | undefined;
    try {
      result = captureServiceEvent("user-1", "subscription_self_healed", props);
    } catch {
      threw = true;
    }

    assert.equal(
      threw,
      false,
      "telemetry error must NOT propagate to the caller"
    );
    assert.equal(result, undefined, "must still return void after swallowing");
    assert.equal(
      getterFired,
      true,
      "the real capture() must have read forwarded properties (proves 3rd arg reaches the client)"
    );
  });

  it("never throws across repeated hostile invocations (idempotent fail-open)", () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_failopen_test";
    for (let i = 0; i < 5; i++) {
      const props = propertiesWithThrowingGetter(() => {});
      assert.doesNotThrow(() => captureServiceEvent(`user-${i}`, "evt", props));
    }
  });
});

// ── Input edge cases: helper must tolerate odd-but-non-throwing inputs ────

describe("captureServiceEvent - input edge cases (real export)", () => {
  it("defaults the properties argument to {} when omitted (no key → no-op)", () => {
    // Exercise the default-parameter path without opening a socket: with no
    // key set the helper returns before constructing a client, so the missing
    // third arg is safe to assert as a pure throw-free no-op.
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    assert.equal(captureServiceEvent("anon", "event_with_no_props"), undefined);
  });

  it("tolerates an empty distinctId and empty event name", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    assert.equal(captureServiceEvent("", ""), undefined);
  });

  it("tolerates an empty distinctId/event even on the real client path", () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_failopen_test";
    // Pair the blank ids with a throwing-getter property so the real client
    // path runs to its synchronous throw (no async flush) and is swallowed.
    const props = propertiesWithThrowingGetter(() => {});
    assert.doesNotThrow(() => captureServiceEvent("", "", props));
  });
});

// ── Consumer-shape sanity: the one real caller (credit.service.ts) ───────
// credit.service.ts fires:
//   captureServiceEvent(userId, "subscription_self_healed", { planId, healCredits,
//     healStatus, statusWas, creditsLimitWas, creditsLimitExpected })
// where several values are `undefined` when that drift dimension didn't apply.
// Assert the helper accepts that exact call (undefined-valued props included)
// without throwing - on the no-op path so no network is touched.

describe("captureServiceEvent - subscription_self_healed call site shape", () => {
  it("accepts the credit.service self-heal payload (with undefined-valued props)", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    assert.equal(
      captureServiceEvent("user-42", "subscription_self_healed", {
        planId: "FREE",
        healCredits: false,
        healStatus: true,
        statusWas: "CANCELLED",
        creditsLimitWas: undefined,
        creditsLimitExpected: undefined,
      }),
      undefined
    );
  });

  it("accepts the both-dimensions-drifted variant of the payload", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    assert.equal(
      captureServiceEvent("user-7", "subscription_self_healed", {
        planId: "FREE",
        healCredits: true,
        healStatus: true,
        statusWas: "EXPIRED",
        creditsLimitWas: 0,
        creditsLimitExpected: 5,
      }),
      undefined
    );
  });
});
