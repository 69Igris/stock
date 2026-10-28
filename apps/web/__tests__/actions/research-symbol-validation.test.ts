/**
 * MONEY-620 — research symbol-routing helpers (REAL exported symbols).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow via EXTRACT + WIRE)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW that re-implemented `validateAndResolveSymbols`,
 * `autoDetectComparison`, `detectCallingConvention`, `formatInvalidSymbolError`
 * INLINE ("// Re-implemented pure functions (mirrors research.ts logic exactly)")
 * and asserted the copies — and those symbols were NOT exported from anywhere,
 * so the copies could drift arbitrarily from the real `startResearchAction`
 * behaviour (and did: it modelled a fictional `validateAndResolveSymbols` API).
 *
 * Per the de-shadow recipe, the pure decision logic was EXTRACTED out of
 * `startResearchAction` into the exported sibling
 * `lib/actions/research-symbol-logic.ts`, and `research.ts` was WIRED to CALL
 * those exports (the inline copies are gone — production and this test now run
 * the SAME code). This file imports & asserts the REAL exports:
 *   - looksLikeUserId: 24-hex ObjectId / `user_`-prefixed Clerk id → old calling
 *     convention; plain queries / @mentions → new convention.
 *   - autoDetectComparison: 2+ symbols w/o skill → peer-comparison + advanced;
 *     an explicit skill/mode is never overridden; 0/1 symbol untouched.
 *   - isFundShapedQuery: `[MUTUAL_FUND]` / `[ETF]` prefixes bypass equity
 *     validation; a plain query does not.
 *   - cleanSymbol: uppercases + strips `.NS`/`.BO`.
 *   - formatInvalidSymbolError: singular vs plural + lists the symbols.
 *
 * This module is pure (no Prisma / network), so it is imported DIRECTLY — no
 * require.cache seam needed.
 *
 * Source: apps/web/lib/actions/research-symbol-logic.ts (called by research.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeUserId,
  autoDetectComparison,
  isFundShapedQuery,
  cleanSymbol,
  stripMentionPrefix,
  isSchemeCodeRun,
  formatInvalidSymbolError,
} from "@/lib/actions/research-symbol-logic";

describe("MONEY-620 — research-symbol-logic (real exports)", () => {
  describe("looksLikeUserId", () => {
    it("a 24-char lowercase hex ObjectId → old convention", () => {
      assert.equal(looksLikeUserId("a".repeat(24)), true);
      assert.equal(looksLikeUserId("0123456789abcdef01234567"), true);
    });

    it("a Clerk id (user_…) → old convention", () => {
      assert.equal(looksLikeUserId("user_2abcXYZ"), true);
    });

    it("a plain query string → new convention", () => {
      assert.equal(looksLikeUserId("Analyze RELIANCE vs TCS"), false);
      assert.equal(looksLikeUserId("@RELIANCE growth"), false);
    });

    it("a 23- or 25-char hex (wrong length) → NOT a userId", () => {
      assert.equal(looksLikeUserId("a".repeat(23)), false);
      assert.equal(looksLikeUserId("a".repeat(25)), false);
    });

    it("uppercase hex (not lowercase) → NOT an ObjectId-shaped id", () => {
      assert.equal(looksLikeUserId("A".repeat(24)), false);
    });

    it("empty string → new convention", () => {
      assert.equal(looksLikeUserId(""), false);
    });
  });

  describe("autoDetectComparison", () => {
    it("2 symbols without skill/mode → peer-comparison + advanced", () => {
      const r = autoDetectComparison(["RELIANCE", "TCS"], undefined, undefined);
      assert.equal(r.skill, "peer-comparison");
      assert.equal(r.mode, "advanced");
    });

    it("3 symbols still → peer-comparison + advanced", () => {
      const r = autoDetectComparison(["A", "B", "C"], undefined, undefined);
      assert.equal(r.skill, "peer-comparison");
      assert.equal(r.mode, "advanced");
    });

    it("an explicit skill is NOT overridden", () => {
      const r = autoDetectComparison(["A", "B"], "stock-analysis", undefined);
      assert.equal(r.skill, "stock-analysis");
      // mode still upgrades since it was unset
      assert.equal(r.mode, "advanced");
    });

    it("an explicit mode is NOT overridden", () => {
      const r = autoDetectComparison(["A", "B"], undefined, "fast");
      assert.equal(r.skill, "peer-comparison");
      assert.equal(r.mode, "fast");
    });

    it("a single symbol is left untouched", () => {
      const r = autoDetectComparison(["RELIANCE"], undefined, undefined);
      assert.equal(r.skill, undefined);
      assert.equal(r.mode, undefined);
    });

    it("no symbols → untouched", () => {
      const r0 = autoDetectComparison([], undefined, undefined);
      assert.equal(r0.skill, undefined);
      const rU = autoDetectComparison(undefined, undefined, undefined);
      assert.equal(rU.skill, undefined);
      assert.equal(rU.mode, undefined);
    });
  });

  describe("isFundShapedQuery", () => {
    it("[MUTUAL_FUND] prefix → true (bypass equity validation)", () => {
      assert.equal(isFundShapedQuery("[MUTUAL_FUND] Axis Bluechip"), true);
    });
    it("[ETF] prefix → true", () => {
      assert.equal(isFundShapedQuery("[ETF] NIFTYBEES"), true);
    });
    it("a plain equity query → false", () => {
      assert.equal(isFundShapedQuery("Analyze RELIANCE"), false);
    });
    it("the prefix must be at the START", () => {
      assert.equal(isFundShapedQuery("Compare [ETF] later"), false);
    });
  });

  describe("cleanSymbol", () => {
    it("uppercases and strips a .NS suffix", () => {
      assert.equal(cleanSymbol("reliance.NS"), "RELIANCE");
      assert.equal(cleanSymbol("reliance.ns"), "RELIANCE");
    });
    it("strips a .BO suffix", () => {
      assert.equal(cleanSymbol("tcs.BO"), "TCS");
    });
    it("leaves a bare symbol uppercased", () => {
      assert.equal(cleanSymbol("infy"), "INFY");
    });
    it("only strips a TRAILING exchange suffix", () => {
      // ".NSE" is not the .NS/.BO suffix → not stripped (only uppercased)
      assert.equal(cleanSymbol("foo.NSE"), "FOO.NSE");
    });
  });

  describe("formatInvalidSymbolError", () => {
    it("singular for one symbol", () => {
      const msg = formatInvalidSymbolError(["XYZ"]);
      assert.match(msg, /Symbol not found on NSE\/BSE: XYZ/);
      assert.ok(!/Symbols not found/.test(msg));
    });
    it("plural for multiple symbols, lists them all", () => {
      const msg = formatInvalidSymbolError(["XYZ", "ABC"]);
      assert.match(msg, /Symbols not found on NSE\/BSE: XYZ, ABC/);
    });
    it("includes the guidance examples", () => {
      const msg = formatInvalidSymbolError(["XYZ"]);
      assert.match(msg, /RELIANCE, TCS, INFY/);
    });
  });
});

/**
 * MONEY-1073 — mutual-fund runs must survive EVERY classifier path.
 *
 * The chat fast-path can tag a fund mention explicitly (assetType "mf"), but a
 * FOLLOW-UP turn ("detailed deep-dive" after a clarification) loses the
 * `[Mentioned:]` context and is resolved from conversation history by Flash —
 * verbatim, so the scheme code arrives as "@140288". Both helpers below are
 * what `startResearchAction` uses to normalize + detect that at the funnel, so
 * the fund skips the equity-only validation instead of being rejected with
 * "Symbol not found on NSE/BSE: @140288".
 */
