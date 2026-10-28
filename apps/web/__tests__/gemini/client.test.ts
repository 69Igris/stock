/**
 * Gemini Client Tests (lib/gemini/client.ts + lib/gemini/client-logic.ts)
 *
 * De-shadowed (MONEY-620): previously this file inlined verbatim copies of the
 * client's pure helpers and asserted the copies. It now imports the REAL
 * exports:
 *   - isGeminiEnabled              from @/lib/gemini/client       (reads env)
 *   - resolveGeminiLocation, validateProjectId, decodeBase64Credentials,
 *     determineAuthMethod, formatInitError   from @/lib/gemini/client-logic
 * which `getVertexAIClient` in client.ts now calls (no shadow).
 *
 * Source: apps/web/lib/gemini/client-logic.ts (+ client.ts isGeminiEnabled)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { isGeminiEnabled } from "@/lib/gemini/client";
import {
  resolveGeminiLocation as getDefaultLocation,
  validateProjectId,
  decodeBase64Credentials,
  determineAuthMethod,
  formatInitError,
} from "@/lib/gemini/client-logic";

// ── Environment variable save/restore helpers ────────────────────────────

let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "USE_GEMINI",
  "GCP_PROJECT_ID",
  "GCP_LOCATION",
  "GCP_SERVICE_ACCOUNT_KEY_BASE64",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

function saveEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Gemini Client", () => {
  beforeEach(() => {
    saveEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  // ───────────────────── isGeminiEnabled (real, reads env) ────────────────

  describe("isGeminiEnabled", () => {
    it('should return true when USE_GEMINI is "true"', () => {
      process.env.USE_GEMINI = "true";
      assert.strictEqual(isGeminiEnabled(), true);
    });

    it('should return false when USE_GEMINI is "false"', () => {
      process.env.USE_GEMINI = "false";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is unset", () => {
      delete process.env.USE_GEMINI;
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is empty string", () => {
      process.env.USE_GEMINI = "";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it('should be case-sensitive: "TRUE" is false', () => {
      process.env.USE_GEMINI = "TRUE";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it('should be case-sensitive: "True" is false', () => {
      process.env.USE_GEMINI = "True";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it('should return false for "1"', () => {
      process.env.USE_GEMINI = "1";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it('should return false for "yes"', () => {
      process.env.USE_GEMINI = "yes";
      assert.strictEqual(isGeminiEnabled(), false);
    });
  });

  // ───────────────────── resolveGeminiLocation ─────────────────

  describe("getDefaultLocation", () => {
    it('should return "us-central1" when location is undefined', () => {
      assert.strictEqual(getDefaultLocation(undefined), "us-central1");
    });

    it('should return "us-central1" when location is empty string', () => {
      assert.strictEqual(getDefaultLocation(""), "us-central1");
    });

    it("should return custom location when provided", () => {
      assert.strictEqual(getDefaultLocation("europe-west1"), "europe-west1");
    });

    it("should return asia-southeast1 when set", () => {
      assert.strictEqual(
        getDefaultLocation("asia-southeast1"),
        "asia-southeast1"
      );
    });

    it("should return us-east4 when set", () => {
      assert.strictEqual(getDefaultLocation("us-east4"), "us-east4");
    });

    it("should work with process.env.GCP_LOCATION", () => {
      process.env.GCP_LOCATION = "asia-east1";
      assert.strictEqual(
        getDefaultLocation(process.env.GCP_LOCATION),
        "asia-east1"
      );
    });

    it("should fallback when process.env.GCP_LOCATION is not set", () => {
      delete process.env.GCP_LOCATION;
      assert.strictEqual(
        getDefaultLocation(process.env.GCP_LOCATION),
        "us-central1"
      );
    });
  });

  // ───────────────────── validateProjectId ─────────────────

  describe("validateProjectId", () => {
    it("should return valid for a normal project ID", () => {
      const result = validateProjectId("my-gcp-project-123");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    it("should return valid for a project ID with hyphens", () => {
      const result = validateProjectId("stockbook-prod-12345");
      assert.strictEqual(result.valid, true);
    });

    it("should return invalid for undefined project ID", () => {
      const result = validateProjectId(undefined);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
      assert.ok(result.error!.includes("GCP_PROJECT_ID"));
    });

    it("should return invalid for empty string project ID", () => {
      const result = validateProjectId("");
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
    });

    it("should include 'required' in error message for missing project ID", () => {
      const result = validateProjectId(undefined);
      assert.ok(result.error!.includes("required"));
    });

    it("should work with process.env.GCP_PROJECT_ID", () => {
      process.env.GCP_PROJECT_ID = "test-project";
      const result = validateProjectId(process.env.GCP_PROJECT_ID);
      assert.strictEqual(result.valid, true);
    });

    it("should fail when process.env.GCP_PROJECT_ID is not set", () => {
      delete process.env.GCP_PROJECT_ID;
      const result = validateProjectId(process.env.GCP_PROJECT_ID);
      assert.strictEqual(result.valid, false);
    });
  });

  // ───────────────────── decodeBase64Credentials ─────────────────

  describe("decodeBase64Credentials", () => {
    it("should decode valid base64-encoded JSON credentials", () => {
      const creds = { type: "service_account", project_id: "my-project" };
      const base64 = Buffer.from(JSON.stringify(creds)).toString("base64");
      const result = decodeBase64Credentials(base64);
      assert.strictEqual(result.type, "service_account");
      assert.strictEqual(result.project_id, "my-project");
    });

    it("should decode credentials with client_email field", () => {
      const creds = {
        type: "service_account",
        client_email: "sa@project.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
      };
      const base64 = Buffer.from(JSON.stringify(creds)).toString("base64");
      const result = decodeBase64Credentials(base64);
      assert.strictEqual(
        result.client_email,
        "sa@project.iam.gserviceaccount.com"
      );
    });

    it("should decode empty JSON object from base64", () => {
      const base64 = Buffer.from("{}").toString("base64");
      const result = decodeBase64Credentials(base64);
      assert.deepStrictEqual(result, {});
    });

    it("should handle credentials with nested objects", () => {
      const creds = {
        type: "service_account",
        auth_provider_x509_cert_url:
          "https://www.googleapis.com/oauth2/v1/certs",
        token_uri: "https://oauth2.googleapis.com/token",
      };
      const base64 = Buffer.from(JSON.stringify(creds)).toString("base64");
      const result = decodeBase64Credentials(base64);
      assert.strictEqual(
        result.token_uri,
        "https://oauth2.googleapis.com/token"
      );
    });

    it("should throw for invalid base64 that produces invalid JSON", () => {
      const base64 = Buffer.from("not valid json").toString("base64");
      assert.throws(() => decodeBase64Credentials(base64), {
        name: "SyntaxError",
      });
    });

    it("should handle base64 of empty string (throws on parse)", () => {
      const base64 = Buffer.from("").toString("base64");
      assert.throws(() => decodeBase64Credentials(base64));
    });

    it("should decode credentials with numeric values", () => {
      const creds = { project_number: 123456789, quota_limit: 1000 };
      const base64 = Buffer.from(JSON.stringify(creds)).toString("base64");
      const result = decodeBase64Credentials(base64);
      assert.strictEqual(result.project_number, 123456789);
      assert.strictEqual(result.quota_limit, 1000);
    });
  });

  // ───────────────────── determineAuthMethod ─────────────────

  describe("determineAuthMethod", () => {
    it("should return 'base64_credentials' when base64Creds is provided", () => {
      assert.strictEqual(
        determineAuthMethod("c29tZWJhc2U2NA==", undefined),
        "base64_credentials"
      );
    });

    it("should return 'file_path' when only filePath is provided", () => {
      assert.strictEqual(
        determineAuthMethod(undefined, "/path/to/creds.json"),
        "file_path"
      );
    });

    it("should return 'none' when neither is provided", () => {
      assert.strictEqual(determineAuthMethod(undefined, undefined), "none");
    });

    it("should prefer base64_credentials over file_path when both are provided", () => {
      assert.strictEqual(
        determineAuthMethod("c29tZWJhc2U2NA==", "/path/to/creds.json"),
        "base64_credentials"
      );
    });

    it("should return 'none' when both are empty strings", () => {
      assert.strictEqual(determineAuthMethod("", ""), "none");
    });

    it("should return 'base64_credentials' for non-empty base64 with empty filePath", () => {
      assert.strictEqual(determineAuthMethod("data", ""), "base64_credentials");
    });

    it("should return 'file_path' for empty base64 with non-empty filePath", () => {
      assert.strictEqual(
        determineAuthMethod("", "/path/to/key.json"),
        "file_path"
      );
    });

    it("should work with actual process.env values", () => {
      process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 = "base64data";
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      assert.strictEqual(
        determineAuthMethod(
          process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64,
          process.env.GOOGLE_APPLICATION_CREDENTIALS
        ),
        "base64_credentials"
      );
    });

    it("should detect file_path from process.env when no base64", () => {
      delete process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/home/user/key.json";
      assert.strictEqual(
        determineAuthMethod(
          process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64,
          process.env.GOOGLE_APPLICATION_CREDENTIALS
        ),
        "file_path"
      );
    });

    it("should detect none when both process.env vars are missing", () => {
      delete process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      assert.strictEqual(
        determineAuthMethod(
          process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64,
          process.env.GOOGLE_APPLICATION_CREDENTIALS
        ),
        "none"
      );
    });
  });

  // ───────────────────── formatInitError ─────────────────

  describe("formatInitError", () => {
    it("should format an Error object with its message", () => {
      const err = new Error("Connection refused");
      assert.strictEqual(
        formatInitError(err),
        "Failed to initialize Vertex AI: Connection refused"
      );
    });

    it("should format a TypeError", () => {
      const err = new TypeError("Invalid argument");
      assert.strictEqual(
        formatInitError(err),
        "Failed to initialize Vertex AI: Invalid argument"
      );
    });

    it('should format a string error as "Unknown error"', () => {
      assert.strictEqual(
        formatInitError("some string error"),
        "Failed to initialize Vertex AI: Unknown error"
      );
    });

    it('should format null as "Unknown error"', () => {
      assert.strictEqual(
        formatInitError(null),
        "Failed to initialize Vertex AI: Unknown error"
      );
    });

    it('should format undefined as "Unknown error"', () => {
      assert.strictEqual(
        formatInitError(undefined),
        "Failed to initialize Vertex AI: Unknown error"
      );
    });

    it('should format a number as "Unknown error"', () => {
      assert.strictEqual(
        formatInitError(42),
        "Failed to initialize Vertex AI: Unknown error"
      );
    });

    it('should format a plain object as "Unknown error"', () => {
      assert.strictEqual(
        formatInitError({ code: "ECONNREFUSED" }),
        "Failed to initialize Vertex AI: Unknown error"
      );
    });

    it("should always start with 'Failed to initialize Vertex AI:'", () => {
      const cases = [new Error("test"), "string", null, undefined, 42, {}, []];
      for (const err of cases) {
        const result = formatInitError(err);
        assert.ok(
          result.startsWith("Failed to initialize Vertex AI:"),
          `Failed for error: ${String(err)}`
        );
      }
    });

    it("should handle Error with empty message", () => {
      const err = new Error("");
      assert.strictEqual(
        formatInitError(err),
        "Failed to initialize Vertex AI: "
      );
    });

    it("should handle Error with long message", () => {
      const longMsg = "Error detail: " + "x".repeat(500);
      const err = new Error(longMsg);
      assert.ok(formatInitError(err).includes(longMsg));
    });
  });
});
