/**
 * Tax Analysis Routes
 *
 * Tax report and paired trades endpoints.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes } from "../../lib/response";
import {
  getTaxReport,
  getPairedTradesForFY,
  getTaxLedgers,
} from "@usemoney/services";
import { isValidFinancialYear } from "./filters";
import { isEntitled } from "../../lib/premium-gate";

/** Shared 400 for a malformed `?fy` (both tax endpoints). */
const INVALID_FY_MESSAGE =
  "Invalid financial year (expected e.g. 2024-25 or 2024-2025)";

const taxRoutes = new Hono<AppContext>();

/**
 * GET /v1/tax/report
 * Generate full tax report for a financial year
 */
taxRoutes.get("/report", async (c) => {
  const userId = c.get("userId");
  // MONEY-1142 — tier gate. apps/web enforced this; apps/api did not, so a
  // FREE user with a valid Clerk JWT could curl this endpoint and receive the
  // premium payload with no client involved at all.
  if (!(await isEntitled(userId, "taxAnalysis"))) {
    return c.json(
      error(ErrorCodes.SUBSCRIPTION_REQUIRED, "Upgrade required"),
      403,
    );
  }

  try {
    const fy = c.req.query("fy");
    // Reject a malformed ?fy before the service (a bad label throws RangeError in
    // fyStartYear → 500); an absent/empty fy defaults to the current FY.
    if (!isValidFinancialYear(fy)) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, INVALID_FY_MESSAGE),
        400,
      );
    }
    const result = await getTaxReport(userId, fy);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Tax report error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to generate tax report"),
      500,
    );
  }
});

/**
 * GET /v1/tax/trades
 * Get paired trades for a financial year
 */
taxRoutes.get("/trades", async (c) => {
  const userId = c.get("userId");
  // MONEY-1142 — tier gate. apps/web enforced this; apps/api did not, so a
  // FREE user with a valid Clerk JWT could curl this endpoint and receive the
  // premium payload with no client involved at all.
  if (!(await isEntitled(userId, "taxAnalysis"))) {
    return c.json(
      error(ErrorCodes.SUBSCRIPTION_REQUIRED, "Upgrade required"),
      403,
    );
  }

  try {
    const fy = c.req.query("fy");
    if (!isValidFinancialYear(fy)) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, INVALID_FY_MESSAGE),
        400,
      );
    }
    const result = await getPairedTradesForFY(userId, fy);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Tax trades error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch tax trades"),
      500,
    );
  }
});

/**
 * GET /v1/tax/ledgers?fy=
 * F&O / Intraday / Dividend ledgers for a financial year. Mirrors
 * getTaxLedgersAction (apps/web lib/actions/tax-ledgers.ts:67) via the
 * extracted getTaxLedgers service (userId-scoped Trade read; FY window via the
 * canonical IST-aware parseFYDates; dividends always empty — no model yet).
 * Same ?fy guard as the sibling endpoints; absent fy → current FY.
 */
taxRoutes.get("/ledgers", async (c) => {
  const userId = c.get("userId");
  // MONEY-1142 — tier gate. apps/web enforced this; apps/api did not, so a
  // FREE user with a valid Clerk JWT could curl this endpoint and receive the
  // premium payload with no client involved at all.
  if (!(await isEntitled(userId, "taxAnalysis"))) {
    return c.json(
      error(ErrorCodes.SUBSCRIPTION_REQUIRED, "Upgrade required"),
      403,
    );
  }

  try {
    const fy = c.req.query("fy");
    if (!isValidFinancialYear(fy)) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, INVALID_FY_MESSAGE),
        400,
      );
    }
    const result = await getTaxLedgers(userId, fy);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Tax ledgers error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch tax ledgers"),
      500,
    );
  }
});

export default taxRoutes;
