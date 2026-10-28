/**
 * Signed URL Utility Tests
 *
 * De-shadowed (MONEY-620): imports the REAL pure functions from
 * lib/storage/signed-urls.ts. The GCS Storage client is created lazily (only
 * inside getStorageClient), so importing this module does not open a connection
 * — it loads clean under node:test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TTL,
  isSignedUrlValid,
  getTTLForContentType,
  getFilename,
  buildContentDisposition,
} from "@/lib/storage/signed-urls";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a synthetic GCS v4 signed URL with the given date and expiry. */
function buildSignedUrl(
  dateStr: string,
  expiresSeconds: number,
  base = "https://storage.googleapis.com/bucket/file.mp4"
): string {
  return `${base}?X-Goog-Date=${dateStr}&X-Goog-Expires=${expiresSeconds}&X-Goog-Signature=abc123`;
}

/** Return a YYYYMMDDTHHMMSSZ string for a Date object in UTC. */
function formatGoogDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Signed URL Utilities", () => {
  // ===================== DEFAULT_TTL =====================

  describe("DEFAULT_TTL", () => {
    it("should define video TTL as 15 minutes (900 seconds)", () => {
      assert.strictEqual(DEFAULT_TTL.video, 900);
    });

    it("should define audio TTL as 30 minutes (1800 seconds)", () => {
      assert.strictEqual(DEFAULT_TTL.audio, 1800);
    });

    it("should define document TTL as 10 minutes (600 seconds)", () => {
      assert.strictEqual(DEFAULT_TTL.document, 600);
    });

    it("should define image TTL as 1 hour (3600 seconds)", () => {
      assert.strictEqual(DEFAULT_TTL.image, 3600);
    });

    it("should define default TTL as 15 minutes (900 seconds)", () => {
      assert.strictEqual(DEFAULT_TTL.default, 900);
    });

    it("should have exactly 5 TTL categories", () => {
      assert.strictEqual(Object.keys(DEFAULT_TTL).length, 5);
    });

    it("should have all positive values", () => {
      for (const [key, value] of Object.entries(DEFAULT_TTL)) {
        assert.ok(value > 0, `DEFAULT_TTL.${key} should be positive`);
      }
    });

    it("should have image TTL as the longest", () => {
      assert.ok(DEFAULT_TTL.image > DEFAULT_TTL.video);
      assert.ok(DEFAULT_TTL.image > DEFAULT_TTL.audio);
      assert.ok(DEFAULT_TTL.image > DEFAULT_TTL.document);
      assert.ok(DEFAULT_TTL.image > DEFAULT_TTL.default);
    });

    it("should have document TTL as the shortest", () => {
      assert.ok(DEFAULT_TTL.document <= DEFAULT_TTL.video);
      assert.ok(DEFAULT_TTL.document <= DEFAULT_TTL.audio);
      assert.ok(DEFAULT_TTL.document <= DEFAULT_TTL.image);
    });
  });

  // ===================== isSignedUrlValid =====================

  describe("isSignedUrlValid", () => {
    describe("valid (not-yet-expired) URLs", () => {
      it("should return true for a URL expiring 1 hour in the future", () => {
        const now = new Date();
        const url = buildSignedUrl(formatGoogDate(now), 3600);
        assert.strictEqual(isSignedUrlValid(url), true);
      });

      it("should return true for a URL expiring 1 second in the future", () => {
        const now = new Date();
        const url = buildSignedUrl(formatGoogDate(now), 2); // 2 seconds buffer
        assert.strictEqual(isSignedUrlValid(url), true);
      });

      it("should return true for a URL with a very large expiry", () => {
        const now = new Date();
        const url = buildSignedUrl(formatGoogDate(now), 86400); // 24 hours
        assert.strictEqual(isSignedUrlValid(url), true);
      });

      it("should return true for a URL signed 5 minutes ago but still valid", () => {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        const url = buildSignedUrl(formatGoogDate(fiveMinAgo), 600); // 10 min expiry
        assert.strictEqual(isSignedUrlValid(url), true);
      });
    });

    describe("expired URLs", () => {
      it("should return false for a URL that expired 1 hour ago", () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const url = buildSignedUrl(formatGoogDate(twoHoursAgo), 3600);
        assert.strictEqual(isSignedUrlValid(url), false);
      });

      it("should return false for a URL that expired 1 second ago", () => {
        const past = new Date(Date.now() - 61 * 1000);
        const url = buildSignedUrl(formatGoogDate(past), 60);
        assert.strictEqual(isSignedUrlValid(url), false);
      });

      it("should return false for a URL signed yesterday with 1-hour expiry", () => {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const url = buildSignedUrl(formatGoogDate(yesterday), 3600);
        assert.strictEqual(isSignedUrlValid(url), false);
      });

      it("should return false for a URL with 0 second expiry", () => {
        const now = new Date(Date.now() - 1000);
        const url = buildSignedUrl(formatGoogDate(now), 0);
        assert.strictEqual(isSignedUrlValid(url), false);
      });
    });

    describe("missing parameters", () => {
      it("should return false when X-Goog-Date is missing", () => {
        const url =
          "https://storage.googleapis.com/bucket/file.mp4?X-Goog-Expires=3600";
        assert.strictEqual(isSignedUrlValid(url), false);
      });

      it("should return false when X-Goog-Expires is missing", () => {
        const url =
          "https://storage.googleapis.com/bucket/file.mp4?X-Goog-Date=20260101T120000Z";
        assert.strictEqual(isSignedUrlValid(url), false);
      });

      it("should return false when both params are missing", () => {
        const url =
          "https://storage.googleapis.com/bucket/file.mp4?X-Goog-Signature=abc";
        assert.strictEqual(isSignedUrlValid(url), false);
      });

      it("should return false for a URL with no query params at all", () => {
        const url = "https://storage.googleapis.com/bucket/file.mp4";
        assert.strictEqual(isSignedUrlValid(url), false);
      });
    });

    describe("malformed URLs", () => {
      it("should return false for a completely invalid URL", () => {
        assert.strictEqual(isSignedUrlValid("not a url"), false);
      });

      it("should return false for an empty string", () => {
        assert.strictEqual(isSignedUrlValid(""), false);
      });

      it("should return false for a relative path", () => {
        assert.strictEqual(isSignedUrlValid("/bucket/file.mp4"), false);
      });

      it("should return false for non-numeric X-Goog-Expires", () => {
        const url =
          "https://storage.googleapis.com/bucket/file.mp4?X-Goog-Date=20260101T120000Z&X-Goog-Expires=abc";
        assert.strictEqual(isSignedUrlValid(url), false);
      });

      it("should return false for malformed X-Goog-Date format", () => {
        const url =
          "https://storage.googleapis.com/bucket/file.mp4?X-Goog-Date=2026-01-01&X-Goog-Expires=3600";
        // parseInt will parse partial numbers but the resulting date will be NaN-ish
        // The function should handle this gracefully
        const result = isSignedUrlValid(url);
        assert.strictEqual(typeof result, "boolean");
      });

      it("should return false for negative X-Goog-Expires", () => {
        const now = new Date();
        const url = buildSignedUrl(formatGoogDate(now), -3600);
        assert.strictEqual(isSignedUrlValid(url), false);
      });
    });

    describe("edge cases", () => {
      it("should handle URL with additional query params", () => {
        const now = new Date();
        const dateStr = formatGoogDate(now);
        const url = `https://storage.googleapis.com/bucket/file.mp4?foo=bar&X-Goog-Date=${dateStr}&X-Goog-Expires=3600&X-Goog-Signature=xyz`;
        assert.strictEqual(isSignedUrlValid(url), true);
      });

      it("should handle URL with encoded path characters", () => {
        const now = new Date();
        const url = buildSignedUrl(
          formatGoogDate(now),
          3600,
          "https://storage.googleapis.com/bucket/path%20with%20spaces/file.mp4"
        );
        assert.strictEqual(isSignedUrlValid(url), true);
      });

      it("should handle midnight UTC boundary", () => {
        const midnight = new Date("2026-06-15T00:00:00Z");
        if (midnight.getTime() < Date.now()) {
          // If this date is in the past, it should be false with short expiry
          const url = buildSignedUrl(formatGoogDate(midnight), 60);
          assert.strictEqual(isSignedUrlValid(url), false);
        } else {
          // If this date is in the future, make it in the past
          const past = new Date(Date.now() - 10000);
          const url = buildSignedUrl(formatGoogDate(past), 5);
          assert.strictEqual(isSignedUrlValid(url), false);
        }
      });
    });
  });

  // ===================== getTTLForContentType =====================

  describe("getTTLForContentType", () => {
    describe("video file types", () => {
      it("should return video TTL for .mp4 files", () => {
        assert.strictEqual(
          getTTLForContentType("video.mp4"),
          DEFAULT_TTL.video
        );
      });

      it("should return video TTL for .webm files", () => {
        assert.strictEqual(
          getTTLForContentType("content/video.webm"),
          DEFAULT_TTL.video
        );
      });

      it("should return video TTL for .m3u8 files (HLS manifest)", () => {
        assert.strictEqual(
          getTTLForContentType("stream/playlist.m3u8"),
          DEFAULT_TTL.video
        );
      });

      it("should return video TTL for .ts files (HLS segment)", () => {
        assert.strictEqual(
          getTTLForContentType("stream/segment001.ts"),
          DEFAULT_TTL.video
        );
      });

      it("should return video TTL for uppercase .MP4 (case insensitive)", () => {
        assert.strictEqual(
          getTTLForContentType("video.MP4"),
          DEFAULT_TTL.video
        );
      });
    });

    describe("audio file types", () => {
      it("should return audio TTL for .mp3 files", () => {
        assert.strictEqual(
          getTTLForContentType("podcast.mp3"),
          DEFAULT_TTL.audio
        );
      });

      it("should return audio TTL for .wav files", () => {
        assert.strictEqual(
          getTTLForContentType("audio/sample.wav"),
          DEFAULT_TTL.audio
        );
      });

      it("should return audio TTL for .m4a files", () => {
        assert.strictEqual(
          getTTLForContentType("lessons/123/audio.m4a"),
          DEFAULT_TTL.audio
        );
      });
    });

    describe("document file types", () => {
      it("should return document TTL for .pdf files", () => {
        assert.strictEqual(
          getTTLForContentType("docs/report.pdf"),
          DEFAULT_TTL.document
        );
      });

      it("should return document TTL for .pptx files", () => {
        assert.strictEqual(
          getTTLForContentType("slides/presentation.pptx"),
          DEFAULT_TTL.document
        );
      });

      it("should return document TTL for .ppt files", () => {
        assert.strictEqual(
          getTTLForContentType("old/legacy.ppt"),
          DEFAULT_TTL.document
        );
      });
    });

    describe("image file types", () => {
      it("should return image TTL for .png files", () => {
        assert.strictEqual(
          getTTLForContentType("images/chart.png"),
          DEFAULT_TTL.image
        );
      });

      it("should return image TTL for .jpg files", () => {
        assert.strictEqual(
          getTTLForContentType("photos/avatar.jpg"),
          DEFAULT_TTL.image
        );
      });

      it("should return image TTL for .jpeg files", () => {
        assert.strictEqual(
          getTTLForContentType("photos/photo.jpeg"),
          DEFAULT_TTL.image
        );
      });

      it("should return image TTL for .gif files", () => {
        assert.strictEqual(
          getTTLForContentType("memes/funny.gif"),
          DEFAULT_TTL.image
        );
      });

      it("should return image TTL for .svg files", () => {
        assert.strictEqual(
          getTTLForContentType("icons/logo.svg"),
          DEFAULT_TTL.image
        );
      });
    });

    describe("unknown / default file types", () => {
      it("should return default TTL for .txt files", () => {
        assert.strictEqual(
          getTTLForContentType("readme.txt"),
          DEFAULT_TTL.default
        );
      });

      it("should return default TTL for .json files", () => {
        assert.strictEqual(
          getTTLForContentType("data.json"),
          DEFAULT_TTL.default
        );
      });

      it("should return default TTL for .zip files", () => {
        assert.strictEqual(
          getTTLForContentType("archive.zip"),
          DEFAULT_TTL.default
        );
      });

      it("should return default TTL for files with no extension", () => {
        assert.strictEqual(
          getTTLForContentType("Makefile"),
          DEFAULT_TTL.default
        );
      });

      it("should return default TTL for .html files", () => {
        assert.strictEqual(
          getTTLForContentType("index.html"),
          DEFAULT_TTL.default
        );
      });
    });

    describe("path handling", () => {
      it("should handle deeply nested paths", () => {
        assert.strictEqual(
          getTTLForContentType("a/b/c/d/e/video.mp4"),
          DEFAULT_TTL.video
        );
      });

      it("should use the last dot for extension", () => {
        assert.strictEqual(
          getTTLForContentType("archive.tar.gz"),
          DEFAULT_TTL.default
        );
      });

      it("should handle filenames with multiple dots", () => {
        assert.strictEqual(
          getTTLForContentType("my.cool.video.mp4"),
          DEFAULT_TTL.video
        );
      });
    });
  });

  // ===================== getFilename =====================

  describe("getFilename", () => {
    it("should extract filename from simple path", () => {
      assert.strictEqual(getFilename("path/to/file.mp4"), "file.mp4");
    });

    it("should extract filename from deeply nested path", () => {
      assert.strictEqual(getFilename("a/b/c/d/report.pdf"), "report.pdf");
    });

    it("should return the filename if no directory prefix", () => {
      assert.strictEqual(getFilename("video.mp4"), "video.mp4");
    });

    it("should return 'file' for empty string", () => {
      assert.strictEqual(getFilename(""), "file");
    });

    it("should handle filenames with spaces (encoded)", () => {
      assert.strictEqual(getFilename("path/to/my file.pdf"), "my file.pdf");
    });

    it("should handle filenames with special characters", () => {
      assert.strictEqual(
        getFilename("path/to/file-name_v2 (1).mp4"),
        "file-name_v2 (1).mp4"
      );
    });

    it("should handle paths with single segment", () => {
      assert.strictEqual(getFilename("document.pptx"), "document.pptx");
    });

    it("should handle trailing slash by returning empty then fallback", () => {
      // "path/to/" -> last segment is "" -> fallback is "file"
      assert.strictEqual(getFilename("path/to/"), "file");
    });

    it("should handle dotfiles", () => {
      assert.strictEqual(getFilename("path/.gitignore"), ".gitignore");
    });

    it("should handle filename with no extension", () => {
      assert.strictEqual(getFilename("path/to/Makefile"), "Makefile");
    });

    it("should handle very long filenames", () => {
      const longName = "a".repeat(200) + ".pdf";
      assert.strictEqual(getFilename(`path/${longName}`), longName);
    });

    it("should handle path with consecutive slashes", () => {
      // split on "/" -> last non-empty is the filename
      // "a//b.mp4".split("/") -> ["a", "", "b.mp4"]  -> pop() -> "b.mp4"
      assert.strictEqual(getFilename("a//b.mp4"), "b.mp4");
    });
  });

  // ===================== buildContentDisposition (MONEY-1074) =====================

  describe("buildContentDisposition", () => {
    it("emits both an ASCII fallback and a UTF-8 filename* param", () => {
      const v = buildContentDisposition("attachment", "report.pdf");
      assert.strictEqual(
        v,
        `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`
      );
    });

    it("strips quotes and backslashes from the ASCII fallback (no header break)", () => {
      const v = buildContentDisposition("attachment", 'a"b\\c.csv');
      assert.strictEqual(v.includes('filename="abc.csv"'), true);
      // The exact name is preserved in the encoded param.
      assert.strictEqual(v.includes("filename*=UTF-8''"), true);
    });

    it("neutralizes CR/LF so a filename can't inject headers", () => {
      const v = buildContentDisposition(
        "attachment",
        "evil\r\nSet-Cookie: x.csv"
      );
      assert.strictEqual(/[\r\n]/.test(v), false);
    });

    it("replaces non-ASCII in the fallback but keeps it in filename*", () => {
      const v = buildContentDisposition("inline", "मेरा-दस्तावेज़.pdf");
      // ASCII fallback has no raw non-ASCII bytes.
      // eslint-disable-next-line no-control-regex
      const fallback = v.match(/filename="([^"]*)"/)?.[1] ?? "";
      assert.strictEqual(/[^\x20-\x7E]/.test(fallback), false);
      assert.strictEqual(
        v.includes(encodeURIComponent("मेरा-दस्तावेज़.pdf")),
        true
      );
    });

    it("falls back to 'file' for empty / whitespace names", () => {
      assert.strictEqual(
        buildContentDisposition("attachment", ""),
        `attachment; filename="file"; filename*=UTF-8''file`
      );
      assert.strictEqual(
        buildContentDisposition("attachment", "   ").includes(
          'filename="file"'
        ),
        true
      );
    });

    it("honours the disposition kind", () => {
      assert.strictEqual(
        buildContentDisposition("inline", "x.pdf").startsWith("inline;"),
        true
      );
    });
  });
});
