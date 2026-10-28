import { z } from "zod";

// ============================================
// Feedback Validation Schemas
// ============================================

export const FeedbackTypeEnum = z.enum([
  "BUG",
  "FEATURE_REQUEST",
  "IMPROVEMENT",
  "QUESTION",
  "OTHER",
]);

export const FeedbackStatusEnum = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "PLANNED",
  "COMPLETED",
  "DECLINED",
  "DUPLICATE",
]);

export const CreateFeedbackSchema = z.object({
  type: FeedbackTypeEnum,
  title: z
    .string()
    .min(5, "Title must be at least 5 characters")
    .max(200, "Title must be at most 200 characters"),
  description: z
    .string()
    .min(10, "Description must be at least 10 characters")
    .max(2000, "Description must be at most 2000 characters"),
  page: z.string().optional(),
  images: z.array(z.string()).max(5, "Maximum 5 images allowed").optional(),
});

export type CreateFeedbackInput = z.input<typeof CreateFeedbackSchema>;
export type CreateFeedbackData = z.output<typeof CreateFeedbackSchema>;

export const FeedbackFilterSchema = z.object({
  status: FeedbackStatusEnum.optional(),
  type: FeedbackTypeEnum.optional(),
  skip: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(10),
});

export type FeedbackFilterInput = z.input<typeof FeedbackFilterSchema>;
export type FeedbackFilterData = z.output<typeof FeedbackFilterSchema>;

export const AddFeedbackReplySchema = z.object({
  feedbackId: z.string().min(1, "Feedback ID is required"),
  message: z
    .string()
    .min(1, "Message is required")
    .max(2000, "Message must be at most 2000 characters"),
  images: z.array(z.string()).max(5, "Maximum 5 images allowed").optional(),
});

export type AddFeedbackReplyInput = z.input<typeof AddFeedbackReplySchema>;
export type AddFeedbackReplyData = z.output<typeof AddFeedbackReplySchema>;

// ============================================
// Per-result feedback (👍/👎 on AI answers) — MONEY-587
// ============================================

export const ResultFeedbackSurfaceEnum = z.enum(["CHAT", "RESEARCH", "ROAST"]);
export const ResultFeedbackRatingEnum = z.enum(["UP", "DOWN"]);

/**
 * One thumbs rating per AI result, with an optional message (ChatGPT-style).
 * `refId` ties it to the thing being rated: a chat message id, a research
 * sessionId, or a roast sessionId. The model/tier/intent/symbols snapshot is
 * captured so the self-improving loop can slice 👎-rate by what produced it.
 */
export const SubmitResultFeedbackSchema = z.object({
  surface: ResultFeedbackSurfaceEnum,
  refId: z.string().min(1, "refId is required").max(120),
  chatId: z.string().max(120).optional(),
  rating: ResultFeedbackRatingEnum,
  comment: z
    .string()
    .max(1000, "Keep it under 1000 characters")
    .optional()
    // collapse empty/whitespace to undefined so we don't store blanks
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  reasons: z.array(z.string().max(60)).max(8).optional(),
  model: z.string().max(80).optional(),
  tier: z.string().max(16).optional(),
  intent: z.string().max(64).optional(),
  symbols: z.array(z.string().max(24)).max(24).optional(),
  // MONEY-800 (B6): the explanation-style bandit arm that produced this answer,
  // echoed back by the client so the thumbs outcome can be attributed to the
  // arm (👍 → success, 👎 → failure). Style only — never advice.
  // Charset-bounded (MONEY-779 scan): a bandit arm id is an opaque token, so
  // restrict it so a forged value can't carry path/markup/control chars into the
  // win-rate map (the bandit ALSO uses a null-prototype accumulator as the real
  // prototype-pollution guard — this is defense in depth + format hygiene).
  variantId: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "invalid variantId")
    .optional(),
  // Optional free-form blob for the self-improving loop (persisted as
  // ResultFeedback.metadata). Bounded so a forged payload can't bloat the row.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SubmitResultFeedbackInput = z.input<
  typeof SubmitResultFeedbackSchema
>;
export type SubmitResultFeedbackData = z.output<
  typeof SubmitResultFeedbackSchema
>;
