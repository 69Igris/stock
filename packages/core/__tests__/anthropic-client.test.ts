/**
 * MONEY-506 (BAD-1) — Claude-live slice: client + compat adapter tests.
 *
 * No network: the slice's only call (messages.create) is overridden via the
 * `__setClaudeCreateForTests` seam, so we assert the request body shape +
 * sanitized error mapping with neither the SDK's transport nor a live key.
 * Covers
 *   - claudeGenerate: request shape (model/system/max_tokens/messages),
 *     text-block extraction, sanitized errors (status + type, never the key)
 *   - toGeminiCompatResult: exact OLD-SDK compat shape the synthesis
 *     pipeline reads (candidates[0].content.parts[0].text, text, usage)
 *   - promptFromCompatRequest: string + contents-union extraction
 *   - getClaudeCompatModel: Claude success path + LAZY Gemini fallback on
 *     failure (fallback not constructed unless Claude throws)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  claudeGenerate,
  claudeStreamText,
  CLAUDE_SONNET_ID,
  isClaudeConfigured,
  __setClaudeCreateForTests,
  __setClaudeStreamForTests,
  resetAnthropicClient,
} from "../src/anthropic/client";
import {
  toGeminiCompatResult,
  promptFromCompatRequest,
  getClaudeCompatModel,
} from "../src/anthropic/compat";

const realKey = process.env.ANTHROPIC_API_KEY;
const realFlag = process.env.CLAUDE_PORTFOLIO_AGENT;

/** A minimal Anthropic.Message-shaped success body (cast at the boundary). */
function okMessage(overrides: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "grounded answer", citations: null }],
    model: CLAUDE_SONNET_ID,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 25 },
    ...overrides,
  } as unknown as Anthropic.Message;
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  delete process.env.CLAUDE_PORTFOLIO_AGENT;
  resetAnthropicClient();
});

afterEach(() => {
  __setClaudeCreateForTests(null);
  __setClaudeStreamForTests(null);
  resetAnthropicClient();
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
  if (realFlag === undefined) delete process.env.CLAUDE_PORTFOLIO_AGENT;
  else process.env.CLAUDE_PORTFOLIO_AGENT = realFlag;
});

describe("isClaudeConfigured", () => {
  it("true with key, false without, false when killed", () => {
    assert.equal(isClaudeConfigured(), true);
    process.env.CLAUDE_PORTFOLIO_AGENT = "off";
    assert.equal(isClaudeConfigured(), false);
    delete process.env.CLAUDE_PORTFOLIO_AGENT;
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isClaudeConfigured(), false);
  });
});

describe("claudeGenerate", () => {
  it("sends Messages API shape and extracts text blocks", async () => {
    let captured: Anthropic.MessageCreateParamsNonStreaming | undefined;
    __setClaudeCreateForTests(async (body) => {
      captured = body;
      return okMessage();
    });

    const r = await claudeGenerate({
      system: "you are grounded",
      prompt: "what is my P&L?",
      temperature: 0.2,
    });

    assert.equal(captured?.model, CLAUDE_SONNET_ID);
    assert.equal(captured?.system, "you are grounded");
    assert.equal(captured?.max_tokens, 8192);
    assert.equal(captured?.temperature, 0.2);
    assert.deepEqual(captured?.messages, [
      { role: "user", content: "what is my P&L?" },
    ]);
    assert.equal(r.text, "grounded answer");
    assert.equal(r.usage.inputTokens, 100);
    assert.equal(r.usage.outputTokens, 25);
    assert.equal(r.stopReason, "end_turn");
  });

  it("joins multiple text blocks and ignores non-text blocks", async () => {
    __setClaudeCreateForTests(async () =>
      okMessage({
        content: [
          { type: "text", text: "part1 ", citations: null },
          { type: "tool_use", id: "x", name: "t", input: {} },
          { type: "text", text: "part2", citations: null },
        ],
      }),
    );
    const r = await claudeGenerate({ prompt: "p" });
    assert.equal(r.text, "part1 part2");
  });

  it("omits temperature/system when not provided", async () => {
    let captured: Anthropic.MessageCreateParamsNonStreaming | undefined;
    __setClaudeCreateForTests(async (body) => {
      captured = body;
      return okMessage();
    });
    await claudeGenerate({ prompt: "p" });
    assert.equal("temperature" in (captured ?? {}), false);
    assert.equal("system" in (captured ?? {}), false);
  });

  it("omits temperature on Opus 4.6+ even when provided (API deprecates it)", async () => {
    let captured: Anthropic.MessageCreateParamsNonStreaming | undefined;
    __setClaudeCreateForTests(async (body) => {
      captured = body;
      return okMessage({ model: "claude-opus-4-8" });
    });
    // Sonnet keeps temperature (covered above); Opus 4.6/4.7/4.8 must NOT send
    // it or the Messages API 400s ("temperature is deprecated for this model").
    for (const model of [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
    ]) {
      await claudeGenerate({ prompt: "p", temperature: 0.2, model });
      assert.equal(
        "temperature" in (captured ?? {}),
        false,
        `${model} must omit temperature`,
      );
    }
  });

  it("throws sanitized error (status + type, no key, no body)", async () => {
    __setClaudeCreateForTests(async () => {
      // Shape of an Anthropic.APIError: status + parsed body.
      throw {
        status: 529,
        error: {
          type: "error",
          error: { type: "overloaded_error", message: "secret-ish details" },
        },
      };
    });
    await assert.rejects(
      () => claudeGenerate({ prompt: "p" }),
      (e: Error) => {
        assert.match(e.message, /Anthropic API 529 \(overloaded_error\)/);
        assert.doesNotMatch(e.message, /secret/);
        assert.doesNotMatch(e.message, /test-key/);
        return true;
      },
    );
  });

  it("throws when key missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    __setClaudeCreateForTests(null); // force the real key pre-check path
    await assert.rejects(
      () => claudeGenerate({ prompt: "p" }),
      /ANTHROPIC_API_KEY/,
    );
  });
});

