/**
 * Strategies Service (MONEY-1062 P4c — discovery-power parity).
 *
 * Faithful extraction of the strategy server actions for apps/api:
 *   PRESETS (apps/web/lib/actions/strategies.ts)
 *     - :93  `getStrategyPresetsAction`     → getStrategyPresets
 *     - :124 `getStrategyCategoriesAction`  → getStrategyCategoriesInfo
 *   CUSTOM CRUD + RUN (apps/web/lib/actions/custom-strategy.ts)
 *     - :54  `listStrategiesAction`  → listStrategies
 *     - :127 `createStrategyAction`  → createStrategy
 *     - :183 `updateStrategyAction`  → updateStrategy
 *     - :234 `deleteStrategyAction`  → deleteStrategy
 *     - :264 `cloneBuiltInAction`    → cloneBuiltIn
 *     - :310 `runStrategyAction`     → runStrategyScan  (async → Pub/Sub)
 *     - :388 `getScanStatusAction`   → getScanStatus
 *     - :421 `getScanResultAction`   → getScanResult
 *     - :464 `getScanHistoryAction`  → getScanHistory
 *
 * STRIPPED (web/next glue): `getAuthenticatedUser` (the route owns auth and
 * passes the resolved Mongo userId, like alerts.service). Zod input validation
 * moves to the route; the service owns the DB + gating business logic.
 *
 * ASYNC (G3): runStrategyScan resolves the strategy (built-in OR ownership-scoped
 * custom) as the GATE, creates the ScanResult in PENDING, THEN publishes the
 * strategy-scan Pub/Sub job. A failed gate (strategy not found / not owned)
 * returns BEFORE any create/publish — the worker is never handed an orphan job.
 * `publishStrategyScanJob` is injectable so the suite asserts the message shape
 * and that a gate failure NEVER publishes.
 *
 * @see packages/services/__tests__/parity-p4c-strategies.service.test.ts
 */

import { prisma } from "@usemoney/database";
import type { Prisma } from "@prisma/client";
import { dbLogger as logger } from "@usemoney/logger";
import { getCached } from "@usemoney/core";
import { randomUUID } from "node:crypto";
import {
  BUILTIN_STRATEGIES,
  getStrategyById,
  getStrategiesByCategory,
  searchStrategies as searchBuiltIn,
  getStrategyCategories,
  type BuiltInStrategy,
  type StrategyCategory,
} from "@usemoney/research/strategies/builtin-strategies";
import { publishStrategyScanJob as defaultPublishStrategyScanJob } from "@usemoney/pubsub/publish";
import type { StrategyScanMessage } from "@usemoney/types";
import type { ServiceResult } from "./types";

// Re-exported so apps/api can type the presets `category` param without
// depending on @usemoney/research directly.
export type { StrategyCategory } from "@usemoney/research/strategies/builtin-strategies";

// ── Preset types (mirror strategies.ts action) ───────────────────────

export interface StrategyStats {
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  oneYearReturn: number;
  period: string;
  equityCurve: number[];
  users: number | null;
  computedAt: string;
}

export interface StrategyCard {
  id: string;
  name: string;
  description: string;
  category: StrategyCategory;
  subcategory: string | null;
  tags: string[];
  attribution: string | null;
  /** Null = not yet backtested. UI shows a "Run backtest" CTA. */
  stats: StrategyStats | null;
}

export interface StrategyCategoryInfo {
  category: StrategyCategory | "all";
  count: number;
  label: string;
}

// ── Custom-strategy types (mirror custom-strategy.ts action) ─────────

export interface StrategyListItem {
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

export interface CreateStrategyInput {
  name: string;
  description?: string;
  filters: unknown[];
  logic?: string;
  scanType: string;
  chartinkQuery?: string;
  category?: string;
  tags?: string[];
}

/** Injectable IO seam. ESM suite passes fakes via `deps` (no module mocks). */
export interface StrategiesServiceDeps {
  prisma?: typeof prisma;
  publishStrategyScanJob?: (msg: StrategyScanMessage) => Promise<string>;
  /** Backtest stats loader (Redis-backed in prod). Missing entry ⇒ stats null. */
  loadStatsMap?: () => Promise<Map<string, StrategyStats>>;
}

// ════════════════════════════════════════════════════════════════════════════
// PRESETS
// ════════════════════════════════════════════════════════════════════════════

/** Default stats loader — reads the strategy-stats-sync Redis entry. */
async function defaultLoadStatsMap(): Promise<Map<string, StrategyStats>> {
  const cached = await getCached<Record<string, StrategyStats>>(
    "discover",
    "_global",
    "strategy-stats:all",
    undefined,
    { ttl: 24 * 60 * 60 },
  );
  if (!cached) return new Map();
  return new Map(Object.entries(cached));
}

function toCard(s: BuiltInStrategy, stats: StrategyStats | null): StrategyCard {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    subcategory: s.subcategory ?? null,
    tags: s.tags,
    attribution: s.attribution ?? null,
    stats,
  };
}

