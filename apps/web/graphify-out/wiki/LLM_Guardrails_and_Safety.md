# LLM Guardrails and Safety

> 24 nodes

## Key Concepts

- **guardrails.ts** (26 connections) — `lib/gemini/guardrails.ts`
- **flashGuardOutput()** (7 connections) — `lib/gemini/guardrails.ts`
- **validateAndSanitize()** (4 connections) — `lib/gemini/guardrails.ts`
- **flashGuardInput()** (3 connections) — `lib/gemini/guardrails.ts`
- **validateFinanceTopic()** (3 connections) — `lib/gemini/guardrails.ts`
- **validateWithLLM()** (3 connections) — `lib/gemini/guardrails.ts`
- **TopicValidationResult** (2 connections) — `lib/gemini/types.ts`
- **detectPromptInjection()** (2 connections) — `lib/gemini/guardrails.ts`
- **hashForCache()** (2 connections) — `lib/gemini/guardrails.ts`
- **parseFlashInputVerdict()** (2 connections) — `lib/gemini/guardrails.ts`
- **parseFlashOutputVerdict()** (2 connections) — `lib/gemini/guardrails.ts`
- **sanitizeUserInput()** (2 connections) — `lib/gemini/guardrails.ts`
- **scanResponseDeterministic()** (2 connections) — `lib/gemini/guardrails.ts`
- **FlashGuardInputResult** (1 connections) — `lib/gemini/guardrails.ts`
- **FlashGuardOutputResult** (1 connections) — `lib/gemini/guardrails.ts`
- **FlashGuardOutputVerdict** (1 connections) — `lib/gemini/guardrails.ts`
- **RawFlashInputVerdict** (1 connections) — `lib/gemini/guardrails.ts`
- **RawFlashOutputVerdict** (1 connections) — `lib/gemini/guardrails.ts`
- **filterUnsafeContent()** (1 connections) — `lib/gemini/guardrails.ts`
- **BLOCKED_KEYWORDS** (1 connections) — `lib/gemini/guardrails.ts`
- **FINANCE_KEYWORDS** (1 connections) — `lib/gemini/guardrails.ts`
- **flashOutputCache** (1 connections) — `lib/gemini/guardrails.ts`
- **guardrailCache** (1 connections) — `lib/gemini/guardrails.ts`
- **Gemini Model Update Summary** (1 connections) — `docs/archive/GEMINI_MODEL_UPDATE.md`

## Relationships

- [Gemini Summarization Client](Gemini_Summarization_Client.md) (4 shared connections)
- [Chat Narrative Routing](Chat_Narrative_Routing.md) (3 shared connections)
- [System Prompt Engineering](System_Prompt_Engineering.md) (2 shared connections)

## Source Files

- `docs/archive/GEMINI_MODEL_UPDATE.md`
- `lib/gemini/guardrails.ts`
- `lib/gemini/types.ts`

## Audit Trail

- EXTRACTED: 40 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*