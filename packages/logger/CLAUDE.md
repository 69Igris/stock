# @usemoney/logger - CLAUDE.md

## Overview

Structured logging utilities for UseMoney. Provides consistent logging with context, levels, and formatting.

**Package:** `@usemoney/logger`

---

## Exports

```typescript
import { getLogger, initLogger, flushLogs, syncLogger } from "@usemoney/logger";
import type { LogLevel, LogContext } from "@usemoney/logger/types";
```

---

## Key Functions

| Function                     | Description                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `getLogger(module?)`         | Root or module-scoped pino logger (there is no bare `logger` export)                 |
| `log.info(context, message)` | **Pino arg order: context object FIRST, message second** (same for warn/error/debug) |
| `initLogger()`               | Call once at startup — enables Datadog multistream when `DD_API_KEY` is set          |
| `flushLogs()`                | Flush buffered logs in shutdown handlers                                             |

> **MONEY-1209 — every serialized value is redacted before it leaves the
> process.** `pinoConfig.serializers` wraps `error`, `err`, `req` and `res` in
> `redactSensitive` (`@usemoney/utils/log-redaction`). This is NOT covered by
> `workers/src/log-boundary.ts`: pino does not go through `console`, it writes
> JSON straight to its own stream (stdout plus the Datadog multistream). It is
> also the worse of the two paths — `util.inspect` has a depth limit,
> `JSON.stringify` has none, so an unredacted pino error line publishes the whole
> `options` / `config` / `response` subtree of a ky/got/axios error, which is the
> credentialed request itself.
>
> The serializer hook is on those four KEYS. EVERY OTHER LOG LINE IS NOW COVERED
> TOO, by `formatters.log` — this paragraph used to say a hand-built
> `logger.info({ headers }, "...")` was deliberately uncovered, and that stopped
> being true.
>
> What changed the call was measuring what the alternative cost. The
> `redact.paths` wildcards that briefly stood in for this were 11x the baseline
> per line and reached exactly ONE level of nesting; `formatters.log` is 2.4x and
> reaches every depth. It is cheaper than a SINGLE wildcard.
>
> Two things about that wiring are load-bearing and not obvious:
>
> - It runs BEFORE the per-key serializers, and `headers` is a prototype
>   ACCESSOR on a modern Node `IncomingMessage` — so a naive deep copy silently
>   drops it, and `req` logs as `{"method":"GET","url":"/"}` with no headers at
>   all. The four serialized keys are therefore skipped, from the serializer
>   list itself rather than from a second copy of it.
> - The key pattern names its credentials EXPLICITLY instead of matching a
>   `*token` suffix. This repo logs `instrument_token`, `symboltoken`,
>   `instrumentToken` and `exchangeToken` several hundred times — they are
>   Kite and SmartAPI instrument IDENTIFIERS, and a suffix rule would redact
>   every market-data line in the estate.
>
> Tested by `__tests__/config-redaction.test.ts` against the real exported
> `pinoConfig` driving a real logger, asserting the bytes written.

---

## Usage

```typescript
import { getLogger, syncLogger } from "@usemoney/logger";

// Basic logging — pino: context object FIRST, then message
const log = getLogger();
log.info({ userId: "123" }, "User logged in");
log.error({ error: err.message }, "Failed to sync");

// Module-scoped logger (or use a pre-built one like `syncLogger`)
const brokerLogger = getLogger("broker-sync");
brokerLogger.info({ broker: "ZERODHA" }, "Syncing holdings");
```

---

## Log Levels

| Level   | When to Use         |
| ------- | ------------------- |
| `debug` | Development details |
| `info`  | Normal operations   |
| `warn`  | Potential issues    |
| `error` | Errors and failures |

---

## Configuration

```bash
LOG_LEVEL=info  # trace | debug | info | warn | error | fatal — default: debug (dev) / info (prod)
# Output format switching is NODE_ENV-based (pretty in dev, JSON in prod) — there is no LOG_FORMAT env
```

---

_Last Updated: August 2026_
