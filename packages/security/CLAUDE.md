# @usemoney/security - CLAUDE.md

## Overview

Security utilities for UseMoney: AES-256-GCM encryption for broker credentials
and other sensitive data, plus the shared **rate limiting** and **cron-request
auth** helpers consolidated here in MONEY-1062 (moved out of
`apps/web/lib/security/`).

**Package:** `@usemoney/security`

---

## Exports

```typescript
// Encryption (root barrel re-exports the ./encryption module)
import {
  encryption,
  generateEncryptionKey,
  assertEncryptionKey,
  type EncryptedData,
} from "@usemoney/security";
import { SecureEncryption, getEncryption } from "@usemoney/security/encryption";

// Rate limiting (MONEY-1062 — moved from apps/web/lib/security/rate-limit.ts)
import {
  createRateLimiter,
  checkRateLimit,
  createRateLimitKey,
  apiRateLimiter,
  authRateLimiter,
  brokerRateLimiter,
  syncRateLimiter,
} from "@usemoney/security/rate-limit";

// Cron-request auth (MONEY-1062)
import { verifyCronAuth } from "@usemoney/security/cron-auth";
```

> The root barrel (`@usemoney/security`) exports the **encryption** surface only.
> Rate-limit and cron-auth are subpath-only (`/rate-limit`, `/cron-auth`).

---

## Key Functions

| Function                                               | Description                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `encryption.encrypt(data)`                             | Encrypt (object is JSON-stringified) → `EncryptedData`                           |
| `encryption.decrypt(encrypted, iv, authTag)`           | Decrypt — takes the 3 `EncryptedData` fields                                     |
| `getEncryption()`                                      | Lazy singleton accessor                                                          |
| `generateEncryptionKey()`                              | Generate new 64-char hex key                                                     |
| `assertEncryptionKey()`                                | Startup fail-fast if `ENCRYPTION_KEY` unset                                      |
| `createRateLimiter(opts)`                              | Build a limiter (LRU-backed); `api`/`auth`/`broker`/`sync` presets are pre-built |
| `checkRateLimit(...)` / `createRateLimitKey(...parts)` | Consume a limiter / build a composite limiter key                                |
| `verifyCronAuth(...)`                                  | Validate an inbound cron/scheduler request's secret                              |

---

## Encryption Details

**Algorithm:** AES-256-GCM

- 256-bit key
- Unique IV per encryption
- Auth tag for integrity

**Storage Format:**

```
EncryptedData { encrypted, iv, authTag } — three HEX strings; plaintext is
JSON.stringify'd. NOT a colon-joined base64 string.
```

Gotchas (both from security audits): the constructor THROWS when
`ENCRYPTION_KEY` is unset — the zero-key fallback was removed (MONEY-285) —
and decrypt rejects auth tags that are not exactly 16 bytes (MONEY-592).

---

## Usage

```typescript
import { encryption, type EncryptedData } from "@usemoney/security";

// Encrypt before storing — objects are JSON-stringified internally
const enc: EncryptedData = encryption.encrypt({
  accessToken: "...",
  refreshToken: "...",
});

// Decrypt with the three stored fields (see apps/web/lib/brokers/base-adapter.ts)
const credentials = JSON.parse(
  encryption.decrypt(enc.encrypted, enc.iv, enc.authTag),
);
```

---

## Configuration

```bash
ENCRYPTION_KEY=<64-char-hex-key>
```

Generate key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## What's Been Completed

- [x] AES-256-GCM encryption
- [x] Credential encryption/decryption
- [x] Key generation utility
- [x] Rate limiting (`/rate-limit`) — MONEY-1062, consolidated from apps/web
- [x] Cron-request auth (`/cron-auth`) — MONEY-1062

---

## Restrictions

- Never log decrypted values
- Keep ENCRYPTION_KEY secure
- Rotate keys periodically
- All credentials must be encrypted before storage

---

_Last Updated: July 2026_
