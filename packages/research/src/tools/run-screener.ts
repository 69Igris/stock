/**
 * Run Screener - Chat Tool
 *
 * Enables natural language stock screening via the chat interface.
 * Supports both pre-built strategies and custom filter combinations.
 *
 * Examples:
 * - "Find undervalued large caps" → value_investing strategy
 * - "Stocks with RSI below 30" → custom technical filter
 * - "Run momentum strategy" → pre-built momentum strategy
 */

import {
  runScreener,
  runStrategy,
  findUnavailableFields,
  type ScreenerFilter,
  type ScreenerStrategy,
} from "@usemoney/core/screener/engine";
import {
  findStrategy,
  listStrategiesByCategory,
  ALL_STRATEGIES,
} from "@usemoney/core/screener/strategies";
import {
  BUILTIN_STRATEGIES,
  getStrategyById,
  searchStrategies,
  type BuiltInStrategy,
  type StrategyFilter,
} from "../strategies/builtin-strategies";

/**
 * Bridge a research `BuiltInStrategy` (the richer ~120-strategy library that
 * the agent/prompts advertise, keyed by ids such as "low_debt_high_roe") into
 * a core `ScreenerStrategy` so it can run through the same `runStrategy` path
 * and produce the identical `strategy_result` shape.
 *
 * The core `ALL_STRATEGIES` list only carries a ~28-strategy subset, so ids
 * that exist solely in `BUILTIN_STRATEGIES` previously failed with
 * `Strategy "<id>" not found`. This converter keeps a single resolution point.
 */
function builtinToScreenerStrategy(builtin: BuiltInStrategy): ScreenerStrategy {
  const filters: ScreenerFilter[] = builtin.filters
    .filter(
      (f: StrategyFilter) =>
        Boolean(f.metric) && Boolean(f.operator) && f.value !== undefined,
    )
    .map((f: StrategyFilter) => ({
      field: f.metric,
      // MONEY-612: the core engine now supports gte/lte natively, so pass the
      // operator straight through instead of the old lossy gte→gt / lte→lt
      // collapse that excluded boundary values.
      operator: f.operator as ScreenerFilter["operator"],
      value:
        f.operator === "between" && f.value2 !== undefined
          ? ([f.value, f.value2] as [number, number])
          : f.value,
    }));

  return {
    id: builtin.id,
    name: builtin.name,
    description: builtin.description,
    category: builtin.category,
    filters,
    source: "builtin",
  };
}

/**
 * Resolve a strategy by id/name across BOTH registries: the core
 * `findStrategy` first (preserves existing behaviour), then the research
 * `BUILTIN_STRATEGIES` (exact id, then fuzzy name/tag search). Returns a core
 * `ScreenerStrategy` ready for `runStrategy`, or undefined if nothing matches.
 */
function resolveStrategy(query: string): ScreenerStrategy | undefined {
  const core = findStrategy(query);
  if (core) return core;

  const lower = query.toLowerCase();
  const builtin =
    getStrategyById(lower) ||
    getStrategyById(query) ||
    searchStrategies(query)[0];
  return builtin ? builtinToScreenerStrategy(builtin) : undefined;
}

export interface RunScreenerParams {
  /** Natural language screening query (parsed into strategy/filters) */
  query?: string;
  /** Pre-built strategy name or ID */
  strategy?: string;
  /** Custom filters (used when no strategy is specified) */
  filters?: ScreenerFilter[];
  /** Exchange filter */
  exchange?: string;
  /** Index filter (e.g., "NIFTY 50", "SENSEX") */
  indexFilter?: string;
  /** Max results */
  limit?: number;
  /** Sort field */
  sortBy?: string;
  /** List available strategies by category */
  listStrategies?: string;
}

/** Human label for a StockRatios column, used in the empty-state message. */
const FIELD_LABELS: Record<string, string> = {
  debtToEquity: "debt-to-equity",
  currentRatio: "current ratio",
  interestCoverage: "interest coverage",
  pegRatio: "PEG ratio",
  evToEbitda: "EV/EBITDA",
  revenueGrowth: "revenue growth",
  earningsGrowth: "earnings growth",
  grossMargin: "gross margin",
  operatingMargin: "operating margin",
  netMargin: "net margin",
  roa: "return on assets",
};

