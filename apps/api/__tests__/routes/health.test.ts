/**
 * Health Check Routes Tests - API Server
 *
 * Tests for basic health check response format, ready endpoint with "unknown"
 * status (the fix), liveness probe, and status codes.
 *
 * Exercises the REAL exported helpers from apps/api/src/routes/health.ts
 * (`buildHealthResponse`, `buildReadyResponse`, `buildReadyResponseFromChecks`)
 * that the Hono handlers call — no inline copy.
 *
 * Source: apps/api/src/routes/health.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildHealthResponse,
  buildReadyResponse,
  buildReadyResponseFromChecks,
} from "../../src/routes/health";

// ============================================================================
// Environment Save/Restore
// ============================================================================

let savedEnv: NodeJS.ProcessEnv;

// ============================================================================
// Tests: Basic Health Check
// ============================================================================

describe("Health Routes - Basic Health Check", () => {
  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should return healthy status", () => {
    const response = buildHealthResponse();
    assert.equal(response.status, "healthy");
  });

  it("should include a valid ISO timestamp", () => {
    const response = buildHealthResponse();
    const parsed = new Date(response.timestamp);
    assert.ok(!isNaN(parsed.getTime()));
  });

  it("should return the timestamp in ISO 8601 format", () => {
    const response = buildHealthResponse();
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(response.timestamp),
    );
  });

  it("should include all required fields", () => {
    const response = buildHealthResponse();
    assert.ok("status" in response);
    assert.ok("timestamp" in response);
    assert.ok("version" in response);
    assert.ok("environment" in response);
  });

  it("should return version from npm_package_version if set", () => {
    process.env.npm_package_version = "2.5.0";
    const response = buildHealthResponse();
    assert.equal(response.version, "2.5.0");
  });

  it("should default version to 1.0.0 if npm_package_version not set", () => {
    delete process.env.npm_package_version;
    const response = buildHealthResponse();
    assert.equal(response.version, "1.0.0");
  });

  it("should return environment from NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    const response = buildHealthResponse();
    assert.equal(response.environment, "production");
  });

  it("should default environment to 'development'", () => {
    delete process.env.NODE_ENV;
    const response = buildHealthResponse();
    assert.equal(response.environment, "development");
  });

  it("should return region from CLOUD_RUN_REGION if set", () => {
    process.env.CLOUD_RUN_REGION = "asia-south1";
    const response = buildHealthResponse();
    assert.equal(response.region, "asia-south1");
  });

  it("should default region to 'local'", () => {
    delete process.env.CLOUD_RUN_REGION;
    const response = buildHealthResponse();
    assert.equal(response.region, "local");
  });
});

// ============================================================================
// Tests: Ready Endpoint (with "unknown" status fix)
// ============================================================================

describe("Health Routes - Ready Endpoint", () => {
  it("should report database status as 'unknown' (not falsely healthy)", () => {
    const { body } = buildReadyResponse();
    assert.equal(body.checks.database?.status, "unknown");
  });

  it("should report redis status as 'unknown' (not falsely healthy)", () => {
    const { body } = buildReadyResponse();
    assert.equal(body.checks.redis?.status, "unknown");
  });

  it("should return overall status as 'healthy' when no unhealthy checks", () => {
    const { body } = buildReadyResponse();
    // "unknown" is not "unhealthy", so overall should be "healthy"
    assert.equal(body.status, "healthy");
  });

  it("should return 200 status code when no unhealthy checks", () => {
    const { status } = buildReadyResponse();
    assert.equal(status, 200);
  });
});

// ============================================================================
// Tests: Status Code Logic
// ============================================================================

describe("Health Routes - Status Code Logic", () => {
  it("should return 503 when any dependency is unhealthy", () => {
    const { status, body } = buildReadyResponseFromChecks({
      database: { status: "healthy", latency: 5 },
      redis: { status: "unhealthy" },
    });
    assert.equal(status, 503);
    assert.equal(body.status, "degraded");
  });

  it("should return 200 when all dependencies are healthy", () => {
    const { status, body } = buildReadyResponseFromChecks({
      database: { status: "healthy", latency: 5 },
      redis: { status: "healthy", latency: 2 },
    });
    assert.equal(status, 200);
    assert.equal(body.status, "healthy");
  });

  it("should return 200 when dependencies report 'unknown' (not unhealthy)", () => {
    const { status, body } = buildReadyResponseFromChecks({
      database: { status: "unknown" },
      redis: { status: "unknown" },
    });
    assert.equal(status, 200);
    assert.equal(body.status, "healthy");
  });

  it("should return 'degraded' only when status is literally 'unhealthy'", () => {
    const { body } = buildReadyResponseFromChecks({
      database: { status: "slow" },
      redis: { status: "timeout" },
    });
    // "slow" and "timeout" are not === "unhealthy"
    assert.equal(body.status, "healthy");
  });

  it("should preserve latency for a healthy check", () => {
    const { body } = buildReadyResponseFromChecks({
      database: { status: "healthy", latency: 15 },
      redis: { status: "healthy", latency: 8 },
    });
    assert.equal(body.checks.database?.latency, 15);
    assert.equal(body.checks.redis?.latency, 8);
  });

  it("should carry through both database and redis checks", () => {
    const { body } = buildReadyResponseFromChecks({
      database: { status: "healthy", latency: 1 },
      redis: { status: "healthy", latency: 1 },
    });
    assert.ok("database" in body.checks);
    assert.ok("redis" in body.checks);
  });

  it("should include a valid ISO timestamp in the ready payload", () => {
    const { body } = buildReadyResponseFromChecks({
      database: { status: "unknown" },
      redis: { status: "unknown" },
    });
    assert.ok(!isNaN(new Date(body.timestamp).getTime()));
  });
});
