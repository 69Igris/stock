/**
 * MONEY-393 §3 - /api/demo/end + useDemoAnalytics tests.
 *
 * Mirrors the pattern in demo-start.test.ts but for the corresponding
 * end-of-session endpoint. The POST handler must:
 *   1. Clear both `sb_demo` (HMAC) and `sb_demo_did` (companion did) cookies.
 *   2. Capture a PostHog event - `demo_ended` for plain exits, OR
 *      `demo_ended_signup_started` when ?reason=signup is present (the
 *      MONEY-383 funnel hop into the sign-up flow).
 *   3. Skip the PostHog call when `NEXT_PUBLIC_POSTHOG_KEY` is unset
 *      (no analytics in dev). Tests rely on this so the runner doesn't
 *      hit the real PostHog endpoint.
 *
 * Top-level `it()` to dodge node:test --test-force-exit's flat-suite race.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── env setup before importing the route ────────────────────────────

const TEST_ENC_KEY =
  "demo-end-test-encryption-key-64-chars-long-test-test-test-1234ab";
process.env.ENCRYPTION_KEY = TEST_ENC_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

import { POST } from "../../app/api/demo/end/route";

function makeRequest(opts: {
  did?: string;
  reason?: string;
}): Parameters<typeof POST>[0] {
  const url = `http://localhost/api/demo/end${
    opts.reason ? `?reason=${opts.reason}` : ""
  }`;
  const headers = new Headers();
  if (opts.did) {
    // NextRequest reads cookies from the Cookie header. Set it manually so
    // we don't have to construct a cookie store fixture.
    headers.set("cookie", `sb_demo_did=${opts.did}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(url, { method: "POST", headers });
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", "..", rel), "utf8");
}

describe("MONEY-393 §3 - /api/demo/end + useDemoAnalytics", () => {
  it("[demo-end] returns { success: true }", async () => {
    const res = await POST(makeRequest({ did: "demo_abc123" }));
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);
  });

  it("[demo-end] clears both sb_demo and sb_demo_did cookies (maxAge=0)", async () => {
    const res = await POST(makeRequest({ did: "demo_zzz" }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    // Both cookies should be set to empty + maxAge=0 / Max-Age=0 / Expires past.
    assert.ok(setCookie.includes("sb_demo="), "must clear sb_demo HMAC cookie");
    assert.ok(
      setCookie.includes("sb_demo_did="),
      "must clear sb_demo_did companion cookie"
    );
    // Either Max-Age=0 or an expired Expires date is acceptable.
    assert.ok(
      /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(setCookie),
      `cookie must be cleared (Max-Age=0 or epoch Expires); got: ${setCookie.slice(0, 200)}`
    );
  });

  it("[demo-end] succeeds even when no sb_demo_did cookie is present", async () => {
    // Already-ended sessions (or never-started) should still complete
    // without throwing - the PostHog branch is skipped when distinctId
    // is missing.
    const res = await POST(makeRequest({}));
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("sb_demo="));
    assert.ok(setCookie.includes("sb_demo_did="));
  });

  it("[demo-end] honors the ?reason=signup query for the demo→signup funnel hop", async () => {
    // The route uses the reason in the event name. Without PostHog key
    // set, the event isn't fired, but the response should still succeed
    // and clear the cookies - covers MONEY-383's signup transition path.
    const res = await POST(
      makeRequest({ did: "demo_signup_user", reason: "signup" })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);
  });

  // ── Source-text guards (catch refactors that break the contract) ──

  it("[demo-end][src] captures demo_ended when reason !== 'signup'", () => {
    const src = readSrc("app/api/demo/end/route.ts");
    assert.match(src, /demo_ended_signup_started/);
    assert.match(src, /demo_ended/);
    // Must read sb_demo_did and reason from the request.
    assert.match(src, /sb_demo_did/);
    assert.match(src, /reason/);
  });

  it("[demo-end][src] skips PostHog when NEXT_PUBLIC_POSTHOG_KEY is unset", () => {
    const src = readSrc("app/api/demo/end/route.ts");
    assert.match(
      src,
      /NEXT_PUBLIC_POSTHOG_KEY/,
      "must gate analytics on the public PostHog key"
    );
  });

  // ── useDemoAnalytics source-text guards ──

  it("[useDemoAnalytics] is a client hook that calls posthog.identify with the sb_demo_did", () => {
    const src = readSrc("lib/hooks/useDemoAnalytics.ts");
    assert.match(src, /^"use client"/m, "must be a client hook");
    assert.match(src, /usePostHog/);
    assert.match(src, /sb_demo_did/, "reads the non-HttpOnly companion cookie");
    assert.match(
      src,
      /posthog\.identify\(did,\s*\{\s*is_demo:\s*true\s*\}\)/,
      "identifies the demo session with is_demo:true so PostHog can segment"
    );
  });

  it("[useDemoAnalytics] dedupes identify calls when distinctId hasn't changed", () => {
    const src = readSrc("lib/hooks/useDemoAnalytics.ts");
    // The hook reads posthog.get_distinct_id() and bails when it
    // already matches - prevents extra network chatter on every mount.
    assert.match(
      src,
      /get_distinct_id\?\.\(\)/,
      "uses optional-chained get_distinct_id() to dedupe"
    );
    assert.match(src, /if\s*\(\s*current\s*===\s*did\s*\)\s*return/);
  });

  it("[useDemoAnalytics] trackDemoCtaClick no-ops when no demo cookie is present", () => {
    const src = readSrc("lib/hooks/useDemoAnalytics.ts");
    assert.match(src, /export\s+function\s+trackDemoCtaClick/);
    // Reads the cookie + bails if missing - safe to call in non-demo contexts.
    assert.match(src, /readCookie\("sb_demo_did"\)/);
    // Capture event name is demo_cta_clicked.
    assert.match(src, /"demo_cta_clicked"/);
  });
});
