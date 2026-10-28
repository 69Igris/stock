# P0-01 · US service contract — one function, two callers, a parity test

Ticket: MONEY-1632 · Branch: `feat/MONEY-1632` · Flag(s): none (foundation) · Screens: none · Depends on: nothing · Parallel-safe with: P0-02

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt. §2 of the US file IS the spec this prompt builds.

## Goal

Every US surface in Phases 0–3 becomes ONE service function in `packages/services/src/us/`, called by a thin Next.js server action and a thin `/v1/us/*` Hono route. This prompt builds the rails: the `us/` subpath export, the `US_SURFACES` registry, the `/v1/us` router mount, the parity test that fails when the rails are bent, and one real surface, `us/access-status`, that every later screen can call to learn the caller's US licence state.

## Why / measured state today

- **The reference pair is two implementations.** `packages/services/src/saved-screens.service.ts` exists, but `apps/web/lib/actions/saved-screens.ts:18` still imports `prisma` and runs its own queries (`:80`, `:128`, `:165`, `:210`, `:232`, `:265`). `apps/api/src/routes/v1/saved-screens.ts:48` says `// Mirrors apps/web/lib/actions/saved-screens-logic.ts (SaveSchema/RenameSchema)` over hand-copied schemas. Do not copy this shape.
- **`ServiceResult<T>` already exists**: `packages/services/src/types.ts` (`{success:true,data}|{success:false,error,code?}`), structurally compatible with `ActionResponse<T>` from `@usemoney/validation`, so an action can return a service result unchanged.
- **`packages/services/package.json` exports** list 9 explicit subpaths and no `us/`. A wildcard subpath has precedent: `packages/email/package.json:11` `"./templates/*": "./src/templates/*.tsx"`.
- **`V1_ENDPOINTS`** is at `apps/api/src/routes/v1/index.ts:60`, pinned at 38 by `apps/api/__tests__/routes/v1-helpers.test.ts:219` and `apps/api/__tests__/routes/parity-p14-discover-sections-contract.test.ts:780-784`. Mounts start at `:166`. `/v1/*` is behind `authMiddleware` (`apps/api/src/app.ts:84`), which sets `c.get("userId")` to the Mongo `_id`.
- **The licence rule today** is `isUsMarketAllowed(email)` in `packages/core/src/market-data/us-market-access.ts`, re-resolved separately by `apps/web/lib/market/us-access.ts` (`currentUserMaySeeUsMarket`, Clerk id → email, 5-min cache) and `apps/api/src/lib/us-access.ts` (`mayServeUsMarket`, Mongo id → email). Two resolvers of one rule. `access-status` becomes the third caller and the first shared one; P0-03 folds the other two into it.
- **Web auth helper**: `getAuthenticatedUser()` in `apps/web/lib/auth.ts:13` returns `{ userId }` (Mongo id) and hides `prisma` behind `apps/web/lib/db/user.ts`, so an action never imports the database.

## Read first (verified paths)

- `packages/services/src/types.ts`, `packages/services/package.json`, `packages/services/src/scans.service.ts` (a service returning `ServiceResult`)
- `apps/web/lib/auth.ts`, `apps/web/lib/actions/result-feedback.ts` (action shape; note it ALSO imports prisma — second anti-example)
- `apps/api/src/routes/v1/result-feedback.ts` (route shape: `safeJson`, `zodParse`, `success`/`error` from `apps/api/src/lib/response`)
- `apps/api/src/routes/v1/index.ts`, `apps/api/src/app.ts`
- `packages/core/src/market-data/us-market-access.ts`, `apps/api/src/lib/us-access.ts`, `apps/web/lib/market/us-access.ts`
- `packages/core/__tests__/market-data/us-market-access-wired.test.ts` (house style for a source-scan test with PREMISE cases)

## Build — in this order

### 1. Service — `packages/services/src/us/`

Add to `packages/services/package.json` exports: `"./us/*": "./src/us/*.ts"`. Import sites use `@usemoney/services/us/<file>` (subpaths, never the root barrel — the root barrel costs ~3.8 s cold per root CLAUDE.md). Do NOT add `us/` to `packages/services/src/index.ts`.

`packages/services/src/us/access-status-logic.ts` (pure, zod lives here):

