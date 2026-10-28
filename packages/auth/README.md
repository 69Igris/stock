# @usemoney/auth

> Authentication utilities for UseMoney

## Usage

```typescript
import { requireAuth, getClerkUserId } from "@usemoney/auth";

const userId = await requireAuth();
const clerkId = await getClerkUserId();
```

## Functions

| Function        | Description      |
| --------------- | ---------------- |
| `getAuth()`     | Get auth state   |
| `requireAuth()` | Require auth     |
| `isAdmin()`     | Check admin role |

## Documentation

See **CLAUDE.md** for details.
