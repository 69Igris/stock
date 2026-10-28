# Mutual Fund NAV Propagation

> 6 nodes

## Key Concepts

- **routes/mf-nav-propagate.ts** (9 connections) — `workers/src/routes/mf-nav-propagate.ts`
- **processors/mf-nav-propagate.ts** (6 connections) — `workers/src/processors/mf-nav-propagate.ts`
- **MfNavPropagateMessage** (4 connections) — `packages/types/src/pubsub.ts`
- **propagateMfNavToUserFunds()** (4 connections) — `packages/services/src/mf-nav-propagation.service.ts`
- **processMfNavPropagate()** (3 connections) — `workers/src/processors/mf-nav-propagate.ts`
- **mfNavPropagateRoute** (2 connections) — `workers/src/routes/mf-nav-propagate.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (6 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (3 shared connections)
- [Mutual Fund NAV Processing](Mutual_Fund_NAV_Processing.md) (2 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (1 shared connections)

## Source Files

- `packages/services/src/mf-nav-propagation.service.ts`
- `packages/types/src/pubsub.ts`
- `workers/src/processors/mf-nav-propagate.ts`
- `workers/src/routes/mf-nav-propagate.ts`

## Audit Trail

- EXTRACTED: 20 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*