# Chat Narrative Routing

> 55 nodes

## Key Concepts

- **chat/route.ts** (91 connections) — `app/api/chat/route.ts`
- **POST()** (52 connections) — `app/api/chat/route.ts`
- **turn-context.ts** (21 connections) — `lib/chat-tools/turn-context.ts`
- **chat/route-logic.ts** (10 connections) — `app/api/chat/route-logic.ts`
- **turn-context.test.ts** (10 connections) — `__tests__/chat-tools/turn-context.test.ts`
- **chat-stream.ts** (8 connections) — `lib/chat/chat-stream.ts`
- **buildCreditPaywallBlocks()** (7 connections) — `app/api/chat/route-logic.ts`
- **classification-logger.ts** (7 connections) — `lib/chat-tools/classification-logger.ts`
- **creditPaywallTitle()** (6 connections) — `app/api/chat/route-logic.ts`
- **deriveScreenerTurnState()** (6 connections) — `lib/chat-tools/turn-context.ts`
- **loadPriorTurnContext()** (6 connections) — `lib/chat-tools/turn-context.ts`
- **chat-narrative-gate.test.ts** (6 connections) — `__tests__/api/chat-narrative-gate.test.ts`
- **ConversationState** (5 connections) — `lib/chat-tools/turn-context.ts`
- **shouldRunToolNarrative()** (5 connections) — `app/api/chat/route-logic.ts`
- **extractScreenerRows()** (5 connections) — `lib/chat-tools/turn-context.ts`
- **saveTurnContext()** (5 connections) — `lib/chat-tools/turn-context.ts`
- **chat-credit-paywall.test.ts** (5 connections) — `__tests__/api/chat-credit-paywall.test.ts`
- **chat-stream.test.ts** (5 connections) — `__tests__/chat/chat-stream.test.ts`
- **buildToolNarrativeFallbackBlocks()** (4 connections) — `app/api/chat/route-logic.ts`
- **refundAIQuery()** (4 connections) — `lib/actions/subscription.ts`
- **parseSSEChunks()** (4 connections) — `lib/chat/chat-stream.ts`
- **buildConfirmFields()** (4 connections) — `lib/chat/confirm-config.ts`
- **mapStyleToMode()** (4 connections) — `lib/chat/research-style.ts`
- **classifyMisclassificationSignals()** (4 connections) — `lib/chat-tools/classification-logger.ts`
- **detectMisclassificationSignal()** (4 connections) — `lib/chat-tools/classification-logger.ts`
- *... and 30 more nodes in this community*

## Relationships

- [Chat Tool Execution](Chat_Tool_Execution.md) (12 shared connections)
- [Persona Selector Prompts](Persona_Selector_Prompts.md) (10 shared connections)
- [Flash Response Handler](Flash_Response_Handler.md) (10 shared connections)
- [Research Tiers Classifier](Research_Tiers_Classifier.md) (10 shared connections)
- [Chat History Context](Chat_History_Context.md) (9 shared connections)
- [Screener Table Blocks](Screener_Table_Blocks.md) (8 shared connections)
- [RAG Context Retrieval](RAG_Context_Retrieval.md) (7 shared connections)
- [Tool Narration Generators](Tool_Narration_Generators.md) (5 shared connections)
- [AI Description Generators](AI_Description_Generators.md) (5 shared connections)
- [Action Parameter Detection](Action_Parameter_Detection.md) (5 shared connections)
- [Intent Mapping and Classification](Intent_Mapping_and_Classification.md) (5 shared connections)
- [Chat History Views](Chat_History_Views.md) (4 shared connections)

## Source Files

- `__tests__/api/chat-credit-paywall.test.ts`
- `__tests__/api/chat-narrative-gate.test.ts`
- `__tests__/chat-tools/classification-logger.test.ts`
- `__tests__/chat-tools/research-style-mapping.test.ts`
- `__tests__/chat-tools/turn-context-turnmeta.test.ts`
- `__tests__/chat-tools/turn-context.test.ts`
- `__tests__/chat/chat-stream.test.ts`
- `app/api/chat/route-logic.ts`
- `app/api/chat/route.ts`
- `lib/actions/subscription.ts`
- `lib/chat-tools/classification-logger.ts`
- `lib/chat-tools/turn-context.ts`
- `lib/chat/chat-stream.ts`
- `lib/chat/confirm-config.ts`
- `lib/chat/research-style.ts`

## Audit Trail

- EXTRACTED: 238 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*