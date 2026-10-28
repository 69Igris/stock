/**
 * MONEY-393 §34 - app/api/demo/{start,end}/route.ts coverage push
 * (66-70% → 90%+).
 *
 * Existing tests (demo-start.test.ts, demo-end.test.ts) cover the
 * happy paths but skip:
 *   - The 429 rate-limit branch in /start (rl.success === false)
 *   - The PostHog-on branches in both routes (analytics fires + capture
 *     + shutdown succeed / throw)
 *   - The catch-all 500 branch in /start (createDemoToken throws)
 *   - The demo_ended_signup_started branch in /end with PostHog on
 *
 * Strategy: inject stubs for `@usemoney/security/rate-limit`,
 * `@/lib/demo/session`, and `@/lib/posthog` via require.cache before
 * importing the route handlers. Each test re-imports a fresh route
 * module so the module-scope rate limiter doesn't leak state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const TEST_ENC_KEY =
  "demo-branches-test-key-64-chars-long-test-test-test-test-test-12";
process.env.ENCRYPTION_KEY = TEST_ENC_KEY;

// ── Shared helpers ──────────────────────────────────────────────

interface StubPostHog {
  _captures: Array<{ distinctId: string; event: string; properties: unknown }>;
  _shutdownCalls: number;
  capture: (args: {
    distinctId: string;
    event: string;
    properties: unknown;
  }) => void;
  shutdown: () => Promise<void>;
}

function makeStubPostHog(failCapture: boolean = false): StubPostHog {
  const stub: StubPostHog = {
    _captures: [],
    _shutdownCalls: 0,
    capture(args) {
      if (failCapture) throw new Error("simulated posthog capture failure");
      stub._captures.push(args);
    },
    async shutdown() {
      stub._shutdownCalls++;
    },
  };
  return stub;
}

interface StubRateLimiter {
  _checks: Array<{ limit: number; key: string }>;
  check: (limit: number, key: string) => Promise<{ success: boolean }>;
  _allow: boolean;
}

function makeStubRateLimiter(allow: boolean): StubRateLimiter {
  const stub: StubRateLimiter = {
    _checks: [],
    _allow: allow,
    async check(limit: number, key: string) {
      stub._checks.push({ limit, key });
      return { success: stub._allow };
    },
  };
  return stub;
}

interface InjectedMocks {
  rateLimiter?: StubRateLimiter;
  posthog?: StubPostHog;
  posthogReturnsNull?: boolean;
  createDemoTokenThrows?: boolean;
}

function injectMocks(opts: InjectedMocks) {
  const rlPath = require.resolve("@usemoney/security/rate-limit");
  const phPath = require.resolve("../../lib/posthog");
  const sessionPath = require.resolve("../../lib/demo/session");
  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;

  delete cache[rlPath];
  delete cache[phPath];
  delete cache[sessionPath];

  if (opts.rateLimiter) {
    cache[rlPath] = {
      exports: {
        __esModule: true,
        createRateLimiter: () => opts.rateLimiter,
      },
    };
  }
  if (opts.posthog || opts.posthogReturnsNull) {
    // __esModule:true so tsx's __importDefault interop returns our
    // .default rather than wrapping it again.
    cache[phPath] = {
      exports: {
        __esModule: true,
        default: () => (opts.posthogReturnsNull ? null : opts.posthog),
      },
    };
  }
  if (opts.createDemoTokenThrows) {
    cache[sessionPath] = {
      exports: {
        __esModule: true,
        COOKIE_NAME: "sb_demo",
        createDemoToken: async () => {
          throw new Error("simulated createDemoToken failure");
        },
      },
    };
  }
}

// Clear all cached modules touched by the routes between tests.
function clearRouteCaches(): void {
  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/app/api/demo/start/route") ||
      key.includes("/app/api/demo/end/route") ||
      key.endsWith("/security/src/rate-limit.ts") ||
      key.endsWith("/security/src/rate-limit.js") ||
      key.endsWith("/lib/posthog.ts") ||
      key.endsWith("/lib/posthog.js") ||
      key.endsWith("/lib/demo/session.ts") ||
      key.endsWith("/lib/demo/session.js")
    ) {
      delete cache[key];
    }
  }
}

interface RouteModule {
  POST: (req: unknown) => Promise<Response>;
}

function loadStartRoute(): RouteModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../app/api/demo/start/route") as RouteModule;
}

function loadEndRoute(): RouteModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../app/api/demo/end/route") as RouteModule;
}

function makeStartReq(ip: string = "1.2.3.4"): unknown {
  const url = "http://localhost/api/demo/start";
  const headers = new Headers({
    "x-forwarded-for": ip,
    "user-agent": "test-runner",
    referer: "https://usemoney.ai/",
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(url, { method: "POST", headers });
}

function makeEndReq(opts: { did?: string; reason?: string }): unknown {
  const url = `http://localhost/api/demo/end${
    opts.reason ? `?reason=${opts.reason}` : ""
  }`;
  const headers = new Headers();
  if (opts.did) headers.set("cookie", `sb_demo_did=${opts.did}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(url, { method: "POST", headers });
}

// ── /start tests ────────────────────────────────────────────────

describe("MONEY-393 §34 - /api/demo/start branches", () => {
  it("[start] 429 when rate limiter denies the request", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    clearRouteCaches();
    injectMocks({ rateLimiter: makeStubRateLimiter(false) });
    const { POST } = loadStartRoute();
    const res = await POST(makeStartReq("1.1.1.1"));
    assert.equal(res.status, 429);
    const body = (await res.json()) as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /Too many demo sessions/);
  });

  it("[start] fires PostHog demo_started + shutdown when key is set", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    clearRouteCaches();
    const ph = makeStubPostHog();
    injectMocks({
      rateLimiter: makeStubRateLimiter(true),
      posthog: ph,
    });
    const { POST } = loadStartRoute();
    const res = await POST(makeStartReq("8.7.6.5"));
    assert.equal(res.status, 200);
    assert.equal(ph._captures.length, 1, "PostHog capture called once");
    assert.equal(ph._captures[0]!.event, "demo_started");
    assert.equal(ph._shutdownCalls, 1, "shutdown called after capture");
    const props = ph._captures[0]!.properties as {
      source: string | null;
      ua: string | null;
      ip_hash: string | null;
    };
    assert.equal(props.source, "https://usemoney.ai/");
    assert.equal(props.ua, "test-runner");
    assert.equal(
      props.ip_hash,
      "8.7",
      "ip_hash must be first 2 octets only (privacy guard)"
    );
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("[start] swallows PostHog errors and still returns 200", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    clearRouteCaches();
    const failingPh = makeStubPostHog(true);
    injectMocks({
      rateLimiter: makeStubRateLimiter(true),
      posthog: failingPh,
    });
    const { POST } = loadStartRoute();
    const res = await POST(makeStartReq("4.5.6.7"));
    assert.equal(res.status, 200, "analytics failure must not break /start");
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("[start] uses 'unknown' + null ip_hash when no x-forwarded-for header", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    clearRouteCaches();
    const ph = makeStubPostHog();
    injectMocks({
      rateLimiter: makeStubRateLimiter(true),
      posthog: ph,
    });
    const { POST } = loadStartRoute();
    // Build a request with NO IP headers
    const url = "http://localhost/api/demo/start";
    const headers = new Headers({});
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NextRequest } = require("next/server");
    const req = new NextRequest(url, { method: "POST", headers });
    const res = await POST(req);
    assert.equal(res.status, 200);
    const props = ph._captures[0]!.properties as { ip_hash: string | null };
    assert.equal(
      props.ip_hash,
      null,
      "unknown IP must produce null ip_hash (no hash of 'unknown')"
    );
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("[start] returns 500 when createDemoToken throws", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    clearRouteCaches();
    injectMocks({
      rateLimiter: makeStubRateLimiter(true),
      createDemoTokenThrows: true,
    });
    const { POST } = loadStartRoute();
    const res = await POST(makeStartReq("3.3.3.3"));
    assert.equal(res.status, 500);
    const body = (await res.json()) as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /Failed to start demo session/);
  });
});

// ── /end tests ──────────────────────────────────────────────────

describe("MONEY-393 §34 - /api/demo/end branches", () => {
  it("[end] fires demo_ended when reason is absent", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    clearRouteCaches();
    const ph = makeStubPostHog();
    injectMocks({ posthog: ph });
    const { POST } = loadEndRoute();
    const res = await POST(makeEndReq({ did: "demo_x" }));
    assert.equal(res.status, 200);
    assert.equal(ph._captures.length, 1);
    assert.equal(ph._captures[0]!.event, "demo_ended");
    assert.equal(ph._shutdownCalls, 1);
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("[end] fires demo_ended_signup_started when reason=signup", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    clearRouteCaches();
    const ph = makeStubPostHog();
    injectMocks({ posthog: ph });
    const { POST } = loadEndRoute();
    const res = await POST(
      makeEndReq({ did: "demo_signup", reason: "signup" })
    );
    assert.equal(res.status, 200);
    assert.equal(ph._captures[0]!.event, "demo_ended_signup_started");
    const props = ph._captures[0]!.properties as { reason: string };
    assert.equal(props.reason, "signup");
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("[end] swallows PostHog errors and still clears cookies + returns 200", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    clearRouteCaches();
    const failingPh = makeStubPostHog(true);
    injectMocks({ posthog: failingPh });
    const { POST } = loadEndRoute();
    const res = await POST(makeEndReq({ did: "demo_err" }));
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("sb_demo="));
    assert.ok(setCookie.includes("sb_demo_did="));
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("[end] skips PostHog when no distinctId cookie present (even with key set)", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    clearRouteCaches();
    const ph = makeStubPostHog();
    injectMocks({ posthog: ph });
    const { POST } = loadEndRoute();
    const res = await POST(makeEndReq({}));
    assert.equal(res.status, 200);
    assert.equal(
      ph._captures.length,
      0,
      "without distinctId, PostHog must not fire"
    );
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("[end] skips PostHog when key is unset (existing branch - explicit check)", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    clearRouteCaches();
    const ph = makeStubPostHog();
    injectMocks({ posthog: ph });
    const { POST } = loadEndRoute();
    const res = await POST(makeEndReq({ did: "demo_x" }));
    assert.equal(res.status, 200);
    assert.equal(ph._captures.length, 0);
  });
});
