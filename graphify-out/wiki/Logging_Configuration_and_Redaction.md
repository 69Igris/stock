# Logging Configuration and Redaction

> 50 nodes

## Key Concepts

- **log-redaction.ts** (30 connections) — `packages/utils/src/log-redaction.ts`
- **src/config.ts** (15 connections) — `packages/logger/src/config.ts`
- **log-redaction.test.ts** (14 connections) — `packages/utils/__tests__/log-redaction.test.ts`
- **walkObject()** (12 connections) — `packages/utils/src/log-redaction.ts`
- **redactError()** (9 connections) — `packages/utils/src/log-redaction.ts`
- **config-redaction.test.ts** (9 connections) — `packages/logger/__tests__/config-redaction.test.ts`
- **redactSensitive()** (8 connections) — `packages/utils/src/log-redaction.ts`
- **walk()** (7 connections) — `packages/utils/src/log-redaction.ts`
- **maskSensitiveText()** (6 connections) — `packages/utils/src/log-redaction.ts`
- **walkValue()** (5 connections) — `packages/utils/src/log-redaction.ts`
- **mapToRecord()** (4 connections) — `packages/utils/src/log-redaction.ts`
- **readName()** (4 connections) — `packages/utils/src/log-redaction.ts`
- **redactEntry()** (4 connections) — `packages/utils/src/log-redaction.ts`
- **describeBinary()** (3 connections) — `packages/utils/src/log-redaction.ts`
- **headersToRecord()** (3 connections) — `packages/utils/src/log-redaction.ts`
- **readMessage()** (3 connections) — `packages/utils/src/log-redaction.ts`
- **safeString()** (3 connections) — `packages/utils/src/log-redaction.ts`
- **walkPlain()** (3 connections) — `packages/utils/src/log-redaction.ts`
- **pinoConfig** (3 connections) — `packages/logger/src/config.ts`
- **REDACTED** (3 connections) — `packages/utils/src/log-redaction.ts`
- **SENSITIVE_KEY_PATTERN** (3 connections) — `packages/utils/src/log-redaction.ts`
- **redacting()** (2 connections) — `packages/logger/src/config.ts`
- **redactLogObject()** (2 connections) — `packages/logger/src/config.ts`
- **captureLines()** (2 connections) — `packages/logger/__tests__/config-redaction.test.ts`
- **captureOne()** (2 connections) — `packages/logger/__tests__/config-redaction.test.ts`
- *... and 25 more nodes in this community*

## Relationships

- [Application Logging Framework](Application_Logging_Framework.md) (5 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)

## Source Files

- `packages/logger/__tests__/config-redaction.test.ts`
- `packages/logger/src/config.ts`
- `packages/utils/__tests__/log-redaction.test.ts`
- `packages/utils/src/log-redaction.ts`

## Audit Trail

- EXTRACTED: 99 (98%)
- INFERRED: 2 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*