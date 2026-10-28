# Route Proxy and Middleware

> 15 nodes

## Key Concepts

- **proxy.ts** (10 connections) — `proxy.ts`
- **proxy-routes.ts** (9 connections) — `proxy-routes.ts`
- **middleware.test.ts** (9 connections) — `__tests__/security/middleware.test.ts`
- **PUBLIC_ROUTE_PATTERNS** (7 connections) — `proxy-routes.ts`
- **APP_ROUTE_PATTERNS** (5 connections) — `proxy-routes.ts`
- **getRouteAction()** (4 connections) — `__tests__/security/middleware.test.ts`
- **API_ROUTE_PATTERNS** (4 connections) — `proxy-routes.ts`
- **isApiRoute** (2 connections) — `__tests__/security/middleware.test.ts`
- **isAppRoute** (2 connections) — `__tests__/security/middleware.test.ts`
- **isPublicRoute** (2 connections) — `__tests__/security/middleware.test.ts`
- **makeMatcher()** (1 connections) — `__tests__/security/middleware.test.ts`
- **config** (1 connections) — `proxy.ts`
- **isApiRoute** (1 connections) — `proxy.ts`
- **isAppRoute** (1 connections) — `proxy.ts`
- **isPublicRoute** (1 connections) — `proxy.ts`

## Relationships

- [Market Index Navigation Links](Market_Index_Navigation_Links.md) (4 shared connections)
- [Sidebar Prefetch Optimization](Sidebar_Prefetch_Optimization.md) (3 shared connections)
- [UDF Configuration Routes](UDF_Configuration_Routes.md) (2 shared connections)
- [Route Access Middleware](Route_Access_Middleware.md) (2 shared connections)
- [Marketing Root Route](Marketing_Root_Route.md) (2 shared connections)

## Source Files

- `__tests__/security/middleware.test.ts`
- `proxy-routes.ts`
- `proxy.ts`

## Audit Trail

- EXTRACTED: 36 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*