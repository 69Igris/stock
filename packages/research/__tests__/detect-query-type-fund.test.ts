/**
 * detectQueryType — fund (MF/ETF) routing — REAL export.  MONEY-1073
 *
 * The synthesizer has a fund-specific prompt keyed on queryType "mf"/"etf"
 * (getSynthesizerPrompt), and the mf-analysis skill injects that queryType on
 * its synthesize task. But `detectQueryType` had no fund branch, so the agent's
 * per-task `queryType = detectQueryType(query)` returned `undefined` for a
 * `[MUTUAL_FUND] …` run — the fund was synthesized with the STOCK prompt and
 * the synthesis step failed ("RESEARCH FAILED" at SYNTHESIZING).
 *
 * These bind to the REAL exported `detectQueryType` (no shadow) and pin:
 *   - a `[MUTUAL_FUND]` / `[ETF]` prefixed query → "mf" / "etf";
 *   - the fund-prefix check WINS over keyword checks even when the fund NAME
 *     contains "sector" / "valuation" / "portfolio" (real fund names do);
 *   - non-fund queries keep their existing classification (no regression).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectQueryType } from "../src/agent-logic";

describe("MONEY-1073 — detectQueryType routes fund-shaped queries", () => {
  it("a [MUTUAL_FUND] query → 'mf'", () => {
    assert.equal(
      detectQueryType(
        "[MUTUAL_FUND] Edelweiss Banking and PSU Debt Fund - Direct Plan - IDCW Option",
      ),
      "mf",
    );
    assert.equal(detectQueryType("[MUTUAL_FUND] 140288"), "mf");
  });

  it("an [ETF] query → 'etf'", () => {
    assert.equal(detectQueryType("[ETF] NIFTYBEES"), "etf");
  });

  it("the fund prefix WINS over keyword checks in the fund name", () => {
    // "sector" / "valuation" / "banking" in the NAME must not mis-route a fund
    // to the stock (sector/valuation) synthesizer prompt.
    assert.equal(detectQueryType("[MUTUAL_FUND] HDFC Sectoral Fund"), "mf");
    assert.equal(
      detectQueryType("[MUTUAL_FUND] Quant Value Fund - Direct Plan"),
      "mf",
    );
    assert.equal(detectQueryType("[ETF] Nippon India ETF Nifty Bank"), "etf");
  });
});

describe("MONEY-1073 — non-fund detectQueryType classification is unchanged", () => {
  it("comparison / sector / valuation / strategy still classify", () => {
    assert.equal(detectQueryType("compare TCS vs INFY"), "comparison");
    assert.equal(detectQueryType("IT sector outlook"), "sector");
    assert.equal(detectQueryType("DCF valuation of RELIANCE"), "valuation");
    assert.equal(detectQueryType("golden cross stocks in nifty"), "strategy");
  });

  it("a plain single-stock query → undefined (mode-based stock prompt)", () => {
    assert.equal(detectQueryType("analyse RELIANCE"), undefined);
    assert.equal(detectQueryType("how is TCS doing"), undefined);
  });
});
