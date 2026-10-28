# M10 · Module: App shell + navigation — 5-tab bar (Sage centre) · topbar · ticker · global search · sheets · toasts · sub-page header · demo banner · dark mode

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: M00 (kit, router skeleton, API client), A01 (`/v1/sync/summary` for the credits chip/unread dot — until it lands, use `/v1/credits` + `/v1/notifications/unread-count`).

**Ticket:** `MONEY-{n}` "Mobile — shell & navigation" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/app/shell2.jsx` (all of it: `TABS_V2`, `TickerTape`, `TopBarV2`, `TabBarV2`, `DemoBanner`, `SearchOverlay` with sections Stocks · US stocks · Mutual funds · Actions + empty state copy, `PageHead`, `SubPage`, `AppShellV2` — ticker shows only on Home and Discover) · `app/root2.jsx` (`REG` kinds: `public` = own chrome, `root` = tab root inside the shell, `push` = sub-page with own header and **no tab bar**; `ALIAS` map: `home→dashboard`, `holdings→portfolio`, `sagechat→sage`, `markets→discover:markets`, `watchlist→discover:watchlist`, `tradebook→portfolio:trades`, `screener→discover:screener`, `news→discover:news`; `US_SCREENS` gated by `usFlag`; `FlagOffScreen`; `go(key,{reset|replace})`, `back`, `jump`) · `app/kit2.jsx` (`SheetHost` drag-to-dismiss, `ToastHost` kinds ok/err/info, `SyncPill` states) · `Design Review.dc.html` §03–04 (reach-based IA: "the four things you check daily on the bar, everything else two taps deep with context, not in a catalog"; no drawer anywhere).

## Read first
- `apps/mobile/src/ui/*`, `apps/mobile/app/**` (skeleton), `src/api/*`, `src/store/*` (M00); `apps/api/src/routes/v1/{market,discover,notifications,credits,me}.ts` (`GET /v1/market/indices`, `GET /v1/discover/search`, `GET /v1/discover/instruments`, `GET /v1/notifications/unread-count`, `GET /v1/credits`, `GET /v1/me`), `apps/web/components/CommandPalette.tsx` (search intents parity), `apps/web/lib/demo/*` (demo semantics)

## Build
1. **Tab bar** (`(app)/(tabs)/_layout.tsx`): Home · Portfolio · **Sage (centre, raised ink circle with sparkles icon; active = emerald fill)** · Discover · You; icons from lucide (`home`, `briefcase`, `sparkles`, `trending-up`, `user`); active indicator bar; labels mono 10 px; safe-area bottom inset; hidden on pushed screens (`SubPage` routes render outside the tab navigator or hide the bar via `tabBarStyle: display none` — pick the Expo Router pattern that keeps back-gesture behaviour native).
2. **Topbar (tab roots only):** wordmark (tap → Home), right cluster: `CreditChip` (⚡ N → `/plan`), search button (opens overlay), bell with unread dot (→ `/notifications`). Reads `/v1/sync/summary` (A01) or the fallbacks.
3. **Ticker tape** (Home + Discover only): marquee of `INDICES` (NIFTY 50 · SENSEX · BANK NIFTY from `/v1/market/indices` with `delayed` provenance), US indices + USDINR when `usFlag` (`/v1/market/us/quotes` for SPX/NDX proxies if available, else omit), then top-6 holdings LTP/day% (`/v1/holdings` + `/v1/market/quotes` batch); tap → stock/US portfolio/discover; `◷` glyph on US items; respect reduced-motion.
4. **Global search overlay:** full-screen sheet with autofocus input "Stocks, funds, actions…", sections Stocks (`/v1/discover/search?q=`, top 6/4), US stocks (when flag; `US` tag + `◷ EOD`), Mutual funds (`/v1/discover/mfs?q=`), Actions (static intents: Run a portfolio roast · Import trades (CSV) · FIRE calculator · Tax report · Compare stocks · Manage brokers · [+ Link a US brokerage (SnapTrade) · Market preferences when flag]); debounce 200 ms; recent searches (MMKV); empty state copy "Nothing for “{q}” — Try a ticker like INFY, a fund name, or an action like roast."; Cancel.
5. **Sheet host + toast host:** one `Sheet` provider (gorhom) rendering `um.sheet` `{ title?, body }` with drag-to-dismiss and scrim; `Toast` provider with `ok|err|info` kinds, 2.4 s, bottom-safe placement above the tab bar.
6. **`SubPage`** (pushed screens): back button (system back gesture too), mono/sans title, optional right slot, scroll body, optional sticky footer (CTA); `PageHead` for tab roots (eyebrow dot + mono eyebrow, H1 with serif flourish, sub, right slot).
7. **Demo banner:** "DEMO DATA — exploring as a guest · create free account →" above the topbar when the session is demo (server demo flag via `/v1/me`? — the web demo is cookie-based; for mobile, M11 decides: demo = unauthenticated read of `/v1/demo/*`? **Check `apps/web/app/api/demo/*` and add `GET /v1/demo/summary` if needed** — record the decision).
8. **Dark mode:** `useTheme()` override toggled from You (M19); `StatusBar` style follows; all kit components tested in both.
9. **Route guards + aliases:** `ALIAS` map implemented as redirects so push payloads and web links using old keys resolve (`/app/holdings` → portfolio tab, `/app/tradebook` → portfolio?seg=trades …); `US_SCREENS` render `FlagOffScreen` ("Not here yet … FLAG us-stocks-listing · OFF") when the server says the flag is off (`/v1/me` flags) — the mockup's "Turn the flag on" button is dev-only.
10. **Analytics:** screen view events named after the `REG` keys; `search_opened`, `search_result_tapped`.

## Non-goals
Any tab content (M12–M15), notifications list (M19), the Sage screen (M14).

## Acceptance
- All five tabs render with the shell; pushing a `SubPage` hides the tab bar and restores it on back (iOS swipe-back + Android back button tested manually and with a navigation test).
- Ticker shows real indices with the delayed flag and stops animating under reduce-motion; tapping a holding opens `/stock/[symbol]`.
- Search returns live results from `/v1/discover/search` within 300 ms p50 on QA; empty state exact.
- Sheet and toast providers work from any screen (render test dispatching `um.setSheet`/`um.toast`).
- Deep links for every `ALIAS` key resolve (table test); flag-off US routes show `FlagOffScreen`.
- Light/dark screenshots of the shell on iOS + Android attached; `verify:push`; `/code-review`.
