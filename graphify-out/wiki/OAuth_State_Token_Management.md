# OAuth State Token Management

> 16 nodes

## Key Concepts

- **oauth-state.ts** (17 connections) — `packages/core/src/brokers/oauth-state.ts`
- **oauth-state.test.ts** (12 connections) — `packages/core/__tests__/brokers/oauth-state.test.ts`
- **stateKey()** (4 connections) — `packages/core/src/brokers/oauth-state.ts`
- **consumeReauthIntent()** (3 connections) — `packages/core/src/brokers/oauth-state.ts`
- **generateOAuthState()** (3 connections) — `packages/core/src/brokers/oauth-state.ts`
- **__peekOAuthStateForTests()** (3 connections) — `packages/core/src/brokers/oauth-state.ts`
- **reauthKey()** (3 connections) — `packages/core/src/brokers/oauth-state.ts`
- **__setRedisClientGetterForTests()** (3 connections) — `packages/core/src/brokers/oauth-state.ts`
- **storeReauthIntent()** (3 connections) — `packages/core/src/brokers/oauth-state.ts`
- **verifyOAuthState()** (3 connections) — `packages/core/src/brokers/oauth-state.ts`
- **ReauthIntent** (2 connections) — `packages/core/src/brokers/oauth-state.ts`
- **useRedis()** (2 connections) — `packages/core/__tests__/brokers/oauth-state.test.ts`
- **OAUTH_STATE_TTL_SECONDS** (2 connections) — `packages/core/src/brokers/oauth-state.ts`
- **authLogger** (2 connections) — `packages/logger/src/index.ts`
- **StubRedis** (1 connections) — `packages/core/__tests__/brokers/oauth-state.test.ts`
- **makeStubRedis()** (1 connections) — `packages/core/__tests__/brokers/oauth-state.test.ts`

## Relationships

- [Application Logging Framework](Application_Logging_Framework.md) (2 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (1 shared connections)
- [Broker Account Sync Decisions](Broker_Account_Sync_Decisions.md) (1 shared connections)
- [Redis Connection Management](Redis_Connection_Management.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/brokers/oauth-state.test.ts`
- `packages/core/src/brokers/oauth-state.ts`
- `packages/logger/src/index.ts`

## Audit Trail

- EXTRACTED: 35 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*