```ts
import { z } from "zod";

/** No input today. Declared so both callers import ONE schema from day one. */
export const UsAccessStatusInput = z.object({}).strict();
export type UsAccessStatusInput = z.infer<typeof UsAccessStatusInput>;

/** Plain JSON. A mobile client deserialises this with no knowledge of our server. */
export interface UsAccessStatus {
  /** May this caller be shown a US price? (licence gate only — P0-03 adds the flag) */
  mayServe: boolean;
  /** false = we could not decide (DB blip). Callers treat it as mayServe:false and never cache it. */
  determined: boolean;
  checkedAt: string; // ISO
}

export const ABSENT_US_ACCESS = (now: Date): UsAccessStatus => ({
  mayServe: false,
  determined: true,
  checkedAt: now.toISOString(),
});

export function toAccessStatus(a: {
  email: string | null | undefined;
  lookupFailed: boolean;
  allowed: (e: string | null | undefined) => boolean;
  now: Date;
}): UsAccessStatus {
  if (a.lookupFailed)
    return {
      mayServe: false,
      determined: false,
      checkedAt: a.now.toISOString(),
    };
  return {
    mayServe: a.allowed(a.email),
    determined: true,
    checkedAt: a.now.toISOString(),
  };
}
```

`packages/services/src/us/access-status.service.ts`:

```ts
import { prisma } from "@usemoney/database";
import { isUsMarketAllowed } from "@usemoney/core/market-data/us-market-access";
import type { ServiceResult } from "../types";
import {
  toAccessStatus,
  type UsAccessStatus,
  type UsAccessStatusInput,
} from "./access-status-logic";

/** Test seam — same shape as `ResultFeedbackServiceDeps` (result-feedback.service.ts:51). */
export interface UsAccessStatusDeps {
  prisma?: Pick<typeof prisma, "user">;
  now?: Date;
}

export async function getUsAccessStatus(
  userId: string,
  _input: UsAccessStatusInput = {},
  deps: UsAccessStatusDeps = {},
): Promise<ServiceResult<UsAccessStatus>> {
  const db = deps.prisma ?? prisma;
  const now = deps.now ?? new Date();
  let email: string | null = null;
  let lookupFailed = false;
  try {
    const u = await db.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    email = u?.email ?? null;
  } catch {
    lookupFailed = true; // FAIL CLOSED, and say we could not decide
  }
  return {
    success: true,
    data: toAccessStatus({
      email,
      lookupFailed,
      allowed: isUsMarketAllowed,
      now,
    }),
  };
}
```

`packages/services/src/us/registry.ts`:

```ts
export interface UsSurface {
  /** kebab-case, unique, a FREE id with NO `us-` prefix (the registry already says "US"): "search", "stock-overview", "markets" */
  surface: string;
  /** PostHog flag key; null for foundation surfaces. Narrowed to the P0-02 flag-key type by whichever of P0-01/P0-02 merges second. */
  flag: string | null;
  /** "required" = both callers must gate on the US layer (P0-03's resolveUsLayer / usLayerForRequest / usLayerFor); "none" = caller-scoped state, never US data */
  usAccess: "required" | "none";
  serviceExport: string; // named export of serviceFile
  serviceFile: string; // repo-relative, anywhere under packages/services/src/
  actionFile: string; // usually apps/web/lib/actions/us-<surface>.ts
  routeFile: string; // usually apps/api/src/routes/v1/us/<surface>.ts
  routePath: string; // starts with "/v1/"; normally "/v1/us/<sub-path>"
  /** REQUIRED when routePath is outside /v1/us: the reason this surface lives in another, existing family. */
  familyException?: string;
}

export const US_SURFACES: readonly UsSurface[] = [
  {
    surface: "access-status",
    flag: null,
    usAccess: "none", // it reports the caller's OWN licence state; it serves no US data
    serviceExport: "getUsAccessStatus",
    serviceFile: "packages/services/src/us/access-status.service.ts",
    actionFile: "apps/web/lib/actions/us-access-status.ts",
    routeFile: "apps/api/src/routes/v1/us/access-status.ts",
    routePath: "/v1/us/access-status",
  },
];
```

The registry holds strings only. It imports nothing from `apps/*`.

### 2. Server action — `apps/web/lib/actions/us-access-status.ts`

```ts
"use server";
import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import { getUsAccessStatus } from "@usemoney/services/us/access-status.service";
import {
  ABSENT_US_ACCESS,
  UsAccessStatusInput,
  type UsAccessStatus,
} from "@usemoney/services/us/access-status-logic";

export async function getUsAccessStatusAction(
  input: unknown = {},
): Promise<ActionResponse<UsAccessStatus>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: true, data: ABSENT_US_ACCESS(new Date()) }; // signed-out + demo: absent, not an error
  const parsed = UsAccessStatusInput.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  return getUsAccessStatus(user.userId, parsed.data);
}
```