describe("MONEY-1073 — fund-run normalization + detection (real exports)", () => {
  describe("stripMentionPrefix", () => {
    it("strips the @ Flash echoes from an @mention", () => {
      assert.equal(stripMentionPrefix("@140288"), "140288");
      assert.equal(stripMentionPrefix("@RELIANCE"), "RELIANCE");
    });

    it("leaves a clean symbol untouched and trims whitespace", () => {
      assert.equal(stripMentionPrefix("140288"), "140288");
      assert.equal(stripMentionPrefix("  TCS  "), "TCS");
    });
  });

  describe("isSchemeCodeRun", () => {
    it("a lone all-digit symbol IS an AMFI scheme code → fund run", () => {
      assert.equal(isSchemeCodeRun(["140288"]), true);
      assert.equal(isSchemeCodeRun(["121281"]), true);
    });

    it("an equity ticker is NOT a fund run (every ticker has a letter)", () => {
      assert.equal(isSchemeCodeRun(["RELIANCE"]), false);
      // Numeric-LEADING tickers must stay on the stock path.
      assert.equal(isSchemeCodeRun(["360ONE"]), false);
      assert.equal(isSchemeCodeRun(["5PAISA"]), false);
    });

    it("only a LONE symbol is a fund run (multi-symbol = comparison)", () => {
      assert.equal(isSchemeCodeRun(["140288", "TCS"]), false);
      assert.equal(isSchemeCodeRun(["140288", "121281"]), false);
    });

    it("no symbols → not a fund run", () => {
      assert.equal(isSchemeCodeRun(undefined), false);
      assert.equal(isSchemeCodeRun([]), false);
    });
  });
});
