"use server";

/**
 * Custom Strategy Server Actions
 *
 * CRUD operations for custom strategies + running built-in/custom strategies.
 * Strategy EXECUTION for large scans offloads to workers via Pub/Sub.
 */

import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import prisma from "@usemoney/database";
import type { Prisma } from "@usemoney/database";
import {
  BUILTIN_STRATEGIES,
  getStrategyById,
  getStrategiesByCategory,
  searchStrategies as searchBuiltIn,
  getStrategyCategories,
  type BuiltInStrategy,
  type StrategyCategory,
} from "@usemoney/research";
import { publishStrategyScanJob } from "@usemoney/pubsub/publish";
import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────

interface StrategyListItem {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  scanType: string;
  tags: string[];
  isBuiltIn: boolean;
  usageCount: number;
  lastRunAt: string | null;
  lastRunCount: number | null;
}

interface CreateStrategyInput {
  name: string;
  description?: string;
  filters: unknown[];
  logic?: string;
  scanType: string;
  chartinkQuery?: string;
  category?: string;
  tags?: string[];
}

// ── List Strategies (built-in + user custom) ─────────────────

export async function listStrategiesAction(options?: {
  category?: string;
  search?: string;
}): Promise<
  ActionResponse<{
    builtIn: StrategyListItem[];
    custom: StrategyListItem[];
    categories: { category: string; count: number; label: string }[];
  }>
> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Built-in strategies
    let builtInList: BuiltInStrategy[];
    if (options?.search) {
      builtInList = searchBuiltIn(options.search);
    } else if (options?.category) {
      builtInList = getStrategiesByCategory(
        options.category as StrategyCategory
      );
    } else {
      builtInList = BUILTIN_STRATEGIES;
    }

    const builtIn: StrategyListItem[] = builtInList.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      scanType: s.scanType,
      tags: s.tags,
      isBuiltIn: true,
      usageCount: 0,
      lastRunAt: null,
      lastRunCount: null,
    }));

    // User's custom strategies
    const customStrategies = await prisma.customStrategy.findMany({
      where: { userId: authUser.userId },
      orderBy: { updatedAt: "desc" },
    });

    const custom: StrategyListItem[] = customStrategies.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      scanType: s.scanType,
      tags: s.tags,
      isBuiltIn: false,
      usageCount: s.usageCount,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      lastRunCount: s.lastRunCount,
    }));

    const categories = getStrategyCategories();

    return { success: true, data: { builtIn, custom, categories } };
  } catch (error) {
    return {
      success: false,
      error: `Failed to list strategies: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Create Custom Strategy ───────────────────────────────────

export async function createStrategyAction(
  input: CreateStrategyInput
): Promise<ActionResponse<{ id: string }>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  if (!input.name || input.name.length < 2) {
    return {
      success: false,
      error: "Strategy name must be at least 2 characters",
    };
  }

  if (
    !input.filters ||
    !Array.isArray(input.filters) ||
    input.filters.length === 0
  ) {
    return { success: false, error: "At least one filter is required" };
  }

  try {
    const strategy = await prisma.customStrategy.create({
      data: {
        userId: authUser.userId,
        name: input.name,
        description: input.description || null,
        filters: input.filters as Prisma.InputJsonValue,
        logic: input.logic || "AND",
        scanType: input.scanType || "fundamental",
        chartinkQuery: input.chartinkQuery || null,
        category: input.category || null,
        tags: input.tags || [],
      },
    });

    return { success: true, data: { id: strategy.id } };
  } catch (error) {
    // Handle unique constraint violation
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return {
        success: false,
        error: "A strategy with this name already exists",
      };
    }
    return {
      success: false,
      error: `Failed to create strategy: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Update Custom Strategy ───────────────────────────────────

export async function updateStrategyAction(
  id: string,
  input: Partial<CreateStrategyInput>
): Promise<ActionResponse<{ id: string }>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const existing = await prisma.customStrategy.findFirst({
      where: { id, userId: authUser.userId },
    });

    if (!existing) {
      return { success: false, error: "Strategy not found" };
    }

    await prisma.customStrategy.update({
      where: { id },
      data: {
        ...(input.name && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description || null,
        }),
        ...(input.filters && {
          filters: input.filters as Prisma.InputJsonValue,
        }),
        ...(input.logic && { logic: input.logic }),
        ...(input.scanType && { scanType: input.scanType }),
        ...(input.chartinkQuery !== undefined && {
          chartinkQuery: input.chartinkQuery || null,
        }),
        ...(input.category !== undefined && {
          category: input.category || null,
        }),
        ...(input.tags && { tags: input.tags }),
      },
    });

    return { success: true, data: { id } };
  } catch (error) {
    return {
      success: false,
      error: `Failed to update strategy: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Delete Custom Strategy ───────────────────────────────────

export async function deleteStrategyAction(
  id: string
): Promise<ActionResponse<void>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const existing = await prisma.customStrategy.findFirst({
      where: { id, userId: authUser.userId },
    });

    if (!existing) {
      return { success: false, error: "Strategy not found" };
    }

    await prisma.customStrategy.delete({ where: { id } });

    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: `Failed to delete strategy: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Clone Built-in to Custom ─────────────────────────────────

export async function cloneBuiltInAction(
  builtInId: string,
  customName?: string
): Promise<ActionResponse<{ id: string }>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  const builtIn = getStrategyById(builtInId);
  if (!builtIn) {
    return { success: false, error: "Built-in strategy not found" };
  }

  try {
    const strategy = await prisma.customStrategy.create({
      data: {
        userId: authUser.userId,
        name: customName || `${builtIn.name} (Custom)`,
        description: builtIn.description,
        filters: builtIn.filters as unknown as Prisma.InputJsonValue,
        logic: "AND",
        scanType: builtIn.scanType,
        chartinkQuery: builtIn.chartinkQuery || null,
        category: builtIn.category,
        tags: [...builtIn.tags, "cloned"],
      },
    });

    return { success: true, data: { id: strategy.id } };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return {
        success: false,
        error: "A strategy with this name already exists",
      };
    }
    return {
      success: false,
      error: `Failed to clone strategy: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Run Strategy (Async via Pub/Sub) ─────────────────────────

export async function runStrategyAction(
  strategyId: string,
  options?: { isBuiltIn?: boolean; limit?: number }
): Promise<ActionResponse<{ scanId: string; status: string }>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    let scanName: string;
    let filters: unknown[];
    let logic = "AND";
    let scanType = "fundamental";

    if (options?.isBuiltIn) {
      const builtIn = getStrategyById(strategyId);
      if (!builtIn) {
        return { success: false, error: "Built-in strategy not found" };
      }
      scanName = builtIn.name;
      filters = builtIn.filters;
      logic = "AND";
      scanType = builtIn.scanType;
    } else {
      const custom = await prisma.customStrategy.findFirst({
        where: { id: strategyId, userId: authUser.userId },
      });

      if (!custom) {
        return { success: false, error: "Strategy not found" };
      }

      scanName = custom.name;
      filters = custom.filters as unknown[];
      logic = custom.logic || "AND";
      scanType = custom.scanType;
    }

    // Create ScanResult in PENDING state
    const scanResult = await prisma.scanResult.create({
      data: {
        strategyId: options?.isBuiltIn ? null : strategyId,
        userId: authUser.userId,
        scanName,
        results: [],
        stockCount: 0,
        status: "PENDING",
      },
    });

    // Publish to worker via Pub/Sub
    await publishStrategyScanJob({
      jobId: randomUUID(),
      userId: authUser.userId,
      scanId: scanResult.id,
      strategyId,
      isBuiltIn: !!options?.isBuiltIn,
      filters,
      logic,
      scanType,
      limit: options?.limit || 50,
    });

    return {
      success: true,
      data: { scanId: scanResult.id, status: "PENDING" },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to run strategy: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Get Scan Status ──────────────────────────────────────────

export async function getScanStatusAction(scanId: string): Promise<
  ActionResponse<{
    status: string;
    stockCount: number;
    errorMessage?: string | null;
  }>
> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const scan = await prisma.scanResult.findFirst({
      where: { id: scanId, userId: authUser.userId },
      select: { status: true, stockCount: true, errorMessage: true },
    });

    if (!scan) {
      return { success: false, error: "Scan not found" };
    }

    return { success: true, data: scan };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get scan status: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Get Scan Result ──────────────────────────────────────────

export async function getScanResultAction(scanId: string): Promise<
  ActionResponse<{
    scanName: string;
    stockCount: number;
    status: string;
    results: unknown;
    executedAt: string;
  }>
> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const scan = await prisma.scanResult.findFirst({
      where: { id: scanId, userId: authUser.userId },
    });

    if (!scan) {
      return { success: false, error: "Scan not found" };
    }

    return {
      success: true,
      data: {
        scanName: scan.scanName,
        stockCount: scan.stockCount,
        status: scan.status,
        results: scan.results,
        executedAt: scan.executedAt.toISOString(),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get scan result: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ── Get Scan History ─────────────────────────────────────────

export async function getScanHistoryAction(options?: {
  limit?: number;
}): Promise<
  ActionResponse<{
    scans: Array<{
      id: string;
      scanName: string;
      stockCount: number;
      executedAt: string;
    }>;
  }>
> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const scans = await prisma.scanResult.findMany({
      where: { userId: authUser.userId },
      orderBy: { executedAt: "desc" },
      take: options?.limit || 20,
      select: {
        id: true,
        scanName: true,
        stockCount: true,
        executedAt: true,
      },
    });

    return {
      success: true,
      data: {
        scans: scans.map((s) => ({
          id: s.id,
          scanName: s.scanName,
          stockCount: s.stockCount,
          executedAt: s.executedAt.toISOString(),
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get scan history: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
