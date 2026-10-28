# Research Mode Job Processing

> 19 nodes

## Key Concepts

- **processors/research.ts** (25 connections) — `workers/src/processors/research.ts`
- **processResearch()** (15 connections) — `workers/src/processors/research.ts`
- **processors/research-logic.ts** (14 connections) — `workers/src/processors/research-logic.ts`
- **reconcileBilling()** (6 connections) — `workers/src/processors/research.ts`
- **resolveResearchMode()** (4 connections) — `workers/src/processors/research-logic.ts`
- **toAgentResearchMode()** (4 connections) — `workers/src/processors/research-logic.ts`
- **buildResearchCompleteNotification()** (3 connections) — `workers/src/processors/research-logic.ts`
- **computeResearchHardCeiling()** (3 connections) — `workers/src/processors/research-logic.ts`
- **parseEnvInt()** (3 connections) — `workers/src/processors/research-logic.ts`
- **shouldNotifyResearch()** (3 connections) — `workers/src/processors/research-logic.ts`
- **refundResearchCredits()** (3 connections) — `workers/src/processors/research.ts`
- **emitBillingEvent()** (2 connections) — `workers/src/processors/research.ts`
- **ResearchMode** (1 connections) — `workers/src/processors/research-logic.ts`
- **ResearchNotification** (1 connections) — `workers/src/processors/research-logic.ts`
- **@usemoney/core** (1 connections) — `@usemoney/core`
- **@usemoney/services/preferences** (1 connections) — `@usemoney/services/preferences`
- **@usemoney/services** (1 connections) — `@usemoney/services`
- **RESEARCH_CEILING_BUFFER_MS** (1 connections) — `workers/src/processors/research-logic.ts`
- **RESEARCH_HARD_CEILING_MS** (1 connections) — `workers/src/processors/research-logic.ts`

## Relationships

- [Research Agent Planning](Research_Agent_Planning.md) (6 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (4 shared connections)
- [Portfolio Roast Agent Pipeline](Portfolio_Roast_Agent_Pipeline.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (2 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (2 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [Composer Preferences Configuration](Composer_Preferences_Configuration.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Technical Market Indicators](Technical_Market_Indicators.md) (1 shared connections)
- [Symbol Resolution and Skills](Symbol_Resolution_and_Skills.md) (1 shared connections)

## Source Files

- `@usemoney/core`
- `@usemoney/services`
- `@usemoney/services/preferences`
- `workers/src/processors/research-logic.ts`
- `workers/src/processors/research.ts`

## Audit Trail

- EXTRACTED: 57 (97%)
- INFERRED: 2 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*