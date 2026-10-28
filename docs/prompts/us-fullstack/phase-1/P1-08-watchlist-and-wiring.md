# P1-08 · Mixed watchlist + Phase-1 cross-surface wiring (☆, recents, Home US card, Ask-Sage slots)

Ticket: MONEY-1589 (+ MONEY-1631, MONEY-912) · Branch: `feat/MONEY-1589` · Flag(s): `us-watchlist`, `us-dashboard` (reads `us-stock-research` + `us-sage-entrypoints` for the Sage slots) · Screens: S1.5, S1.6 · Depends on: P1-03 (search, recents, `usStockHref`), P1-04 (page + header slots), P1-01 (rows), P0-08/MONEY-1578 (FX disabled-with-reason) · Parallel-safe with: P1-09

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Connect every Phase-1 US surface to the rest of the app:

1. **Watchlist.** It holds US listings by `listingId`. US rows show a `$` EOD price with an EOD badge. The ☆ works from the US stock header, screener rows and markets movers (1589, 1631).
2. **Recents.** Recently viewed US stocks appear on Home and in search (1631).
3. **Home US card.** A dashboard card with the ETF proxies, your US watchlist movers and US recents, linking into `/markets/us` and stock pages (912, scoped; see deltas).
4. **Ask-Sage slots.** On the stock page, screener row, markets page and watchlist row. Each passes `{market:"US", listingId}` and renders ONLY when `us-stock-research` && `us-sage-entrypoints`, so Phase 2 lights them up with no code change.

## Deltas / scope decisions (this prompt wins)

- **MONEY-912** ("USD dashboards + INR toggle + FX-adjusted P&L", no description) is scoped here to the Home US card plus the `$↔₹` display toggle (P0-08). **FX-adjusted P&L needs US holdings, which are plan 5 / P3-04.** Say so in the PR and leave 912 open for P3-04.
- **The Sage gate is `us-stock-research` && `us-sage-entrypoints`**, per shared context §3/§6. MONEY-1631's text names only `us-stock-research`; the stricter composition wins.
- **The watchlist half only** of W10 (MONEY-1589): holdings/tradebook are plan 5.

## Why / measured state today (verified)

- `WatchlistItem` (`packages/database/prisma/schema.prisma:3200`) has `symbol`, `exchange`, `instrumentId?`, `@@unique([watchlistId, symbol, exchange])`, and no `market`/`listingId`. `packages/services/src/watchlist.service.ts:319` `addWatchlistItem` upserts on `watchlistId_symbol_exchange`.
- **Key design (no index migration, no backfill).** A US row is written as `symbol = listingId`, `exchange = "US"`, plus two new optional columns: `market = "US"` and `listingId`.
  - The existing unique key then admits `DOW:NYSE:1972-…` and `DOW:NYSE:2019-…` as two rows.
  - India rows are untouched.
  - `"US"` is never an India exchange.
  - Never query `{market:"IN"}` or `{listingId: null}`: those fields are ABSENT on every pre-existing row and match nothing. Discriminate in code with `exchange === "US"`.
- The schemas live only in the route: `apps/api/src/routes/v1/watchlist.ts:68` `AddWatchlistItemSchema`, `:83` batch. The action (`apps/web/lib/actions/watchlist.ts:176`) re-validates nothing. Move both into `packages/services/src/watchlist-logic.ts` and import them from both callers (shared context §2 rule 3). This surface already calls one service, so it is not the saved-screens anti-example.
- The watchlist page `apps/web/app/watchlist/client.tsx` (2,102 lines) fetches India quotes per item. Every India quote path must skip `exchange === "US"` rows. Test it; otherwise a US row asks Yahoo for `DOW:NYSE:2019-….NS`.
- `InstrumentSearch.tsx` gets the `includeUs` prop from P1-03. The watchlist page is where it is passed, under `us-watchlist`.
- Dashboard: `apps/web/app/dashboard/client.tsx` + `apps/web/components/dashboard/DashboardOverview.tsx` (1,328 lines; server-warmed `initialStats`, MONEY-1126). W01's persona layouts are not built. Add ONE card to the existing overview; do not rebuild the dashboard.
- Sage entry: `apps/web/app/stocksage/client.tsx:459` reads `?prompt=`. Pass `&market=US&listingId=…` too; they are inert until P2-02 reads them.
- Recents: `packages/services/src/recents.service.ts` (P1-03), stored in `User.preferences.recents`.

