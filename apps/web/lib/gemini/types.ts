/**
 * Gemini LLM Integration - TypeScript Type Definitions
 *
 * This file contains all the TypeScript interfaces and types used throughout
 * the Gemini integration for type safety and IDE support.
 */

// ============== Query Types ==============

/**
 * Query mode determines which Gemini model to use
 * - fast: Gemini Flash (quick, low-cost responses)
 * - advanced: Gemini Pro (deep analysis with thinking always enabled)
 */
export type QueryMode = "fast" | "advanced";

// ============== Model Configuration ==============

/**
 * Configuration for Gemini model generation
 */
export interface GenerationConfig {
  temperature: number; // Randomness (0-1, higher = more creative)
  topP: number; // Nucleus sampling (0-1)
  topK: number; // Top-K sampling
  maxOutputTokens: number; // Maximum tokens in response
  thinkingConfig?: {
    thinkingBudget: number; // Token budget for thinking process (1024-24576, 0 disables)
  };
}

/**
 * Model configuration for fast and advanced modes
 */
export interface ModelConfig {
  modelName: string;
  enableThinking: boolean;
  generationConfig: GenerationConfig;
}

// ============== Guardrails ==============

/**
 * Result of topic validation
 */
export interface TopicValidationResult {
  isValid: boolean; // Whether query passes validation
  reason?: string; // Reason for rejection (if blocked)
  confidence: number; // Confidence score (0-1)
}

// ============== Page Context ==============

/**
 * Context information about the page where chat is happening
 */
export interface PageContext {
  pagePath: string; // e.g., "/fire", "/holdings", "/analysis"
  userContext?: string; // User's current data (JSON or string)
}

// ============== Actions ==============

/**
 * Types of actions that can be detected in LLM responses
 */
export type ActionType =
  | "create_scenario" // FIRE: Create new scenario
  | "modify_scenario" // FIRE: Modify existing scenario
  | "delete_scenario" // FIRE: Delete scenario
  | "add_stock" // Holdings: Add stock position
  | "add_mutual_fund" // Holdings: Add mutual fund
  | "remove_holding" // Holdings: Remove position
  | "save_analysis"; // Analysis: Save stock analysis

/**
 * Detected action from LLM response with parameters
 */
export interface DetectedAction {
  type: ActionType;
  parameters: Record<string, any>; // Extracted parameters
  confirmationMessage: string; // Message to show in confirmation dialog
}

/**
 * Result of action parameter validation
 */
export interface ActionValidationResult {
  valid: boolean;
  errors?: string[]; // List of validation errors
}

// ============== Chat API ==============

/**
 * Request payload for chat API
 */
export interface ChatRequest {
  message: string; // User's message
  queryType: QueryMode; // fast or advanced
  pagePath: string; // Current page path
  userContext?: string; // Optional user context
}

/**
 * Response from chat API
 */
export interface ChatResponse {
  response: string; // LLM's response (cleaned)
  action?: DetectedAction; // Detected action (if any)
  remaining?: number; // Remaining queries
  queryType: QueryMode; // Query type used
  blocked?: boolean; // Whether query was blocked
}

// ============== Token Usage ==============

/**
 * Token usage information for cost tracking
 */
export interface TokenUsageData {
  userId: string;
  queryType: QueryMode;
  inputTokens: number;
  outputTokens: number;
  duration: number; // milliseconds
  pagePath?: string;
}

/**
 * Pricing information for Gemini models
 */
export interface ModelPricing {
  inputCostPer1M: number; // Cost per 1M input tokens (USD)
  outputCostPer1M: number; // Cost per 1M output tokens (USD)
}

// ============== Error Handling ==============

/**
 * Standard result wrapper for async operations
 */
export interface Result<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============== FIRE Scenario Actions ==============

/**
 * Parameters for creating a FIRE scenario
 */
export interface CreateScenarioParams {
  name: string;
  retirementAge: number;
  currentAge: number;
  currentCorpus: number;
  annualExpense?: number;
  monthlySavings?: number;
  [key: string]: any; // Allow additional params
}

/**
 * Parameters for modifying a FIRE scenario
 */
export interface ModifyScenarioParams {
  name: string;
  [key: string]: any; // Allow any modifiable fields
}

// ============== Holdings Actions ==============

/**
 * Parameters for adding a stock holding
 */
export interface AddStockParams {
  symbol: string;
  quantity: number;
  buyPrice: number;
  buyDate?: string;
  broker?: string;
  [key: string]: any;
}

/**
 * Parameters for adding a mutual fund
 */
export interface AddMutualFundParams {
  schemeName: string;
  units: number;
  nav: number;
  purchaseDate?: string;
  broker?: string;
  [key: string]: any;
}

/**
 * Parameters for removing a holding
 */
export interface RemoveHoldingParams {
  symbol: string;
  broker?: string;
}

// ============== Analysis Actions ==============

/**
 * Parameters for saving stock analysis
 *
 * MONEY-457: `recommendation` is constant "N/A" (was BUY|HOLD|SELL).
 * `targetPrice` and `stopLoss` are deprecated — see the validator in
 * `actions.ts` which rejects them. The schema keeps the optional fields
 * so older clients that still emit them get a clean error instead of a
 * runtime crash. UseMoney is not SEBI-registered as a Research Analyst.
 */
export interface SaveAnalysisParams {
  symbol: string;
  recommendation: "N/A";
  /** @deprecated MONEY-457 — SEBI compliance. Validator rejects. */
  targetPrice?: number;
  /** @deprecated MONEY-457 — SEBI compliance. Validator rejects. */
  stopLoss?: number;
  confidence?: number;
  strengths?: string[];
  weaknesses?: string[];
  commentary?: string;
  [key: string]: any;
}
