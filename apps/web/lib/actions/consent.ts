"use server";

/**
 * Consent ledger actions — MONEY-505 / 501 (SEBI IA Reg 18(9)).
 *
 * Reads/writes the unified ConsentRecord ledger (kind AI_ADVISORY). The
 * AI-advisory disclosure is presented + consented before broker-connect (505);
 * the records are exportable for any user (501 acceptance criterion).
 */

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { isDemoSession } from "@/lib/demo/session";
import { AI_ADVISORY_VERSION } from "@/lib/consent/ai-advisory";

async function resolveUserId(): Promise<string | null> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;
  const user = await prisma.user.findFirst({
    where: { OR: [{ clerkId: clerkUserId }, { email: clerkUserId }] },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * Has the user accepted the CURRENT AI-advisory disclosure version? Demo
 * sessions bypass (no DB user). Used to gate the broker-connect flow.
 */
export async function getBrokerConsentStatusAction(): Promise<{
  accepted: boolean;
  version: string;
}> {
  try {
    if (await isDemoSession()) {
      return { accepted: true, version: AI_ADVISORY_VERSION };
    }
    const userId = await resolveUserId();
    if (!userId) return { accepted: false, version: AI_ADVISORY_VERSION };
    const record = await prisma.consentRecord.findFirst({
      where: { userId, kind: "AI_ADVISORY", version: AI_ADVISORY_VERSION },
      select: { id: true },
    });
    return { accepted: !!record, version: AI_ADVISORY_VERSION };
  } catch {
    // Fail open to "not accepted" so the disclosure is shown rather than
    // silently skipped on an error.
    return { accepted: false, version: AI_ADVISORY_VERSION };
  }
}

/**
 * Record AI-advisory consent (version-stamped, idempotent per version). `source`
 * is where it was captured ("broker_connect" | "settings" | "chat").
 */
export async function recordBrokerConsentAction(
  source = "broker_connect"
): Promise<{ success: boolean; error?: string }> {
  try {
    if (await isDemoSession()) return { success: true };
    const userId = await resolveUserId();
    if (!userId) return { success: false, error: "Authentication required" };

    const existing = await prisma.consentRecord.findFirst({
      where: { userId, kind: "AI_ADVISORY", version: AI_ADVISORY_VERSION },
      select: { id: true },
    });
    if (!existing) {
      await prisma.consentRecord.create({
        data: {
          userId,
          kind: "AI_ADVISORY",
          version: AI_ADVISORY_VERSION,
          source,
        },
      });
    }
    return { success: true };
  } catch (error) {
    console.error("recordBrokerConsentAction failed", error);
    return { success: false, error: "Failed to record consent" };
  }
}

/**
 * All consent records for the current user, newest first — exportable per the
 * Reg 18(9) audit-trail requirement (501).
 */
export async function getConsentRecordsAction(): Promise<
  Array<{
    kind: string;
    version: string;
    acceptedAt: Date;
    source: string | null;
  }>
> {
  try {
    const userId = await resolveUserId();
    if (!userId) return [];
    const records = await prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { acceptedAt: "desc" },
      select: { kind: true, version: true, acceptedAt: true, source: true },
    });
    return records;
  } catch {
    return [];
  }
}
