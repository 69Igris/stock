"use server";

import { randomUUID } from "crypto";
import { getAuthenticatedUser } from "@/lib/auth";
import prisma from "@usemoney/database";
import { generateSignedUrl } from "@/lib/storage/signed-urls";
import { uploadFile } from "@/lib/storage/gcp-client";
import {
  validateFeedbackImage,
  feedbackImagePath,
  filterOwnedImagePaths,
} from "@/lib/feedback/attachments";
import {
  CreateFeedbackSchema,
  FeedbackFilterSchema,
  AddFeedbackReplySchema,
  type CreateFeedbackInput,
  type FeedbackFilterInput,
  type AddFeedbackReplyInput,
  type ActionResponse,
} from "@usemoney/validation";

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

export interface FeedbackReplyItem {
  id: string;
  message: string;
  images: string[];
  imageUrls: string[];
  isAdmin: boolean;
  createdAt: Date;
}

export interface FeedbackThread {
  feedback: FeedbackItem & { imageUrls: string[] };
  replies: FeedbackReplyItem[];
}

export interface FeedbackCounts {
  total: number;
  open: number;
  inProgress: number;
  planned: number;
  completed: number;
}

// Plan-based monthly submission limits
const FEEDBACK_LIMITS: Record<string, number> = {
  FREE: 3,
  PRO: 10,
  PREMIUM: -1, // unlimited
  ULTIMATE: -1,
};

/**
 * Generate signed URLs for an array of GCS paths.
 */
async function resolveImageUrls(paths: string[]): Promise<string[]> {
  if (!paths || paths.length === 0) return [];
  const urls = await Promise.all(
    paths.map((p) => generateSignedUrl(p, { expiresIn: 3600 }).catch(() => ""))
  );
  return urls.filter(Boolean);
}

/**
 * Upload one feedback attachment (screenshot) to GCS and return its path
 * (stored on the ticket) + a short-lived preview URL (composer thumbnail).
 *
 * Graceful by contract: ANY storage failure (bucket unconfigured in local
 * dev, GCS outage, oversized/unsupported file) returns a friendly error and
 * the composer sends the ticket text-only — attachments never block a
 * submission.
 */
export async function uploadFeedbackImageAction(
  formData: FormData
): Promise<ActionResponse<{ path: string; previewUrl: string }>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { success: false, error: "No file provided" };
  }
  const check = validateFeedbackImage({ type: file.type, size: file.size });
  if (!check.ok) return { success: false, error: check.error };

  try {
    const path = feedbackImagePath(user.userId, check.ext, randomUUID());
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadFile(path, buffer, file.type);
    const previewUrl = await generateSignedUrl(path, { expiresIn: 3600 });
    return { success: true, data: { path, previewUrl } };
  } catch (err) {
    console.error("[feedback] attachment upload failed:", err);
    return {
      success: false,
      error:
        "Attachment upload is unavailable right now — you can still send without it.",
    };
  }
}

/**
 * Submit new feedback.
 * Plan-based limits: FREE=3/month, PRO=10/month, PREMIUM/ULTIMATE=unlimited.
 * Premium users get an email confirmation with reply-to set to user's email.
 */
