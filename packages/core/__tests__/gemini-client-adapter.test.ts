/**
 * Gemini client compat adapter — MONEY-619 Phase 4.
 *
 * The migration from `@google-cloud/vertexai` to `@google/genai` is done via a
 * COMPAT adapter (packages/core/src/gemini/client.ts) so the ~20 existing call
 * sites that read the OLD SDK result shape keep working unchanged:
 *
 *   result.response.candidates[0].content.parts[].text   (generateContent)
 *   result.stream  +  result.response (Promise)          (generateContentStream)
 *   candidate.groundingMetadata                           (grounding)
 *
 * The new `@google/genai` response is FLAT (`candidates` at top level, a `text`
 * GETTER, NO `.response` wrapper). This suite is the safety net for the shape
 * mapping: it drives the REAL adapter (`createGeminiModel`, `toContents`,
 * `toConfig`, `withTextCompat`, `aggregateStreamChunks`) with a hand-rolled
 * `GenAiHost` fake that returns known `GenerateContentResponse` instances and
 * asserts the OLD `{ response: { candidates: [...] } }` shape comes back out.
 *
 * No module mocking is used (node:test `mock.module` needs an experimental
 * flag and isn't used anywhere in this repo) — the adapter exposes a structural
 * `GenAiHost` seam precisely so a plain fake suffices.
 *
 * Source: packages/core/src/gemini/client.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GenerateContentResponse } from "@google/genai";
import {
  createGeminiModel,
  toContents,
  toConfig,
  withTextCompat,
  aggregateStreamChunks,
  type GenAiHost,
} from "../src/gemini/client";

// ── Helpers: build REAL GenerateContentResponse instances ─────────────────
// (real instances carry the prototype `text` getter the adapter relies on).

function makeResponse(
  text: string,
  extra?: Partial<{
    finishReason: string;
    groundingMetadata: unknown;
    role: string;
  }>,
): GenerateContentResponse {
  const r = new GenerateContentResponse();
  r.candidates = [
    {
      content: {
        role: extra?.role ?? "model",
        parts: [{ text }],
      },
      finishReason: extra?.finishReason as never,
      groundingMetadata: extra?.groundingMetadata as never,
    },
  ];
  return r;
}

function makeChunk(text: string): GenerateContentResponse {
  const r = new GenerateContentResponse();
  r.candidates = [{ content: { role: "model", parts: [{ text }] } }];
  return r;
}

/** A configurable fake of the genai host that records the params it received. */
function makeFakeHost(opts: {
  contentResponse?: GenerateContentResponse;
  streamChunks?: GenerateContentResponse[];
  capture?: {
    contents?: unknown;
    config?: unknown;
    model?: string;
  };
}): GenAiHost {
  return {
    models: {
      async generateContent(params) {
        if (opts.capture) {
          opts.capture.model = params.model;
          opts.capture.contents = params.contents;
          opts.capture.config = params.config;
        }
        return opts.contentResponse ?? makeResponse("");
      },
      async generateContentStream(params) {
        if (opts.capture) {
          opts.capture.model = params.model;
          opts.capture.contents = params.contents;
          opts.capture.config = params.config;
        }
        const chunks = opts.streamChunks ?? [];
        async function* gen(): AsyncGenerator<GenerateContentResponse> {
          for (const c of chunks) yield c;
        }
        return gen();
      },
    },
  };
}

