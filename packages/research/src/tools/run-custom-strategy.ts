/**
 * Run Custom Strategy Tool
 *
 * Executes a strategy (built-in or custom) from within the research agent.
 * Routes to the strategy executor which handles Tickertape + Chartink.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  executeStrategy,
  getStrategyById,
  BUILTIN_STRATEGIES,
  searchStrategies,
  type CustomStrategyInput,
  type StrategyFilter,
} from "../strategies/index";

export const runCustomStrategyTool: ResearchToolDef = {
  name: "run_custom_strategy",
  description:
    "Run a built-in or custom strategy scan. Provide either a strategy_id (built-in ID) or custom filters. Returns matching stocks.",
  category: "computation",
  parameters: {
    strategy_id: {
      type: "string",
      description:
        'Built-in strategy ID (e.g., "graham_number", "golden_cross", "consistent_compounders")',
    },
    strategy_name: {
      type: "string",
      description: "Strategy name to search for (if exact ID not known)",
    },
    filters: {
      type: "array",
      description:
        'Custom filters array: [{ metric, operator, value, source }]. Operators: gt, lt, gte, lte, eq, between. Source: "fundamental" or "technical".',
    },
    logic: {
      type: "string",
      description: 'Filter combination logic: "AND" or "OR"',
      default: "AND",
    },
    scan_type: {
      type: "string",
      description: '"fundamental", "technical", or "combined"',
      default: "fundamental",
    },
    limit: {
      type: "number",
      description: "Max results to return",
      default: 50,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const strategyId = params.strategy_id as string | undefined;
    const strategyName = params.strategy_name as string | undefined;
    const customFilters = params.filters as StrategyFilter[] | undefined;
    const logic = (params.logic as string) || "AND";
    const scanType = (params.scan_type as string) || "fundamental";
    const limit = (params.limit as number) || 50;

    try {
      // Option 1: Run a built-in strategy by ID
      if (strategyId) {
        const builtIn = getStrategyById(strategyId);
        if (!builtIn) {
          // Try searching by name
          const matches = searchStrategies(strategyId);
          if (matches.length > 0) {
            const result = await executeStrategy(matches[0]!, { limit });
            return { success: true, data: result };
          }
          return {
            success: false,
            error: `Strategy "${strategyId}" not found. Available categories: value, growth, momentum, income, quality, technical, combined.`,
          };
        }
        const result = await executeStrategy(builtIn, { limit });
        return { success: true, data: result };
      }

      // Option 2: Search for a built-in by name
      if (strategyName && !customFilters) {
        const matches = searchStrategies(strategyName);
        if (matches.length === 0) {
          return {
            success: false,
            error: `No strategies matching "${strategyName}". Try: ${BUILTIN_STRATEGIES.slice(
              0,
              5,
            )
              .map((s) => s.name)
              .join(", ")}`,
          };
        }
        const result = await executeStrategy(matches[0]!, { limit });
        return {
          success: true,
          data: result,
          metadata: {
            matchedStrategy: matches[0]!.id,
            alternatives: matches
              .slice(1, 5)
              .map((s) => ({ id: s.id, name: s.name })),
          },
        };
      }

      // Option 3: Run custom filters
      if (customFilters && customFilters.length > 0) {
        const customInput: CustomStrategyInput = {
          name: strategyName || "Custom Scan",
          filters: customFilters,
          logic: logic as "AND" | "OR",
          scanType: scanType as "fundamental" | "technical" | "combined",
        };
        const result = await executeStrategy(customInput, { limit });
        return { success: true, data: result };
      }

      return {
        success: false,
        error:
          "Provide either strategy_id, strategy_name, or custom filters array",
      };
    } catch (error) {
      return {
        success: false,
        error: `Strategy execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
