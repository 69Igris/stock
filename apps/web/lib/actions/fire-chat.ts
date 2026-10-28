"use server";

/* =====================================================================
   Ask FIRE chat — SERVER ACTION  (MONEY-1079)
   ---------------------------------------------------------------------
   Replaces the POST /api/fire-chat HTTP route: the /fire page now calls
   this server action directly instead of fetching its own API route
   (repo convention — web mutations go through server actions, not
   app/api). The classification logic is UNCHANGED from the route; only
   the transport differs. The framework-free engine (parser, tools,
   system prompt) lives in `@usemoney/fire`, so apps/api's mobile route
   shares the exact same two tiers.

   Two tiers ("functions if possible, else LLM"):
     Tier 1 — parseFireCommand resolves an unambiguous single-intent
       command to tool calls with NO model call (free, no credit).
     Tier 2 — everything else → Gemini function-calling (credit-charged
       ONLY on a pure-answer turn).

   Tool EXECUTION still happens client-side (it mutates the FIRE page's
   React state), so this action only CLASSIFIES and returns tool calls.
   ===================================================================== */

import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import type { Content } from "@google/genai";
import { isDemoSession } from "@/lib/demo/session";
import { getOrCreateDbUser } from "@/lib/db/user";
import { getVertexAIClient } from "@/lib/gemini/client";
import { apiRateLimiter } from "@usemoney/security/rate-limit";
import { consumeCredits } from "@usemoney/services";
import { DEFAULT_MODEL_FOR_PLAN } from "@usemoney/core";
import { geminiLogger as logger } from "@usemoney/logger";
import {
  FIRE_TOOLS,
  parseFireCommand,
  buildFireSystemPrompt,
  type FireSnapshot,
} from "@usemoney/fire";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

// FREE-tier chat model (single source of truth) — fast, cheap, strong native
// tool-calling. Ask FIRE pins the cheapest lane regardless of the user's plan.
const MODEL = DEFAULT_MODEL_FOR_PLAN.FREE;
const FIRE_CHAT_ACTION = "fire_chat";

/**
 * Output budget for one hop (MONEY-1240).
 *
 * Was 1024, which a FIRE projection answer routinely overran: the model wrote
 * the prose and ran out mid-sentence, right where the figure belonged —
 * "…you would achieve it" with no age, "…you would need" with no rupee amount.
 *
 * The cap alone is not the fix. `finishReason` decides whether the text is a
 * whole answer or a fragment, and nothing read it, so a truncated candidate was
 * indistinguishable from a complete one and rendered as if finished. Raising
 * this without reading that would only move the cliff further out.
 */
const MAX_OUTPUT_TOKENS = 4096;
// Per-REQUEST cap (a message fans out up to MAX_HOPS calls), keyed on userId
// else client IP. Mirrors the old /api/fire-chat route.
const RATE_LIMIT_PER_MIN = 90;

export interface FireFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type FireChatTurnResult =
  | {
      text: string | null;
      functionCalls: FireFunctionCall[];
      source: "deterministic" | "llm";
    }
  | { error: string; detail?: string };

/**
 * The latest user command text, but ONLY when the last turn is a fresh user
 * message (not a follow-up carrying functionResponse parts). Null on follow-up
 * hops so the deterministic tier never short-circuits a mid-loop confirmation.
 */
function latestUserText(contents: Content[]): string | null {
  const last = contents[contents.length - 1];
  if (!last || last.role !== "user") return null;
  const parts = last.parts ?? [];
  if (parts.some((p) => p.functionResponse)) return null;
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join(" ")
    .trim();
  return text || null;
}

/**
 * Entry point for a FIRE chat turn. The body lives in `runFireChatTurnAction`;
 * this wrapper tags its model calls `ml_app: fire` (MONEY-1380).
 *
 * Wrapped at the CALLER rather than inside `packages/fire`: the package is a
 * library shared by this action and apps/api's /v1/fire route, and wrapping a
 * library would open a workflow span for anything that ever imports it. The
 * api route wraps its own call the same way.
 */
export async function fireChatTurnAction(
  contents: Content[],
  snapshot: FireSnapshot
): Promise<FireChatTurnResult> {
  return llmWorkflow("fire", "fire-chat-turn", () =>
    runFireChatTurnAction(contents, snapshot)
  );
}

