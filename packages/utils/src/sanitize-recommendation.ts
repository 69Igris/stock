/**
 * MONEY-457: Render-time recommendation-language scrubber.
 *
 * UseMoney is not a SEBI-registered Research Analyst or Investment Adviser.
 * Historical research reports stored in MongoDB still contain prose that
 * names BUY/SELL/HOLD/STRONG_BUY/STRONG_SELL recommendations, computes
 * "potential upside of X%" off DCF intrinsic values, or labels stocks as
 * "attractive long-term opportunities" — all of which qualify as research
 * recommendations under SEBI (Research Analysts) Regulations 2014.
 *
 * The companion prompt fix (also MONEY-457) stops new reports from
 * generating this language. This module scrubs the language at render
 * time so the ~thousands of existing reports do not need a DB migration.
 *
 * The function is idempotent: scrubbing already-scrubbed text is a no-op.
 */

/** Regex source for the canonical recommendation tokens. */
const REC_TOKEN_SRC =
  "strong[\\s_-]?buy|strong[\\s_-]?sell|buy|sell|hold|avoid|overweight|underweight|accumulate|reduce|neutral";

/**
 * Strip recommendation language from a prose string.
 *
 * Handles the leak vectors documented in MONEY-457 screenshots:
 *   1. ", leading to a 'STRONG_BUY' recommendation"
 *   2. ", suggesting a potential upside of 14.7% from the current price of ₹1,525"
 *   3. ", making it an attractive long-term opportunity"
 *   4. "presents a strong investment case"
 *   5. bare quoted/unquoted BUY/SELL/HOLD tokens
 */
