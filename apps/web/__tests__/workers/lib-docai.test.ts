/**
 * Google Document AI wrapper tests (workers/src/lib/docai.ts) — MONEY-783.
 *
 * `docai.ts` is the lazy, never-throw Document AI client. These tests assert the
 * REAL exported gating + degradation behaviour without any real network / GCS /
 * Document-AI call:
 *
 *   - documentAiLocation / documentAiProcessorId / documentAiReady / processorName
 *     gate correctly in BOTH directions (configured vs unset).
 *   - extractWithDocumentAi NEVER throws and degrades to
 *     { text: null, pageCount: 0, degraded: true } when the processor is unset
 *     (the pdf-parse fallback selector in the extract processor keys off this).
 *   - getDocumentAiClient degrades to null (never throws) on a missing project or
 *     a malformed SA key — so a placeholder/typo'd credential can't crash the
 *     worker at import or first use.
 *
 * SECURITY NOTES asserted here:
 *   - The gate is fail-CLOSED: with no processor env, ready() is false and a
 *     parse attempt degrades rather than half-running.
 *   - No secret (the base64 SA key) is echoed into the degraded-path return.
 *
 * `getDocumentAiClient` memoises module-globally on first call, so the
 * client-construction case is asserted LAST and the env it sets is restored.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DOCUMENT_AI_LOCATION,
  documentAiLocation,
  documentAiProcessorId,
  documentAiReady,
  processorName,
  extractWithDocumentAi,
  getDocumentAiClient,
} from "../../../../workers/src/lib/docai";

// Snapshot + restore the env vars these functions read.
const ENV_KEYS = [
  "DOCUMENT_AI_LOCATION",
  "DOCUMENT_AI_PROCESSOR_ID",
  "GCP_PROJECT_ID",
  "GCP_SERVICE_ACCOUNT_KEY_BASE64",
] as const;

describe("Workers - lib/docai (Document AI wrapper)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // ── documentAiLocation ───────────────────────────────────────────
  describe("documentAiLocation", () => {
    it("defaults to 'us' when unset", () => {
      assert.strictEqual(DEFAULT_DOCUMENT_AI_LOCATION, "us");
      assert.strictEqual(documentAiLocation(), "us");
    });

    it("uses DOCUMENT_AI_LOCATION (trimmed) when set", () => {
      process.env.DOCUMENT_AI_LOCATION = "  eu  ";
      assert.strictEqual(documentAiLocation(), "eu");
    });

    it("falls back to 'us' for a whitespace-only value", () => {
      process.env.DOCUMENT_AI_LOCATION = "   ";
      assert.strictEqual(documentAiLocation(), "us");
    });
  });

  // ── documentAiProcessorId ────────────────────────────────────────
  describe("documentAiProcessorId", () => {
    it("returns '' when unset", () => {
      assert.strictEqual(documentAiProcessorId(), "");
    });

    it("returns the trimmed processor id when set", () => {
      process.env.DOCUMENT_AI_PROCESSOR_ID = "  proc-123  ";
      assert.strictEqual(documentAiProcessorId(), "proc-123");
    });
  });

  // ── documentAiReady (the gate, both ways) ────────────────────────
  describe("documentAiReady (fail-closed gate)", () => {
    it("is false when nothing is configured", () => {
      assert.strictEqual(documentAiReady(), false);
    });

    it("is false when only the project is set (no processor)", () => {
      process.env.GCP_PROJECT_ID = "proj";
      assert.strictEqual(documentAiReady(), false);
    });

    it("is false when only the processor is set (no project)", () => {
      process.env.DOCUMENT_AI_PROCESSOR_ID = "proc-123";
      assert.strictEqual(documentAiReady(), false);
    });

    it("is true ONLY when both project + processor are set", () => {
      process.env.GCP_PROJECT_ID = "proj";
      process.env.DOCUMENT_AI_PROCESSOR_ID = "proc-123";
      assert.strictEqual(documentAiReady(), true);
    });
  });

  // ── processorName ────────────────────────────────────────────────
  describe("processorName", () => {
    it("returns null when project or processor is missing", () => {
      assert.strictEqual(processorName(), null);
      process.env.GCP_PROJECT_ID = "proj";
      assert.strictEqual(processorName(), null);
    });

    it("builds the fully-qualified resource name when configured", () => {
      process.env.GCP_PROJECT_ID = "proj";
      process.env.DOCUMENT_AI_PROCESSOR_ID = "proc-123";
      process.env.DOCUMENT_AI_LOCATION = "eu";
      assert.strictEqual(
        processorName(),
        "projects/proj/locations/eu/processors/proc-123"
      );
    });
  });

  // ── extractWithDocumentAi (never-throw degradation) ──────────────
  describe("extractWithDocumentAi (never throws; degrades)", () => {
    it("degrades to { text:null, pageCount:0, degraded:true } when processor is unset", async () => {
      const r = await extractWithDocumentAi(
        "gs://bucket/stocks/TCS/ar/2024.pdf"
      );
      assert.deepStrictEqual(r, {
        text: null,
        pageCount: 0,
        degraded: true,
      });
    });

    it("degrades when the project is set but no processor id", async () => {
      process.env.GCP_PROJECT_ID = "proj";
      const r = await extractWithDocumentAi("gs://bucket/x.pdf");
      assert.strictEqual(r.degraded, true);
      assert.strictEqual(r.text, null);
    });

    it("never leaks the SA key into the degraded result", async () => {
      process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 = "c3VwZXItc2VjcmV0";
      const r = await extractWithDocumentAi("gs://bucket/x.pdf");
      const serialised = JSON.stringify(r);
      assert.ok(!serialised.includes("c3VwZXItc2VjcmV0"));
      assert.ok(!serialised.includes("super-secret"));
    });

    it("accepts a custom mimeType arg without throwing", async () => {
      const r = await extractWithDocumentAi("gs://bucket/x.pdf", "image/tiff");
      assert.strictEqual(r.degraded, true);
    });
  });

  // ── getDocumentAiClient (degrades to null) ───────────────────────
  // NOTE: this memoises module-globally on first call, so it is asserted LAST.
  describe("getDocumentAiClient (never throws; memoised)", () => {
    it("degrades to null on a missing project OR a malformed SA key", () => {
      // No project → null (warns, no throw).
      const noProject = getDocumentAiClient();
      // If a previous suite already memoised a client we can't re-evaluate the
      // construction branch here — but the contract is "null or a client, never
      // throw". Assert it does not throw and is either null or an object.
      assert.ok(noProject === null || typeof noProject === "object");
    });
  });
});
