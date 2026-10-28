/**
 * Classification Logger
 *
 * Fire-and-forget logging of classification metadata for the self-learning loop.
 * Also detects misclassification signals (rephrases, escalations).
 */

import prisma from "@usemoney/database";

export interface ClassificationData {
  message: string;
  intent?: string;
  tier: string;
  persona?: string;
  tool?: string;
  confidence?: number;
  source: string;
  flashFailed: boolean;
  flashError?: string;
  safetyNetActivated: boolean;
  userId: string;
  chatId?: string;
  pagePath?: string;
  requestId: string;
}

/**
 * Log a classification event. Fire-and-forget - caller should .catch(() => {}).
 */
export async function logClassification(
  data: ClassificationData
): Promise<void> {
  await prisma.classificationLog.create({
    data: {
      message: data.message.slice(0, 500),
      intent: data.intent,
      tier: data.tier,
      persona: data.persona,
      tool: data.tool,
      confidence: data.confidence,
      source: data.source,
      flashFailed: data.flashFailed,
      flashError: data.flashError,
      safetyNetActivated: data.safetyNetActivated,
      userId: data.userId,
      chatId: data.chatId,
      pagePath: data.pagePath,
      requestId: data.requestId,
    },
  });
}

/**
 * Detect misclassification signals by comparing with the user's previous message.
 *
 * Signals:
 * - Rephrase: Jaccard word similarity 0.3-0.9 with previous message
 * - Escalation: Previous was L1, current triggers L2 tool
 */
export async function detectMisclassificationSignal(
  userId: string,
  currentMessage: string,
  currentTier: string,
  currentTool?: string
): Promise<void> {
  try {
    // Find the most recent log for this user (prior to the current one)
    const previousLog = await prisma.classificationLog.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: 1, // Skip the one we just created
      select: {
        id: true,
        message: true,
        tier: true,
        tool: true,
      },
    });

    if (!previousLog) return;

    const { isRephrase, isEscalation } = classifyMisclassificationSignals(
      previousLog.message,
      previousLog.tier,
      currentMessage,
      currentTier,
      currentTool
    );

    if (isRephrase || isEscalation) {
      await prisma.classificationLog.update({
        where: { id: previousLog.id },
        data: {
          ...(isRephrase ? { userRephrased: true } : {}),
          ...(isEscalation ? { userEscalated: true } : {}),
        },
      });
    }
  } catch {
    // Non-critical - don't fail the request
  }
}

/**
 * Decide the misclassification signals between a user's previous and current
 * turn. Pure — exported (and called by `detectMisclassificationSignal`) so the
 * thresholds can be unit-tested without standing up Prisma:
 *   - rephrase  : Jaccard word similarity in [0.3, 0.9]
 *   - escalation: previous tier was L1, current is L2/L3, and a tool fired
 */
export function classifyMisclassificationSignals(
  previousMessage: string,
  previousTier: string,
  currentMessage: string,
  currentTier: string,
  currentTool?: string
): { isRephrase: boolean; isEscalation: boolean } {
  const similarity = jaccardSimilarity(previousMessage, currentMessage);
  const isRephrase = similarity >= 0.3 && similarity <= 0.9;
  const isEscalation =
    previousTier === "L1" &&
    (currentTier === "L2" || currentTier === "L3") &&
    !!currentTool;
  return { isRephrase, isEscalation };
}

/**
 * Jaccard word similarity between two strings.
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;

  let intersection = 0;
  const arrA = Array.from(wordsA);
  for (let i = 0; i < arrA.length; i++) {
    if (wordsB.has(arrA[i]!)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
