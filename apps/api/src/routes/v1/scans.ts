/**
 * Scans Routes (MONEY-1062 P4c — discovery-power parity)
 *
 * Thin Hono wrappers over @usemoney/services scans.service — the faithful
 * ports of the apps/web scans-library actions:
 *
 *   GET  /v1/scans          ← getScanCatalogAction (apps/web lib/actions/scans.ts:51)
 *   POST /v1/scans/:id/run  ← runScanAction        (apps/web lib/actions/scans.ts:85)
 *
 * The catalog is static, public-safe metadata (no userId — global, like the
 * web action). Runs execute inline through the screener engine (cached,
 * bounded) and FAIL CLOSED for browse-only / zero-mapping scans — the service
 * returns code NOT_RUNNABLE with the web action's exact message, mapped here
 * to a 400 (client can't run this scan; deep-link to the screener instead).
 *
 * SEBI: a scan SURFACES matching stocks — descriptive rows only, never a
 * buy/sell recommendation.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes, zodParse } from "../../lib/response";
import { getScanCatalog, runScan } from "@usemoney/services";

const scansRoutes = new Hono<AppContext>();

// Namespaced catalog ids look like "core:low_pe_value" / "chartink:ma_golden_cross".
const MAX_SCAN_ID_LEN = 120;

const ScanIdSchema = z.string().min(1).max(MAX_SCAN_ID_LEN);

/** Body for POST /:id/run — optional; absent body ≡ {} (limit defaults to 50). */
const RunBodySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * GET /v1/scans
 * The unified scan catalog: { scans, categories }. Global.
 */
scansRoutes.get("/", async (c) => {
  try {
    const result = await getScanCatalog();
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Scan catalog error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load scan catalog"),
      500,
    );
  }
});

/**
 * POST /v1/scans/:id/run
 * Run an inline-runnable scan → { scanId, scanName, rows, total, unmapped,
 * partial }. Body { limit? } is OPTIONAL — an empty body runs with the
 * default preview size (50, capped at 100 like the web action).
 * Unknown id → 404; browse-only / zero-mapping scan → 400 (fail closed).
 */
scansRoutes.post("/:id/run", async (c) => {
  const idParsed = zodParse(ScanIdSchema, c.req.param("id"));
  if (!idParsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid scan id", idParsed.issues),
      400,
    );
  }

  // Optional JSON body: absent/empty → {}; present-but-malformed → 400.
  let bodyData: unknown = {};
  const rawText = await c.req.text();
  if (rawText.trim().length > 0) {
    try {
      bodyData = JSON.parse(rawText);
    } catch {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
  }
  const parsed = zodParse(RunBodySchema, bodyData);
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid run payload", parsed.issues),
      400,
    );
  }

  try {
    const result = await runScan(idParsed.data, {
      limit: parsed.data.limit,
    });
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "NOT_RUNNABLE") {
        return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Scan run error:", err);
    return c.json(error(ErrorCodes.INTERNAL_ERROR, "Failed to run scan"), 500);
  }
});

export default scansRoutes;
