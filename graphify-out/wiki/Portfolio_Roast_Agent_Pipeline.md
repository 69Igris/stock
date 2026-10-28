# Portfolio Roast Agent Pipeline

> 75 nodes

## Key Concepts

- **roast/src/agent.ts** (31 connections) — `packages/roast/src/agent.ts`
- **getVertexAIClient()** (30 connections) — `packages/core/src/gemini/client.ts`
- **roast/src/types.ts** (25 connections) — `packages/roast/src/types.ts`
- **agent-pipeline.ts** (17 connections) — `packages/roast/src/agent-pipeline.ts`
- **generate-scores.ts** (17 connections) — `packages/roast/src/steps/generate-scores.ts`
- **portfolio-query.ts** (16 connections) — `packages/roast/src/lib/portfolio-query.ts`
- **fetch-portfolio.ts** (16 connections) — `packages/roast/src/steps/fetch-portfolio.ts`
- **generate-roast.ts** (16 connections) — `packages/roast/src/steps/generate-roast.ts`
- **processors/roast.ts** (16 connections) — `workers/src/processors/roast.ts`
- **geminiLogger** (14 connections) — `packages/logger/src/index.ts`
- **roast/src/index.ts** (14 connections) — `packages/roast/src/index.ts`
- **RoastJobMessage** (13 connections) — `packages/types/src/pubsub.ts`
- **.buildDeps()** (13 connections) — `packages/roast/src/agent.ts`
- **roast/src/prompts.ts** (13 connections) — `packages/roast/src/prompts.ts`
- **analyze-mf.ts** (13 connections) — `packages/roast/src/steps/analyze-mf.ts`
- **analyze-stocks.ts** (13 connections) — `packages/roast/src/steps/analyze-stocks.ts`
- **processor-boundary-contracts.test.ts** (13 connections) — `workers/__tests__/processors/processor-boundary-contracts.test.ts`
- **parse-llm-json.ts** (12 connections) — `packages/roast/src/lib/parse-llm-json.ts`
- **PortfolioData** (11 connections) — `packages/roast/src/types.ts`
- **parseLLMJson()** (10 connections) — `packages/roast/src/lib/parse-llm-json.ts`
- **processRoast()** (10 connections) — `workers/src/processors/roast.ts`
- **processors/roast-logic.ts** (10 connections) — `workers/src/processors/roast-logic.ts`
- **RoastPipelineDeps** (9 connections) — `packages/roast/src/agent-pipeline.ts`
- **ScoresResult** (9 connections) — `packages/roast/src/types.ts`
- **RoastAgent** (8 connections) — `packages/roast/src/agent.ts`
- *... and 50 more nodes in this community*

## Relationships

- [Gemini Model Registry](Gemini_Model_Registry.md) (10 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (8 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (7 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (7 shared connections)
- [Content and Quiz Generation](Content_and_Quiz_Generation.md) (6 shared connections)
- [Gemini AI Client Integration](Gemini_AI_Client_Integration.md) (5 shared connections)
- [Gemini Filing Analysis](Gemini_Filing_Analysis.md) (5 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Portfolio Roast Scoring](Portfolio_Roast_Scoring.md) (3 shared connections)
- [LLM Prompt Guardrails](LLM_Prompt_Guardrails.md) (3 shared connections)
- [Chat Intent Signal Capture](Chat_Intent_Signal_Capture.md) (3 shared connections)
- [AI Decision Logging Analytics](AI_Decision_Logging_Analytics.md) (3 shared connections)

## Source Files

- `packages/core/src/gemini/client.ts`
- `packages/logger/src/index.ts`
- `packages/roast/src/agent-pipeline.ts`
- `packages/roast/src/agent.ts`
- `packages/roast/src/index.ts`
- `packages/roast/src/lib/parse-llm-json.ts`
- `packages/roast/src/lib/portfolio-query.ts`
- `packages/roast/src/lib/score-utils.ts`
- `packages/roast/src/prompts.ts`
- `packages/roast/src/steps/analyze-mf.ts`
- `packages/roast/src/steps/analyze-stocks.ts`
- `packages/roast/src/steps/assemble-result.ts`
- `packages/roast/src/steps/fetch-portfolio.ts`
- `packages/roast/src/steps/generate-roast.ts`
- `packages/roast/src/steps/generate-scores.ts`
- `packages/roast/src/types.ts`
- `packages/types/src/pubsub.ts`
- `packages/types/src/roast.ts`
- `workers/__tests__/processors/processor-boundary-contracts.test.ts`
- `workers/src/processors/roast-logic.ts`

## Audit Trail

- EXTRACTED: 311 (97%)
- INFERRED: 9 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*