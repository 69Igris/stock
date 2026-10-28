# @usemoney/api-utils - CLAUDE.md

## Overview

Shared API utilities for the Hono API server and other API implementations.

**Package:** `@usemoney/api-utils`

---

## Exports

```typescript
import {
  success,
  error,
  paginated,
  ErrorCodes,
  type ApiResponse,
} from "@usemoney/api-utils/response";
import {
  ApiError,
  NotFoundError,
  isApiError,
  toApiError,
} from "@usemoney/api-utils/errors";
```

---

## Response Helpers

| Function                                  | Description                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `success(data, meta?)`                    | Create success response                                                        |
| `error(code, message, details?)`          | Create error response (envelope only — pass HTTP status to `c.json(..., 404)`) |
| `paginated(data, { total, page, limit })` | Success response with computed `meta.hasMore`                                  |

---

## Response Format

```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
    hasMore?: boolean;
  };
}
```

---

## Usage

```typescript
import { success, error } from "@usemoney/api-utils/response";

// Success
return c.json(success({ users: [...] }, { total: 100 }));

// Error
return c.json(error("NOT_FOUND", "User not found"), 404);
```

---

_Last Updated: July 2026_
