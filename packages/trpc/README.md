# @usemoney/trpc

> tRPC router definitions for UseMoney

## Usage

```typescript
// Server
import { appRouter, createContext } from "@usemoney/trpc/server";

// Client
import { trpc } from "@/lib/trpc";
const { data } = trpc.holdings.list.useQuery();
```

## Routers

| Router      | Procedures                        |
| ----------- | --------------------------------- |
| `dashboard` | `summary`                         |
| `holdings`  | `list`, `get`, `sync`             |
| `positions` | `list`, `get`                     |
| `trades`    | `list`, `get`, `create`, `paired` |
| `brokers`   | `list`, `sync`                    |

## Documentation

See **CLAUDE.md** for details.
