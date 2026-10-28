# LLM Prompt Guardrails

> 44 nodes

## Key Concepts

- **guardrails.ts** (36 connections) — `packages/core/src/gemini/guardrails.ts`
- **guardrails-core.ts** (33 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **validateWithLLMRetry()** (9 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **validateFinanceTopic()** (7 connections) — `packages/core/src/gemini/guardrails.ts`
- **TopicValidationResult** (6 connections) — `packages/types/src/gemini.ts`
- **evaluateFinanceTopic()** (6 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **validateWithLLM()** (6 connections) — `packages/core/src/gemini/guardrails.ts`
- **validateAndSanitize()** (5 connections) — `packages/core/src/gemini/guardrails.ts`
- **guardrailCacheKey()** (4 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **matchBlockedKeywords()** (4 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **matchFinanceKeywords()** (4 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **readGuardrailCache()** (4 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **sanitizeUserInput()** (4 connections) — `packages/core/src/gemini/guardrails.ts`
- **GuardrailCacheEntry** (3 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **cleanupGuardrailCache()** (3 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **exceedsSanitizeLimit()** (3 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **detectPromptInjection()** (3 connections) — `packages/core/src/gemini/guardrails.ts`
- **startCacheCleanup()** (3 connections) — `packages/core/src/gemini/guardrails.ts`
- **backoffDelay()** (2 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **buildLLMValidationResult()** (2 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **detectPromptInjection()** (2 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **filterUnsafeContent()** (2 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **getBlockedKeywords()** (2 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **getFinanceKeywords()** (2 connections) — `packages/core/src/gemini/guardrails-core.ts`
- **isRateLimitError()** (2 connections) — `packages/core/src/gemini/guardrails-core.ts`
- *... and 19 more nodes in this community*

## Relationships

- [Gemini Model Registry](Gemini_Model_Registry.md) (12 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (3 shared connections)
- [Portfolio Roast Agent Pipeline](Portfolio_Roast_Agent_Pipeline.md) (3 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)
- [Gemini AI Client Integration](Gemini_AI_Client_Integration.md) (1 shared connections)

## Source Files

- `packages/core/src/gemini/guardrails-core.ts`
- `packages/core/src/gemini/guardrails.ts`
- `packages/types/src/gemini.ts`

## Audit Trail

- EXTRACTED: 103 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*