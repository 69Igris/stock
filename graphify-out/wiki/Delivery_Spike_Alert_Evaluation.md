# Delivery Spike Alert Evaluation

> 52 nodes

## Key Concepts

- **alert-evaluator-logic.ts** (61 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **alert-evaluator-logic.test.ts** (32 connections) — `workers/__tests__/processors/alert-evaluator-logic.test.ts`
- **evaluateFiiFlowStreak()** (9 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **utcDay()** (9 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **evaluateDeliverySpike()** (7 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **evaluateFlagTransition()** (7 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **evaluateInsiderCluster()** (7 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **evaluateMwplHigh()** (6 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **evaluatePledgeIncrease()** (6 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **numberOption()** (6 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **detectFlagTransitions()** (5 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **detectFlowStreaks()** (5 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **distinctDaysAsc()** (5 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **shouldSuppressRepeat()** (5 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **stringArrayOption()** (4 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **AlertEvent** (3 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **meanDeliveryPct()** (3 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **quarterEndDate()** (3 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **DeliveryBarLite** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **FlowRowLite** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **InsiderEventLite** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **MwplRowLite** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **ShareholdingRowLite** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **StockFlagRowLite** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **aug()** (2 connections) — `workers/__tests__/processors/alert-evaluator-logic.test.ts`
- *... and 27 more nodes in this community*

## Relationships

- [Alert Evaluation Engine](Alert_Evaluation_Engine.md) (20 shared connections)
- [Alert Delivery Evaluation Logic](Alert_Delivery_Evaluation_Logic.md) (7 shared connections)
- [Financial Filing Aggregation](Financial_Filing_Aggregation.md) (3 shared connections)
- [Stock Surveillance Flags](Stock_Surveillance_Flags.md) (2 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)

## Source Files

- `workers/__tests__/processors/alert-evaluator-logic.test.ts`
- `workers/src/processors/alert-evaluator-logic.ts`

## Audit Trail

- EXTRACTED: 132 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*