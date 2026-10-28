/**
 * MONEY-1060 (fix 10) — Gemini search-grounded scalar quote.
 *
 * Covers `packages/research/src/data-sources/search-quote.ts`: the FINAL
 * resilience tier for fetch_stock_price. Tests import the REAL exported
 * `fetchSearchGroundedQuote` / `parseSearchQuoteResponse` /
 * `buildSearchQuotePrompt` and inject a fake generation call (`fetchImpl`) —
 * no LLM, no network:
 *
 *   - accept: strict JSON (plain or fenced) with a finite positive price;
 *   - VALIDATION GATE: price rejected when non-finite/≤0 or outside
 *     [0.5×, 2×] of the provided lastKnownClose (hallucination guard;
 *     boundary values accepted);
 *   - swallow-and-null on ANY error (observable via onError) + hard timeout;
 *   - env gate: without a fetchImpl and without Gemini env config the tier
 *     short-circuits to null instead of throwing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchSearchGroundedQuote,
  parseSearchQuoteResponse,
  buildSearchQuotePrompt,
  SEARCH_QUOTE_MODEL,
} from "../src/data-sources/search-quote";

const GOOD_JSON =
  '{"price": 4012.5, "marketCap": 1450000000000, "asOf": "2026-07-06"}';

describe("parseSearchQuoteResponse — strict-JSON gate", () => {
  it("accepts plain strict JSON", () => {
    const q = parseSearchQuoteResponse(GOOD_JSON);
    assert.deepEqual(q, {
      price: 4012.5,
      marketCap: 1_450_000_000_000,
      asOf: "2026-07-06",
      source: "search",
    });
  });

  it("accepts fenced JSON and JSON embedded in prose", () => {
    const fenced = parseSearchQuoteResponse("```json\n" + GOOD_JSON + "\n```");
    assert.equal(fenced?.price, 4012.5);
    const prose = parseSearchQuoteResponse(
      `The latest price data: ${GOOD_JSON} as reported.`,
    );
    assert.equal(prose?.price, 4012.5);
  });

  it("rejects a missing / non-numeric / non-finite / non-positive price", () => {
    assert.equal(parseSearchQuoteResponse('{"marketCap": 100}'), null);
    assert.equal(parseSearchQuoteResponse('{"price": "N/A"}'), null);
    assert.equal(parseSearchQuoteResponse('{"price": 0}'), null);
    assert.equal(parseSearchQuoteResponse('{"price": -5}'), null);
    // 1e999 parses to Infinity — must fail the finiteness gate.
    assert.equal(parseSearchQuoteResponse('{"price": 1e999}'), null);
  });

  it("rejects garbage / empty / non-JSON output", () => {
    assert.equal(parseSearchQuoteResponse(""), null);
    assert.equal(parseSearchQuoteResponse("I could not find the price."), null);
    assert.equal(parseSearchQuoteResponse("{broken json"), null);
  });

  it("hallucination guard: rejects outside [0.5×, 2×] of lastKnownClose; boundaries accepted", () => {
    // Out of bounds — wrong ticker / hallucinated figure.
    assert.equal(parseSearchQuoteResponse('{"price": 500}', 100), null);
    assert.equal(parseSearchQuoteResponse('{"price": 30}', 100), null);
    // Boundaries are inside the closed interval.
    assert.equal(parseSearchQuoteResponse('{"price": 200}', 100)?.price, 200);
    assert.equal(parseSearchQuoteResponse('{"price": 50}', 100)?.price, 50);
    // In-bounds passes.
    assert.equal(parseSearchQuoteResponse('{"price": 104}', 100)?.price, 104);
  });

  it("drops an invalid marketCap / blank asOf but keeps the valid price", () => {
    const q = parseSearchQuoteResponse(
      '{"price": 104, "marketCap": "12Cr", "asOf": "  "}',
    );
    assert.deepEqual(q, { price: 104, source: "search" });
    const neg = parseSearchQuoteResponse('{"price": 104, "marketCap": -1}');
    assert.equal(neg?.marketCap, undefined);
    const nullCap = parseSearchQuoteResponse(
      '{"price": 104, "marketCap": null, "asOf": "2026-07-06"}',
    );
    assert.deepEqual(nullCap, {
      price: 104,
      asOf: "2026-07-06",
      source: "search",
    });
  });
});

describe("buildSearchQuotePrompt — strict-JSON search prompt", () => {
  it("names the clean ticker, the exchange, INR, and demands JSON-only", () => {
    const p = buildSearchQuotePrompt("TCS.NS");
    assert.match(p, /"TCS"/);
    assert.match(p, /NSE-listed/);
    assert.match(p, /INR/);
    assert.match(p, /ONLY minified JSON/);
    assert.match(p, /"price":/);
  });

  it("maps a .BO suffix to BSE", () => {
    assert.match(buildSearchQuotePrompt("BIHSPONG.BO"), /BSE-listed/);
  });

  it("pins the cheap grounding-capable flash id", () => {
    assert.equal(SEARCH_QUOTE_MODEL, "gemini-2.5-flash");
  });
});

describe("fetchSearchGroundedQuote — injected generation (no LLM)", () => {
  it("accept: valid JSON from the injected fetchImpl → quote with source:'search'", async () => {
    const prompts: string[] = [];
    const q = await fetchSearchGroundedQuote("TCS.NS", {
      fetchImpl: async (prompt) => {
        prompts.push(prompt);
        return GOOD_JSON;
      },
    });
    assert.ok(q);
    assert.equal(q!.price, 4012.5);
    assert.equal(q!.source, "search");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /"TCS"/);
  });

  it("reject-out-of-bounds: lastKnownClose gates the result to null", async () => {
    const q = await fetchSearchGroundedQuote("TCS.NS", {
      lastKnownClose: 100,
      fetchImpl: async () => '{"price": 4012.5}',
    });
    assert.equal(q, null);
  });

  it("error → null, with the error observable via onError", async () => {
    const seen: Array<{ error: unknown; context?: string }> = [];
    const q = await fetchSearchGroundedQuote("TCS.NS", {
      fetchImpl: async () => {
        throw new Error("Gemini 500");
      },
      onError: (error, context) => seen.push({ error, context }),
    });
    assert.equal(q, null);
    assert.equal(seen.length, 1);
    assert.match(String((seen[0]!.error as Error).message), /Gemini 500/);
    assert.match(seen[0]!.context ?? "", /search-quote:TCS\.NS/);
  });

  it("hard timeout: a hung generation resolves to null (timer cleaned up)", async () => {
    let hangTimer: ReturnType<typeof setTimeout> | undefined;
    const seen: unknown[] = [];
    const q = await fetchSearchGroundedQuote("TCS.NS", {
      timeoutMs: 10,
      fetchImpl: () =>
        new Promise<string>((resolve) => {
          hangTimer = setTimeout(() => resolve(GOOD_JSON), 5_000);
        }),
      onError: (error) => seen.push(error),
    });
    if (hangTimer) clearTimeout(hangTimer); // don't orphan the runner
    assert.equal(q, null);
    assert.equal(seen.length, 1);
    assert.match(String((seen[0] as Error).message), /timed out after 10ms/);
  });

  it("garbage model output → null (no throw)", async () => {
    const q = await fetchSearchGroundedQuote("TCS.NS", {
      fetchImpl: async () => "no idea, markets are closed",
    });
    assert.equal(q, null);
  });

  it("env gate: no fetchImpl + no Gemini env config → null without throwing", async () => {
    const savedKey = process.env.GOOGLE_GENAI_API_KEY;
    const savedProject = process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.GCP_PROJECT_ID;
    try {
      const q = await fetchSearchGroundedQuote("TCS.NS");
      assert.equal(q, null);
    } finally {
      if (savedKey !== undefined) process.env.GOOGLE_GENAI_API_KEY = savedKey;
      if (savedProject !== undefined) process.env.GCP_PROJECT_ID = savedProject;
    }
  });

  it("blank symbol → null (defensive)", async () => {
    const q = await fetchSearchGroundedQuote("", {
      fetchImpl: async () => GOOD_JSON,
    });
    assert.equal(q, null);
  });
});
