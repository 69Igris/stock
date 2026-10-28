/**
 * FIRE Service
 *
 * Handles FIRE (Financial Independence, Retire Early) scenario CRUD and chat history.
 * Source: apps/web/lib/actions/fire.ts + apps/web/lib/db/fire.ts
 */

import { prisma, Prisma } from "@usemoney/database";
import { getCached, setCached, clearFireCache } from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import { computeMonthlyExpenses, computeFireProjection } from "./fire-logic";
import type {
  FireScenarioProjectionInput,
  FireProjectionResult,
} from "./fire-logic";

type JsonValue = Prisma.InputJsonValue;

// ── Types ──────────────────────────────────────────────────────────

export interface FireScenarioInput {
  name: string;
  description?: string;
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  taxRate?: number;
  salaryIncrement: number;
  savingsIncrement: number;
  assetClasses: JsonValue[];
  expenses: JsonValue[];
  oneTimeExpenses: JsonValue[];
  fireNumber?: number;
  /**
   * `null` explicitly CLEARS the stored horizon (the plan no longer reaches
   * FIRE); `undefined` leaves it untouched. The distinction matters because
   * saveFireScenario persists via `updateMany`, which SKIPS undefined — so
   * passing undefined for an unreachable plan would silently keep the old,
   * now-wrong horizon next to the new inputs.
   */
  yearsToFire?: number | null;
  monthlyExpenses?: number;
  avgInflation?: number;
  weightedReturn?: number;
  chatHistory?: JsonValue[];
  retirementSlots?: JsonValue[];
}

