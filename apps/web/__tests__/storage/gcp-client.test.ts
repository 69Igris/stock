/**
 * GCP Cloud Storage Client Logic Tests
 *
 * De-shadowed (MONEY-620): imports the REAL pure helpers from
 * lib/storage/gcp-client-logic.ts, which gcp-client.ts (getStorageClient /
 * getBucket / uploadFile) now calls. Importing the logic module does NOT
 * instantiate the @google-cloud/storage client (that's lazy), so it loads clean
 * under node:test.
 *
 * Divergences the old inline shadow hid and this fixes:
 *   - validateProjectId returned `{ valid, error }`; the REAL code throws
 *     (assertProjectId → MISSING_PROJECT_ID_ERROR). Asserted via throws here.
 *   - formatStorageInitError invented a "Failed to initialize GCP Storage: <msg>"
 *     string; the REAL catch throws the constant STORAGE_INIT_ERROR
 *     ("Failed to initialize storage service"). Pinned to the real constant.
 *   - validateFilePath / getCredentialsPathForLog had no source counterpart and
 *     are dropped (no dead exports).
 *
 * MONEY-807: resolveStorageAuthMethod + decodeBase64Credentials were deleted
 * from the source (credential resolution moved to `googleCredentials()`), so
 * their test blocks were removed here — the live base64-decode path now lives
 * in lib/gemini/client-logic.ts (covered by __tests__/gemini/client.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertProjectId,
  getBucketName,
  buildGcsPath,
  mergeUploadMetadata,
  DEFAULT_BUCKET_NAME,
  DEFAULT_UPLOAD_CACHE_CONTROL,
  MISSING_PROJECT_ID_ERROR,
  STORAGE_INIT_ERROR,
} from "@/lib/storage/gcp-client-logic";

describe("GCP Cloud Storage Client Logic", () => {
  // -- assertProjectId --
  describe("assertProjectId", () => {
    it("does not throw for a valid project ID", () => {
      assert.doesNotThrow(() => assertProjectId("my-gcp-project"));
      assert.doesNotThrow(() => assertProjectId("stockbook-prod-12345"));
    });

    it("throws for undefined", () => {
      assert.throws(() => assertProjectId(undefined), /GCP_PROJECT_ID/);
    });

    it("throws for empty string", () => {
      assert.throws(() => assertProjectId(""));
    });

    it("throws the exact MISSING_PROJECT_ID_ERROR with a .env hint", () => {
      assert.throws(
        () => assertProjectId(undefined),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.strictEqual(err.message, MISSING_PROJECT_ID_ERROR);
          assert.ok(err.message.includes("GCP_PROJECT_ID"));
          assert.ok(err.message.includes(".env"));
          return true;
        }
      );
    });
  });

  // -- getBucketName --
  describe("getBucketName", () => {
    it("returns the env bucket name when provided", () => {
      assert.strictEqual(getBucketName("my-custom-bucket"), "my-custom-bucket");
    });

    it("falls back to DEFAULT_BUCKET_NAME for undefined / empty", () => {
      assert.strictEqual(getBucketName(undefined), DEFAULT_BUCKET_NAME);
      assert.strictEqual(getBucketName(""), DEFAULT_BUCKET_NAME);
      assert.strictEqual(DEFAULT_BUCKET_NAME, "stockbook-learning-content");
    });
  });

  // -- STORAGE_INIT_ERROR (real init-failure message) --
  describe("STORAGE_INIT_ERROR", () => {
    it("is the user-safe init-failure message (no raw detail leaked)", () => {
      assert.strictEqual(
        STORAGE_INIT_ERROR,
        "Failed to initialize storage service"
      );
    });
  });

  // -- buildGcsPath --
  describe("buildGcsPath", () => {
    it("builds a gs:// URI from bucket + path", () => {
      assert.strictEqual(
        buildGcsPath("my-bucket", "lessons/123/video.mp4"),
        "gs://my-bucket/lessons/123/video.mp4"
      );
    });

    it("handles root-level and deeply-nested paths", () => {
      assert.strictEqual(
        buildGcsPath("bucket", "file.txt"),
        "gs://bucket/file.txt"
      );
      assert.strictEqual(
        buildGcsPath("bkt", "a/b/c/d.txt"),
        "gs://bkt/a/b/c/d.txt"
      );
    });
  });

  // -- mergeUploadMetadata + DEFAULT_UPLOAD_CACHE_CONTROL --
  describe("mergeUploadMetadata", () => {
    it("includes the default cacheControl when no custom metadata", () => {
      assert.strictEqual(
        mergeUploadMetadata().cacheControl,
        DEFAULT_UPLOAD_CACHE_CONTROL
      );
      assert.strictEqual(
        mergeUploadMetadata(undefined).cacheControl,
        "private, max-age=3600"
      );
    });

    it("merges custom metadata over the default", () => {
      const out = mergeUploadMetadata({ author: "test-user" });
      assert.strictEqual(out.cacheControl, DEFAULT_UPLOAD_CACHE_CONTROL);
      assert.strictEqual(out.author, "test-user");
    });

    it("lets a custom cacheControl override the default", () => {
      assert.strictEqual(
        mergeUploadMetadata({ cacheControl: "no-store" }).cacheControl,
        "no-store"
      );
    });

    it("DEFAULT_UPLOAD_CACHE_CONTROL is private + 1-hour max-age", () => {
      assert.ok(DEFAULT_UPLOAD_CACHE_CONTROL.includes("private"));
      assert.ok(DEFAULT_UPLOAD_CACHE_CONTROL.includes("max-age=3600"));
    });
  });
});
