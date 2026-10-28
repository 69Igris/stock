# tRPC Router Configuration

> 14 nodes

## Key Concepts

- **trpc.ts** (17 connections) — `packages/trpc/src/server/trpc.ts`
- **trpc/src/index.ts** (11 connections) — `packages/trpc/src/index.ts`
- **server/index.ts** (9 connections) — `packages/trpc/src/server/index.ts`
- **router** (8 connections) — `packages/trpc/src/server/trpc.ts`
- **protectedProcedure** (7 connections) — `packages/trpc/src/server/trpc.ts`
- **AppRouter** (4 connections) — `packages/trpc/src/routers/index.ts`
- **client/index.ts** (4 connections) — `packages/trpc/src/client/index.ts`
- **createCallerFactory** (4 connections) — `packages/trpc/src/server/trpc.ts`
- **Context** (3 connections) — `packages/trpc/src/server/trpc.ts`
- **mergeRouters** (3 connections) — `packages/trpc/src/server/trpc.ts`
- **middleware** (3 connections) — `packages/trpc/src/server/trpc.ts`
- **publicProcedure** (3 connections) — `packages/trpc/src/server/trpc.ts`
- **superjson** (3 connections) — `packages/trpc/package.json`
- **t** (1 connections) — `packages/trpc/src/server/trpc.ts`

## Relationships

- [Dashboard and Holdings Routers](Dashboard_and_Holdings_Routers.md) (14 shared connections)
- [tRPC Unimplemented Routers](tRPC_Unimplemented_Routers.md) (4 shared connections)
- [Trade Schemas & Types](Trade_Schemas_&_Types.md) (3 shared connections)
- [TRPC Package Manifest](TRPC_Package_Manifest.md) (1 shared connections)

## Source Files

- `packages/trpc/package.json`
- `packages/trpc/src/client/index.ts`
- `packages/trpc/src/index.ts`
- `packages/trpc/src/routers/index.ts`
- `packages/trpc/src/server/index.ts`
- `packages/trpc/src/server/trpc.ts`

## Audit Trail

- EXTRACTED: 51 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*