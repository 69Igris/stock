# Database Package Configuration

> 56 nodes

## Key Concepts

- **login-briefing-logic.ts** (30 connections) — `workers/src/processors/login-briefing-logic.ts`
- **processors/login-briefing.ts** (25 connections) — `workers/src/processors/login-briefing.ts`
- **database/package.json** (13 connections) — `packages/database/package.json`
- **processLoginBriefing()** (11 connections) — `workers/src/processors/login-briefing.ts`
- **scripts** (10 connections) — `packages/database/package.json`
- **describeHoldingFlag()** (6 connections) — `workers/src/processors/login-briefing-logic.ts`
- **buildMarketContextSections()** (5 connections) — `workers/src/processors/login-briefing.ts`
- **buildHoldingFlagsSection()** (5 connections) — `workers/src/processors/login-briefing-logic.ts`
- **buildMarketFlowSection()** (5 connections) — `workers/src/processors/login-briefing-logic.ts`
- **buildPortfolioSection()** (4 connections) — `workers/src/processors/login-briefing-logic.ts`
- **buildTopHoldingsSection()** (4 connections) — `workers/src/processors/login-briefing-logic.ts`
- **buildVolatilitySection()** (4 connections) — `workers/src/processors/login-briefing-logic.ts`
- **computePortfolioSummary()** (4 connections) — `workers/src/processors/login-briefing-logic.ts`
- **shortDate()** (4 connections) — `workers/src/processors/login-briefing-logic.ts`
- **buildMoversSection()** (3 connections) — `workers/src/processors/login-briefing-logic.ts`
- **detectSignificantMovers()** (3 connections) — `workers/src/processors/login-briefing-logic.ts`
- **inr()** (3 connections) — `workers/src/processors/login-briefing-logic.ts`
- **dependencies** (3 connections) — `packages/database/package.json`
- **login-briefing-flag-decode.test.ts** (3 connections) — `workers/__tests__/processors/login-briefing-flag-decode.test.ts`
- **BriefingSection** (2 connections) — `workers/src/processors/login-briefing-logic.ts`
- **HoldingFlagRow** (2 connections) — `workers/src/processors/login-briefing-logic.ts`
- **crore()** (2 connections) — `workers/src/processors/login-briefing-logic.ts`
- **sumBy()** (2 connections) — `workers/src/processors/login-briefing-logic.ts`
- **summarizeNewFlags()** (2 connections) — `workers/src/processors/login-briefing-logic.ts`
- **devDependencies** (2 connections) — `packages/database/package.json`
- *... and 31 more nodes in this community*

## Relationships

- [Database Client and Migrations](Database_Client_and_Migrations.md) (5 shared connections)
- [Financial Filing Aggregation](Financial_Filing_Aggregation.md) (4 shared connections)
- [Research Agent Planning](Research_Agent_Planning.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (1 shared connections)

## Source Files

- `packages/database/package.json`
- `workers/__tests__/processors/login-briefing-flag-decode.test.ts`
- `workers/src/processors/login-briefing-logic.ts`
- `workers/src/processors/login-briefing.ts`

## Audit Trail

- EXTRACTED: 105 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*