/**
 * UNIT TEST — a data-source chain reports HOW it ended (MONEY-1146).
 *
 * ## The defect
 *
 * `tryChain` returned `null` for two endings that need opposite responses:
 *
 *   - every source answered cleanly and none had data for this symbol
 *     (BSE-only, SME/Emerge, newly listed) — an ordinary, correct answer
 *   - every source THREW: blocked, rate-limited, vendor layout changed —
 *     the feature is broken
 *
 * Every client in these chains returns `null` for an empty response as well as
 * for a failure (`tickertape-client.ts`: `if (!resp?.data?.length) return null`),
 * and `tryChain` caught every exception. So the Ownership tab rendered one
 * empty panel for both, with no log line separating them — it could have been
 * dead for months without a signal, which is exactly what MONEY-1146 found.
 *
 * ## Why this test drives the real helper
 *
 * The companion test (`apps/web/__tests__/actions/shareholding-failure-visible.test.ts`)
 * parses the ACTION's source to pin that it branches on `errors` before
 * collapsing null to `[]`. That catches the wiring but not the logic. This one
 * executes `tryChainDetailed` with fake sources, so the classification itself
 * is asserted rather than assumed.
 *
 * No network: every source here is a local function.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tryChainDetailed } from "../src/data-sources/data-source-chain";

const ok = <T>(value: T) => ({
  name: "ok-source",
  fn: async (): Promise<T | null> => value,
});
const empty = (name = "empty-source") => ({
  name,
  fn: async (): Promise<string[] | null> => null,
});
const throws = (name = "broken-source", message = "403 Forbidden") => ({
  name,
  fn: async (): Promise<string[] | null> => {
    throw new Error(message);
  },
});

describe("tryChainDetailed — no-coverage vs every-source-failed", () => {
  it("a clean exhaustion reports NO errors — this is 'no coverage'", () => {
    // The ordinary answer. If this ever reported an error, every uncovered
    // symbol would get a red panel — which is precisely the regression an
    // earlier attempt at MONEY-1146 shipped.
    return tryChainDetailed([empty("tickertape"), empty("screener")]).then(
      (outcome) => {
        assert.equal(outcome.data, null);
        assert.deepEqual(outcome.errors, []);
        assert.equal(outcome.emptyCount, 2);
      },
    );
  });

  it("a thrown exhaustion reports the errors — this is 'broken'", async () => {
    const outcome = await tryChainDetailed([
      throws("tickertape", "403 Forbidden"),
      throws("screener", "ETIMEDOUT"),
    ]);
    assert.equal(outcome.data, null);
    assert.equal(outcome.errors.length, 2);
    assert.deepEqual(
      outcome.errors.map((e) => e.source),
      ["tickertape", "screener"],
      "errors are reported in attempt order",
    );
    assert.match(outcome.errors[0]!.message, /403/);
    assert.equal(outcome.emptyCount, 0);
  });

  it("the two endings are DISTINGUISHABLE — the whole point", () => {
    // Stated as one assertion because it is the property the UI depends on:
    // both produce `data === null`, so `errors` must be what separates them.
    return Promise.all([
      tryChainDetailed([empty(), empty()]),
      tryChainDetailed([throws(), throws()]),
    ]).then(([clean, broken]) => {
      assert.equal(clean.data, null);
      assert.equal(broken.data, null);
      assert.notEqual(
        clean.errors.length > 0,
        broken.errors.length > 0,
        "if both report the same error-ness, the caller is back to rendering " +
          "one empty panel for a broken scrape and an uncovered symbol",
      );
    });
  });

  it("a later source succeeding hides earlier failures from the RESULT but not the record", async () => {
    // A fallback chain working as designed: tickertape is down, screener
    // answers. The caller gets data and must NOT see this as a failure — but
    // the errors are still carried, so a caller that wants to alert on
    // degraded sources can.
    const outcome = await tryChainDetailed<string[]>([
      throws("tickertape"),
      ok(["screener-row"]),
    ]);
    assert.deepEqual(outcome.data, ["screener-row"]);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0]!.source, "tickertape");
  });

  it("stops at the first success — a chain is a fallback, not a fan-out", async () => {
    let secondCalled = false;
    const outcome = await tryChainDetailed<string[]>([
      ok(["first"]),
      {
        name: "should-not-run",
        fn: async () => {
          secondCalled = true;
          return ["second"];
        },
      },
    ]);
    assert.deepEqual(outcome.data, ["first"]);
    assert.equal(
      secondCalled,
      false,
      "a later source must not be hit once one has answered — these are " +
        "rate-limited third parties",
    );
  });

  it("an empty attempt list is a clean exhaustion, not an error", async () => {
    const outcome = await tryChainDetailed([]);
    assert.equal(outcome.data, null);
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.emptyCount, 0);
  });

  it("a non-Error throw still yields a usable message", async () => {
    const outcome = await tryChainDetailed([
      {
        name: "odd",
        fn: async (): Promise<string[] | null> => {
          throw "just a string";
        },
      },
    ]);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0]!.message, "just a string");
  });
});
