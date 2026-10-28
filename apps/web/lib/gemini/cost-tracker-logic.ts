/**
 * Cost Tracker — pure logic
 *
 * Pure helpers extracted from cost-tracker.ts so the aggregation / threshold /
 * model-resolution logic can be unit-tested without importing the Prisma-backed
 * module. cost-tracker.ts imports and CALLS these (no dead exports): the
 * production analytics path and the tests run the same code.
 */

import { convertToINR } from "./cost-tracker";

/** A token-usage row as needed for aggregation. */
export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface AggregatedUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  totalCostINR: number;
  queryCount: number;
}

/**
 * Resolve the model name from a query type. Anything other than "fast" maps to
 * the Pro model (so an unexpected/typo'd queryType bills at the Pro rate — the
 * conservative default). Used by trackTokenUsage.
 */
export function resolveModelName(queryType: string | undefined): string {
  return queryType === "fast" ? "gemini-2.5-flash" : "gemini-2.5-pro";
}

/**
 * Cost-threshold gate (strict `>` — a cost exactly AT the threshold does NOT
 * exceed it). Used by exceedsCostThreshold.
 */
export function exceedsThreshold(
  totalCostUSD: number,
  thresholdUSD: number
): boolean {
  return totalCostUSD > thresholdUSD;
}

/**
 * Sum a set of usage rows into totals (+ INR conversion). Used by
 * getUserTokenUsage.
 */
export function aggregateUsage(records: UsageRecord[]): AggregatedUsage {
  const stats = records.reduce(
    (acc, u) => {
      acc.totalInputTokens += u.inputTokens;
      acc.totalOutputTokens += u.outputTokens;
      acc.totalCostUSD += u.estimatedCost;
      acc.queryCount += 1;
      return acc;
    },
    {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUSD: 0,
      totalCostINR: 0,
      queryCount: 0,
    }
  );

  stats.totalCostINR = convertToINR(stats.totalCostUSD);
  return stats;
}

export interface DailyUsageRow {
  createdAt: Date;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface DailyUsageBucket {
  date: string;
  queries: number;
  tokens: number;
  cost: number;
}

/**
 * Group usage rows into per-UTC-day buckets (date via toISOString). Used by
 * getDailyUsage.
 */
export function groupDailyUsage(records: DailyUsageRow[]): DailyUsageBucket[] {
  const dailyMap = new Map<string, DailyUsageBucket>();

  for (const u of records) {
    const date = u.createdAt.toISOString().split("T")[0]!;

    if (!dailyMap.has(date)) {
      dailyMap.set(date, { date, queries: 0, tokens: 0, cost: 0 });
    }

    const daily = dailyMap.get(date)!;
    daily.queries += 1;
    daily.tokens += u.inputTokens + u.outputTokens;
    daily.cost += u.estimatedCost;
  }

  return Array.from(dailyMap.values());
}

export interface ModelUsageRow {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface ModelUsageBreakdown {
  modelName: string;
  queryCount: number;
  totalTokens: number;
  totalCost: number;
}

/**
 * Break usage rows down per model. Unknown model names are still accumulated
 * (the cost was already computed and stored). Used by getUsageByModel.
 */
export function breakdownByModel(
  records: ModelUsageRow[]
): ModelUsageBreakdown[] {
  const breakdown: Record<string, ModelUsageBreakdown> = {};

  for (const u of records) {
    if (!breakdown[u.modelName]) {
      breakdown[u.modelName] = {
        modelName: u.modelName,
        queryCount: 0,
        totalTokens: 0,
        totalCost: 0,
      };
    }
    breakdown[u.modelName]!.queryCount += 1;
    breakdown[u.modelName]!.totalTokens += u.inputTokens + u.outputTokens;
    breakdown[u.modelName]!.totalCost += u.estimatedCost;
  }

  return Object.values(breakdown);
}
