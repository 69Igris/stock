# Trade Pairing Processor

> 14 nodes

## Key Concepts

- **processors/pairing.ts** (20 connections) — `workers/src/processors/pairing.ts`
- **processPairing()** (14 connections) — `workers/src/processors/pairing.ts`
- **pairing-logic.ts** (9 connections) — `workers/src/processors/pairing-logic.ts`
- **routes/pairing.ts** (9 connections) — `workers/src/routes/pairing.ts`
- **PairingJobMessage** (5 connections) — `packages/types/src/pubsub.ts`
- **deriveEffectiveIsin()** (5 connections) — `workers/src/processors/pairing-logic.ts`
- **corpActionFilterFromTrades()** (4 connections) — `workers/src/processors/pairing-logic.ts`
- **derivePairingPrice()** (3 connections) — `workers/src/processors/pairing-logic.ts`
- **toCorporateActionInput()** (3 connections) — `workers/src/processors/pairing-logic.ts`
- **looksLikeIsin()** (2 connections) — `workers/src/processors/pairing-logic.ts`
- **pairingRoute** (2 connections) — `workers/src/routes/pairing.ts`
- **CorpActionFilterTrade** (1 connections) — `workers/src/processors/pairing-logic.ts`
- **CorpActionRow** (1 connections) — `workers/src/processors/pairing-logic.ts`
- **PairingTradeFields** (1 connections) — `workers/src/processors/pairing-logic.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (6 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (4 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (3 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (3 shared connections)
- [Trade PnL Calculation Engine](Trade_PnL_Calculation_Engine.md) (3 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (3 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)

## Source Files

- `packages/types/src/pubsub.ts`
- `workers/src/processors/pairing-logic.ts`
- `workers/src/processors/pairing.ts`
- `workers/src/routes/pairing.ts`

## Audit Trail

- EXTRACTED: 52 (96%)
- INFERRED: 2 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*