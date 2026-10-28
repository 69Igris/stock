# Alert Evaluation Engine

> 32 nodes

## Key Concepts

- **processors/alert-evaluator.ts** (53 connections) — `workers/src/processors/alert-evaluator.ts`
- **processAlertEvaluator()** (15 connections) — `workers/src/processors/alert-evaluator.ts`
- **evaluateDataEngineAlert()** (12 connections) — `workers/src/processors/alert-evaluator.ts`
- **notify()** (8 connections) — `workers/src/processors/alert-evaluator.ts`
- **readOr()** (8 connections) — `workers/src/processors/alert-evaluator.ts`
- **getLatestQuote()** (5 connections) — `workers/src/processors/alert-evaluator.ts`
- **FlagObservationLite** (4 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **daysAgo()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **evaluateCorporateAction()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **evaluateEarningsDate()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **evaluateNews()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **evaluatePrice()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **evaluateVolume()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **getFlagObservations()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **getFlowTradingDates()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **resolveInstrumentId()** (4 connections) — `workers/src/processors/alert-evaluator.ts`
- **AlertEvaluatorMessage** (2 connections) — `workers/src/processors/alert-evaluator.ts`
- **RunContext** (2 connections) — `workers/src/processors/alert-evaluator.ts`
- **isWithinCooldown()** (2 connections) — `workers/src/processors/alert-evaluator.ts`
- **DELIVERY_BASELINE_DAYS** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **INSIDER_CLUSTER_WINDOW_DAYS** (2 connections) — `workers/src/processors/alert-evaluator-logic.ts`
- **CorpActionConditions** (1 connections) — `workers/src/processors/alert-evaluator.ts`
- **DataEngineAlertKind** (1 connections) — `workers/src/processors/alert-evaluator.ts`
- **EarningsConditions** (1 connections) — `workers/src/processors/alert-evaluator.ts`
- **NewsConditions** (1 connections) — `workers/src/processors/alert-evaluator.ts`
- *... and 7 more nodes in this community*

## Relationships

- [Delivery Spike Alert Evaluation](Delivery_Spike_Alert_Evaluation.md) (20 shared connections)
- [Alert Delivery Evaluation Logic](Alert_Delivery_Evaluation_Logic.md) (8 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (5 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)

## Source Files

- `workers/src/processors/alert-evaluator-logic.ts`
- `workers/src/processors/alert-evaluator.ts`

## Audit Trail

- EXTRACTED: 101 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*