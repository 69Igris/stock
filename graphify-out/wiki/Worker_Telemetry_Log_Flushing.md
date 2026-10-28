# Worker Telemetry Log Flushing

> 36 nodes

## Key Concepts

- **initJobTelemetry()** (36 connections) — `workers/src/lib/job-telemetry.ts`
- **job-telemetry.ts** (34 connections) — `workers/src/lib/job-telemetry.ts`
- **log-boundary.ts** (19 connections) — `workers/src/log-boundary.ts`
- **flushMetrics()** (18 connections) — `packages/datadog/src/metrics.ts`
- **log-boundary.test.ts** (11 connections) — `workers/__tests__/log-boundary.test.ts`
- **forwardConsoleToDatadog()** (8 connections) — `workers/src/lib/job-telemetry.ts`
- **installLogRedaction()** (8 connections) — `workers/src/log-boundary.ts`
- **shutdown()** (7 connections) — `workers/src/realtime/main.ts`
- **flushLogs()** (6 connections) — `packages/logger/src/index.ts`
- **shutdown()** (5 connections) — `workers/src/index.ts`
- **flushTelemetry()** (5 connections) — `workers/src/lib/job-telemetry.ts`
- **getState()** (4 connections) — `workers/src/log-boundary.ts`
- **job-log-delivery.test.ts** (4 connections) — `workers/__tests__/job-log-delivery.test.ts`
- **flushOnExit()** (3 connections) — `workers/src/lib/job-telemetry.ts`
- **stopPullSubscribers()** (3 connections) — `workers/src/lib/pull-subscriber.ts`
- **isLogRedactionInstalled()** (3 connections) — `workers/src/log-boundary.ts`
- **setConsoleForwarder()** (3 connections) — `workers/src/log-boundary.ts`
- **uninstallLogRedaction()** (3 connections) — `workers/src/log-boundary.ts`
- **flushJobTelemetry()** (2 connections) — `workers/src/lib/job-telemetry.ts`
- **safeStringify()** (2 connections) — `workers/src/lib/job-telemetry.ts`
- **BoundaryState** (1 connections) — `workers/src/log-boundary.ts`
- **ConsoleFn** (1 connections) — `workers/src/log-boundary.ts`
- **ConsoleForwarder** (1 connections) — `workers/src/log-boundary.ts`
- **StatefulGlobal** (1 connections) — `workers/src/log-boundary.ts`
- **WrappedMethod** (1 connections) — `workers/src/log-boundary.ts`
- *... and 11 more nodes in this community*

## Relationships

- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (10 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (8 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (8 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (7 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (7 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (5 shared connections)
- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (5 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (5 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (3 shared connections)
- [Corporate Actions Windows](Corporate_Actions_Windows.md) (3 shared connections)
- [Bond Trade Data Processing](Bond_Trade_Data_Processing.md) (3 shared connections)
- [Feed Backfill Logic](Feed_Backfill_Logic.md) (3 shared connections)

## Source Files

- `packages/datadog/src/metrics.ts`
- `packages/logger/src/index.ts`
- `workers/CLAUDE.md`
- `workers/__tests__/job-log-delivery.test.ts`
- `workers/__tests__/log-boundary.test.ts`
- `workers/src/index.ts`
- `workers/src/lib/job-telemetry.ts`
- `workers/src/lib/pull-subscriber.ts`
- `workers/src/log-boundary.ts`
- `workers/src/realtime/main.ts`

## Audit Trail

- EXTRACTED: 144 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*