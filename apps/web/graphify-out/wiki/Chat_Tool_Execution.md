# Chat Tool Execution

> 54 nodes

## Key Concepts

- **chat-tools/index.ts** (35 connections) — `lib/chat-tools/index.ts`
- **output-validator.ts** (17 connections) — `lib/chat-tools/output-validator.ts`
- **getTool()** (13 connections) — `lib/chat-tools/registry.ts`
- **chat-tools/executor.ts** (13 connections) — `lib/chat-tools/executor.ts`
- **input-validator.ts** (12 connections) — `lib/chat-tools/input-validator.ts`
- **executor.test.ts** (12 connections) — `__tests__/chat-tools/executor.test.ts`
- **validateOutput()** (11 connections) — `lib/chat-tools/output-validator.ts`
- **output-validator-logic.ts** (11 connections) — `lib/chat-tools/output-validator-logic.ts`
- **input-validator.test.ts** (10 connections) — `__tests__/chat-tools/input-validator.test.ts`
- **factCheckNumbers()** (9 connections) — `lib/chat-tools/output-validator-logic.ts`
- **extractAndValidateParams()** (9 connections) — `lib/chat-tools/param-extractor.ts`
- **param-extractor.ts** (9 connections) — `lib/chat-tools/param-extractor.ts`
- **IntentMatch** (8 connections) — `lib/chat-tools/intent-mapper.ts`
- **executeTool()** (8 connections) — `lib/chat-tools/executor.ts`
- **executeConfirmedTool()** (7 connections) — `lib/chat-tools/executor.ts`
- **validateInput()** (7 connections) — `lib/chat-tools/input-validator.ts`
- **generateConfirmation()** (6 connections) — `lib/chat-tools/executor-logic.ts`
- **sanitizeToolError()** (6 connections) — `lib/chat-tools/executor-logic.ts`
- **detectDisclaimers()** (5 connections) — `lib/chat-tools/output-validator-logic.ts`
- **filterUnsafeContent()** (5 connections) — `lib/chat-tools/output-validator-logic.ts`
- **validateParamsAgainstSchema()** (5 connections) — `lib/chat-tools/param-extractor-logic.ts`
- **executor-logic.ts** (5 connections) — `lib/chat-tools/executor-logic.ts`
- **input-validator-logic.ts** (5 connections) — `lib/chat-tools/input-validator-logic.ts`
- **param-extractor-logic.ts** (5 connections) — `lib/chat-tools/param-extractor-logic.ts`
- **output-validator.test.ts** (5 connections) — `__tests__/chat-tools/output-validator.test.ts`
- *... and 29 more nodes in this community*

## Relationships

- [Intent Mapping and Classification](Intent_Mapping_and_Classification.md) (14 shared connections)
- [Chat Narrative Routing](Chat_Narrative_Routing.md) (12 shared connections)
- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (9 shared connections)
- [Tool Execution API](Tool_Execution_API.md) (5 shared connections)
- [Research Tiers Classifier](Research_Tiers_Classifier.md) (4 shared connections)
- [Flash Response Handler](Flash_Response_Handler.md) (4 shared connections)
- [Tool Registry Metadata](Tool_Registry_Metadata.md) (3 shared connections)
- [Persona Selector Prompts](Persona_Selector_Prompts.md) (3 shared connections)
- [Subscription and Broker Requests](Subscription_and_Broker_Requests.md) (1 shared connections)

## Source Files

- `__tests__/chat-tools/executor-edge-cases.test.ts`
- `__tests__/chat-tools/executor.test.ts`
- `__tests__/chat-tools/input-validator.test.ts`
- `__tests__/chat-tools/output-validator.test.ts`
- `__tests__/chat-tools/param-extractor.test.ts`
- `lib/chat-tools/executor-logic.ts`
- `lib/chat-tools/executor.ts`
- `lib/chat-tools/index.ts`
- `lib/chat-tools/input-validator-logic.ts`
- `lib/chat-tools/input-validator.ts`
- `lib/chat-tools/intent-mapper.ts`
- `lib/chat-tools/output-validator-logic.ts`
- `lib/chat-tools/output-validator.ts`
- `lib/chat-tools/param-extractor-logic.ts`
- `lib/chat-tools/param-extractor.ts`
- `lib/chat-tools/registry.ts`

## Audit Trail

- EXTRACTED: 175 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*