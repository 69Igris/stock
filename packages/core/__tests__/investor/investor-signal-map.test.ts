/**
 * Behaviour-signal → concept maps (MONEY-788, B3).
 *
 * Asserts the pure capture-time translation layer: every right-hand-side slug
 * in every map resolves to a real concept in the taxonomy, the research/chat
 * lookups dedupe + degrade gracefully on unknown inputs, and the mode →
 * difficulty helper buckets correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getConcept } from "../../src/investor/concepts";
import {
  CHAT_INTENT_CONCEPT_MAP,
  ROAST_CONCEPTS,
  SKILL_CONCEPT_MAP,
  conceptsForChatIntent,
  conceptsForResearch,
  difficultyForMode,
} from "../../src/investor/signal-map";

describe("signal-map · slug integrity", () => {
  it("every SKILL_CONCEPT_MAP slug resolves to a real concept", () => {
    for (const [skill, slugs] of Object.entries(SKILL_CONCEPT_MAP)) {
      assert.ok(slugs.length > 0, `skill "${skill}" maps to no concepts`);
      for (const slug of slugs) {
        assert.ok(
          getConcept(slug),
          `skill "${skill}" maps to unknown concept "${slug}"`,
        );
      }
    }
  });

  it("every CHAT_INTENT_CONCEPT_MAP slug resolves to a real concept", () => {
    for (const [tool, slugs] of Object.entries(CHAT_INTENT_CONCEPT_MAP)) {
      for (const slug of slugs) {
        assert.ok(
          getConcept(slug),
          `chat intent "${tool}" maps to unknown concept "${slug}"`,
        );
      }
    }
  });

  it("every ROAST_CONCEPTS slug resolves to a real concept", () => {
    assert.ok(ROAST_CONCEPTS.length > 0);
    for (const slug of ROAST_CONCEPTS) {
      assert.ok(getConcept(slug), `roast concept "${slug}" does not exist`);
    }
  });

  it("general_chat maps to no concepts", () => {
    assert.deepEqual(CHAT_INTENT_CONCEPT_MAP.general_chat, []);
  });
});

describe("conceptsForResearch", () => {
  it("maps known skills to their concept set", () => {
    assert.deepEqual(conceptsForResearch("stock-analysis", []), [
      "asset.equity",
      "valuation.pe-ratio",
    ]);
    assert.deepEqual(conceptsForResearch("tax-analysis", []), [
      "tax.stcg",
      "tax.ltcg",
      "tax.harvesting",
    ]);
    assert.deepEqual(conceptsForResearch("mf-analysis", []), [
      "asset.mutual-fund",
      "asset.etf",
    ]);
  });

  it("treats peer-comparison and multi-comparison as the same set", () => {
    assert.deepEqual(
      conceptsForResearch("peer-comparison", []),
      conceptsForResearch("multi-comparison", []),
    );
  });

  it("returns [] for an unknown skill", () => {
    assert.deepEqual(conceptsForResearch("not-a-real-skill", []), []);
  });

  it("returns [] when skill is undefined", () => {
    assert.deepEqual(conceptsForResearch(undefined, ["INFY"]), []);
  });

  it("dedupes any repeated slugs", () => {
    for (const skill of Object.keys(SKILL_CONCEPT_MAP)) {
      const out = conceptsForResearch(skill, []);
      assert.equal(
        new Set(out).size,
        out.length,
        `skill "${skill}" yields duplicate slugs`,
      );
    }
  });
});

describe("conceptsForChatIntent", () => {
  it("maps known intents", () => {
    assert.deepEqual(conceptsForChatIntent("run_roast"), [
      "portfolio.diversification",
      "risk.concentration",
    ]);
    assert.deepEqual(conceptsForChatIntent("tax_analysis"), [
      "tax.stcg",
      "tax.ltcg",
    ]);
  });

  it("returns [] for general_chat, an unknown tool, and undefined", () => {
    assert.deepEqual(conceptsForChatIntent("general_chat"), []);
    assert.deepEqual(conceptsForChatIntent("not_a_tool"), []);
    assert.deepEqual(conceptsForChatIntent(undefined), []);
  });
});

describe("difficultyForMode", () => {
  it("maps fast → EASY", () => {
    assert.equal(difficultyForMode("fast"), "EASY");
  });

  it("maps advanced + comprehensive → HARD", () => {
    assert.equal(difficultyForMode("advanced"), "HARD");
    assert.equal(difficultyForMode("comprehensive"), "HARD");
  });

  it("maps anything else (incl. undefined) → MODERATE", () => {
    assert.equal(difficultyForMode(undefined), "MODERATE");
    assert.equal(difficultyForMode("balanced"), "MODERATE");
    assert.equal(difficultyForMode(""), "MODERATE");
  });
});

describe("signal-map · bounded fan-out (DoS invariant)", () => {
  // `capture.ts` caps concept nudges at MAX_CONCEPTS_PER_CAPTURE (8). These
  // assertions document that no static map entry even approaches that cap, so a
  // single research/chat/roast capture can never spawn an unbounded write storm
  // (the cap is belt-and-braces for a future mis-edit).
  const CAP = 8;

  it("no SKILL_CONCEPT_MAP entry exceeds the capture cap", () => {
    for (const [skill, slugs] of Object.entries(SKILL_CONCEPT_MAP)) {
      assert.ok(
        slugs.length <= CAP,
        `skill "${skill}" maps to ${slugs.length} concepts (> ${CAP})`,
      );
    }
  });

  it("no CHAT_INTENT_CONCEPT_MAP entry exceeds the capture cap", () => {
    for (const [tool, slugs] of Object.entries(CHAT_INTENT_CONCEPT_MAP)) {
      assert.ok(
        slugs.length <= CAP,
        `intent "${tool}" maps to ${slugs.length} concepts (> ${CAP})`,
      );
    }
  });

  it("ROAST_CONCEPTS stays within the cap", () => {
    assert.ok(ROAST_CONCEPTS.length <= CAP);
  });

  it("conceptsForResearch ignores symbols entirely (skill alone drives the set)", () => {
    const many = Array.from({ length: 500 }, (_, i) => `SYM${i}`);
    const withSymbols = conceptsForResearch("stock-analysis", many);
    const without = conceptsForResearch("stock-analysis", []);
    assert.deepEqual(
      withSymbols,
      without,
      "a 500-symbol run must not enlarge the concept set",
    );
    assert.ok(withSymbols.length <= CAP);
  });
});
