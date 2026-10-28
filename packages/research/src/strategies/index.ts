/**
 * Strategy Module - barrel export
 */

export {
  BUILTIN_STRATEGIES,
  getStrategyById,
  getStrategiesByCategory,
  searchStrategies,
  getStrategyCategories,
  type BuiltInStrategy,
  type StrategyFilter,
  type StrategyCategory,
} from "./builtin-strategies";

export {
  executeStrategy,
  type StrategyExecutionResult,
  type StrategyMatchedStock,
  type CustomStrategyInput,
} from "./strategy-executor";

export {
  INVESTMENT_THEMES,
  getAllThemes,
  getThemeById,
  searchThemes,
  getThemesByTimeframe,
  type InvestmentTheme,
  type ThemeStock,
} from "./investment-themes";
