# P1-03 · US in every picker — search, command palette, recents

Ticket: MONEY-1627 · Branch: `feat/MONEY-1627` · Flag(s): `us-stocks-search` · Screens: S1.1 · Depends on: P0-03 (`resolveUsLayer`/`useUsLayer`), P1-02 (search module moved into `packages/services` + rung) · Parallel-safe with: P1-05 (not P1-01: this prompt depends on P1-02, which depends on P1-01)

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

A user with US access and `us-stocks-search` on finds a US listing from global search and the command palette. The pick carries `{market:"US", listingId}` and is never persisted as an NSE/BSE row. Recent searches remember the market. `/v1/us/search` gives mobile the same answer.

## Why / measured state today (verified)

- `apps/web/components/InstrumentSearch.tsx:15` is headed "INDIA ONLY — this is a WRITE-SIDE picker". At `:153-157` it deliberately omits `includeUs`, because `AddTradeDialog`, `AddMutualFundDialog` and the watchlist persist the pick into India-resolved records.
- `apps/web/components/CommandPalette.tsx:238-250` omits `includeUs`. Its mapping drops `market`/`listingStatus`/`listingEndDate`, and it routes to `/stock/{symbol}?exchange=…`, which resolves `instrumentMapping` first. A colliding ticker (214 exist in both markets) renders Indian data under a US name.
- `apps/web/app/api/market/autocomplete/route.ts:14-51` is India-only by design. Leave it.
- `/api/market/search` (`route.ts:105-123`) already has a US leg double-gated by `includeUs` AND `us-stocks-search`.
- `apps/api` has no search family. Search is `GET /v1/discover/search` (`apps/api/src/routes/v1/discover.ts:135`). The ticket says "`/v1/search` gets a US leg"; that would be a 39th family. Per shared context §2 it becomes `GET /v1/us/search`.
- There is NO recent-searches store anywhere (grep `recent` in both pickers: nothing). `User.preferences Json?` (`schema.prisma:11` model, comment "namespaced by feature", MONEY-219) is the existing per-feature bucket.
- The US page link target: `/stock/[symbol]` US branch (`apps/web/app/stock/[symbol]/page.tsx:195-218`) resolves `resolveInstrument({market:"US"})` only AFTER India misses. P1-04 adds `/us/stock/[symbol]`.

## Read first (verified paths)

- `packages/services/src/us/search.service.ts` (moved by P1-02; returns `{rows, rung}`).
- `apps/web/components/InstrumentSearch.tsx`, `apps/web/components/CommandPalette.tsx`, `apps/web/components/terminal-luxe/InstrumentAutocomplete.tsx` (third picker: leave it India-only and say so in the PR).
- `apps/web/app/api/market/search/{route,search-logic}.ts`, `apps/api/src/lib/us-access.ts:83` `mayServeUsMarket`, `apps/web/lib/market/us-access.ts:77`.
- `packages/services/src/us/registry.ts` (`US_SURFACES`), `apps/api/src/routes/v1/us/` (family mounted by P0-01), the flag registry (P0-02).
- Telemetry pattern: `apps/web/lib/hooks/useDemoAnalytics.ts:57-60` (lazy `posthog-js` then `capture`).

## Build — in this order

### 1. Service

In `packages/services/src/us/search.service.ts` add:

```ts
export const UsSearchInputSchema = z.object({
  q: z.string().trim().min(1).max(40),
  limit: z.number().int().min(1).max(20).default(8),
  includeDelisted: z.boolean().default(true),
});
export async function searchUs(
  userId: string,
  input: UsSearchInput,
): Promise<
  ServiceResult<{ rows: UsPick[]; rung: "atlas" | "prisma-fallback" }>
>;
// UsPick = { market:"US"; listingId; symbol; name; exchange; assetType; listingStatus; listingEndDate: string|null }
```

Recents go in a sibling, `packages/services/src/recents.service.ts` + `recents-logic.ts` (pure):

- `recordRecent(userId, {market:"IN"|"US", symbol, exchange, listingId?})`. It writes `User.preferences.recents` (a max-20 LRU, dedupe key `market+listingId|symbol+exchange`) with a read-modify-write of the JSON. The other namespaces are preserved; test it.
- `listRecents(userId, {market?})`. US entries are dropped at READ time when US access fails. The rows stay stored so re-entitlement restores them.

### 2. Server action

`apps/web/lib/actions/us-search.ts` (`"use server"`): `searchUsAction(input)` and `recordRecentAction(input)` / `listRecentsAction()`. Each one is auth → DB user → `resolveUsLayer()` (P0-03) → `UsSearchInputSchema.parse` → service. When refused it returns `{rows:[]}` (absence). The action never imports `@usemoney/database`.

### 3. `/v1` route + `US_SURFACES` row

- `apps/api/src/routes/v1/us/search.ts`: `GET /v1/us/search?q=&limit=` uses the same schema, service and absence rule. Recents are `GET/POST /v1/me/recents` (sub-path of the existing `me` family; no new family).
- Add a `US_SURFACES` row: `{surface:"search", flag:"us-stocks-search", usAccess:"required", serviceExport:"searchUs", serviceFile:"packages/services/src/us/search.service.ts", actionFile:"apps/web/lib/actions/us-search.ts", routeFile:"apps/api/src/routes/v1/us/search.ts", routePath:"/v1/us/search"}`. Mount it with one `usRoutes.route("/search", …)` line in `us/index.ts`.
- Recents get no row: `/v1/me/recents` serves India-only users too and is not US data. Both of its callers still import `recents.service.ts` (§2 rules 1–3 apply; only the registry row is skipped).