/** Built-in strategy presets (stats-first sort), optionally category-filtered. */
export async function getStrategyPresets(
  options?: { category?: StrategyCategory; limit?: number },
  deps: StrategiesServiceDeps = {},
): Promise<ServiceResult<StrategyCard[]>> {
  const loadStats = deps.loadStatsMap ?? defaultLoadStatsMap;
  try {
    const { category, limit = 60 } = options ?? {};
    const statsMap = await loadStats();

    let pool: BuiltInStrategy[] = BUILTIN_STRATEGIES;
    if (category) {
      pool = pool.filter((s) => s.category === category);
    }

    const cards = pool.map((s) => toCard(s, statsMap.get(s.id) ?? null));
    cards.sort((a, b) => {
      const aHas = a.stats != null;
      const bHas = b.stats != null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (a.stats && b.stats) return b.stats.cagr - a.stats.cagr;
      return a.name.localeCompare(b.name);
    });

    return { success: true, data: cards.slice(0, limit) };
  } catch (error) {
    logger.error({ error }, "getStrategyPresets service error");
    return { success: false, error: "Failed to load strategy presets" };
  }
}

/** Category buckets with counts, prefixed by an "all" pseudo-category. */
export async function getStrategyCategoriesInfo(): Promise<
  ServiceResult<StrategyCategoryInfo[]>
