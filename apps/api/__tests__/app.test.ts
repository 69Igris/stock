/**
 * Hono Application Setup Tests - API Server
 *
 * Exercises the REAL app logic exported from apps/api/src/app-logic.ts
 * (`getCorsOrigins`, `buildNotFoundBody`, `buildInternalErrorBody`,
 * `buildRootInfoBody`, and the CORS config constants) that apps/api/src/app.ts
 * imports & calls. No inline reimplementation.
 *
 * Covers env-specific CORS allow-lists, the CORS method/header config, the 404
 * body, the root body, and — crucially — that the global error handler NEVER
 * leaks internal error details.
 *
 * Source: apps/api/src/app-logic.ts
 *         apps/api/src/app.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getCorsOrigins,
  buildNotFoundBody,
  buildInternalErrorBody,
  buildRootInfoBody,
  CORS_ALLOW_METHODS,
  CORS_ALLOW_HEADERS,
  CORS_EXPOSE_HEADERS,
  CORS_MAX_AGE,
} from "../src/app-logic";

// ============================================================================
// Environment Save/Restore
// ============================================================================

let savedEnv: NodeJS.ProcessEnv;

// ============================================================================
// Tests: CORS Origin Configuration
// ============================================================================

describe("App - CORS Origin Configuration", () => {
  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should return localhost origins for development environment", () => {
    const origins = getCorsOrigins({ nodeEnv: "development" });
    assert.ok(origins.includes("http://localhost:3000"));
    assert.ok(origins.includes("http://localhost:3001"));
    assert.ok(origins.includes("http://localhost:8080"));
  });

  it("should return localhost origins when no env specified", () => {
    const origins = getCorsOrigins({});
    assert.ok(origins.includes("http://localhost:3000"));
    assert.ok(origins.includes("http://localhost:3001"));
    assert.ok(origins.includes("http://localhost:8080"));
  });

  it("should return production origins for production environment", () => {
    const origins = getCorsOrigins({ nodeEnv: "production" });
    assert.ok(origins.includes("https://usemoney.ai"));
    assert.ok(origins.includes("https://www.usemoney.ai"));
    assert.ok(origins.includes("https://admin.usemoney.ai"));
  });

  it("should return production origins for 'prod' environment", () => {
    const origins = getCorsOrigins({ nodeEnv: "prod" });
    assert.ok(origins.includes("https://usemoney.ai"));
    assert.ok(origins.includes("https://www.usemoney.ai"));
    assert.ok(origins.includes("https://admin.usemoney.ai"));
  });

  it("should NOT include localhost in production", () => {
    const origins = getCorsOrigins({ nodeEnv: "production" });
    assert.ok(!origins.includes("http://localhost:3000"));
    assert.ok(!origins.includes("http://localhost:3001"));
    assert.ok(!origins.includes("http://localhost:8080"));
  });

  it("should return QA origins for qa environment", () => {
    const origins = getCorsOrigins({ nodeEnv: "qa" });
    assert.ok(origins.includes("https://qa.usemoney.ai"));
    assert.ok(origins.includes("https://admin.qa.usemoney.ai"));
  });

  it("should include localhost in QA for testing", () => {
    const origins = getCorsOrigins({ nodeEnv: "qa" });
    assert.ok(origins.includes("http://localhost:3000"));
    assert.ok(origins.includes("http://localhost:3001"));
  });

  it("should include WEB_URL when provided", () => {
    const origins = getCorsOrigins({
      nodeEnv: "development",
      webUrl: "https://custom-web.example.com",
    });
    assert.ok(origins.includes("https://custom-web.example.com"));
  });

  it("should include ADMIN_URL when provided", () => {
    const origins = getCorsOrigins({
      nodeEnv: "development",
      adminUrl: "https://custom-admin.example.com",
    });
    assert.ok(origins.includes("https://custom-admin.example.com"));
  });

  it("should include both WEB_URL and ADMIN_URL when provided", () => {
    const origins = getCorsOrigins({
      nodeEnv: "production",
      webUrl: "https://web.example.com",
      adminUrl: "https://admin.example.com",
    });
    assert.ok(origins.includes("https://web.example.com"));
    assert.ok(origins.includes("https://admin.example.com"));
  });

  it("should only have localhost origins (3) in development with no urls", () => {
    const origins = getCorsOrigins({ nodeEnv: "development" });
    assert.equal(origins.length, 3);
  });

  it("should deduplicate origins when WEB_URL matches a default", () => {
    const origins = getCorsOrigins({
      nodeEnv: "production",
      webUrl: "https://usemoney.ai",
    });
    const count = origins.filter((o) => o === "https://usemoney.ai").length;
    assert.equal(count, 1);
  });

  it("should return an array with no duplicates", () => {
    const origins = getCorsOrigins({
      nodeEnv: "qa",
      webUrl: "http://localhost:3000",
    });
    assert.equal(origins.length, new Set(origins).size);
  });
});

// ============================================================================
// Tests: CORS Configuration Constants
// ============================================================================

describe("App - CORS Configuration", () => {
  it("should allow GET, POST, PUT, PATCH, DELETE, OPTIONS methods", () => {
    assert.deepEqual(
      [...CORS_ALLOW_METHODS],
      ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    );
  });

  it("should allow Content-Type, Authorization, X-Requested-With headers", () => {
    assert.ok(CORS_ALLOW_HEADERS.includes("Content-Type"));
    assert.ok(CORS_ALLOW_HEADERS.includes("Authorization"));
    assert.ok(CORS_ALLOW_HEADERS.includes("X-Requested-With"));
  });

  it("should expose X-Request-Id header", () => {
    assert.deepEqual([...CORS_EXPOSE_HEADERS], ["X-Request-Id"]);
  });

  it("should have max age of 600 seconds", () => {
    assert.equal(CORS_MAX_AGE, 600);
  });
});

// ============================================================================
// Tests: Error Handler (never leaks internal details)
// ============================================================================

describe("App - Error Handler", () => {
  it("should return success: false", () => {
    const result = buildInternalErrorBody(
      new Error("database connection failed"),
    );
    assert.equal(result.success, false);
  });

  it("should return INTERNAL_ERROR code", () => {
    const result = buildInternalErrorBody(new Error("something broke"));
    assert.equal(result.error.code, "INTERNAL_ERROR");
  });

  it("should return the generic message, not the internal error detail", () => {
    const result = buildInternalErrorBody(
      new Error("MongoServerError: Authentication failed for user admin"),
    );
    assert.equal(result.error.message, "An unexpected error occurred");
    assert.ok(!result.error.message.includes("MongoServerError"));
    assert.ok(!result.error.message.includes("Authentication"));
  });

  it("should not leak a SECRET_KEY mentioned in the error", () => {
    const result = buildInternalErrorBody(
      new Error("SECRET_KEY exposed in stack trace"),
    );
    assert.ok(!result.error.message.includes("SECRET_KEY"));
  });

  it("should return the same generic response for any error type", () => {
    const e1 = buildInternalErrorBody(new TypeError("cannot read property"));
    const e2 = buildInternalErrorBody(new RangeError("out of bounds"));
    const e3 = buildInternalErrorBody(new Error("generic error"));
    assert.deepEqual(e1, e2);
    assert.deepEqual(e2, e3);
  });

  it("should return the generic message even when error has no message", () => {
    const err = new Error();
    err.message = "";
    const result = buildInternalErrorBody(err);
    assert.equal(result.error.message, "An unexpected error occurred");
  });

  it("should return the generic message when called with no argument", () => {
    const result = buildInternalErrorBody();
    assert.equal(result.error.message, "An unexpected error occurred");
  });
});

// ============================================================================
// Tests: 404 Handler
// ============================================================================

describe("App - 404 Not Found Handler", () => {
  it("should return success: false", () => {
    assert.equal(buildNotFoundBody("GET", "/nonexistent").success, false);
  });

  it("should return NOT_FOUND error code", () => {
    assert.equal(
      buildNotFoundBody("GET", "/nonexistent").error.code,
      "NOT_FOUND",
    );
  });

  it("should include HTTP method in message", () => {
    assert.ok(
      buildNotFoundBody("POST", "/api/v1/users").error.message.includes("POST"),
    );
  });

  it("should include path in message", () => {
    assert.ok(
      buildNotFoundBody("GET", "/api/v1/unknown").error.message.includes(
        "/api/v1/unknown",
      ),
    );
  });

  it("should format message correctly for various methods", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const result = buildNotFoundBody(method, "/test");
      assert.equal(result.error.message, `Route ${method} /test not found`);
    }
  });
});

// ============================================================================
// Tests: Root Endpoint
// ============================================================================

describe("App - Root Endpoint", () => {
  it("should return the API name", () => {
    assert.equal(buildRootInfoBody().name, "UseMoney API");
  });

  it("should return version 1.0.0", () => {
    assert.equal(buildRootInfoBody().version, "1.0.0");
  });

  it("should return operational status", () => {
    assert.equal(buildRootInfoBody().status, "operational");
  });

  it("should return documentation path", () => {
    assert.equal(buildRootInfoBody().documentation, "/docs");
  });
});