export interface FireScenario {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  taxRate: number | null;
  salaryIncrement: number;
  savingsIncrement: number;
  assetClasses: JsonValue[];
  expenses: JsonValue[];
  oneTimeExpenses: JsonValue[];
  fireNumber: number | null;
  yearsToFire: number | null;
  monthlyExpenses: number | null;
  avgInflation: number | null;
  weightedReturn: number | null;
  chatHistory: JsonValue[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Compute monthlyExpenses from the expenses array (sum of each expense amount).
 *
 * Delegates to the guarded `computeMonthlyExpenses` in `./fire-logic.ts` so the
 * LIVE read path runs the same non-finite-guarded sum the projection math uses
 * (a corrupt stored `amount` of `NaN`/`Infinity` can no longer poison
 * `monthlyExpenses` into NaN). Behaviour is identical for finite amounts:
 * empty/all-zero → null, otherwise the summed amount.
 */
function withMonthlyExpenses<T extends { expenses: JsonValue | JsonValue[] }>(
  scenario: T,
): T & { monthlyExpenses: number | null } {
  const expenses = scenario.expenses as
    | Array<{ amount?: number | null }>
    | undefined;
  return { ...scenario, monthlyExpenses: computeMonthlyExpenses(expenses) };
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Get all FIRE scenarios for a user (cached, 2 min TTL)
 */
export async function getFireScenarios(
  userId: string,
): Promise<ServiceResult<FireScenario[]>> {
  try {
    const cached = await getCached<FireScenario[]>(
      "fire",
      userId,
      "scenarios",
      undefined,
      { ttl: 2 * 60 },
    );

    if (cached) {
      logger.debug({ userId }, "FIRE scenarios from cache");
      return { success: true, data: cached };
    }

    logger.debug({ userId }, "FIRE scenarios cache miss");

    const scenarios = await prisma.fireScenario.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });

    const data = scenarios.map((s) => withMonthlyExpenses(s)) as FireScenario[];

    await setCached("fire", userId, "scenarios", data, undefined, {
      ttl: 2 * 60,
    });

    return { success: true, data };
  } catch (error) {
    logger.error({ error, userId }, "FIRE scenarios service error");
    return { success: false, error: "Failed to fetch scenarios" };
  }
}

/**
 * Get a single FIRE scenario (cached, 1 min TTL)
 */
export async function getFireScenario(
  userId: string,
  scenarioId: string,
): Promise<ServiceResult<FireScenario | null>> {
  try {
    const cached = await getCached<FireScenario | null>(
      "fire",
      userId,
      scenarioId,
      undefined,
      { ttl: 1 * 60 },
    );

    if (cached) {
      logger.debug({ userId, scenarioId }, "FIRE scenario from cache");
      return { success: true, data: cached };
    }

    logger.debug({ userId, scenarioId }, "FIRE scenario cache miss");

    const scenario = await prisma.fireScenario.findFirst({
      where: { id: scenarioId, userId },
    });

    if (!scenario) {
      return { success: true, data: null };
    }

    const data = withMonthlyExpenses(scenario) as FireScenario;

    await setCached("fire", userId, scenarioId, data, undefined, {
      ttl: 1 * 60,
    });

    return { success: true, data };
  } catch (error) {
    logger.error({ error, userId, scenarioId }, "FIRE scenario service error");
    return { success: false, error: "Failed to fetch scenario" };
  }
}

/**
 * Create or update a FIRE scenario
 * If scenarioId is provided, updates the existing scenario; otherwise creates a new one.
 */
export async function saveFireScenario(
  userId: string,
  data: FireScenarioInput,
  scenarioId?: string,
): Promise<ServiceResult<FireScenario>> {
  try {
    if (scenarioId) {
      // Update existing. Whitelist the client-editable columns (the same set the
      // create branch below writes) so an injected body field can NOT be
      // mass-assigned through what was a blind `data as unknown as ...` cast:
      // userId (ownership!), id, isDefault and the timestamps are all excluded,
      // and non-column inputs (monthlyExpenses is computed; retirementSlots is not
      // persisted) are dropped so they can't trigger a Prisma "Unknown arg" 500.
      // Prisma skips `undefined`, so a partial update still touches only the
      // fields the client actually sent.
      await prisma.fireScenario.updateMany({
        where: { id: scenarioId, userId },
        data: {
          name: data.name,
          description: data.description,
          currentAge: data.currentAge,
          retirementAge: data.retirementAge,
          lifeExpectancy: data.lifeExpectancy,
          currentCorpus: data.currentCorpus,
          monthlySavings: data.monthlySavings,
          withdrawalRate: data.withdrawalRate,
          taxRate: data.taxRate,
          salaryIncrement: data.salaryIncrement,
          savingsIncrement: data.savingsIncrement,
          assetClasses: data.assetClasses,
          expenses: data.expenses,
          oneTimeExpenses: data.oneTimeExpenses,
          fireNumber: data.fireNumber,
          yearsToFire: data.yearsToFire,
          avgInflation: data.avgInflation,
          weightedReturn: data.weightedReturn,
          chatHistory: data.chatHistory,
        } as unknown as Prisma.FireScenarioUpdateManyMutationInput,
      });

      const updated = await prisma.fireScenario.findFirst({
        where: { id: scenarioId, userId },
      });

      if (!updated) {
        return {
          success: false,
          error: "Scenario not found",
          code: "NOT_FOUND",
        };
      }

      // Clear cache for this specific scenario
      await clearFireCache(userId, scenarioId);

      const result = withMonthlyExpenses(updated) as FireScenario;
      return { success: true, data: result, message: "Scenario updated!" };
    } else {
      // Create new - if default, unset other defaults first
      if (data.name === "Default") {
        await prisma.fireScenario.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }

      const scenario = await prisma.fireScenario.create({
        data: {
          userId,
          name: data.name,
          description: data.description,
          currentAge: data.currentAge,
          retirementAge: data.retirementAge,
          lifeExpectancy: data.lifeExpectancy,
          currentCorpus: data.currentCorpus,
          monthlySavings: data.monthlySavings,
          withdrawalRate: data.withdrawalRate,
          taxRate: data.taxRate,
          salaryIncrement: data.salaryIncrement,
          savingsIncrement: data.savingsIncrement,
          assetClasses: data.assetClasses,
          expenses: data.expenses,
          oneTimeExpenses: data.oneTimeExpenses,
          fireNumber: data.fireNumber,
          yearsToFire: data.yearsToFire,
          avgInflation: data.avgInflation,
          weightedReturn: data.weightedReturn,
          chatHistory: data.chatHistory || [],
          isDefault: data.name === "Default",
        },
      });

      // Clear scenarios list cache (new scenario added)
      await clearFireCache(userId);

      const result = withMonthlyExpenses(scenario) as FireScenario;
      return { success: true, data: result, message: "Scenario saved!" };
    }
  } catch (error) {
    logger.error(
      { error, userId, scenarioId },
      "Save FIRE scenario service error",
    );
    return {
      success: false,
      error: "Failed to save scenario",
      code: "INTERNAL",
    };
  }
}

/**
 * Delete a FIRE scenario
 */
export async function deleteFireScenario(
  userId: string,
  scenarioId: string,
): Promise<ServiceResult<void>> {
  try {
    const result = await prisma.fireScenario.deleteMany({
      where: { id: scenarioId, userId },
    });

    if (result.count === 0) {
      return { success: false, error: "Scenario not found", code: "NOT_FOUND" };
    }

    // Clear all FIRE cache (scenario deleted, affects list)
    await clearFireCache(userId);

    return { success: true, data: undefined, message: "Scenario deleted!" };
  } catch (error) {
    logger.error(
      { error, userId, scenarioId },
      "Delete FIRE scenario service error",
    );
    return {
      success: false,
      error: "Failed to delete scenario",
      code: "INTERNAL",
    };
  }
}

/**
 * Append a chat message to a FIRE scenario's chat history
 */
export async function addFireChat(
  userId: string,
  scenarioId: string,
  message: { role: string; content: string },
): Promise<ServiceResult<void>> {
  try {
    const scenario = await prisma.fireScenario.findFirst({
      where: { id: scenarioId, userId },
    });

    if (!scenario) {
      return { success: false, error: "Scenario not found" };
    }

    const chatHistory = [
      ...((scenario.chatHistory as JsonValue[]) || []),
      { ...message, timestamp: new Date().toISOString() } as JsonValue,
    ];

    await prisma.fireScenario.updateMany({
      where: { id: scenarioId, userId },
      data: { chatHistory },
    });

    // Clear cache for this scenario (chat history updated)
    await clearFireCache(userId, scenarioId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, userId, scenarioId }, "Add FIRE chat service error");
    return { success: false, error: "Failed to save chat" };
  }
}

