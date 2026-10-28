# Clerk Webhook Handling

> 19 nodes

## Key Concepts

- **clerk-webhook.test.ts** (23 connections) — `__tests__/api/clerk-webhook.test.ts`
- **clerk-webhook-logic.ts** (22 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **ClerkUserData** (3 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **WebhookEvent** (3 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **isSupportedEvent()** (3 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **mapClerkEventToAction()** (3 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **ClerkSessionData** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **parseWebhookEvent()** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **shouldSyncContactToResend()** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **createMockClerkUser()** (2 connections) — `__tests__/api/clerk-webhook.test.ts`
- **createMockWebhookEvent()** (2 connections) — `__tests__/api/clerk-webhook.test.ts`
- **BRIEFING_FAILED_RETRY_COOLDOWN_MINUTES** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **BRIEFING_MAX_FAILED_PER_DAY** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **CLERK_SVIX_HEADERS** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **WELCOME_BACKFILL_MAX_AGE_DAYS** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **BriefingRowForDedup** (1 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **absentArm()** (1 connections) — `__tests__/api/clerk-webhook.test.ts`
- **createSvixHeaders()** (1 connections) — `__tests__/api/clerk-webhook.test.ts`
- **sign()** (1 connections) — `__tests__/api/clerk-webhook.test.ts`

## Relationships

- [Clerk User Webhooks](Clerk_User_Webhooks.md) (14 shared connections)
- [Briefing Deduplication Tests](Briefing_Deduplication_Tests.md) (4 shared connections)
- [Dodo Payment Webhooks](Dodo_Payment_Webhooks.md) (1 shared connections)

## Source Files

- `__tests__/api/clerk-webhook.test.ts`
- `app/api/webhooks/clerk/clerk-webhook-logic.ts`

## Audit Trail

- EXTRACTED: 49 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*