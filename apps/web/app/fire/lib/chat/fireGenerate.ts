import { getVertexAIClient } from "@/lib/gemini/client";
import { DEFAULT_MODEL_FOR_PLAN } from "@usemoney/core";
import { FIRE_TOOLS } from "./tools";
import { buildFireSystemPrompt } from "./systemPrompt";
import type { FireTurnGenerate } from "./serverTurn";

/* =====================================================================
   FIRE chat — real Gemini adapter for the server turn  (integration)
   ---------------------------------------------------------------------
   The production `generate` implementation injected into runFireChatTurn.
   Identical model config to the fireChatTurnAction server action
   (FREE-tier flash, temp 0.2,
   native function-calling with FIRE_TOOLS), but rebuilds the system
   instruction from the FRESH snapshot on every hop so the model sees the
   effect of its previous tool calls (server-side goal-seeking). Reads the
   candidate parts directly — robust across the SDK's native response and
   the compat shim, matching the route.
   ===================================================================== */

const MODEL = DEFAULT_MODEL_FOR_PLAN.FREE;

export function makeGeminiFireGenerate(): FireTurnGenerate {
  return async (contents, snapshot) => {
    const model = getVertexAIClient().getGenerativeModel({
      model: MODEL,
      systemInstruction: buildFireSystemPrompt(snapshot),
      tools: [{ functionDeclarations: FIRE_TOOLS }],
      // 2.5-flash reasons before answering; a tight cap can let the thinking
      // phase consume the whole budget and return an EMPTY response (no tool
      // call, no text). 2048 leaves room for the reasoning + the tool calls.
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
