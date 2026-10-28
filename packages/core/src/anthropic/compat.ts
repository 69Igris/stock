/**
 * Claude → Gemini-compat adapter — MONEY-506 (BAD-1, Claude-live slice).
 *
 * The research synthesis path calls models through the OLD-SDK compat
 * shape (`model.generateContent(prompt)` → `{ response }` with
 * `candidates[0].content.parts[0].text`, plus `.text`/`.text()` helpers —
 * see `gemini/client.ts`). This adapter makes a Claude call satisfy that
 * exact contract, so `generateWithTimeout()` and every downstream text
 * extractor work unchanged.
 *
 * Resilience: the adapter takes a LAZY Gemini fallback. If the Claude call
 * throws (4xx/5xx/network), it logs once and delegates the same prompt to
 * the fallback — the user gets a Gemini answer instead of an error. The
 * fallback is a thunk so no Gemini client is constructed unless needed.
 */

import type { GeminiGenerativeModel } from "../gemini/client";
import { geminiLogger as logger } from "@usemoney/logger";
import {
  claudeGenerate,
  claudeStreamText,
  CLAUDE_SONNET_ID,
  type ClaudeGenerateResult,
} from "./client";

/**
 * Pure mapper: Claude result → the compat `{ response }` shape the
 * synthesis pipeline reads. Exported for unit tests.
 */
export function toGeminiCompatResult(r: ClaudeGenerateResult): {
  response: {
    candidates: Array<{
      content: { parts: Array<{ text: string }>; role: string };
      finishReason: string;
    }>;
    text: string;
    usageMetadata: {
      promptTokenCount: number;
      candidatesTokenCount: number;
      totalTokenCount: number;
    };
  };
} {
  const finishReason = r.stopReason === "max_tokens" ? "MAX_TOKENS" : "STOP";
  return {
    response: {
      candidates: [
        {
          content: { parts: [{ text: r.text }], role: "model" },
          finishReason,
        },
      ],
      text: r.text,
      usageMetadata: {
        promptTokenCount: r.usage.inputTokens,
        candidatesTokenCount: r.usage.outputTokens,
        totalTokenCount: r.usage.inputTokens + r.usage.outputTokens,
      },
    },
  };
}

/** Extract a plain prompt string from the compat call's argument union. */
export function promptFromCompatRequest(promptOrReq: unknown): string {
  if (typeof promptOrReq === "string") return promptOrReq;
  // OLD-SDK request object: { contents: [{ role, parts: [{ text }] }] }
  if (promptOrReq && typeof promptOrReq === "object") {
    const contents = (promptOrReq as { contents?: unknown }).contents;
    if (Array.isArray(contents)) {
      return contents
        .flatMap((c) =>
          Array.isArray((c as { parts?: unknown[] }).parts)
            ? ((c as { parts: Array<{ text?: string }> }).parts ?? [])
            : [],
        )
        .map((p) => p.text ?? "")
        .join("\n");
    }
  }
  return String(promptOrReq ?? "");
}

export interface ClaudeCompatOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Lazy Gemini fallback — invoked ONLY when the Claude call throws.
   * Lazy so tests / kill-switch paths never construct a Gemini client.
   */
  fallback?: () => GeminiGenerativeModel;
}

/**
 * A `GeminiGenerativeModel`-shaped handle whose generateContent runs on
 * Claude Sonnet (with Gemini fallback). Streaming is intentionally not
 * implemented in the slice — the synthesis path is non-streaming; the
 * full router (BAD-1b / MONEY-626) owns streaming + tool-use.
 */
export function getClaudeCompatModel(
  opts: ClaudeCompatOptions = {},
): GeminiGenerativeModel {
  const adapter = {
    async generateContent(promptOrReq: unknown) {
      const prompt = promptFromCompatRequest(promptOrReq);
      try {
        const result = await claudeGenerate({
          model: opts.model ?? CLAUDE_SONNET_ID,
          prompt,
          temperature: opts.temperature,
          maxOutputTokens: opts.maxOutputTokens,
        });
        return toGeminiCompatResult(result);
      } catch (error) {
        if (!opts.fallback) throw error;
        logger.warn(
          {
            model: opts.model ?? CLAUDE_SONNET_ID,
            error: error instanceof Error ? error.message : "unknown",
          },
          "Claude slice failed — falling back to Gemini for this call",
        );
        return opts.fallback().generateContent(prompt);
      }
    },
    // Real token streaming (MONEY-626): map Claude text deltas onto the
    // Gemini stream-chunk shape `generateContentStreamText` reads
    // (`chunk.candidates[0].content.parts[].text`). If Claude fails BEFORE
    // the first token and a fallback exists, delegate the whole stream to
    // Gemini; a mid-stream failure propagates (the chat route handles it).
    async generateContentStream(promptOrReq: unknown) {
      const prompt = promptFromCompatRequest(promptOrReq);
      const model = opts.model ?? CLAUDE_SONNET_ID;
      const fallback = opts.fallback;

      let resolveFinal!: (r: unknown) => void;
      const response = new Promise<unknown>((res) => {
        resolveFinal = res;
      });

      async function* stream() {
        let yielded = false;
        let acc = "";
        try {
          for await (const text of claudeStreamText({
            model,
            prompt,
            temperature: opts.temperature,
            maxOutputTokens: opts.maxOutputTokens,
          })) {
            if (!text) continue;
            yielded = true;
            acc += text;
            yield {
              candidates: [
                {
                  content: { parts: [{ text }], role: "model" },
                  finishReason: "STOP",
                },
              ],
            };
          }
          resolveFinal(
            toGeminiCompatResult({
              text: acc,
              model,
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0 },
            }),
          );
        } catch (error) {
          if (!yielded && fallback) {
            logger.warn(
              {
                model,
                error: error instanceof Error ? error.message : "unknown",
              },
              "Claude stream failed pre-token — falling back to Gemini",
            );
            const gem = await fallback().generateContentStream(prompt);
            for await (const chunk of gem.stream) yield chunk;
            resolveFinal(await gem.response);
            return;
          }
          // Mid-stream failure (or no fallback): settle `response` so a
          // listener never hangs, then surface the error to the consumer.
          resolveFinal(
            toGeminiCompatResult({
              text: acc,
              model,
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0 },
            }),
          );
          throw error;
        }
      }

      return { stream: stream(), response };
    },
  };
  return adapter as unknown as GeminiGenerativeModel;
}
