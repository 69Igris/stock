/**
 * Saved Screens Routes (MONEY-1062 P4c — discovery-power parity)
 *
 * User-scoped CRUD for named screener filter bundles. Thin wrappers over
 * @usemoney/services saved-screens.service — the faithful ports of the
 * apps/web actions (lib/actions/saved-screens.ts:56-274):
 *
 *   GET    /v1/saved-screens?mode=   ← listSavedScreensAction
 *   POST   /v1/saved-screens         ← saveScreenAction (upsert on (mode,name))
 *   GET    /v1/saved-screens/:id     ← loadSavedScreenAction
 *   PATCH  /v1/saved-screens/:id     ← renameSavedScreenAction
 *   DELETE /v1/saved-screens/:id     ← deleteSavedScreenAction
 *
 * The zod input schemas mirror apps/web/lib/actions/saved-screens-logic.ts
 * (SaveSchema / RenameSchema) exactly: name trimmed 1..60, mode enum,
 * filters = free-form record (the screener modes have three different filter
 * shapes; the loader casts on read), query ≤ 200.
 *
 * SECURITY (IDOR): every service call is scoped to the caller's Mongo userId;
 * a foreign id resolves as not-found (no cross-user oracle). A rename that
 * collides with another same-mode screen → 409 CONFLICT.
 *
 * DIVERGENCE (documented): the web list/load/rename/delete actions return
 * empty-list / soft errors for an UNAUTHENTICATED caller — here the /v1
 * middleware already guarantees auth, so those branches don't exist.
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
} from "../../lib/response";
import {
  saveScreen,
  listSavedScreens,
  loadSavedScreen,
  renameSavedScreen,
  deleteSavedScreen,
} from "@usemoney/services";

const savedScreensRoutes = new Hono<AppContext>();

// Mirrors apps/web/lib/actions/saved-screens-logic.ts (SaveSchema/RenameSchema).
const ModeSchema = z.enum(["stocks", "mf", "etf"]);
const NameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(60, "Name too long (max 60 chars)");

// `filters` stays a free-form record like the web schema; the record itself is
// bounded (≤ 40 keys) so a client can't persist an unbounded JSON blob.
const MAX_FILTER_KEYS = 40;
const FiltersSchema = z
  .record(z.string(), z.unknown())
  .refine((f) => Object.keys(f).length <= MAX_FILTER_KEYS, {
    message: `At most ${MAX_FILTER_KEYS} filter keys allowed`,
  });

const SaveSchema = z.object({
  name: NameSchema,
  mode: ModeSchema,
  filters: FiltersSchema,
  query: z.string().max(200).optional(),
});

const RenameSchema = z.object({
  name: NameSchema,
});

/**
 * Code-aware status for a screen read/mutate failure (C3#4). The old blanket
 * `!success → 404` swallowed the service's DB-error catches ("Failed to
 * load/rename/delete screen") as 404s. Mapping:
 *   - code NOT_FOUND → 404; code INTERNAL (or any other code) → 500;
 *   - code-less → 404 ONLY for the service's known miss string
 *     ("Screen not found", saved-screens.service.ts:167/:202/:244), else 500.
 * Degrades sensibly whether or not the service emits codes (they're being
 * added in parallel). CONFLICT is handled by the caller BEFORE this mapping.
 */
function screenFailureStatus(result: {
  code?: string;
  error: string;
}): 404 | 500 {
  if (result.code === "NOT_FOUND") return 404;
  if (result.code === undefined && result.error === "Screen not found")
    return 404;
  return 500;
}

/** Envelope error code matching a {@link screenFailureStatus} status. */
function screenFailureCode(status: 404 | 500): string {
  return status === 404 ? ErrorCodes.NOT_FOUND : ErrorCodes.INTERNAL_ERROR;
}

/** GET /v1/saved-screens?mode= — the caller's screens (updated-desc, ≤100). */
savedScreensRoutes.get("/", async (c) => {
  const modeRaw = c.req.query("mode");
  const parsed = zodParse(ModeSchema.optional(), modeRaw ?? undefined);
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid mode", parsed.issues),
      400,
    );
  }

  const result = await listSavedScreens(c.get("userId"), parsed.data);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/** POST /v1/saved-screens — save (or overwrite the same (mode,name)) → 201. */
savedScreensRoutes.post("/", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(SaveSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid saved-screen payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await saveScreen(c.get("userId"), parsed.data);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data), 201);
});

/**
 * GET /v1/saved-screens/:id — load one screen incl. filters. Foreign/missing
 * id → 404; a DB failure → 500 (code-aware, see screenFailureStatus).
 */
savedScreensRoutes.get("/:id", async (c) => {
  const result = await loadSavedScreen(c.get("userId"), c.req.param("id"));
  if (!result.success) {
    const status = screenFailureStatus(result);
    return c.json(error(screenFailureCode(status), result.error), status);
  }
  return c.json(success(result.data));
});

/**
 * PATCH /v1/saved-screens/:id — rename. Collision → 409; foreign/missing id →
 * 404; a DB failure → 500 (code-aware, see screenFailureStatus).
 */
savedScreensRoutes.patch("/:id", async (c) => {
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

  const result = await renameSavedScreen(c.get("userId"), {
    id: c.req.param("id"),
    name: parsed.data.name,
  });
  if (!result.success) {
    if (result.code === "CONFLICT") {
      return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
    }
    const status = screenFailureStatus(result);
    return c.json(error(screenFailureCode(status), result.error), status);
  }
  return c.json(success(result.data));
});

/**
 * DELETE /v1/saved-screens/:id — delete own screen. Foreign/missing id →
 * 404; a DB failure → 500 (code-aware, see screenFailureStatus).
 */
savedScreensRoutes.delete("/:id", async (c) => {
  const result = await deleteSavedScreen(c.get("userId"), c.req.param("id"));
  if (!result.success) {
    const status = screenFailureStatus(result);
    return c.json(error(screenFailureCode(status), result.error), status);
  }
  return c.json(success(result.data));
});

export default savedScreensRoutes;
