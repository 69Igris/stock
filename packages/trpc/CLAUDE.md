# @usemoney/trpc - CLAUDE.md

## Overview

tRPC router definitions for type-safe API communication between apps.

**Package:** `@usemoney/trpc`

---

## ⚠️ Status: every procedure throws `NOT_IMPLEMENTED` (MONEY-1062)

**None of the procedures in this package are implemented.** Every resolver
(`dashboard.*`, `holdings.*`, `positions.*`, `trades.*`) throws
`TRPCError({ code: "NOT_IMPLEMENTED" })` via the shared `notImplemented()` helper
(`src/routers/not-implemented.ts`) and names the concrete REST route to use
instead. **The real, implemented API is the REST `/v1` surface in
`apps/api/src/routes/v1`** (28 endpoint families) — see `apps/api/CLAUDE.md`.

This replaced fabricated stubs that silently returned fake data — worst,
`trades.create` returned `{ id: "", ...input }` and `trades.delete` returned
`{ success: true }` without persisting/deleting anything, and `dashboard.summary`
returned hardcoded zeros. Now every call fails loudly (HTTP 501-equivalent).

The router is still **mounted + authenticated** in `apps/api`
(`src/routes/trpc.ts`) and the `.input(...)` zod schemas + router tree are kept
intact so the shape is ready for a future real implementation — only the
resolver bodies throw. Do NOT treat any procedure as a working data source.

---

## Exports

```typescript
import { appRouter, type AppRouter, type Context } from "@usemoney/trpc";
// No createContext export exists — each host builds its own Context
// (see createTrpcContext in apps/api/src/routes/trpc.ts).
```

---

## Router Structure

```
appRouter/
├── dashboard
│   ├── summary
│   ├── brokers
│   ├── allocation
│   ├── performance
│   └── recentActivity
├── holdings
│   ├── list
│   ├── byId
│   ├── bySymbol
│   └── summary
├── positions
│   ├── list
│   ├── byId
│   ├── bySymbol
│   └── summary
└── trades
    ├── list
    ├── byId
    ├── paired
    ├── summary
    ├── create
    ├── update
    └── delete
```

---

## Usage (Server)

```typescript
// Real integration (apps/api/src/routes/trpc.ts) — Hono, not Next:
trpcRoutes.use(
  "/*",
  trpcServer({
    // trpcServer from @hono/trpc-server
    router: appRouter,
    createContext: (_opts, c): Context => createTrpcContext(c),
  }),
);
```

## Usage (Client)

Note: no React tRPC client exists in the repo — apps/api is the sole consumer of
this package, and it only **mounts** the router (it never calls the procedures).

**Every procedure currently throws `NOT_IMPLEMENTED`** (see the Status note
above), so the illustrative client calls below would reject at runtime — use the
REST `/v1` route each procedure names instead.

```typescript
import { trpc } from "@/lib/trpc";

// Would throw NOT_IMPLEMENTED → use `GET /v1/holdings`
const { data } = trpc.holdings.list.useQuery();

// Would throw NOT_IMPLEMENTED → use `POST /v1/trades`
const mutation = trpc.trades.create.useMutation();
```

---

_Last Updated: July 2026_
