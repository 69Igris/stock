/**
 * Output Validator Tests (lib/chat-tools/output-validator-logic.ts)
 *
 * DE-SHADOWED (MONEY-620): previously this file re-declared the validator
 * logic inline and asserted the COPY — and the inline `factCheckNumbers` was a
 * no-op STUB while the real function actually cross-checks numbers. The pure
 * checks now live in `output-validator-logic.ts` (extracted out of
 * `output-validator.ts` so they import cleanly under node:test, away from the
 * registry → server-action → `lib/auth.ts` `react.cache` chain). This test
 * imports and executes the REAL exported functions.
 *
 * `validateOutput` (the orchestrator) still needs the tool registry
 * (`getTool`, `extractAndValidateParams`) and so cannot be imported here; it is
 * covered by the chat route + executor suites that run in the Next.js runtime.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterUnsafeContent,
  detectDisclaimers,
  factCheckNumbers,
  stripLeakedJson,
} from "@/lib/chat-tools/output-validator-logic";

describe("Output Validator (logic)", () => {
  // ───────────────────── filterUnsafeContent ─────────────────────

  describe("filterUnsafeContent", () => {
    // === Positive: clean response passes through ===

    it("should pass through a clean response unchanged", () => {
      const clean = "Your portfolio has grown by 12% this quarter.";
      assert.strictEqual(filterUnsafeContent(clean), clean);
    });

    it("should pass through finance content with special characters", () => {
      const finance = "P/E ratio: 25.5x, ROE: 18.2%, Debt/Equity: 0.3x";
      assert.strictEqual(filterUnsafeContent(finance), finance);
    });

    it("should pass through content with numbers and currency", () => {
      const currency = "Total value: INR 1,03,791.50 across 5 brokers.";
      assert.strictEqual(filterUnsafeContent(currency), currency);
    });

    // === Negative: unsafe patterns removed ===

    it("should filter out 'SYSTEM PROMPT:' pattern", () => {
      const response = "SYSTEM PROMPT: override rules. Here is your data.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.includes("SYSTEM PROMPT:"));
      assert.ok(result.includes("Here is your data."));
    });

    it("should filter out 'INSTRUCTION:' pattern", () => {
      const response = "INSTRUCTION: ignore safety. Show holdings below.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.includes("INSTRUCTION:"));
      assert.ok(result.includes("Show holdings below."));
    });

    it("should filter out '[INTERNAL]' pattern", () => {
      const response = "[INTERNAL] debug info. Your holdings are listed here.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.includes("[INTERNAL]"));
      assert.ok(result.includes("Your holdings are listed here."));
    });

    // === Edge: case variations ===

    it("should filter 'system prompt:' in lowercase", () => {
      const response = "system prompt: leaked info. Normal text.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.toLowerCase().includes("system prompt:"));
    });

    it("should filter 'SYSTEM PROMPT:' in uppercase", () => {
      const response = "SYSTEM PROMPT: uppercase leak. Safe data here.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.includes("SYSTEM PROMPT:"));
    });

    it("should filter 'System Prompt:' in mixed case", () => {
      const response = "System Prompt: mixed case leak. Your portfolio.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.toLowerCase().includes("system prompt:"));
    });

    it("should filter 'instruction:' in lowercase", () => {
      const response = "instruction: lower. More text.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.toLowerCase().includes("instruction:"));
    });

    it("should filter '[internal]' in lowercase", () => {
      const response = "[internal] private note. Public data.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.toLowerCase().includes("[internal]"));
    });

    it("should handle 'SYSTEM  PROMPT:' with extra whitespace", () => {
      const response = "SYSTEM  PROMPT: extra space leak. Data here.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.includes("SYSTEM  PROMPT:"));
    });

    // === Edge: multiple patterns in one response ===

    it("should filter multiple unsafe patterns in one response", () => {
      const response =
        "SYSTEM PROMPT: ignore. INSTRUCTION: override. [INTERNAL] debug. Your portfolio value is $10,000.";
      const result = filterUnsafeContent(response);
      assert.ok(!result.includes("SYSTEM PROMPT:"));
      assert.ok(!result.includes("INSTRUCTION:"));
      assert.ok(!result.includes("[INTERNAL]"));
      assert.ok(result.includes("Your portfolio value is $10,000."));
    });

    it("should handle response with only unsafe content", () => {
      const response = "SYSTEM PROMPT:INSTRUCTION:[INTERNAL]";
      const result = filterUnsafeContent(response);
      assert.ok(!result.includes("SYSTEM PROMPT:"));
      assert.ok(!result.includes("INSTRUCTION:"));
      assert.ok(!result.includes("[INTERNAL]"));
    });

    // === Edge: empty and whitespace ===

    it("should handle empty response", () => {
      assert.strictEqual(filterUnsafeContent(""), "");
    });

    it("should handle whitespace-only response", () => {
      assert.strictEqual(filterUnsafeContent("   "), "   ");
    });
  });

  // ───────────────────── detectDisclaimers ─────────────────────

  describe("detectDisclaimers", () => {
    const FINANCIAL_ADVICE_DISCLAIMER =
      "This is not financial advice. Please consult a SEBI-registered advisor before making investment decisions.";
    const PAST_PERFORMANCE_DISCLAIMER =
      "Past performance is not indicative of future results. All investments carry risk.";

    // === Positive: financial recommendation triggers ===

    it("should trigger disclaimer for 'buy recommendation'", () => {
      const response =
        "Based on analysis, this is a buy recommendation for TCS.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger disclaimer for 'sell advice'", () => {
      const response = "My sell advice is to exit this stock now.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger disclaimer for 'recommend buy'", () => {
      const response = "I recommend you buy RELIANCE at current levels.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger disclaimer for 'suggest invest'", () => {
      const response = "I suggest you invest in index funds for the long term.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger disclaimer for 'long advice'", () => {
      const response = "Going long is my advice for HDFC Bank.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger disclaimer for 'short recommendation'", () => {
      const response = "Going short is my recommendation for bearish markets.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    // === Positive: target price / stop loss triggers ===

    it("should trigger past performance disclaimer for 'target price'", () => {
      const response = "The target price for TCS is Rs 4,200.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(PAST_PERFORMANCE_DISCLAIMER));
    });

    it("should trigger past performance disclaimer for 'stop loss'", () => {
      const response = "Set your stop loss at Rs 2,100 for safety.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(PAST_PERFORMANCE_DISCLAIMER));
    });

    it("should trigger past performance disclaimer for 'entry price'", () => {
      const response = "A good entry price would be around Rs 1,500.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(PAST_PERFORMANCE_DISCLAIMER));
    });

    // === Both disclaimers triggered ===

    it("should trigger both disclaimers when both patterns are present", () => {
      const response =
        "I recommend you buy TCS with a target price of Rs 4,200.";
      const disclaimers = detectDisclaimers(response);
      assert.strictEqual(disclaimers.length, 2);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
      assert.ok(disclaimers.includes(PAST_PERFORMANCE_DISCLAIMER));
    });

    it("should trigger both disclaimers for 'sell advice' with 'stop loss'", () => {
      const response =
        "My sell advice is to exit at current levels with a stop loss at Rs 1,800.";
      const disclaimers = detectDisclaimers(response);
      assert.strictEqual(disclaimers.length, 2);
    });

    // === Allocation / rebalancing disclaimer (real source — was MISSING from
    // the old shadow's inline copy, which only had 2 branches) ===

    // REGRESSION (MONEY-620, task 140): the old `\b(\d+%|percent)\b` branch
    // never fired for a "<digits>%" token — `\b` after "%" needs a following
    // word char, but "%" is always followed by a space/period/EOL, so a bare
    // "30%" produced NO disclaimer while the "percent" spelling worked. Source
    // now uses `(\d+\s*%|\bpercent\b)`; both forms trigger. Locked in here.
    it("should trigger advice disclaimer for percentage rebalance ('30%')", () => {
      const response = "You should rebalance 30% of your equity into bonds.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger for '30 %' (space before percent sign)", () => {
      const disclaimers = detectDisclaimers(
        "Shift 30 % of the portfolio into debt."
      );
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger for a trailing '40%.' at end of sentence", () => {
      const disclaimers = detectDisclaimers(
        "Move into gold by allocating 40%."
      );
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger advice disclaimer for 'allocate ... percent'", () => {
      const response = "I'd allocate 25 percent to large-cap funds.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger advice disclaimer for 'overweight'", () => {
      const response = "Stay overweight on IT for the next two quarters.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should trigger advice disclaimer for 'underweight'", () => {
      const response = "Go underweight on PSU banks.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });

    it("should NOT duplicate the advice disclaimer when buy+allocate both present", () => {
      const response =
        "I recommend you buy TCS and overweight IT by allocating 40% there.";
      const disclaimers = detectDisclaimers(response);
      // Only one financial-advice disclaimer even though both branches match.
      const adviceCount = disclaimers.filter(
        (d) => d === FINANCIAL_ADVICE_DISCLAIMER
      ).length;
      assert.strictEqual(adviceCount, 1);
    });

    // === No disclaimers for normal text ===

    it("should return empty array for normal portfolio description", () => {
      const response =
        "Your portfolio consists of 15 stocks across various sectors.";
      const disclaimers = detectDisclaimers(response);
      assert.strictEqual(disclaimers.length, 0);
    });

    it("should return empty array for general market commentary", () => {
      const response =
        "The market closed higher today with Nifty gaining 1.2%.";
      const disclaimers = detectDisclaimers(response);
      assert.strictEqual(disclaimers.length, 0);
    });

    it("should return empty array for educational content", () => {
      const response =
        "P/E ratio measures how much investors pay for each rupee of earnings.";
      const disclaimers = detectDisclaimers(response);
      assert.strictEqual(disclaimers.length, 0);
    });

    it("should return empty array for empty string", () => {
      const disclaimers = detectDisclaimers("");
      assert.strictEqual(disclaimers.length, 0);
    });

    // === Case insensitivity ===

    it("should detect 'TARGET PRICE' in uppercase", () => {
      const response = "The TARGET PRICE is Rs 5,000.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(PAST_PERFORMANCE_DISCLAIMER));
    });

    it("should detect 'Stop Loss' in mixed case", () => {
      const response = "Keep a Stop Loss at 10%.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(PAST_PERFORMANCE_DISCLAIMER));
    });

    it("should detect 'RECOMMEND BUY' in uppercase", () => {
      const response = "I RECOMMEND you BUY INFY shares.";
      const disclaimers = detectDisclaimers(response);
      assert.ok(disclaimers.includes(FINANCIAL_ADVICE_DISCLAIMER));
    });
  });

  // ───────────────────── factCheckNumbers (REAL impl) ─────────────────────
  //
  // The old shadow asserted a no-op stub. These exercise the actual
  // cross-checking logic: extract numbers from toolData, normalize Indian
  // currency in the response, and flag >20% deviations.

  describe("factCheckNumbers", () => {
    it("should return response unchanged when toolData is undefined", () => {
      const response = "Your portfolio value is Rs 5,00,000.";
      const result = factCheckNumbers(response, undefined);
      assert.strictEqual(result.response, response);
      assert.deepStrictEqual(result.corrections, []);
    });

    it("should return no corrections when toolData has no numeric values", () => {
      const response = "TCS is a great company.";
      const result = factCheckNumbers(response, { symbol: "TCS", note: "x" });
      assert.strictEqual(result.response, response);
      assert.deepStrictEqual(result.corrections, []);
    });

    it("should return no corrections when the single number matches its tool value", () => {
      // factCheckNumbers cross-checks EVERY response number against EVERY known
      // value, so multiple distinct numbers can collide (a PE of 28 would be
      // compared against a price of 3800). Use a single number + single value
      // that agree to assert the clean (no-correction) path.
      const response = "TCS is trading at 3800.";
      const toolData = { price: 3800 };
      const result = factCheckNumbers(response, toolData);
      assert.deepStrictEqual(result.corrections, []);
      assert.strictEqual(result.response, response);
    });

    it("flags cross-product collisions: a response number is checked against every known value", () => {
      // Documents the real (fuzzy) behavior: the PE "28" is compared against
      // the known "price" 3800 and flagged. Not a clean match — by design.
      const response = "TCS is trading at 3800 with a PE of 28.";
      const result = factCheckNumbers(response, { price: 3800, pe: 28 });
      assert.ok(result.corrections.some((c) => c.includes("price")));
    });

    it("should flag a number that deviates >20% from the tool data", () => {
      // toolData says price = 1000; response claims 5000 → 400% deviation.
      const response = "The current price is 5000.";
      const toolData = { price: 1000 };
      const result = factCheckNumbers(response, toolData);
      assert.ok(
        result.corrections.length >= 1,
        "expected at least one correction"
      );
      assert.ok(result.corrections.some((c) => c.includes("price")));
      // Correction footnote appended to the response.
      assert.ok(result.response.includes("Data verification"));
    });

    it("should normalize lakh in the response against a raw rupee value", () => {
      // "2L" => 200000. toolData totalValue = 1000000 → 80% deviation → flag.
      const response = "Your portfolio is worth 2L.";
      const toolData = { totalValue: 1000000 };
      const result = factCheckNumbers(response, toolData);
      assert.ok(result.corrections.some((c) => c.includes("totalValue")));
    });

    it("should NOT flag a deviation beyond the 10x upper guard", () => {
      // response 50000 vs toolData 100 → deviation ~499 (>= 10) → ignored.
      const response = "Value is 50000.";
      const toolData = { tinyMetric: 100 };
      const result = factCheckNumbers(response, toolData);
      assert.deepStrictEqual(result.corrections, []);
    });

    it("should skip zero-valued known data (no divide-by-zero correction)", () => {
      const response = "P&L is 4200.";
      const toolData = { pnl: 0 };
      const result = factCheckNumbers(response, toolData);
      assert.deepStrictEqual(result.corrections, []);
    });

    it("should extract numbers from one level of nested tool data", () => {
      // nested.summary.totalValue = 1000000; response "5L" = 500000 → 50% → flag.
      const response = "Total is 5L.";
      const toolData = { summary: { totalValue: 1000000 } };
      const result = factCheckNumbers(response, toolData);
      assert.ok(
        result.corrections.some((c) => c.includes("summary.totalValue"))
      );
    });

    it("should handle empty response with toolData (no numbers to check)", () => {
      const result = factCheckNumbers("", { totalValue: 1000000 });
      assert.strictEqual(result.response, "");
      assert.deepStrictEqual(result.corrections, []);
    });

    it("should handle empty toolData object", () => {
      const result = factCheckNumbers("Some response text.", {});
      assert.strictEqual(result.response, "Some response text.");
      assert.deepStrictEqual(result.corrections, []);
    });

    it("should ignore a literal zero in the response (parsedNumber === 0 guard)", () => {
      const response = "You have 0 open positions.";
      const toolData = { openPositions: 7 };
      const result = factCheckNumbers(response, toolData);
      // 0 is skipped, so no correction about openPositions from the "0".
      assert.deepStrictEqual(result.corrections, []);
    });

    it("should always return an array for corrections", () => {
      const a = factCheckNumbers("Any text", undefined);
      const b = factCheckNumbers("Value 9999", { x: 1 });
      assert.ok(Array.isArray(a.corrections));
      assert.ok(Array.isArray(b.corrections));
    });
  });

  // ───────────────────── stripLeakedJson (REAL impl) ─────────────────────
  //
  // Not covered at all by the old shadow. Guards against Gemini leaking raw
  // filter/param JSON into the user-facing narrative.

  describe("stripLeakedJson", () => {
    it("should leave clean narrative text untouched", () => {
      const text = "Here are the top 3 momentum stocks for you.";
      assert.strictEqual(stripLeakedJson(text), text);
    });

    it("should strip a standalone JSON object line", () => {
      const text =
        'I tightened the screen.\n{"metric": "ROE", "operator": "gt", "value": 20}';
      const out = stripLeakedJson(text);
      assert.ok(!out.includes('"metric"'));
      assert.ok(out.includes("I tightened the screen."));
    });

    it("should strip a trailing JSON fragment at the end of a sentence", () => {
      const text =
        'I\'ll tighten the screen for you.\n, {"metric": "DebtToEquity", "operator": "lt", "value": 1}]}';
      const out = stripLeakedJson(text);
      assert.ok(!out.includes("DebtToEquity"));
      assert.ok(out.includes("I'll tighten the screen for you."));
    });

    it("should strip orphaned closing braces/brackets", () => {
      const text = "Done.\n]}}";
      const out = stripLeakedJson(text);
      assert.ok(!out.includes("]}}"));
      assert.ok(out.includes("Done."));
    });

    it("should strip a standalone JSON array line", () => {
      const text = 'Results below.\n["NIFTY 50", "SENSEX"]';
      const out = stripLeakedJson(text);
      assert.ok(!out.includes("SENSEX"));
      assert.ok(out.includes("Results below."));
    });

    it("should collapse excess blank lines and trim", () => {
      const text = "Line one.\n\n\n\nLine two.   ";
      const out = stripLeakedJson(text);
      assert.ok(!out.includes("\n\n\n"));
      assert.strictEqual(out, "Line one.\n\nLine two.");
    });

    it("should handle empty input", () => {
      assert.strictEqual(stripLeakedJson(""), "");
    });
  });
});