async function runFireChatTurnAction(
  contents: Content[],
  snapshot: FireSnapshot
): Promise<FireChatTurnResult> {
  // The FIRE page is ungated (Clerk user OR demo session); gate the chat the
  // same way. Local dev is always allowed so testing isn't blocked.
  const { userId } = await auth();
  if (
    !userId &&
    process.env.NODE_ENV === "production" &&
    !(await isDemoSession())
  ) {
    return { error: "Unauthorized" };
  }

  // Rate limit BEFORE any work (incl. the free parser) so a flood can't fan out
  // Gemini calls. IP via next/headers (server actions have no NextRequest).
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown";
  const rlToken = userId ? `fire:user:${userId}` : `fire:ip:${ip}`;
  const rl = await apiRateLimiter.check(RATE_LIMIT_PER_MIN, rlToken);
  if (!rl.success) {
    return {
      error: "Too many requests. Please slow down and try again shortly.",
    };
  }

  if (!process.env.GOOGLE_GENAI_API_KEY && !process.env.GCP_PROJECT_ID) {
    return {
      error: "The FIRE assistant is not configured.",
      detail:
        process.env.NODE_ENV !== "production"
          ? "Set GOOGLE_GENAI_API_KEY in apps/web/.env (or GCP_PROJECT_ID + service-account creds for Vertex) and restart the dev server."
          : undefined,
    };
  }

  if (!Array.isArray(contents) || contents.length === 0 || !snapshot) {
    return {
      error: "`contents` (non-empty array) and `snapshot` are required.",
    };
  }

  // ── Tier 1: deterministic fast path (no model, no credit) ───────────
  const userText = latestUserText(contents);
  if (userText) {
    const parsed = parseFireCommand(userText, snapshot);
    if (parsed) {
      logger.info(
        { matcher: parsed.matcher, calls: parsed.functionCalls.length },
        "[fire-chat] deterministic fast path"
      );
      return {
        text: null,
        functionCalls: parsed.functionCalls,
        source: "deterministic",
      };
    }
  }

  // ── Tier 2: Gemini function-calling ─────────────────────────────────
  try {
    const model = getVertexAIClient().getGenerativeModel({
      model: MODEL,
      systemInstruction: buildFireSystemPrompt(snapshot),
      tools: [{ functionDeclarations: FIRE_TOOLS }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    });

    const { response } = await model.generateContent({ contents });
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const text =
      parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim() || null;

    const functionCalls: FireFunctionCall[] = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: p.functionCall?.id,
        name: p.functionCall?.name ?? "",
        args: (p.functionCall?.args ?? {}) as Record<string, unknown>,
      }))
      .filter((c) => c.name);

    // MONEY-1240 — a candidate that stopped on MAX_TOKENS is a FRAGMENT, and
    // until now nothing told it apart from a finished answer: the parts were
    // joined and returned either way, so the UI printed half a sentence as
    // though the assistant had finished speaking. That is worse than an error,
    // because the reply reads confident and stops exactly where the number the
    // user asked for should have been.
    //
    // Only fail a TEXT-ONLY turn. When the model also emitted tool calls the
    // client executes them and hops again, so the conversation continues and
    // the truncated prose is not the final word.
    if (
      candidate?.finishReason === "MAX_TOKENS" &&
      functionCalls.length === 0
    ) {
      logger.warn(
        { model: MODEL, maxOutputTokens: MAX_OUTPUT_TOKENS },
        "[fire-chat] response truncated at MAX_TOKENS"
      );
      return {
        error:
          "That answer was too long for me to finish. Try asking for one thing at a time — for example, just the retirement age, then the monthly amount.",
      };
    }

    // Charge only a PURE-ANSWER turn (no tools). Tool turns are free; follow-up
    // hops (userText null) and demo/dev (no userId) are never charged.
    //
    // consumeCredits keys the subscription on the INTERNAL Mongo user id, NOT
    // the Clerk id — resolve it first (as the main chat route does). Passing the
    // raw Clerk id here made every question turn fail with "subscription
    // missing → Failed to consume credits" (a bug the old /api/fire-chat route
    // also had). A missing dbUser (shouldn't happen for an authed user) skips
    // the charge rather than failing the turn.
    if (userText !== null && userId && functionCalls.length === 0) {
      const dbUser = await getOrCreateDbUser(userId);
      if (dbUser) {
        const credit = await consumeCredits(dbUser.id, FIRE_CHAT_ACTION, {
          query: userText.slice(0, 200),
          geminiModel: MODEL,
        });
        if (!credit.success) {
          return {
            error:
              credit.error ||
              "You're out of credits for the FIRE assistant. Upgrade to keep chatting.",
          };
        }
      }
    }

    return { text, functionCalls, source: "llm" };
  } catch (err) {
    // No refund needed — credit is taken only AFTER a successful no-tool turn.
    logger.error({ error: err }, "[fire-chat] Gemini call failed");
    const detail =
      process.env.NODE_ENV !== "production" && err instanceof Error
        ? err.message
        : undefined;
    return {
      error: "The FIRE assistant is unavailable right now. Try again.",
      ...(detail ? { detail } : {}),
    };
  }
}
