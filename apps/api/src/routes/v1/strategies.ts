/**
 * Strategies Routes (MONEY-1062 P4c — discovery-power parity)
 *
 * Thin Hono wrappers over @usemoney/services strategies.service — the faithful
 * ports of the apps/web strategy actions:
 *
 *   PRESETS (apps/web lib/actions/strategies.ts)
 *     GET  /v1/strategies/presets     ← getStrategyPresetsAction    (:93)
 *     GET  /v1/strategies/categories  ← getStrategyCategoriesAction (:124)
 *   CUSTOM CRUD + RUN (apps/web lib/actions/custom-strategy.ts)
 *     GET    /v1/strategies                    ← listStrategiesAction (:54)
 *     POST   /v1/strategies                    ← createStrategyAction (:127)
 *     PATCH  /v1/strategies/:id                ← updateStrategyAction (:183)
 *     DELETE /v1/strategies/:id                ← deleteStrategyAction (:234)
 *     POST   /v1/strategies/:id/clone          ← cloneBuiltInAction   (:264)
 *     POST   /v1/strategies/:id/run            ← runStrategyAction    (:310) → 202
 *     GET    /v1/strategies/scans/history      ← getScanHistoryAction (:464)
 *     GET    /v1/strategies/scans/:scanId/status ← getScanStatusAction (:388)
 *     GET    /v1/strategies/scans/:scanId/result ← getScanResultAction (:421)
 *
 * ASYNC (G3): POST /:id/run resolves the strategy as the GATE inside the
 * service (built-in registry / ownership-scoped custom row); a failed gate
 * returns 404 BEFORE any ScanResult create or Pub/Sub publish. Success → 202
 * with { scanId, status: "PENDING" } — scanId is the poll handle for
 * /scans/:scanId/status → /result (the web action's exact run shape).
 *
 * SCOPING: presets + categories are static registry data (global, like the
 * web presets action, which has no auth). Everything else is userId-scoped;
 * foreign ids resolve as 404 (no cross-user oracle).
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
  getStrategyPresets,
  getStrategyCategoriesInfo,
  listStrategies,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  cloneBuiltIn,
  runStrategyScan,
  getScanStatus,
  getScanResult,
  getScanHistory,
  type StrategyCategory,
} from "@usemoney/services";

const strategiesRoutes = new Hono<AppContext>();

const MAX_CATEGORY_LEN = 32;
const MAX_SEARCH_LEN = 64;
const MAX_NAME_LEN = 80;
const MAX_DESCRIPTION_LEN = 500;
const MAX_FILTERS = 50;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 32;
const MAX_CHARTINK_LEN = 2000;

const PresetsQuerySchema = z.object({
  category: z.string().min(1).max(MAX_CATEGORY_LEN).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const ListQuerySchema = z.object({
  category: z.string().min(1).max(MAX_CATEGORY_LEN).optional(),
  search: z.string().min(1).max(MAX_SEARCH_LEN).optional(),
});

const CreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Strategy name must be at least 2 characters")
    .max(MAX_NAME_LEN),
  description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
  filters: z
    .array(z.unknown())
    .min(1, "At least one filter is required")
    .max(MAX_FILTERS),
  logic: z.string().min(1).max(8).optional(),
  scanType: z.string().min(1).max(16).default("fundamental"),
  chartinkQuery: z.string().max(MAX_CHARTINK_LEN).optional(),
  category: z.string().max(MAX_CATEGORY_LEN).optional(),
  tags: z.array(z.string().min(1).max(MAX_TAG_LEN)).max(MAX_TAGS).optional(),
});

const UpdateSchema = z.object({
  name: z.string().trim().min(2).max(MAX_NAME_LEN).optional(),
  description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
  filters: z.array(z.unknown()).min(1).max(MAX_FILTERS).optional(),
  logic: z.string().min(1).max(8).optional(),
  scanType: z.string().min(1).max(16).optional(),
  chartinkQuery: z.string().max(MAX_CHARTINK_LEN).optional(),
  category: z.string().max(MAX_CATEGORY_LEN).optional(),
  tags: z.array(z.string().min(1).max(MAX_TAG_LEN)).max(MAX_TAGS).optional(),
});

const RunSchema = z.object({
  isBuiltIn: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const CloneSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
});

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Optional JSON body: absent/empty → {}; present-but-malformed → null. */
async function optionalJson(c: {
  req: { text: () => Promise<string> };
}): Promise<unknown | null> {
  const rawText = await c.req.text();
  if (rawText.trim().length === 0) return {};
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

/**
 * Code-aware status for a scan read failure (C3#4). The old blanket
 * `!success → 404` swallowed getScanStatus/getScanResult DB-error catches
 * ("Failed to get scan status/result: …") as 404s. Mapping:
 *   - code NOT_FOUND → 404; code INTERNAL (or any other code) → 500;
 *   - code-less → 404 ONLY for the service's known miss string
 *     ("Scan not found", strategies.service.ts:558/:590), else 500.
 * Degrades sensibly whether or not the service emits codes (they're being
 * added in parallel).
 */
function scanReadFailureStatus(result: {
  code?: string;
  error: string;
}): 404 | 500 {
  if (result.code === "NOT_FOUND") return 404;
  if (result.code === undefined && result.error === "Scan not found")
    return 404;
  return 500;
}

/**
 * GET /v1/strategies/presets?category=&limit=
 * Built-in strategy cards (stats-first sort; stats null until backtests land).
 */
strategiesRoutes.get("/presets", async (c) => {
  const parsed = zodParse(PresetsQuerySchema, {
    category: c.req.query("category") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
  });
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid presets query",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await getStrategyPresets({
    category: parsed.data.category as StrategyCategory | undefined,
    limit: parsed.data.limit,
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/** GET /v1/strategies/categories — category buckets with counts ("All" first). */
strategiesRoutes.get("/categories", async (c) => {
  const result = await getStrategyCategoriesInfo();
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/strategies/scans/history?limit=
 * The caller's recent scan runs (newest first).
 */
strategiesRoutes.get("/scans/history", async (c) => {
  const parsed = zodParse(HistoryQuerySchema, {
    limit: c.req.query("limit") ?? undefined,
  });
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid history query",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await getScanHistory(c.get("userId"), {
    limit: parsed.data.limit,
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/strategies/scans/:scanId/status — poll a run. Foreign/missing id →
 * 404; a DB failure → 500 (code-aware, see scanReadFailureStatus).
 */
strategiesRoutes.get("/scans/:scanId/status", async (c) => {
  const result = await getScanStatus(c.get("userId"), c.req.param("scanId"));
  if (!result.success) {
    const status = scanReadFailureStatus(result);
    return c.json(
      error(
        status === 404 ? ErrorCodes.NOT_FOUND : ErrorCodes.INTERNAL_ERROR,
        result.error,
      ),
      status,
    );
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/strategies/scans/:scanId/result — fetch a run's rows. Foreign/
 * missing id → 404; a DB failure → 500 (code-aware, see scanReadFailureStatus).
 */
strategiesRoutes.get("/scans/:scanId/result", async (c) => {
  const result = await getScanResult(c.get("userId"), c.req.param("scanId"));
  if (!result.success) {
    const status = scanReadFailureStatus(result);
    return c.json(
      error(
        status === 404 ? ErrorCodes.NOT_FOUND : ErrorCodes.INTERNAL_ERROR,
        result.error,
      ),
      status,
    );
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/strategies?category=&search=
 * Built-in registry (filtered) + the caller's custom strategies + categories.
 */
strategiesRoutes.get("/", async (c) => {
  const parsed = zodParse(ListQuerySchema, {
    category: c.req.query("category") ?? undefined,
    search: c.req.query("search") ?? undefined,
  });
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid list query", parsed.issues),
      400,
    );
  }

  const result = await listStrategies(c.get("userId"), parsed.data);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/** POST /v1/strategies — create a custom strategy → 201 (name collision → 409). */
strategiesRoutes.post("/", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(CreateSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid strategy payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await createStrategy(c.get("userId"), parsed.data);
  if (!result.success) {
    if (result.code === "CONFLICT") {
      return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data), 201);
});

/**
 * POST /v1/strategies/:id/run
 * Async run: gate (built-in registry / owned custom) → ScanResult PENDING →
 * publish strategy-scan job → 202 { scanId, status } (the poll handle).
 * Body { isBuiltIn?, limit? } is optional (defaults: custom, limit 50).
 */
strategiesRoutes.post("/:id/run", async (c) => {
  const bodyData = await optionalJson(c);
  if (bodyData === null) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(RunSchema, bodyData);
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid run payload", parsed.issues),
      400,
    );
  }

  const result = await runStrategyScan(
    c.get("userId"),
    c.req.param("id"),
    parsed.data,
  );
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data), 202);
});

/**
 * POST /v1/strategies/:id/clone
 * Clone a BUILT-IN strategy into the caller's custom set → 201.
 * Body { name? } is optional (defaults to "<name> (Custom)").
 */
strategiesRoutes.post("/:id/clone", async (c) => {
  const bodyData = await optionalJson(c);
  if (bodyData === null) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(CloneSchema, bodyData);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid clone payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await cloneBuiltIn(
    c.get("userId"),
    c.req.param("id"),
    parsed.data.name,
  );
  if (!result.success) {
    if (result.code === "CONFLICT") {
      return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data), 201);
});

/** PATCH /v1/strategies/:id — sparse update of an owned custom strategy. */
strategiesRoutes.patch("/:id", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(UpdateSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid strategy payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await updateStrategy(
    c.get("userId"),
    c.req.param("id"),
    parsed.data,
  );
  if (!result.success) {
    // MONEY-1183 — a DB failure is a 500, not a 404. Both outcomes collapsed
    // into this branch and answered 404, telling the client the row does not
    // exist so it stopped retrying a blip that would have succeeded.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

/** DELETE /v1/strategies/:id — delete an owned custom strategy (foreign → 404). */
strategiesRoutes.delete("/:id", async (c) => {
  const result = await deleteStrategy(c.get("userId"), c.req.param("id"));
  if (!result.success) {
    // MONEY-1183 — a DB failure is a 500, not a 404. Both outcomes used to
    // collapse into this one branch and answer 404, which tells the client the
    // row does not exist and retrying is pointless — so a transient failure was
    // terminal. The service now tags NOT_FOUND / INTERNAL; un-coded failures
    // keep the 404 default.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

export default strategiesRoutes;
