/**
 * Ask FIRE — Gemini adapter for the mobile API (MONEY-1079).
 *
 * The `generate` implementation injected into `runFireChatTurn` (the shared
 * engine in @usemoney/fire). Identical model config to the web adapter
 * (FREE-tier flash, temp 0.2, native function-calling with FIRE_TOOLS), but
 * built on @usemoney/core's Gemini client rather than the web-local one, so the
 * two apps stay independent while reusing the exact same engine + tool schema.
 * Rebuilds the system instruction from the FRESH snapshot each hop so the model
 * sees the effect of its prior tool calls (server-side goal-seeking).
 */

import { DEFAULT_MODEL_FOR_PLAN } from "@usemoney/core";
import { getVertexAIClient } from "@usemoney/core/gemini";
import {
  FIRE_TOOLS,
  buildFireSystemPrompt,
  type FireTurnGenerate,
} from "@usemoney/fire";

const MODEL = DEFAULT_MODEL_FOR_PLAN.FREE;

export function makeApiFireGenerate(): FireTurnGenerate {
  return async (contents, snapshot) => {
    const model = getVertexAIClient().getGenerativeModel({
      model: MODEL,
      systemInstruction: buildFireSystemPrompt(snapshot),
      tools: [{ functionDeclarations: FIRE_TOOLS }],
      // 2.5-flash reasons before answering; 2048 leaves room for the thinking
      // phase + the tool calls (a tight cap can return an empty response).
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    });

    const { response } = await model.generateContent({ contents });
    const parts = response.candidates?.[0]?.content?.parts ?? [];

    const text =
      parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim() || null;

    const functionCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: p.functionCall?.id,
        name: p.functionCall?.name ?? "",
        args: (p.functionCall?.args ?? {}) as Record<string, unknown>,
      }))
      .filter((c) => c.name);

    return { text, functionCalls };
  };
}
