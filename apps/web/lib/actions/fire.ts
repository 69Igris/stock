"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import {
  getFireScenarios as getFireScenariosService,
  getFireScenario as getFireScenarioService,
  saveFireScenario as saveFireScenarioService,
  deleteFireScenario as deleteFireScenarioService,
  addFireChat as addFireChatService,
} from "@usemoney/services";
import type { FireScenarioInput, FireScenario } from "@usemoney/services";
import { dbLogger as logger } from "@usemoney/logger";
import {
  indexFireScenarios,
  deleteScenarioEmbeddings,
} from "@/lib/gemini/indexer";
import { isDemoSession } from "@/lib/demo/session";
import { demoScenarios } from "@/lib/demo/data";

// Re-export types for consumers
export type { FireScenario, FireScenarioInput } from "@usemoney/services";

/**
 * Get all FIRE scenarios
 */
export async function getFireScenariosAction(): Promise<
  ActionResponse<FireScenario[]>
> {
  if (await isDemoSession()) {
    return { success: true, data: demoScenarios };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  return getFireScenariosService(authUser.userId);
}

/**
 * Get a single FIRE scenario
 */
export async function getFireScenarioAction(
  scenarioId: string
): Promise<ActionResponse<FireScenario | null>> {
  if (await isDemoSession()) {
    const scenario = demoScenarios.find((s) => s.id === scenarioId);
    return { success: true, data: scenario || null };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  return getFireScenarioService(authUser.userId, scenarioId);
}

/**
 * Save a FIRE scenario (create or update)
 */
export async function saveFireScenarioAction(
  data: FireScenarioInput,
  scenarioId?: string
): Promise<ActionResponse<FireScenario>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to save scenarios!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await saveFireScenarioService(
    authUser.userId,
    data,
    scenarioId
  );

  if (result?.success) {
    // Index for RAG (run in background)
    const targetId = scenarioId || result?.data.id;
    indexFireScenarios(authUser.userId, targetId).catch((error) => {
      logger.warn(
        { error, scenarioId: targetId },
        "RAG indexing failed for FIRE scenario"
      );
    });

    revalidatePath("/fire");
  }

  return result;
}

/**
 * Delete a FIRE scenario
 */
export async function deleteFireScenarioAction(
  scenarioId: string
): Promise<ActionResponse<void>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await deleteFireScenarioService(authUser.userId, scenarioId);

  if (result?.success) {
    // Delete RAG embeddings (run in background)
    deleteScenarioEmbeddings(authUser.userId, scenarioId).catch((error) => {
      logger.warn(
        { error, scenarioId },
        "Failed to delete RAG embeddings for scenario"
      );
    });

    revalidatePath("/fire");
  }

  return result;
}

/**
 * Load a saved scenario
 */
export async function loadFireScenarioAction(
  scenarioId: string
): Promise<ActionResponse<FireScenario>> {
  if (await isDemoSession()) {
    const scenario = demoScenarios.find((s) => s.id === scenarioId);
    if (!scenario) {
      return { success: false, error: "Scenario not found" };
    }
    return { success: true, data: scenario };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await getFireScenarioService(authUser.userId, scenarioId);

  if (!result?.success) {
    return result as ActionResponse<FireScenario>;
  }

  if (!result?.data) {
    return { success: false, error: "Scenario not found" };
  }

  return { success: true, data: result?.data };
}

/**
 * Add chat message to scenario
 */
export async function addFireChatAction(
  scenarioId: string,
  message: { role: string; content: string }
): Promise<ActionResponse<void>> {
  if (await isDemoSession()) {
    return { success: true }; // Just acknowledge in demo mode
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  return addFireChatService(authUser.userId, scenarioId, message);
}
