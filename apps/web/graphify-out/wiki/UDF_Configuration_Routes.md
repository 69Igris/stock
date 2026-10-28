# UDF Configuration Routes

> 34 nodes

## Key Concepts

- **session.ts** (62 connections) — `lib/demo/session.ts`
- **verifyDemoToken()** (8 connections) — `lib/demo/session.ts`
- **session.test.ts** (8 connections) — `__tests__/demo/session.test.ts`
- **createDemoToken()** (7 connections) — `lib/demo/session.ts`
- **config-logic.ts** (7 connections) — `app/api/market/udf/config/config-logic.ts`
- **config/route.ts** (7 connections) — `app/api/market/udf/config/route.ts`
- **time/route.ts** (7 connections) — `app/api/market/udf/time/route.ts`
- **verifyDemoCookieEdge()** (5 connections) — `lib/demo/session.ts`
- **getServerTimeSeconds()** (4 connections) — `app/api/market/udf/time/time-logic.ts`
- **getDemoSecret()** (4 connections) — `lib/demo/session.ts`
- **resolveDemoState()** (4 connections) — `lib/demo/session.ts`
- **signHmac32()** (4 connections) — `lib/demo/session.ts`
- **time-logic.ts** (4 connections) — `app/api/market/udf/time/time-logic.ts`
- **session-edge-cases.test.ts** (4 connections) — `__tests__/demo/session-edge-cases.test.ts`
- **demo-mode-resolver.test.ts** (4 connections) — `__tests__/security/demo-mode-resolver.test.ts`
- **GET()** (3 connections) — `app/api/market/udf/time/route.ts`
- **deriveDemoSecret()** (3 connections) — `lib/demo/session.ts`
- **timingSafeEqualHex()** (3 connections) — `lib/demo/session.ts`
- **UDF_CONFIG** (3 connections) — `app/api/market/udf/config/config-logic.ts`
- **UDF_TIME_CONTENT_TYPE** (3 connections) — `app/api/market/udf/time/time-logic.ts`
- **udf-time.test.ts** (3 connections) — `__tests__/api/udf-time.test.ts`
- **GET()** (2 connections) — `app/api/market/udf/config/route.ts`
- **getUserId()** (2 connections) — `__tests__/security/demo-mode-resolver.test.ts`
- **CONFIG_CACHE_CONTROL** (2 connections) — `app/api/market/udf/config/config-logic.ts`
- **TTL_MS** (2 connections) — `lib/demo/session.ts`
- *... and 9 more nodes in this community*

## Relationships

- [Paper Trading Views](Paper_Trading_Views.md) (10 shared connections)
- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (8 shared connections)
- [Demo Session Management](Demo_Session_Management.md) (7 shared connections)
- [Portfolio Roast Views](Portfolio_Roast_Views.md) (3 shared connections)
- [Route Proxy and Middleware](Route_Proxy_and_Middleware.md) (2 shared connections)
- [User Trade Routes](User_Trade_Routes.md) (2 shared connections)
- [Dashboard Shell and Layout](Dashboard_Shell_and_Layout.md) (2 shared connections)
- [News Feed Views](News_Feed_Views.md) (2 shared connections)
- [Analysis Tier Management](Analysis_Tier_Management.md) (1 shared connections)
- [Market Quote Parser](Market_Quote_Parser.md) (1 shared connections)
- [Market Search API](Market_Search_API.md) (1 shared connections)
- [Historical Bar Routes](Historical_Bar_Routes.md) (1 shared connections)

## Source Files

- `__tests__/api/udf-config.test.ts`
- `__tests__/api/udf-time.test.ts`
- `__tests__/demo/demo-secret-derivation.test.ts`
- `__tests__/demo/session-edge-cases.test.ts`
- `__tests__/demo/session.test.ts`
- `__tests__/security/demo-mode-resolver.test.ts`
- `app/api/market/udf/config/config-logic.ts`
- `app/api/market/udf/config/route.ts`
- `app/api/market/udf/time/route.ts`
- `app/api/market/udf/time/time-logic.ts`
- `lib/demo/session.ts`

## Audit Trail

- EXTRACTED: 116 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*