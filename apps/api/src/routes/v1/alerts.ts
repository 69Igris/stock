/**
 * Alerts Routes (MONEY-402 / MONEY-408 mobile-parity)
 *
 * User-scoped CRUD for the `Alert` model. Thin wrappers over alerts.service —
 * every read/write is IDOR-scoped to the caller (update confirms ownership;
 * delete is a scoped `deleteMany` → a foreign id affects zero rows → 404). The
 * evaluator that FIRES alerts is a separate worker (out of scope here).
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
  listAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
} from "@usemoney/services";

const alertsRoutes = new Hono<AppContext>();

const CHANNEL = z.enum(["IN_APP", "EMAIL", "PUSH"]);
const CONDITIONS = z.record(z.string(), z.unknown());

const CreateSchema = z.object({
  kind: z.enum([
    "PRICE",
    "VOLUME",
    "NEWS",
    "EARNINGS_DATE",
    "CORPORATE_ACTION",
    "CUSTOM",
    // MONEY-1204 / 14e.3 — the third copy of this list. See the note in
    // packages/services/src/alerts-logic.ts.
    "FLAG_TRANSITION",
    "DELIVERY_SPIKE",
    "PLEDGE_INCREASE",
    "INSIDER_CLUSTER",
    "MWPL_HIGH",
    "FII_FLOW_STREAK",
  ]),
  symbol: z.string().max(50).nullish(),
  conditions: CONDITIONS,
  notifyChannels: z.array(CHANNEL).optional(),
  cooldownMinutes: z.number().int().positive().optional(),
});
const UpdateSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "TRIGGERED", "EXPIRED"]).optional(),
  conditions: CONDITIONS.optional(),
  notifyChannels: z.array(CHANNEL).optional(),
  cooldownMinutes: z.number().int().positive().optional(),
});

/** GET /v1/alerts — the caller's alerts (active first, newest first). */
alertsRoutes.get("/", async (c) => {
  const result = await listAlerts(c.get("userId"));
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/** POST /v1/alerts — create an alert (kind allow-listed, channels sanitised). */
alertsRoutes.post("/", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(CreateSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid alert payload",
        parsed.issues,
      ),
      400,
    );
  }
  const result = await createAlert(c.get("userId"), parsed.data);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data), 201);
});

/** PATCH /v1/alerts/:id — update the caller's own alert (foreign id → 404). */
alertsRoutes.patch("/:id", async (c) => {
  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(UpdateSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid alert payload",
        parsed.issues,
      ),
      400,
    );
  }
  const result = await updateAlert(
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

/** DELETE /v1/alerts/:id — delete the caller's own alert (foreign id → 404). */
alertsRoutes.delete("/:id", async (c) => {
  const result = await deleteAlert(c.get("userId"), c.req.param("id"));
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
  return c.json(success({ message: "Alert deleted" }));
});

export default alertsRoutes;
