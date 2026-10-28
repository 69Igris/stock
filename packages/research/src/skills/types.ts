/**
 * Research Skill Interface
 */

import type { ResearchPlan, ResearchTask } from "../types";

export interface ResearchSkill {
  name: string;
  description: string;
  triggers: RegExp[];
  requiredParams: string[];
  optionalParams?: string[];
  buildPlan: (params: Record<string, unknown>) => ResearchPlan;
}

/**
 * Helper to create a task ID
 */
export function taskId(prefix: string, index: number): string {
  return `${prefix}_${index}`;
}

/**
 * Helper to create a data_fetch task
 */
export function fetchTask(
  id: string,
  tool: string,
  params: Record<string, unknown>,
  dependsOn: string[] = [],
): ResearchTask {
  return {
    id,
    type: "data_fetch",
    tool,
    params,
    dependsOn,
    status: "pending",
  };
}

/**
 * Helper to create a computation task
 */
export function computeTask(
  id: string,
  tool: string,
  params: Record<string, unknown>,
  dependsOn: string[],
): ResearchTask {
  return {
    id,
    type: "computation",
    tool,
    params,
    dependsOn,
    status: "pending",
  };
}

/**
 * Helper to create a synthesis task
 */
export function synthesisTask(
  id: string,
  tool: string,
  params: Record<string, unknown>,
  dependsOn: string[],
): ResearchTask {
  return {
    id,
    type: "synthesis",
    tool,
    params,
    dependsOn,
    status: "pending",
  };
}
