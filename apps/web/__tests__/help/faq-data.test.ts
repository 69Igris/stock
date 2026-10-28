/**
 * FAQ Data Tests
 *
 * Tests for the FAQ data module: section structure, question/answer
 * integrity, uniqueness, and content quality checks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  faqSections,
  type FAQSection,
  type FAQItem,
} from "../../app/help/lib/faq-data";

describe("FAQ Data", () => {
  describe("sections", () => {
    it("should export an array of sections", () => {
      assert.ok(Array.isArray(faqSections));
      assert.ok(faqSections.length > 0);
    });

    it("should have exactly 7 sections", () => {
      assert.strictEqual(faqSections.length, 7);
    });

    it("should have unique section ids", () => {
      const ids = faqSections.map((s: FAQSection) => s.id);
      const unique = new Set(ids);
      assert.strictEqual(unique.size, ids.length, "Section IDs must be unique");
    });

    it("should have unique section titles", () => {
      const titles = faqSections.map((s: FAQSection) => s.title);
      const unique = new Set(titles);
      assert.strictEqual(
        unique.size,
        titles.length,
        "Section titles must be unique"
      );
    });

    it("should have all required fields on every section", () => {
      for (const section of faqSections) {
        assert.ok(section.id, "Section missing id");
        assert.ok(section.title, `Section ${section.id} missing title`);
        assert.ok(section.icon, `Section ${section.id} missing icon`);
        assert.ok(
          Array.isArray(section.items),
          `Section ${section.id} missing items array`
        );
      }
    });

    it("should have the expected section ids", () => {
      // "paper-trading" section was removed 2026-05-28 per product decision.
      const expected = [
        "account-billing",
        "broker-data",
        "ai-chat",
        "portfolio-analytics",
        "fire-planning",
        "features-market",
        "security-privacy",
      ];
      const ids = faqSections.map((s: FAQSection) => s.id);
      for (const id of expected) {
        assert.ok(ids.includes(id), `Missing section: ${id}`);
      }
    });
  });

  describe("FAQ items", () => {
    it("every section should have at least 4 items", () => {
      for (const section of faqSections) {
        assert.ok(
          section.items.length >= 4,
          `Section "${section.title}" only has ${section.items.length} items (min 4)`
        );
      }
    });

    it("should have all required fields on every FAQ item", () => {
      for (const section of faqSections) {
        for (const item of section.items) {
          assert.ok(
            item.question && item.question.trim().length > 0,
            `Empty question in section "${section.title}"`
          );
          assert.ok(
            item.answer && item.answer.trim().length > 0,
            `Empty answer in section "${section.title}"`
          );
        }
      }
    });

    it("questions should end with a question mark", () => {
      for (const section of faqSections) {
        for (const item of section.items) {
          assert.ok(
            item.question.trim().endsWith("?"),
            `Question doesn't end with '?': "${item.question}"`
          );
        }
      }
    });

    it("answers should be at least 50 characters", () => {
      for (const section of faqSections) {
        for (const item of section.items) {
          assert.ok(
            item.answer.length >= 50,
            `Answer too short in "${section.title}": "${item.answer.substring(0, 40)}..."`
          );
        }
      }
    });

    it("should have unique questions across all sections", () => {
      const allQuestions: string[] = [];
      for (const section of faqSections) {
        for (const item of section.items) {
          allQuestions.push(item.question);
        }
      }
      const unique = new Set(allQuestions);
      assert.strictEqual(
        unique.size,
        allQuestions.length,
        "Duplicate questions found"
      );
    });
  });

  describe("total count", () => {
    it("should have a reasonable total number of FAQ items", () => {
      let total = 0;
      for (const section of faqSections) {
        total += section.items.length;
      }
      assert.ok(total >= 30, `Only ${total} total FAQ items (expected 30+)`);
      assert.ok(total <= 100, `Too many FAQ items: ${total}`);
    });
  });

  describe("icon values", () => {
    it("every section should have a valid icon string", () => {
      const validIcons = [
        "CreditCard",
        "Link2",
        "Sparkles",
        "PieChart",
        "FileSpreadsheet",
        "Flame",
        "IndianRupee",
        "Shield",
      ];
      for (const section of faqSections) {
        assert.ok(
          validIcons.includes(section.icon),
          `Section "${section.title}" has unexpected icon: ${section.icon}`
        );
      }
    });
  });
});
