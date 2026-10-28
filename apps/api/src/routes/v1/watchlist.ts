/**
 * Watchlist Routes
 *
 * Manage user watchlists and their items.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
  paginatedCursor,
  encodeCursor,
  decodeCursor,
} from "../../lib/response";
import {
  getWatchlists,
  createWatchlist,
  updateWatchlist,
  deleteWatchlist,
  addWatchlistItem,
  removeWatchlistItem,
  reorderWatchlistItems,
  batchAddWatchlistItems,
} from "@usemoney/services";
import { parseLimit } from "./pagination";

const watchlistRoutes = new Hono<AppContext>();

/** Hard cap on a reorder payload (a full watchlist is at most a few hundred). */
const MAX_REORDER_ITEMS = 500;
/** Hard cap on a batch-add payload (bounds the upsert transaction). */
const MAX_BATCH_ITEMS = 100;

/** Create-watchlist body: a trimmed 1-100 char name + optional ≤500 description. */
const CreateWatchlistSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().max(500).optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  type: z.enum(["STOCK", "MF"]).optional(),
});

/**
 * Update-watchlist body: every field optional (partial rename/re-color), but
 * at least ONE must be present — an empty {} would be a no-op write.
 * `description`/`color`/`icon` accept null to CLEAR the stored value
 * (UpdateWatchlistInput is nullable there; the service spreads only defined keys).
 */
const UpdateWatchlistSchema = z
  .object({
    name: z.string().trim().min(1, "Name cannot be empty").max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    color: z.string().max(64).nullable().optional(),
    icon: z.string().max(64).nullable().optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    "At least one field (name, description, color, icon) is required",
  );

/** Add-item body: a non-empty ≤30 char symbol + optional exchange. */
const AddWatchlistItemSchema = z.object({
  symbol: z.string().trim().min(1, "Symbol is required").max(30),
  exchange: z.string().optional(),
  instrumentId: z.string().optional(),
});

/** Reorder body: the watchlist's item ids in their new order (bounded). */
const ReorderItemsSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "itemIds must not be empty")
    .max(MAX_REORDER_ITEMS),
});

/** Batch-add body: 1-100 items of { symbol required, exchange? }. */
const BatchAddItemsSchema = z.object({
  items: z
    .array(
      z.object({
        symbol: z.string().trim().min(1, "Symbol is required").max(30),
        exchange: z.string().optional(),
        instrumentId: z.string().optional(),
      }),
    )
    .min(1, "items must not be empty")
    .max(MAX_BATCH_ITEMS),
});

/**
 * Map a code-less watchlist-service failure to a status. The watchlist write
 * services signal a missing/foreign watchlist with the literal error
 * "Watchlist not found" (no `code` field yet) — that is the ownership signal
 * (→ 404). A future `code` wins when present; every other refusal (e.g. a
 * rename name-conflict) stays a 400.
 */
function watchlistFailure(
  c: Context<AppContext>,
  result: { error: string; code?: string },
) {
  if (result.code === "INTERNAL") {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  if (result.code === "NOT_FOUND" || result.error === "Watchlist not found") {
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
}

/**
 * GET /v1/watchlists
 * List all watchlists with items
 */
watchlistRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const limit = parseLimit(c.req.query("limit"));
  const cursor = decodeCursor<{ id: string }>(c.req.query("cursor"));

  try {
    const result = await getWatchlists(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    // Route-level keyset (id) pagination over the user's watchlist set. The
    // service reads all of a user's watchlists (a handful), so the cursor bounds
    // the RESPONSE and gives the mobile client a stable forward-paging contract.
    // A garbage/stale cursor id (findIndex → -1) falls back to the first page.
    // NOTE: a DB-level cursor would need an additive getWatchlists({ limit,
    // cursor }) param — the watchlist service is outside this task's ownership.
    const all = result.data;
    const start = cursor ? all.findIndex((w) => w.id === cursor.id) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    const nextCursor =
      last && start + limit < all.length ? encodeCursor({ id: last.id }) : null;

    return c.json(paginatedCursor(items, nextCursor));
  } catch (err) {
    console.error("Watchlists error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch watchlists"),
      500,
    );
  }
});

/**
 * POST /v1/watchlists
 * Create a new watchlist
 */
watchlistRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(CreateWatchlistSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid watchlist",
          validated.issues,
        ),
        400,
      );
    }
    const result = await createWatchlist(userId, validated.data);
    if (!result.success) {
      // MONEY-1183 — a DB failure is a 500. It used to share this branch with
      // genuine client errors, so a failed write was reported as the caller's
      // fault and never retried. The service now tags INTERNAL; anything
      // un-coded keeps this route's previous status.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success(result.data), 201);
  } catch (err) {
    console.error("Watchlist create error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to create watchlist"),
      500,
    );
  }
});

/**
 * DELETE /v1/watchlists/:id
 * Delete a watchlist
 */
watchlistRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const watchlistId = c.req.param("id");

  try {
    const result = await deleteWatchlist(userId, watchlistId);
    if (!result.success) {
      // MONEY-1180 — a DB failure is a 500, not a 404. Both outcomes used
      // to collapse into this one branch and answer 404, which told the
      // client the row does not exist and it stopped retrying a delete
      // that would have worked. Un-coded failures keep the 404 default.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success({ message: "Watchlist deleted" }));
  } catch (err) {
    console.error("Watchlist delete error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to delete watchlist"),
      500,
    );
  }
});

/**
 * PATCH /v1/watchlists/:id
 * Rename / re-describe / re-color a watchlist the caller owns. Mirrors
 * updateWatchlistAction (apps/web lib/actions/watchlist.ts:135) —
 * updateWatchlist(userId, watchlistId, data). A foreign/missing watchlist →
 * 404; a rename name-conflict → 400.
 */
watchlistRoutes.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const watchlistId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(UpdateWatchlistSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid watchlist update",
          validated.issues,
        ),
        400,
      );
    }

    const result = await updateWatchlist(userId, watchlistId, validated.data);
    if (!result.success) {
      return watchlistFailure(c, result);
    }

    return c.json(success({ message: "Watchlist updated" }));
  } catch (err) {
    console.error("Watchlist update error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to update watchlist"),
      500,
    );
  }
});

/**
 * POST /v1/watchlists/:id/reorder
 * Persist a new item order for a watchlist the caller owns. Mirrors
 * reorderWatchlistItemsAction (apps/web lib/actions/watchlist.ts:216) —
 * reorderWatchlistItems(userId, { watchlistId, itemIds }). The service scopes
 * every child write to the verified watchlist (IDOR guard MONEY-594): a
 * foreign itemId matches zero rows and is ignored.
 */
watchlistRoutes.post("/:id/reorder", async (c) => {
  const userId = c.get("userId");
  const watchlistId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(ReorderItemsSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid reorder payload",
          validated.issues,
        ),
        400,
      );
    }

    const result = await reorderWatchlistItems(userId, {
      watchlistId,
      itemIds: validated.data.itemIds,
    });
    if (!result.success) {
      return watchlistFailure(c, result);
    }

    return c.json(success({ message: "Items reordered" }));
  } catch (err) {
    console.error("Watchlist reorder error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to reorder items"),
      500,
    );
  }
});

/**
 * POST /v1/watchlists/:id/items/batch
 * Bulk-add up to 100 symbols to a watchlist the caller owns (duplicate
 * symbol+exchange pairs upsert as no-ops). Mirrors batchAddWatchlistItemsAction
 * (apps/web lib/actions/watchlist.ts:236) — batchAddWatchlistItems(userId,
 * { watchlistId, items }); exchange defaults to NSE like the single-add route.
 */
watchlistRoutes.post("/:id/items/batch", async (c) => {
  const userId = c.get("userId");
  const watchlistId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(BatchAddItemsSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid batch items payload",
          validated.issues,
        ),
        400,
      );
    }

    const result = await batchAddWatchlistItems(userId, {
      watchlistId,
      items: validated.data.items.map((item) => ({
        symbol: item.symbol,
        exchange: item.exchange || "NSE",
        instrumentId: item.instrumentId,
      })),
    });
    if (!result.success) {
      return watchlistFailure(c, result);
    }

    return c.json(success({ addedCount: result.data.addedCount }), 201);
  } catch (err) {
    console.error("Watchlist batch add error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to add items to watchlist"),
      500,
    );
  }
});

/**
 * POST /v1/watchlists/:id/items
 * Add a symbol to a watchlist
 */
watchlistRoutes.post("/:id/items", async (c) => {
  const userId = c.get("userId");
  const watchlistId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(AddWatchlistItemSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid watchlist item",
          validated.issues,
        ),
        400,
      );
    }
    const result = await addWatchlistItem(userId, {
      watchlistId,
      symbol: validated.data.symbol,
      exchange: validated.data.exchange || "NSE",
      instrumentId: validated.data.instrumentId,
    });
    if (!result.success) {
      // A missing/foreign watchlist → 404; anything else → 400.
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success({ message: "Item added" }), 201);
  } catch (err) {
    console.error("Watchlist add item error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to add item to watchlist"),
      500,
    );
  }
});

/**
 * DELETE /v1/watchlists/:id/items/:itemId
 * Remove an item from a watchlist
 */
watchlistRoutes.delete("/:id/items/:itemId", async (c) => {
  const userId = c.get("userId");
  const itemId = c.req.param("itemId");

  try {
    const result = await removeWatchlistItem(userId, itemId);
    if (!result.success) {
      // MONEY-1180 — a DB failure is a 500, not a 404. Both outcomes used
      // to collapse into this one branch and answer 404, which told the
      // client the row does not exist and it stopped retrying a delete
      // that would have worked. Un-coded failures keep the 404 default.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success({ message: "Item removed" }));
  } catch (err) {
    console.error("Watchlist remove item error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to remove item from watchlist"),
      500,
    );
  }
});

export default watchlistRoutes;
