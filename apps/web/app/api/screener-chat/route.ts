import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import type { Content } from "@google/genai";
import { isDemoSession } from "@/lib/demo/session";
import { getOrCreateDbUser } from "@/lib/db/user";
import { getVertexAIClient } from "@/lib/gemini/client";
import { apiRateLimiter } from "@usemoney/security/rate-limit";
import { consumeCredits } from "@usemoney/services";
import { DEFAULT_MODEL_FOR_PLAN } from "@usemoney/core";
import { geminiLogger as logger } from "@usemoney/logger";
import { SCREENER_TOOLS } from "@/app/discover/screener/lib/chat/tools";
import {
  buildScreenerSystemPrompt,
  type ScreenerSnapshot,
} from "@/app/discover/screener/lib/chat/systemPrompt";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

/* =====================================================================
   POST /api/screener-chat  (MONEY-1078)
   ---------------------------------------------------------------------
   Ask Screener chat endpoint, mirroring the Ask FIRE chat (MONEY-1049;
   its route became the fireChatTurnAction server action in MONEY-1079)
   minus the deterministic parser tier (screener requests are almost
   always multi-key filter builds — there is no single-intent command
   vocabulary worth a parser yet).

   Tool EXECUTION always happens client-side (it mutates the screener
   page's React state), so this route never runs tools itself.

   Request:  { contents: Content[], snapshot: ScreenerSnapshot }
   Response: { text: string|null, functionCalls: {id?,name,args}[],
               source: "llm" }
   ===================================================================== */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same lane as Ask FIRE: the FREE-tier chat model — fast + cheap, strong
// native tool-calling (batches parallel functionCall parts).
const MODEL = DEFAULT_MODEL_FOR_PLAN.FREE;

// Billed once per pure-answer LLM turn (see CREDIT_COSTS in @usemoney/core).
const SCREENER_CHAT_ACTION = "screener_chat";

/**
 * Output budget for one hop (MONEY-1243).
 *
 * Was 1024. This cap counts the THINKING budget too, and `thinkingConfig`
 * below pins 512 of it, so an answer had roughly half the room it appeared to
 * have — the model reasoned, then ran out mid-sentence.
 *
 * The cap is only half the fix. `finishReason` decides whether the text is a
 * whole answer or a fragment, and nothing read it, so a truncated candidate
 * was indistinguishable from a complete one. Raising this alone would just
 * move the cliff.
 */
const MAX_OUTPUT_TOKENS = 4096;

// Per-REQUEST ceiling (a single user message fans out to up to MAX_HOPS
// POSTs here) — same rationale and figure as fire-chat.
const RATE_LIMIT_PER_MIN = 90;

// Request size ceilings (see the 413 checks in POST). Generous multiples of
// what the real client sends: it caps history at 24 turns and the snapshot
// at 10 result rows + 40 vocabulary options.
const MAX_CONTENTS = 100;
const MAX_SNAPSHOT_CHARS = 100_000;
// Bounding the NUMBER of turns is not enough on its own — 100 turns can still
// carry megabytes. This caps the actual payload. The legitimate client sends
// 24 capped turns (well under 100 KB), so this sits far above real traffic.
const MAX_CONTENTS_CHARS = 200_000;

interface ScreenerChatRequest {
  contents: Content[];
  snapshot: ScreenerSnapshot;
}

interface ScreenerFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The latest user command text, but ONLY when the last turn is a fresh
 * user message (not a functionResponse follow-up hop). Used for the
 * charge decision + logging, same contract as fire-chat.
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
 * Entry point. The body lives in `handleScreenerChatPost`; this wrapper tags every model call
 * underneath it with `ml_app: chat` (MONEY-1380). Auto-instrumented LLM
 * spans inherit it from this workflow parent, so calls made deep inside
 * packages this file never imports are attributed correctly.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return llmWorkflow("chat", "screener-chat-turn", () =>
    handleScreenerChatPost(req)
  );
}

