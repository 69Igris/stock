/**
 * Storage Stream route CONTRACT test.
 *
 * Exercises the REAL exported symbols the GET/HEAD
 * /api/storage/stream/[...path] handlers call (from
 * `@/app/api/storage/stream/[...path]/route-logic`):
 *   - `isValidContentPath` — lessons/ | generated/ | documents/ allowlist +
 *     `..` / `//` traversal guard.
 *   - `isDocumentPath` / `extractDocumentUserId` — document ownership routing.
 *   - `getContentType` / `shouldRedirect` / `shouldProxy` — media routing.
 *   - `parseRangeHeader` — HTTP Range byte-bounds parse.
 *   - `hasFeatureAccess` (re-exported from @usemoney/core/subscription) — the
 *     learning-content subscription gate (PREMIUM/ULTIMATE only; PRO does NOT
 *     get learningContent).
 *
 * (Replaces the previous shadow version, whose `isValidContentPath` was stale —
 * it omitted the documents/ branch — and whose `hasFeatureAccess` copy wrongly
 * granted PRO access to learningContent.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isValidContentPath,
  isDocumentPath,
  extractDocumentUserId,
  getContentType,
  shouldRedirect,
  shouldProxy,
  parseRangeHeader,
  hasFeatureAccess,
} from "@/app/api/storage/stream/[...path]/route-logic";

describe("Storage Stream route", () => {
  describe("isValidContentPath", () => {
    it("accepts paths starting with lessons/", () => {
      assert.strictEqual(
        isValidContentPath("lessons/abc123/video/index.m3u8"),
        true
      );
    });

    it("accepts paths starting with generated/", () => {
      assert.strictEqual(
        isValidContentPath("generated/slides/slide1.jpg"),
        true
      );
    });

    it("accepts paths starting with documents/", () => {
      assert.strictEqual(
        isValidContentPath("documents/user_1/report.pdf"),
        true
      );
    });

    it("rejects paths not starting with an allowed prefix", () => {
      assert.strictEqual(isValidContentPath("other/path/file.mp4"), false);
    });

    it("rejects path traversal with ..", () => {
      assert.strictEqual(
        isValidContentPath("lessons/../../../etc/passwd"),
        false
      );
    });

    it("rejects double slashes", () => {
      assert.strictEqual(isValidContentPath("lessons//hidden/file.mp4"), false);
    });

    it("rejects an empty path", () => {
      assert.strictEqual(isValidContentPath(""), false);
    });

    it("rejects an admin path", () => {
      assert.strictEqual(isValidContentPath("admin/page"), false);
    });

    it("accepts a deeply nested lesson path", () => {
      assert.strictEqual(
        isValidContentPath("lessons/course1/module2/lesson3/video/segment0.ts"),
        true
      );
    });

    it("rejects .. in the middle of an otherwise-valid path", () => {
      assert.strictEqual(
        isValidContentPath("lessons/abc/../secret/file.mp4"),
        false
      );
    });
  });

  describe("isDocumentPath / extractDocumentUserId", () => {
    it("flags a documents/ path", () => {
      assert.strictEqual(isDocumentPath("documents/user_1/file.pdf"), true);
    });

    it("does not flag a lessons/ path", () => {
      assert.strictEqual(isDocumentPath("lessons/abc/file.pdf"), false);
    });

    it("extracts the owning userId from a document path", () => {
      assert.strictEqual(
        extractDocumentUserId("documents/user_42/reports/q1.pdf"),
        "user_42"
      );
    });

    it("returns null when there is no userId segment", () => {
      assert.strictEqual(extractDocumentUserId("documents"), null);
    });

    it("returns null for an empty userId segment", () => {
      assert.strictEqual(extractDocumentUserId("documents//file.pdf"), null);
    });
  });

  describe("getContentType", () => {
    it("detects the HLS manifest", () => {
      assert.strictEqual(
        getContentType("video/index.m3u8"),
        "application/vnd.apple.mpegurl"
      );
    });

    it("detects an HLS segment", () => {
      assert.strictEqual(getContentType("video/segment0.ts"), "video/mp2t");
    });

    it("detects MP4", () => {
      assert.strictEqual(getContentType("video/main.mp4"), "video/mp4");
    });

    it("detects MP3", () => {
      assert.strictEqual(getContentType("audio/track.mp3"), "audio/mpeg");
    });

    it("detects PDF", () => {
      assert.strictEqual(getContentType("docs/slides.pdf"), "application/pdf");
    });

    it("detects JPEG (both extensions)", () => {
      assert.strictEqual(getContentType("img/photo.jpg"), "image/jpeg");
      assert.strictEqual(getContentType("img/photo.jpeg"), "image/jpeg");
    });

    it("detects PNG", () => {
      assert.strictEqual(getContentType("img/diagram.png"), "image/png");
    });

    it("detects WebP", () => {
      assert.strictEqual(getContentType("img/modern.webp"), "image/webp");
    });

    it("detects SVG", () => {
      assert.strictEqual(getContentType("img/icon.svg"), "image/svg+xml");
    });

    it("defaults to octet-stream for unknown extensions", () => {
      assert.strictEqual(
        getContentType("file.xyz"),
        "application/octet-stream"
      );
    });

    it("is case-insensitive on the extension", () => {
      assert.strictEqual(
        getContentType("video/INDEX.M3U8"),
        "application/vnd.apple.mpegurl"
      );
    });
  });

  describe("shouldRedirect / shouldProxy", () => {
    it("redirects .m3u8 files", () => {
      assert.strictEqual(shouldRedirect("video/index.m3u8"), true);
    });

    it("redirects .ts files", () => {
      assert.strictEqual(shouldRedirect("video/segment0.ts"), true);
    });

    it("does not redirect .mp3 files", () => {
      assert.strictEqual(shouldRedirect("audio/track.mp3"), false);
    });

    it("proxies .mp3 files", () => {
      assert.strictEqual(shouldProxy("audio/track.mp3"), true);
    });

    it("proxies .pdf files", () => {
      assert.strictEqual(shouldProxy("docs/slides.pdf"), true);
    });

    it("proxies .jpg files", () => {
      assert.strictEqual(shouldProxy("img/photo.jpg"), true);
    });

    it("proxies .mp4 files", () => {
      assert.strictEqual(shouldProxy("video/main.mp4"), true);
    });

    it("does not proxy .m3u8 files (those redirect)", () => {
      assert.strictEqual(shouldProxy("video/index.m3u8"), false);
    });

    it("does not redirect .pdf files", () => {
      assert.strictEqual(shouldRedirect("docs/slides.pdf"), false);
    });
  });

  describe("parseRangeHeader", () => {
    it("parses a range with start and end", () => {
      assert.deepStrictEqual(parseRangeHeader("bytes=0-1023", 10000), {
        start: 0,
        end: 1023,
      });
    });

    it("parses an open-ended range (clamps to length - 1)", () => {
      assert.deepStrictEqual(parseRangeHeader("bytes=500-", 10000), {
        start: 500,
        end: 9999,
      });
    });

    it("returns null for a null header", () => {
      assert.strictEqual(parseRangeHeader(null, 10000), null);
    });

    it("returns null for an invalid format", () => {
      assert.strictEqual(parseRangeHeader("invalid", 10000), null);
    });

    it("handles large file sizes", () => {
      assert.deepStrictEqual(parseRangeHeader("bytes=0-", 100000000), {
        start: 0,
        end: 99999999,
      });
    });
  });

  describe("hasFeatureAccess (real @usemoney/core gate)", () => {
    it("grants learningContent for PREMIUM", () => {
      assert.strictEqual(hasFeatureAccess("PREMIUM", "learningContent"), true);
    });

    it("grants learningContent for ULTIMATE", () => {
      assert.strictEqual(hasFeatureAccess("ULTIMATE", "learningContent"), true);
    });

    it("denies learningContent for PRO (PREMIUM+ only)", () => {
      assert.strictEqual(hasFeatureAccess("PRO", "learningContent"), false);
    });

    it("denies learningContent for FREE", () => {
      assert.strictEqual(hasFeatureAccess("FREE", "learningContent"), false);
    });

    it("denies an unknown plan", () => {
      assert.strictEqual(
        hasFeatureAccess("NONEXISTENT", "learningContent"),
        false
      );
    });
  });
});
