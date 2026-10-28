# P0-06 · Global market switch — India · US · Both

Ticket: MONEY-1625 · Branch: `feat/MONEY-1625` · Flag(s): `us-market-switch` · Screens: S0.6 market pill (header + mobile top bar) · Depends on: P0-05 (`User.market`, `market-profile` service), P0-03 (`useUsLayer`) · Parallel-safe with: P0-08

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

A user with US access sees a compact `India · US · Both` pill in the top bar on every page. Picking one persists to `User.market` and becomes the default market for every market-aware surface — search today, screener/markets/dashboard as Phase 1 lands them. A user without US access never sees the pill and is always `IN`.

## Why / measured state today (verified 2026-09-24)

- No user- or UI-level market concept exists. After P0-05 `User.market` (`IN | US | BOTH`, optional, absent = IN) exists with `getMarketProfile` / `updateMarketProfile` and `GET/PATCH /v1/me/market`.
- Search is the only market-aware surface today: `/api/market/search` returns US rows only for an explicit `includeUs=true` AND the flag (`apps/web/app/api/market/search/route.ts:20`, `:123`); `CommandPalette` deliberately sends NO `includeUs` (`apps/web/components/CommandPalette.tsx:238`); `InstrumentSearch` can (`apps/web/components/InstrumentSearch.tsx:32`).
- Headers: desktop `apps/web/components/TopBar.tsx` (`hidden lg:block`, `:102`); mobile `MobileHeader` in `apps/web/components/Sidebar.tsx:2204` (`<header className="lg:hidden …">` `:2259`). The v2 tab bar (Home · Portfolio · Sage · Discover · You) is NOT built — `GlobalMobileBottomNav.tsx` still has Holdings · Screener · Chat · Brokers · More — so the pill goes in the mobile TOP bar, which §4 of the US shared context already specifies ("the market pill sits in the top bar on both").
- `MarketPill` does not exist (W00 not built); W00 specifies `apps/web/components/design-v2/MarketPill.tsx`, `INDIA | US`, extensible to a third pill (`docs/prompts/design-v2/web/W00-design-primitives-and-shell.md:36`).

## Read first (verified paths)

- P0-05 output: `packages/services/src/us/market-profile{-logic,.service}.ts`, `apps/web/lib/actions/us-market-profile.ts`
- P0-03 output: `apps/web/lib/hooks/useUsLayer.ts`, `packages/services/src/us/us-layer-logic.ts`
- `apps/web/components/TopBar.tsx`, `apps/web/components/Sidebar.tsx:2204-2300`, `apps/web/app/layout.tsx`
- `apps/web/components/CommandPalette.tsx:230-260`, `apps/web/components/InstrumentSearch.tsx`, `apps/web/app/api/market/search/route.ts`
- `docs/design/v2-bundle/app/shell2.jsx` (`TopBarV2` `:44`), `v2 US Launch.dc.html` (market pill)

## Build — in this order

### 1. Service — no new service

The switch writes through `updateMarketProfile(userId, {market})` (P0-05). Add ONE pure function to `market-profile-logic.ts`:

```ts
/** The market a surface should default to. Without US access the answer is always IN, whatever is stored. */
export function effectiveMarket(
  stored: "IN" | "US" | "BOTH",
  usLayer: "on" | "gated" | "absent",
): "IN" | "US" | "BOTH" {
  return usLayer === "on" ? stored : "IN";
}
```

`updateMarketProfile` fires `market_switched {from, to, flag:"us-market-switch"}` when the change comes from the pill (patch gains an optional `source: "pill" | "settings" | "onboarding"`, default `"settings"`; `market_selected` stays for onboarding/settings). The service does NOT check US access for writes — storing `US` without access is harmless because every read goes through `effectiveMarket`.

### 2. Server action

Reuse `updateMarketProfileAction` / `getMarketProfileAction` (P0-05). No new action file.

### 3. `/v1`

Reuse `PATCH /v1/me/market` (P0-05) — this satisfies the ticket's "apps/api `PATCH /v1/me` accepts `market`". `GET /v1/us/access-status` already tells mobile whether to show the pill (layer + flags). No new route, no new `US_SURFACES` row.

### 4. UI

