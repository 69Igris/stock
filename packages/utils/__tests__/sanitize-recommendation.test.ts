/**
 * MONEY-457: Tests for the render-time recommendation-language scrubber.
 *
 * Each test case below is anchored to a real leak observed in production
 * reports (taken from MONEY-457 screenshots) or to a forbidden phrase
 * listed in the SEBI compliance directive.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripRecommendationLanguage,
  scrubProse,
  isAdviceAdjacentField,
  scrubAdviceFields,
} from "../src/sanitize-recommendation";

describe("stripRecommendationLanguage — SEBI scrubber", () => {
  describe("clause-form recommendations", () => {
    it("drops 'leading to a STRONG_BUY recommendation'", () => {
      const input =
        "Our analysis assigns HDFC Bank a score of 76, leading to a 'STRONG_BUY' recommendation. This is underpinned by exceptional profitability.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/STRONG_BUY/i.test(out), `STRONG_BUY survived in: ${out}`);
      assert.ok(
        !/recommendation/i.test(out),
        `recommendation survived: ${out}`,
      );
      assert.ok(
        /score of 76\. This is underpinned/.test(out),
        `Bad shape: ${out}`,
      );
    });

    it("drops 'suggesting a BUY rating'", () => {
      const input = "The fundamentals are strong, suggesting a BUY rating.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/buy/i.test(out));
      assert.ok(!/rating/i.test(out) || /^The fundamentals/.test(out));
    });

    it("drops 'indicating a SELL signal'", () => {
      const input = "Margins are compressing, indicating a SELL signal.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/\bSELL\b/i.test(out));
    });

    it("drops 'warranting a HOLD recommendation'", () => {
      const input = "Valuation is fair, warranting a HOLD recommendation.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/HOLD/i.test(out));
    });

    it("handles smart quotes", () => {
      const input =
        "Our DCF leads to a “STRONG_BUY” recommendation per the model.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/STRONG_BUY/i.test(out));
    });
  });

  describe("price target / upside framing", () => {
    it("drops 'suggesting a potential upside of 14.7% from the current price of ₹1,525'", () => {
      const input =
        "Our DCF analysis indicates an intrinsic value of ₹1,750 per share, suggesting a potential upside of 14.7% from the current price of ₹1,525.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/upside/i.test(out), `upside survived: ${out}`);
      assert.ok(
        !/current price of ₹1,525/i.test(out),
        `price target survived: ${out}`,
      );
      assert.ok(
        /intrinsic value of ₹1,750/.test(out),
        `lost intrinsic: ${out}`,
      );
    });

    it("drops 'X% upside from current price'", () => {
      const input =
        "DCF intrinsic is ₹2,000, a 10% upside from the current price of ₹1,818.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/upside/i.test(out));
    });

    it("drops 'representing a Y% downside'", () => {
      const input =
        "Fair value is ₹500, representing a 15% downside from current levels.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/downside/i.test(out));
    });
  });

  describe("soft recommendation framing", () => {
    it("strips 'making it an attractive long-term opportunity'", () => {
      const input =
        "PE of 18.1x sits slightly below sector average of 18.5x, making it an attractive long-term opportunity.";
      const out = stripRecommendationLanguage(input);
      assert.ok(
        !/attractive long-term opportunity/i.test(out),
        `survived: ${out}`,
      );
    });

    it("rewrites 'presents a strong investment case'", () => {
      const input =
        "HDFC Bank presents a strong investment case, underpinned by market leadership.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/strong investment case/i.test(out), `survived: ${out}`);
      assert.ok(
        /HDFC Bank shows strong fundamentals/.test(out),
        `Bad rewrite: ${out}`,
      );
    });

    it("rewrites bare 'an attractive opportunity'", () => {
      const input =
        "The stock looks like an attractive opportunity at these levels.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/attractive (long-term )?opportunity/i.test(out));
    });

    it("rewrites 'good entry point'", () => {
      const input = "The pullback creates a good entry point for accumulation.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/good entry point/i.test(out));
    });

    it("rewrites 'X is a better pick than Y'", () => {
      const input = "TCS is a better pick than INFY on current numbers.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/better pick/i.test(out));
    });
  });

  describe("bare tokens and label lines", () => {
    it("strips standalone quoted STRONG_BUY", () => {
      const input = "Verdict: 'STRONG_BUY' on the basis of margin expansion.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/STRONG_?BUY/i.test(out));
    });

    it("strips 'Recommendation: BUY' label lines", () => {
      const input = "Summary: solid fundamentals. Recommendation: BUY";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/Recommendation:\s*BUY/i.test(out));
    });

    it("strips STOCK_A_PREFERRED token", () => {
      const input = "Verdict: STOCK_A_PREFERRED based on lower PE.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/STOCK_A_PREFERRED/.test(out));
    });

    it("strips 'AMBER Preferred' inline phrasing", () => {
      const input = "On risk-adjusted metrics, AMBER Preferred over peers.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/AMBER\s+Preferred/.test(out));
    });

    it("rewrites 'potential buy signal'", () => {
      const input = "RSI < 30 is often a potential buy signal.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/potential buy signal/i.test(out));
    });
  });

  // MONEY-620 (task 137): the clause-form patterns missed two whole families —
  // analyst rating VERBS ("we rate this a BUY") and ABSOLUTE rupee price targets
  // ("target ₹4000", as opposed to a % upside). Both are SEBI RA recommendations.
  describe("analyst rating verbs + absolute price targets (task 137)", () => {
    it("scrubs the canonical 'we rate this a BUY with target ₹4000' leak", () => {
      const input =
        "We rate this a BUY with target ₹4000, given strong fundamentals.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/\bBUY\b/i.test(out), `verdict survived: ${out}`);
      assert.ok(!/target/i.test(out), `price target survived: ${out}`);
      assert.ok(!/4000/.test(out), `target number survived: ${out}`);
      assert.ok(/strong fundamentals/.test(out), `context dropped: ${out}`);
    });

    it("scrubs 'rate it a HOLD' / 'rates the stock a SELL' (object-anchored)", () => {
      assert.ok(
        !/\bhold\b/i.test(
          stripRecommendationLanguage("I rate it a HOLD here."),
        ),
      );
      assert.ok(
        !/\bsell\b/i.test(
          stripRecommendationLanguage("The desk rates the stock a SELL."),
        ),
      );
    });

    it("scrubs 'rate Reliance a STRONG BUY' (symbol object)", () => {
      const out = stripRecommendationLanguage(
        "We rate Reliance a STRONG BUY on the refining cycle.",
      );
      assert.ok(!/strong\s*buy/i.test(out), out);
      assert.ok(!/\bbuy\b/i.test(out), out);
    });

    it("neutralizes passive 'rated BUY' / 'rated as a SELL' to 'covered'", () => {
      assert.ok(
        !/\bbuy\b/i.test(
          stripRecommendationLanguage("The stock is rated BUY."),
        ),
      );
      const out = stripRecommendationLanguage(
        "It was rated as a SELL by them.",
      );
      assert.ok(!/\bsell\b/i.test(out), out);
      assert.ok(/covered/i.test(out), out);
    });

    it("strips absolute price targets (of/PT/reversed/colon forms)", () => {
      for (const input of [
        "The DCF supports a price target of ₹4,000 per share.",
        "PT ₹4000 on a 1-year view.",
        "Our analysis points to a ₹4000 target.",
        "Target price: ₹3,250 over twelve months.",
        "We maintain our target of ₹4000.",
      ]) {
        const out = stripRecommendationLanguage(input);
        assert.ok(!/target/i.test(out), `target survived: ${out}`);
        assert.ok(!/₹\s?[\d,]+/.test(out), `price survived: ${out}`);
      }
    });

    it("does NOT strip company REVENUE targets in crore (observational)", () => {
      const input = "The company set a revenue target of ₹4000 crore for FY25.";
      const out = stripRecommendationLanguage(input);
      assert.ok(/revenue target of ₹4000 crore/i.test(out), out);
    });

    it("does NOT false-positive on 'rate' as a noun (savings/exchange/growth)", () => {
      for (const input of [
        "The savings rate this year improved to 8%.",
        "The exchange rate held steady against the dollar.",
        "GDP growth rate this quarter beat estimates.",
      ]) {
        assert.strictEqual(stripRecommendationLanguage(input), input);
      }
    });

    it("is idempotent on the canonical rating+target leak", () => {
      const input =
        "We rate this a BUY with a target price of ₹4000, supported by margins.";
      const once = stripRecommendationLanguage(input);
      const twice = stripRecommendationLanguage(once);
      assert.strictEqual(once, twice);
    });
  });

  describe("idempotency", () => {
    it("scrubbing already-clean text is a no-op", () => {
      const input =
        "HDFC Bank shows strong fundamentals with PE 18x, ROE 16.7%, and stable margins. Not financial advice — consult a SEBI-registered advisor.";
      const first = stripRecommendationLanguage(input);
      const second = stripRecommendationLanguage(first);
      assert.strictEqual(first, second);
    });

    it("scrubbing twice produces identical output (full leak case)", () => {
      const input =
        "Our analysis assigns HDFC Bank a score of 76, leading to a 'STRONG_BUY' recommendation. DCF indicates ₹1,750 per share, suggesting a potential upside of 14.7% from the current price of ₹1,525, making it an attractive long-term opportunity.";
      const first = stripRecommendationLanguage(input);
      const second = stripRecommendationLanguage(first);
      assert.strictEqual(first, second);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      assert.strictEqual(stripRecommendationLanguage(""), "");
    });

    it("preserves text with no recommendation language", () => {
      const input =
        "ROE has risen from 14.2% to 16.7% over the last 3 fiscals.";
      assert.strictEqual(stripRecommendationLanguage(input), input);
    });

    it("does not touch the word 'HOLDINGS' (section headers)", () => {
      const input = "HOLDINGS-SPECIFIC ASSESSMENT: position size is 8%.";
      const out = stripRecommendationLanguage(input);
      assert.ok(/HOLDINGS/.test(out));
    });

    it("does not mangle multi-line input", () => {
      const input =
        "Strengths:\n- ROE 16.7%\n- Low NPAs\nRisks:\n- NIM compression";
      const out = stripRecommendationLanguage(input);
      assert.ok(out.includes("Strengths:"));
      assert.ok(out.includes("Risks:"));
    });
  });

  describe("scrubProse composition", () => {
    it("composes with additional transforms", () => {
      const input = "RELIANCE.NS leads to a BUY recommendation.";
      const out = scrubProse(input, (t) => t.replace(/\.(NS|BO)\b/g, ""));
      assert.ok(!/\.NS/.test(out));
      assert.ok(!/BUY/i.test(out));
    });
  });

  describe("unanchored DCF % framing (MONEY-457 follow-up)", () => {
    it("drops 'DCF shows -38.4% downside'", () => {
      const input =
        "Significantly overvalued. DCF shows -38.4% downside. TTM PE is high at 39.4x.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/-?38\.4%\s+downside/i.test(out), `survived: ${out}`);
      assert.ok(/intrinsic estimate/i.test(out), `lost replacement: ${out}`);
    });

    it("drops 'the DCF model indicates 12% upside'", () => {
      const input = "Earnings are stable. The DCF model indicates 12% upside.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/12%\s+upside/i.test(out));
    });

    it("drops 'our valuation model projects 8.5% downside'", () => {
      const input =
        "Our valuation model projects 8.5% downside on a 5y horizon.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/8\.5%\s+downside/i.test(out));
    });
  });

  describe("overvalued / undervalued verdicts (MONEY-457 follow-up)", () => {
    it("rewrites 'Significantly overvalued'", () => {
      const input = "Significantly overvalued at current levels.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/overvalued/i.test(out));
      assert.ok(/premium to fair value/i.test(out));
    });

    it("rewrites bare 'overvalued'", () => {
      const input = "The stock is overvalued on PE basis.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/overvalued/i.test(out));
      assert.ok(/premium/i.test(out));
    });

    it("rewrites 'massively undervalued' to discount framing", () => {
      const input = "Massively undervalued vs sector peers.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/undervalued/i.test(out));
      assert.ok(/discount/i.test(out));
    });

    it("rewrites bare 'undervalued'", () => {
      const input = "Undervalued at these multiples.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/undervalued/i.test(out));
    });
  });

  describe("adverbial intensifiers (MONEY-457 follow-up)", () => {
    it("strips 'alarmingly high'", () => {
      const input = "Debt-to-Equity is alarmingly high at 2.1x.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/alarmingly/i.test(out));
      assert.ok(/Debt-to-Equity is high at 2\.1x/.test(out));
    });

    it("strips 'extremely weak'", () => {
      const input = "Balance sheet is extremely weak. Current ratio 0.83.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/extremely/i.test(out));
      assert.ok(/weak/i.test(out));
    });

    it("strips 'dangerously low'", () => {
      const input = "Liquidity is dangerously low.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/dangerously/i.test(out));
      assert.ok(/low/i.test(out));
    });

    it("strips 'exceptionally strong'", () => {
      const input = "ROE is exceptionally strong at 27.7%.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/exceptionally/i.test(out));
      assert.ok(/ROE is strong at 27\.7%/.test(out));
    });
  });

  describe("technical-analysis recommendation framing (MONEY-457 follow-up)", () => {
    it("drops 'suggesting a long entry'", () => {
      const input = "RSI broke above 60, suggesting a long entry.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/long entry/i.test(out));
      assert.ok(!/suggesting/i.test(out));
      assert.ok(/RSI broke above 60/.test(out));
    });

    it("drops 'signals a buy'", () => {
      const input = "Golden cross signals a buy.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/signals a buy/i.test(out));
      assert.ok(/golden cross/i.test(out));
    });

    it("rewrites 'primed for a breakout'", () => {
      const input = "Consolidation tightening — primed for a breakout.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/primed for a breakout/i.test(out));
      assert.ok(/watch-worthy state/i.test(out));
    });

    it("rewrites 'poised for upside'", () => {
      const input = "ADX rising — poised for upside.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/poised for upside/i.test(out));
    });

    it("drops 'support provides a buy zone'", () => {
      const input = "Support at ₹1,500 provides a buy zone.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/buy zone/i.test(out));
      assert.ok(/Support at ₹1,500/.test(out));
    });

    it("drops 'bullish for entry'", () => {
      const input = "MACD turning up — bullish for entry.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/bullish for entry/i.test(out));
      assert.ok(/bullish/i.test(out));
    });
  });

  describe("lowercase 'preferred' verdicts (MONEY-457 follow-up #2)", () => {
    it("strips 'ACC is preferred on a relative value basis'", () => {
      const input =
        "ACC is preferred on a relative value basis, offering a lower valuation.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/is\s+preferred\s+on/i.test(out), `survived: ${out}`);
      assert.ok(/ACC/.test(out));
    });

    it("strips 'ABB is the preferred entity'", () => {
      const input = "ABB is the preferred entity due to its superior margins.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/preferred entity/i.test(out));
      assert.ok(/ABB/.test(out));
    });

    it("rewrites 'a preferred candidate'", () => {
      const input = "ACC emerges as a preferred candidate for value investors.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/a preferred candidate/i.test(out));
      assert.ok(/noteworthy candidate/i.test(out));
    });

    it("rewrites 'preferred over peers'", () => {
      const input = "ABB stands preferred over peers on quality metrics.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/preferred over peers/i.test(out));
    });

    it("rewrites 'preferred for value investors'", () => {
      const input = "ACC looks preferred for value investors today.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/preferred for value investors/i.test(out));
    });

    it("rewrites 'is preferred' bare form", () => {
      const input = "On a risk-adjusted basis, ACC is preferred.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/is preferred\b/i.test(out));
      assert.ok(/ACC is noteworthy/i.test(out));
    });

    it("leaves 'preferred stock' (capital-structure term) alone", () => {
      const input = "The issuer raised funds via preferred stock issuance.";
      const out = stripRecommendationLanguage(input);
      assert.ok(/preferred stock/i.test(out));
    });
  });

  describe("macro / sector allocation framing (MONEY-457 follow-up)", () => {
    it("rewrites 'bullish on IT sector'", () => {
      const input = "We remain bullish on IT sector given USD tailwinds.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/bullish on IT/i.test(out));
      assert.ok(/monitoring IT/i.test(out));
    });

    it("rewrites 'bearish on PSU banks'", () => {
      const input = "Bearish on PSU banks on asset quality concerns.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/bearish on PSU banks/i.test(out));
      assert.ok(/monitoring PSU banks/i.test(out));
    });

    it("rewrites 'overweight equities'", () => {
      const input = "We are overweight equities into year-end.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/overweight equities/i.test(out));
      assert.ok(/neutral on equities/i.test(out));
    });

    it("rewrites 'tactical long metals'", () => {
      const input = "Tactical long metals on China stimulus.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/tactical long metals/i.test(out));
      assert.ok(/watching metals/i.test(out));
    });

    it("rewrites 'macro tailwinds make IT attractive'", () => {
      const input =
        "Macro tailwinds make IT attractive amid rupee depreciation.";
      const out = stripRecommendationLanguage(input);
      assert.ok(!/make IT attractive/i.test(out));
      assert.ok(/macro tailwinds affect IT/i.test(out));
    });
  });

  describe("full HDFCBANK leak (the screenshot scenario)", () => {
    it("scrubs the canonical leak prose to no recommendation language", () => {
      const input =
        "HDFC Bank presents a strong investment case, underpinned by its market leadership and robust financial health. Our DCF analysis indicates an intrinsic value of ₹1,750 per share, suggesting a potential upside of 14.7% from the current price of ₹1,525. The bank demonstrates excellent earnings quality with operating cash flow at 1.23x net income. The stock trades at a fair P/E of 18.1x, slightly below the sector average of 18.5x, making it an attractive long-term opportunity.";
      const out = stripRecommendationLanguage(input);

      // Hard checks: no forbidden token, no forbidden phrase.
      const forbiddenTokens =
        /\b(STRONG[_ ]?BUY|STRONG[_ ]?SELL|BUY|SELL|HOLD|AVOID)\b/i;
      const forbiddenPhrases =
        /strong investment case|attractive long-term opportunity|potential upside of|from the current price of|good entry point|better pick/i;

      assert.ok(!forbiddenTokens.test(out), `Forbidden token survived: ${out}`);
      assert.ok(
        !forbiddenPhrases.test(out),
        `Forbidden phrase survived: ${out}`,
      );

      // Soft check: key data points survive.
      assert.ok(/1,750/.test(out), "Intrinsic value number lost");
      assert.ok(/18\.1x/.test(out), "PE number lost");
      assert.ok(/1\.23x/.test(out), "CF/NI ratio lost");
    });
  });
});

describe("advice-adjacent structured fields (MONEY-778)", () => {
  describe("isAdviceAdjacentField", () => {
    it("flags forward target / return / verdict field names", () => {
      for (const k of [
        "expectedValue", // probability-weighted single verdict (the leak)
        "fairValue",
        "targetPrice",
        "priceTarget",
        "upside",
        "downside",
        "expectedReturn",
        "impliedReturn",
        "valuationGap",
      ]) {
        assert.ok(isAdviceAdjacentField(k), `${k} should be advice-adjacent`);
      }
    });

    it("normalizes case and separators", () => {
      assert.ok(isAdviceAdjacentField("Expected_Value"));
      assert.ok(isAdviceAdjacentField("TARGET-PRICE"));
      assert.ok(isAdviceAdjacentField("expected value"));
    });

    it("leaves observational fields AND framed intrinsic value alone", () => {
      for (const k of [
        "currentPrice", // present market fact, not a forecast
        "intrinsicValue", // design surfaces it framed (WACC + scenarios)
        "revenue",
        "pe",
        "score",
        "probability",
        "marketCap",
        "wacc",
      ]) {
        assert.ok(!isAdviceAdjacentField(k), `${k} should NOT be flagged`);
      }
    });
  });

  describe("scrubAdviceFields", () => {
    it("drops advice-adjacent entries but keeps intrinsic value", () => {
      const { safe, withheld } = scrubAdviceFields([
        ["currentPrice", 1293],
        ["expectedValue", 933.35], // the MONEY-778 leak → dropped
        ["intrinsicValue", 1500], // design shows it → kept
        ["upside", 14.7], // directional → dropped
        ["pe", 24.3],
      ]);
      assert.equal(withheld, true);
      const keys = safe.map(([k]) => k);
      assert.deepEqual(keys, ["currentPrice", "intrinsicValue", "pe"]);
      assert.ok(
        !keys.includes("expectedValue") && !keys.includes("upside"),
        "directional / verdict values must not survive",
      );
    });

    it("withheld=false when nothing was advice-adjacent", () => {
      const { safe, withheld } = scrubAdviceFields([
        ["currentPrice", 1293],
        ["revenue", 39850],
      ]);
      assert.equal(withheld, false);
      assert.equal(safe.length, 2);
    });
  });
});
