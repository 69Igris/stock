/**
 * Real-estate industry matcher (MONEY-1093).
 *
 * This decides, from FREE TEXT, which companies get moved into a different
 * sector — and a free-text heuristic already cost a bug on this ticket: a
 * bond-symbol regex looked sound and, measured against prod, hit 2,236 wrong
 * rows while missing 9,043.
 *
 * The reason it cannot be reasoned about from Yahoo's vocabulary alone is that
 * `InstrumentMapping.industry` has three provenances:
 *
 *   - Yahoo's closed taxonomy ("Real Estate - Development", "Mortgage Finance",
 *     "Engineering & Construction");
 *   - UNVALIDATED Gemini free text, written by `enrich-sectors-gemini.ts` for
 *     rows with no sector — i.e. exactly this ticket's target population;
 *   - on-demand enrichment via `stock-sector.ts`.
 *
 * "realty" does not exist in Yahoo's taxonomy at all, so that rule fires
 * exclusively on model output. The cases below are therefore split into
 * Yahoo-shaped strings and model-shaped ones.
 *
 * Source: packages/core/src/market-data/instruments/real-estate-industry-match.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyIndustry,
  INDUSTRY_MATCHES,
  NEAR_MISSES,
  isInfraTrust,
  INFRA_TRUST_SYMBOLS,
} from "../../src/market-data/instruments/real-estate-industry-match";

describe("Yahoo-shaped strings — the predictable half", () => {
  it("matches the real-estate industries", () => {
    for (const s of [
      "Real Estate - Development",
      "Real Estate Services",
      "Real Estate - Diversified",
    ]) {
      assert.equal(classifyIndustry(s).verdict, "match", s);
    }
  });

  it("does NOT match housing finance or mortgage lenders", () => {
    // LIC Housing Finance, PNB Housing, Can Fin Homes, Repco, GIC Housing,
    // Aavas, Home First, Aptus all file as Mortgage Finance. They lend against
    // property; they do not own it.
    for (const s of ["Mortgage Finance", "Credit Services"]) {
      assert.notEqual(classifyIndustry(s).verdict, "match", s);
    }
  });

  it("does NOT match EPC / construction firms", () => {
    // NCC, Ahluwalia, Kalpataru Projects, PNC Infratech, HG Infra, Dilip
    // Buildcon all file as Engineering & Construction.
    const r = classifyIndustry("Engineering & Construction");
    assert.equal(r.verdict, "near-miss");
    assert.equal(r.nearMiss, "construction");
  });
});

describe("model-shaped strings — the half that actually needs guarding", () => {
  it("treats a string hitting BOTH lists as ambiguous, and does NOT move it", () => {
    // The exact failure the first version could not see: it checked the match
    // list, returned on the first hit, and only consulted the near-miss list
    // when nothing matched. So this was silently MOVED and never appeared in
    // the near-miss report that existed to surface it.
    for (const s of [
      "Housing Finance / Real Estate",
      "Real Estate Finance",
      "Real Estate & Construction",
      "Realty and Infrastructure",
    ]) {
      const r = classifyIndustry(s);
      assert.equal(r.verdict, "ambiguous", `"${s}" must not be auto-moved`);
      assert.ok(r.match, "should still record which term matched");
      assert.ok(r.nearMiss, "should still record which term conflicted");
    }
  });

  it("matches an unambiguous model string", () => {
    assert.equal(classifyIndustry("Realty").verdict, "match");
    assert.equal(classifyIndustry("Real Estate Developer").verdict, "match");
  });

  it("is case-insensitive", () => {
    assert.equal(
      classifyIndustry("REAL ESTATE - DEVELOPMENT").verdict,
      "match",
    );
    assert.equal(classifyIndustry("realty").verdict, "match");
  });
});

describe('"reit" is word-bounded, not a bare substring', () => {
  it("matches a real REIT industry", () => {
    for (const s of ["REIT - Retail", "REIT—Diversified", "Equity REIT"]) {
      assert.equal(classifyIndustry(s).verdict, "match", s);
    }
  });

  it("does NOT fire on the letters appearing inside another word", () => {
    // A bare includes("reit") is applied to free text, so a model returning
    // e.g. a German/Dutch-derived word, or "Freight", would have matched.
    for (const s of [
      "Freight & Logistics",
      "Preitzel Foods",
      "Sureity Bonds",
    ]) {
      assert.notEqual(
        classifyIndustry(s).verdict,
        "match",
        `"${s}" must not match on the letters r-e-i-t`,
      );
    }
  });
});

describe("abstention", () => {
  it("returns none for an empty or absent industry", () => {
    for (const s of [null, "", "   "]) {
      assert.equal(classifyIndustry(s).verdict, "none");
    }
  });

  it("returns none for an unrelated industry", () => {
    for (const s of ["Software - Application", "Steel", "Pharmaceuticals"]) {
      assert.equal(classifyIndustry(s).verdict, "none", s);
    }
  });
});

describe("the two lists cannot silently overlap each other", () => {
  it("no term appears in both lists", () => {
    // If one did, every string containing it would be permanently ambiguous
    // and nothing would ever move — a silent no-op rather than an error.
    for (const m of INDUSTRY_MATCHES) {
      assert.ok(
        !NEAR_MISSES.includes(m as never),
        `"${m}" is in both INDUSTRY_MATCHES and NEAR_MISSES`,
      );
    }
  });

  it("every near-miss term is reachable — none is shadowed by a match term", () => {
    // A near-miss term that always co-occurs with a match term would only ever
    // produce "ambiguous", never "near-miss", making the rejection report empty
    // and misleading.
    for (const nm of NEAR_MISSES) {
      const r = classifyIndustry(nm);
      assert.equal(
        r.verdict,
        "near-miss",
        `"${nm}" alone should classify as near-miss, got ${r.verdict}`,
      );
    }
  });
});

// ── Infrastructure trusts must never be swept into Real Estate ──────────

/**
 * The full population, kept as DATA so the claim about it is measurable.
 *
 * This exists because the exclusion was wrong twice while being described as
 * correct — first as an enumeration of the four instances a review surfaced,
 * then as a "shape-based" pattern that still could not match INDINFRAVIT. Each
 * time the evidence was a throwaway script, so nothing carried forward. If a
 * new trust lists, add it here and the assertion below measures the outcome
 * instead of anyone asserting completeness in a comment.
 */