describe("toGeminiCompatResult", () => {
  it("produces the OLD-SDK compat shape the synthesis extractors read", () => {
    const out = toGeminiCompatResult({
      text: "report json",
      model: CLAUDE_SONNET_ID,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    assert.equal(
      out.response.candidates[0].content.parts[0].text,
      "report json",
    );
    assert.equal(out.response.candidates[0].content.role, "model");
    assert.equal(out.response.candidates[0].finishReason, "STOP");
    assert.equal(out.response.text, "report json");
    assert.equal(out.response.usageMetadata.totalTokenCount, 15);
  });

  it("maps max_tokens stop to MAX_TOKENS finishReason", () => {
    const out = toGeminiCompatResult({
      text: "truncated",
      model: CLAUDE_SONNET_ID,
      stopReason: "max_tokens",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    assert.equal(out.response.candidates[0].finishReason, "MAX_TOKENS");
  });
});

describe("promptFromCompatRequest", () => {
  it("passes strings through", () => {
    assert.equal(promptFromCompatRequest("plain"), "plain");
  });
  it("extracts text from OLD-SDK contents union", () => {
    assert.equal(
      promptFromCompatRequest({
        contents: [
          { role: "user", parts: [{ text: "a" }, { text: "b" }] },
          { role: "user", parts: [{ text: "c" }] },
        ],
      }),
      "a\nb\nc",
    );
  });
});

describe("claudeStreamText (streaming)", () => {
  it("yields text deltas from the stream", async () => {
    __setClaudeStreamForTests(async function* () {
      yield "Hel";
      yield "lo";
    });
    const out: string[] = [];
    for await (const t of claudeStreamText({ prompt: "hi" })) out.push(t);
    assert.deepEqual(out, ["Hel", "lo"]);
  });
});

describe("getClaudeCompatModel.generateContentStream", () => {
  it("maps Claude deltas onto the Gemini stream-chunk shape", async () => {
    __setClaudeStreamForTests(async function* () {
      yield "A";
      yield "B";
    });
    const model = getClaudeCompatModel({});
    const res = await model.generateContentStream("q");
    const chunks: (string | undefined)[] = [];
    for await (const c of res.stream) {
      chunks.push(c.candidates?.[0]?.content?.parts?.[0]?.text);
    }
    assert.deepEqual(chunks, ["A", "B"]);
  });

  it("falls back to the Gemini stream on a pre-token Claude failure", async () => {
    __setClaudeStreamForTests(
      // eslint-disable-next-line require-yield
      async function* () {
        throw { status: 500, error: { error: { type: "api_error" } } };
      },
    );
    const model = getClaudeCompatModel({
      fallback: () =>
        ({
          async generateContentStream(prompt: unknown) {
            return {
              stream: (async function* () {
                yield {
                  candidates: [
                    { content: { parts: [{ text: `gem:${String(prompt)}` }] } },
                  ],
                };
              })(),
              response: Promise.resolve({}),
            };
          },
        }) as unknown as ReturnType<typeof getClaudeCompatModel>,
    });
    const res = await model.generateContentStream("Q");
    const chunks: (string | undefined)[] = [];
    for await (const c of res.stream) {
      chunks.push(c.candidates?.[0]?.content?.parts?.[0]?.text);
    }
    assert.deepEqual(chunks, ["gem:Q"]);
  });
});

describe("getClaudeCompatModel", () => {
  it("returns Claude text through the compat shape on success", async () => {
    __setClaudeCreateForTests(async () => okMessage());
    let fallbackBuilt = false;
    const model = getClaudeCompatModel({
      fallback: () => {
        fallbackBuilt = true;
        throw new Error("must stay lazy");
      },
    });
    const result = await model.generateContent("q");
    assert.equal(
      result.response.candidates?.[0]?.content?.parts?.[0]?.text,
      "grounded answer",
    );
    assert.equal(fallbackBuilt, false); // lazy: never constructed on success
  });

  it("falls back to Gemini-shaped model when Claude fails", async () => {
    __setClaudeCreateForTests(async () => {
      throw {
        status: 500,
        error: { type: "error", error: { type: "api_error" } },
      };
    });
    const calls: string[] = [];
    const model = getClaudeCompatModel({
      fallback: () =>
        ({
          async generateContent(prompt: unknown) {
            calls.push(String(prompt));
            return {
              response: {
                candidates: [
                  {
                    content: {
                      parts: [{ text: "gemini says hi" }],
                      role: "model",
                    },
                  },
                ],
              },
            };
          },
        }) as unknown as ReturnType<typeof getClaudeCompatModel>,
    });
    const result = await model.generateContent("original prompt");
    assert.deepEqual(calls, ["original prompt"]);
    assert.equal(
      result.response.candidates?.[0]?.content?.parts?.[0]?.text,
      "gemini says hi",
    );
  });

  it("rethrows when no fallback is provided", async () => {
    __setClaudeCreateForTests(async () => {
      throw {
        status: 401,
        error: { type: "error", error: { type: "authentication_error" } },
      };
    });
    const model = getClaudeCompatModel();
    await assert.rejects(() => model.generateContent("q"), /Anthropic API 401/);
  });
});
