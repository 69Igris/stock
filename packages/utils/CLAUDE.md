# @usemoney/utils - CLAUDE.md

## Overview

General utility functions used across UseMoney packages and apps. MONEY-1062
also consolidated three cross-cutting helpers here (moved out of
`apps/web/lib/`): error sanitization, recommendation/advice scrubbing, and a
soft-timeout wrapper — all subpath-only exports.

**Package:** `@usemoney/utils`

---

## Exports

```typescript
// Root barrel — formatters, class-merge, financial calcs
import {
  cn,
  formatCurrency,
  formatDate,
  formatPercentage,
} from "@usemoney/utils";

// Subpath-only modules (MONEY-1062 moves; not re-exported by the root barrel)
import { cn } from "@usemoney/utils/cn";
import {
  sanitizeErrorMessage,
  sanitizeErrors,
  getSafeErrorMessage,
} from "@usemoney/utils/error-sanitization";
import {
  stripRecommendationLanguage,
  scrubAdviceFields,
  scrubProse,
  isAdviceAdjacentField,
  ADVICE_ADJACENT_FIELDS,
  ADVICE_FIELDS_WITHHELD_NOTE,
} from "@usemoney/utils/sanitize-recommendation";
import { withSoftTimeout } from "@usemoney/utils/with-soft-timeout";
import {
  redactSensitive,
  maskSensitiveText,
  REDACTED,
  SENSITIVE_KEY_PATTERN,
  SESSION_COOKIE_NAMES,
} from "@usemoney/utils/log-redaction";
```

---

## Key Functions

| Function                                                                                            | Description                                                                   |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `cn(...classes)`                                                                                    | Merge Tailwind classes                                                        |
| `formatCurrency(value)`                                                                             | Format as INR currency                                                        |
| `formatDate(date)`                                                                                  | "15 Jan 2024" (en-IN)                                                         |
| `formatPercentage(value)`                                                                           | Format as % with +/- prefix                                                   |
| `formatPnL(v)` / `formatDateTime(d)` / `formatNumber(v)` / `formatCompactNumber(v)`                 | Other formatters (1.5L / 2.3Cr compact)                                       |
| `calculateXIRR` / `calculateCAGR` / `calculateAbsoluteReturn` / `calculatePnL` / `calculateWinRate` | Financial calcs (`src/financial.ts`, clamped to [-99, 999]%)                  |
| `sanitizeErrorMessage(err)` / `sanitizeErrors(errs)` / `getSafeErrorMessage(...)`                   | `/error-sanitization` — map raw DB/system errors to user-safe strings         |
| `stripRecommendationLanguage(text)` / `scrubAdviceFields(entries)` / `scrubProse(...)`              | `/sanitize-recommendation` — strip buy/sell advice-language (SEBI compliance) |
| `withSoftTimeout(promise, ms, ...)`                                                                 | `/with-soft-timeout` — resolve-or-fallback wrapper that never leaks a timer   |
| `redactSensitive(value, depth?)` / `maskSensitiveText(text)`                                        | `/log-redaction` — MONEY-1209: strip credentials out of a LOG payload         |

---

## Usage

```typescript
import { cn, formatCurrency } from "@usemoney/utils";

// Merge classes
const className = cn("base", isActive && "active");

// Format currency
formatCurrency(10000); // "₹10,000.00"
```

---

## `/log-redaction` vs `/error-sanitization` (do not merge them)

Two sanitizers, two audiences, two blast radii — and the temptation to fold one
into the other is why this note exists.

|              | `/error-sanitization`                            | `/log-redaction`                                         |
| ------------ | ------------------------------------------------ | -------------------------------------------------------- |
| Audience     | the USER                                         | the LOG SINK                                             |
| Job          | map a raw DB/system error to a friendly sentence | keep every technical detail, remove only the credentials |
| Failure mode | a confusing toast                                | a live session cookie indexed in Cloud Logging           |

`redactSensitive` is **total** — every recursive edge is inside a try/catch, so a
Proxy, a throwing getter or a cross-realm exotic degrades to
`"[unserializable]"` for that node instead of throwing. Callers rely on that: it
runs inside `workers/src/log-boundary.ts` (console) and inside the pino
serializers in `@usemoney/logger` (config.ts), and a redactor that can throw
turns "a log line with a secret in it" into "no log line and a crashed handler".

It also never returns a live object it did not construct. That is the actual
guarantee, and it is not paranoia: undici's `Request` and `Headers` define
`[util.inspect.custom]`, so they inline their whole contents as ONE leaf and
sail straight past `util.inspect`'s depth limit. Anything that reasons about
nesting depth as a safety property is reasoning about the wrong thing.

---

_Last Updated: August 2026_