export function stripRecommendationLanguage(text: string): string {
  if (!text || typeof text !== "string") return text;
  let s = text;

  // 1. Clause-form recommendations: ", leading to a 'STRONG_BUY' recommendation"
  //    Also catches: "suggesting a BUY rating", "warranting a HOLD recommendation",
  //                  "indicating a SELL signal", "making it a strong buy".
  const clauseLead =
    "leading to|suggesting|indicating|signal(?:l)?ing|warranting|making it|which (?:indicates|warrants|signals)|prompting";
  s = s.replace(
    new RegExp(
      `,?\\s*\\b(?:${clauseLead})\\s+(?:a\\s+|an\\s+)?["'‘’“”]?\\b(?:${REC_TOKEN_SRC})\\b["'‘’“”]?(?:\\s+(?:recommendation|rating|signal|call|stance))?`,
      "gi",
    ),
    "",
  );

  // 1a. Analyst-style rating verbs the clause-form patterns (1) never catch:
  //     "we rate this a BUY", "rates the stock a HOLD", "rated it a SELL",
  //     "rate Reliance STRONG BUY". A rating verb + verdict is itself a research
  //     recommendation under SEBI RA Regs 2014. Object-anchored (a "this/it/the
  //     stock/<SYMBOL>" must sit between the verb and the verdict) so ordinary
  //     finance prose like "the savings rate this year" or "exchange rate holds"
  //     is left untouched. An optional leading subject is consumed so no orphan
  //     "We" is stranded.
  s = s.replace(
    new RegExp(
      `\\b(?:we\\s+|i\\s+|they\\s+|our\\s+(?:team|analysts?)\\s+|analysts?\\s+|the\\s+(?:firm|desk|house)\\s+)?` +
        // Two object shapes (the `i` flag makes `[A-Z]` match lowercase, so a
        // generic word can't be the *sole* anchor): (1) a closed stock-referent
        // pronoun with an OPTIONAL article, or (2) any word except the connector
        // "as", which then REQUIRES an article — that article + verdict is what
        // keeps "the savings rate this year improved" from matching.
        `rate[sd]?\\s+(?:` +
        `(?:this|it|them|that|the\\s+(?:stock|fund|name|company|counter|scrip|share))\\s*(?:as\\s+)?(?:a\\s+|an\\s+)?` +
        `|(?!as\\b)[A-Za-z][A-Za-z.&-]{1,19}\\s+(?:as\\s+)?(?:a\\s+|an\\s+)` +
        `)["'‘’“”]?\\b(?:${REC_TOKEN_SRC})\\b["'‘’“”]?`,
      "gi",
    ),
    "",
  );

  // 1b. Passive "rated BUY" / "rated as a SELL" / "rated a HOLD" (no object) —
  //     keep the sentence flowing by neutralizing to "covered".
  s = s.replace(
    new RegExp(
      `\\brated\\s+(?:as\\s+)?(?:a\\s+|an\\s+)?["'‘’“”]?\\b(?:${REC_TOKEN_SRC})\\b["'‘’“”]?`,
      "gi",
    ),
    "covered",
  );

  // 2. Price-target / upside clauses tied to DCF or "current price":
  //    ", suggesting a potential upside of 14.7% from the current price of ₹1,525"
  //    ", representing an upside of 10% to current price"
  //    ", offering 12.5% downside from current levels"
  s = s.replace(
    /,?\s*(?:suggesting|implying|representing|indicating|offering|providing|with|for)\s+(?:a\s+|an\s+)?(?:potential\s+)?(?:upside|downside|return)\s+of\s+~?[\d.]+%\s*(?:from\s+(?:the\s+)?current\s+(?:price|levels?)(?:\s+of\s+[₹$][\d,]+(?:\.\d+)?)?)?/gi,
    "",
  );

  // 3. Bare upside/downside phrases: "10% upside from current price"
  s = s.replace(
    /,?\s*~?[\d.]+%\s+(?:potential\s+)?(?:upside|downside)\s+(?:from\s+|to\s+|relative to\s+)?(?:the\s+)?current\s+(?:price|levels?)(?:\s+of\s+[₹$][\d,]+(?:\.\d+)?)?/gi,
    "",
  );

  // 3a. Absolute rupee/dollar PRICE TARGETS: "target price of ₹4,000",
  //     "price target of ₹4000", "with a target of ₹4000", "PT ₹4000",
  //     "target: ₹4000", "our target of ₹4000". A named price target is a
  //     recommendation under SEBI RA Regs independent of any % upside framing
  //     (patterns 2/3 only catch the percentage form). The currency symbol is
  //     mandatory and the cr/crore/bn lookahead spares company REVENUE/PROFIT
  //     targets ("revenue target of ₹4000 crore"), which are observational.
  s = s.replace(
    /,?\s*(?:with\s+|at\s+|implying\s+|setting\s+|and\s+|having\s+)?(?:a\s+|an\s+|our\s+|the\s+)?(?:price\s+target|target\s+price|target|PT)\s*(?:of|:|=|at|near|around)?\s*[₹$]\s?[\d,]+(?:\.\d+)?\b(?:\s*(?:per\s+share|levels?))?(?!\s*(?:cr\b|crore|bn\b|billion|mn\b|million|lakh|k\b))/gi,
    "",
  );

  // 3b. Reversed form: "₹4000 target", "₹4,000 price target" (revenue targets
  //     in crore are excluded by the lookahead, same as 3a).
  s = s.replace(
    /,?\s*[₹$]\s?[\d,]+(?:\.\d+)?\s+(?:price\s+)?target\b(?!\s*(?:cr\b|crore))/gi,
    "",
  );

  // 4. "making it (a|an) [attractive|compelling|strong] [long-term|...] opportunity"
  s = s.replace(
    /,?\s*\bmaking it (?:a\s+|an\s+)(?:attractive|compelling|strong|favou?rable)\s+(?:long-term\s+|short-term\s+|medium-term\s+|near-term\s+)?(?:investment\s+)?opportunity\b/gi,
    "",
  );

  // 5. "presents/offers a (strong|compelling|attractive|weak) investment case"
  s = s.replace(
    /\b(?:presents?|presenting|offers?|offering|builds?|building|makes?|making)\s+(?:a\s+|an\s+)?(?:strong|compelling|attractive|favou?rable|weak|poor)\s+(?:investment\s+)?case\b/gi,
    "shows strong fundamentals",
  );

  // 6. Standalone "an attractive (long-term) opportunity" / "good entry point"
  s = s.replace(
    /\b(?:a|an)\s+(?:attractive|compelling|favou?rable)\s+(?:long-term\s+|short-term\s+|medium-term\s+|near-term\s+)?(?:investment\s+)?opportunity\b/gi,
    "a noteworthy profile",
  );
  s = s.replace(
    /\b(?:a\s+|an\s+)?(?:good|favou?rable|attractive|compelling)\s+entry\s+(?:point|level|zone)\b/gi,
    "valuation snapshot",
  );

  // 7. "X is a (better|preferred) pick (over|than) Y"
  s = s.replace(
    /\b(?:a\s+|an\s+)?(?:better|preferred|stronger|superior)\s+(?:pick|choice|bet|option)\s+(?:over|than|vs\.?)\s+\w+/gi,
    "a different profile",
  );

  // 8. "<Symbol> Preferred" pill leftover language inline (capitalized form)
  s = s.replace(/\b([A-Z]{2,12})\s+Preferred\b/g, "$1");

  // 8a. Lowercase "preferred" verdicts — equally a SEBI violation. Catches:
  //     "ACC is preferred", "ABB is the preferred entity",
  //     "preferred on a relative value basis", "preferred over peers",
  //     "preferred for value investors", "the preferred pick".
  //
  //     We strip the "is preferred ..." / "the preferred X" clause but
  //     leave the stock symbol intact so the surrounding sentence still
  //     reads.
  s = s.replace(
    /\b(is|are|remains?|stays?|becomes?)\s+(?:the\s+)?preferred\s+(?:on|for|over|by|in|across|among|as|due|because|owing)\b[^.,;]*/gi,
    "$1 noteworthy",
  );
  s = s.replace(
    /\b(?:is|are|remains?)\s+(?:the\s+)?preferred\b(?!\s+stock)/gi,
    "is noteworthy",
  );
  s = s.replace(
    /\b(?:the|our|this)\s+preferred\s+(?:pick|choice|entity|name|candidate|bet|holding|allocation)\b/gi,
    "the highlighted name",
  );
  s = s.replace(
    /\bpreferred\s+(?:over|relative\s+to|versus|vs\.?)\s+([A-Za-z][A-Za-z\s,]{0,40}?)(?=[.,;]|\s+(?:and|but|while|because|due|owing|given))/gi,
    "different from $1",
  );
  s = s.replace(
    /\bpreferred\s+for\s+(?:value|growth|income|momentum|defensive|quality)\s+(?:investors?|allocations?|portfolios?)\b/gi,
    "of interest to those investor profiles",
  );
  // Standalone "preferred" inside qualifying clauses like
  // "a preferred name", "a preferred candidate".
  s = s.replace(
    /\b(?:a|an)\s+preferred\s+(name|candidate|entity|pick|choice|stock|holding)\b/gi,
    "a noteworthy $1",
  );

  // 9. "STOCK_A_PREFERRED" / "STRONG_BUY" style tokens in prose
  s = s.replace(/\b(?:STOCK_[AB]_PREFERRED|EQUAL_PREFERRED)\b/g, "N/A");
  s = s.replace(
    /["'‘’“”]?\b(?:STRONG_?BUY|STRONG_?SELL|STRONG\s+BUY|STRONG\s+SELL)\b["'‘’“”]?/gi,
    "",
  );

  // 10. Trailing "BUY rating" / "SELL signal" / "HOLD call" without leading clause
  s = s.replace(
    new RegExp(
      `\\b(?:${REC_TOKEN_SRC})\\s+(?:rating|recommendation|signal|call|stance)\\b`,
      "gi",
    ),
    "rating",
  );

  // 11. Standalone "Recommendation: BUY/SELL/HOLD" lines (older reports
  //     occasionally inlined a label). Drop the whole line.
  s = s.replace(
    new RegExp(
      `\\b(?:Recommendation|Verdict|Rating|Call)\\s*[:=]\\s*["'‘’“”]?\\b(?:${REC_TOKEN_SRC})\\b["'‘’“”]?`,
      "gi",
    ),
    "",
  );

  // 12. "potential buy signal" / "potential sell signal" (technical
  //     interpretation language)
  s = s.replace(/\bpotential\s+(?:buy|sell)\s+signal\b/gi, "momentum signal");

  // 13. "good buying opportunity" / "good selling opportunity"
  s = s.replace(
    /\b(?:good|great|strong)\s+(?:buying|selling)\s+opportunity\b/gi,
    "noteworthy moment",
  );

  // 14. "intrinsic value of ₹X, representing an upside of Y%" → keep the
  //     intrinsic value, drop the upside framing.
  s = s.replace(
    /(intrinsic value of [₹$][\d,]+(?:\.\d+)?(?: per share)?)\s*,\s*representing\s+(?:a\s+|an\s+)?(?:potential\s+)?(?:upside|downside)\s+of\s+~?[\d.]+%/gi,
    "$1",
  );

  // 15. Unanchored DCF / valuation upside/downside framing.
  //     Pattern 2 only catches the form anchored on "current price"; this
  //     catches the bare form like "DCF shows -38.4% downside" or
  //     "model indicates 12% upside" which is equally a price-target
  //     leak per SEBI RA Regulations.
  s = s.replace(
    /\b(?:DCF(?:\s+(?:model|analysis))?|the\s+model|valuation\s+model|our\s+(?:DCF|model|analysis))\s+(?:shows?|indicates?|implies|projects?|produces?|yields?|points\s+to|reflects?)\s+(?:a\s+|an\s+)?-?~?[\d.]+%\s+(?:potential\s+)?(?:upside|downside)/gi,
    "the DCF model produced an intrinsic estimate",
  );

  // 16. "(Significantly|clearly|massively|...) overvalued / undervalued"
  //     and the bare forms — these are implicit recommendations under
  //     SEBI RA Regulations 2014 (an "overvalued" stock is an implicit
  //     SELL; "undervalued" is an implicit BUY).
  s = s.replace(
    /\b(?:significantly|clearly|massively|substantially|notably|considerably|severely|grossly|highly|deeply)\s+(over|under)valued\b/gi,
    (_, dir: string) =>
      dir.toLowerCase() === "over"
        ? "trading at a premium to fair value"
        : "trading at a discount to fair value",
  );
  s = s.replace(/\bovervalued\b/gi, "trading at a premium");
  s = s.replace(/\bundervalued\b/gi, "trading at a discount");

  // 17. Adverbial intensifiers that promote observation → verdict.
  //     "Debt-to-Equity is alarmingly high" reads as a sell signal even
  //     though the underlying fact ("D/E is high") is observational.
  //     Strip the adverb but keep the adjective.
  s = s.replace(
    /\b(?:alarmingly|extremely|dangerously|exceptionally|critically|worryingly|severely|excessively|distressingly)\s+(high|low|weak|strong|elevated|depressed|poor|positive|negative|good|bad|tight|loose)\b/gi,
    "$1",
  );

  // 18. Technical-analysis specific recommendation framing. Standard TA
  //     vocabulary ("overbought", "oversold", "RSI", "MACD") is
  //     observational and SAFE — these are mechanical readings of the
  //     indicator, not recommendations. But TA prose often goes on to
  //     translate those readings into action ("…suggesting entry",
  //     "…signals a long position", "primed for upside") — that crosses
  //     the SEBI line in the same way DCF prose does.
  //
  //     Drop the action-suggesting trailer; keep the indicator reading.
  s = s.replace(
    /,?\s*(?:suggesting|signal(?:l)?ing|indicating|warranting|implying|pointing\s+to|setting\s+up\s+for)\s+(?:a\s+|an\s+)?(?:entry|exit|long|short|long\s+position|short\s+position|buying|selling|accumulation|distribution|reduction|booking\s+profits?|profit\s+booking|breakout|breakdown)\b/gi,
    "",
  );

  // 19. "Primed for / ripe for / ready for / poised for upside / downside /
  //     a breakout / a breakdown / a move" — all imply impending action.
  s = s.replace(
    /\b(?:primed|ripe|ready|poised|set\s+up|positioned)\s+for\s+(?:a\s+|an\s+)?(?:upside|downside|breakout|breakdown|move(?:\s+up|\s+down)?|rally|correction|reversal|continuation|pullback)\b/gi,
    "in a watch-worthy state",
  );

  // 20. "Golden cross signals/suggests a buy" / "death cross indicates a
  //     sell" — bare "golden cross" and "death cross" are standard TA
  //     terms (mean SMA50 ↑/↓ SMA200) and stay; it's the trailing action
  //     that needs removal.
  s = s.replace(
    /\b(?:golden\s+cross|death\s+cross|bullish\s+crossover|bearish\s+crossover|breakout|breakdown)\s+(?:signal(?:l)?(?:ing|s)|indicat(?:ing|es)|suggest(?:ing|s)|trigger(?:ing|s))\s+(?:a\s+|an\s+)?(?:buy|sell|long|short|entry|exit|accumulation|distribution)\b/gi,
    (m) =>
      m
        .replace(
          /\s+(?:signal(?:l)?(?:ing|s)|indicat(?:ing|es)|suggest(?:ing|s)|trigger(?:ing|s))\s+(?:a\s+|an\s+)?(?:buy|sell|long|short|entry|exit|accumulation|distribution)\b/gi,
          "",
        )
        .trim(),
  );

  // 21. "Support at ₹X provides a buy zone" / "resistance at ₹Y caps upside"
  //     — drop the action framing; price levels themselves are fine.
  s = s.replace(
    /(\bsupport\b[^.]{0,40})\s+(?:provides?|offers?|defines?|marks?)\s+(?:a\s+|an\s+)?(?:buy|long|entry|accumulation)\s+zone\b/gi,
    "$1 holds as a key level",
  );
  s = s.replace(
    /(\bresistance\b[^.]{0,40})\s+(?:caps?|limits?|defines?|marks?)\s+(?:the\s+)?upside\b/gi,
    "$1 is the next overhead level",
  );

  // 22. "RSI at X is bullish/bearish for entry/exit" — the indicator value
  //     stays, the trailing action framing goes.
  s = s.replace(
    /\b(bullish|bearish)\s+(?:for|on)\s+(?:entry|exit|long|short|buying|selling)\b/gi,
    "$1",
  );

  // ─── Macro / sector allocation framing (MONEY-457) ─────────────
  //
  // Macro analysis prose tends to make asset-class calls — "bullish on
  // IT", "overweight bonds", "constructive on PSU banks". These are
  // research recommendations on a sector / asset class, equivalent in
  // SEBI terms to a stock-level BUY / SELL. Soften to observational
  // monitoring language.

  // 23. "Bullish / bearish / constructive / cautious / positive / negative
  //     on <X>" where X is a sector / asset class.
  s = s.replace(
    /\b(?:remain(?:s|ing)?\s+|stay(?:s|ing)?\s+|are\s+|is\s+|am\s+|we\s+are\s+|we\s+remain\s+)?(?:bullish|bearish|constructive|cautious)\s+on\s+([A-Za-z][A-Za-z\s&/-]{0,40}?(?:\s+sector|\s+stocks|\s+equities|\s+bonds|\s+commodities|\s+rupee|\s+INR|\s+banks|\s+IT|\s+pharma|\s+FMCG|\s+auto|\s+metals|\s+energy|\s+small[\s-]?caps?|\s+mid[\s-]?caps?|\s+large[\s-]?caps?))\b/gi,
    "monitoring $1",
  );

  // 24. "Overweight / underweight <X>" — explicit allocation calls.
  s = s.replace(
    /\b(?:we\s+remain\s+|we\s+are\s+|remain\s+|stay\s+|are\s+|is\s+)?(?:overweight|underweight)\s+([A-Za-z][A-Za-z\s&/-]{0,40}?(?:\s+sector|\s+stocks|\s+equities|\s+bonds|\s+commodities|\s+banks|\s+IT|\s+pharma|\s+FMCG|\s+auto|\s+metals|\s+energy)?)\b/gi,
    "neutral on $1",
  );

  // 25. "Tactical long/short [X]", "Strategic long/short [X]" — explicit
  //     position calls common in macro commentary.
  s = s.replace(
    /\b(?:tactical|strategic)\s+(?:long|short)\s+([A-Za-z][A-Za-z\s&/-]{0,40})\b/gi,
    "watching $1",
  );

  // 26. "Macro tailwinds make X attractive" / "Macro headwinds make Y
  //     vulnerable" — keep the macro observation, drop the implicit call.
  s = s.replace(
    /\b(macro\s+(?:tailwinds?|headwinds?))\s+make[s]?\s+([A-Za-z][A-Za-z\s&/-]{0,40}?)\s+(?:attractive|vulnerable|preferred|risky|compelling)\b/gi,
    "$1 affect $2",
  );

  // ─── Cleanup orphaned punctuation/whitespace after replacements ───
  s = s.replace(/\s+,/g, ",");
  s = s.replace(/,(\s*,)+/g, ",");
  s = s.replace(/,\s*\./g, ".");
  s = s.replace(/\s+\./g, ".");
  s = s.replace(/\.(\s*\.)+/g, ".");
  s = s.replace(/\(\s*\)/g, "");
  s = s.replace(/\(\s+/g, "(");
  s = s.replace(/\s+\)/g, ")");
  s = s.replace(/\s{2,}/g, " ");
  // Orphaned leading punctuation left when a clause at the very start was
  // stripped (e.g. "We rate this a BUY, given X" → ", given X" → "given X").
  s = s.replace(/^[\s,;:]+/, "");
  s = s.trim();

  return s;
}

/* ─────────────────────────────────────────────────────────────────────────
 * MONEY-778: advice-adjacent STRUCTURED fields.
 *
 * The prose scrubber above handles narrative leaks. But research compute tools
 * (DCF, DDM, scenario, Monte-Carlo, DCF-sensitivity) also emit raw numeric
 * fields that render as `key: value` rows in tool-result step views and report
 * tables — e.g. `expectedValue: 933.35`, `upside: 14.7`, `targetPrice: 4000`.
 * Shown bare, a single forward DIRECTIONAL value (a price *target*, a *return*,
 * or a probability-weighted *verdict*) reads as a recommendation, which a
 * non-RA platform must not surface (SEBI RA Regs 2014) — exactly the leak prose
 * patterns 14/15 strip from narrative.
 *
 * NOT on this list: `intrinsicValue`. The StockSage design surfaces it as a
 * framed "INTRINSIC ₹X" tile inside the DCF/valuation card (methodology shown:
 * WACC + scenarios), and the report's purpose-built DCF tiles read it directly.
 * A transparent valuation output with its assumptions in view is permitted —
 * it's the directional target/return framing that crosses the line (parity with
 * the prose scrubber, which keeps the intrinsic figure but drops upside/target).
 * `expectedValue` (a probability-weighted single verdict, the leak the user
 * flagged, and absent from the design) IS scrubbed. `currentPrice` is a
 * present-tense market fact and is intentionally NOT on this list.
 * ───────────────────────────────────────────────────────────────────────── */
export const ADVICE_ADJACENT_FIELDS: ReadonlySet<string> = new Set([
  "expectedvalue",
  "fairvalue",
  "fairprice",
  "targetprice",
  "pricetarget",
  "targetvalue",
  "dcfvalue",
  "expectedprice",
  "upside",
  "downside",
  "potentialupside",
  "potentialdownside",
  "impliedupside",
  "impliedreturn",
  "expectedreturn",
  "valuationgap",
  "petarget",
]);

/** Normalize a field key for denylist lookup: lowercase, strip separators. */
function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * True when a structured-data field name is advice-adjacent (a forward
 * value / price target / implied return) and must be withheld from a bare
 * `key: value` display. See {@link ADVICE_ADJACENT_FIELDS}.
 */
export function isAdviceAdjacentField(key: string): boolean {
  return ADVICE_ADJACENT_FIELDS.has(normalizeFieldKey(key));
}

/** Muted footnote shown when ≥1 advice-adjacent field was withheld from a view. */
export const ADVICE_FIELDS_WITHHELD_NOTE =
  "Forward-value fields (intrinsic value / target / upside) hidden — informational, not a price target.";

/**
 * Drop advice-adjacent fields from a flat record of structured tool data,
 * returning the safe entries plus a flag for whether anything was withheld
 * (so callers can render {@link ADVICE_FIELDS_WITHHELD_NOTE}).
 */
export function scrubAdviceFields(entries: Array<[string, unknown]>): {
  safe: Array<[string, unknown]>;
  withheld: boolean;
} {
  const safe = entries.filter(([k]) => !isAdviceAdjacentField(k));
  return { safe, withheld: safe.length !== entries.length };
}

/**
 * Compose with `stripExchangeSuffix` (or any other prose normalizer).
 * Order: scrub recommendation language first, then normalize symbols.
 */
export function scrubProse(
  text: string,
  ...transforms: Array<(t: string) => string>
): string {
  let out = stripRecommendationLanguage(text);
  for (const t of transforms) out = t(out);
  return out;
}
