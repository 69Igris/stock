/**
 * Prompt Library Data Tests
 *
 * Tests for the prompt library data module: categories, prompts,
 * type integrity, uniqueness constraints, and category coverage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categories,
  prompts,
  type PromptCategory,
  type PromptItem,
  type CategoryConfig,
} from "../../app/help/lib/prompt-library";

describe("Prompt Library", () => {
  describe("categories", () => {
    it("should export an array of categories", () => {
      assert.ok(Array.isArray(categories));
      assert.ok(categories.length > 0);
    });

    it("should have exactly 8 categories", () => {
      assert.strictEqual(categories.length, 8);
    });

    it("should have unique category ids", () => {
      const ids = categories.map((c: CategoryConfig) => c.id);
      const unique = new Set(ids);
      assert.strictEqual(
        unique.size,
        ids.length,
        "Category IDs must be unique"
      );
    });

    it("should have all required fields on every category", () => {
      for (const cat of categories) {
        assert.ok(cat.id, `Category missing id`);
        assert.ok(cat.label, `Category ${cat.id} missing label`);
        assert.ok(cat.description, `Category ${cat.id} missing description`);
        assert.ok(cat.icon, `Category ${cat.id} missing icon`);
        assert.ok(cat.color, `Category ${cat.id} missing color`);
      }
    });

    it("should have the expected category ids", () => {
      // "paper-trading" category was removed 2026-05-28 per product decision
      // (the type member is retained for filter components, but no category
      // config or prompts reference it anymore).
      const expected: PromptCategory[] = [
        "stock-analysis",
        "screening",
        "comparison",
        "portfolio-intel",
        "market-discovery",
        "holdings-trades",
        "mutual-funds",
        "fire",
      ];
      const ids = categories.map((c: CategoryConfig) => c.id);
      for (const id of expected) {
        assert.ok(ids.includes(id), `Missing category: ${id}`);
      }
    });

    it("should have color strings containing tailwind classes", () => {
      for (const cat of categories) {
        assert.ok(
          cat.color.includes("bg-") || cat.color.includes("text-"),
          `Category ${cat.id} color should contain Tailwind classes`
        );
      }
    });
  });

  describe("prompts", () => {
    it("should export an array of prompts", () => {
      assert.ok(Array.isArray(prompts));
      assert.ok(prompts.length > 0);
    });

    it("should have at least 60 prompts", () => {
      assert.ok(
        prompts.length >= 60,
        `Expected at least 60 prompts, got ${prompts.length}`
      );
    });

    it("should have unique prompt ids", () => {
      const ids = prompts.map((p: PromptItem) => p.id);
      const unique = new Set(ids);
      assert.strictEqual(
        unique.size,
        ids.length,
        `Found duplicate IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`
      );
    });

    it("should have all required fields on every prompt", () => {
      for (const prompt of prompts) {
        assert.ok(prompt.id, "Prompt missing id");
        assert.ok(prompt.label, `Prompt ${prompt.id} missing label`);
        assert.ok(
          prompt.description,
          `Prompt ${prompt.id} missing description`
        );
        assert.ok(prompt.prompt, `Prompt ${prompt.id} missing prompt text`);
        assert.ok(prompt.icon, `Prompt ${prompt.id} missing icon`);
        assert.ok(prompt.category, `Prompt ${prompt.id} missing category`);
      }
    });

    it("should only reference valid categories", () => {
      const validCategories = new Set(
        categories.map((c: CategoryConfig) => c.id)
      );
      for (const prompt of prompts) {
        assert.ok(
          validCategories.has(prompt.category),
          `Prompt ${prompt.id} has invalid category: ${prompt.category}`
        );
      }
    });

    it("should have non-empty prompt text for every entry", () => {
      for (const prompt of prompts) {
        assert.ok(
          prompt.prompt.trim().length > 10,
          `Prompt ${prompt.id} has very short prompt text`
        );
      }
    });

    it("should not have extremely long prompt text", () => {
      for (const prompt of prompts) {
        assert.ok(
          prompt.prompt.length < 200,
          `Prompt ${prompt.id} has prompt text over 200 chars`
        );
      }
    });
  });

  describe("category coverage", () => {
    it("every category should have at least 5 prompts", () => {
      for (const cat of categories) {
        const count = prompts.filter(
          (p: PromptItem) => p.category === cat.id
        ).length;
        assert.ok(
          count >= 5,
          `Category ${cat.id} only has ${count} prompts (min 5)`
        );
      }
    });

    it("should have expected prompt counts per category", () => {
      const counts: Record<string, number> = {};
      for (const p of prompts) {
        counts[p.category] = (counts[p.category] || 0) + 1;
      }
      assert.strictEqual(counts["stock-analysis"], 12);
      assert.strictEqual(counts["screening"], 8);
      assert.strictEqual(counts["comparison"], 6);
      // 8 → 6: "risk-analysis" + "tax-analysis" commented out alongside the
      // /risk and /tax slash commands.
      assert.strictEqual(counts["portfolio-intel"], 6);
      assert.strictEqual(counts["market-discovery"], 7);
      assert.strictEqual(counts["holdings-trades"], 8);
      assert.strictEqual(counts["mutual-funds"], 6);
      assert.strictEqual(counts["fire"], 7);
      // "paper-trading" (6 prompts) removed 2026-05-28 per product decision.
    });

    it("total prompts across categories should equal total prompts", () => {
      let sum = 0;
      for (const cat of categories) {
        sum += prompts.filter((p: PromptItem) => p.category === cat.id).length;
      }
      assert.strictEqual(sum, prompts.length);
    });
  });

  describe("prompt content quality", () => {
    it("labels should be title-cased or short", () => {
      for (const prompt of prompts) {
        assert.ok(
          prompt.label.length > 0 && prompt.label.length <= 30,
          `Prompt ${prompt.id} label too long: "${prompt.label}"`
        );
      }
    });

    it("descriptions should be concise", () => {
      for (const prompt of prompts) {
        assert.ok(
          prompt.description.length > 0 && prompt.description.length <= 60,
          `Prompt ${prompt.id} description too long (${prompt.description.length} chars)`
        );
      }
    });

    it("ids should be kebab-case", () => {
      const kebabRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
      for (const prompt of prompts) {
        assert.ok(
          kebabRegex.test(prompt.id),
          `Prompt ID "${prompt.id}" is not kebab-case`
        );
      }
    });
  });

  describe("tier and credits metadata", () => {
    it("prompts with tier should have valid tier values", () => {
      for (const prompt of prompts) {
        if (prompt.tier) {
          assert.ok(
            ["L1", "L2", "L3"].includes(prompt.tier),
            `Prompt ${prompt.id} has invalid tier: ${prompt.tier}`
          );
        }
      }
    });

    it("prompts with tier should have credits defined", () => {
      for (const prompt of prompts) {
        if (prompt.tier) {
          assert.ok(
            prompt.credits !== undefined && prompt.credits >= 0,
            `Prompt ${prompt.id} has tier but missing/invalid credits`
          );
        }
      }
    });

    it("prompts with estimatedTime should have valid values", () => {
      const validTimes = ["instant", "~30s", "~2min", "~5min"];
      for (const prompt of prompts) {
        if (prompt.estimatedTime) {
          assert.ok(
            validTimes.includes(prompt.estimatedTime),
            `Prompt ${prompt.id} has invalid estimatedTime: ${prompt.estimatedTime}`
          );
        }
      }
    });

    it("stock-analysis category should have tiered prompts", () => {
      const analysisPrompts = prompts.filter(
        (p: PromptItem) => p.category === "stock-analysis"
      );
      const tiered = analysisPrompts.filter((p: PromptItem) => p.tier);
      assert.ok(
        tiered.length >= 8,
        `stock-analysis should have at least 8 tiered prompts, got ${tiered.length}`
      );
    });
  });
});