### 4. UI

- `CommandPalette.tsx`: when `useUsLayer().on && flags["us-stocks-search"]`, run `searchUsAction` in parallel with the India fetch and render a separate **"US · EOD"** group below India. Each row shows the symbol, name, exchange chip and a `DELISTED 2017` chip when applicable. Select → `usStockHref(pick)`.
- `InstrumentSearch.tsx`: add an `includeUs?: boolean` prop, default `false`, and keep the header note. Only read-side callers may pass it. The watchlist picker is flipped by P1-08, after `WatchlistItem` can hold a listing. `AddTradeDialog`/`AddMutualFundDialog` NEVER get it; add a test that pins this.
- New `apps/web/lib/market/us-href.ts`: `usStockHref({symbol, listingId, listingStatus})`. It returns `/stock/${encodeURIComponent(symbol)}` today, and `?listing=${encodeURIComponent(listingId)}` is appended for DELISTED. **P1-04 changes this one function to `/us/stock/…`.** Every US link in Phase 1 goes through it.
- Recents: when the input is empty, the palette shows "Recent" (max 5) with a market chip on each row. `recordRecentAction` fires on select.
- Telemetry: `us_search_opened {flag:"us-stocks-search"}` on first render of the US group, and `us_search_selected {flag, listingId, rung}`.

## Screens

### S1.1 — command palette, 375px (bottom sheet)

```
┌──────────────────────────────────────┐
│ ⌕  apple                          ✕  │
├──────────────────────────────────────┤
│ INDIA                                │
│  —  No NSE/BSE match                 │
│ US · ◷ EOD                           │
│  AAPL  Apple Inc.        NASDAQ  ›   │
│  APLE  Apple Hospitality  NYSE   ›   │
│  AAPB  GraniteShares 2x   NASDAQ ›   │
│ RECENT                               │
│  US  NVDA  NVIDIA Corp          ›    │
│  IN  TCS   Tata Consultancy     ›    │
└──────────────────────────────────────┘
```

```
┌──────────────────────────────────────┐
│ ⌕  DOW                            ✕  │
│ US · ◷ EOD                           │
│  DOW  Dow Inc.           NYSE    ›   │
│  DOW  Dow Chemical  DELISTED 2017 ›  │
└──────────────────────────────────────┘
```

1280px: the existing centred palette. The US group sits below India with a `US` section header; keyboard ↑↓ crosses groups.

| State      | Render                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------- |
| loading    | 3 skeleton rows in the US group at final height                                          |
| empty      | "No US listing matches “xyz”" (US group only)                                            |
| error      | US group hidden; India results unaffected; failure counted (P1-02)                       |
| DataGap    | n/a (search is identity only; no prices shown)                                           |
| gated (U5) | one inline row: GateInline "US stocks are part of PRO" → `/upgrade?market=US`            |
| flag-off   | no US group, no US recents, `/v1/us/search` → `{rows:[]}`                                |
| demo       | fixture rows AAPL/MSFT/NVDA from the demo dataset (P0-07); select opens the demo US page |

| User                     | Behaviour                                |
| ------------------------ | ---------------------------------------- |
| U1 India-only            | no US group, ever                        |
| U2 US-interested, access | US group + US recents                    |
| U3 existing India        | same as U1 until market prefs include US |
| U4 demo                  | demo US rows                             |
| U5 FREE, flag on         | GateInline row, no results leaked        |
| U6 paid                  | full                                     |
| U7 founder               | full, any plan                           |

## Cross-surface access (§6)

1. Search: this IS the surface. 2. Watchlist: n/a here; P1-08 adds `includeUs` to the watchlist picker. 3. Sage: n/a (identity rows; the Ask-Sage chip lives on the destination page, P1-08). 4. Home: recents feed P1-08's Home row. 5. Deep link: `usStockHref`. 6. API: `/v1/us/search`, `/v1/me/recents`, plus a `US_SURFACES` row. 7. Demo: fixture rows. 8. Telemetry: two events above.

## Tests

- `packages/services/__tests__/us-search-service.test.ts`:
  - refused access returns `{rows:[]}` with the same shape as a no-match;
  - **DOW:** two listings come back as two rows with distinct `listingId`; the DELISTED row carries `listingEndDate`; no row is keyed by bare symbol.
- `packages/services/__tests__/recents-logic.test.ts`: LRU cap 20, dedupe, preserves `preferences.research`, US rows filtered on refusal.
- `apps/web/__tests__/components/instrument-search-write-side.test.ts`: `AddTradeDialog`/`AddMutualFundDialog` source never passes `includeUs` (source scan is acceptable here: it asserts a call-site fact, not a policy).
- `apps/api/__tests__/routes/us-search-contract.test.ts`: the envelope, the absence on refusal, and a `q` over 40 characters giving 400 via the shared schema.
- The `us-surface-parity.test.ts` row passes. `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] Founder, flag on: ⌘K "apple" shows AAPL under US, and select opens the US page. "DOW" shows two rows.
- [ ] Flag off or non-allowlisted: zero US rows in the palette and `/v1/us/search`, and no 403 anywhere.
- [ ] India palette results byte-identical (existing tests green).
- [ ] U1/U2/U5 screenshots at 375/1280, light and dark; `verify:push`; `/code-review`.

## Out of scope / hand-offs

The `/us/stock/[symbol]` route (P1-04 flips `usStockHref`). The watchlist picker and ☆ writes (P1-08). The Home recents row (P1-08). The autocomplete route stays India-only.
