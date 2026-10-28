# @usemoney/auth - CLAUDE.md

## Overview

Admin gate + environment helpers (2-file package: `admin.ts` + `index.ts`),
fail-closed on Clerk errors. MONEY-1062 unified this with the (now removed)
`apps/web/lib/auth/admin.ts` twin, so admin is granted by the **UNION** of the
two prior mechanisms (still fail-closed):

1. Clerk `publicMetadata.role === "admin"` (web twin's primary)
2. email listed in `ADMIN_EMAILS` env (CSV) (web twin's fallback)
3. email === founder `deepshaswat@gmail.com` (this package's original fallback)

**Package:** `@usemoney/auth`

---

## Exports

```typescript
import {
  isAdmin,
  checkAdminAuth,
  requireAdmin,
  isProduction,
  isDebugEnabled,
} from "@usemoney/auth";
```

---

## Key Functions

| Function                              | Description                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAdmin()`                           | `true` if the current Clerk user satisfies ANY of: `publicMetadata.role === "admin"`, email in `ADMIN_EMAILS` CSV, or email === founder; fail-closed |
| `checkAdminAuth()`                    | `{ isAdmin, userId, userEmail }` via `auth()` + `currentUser()` (same union rule)                                                                    |
| `requireAdmin()`                      | Throws "Unauthorized: Admin access required" if not admin                                                                                            |
| `isProduction()` / `isDebugEnabled()` | NODE_ENV gate; debug in prod needs `ENABLE_DEBUG_FEATURES=true`                                                                                      |

---

## Usage

```typescript
import { requireAdmin, checkAdminAuth } from "@usemoney/auth";

// Gate an admin/debug endpoint (throws if not admin)
await requireAdmin();
const { isAdmin, userId, userEmail } = await checkAdminAuth();

// Check admin
const admin = await isAdmin();
```

---

## Configuration

```bash
ADMIN_EMAILS=a@x.com,b@y.com   # optional CSV; unset → Clerk role or founder only
ENABLE_DEBUG_FEATURES=true     # allow isDebugEnabled() to return true in production
```

Admin can also be granted per-user via Clerk `publicMetadata.role = "admin"`.

---

_Last Updated: July 2026_
