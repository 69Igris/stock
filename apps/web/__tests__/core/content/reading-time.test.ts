/**
 * Reading Time Calculation Tests
 *
 * Exercises the REAL reading-time utilities exported from
 * packages/core/src/content/reading-time.ts (re-exported through the
 * `@usemoney/core` package root). No inline reimplementation:
 * `calculateReadingTime`, `formatReadingTime`, `getReadingTimeFromBlockNote`,
 * and the recursive `extractTextFromBlocks` (exported for direct test; the
 * production path reaches it via `getReadingTimeFromBlockNote`) all run the
 * same source code asserted here.
 *
 * Source: packages/core/src/content/reading-time.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateReadingTime,
  formatReadingTime,
  getReadingTimeFromBlockNote,
  extractTextFromBlocks,
} from "@usemoney/core";
import type { Block } from "@usemoney/core";

// ============== HELPERS ==============

function generateWords(count: number): string {
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push("word");
  }
  return words.join(" ");
}

// ============== TESTS ==============

describe("Reading Time Utilities (real @usemoney/core exports)", () => {
  // ---- calculateReadingTime ----

  describe("calculateReadingTime", () => {
    it("should return 1 for a single word", () => {
      assert.equal(calculateReadingTime("hello"), 1);
    });

    it("should return 1 for a short sentence", () => {
      assert.equal(calculateReadingTime("This is a short sentence."), 1);
    });

    it("should return 1 for exactly 225 words", () => {
      const text = generateWords(225);
      assert.equal(calculateReadingTime(text), 1);
    });

    it("should return 2 for 226 words (Math.ceil)", () => {
      const text = generateWords(226);
      assert.equal(calculateReadingTime(text), 2);
    });

    it("should return 2 for 450 words", () => {
      const text = generateWords(450);
      assert.equal(calculateReadingTime(text), 2);
    });

    it("should return 3 for 451 words", () => {
      const text = generateWords(451);
      assert.equal(calculateReadingTime(text), 3);
    });

    it("should return 5 for 1000 words", () => {
      const text = generateWords(1000);
      // Math.ceil(1000 / 225) = Math.ceil(4.44) = 5
      assert.equal(calculateReadingTime(text), 5);
    });

    it("should return 1 for empty string", () => {
      assert.equal(calculateReadingTime(""), 1);
    });

    it("should return 1 for whitespace only", () => {
      assert.equal(calculateReadingTime("   \t\n  "), 1);
    });

    it("should strip HTML tags before counting words", () => {
      const html =
        "<p>Hello <strong>world</strong> this is <em>a</em> test</p>";
      // Words: Hello world this is a test = 6 words
      assert.equal(calculateReadingTime(html), 1);
    });

    it("should strip complex HTML tags", () => {
      const html =
        '<div class="container"><h1>Title</h1><p>Paragraph with <a href="#">link</a>.</p></div>';
      // Words: Title Paragraph with link. = 4 words
      assert.equal(calculateReadingTime(html), 1);
    });

    it("should strip nested HTML with many words", () => {
      const wordsText = generateWords(300);
      const html = `<div><p>${wordsText}</p></div>`;
      assert.equal(calculateReadingTime(html), 2);
    });

    it("should handle HTML with no text content", () => {
      const html = "<div><br/><hr/><img src='test.png'/></div>";
      assert.equal(calculateReadingTime(html), 1);
    });

    it("should handle multiple spaces between words", () => {
      const text = "word1    word2    word3";
      assert.equal(calculateReadingTime(text), 1);
    });

    it("should handle tabs and newlines between words", () => {
      const text = "word1\tword2\nword3\r\nword4";
      assert.equal(calculateReadingTime(text), 1);
    });

    it("should correctly calculate for very long content", () => {
      const text = generateWords(2250);
      // Math.ceil(2250 / 225) = 10
      assert.equal(calculateReadingTime(text), 10);
    });

    it("should correctly calculate for 10000 words", () => {
      const text = generateWords(10000);
      // Math.ceil(10000 / 225) = Math.ceil(44.44) = 45
      assert.equal(calculateReadingTime(text), 45);
    });

    it("should handle content with only HTML tags", () => {
      assert.equal(calculateReadingTime("<br/><hr/>"), 1);
    });

    it("should handle content with special characters mixed with words", () => {
      const text = "Hello! World? This is -- a test.";
      // Words: Hello! World? This is -- a test. = 7 words
      assert.equal(calculateReadingTime(text), 1);
    });
  });

  // ---- formatReadingTime ----

  describe("formatReadingTime", () => {
    it("should format 1 minute", () => {
      assert.equal(formatReadingTime(1), "1 min read");
    });

    it("should format 5 minutes", () => {
      assert.equal(formatReadingTime(5), "5 min read");
    });

    it("should format 10 minutes", () => {
      assert.equal(formatReadingTime(10), "10 min read");
    });

    it("should format 0 minutes", () => {
      assert.equal(formatReadingTime(0), "0 min read");
    });

    it("should format large numbers", () => {
      assert.equal(formatReadingTime(100), "100 min read");
    });
  });

  // ---- extractTextFromBlocks ----

  describe("extractTextFromBlocks", () => {
    it("should extract text from a single block with text content", () => {
      const blocks: Block[] = [
        { content: [{ type: "text", text: "Hello world" }] },
      ];
      assert.equal(extractTextFromBlocks(blocks).trim(), "Hello world");
    });

    it("should extract text from multiple content items in one block", () => {
      const blocks: Block[] = [
        {
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "world" },
          ],
        },
      ];
      const result = extractTextFromBlocks(blocks);
      assert.ok(result.includes("Hello"));
      assert.ok(result.includes("world"));
    });

    it("should skip non-text content types", () => {
      const blocks: Block[] = [
        {
          content: [
            { type: "text", text: "visible" },
            { type: "image", text: "hidden" },
          ],
        },
      ];
      const result = extractTextFromBlocks(blocks);
      assert.ok(result.includes("visible"));
      assert.ok(!result.includes("hidden"));
    });

    it("should extract text from nested children", () => {
      const blocks: Block[] = [
        {
          content: [{ type: "text", text: "parent" }],
          children: [{ content: [{ type: "text", text: "child" }] }],
        },
      ];
      const result = extractTextFromBlocks(blocks);
      assert.ok(result.includes("parent"));
      assert.ok(result.includes("child"));
    });

    it("should extract text from deeply nested children", () => {
      const blocks: Block[] = [
        {
          content: [{ type: "text", text: "level1" }],
          children: [
            {
              content: [{ type: "text", text: "level2" }],
              children: [{ content: [{ type: "text", text: "level3" }] }],
            },
          ],
        },
      ];
      const result = extractTextFromBlocks(blocks);
      assert.ok(result.includes("level1"));
      assert.ok(result.includes("level2"));
      assert.ok(result.includes("level3"));
    });

    it("should return empty string for blocks with no content", () => {
      const blocks: Block[] = [{}];
      assert.equal(extractTextFromBlocks(blocks), "");
    });

    it("should return empty string for empty blocks array", () => {
      assert.equal(extractTextFromBlocks([]), "");
    });

    it("should handle blocks with empty content array", () => {
      const blocks: Block[] = [{ content: [] }];
      assert.equal(extractTextFromBlocks(blocks), "");
    });

    it("should handle blocks with children but no content", () => {
      const blocks: Block[] = [
        {
          children: [{ content: [{ type: "text", text: "child only" }] }],
        },
      ];
      assert.ok(extractTextFromBlocks(blocks).includes("child only"));
    });
  });

  // ---- getReadingTimeFromBlockNote ----

  describe("getReadingTimeFromBlockNote", () => {
    it("should calculate reading time from valid BlockNote JSON", () => {
      const blocks: Block[] = [
        { content: [{ type: "text", text: generateWords(225) }] },
      ];
      assert.equal(getReadingTimeFromBlockNote(JSON.stringify(blocks)), 1);
    });

    it("should return 1 for invalid JSON", () => {
      assert.equal(getReadingTimeFromBlockNote("not json"), 1);
    });

    it("should return 1 for empty JSON array", () => {
      assert.equal(getReadingTimeFromBlockNote("[]"), 1);
    });

    it("should return 1 for empty string input", () => {
      assert.equal(getReadingTimeFromBlockNote(""), 1);
    });

    it("should calculate reading time from nested blocks", () => {
      const blocks: Block[] = [
        {
          content: [{ type: "text", text: generateWords(300) }],
          children: [{ content: [{ type: "text", text: generateWords(200) }] }],
        },
      ];
      // Total words: 500. Math.ceil(500 / 225) = Math.ceil(2.22) = 3
      assert.equal(getReadingTimeFromBlockNote(JSON.stringify(blocks)), 3);
    });

    it("should return 1 for blocks with only non-text content", () => {
      const blocks: Block[] = [{ content: [{ type: "image" }] }];
      assert.equal(getReadingTimeFromBlockNote(JSON.stringify(blocks)), 1);
    });

    it("should handle malformed JSON gracefully", () => {
      assert.equal(getReadingTimeFromBlockNote("{broken"), 1);
    });

    it("should handle null input gracefully", () => {
      assert.equal(getReadingTimeFromBlockNote("null"), 1);
    });
  });
});
