/**
 * Slug Generation and Validation Tests
 *
 * Exercises the REAL slug utilities exported from
 * packages/core/src/content/slugify.ts (re-exported through the
 * `@usemoney/core` package root — content has no dedicated subpath export).
 * No inline reimplementation: the production code path and these assertions run
 * the SAME `generateSlug` / `ensureUniqueSlug` / `isValidSlug`.
 *
 * Source: packages/core/src/content/slugify.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateSlug, ensureUniqueSlug, isValidSlug } from "@usemoney/core";

// ============== TESTS ==============

describe("Slug Utilities (real @usemoney/core exports)", () => {
  // ---- generateSlug ----

  describe("generateSlug", () => {
    it("should convert a simple title to a slug", () => {
      assert.equal(generateSlug("Hello World"), "hello-world");
    });

    it("should lowercase all characters", () => {
      assert.equal(generateSlug("UPPERCASE TITLE"), "uppercase-title");
    });

    it("should handle mixed case", () => {
      assert.equal(generateSlug("Mixed Case Title"), "mixed-case-title");
    });

    it("should trim leading and trailing whitespace", () => {
      assert.equal(generateSlug("  hello world  "), "hello-world");
    });

    it("should replace spaces with hyphens", () => {
      assert.equal(generateSlug("one two three"), "one-two-three");
    });

    it("should remove special characters", () => {
      assert.equal(generateSlug("hello!@#$%^&*()world"), "helloworld");
    });

    it("should remove special characters but keep words", () => {
      assert.equal(generateSlug("what's up? nothing!"), "whats-up-nothing");
    });

    it("should collapse multiple spaces into a single hyphen", () => {
      assert.equal(generateSlug("hello    world"), "hello-world");
    });

    it("should collapse multiple hyphens into one", () => {
      assert.equal(generateSlug("hello---world"), "hello-world");
    });

    it("should remove leading hyphens", () => {
      assert.equal(generateSlug("-hello"), "hello");
    });

    it("should remove trailing hyphens", () => {
      assert.equal(generateSlug("hello-"), "hello");
    });

    it("should remove both leading and trailing hyphens", () => {
      assert.equal(generateSlug("-hello-"), "hello");
    });

    it("should handle numbers", () => {
      assert.equal(generateSlug("Top 10 Stocks"), "top-10-stocks");
    });

    it("should handle numbers only", () => {
      assert.equal(generateSlug("12345"), "12345");
    });

    it("should handle underscores (they pass through \\w)", () => {
      const result = generateSlug("hello_world");
      // \w matches underscores, so they remain
      assert.equal(result, "hello_world");
    });

    it("should handle a complex real-world title", () => {
      assert.equal(
        generateSlug("How to Invest in Stocks: A Beginner's Guide (2024)"),
        "how-to-invest-in-stocks-a-beginners-guide-2024"
      );
    });

    it("should handle ampersand and plus", () => {
      // & and + removed => "Stocks  Bonds  ETFs" => "stocks--bonds--etfs" => collapsed => "stocks-bonds-etfs"
      assert.equal(generateSlug("Stocks & Bonds + ETFs"), "stocks-bonds-etfs");
    });

    it("should return empty string for special characters only", () => {
      assert.equal(generateSlug("!@#$%^&*()"), "");
    });

    it("should return empty string for empty input", () => {
      assert.equal(generateSlug(""), "");
    });

    it("should handle single word", () => {
      assert.equal(generateSlug("hello"), "hello");
    });

    it("should handle single character", () => {
      assert.equal(generateSlug("a"), "a");
    });

    it("should handle dots and commas", () => {
      assert.equal(generateSlug("hello.world,foo"), "helloworldfoo");
    });

    it("should handle colons and semicolons", () => {
      assert.equal(
        generateSlug("section: the beginning"),
        "section-the-beginning"
      );
    });

    it("should handle tab characters", () => {
      assert.equal(generateSlug("hello\tworld"), "hello-world");
    });
  });

  // ---- ensureUniqueSlug ----

  describe("ensureUniqueSlug", () => {
    it("should return original slug when no conflicts", () => {
      assert.equal(ensureUniqueSlug("hello-world", []), "hello-world");
    });

    it("should return original slug when not in existing list", () => {
      assert.equal(
        ensureUniqueSlug("hello-world", ["other-slug", "another-slug"]),
        "hello-world"
      );
    });

    it("should append -1 when slug exists", () => {
      assert.equal(
        ensureUniqueSlug("hello-world", ["hello-world"]),
        "hello-world-1"
      );
    });

    it("should append -2 when slug and slug-1 both exist", () => {
      assert.equal(
        ensureUniqueSlug("hello-world", ["hello-world", "hello-world-1"]),
        "hello-world-2"
      );
    });

    it("should append -3 when slug, slug-1, and slug-2 exist", () => {
      assert.equal(
        ensureUniqueSlug("hello-world", [
          "hello-world",
          "hello-world-1",
          "hello-world-2",
        ]),
        "hello-world-3"
      );
    });

    it("should skip gaps and find next available number", () => {
      // If slug-1 exists but slug-2 does not
      assert.equal(ensureUniqueSlug("test", ["test", "test-1"]), "test-2");
    });

    it("should handle single-word slug conflicts", () => {
      assert.equal(ensureUniqueSlug("stocks", ["stocks"]), "stocks-1");
    });

    it("should handle numeric slugs", () => {
      assert.equal(ensureUniqueSlug("123", ["123"]), "123-1");
    });

    it("should handle slug that already ends with a number", () => {
      assert.equal(ensureUniqueSlug("top-10", ["top-10"]), "top-10-1");
    });

    it("should handle many conflicts", () => {
      const existing = ["post"];
      for (let i = 1; i <= 99; i++) {
        existing.push(`post-${i}`);
      }
      assert.equal(ensureUniqueSlug("post", existing), "post-100");
    });

    it("should not modify slug when existingSlugs is empty array", () => {
      assert.equal(ensureUniqueSlug("my-post", []), "my-post");
    });
  });

  // ---- isValidSlug ----

  describe("isValidSlug", () => {
    it("should return true for a simple valid slug", () => {
      assert.equal(isValidSlug("hello-world"), true);
    });

    it("should return true for a single word slug", () => {
      assert.equal(isValidSlug("hello"), true);
    });

    it("should return true for numbers only", () => {
      assert.equal(isValidSlug("123"), true);
    });

    it("should return true for alphanumeric with hyphens", () => {
      assert.equal(isValidSlug("top-10-stocks"), true);
    });

    it("should return true for a long valid slug", () => {
      assert.equal(
        isValidSlug("this-is-a-very-long-slug-with-many-parts"),
        true
      );
    });

    it("should return false for slug with uppercase letters", () => {
      assert.equal(isValidSlug("Hello-World"), false);
    });

    it("should return false for slug with spaces", () => {
      assert.equal(isValidSlug("hello world"), false);
    });

    it("should return false for slug with special characters", () => {
      assert.equal(isValidSlug("hello@world"), false);
    });

    it("should return false for slug with underscores", () => {
      assert.equal(isValidSlug("hello_world"), false);
    });

    it("should return false for slug starting with a hyphen", () => {
      assert.equal(isValidSlug("-hello"), false);
    });

    it("should return false for slug ending with a hyphen", () => {
      assert.equal(isValidSlug("hello-"), false);
    });

    it("should return false for slug with consecutive hyphens", () => {
      assert.equal(isValidSlug("hello--world"), false);
    });

    it("should return false for empty string", () => {
      assert.equal(isValidSlug(""), false);
    });

    it("should return false for just a hyphen", () => {
      assert.equal(isValidSlug("-"), false);
    });

    it("should return true for single digit", () => {
      assert.equal(isValidSlug("1"), true);
    });

    it("should return true for single letter", () => {
      assert.equal(isValidSlug("a"), true);
    });

    it("should return false for slug with dots", () => {
      assert.equal(isValidSlug("hello.world"), false);
    });

    it("should return false for slug with trailing dot", () => {
      assert.equal(isValidSlug("hello."), false);
    });
  });
});
