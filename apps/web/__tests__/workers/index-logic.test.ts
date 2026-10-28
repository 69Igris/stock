/**
 * Worker startup-decision tests (workers/src/index-logic.ts) — MONEY-807.
 *
 * `index.ts` boots a real HTTP server + the local pull subscriber at module
 * load, so it can't be imported in a unit test without leaking handles. The
 * regression-prone startup DECISION — "should the local pull subscriber start?"
 * — lives in the pure `index-logic.ts` sibling that `index.ts` CALLS, so this
 * test asserts the REAL exported decision (no shadow, no server boot).
 *
 * The bug this guards (MONEY-807): the old auto-enable keyed off
 * `NODE_ENV NOT IN {production, qa}`, so a DEPLOYED worker booting with an
 * unset/odd NODE_ENV ("" / "staging") silently auto-created pull subscriptions —
 * a competing consumer that STEALS its own Pub/Sub push messages. The fix is a
 * fail-CLOSED positive local signal; these tests pin both directions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldEnablePullSubscriber } from "../../../../workers/src/index-logic";

describe("Workers - index-logic: shouldEnablePullSubscriber (MONEY-807)", () => {
  // ── Explicit override flag (always wins) ─────────────────────────
  describe("ENABLE_PULL_SUBSCRIBER override", () => {
    it("force-enables in ANY environment when set to 'true'", () => {
      assert.strictEqual(
        shouldEnablePullSubscriber({
          ENABLE_PULL_SUBSCRIBER: "true",
          NODE_ENV: "production",
          PUBSUB_ENV: "prod",
        }),
        true
      );
    });

    it("does NOT enable for a non-'true' value (only the exact string)", () => {
      assert.strictEqual(
        shouldEnablePullSubscriber({ ENABLE_PULL_SUBSCRIBER: "1" }),
        false
      );
      assert.strictEqual(
        shouldEnablePullSubscriber({ ENABLE_PULL_SUBSCRIBER: "yes" }),
        false
      );
      assert.strictEqual(
        shouldEnablePullSubscriber({ ENABLE_PULL_SUBSCRIBER: "TRUE" }),
        false
      );
    });

    it("the override even bypasses the missing-GCP_PROJECT_ID guard (operator opt-in)", () => {
      assert.strictEqual(
        shouldEnablePullSubscriber({ ENABLE_PULL_SUBSCRIBER: "true" }),
        true
      );
    });
  });

  // ── Positive local signal (auto-enable) ──────────────────────────
  describe("auto-enable on a genuinely-local boot", () => {
    it("enables for NODE_ENV=development WITH a project id", () => {
      assert.strictEqual(
        shouldEnablePullSubscriber({
          NODE_ENV: "development",
          GCP_PROJECT_ID: "stock-book-local",
        }),
        true
      );
    });

    it("enables for PUBSUB_ENV=local WITH a project id", () => {
      assert.strictEqual(
        shouldEnablePullSubscriber({
          PUBSUB_ENV: "local",
          GCP_PROJECT_ID: "stock-book-local",
        }),
        true
      );
    });

    it("does NOT auto-enable a local boot with no GCP_PROJECT_ID (can't subscribe)", () => {
      assert.strictEqual(
        shouldEnablePullSubscriber({ NODE_ENV: "development" }),
        false
      );
      assert.strictEqual(
        shouldEnablePullSubscriber({ PUBSUB_ENV: "local" }),
        false
      );
      assert.strictEqual(
        shouldEnablePullSubscriber({
          NODE_ENV: "development",
          GCP_PROJECT_ID: "",
        }),
        false
      );
    });
  });

  // ── Fail-CLOSED: deployed / unknown envs never auto-enable ───────
  // This is the regression class MONEY-807 fixed — a deployed worker must NEVER
  // auto-create a competing pull subscription that steals its own push traffic.
  describe("fail-closed for deployed / unrecognised environments", () => {
    for (const env of ["production", "prod", "qa", "staging", "", undefined]) {
      it(`does NOT auto-enable for NODE_ENV=${JSON.stringify(env)} (even with a project)`, () => {
        assert.strictEqual(
          shouldEnablePullSubscriber({
            NODE_ENV: env,
            GCP_PROJECT_ID: "stock-book-483718",
          }),
          false
        );
      });
    }

    it("the OLD negation bug: NODE_ENV='staging' + project no longer auto-enables", () => {
      // Under the old "!['production','qa'].includes(NODE_ENV)" logic this was
      // TRUE — a deployed staging worker stole push messages. Must be false now.
      assert.strictEqual(
        shouldEnablePullSubscriber({
          NODE_ENV: "staging",
          PUBSUB_ENV: "qa",
          GCP_PROJECT_ID: "stock-book-483718",
        }),
        false
      );
    });

    it("PUBSUB_ENV=qa/prod never auto-enables", () => {
      assert.strictEqual(
        shouldEnablePullSubscriber({
          PUBSUB_ENV: "qa",
          GCP_PROJECT_ID: "p",
        }),
        false
      );
      assert.strictEqual(
        shouldEnablePullSubscriber({
          PUBSUB_ENV: "prod",
          GCP_PROJECT_ID: "p",
        }),
        false
      );
    });

    it("a fully-empty env is fail-closed (off)", () => {
      assert.strictEqual(shouldEnablePullSubscriber({}), false);
    });
  });
});