export async function submitFeedbackAction(
  data: CreateFeedbackInput
): Promise<ActionResponse<FeedbackItem>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const parsed = CreateFeedbackSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.errors[0]?.message || "Invalid input",
    };
  }

  // Check plan-based limits
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.userId },
    select: { planId: true },
  });
  const planId = subscription?.planId || "FREE";
  const limit = FEEDBACK_LIMITS[planId] ?? 3;

  if (limit !== -1) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const thisMonthCount = await prisma.feedback.count({
      where: {
        userId: user.userId,
        createdAt: { gte: startOfMonth },
      },
    });

    if (thisMonthCount >= limit) {
      return {
        success: false,
        error: `You've reached your monthly feedback limit (${limit}). Upgrade your plan for more.`,
      };
    }
  }

  // Get user info for metadata and email
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { email: true, name: true },
  });

  const feedback = await prisma.feedback.create({
    data: {
      userId: user.userId,
      type: parsed.data.type,
      title: parsed.data.title,
      description: parsed.data.description,
      // IDOR guard: the thread view mints signed URLs for stored paths, so
      // only the caller's own feedback/{userId}/ uploads may persist.
      images: filterOwnedImagePaths(parsed.data.images, user.userId),
      page: parsed.data.page,
      metadata: {
        planId,
        userEmail: dbUser?.email,
        userName: dbUser?.name,
      },
    },
  });

  // Send email confirmation for premium users (fire-and-forget)
  if (planId === "PREMIUM" || planId === "ULTIMATE") {
    sendFeedbackConfirmationEmail(
      dbUser?.email || "",
      dbUser?.name || "User",
      feedback.title,
      feedback.type,
      feedback.description
    ).catch(() => {});
  }

  return {
    success: true,
    data: { ...feedback, replyCount: 0 },
  };
}

/**
 * Get current user's own feedback submissions only.
 * Includes reply count for each item.
 */
export async function getUserFeedbackAction(
  filters?: FeedbackFilterInput
): Promise<ActionResponse<{ items: FeedbackItem[]; total: number }>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const parsed = FeedbackFilterSchema.safeParse(filters || {});
  if (!parsed.success) {
    return { success: false, error: "Invalid filters" };
  }

  const { status, type, skip, limit } = parsed.data;

  const where: Record<string, unknown> = { userId: user.userId };
  if (status) where.status = status;
  if (type) where.type = type;

  const [rawItems, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        _count: { select: { replies: true } },
      },
    }),
    prisma.feedback.count({ where }),
  ]);

  const items: FeedbackItem[] = rawItems.map((item) => ({
    id: item.id,
    userId: item.userId,
    type: item.type,
    title: item.title,
    description: item.description,
    images: item.images,
    status: item.status,
    priority: item.priority,
    page: item.page,
    adminNote: item.adminNote,
    replyCount: item._count.replies,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  return { success: true, data: { items, total } };
}

/**
 * Get a feedback thread - the feedback item + all replies with signed image URLs.
 */
export async function getFeedbackThreadAction(
  feedbackId: string
): Promise<ActionResponse<FeedbackThread>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const feedback = await prisma.feedback.findFirst({
    where: { id: feedbackId, userId: user.userId },
    include: {
      replies: { orderBy: { createdAt: "asc" } },
      _count: { select: { replies: true } },
    },
  });

  if (!feedback) {
    return { success: false, error: "Feedback not found" };
  }

  const feedbackImageUrls = await resolveImageUrls(feedback.images);

  const replies: FeedbackReplyItem[] = await Promise.all(
    feedback.replies.map(async (reply) => ({
      id: reply.id,
      message: reply.message,
      images: reply.images,
      imageUrls: await resolveImageUrls(reply.images),
      isAdmin: reply.isAdmin,
      createdAt: reply.createdAt,
    }))
  );

  return {
    success: true,
    data: {
      feedback: {
        id: feedback.id,
        userId: feedback.userId,
        type: feedback.type,
        title: feedback.title,
        description: feedback.description,
        images: feedback.images,
        imageUrls: feedbackImageUrls,
        status: feedback.status,
        priority: feedback.priority,
        page: feedback.page,
        adminNote: feedback.adminNote,
        replyCount: feedback._count.replies,
        createdAt: feedback.createdAt,
        updatedAt: feedback.updatedAt,
      },
      replies,
    },
  };
}

/**
 * Add a reply to a feedback thread (user side).
 */
export async function addFeedbackReplyAction(
  data: AddFeedbackReplyInput
): Promise<ActionResponse<FeedbackReplyItem>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const parsed = AddFeedbackReplySchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.errors[0]?.message || "Invalid input",
    };
  }

  // Verify the feedback belongs to the current user
  const feedback = await prisma.feedback.findFirst({
    where: { id: parsed.data.feedbackId, userId: user.userId },
    select: { id: true },
  });

  if (!feedback) {
    return { success: false, error: "Feedback not found" };
  }

  const reply = await prisma.feedbackReply.create({
    data: {
      feedbackId: parsed.data.feedbackId,
      userId: user.userId,
      message: parsed.data.message,
      // Same IDOR guard as submitFeedbackAction.
      images: filterOwnedImagePaths(parsed.data.images, user.userId),
      isAdmin: false,
    },
  });

  // Touch the feedback's updatedAt
  await prisma.feedback.update({
    where: { id: parsed.data.feedbackId },
    data: { updatedAt: new Date() },
  });

  const imageUrls = await resolveImageUrls(reply.images);

  return {
    success: true,
    data: {
      id: reply.id,
      message: reply.message,
      images: reply.images,
      imageUrls,
      isAdmin: reply.isAdmin,
      createdAt: reply.createdAt,
    },
  };
}

