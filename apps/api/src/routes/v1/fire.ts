/**
 * FIRE Calculator Routes
 *
 * Financial Independence, Retire Early scenarios.
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
  getFireScenarios,
  getFireScenario,
  saveFireScenario,
  deleteFireScenario,
  addFireChat,
  consumeCredits,
  type FireScenarioInput,
} from "@usemoney/services";
// MONEY-1079 — the framework-free FIRE chat engine, shared with apps/web.
import {
  ServerFireActions,
  runFireChatTurn,
  scenarioToServerPlan,
  serverPlanToScenarioInput,
  buildFireSnapshotFromPlan,
  createScenarioOps,
} from "@usemoney/fire";
import { makeApiFireGenerate } from "../../lib/fire-generate";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

const fireRoutes = new Hono<AppContext>();

// Mirrors addFireChatAction's message shape ({ role, content } — both plain
// strings on the web) with API-side bounds so an unauthenticated-size blob
// can't be appended into the scenario's chatHistory JSON.
const FireChatSchema = z.object({
  role: z.string().min(1).max(32),
  content: z.string().min(1).max(10000),
});

/**
 * GET /v1/fire
 * List all FIRE scenarios
 */
fireRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getFireScenarios(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("FIRE scenarios error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch FIRE scenarios"),
      500,
    );
  }
});

/**
 * GET /v1/fire/:id
 * Get a single FIRE scenario
 */
fireRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  const scenarioId = c.req.param("id");

  try {
    const result = await getFireScenario(userId, scenarioId);
    // A DB failure is a 500 (retryable); a successful read of a missing/foreign
    // scenario is `data: null` → 404. The two were previously inverted (a DB
    // error 404'd; a not-found 200'd with data:null). Mirror chat-history.ts.
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    if (result.data == null) {
      return c.json(
        error(ErrorCodes.NOT_FOUND, "FIRE scenario not found"),
        404,
      );
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("FIRE scenario error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch FIRE scenario"),
      500,
    );
  }
});

/**
 * POST /v1/fire
 * Create a new FIRE scenario
 */
fireRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  try {
    const parsed = await safeJson<FireScenarioInput>(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const body = parsed.data;
    const result = await saveFireScenario(userId, body);
    if (!result.success) {
      // A create only fails on a DB error (code "INTERNAL") → 500; any other
      // failure stays a 400 validation error (create has no not-found path).
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success(result.data), 201);
  } catch (err) {
    console.error("FIRE create error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to create FIRE scenario"),
      500,
    );
  }
});

/**
 * PUT /v1/fire/:id
 * Update a FIRE scenario
 */
fireRoutes.put("/:id", async (c) => {
  const userId = c.get("userId");
  const scenarioId = c.req.param("id");

  try {
    const parsed = await safeJson<FireScenarioInput>(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const body = parsed.data;
    const result = await saveFireScenario(userId, body, scenarioId);
    if (!result.success) {
      // Updating a missing/foreign scenario → 404; a DB error → 500; anything
      // else remains a 400 validation error.
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("FIRE update error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to update FIRE scenario"),
      500,
    );
  }
});

/**
 * DELETE /v1/fire/:id
 * Delete a FIRE scenario
 */
fireRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const scenarioId = c.req.param("id");

  try {
    const result = await deleteFireScenario(userId, scenarioId);
    if (!result.success) {
      // A DB error (code "INTERNAL") is a 500; a missing/foreign scenario → 404.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success({ message: "Scenario deleted" }));
  } catch (err) {
    console.error("FIRE delete error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to delete FIRE scenario"),
      500,
    );
  }
});

/**
 * POST /v1/fire/:id/chat (MONEY-1062 P1a)
 * Append a chat message to a scenario's chat history. Mirrors
 * addFireChatAction: the service scopes the scenario read/update to the
 * caller (a foreign/missing scenario never mutates).
 */
fireRoutes.post("/:id/chat", async (c) => {
  const userId = c.get("userId");
  const scenarioId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(FireChatSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid chat message",
          validated.issues,
        ),
        400,
      );
    }

    const result = await addFireChat(userId, scenarioId, validated.data);
    if (!result.success) {
      // addFireChat sets no failure `code`: a missing/foreign scenario fails
      // with "Scenario not found" → 404; anything else is a DB failure → 500.
      if (result.error === "Scenario not found") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success({ message: "Chat saved" }));
  } catch (err) {
    console.error("FIRE chat error:", err);
    return c.json(error(ErrorCodes.INTERNAL_ERROR, "Failed to save chat"), 500);
  }
});

