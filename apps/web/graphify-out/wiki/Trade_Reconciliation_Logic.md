# Trade Reconciliation Logic

> 30 nodes

## Key Concepts

- **service.ts** (18 connections) — `lib/pairing/service.ts`
- **pairing-logic.ts** (14 connections) — `lib/pairing/pairing-logic.ts`
- **paired/route.ts** (7 connections) — `app/api/trades/paired/route.ts`
- **reconciliation.test.ts** (7 connections) — `__tests__/pairing/reconciliation.test.ts`
- **deriveEffectiveIsin()** (5 connections) — `lib/pairing/pairing-logic.ts`
- **reconcileOpenLotsVsHoldings()** (5 connections) — `lib/pairing/pairing-logic.ts`
- **derivePairingPrice()** (4 connections) — `lib/pairing/pairing-logic.ts`
- **getPairedTrades()** (4 connections) — `lib/pairing/service.ts`
- **pairing-logic.test.ts** (4 connections) — `__tests__/pairing/pairing-logic.test.ts`
- **GET()** (3 connections) — `app/api/trades/paired/route.ts`
- **looksLikeIsin()** (3 connections) — `lib/pairing/pairing-logic.ts`
- **pairUserTrades()** (3 connections) — `lib/pairing/service.ts`
- **ReconHolding** (2 connections) — `lib/pairing/pairing-logic.ts`
- **ReconOpenLot** (2 connections) — `lib/pairing/pairing-logic.ts`
- **ReconReport** (2 connections) — `lib/pairing/pairing-logic.ts`
- **PairedTradeFilters** (2 connections) — `lib/pairing/service.ts`
- **POST()** (2 connections) — `app/api/trades/paired/route.ts`
- **reconKey()** (2 connections) — `lib/pairing/pairing-logic.ts`
- **RECON_QUANTITY_EPSILON** (2 connections) — `lib/pairing/pairing-logic.ts`
- **PairingTradeFields** (1 connections) — `lib/pairing/pairing-logic.ts`
- **ReconEntry** (1 connections) — `lib/pairing/pairing-logic.ts`
- **PairedTradeStats** (1 connections) — `lib/pairing/service.ts`
- **PairTradesOptions** (1 connections) — `lib/pairing/service.ts`
- **PairTradesResult** (1 connections) — `lib/pairing/service.ts`
- **SegmentPnL** (1 connections) — `lib/pairing/service.ts`
- *... and 5 more nodes in this community*

## Relationships

- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (5 shared connections)
- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (1 shared connections)

## Source Files

- `__tests__/pairing/pairing-logic.test.ts`
- `__tests__/pairing/reconciliation.test.ts`
- `app/api/trades/paired/route.ts`
- `lib/pairing/pairing-logic.ts`
- `lib/pairing/service.ts`

## Audit Trail

- EXTRACTED: 54 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*