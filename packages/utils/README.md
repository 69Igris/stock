# @usemoney/utils

> General utility functions for UseMoney

## Usage

```typescript
import { cn, formatCurrency, formatDate } from "@usemoney/utils";

cn("base", isActive && "active");
formatCurrency(10000); // "₹10,000.00"
formatDate(new Date());
```

## Functions

| Function           | Description   |
| ------------------ | ------------- |
| `cn()`             | Merge classes |
| `formatCurrency()` | Format INR    |
| `formatDate()`     | Format date   |
| `formatPercent()`  | Format %      |

## Documentation

See **CLAUDE.md** for details.
