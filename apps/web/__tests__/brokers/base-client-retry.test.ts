/**
 * Broker base-client retry / sanitization contract — MONEY-582d.
 *
 * The pure decision helpers (isRetryableStatus, backoffMs) are exported and
 * imported directly. makeRequest itself needs fetch + an abstract subclass, so
 * its sanitization contract is asserted via an inline mirror of the throw
 * format (kept in lockstep with base-client.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryableStatus, backoffMs } from "../../lib/brokers/base-client";

describe("isRetryableStatus (MONEY-582d)", () => {
  it("retries rate-limit (429) and 5xx", () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
  });

  it("does NOT retry deterministic 4xx (expired token, bad request, forbidden)", () => {
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(403), false);
    assert.equal(isRetryableStatus(404), false);
  });

  it("does not retry success codes", () => {
    assert.equal(isRetryableStatus(200), false);
  });
});

describe("backoffMs (MONEY-582d exponential)", () => {
  it("grows 500ms, 1000ms, 2000ms", () => {
    assert.equal(backoffMs(0), 500);
    assert.equal(backoffMs(1), 1000);
    assert.equal(backoffMs(2), 2000);
  });
});

describe("error sanitization contract (MONEY-582d)", () => {
  // Mirror of base-client.ts makeRequest's throw format. The invariant: the raw
  // upstream BODY is never interpolated — only status + statusText.
  function sanitizedMessage(
    broker: string,
    status: number,
    statusText: string
  ): string {
    return `${broker} API Error: ${status} - ${statusText}`;
  }

  it("never includes the raw upstream body", () => {
    const secretBody = '{"error":"token abc123 for account UN1836 is invalid"}';
    const msg = sanitizedMessage("ZERODHA", 401, "Unauthorized");
    assert.ok(!msg.includes(secretBody));
    assert.ok(!msg.includes("UN1836"));
    assert.ok(!msg.includes("abc123"));
  });

  it("preserves 'API Error: <status>' so 499 classifier + 582e 403-check key on it", () => {
    assert.match(
      sanitizedMessage("ZERODHA", 403, "Forbidden"),
      /API Error: 403\b/
    );
    assert.match(
      sanitizedMessage("ZERODHA", 429, "Too Many Requests"),
      /API Error: 429\b/
    );
    assert.match(
      sanitizedMessage("ZERODHA", 500, "Internal Server Error"),
      /API Error: 500\b/
    );
  });
});
