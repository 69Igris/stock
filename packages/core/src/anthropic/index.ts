/** Anthropic Claude — MONEY-506 slice + MONEY-626 router (multi-model, gated). */
export {
  claudeGenerate,
  claudeStreamText,
  getAnthropicClient,
  resetAnthropicClient,
  isClaudeConfigured,
  CLAUDE_SONNET_ID,
  type ClaudeGenerateParams,
  type ClaudeGenerateResult,
} from "./client";
export {
  getClaudeCompatModel,
  toGeminiCompatResult,
  promptFromCompatRequest,
  type ClaudeCompatOptions,
} from "./compat";
export {
  getClaudeAllowedEmails,
  isClaudeAllowedForEmail,
  isClaudeAvailableForEmail,
} from "./access";
