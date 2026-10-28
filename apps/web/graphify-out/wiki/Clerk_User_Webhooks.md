# Clerk User Webhooks

> 14 nodes

## Key Concepts

- **clerk/route.ts** (22 connections) — `app/api/webhooks/clerk/route.ts`
- **handleUserUpdated()** (7 connections) — `app/api/webhooks/clerk/route.ts`
- **handleUserCreated()** (6 connections) — `app/api/webhooks/clerk/route.ts`
- **POST()** (6 connections) — `app/api/webhooks/clerk/route.ts`
- **getFullName()** (5 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **getPrimaryEmail()** (5 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **buildContentAuthorImageSyncUpdate()** (4 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **validateSvixHeaders()** (4 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **welcomeClaimWhere()** (4 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **syncContentAuthorImage()** (4 connections) — `app/api/webhooks/clerk/route.ts`
- **syncNewContactToResend()** (4 connections) — `app/api/webhooks/clerk/route.ts`
- **handleSessionCreated()** (3 connections) — `app/api/webhooks/clerk/route.ts`
- **handleUserDeleted()** (3 connections) — `app/api/webhooks/clerk/route.ts`
- **hasInFlightDeletion()** (3 connections) — `app/api/webhooks/clerk/route.ts`

## Relationships

- [Clerk Webhook Handling](Clerk_Webhook_Handling.md) (14 shared connections)
- [Briefing Deduplication Tests](Briefing_Deduplication_Tests.md) (2 shared connections)
- [Dodo Payment Webhooks](Dodo_Payment_Webhooks.md) (1 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)
- [Debug & UI Components](Debug_&_UI_Components.md) (1 shared connections)
- [Market Discovery Views](Market_Discovery_Views.md) (1 shared connections)

## Source Files

- `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- `app/api/webhooks/clerk/route.ts`

## Audit Trail

- EXTRACTED: 50 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*