No `prisma`, no `@usemoney/database`. Demo sessions have no Clerk user, so they get absence (same as `currentUserMaySeeUsMarket` today).

### 3. `/v1/us` route + registry row

`apps/api/src/routes/v1/us/access-status.ts`:

```ts
import { Hono } from "hono";
import type { AppContext } from "../../../app";
import { success, error, ErrorCodes, zodParse } from "../../../lib/response";
import { getUsAccessStatus } from "@usemoney/services/us/access-status.service";
import { UsAccessStatusInput } from "@usemoney/services/us/access-status-logic";

const accessStatusRoutes = new Hono<AppContext>();

/** GET /v1/us/access-status → 200 { mayServe, determined, checkedAt } */
accessStatusRoutes.get("/", async (c) => {
  const parsed = zodParse(UsAccessStatusInput, c.req.query());
  if (!parsed.ok)
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid query", parsed.issues),
      400,
    );
  const r = await getUsAccessStatus(c.get("userId"), parsed.data);
  if (!r.success) return c.json(error(ErrorCodes.INTERNAL_ERROR, r.error), 500);
  return c.json(success(r.data));
});

export default accessStatusRoutes;
```

`apps/api/src/routes/v1/us/index.ts`: `const usRoutes = new Hono<AppContext>(); usRoutes.route("/access-status", accessStatusRoutes); export default usRoutes;` — every later ticket adds one `usRoutes.route(...)` line here and one registry row, never a family.

`apps/api/src/routes/v1/index.ts`: import `usRoutes`, add `v1Routes.route("/us", usRoutes);` after `/saved-screens`, and one `V1_ENDPOINTS` entry `{ path: "/v1/us", description: "US market layer — every sub-path is a US_SURFACES row (MONEY-1632)" }`. That makes **39**. Update both pins deliberately (`v1-helpers.test.ts:219`, `parity-p14-discover-sections-contract.test.ts:780-784` incl. its test title), and the "38" wording in root `CLAUDE.md` (Monorepo Structure, `apps/api` line) and `apps/api/CLAUDE.md`. `/v1/us` is the last family this program adds.

