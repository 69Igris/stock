# @usemoney/api-utils

> Shared API utilities for UseMoney

## Usage

```typescript
import { success, error } from "@usemoney/api-utils/response";

// Success response
return c.json(success({ data: [...] }));

// Error response
return c.json(error("NOT_FOUND", "Not found"), 404);
```

## Response Format

```typescript
{
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta?: { total?: number; page?: number };
}
```

## Documentation

See **CLAUDE.md** for details.
