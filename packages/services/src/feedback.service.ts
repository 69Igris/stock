/**
 * Feedback Service (MONEY-402 mobile-parity)
 *
 * Submit a feedback ticket and list the caller's own tickets. Extracted from
 * `apps/web/lib/actions/feedback.ts`, PRESERVING the two security-relevant
 * behaviours:
 *   - the plan-based monthly submission limit (FREE=3, PRO=10,
 *     PREMIUM/ULTIMATE=unlimited) via {@link checkFeedbackQuota}, and
 *   - the IDOR attachment guard — only the caller's own `feedback/{userId}/`
 *     paths persist ({@link filterOwnedImagePaths}).
 *
 * STRIPPED (web/next glue): `getAuthenticatedUser` (route owns auth) and the
 * fire-and-forget premium confirmation EMAIL (a UI side effect; the API route
 * stays a pure data write — re-add via `@usemoney/email` in a follow-up if
 * mobile wants the receipt).
 *
 * DEFERRED: the attachment UPLOAD path (GCS `uploadFile` + signed URL) is not
 * modelled here — mobile should upload via a signed-URL flow (like documents)
 * and pass the resulting `feedback/{userId}/…` paths to `submitFeedback`, which
 * re-applies the IDOR filter. Thread reads with signed image URLs are also
 * deferred (GCS-coupled).
 *
 * IDOR: every read/write is scoped to the caller's `userId`.
 *
 * @see packages/services/src/feedback-logic.ts (quota + IDOR pure seams)
 * @see packages/services/__tests__/feedback-service.test.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { getSignedUrl } from "@usemoney/storage";
import type { ServiceResult } from "./types";
import {
  checkFeedbackQuota,
  filterOwnedImagePaths,
  isValidFeedbackStatus,
  isValidFeedbackType,
  monthStartUtc,
} from "./feedback-logic";

/** A feedback ticket as returned to the client. */
export interface FeedbackItem {
  id: string;
  userId: string;
  type: string;
  title: string;
  description: string;
  images: string[];
  status: string;
  priority: string | null;
  page: string | null;
  adminNote: string | null;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Validated submit payload (the route Zod-validates before calling). */
export interface SubmitFeedbackInput {
  type: string;
  title: string;
  description: string;
  page?: string | null;
  images?: string[];
}

/** Validated list filter. */
export interface FeedbackListInput {
  status?: string;
  type?: string;
  skip?: number;
  limit?: number;
}

/**
 * Injectable IO seam. `@usemoney/services` runs its suite as ESM, so tests pass
 * a fake prisma (and clock) via `deps` rather than module-mocking.
 */
export interface FeedbackServiceDeps {
  prisma?: typeof prisma;
  now?: () => Date;
}

/**
 * Submit a feedback ticket for the caller. Enforces the plan-based monthly
 * limit and the IDOR attachment filter before the write.
 */
export async function submitFeedback(
  userId: string,
  input: SubmitFeedbackInput,
  deps: FeedbackServiceDeps = {},
): Promise<ServiceResult<FeedbackItem>> {
  const db = deps.prisma ?? prisma;
  const now = deps.now ?? (() => new Date());

  // Allow-list the type before any DB work: rejects a forged value AND narrows
  // `string` → `FeedbackType` so the enum column write type-checks (defence in
  // depth — the route Zod-validates the same set).
  if (!isValidFeedbackType(input.type)) {
    return {
      success: false,
      error: "Invalid feedback type",
      code: "INVALID_INPUT",
    };
  }
  const feedbackType = input.type;

  try {
    // Plan-based monthly limit — scoped to the caller.
    const subscription = await db.subscription.findUnique({
      where: { userId },
      select: { planId: true },
    });
    const planId = subscription?.planId ?? "FREE";

    const monthlyCount = await db.feedback.count({
      where: { userId, createdAt: { gte: monthStartUtc(now()) } },
    });
    const quota = checkFeedbackQuota(planId, monthlyCount);
    if (!quota.allowed) {
      return {
        success: false,
        error: quota.reason ?? "Monthly limit reached",
        code: "QUOTA_EXCEEDED",
      };
    }

    const feedback = await db.feedback.create({
      data: {
        userId,
        type: feedbackType,
        title: input.title,
        description: input.description,
        // IDOR guard: only the caller's own uploads may persist.
        images: filterOwnedImagePaths(input.images, userId),
        page: input.page ?? null,
        metadata: { planId },
      },
    });

    return {
      success: true,
      data: { ...toFeedbackItem(feedback), replyCount: 0 },
    };
  } catch (error) {
    logger.error({ error, userId }, "Submit feedback service error");
    return { success: false, error: "Failed to submit feedback" };
  }
}

/**
 * List the caller's own feedback tickets (with reply counts + total), filtered
 * + paginated. IDOR: the WHERE is always scoped to `userId`.
 */
export async function getUserFeedback(
  userId: string,
  input: FeedbackListInput = {},
  deps: FeedbackServiceDeps = {},
): Promise<ServiceResult<{ items: FeedbackItem[]; total: number }>> {
  const db = deps.prisma ?? prisma;
  // Cap matches the /v1/feedback route's clamp (MAX_LIMIT=100) so the route's
  // paginate() hasMore/limit meta never over-reports vs the rows actually
  // returned (MONEY-1062 review): a 60-row user asking limit=100 must get all 60.
  const take = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const skip = Math.max(input.skip ?? 0, 0);
  try {
    // Only apply the status/type filters when they are valid enum members — an
    // unknown `?status=`/`?type=` value passed straight into a Prisma enum column
    // throws ("Invalid enum value") → the catch below turns a mere bad query
    // param into a 500. An invalid filter is dropped (unfiltered), never a 500.
    const where: Record<string, unknown> = { userId };
    if (input.status && isValidFeedbackStatus(input.status)) {
      where.status = input.status;
    }
    if (input.type && isValidFeedbackType(input.type)) {
      where.type = input.type;
    }

    const [rows, total] = await Promise.all([
      db.feedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { _count: { select: { replies: true } } },
      }),
      db.feedback.count({ where }),
    ]);

