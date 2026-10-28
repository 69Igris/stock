/**
 * Storage Stream API Route - Extended CONTRACT tests.
 *
 * Deep, adversarial coverage of the security-critical routing helpers the
 * GET/HEAD /api/storage/stream/[...path] handlers call. These now import the
 * REAL exported symbols from
 * `@/app/api/storage/stream/[...path]/route-logic` (the same module the route
 * itself imports) instead of re-declaring inline copies.
 *
 * This file was previously a SHADOW: it reimplemented `isValidContentPath`,
 * `getContentType`, `shouldRedirect`, `shouldProxy`, `parseRangeHeader`, and
 * `hasFeatureAccess` inline and asserted the copies. The copies had drifted
 * from the source and were GREEN while asserting the WRONG behavior:
 *
 *   1. The inline `isValidContentPath` omitted the `documents/` allow-prefix,
 *      so it claimed real document paths (`documents/<uid>/report.pdf`) were
 *      INVALID — they are valid in the route, which serves user documents via
 *      ownership checks. A refactor "to match the test" would have 400'd every
 *      document download.
 *   2. The inline `hasFeatureAccess` granted **PRO** access to
 *      `learningContent` (`planId === "PRO"` → true). The REAL gate
 *      (`@usemoney/core/subscription`, re-exported by route-logic) returns
 *      FALSE for PRO — only PREMIUM/ULTIMATE get learning content. The shadow
 *      was a green test asserting a FALSE authorization claim; trusting it
 *      would have leaked PREMIUM learning content to the PRO tier.
 *
 * Both gaps are encoded below as regression assertions against the real
 * exports.
 *
 * Source: apps/web/app/api/storage/stream/[...path]/route.ts
 *         apps/web/app/api/storage/stream/[...path]/route-logic.ts
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
  CONTENT_TYPES,
  REDIRECT_EXTENSIONS,
  PROXY_EXTENSIONS,
} from "@/app/api/storage/stream/[...path]/route-logic";

describe("Storage Stream - Extended (real route-logic)", () => {
  // -- Path validation: exhaustive --

  describe("Path validation - exhaustive", () => {
    it("should accept lessons/ prefix with simple file", () => {
      assert.strictEqual(isValidContentPath("lessons/video.mp4"), true);
    });

    it("should accept generated/ prefix with simple file", () => {
      assert.strictEqual(isValidContentPath("generated/doc.pdf"), true);
    });

    // REGRESSION (shadow bug #1): the inline copy omitted documents/ and would
    // have rejected this. The real route serves user documents from this prefix.
    it("should accept documents/ prefix (real source allows it)", () => {
      assert.strictEqual(
        isValidContentPath("documents/user_1/report.pdf"),
        true
      );
    });

    it("should accept deeply nested lessons path", () => {
      assert.strictEqual(isValidContentPath("lessons/a/b/c/d/e/f/g.mp4"), true);
    });

    it("should accept deeply nested generated path", () => {
      assert.strictEqual(isValidContentPath("generated/a/b/c.pdf"), true);
    });

    it("should reject path starting with /", () => {
      assert.strictEqual(isValidContentPath("/lessons/video.mp4"), false);
    });

    it("should reject path starting with ../", () => {
      assert.strictEqual(isValidContentPath("../lessons/video.mp4"), false);
    });

    it("should reject path with .. in middle (traversal)", () => {
      assert.strictEqual(
        isValidContentPath("lessons/../../../etc/passwd"),
        false
      );
    });

    it("should reject documents/ traversal to another user", () => {
      assert.strictEqual(
        isValidContentPath("documents/../lessons/secret.mp4"),
        false
      );
    });

    it("should reject path with // anywhere", () => {
      assert.strictEqual(
        isValidContentPath("lessons//hidden/video.mp4"),
        false
      );
    });

    it("should reject path with // at end", () => {
      assert.strictEqual(isValidContentPath("lessons/video//"), false);
    });

    it("should reject empty string", () => {
      assert.strictEqual(isValidContentPath(""), false);
    });

    it("should reject just 'lessons' without slash", () => {
      assert.strictEqual(isValidContentPath("lessons"), false);
    });

    it("should accept 'lessons/' with trailing slash", () => {
      assert.strictEqual(isValidContentPath("lessons/"), true);
    });

    it("should reject paths starting with other prefixes", () => {
      const badPrefixes = [
        "admin/config.json",
        "public/image.png",
        "private/data.csv",
        "uploads/file.pdf",
        "src/code.ts",
      ];
      for (const path of badPrefixes) {
        assert.strictEqual(
          isValidContentPath(path),
          false,
          `Should reject: ${path}`
        );
      }
    });

    it("should reject path with .. after valid prefix", () => {
      assert.strictEqual(
        isValidContentPath("lessons/abc/../secret.mp4"),
        false
      );
    });

    it("should reject path with only ..", () => {
      assert.strictEqual(isValidContentPath(".."), false);
    });

    it("should accept path with dots in filename (not ..)", () => {
      assert.strictEqual(isValidContentPath("lessons/file.v2.mp4"), true);
    });

    it("should accept path with single dot in name", () => {
      assert.strictEqual(isValidContentPath("lessons/./file.mp4"), true);
    });
  });

  // -- Document ownership routing (the IDOR-relevant helpers) --

  describe("Document ownership parsing", () => {
    it("isDocumentPath is true only for the documents/ prefix", () => {
      assert.strictEqual(isDocumentPath("documents/u1/a.pdf"), true);
      assert.strictEqual(isDocumentPath("lessons/u1/a.pdf"), false);
      assert.strictEqual(isDocumentPath("generated/u1/a.pdf"), false);
    });

    it("extractDocumentUserId returns the 2nd path segment", () => {
      assert.strictEqual(
        extractDocumentUserId("documents/user_42/report.pdf"),
        "user_42"
      );
    });

    it("extractDocumentUserId on a nested path still returns the owner", () => {
      assert.strictEqual(
        extractDocumentUserId("documents/user_42/sub/dir/report.pdf"),
        "user_42"
      );
    });

    it("extractDocumentUserId returns null when there is no owner segment", () => {
      assert.strictEqual(extractDocumentUserId("documents/"), null);
    });

    it("a foreign owner segment is NOT the requesting user (IDOR guard input)", () => {
      // The route compares extractDocumentUserId(path) !== user.id and 403s.
      const owner = extractDocumentUserId("documents/victim_user/secret.pdf");
      assert.strictEqual(owner, "victim_user");
      assert.notStrictEqual(owner, "attacker_user");
    });
  });

  // -- Content type detection: all extensions --

  describe("Content type - all extensions", () => {
    const extensionTests: [string, string][] = [
      ["video/index.m3u8", "application/vnd.apple.mpegurl"],
      ["video/segment.ts", "video/mp2t"],
      ["video/main.mp4", "video/mp4"],
      ["audio/track.mp3", "audio/mpeg"],
      ["audio/track.m4a", "audio/mp4"],
      ["audio/track.aac", "audio/aac"],
      ["audio/track.wav", "audio/wav"],
      ["docs/slides.pdf", "application/pdf"],
      ["img/photo.jpg", "image/jpeg"],
      ["img/photo.jpeg", "image/jpeg"],
      ["img/diagram.png", "image/png"],
      ["img/modern.webp", "image/webp"],
      ["img/anim.gif", "image/gif"],
      ["img/icon.svg", "image/svg+xml"],
    ];

    for (const [path, expectedType] of extensionTests) {
      it(`should detect ${path} as ${expectedType}`, () => {
        assert.strictEqual(getContentType(path), expectedType);
      });
    }

    it("should default to octet-stream for .txt", () => {
      assert.strictEqual(
        getContentType("readme.txt"),
        "application/octet-stream"
      );
    });

    it("should default to octet-stream for .zip", () => {
      assert.strictEqual(
        getContentType("archive.zip"),
        "application/octet-stream"
      );
    });

    it("should default to octet-stream for no extension", () => {
      assert.strictEqual(
        getContentType("filename"),
        "application/octet-stream"
      );
    });

    it("should handle UPPERCASE extension via toLowerCase", () => {
      assert.strictEqual(
        getContentType("VIDEO/INDEX.M3U8"),
        "application/vnd.apple.mpegurl"
      );
    });

    it("should handle mixed case extension", () => {
      assert.strictEqual(getContentType("file.Mp4"), "video/mp4");
    });

    it("should handle file with multiple dots", () => {
      assert.strictEqual(
        getContentType("lessons/file.backup.mp3"),
        "audio/mpeg"
      );
    });
  });

  // -- Redirect vs Proxy: comprehensive --

  describe("Redirect vs Proxy - comprehensive", () => {
    describe("Redirect extensions", () => {
      it(".m3u8 should redirect", () => {
        assert.strictEqual(shouldRedirect("a.m3u8"), true);
        assert.strictEqual(shouldProxy("a.m3u8"), false);
      });

      it(".ts should redirect", () => {
        assert.strictEqual(shouldRedirect("a.ts"), true);
        assert.strictEqual(shouldProxy("a.ts"), false);
      });
    });

    describe("Proxy extensions", () => {
      const proxyExts = [
        ".mp3",
        ".m4a",
        ".aac",
        ".wav",
        ".pdf",
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".gif",
        ".svg",
        ".mp4",
      ];

      for (const ext of proxyExts) {
        it(`${ext} should proxy and not redirect`, () => {
          assert.strictEqual(shouldProxy(`file${ext}`), true);
          assert.strictEqual(shouldRedirect(`file${ext}`), false);
        });
      }
    });

    describe("Unknown extensions", () => {
      it(".txt should neither redirect nor proxy", () => {
        assert.strictEqual(shouldRedirect("file.txt"), false);
        assert.strictEqual(shouldProxy("file.txt"), false);
      });

      it(".zip should neither redirect nor proxy", () => {
        assert.strictEqual(shouldRedirect("file.zip"), false);
        assert.strictEqual(shouldProxy("file.zip"), false);
      });
    });
  });

  // -- Range header parsing: edge cases --

  describe("Range header parsing - edge cases", () => {
    it("should parse standard range", () => {
      const result = parseRangeHeader("bytes=0-1023", 10000);
      assert.deepStrictEqual(result, { start: 0, end: 1023 });
    });

    it("should parse open-ended range (clamps to contentLength-1)", () => {
      const result = parseRangeHeader("bytes=500-", 10000);
      assert.deepStrictEqual(result, { start: 500, end: 9999 });
    });

    it("should return null for null header", () => {
      assert.strictEqual(parseRangeHeader(null, 10000), null);
    });

    it("should return null for 'invalid'", () => {
      assert.strictEqual(parseRangeHeader("invalid", 10000), null);
    });

    it("should return null for 'pages=1-5'", () => {
      assert.strictEqual(parseRangeHeader("pages=1-5", 10000), null);
    });

    it("should parse range starting at 0", () => {
      const result = parseRangeHeader("bytes=0-0", 100);
      assert.deepStrictEqual(result, { start: 0, end: 0 });
    });

    it("should parse range for entire file", () => {
      const result = parseRangeHeader("bytes=0-99", 100);
      assert.deepStrictEqual(result, { start: 0, end: 99 });
    });

    it("should parse range beyond file size (parser does not clamp the end)", () => {
      const result = parseRangeHeader("bytes=0-999999", 100);
      assert.deepStrictEqual(result, { start: 0, end: 999999 });
    });

    it("should handle large file sizes", () => {
      const result = parseRangeHeader("bytes=0-", 5_000_000_000);
      assert.deepStrictEqual(result, { start: 0, end: 4_999_999_999 });
    });

    it("should handle high start offset", () => {
      const result = parseRangeHeader("bytes=9000-9999", 10000);
      assert.deepStrictEqual(result, { start: 9000, end: 9999 });
    });
  });

  // -- Subscription feature access (REAL gate) --

  describe("Subscription feature access - real @usemoney/core/subscription", () => {
    it("PREMIUM should have learningContent access", () => {
      assert.strictEqual(hasFeatureAccess("PREMIUM", "learningContent"), true);
    });

    it("ULTIMATE should have learningContent access", () => {
      assert.strictEqual(hasFeatureAccess("ULTIMATE", "learningContent"), true);
    });

    // REGRESSION (shadow bug #2): the inline copy returned TRUE for PRO. The
    // REAL gate denies PRO. Pin the real contract so a future edit can't quietly
    // grant PRO the PREMIUM learning library.
    it("PRO should NOT have learningContent access (real gate denies it)", () => {
      assert.strictEqual(hasFeatureAccess("PRO", "learningContent"), false);
    });

    it("FREE should NOT have learningContent access", () => {
      assert.strictEqual(hasFeatureAccess("FREE", "learningContent"), false);
    });

    it("empty plan should NOT have access", () => {
      assert.strictEqual(hasFeatureAccess("", "learningContent"), false);
    });

    it("unknown plan should NOT have access", () => {
      assert.strictEqual(hasFeatureAccess("TRIAL", "learningContent"), false);
    });
  });

  // -- Map completeness (real exported tables) --

  describe("CONTENT_TYPES / extension tables", () => {
    it("CONTENT_TYPES has the 14 supported extensions", () => {
      assert.strictEqual(Object.keys(CONTENT_TYPES).length, 14);
    });

    it(".jpg and .jpeg both map to image/jpeg; others are unique", () => {
      const values = Object.values(CONTENT_TYPES);
      const withoutJpeg = values.filter((v) => v !== "image/jpeg");
      const uniqueWithoutJpeg = new Set(withoutJpeg);
      assert.strictEqual(withoutJpeg.length, uniqueWithoutJpeg.size);
    });

    it("REDIRECT_EXTENSIONS is a subset of CONTENT_TYPES keys", () => {
      for (const ext of REDIRECT_EXTENSIONS) {
        assert.ok(
          CONTENT_TYPES[ext] !== undefined,
          `Redirect ext ${ext} missing from CONTENT_TYPES`
        );
      }
    });

    it("PROXY_EXTENSIONS is a subset of CONTENT_TYPES keys", () => {
      for (const ext of PROXY_EXTENSIONS) {
        assert.ok(
          CONTENT_TYPES[ext] !== undefined,
          `Proxy ext ${ext} missing from CONTENT_TYPES`
        );
      }
    });

    it("REDIRECT and PROXY extensions do not overlap", () => {
      for (const ext of REDIRECT_EXTENSIONS) {
        assert.ok(
          !PROXY_EXTENSIONS.includes(ext),
          `Extension ${ext} should not be in both REDIRECT and PROXY`
        );
      }
    });
  });
});
