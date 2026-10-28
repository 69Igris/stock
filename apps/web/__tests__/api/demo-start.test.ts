/**
 * MONEY-383: /api/demo/start must:
 *   1. Mint an HMAC-signed sb_demo cookie (existing behavior)
 *   2. Mint a non-HttpOnly sb_demo_did companion cookie with a unique distinctId
 *   3. Return { success: true, distinctId } in the JSON body
 *
 * MONEY-278 dependency: distinctId is used by useDemoAnalytics on the client
 * to identify the PostHog session.
 *
 * This test exercises the route shape without firing real PostHog events
 * (NEXT_PUBLIC_POSTHOG_KEY unset → analytics block skipped).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Required so the route can sign tokens.
const TEST_ENC_KEY =
  "demo-start-test-encryption-key-64-chars-long-test-test-test-1234";
process.env.ENCRYPTION_KEY = TEST_ENC_KEY;
// Force the PostHog branch off so we don't hit the real client.
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

import { POST } from "../../app/api/demo/start/route";

function makeRequest(ip = "1.2.3.4"): Parameters<typeof POST>[0] {
  // The route reads headers + auths via createDemoToken. We mock with
  // a minimal NextRequest-shaped object using the global Headers + URL.
  const url = "http://localhost/api/demo/start";
  const headers = new Headers({
    "x-forwarded-for": ip,
    "user-agent": "test-runner",
    referer: "https://usemoney.ai/",
  });
  // NextRequest is structurally compatible - we use the real constructor.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(url, { method: "POST", headers });
}

describe("MONEY-383 - /api/demo/start", () => {
  it("returns success + distinctId", async () => {
    const req = makeRequest("1.2.3.4");
    const res = await POST(req);
    const body = (await res.json()) as {
      success: boolean;
      distinctId?: string;
    };
    assert.equal(body.success, true);
    assert.equal(typeof body.distinctId, "string");
    assert.ok(body.distinctId!.startsWith("demo_"));
  });

  it("sets sb_demo and sb_demo_did cookies", async () => {
    const req = makeRequest("4.3.2.1");
    const res = await POST(req);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("sb_demo="), "expected sb_demo cookie");
    assert.ok(
      setCookie.includes("sb_demo_did="),
      "expected sb_demo_did companion cookie"
    );
  });

  it("each call mints a unique distinctId", async () => {
    // Rate limiter uses IP - vary IPs so the limiter doesn't kick in.
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const req = makeRequest(`9.8.7.${i + 1}`);
      const res = await POST(req);
      const body = (await res.json()) as { distinctId?: string };
      ids.add(body.distinctId ?? "");
    }
    assert.equal(ids.size, 3, "expected three distinct distinctIds");
  });
});
