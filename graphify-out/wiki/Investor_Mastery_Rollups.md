# Investor Mastery Rollups

> 49 nodes

## Key Concepts

- **processors/investor-rollup.ts** (36 connections) — `workers/src/processors/investor-rollup.ts`
- **investor-rollup-logic.ts** (36 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **rollupUser()** (11 connections) — `workers/src/processors/investor-rollup.ts`
- **clamp01()** (9 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **derivePortfolioBehavior()** (8 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **buildInsights()** (7 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **driftProfile()** (7 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **finite()** (7 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **processInvestorRollup()** (7 connections) — `workers/src/processors/investor-rollup.ts`
- **decayStaleMastery()** (6 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **swapInsight()** (4 connections) — `workers/src/processors/investor-rollup.ts`
- **decayUserMastery()** (3 connections) — `workers/src/processors/investor-rollup.ts`
- **driftToward()** (3 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **glowFromPKnown()** (3 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **hhi()** (3 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **pct()** (3 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **positionNetValue()** (3 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **tradeValue()** (3 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **reprojectFire()** (3 connections) — `workers/src/processors/investor-rollup.ts`
- **DerivedBehaviorSnapshot** (2 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **ProfileState** (2 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **ResearchAggregate** (2 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **RollupHolding** (2 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **RollupMutualFund** (2 connections) — `workers/src/processors/investor-rollup-logic.ts`
- **RollupPosition** (2 connections) — `workers/src/processors/investor-rollup-logic.ts`
- *... and 24 more nodes in this community*

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [AI Decision Logging Analytics](AI_Decision_Logging_Analytics.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Bayesian Knowledge Tracing Mastery](Bayesian_Knowledge_Tracing_Mastery.md) (3 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `@usemoney/core/investor/types`
- `workers/src/processors/investor-rollup-logic.ts`
- `workers/src/processors/investor-rollup.ts`

## Audit Trail

- EXTRACTED: 111 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*