async function handleScreenerChatPost(req: NextRequest) {
  // The screener works for a signed-in Clerk user OR a demo session, so
  // gate the chat the same way. Local dev is always allowed.
  const { userId } = await auth();
  if (
    !userId &&
    process.env.NODE_ENV === "production" &&
    !(await isDemoSession())
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit BEFORE any work so a flood can't fan out Gemini calls.
  const ipHeader =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rlToken = userId
    ? `screener-chat:user:${userId}`
    : `screener-chat:ip:${ipHeader}`;
  const rl = await apiRateLimiter.check(RATE_LIMIT_PER_MIN, rlToken);
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.reset / 1000)) },
      }
    );
  }

  if (!process.env.GOOGLE_GENAI_API_KEY && !process.env.GCP_PROJECT_ID) {
    return NextResponse.json(
      {
        error: "The Screener assistant is not configured.",
        detail:
          process.env.NODE_ENV !== "production"
            ? "Set GOOGLE_GENAI_API_KEY in apps/web/.env (or GCP_PROJECT_ID + service-account creds for Vertex) and restart the dev server."
            : undefined,
      },
      { status: 503 }
    );
  }

  let body: ScreenerChatRequest;
  try {
    body = (await req.json()) as ScreenerChatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { contents, snapshot } = body;
  if (!Array.isArray(contents) || contents.length === 0 || !snapshot) {
    return NextResponse.json(
      { error: "`contents` (non-empty array) and `snapshot` are required." },
      { status: 400 }
    );
  }

  // Size caps. The snapshot is stringified straight into the system prompt
  // and `contents` is forwarded verbatim, so without a ceiling an
  // authenticated client could drive multi-MB prompts at the rate limit —
  // and tool turns are never credit-charged, so nothing else bounds cost.
  // The legitimate client caps history at MAX_HISTORY (24) and the snapshot
  // at 10 rows / 40 options, so these limits sit far above real traffic.
  if (
    contents.length > MAX_CONTENTS ||
    JSON.stringify(contents).length > MAX_CONTENTS_CHARS
  ) {
    return NextResponse.json(
      { error: "Conversation too long. Start a new chat." },
      { status: 413 }
    );
  }
  if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_CHARS) {
    return NextResponse.json(
      { error: "Screen snapshot too large." },
      { status: 413 }
    );
  }

  // Credit is charged AFTER the response and ONLY when the turn produced
  // NO tool calls (pure reasoning/answering). Tool-producing turns and
  // follow-up hops are free — same policy as fire-chat.
  const userText = latestUserText(contents);
  try {
    const model = getVertexAIClient().getGenerativeModel({
      model: MODEL,
      systemInstruction: buildScreenerSystemPrompt(snapshot),
      tools: [{ functionDeclarations: SCREENER_TOOLS }],
      generationConfig: {
        temperature: 0.2,
        // MONEY-1243 — was 1024, and this cap INCLUDES the thinking budget
        // pinned below, so ~512 of it was spent before a single visible
        // character was produced. Answers truncated mid-sentence, and because
        // finishReason was never read (see below) the fragment rendered as a
        // finished reply. Raised so the answer has room AFTER thinking.
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // EXPLICIT thinking budget is REQUIRED, not a tuning knob.
        // With `thinkingConfig` omitted, gemini-2.5-flash's dynamic-thinking
        // default intermittently returns an EMPTY candidate for this
        // prompt+toolset: finishReason "STOP" with candidatesTokenCount 0 and
        // thoughtsTokenCount 0 — no text, no function call. It is not random:
        // "sort by market cap high to low" reproduced EMPTY 3/3, while the
        // same request with any explicit budget produced the tool call 3/3
        // (verified live against gemini-2.5-flash, 2026-07-21). An empty
        // candidate surfaces to the user as a silent no-op ("Done." with
        // nothing changed), so pin the budget.
        thinkingConfig: { thinkingBudget: 512 },
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

    const functionCalls: ScreenerFunctionCall[] = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: p.functionCall?.id,
        name: p.functionCall?.name ?? "",
        args: (p.functionCall?.args ?? {}) as Record<string, unknown>,
      }))
      .filter((c) => c.name);

    // MONEY-1243 — a candidate that stopped on MAX_TOKENS is a FRAGMENT, and
    // nothing told it apart from a finished answer: the parts were joined and
    // returned either way, so the panel printed half a sentence as though the
    // assistant had finished. Worse than an error, because it reads confident
    // and stops exactly where the user's answer should have been.
    //
    // Only fail a TEXT-ONLY turn. When the model also emitted tool calls the
    // client executes them and hops again, so the truncated prose is not the
    // final word — failing here would strand an applied screen change.
    //
    // Placed BEFORE consumeCredits: you pay to think, not to be cut off.
    if (
      candidate?.finishReason === "MAX_TOKENS" &&
      functionCalls.length === 0
    ) {
      logger.warn(
        { model: MODEL, maxOutputTokens: MAX_OUTPUT_TOKENS },
        "[screener-chat] response truncated at MAX_TOKENS"
      );
      return NextResponse.json(
        {
          error:
            "That answer was too long for me to finish. Try narrowing the question — for example, ask for one filter at a time.",
        },
        { status: 502 }
      );
    }

    // consumeCredits keys the subscription on the INTERNAL Mongo user id, NOT
    // the Clerk id (Subscription.userId is an @db.ObjectId FK to User.id), so
    // resolve it first — exactly as lib/actions/fire-chat.ts does. Passing the
    // raw Clerk id makes Prisma throw "Malformed ObjectID", which
    // consumeCredits catches and returns as `Failed to consume credits`, so
    // EVERY pure-answer turn 402'd for a user with plenty of credits. A
    // missing dbUser (shouldn't happen for an authed user) skips the charge
    // rather than failing the turn.
    if (userText !== null && userId && functionCalls.length === 0) {
      const dbUser = await getOrCreateDbUser(userId);
      if (dbUser) {
        const credit = await consumeCredits(dbUser.id, SCREENER_CHAT_ACTION, {
          query: userText.slice(0, 200),
          geminiModel: MODEL,
        });
        if (!credit.success) {
          return NextResponse.json(
            {
              error:
                credit.error ||
                "You're out of credits for the Screener assistant. Upgrade to keep chatting.",
              source: "llm",
            },
            { status: 402 }
          );
        }
      }
    }

    return NextResponse.json({ text, functionCalls, source: "llm" });
  } catch (err) {
    // No refund needed — credit is only taken AFTER a successful no-tool
    // response, so a failed turn was never charged.
    logger.error({ error: err }, "[screener-chat] Gemini call failed");
    const detail =
      process.env.NODE_ENV !== "production" && err instanceof Error
        ? err.message
        : undefined;
    return NextResponse.json(
      {
        error: "The Screener assistant is unavailable right now. Try again.",
        ...(detail ? { detail } : {}),
      },
      { status: 502 }
    );
  }
}
