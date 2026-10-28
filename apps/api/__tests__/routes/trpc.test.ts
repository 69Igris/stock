/**
 * tRPC Route Handler Tests - API Server
 *
 * Tests for tRPC context creation. Exercises the REAL `createTrpcContext`
 * exported from apps/api/src/routes/trpc.ts (the function the Hono/tRPC bridge
 * calls) — no inline copy. `createMockHonoContext` is just a test fixture that
 * stands in for Hono's `c` with the `get(key)` accessor the source reads.
 *
 * Source: apps/api/src/routes/trpc.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTrpcContext,
  type TrpcContextSource,
} from "../../src/routes/trpc";

// ============================================================================
// Test fixture: minimal Hono-context stand-in
// ============================================================================

/**
 * Build a mock Hono context exposing the `get(key)` accessor `createTrpcContext`
 * depends on, backed by the supplied variables map.
 */
function createMockHonoContext(
  variables: Record<string, string | undefined>,
): TrpcContextSource {
  return {
    get(key: string): string | undefined {
      return variables[key];
    },
  };
}

// ============================================================================
// Tests: tRPC Context Creation
// ============================================================================

describe("tRPC Routes - Context Creation", () => {
  it("should extract userId from Hono context", () => {
    const c = createMockHonoContext({
      userId: "user_123",
      clerkUserId: "user_123",
    });
    const ctx = createTrpcContext(c);
    assert.equal(ctx.userId, "user_123");
  });

  it("should extract clerkUserId from Hono context", () => {
    const c = createMockHonoContext({
      userId: "user_456",
      clerkUserId: "user_456",
    });
    const ctx = createTrpcContext(c);
    assert.equal(ctx.clerkUserId, "user_456");
  });

  it("should handle missing userId gracefully", () => {
    const c = createMockHonoContext({});
    const ctx = createTrpcContext(c);
    assert.equal(ctx.userId, undefined);
  });

  it("should handle missing clerkUserId gracefully", () => {
    const c = createMockHonoContext({});
    const ctx = createTrpcContext(c);
    assert.equal(ctx.clerkUserId, undefined);
  });

  it("should pass both userId and clerkUserId as same value", () => {
    const c = createMockHonoContext({
      userId: "user_same",
      clerkUserId: "user_same",
    });
    const ctx = createTrpcContext(c);
    assert.equal(ctx.userId, ctx.clerkUserId);
  });

  it("should return an object with exactly userId and clerkUserId keys", () => {
    const c = createMockHonoContext({
      userId: "user_test",
      clerkUserId: "user_test",
    });
    const ctx = createTrpcContext(c);
    const keys = Object.keys(ctx);
    assert.ok(keys.includes("userId"));
    assert.ok(keys.includes("clerkUserId"));
    assert.equal(keys.length, 2);
  });

  it("should handle context when auth middleware did not run", () => {
    const c = createMockHonoContext({
      userId: undefined,
      clerkUserId: undefined,
    });
    const ctx = createTrpcContext(c);
    assert.equal(ctx.userId, undefined);
    assert.equal(ctx.clerkUserId, undefined);
  });

  it("should not mutate the Hono context", () => {
    const variables = {
      userId: "user_immutable",
      clerkUserId: "user_immutable",
    };
    const c = createMockHonoContext(variables);
    createTrpcContext(c);
    assert.equal(variables.userId, "user_immutable");
    assert.equal(variables.clerkUserId, "user_immutable");
  });
});