> {
  try {
    const categories = getStrategyCategories();
    const total = categories.reduce((sum, c) => sum + c.count, 0);
    const data: StrategyCategoryInfo[] = [
      { category: "all", count: total, label: "All" },
      ...categories,
    ];
    return { success: true, data };
  } catch (error) {
    logger.error({ error }, "getStrategyCategoriesInfo service error");
    return { success: false, error: "Failed to load strategy categories" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CUSTOM STRATEGIES — CRUD
// ════════════════════════════════════════════════════════════════════════════

/** List built-in strategies (search/category filtered) + the caller's custom set. */
export async function listStrategies(
  userId: string,
  options?: { category?: string; search?: string },
  deps: StrategiesServiceDeps = {},
): Promise<
  ServiceResult<{
    builtIn: StrategyListItem[];
    custom: StrategyListItem[];
    categories: { category: string; count: number; label: string }[];
  }>
> {
  const db = deps.prisma ?? prisma;
  try {
    let builtInList: BuiltInStrategy[];
    if (options?.search) {
      builtInList = searchBuiltIn(options.search);
    } else if (options?.category) {
      builtInList = getStrategiesByCategory(
        options.category as StrategyCategory,
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

    const customStrategies = await db.customStrategy.findMany({
      where: { userId },
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
    logger.error({ error, userId }, "listStrategies service error");
    return {
      success: false,
      error: `Failed to list strategies: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}

/** Create a custom strategy (name ≥2 chars, ≥1 filter). */
export async function createStrategy(
  userId: string,
  input: CreateStrategyInput,
  deps: StrategiesServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
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

  const db = deps.prisma ?? prisma;
  try {
    const strategy = await db.customStrategy.create({
      data: {
        userId,
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
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return {
        success: false,
        error: "A strategy with this name already exists",
        code: "CONFLICT",
      };
    }
    return {
      success: false,
      error: `Failed to create strategy: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}

/** Update the caller's own custom strategy (ownership confirmed, sparse patch). */
export async function updateStrategy(
  userId: string,
  id: string,
  input: Partial<CreateStrategyInput>,
  deps: StrategiesServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const existing = await db.customStrategy.findFirst({
      where: { id, userId },
    });
    if (!existing)
      return {
        success: false,
        error: "Strategy not found",
        code: "NOT_FOUND",
      };

    await db.customStrategy.update({
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
    logger.error({ error, userId, id }, "updateStrategy service error");
    return {
      success: false,
      error: `Failed to update strategy: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      code: "INTERNAL",
    };
  }
}

/** Delete the caller's own custom strategy (ownership confirmed first). */
export async function deleteStrategy(
  userId: string,
  id: string,
  deps: StrategiesServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const existing = await db.customStrategy.findFirst({
      where: { id, userId },
    });
    if (!existing)
      return {
        success: false,
        error: "Strategy not found",
        code: "NOT_FOUND",
      };

    await db.customStrategy.delete({ where: { id } });
    return { success: true, data: { id } };
  } catch (error) {
    logger.error({ error, userId, id }, "deleteStrategy service error");
    return {
      success: false,
      error: `Failed to delete strategy: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      code: "INTERNAL",
    };
  }
}

/** Clone a built-in strategy into the caller's custom set. */
export async function cloneBuiltIn(
  userId: string,
  builtInId: string,
  customName?: string,
  deps: StrategiesServiceDeps = {},
): Promise<ServiceResult<{ id: string }>> {
  const builtIn = getStrategyById(builtInId);
  if (!builtIn) {
    return { success: false, error: "Built-in strategy not found" };
  }

  const db = deps.prisma ?? prisma;
  try {
    const strategy = await db.customStrategy.create({
      data: {
        userId,
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
        code: "CONFLICT",
      };
    }
    return {
      success: false,
      error: `Failed to clone strategy: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RUN (async via Pub/Sub) + scan polling
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run a built-in or custom strategy. GATE: resolve the strategy (custom is
 * ownership-scoped) — a miss returns BEFORE any ScanResult create / publish.
 * On success: create the PENDING ScanResult, then publish the scan job.
 */
export async function runStrategyScan(
  userId: string,
  strategyId: string,
  options?: { isBuiltIn?: boolean; limit?: number },
  deps: StrategiesServiceDeps = {},
): Promise<ServiceResult<{ scanId: string; status: string }>> {
  const db = deps.prisma ?? prisma;
  const publish = deps.publishStrategyScanJob ?? defaultPublishStrategyScanJob;

  try {
    let scanName: string;
    let filters: unknown[];
    let logic = "AND";
    let scanType = "fundamental";

    if (options?.isBuiltIn) {
      const builtIn = getStrategyById(strategyId);
      if (!builtIn) {
        return {
          success: false,
          error: "Built-in strategy not found",
          code: "NOT_FOUND",
        };
      }
      scanName = builtIn.name;
      filters = builtIn.filters;
      logic = "AND";
      scanType = builtIn.scanType;
    } else {
      const custom = await db.customStrategy.findFirst({
        where: { id: strategyId, userId },
      });
      if (!custom) {
        return {
          success: false,
          error: "Strategy not found",
          code: "NOT_FOUND",
        };
      }
      scanName = custom.name;
      filters = custom.filters as unknown[];
      logic = custom.logic || "AND";
      scanType = custom.scanType;
    }

    // Gate passed → create the PENDING ScanResult, then publish.
    const scanResult = await db.scanResult.create({
      data: {
        strategyId: options?.isBuiltIn ? null : strategyId,
        userId,
        scanName,
        results: [],
        stockCount: 0,
        status: "PENDING",
      },
    });

    await publish({
      jobId: randomUUID(),
      userId,
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
    logger.error(
      { error, userId, strategyId },
      "runStrategyScan service error",
    );
    return {
      success: false,
      error: `Failed to run strategy: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}

/** Poll a scan's status (ownership-scoped). */
export async function getScanStatus(
  userId: string,
  scanId: string,
  deps: StrategiesServiceDeps = {},
): Promise<
  ServiceResult<{
    status: string;
    stockCount: number;
    errorMessage?: string | null;
  }>
> {
  const db = deps.prisma ?? prisma;
  try {
    const scan = await db.scanResult.findFirst({
      where: { id: scanId, userId },
      select: { status: true, stockCount: true, errorMessage: true },
    });
    if (!scan)
      return { success: false, error: "Scan not found", code: "NOT_FOUND" };
    return { success: true, data: scan };
  } catch (error) {
    // MONEY-1062 (Round C / C3#4): the raw error text used to be interpolated
    // into the user-facing message (driver internals leak) and the leg carried
    // no code, so routes read a DB blip as "scan deleted" (404). Log the raw
    // error server-side only; return a generic message + INTERNAL.
    logger.error({ error, userId, scanId }, "getScanStatus service error");
    return {
      success: false,
      error: "Failed to get scan status",
      code: "INTERNAL",
    };
  }
}

/** Fetch a completed scan's result (ownership-scoped). */
export async function getScanResult(
  userId: string,
  scanId: string,
  deps: StrategiesServiceDeps = {},
): Promise<
  ServiceResult<{
    scanName: string;
    stockCount: number;
    status: string;
    results: unknown;
    executedAt: string;
  }>
> {
  const db = deps.prisma ?? prisma;
  try {
    const scan = await db.scanResult.findFirst({
      where: { id: scanId, userId },
    });
    if (!scan)
      return { success: false, error: "Scan not found", code: "NOT_FOUND" };
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
    // Sanitize: never leak raw driver text to the client (route maps INTERNAL
    // → 500). A transient DB error must NOT read as "Scan not found" (→ 404).
    logger.error({ error, userId, scanId }, "getScanResult service error");
    return {
      success: false,
      error: "Failed to get scan result",
      code: "INTERNAL",
    };
  }
}

/** List the caller's recent scans (newest first). */
export async function getScanHistory(
  userId: string,
  options?: { limit?: number },
  deps: StrategiesServiceDeps = {},
): Promise<
  ServiceResult<{
    scans: Array<{
      id: string;
      scanName: string;
      stockCount: number;
      executedAt: string;
    }>;
  }>
> {
  const db = deps.prisma ?? prisma;
  try {
    const scans = await db.scanResult.findMany({
      where: { userId },
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
    logger.error({ error, userId }, "getScanHistory service error");
    return {
      success: false,
      error: "Failed to get scan history",
      code: "INTERNAL",
    };
  }
}