// ── FIRE Projection (server-side guarded math) ─────────────────────

// Re-export the projection types so action/route consumers get them from the
// service barrel alongside the scenario types.
export type {
  FireScenarioProjectionInput,
  FireProjectionResult,
  FireProjectionPoint,
  FireProjectionInput,
  FireStatus,
} from "./fire-logic";

/**
 * Compute the full FIRE projection (fireNumber, yearsToFire, year-by-year
 * series, status) from a scenario's raw parameters, server-side.
 *
 * This is the SERVICE entry point into the guarded projection math in
 * `./fire-logic.ts`: the client computes the same projection live in
 * `apps/web/app/fire/client.tsx`, but persisted/AI/RAG consumers (and any
 * server-side recompute) MUST go through this so the result is the
 * non-finite-guarded one — a corrupt or adversarial stored parameter
 * (`NaN`/`±Infinity` corpus, a `Math.pow` overflow, a 0 withdrawal rate) can
 * never yield a `NaN`/`Infinity` corpus, an out-of-range `yearsToFire`, or a
 * non-finite chart point that would render "₹NaN" / throw downstream.
 *
 * Synchronous + pure (no DB/cache I/O): wrapped in `ServiceResult` for a
 * uniform call shape, and so a defensive failure still degrades gracefully
 * instead of throwing into the caller.
 */
export function computeFireScenarioProjection(
  input: FireScenarioProjectionInput,
): ServiceResult<FireProjectionResult> {
  try {
    return { success: true, data: computeFireProjection(input) };
  } catch (error) {
    logger.error({ error }, "FIRE projection service error");
    return { success: false, error: "Failed to compute projection" };
  }
}
