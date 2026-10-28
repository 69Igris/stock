/**
 * The shared sector-keyword matcher (MONEY-1093).
 *
 * This rule was written five times as `haystack.includes(key)` and fixed twice
 * in place; the second fix's comment claimed the sweep was complete and three
 * copies survived it. So the behaviour is pinned here once, with the two
 * regressions each fix introduced as explicit cases, and every consumer imports
 * the function rather than re-deriving a regex.
 *
 * Source: packages/core/src/market-data/instruments/sector-key-match.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sectorKeyMatches,
  anySectorKeyMatches,
  firstMatchingSectorKey,
} from "../../src/market-data/instruments/sector-key-match";
import { getAllSectorNames } from "../../src/market-data/instruments/sector-taxonomy";

describe('the infix-"it" defect — the reason this module exists', () => {
  it('does NOT match "it" inside utilities or commodities', () => {
    // The whole bug: `"utilities".includes("it") === true`. Utilities and
    // Commodities were classified as Information Technology, so a Tata
    // Power or Tata Steel holding was graded against IT benchmarks, told a pure
    // IT shock cost it 20%, and counted as a mid-cycle sector.
    for (const sector of [
      "Utilities",
      "utilities",
      "Commodities",
      "Metals & Commodities",
      "Utilities & Power",
    ]) {
      assert.equal(
        sectorKeyMatches(sector, "it"),
        false,
        `"${sector}" must not match the key "it"`,
      );
    }
  });

  it('DOES match "it" where it genuinely is the sector', () => {
    for (const sector of [
      "IT",
      "it",
      "Information Technology",
      "information technology",
      "IT - Software",
      "Banking & IT",
    ]) {
      assert.equal(
        sectorKeyMatches(sector, "it"),
        true,
        `"${sector}" must match the key "it"`,
      );
    }
  });

  it('does NOT match "it" at the START of an unrelated name', () => {
    // Regression #1, from the first attempt at this fix: a start-anchor alone
    // (`\bit`) matches "ITC" — a top-10 NSE name in this repo's own FMCG
    // basket — so "ITC sector analysis" returned a report built from TCS,
    // Infosys and Wipro.
    for (const sector of ["ITC", "ITC Ltd", "Itinerary", "Item Rate"]) {
      assert.equal(sectorKeyMatches(sector, "it"), false, sector);
    }
  });

  it("still matches the CANONICAL spelling, which \\bit\\b alone loses", () => {
    // Regression #2, from the second attempt: anchoring both ends stopped
    // "Information Technology" matching — the canonical NSE name, and the single
    // most important thing this key has to match.
    assert.equal(sectorKeyMatches("Information Technology", "it"), true);
    assert.equal(sectorKeyMatches("Information  Technology", "it"), true);
    assert.equal(sectorKeyMatches("InformationTech", "it"), true);
  });
});

describe("longer keys keep a loose tail", () => {
  it("matches plurals and suffixes", () => {
    // Anchoring both ends on longer keys breaks real matches, which is why only
    // 2-char keys get the closing anchor.
    const cases: Array<[string, string]> = [
      ["Financials", "financial"],
      ["Banking & Financials", "financial"],
      ["Financial Services", "financial"],
      ["Pharmaceuticals", "pharma"],
      ["Automobile", "auto"],
      ["Automotive", "auto"],
      ["Real Estate - Development", "real estate"],
    ];
    for (const [sector, key] of cases) {
      assert.equal(sectorKeyMatches(sector, key), true, `${sector} / ${key}`);
    }
  });

  it("stays anchored at the START, so it is not a bare substring", () => {
    assert.equal(sectorKeyMatches("Refinancing", "financ"), false);
    assert.equal(
      sectorKeyMatches("Autocorrelation Services", "correlation"),
      false,
    );
  });

  it("tolerates any run of whitespace inside a multi-word key", () => {
    assert.equal(sectorKeyMatches("Oil  &  Gas", "oil & gas"), true);
    assert.equal(sectorKeyMatches("Capital   Goods", "capital goods"), true);
  });
});

describe("degenerate input", () => {
  it("returns false rather than throwing or matching everything", () => {
    for (const sector of ["", "   "]) {
      assert.equal(sectorKeyMatches(sector, "it"), false);
    }
    // An empty KEY must not match every sector — `"".includes("")` is true, and
    // a regex built from "" matches anything.
    assert.equal(sectorKeyMatches("Utilities", ""), false);
  });
});

describe("the list helpers", () => {
  it("anySectorKeyMatches is the includes-over-a-list replacement", () => {
    const MID_CYCLE = ["industrials", "it", "technology", "software"];
    assert.equal(
      anySectorKeyMatches("Information Technology", MID_CYCLE),
      true,
    );
    assert.equal(anySectorKeyMatches("Industrials", MID_CYCLE), true);
    // The two that were wrongly landing in this bucket:
    assert.equal(anySectorKeyMatches("Utilities", MID_CYCLE), false);
    assert.equal(anySectorKeyMatches("Commodities", MID_CYCLE), false);
  });

  it("firstMatchingSectorKey reports WHICH key won, in caller order", () => {
    assert.equal(
      firstMatchingSectorKey("Financial Services", ["services", "financial"]),
      "services",
      "first match wins — ordering is the caller's responsibility",
    );
    assert.equal(
      firstMatchingSectorKey("Financial Services", ["financial", "services"]),
      "financial",
    );
    assert.equal(firstMatchingSectorKey("Utilities", ["it", "tech"]), null);
  });
});

describe("every canonical sector resolves predictably", () => {
  // A completeness sweep over the real taxonomy. Its value is that a future
  // taxonomy change (a renamed or added sector) shows up HERE as a change in the
  // mapping, rather than silently as a sector that quietly stops matching any
  // keyword — which is exactly how Real Estate, Commodities and Healthcare each
  // came to fall through to a default.
  const KEYS = [
    "it",
    "financial",
    "healthcare",
    "pharma",
    "real estate",
    "realty",
    "energy",
    "consumer",
    "industrial",
    "commodities",
    "metal",
    "fmcg",
    "telecom",
    "utilit",
    "services",
    "diversified",
  ];

  it("maps each of the 13 canonical names to a stable key", () => {
    const resolved = new Map<string, string | null>();
    for (const name of getAllSectorNames()) {
      resolved.set(name, firstMatchingSectorKey(name, KEYS));
    }

    // Pinned explicitly — the two that were BROKEN are the interesting rows.
    assert.equal(resolved.get("Information Technology"), "it");
    assert.equal(resolved.get("Financial Services"), "financial");
    assert.equal(
      resolved.get("Healthcare"),
      "healthcare",
      'Healthcare must reach its own key, not fall through — the scenario tables carry a "pharma" bucket it could not match',
    );
    assert.equal(
      resolved.get("Commodities"),
      "commodities",
      'Commodities must reach its own key — the scenario tables carry a "metal" bucket it could not match, so a Tata Steel holding was modelled at defaultImpact',
    );
    assert.equal(resolved.get("Real Estate"), "real estate");
    assert.equal(resolved.get("Utilities"), "utilit");
    assert.equal(resolved.get("Consumer Discretionary"), "consumer");

    // Nothing may resolve to "it" except the IT sector itself.
    const wrongIt = [...resolved.entries()].filter(
      ([name, key]) => key === "it" && name !== "Information Technology",
    );
    assert.deepEqual(
      wrongIt,
      [],
      "only Information Technology may map to 'it'",
    );
  });

  it("no canonical sector is unmatched by the full key set", () => {
    const unmatched = getAllSectorNames().filter(
      (n) => firstMatchingSectorKey(n, KEYS) === null,
    );
    assert.deepEqual(
      unmatched,
      [],
      "a canonical sector matching NO key silently falls through to a default " +
        "everywhere this matcher is used",
    );
  });
});