## Read first (verified paths)

W10 §2 (watchlist); `packages/services/src/watchlist.service.ts`; `apps/web/lib/actions/watchlist.ts`; `apps/api/src/routes/v1/watchlist.ts`; `apps/web/app/watchlist/client.tsx`; `apps/web/hooks/useWatchlistMembership.ts`; `apps/web/components/dashboard/DashboardOverview.tsx`; `apps/web/app/dashboard/{page,client}.tsx`; `apps/web/lib/demo/data.ts:1285` (demo watchlists); `packages/services/src/us/{stock,markets,screener}.service.ts`; `packages/services/src/us/registry.ts`.

## Build — in this order

### 1. Services

- Schema: `WatchlistItem` gains `market String?` and `listingId String?` (comments state the key convention above). There is no index change: US reads go through `watchlistId` (already indexed).
- `packages/services/src/watchlist-logic.ts`: `AddWatchlistItemSchema = z.union([UsItemSchema /* {market: z.literal("US"), listingId} */, InItemSchema /* {market?: z.literal("IN"), symbol, exchange (≠ "US"), instrumentId?} */])`. Use `z.union`, not `discriminatedUnion`, because India bodies omit `market`.. The batch schema follows the same shape. A pure `toItemKey(input)` maps US to `{symbol: listingId, exchange:"US", market:"US", listingId}`.
- `addWatchlistItem`/`batchAddWatchlistItems`: accept the union. For US, the service verifies the listing exists in `UsInstrument` (by listingId) and refuses as NOT_FOUND otherwise.
- `WatchlistItemData` gains `market: "IN"|"US"` (derived `exchange==="US" ? "US" : "IN"`) and `listingId: string|null`.
- `packages/services/src/us/watchlist.service.ts`: `getUsWatchlistQuotes(userId, {listingIds ≤ 100})` reads `usScreenerRow` (lastClose, chg1D, lastCloseDate, priceFill). It returns absence for listings without a row; it never falls back to another source.
- `packages/services/src/us/home.service.ts`: `getUsHomeCard(userId)` returns `{asOf, proxies (reuse markets-logic), watchlistMovers (top 3 by |chg1D| among the user's US items), recents (US, 5)}`.

### 2. Server actions

- `apps/web/lib/actions/watchlist.ts`: `addWatchlistItemAction`/`batchAddWatchlistItemsAction` parse with the shared schema. A US input requires `resolveUsLayer()` + `us-watchlist`; otherwise NOT_FOUND.
- `apps/web/lib/actions/us-watchlist.ts`: `getUsWatchlistQuotesAction`.
- `apps/web/lib/actions/us-home.ts`: `getUsHomeCardAction` (`us-dashboard`).

### 3. `/v1` routes + `US_SURFACES` rows

