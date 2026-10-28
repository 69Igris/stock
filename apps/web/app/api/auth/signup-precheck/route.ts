/**
 * POST /api/auth/signup-precheck (MONEY-144)
 *
 * Returns a friendly "blocked" signal ONLY for emails attached to an
 * in-flight account deletion (DeletedUserAudit status in
 * PENDING/PROCESSING/LOCKED). For everything else — email never seen,
 * active account, completed-deletion-then-purged, parse errors,
 * rate-limit — returns `{ blocked: false }` so an attacker cannot use
 * this endpoint to enumerate active users.
 *
 * Design notes:
 *   - Rate-limited per-IP (10 req / 15 min) via the existing auth
 *     limiter. Even the deleted-case is rate-limited so an attacker
 *     can't enumerate "recently deleted accounts" en masse.
 *   - Email is normalised to lowercase before matching.
 *   - Logs do NOT include the raw email (only a short hash) to keep
 *     the audit logs clean.
 *   - Response is intentionally lossless on the "not blocked" path —
 *     no field that could leak whether the email is registered, has
 *     a Clerk identity, etc.
 */

import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  authRateLimiter,
  checkRateLimit,
  createRateLimitKey,
} from "@usemoney/security/rate-limit";
import { authLogger as logger } from "@usemoney/logger";

const PrecheckSchema = z.object({
  email: z.string().email().max(254),
});

type PrecheckResponse =
  | { blocked: false }
  | { blocked: true; availableAt: string; reason: "recently_deleted" };

const NOT_BLOCKED: PrecheckResponse = { blocked: false };

function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 10);
}

function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: Request) {
  const ip = getClientIp(request);

  try {
    await checkRateLimit(
      authRateLimiter,
      10,
      createRateLimitKey("signup-precheck", ip)
    );
  } catch {
    // Rate-limited callers get the same non-leaking response as
    // happy-path callers. Returning 429 would itself be a signal.
    return NextResponse.json(NOT_BLOCKED, { status: 200 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(NOT_BLOCKED, { status: 200 });
  }

  const parsed = PrecheckSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(NOT_BLOCKED, { status: 200 });
  }

  const email = parsed.data.email.toLowerCase().trim();

  try {
    const audit = await prisma.deletedUserAudit.findFirst({
      where: {
        email: { equals: email, mode: "insensitive" },
        status: { in: ["PENDING", "PROCESSING", "LOCKED"] },
      },
      select: {
        clerkDeleteScheduledFor: true,
        clerkLockedAt: true,
        deletedAt: true,
      },
      orderBy: { deletedAt: "desc" },
    });

    if (!audit) {
      return NextResponse.json(NOT_BLOCKED, { status: 200 });
    }

    // Prefer the scheduled purge timestamp (set by the worker in
    // Phase 1). If the worker hasn't reached Phase 1 yet (PENDING),
    // estimate from deletedAt + 24h so the UI still has something
    // accurate-ish to show.
    const availableAt =
      audit.clerkDeleteScheduledFor ??
      (audit.clerkLockedAt
        ? new Date(audit.clerkLockedAt.getTime() + 24 * 60 * 60 * 1000)
        : new Date(audit.deletedAt.getTime() + 24 * 60 * 60 * 1000));

    logger.info(
      { emailHash: hashEmail(email), ip },
      "[signup-precheck] blocked - in-flight deletion"
    );

    return NextResponse.json(
      {
        blocked: true,
        availableAt: availableAt.toISOString(),
        reason: "recently_deleted",
      } satisfies PrecheckResponse,
      { status: 200 }
    );
  } catch (err) {
    logger.error({ err }, "[signup-precheck] lookup failed");
    // Fail open: don't block a legitimate user just because the lookup
    // errored. Clerk's own signup flow will still enforce uniqueness.
    return NextResponse.json(NOT_BLOCKED, { status: 200 });
  }
}
