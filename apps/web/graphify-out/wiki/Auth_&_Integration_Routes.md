# Auth & Integration Routes

> 33 nodes

## Key Concepts

- **getOrCreateDbUser()** (42 connections) — `lib/db/user.ts`
- **prisma.ts** (41 connections) — `lib/prisma.ts`
- **db/user.ts** (29 connections) — `lib/db/user.ts`
- **db/user.test.ts** (8 connections) — `__tests__/db/user.test.ts`
- **extractEmail()** (6 connections) — `lib/db/user-logic.ts`
- **resolveFullName()** (6 connections) — `lib/db/user-logic.ts`
- **angel-one/connect/route.ts** (6 connections) — `app/api/brokers/angel-one/connect/route.ts`
- **groww/connect/route.ts** (6 connections) — `app/api/brokers/groww/connect/route.ts`
- **user-logic.ts** (6 connections) — `lib/db/user-logic.ts`
- **needsNameUpdate()** (5 connections) — `lib/db/user-logic.ts`
- **resolveUserAction()** (4 connections) — `__tests__/db/user.test.ts`
- **POST()** (3 connections) — `app/api/brokers/angel-one/connect/route.ts`
- **POST()** (3 connections) — `app/api/brokers/groww/connect/route.ts`
- **feedback/route.ts** (3 connections) — `app/api/email/feedback/route.ts`
- **verify/route.ts** (3 connections) — `app/api/newsletter/verify/route.ts`
- **ClerkUserNameInput** (2 connections) — `lib/db/user-logic.ts`
- **feedbackPageHtml()** (2 connections) — `app/api/email/feedback/route.ts`
- **GET()** (2 connections) — `app/api/email/feedback/route.ts`
- **getCachedUser()** (2 connections) — `lib/db/user.ts`
- **hasPendingDeletion()** (2 connections) — `lib/db/user.ts`
- **isClerkUserNotFound()** (2 connections) — `lib/db/user.ts`
- **setCachedUser()** (2 connections) — `lib/db/user.ts`
- **docs/route.ts** (2 connections) — `app/api/content/docs/route.ts`
- **redeem/route.ts** (2 connections) — `app/api/invite/[token]/redeem/route.ts`
- **DbUser** (1 connections) — `lib/db/user.ts`
- *... and 8 more nodes in this community*

## Relationships

- [Broker Connection Routes](Broker_Connection_Routes.md) (11 shared connections)
- [Saved Filter Controls](Saved_Filter_Controls.md) (7 shared connections)
- [Portfolio Roast Views](Portfolio_Roast_Views.md) (6 shared connections)
- [Trade Reconciliation Logic](Trade_Reconciliation_Logic.md) (5 shared connections)
- [Account & Billing Views](Account_&_Billing_Views.md) (5 shared connections)
- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (4 shared connections)
- [Billing and Invite Management](Billing_and_Invite_Management.md) (4 shared connections)
- [Tool Execution API](Tool_Execution_API.md) (3 shared connections)
- [Chat Narrative Routing](Chat_Narrative_Routing.md) (3 shared connections)
- [AI Screener Chat Handler](AI_Screener_Chat_Handler.md) (3 shared connections)
- [FIRE AI Assistant Panel](FIRE_AI_Assistant_Panel.md) (3 shared connections)
- [Tradebook Export Views](Tradebook_Export_Views.md) (3 shared connections)

## Source Files

- `__tests__/db/user.test.ts`
- `app/api/brokers/angel-one/connect/route.ts`
- `app/api/brokers/groww/connect/route.ts`
- `app/api/content/docs/route.ts`
- `app/api/email/feedback/route.ts`
- `app/api/invite/[token]/redeem/route.ts`
- `app/api/newsletter/verify/route.ts`
- `lib/db/user-logic.ts`
- `lib/db/user.ts`
- `lib/prisma.ts`

## Audit Trail

- EXTRACTED: 142 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*