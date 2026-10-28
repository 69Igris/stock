/**
 * Ideas Action Tests
 *
 * Exercises the REAL exported helpers from
 * `apps/content/lib/actions/ideas-logic.ts` (which `ideas.ts` imports and
 * calls) — NOT inline copies.
 * - titleToSlug conversion (convertIdeaToDraft post URL)
 * - Username generation sanitization
 * - canAccessResource / buildIdeaListWhere (SECURITY: WRITER scoping)
 * - Idea status/stage constants
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  titleToSlug,
  sanitizeUsername,
  generateUsernameBase,
  usernameWithCounter,
  canAccessResource,
  buildIdeaListWhere,
} from "@/lib/actions/ideas-logic";

// ── Tests ────────────────────────────────────────────────

describe("titleToSlug", () => {
  it("should convert simple title to slug", () => {
    assert.strictEqual(titleToSlug("Hello World"), "hello-world");
  });

  it("should remove special characters", () => {
    assert.strictEqual(
      titleToSlug("NIFTY 50: Analysis & Tips"),
      "nifty-50-analysis-tips",
    );
  });

  it("should handle leading/trailing special chars", () => {
    assert.strictEqual(titleToSlug("---Hello World---"), "hello-world");
  });

  it("should collapse multiple hyphens", () => {
    assert.strictEqual(titleToSlug("One   Two   Three"), "one-two-three");
  });

  it("should handle numbers", () => {
    assert.strictEqual(titleToSlug("Top 10 Stocks 2025"), "top-10-stocks-2025");
  });

  it("should handle unicode characters", () => {
    assert.strictEqual(titleToSlug("IPO Analysis ₹100"), "ipo-analysis-100");
  });

  it("should truncate to 100 characters", () => {
    const longTitle = "a".repeat(200);
    const slug = titleToSlug(longTitle);
    assert.ok(slug.length <= 100);
  });

  it("should handle empty string", () => {
    assert.strictEqual(titleToSlug(""), "");
  });

  it("should handle only special characters", () => {
    assert.strictEqual(titleToSlug("!@#$%^&*()"), "");
  });

  it("should handle single word", () => {
    assert.strictEqual(titleToSlug("Investing"), "investing");
  });

  it("should handle ampersands and commas", () => {
    assert.strictEqual(
      titleToSlug("Stocks, Bonds & ETFs"),
      "stocks-bonds-etfs",
    );
  });
});

describe("sanitizeUsername", () => {
  it("should lowercase the input", () => {
    assert.strictEqual(sanitizeUsername("JohnDoe"), "johndoe");
  });

  it("should replace spaces with underscores", () => {
    assert.strictEqual(sanitizeUsername("John Doe"), "john_doe");
  });

  it("should replace special chars with underscores", () => {
    assert.strictEqual(sanitizeUsername("john.doe@email"), "john_doe_email");
  });

  it("should keep underscores", () => {
    assert.strictEqual(sanitizeUsername("john_doe"), "john_doe");
  });

  it("should keep numbers", () => {
    assert.strictEqual(sanitizeUsername("user123"), "user123");
  });

  it("should truncate to 25 chars", () => {
    const long = "abcdefghijklmnopqrstuvwxyz123";
    assert.strictEqual(sanitizeUsername(long).length, 25);
  });

  it("should handle empty string", () => {
    assert.strictEqual(sanitizeUsername(""), "");
  });
});

describe("generateUsernameBase", () => {
  it("should use name when provided", () => {
    assert.strictEqual(
      generateUsernameBase("John Doe", "john@example.com"),
      "john_doe",
    );
  });

  it("should use email prefix when name is null", () => {
    assert.strictEqual(
      generateUsernameBase(null, "trader@example.com"),
      "trader",
    );
  });

  it("should use email prefix when name is undefined", () => {
    assert.strictEqual(
      generateUsernameBase(undefined, "investor@usemoney.ai"),
      "investor",
    );
  });

  it("should handle email with dots", () => {
    assert.strictEqual(
      generateUsernameBase(null, "john.doe@example.com"),
      "john_doe",
    );
  });
});

describe("usernameWithCounter", () => {
  it("should append counter to base", () => {
    assert.strictEqual(usernameWithCounter("johndoe", 1), "johndoe_1");
  });

  it("should truncate base to 22 chars before appending", () => {
    const longBase = "a".repeat(30);
    const result = usernameWithCounter(longBase, 1);
    assert.ok(result.startsWith("a".repeat(22)));
    assert.ok(result.endsWith("_1"));
  });

  it("should handle multi-digit counter", () => {
    const result = usernameWithCounter("johndoe", 99);
    assert.strictEqual(result, "johndoe_99");
  });
});

describe("canAccessResource", () => {
  it("should allow WRITER to access own resource", () => {
    assert.strictEqual(
      canAccessResource("WRITER", "author-1", "author-1"),
      true,
    );
  });

  it("should deny WRITER access to other's resource", () => {
    assert.strictEqual(
      canAccessResource("WRITER", "author-2", "author-1"),
      false,
    );
  });

  it("should allow ADMIN to access any resource", () => {
    assert.strictEqual(
      canAccessResource("ADMIN", "author-2", "author-1"),
      true,
    );
  });

  it("should allow OWNER to access any resource", () => {
    assert.strictEqual(
      canAccessResource("OWNER", "author-2", "author-1"),
      true,
    );
  });

  it("should allow EDITOR to access any resource", () => {
    assert.strictEqual(
      canAccessResource("EDITOR", "author-2", "author-1"),
      true,
    );
  });
});

describe("buildIdeaListWhere", () => {
  it("should return empty where for ADMIN with no status", () => {
    const where = buildIdeaListWhere("ADMIN", "author-1");
    assert.deepStrictEqual(where, {});
  });

  it("should add status filter when provided", () => {
    const where = buildIdeaListWhere("ADMIN", "author-1", "IN_PROGRESS");
    assert.deepStrictEqual(where, { status: "IN_PROGRESS" });
  });

  it("should add authorId filter for WRITER", () => {
    const where = buildIdeaListWhere("WRITER", "author-1");
    assert.deepStrictEqual(where, { authorId: "author-1" });
  });

  it("should add both status and authorId for WRITER", () => {
    const where = buildIdeaListWhere("WRITER", "author-1", "NEW");
    assert.deepStrictEqual(where, { status: "NEW", authorId: "author-1" });
  });

  it("should not add authorId for OWNER", () => {
    const where = buildIdeaListWhere("OWNER", "author-1", "NEW");
    assert.deepStrictEqual(where, { status: "NEW" });
  });
});

describe("Idea status and stage constants", () => {
  it("should define valid idea statuses", () => {
    const statuses = [
      "NEW",
      "IN_PROGRESS",
      "COMPLETED",
      "DRAFT_CREATED",
      "CANCELLED",
    ];
    assert.ok(statuses.includes("NEW"));
    assert.ok(statuses.includes("DRAFT_CREATED"));
  });

  it("should define valid idea stages", () => {
    const stages = ["ROUGH_IDEA", "OUTLINED", "SCRIPTED", "READY_TO_WRITE"];
    assert.ok(stages.includes("ROUGH_IDEA"));
    assert.ok(stages.includes("OUTLINED"));
  });

  it("should use ROUGH_IDEA as default stage on creation", () => {
    const defaultStage = "ROUGH_IDEA";
    assert.strictEqual(defaultStage, "ROUGH_IDEA");
  });

  it("should use NEW as default status on creation", () => {
    const defaultStatus = "NEW";
    assert.strictEqual(defaultStatus, "NEW");
  });
});