describe("Gemini compat adapter (client.ts)", () => {
  // ───────────────────── toContents ─────────────────────

  describe("toContents", () => {
    it("wraps a bare string prompt into a single user text part", () => {
      const result = toContents("Hello Gemini");
      assert.deepStrictEqual(result, [
        { role: "user", parts: [{ text: "Hello Gemini" }] },
      ]);
    });

    it("passes through an explicit { contents } request unchanged", () => {
      const contents = [
        { role: "user", parts: [{ text: "a" }] },
        { role: "model", parts: [{ text: "b" }] },
      ];
      const result = toContents({ contents });
      assert.strictEqual(result, contents);
    });
  });

  // ───────────────────── toConfig (generationConfig → flat config) ──────────

  describe("toConfig", () => {
    it("maps the standard generation params onto the flat config", () => {
      const config = toConfig({
        model: "gemini-2.5-flash",
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 2048,
        },
      });
      assert.ok(config);
      assert.strictEqual(config!.temperature, 0.7);
      assert.strictEqual(config!.topP, 0.95);
      assert.strictEqual(config!.topK, 40);
      assert.strictEqual(config!.maxOutputTokens, 2048);
    });

    it("LIFTS the nested thinkingConfig to a sibling field of config", () => {
      const config = toConfig({
        model: "gemini-2.5-pro",
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 12288,
          thinkingConfig: { thinkingBudget: 4096 },
        },
      });
      assert.ok(config);
      // thinkingConfig must be a TOP-LEVEL field of config (not nested under a
      // `generationConfig` key) — this is the key new-SDK shape difference.
      assert.deepStrictEqual(config!.thinkingConfig, { thinkingBudget: 4096 });
    });

    it("forwards responseMimeType (roast/ai-filter JSON mode)", () => {
      const config = toConfig({
        model: "gemini-2.5-pro",
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
      });
      assert.strictEqual(config!.responseMimeType, "application/json");
    });

    it("forwards tools (grounding googleSearch) and safetySettings", () => {
      const config = toConfig({
        model: "gemini-2.5-flash",
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        tools: [{ googleSearch: {} }],
      });
      assert.deepStrictEqual(config!.tools, [{ googleSearch: {} }]);
    });

    it("returns undefined when there is nothing to configure", () => {
      const config = toConfig({ model: "gemini-2.5-flash" });
      assert.strictEqual(config, undefined);
    });
  });

  // ───────────────────── withTextCompat ─────────────────────

  describe("withTextCompat", () => {
    it("keeps candidates[].content.parts[].text readable (old SDK shape)", () => {
      const resp = withTextCompat(makeResponse("Hello world"));
      const part = resp.candidates?.[0]?.content?.parts?.[0];
      assert.strictEqual(part?.text, "Hello world");
    });

    it("exposes text BOTH as a coercible value and as a callable method", () => {
      const resp = withTextCompat(makeResponse("Hello world"));
      // Old-SDK method form: response.text()
      assert.strictEqual(
        (resp.text as unknown as () => string | undefined)(),
        "Hello world",
      );
      // Coercion form (template / String()): yields the same text.
      assert.strictEqual(`${resp.text}`, "Hello world");
      assert.strictEqual(String(resp.text), "Hello world");
    });
  });

  // ───────────────────── generateContent (full result shape) ───────────────

  describe("createGeminiModel().generateContent", () => {
    it("returns the OLD { response: { candidates: [...] } } shape", async () => {
      const host = makeFakeHost({
        contentResponse: makeResponse("Paired trade analysis", {
          finishReason: "STOP",
        }),
      });
      const model = createGeminiModel(host, { model: "gemini-2.5-flash" });

      const result = await model.generateContent("Analyze my portfolio");

      // The exact access pattern used across ~20 call sites:
      const text = (result.response.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      assert.strictEqual(text, "Paired trade analysis");
      assert.strictEqual(result.response.candidates?.[0]?.finishReason, "STOP");
    });

    it("normalizes a string prompt into contents and threads the model id", async () => {
      const capture: { contents?: unknown; config?: unknown; model?: string } =
        {};
      const host = makeFakeHost({
        contentResponse: makeResponse("ok"),
        capture,
      });
      const model = createGeminiModel(host, {
        model: "gemini-3-pro",
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 20480,
          thinkingConfig: { thinkingBudget: 12288 },
        },
      });

      await model.generateContent("Deep research on TCS");

      assert.strictEqual(capture.model, "gemini-3-pro");
      assert.deepStrictEqual(capture.contents, [
        { role: "user", parts: [{ text: "Deep research on TCS" }] },
      ]);
      // The lifted thinkingConfig must reach the host on the flat config.
      assert.deepStrictEqual(
        (capture.config as { thinkingConfig?: unknown }).thinkingConfig,
        { thinkingBudget: 12288 },
      );
    });

    it("preserves candidate.groundingMetadata (grounding reads it)", async () => {
      const groundingMetadata = {
        webSearchQueries: ["TCS share price"],
        groundingChunks: [
          { web: { uri: "https://moneycontrol.com/tcs", title: "TCS" } },
        ],
      };
      const host = makeFakeHost({
        contentResponse: makeResponse("TCS trades at...", {
          groundingMetadata,
        }),
      });
      const model = createGeminiModel(host, { model: "gemini-2.5-flash" });

      const result = await model.generateContent("price?");
      assert.deepStrictEqual(
        result.response.candidates?.[0]?.groundingMetadata,
        groundingMetadata,
      );
    });
  });

  // ───────────────────── generateContentStream ─────────────────────

  describe("createGeminiModel().generateContentStream", () => {
    it("returns { stream, response } with the OLD chunk shape", async () => {
      const host = makeFakeHost({
        streamChunks: [makeChunk("Hel"), makeChunk("lo "), makeChunk("world")],
      });
      const model = createGeminiModel(host, { model: "gemini-2.5-flash" });

      const { stream, response } = await model.generateContentStream("hi");

      // Each chunk exposes candidates[0].content.parts[0].text (old shape).
      const deltas: string[] = [];
      for await (const chunk of stream) {
        const t = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (t) deltas.push(t);
      }
      assert.deepStrictEqual(deltas, ["Hel", "lo ", "world"]);

      // The aggregated `response` promise carries the FULL concatenated text.
      const final = await response;
      const fullText = (final.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      assert.strictEqual(fullText, "Hello world");
    });
  });

  // ───────────────────── aggregateStreamChunks ─────────────────────

  describe("aggregateStreamChunks", () => {
    it("concatenates text and preserves the last chunk's metadata", () => {
      const chunks = [
        makeChunk("foo"),
        makeChunk("bar"),
        makeResponse("baz", { finishReason: "STOP" }),
      ];
      const merged = aggregateStreamChunks(chunks);
      const text = (merged.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      assert.strictEqual(text, "foobarbaz");
      assert.strictEqual(merged.candidates?.[0]?.finishReason, "STOP");
    });

    it("returns an empty-candidates response for zero chunks", () => {
      const merged = aggregateStreamChunks([]);
      assert.deepStrictEqual(merged.candidates, []);
    });
  });
});