// A natural-language FIRE command / question against a specific scenario.
const FireTurnSchema = z.object({
  request: z.string().min(1).max(2000),
});

/**
 * POST /v1/fire/:id/turn (MONEY-1079)
 * Run one Ask FIRE turn against scenario :id, reusing the SAME two-tier engine
 * (@usemoney/fire) the web app uses — deterministic parser first (free), else
 * Gemini function-calling. Tools execute SERVER-side against a working copy of
 * the scenario and the mutated plan is persisted; the caller gets the reply +
 * the fresh plan snapshot. Credit mirrors web's fire_plan: tool turns are FREE,
 * only a pure-answer LLM turn charges `fire_chat`.
 */
fireRoutes.post("/:id/turn", async (c) => {
  const userId = c.get("userId");
  const scenarioId = c.req.param("id");

  try {
    const parsed = await safeJson(c);
    if (!parsed.ok) {
      return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
    }
    const validated = zodParse(FireTurnSchema, parsed.data);
    if (!validated.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid request", validated.issues),
        400,
      );
    }
    const request = validated.data.request.trim();

    // Load the target scenario (service scopes the read to userId → a foreign
    // or missing id is simply "not found", never another user's plan).
    const scRes = await getFireScenario(userId, scenarioId);
    if (!scRes.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, scRes.error), 500);
    }
    if (!scRes.data) {
      return c.json(error(ErrorCodes.NOT_FOUND, "Scenario not found"), 404);
    }
    const scenario = scRes.data;

    // Saved names power the parser's scenario-op name resolution.
    const listRes = await getFireScenarios(userId);
    const saved = listRes.success ? (listRes.data ?? []) : [];
    const savedNames = saved.map((s) => s.name);

    // MONEY-1079 — scenario ops MUST be injected whenever savedNames is fed to
    // the prompt. Without them ServerFireActions falls back to `false` for both,
    // so the model is told which plans exist, emits loadScenario/saveScenario,
    // and is then told it failed — every time.
    //
    // `createScenarioOps` also owns the save-target bookkeeping: a turn that
    // loads a different scenario must persist THERE, not to the path scenario
    // (see its doc comment — writing to the path id is permanent data loss).
    // It lives in @usemoney/fire so that invariant is unit-tested without a
    // HTTP harness: packages/fire/__tests__/scenario-save-target.test.ts.
    const { ops, getSaveTarget } = createScenarioOps({
      saved,
      pathScenario: { id: scenarioId, name: scenario.name },
      persistNew: async (input) => {
        const res = await saveFireScenario(userId, input);
        return res.success;
      },
    });

    const actions = new ServerFireActions(scenarioToServerPlan(scenario), ops);
    // MONEY-1380 — tags this turn's model calls `ml_app: fire`. Wrapped here
    // rather than inside `packages/fire` because that package is a library
    // shared with apps/web's fireChatTurnAction, which wraps its own call.
    const result = await llmWorkflow("fire", "fire-chat-turn", () =>
      runFireChatTurn(actions, savedNames, request, makeApiFireGenerate()),
    );

    const mutated = result.toolCallCount > 0;
    if (mutated) {
      // Persist to the scenario the plan actually BELONGS to: the loaded one
      // if this turn switched scenarios, else the path scenario.
      const target = getSaveTarget();
      const saveRes = await saveFireScenario(
        userId,
        serverPlanToScenarioInput(actions.plan, target.name),
        target.id,
      );
      if (!saveRes.success) {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, saveRes.error), 500);
      }
    }

    // Charge ONLY a pure-answer LLM turn (no tools). Tool turns + the free
    // deterministic parser are never charged (mirrors web fire_plan).
    if (result.usedLlm && result.toolCallCount === 0) {
      const credit = await consumeCredits(userId, "fire_chat", {
        query: request.slice(0, 200),
      });
      if (!credit.success) {
        return c.json(
          error(
            ErrorCodes.FORBIDDEN,
            credit.error ||
              "You're out of credits for the FIRE assistant. Upgrade to keep chatting.",
          ),
          402,
        );
      }
    }

    const reply =
      result.finalText ??
      (result.summaries.length ? result.summaries.join(" ") : "Done.");

    return c.json(
      success({
        reply,
        mutated,
        source: result.usedLlm ? "llm" : "deterministic",
        rebalanceNote: result.rebalanceNote,
        plan: buildFireSnapshotFromPlan(actions.plan, savedNames),
      }),
    );
  } catch (err) {
    console.error("FIRE turn error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "The FIRE assistant is unavailable."),
      500,
    );
  }
});

export default fireRoutes;