- `POST /v1/watchlists/:id/items` and `/items/batch` (existing `watchlists` family) import the shared schema and accept `{market:"US", listingId}`. `GET /v1/watchlists` returns `market`/`listingId` on items.
- `GET /v1/us/watchlist/quotes?listingIds=` → `getUsWatchlistQuotes`.
- `GET /v1/us/home` → `getUsHomeCard`.
- Rows (all `usAccess:"required"`; mount the two `/v1/us` routes with `usRoutes.route("/watchlist", …)` and `usRoutes.route("/home", …)`):
  - `{surface:"watchlist-add", flag:"us-watchlist", usAccess:"required", serviceExport:"addWatchlistItem", serviceFile:"packages/services/src/watchlist.service.ts", actionFile:"apps/web/lib/actions/watchlist.ts", routeFile:"apps/api/src/routes/v1/watchlist.ts", routePath:"/v1/watchlists/:id/items", familyException:"existing mixed-market watchlist family; a US item is one more body shape, not a new surface"}`. The service lives outside `us/`; P0-01 rule 3 derives `@usemoney/services/watchlist.service` from `serviceFile`, so add that subpath to `packages/services/package.json` `exports` if it is missing.
  - `{surface:"watchlist-quotes", flag:"us-watchlist", usAccess:"required", serviceExport:"getUsWatchlistQuotes", serviceFile:"packages/services/src/us/watchlist.service.ts", actionFile:"apps/web/lib/actions/us-watchlist.ts", routeFile:"apps/api/src/routes/v1/us/watchlist.ts", routePath:"/v1/us/watchlist/quotes"}`
  - `{surface:"home", flag:"us-dashboard", usAccess:"required", serviceExport:"getUsHomeCard", serviceFile:"packages/services/src/us/home.service.ts", actionFile:"apps/web/lib/actions/us-home.ts", routeFile:"apps/api/src/routes/v1/us/home.ts", routePath:"/v1/us/home"}`

### 4. UI

- `apps/web/components/us/UsWatchStar.tsx` (☆/★, 44×44, optimistic, `useWatchlistMembership` extended with `market`/`listingId`). Mounted in the P1-04 header slot, on P1-06 result rows, and on P1-07 movers rows. It renders only under `us-watchlist`.
- `apps/web/components/us/AskSageUs.tsx`: a button that links to `/stocksage?prompt=<"Tell me about AAPL">&market=US&listingId=<id>`. It renders only when `flags["us-stock-research"] && flags["us-sage-entrypoints"]`. Mount it in the P1-04 header, on P1-06 rows (overflow), in the P1-07 page slot ("Ask Sage about today's US market", with no listingId) and on watchlist US rows.
- Watchlist page: US rows show a `US` chip, the symbol (from `listingId`), `$` price, `◷ EOD · SEP 23` and the 1D %. The `₹` secondary appears only under `us-currency-toggle` at SPOT with its stamp; a missing rate shows no ₹ plus the P0-08 reason. The picker passes `includeUs` under `us-watchlist`. Rows are sortable with India rows.
- Home: `apps/web/components/dashboard/UsHomeCard.tsx` goes into `DashboardOverview` after the stat strip, only under `us-dashboard`. Links: "US markets →" (`/markets/us`, only if `us-market-overview`), rows to `usStockHref`, and a "Recently viewed" row.
- Recents: the US stock page (P1-04 `page.tsx`) calls `recordRecentAction` on view. Search already shows recents (P1-03).
- Demo: add AAPL/MSFT/NVDA US items to a demo watchlist and a US home card fixture in `apps/web/lib/demo/data.ts` (or the P0-07 single fixture, if it exists: one fixture, not two).

## Screens

### S1.5 — mixed watchlist, 375px

```
┌──────────────────────────────────────┐
│ Watchlist · Core           + Add     │
├──────────────────────────────────────┤
│ IN  TCS    ₹4,212.50  +0.8%   ◷ 15m  │
│ IN  INFY   ₹1,904.10  −0.3%   ◷ 15m  │
│ US  AAPL   $229.87    +0.8%   ◷ EOD  │
│ US  NVDA   $121.44    −1.2%   ◷ EOD  │
│ US  DOW    $54.12     +0.2%   ◷ EOD  │
│     Dow Inc. · NYSE                  │
├──────────────────────────────────────┤
│ US prices are previous session close │
│ (SEP 23). India is exchange-delayed. │
└──────────────────────────────────────┘
```

### S1.6 — Home US card, 375px