- `apps/web/components/design-v2/MarketPill.tsx` (+ `market-pill-logic.ts`): three segments `India · US · Both`, `role="radiogroup"`, each segment a `role="radio"` ≥ 44×44 px hit area, keyboard arrows move selection. Optimistic update; on failure revert and toast "Couldn't switch market".
- `apps/web/lib/market/market-context.tsx`: `MarketProvider` (mounted once in `apps/web/app/layout.tsx` inside the existing providers) holds `{ stored, layer }`, loaded once per session from `getMarketProfileAction()` + `useUsLayer("us-market-switch")`. `useMarket()` returns `{ market: effectiveMarket(...), setMarket, pillVisible }`. `pillVisible = layer === "on"` (licence AND `us-market-switch`).
- Mount: `TopBar.tsx` (right cluster, left of the profile menu) and `MobileHeader` in `Sidebar.tsx` (right of the logo). Both render `null` unless `pillVisible` — no placeholder, no skeleton that reveals a hidden feature (flag-off = absent).
- First consumer: search. `CommandPalette` and `InstrumentSearch` send `includeUs=true` only when `useMarket().market !== "IN"`. The server still enforces the layer (P0-03), so a forged `includeUs` changes nothing. Result ordering: `BOTH` interleaves by relevance (current behaviour); `US` puts US rows first. Keep the cache-key rule at `search/route.ts:296-310` — `includeUs` is already in the key.

## Screens

### S0.6 market pill — 375px (mobile top bar)

```
┌──────────────────────────────────────┐
│ ≡ UseMoney     [India|US|Both•]  (S) │
├──────────────────────────────────────┤
│ Dashboard                            │
│ …                                    │
└──────────────────────────────────────┘
```

Segment labels at 375px: `IN · US · Both` if the full labels overflow (measure; never wrap). 1280px: in `TopBar` right cluster, full labels `India · US · Both`, same component.

### States

| State    | Pill                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| loading  | not rendered until the layer resolves (no flash of a hidden feature)                                 |
| empty    | stored market absent → `India` selected                                                              |
| error    | write fails → revert selection + toast; read fails → not rendered                                    |
| DataGap  | n/a                                                                                                  |
| gated    | not rendered (FREE in `entitled` mode has no US access; they meet GateInline on US surfaces instead) |
| flag-off | not rendered; `useMarket().market === "IN"`                                                          |
| demo     | not rendered (demo is `absent`); demo US content comes from the P0-07 fixture, not the pill          |

### U1–U7

| User                          | Pill                                               | Default market  |
| ----------------------------- | -------------------------------------------------- | --------------- |
| U1 India-only                 | hidden                                             | IN              |
| U2 US-interested, with access | shown, preselected from onboarding                 | stored          |
| U3 existing India             | hidden unless they have access; then shows `India` | IN (backfilled) |
| U4 demo                       | hidden                                             | IN              |
| U5 FREE, flag on              | hidden (no US access)                              | IN              |
| U6 paid, flag on              | shown (once mode = `entitled`)                     | stored          |
| U7 founder                    | shown                                              | stored          |

## Cross-surface access (§6)

1. Search — yes: this prompt wires it (`includeUs` from `useMarket`). 2. Watchlist — n/a: no entity; P1-08 reads `useMarket` for its default tab. 3. Sage — n/a here; P2-02's Sage pill reads `useMarket` for its default. 4. Home — n/a here; P1-08 dashboard cards read `useMarket`. 5. Deep link — n/a (pill state, not a URL); surfaces that accept `?market=` let the URL win over the context. 6. API — reuses `PATCH /v1/me/market`; mobile decides visibility from `GET /v1/us/access-status`. 7. Demo — hidden; asserted. 8. Telemetry — `market_switched {from, to, flag:"us-market-switch"}` (server), `market_pill_viewed {flag}` once per session (client).

## Tests

- `packages/services/__tests__/us/market-profile-logic.test.ts` — `effectiveMarket` for each stored value × layer; `source:"pill"` fires `market_switched`, other sources do not.
- `apps/web/__tests__/design-v2/market-pill.test.tsx` — radiogroup roles; arrow keys; three segments; failure reverts.
- `apps/web/__tests__/market/market-context.test.tsx` — `pillVisible` false for absent/gated layer and for flag off; `market` forced to IN when not `on` even if stored `US`.
- `apps/web/__tests__/components/command-palette-include-us.test.ts` — `includeUs` sent only when effective market ≠ IN (pure helper extracted from the palette).
- **Mutation check:** make `effectiveMarket` return `stored` unconditionally → the context test goes red (a user without access would get US defaults).
- `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] Founder with `us-market-switch` on: pill visible on desktop and 375px; switching to US makes Ctrl-K return AAPL; reload keeps it; `GET /v1/me/market` shows `US`.
- [ ] A non-allowlisted test account with the flag on: no pill, search India-only, even if its stored market is `US`.
- [ ] Flag off: no pill anywhere, no layout shift in either header.
- [ ] Screenshots U1, U2, U5 at 375 + 1280, light + dark.
- [ ] `verify:push`; `/code-review`.

## Out of scope / hand-offs

- Screener pill default → **P1-06**; US Markets default → **P1-07**; watchlist + dashboard cards → **P1-08**; Sage pill → **P2-02**. Each reads `useMarket()`; none adds a second market store.
- The v2 tab bar (DS-IA4 / design-review DT6) — not in this program; when it lands the pill stays in the top bar.
