/**
 * PostHog must capture SPA route changes — MONEY-1084.
 *
 * ## The defect
 *
 * `PostHogProvider` passed `capture_pageview: true`, which is posthog-js's
 * LEGACY load-only behaviour. UseMoney is an App Router SPA, so moving between
 * /dashboard, /holdings, /tradebook etc. never reloads the page and none of it
 * was captured.
 *
 * Prod over 14 days: 475 pageviews across 441 sessions — ~1.08 per session.
 * The consequences were not academic:
 *   - a reproducible navigation bug (MONEY-1082) left NO trace in analytics,
 *     so PostHog could not confirm a defect users were hitting, and
 *   - every funnel/path/retention insight spanning more than one route was
 *     measuring initial loads, understating engagement and mis-attributing
 *     drop-off to the landing page.
 *
 * ## Why a scan and not a unit test
 *
 * The value lives in a `posthog.init()` config object inside a client
 * component that pulls Clerk and a dynamic import. There is nothing to call.
 * A static assertion on the literal is the honest test — and it is enough,
 * because the failure mode is precisely "someone sets it back to `true`".
 *
 * Subtle enough to be worth pinning: `defaults: "2025-05-24"` ALREADY resolves
 * capture_pageview to "history_change" (posthog-js computes
 * `!(v && v >= "2025-05-24") || "history_change"`). The explicit `true` was
 * overriding a default that was already correct, so "remove the line" and
 * "set it correctly" both work — but only the explicit form survives a future
 * `defaults` bump, which is what this test locks in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CWD is apps/web (the package's test script runs from there).
const PROVIDER = join("components", "PostHogProvider.tsx");

describe("PostHog SPA pageview capture (MONEY-1084)", () => {
  const src = readFileSync(PROVIDER, "utf8");

  it("capture_pageview is 'history_change', never true", () => {
    const match = src.match(/capture_pageview:\s*([^,\n]+)/);
    assert.ok(match, "capture_pageview must be set explicitly in posthog.init");
    assert.equal(
      match![1]!.trim(),
      '"history_change"',
      "`true` is the legacy load-only mode — client-side route changes would " +
        "stop being captured and every multi-route funnel would silently " +
        "measure landings only (MONEY-1084)"
    );
  });

  it("still opts into pageleave, which pairs with route-change capture", () => {
    // Without pageleave, time-on-page for an SPA route is unbounded.
    assert.match(src, /capture_pageleave:\s*true/);
  });

  it("the init call this guards actually exists", () => {
    // Liveness: if PostHogProvider is rewritten or the init moves, fail here
    // rather than passing on a file that no longer configures anything.
    assert.match(src, /posthog\.init\(/);
  });
});
