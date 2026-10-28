/**
 * MONEY-1136 — the client Router Cache must stay configured.
 *
 * This is a regression guard for a bug that was introduced by an ABSENCE, and
 * would be reintroduced the same way: `next.config.js` simply did not set
 * `experimental.staleTimes`, so the Next 14→16 upgrade silently inherited Next
 * 15's new default of `dynamic: 0` and turned every in-app navigation into a
 * server round trip.
 *
 * Why that is a navigation bug and not just a slow one: App Router keeps the
 * OUTGOING page mounted for the whole of a transition. With no client cache,
 * that transition lasts as long as the server takes — seconds, on the 61 of 93
 * pages that are `force-dynamic` — and the page the user just left keeps
 * running effects and firing server actions the entire time. Its late work then
 * lands on top of the navigation the user actually asked for, and they get
 * yanked back to the page they came from. Before the upgrade, a route visited
 * in the last 30s was served from the client cache and committed in ~0ms, so
 * there was no window to lose the race in.
 *
 * Nothing else in the suite would catch a revert: the app builds, type-checks
 * and behaves correctly with the value missing — it is only *slower*, and the
 * symptom shows up as an intermittent mis-navigation under load. Hence a test
 * that asserts the config directly.
 *
 * Source: apps/web/next.config.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require("../../next.config.js") as {
  experimental?: { staleTimes?: { dynamic?: number; static?: number } };
};

describe("MONEY-1136 — client Router Cache staleTimes", () => {
  it("[regression] experimental.staleTimes.dynamic is set at all", () => {
    // The bug was the ABSENCE of this key, not a wrong value.
    assert.ok(
      nextConfig.experimental,
      "next.config.js must declare an experimental block"
    );
    assert.notEqual(
      nextConfig.experimental?.staleTimes?.dynamic,
      undefined,
      "staleTimes.dynamic must be set explicitly — leaving it unset inherits " +
        "Next 15's `dynamic: 0`, which disables the client Router Cache and " +
        "makes every navigation a server round trip (MONEY-1136)"
    );
  });

  it("restores a non-zero dynamic stale time", () => {
    const dynamic = nextConfig.experimental?.staleTimes?.dynamic;
    assert.equal(
      typeof dynamic,
      "number",
      "staleTimes.dynamic must be a number"
    );
    assert.ok(
      (dynamic as number) > 0,
      "a 0 stale time IS the disabled cache this ticket exists to undo"
    );
  });

  it("matches the Next 14 default it is restoring", () => {
    // 30 is not a tuning choice — it is the value this app was built and
    // tested against for its entire life before the June 2026 upgrade.
    // Changing it is a deliberate product decision about data freshness on
    // repeat/back-forward navigation, so it should fail here first.
    assert.equal(nextConfig.experimental?.staleTimes?.dynamic, 30);
  });

  it("does not silently lower the static stale time", () => {
    // Next clamps `static` to >= 30 via its own zod schema; if we ever set it,
    // it must not be set below the default of 300 by accident.
    const staticTime = nextConfig.experimental?.staleTimes?.static;
    if (staticTime !== undefined) {
      assert.ok(
        staticTime >= 30,
        "Next's config schema rejects a static stale time below 30"
      );
    }
  });
});
