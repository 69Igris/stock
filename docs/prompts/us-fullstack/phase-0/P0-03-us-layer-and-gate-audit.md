# P0-03 · One US-layer selector + the US gate audit

Ticket: MONEY-1562 (+ MONEY-1561) · Branch: `feat/MONEY-1562` (one PR closes both) · Flag(s): reads `us-stocks-listing`, `us-stocks-search`; declares none · Screens: none · Depends on: P0-01 (service contract), P0-02 (flag registry) · Parallel-safe with: P0-08, P0-09

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Two gates — the licence and the product flag — are evaluated in ONE function, `resolveUsLayer(userId, flag)`, used by every web route, server action, `/v1` route and the market-data token mint; the browser gets one hook, `useUsLayer(flag)`. The three routes that serve US prices without the product flag get it. A source scan fails when a US read path skips the selector, and the setup doc records every route with both gate states and the token-TTL revocation lag.

## Why / measured state today (verified 2026-09-24)

| Surface                                   | Licence gate                                                                                                | Product flag                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/api/market/quote`                       | `apps/web/app/api/market/quote/route.ts:135` `currentUserMaySeeUsMarket()`                                  | **absent**                                                       |
| `/api/market/stream`                      | `apps/web/app/api/market/stream/route.ts:141`                                                               | **absent**                                                       |
| `/stock/[symbol]`                         | `apps/web/app/stock/[symbol]/page.tsx:195`                                                                  | `:187-195` `us-stocks-listing` (both)                            |
| market-data token mint                    | `apps/web/lib/actions/market-data-token.ts:70`                                                              | n/a — the `us` claim is the licence                              |
| `/api/market/search`                      | none (US rows gated by flag only)                                                                           | `apps/web/app/api/market/search/route.ts:123` `us-stocks-search` |
| `GET /v1/market/us/quotes`                | `apps/api/src/routes/v1/market.ts:556` `mayServeUsMarket`                                                   | **absent** — reachable by any Bearer token                       |
| `apps/market-data` quotes/history/symbols | trusts the claim: `tokenMayReadUs` (`apps/market-data/src/app-logic.ts:262`, used at `routes/quotes.ts:63`) | n/a                                                              |

- The licence rule is resolved twice: `apps/web/lib/market/us-access.ts` (Clerk id → email, 5-min cache, fail-closed) and `apps/api/src/lib/us-access.ts:83` `mayServeUsMarket` (Mongo id → email, no cache, test seam `__setUsAccessEmailResolverForTests`). Both call `isUsMarketAllowed` (`packages/core/src/market-data/us-market-access.ts:67`).
- `apps/web/proxy-routes.ts` does no US gating; every branch is inside a page.
- **Revocation lag = token TTL = 300 s** (`TOKEN_TTL_SECONDS`, `apps/web/lib/actions/market-data-token.ts:37`). Narrowing the allowlist takes effect on `apps/market-data` only after outstanding tokens expire.
- A source scan already exists: `packages/core/__tests__/market-data/us-market-access-wired.test.ts` (`US_READ_ENTRY_POINTS` = quote/bar/tile readers; `GATE_MARKERS` accepts ANY of five gate names). It asserts "a gate", not "THE selector", and it does not cover direct reads of `usInstrument` (`apps/web/lib/market/us-instrument-search.ts:466`, `apps/market-data/src/routes/symbols.ts:255`).
- `useUsFeatureFlags` has no consumers; after P0-02 it derives from `US_FLAGS`.

## Read first (verified paths)

- The seven sites in the table; `packages/core/__tests__/market-data/us-market-access-wired.test.ts`; `apps/api/__tests__/routes/market-us-quotes-contract.test.ts` (uses the api test seam); `apps/web/__tests__/market/us-stock-page-branch.test.ts`
- P0-01 output: `packages/services/src/us/{registry,access-status.service,access-status-logic}.ts`
- P0-02 output: `packages/core/src/flags/us-flags.ts`, `packages/services/src/flags/us-flags.service.ts`
- `docs/setup/us-feature-flags-setup.md`

## Build — in this order

### 1. Service — `packages/services/src/us/us-layer-logic.ts` + `us-layer.service.ts`

```ts
// us-layer-logic.ts (pure)
export type UsLayerState = "on" | "absent"; // P0-04 adds "gated"
export interface UsLayer {
  state: UsLayerState;
  mayServe: boolean;
  flagOn: boolean;
  determined: boolean;
}
export function composeUsLayer(a: {
  mayServe: boolean;
  determined: boolean;
  flagOn: boolean;
}): UsLayer {
  const on = a.determined && a.mayServe && a.flagOn;
  return { state: on ? "on" : "absent", ...a };
}
```

```ts
// us-layer.service.ts
export async function resolveUsLayer(userId: string | null | undefined, flag: UsFlagKey | null, deps?: …): Promise<UsLayer>
```

- `userId` falsy (signed out, demo) → `absent` without I/O.
- Licence from `getUsAccessStatus` (P0-01). Flag from `getUsFlags` (P0-02); `flag: null` = licence-only (used by the token mint and by data routes whose page carries the flag).
- Add a determined-only 5-min in-process cache to `getUsAccessStatus`, keyed by `userId` (it replaces the web resolver's email cache; `/api/market/quote` is polled every few seconds per tab). Never cache `determined:false`.
- Returns plain JSON, never throws (a thrown error → `absent`, `determined:false`).

Extend `access-status` (P0-01's surface) so mobile gets the same answer: `UsAccessStatus` gains `flags: UsFlagMap` (from `getUsFlags`). One call tells a client its licence and every flag; `/v1/me/flags` stays for India-only clients that never touch `/v1/us`.

### 2. Callers — delete the two resolvers

- `apps/web/lib/market/us-access.ts`: replace the body with `export async function usLayerForRequest(flag: UsFlagKey | null)` = `getAuthenticatedUser()` → `resolveUsLayer(user?.userId, flag)`. Delete `resolveEmail`, the email cache and `currentUserMaySeeUsMarket`.
- `apps/api/src/lib/us-access.ts`: replace with `export async function usLayerFor(c, flag)` = `resolveUsLayer(c.get("userId"), flag)`. Delete `userEmailForUsAccess`, `mayServeUsMarket` and the email-resolver seam; migrate `market-us-quotes-contract.test.ts` to stub the service via its `deps` seam (or a module seam on `usLayerFor`), keeping BOTH the allowed and refused cases.
- Rewire every site in the table:
  - `/api/market/quote`, `/api/market/stream`: `usLayerForRequest("us-stocks-listing")` — **adds the flag (MONEY-1561)**. Refusal stays `{}` / an absent symbol, never 403.
  - `/stock/[symbol]/page.tsx`: one call `usLayerForRequest("us-stocks-listing")` replaces the flag read + licence read.
  - `/api/market/search`: `usLayerForRequest("us-stocks-search")` — **adds the licence gate**: a US row is returned only when the layer is `on`. (Today a flagged-on, non-licensed user sees US names in search; names are not prices, but a hit links to a page they cannot open.)
  - `market-data-token.ts:70`: `(await usLayerForRequest(null)).mayServe` (licence only — the claim is the data gate; pages carry flags).
  - `/v1/market/us/quotes`: `usLayerFor(c, "us-stocks-listing")` — **adds the flag (MONEY-1561)**; refused → the existing empty quote map.
- `apps/market-data` keeps `tokenMayReadUs` (it cannot evaluate anything per request; the claim is minted by the selector).

### 3. Client — `apps/web/lib/hooks/useUsLayer.ts`

`useUsLayer(flag: UsFlagKey): { state: "loading" | UsLayerState }` — calls `getUsAccessStatusAction()` once per page load (module-level promise memo, reset on sign-out), composes with `composeUsLayer`. Signed-out/demo → `absent` with no call. It is the ONLY way a component decides whether to show US market data (`licensed: true` flags); `useUsFeatureFlags` stays for `licensed: false` flags such as `us-onboarding` (scan below).

### 4. `/v1` + registry

No new route: `access-status` (already a `US_SURFACES` row) now carries `flags`. Update its contract test.

### 5. The audit doc — `docs/setup/us-feature-flags-setup.md`

Add a "Routes and gates" table: every row of the table above plus `/v1/us/*` and `/v1/me/flags`, with columns `licence`, `flag`, `refusal shape`, `file:line`. State: "Revocation lag: a narrowed allowlist reaches apps/market-data only after `TOKEN_TTL_SECONDS` = 300 s." Link the scan test as the enforcement.

## Tests

- `packages/services/__tests__/us/us-layer-logic.test.ts` — truth table (mayServe × flagOn × determined → state); `determined:false` is always `absent`.
- `packages/services/__tests__/us/us-layer-service.test.ts` — null userId → absent, zero I/O; licence cache: second call no prisma read; `determined:false` not cached; `flag:null` ignores flags.
- `apps/api/__tests__/routes/market-us-quotes-contract.test.ts` (migrated) — allowed+flag on → quotes; allowed+flag off → empty map, 200; not allowed → empty map, 200; never 403.
- `apps/web/__tests__/market/us-stock-page-branch.test.ts` — updated to the single call.
- New `apps/web/__tests__/market/us-layer-routes.test.ts` — functional: for `/api/market/quote`, `/api/market/stream` and `/api/market/search` with the layer stubbed `absent`, the US part of the response is empty and the status is 200.
- **Scan** — extend `packages/core/__tests__/market-data/us-market-access-wired.test.ts` (do not write a second scan):
  - `US_READ_ENTRY_POINTS` += `usInstrument.`, `usFundNav.`, `usFundamental`, `usNewsArticle.`, `usFilingInsight.`, `fxRate.`, `searchUsInstruments` (the ticket names `fx_rates`; keep it — FX is only read to render US values).
  - `GATE_MARKERS` becomes `["resolveUsLayer", "usLayerForRequest", "usLayerFor", "useUsLayer", "tokenMayReadUs"]` — the old five names no longer count. Add `apps/market-data/src/routes/symbols.ts` to the scanned population (it reads `usInstrument` directly) and record why `tokenMayReadUs` satisfies it.
  - New case: no production file outside `packages/services/src/us/` and `packages/core/src/market-data/us-market-access.ts` references `isUsMarketAllowed` or `getUsMarketAllowedEmails`.
  - New case: no file under `apps/web/components` or `apps/web/app` reads a flag whose `US_FLAGS` entry has `licensed: true` through `useUsFeatureFlags`/`getUsFeatureFlags` — those go through `useUsLayer`/`usLayerForRequest`. `licensed: false` flags (onboarding, market switch, upgrade, currency toggle, connect/import/LRS flows) may be read directly (P0-02 declares the field).
  - **Mutation check:** revert the quote route to `currentUserMaySeeUsMarket` → red; delete the `usLayerFor` call from `/v1/market/us/quotes` → red; call `isUsMarketAllowed` from a web route → red. Paste the red output in the PR.
- `TEST-COVERAGE.md` updated.

## Cross-surface access (§6)

1–4 n/a: no new surface; this changes who can reach existing ones. 5. Deep link — `/stock/AAPL` for a non-licensed user renders the India path / not-found exactly as today (absence). 6. API — `GET /v1/us/access-status` now carries `flags`; `/v1/market/us/quotes` gains the flag. 7. Demo — demo is `absent` everywhere (no Clerk user), asserted in the layer test. 8. Telemetry — n/a.

## Acceptance

- [ ] Every row of the table goes through `resolveUsLayer` (grep shows `currentUserMaySeeUsMarket` and `mayServeUsMarket` gone from the repo).
- [ ] Founder with `us-stocks-listing` OFF: `/api/market/quote?symbols=AAPL` and `/v1/market/us/quotes?symbols=AAPL` return no AAPL, 200. ON: AAPL present. Record both runs in the PR.
- [ ] `docs/setup/us-feature-flags-setup.md` has the routes table and the 300 s lag.
- [ ] Scan extended; mutation checks red then green; `verify:push`; `/code-review`.

## Out of scope / hand-offs

- The `gated` state (plan-based refusal that shows `GateInline`) and `US_MARKET_MODE` → **P0-04**.
- Adding `resolveUsLayer` to new surfaces — every Phase 1–3 prompt does it for its own route; the parity test (P0-01 rule 6) enforces it once a row is `usAccess:"required"`.
