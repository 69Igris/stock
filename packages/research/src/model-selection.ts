/**
 * Research synthesizer/validator model selection.
 *
 * MONEY-587: the run_research publisher threads the user-chosen model id
 * through `ResearchJobMessage.model` → agent → synthesis task params; this
 * helper turns that id into a concrete model instance.
 *
 * MONEY-626 (Claude router): routing is now MODEL-DRIVEN, not skill-driven.
 * `getGeminiModelById` (in @usemoney/core/gemini) routes ANY Anthropic id to
 * the Claude compat model (with a lazy Gemini fallback); a Gemini id resolves
 * to Gemini. So this helper just forwards the resolved id — Claude vs Gemini
 * is decided by which id the publisher chose. The founder allowlist is
 * enforced at PUBLISH time on the web side (`resolveResearchModel(...,
 * claudeAllowed)`), so a non-allowlisted user's run can never carry a Claude
 * id into the worker. Gemini stays the default for everyone.
 *
 * Safety (unchanged):
 *   - An omitted / unknown / env-gated id → the advanced config (2.5-pro),
 *     preserving the prior behaviour and never handing a 404-ing id to the
 *     backend.
 */

import {
  getGeminiModel,
  getGeminiModelById,
  isModelAvailable,
} from "@usemoney/core/gemini";

/**
 * The concrete model instance, derived from the core helper's return type so
 * the research package doesn't need a direct dependency on the underlying
 * SDK for the annotation. (Anthropic ids return the Claude compat model,
 * which satisfies the same shape.)
 */
type ResearchGenerativeModel = ReturnType<typeof getGeminiModel>;

/**
 * Resolve a model instance for a research synthesis/validation step. Honors
 * the publisher-chosen id when usable (Gemini OR Claude — see module note),
 * else falls back to the advanced Gemini config (2.5-pro).
 *
 * @param modelId - registry model id forwarded from the publisher, or
 *   undefined when the caller had no preference.
 */
export function getResearchModel(
  modelId: string | undefined,
): ResearchGenerativeModel {
  if (modelId && isModelAvailable(modelId)) {
    return getGeminiModelById(modelId);
  }
  // No preference, unknown id, or env-gated → safe advanced default.
  return getGeminiModel("advanced");
}
