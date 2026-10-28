# Alert Delivery Evaluation Logic

> 15 nodes

## Key Concepts

- **alert-evaluator-run-verdict.test.ts** (15 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- **isSilentDelivery()** (5 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **undeliverableChannels()** (5 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **AlertRunTotals** (4 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **judgeAlertRun()** (4 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **wantedChannels()** (3 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **AlertEvaluatorResult** (2 connections) — `workers/src/processors/alert-evaluator.ts`
- **blankComments()** (2 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- **spaces()** (2 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- **DELIVERABLE_CHANNELS** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **clean** (1 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- **PROC** (1 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- **PROC_RAW** (1 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- **ROUTE** (1 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- **ROUTE_RAW** (1 connections) — `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`

## Relationships

- [Alert Evaluation Engine](Alert_Evaluation_Engine.md) (8 shared connections)
- [Delivery Spike Alert Evaluation](Delivery_Spike_Alert_Evaluation.md) (7 shared connections)
- [Jobs Authentication Middleware](Jobs_Authentication_Middleware.md) (2 shared connections)

## Source Files

- `workers/__tests__/processors/alert-evaluator-run-verdict.test.ts`
- `workers/src/processors/alert-evaluator-logic.ts`
- `workers/src/processors/alert-evaluator.ts`

## Audit Trail

- EXTRACTED: 33 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*