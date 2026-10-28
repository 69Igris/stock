/**
 * @usemoney/roast - Barrel exports
 */

export { RoastAgent } from "./agent";
// MONEY-488: sanitizer for user-facing roast error strings — exported
// so workers/processors can keep the technical exception out of the DB.
// MONEY-543: ROAST_CANCELLED_SENTINEL exported as the single source of
// truth for the cancel-status string the UI keys off.
export {
  sanitizeRoastErrorMessage,
  ROAST_CANCELLED_SENTINEL,
} from "./lib/parse-llm-json";

export type {
  RoastAgentConfig,
  RoastJobMessage,
  PortfolioData,
  StockAnalysisResult,
  MfAnalysisResult,
  ScoresResult,
  RoastContentResult,
} from "./types";
