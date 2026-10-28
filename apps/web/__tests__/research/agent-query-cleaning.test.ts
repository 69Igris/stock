/**
 * Research Agent — query cleaning, error sanitisation & query-type routing.
 *
 * De-shadowed (MONEY-620): previously this file re-implemented `cleanQuery`,
 * `sanitizeError`, `normalizeScore`, `detectQueryType`, `isSessionStale` and
 * `hasMinimumStructure` inline and asserted the copies — so it stayed green
 * even after the real agent diverged (e.g. the real `cleanQueryForPlanner`
 * regex requires a parenthesised `@SYM ("Name", Exch)` form, and the real
 * `sanitizeResearchError` maps DB errors to "A temporary service error…", not
 * "database error"). It now imports the REAL pure exports from
 * `packages/research/src/agent-logic.ts` (which `agent.ts` itself calls).
 *
 * `isSessionStale` / `hasMinimumStructure` / a standalone `normalizeScore`
 * have no real exported counterpart — the agent inlines the stale-status check
 * at the call site and folds score normalisation into `computeQualityScore`.
 * Those reimplementation-only suites were dropped rather than kept as shadows;
 * score normalisation is covered through the real `computeQualityScore` here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cleanQueryForPlanner,
  sanitizeResearchError,
  detectQueryType,
  computeQualityScore,
} from "@usemoney/research/agent-logic";

// ─────────────────────────────────────────────────────────────────────────────
// cleanQueryForPlanner — strips the chat composer's
// `[Mentioned: @SYM ("Name", Exchange), ...]` prefix (parens REQUIRED) and the
// parenthesised descriptions that follow bare @mentions in the body.
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanQueryForPlanner", () => {
  it('strips a single mention prefix with the ("Name", Exchange) form', () => {
    const input =
      '[Mentioned: @RELIANCE ("Reliance Industries", NSE)] Analyze it';
    assert.strictEqual(cleanQueryForPlanner(input), "Analyze it");
  });

  it("strips a multi-symbol mention prefix", () => {
    const input =
      '[Mentioned: @RELIANCE ("Reliance", NSE), @IOC ("Indian Oil", NSE)] Compare these two stocks';
    assert.strictEqual(cleanQueryForPlanner(input), "Compare these two stocks");
  });

  it("collapses the parenthesised description after a bare @SYMBOL in the body", () => {
    const input = 'Tell me about @RELIANCE ("RELIANCE INDUSTRIES", NSE) today';
    assert.strictEqual(
      cleanQueryForPlanner(input),
      "Tell me about @RELIANCE today"
    );
  });

  it("falls back to the trimmed raw query when stripping leaves nothing", () => {
    const input = '[Mentioned: @SYM ("Name", NSE)]';
    // After the prefix is removed the result is "", so the function falls
    // back to the trimmed raw input (NOT an empty string).
    assert.strictEqual(cleanQueryForPlanner(input), input);
  });

  it("returns plain text unchanged when there is no mention prefix", () => {
    const input = "No prefix here, plain query";
    assert.strictEqual(
      cleanQueryForPlanner(input),
      "No prefix here, plain query"
    );
  });

  it("does NOT strip a bare @-mention prefix without the parenthesised form", () => {
    // The real regex requires `@SYM (...)`; a bare `@RELIANCE` is left intact
    // (the OLD shadow copy stripped this — encoding behaviour prod never had).
    const input = "[Mentioned: @RELIANCE @IOC] Compare these two stocks";
    assert.strictEqual(cleanQueryForPlanner(input), input);
  });

  it("returns the raw query for empty input (raw-trim fallback)", () => {
    assert.strictEqual(cleanQueryForPlanner(""), "");
  });

  it("only strips the prefix at the START of the string", () => {
    const input =
      'Some text [Mentioned: @RELIANCE ("Reliance", NSE)] more text';
    // Anchored to ^, so the mid-string prefix `[Mentioned: ... ]` is NOT
    // stripped; but the body @SYM("Name", Exch) collapse still applies → the
    // parenthetical is removed, leaving the surrounding brackets/text intact.
    assert.strictEqual(
      cleanQueryForPlanner(input),
      "Some text [Mentioned: @RELIANCE] more text"
    );
  });

  it("trims surrounding whitespace from the result", () => {
    const input =
      '[Mentioned: @RELIANCE ("Reliance", NSE)]   Analyze RELIANCE   ';
    assert.strictEqual(cleanQueryForPlanner(input), "Analyze RELIANCE");
  });

  it("preserves @-mentions in the body that have no parenthetical", () => {
    const input =
      '[Mentioned: @RELIANCE ("Reliance", NSE)] Tell me about @RELIANCE';
    const result = cleanQueryForPlanner(input);
    assert.ok(result.includes("@RELIANCE"));
    assert.ok(!result.startsWith("[Mentioned:"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeResearchError — maps technical internals to safe copy, passes through
// known-safe / short non-technical messages.
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizeResearchError", () => {
  it("maps a Prisma error to the generic temporary-service message", () => {
    const result = sanitizeResearchError(
      "PrismaClientKnownRequestError: record not found"
    );
    assert.strictEqual(
      result,
      "A temporary service error occurred. Please try again."
    );
  });

  it("maps a mongodb/database error to the temporary-service message", () => {
    const result = sanitizeResearchError(
      "mongodb write conflict: database unavailable"
    );
    assert.strictEqual(
      result,
      "A temporary service error occurred. Please try again."
    );
  });

  it("a bare 'MongoServerError' (no 'mongodb'/'database' token) hits the catch-all", () => {
    // Documents the real gap: the DB bucket matches /mongodb|database/, not the
    // class name "MongoServerError" — so it falls to the generic catch-all.
    // (Still safe; no internals leak.)
    const result = sanitizeResearchError("MongoServerError: write conflict");
    assert.strictEqual(
      result,
      "Something went wrong during the analysis. Please try again."
    );
  });

  it("maps ECONNREFUSED to the temporary-service message (ECONN bucket)", () => {
    const result = sanitizeResearchError("ECONNREFUSED 127.0.0.1:27017");
    assert.strictEqual(
      result,
      "A temporary service error occurred. Please try again."
    );
  });

  it("maps a 401 to the configuration-error message", () => {
    const result = sanitizeResearchError("401 Unauthorized access to API");
    assert.strictEqual(
      result,
      "A service configuration error occurred. Please try again later."
    );
  });

  it("maps a 403 to the configuration-error message", () => {
    const result = sanitizeResearchError("403 Forbidden: API key invalid");
    assert.strictEqual(
      result,
      "A service configuration error occurred. Please try again later."
    );
  });

  it("maps a 429 to the busy/rate-limit message", () => {
    const result = sanitizeResearchError("429 Too Many Requests");
    assert.strictEqual(
      result,
      "Service is temporarily busy. Please try again in a few minutes."
    );
  });

  it("maps RESOURCE_EXHAUSTED quota to the busy/rate-limit message", () => {
    const result = sanitizeResearchError(
      "RESOURCE_EXHAUSTED: quota exceeded for model"
    );
    assert.strictEqual(
      result,
      "Service is temporarily busy. Please try again in a few minutes."
    );
  });

  it("maps a Gemini/Vertex error to the AI-service message", () => {
    const result = sanitizeResearchError("Gemini model error: blocked");
    assert.strictEqual(
      result,
      "AI analysis service encountered an error. Please try again."
    );
  });

  it("maps a timeout to the took-too-long message", () => {
    const result = sanitizeResearchError("Request timeout after 30000ms");
    assert.strictEqual(
      result,
      "Research took too long to complete. Please try again."
    );
  });

  it("maps ETIMEDOUT to the took-too-long message (timeout bucket)", () => {
    // NOTE: avoid the word "connection" here — it would hit the earlier DB
    // bucket (/connection/) before reaching the timeout bucket.
    const result = sanitizeResearchError(
      "ETIMEDOUT reaching the upstream host"
    );
    assert.strictEqual(
      result,
      "Research took too long to complete. Please try again."
    );
    assert.ok(!result.toLowerCase().includes("redis"));
  });

  it("maps OOM/internal-server to the temporary-error message", () => {
    const result = sanitizeResearchError(
      "500 Internal Server Error from Yahoo Finance"
    );
    assert.strictEqual(result, "A temporary error occurred. Please try again.");
  });

  it("passes through the safe not-listed message unchanged", () => {
    const msg =
      "TSLA is not listed on Indian exchanges (NSE/BSE). UseMoney only supports Indian stocks.";
    assert.strictEqual(sanitizeResearchError(msg), msg);
  });

  it("passes through the 'only supports' message unchanged", () => {
    const msg = "UseMoney only supports Indian stocks. Use NSE/BSE symbols.";
    assert.strictEqual(sanitizeResearchError(msg), msg);
  });

  it("returns the generic message for empty input", () => {
    assert.strictEqual(
      sanitizeResearchError(""),
      "An error occurred during research. Please try again."
    );
  });

  it("passes through a short non-technical message", () => {
    // < 150 chars and no error/exception/stack/trace/'at ' tokens → kept.
    const msg = "No data found for this symbol yet";
    assert.strictEqual(sanitizeResearchError(msg), msg);
  });

  it("does not leak a stack trace (falls to the generic catch-all)", () => {
    const stack =
      "Error: something failed\n    at Object.<anonymous> (/app/src/agent.ts:42:3)";
    const result = sanitizeResearchError(stack);
    assert.ok(!result.includes("agent.ts"));
    assert.ok(!result.includes("at Object"));
    assert.strictEqual(
      result,
      "Something went wrong during the analysis. Please try again."
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectQueryType — synthesizer-prompt routing.
// ─────────────────────────────────────────────────────────────────────────────

describe("detectQueryType", () => {
  it("detects comparison from 'Compare RELIANCE vs IOC'", () => {
    assert.strictEqual(
      detectQueryType("Compare RELIANCE vs IOC"),
      "comparison"
    );
  });

  it("detects comparison from 'comparison of TCS and INFY'", () => {
    assert.strictEqual(
      detectQueryType("Side by side comparison of TCS and INFY"),
      "comparison"
    );
  });

  it("returns undefined for 'best dividend strategy for 2024' (no stock/nifty/market word)", () => {
    assert.strictEqual(
      detectQueryType("Best dividend strategy for 2024"),
      undefined
    );
  });

  it("detects strategy from an RSI/momentum indicator query", () => {
    assert.strictEqual(
      detectQueryType("Apply RSI momentum indicator on SBIN"),
      "strategy"
    );
  });

  it("detects strategy from a MACD keyword", () => {
    assert.strictEqual(
      detectQueryType("Show me MACD signals for INFY"),
      "strategy"
    );
  });

  it("detects valuation from a DCF keyword", () => {
    assert.strictEqual(detectQueryType("DCF valuation of TCS"), "valuation");
  });

  it("detects valuation from a fair-value keyword", () => {
    assert.strictEqual(
      detectQueryType("What is the fair value of HDFC Bank?"),
      "valuation"
    );
  });

  it("detects valuation from an intrinsic keyword", () => {
    assert.strictEqual(
      detectQueryType("Calculate intrinsic value of Wipro"),
      "valuation"
    );
  });

  it("detects sector from a banking-sector query", () => {
    assert.strictEqual(
      detectQueryType("Banking sector analysis for Q3"),
      "sector"
    );
  });

  it("detects portfolio from a portfolio query", () => {
    assert.strictEqual(
      detectQueryType("Analyze my portfolio risk"),
      "portfolio"
    );
  });

  it("returns undefined for a plain single-stock query", () => {
    assert.strictEqual(
      detectQueryType("Tell me about RELIANCE Industries"),
      undefined
    );
  });

  it("returns undefined for 'which is better TCS or INFY' (no compare token)", () => {
    assert.strictEqual(
      detectQueryType("Which is better TCS or INFY?"),
      undefined
    );
  });

  it("detects strategy from a swing-trading keyword", () => {
    assert.strictEqual(
      detectQueryType("Find swing trading opportunities in IT stocks"),
      "strategy"
    );
  });

  it("detects comparison from case-insensitive 'COMPARE'", () => {
    assert.strictEqual(detectQueryType("COMPARE HDFC vs KOTAK"), "comparison");
  });

  it("returns undefined for 'overvalued' (not in the valuation regex)", () => {
    assert.strictEqual(
      detectQueryType("Is ZOMATO overvalued right now?"),
      undefined
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeQualityScore — the persisted qualityScore derivation (covers what the
// old standalone `normalizeScore` shadow tried to test: the 0-1 → 0-100
// validator-score normalisation, plus the fast/advanced falsy-0 handling).
// ─────────────────────────────────────────────────────────────────────────────

describe("computeQualityScore — validator-score normalisation", () => {
  const ADVANCED = false; // skipValidation=false
  const FAST = true; // skipValidation=true

  it("scales a 0-1 validator score to 0-100 (0.75 → 75)", () => {
    assert.strictEqual(computeQualityScore({}, 0.75, ADVANCED), 75);
  });

  it("scales 1.0 to 100", () => {
    assert.strictEqual(computeQualityScore({}, 1, ADVANCED), 100);
  });

  it("rounds a scaled validator score (0.856 → 86)", () => {
    assert.strictEqual(computeQualityScore({}, 0.856, ADVANCED), 86);
  });

  it("leaves an already-0-100 validator score unchanged (82 → 82)", () => {
    assert.strictEqual(computeQualityScore({}, 82, ADVANCED), 82);
  });

  it("prefers the validator score over report.score", () => {
    assert.strictEqual(computeQualityScore({ score: 60 }, 0.9, ADVANCED), 90);
  });

  it("falls back to report.score (already 0-100) when validator score is 0", () => {
    assert.strictEqual(computeQualityScore({ score: 65 }, 0, ADVANCED), 65);
  });

  it("fast mode: report.score=0 → undefined (don't persist a misleading 0)", () => {
    assert.strictEqual(computeQualityScore({ score: 0 }, 0, FAST), undefined);
  });

  it("advanced mode: both scores 0 → 0", () => {
    assert.strictEqual(computeQualityScore({ score: 0 }, 0, ADVANCED), 0);
  });

  it("fast mode with a string report → undefined", () => {
    assert.strictEqual(computeQualityScore("plain text", 0, FAST), undefined);
  });

  it("fast mode: report.score=72 used as fallback", () => {
    assert.strictEqual(computeQualityScore({ score: 72 }, 0, FAST), 72);
  });
});