function labelFor(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * The user-facing sentence for a screen blocked by missing data. Pure, so the
 * wording is unit-testable without a database — the DB-dependent half is
 * `findUnavailableFields`.
 */
export function buildUnavailableMessage(
  unavailable: readonly string[],
): string {
  const labels = unavailable.map(labelFor);
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const isAre = labels.length === 1 ? "isn't" : "aren't";

  return (
    `This screen filters on ${list}, which ${isAre} in our data yet — ` +
    `so it can't return matches regardless of the market. ` +
    `Try a screen based on P/E, P/B, ROE, ROCE, market cap or dividend yield.`
  );
}

/**
 * MONEY-1095 item 6 — explain an empty screen when the cause is missing data
 * rather than a genuinely empty market.
 *
 * A filter on an all-null column matches nothing, so the user saw "No stocks
 * matched your criteria" — indistinguishable from "no such stocks exist". The
 * ratios feed supplies 7 of 23 columns, so e.g. `value_investing` (pe < 15,
 * pb < 2, roe > 15, debtToEquity < 1) is annihilated by its last predicate:
 * the first three match hundreds of rows each, the fourth matches none.
 *
 * Returns undefined when every filtered field HAS data — then zero really does
 * mean zero and the ordinary empty-state is correct.
 */
async function explainEmptyResult(
  filters: readonly ScreenerFilter[],
): Promise<{ unavailableFields: string[]; message: string } | undefined> {
  const fields = filters.map((f) => f.field).filter(Boolean);
  if (fields.length === 0) return undefined;

  const unavailable = await findUnavailableFields(fields);
  if (unavailable.length === 0) return undefined;

  return {
    unavailableFields: unavailable,
    message: buildUnavailableMessage(unavailable),
  };
}

export async function executeRunScreener(params: RunScreenerParams) {
  // If query is provided but no strategy/filters, parse NL query
  if (
    params.query &&
    !params.strategy &&
    (!params.filters || params.filters.length === 0)
  ) {
    const { parseQueryToFilters } = await import("./query-to-filters");
    const parsed = parseQueryToFilters(params.query);

    if (parsed.strategy) {
      params.strategy = parsed.strategy;
    }
    if (parsed.filters.length > 0) {
      params.filters = parsed.filters;
    }
    if (parsed.index && !params.indexFilter) {
      params.indexFilter = parsed.index;
    }
    // If NL parsing found nothing, try strategy fuzzy match on the raw query
    if (!params.strategy && (!params.filters || params.filters.length === 0)) {
      const directMatch = resolveStrategy(params.query);
      if (directMatch) {
        params.strategy = directMatch.id;
      }
    }
    // If we have an index but no filters, that's valid - list all stocks in the index
    // Still nothing at all? Return helpful error
    if (
      !params.strategy &&
      (!params.filters || params.filters.length === 0) &&
      !params.indexFilter &&
      params.listStrategies === undefined
    ) {
      return {
        success: false,
        error: "Could not parse screening criteria from your query",
        message: `I couldn't extract specific filters from "${params.query}". Try being more specific, e.g. "stocks with RSI < 30" or "golden cross stocks". Use /screener list to see available strategies.`,
      };
    }
  }

  // List strategies mode
  if (params.listStrategies !== undefined) {
    const category = params.listStrategies || undefined;
    const strategies = listStrategiesByCategory(category);
    return {
      success: true,
      type: "strategy_list" as const,
      data: strategies.map((s: ScreenerStrategy) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        filterCount: s.filters.length,
      })),
      total: strategies.length,
      message: `Found ${strategies.length} strategies${category ? ` in category "${category}"` : ""}`,
    };
  }

  // Run pre-built strategy
  if (params.strategy) {
    const matched = resolveStrategy(params.strategy);
    if (!matched) {
      // Fuzzy match attempt across BOTH registries (core + research builtin)
      const q = params.strategy!.toLowerCase();
      const coreSuggestions = ALL_STRATEGIES.filter(
        (s: ScreenerStrategy) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      ).map((s: ScreenerStrategy) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      }));
      const builtinSuggestions = BUILTIN_STRATEGIES.filter(
        (s: BuiltInStrategy) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      ).map((s: BuiltInStrategy) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      }));
      const seen = new Set<string>();
      const suggestions = [...coreSuggestions, ...builtinSuggestions]
        .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
        .slice(0, 5);

      return {
        success: false,
        error: `Strategy "${params.strategy}" not found`,
        suggestions,
        message:
          suggestions.length > 0
            ? `Did you mean one of these? ${suggestions.map((s) => s.name).join(", ")}`
            : "No matching strategies found. Use /screener list to see all available strategies.",
      };
    }

    const results = await runStrategy(matched, {
      exchange: params.exchange,
      limit: params.limit,
      sortBy: params.sortBy,
      indexFilter: params.indexFilter,
    });

    const explained =
      results.length === 0
        ? await explainEmptyResult(matched.filters)
        : undefined;

    return {
      success: true,
      type: "strategy_result" as const,
      strategy: {
        id: matched.id,
        name: matched.name,
        description: matched.description,
      },
      data: results,
      total: results.length,
      ...(explained ? { unavailableFields: explained.unavailableFields } : {}),
      message: explained
        ? `${matched.name} can't run yet. ${explained.message}`
        : `${matched.name}: Found ${results.length} matching stocks`,
    };
  }

  // Run custom filters
  if (params.filters && params.filters.length > 0) {
    const results = await runScreener(params.filters, {
      exchange: params.exchange,
      limit: params.limit,
      sortBy: params.sortBy,
      indexFilter: params.indexFilter,
    });

    const explained =
      results.length === 0
        ? await explainEmptyResult(params.filters)
        : undefined;

    return {
      success: true,
      type: "custom_result" as const,
      data: results,
      total: results.length,
      filters: params.filters,
      ...(explained ? { unavailableFields: explained.unavailableFields } : {}),
      message: explained
        ? `Custom screen can't run yet. ${explained.message}`
        : `Custom screen: Found ${results.length} matching stocks`,
    };
  }

  // Index-only query: list all stocks in the index (no filters needed)
  if (params.indexFilter) {
    // Use a permissive filter (marketCap > 0) to get all stocks, then index filter narrows it
    const results = await runScreener(
      [{ field: "marketCap", operator: "gt", value: 0 }],
      {
        exchange: params.exchange,
        limit: params.limit || 100,
        sortBy: params.sortBy || "marketCap",
        indexFilter: params.indexFilter,
      },
    );

    return {
      success: true,
      type: "index_result" as const,
      data: results,
      total: results.length,
      message: `${params.indexFilter}: ${results.length} stocks`,
    };
  }

  return {
    success: false,
    error: "No strategy or filters provided",
    message:
      "Specify a strategy name or custom filters. Use /screener list to see available strategies.",
  };
}