/**
 * Close a user's own feedback ticket (mark it as COMPLETED). The user
 * decides when their ask is satisfied - admins can still reopen via the
 * admin panel. Only the ticket's author can close it.
 */
export async function closeUserFeedbackAction(
  feedbackId: string
): Promise<ActionResponse<{ id: string; status: string }>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const feedback = await prisma.feedback.findFirst({
    where: { id: feedbackId, userId: user.userId },
    select: { id: true, status: true },
  });

  if (!feedback) {
    return { success: false, error: "Feedback not found" };
  }

  if (
    feedback.status === "COMPLETED" ||
    feedback.status === "DECLINED" ||
    feedback.status === "DUPLICATE"
  ) {
    return { success: false, error: "Ticket already closed" };
  }

  const updated = await prisma.feedback.update({
    where: { id: feedbackId },
    data: { status: "COMPLETED" },
    select: { id: true, status: true },
  });

  return { success: true, data: updated };
}

/**
 * Get feedback counts by status for the current user.
 */
export async function getFeedbackCountsAction(): Promise<
  ActionResponse<FeedbackCounts>
> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const baseWhere = { userId: user.userId };

  const [total, open, inProgress, planned, completed] = await Promise.all([
    prisma.feedback.count({ where: baseWhere }),
    prisma.feedback.count({ where: { ...baseWhere, status: "OPEN" } }),
    prisma.feedback.count({
      where: { ...baseWhere, status: "IN_PROGRESS" },
    }),
    prisma.feedback.count({ where: { ...baseWhere, status: "PLANNED" } }),
    prisma.feedback.count({
      where: { ...baseWhere, status: "COMPLETED" },
    }),
  ]);

  return {
    success: true,
    data: { total, open, inProgress, planned, completed },
  };
}

/**
 * Send a confirmation email to premium users when they submit feedback.
 */
async function sendFeedbackConfirmationEmail(
  userEmail: string,
  userName: string,
  feedbackTitle: string,
  feedbackType: string,
  feedbackDescription: string
) {
  if (!userEmail) return;

  try {
    const { sendEmail } = await import("@usemoney/email");
    const { FeedbackReceivedEmail } =
      await import("@usemoney/email/templates/feedback-received");
    const React = await import("react");

    const typeLabels: Record<string, string> = {
      BUG: "Bug Report",
      FEATURE_REQUEST: "Feature Request",
      IMPROVEMENT: "Improvement Suggestion",
      QUESTION: "Question",
      OTHER: "Feedback",
    };

    // MONEY-878: route through the shared sendEmail() helper (EmailLog + retry +
    // consistent From) instead of calling the Resend client directly.
    await sendEmail({
      to: userEmail,
      replyTo: userEmail,
      subject: `[UseMoney] ${typeLabels[feedbackType] || "Feedback"} received: ${feedbackTitle}`,
      template: "feedback-received",
      react: React.createElement(FeedbackReceivedEmail, {
        name: userName,
        feedbackTitle,
        feedbackType,
        feedbackDescription,
      }),
    });
  } catch (err) {
    console.error("[feedback] Failed to send confirmation email:", err);
  }
}
