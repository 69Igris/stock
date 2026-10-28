/**
 * Glossary Data Tests
 *
 * Tests for the financial glossary data module: term structure,
 * alphabetical ordering, uniqueness, and content coverage for
 * A-Z and numeric entries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  glossaryTerms,
  type GlossaryTerm,
} from "../../app/help/lib/glossary-data";

describe("Glossary Data", () => {
  describe("structure", () => {
    it("should export an array of terms", () => {
      assert.ok(Array.isArray(glossaryTerms));
      assert.ok(glossaryTerms.length > 0);
    });

    it("should have at least 100 terms", () => {
      assert.ok(
        glossaryTerms.length >= 100,
        `Only ${glossaryTerms.length} terms (expected 100+)`
      );
    });

    it("should have all required fields on every term", () => {
      for (const term of glossaryTerms) {
        assert.ok(
          term.term && term.term.trim().length > 0,
          "Term has empty name"
        );
        assert.ok(
          term.definition && term.definition.trim().length > 0,
          `Term "${term.term}" has empty definition`
        );
      }
    });
  });

  describe("uniqueness", () => {
    it("should have unique term names", () => {
      const names = glossaryTerms.map((t: GlossaryTerm) => t.term);
      const unique = new Set(names);
      assert.strictEqual(
        unique.size,
        names.length,
        `Duplicate terms: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`
      );
    });
  });

  describe("alphabetical coverage", () => {
    it("should have terms starting with A through Z", () => {
      const letters = new Set(
        glossaryTerms
          .map((t: GlossaryTerm) => t.term[0].toUpperCase())
          .filter((c: string) => /[A-Z]/.test(c))
      );
      const missing: string[] = [];
      for (let code = 65; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        // J and Q have no common financial terms, skip
        if (letter === "J" || letter === "Q") continue;
        if (!letters.has(letter)) {
          missing.push(letter);
        }
      }
      assert.strictEqual(
        missing.length,
        0,
        `Missing letters: ${missing.join(", ")}`
      );
    });

    it("should have numeric/special character entries", () => {
      const hasNumeric = glossaryTerms.some((t: GlossaryTerm) =>
        /^\d/.test(t.term)
      );
      assert.ok(
        hasNumeric,
        "Should have at least one term starting with a digit"
      );
    });

    it("should be sorted alphabetically within each letter group", () => {
      // Group by first character
      const groups = new Map<string, string[]>();
      for (const t of glossaryTerms) {
        const key = /\d/.test(t.term[0]) ? "#" : t.term[0].toUpperCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(t.term);
      }
      for (const [letter, terms] of Array.from(groups)) {
        const sorted = [...terms].sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: "base" })
        );
        assert.deepStrictEqual(
          terms,
          sorted,
          `Terms under "${letter}" are not sorted: ${terms.join(", ")}`
        );
      }
    });
  });

  describe("content quality", () => {
    it("definitions should be at least 30 characters", () => {
      for (const term of glossaryTerms) {
        assert.ok(
          term.definition.length >= 30,
          `Definition too short for "${term.term}": ${term.definition.length} chars`
        );
      }
    });

    it("definitions should not exceed 300 characters", () => {
      for (const term of glossaryTerms) {
        assert.ok(
          term.definition.length <= 300,
          `Definition too long for "${term.term}": ${term.definition.length} chars`
        );
      }
    });

    it("terms should not be longer than 30 characters", () => {
      for (const term of glossaryTerms) {
        assert.ok(
          term.term.length <= 30,
          `Term name too long: "${term.term}" (${term.term.length} chars)`
        );
      }
    });
  });

  describe("key financial terms", () => {
    const essentialTerms = [
      "P/E Ratio",
      "EPS",
      "NAV",
      "SIP",
      "FIRE",
      "FIFO",
      "Nifty 50",
      "Sensex",
      "SEBI",
      "NSE",
      "BSE",
      "Market Cap",
      "Mutual Fund",
      "IPO",
      "Demat Account",
      "LTCG",
      "STCG",
      "ROE",
      "ROCE",
      "F&O",
    ];

    for (const expected of essentialTerms) {
      it(`should include essential term: ${expected}`, () => {
        const found = glossaryTerms.some(
          (t: GlossaryTerm) => t.term === expected
        );
        assert.ok(found, `Missing essential term: ${expected}`);
      });
    }
  });
});
