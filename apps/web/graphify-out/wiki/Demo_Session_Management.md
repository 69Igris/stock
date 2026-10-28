# Demo Session Management

> 24 nodes

## Key Concepts

- **start/route.ts** (12 connections) — `app/api/demo/start/route.ts`
- **PostHogClient()** (8 connections) — `lib/posthog.ts`
- **end/route.ts** (8 connections) — `app/api/demo/end/route.ts`
- **demo/route-logic.ts** (8 connections) — `app/api/demo/route-logic.ts`
- **demo.test.ts** (8 connections) — `__tests__/api/demo.test.ts`
- **posthog.ts** (7 connections) — `lib/posthog.ts`
- **POST()** (6 connections) — `app/api/demo/start/route.ts`
- **COOKIE_NAME** (5 connections) — `lib/demo/session.ts`
- **POST()** (4 connections) — `app/api/demo/end/route.ts`
- **demoClearCookieAttributes()** (4 connections) — `app/api/demo/route-logic.ts`
- **demoSessionCookieAttributes()** (4 connections) — `app/api/demo/route-logic.ts`
- **extractDemoIp()** (4 connections) — `app/api/demo/route-logic.ts`
- **demo-end.test.ts** (4 connections) — `__tests__/api/demo-end.test.ts`
- **DEMO_COOKIE_MAX_AGE** (3 connections) — `app/api/demo/route-logic.ts`
- **demo-start.test.ts** (3 connections) — `__tests__/api/demo-start.test.ts`
- **posthog/client.test.ts** (2 connections) — `__tests__/posthog/client.test.ts`
- **posthog-node** (2 connections) — `package.json`
- **DemoCookieAttributes** (1 connections) — `app/api/demo/route-logic.ts`
- **makeRequest()** (1 connections) — `__tests__/api/demo-end.test.ts`
- **readSrc()** (1 connections) — `__tests__/api/demo-end.test.ts`
- **makeRequest()** (1 connections) — `__tests__/api/demo-start.test.ts`
- **headerGetter()** (1 connections) — `__tests__/api/demo.test.ts`
- **demoRateLimiter** (1 connections) — `app/api/demo/start/route.ts`
- **NOTE: This is a Node.js client, so you can use it for sending events from the…** (1 connections) — `lib/posthog.ts`

## Relationships

- [UDF Configuration Routes](UDF_Configuration_Routes.md) (7 shared connections)
- [Chat Narrative Routing](Chat_Narrative_Routing.md) (3 shared connections)
- [Primitive UI Components](Primitive_UI_Components.md) (1 shared connections)

## Source Files

- `__tests__/api/demo-end.test.ts`
- `__tests__/api/demo-start.test.ts`
- `__tests__/api/demo.test.ts`
- `__tests__/posthog/client.test.ts`
- `app/api/demo/end/route.ts`
- `app/api/demo/route-logic.ts`
- `app/api/demo/start/route.ts`
- `lib/demo/session.ts`
- `lib/posthog.ts`
- `package.json`

## Audit Trail

- EXTRACTED: 55 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*