/**
 * Content Upload Route Helper Tests
 *
 * Tests for apps/content/app/api/upload/route.ts
 * Pure helpers: getFileCategory, getMaxSize, getFolder, generateUniqueFilename, MIME validation
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Re-implement pure helpers for testing ─────────────────

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const MAX_AUDIO_SIZE = 50 * 1024 * 1024;

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
] as const;

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

function getFileCategory(mimeType: string): "image" | "video" | "audio" {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "image";
}

function getMaxSize(category: "image" | "video" | "audio"): number {
  if (category === "video") return MAX_VIDEO_SIZE;
  if (category === "audio") return MAX_AUDIO_SIZE;
  return MAX_IMAGE_SIZE;
}

function getFolder(category: "image" | "video" | "audio"): string {
  if (category === "video") return "content/videos";
  if (category === "audio") return "content/audio";
  return "content/images";
}

function generateUniqueFilename(
  originalName: string,
  mimeType: string
): string {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 10);
  const extension =
    MIME_TO_EXTENSION[mimeType] || originalName.split(".").pop() || "jpg";
  return `${timestamp}-${randomString}.${extension}`;
}

// ── Tests ────────────────────────────────────────────────

describe("getFileCategory", () => {
  it("should classify image MIME types", () => {
    assert.strictEqual(getFileCategory("image/jpeg"), "image");
    assert.strictEqual(getFileCategory("image/png"), "image");
    assert.strictEqual(getFileCategory("image/gif"), "image");
    assert.strictEqual(getFileCategory("image/webp"), "image");
  });

  it("should classify video MIME types", () => {
    assert.strictEqual(getFileCategory("video/mp4"), "video");
    assert.strictEqual(getFileCategory("video/webm"), "video");
    assert.strictEqual(getFileCategory("video/quicktime"), "video");
  });

  it("should classify audio MIME types", () => {
    assert.strictEqual(getFileCategory("audio/mpeg"), "audio");
    assert.strictEqual(getFileCategory("audio/wav"), "audio");
    assert.strictEqual(getFileCategory("audio/ogg"), "audio");
    assert.strictEqual(getFileCategory("audio/mp4"), "audio");
  });

  it("should default to image for unknown types", () => {
    assert.strictEqual(getFileCategory("application/pdf"), "image");
    assert.strictEqual(getFileCategory("text/plain"), "image");
  });
});

describe("getMaxSize", () => {
  it("should return 5MB for images", () => {
    assert.strictEqual(getMaxSize("image"), 5 * 1024 * 1024);
  });

  it("should return 100MB for videos", () => {
    assert.strictEqual(getMaxSize("video"), 100 * 1024 * 1024);
  });

  it("should return 50MB for audio", () => {
    assert.strictEqual(getMaxSize("audio"), 50 * 1024 * 1024);
  });
});

describe("getFolder", () => {
  it("should return content/images for images", () => {
    assert.strictEqual(getFolder("image"), "content/images");
  });

  it("should return content/videos for videos", () => {
    assert.strictEqual(getFolder("video"), "content/videos");
  });

  it("should return content/audio for audio", () => {
    assert.strictEqual(getFolder("audio"), "content/audio");
  });
});

describe("generateUniqueFilename", () => {
  it("should generate filename with correct extension from MIME", () => {
    const filename = generateUniqueFilename("photo.jpeg", "image/jpeg");
    assert.ok(filename.endsWith(".jpg"));
  });

  it("should generate filename with png extension", () => {
    const filename = generateUniqueFilename("screenshot.png", "image/png");
    assert.ok(filename.endsWith(".png"));
  });

  it("should generate filename with mp4 extension", () => {
    const filename = generateUniqueFilename("video.mp4", "video/mp4");
    assert.ok(filename.endsWith(".mp4"));
  });

  it("should generate filename with mov extension for quicktime", () => {
    const filename = generateUniqueFilename("clip.mov", "video/quicktime");
    assert.ok(filename.endsWith(".mov"));
  });

  it("should generate filename with mp3 extension for mpeg audio", () => {
    const filename = generateUniqueFilename("song.mp3", "audio/mpeg");
    assert.ok(filename.endsWith(".mp3"));
  });

  it("should generate filename with m4a extension for audio/mp4", () => {
    const filename = generateUniqueFilename("podcast.m4a", "audio/mp4");
    assert.ok(filename.endsWith(".m4a"));
  });

  it("should fall back to original extension for unknown MIME", () => {
    const filename = generateUniqueFilename("document.pdf", "application/pdf");
    assert.ok(filename.endsWith(".pdf"));
  });

  it("should fall back to original name for unknown MIME with no dot", () => {
    const filename = generateUniqueFilename(
      "noext",
      "application/octet-stream"
    );
    // "noext".split(".").pop() returns "noext" - used as extension
    assert.ok(filename.endsWith(".noext"));
  });

  it("should generate unique filenames", () => {
    const f1 = generateUniqueFilename("test.jpg", "image/jpeg");
    const f2 = generateUniqueFilename("test.jpg", "image/jpeg");
    assert.notStrictEqual(f1, f2);
  });

  it("should include timestamp in filename", () => {
    const before = Date.now();
    const filename = generateUniqueFilename("test.jpg", "image/jpeg");
    const after = Date.now();
    const parts = filename.split("-");
    const timestamp = parseInt(parts[0]!, 10);
    assert.ok(timestamp >= before);
    assert.ok(timestamp <= after);
  });

  it("should have correct format: timestamp-random.ext", () => {
    const filename = generateUniqueFilename("test.jpg", "image/jpeg");
    const match = filename.match(/^\d+-[a-z0-9]+\.jpg$/);
    assert.ok(
      match,
      `Filename "${filename}" should match timestamp-random.ext`
    );
  });
});

describe("ALLOWED_TYPES", () => {
  it("should include 4 image types", () => {
    const imageTypes = ALLOWED_TYPES.filter((t) => t.startsWith("image/"));
    assert.strictEqual(imageTypes.length, 4);
  });

  it("should include 3 video types", () => {
    const videoTypes = ALLOWED_TYPES.filter((t) => t.startsWith("video/"));
    assert.strictEqual(videoTypes.length, 3);
  });

  it("should include 4 audio types", () => {
    const audioTypes = ALLOWED_TYPES.filter((t) => t.startsWith("audio/"));
    assert.strictEqual(audioTypes.length, 4);
  });

  it("should have 11 total types", () => {
    assert.strictEqual(ALLOWED_TYPES.length, 11);
  });

  it("should not include application types", () => {
    assert.ok(!ALLOWED_TYPES.some((t) => t.startsWith("application/")));
  });

  it("should not include text types", () => {
    assert.ok(!ALLOWED_TYPES.some((t) => t.startsWith("text/")));
  });
});

describe("MIME_TO_EXTENSION mapping", () => {
  it("should have an extension for every allowed type", () => {
    for (const mime of ALLOWED_TYPES) {
      assert.ok(
        MIME_TO_EXTENSION[mime],
        `Missing extension mapping for ${mime}`
      );
    }
  });

  it("should not have duplicate extensions", () => {
    const extensions = Object.values(MIME_TO_EXTENSION);
    const unique = new Set(extensions);
    assert.strictEqual(
      extensions.length,
      unique.size,
      "Duplicate extensions found"
    );
  });
});

describe("End-to-end file classification", () => {
  it("should correctly classify and route an image upload", () => {
    const mimeType = "image/jpeg";
    const category = getFileCategory(mimeType);
    assert.strictEqual(category, "image");
    assert.strictEqual(getMaxSize(category), 5 * 1024 * 1024);
    assert.strictEqual(getFolder(category), "content/images");
  });

  it("should correctly classify and route a video upload", () => {
    const mimeType = "video/mp4";
    const category = getFileCategory(mimeType);
    assert.strictEqual(category, "video");
    assert.strictEqual(getMaxSize(category), 100 * 1024 * 1024);
    assert.strictEqual(getFolder(category), "content/videos");
  });

  it("should correctly classify and route an audio upload", () => {
    const mimeType = "audio/mpeg";
    const category = getFileCategory(mimeType);
    assert.strictEqual(category, "audio");
    assert.strictEqual(getMaxSize(category), 50 * 1024 * 1024);
    assert.strictEqual(getFolder(category), "content/audio");
  });
});
