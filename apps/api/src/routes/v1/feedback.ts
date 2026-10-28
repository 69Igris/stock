/**
 * Feedback Routes (MONEY-402 mobile-parity)
 *
 * Submit a feedback ticket + list the caller's own tickets. Thin wrappers over
 * feedback.service, which enforces the plan-based monthly quota and the IDOR
 * attachment guard (only the caller's own `feedback/{userId}/` paths persist).
 *
 * DEFERRED: the attachment UPLOAD path (GCS signed-URL) is not surfaced — mobile
 * uploads via a signed-URL flow (like documents) and passes the resulting paths
 * to submit, which re-applies the ownership filter (see feedback.service note).
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
  paginate,
} from "../../lib/response";
import {
  submitFeedback,
  getUserFeedback,
  getFeedbackThread,
  addFeedbackReply,
  closeUserFeedback,
} from "@usemoney/services";
import { parsePagination } from "./pagination";

const feedbackRoutes = new Hono<AppContext>();

// Mirrors packages/services/src/feedback-logic.ts FEEDBACK_TYPES /
// FEEDBACK_STATUSES (which mirror the Prisma enums). LOCAL consts, not a
// barrel value-import: @usemoney/services exposes no feedback-logic subpath,
// and the HTTP contract suites stub the services barrel with a
// functions-only Proxy, so a value import would not survive the test seam.
// MUST stay in lockstep with feedback-logic.ts (C3#12) — the service's
// silent-drop of unknown filters remains as defence in depth behind this
// route-level 400.
const FEEDBACK_TYPE_VALUES = [
  "BUG",
  "FEATURE_REQUEST",
  "IMPROVEMENT",
  "QUESTION",
  "OTHER",
] as const;
const FEEDBACK_STATUS_VALUES = [
  "OPEN",
  "IN_PROGRESS",
  "PLANNED",
  "COMPLETED",
  "DECLINED",
  "DUPLICATE",
] as const;

const SubmitSchema = z.object({
  type: z.enum(FEEDBACK_TYPE_VALUES),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  page: z.string().max(512).optional(),
  images: z.array(z.string().max(256)).max(3).optional(),
});

// List filters (?status / ?type) — validated against the enum sets → 400 on
// an unknown value (aligns the web contract; previously an unknown filter was
// silently dropped by the service and returned an unfiltered page 200).
const ListFiltersSchema = z.object({
  status: z.enum(FEEDBACK_STATUS_VALUES).optional(),
  type: z.enum(FEEDBACK_TYPE_VALUES).optional(),
});

// Reply payload — mirrors @usemoney/validation AddFeedbackReplySchema bounds
// (message ≤2000, ≤5 images). The service re-applies the IDOR attachment filter
// (own `feedback/{userId}/` prefix, ≤3 persisted).
const ReplySchema = z.object({
  message: z.string().min(1).max(2000),
  images: z.array(z.string().max(256)).max(5).optional(),
});

/** POST /v1/feedback — submit a ticket (quota → 429, invalid → 400). */
feedbackRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(SubmitSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid feedback payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await submitFeedback(userId, parsed.data);
  if (!result.success) {
    if (result.code === "QUOTA_EXCEEDED") {
      return c.json(error(ErrorCodes.RATE_LIMIT_EXCEEDED, result.error), 429);
    }
    if (result.code === "INVALID_INPUT") {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data), 201);
});

/**
 * GET /v1/feedback — the caller's own tickets (paginated). ?status / ?type
 * must be members of the enum sets → 400 on garbage (service silent-drop
 * stays as defence).
 */
feedbackRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  // `|| undefined` keeps `?status=` (empty) meaning "no filter" — only a
  // present, non-empty, non-member value 400s.
  const filters = zodParse(ListFiltersSchema, {
    status: c.req.query("status") || undefined,
    type: c.req.query("type") || undefined,
  });
  if (!filters.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid feedback filters",
        filters.issues,
      ),
      400,
    );
  }
  const { page, limit, skip } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await getUserFeedback(userId, {
    status: filters.data.status,
    type: filters.data.type,
    skip,
    limit,
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(paginate(result.data.items, result.data.total, page, limit));
});

/**
 * GET /v1/feedback/:id/thread (MONEY-1062 P4e)
 * The caller's own ticket + all replies, each with short-lived signed image
 * URLs. IDOR-scoped in the service (`{ id, userId }`) → a non-owned id is a 404.
 */
feedbackRoutes.get("/:id/thread", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const result = await getFeedbackThread(userId, id);
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/feedback/:id/replies (MONEY-1062 P4e)
 * Add a reply to the caller's own ticket. Reply attachments are IDOR-filtered
 * (own `feedback/{userId}/` paths only) in the service. Non-owned ticket → 404.
 */
feedbackRoutes.post("/:id/replies", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(ReplySchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid reply payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await addFeedbackReply(userId, {
    feedbackId: id,
    message: parsed.data.message,
    images: parsed.data.images,
  });
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    if (result.code === "INVALID_INPUT") {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data), 201);
});

/**
 * POST /v1/feedback/:id/close (MONEY-1062 P4e)
 * Close the caller's own ticket (mark COMPLETED). Only the author may close it
 * (404 for non-owned); an already-closed ticket → 409.
 */
feedbackRoutes.post("/:id/close", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const result = await closeUserFeedback(userId, id);
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    if (result.code === "ALREADY_CLOSED") {
      return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

export default feedbackRoutes;
