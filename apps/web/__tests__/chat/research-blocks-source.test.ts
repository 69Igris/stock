/**
 * MONEY-620 — research-blocks.ts REAL-SOURCE de-shadow + negative / edge.
 *
 * The large existing research-blocks.test.ts INLINES convertResearchToBlocks /
 * convertStructuredReportToBlocks and the helpers (isStructuredReport,
 * normalizeQualityScore, isComparisonRec) — so c8 sees 0% on the real file and
 * a divergence between the copy and source would ship green.
 *
 * This file imports the REAL exports
 * (apps/web/lib/chat/research-blocks.ts — confirmed importable with no
 * server-only deps) and drives them through their public seams:
 *   - convertResearchToBlocks      (structured + fallback paths)
 *   - convertFullReportToBlocks    (structured expansion + non-structured fallback)
 *   - dataSourceProviders          (tool-name → provider mapping, deduped)
 * exercising the internal isStructuredReport / score-normalisation /
 * recommendation-scrub branches that the inline copy used to shadow, plus
 * adversarial input: null/empty report, malformed structured report, oversized
 * arrays, and recommendation-language injection in stored prose.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  convertResearchToBlocks,
  convertFullReportToBlocks,
  dataSourceProviders,
} from "../../lib/chat/research-blocks";

type Block = ReturnType<typeof convertResearchToBlocks>[number];

interface ResearchResultLike {
  report: unknown;
  contentBlocks: unknown[];
  qualityScore?: number;
  tokensUsed: number;
  symbols: string[];
  sessionId?: string;
}

function base(over: Partial<ResearchResultLike> = {}): ResearchResultLike {
  return {
    report: null,
    contentBlocks: [],
    tokensUsed: 0,
    symbols: ["TCS"],
    ...over,
  };
}

function types(blocks: Block[]): string[] {
  return blocks.map((b) => (b as { type: string }).type);
}

function joinText(blocks: Block[]): string {
  return blocks
    .filter((b) => (b as { type: string }).type === "text")
    .map((b) => (b as { content?: string }).content ?? "")
    .join("\n");
}

describe("MONEY-620 convertResearchToBlocks — empty / null fallbacks", () => {
  it("null report + no blocks + no score → single 'no results' text block (never empty, never throws)", () => {
    const blocks = convertResearchToBlocks(base({ report: null }));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.match(
      (blocks[0] as { content: string }).content,
      /no results available/i
    );
  });

  it("non-structured string report → falls through to a text block with the content", () => {
    const blocks = convertResearchToBlocks(
      base({ report: { content: "Plain narrative summary." } })
    );
    assert.ok(types(blocks).includes("text"));
    assert.match(joinText(blocks), /Plain narrative summary\./);
  });

  it("qualityScore on the non-structured path emits a scorecard (0-100 normalised)", () => {
    const blocks = convertResearchToBlocks(
      base({ report: { content: "x" }, qualityScore: 0.83, symbols: ["INFY"] })
    );
    const sc = blocks.find((b) => b.type === "scorecard") as
      | Record<string, unknown>
      | undefined;
    assert.ok(sc, "scorecard emitted on fallback path");
    assert.equal(sc!.overall, 83); // 0.83 → 83
    assert.equal(sc!.symbol, "INFY");
  });

  it("qualityScore already on 0-100 scale is rounded, not multiplied", () => {
    const blocks = convertResearchToBlocks(
      base({ report: { content: "x" }, qualityScore: 72.4 })
    );
    const sc = blocks.find((b) => b.type === "scorecard") as
      | Record<string, unknown>
      | undefined;
    assert.equal(sc!.overall, 72);
  });

  it("worker-produced contentBlocks pass through when valid; invalid ones are dropped", () => {
    const blocks = convertResearchToBlocks(
      base({
        report: null,
        contentBlocks: [
          { type: "text", content: "kept" },
          { type: "not-a-real-block", content: "dropped" },
          "garbage-non-object",
        ],
      })
    );
    assert.match(joinText(blocks), /kept/);
    assert.doesNotMatch(joinText(blocks), /dropped/);
  });
});

describe("MONEY-620 convertResearchToBlocks — structured report path (isStructuredReport branch)", () => {
  it("report with a numeric score → scorecard block leads, View Full Analysis nav present", () => {
    const blocks = convertResearchToBlocks(
      base({
        report: { score: 68, summary: "Solid franchise. Reasonable value." },
        sessionId: "sess-123",
        symbols: ["HDFCBANK"],
      })
    );
    assert.equal(blocks[0].type, "scorecard");
    assert.equal((blocks[0] as unknown as Record<string, unknown>).overall, 68);
    const nav = blocks.find((b) => b.type === "navigation") as
      | Record<string, unknown>
      | undefined;
    assert.ok(nav, "navigation block present when sessionId set");
    const links = nav!.links as Array<{ href: string }>;
    assert.ok(links.some((l) => l.href.includes("/analysis/sess-123")));
  });

  it("report nested under .content is still detected as structured", () => {
    const blocks = convertResearchToBlocks(
      base({
        report: { content: { score: 55, summary: "ok" } },
        symbols: ["TCS"],
      })
    );
    assert.equal(blocks[0].type, "scorecard");
    assert.equal((blocks[0] as unknown as Record<string, unknown>).overall, 55);
  });

  it("structured report missing score but with recommendation string is STILL structured", () => {
    const blocks = convertResearchToBlocks(
      base({ report: { recommendation: "EQUAL" }, symbols: ["TCS"] })
    );
    // recommendation alone makes isStructuredReport true → scorecard path,
    // score defaults to 0.
    assert.equal(blocks[0].type, "scorecard");
    assert.equal((blocks[0] as unknown as Record<string, unknown>).overall, 0);
  });
});

describe("MONEY-620 convertFullReportToBlocks — expansion + scrub + edge", () => {
  it("non-structured report falls back to the summary converter (no throw)", () => {
    const blocks = convertFullReportToBlocks(base({ report: null }));
    assert.ok(blocks.length >= 1);
    assert.equal(blocks[0].type, "text"); // same fallback as summary path
  });

  it("documented MONEY-457 recommendation vectors ARE scrubbed in rendered prose", () => {
    // Asserts the scrubber's documented contract through the real render seam:
    //   - "leading to a STRONG_BUY recommendation" clause is removed
    //   - "BUY rating" clause becomes a neutral "rating"
    //   - "significantly undervalued" → premium/discount-to-fair-value wording
    const blocks = convertFullReportToBlocks(
      base({
        report: {
          score: 70,
          summary:
            "Strong quarter, leading to a STRONG_BUY recommendation overall.",
          sections: [
            {
              title: "Valuation",
              type: "valuation",
              content:
                "The stock is significantly undervalued and this gives a BUY rating.",
            },
          ],
        },
        sessionId: "s1",
        symbols: ["TCS"],
      })
    );
    const allText = JSON.stringify(blocks);
    assert.doesNotMatch(allText, /STRONG_BUY/);
    assert.doesNotMatch(allText, /BUY rating/);
    assert.doesNotMatch(allText, /undervalued/);
    assert.match(allText, /discount to fair value/);
  });

  // SEBI gap CLOSED (MONEY-620 / was MONEY-137): the formerly-skipped residual
  // hole — a bare analyst-verb verdict + freeform price target, e.g.
  // "we rate this a BUY with a target price of ₹4000" — is now scrubbed by the
  // REAL scrubber (apps/web/lib/utils/sanitize-recommendation.ts patterns 1a
  // "rate[sd]? <object> <verdict>" + 3a "target price of ₹X"). Both the literal
  // "BUY" token and the rupee price target are neutralised before render.
  // This test drives the REAL render seam (convertFullReportToBlocks →
  // stripRecommendationLanguage), so a regression in either pattern fails here.
  it("bare 'rate this a BUY with a target price' phrasing is scrubbed (SEBI gap, real seam)", () => {
    const blocks = convertFullReportToBlocks(
      base({
        report: {
          score: 70,
          summary: "We rate this a BUY with a target price of ₹4000.",
        },
        symbols: ["TCS"],
      })
    );
    const allText = JSON.stringify(blocks);
    assert.doesNotMatch(allText, /\bBUY\b/);
    assert.doesNotMatch(allText, /target price/i);
  });

  // Regression cohort for the same gap, through the real seam — each is a
  // distinct advisory form that must NOT leak a verdict token or a ₹-target.
  it("analyst-verb verdict + comma'd price target is scrubbed (no BUY/SELL token, no ₹ target leaks)", () => {
    for (const summary of [
      "Our analysts rate the stock a STRONG BUY, target price of ₹4,000 per share.",
      "We rate this a SELL; price target of ₹1200.",
      "The desk rates it a HOLD with a target of ₹950.",
    ]) {
      const blocks = convertFullReportToBlocks(
        base({ report: { score: 55, summary }, symbols: ["TCS"] })
      );
      const allText = JSON.stringify(blocks);
      assert.doesNotMatch(
        allText,
        /\b(?:STRONG[\s_-]?)?(?:BUY|SELL|HOLD)\b/,
        `verdict token leaked for: ${summary}`
      );
      assert.doesNotMatch(
        allText,
        /(?:price\s+target|target\s+price|target\s+of)\s*[₹$]/i,
        `price target leaked for: ${summary}`
      );
    }
  });

  // Negative guard — the scrubber must NOT over-scrub legitimate prose while
  // closing the gap. A company REVENUE target in crore and an ordinary
  // "exchange rate this year" clause are observational and must survive intact
  // through the same render seam.
  it("does NOT over-scrub revenue-in-crore targets or 'exchange rate this year' (no compliance over-reach)", () => {
    const blocks = convertFullReportToBlocks(
      base({
        report: {
          score: 60,
          summary:
            "Management guided to a revenue target of ₹4000 crore as the exchange rate this year held steady.",
        },
        symbols: ["TCS"],
      })
    );
    const allText = JSON.stringify(blocks);
    assert.match(allText, /revenue target of ₹4000 crore/i);
    assert.match(allText, /exchange rate this year held steady/i);
  });

  it("DCF section renders a card with a signed Upside; survives negative upside", () => {
    const blocks = convertFullReportToBlocks(
      base({
        report: {
          score: 40,
          sections: [
            {
              title: "DCF",
              type: "valuation",
              dcf: { intrinsicValue: 100, currentPrice: 150, upside: -33.33 },
            },
          ],
        },
        symbols: ["XYZ"],
      })
    );
    const card = blocks.find(
      (b) =>
        b.type === "card" &&
        (b as unknown as Record<string, unknown>).title === "DCF Valuation"
    ) as Record<string, unknown> | undefined;
    assert.ok(card, "DCF card present");
    const items = card!.items as Array<{ label: string; value: string }>;
    const upside = items.find((i) => i.label === "Upside");
    assert.ok(upside);
    assert.match(upside!.value, /-33\.3%/); // negative, no extra '+' sign
  });

  it("OVERSIZED keyMetrics array is capped at 8 in the scorecard 'Key metrics' section", () => {
    const keyMetrics = Array.from({ length: 50 }, (_, i) => ({
      label: `m${i}`,
      value: String(i),
    }));
    const blocks = convertFullReportToBlocks(
      base({ report: { score: 60, keyMetrics }, symbols: ["TCS"] })
    );
    const sc = blocks.find((b) => b.type === "scorecard") as
      | Record<string, unknown>
      | undefined;
    assert.ok(sc);
    const sections = sc!.sections as Array<{
      title: string;
      metrics: unknown[];
    }>;
    const km = sections.find((s) => s.title === "Key metrics");
    assert.ok(km, "Key metrics section present");
    assert.equal(km!.metrics.length, 8); // sliced to 8
  });

  it("technicals card omits the RSI row when rsi is null/absent", () => {
    const blocks = convertFullReportToBlocks(
      base({
        report: {
          score: 50,
          technicals: { trend: "up", support: 100, resistance: 200 },
        },
        symbols: ["TCS"],
      })
    );
    const card = blocks.find(
      (b) =>
        b.type === "card" &&
        (b as unknown as Record<string, unknown>).title === "Technical Overview"
    ) as Record<string, unknown> | undefined;
    assert.ok(card);
    const items = card!.items as Array<{ label: string }>;
    assert.equal(
      items.some((i) => i.label.startsWith("RSI")),
      false
    );
  });
});

describe("MONEY-620 dataSourceProviders — mapping / dedupe / unknowns", () => {
  it("empty tool list → []", () => {
    assert.deepEqual(dataSourceProviders([]), []);
  });

  it("maps known tools to providers and DEDUPES by provider label", () => {
    const out = dataSourceProviders([
      "get_income_statement",
      "get_balance_sheet", // both → Tickertape / Screener.in (deduped to 1)
      "get_stock_price", // → Yahoo Finance
      "get_stock_news", // → Google News
    ]);
    const labels = out.map((p) => p.label);
    assert.equal(
      labels.filter((l) => l === "Tickertape / Screener.in").length,
      1,
      "screener provider deduped"
    );
    assert.ok(labels.includes("Yahoo Finance"));
    assert.ok(labels.includes("Google News"));
    // every mapped provider carries a url
    for (const p of out) assert.match(String(p.url), /^https?:\/\//);
  });

  it("unknown / compute-only tool names map to NO provider (dropped)", () => {
    const out = dataSourceProviders([
      "compute_correlation",
      "totally_unknown_tool",
    ]);
    assert.deepEqual(out, []);
  });

  it("preserves first-seen order of distinct providers", () => {
    const out = dataSourceProviders(["get_stock_news", "get_balance_sheet"]);
    assert.equal(out[0].label, "Google News");
    assert.equal(out[1].label, "Tickertape / Screener.in");
  });
});
