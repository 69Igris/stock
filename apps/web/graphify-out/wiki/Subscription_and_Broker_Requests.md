# Subscription and Broker Requests

> 19 nodes

## Key Concepts

- **zod** (14 connections) — `package.json`
- **subscribe/route.ts** (12 connections) — `app/api/newsletter/subscribe/route.ts`
- **subscribe/route-logic.ts** (12 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **newsletter.test.ts** (8 connections) — `__tests__/api/newsletter.test.ts`
- **POST()** (7 connections) — `app/api/newsletter/subscribe/route.ts`
- **buildVerifyUrl()** (4 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **getAppUrl()** (4 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **handleExistingSubscriber()** (4 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **newsletterSuccessMessage()** (4 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **normalizeEmail()** (4 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **parseIpFromHeader()** (4 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **broker-request/route.ts** (3 connections) — `app/api/broker-request/route.ts`
- **SubscribeSchema** (3 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **validators.ts** (2 connections) — `app/fire/lib/validators.ts`
- **SubscribeInput** (1 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **SubscriberStatus** (1 connections) — `app/api/newsletter/subscribe/route-logic.ts`
- **POST()** (1 connections) — `app/api/broker-request/route.ts`
- **validateParameters()** (1 connections) — `app/fire/lib/validators.ts`
- **BrokerRequestSchema** (1 connections) — `app/api/broker-request/route.ts`

## Relationships

- [Saved Filter Controls](Saved_Filter_Controls.md) (2 shared connections)
- [Tool Registry Metadata](Tool_Registry_Metadata.md) (2 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)
- [Debug & UI Components](Debug_&_UI_Components.md) (1 shared connections)
- [Primitive UI Components](Primitive_UI_Components.md) (1 shared connections)
- [Signup Precheck Route](Signup_Precheck_Route.md) (1 shared connections)
- [Preview Plan Route](Preview_Plan_Route.md) (1 shared connections)
- [Screener Chat Bridge](Screener_Chat_Bridge.md) (1 shared connections)
- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (1 shared connections)
- [Chat Tool Execution](Chat_Tool_Execution.md) (1 shared connections)

## Source Files

- `__tests__/api/newsletter.test.ts`
- `app/api/broker-request/route.ts`
- `app/api/newsletter/subscribe/route-logic.ts`
- `app/api/newsletter/subscribe/route.ts`
- `app/fire/lib/validators.ts`
- `package.json`

## Audit Trail

- EXTRACTED: 51 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*