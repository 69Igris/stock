# @usemoney/security

> AES-256-GCM encryption utilities for UseMoney

## Usage

```typescript
import { encryptCredentials, decryptCredentials } from "@usemoney/security";

// Encrypt
const encrypted = encryptCredentials({
  accessToken: "...",
  refreshToken: "...",
});

// Decrypt
const credentials = decryptCredentials(encrypted);
```

## Functions

| Function                        | Description                |
| ------------------------------- | -------------------------- |
| `encryptCredentials(data)`      | Encrypt credentials object |
| `decryptCredentials(encrypted)` | Decrypt credentials        |
| `generateKey()`                 | Generate encryption key    |

## Configuration

```bash
ENCRYPTION_KEY=<64-char-hex-key>
```

## Documentation

See **CLAUDE.md** for details.
