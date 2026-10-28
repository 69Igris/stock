# Flash Response Handler

> 42 nodes

## Key Concepts

- **cost-tracker.ts** (20 connections) — `lib/gemini/cost-tracker.ts`
- **cost-tracker-logic.ts** (14 connections) — `lib/gemini/cost-tracker-logic.ts`
- **flash-responder.ts** (13 connections) — `lib/chat-tools/flash-responder.ts`
- **handleFlashQuery()** (10 connections) — `lib/chat-tools/flash-responder.ts`
- **cost-tracker-edge-cases.test.ts** (10 connections) — `__tests__/gemini/cost-tracker-edge-cases.test.ts`
- **trackTokenUsage()** (9 connections) — `lib/gemini/cost-tracker.ts`
- **convertToINR()** (8 connections) — `lib/gemini/cost-tracker.ts`
- **flash-responder-logic.ts** (8 connections) — `lib/chat-tools/flash-responder-logic.ts`
- **cost-tracker.test.ts** (6 connections) — `__tests__/gemini/cost-tracker.test.ts`
- **extractFinancialData()** (5 connections) — `lib/chat-tools/flash-responder-logic.ts`
- **exceedsCostThreshold()** (5 connections) — `lib/gemini/cost-tracker.ts`
- **aggregateUsage()** (5 connections) — `lib/gemini/cost-tracker-logic.ts`
- **metadata-fields.ts** (5 connections) — `lib/chat-tools/metadata-fields.ts`
- **METADATA_FIELDS** (5 connections) — `lib/chat-tools/metadata-fields.ts`
- **handleDefinitionQuery()** (4 connections) — `lib/chat-tools/flash-responder.ts`
- **isDefinitionQuery()** (4 connections) — `lib/chat-tools/flash-responder-logic.ts`
- **calculateCost()** (4 connections) — `lib/gemini/cost-tracker.ts`
- **breakdownByModel()** (4 connections) — `lib/gemini/cost-tracker-logic.ts`
- **exceedsThreshold()** (4 connections) — `lib/gemini/cost-tracker-logic.ts`
- **groupDailyUsage()** (4 connections) — `lib/gemini/cost-tracker-logic.ts`
- **resolveModelName()** (4 connections) — `lib/gemini/cost-tracker-logic.ts`
- **buildFlashUserPrompt()** (4 connections) — `lib/gemini/flash-prompt.ts`
- **flash-prompt.ts** (4 connections) — `lib/gemini/flash-prompt.ts`
- **resolveFlashModelId()** (3 connections) — `lib/chat-tools/flash-responder.ts`
- **getUserTokenUsage()** (3 connections) — `lib/gemini/cost-tracker.ts`
- *... and 17 more nodes in this community*

## Relationships

- [Chat Narrative Routing](Chat_Narrative_Routing.md) (10 shared connections)
- [Chat Tool Execution](Chat_Tool_Execution.md) (4 shared connections)
- [AI Description Generators](AI_Description_Generators.md) (2 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)

## Source Files

- `__tests__/chat-tools/flash-responder.test.ts`
- `__tests__/chat-tools/metadata-fields.test.ts`
- `__tests__/gemini/cost-tracker-edge-cases.test.ts`
- `__tests__/gemini/cost-tracker.test.ts`
- `__tests__/gemini/flash-prompt.test.ts`
- `lib/chat-tools/flash-responder-logic.ts`
- `lib/chat-tools/flash-responder.ts`
- `lib/chat-tools/metadata-fields.ts`
- `lib/gemini/cost-tracker-logic.ts`
- `lib/gemini/cost-tracker.ts`
- `lib/gemini/flash-prompt.ts`

## Audit Trail

- EXTRACTED: 106 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*