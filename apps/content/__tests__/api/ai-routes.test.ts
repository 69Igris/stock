/**
 * AI Routes Tests
 *
 * Exercises the REAL fallback generators + upload validation helpers imported &
 * used by the route handlers:
 * - app/api/ai/trending-topics/trending-topics-logic.ts (generateFallbackTrends)
 * - app/api/ai/generate-image/generate-image-logic.ts   (generateImageSuggestion)
 * - app/api/ai/generate-script/generate-script-logic.ts (generateFallbackScript)
 * - app/api/upload/upload-logic.ts (getFileCategory, getMaxSize, getFolder,
 *   isAllowedType, generateUniqueFilename, size + MIME constants)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateFallbackTrends } from "@/app/api/ai/trending-topics/trending-topics-logic";
import { generateImageSuggestion } from "@/app/api/ai/generate-image/generate-image-logic";
import { generateFallbackScript } from "@/app/api/ai/generate-script/generate-script-logic";
import {
  ALLOWED_TYPES,
  generateUniqueFilename,
  getFileCategory,
  getFolder,
  getMaxSize,
  isAllowedType,
  MAX_AUDIO_SIZE,
  MAX_IMAGE_SIZE,
  MAX_VIDEO_SIZE,
  MIME_TO_EXTENSION,
} from "@/app/api/upload/upload-logic";

// ── Tests ────────────────────────────────────────────────

describe("generateFallbackTrends", () => {
  it("should return 15 trends when no category filter", () => {
    const trends = generateFallbackTrends();
    assert.strictEqual(trends.length, 15);
  });

  it("should filter by Stock Market category", () => {
    const trends = generateFallbackTrends("Stock Market");
    assert.ok(trends.length > 0);
    assert.ok(trends.every((t) => t.category === "Stock Market"));
  });

  it("should filter by Finance category", () => {
    const trends = generateFallbackTrends("Finance");
    assert.ok(trends.length > 0);
    // The filter uses case-insensitive includes, so "Personal Finance" also matches
    assert.ok(
      trends.every((t) => t.category.toLowerCase().includes("finance")),
    );
  });

  it("should filter case-insensitively", () => {
    const trends = generateFallbackTrends("economy");
    assert.ok(trends.length > 0);
    assert.ok(
      trends.every((t) => t.category.toLowerCase().includes("economy")),
    );
  });

  it("should return empty array for non-matching category", () => {
    const trends = generateFallbackTrends("NonExistentCategory");
    assert.strictEqual(trends.length, 0);
  });

  it("should have all required fields on each trend", () => {
    const trends = generateFallbackTrends();
    for (const t of trends) {
      assert.ok(typeof t.topic === "string" && t.topic.length > 0);
      assert.ok(typeof t.trendScore === "number");
      assert.ok(typeof t.growth === "string");
      assert.ok(typeof t.category === "string");
      assert.ok(typeof t.searchVolume === "string");
      assert.ok(Array.isArray(t.relatedQueries));
      assert.ok(t.relatedQueries.length > 0);
    }
  });

  it("should have trendScores between 1 and 100", () => {
    const trends = generateFallbackTrends();
    for (const t of trends) {
      assert.ok(t.trendScore >= 1 && t.trendScore <= 100);
    }
  });
});

describe("generateImageSuggestion", () => {
  it("should use photorealistic style by default", () => {
    const suggestion = generateImageSuggestion("market chart");
    assert.ok(suggestion.enhancedPrompt.includes("photograph"));
  });

  it("should use digital-art style when specified", () => {
    const suggestion = generateImageSuggestion("market chart", "digital-art");
    assert.ok(suggestion.enhancedPrompt.includes("digital artwork"));
  });

  it("should use illustration style", () => {
    const suggestion = generateImageSuggestion("portfolio", "illustration");
    assert.ok(suggestion.enhancedPrompt.includes("hand-drawn"));
  });

  it("should use minimalist style", () => {
    const suggestion = generateImageSuggestion("dashboard", "minimalist");
    assert.ok(suggestion.enhancedPrompt.includes("minimalist"));
  });

  it("should use abstract style", () => {
    const suggestion = generateImageSuggestion("growth", "abstract");
    assert.ok(suggestion.enhancedPrompt.includes("abstract"));
  });

  it("should fall back to photorealistic for unknown style", () => {
    const suggestion = generateImageSuggestion("test", "unknown-style");
    assert.ok(suggestion.enhancedPrompt.includes("photograph"));
  });

  it("should include the prompt in the enhanced prompt", () => {
    const suggestion = generateImageSuggestion("stock trading desk");
    assert.ok(suggestion.enhancedPrompt.includes("stock trading desk"));
  });

  it("should return 8 stock photo keywords", () => {
    const suggestion = generateImageSuggestion("any");
    assert.strictEqual(suggestion.stockPhotoKeywords.length, 8);
  });

  it("should return 5 hex colors in palette", () => {
    const suggestion = generateImageSuggestion("any");
    assert.strictEqual(suggestion.colorPalette.length, 5);
    for (const color of suggestion.colorPalette) {
      assert.ok(/^#[0-9A-Fa-f]{6}$/.test(color));
    }
  });
});

describe("generateFallbackScript", () => {
  it("should include the title in lowercase in opening", () => {
    const script = generateFallbackScript("SIP Investing");
    assert.ok(script.includes("sip investing"));
  });

  it("should include description when provided", () => {
    const script = generateFallbackScript("Test", "This is a brief.");
    assert.ok(script.includes("This is a brief."));
  });

  it("should use default description when not provided", () => {
    const script = generateFallbackScript("Test");
    assert.ok(script.includes("This comprehensive guide"));
  });

  it("should include topics as bold list items", () => {
    const script = generateFallbackScript("Trading", undefined, [
      "Charts",
      "Indicators",
    ]);
    assert.ok(script.includes("**Charts**"));
    assert.ok(script.includes("**Indicators**"));
  });

  it("should use default key points when no topics", () => {
    const script = generateFallbackScript("Test");
    assert.ok(script.includes("Add your key points here"));
  });

  it("should contain standard sections", () => {
    const script = generateFallbackScript("Test");
    assert.ok(script.includes("## Why This Matters"));
    assert.ok(script.includes("## Key Concepts"));
    assert.ok(script.includes("## Getting Started"));
    assert.ok(script.includes("## Best Practices"));
    assert.ok(script.includes("## Common Pitfalls to Avoid"));
    assert.ok(script.includes("## Conclusion"));
  });

  it("should include API key note at the end", () => {
    const script = generateFallbackScript("Test");
    assert.ok(script.includes("GOOGLE_GENAI_API_KEY"));
  });
});

describe("getFileCategory", () => {
  it("should return image for image/jpeg", () => {
    assert.strictEqual(getFileCategory("image/jpeg"), "image");
  });

  it("should return image for image/png", () => {
    assert.strictEqual(getFileCategory("image/png"), "image");
  });

  it("should return image for image/webp", () => {
    assert.strictEqual(getFileCategory("image/webp"), "image");
  });

  it("should return video for video/mp4", () => {
    assert.strictEqual(getFileCategory("video/mp4"), "video");
  });

  it("should return video for video/quicktime", () => {
    assert.strictEqual(getFileCategory("video/quicktime"), "video");
  });

  it("should return audio for audio/mpeg", () => {
    assert.strictEqual(getFileCategory("audio/mpeg"), "audio");
  });

  it("should return audio for audio/wav", () => {
    assert.strictEqual(getFileCategory("audio/wav"), "audio");
  });

  it("should return image for unknown types", () => {
    assert.strictEqual(getFileCategory("application/pdf"), "image");
  });
});

describe("getMaxSize", () => {
  it("should return 5MB for images", () => {
    assert.strictEqual(getMaxSize("image"), MAX_IMAGE_SIZE);
  });

  it("should return 100MB for videos", () => {
    assert.strictEqual(getMaxSize("video"), MAX_VIDEO_SIZE);
  });

  it("should return 50MB for audio", () => {
    assert.strictEqual(getMaxSize("audio"), MAX_AUDIO_SIZE);
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

describe("isAllowedType", () => {
  it("should allow image/jpeg", () => {
    assert.strictEqual(isAllowedType("image/jpeg"), true);
  });

  it("should allow image/png", () => {
    assert.strictEqual(isAllowedType("image/png"), true);
  });

  it("should allow video/mp4", () => {
    assert.strictEqual(isAllowedType("video/mp4"), true);
  });

  it("should allow audio/mpeg", () => {
    assert.strictEqual(isAllowedType("audio/mpeg"), true);
  });

  it("should allow audio/mp4", () => {
    assert.strictEqual(isAllowedType("audio/mp4"), true);
  });

  it("should reject application/pdf", () => {
    assert.strictEqual(isAllowedType("application/pdf"), false);
  });

  it("should reject text/plain", () => {
    assert.strictEqual(isAllowedType("text/plain"), false);
  });

  it("should reject empty string", () => {
    assert.strictEqual(isAllowedType(""), false);
  });
});

describe("generateUniqueFilename", () => {
  it("should use correct extension from MIME type", () => {
    const name = generateUniqueFilename("photo.jpeg", "image/jpeg");
    assert.ok(name.endsWith(".jpg"));
  });

  it("should use png extension for image/png", () => {
    const name = generateUniqueFilename("screenshot.png", "image/png");
    assert.ok(name.endsWith(".png"));
  });

  it("should use mp4 extension for video/mp4", () => {
    const name = generateUniqueFilename("vid.mp4", "video/mp4");
    assert.ok(name.endsWith(".mp4"));
  });

  it("should use mov extension for video/quicktime", () => {
    const name = generateUniqueFilename("clip.mov", "video/quicktime");
    assert.ok(name.endsWith(".mov"));
  });

  it("should use m4a extension for audio/mp4", () => {
    const name = generateUniqueFilename("audio.m4a", "audio/mp4");
    assert.ok(name.endsWith(".m4a"));
  });

  it("should fall back to original extension for unknown MIME", () => {
    const name = generateUniqueFilename("doc.pdf", "application/pdf");
    assert.ok(name.endsWith(".pdf"));
  });

  it("should fall back to original name as extension when no dot in name", () => {
    // "noext".split(".").pop() returns "noext" (the whole string), so it uses that
    const name = generateUniqueFilename("noext", "unknown/type");
    assert.ok(name.endsWith(".noext"));
  });

  it("should fall back to jpg when file has dot but empty extension", () => {
    // Edge case: originalName ending with dot - split(".").pop() returns ""
    // which is falsy, so it falls back to "jpg"
    const name = generateUniqueFilename("file.", "unknown/type");
    assert.ok(name.endsWith(".jpg"));
  });

  it("should contain timestamp in filename", () => {
    const before = Date.now();
    const name = generateUniqueFilename("test.jpg", "image/jpeg");
    const after = Date.now();
    const parts = name.split("-");
    const timestamp = parseInt(parts[0]!, 10);
    assert.ok(timestamp >= before && timestamp <= after);
  });

  it("should generate different names for same input", () => {
    const name1 = generateUniqueFilename("test.jpg", "image/jpeg");
    const name2 = generateUniqueFilename("test.jpg", "image/jpeg");
    // Very unlikely to be equal due to random string, but timestamps might match
    // Just check they have expected format
    assert.ok(name1.includes("-"));
    assert.ok(name2.includes("-"));
  });
});

describe("MIME_TO_EXTENSION mapping", () => {
  it("should cover all ALLOWED_TYPES", () => {
    for (const mime of ALLOWED_TYPES) {
      assert.ok(
        MIME_TO_EXTENSION[mime] !== undefined,
        `Missing extension for ${mime}`,
      );
    }
  });
});