Route files keep `zodParse` etc. from `apps/api/src/lib/response`; they do not import `@usemoney/database` (the `apps/api/src/lib/us-access.ts` helper is a lib, not a route, and is P0-03's to retire).

### 4. UI

None. The consumer hook arrives in P0-03 (`useUsLayer`).

## Parity test — `packages/services/__tests__/us/us-surface-parity.test.ts`

Source-scan, `node:test`. Repo root resolved like `us-market-access-wired.test.ts`. For every `US_SURFACES` row:

1. `serviceFile`, `actionFile`, `routeFile` exist. `surface` is unique, matches `/^[a-z0-9]+(-[a-z0-9]+)*$/`, and does NOT start with `us-`. `routePath.startsWith("/v1/")`. The sub-path under `/v1/us` is free (a surface may own several routes, e.g. `stock-financials` is `/v1/us/stocks/:listingId/financials`); it is not derived from `surface`.
   - **Family exceptions.** A `routePath` outside `/v1/us/` is legal only when the row carries a non-empty `familyException: "<reason>"`; a row under `/v1/us/` that carries one fails (a stale exception hides a move). Known uses: `/v1/me/market` (P0-05, profile read by India-only users), `/v1/watchlists` (P1-08, existing mixed-market family), `/v1/market/us/quotes` (P1-10, existing contract), `/v1/research/*` (P2-01, existing family), `/v1/holdings` (P3-04, existing family), `/v1/brokers/snaptrade/*` (P3-02, the rail also serves Indian brokers). Every other route goes under `/v1/us`. No row adds a `V1_ENDPOINTS` family.
2. `serviceFile` has `export async function <serviceExport>` (regex).
3. `actionFile` starts with `"use server"`; `actionFile` and `routeFile` both import `<serviceExport>` from the SAME specifier, derived from `serviceFile` for ANY path under `packages/services/src/`: strip that prefix and the `.ts`, prefix `@usemoney/services/` (`packages/services/src/us/search.service.ts` → `@usemoney/services/us/search.service`; `packages/services/src/watchlist.service.ts` → `@usemoney/services/watchlist.service`). The specifier must resolve through `packages/services/package.json` `exports`; a row whose service has no export adds one in the same PR. A `serviceFile` outside `packages/services/src/` fails.
4. Neither `actionFile` nor `routeFile` matches `/from ["']@usemoney\/database["']|\bprisma\b/`.
5. **The route module is reachable.** `routeFile` is imported AND passed to a `.route(` call by `apps/api/src/routes/v1/index.ts`, or by a module that is itself reachable that way (`us/index.ts` is the normal case; follow the chain, at most 3 hops). There is no rule on the mount NAME.
6. `usAccess === "required"` ⇒ both callers reference one of `resolveUsLayer`, `usLayerForRequest` or `usLayerFor` (the identifiers P0-03 creates). Until P0-03 merges no row is `required`, so this assertion is vacuous — add a PREMISE case that fails once any row is `required` and none of the three identifiers is exported from `packages/services/src/us/`.
7. Repo-wide: no file under `apps/web/app`, `apps/web/components`, `apps/web/lib` matches `fetch\(\s*[`"']\/v1\/`; no file under `apps/api/src`imports from`apps/web`or`@/`.
8. PREMISE: `US_SURFACES.length >= 1` and every scanned file was read (a scan that reads nothing passes forever).

Zod single-source check: in `routeFile` and `actionFile`, fail on `/\bz\.object\(/` — callers import schemas, they never declare them. (Allow-list is empty.)

**Mutation check (do it, then revert, and paste the red output in the PR):** (a) delete the `getUsAccessStatus` import in the route → rule 3 fails; (b) add `import { prisma } from "@usemoney/database"` to the action → rule 4 fails; (c) add a `z.object({})` in the route → zod rule fails; (d) comment out the `usRoutes.route` line → rule 5 fails.

## Cross-surface access (§6)

1. Search — n/a: no user-visible entity. 2. Watchlist — n/a: nothing to star. 3. Sage — n/a: no screen. 4. Home — n/a. 5. Deep link — n/a: API only. 6. API — yes: `GET /v1/us/access-status`, row `access-status`. 7. Demo — demo gets `mayServe:false` from the action (no Clerk user); asserted in tests. 8. Telemetry — n/a: a status read fires no event (it is polled by other screens).

## Tests

- `packages/services/__tests__/us/access-status-logic.test.ts` — allowed email → `mayServe:true`; unknown → false; `lookupFailed` → `{mayServe:false, determined:false}`; `checkedAt` is ISO.
- `packages/services/__tests__/us/access-status-service.test.ts` — functional through the `deps.prisma` seam (the pattern in `packages/services/__tests__/result-feedback-service.test.ts`): allowlisted email, non-allowlisted, throw → `determined:false`. Default allowlist is the founder only; no env set in the test.
- `apps/api/__tests__/routes/us-access-status-contract.test.ts` — envelope `{success:true,data:{mayServe,determined,checkedAt}}`; unknown query key → 400 (strict schema).
- `apps/web/__tests__/actions/us-access-status.test.ts` — no Clerk user → `mayServe:false`, success true.
- `packages/services/__tests__/us/us-surface-parity.test.ts` — above.
- Update the two `V1_ENDPOINTS` pins to 39 and add `/v1/us` to the path assertions in `v1-helpers.test.ts`.
- Update `TEST-COVERAGE.md`; `yarn test:coverage-check` must pass; the new workspace case count must be reflected in `scripts/test-case-floors.json` only if the floor script asks.

## Acceptance

- [ ] `@usemoney/services/us/*` resolves from `apps/web`, `apps/api` and tests (`yarn build` green; `apps/api` bundle includes it).
- [ ] `GET /v1/us/access-status` with the founder's token → `mayServe:true`; any other user → `mayServe:false`, 200, not 403.
- [ ] `getUsAccessStatusAction()` returns the same JSON for the same user (functional test compares the two callers' outputs on one stubbed user).
- [ ] Parity test green; all four mutations above turn it red.
- [ ] `V1_ENDPOINTS.length === 39`; both pin tests and both CLAUDE.md lines updated.
- [ ] `docs/prompts/us-fullstack/00-shared-context.md` is NOT edited here (it already describes this). `apps/api/CLAUDE.md` gains a short "US service contract" section pointing at `packages/services/src/us/registry.ts`.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`; `/code-review`; PR lists `/v1/us/access-status` and the `access-status` row.

## Out of scope / hand-offs

- Converting `saved-screens` to the contract — file a ticket only if you touch it (you should not here).
- `resolveUsLayer` / `useUsLayer` and retiring the two `us-access.ts` resolvers → **P0-03**.
- Narrowing `UsSurface.flag` to the registry key type → whichever of **P0-01 / P0-02** merges second.
- Entitlement rule replacing the allowlist inside `getUsAccessStatus` → **P0-04**.
