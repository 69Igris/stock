/**
 * Gemini LLM Integration Module
 *
 * This module provides Vertex AI / Gemini integration for the UseMoney platform.
 * It includes client setup, model configuration, guardrails, prompts, and pricing.
 *
 * Note: Database tracking (token usage) should be implemented in the app layer
 * using the pricing utilities exported here.
 */

// Client - Vertex AI client setup
export {
  getVertexAIClient,
  withVertexAI,
  isGeminiEnabled,
  testVertexAIConnection,
  resetVertexAIClient,
} from "./client";

// Models - Model configuration and generation helpers
export {
  MODEL_CONFIG,
  getGeminiModel,
  getGeminiModelById,
  generateWithRetry,
  generateWithTimeout,
  estimateTokenCount,
  generateWithSafety,
  getModelNameForMode,
} from "./models";

// Guardrails - Content filtering and validation
export {
  validateFinanceTopic,
  filterUnsafeContent,
  detectPromptInjection,
  sanitizeUserInput,
  validateAndSanitize,
  getFinanceKeywords,
  getBlockedKeywords,
  startCacheCleanup,
  stopCacheCleanup,
} from "./guardrails";

// Prompts - System prompts for different pages
export {
  getSystemPrompt,
  getSupportedPages,
  hasCustomPrompt,
  getBaseSystemPrompt,
  formatFireContext,
  formatHoldingsContext,
} from "./prompts";

// MONEY-1274 — the page anchor. Lives here rather than in apps/web because
// `getSystemPrompt` (this package) is the LIVE implementation: an earlier fix
// landed in an apps/web fork of prompts.ts that nothing imported, so the anchor
// never reached a model. That fork is deleted.
export {
  resolvePromptKey,
  parsePageAnchor,
  formatPageAnchor,
  type PageAnchor,
} from "./page-anchor";

// Model Registry - MONEY-229 Phase A
export {
  GEMINI_MODELS,
  REGISTERED_MODEL_IDS,
  DEFAULT_MODEL_FOR_PLAN,
  getModelDefinition,
  getModelPremium,
  isModelAvailableOnPlan,
  isModelAvailable,
  getAvailableGeminiModels,
  getAvailableModelsForUser,
  getPickerModelsForUser,
  isClaudeEntitled,
  getEffectiveCreditCost,
  resolveModelId,
} from "./model-registry";
export type {
  ModelDefinition,
  ModelTier,
  ModelProvider,
} from "./model-registry";

// Topic Classifier - MONEY-295
export {
  classifyTopic,
  shouldRefuse,
  buildRefusalMessage,
} from "./topic-classifier";
export type {
  TopicCategory,
  TopicClassification,
  ClassifierContext,
} from "./topic-classifier";

// Pricing - Cost calculation utilities
export {
  GEMINI_PRICING,
  calculateCost,
  convertToINR,
  getUsdToInrRate,
  getModelForQueryType,
  estimateQueryCost,
  getModelPricing,
  getAllModelPricing,
  isFlashModel,
  isProModel,
} from "./pricing";

// Re-export types from @usemoney/types for convenience
export type {
  QueryMode,
  GenerationConfig,
  ModelConfig,
  TopicValidationResult,
  PageContext,
  ActionType,
  DetectedAction,
  ActionValidationResult,
  ChatRequest,
  ChatResponse,
  TokenUsageData,
  ModelPricing,
  GeminiResult,
  CreateScenarioParams,
  ModifyScenarioParams,
  AddStockParams,
  AddMutualFundParams,
  RemoveHoldingParams,
  SaveAnalysisParams,
} from "@usemoney/types";
