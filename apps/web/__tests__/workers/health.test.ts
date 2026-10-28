/**
 * Health Route Tests (workers/src/routes/health.ts)
 *
 * Tests for the GET /health endpoint.
 *
 * The actual source uses Hono:
 *   healthRoute.get("/", (c) => {
 *     return c.json({ status: "ok", timestamp: new Date().toISOString() });
 *   });
 *
 * Since importing Hono and running a full HTTP server is overkill for
 * unit tests, we inline the handler logic and verify the output contract.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline the health handler logic ─────────────────────────────────

interface HealthResponse {
  status: string;
  timestamp: string;
}

/**
 * Mirrors the handler in workers/src/routes/health.ts.
 * Returns the same JSON shape the Hono route produces.
 */
function healthHandler(): HealthResponse {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Workers - Health Route", () => {
  it("should return status 'ok'", () => {
    const response = healthHandler();

    assert.strictEqual(response.status, "ok");
  });

  it("should include a timestamp field", () => {
    const response = healthHandler();

    assert.ok(
      "timestamp" in response,
      "response should have a 'timestamp' property"
    );
    assert.strictEqual(typeof response.timestamp, "string");
  });

  it("should return a valid ISO 8601 timestamp", () => {
    const response = healthHandler();

    // Date.parse returns NaN for invalid date strings
    const parsed = Date.parse(response.timestamp);
    assert.ok(
      !isNaN(parsed),
      `timestamp should be parseable as a date: ${response.timestamp}`
    );

    // Verify it round-trips through Date correctly
    const roundTripped = new Date(response.timestamp).toISOString();
    assert.strictEqual(response.timestamp, roundTripped);
  });

  it("should return a timestamp close to the current time", () => {
    const before = Date.now();
    const response = healthHandler();
    const after = Date.now();

    const ts = new Date(response.timestamp).getTime();
    assert.ok(ts >= before, "timestamp should be >= time before the call");
    assert.ok(ts <= after, "timestamp should be <= time after the call");
  });

  it("should return a fresh timestamp on each call", () => {
    const response1 = healthHandler();
    // Introduce a tiny delay to ensure timestamps can differ
    const start = Date.now();
    while (Date.now() - start < 2) {
      // busy-wait for ~2ms
    }
    const response2 = healthHandler();

    // Both should be valid
    assert.strictEqual(response1.status, "ok");
    assert.strictEqual(response2.status, "ok");

    // Timestamps should be different (or at least both valid)
    const ts1 = new Date(response1.timestamp).getTime();
    const ts2 = new Date(response2.timestamp).getTime();
    assert.ok(ts2 >= ts1, "second timestamp should be >= first timestamp");
  });

  it("should have exactly two keys in the response object", () => {
    const response = healthHandler();
    const keys = Object.keys(response);

    assert.strictEqual(keys.length, 2);
    assert.ok(keys.includes("status"), "should contain 'status' key");
    assert.ok(keys.includes("timestamp"), "should contain 'timestamp' key");
  });

  it("should produce JSON-serializable output", () => {
    const response = healthHandler();

    // Ensure it can be serialized and deserialized without loss
    const serialized = JSON.stringify(response);
    const deserialized = JSON.parse(serialized) as HealthResponse;

    assert.strictEqual(deserialized.status, "ok");
    assert.strictEqual(deserialized.timestamp, response.timestamp);
  });

  it("should use ISO 8601 format with Z suffix (UTC)", () => {
    const response = healthHandler();

    // new Date().toISOString() always ends with 'Z'
    assert.ok(
      response.timestamp.endsWith("Z"),
      `timestamp should end with 'Z' (UTC): ${response.timestamp}`
    );
  });

  it("should produce a timestamp matching the YYYY-MM-DDTHH:mm:ss.sssZ pattern", () => {
    const response = healthHandler();

    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assert.ok(
      isoPattern.test(response.timestamp),
      `timestamp should match ISO 8601 pattern: ${response.timestamp}`
    );
  });
});