```
┌──────────────────────────────────────┐
│ US MARKETS        ◷ EOD · SEP 23  ›  │
│ SPY +0.4%   QQQ +0.7%   DIA −0.1%    │
│ YOUR US WATCHLIST                    │
│ NVDA  $121.44  −1.2%                 │
│ AAPL  $229.87  +0.8%                 │
│ RECENTLY VIEWED  MSFT · GOOGL · AMZN │
│ [ Ask Sage about US today ]          │
└──────────────────────────────────────┘
```

1280px: the watchlist table gains MARKET and AS-OF columns. The Home card sits in the right column beside "My Holdings".

| State      | Render                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| loading    | watchlist: row skeletons; card: skeleton at final height                                                                |
| empty      | watchlist with no US rows: nothing extra; card with no US items: "Star a US stock to see it here" + proxies still shown |
| error      | quotes fail → US rows show `—` + `DataGapBanner` on the US group only; India unaffected                                 |
| DataGap    | row without an `us_screener_rows` entry → "Price not on file"; FX missing → no ₹, reason shown                          |
| gated (U5) | ☆ hidden; US rows already saved are kept but show GateInline once in the US group (no prices)                           |
| flag-off   | `us-watchlist` off → no ☆, no US picker section, existing US rows hidden (not deleted); `us-dashboard` off → no card    |
| demo       | demo US rows + card                                                                                                     |

| User | Behaviour             |
| ---- | --------------------- |
| U1   | nothing US anywhere   |
| U2   | ☆, mixed list, card   |
| U3   | as U1 until US access |
| U4   | demo                  |
| U5   | GateInline, no prices |
| U6   | full                  |
| U7   | full                  |

## Cross-surface access (§6)

1. Search: recents in the palette (P1-03); the picker adds US. 2. Watchlist: this PR. 3. Sage: `AskSageUs` on 4 surfaces, dark until both flags. 4. Home: `UsHomeCard`. 5. Deep link: `/watchlist` unchanged; stock links via `usStockHref`. 6. API: 3 rows + the extended `/v1/watchlists`. 7. Demo: fixtures. 8. Telemetry: `us_watch_toggled {flag:"us-watchlist", listingId, on}`, `us_home_card_viewed {flag:"us-dashboard"}`, `us_ask_sage_clicked {surface, listingId}`.

## Tests

- `packages/services/__tests__/watchlist-us.test.ts`:
  - **DOW:** adding `DOW:NYSE:1972-…` and `DOW:NYSE:2019-…` yields 2 rows; removing one leaves the other;
  - an unknown listingId gives NOT_FOUND;
  - an India add is unchanged (golden);
  - `market` is derived, never queried.
- `packages/services/__tests__/watchlist-logic.test.ts`: the union (an India body with `exchange:"US"` is rejected; a US body without `listingId` gives a 400 issue; an IN body without `market` stays valid).
- `apps/web/__tests__/app/watchlist-mixed.test.tsx`:
  - India quote fetch is never called for `exchange==="US"`;
  - **no `₹` glyph in a US price cell**;
  - the EOD badge is on US rows.
- `apps/web/__tests__/components/ask-sage-us.test.tsx`: renders null unless BOTH flags are on; the href carries `market=US&listingId=`.
- `apps/api/__tests__/routes/us-watchlist-contract.test.ts`: the add-US envelope, quotes absence, and `/v1/us/home` absence on refusal.
- `TEST-COVERAGE.md`.

## Acceptance

- [ ] Founder: ☆ AAPL on the stock page, and it appears in `/watchlist` with an EOD price; ☆ from the screener and markets rows works; both DOW listings can be starred.
- [ ] India watchlist behaviour unchanged (existing tests + golden).
- [ ] Ask-Sage buttons are absent with `us-sage-entrypoints` off, and appear with both on (flip locally).
- [ ] The MONEY-912 scope note is in the PR; U1/U2/U5 screenshots; `verify:push`; `/code-review`.

## Out of scope / hand-offs

FX-adjusted P&L and US holdings (P3-04). The Sage side of `market`/`listingId` (P2-02). US price alerts. W01 persona layouts.
