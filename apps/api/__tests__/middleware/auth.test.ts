/**
 * Authentication Middleware Tests - API Server
 *
 * Exercises the REAL auth logic exported from
 * apps/api/src/middleware/auth-logic.ts (`extractBearerToken`,
 * `buildUnauthorizedBody`, `decideAuth`, `decideOptionalAuth`) that the Hono
 * middleware imports & calls. No inline reimplementation.
 *
 * Covers Bearer-token extraction, missing/malformed header handling, the
 * verify→check-sub→set-context flow, and that internal verifier error messages
 * never leak to the client.
 *
 * MONEY-1062: the decision object now exposes the Clerk subject ONLY as
 * `clerkUserId` (the old `userId` field carried the Clerk sub and was a footgun —
 * the middleware resolves the internal Mongo `_id` itself). These tests assert
 * `clerkUserId` and guard that no `userId` alias leaks back onto the decision.
 *
 * Source: apps/api/src/middleware/auth-logic.ts
 *         apps/api/src/middleware/auth.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  extractBearerToken,
  buildUnauthorizedBody,
  decideAuth,
  decideOptionalAuth,
  type TokenPayload,
} from "../../src/middleware/auth-logic";

// ============================================================================
// Environment Save/Restore
// ============================================================================

let savedEnv: NodeJS.ProcessEnv;

// ============================================================================
// Tests: Bearer Token Extraction
// ============================================================================

describe("Auth Middleware - Token Extraction", () => {
  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should extract token from valid Bearer header", () => {
    assert.equal(
      extractBearerToken("Bearer eyJhbGciOiJSUzI1NiJ9.test"),
      "eyJhbGciOiJSUzI1NiJ9.test",
    );
  });

  it("should extract a long JWT-style token", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.signature";
    assert.equal(extractBearerToken(`Bearer ${jwt}`), jwt);
  });

  it("should return null for undefined header", () => {
    assert.equal(extractBearerToken(undefined), null);
  });

  it("should return null for null header", () => {
    assert.equal(extractBearerToken(null), null);
  });

  it("should return null for empty string", () => {
    assert.equal(extractBearerToken(""), null);
  });

  it("should return null for header without Bearer prefix", () => {
    assert.equal(extractBearerToken("Basic dXNlcjpwYXNz"), null);
  });

  it("should return null for 'Bearer' without space and token", () => {
    assert.equal(extractBearerToken("Bearer"), null);
  });

  it("should return null for 'Bearer' without space (Bearerabc123)", () => {
    assert.equal(extractBearerToken("Bearerabc123"), null);
  });

  it("should return empty string for 'Bearer ' with no token", () => {
    // Matches the production substring(7), which verifyToken then rejects.
    assert.equal(extractBearerToken("Bearer "), "");
  });

  it("should handle token with spaces after Bearer prefix", () => {
    assert.equal(
      extractBearerToken("Bearer token with spaces"),
      "token with spaces",
    );
  });

  it("should preserve trailing space in the token (no trim)", () => {
    assert.equal(extractBearerToken("Bearer abc123 "), "abc123 ");
  });

  it("should preserve leading space with multiple spaces after Bearer", () => {
    assert.equal(extractBearerToken("Bearer  token"), " token");
  });

  it("should handle token with special characters", () => {
    assert.equal(extractBearerToken("Bearer abc+/=_-."), "abc+/=_-.");
  });

  it("should handle a JWT with dots", () => {
    assert.equal(
      extractBearerToken("Bearer header.payload.signature"),
      "header.payload.signature",
    );
  });

  it("should be case-sensitive (lowercase 'bearer' should fail)", () => {
    assert.equal(extractBearerToken("bearer some-token"), null);
  });

  it("should return null for extra prefix text (X-Bearer token)", () => {
    assert.equal(extractBearerToken("X-Bearer token"), null);
  });
});

// ============================================================================
// Tests: buildUnauthorizedBody
// ============================================================================

describe("Auth Middleware - Unauthorized Body", () => {
  it("should produce success:false with UNAUTHORIZED code", () => {
    const body = buildUnauthorizedBody("nope");
    assert.equal(body.success, false);
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(body.error.message, "nope");
  });
});

// ============================================================================
// Tests: Required Auth Flow (decideAuth)
// ============================================================================

describe("Auth Middleware - Required Auth Flow", () => {
  const mockVerifier = mock.fn(
    async (_token: string): Promise<TokenPayload> => ({
      sub: "user_abc123",
      iat: 1700000000,
      exp: 1700003600,
    }),
  );

  beforeEach(() => {
    savedEnv = { ...process.env };
    mockVerifier.mock.resetCalls();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should reject missing Authorization header", async () => {
    const result = await decideAuth(undefined, mockVerifier);
    assert.equal(result.authorized, false);
    assert.equal(result.status, 401);
    assert.equal(
      result.body?.error.message,
      "Missing or invalid Authorization header",
    );
  });

  it("should reject empty Authorization header", async () => {
    const result = await decideAuth("", mockVerifier);
    assert.equal(result.authorized, false);
    assert.equal(result.status, 401);
    assert.equal(result.body?.error.code, "UNAUTHORIZED");
  });

  it("should reject malformed (non-Bearer) Authorization header", async () => {
    const result = await decideAuth("Basic dXNlcjpwYXNz", mockVerifier);
    assert.equal(result.authorized, false);
    assert.equal(result.status, 401);
    assert.equal(result.body?.success, false);
  });

  it("should not call verifier for non-Bearer headers", async () => {
    await decideAuth("Basic abc", mockVerifier);
    assert.equal(mockVerifier.mock.callCount(), 0);
  });

  it("should call verifier with extracted token", async () => {
    await decideAuth("Bearer my-test-token", mockVerifier);
    assert.equal(mockVerifier.mock.callCount(), 1);
    assert.equal(mockVerifier.mock.calls[0]!.arguments[0], "my-test-token");
  });

  it("should expose the Clerk sub as clerkUserId with no userId alias", async () => {
    const result = await decideAuth("Bearer valid-token", mockVerifier);
    assert.equal(result.authorized, true);
    assert.equal(result.clerkUserId, "user_abc123");
    // MONEY-1062: the decision no longer carries a `userId` — it held the Clerk
    // sub and was a footgun; the middleware resolves the Mongo _id itself.
    assert.equal("userId" in result, false);
  });

  it("should set clerkUserId from token payload sub", async () => {
    const result = await decideAuth("Bearer valid-token", mockVerifier);
    assert.equal(result.clerkUserId, "user_abc123");
  });

  it("should carry the Clerk sub on clerkUserId (no userId field)", async () => {
    const verifier = mock.fn(
      async (): Promise<TokenPayload> => ({ sub: "user_xyz789" }),
    );
    const result = await decideAuth("Bearer token", verifier);
    assert.equal(result.clerkUserId, "user_xyz789");
    assert.equal("userId" in result, false);
  });

  it("should handle Clerk-style user IDs", async () => {
    const verifier = mock.fn(
      async (): Promise<TokenPayload> => ({
        sub: "user_2VnxpFe0RkYlvG3sQTm8dIFrNpW",
      }),
    );
    const result = await decideAuth("Bearer token", verifier);
    assert.equal(result.clerkUserId, "user_2VnxpFe0RkYlvG3sQTm8dIFrNpW");
  });

  it("should reject token with missing sub in payload", async () => {
    const noSubVerifier = mock.fn(
      async (): Promise<TokenPayload> => ({ iat: 1700000000, exp: 1700003600 }),
    );
    const result = await decideAuth("Bearer token", noSubVerifier);
    assert.equal(result.authorized, false);
    assert.equal(result.status, 401);
    assert.equal(result.body?.error.message, "Invalid token payload");
  });

  it("should reject token with empty-string sub", async () => {
    const emptySubVerifier = mock.fn(
      async (): Promise<TokenPayload> => ({ sub: "" }),
    );
    const result = await decideAuth("Bearer token", emptySubVerifier);
    assert.equal(result.authorized, false);
    assert.equal(result.body?.error.message, "Invalid token payload");
  });

  it("should reject when token verification throws", async () => {
    const failingVerifier = mock.fn(async (): Promise<TokenPayload> => {
      throw new Error("Token expired");
    });
    const result = await decideAuth("Bearer expired", failingVerifier);
    assert.equal(result.authorized, false);
    assert.equal(result.status, 401);
    assert.equal(result.body?.error.message, "Invalid or expired token");
  });

  it("should NOT leak the verifier error message to the response", async () => {
    const failingVerifier = mock.fn(async (): Promise<TokenPayload> => {
      throw new Error("SENSITIVE: Clerk API key invalid");
    });
    const result = await decideAuth("Bearer bad", failingVerifier);
    assert.ok(!result.body?.error.message.includes("SENSITIVE"));
    assert.ok(!result.body?.error.message.includes("Clerk"));
    assert.equal(result.body?.error.message, "Invalid or expired token");
  });

  it("should not set context vars when auth fails", async () => {
    const failingVerifier = mock.fn(async (): Promise<TokenPayload> => {
      throw new Error("fail");
    });
    const result = await decideAuth("Bearer bad", failingVerifier);
    assert.equal(result.clerkUserId, undefined);
    assert.equal("userId" in result, false);
  });

  it("should handle very long tokens", async () => {
    const longToken = "a".repeat(10000);
    const verifier = mock.fn(
      async (): Promise<TokenPayload> => ({ sub: "user_long" }),
    );
    const result = await decideAuth(`Bearer ${longToken}`, verifier);
    assert.equal(result.authorized, true);
    assert.equal(result.clerkUserId, "user_long");
  });
});

// ============================================================================
// Tests: Optional Auth Flow (decideOptionalAuth)
// ============================================================================

describe("Auth Middleware - Optional Auth Flow", () => {
  const mockVerifier = mock.fn(
    async (_token: string): Promise<TokenPayload> => ({
      sub: "user_optional_123",
    }),
  );

  beforeEach(() => {
    savedEnv = { ...process.env };
    mockVerifier.mock.resetCalls();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should allow request without auth header (no vars)", async () => {
    const ctx = await decideOptionalAuth(undefined, mockVerifier);
    assert.equal(ctx.clerkUserId, undefined);
    assert.equal("userId" in ctx, false);
  });

  it("should allow request with empty header (no vars)", async () => {
    const ctx = await decideOptionalAuth("", mockVerifier);
    assert.equal(ctx.clerkUserId, undefined);
  });

  it("should set clerkUserId when valid token is provided", async () => {
    const ctx = await decideOptionalAuth("Bearer valid-token", mockVerifier);
    assert.equal(ctx.clerkUserId, "user_optional_123");
    assert.equal("userId" in ctx, false);
  });

  it("should silently ignore invalid tokens", async () => {
    const failingVerifier = mock.fn(async (): Promise<TokenPayload> => {
      throw new Error("Token invalid");
    });
    const ctx = await decideOptionalAuth("Bearer bad", failingVerifier);
    assert.equal(ctx.clerkUserId, undefined);
  });

  it("should not call verifier for non-Bearer headers", async () => {
    const ctx = await decideOptionalAuth("Basic abc", mockVerifier);
    assert.equal(mockVerifier.mock.callCount(), 0);
    assert.equal(ctx.clerkUserId, undefined);
  });

  it("should not set vars when sub is missing from payload", async () => {
    const noSubVerifier = mock.fn(
      async (): Promise<TokenPayload> => ({ iat: 1700000000 }),
    );
    const ctx = await decideOptionalAuth("Bearer token", noSubVerifier);
    assert.equal(ctx.clerkUserId, undefined);
  });

  it("should not set vars when sub is empty", async () => {
    const emptySubVerifier = mock.fn(
      async (): Promise<TokenPayload> => ({ sub: "" }),
    );
    const ctx = await decideOptionalAuth("Bearer token", emptySubVerifier);
    assert.equal(ctx.clerkUserId, undefined);
  });

  it("should set context identical to required auth on a valid token", async () => {
    const verifier = mock.fn(
      async (): Promise<TokenPayload> => ({ sub: "user_shared_456" }),
    );
    const required = await decideAuth("Bearer tok", verifier);
    const optional = await decideOptionalAuth("Bearer tok", verifier);
    assert.equal(optional.clerkUserId, required.clerkUserId);
    assert.equal(optional.clerkUserId, "user_shared_456");
  });
});
