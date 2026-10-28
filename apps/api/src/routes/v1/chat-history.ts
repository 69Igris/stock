/**
 * Chat-history Routes
 *
 * List / read / delete AI chat sessions. Every read + mutation is userId-scoped
 * (IDOR-safe) in chat-history.service. Thin wrappers — no business logic.
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
  listChatHistories,
  getChatHistoryById,
  deleteChatHistory,
  archiveChatHistory,
  unarchiveChatHistory,
  renameChatHistory,
} from "@usemoney/services";
import { parsePagination } from "./pagination";

const chatHistoryRoutes = new Hono<AppContext>();

/** Rename body: a trimmed 1-200 char custom title. */
const RenameSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
});

/**
 * GET /v1/chat-history
 * Paginated chat sessions (newest lastMessage first). Optional ?pagePath /
 * ?search / ?archived filters. The service slices the page and returns
 * { chats, totalCount }.
 */
chatHistoryRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const { page, limit, skip } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });
  const archived = c.req.query("archived");

  const result = await listChatHistories(userId, {
    skip,
    limit,
    pagePath: c.req.query("pagePath"),
    searchQuery: c.req.query("search"),
    ...(archived !== undefined ? { isArchived: archived === "true" } : {}),
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  return c.json(
    paginate(result.data.chats, result.data.totalCount, page, limit),
  );
});

/**
 * GET /v1/chat-history/:id
 * Full message history for a session the caller owns. getChatHistoryById scopes
 * by userId and returns null for a foreign/missing id → 404 (no cross-user leak).
 */
chatHistoryRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("id");

  const result = await getChatHistoryById(userId, chatId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  if (!result.data) {
    return c.json(error(ErrorCodes.NOT_FOUND, "Chat history not found"), 404);
  }

  return c.json(success(result.data));
});

/**
 * DELETE /v1/chat-history/:id
 * Hard-delete a session the caller owns. A foreign/missing id → 404.
 */
chatHistoryRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("id");

  const result = await deleteChatHistory(userId, chatId);
  if (!result.success) {
    // MONEY-1183 — the service ALREADY distinguishes these two outcomes; this
    // route was throwing the distinction away. `deleteChatHistory` returns
    // code "INTERNAL" from its catch (added by MONEY-1062, whose comment reads
    // "code so routes map a DB blip to 500, not 404") and an un-coded
    // not-found when its scoped deleteMany/updateMany matches nothing. Mapping
    // both to 404 told the client the chat does not exist, so it stopped
    // retrying a DB blip that would have succeeded.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success({ message: "Chat history deleted" }));
});

/**
 * PATCH /v1/chat-history/:id/archive
 * Soft-archive a session the caller owns. Mirrors archiveChatHistoryAction
 * (apps/web lib/actions/chat-history.ts:170) — archiveChatHistory(userId,
 * chatId) is an updateMany scoped by { id, userId }; count 0 (foreign/missing)
 * → 404.
 */
chatHistoryRoutes.patch("/:id/archive", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("id");

  const result = await archiveChatHistory(userId, chatId);
  if (!result.success) {
    // MONEY-1183 — the service ALREADY distinguishes these two outcomes; this
    // route was throwing the distinction away. `archiveChatHistory` returns
    // code "INTERNAL" from its catch (added by MONEY-1062, whose comment reads
    // "code so routes map a DB blip to 500, not 404") and an un-coded
    // not-found when its scoped deleteMany/updateMany matches nothing. Mapping
    // both to 404 told the client the chat does not exist, so it stopped
    // retrying a DB blip that would have succeeded.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success({ message: "Chat history archived" }));
});

/**
 * PATCH /v1/chat-history/:id/unarchive
 * Un-archive a session the caller owns. Mirrors unarchiveChatHistoryAction
 * (apps/web lib/actions/chat-history.ts:189). Foreign/missing id → 404.
 */
chatHistoryRoutes.patch("/:id/unarchive", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("id");

  const result = await unarchiveChatHistory(userId, chatId);
  if (!result.success) {
    // MONEY-1183 — the service ALREADY distinguishes these two outcomes; this
    // route was throwing the distinction away. `unarchiveChatHistory` returns
    // code "INTERNAL" from its catch (added by MONEY-1062, whose comment reads
    // "code so routes map a DB blip to 500, not 404") and an un-coded
    // not-found when its scoped deleteMany/updateMany matches nothing. Mapping
    // both to 404 told the client the chat does not exist, so it stopped
    // retrying a DB blip that would have succeeded.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success({ message: "Chat history unarchived" }));
});

/**
 * PATCH /v1/chat-history/:id
 * Rename a session the caller owns (sets the custom title the list's derived
 * `title` prefers). Mirrors renameChatHistoryAction (apps/web
 * lib/actions/chat-history.ts:227) — renameChatHistory(userId, chatId, title).
 * Foreign/missing id → 404. Registered AFTER the /:id/archive and
 * /:id/unarchive literals (single-segment PATCH — no capture conflict).
 */
chatHistoryRoutes.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("id");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(RenameSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid rename payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await renameChatHistory(userId, chatId, parsed.data.title);
  if (!result.success) {
    // MONEY-1183 — a DB failure is a 500, not a 404. Both outcomes collapsed
    // into this branch and answered 404, telling the client the row does not
    // exist so it stopped retrying a blip that would have succeeded.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success({ message: "Chat history renamed" }));
});

export default chatHistoryRoutes;
