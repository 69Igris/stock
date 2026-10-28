# Briefing Deduplication Tests

> 8 nodes

## Key Concepts

- **briefing-dedupe-status.test.ts** (8 connections) — `__tests__/api/briefing-dedupe-status.test.ts`
- **shouldQueueBriefing()** (5 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **BRIEFING_STANDING_STATUSES** (2 connections) — `app/api/webhooks/clerk/clerk-webhook-logic.ts`
- **dedupeWhere()** (1 connections) — `__tests__/api/briefing-dedupe-status.test.ts`
- **sessionHandlerBody()** (1 connections) — `__tests__/api/briefing-dedupe-status.test.ts`
- **CODE** (1 connections) — `__tests__/api/briefing-dedupe-status.test.ts`
- **REPO_ROOT** (1 connections) — `__tests__/api/briefing-dedupe-status.test.ts`
- **SRC** (1 connections) — `__tests__/api/briefing-dedupe-status.test.ts`

## Relationships

- [Clerk Webhook Handling](Clerk_Webhook_Handling.md) (4 shared connections)
- [Clerk User Webhooks](Clerk_User_Webhooks.md) (2 shared connections)

## Source Files

- `__tests__/api/briefing-dedupe-status.test.ts`
- `app/api/webhooks/clerk/clerk-webhook-logic.ts`

## Audit Trail

- EXTRACTED: 13 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*