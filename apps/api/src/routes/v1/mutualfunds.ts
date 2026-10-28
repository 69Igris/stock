/**
 * Mutual Funds Routes
 *
 * Endpoints for user mutual fund holdings.
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
  getMutualFunds,
  createMutualFund,
  deleteMutualFund,
} from "@usemoney/services";
// The SAME schema the web action parses (apps/web lib/actions/mutualfunds.ts:109
// does MutualFundFormSchema.parse) — one source of truth for the required
// fields (schemeName, positive-finite units/averageNav) and the defaults
// (category "Equity", brokerName "manual", sipActive false).
import { MutualFundFormSchema } from "@usemoney/validation/mutual-fund";
import { parseListPage, encodeIdCursor } from "./pagination";

const mutualfundsRoutes = new Hono<AppContext>();

// The service accepts MutualFundFilters { search?, category? } (see
// mutualfunds.service.ts:67 / mutualfunds-logic.ts#buildMutualFundWhere) and the
// web action forwards both (apps/web/lib/actions/mutualfunds.ts). Bounded strings
// so a client can't send an unbounded regex/search term; empty → omitted → the
// service treats it as "no filter" (and category "all" as "no category filter").
const MfListFiltersSchema = z.object({
  search: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(64).optional(),
});

/**
 * GET /v1/mutualfunds?search=&category=
 * List all mutual fund holdings. `?limit` opts into cursor pagination
 * ({ items, summary, nextCursor }); without it the full list + summary is
 * returned unchanged. `?search=` (case-insensitive schemeName match) and
 * `?category=` (exact; `all` = no filter) narrow the list — both userId-scoped
 * in the service's where-clause (IDOR-safe).
 */
mutualfundsRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    // D4: forward search/category filters (validated, bounded). Only PRESENT,
    // non-empty params are included so an absent-filter request yields exactly
    // `{}` → byte-identical to the previous unfiltered `getMutualFunds` call.
    const rawFilters: Record<string, string> = {};
    const searchParam = c.req.query("search");
    const categoryParam = c.req.query("category");
    if (searchParam) rawFilters.search = searchParam;
    if (categoryParam) rawFilters.category = categoryParam;
    const filtersParsed = zodParse(MfListFiltersSchema, rawFilters);
    if (!filtersParsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid mutual fund filters",
          filtersParsed.issues,
        ),
        400,
      );
    }

    const page = parseListPage(c.req.query("limit"), c.req.query("cursor"));
    const result = await getMutualFunds(userId, filtersParsed.data, page);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    if (!page) {
      return c.json(success(result.data));
    }
    const { funds, summary, nextCursorId } = result.data;
    return c.json(
      success({
        items: funds,
        summary,
        nextCursor: encodeIdCursor(nextCursorId),
      }),
    );
  } catch (err) {
    console.error("Mutual funds error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch mutual funds"),
      500,
    );
  }
});

/**
 * POST /v1/mutualfunds
 * Add a manual mutual-fund holding. Mirrors createMutualFundAction (apps/web
 * lib/actions/mutualfunds.ts:99) — the body is validated with the identical
 * MutualFundFormSchema, then createMutualFund(userId, validated). The service
 * finite-guards the derived invested/current/gain and only fails on a DB error
 * (code-less catch) → 500.
 */
mutualfundsRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(MutualFundFormSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid mutual fund payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await createMutualFund(userId, parsed.data);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data), 201);
});

/**
 * DELETE /v1/mutualfunds/:id
 * Delete a MANUAL mutual-fund holding the caller owns. Mirrors
 * deleteMutualFundAction — deleteMutualFund(userId, fundId). A foreign/missing
 * fund → 404 (the service's "Mutual fund not found…" legs); the broker-synced
 * refusal ("Cannot delete broker-synced mutual funds…") → 400.
 */
mutualfundsRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const fundId = c.req.param("id");

  const result = await deleteMutualFund(userId, fundId);
  if (!result.success) {
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    // The service signals ownership/existence with the literal
    // "Mutual fund not found" / "… not found or already deleted" (no code yet).
    if (
      result.code === "NOT_FOUND" ||
      result.error.startsWith("Mutual fund not found")
    ) {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
  }

  return c.json(success({ message: "Mutual fund deleted" }));
});

export default mutualfundsRoutes;
