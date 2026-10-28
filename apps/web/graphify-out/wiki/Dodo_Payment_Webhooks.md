# Dodo Payment Webhooks

> 14 nodes

## Key Concepts

- **svix** (8 connections) — `package.json`
- **webhooks-dodo-e2e.test.ts** (7 connections) — `__tests__/api/webhooks-dodo-e2e.test.ts`
- **dodo/route.ts** (5 connections) — `app/api/webhooks/dodo/route.ts`
- **dodopayments/route.ts** (2 connections) — `app/api/webhooks/dodopayments/route.ts`
- **DodoRouteModule** (1 connections) — `__tests__/api/webhooks-dodo-e2e.test.ts`
- **ModuleCache** (1 connections) — `__tests__/api/webhooks-dodo-e2e.test.ts`
- **ProvisionCall** (1 connections) — `__tests__/api/webhooks-dodo-e2e.test.ts`
- **gatedSend()** (1 connections) — `app/api/webhooks/dodo/route.ts`
- **POST()** (1 connections) — `app/api/webhooks/dodo/route.ts`
- **POST()** (1 connections) — `app/api/webhooks/dodopayments/route.ts`
- **loadRoute()** (1 connections) — `__tests__/api/webhooks-dodo-e2e.test.ts`
- **makeSignedRequest()** (1 connections) — `__tests__/api/webhooks-dodo-e2e.test.ts`
- **webhookNotifier** (1 connections) — `app/api/webhooks/dodo/route.ts`
- **wh** (1 connections) — `__tests__/api/webhooks-dodo-e2e.test.ts`

## Relationships

- [Debug & UI Components](Debug_&_UI_Components.md) (1 shared connections)
- [Primitive UI Components](Primitive_UI_Components.md) (1 shared connections)
- [Clerk User Webhooks](Clerk_User_Webhooks.md) (1 shared connections)
- [Clerk Webhook Handling](Clerk_Webhook_Handling.md) (1 shared connections)
- [Clerk Webhook Tests](Clerk_Webhook_Tests.md) (1 shared connections)
- [Dodo Payment Webhook Tests](Dodo_Payment_Webhook_Tests.md) (1 shared connections)

## Source Files

- `__tests__/api/webhooks-dodo-e2e.test.ts`
- `app/api/webhooks/dodo/route.ts`
- `app/api/webhooks/dodopayments/route.ts`
- `package.json`

## Audit Trail

- EXTRACTED: 19 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*