    return {
      success: true,
      data: {
        items: rows.map((r) => ({
          ...toFeedbackItem(r),
          replyCount: r._count?.replies ?? 0,
        })),
        total,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get user feedback service error");
    return { success: false, error: "Failed to fetch feedback" };
  }
}

/** Map a raw Feedback row to the client-facing shape (replyCount set by caller). */
function toFeedbackItem(
  row: Record<string, unknown>,
): Omit<FeedbackItem, "replyCount"> {
  return {
    id: row.id as string,
    userId: row.userId as string,
    type: row.type as string,
    title: row.title as string,
    description: row.description as string,
    images: (row.images as string[]) ?? [],
    status: row.status as string,
    priority: (row.priority as string | null) ?? null,
    page: (row.page as string | null) ?? null,
    adminNote: (row.adminNote as string | null) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Feedback thread (MONEY-1062 P4e — apps/api /v1/feedback/:id/{thread,replies,close})
//
// Extracted from apps/web/lib/actions/feedback.ts
// (getFeedbackThreadAction / addFeedbackReplyAction / closeUserFeedbackAction),
// PRESERVING every security-relevant behaviour:
//   - IDOR: the ticket is always fetched with BOTH `id` AND `userId`, so a
//     crafted feedbackId can never surface (or reply to / close) another user's
//     thread.
//   - the reply attachment IDOR guard — only the caller's own
//     `feedback/{userId}/` paths persist ({@link filterOwnedImagePaths}), same
//     as submitFeedback.
//   - the "already closed" guard (COMPLETED / DECLINED / DUPLICATE).
//
// The signed-image-URL minting (previously "deferred (GCS-coupled)" in this
// file's header) is wired via `@usemoney/storage` getSignedUrl, injectable as
// `deps.signImageUrl` so the ESM service suite can assert URL resolution without
// touching GCS. A per-path signing failure degrades to "" (dropped), exactly
// like the web action's `resolveImageUrls`.
// ───────────────────────────────────────────────────────────────────────────

/** A single feedback reply as returned to the client (with signed image URLs). */
export interface FeedbackReplyItem {
  id: string;
  message: string;
  images: string[];
  imageUrls: string[];
  isAdmin: boolean;
  createdAt: Date;
}

/** A feedback thread: the ticket (+ signed image URLs) and its ordered replies. */
export interface FeedbackThread {
  feedback: FeedbackItem & { imageUrls: string[] };
  replies: FeedbackReplyItem[];
}

/** Validated reply payload (the route Zod-validates before calling). */
export interface AddFeedbackReplyInput {
  feedbackId: string;
  message: string;
  images?: string[];
}

/**
 * Thread-flow IO seam. Adds `signImageUrl` to the base deps so the GCS signer is
 * injectable in tests (default = `@usemoney/storage` getSignedUrl, 1h TTL).
 */
export interface FeedbackThreadDeps extends FeedbackServiceDeps {
  /** Resolve a GCS path → short-lived signed URL. Failures degrade to "". */
  signImageUrl?: (path: string) => Promise<string>;
}

/** Default signer: a 1h signed URL, swallowing per-path failures (→ ""). */
async function defaultSignImageUrl(path: string): Promise<string> {
  try {
    return await getSignedUrl(path, { expiresIn: 3600 });
  } catch {
    return "";
  }
}

/** Mint signed URLs for an array of GCS paths (dropping any that fail). */
async function resolveImageUrls(
  paths: string[] | undefined,
  sign: (path: string) => Promise<string>,
): Promise<string[]> {
  if (!paths || paths.length === 0) return [];
  const urls = await Promise.all(paths.map((p) => sign(p)));
  return urls.filter(Boolean);
}

/**
 * Get a feedback thread — the ticket + all replies, each with signed image URLs.
 *
 * IDOR: the ticket is fetched with `{ id, userId }`; a non-owned/absent id →
 * `NOT_FOUND` (route maps to 404).
 */
export async function getFeedbackThread(
  userId: string,
  feedbackId: string,
  deps: FeedbackThreadDeps = {},
): Promise<ServiceResult<FeedbackThread>> {
  const db = deps.prisma ?? prisma;
  const sign = deps.signImageUrl ?? defaultSignImageUrl;
  try {
    const feedback = await db.feedback.findFirst({
      where: { id: feedbackId, userId },
      include: {
        replies: { orderBy: { createdAt: "asc" } },
        _count: { select: { replies: true } },
      },
    });

    if (!feedback) {
      return { success: false, error: "Feedback not found", code: "NOT_FOUND" };
    }

    const row = feedback as unknown as Record<string, unknown>;
    const feedbackImageUrls = await resolveImageUrls(
      row.images as string[] | undefined,
      sign,
    );

    const rawReplies = (row.replies as Array<Record<string, unknown>>) ?? [];
    const replies: FeedbackReplyItem[] = await Promise.all(
      rawReplies.map(async (reply) => ({
        id: reply.id as string,
        message: reply.message as string,
        images: (reply.images as string[]) ?? [],
        imageUrls: await resolveImageUrls(reply.images as string[], sign),
        isAdmin: (reply.isAdmin as boolean) ?? false,
        createdAt: reply.createdAt as Date,
      })),
    );

    return {
      success: true,
      data: {
        feedback: {
          ...toFeedbackItem(row),
          imageUrls: feedbackImageUrls,
          replyCount:
            (row._count as { replies?: number } | undefined)?.replies ?? 0,
        },
        replies,
      },
    };
  } catch (error) {
    logger.error(
      { error, userId, feedbackId },
      "Get feedback thread service error",
    );
    return { success: false, error: "Failed to fetch feedback thread" };
  }
}

/**
 * Add a reply to the caller's own feedback thread. IDOR: the parent ticket is
 * verified with `{ id, userId }` first; reply attachments are filtered to the
 * caller's own `feedback/{userId}/` paths ({@link filterOwnedImagePaths}). The
 * parent's `updatedAt` is touched (mirrors the web action).
 */
export async function addFeedbackReply(
  userId: string,
  input: AddFeedbackReplyInput,
  deps: FeedbackThreadDeps = {},
): Promise<ServiceResult<FeedbackReplyItem>> {
  const db = deps.prisma ?? prisma;
  const sign = deps.signImageUrl ?? defaultSignImageUrl;

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) {
    return {
      success: false,
      error: "Message is required",
      code: "INVALID_INPUT",
    };
  }

  try {
    // IDOR: only the ticket's author may reply.
    const feedback = await db.feedback.findFirst({
      where: { id: input.feedbackId, userId },
      select: { id: true },
    });
    if (!feedback) {
      return { success: false, error: "Feedback not found", code: "NOT_FOUND" };
    }

    const reply = await db.feedbackReply.create({
      data: {
        feedbackId: input.feedbackId,
        userId,
        message,
        // Same IDOR attachment guard as submitFeedback.
        images: filterOwnedImagePaths(input.images, userId),
        isAdmin: false,
      },
    });

    // Touch the parent ticket's updatedAt (bumps it in the caller's list).
    await db.feedback.update({
      where: { id: input.feedbackId },
      data: { updatedAt: new Date() },
    });

    const row = reply as unknown as Record<string, unknown>;
    const images = (row.images as string[]) ?? [];
    return {
      success: true,
      data: {
        id: row.id as string,
        message: row.message as string,
        images,
        imageUrls: await resolveImageUrls(images, sign),
        isAdmin: (row.isAdmin as boolean) ?? false,
        createdAt: row.createdAt as Date,
      },
    };
  } catch (error) {
    logger.error(
      { error, userId, feedbackId: input.feedbackId },
      "Add feedback reply service error",
    );
    return { success: false, error: "Failed to add reply" };
  }
}

/**
 * Close the caller's own feedback ticket (mark COMPLETED). Only the author can
 * close it (IDOR: `{ id, userId }`); an already-closed ticket
 * (COMPLETED / DECLINED / DUPLICATE) returns `ALREADY_CLOSED` (route → 409).
 */
export async function closeUserFeedback(
  userId: string,
  feedbackId: string,
  deps: FeedbackServiceDeps = {},
): Promise<ServiceResult<{ id: string; status: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const feedback = await db.feedback.findFirst({
      where: { id: feedbackId, userId },
      select: { id: true, status: true },
    });
    if (!feedback) {
      return { success: false, error: "Feedback not found", code: "NOT_FOUND" };
    }

    const status = (feedback as { status?: string }).status;
    if (
      status === "COMPLETED" ||
      status === "DECLINED" ||
      status === "DUPLICATE"
    ) {
      return {
        success: false,
        error: "Ticket already closed",
        code: "ALREADY_CLOSED",
      };
    }

    const updated = await db.feedback.update({
      where: { id: feedbackId },
      data: { status: "COMPLETED" },
      select: { id: true, status: true },
    });

    return {
      success: true,
      data: {
        id: (updated as { id: string }).id,
        status: (updated as { status: string }).status,
      },
    };
  } catch (error) {
    logger.error({ error, userId, feedbackId }, "Close feedback service error");
    return { success: false, error: "Failed to close feedback" };
  }
}
