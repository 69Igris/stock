/**
 * TradingView UDF Time Endpoint - REAL logic tests.
 *
 * Asserts the ACTUAL `getServerTimeSeconds` + `UDF_TIME_CONTENT_TYPE` exports
 * the GET /api/market/udf/time handler calls (from
 * `@/app/api/market/udf/time/time-logic`). The route returns this string
 * verbatim with this content type.
 *
 * The time endpoint returns the current unix timestamp in **seconds** as plain
 * text (NOT JSON). `getServerTimeSeconds` accepts an injectable `now` so the
 * seconds-vs-milliseconds invariant (the bug-prone part) is deterministic.
 *
 * (Replaces the previous SHADOW version, which re-declared the computation
 * inline and asserted the copy.)
 *
 * Source: apps/web/app/api/market/udf/time/route.ts
 *         apps/web/app/api/market/udf/time/time-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getServerTimeSeconds,
  UDF_TIME_CONTENT_TYPE,
} from "@/app/api/market/udf/time/time-logic";

// ============================================================================
// Tests: Response Format
// ============================================================================

describe("UDF Time - Response Format", () => {
  it("should return a string", () => {
    assert.equal(typeof getServerTimeSeconds(), "string");
  });

  it("should return a plain integer string (no decimals)", () => {
    const time = getServerTimeSeconds();
    assert.ok(/^\d+$/.test(time), `Expected integer string, got: ${time}`);
  });

  it("should not contain a decimal point", () => {
    assert.ok(!getServerTimeSeconds().includes("."));
  });

  it("should not be wrapped in JSON", () => {
    const time = getServerTimeSeconds();
    assert.ok(!time.startsWith("{"));
    assert.ok(!time.startsWith("["));
    assert.ok(!time.startsWith('"'));
  });

  it("should not contain whitespace", () => {
    const time = getServerTimeSeconds();
    assert.equal(time.trim(), time);
    assert.ok(!/\s/.test(time));
  });
});

// ============================================================================
// Tests: Value is Unix Seconds (not milliseconds) - deterministic via `now`
// ============================================================================

describe("UDF Time - Value Range", () => {
  it("converts a known ms timestamp to seconds (drops the millis)", () => {
    // 2021-06-01T00:00:00.789Z = 1622505600789 ms → 1622505600 s
    assert.equal(getServerTimeSeconds(1_622_505_600_789), "1622505600");
  });

  it("should be a unix timestamp in seconds (not milliseconds)", () => {
    const nowMs = Date.now();
    const time = Number(getServerTimeSeconds(nowMs));
    // If it were milliseconds, it would be ~1000x larger.
    assert.ok(
      time < nowMs,
      "Value appears to be in milliseconds, expected seconds"
    );
    // Should be a reasonable epoch value (after year 2020).
    assert.ok(time > 1_577_836_800, "Value is before year 2020");
  });

  it("should be within 2 seconds of Date.now()/1000", () => {
    const before = Math.floor(Date.now() / 1000);
    const time = Number(getServerTimeSeconds());
    const after = Math.floor(Date.now() / 1000);
    assert.ok(
      time >= before - 2 && time <= after + 2,
      `Time ${time} not within 2s of [${before}, ${after}]`
    );
  });

  it("should be a positive number for a positive timestamp", () => {
    assert.ok(Number(getServerTimeSeconds()) > 0);
  });

  it("should parse as a finite number", () => {
    const time = Number(getServerTimeSeconds());
    assert.ok(Number.isFinite(time));
    assert.ok(!Number.isNaN(time));
  });

  it("should be an integer (no fractional seconds)", () => {
    const time = Number(getServerTimeSeconds());
    assert.equal(time, Math.floor(time));
  });
});

// ============================================================================
// Tests: Content-Type
// ============================================================================

describe("UDF Time - Content-Type", () => {
  it("should use text/plain content type", () => {
    assert.equal(UDF_TIME_CONTENT_TYPE, "text/plain");
  });

  it("should not use application/json", () => {
    assert.notEqual(UDF_TIME_CONTENT_TYPE, "application/json");
  });
});

// ============================================================================
// Tests: Math.floor(now / 1000) equivalence + digit-width guards
// ============================================================================

describe("UDF Time - Computation Logic", () => {
  it("matches Math.floor(now / 1000) exactly for an injected timestamp", () => {
    const now = 1_700_000_123_456;
    assert.equal(getServerTimeSeconds(now), String(Math.floor(now / 1000)));
  });

  it("should produce 10-digit values for the current era", () => {
    const time = getServerTimeSeconds();
    assert.equal(time.length, 10, `Expected 10-digit timestamp, got ${time}`);
  });

  it("should not produce 13-digit values (milliseconds)", () => {
    const time = getServerTimeSeconds();
    assert.notEqual(
      time.length,
      13,
      "Got 13-digit value - likely milliseconds instead of seconds"
    );
  });
});
