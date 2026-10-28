# Dead Letter Queue Consumer

> 31 nodes

## Key Concepts

- **dead-letter-consumer-logic.ts** (32 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **dead-letter-consumer-logic.test.ts** (26 connections) — `workers/__tests__/processors/dead-letter-consumer-logic.test.ts`
- **buildDeadLetterRecord()** (8 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **redactAttributes()** (8 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **decodePayload()** (7 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **redactValue()** (6 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **truncate()** (6 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **redactString()** (5 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **safeStringify()** (5 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **isSensitiveKey()** (4 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **looksSensitive()** (4 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **jobNameFromSubscription()** (3 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **parseDeliveryCount()** (3 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **b64()** (2 connections) — `workers/__tests__/processors/dead-letter-consumer-logic.test.ts`
- **envelope()** (2 connections) — `workers/__tests__/processors/dead-letter-consumer-logic.test.ts`
- **DEFAULT_DLQ_ALERT_EMAILS** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **DLQ_ATTR_DELIVERY_COUNT** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **DLQ_ATTR_SOURCE_PROJECT** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **DLQ_ATTR_SOURCE_PUBLISH_TIME** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **DLQ_ATTR_SOURCE_SUBSCRIPTION** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **MAX_NOTIFICATION_PAYLOAD_CHARS** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **MAX_PAYLOAD_CHARS** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **MAX_REDACT_ARRAY_ITEMS** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **MAX_REDACT_DEPTH** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- **REDACTED** (2 connections) — `workers/src/processors/dead-letter-consumer-logic.ts`
- *... and 6 more nodes in this community*

## Relationships

- [Dead Letter Queue Consumer](Dead_Letter_Queue_Consumer.md) (9 shared connections)

## Source Files

- `workers/__tests__/processors/dead-letter-consumer-logic.test.ts`
- `workers/src/processors/dead-letter-consumer-logic.ts`

## Audit Trail

- EXTRACTED: 78 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*