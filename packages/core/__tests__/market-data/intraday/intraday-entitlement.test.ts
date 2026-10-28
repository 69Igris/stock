/**
 * Who may read intraday bars — MONEY-1470 (A5).
 *
 * Every test here is about ONE polarity: an ambiguous input must mean NO.
 * Refusing someone who should have access is visible, reported and reversible;
 * granting someone who should not is a leak nobody observes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INTRADAY_TIERS,
  intradayTiers,
  mayReadIntraday,
} from "../../../src/market-data/intraday/intraday-entitlement";

describe("the default is nobody", () => {
  it("an absent flag grants nothing", () => {
    assert.deepEqual([...DEFAULT_INTRADAY_TIERS], []);
    assert.equal(mayReadIntraday({ plan: "ULTIMATE" }), false);
    assert.equal(
      mayReadIntraday({ plan: "PREMIUM", flagValue: undefined }),
      false,
    );
    assert.equal(mayReadIntraday({ plan: "PRO", flagValue: null }), false);
  });

  it("a bare `true` is REFUSED rather than read as everyone", () => {
    // A boolean cannot express WHICH tiers, and guessing "all of them" from it
    // would hand intraday to the entire free tier the moment somebody set
    // `{"enabled":true}` by hand in a console.
    assert.deepEqual(intradayTiers(true), []);
    assert.equal(mayReadIntraday({ plan: "FREE", flagValue: true }), false);
    assert.equal(mayReadIntraday({ plan: "ULTIMATE", flagValue: true }), false);
  });

  it("an unknown plan is refused even when the list is generous", () => {
    assert.equal(
      mayReadIntraday({ plan: "GOLD", flagValue: ["PRO", "PREMIUM"] }),
      false,
    );
    assert.equal(mayReadIntraday({ plan: null, flagValue: ["PRO"] }), false);
    assert.equal(mayReadIntraday({ plan: "   ", flagValue: ["PRO"] }), false);
  });
});

describe("granting is naming", () => {
  it("an array, a CSV string and a {tiers} object all work", () => {
    for (const flagValue of [
      ["PRO", "PREMIUM"],
      "PRO,PREMIUM",
      { tiers: ["PRO", "PREMIUM"] },
      { tiers: "PRO,PREMIUM" },
    ]) {
      assert.equal(
        mayReadIntraday({ plan: "PRO", flagValue }),
        true,
        JSON.stringify(flagValue),
      );
      assert.equal(
        mayReadIntraday({ plan: "FREE", flagValue }),
        false,
        JSON.stringify(flagValue),
      );
    }
  });

  it("case and whitespace do not decide entitlement", () => {
    assert.equal(mayReadIntraday({ plan: "pro", flagValue: [" Pro "] }), true);
  });

  it("`enabled:false` REVOKES without editing the list", () => {
    // That is the rollback, and it must not require a second edit under
    // pressure — the same reason the flag is a row rather than an env var.
    assert.equal(
      mayReadIntraday({
        plan: "PRO",
        flagValue: { enabled: false, tiers: ["PRO"] },
      }),
      false,
    );
    assert.equal(
      mayReadIntraday({
        plan: "PRO",
        flagValue: { enabled: "false", tiers: ["PRO"] },
      }),
      false,
    );
  });

  it("junk inside a list is dropped, not coerced", () => {
    assert.deepEqual(intradayTiers([1, null, "PRO", {}, "  "]), ["PRO"]);
  });
});
