/**
 * Gemini Vertex AI Client Tests
 *
 * Exercises the REAL client helpers exported from
 * packages/core/src/gemini/client.ts (via `@usemoney/core/gemini`):
 * `isGeminiEnabled`, `getVertexAIClient`, `resetVertexAIClient`, and the
 * `withVertexAI` result wrapper. No inline reimplementation.
 *
 * The compat adapter seams (`toContents`, `toConfig`, `withTextCompat`,
 * `createGeminiModel`, `aggregateStreamChunks`) are NOT re-exported through the
 * gemini barrel and are already covered against the real source by
 * `packages/core/__tests__/gemini-client-adapter.test.ts` — so this suite stays
 * on the barrel-reachable surface and does not re-shadow them.
 *
 * Hermetic: `getVertexAIClient` constructs `@google/genai` lazily (no network
 * at construction) and `resetVertexAIClient` clears the per-location cache, so
 * every test resets and uses a placeholder project id — no real GCP calls.
 *
 * Divergence the old shadow hid: its `getClient()` mock returned a CACHED
 * wrapper object (so it asserted "same instance on subsequent calls"). The REAL
 * `getVertexAIClient()` caches only the inner `GoogleGenAI` (per location) and
 * returns a FRESH compat wrapper each call, so wrapper identity is NOT stable —
 * that mock-only assertion is dropped rather than asserted falsely.
 *
 * Source: packages/core/src/gemini/client.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  isGeminiEnabled,
  getVertexAIClient,
  resetVertexAIClient,
  withVertexAI,
} from "@usemoney/core/gemini";

// ============================================================================
// Tests
// ============================================================================

describe("Gemini Vertex AI Client (real @usemoney/core exports)", () => {
  // Save/restore env vars
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      USE_GEMINI: process.env.USE_GEMINI,
      GCP_PROJECT_ID: process.env.GCP_PROJECT_ID,
      GCP_LOCATION: process.env.GCP_LOCATION,
      GCP_SERVICE_ACCOUNT_KEY_BASE64:
        process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64,
      GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY,
    };
    // Never let an ambient service-account key or Developer-API key trigger
    // real auth in tests. MONEY-650: GOOGLE_GENAI_API_KEY now selects the
    // Developer-API path, which bypasses the GCP_PROJECT_ID gate — so it must
    // be cleared here for the Vertex-fallback gate tests below to be
    // deterministic (the dedicated Developer-API tests set it explicitly).
    delete process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
    delete process.env.GOOGLE_GENAI_API_KEY;
    resetVertexAIClient();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetVertexAIClient();
  });

  // --------------------------------------------------------------------------
  // isGeminiEnabled
  // --------------------------------------------------------------------------
  describe("isGeminiEnabled", () => {
    it("should return true when USE_GEMINI is 'true'", () => {
      process.env.USE_GEMINI = "true";
      assert.strictEqual(isGeminiEnabled(), true);
    });

    it("should return false when USE_GEMINI is 'false'", () => {
      process.env.USE_GEMINI = "false";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is undefined", () => {
      delete process.env.USE_GEMINI;
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is empty string", () => {
      process.env.USE_GEMINI = "";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is 'TRUE' (case sensitive)", () => {
      process.env.USE_GEMINI = "TRUE";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is '1'", () => {
      process.env.USE_GEMINI = "1";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is 'yes'", () => {
      process.env.USE_GEMINI = "yes";
      assert.strictEqual(isGeminiEnabled(), false);
    });

    it("should return false when USE_GEMINI is 'True'", () => {
      process.env.USE_GEMINI = "True";
      assert.strictEqual(isGeminiEnabled(), false);
    });
  });

  // --------------------------------------------------------------------------
  // getVertexAIClient - project id gate
  // --------------------------------------------------------------------------
  describe("getVertexAIClient - GCP_PROJECT_ID gate", () => {
    it("should throw a GCP_PROJECT_ID error when project id is not set", () => {
      delete process.env.GCP_PROJECT_ID;
      assert.throws(
        () => getVertexAIClient(),
        (err: Error) => {
          assert.ok(err.message.includes("GCP_PROJECT_ID"));
          return true;
        }
      );
    });

    it("should throw a GCP_PROJECT_ID error when project id is empty string", () => {
      process.env.GCP_PROJECT_ID = "";
      assert.throws(
        () => getVertexAIClient(),
        (err: Error) => {
          assert.ok(err.message.includes("GCP_PROJECT_ID"));
          return true;
        }
      );
    });

    it("should return a client handle with getGenerativeModel when project id is set", () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      delete process.env.GCP_LOCATION;
      const client = getVertexAIClient();
      assert.strictEqual(typeof client.getGenerativeModel, "function");
    });

    it("should accept an explicit location override without throwing", () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      const client = getVertexAIClient("global");
      assert.strictEqual(typeof client.getGenerativeModel, "function");
    });

    it("should construct lazily for any region when GCP_LOCATION is set", () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      process.env.GCP_LOCATION = "asia-east1";
      const client = getVertexAIClient();
      assert.strictEqual(typeof client.getGenerativeModel, "function");
    });

    it("should default location (unset GCP_LOCATION) without throwing", () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      delete process.env.GCP_LOCATION;
      // defaultLocation() -> "us-central1"; just must not throw.
      assert.doesNotThrow(() => getVertexAIClient());
    });

    it("getGenerativeModel should build a model handle (generateContent fn) for a fake model", () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      const client = getVertexAIClient();
      const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });
      assert.strictEqual(typeof model.generateContent, "function");
      assert.strictEqual(typeof model.generateContentStream, "function");
    });
  });

  // --------------------------------------------------------------------------
  // getVertexAIClient - Gemini Developer API (api key) path (MONEY-650)
  // --------------------------------------------------------------------------
  describe("getVertexAIClient - Developer API (api key) path", () => {
    it("uses the api key and bypasses the GCP_PROJECT_ID gate", () => {
      process.env.GOOGLE_GENAI_API_KEY = "test-developer-api-key";
      delete process.env.GCP_PROJECT_ID;
      // With the key present, the project-id gate does NOT apply.
      assert.doesNotThrow(() => getVertexAIClient());
      const client = getVertexAIClient();
      assert.strictEqual(typeof client.getGenerativeModel, "function");
    });

    it("ignores the location arg (Developer API is region-less)", () => {
      process.env.GOOGLE_GENAI_API_KEY = "test-developer-api-key";
      delete process.env.GCP_PROJECT_ID;
      const client = getVertexAIClient("global");
      assert.strictEqual(typeof client.getGenerativeModel, "function");
    });
  });

  // --------------------------------------------------------------------------
  // resetVertexAIClient - cache reset behavior
  // --------------------------------------------------------------------------
  describe("resetVertexAIClient", () => {
    it("should allow rebuilding a client after reset (no throw)", () => {
      process.env.GCP_PROJECT_ID = "project-1";
      const c1 = getVertexAIClient("us-central1");
      assert.strictEqual(typeof c1.getGenerativeModel, "function");
      resetVertexAIClient();
      process.env.GCP_PROJECT_ID = "project-2";
      const c2 = getVertexAIClient("us-central1");
      assert.strictEqual(typeof c2.getGenerativeModel, "function");
    });

    it("should re-apply the GCP_PROJECT_ID gate after a reset", () => {
      process.env.GCP_PROJECT_ID = "project-1";
      getVertexAIClient();
      resetVertexAIClient();
      delete process.env.GCP_PROJECT_ID;
      assert.throws(() => getVertexAIClient(), /GCP_PROJECT_ID/);
    });
  });

  // --------------------------------------------------------------------------
  // withVertexAI - success path
  // --------------------------------------------------------------------------
  describe("withVertexAI - success", () => {
    beforeEach(() => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      resetVertexAIClient();
    });

    it("should return success with data when the operation resolves", async () => {
      const result = await withVertexAI(async () => "hello");
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, "hello");
    });

    it("should pass the real client handle into the operation", async () => {
      const result = await withVertexAI(async (client) =>
        typeof client.getGenerativeModel === "function" ? "ok" : "no"
      );
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, "ok");
    });

    it("should return success with object data", async () => {
      const result = await withVertexAI(async () => ({ key: "value" }));
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, { key: "value" });
    });

    it("should not set an error on success", async () => {
      const result = await withVertexAI(async () => "ok");
      assert.strictEqual(result.error, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // withVertexAI - error path
  // --------------------------------------------------------------------------
  describe("withVertexAI - error handling", () => {
    it("should return success:false with the GCP_PROJECT_ID error when project id is missing", async () => {
      delete process.env.GCP_PROJECT_ID;
      resetVertexAIClient();
      const result = await withVertexAI(async () => "unreached");
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("GCP_PROJECT_ID"));
      assert.strictEqual(result.data, undefined);
    });

    it("should capture a thrown Error message from the operation", async () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      resetVertexAIClient();
      const result = await withVertexAI(async () => {
        throw new Error("something went wrong");
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "something went wrong");
      assert.strictEqual(result.data, undefined);
    });

    it("should map a non-Error throw to 'Unknown error'", async () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      resetVertexAIClient();
      const result = await withVertexAI(async () => {
        throw "string error";
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "Unknown error");
    });

    it("should map a thrown number to 'Unknown error'", async () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      resetVertexAIClient();
      const result = await withVertexAI(async () => {
        throw 404;
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "Unknown error");
    });

    it("should map a thrown null to 'Unknown error'", async () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      resetVertexAIClient();
      const result = await withVertexAI(async () => {
        throw null;
      });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "Unknown error");
    });

    it("should capture a TypeError thrown inside the operation", async () => {
      process.env.GCP_PROJECT_ID = "test-project-123";
      resetVertexAIClient();
      const result = await withVertexAI(async () => {
        const obj: Record<string, unknown> = {};
        return (obj as { fn: () => void }).fn();
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });
});
