/**
 * Cron Sync Products route CONTRACT test.
 *
 * Exercises the REAL symbols the GET /api/cron/sync-products handler uses:
 *   - `verifyCronAuth` (@usemoney/security/cron-auth) — constant-time CRON_SECRET
 *     check that returns the exact 503 (not configured) / 401 (bad token) /
 *     ok statuses the route branches on (MONEY-592).
 *   - `formatCronSyncResponse` (./route-logic) — the success payload shape.
 *
 * (Replaces the previous shadow version, which reimplemented the auth +
 * response logic inline as `validateCronSecret` / `validateAuthHeader` /
 * `parseBearerToken` / `formatSyncResponse` and asserted the copies.)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { verifyCronAuth } from "@usemoney/security/cron-auth";
import { formatCronSyncResponse } from "@/app/api/cron/sync-products/route-logic";

describe("Cron Sync Products route", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.CRON_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = savedSecret;
    }
  });

  describe("verifyCronAuth - CRON_SECRET not configured (fail closed)", () => {
    it("returns 503 when CRON_SECRET is undefined", () => {
      delete process.env.CRON_SECRET;
      const result = verifyCronAuth("Bearer anything");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.status, 503);
    });

    it("returns 503 when CRON_SECRET is empty string", () => {
      process.env.CRON_SECRET = "";
      const result = verifyCronAuth("Bearer ");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.status, 503);
    });
  });

  describe("verifyCronAuth - authorization", () => {
    it("authorizes a correct Bearer token", () => {
      process.env.CRON_SECRET = "my-secret-123";
      const result = verifyCronAuth("Bearer my-secret-123");
      assert.strictEqual(result.ok, true);
    });

    it("rejects a wrong token with 401", () => {
      process.env.CRON_SECRET = "my-secret-123";
      const result = verifyCronAuth("Bearer wrong-token");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.status, 401);
    });

    it("rejects a null header with 401", () => {
      process.env.CRON_SECRET = "my-secret-123";
      const result = verifyCronAuth(null);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.status, 401);
    });

    it("rejects a token without the Bearer prefix", () => {
      process.env.CRON_SECRET = "my-secret-123";
      const result = verifyCronAuth("my-secret-123");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.status, 401);
    });

    it("is case-sensitive for the Bearer prefix", () => {
      process.env.CRON_SECRET = "my-secret-123";
      const result = verifyCronAuth("bearer my-secret-123");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.status, 401);
    });

    it("is constant-time safe on length mismatch (shorter token → 401)", () => {
      process.env.CRON_SECRET = "my-secret-123";
      const result = verifyCronAuth("Bearer my");
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.ok === false && result.status, 401);
    });
  });

  describe("formatCronSyncResponse", () => {
    it("formats a successful sync response", () => {
      const result = formatCronSyncResponse(5, []);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.synced, 5);
      assert.deepStrictEqual(result.errors, []);
      assert.ok(result.timestamp);
    });

    it("includes errors when present", () => {
      const result = formatCronSyncResponse(3, ["Product X failed"]);
      assert.strictEqual(result.synced, 3);
      assert.strictEqual(result.errors.length, 1);
    });

    it("emits an ISO-8601 timestamp string", () => {
      const result = formatCronSyncResponse(0, []);
      assert.strictEqual(typeof result.timestamp, "string");
      assert.ok(!Number.isNaN(Date.parse(result.timestamp)));
    });
  });
});
