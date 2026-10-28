/**
 * Behaviour-signal capture seam (MONEY-788, B3).
 *
 * The capture-time half of behaviour-signal capture: three thin helpers that
 * (a) nudge each exercised concept's mastery with a NEUTRAL exposure signal
 * (via {@link applyConceptSignal}), and (b) append a durable `UserEvent` row.
 *
 * Mirrors the `@usemoney/core/analytics` `logAiDecision` contract:
 *   - gated on `process.env.DATABASE_URL` (no DB ⇒ no-op),
 *   - NEVER throws — every failure is swallowed with a `console.warn` so a
 *     capture failure can never break the user-facing request that fired it.
 *
 * SERVER-ONLY: this module touches Prisma. Import it from the
 * `@usemoney/core/investor/capture` subpath only — never the
 * `@usemoney/core/investor` barrel from client code. The signal→concept maps
 * (`./signal-map`) stay pure so they can be imported anywhere.
 */

import { prisma } from "@usemoney/database";
import { applyConceptSignal } from "./profile";
import {
  ROAST_CONCEPTS,
  conceptsForChatIntent,
  conceptsForResearch,
  difficultyForMode,
} from "./signal-map";
import type { SignalDifficulty } from "./mastery";

/**
 * Hard cap on how many concept mastery rows a SINGLE capture call may write.
 * The signal→concept maps are statically bounded today (≤ ~5 slugs/entry), but
 * this is a belt-and-braces guard so a future mis-edited map (or a hostile
 * caller) can never amplify one request into hundreds of DB writes.
 */
const MAX_CONCEPTS_PER_CAPTURE = 8;

/** Cap on how many symbols (and the size of each) we persist on an event row. */
const MAX_SYMBOLS_STORED = 25;
const MAX_SYMBOL_LEN = 32;

/**
 * Sanitize + bound the caller-supplied `symbols` before they land in a durable
 * `UserEvent.data` blob: keep only non-empty strings, truncate each, dedupe,
 * and cap the count. Stops storage amplification from a request that names
 * hundreds of (or oversized) symbols.
 *
 * Exported for direct unit testing of the bound (the surrounding capture
 * helpers need a DB seam to exercise their write path).
 */
export function boundSymbols(symbols: string[]): string[] {
  if (!Array.isArray(symbols)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (typeof s !== "string") continue;
    const v = s.trim().slice(0, MAX_SYMBOL_LEN);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_SYMBOLS_STORED) break;
  }
  return out;
}

/** Apply a NEUTRAL exposure signal to each concept (best-effort, never throws). */
async function nudgeConcepts(
  userId: string,
  conceptIds: string[],
  difficulty: SignalDifficulty,
): Promise<void> {
  // Cap the fan-out: never let one capture spawn an unbounded write storm.
  const capped = conceptIds.slice(0, MAX_CONCEPTS_PER_CAPTURE);
  for (const conceptId of capped) {
    try {
      await applyConceptSignal(userId, {
        conceptId,
        outcome: "NEUTRAL",
        difficulty,
        assistLevel: 0,
      });
    } catch (err) {
      console.warn(
        `UseMoney: captureSignal mastery nudge failed (${conceptId})`,
        err,
      );
    }
  }
}

export interface CaptureResearchSignalInput {
  userId: string;
  sessionId: string;
  skill?: string;
  symbols: string[];
  mode?: string;
  qualityScore?: number;
}

/**
 * Capture a completed research run: nudge each concept the run's skill
 * exercises, then append a `research_completed` event. No-ops without a DB.
 */
export async function captureResearchSignal(
  input: CaptureResearchSignalInput,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  const { userId, sessionId, skill, symbols, mode, qualityScore } = input;
  const conceptIds = conceptsForResearch(skill, symbols);
  const difficulty = difficultyForMode(mode);

  await nudgeConcepts(userId, conceptIds, difficulty);

  try {
    await prisma.userEvent.create({
      data: {
        userId,
        kind: "research_completed",
        surface: "RESEARCH",
        conceptIds,
        data: { skill, symbols: boundSymbols(symbols), mode, qualityScore },
        refId: sessionId,
      },
    });
  } catch (err) {
    console.warn("UseMoney: captureResearchSignal event write failed", err);
  }
}

export interface CaptureChatSignalInput {
  userId: string;
  messageId?: string;
  tool?: string;
  symbols: string[];
}

/**
 * Capture a resolved chat intent: nudge each concept the intent exercises,
 * then append a `chat_intent` event. No-ops without a DB.
 */
export async function captureChatSignal(
  input: CaptureChatSignalInput,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  const { userId, messageId, tool, symbols } = input;
  const conceptIds = conceptsForChatIntent(tool);

  // Chat is a light, conversational exposure — treat as EASY.
  await nudgeConcepts(userId, conceptIds, "EASY");

  try {
    await prisma.userEvent.create({
      data: {
        userId,
        kind: "chat_intent",
        surface: "CHAT",
        conceptIds,
        data: { tool, symbols: boundSymbols(symbols) },
        refId: messageId,
      },
    });
  } catch (err) {
    console.warn("UseMoney: captureChatSignal event write failed", err);
  }
}

export interface CaptureRoastSignalInput {
  userId: string;
  sessionId: string;
  score?: number;
}

/**
 * Capture a completed portfolio roast: nudge the fixed roast concept set, then
 * append a `roast_completed` event. No-ops without a DB.
 */
export async function captureRoastSignal(
  input: CaptureRoastSignalInput,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  const { userId, sessionId, score } = input;
  const conceptIds = [...ROAST_CONCEPTS];

  // A roast is a focused portfolio review — treat as MODERATE exposure.
  await nudgeConcepts(userId, conceptIds, "MODERATE");

  try {
    await prisma.userEvent.create({
      data: {
        userId,
        kind: "roast_completed",
        surface: "ROAST",
        conceptIds,
        data: { score },
        refId: sessionId,
      },
    });
  } catch (err) {
    console.warn("UseMoney: captureRoastSignal event write failed", err);
  }
}