const INFRA_TRUSTS: Array<[string, string]> = [
  ["INDIGRID", "INDIA GRID TRUST"],
  ["PGINVIT", "POWERGRID INFRASTRUCTURE INVESTMENT TRUST"],
  ["IRBINVIT", "IRB INVIT FUND"],
  ["NHIT", "NATIONAL HIGHWAYS INFRA TRUST"],
  ["ROADSTAR", "ROADSTAR INFRA INVESTMENT TRUST"],
  ["HIGHWAYS", "HIGHWAYS INFRASTRUCTURE TRUST"],
  ["DATAINFRA", "DATA INFRASTRUCTURE TRUST"],
  ["INDIAINFRA", "INDIA INFRASTRUCTURE TRUST"],
  ["ORIENTAL", "ORIENTAL INFRATRUST"],
  ["MAPLE", "MAPLE INFRASTRUCTURE TRUST"],
  ["CUBE", "CUBE HIGHWAYS TRUST"],
  ["ANZEN", "ANZEN INDIA ENERGY YIELD PLUS TRUST"],
  ["ENERGYINFRA", "ENERGY INFRASTRUCTURE TRUST"],
  ["INDINFRAVIT", "INDINFRAVIT TRUST"],
  ["INTERISE", "INTERISE TRUST"],
];

/** Real estate that must NOT be excluded — the other half of the invariant. */
const REAL_ESTATE_CONTROLS: Array<[string, string]> = [
  ["EMBASSY", "EMBASSY OFFICE PARKS REIT"],
  ["MINDSPACE", "MINDSPACE BUSINESS PARKS REIT"],
  ["BIRET", "BROOKFIELD INDIA REAL ESTATE TRUST"],
  ["NXST", "NEXUS SELECT TRUST"],
  ["KNOWLEDGE", "KNOWLEDGE REALTY TRUST"],
  ["DLF", "DLF LTD"],
  ["GODREJPROP", "GODREJ PROPERTIES LTD"],
  ["OBEROIRLTY", "OBEROI REALTY LTD"],
  ["PRESTIGE", "PRESTIGE ESTATES PROJECTS LTD"],
];

describe("isInfraTrust", () => {
  it("excludes every known infrastructure trust", () => {
    const missed = INFRA_TRUSTS.filter(([s, n]) => !isInfraTrust(s, n));
    assert.deepEqual(
      missed.map(([s]) => s),
      [],
      "these would be MOVED INTO Real Estate, which they are not",
    );
  });

  it("keeps every real-estate entity — the pattern must not over-reach", () => {
    // BROOKFIELD INDIA REAL ESTATE TRUST and KNOWLEDGE REALTY TRUST are the
    // dangerous ones: both end in TRUST, so a lazier pattern excludes them and
    // the script then silently declines to fix real REITs.
    const wrong = REAL_ESTATE_CONTROLS.filter(([s, n]) => isInfraTrust(s, n));
    assert.deepEqual(
      wrong.map(([s]) => s),
      [],
      "these are real estate and MUST be moved",
    );
  });

  it("matches INFRA mid-token, not only at a word boundary", () => {
    // The specific regression: `\bINFRA` cannot match inside "INDINFRAVIT"
    // because there is no word boundary between IND and INFRA.
    assert.equal(isInfraTrust("INDINFRAVIT", "INDINFRAVIT TRUST"), true);
    assert.equal(isInfraTrust("ORIENTAL", "ORIENTAL INFRATRUST"), true);
  });

  it("covers the no-shape cases by explicit symbol", () => {
    // INTERISE has no infra/grid/highway/invit/yield token in any form, so it
    // can only be caught by the list. Pinned so the list is not "tidied away"
    // by someone who believes the pattern is exhaustive.
    for (const sym of INFRA_TRUST_SYMBOLS) {
      assert.equal(isInfraTrust(sym, "SOME TRUST"), true, sym);
      assert.equal(isInfraTrust(sym.toLowerCase(), null), true, sym);
    }
  });

  it("tolerates an absent name", () => {
    assert.equal(isInfraTrust("INDIGRID", null), false);
    assert.equal(isInfraTrust("INDIGRID", undefined), false);
    // Symbol alone carries the signal only for the enumerated set; a name-shaped
    // trust with no name is correctly NOT excluded, which is the safe direction
    // (it falls through to the industry matcher, which vetoes on ambiguity).
  });
});
